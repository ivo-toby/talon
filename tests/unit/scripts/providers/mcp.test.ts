import { describe, it, expect, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createMcpProvider } from '../../../../src/scripts/providers/mcp.js';
import type { McpClientLike, McpToolLike } from '../../../../src/scripts/providers/mcp.js';
import type { RunProvider } from '../../../../src/scripts/types.js';
import type { SerializableMcpServer } from '../../../../src/providers/openai-compatible/agent-cli/mcp-tool-limits.js';

const stdio = (extra: Partial<SerializableMcpServer> = {}): SerializableMcpServer =>
  ({ transport: 'stdio', command: 'x', args: [], ...extra }) as SerializableMcpServer;

const live = new AbortController().signal;

function fakeClient(
  toolsets: Record<string, Record<string, McpToolLike>>,
  overrides: Partial<McpClientLike> = {},
): McpClientLike & { disconnect: ReturnType<typeof vi.fn> } {
  return {
    listToolsets: vi.fn().mockResolvedValue(toolsets),
    disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as McpClientLike & { disconnect: ReturnType<typeof vi.fn> };
}

async function build(
  client: McpClientLike,
  servers: Record<string, SerializableMcpServer> = { crm: stdio() },
  toolClasses: Record<string, 'read' | 'write'> = {},
  connectTimeoutMs = 1000,
): Promise<RunProvider> {
  const result = await createMcpProvider({
    servers,
    toolClasses,
    connectTimeoutMs,
    createClient: () => client,
  });
  if (result.isErr()) throw result.error;
  return result.value;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createMcpProvider', () => {
  it('describes tools with the class from toolClasses, annotation, or write', async () => {
    const tool = (readOnly?: boolean): McpToolLike => ({
      execute: vi.fn(),
      ...(readOnly === undefined ? {} : { mcp: { annotations: { readOnlyHint: readOnly } } }),
    });
    const provider = await build(
      fakeClient({ crm: { a: tool(true), b: tool(), c: tool(true), d: tool(false) } }),
      undefined,
      { 'crm.c': 'write', 'crm.b': 'read' },
    );
    expect(provider.describe('crm.a')).toEqual({ toolClass: 'read' });
    expect(provider.describe('crm.b')).toEqual({ toolClass: 'read' });
    expect(provider.describe('crm.c')).toEqual({ toolClass: 'write' });
    expect(provider.describe('crm.d')).toEqual({ toolClass: 'write' });
  });

  it('does not describe malformed names, unknown tools or prototype keys', async () => {
    const provider = await build(fakeClient({ crm: { a: { execute: vi.fn() } } }));
    for (const name of [
      'a',
      'crm.',
      '.a',
      'crm.constructor',
      'crm.__proto__',
      'constructor.a',
      '',
    ]) {
      expect(provider.describe(name)).toBeUndefined();
    }
    const result = await provider.call('crm.constructor', {}, live);
    expect(result._unsafeUnwrapErr().scriptCode).toBe('UNKNOWN_TOOL');
  });

  it('applies allowedTools like the existing agent code', async () => {
    const t = (): McpToolLike => ({ execute: vi.fn() });
    const provider = await build(
      fakeClient({ crm: { search: t(), delete: t() }, other: { delete: t() } }),
      { crm: stdio({ allowedTools: ['search'] }), other: stdio() },
    );
    expect(provider.describe('crm.search')).toBeDefined();
    expect(provider.describe('crm.delete')).toBeUndefined();
    expect(provider.describe('other.delete')).toBeDefined();
  });

  it('drops the talon and model servers; with none left it makes no client', async () => {
    const createClient = vi.fn();
    const result = await createMcpProvider({
      servers: { talon: stdio(), model: stdio() },
      toolClasses: {},
      connectTimeoutMs: 10,
      createClient,
    });
    const provider = result._unsafeUnwrap();
    expect(createClient).not.toHaveBeenCalled();
    expect(provider.describe('talon.x')).toBeUndefined();
    await expect(provider.close()).resolves.toBeUndefined();
  });

  it('passes the input and the abort signal to the tool and returns the value', async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'hi' }] });
    const provider = await build(fakeClient({ crm: { a: { execute } } }));
    const result = await provider.call('crm.a', { q: 1 }, live);
    expect(result._unsafeUnwrap()).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    expect(execute).toHaveBeenCalledWith({ q: 1 }, { abortSignal: live });
  });

  it('maps a thrown tool and an isError result to TOOL_FAILED without leaking text', async () => {
    const provider = await build(
      fakeClient({
        crm: {
          throws: { execute: vi.fn().mockRejectedValue(new Error('secret-token')) },
          iserr: { execute: vi.fn().mockResolvedValue({ isError: true, content: 'secret' }) },
        },
      }),
    );
    for (const name of ['crm.throws', 'crm.iserr']) {
      const error = (await provider.call(name, {}, live))._unsafeUnwrapErr();
      expect(error.scriptCode).toBe('TOOL_FAILED');
      expect(error.message).not.toContain('secret');
    }
    const thrown = (await provider.call('crm.throws', {}, live))._unsafeUnwrapErr();
    expect(thrown.cause).toBeInstanceOf(Error);
  });

  it('resolves TOOL_FAILED soon after an abort, even if the tool ignores the signal', async () => {
    const execute = vi.fn().mockReturnValue(new Promise(() => undefined));
    const provider = await build(fakeClient({ crm: { a: { execute } } }));
    const controller = new AbortController();
    const started = Date.now();
    const pending = provider.call('crm.a', {}, controller.signal);
    controller.abort();
    const error = (await pending)._unsafeUnwrapErr();
    expect(error.scriptCode).toBe('TOOL_FAILED');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('returns TOOL_FAILED and disconnects when listing fails', async () => {
    const client = fakeClient({}, { listToolsets: vi.fn().mockRejectedValue(new Error('down')) });
    const result = await createMcpProvider({
      servers: { crm: stdio() },
      toolClasses: {},
      connectTimeoutMs: 1000,
      createClient: () => client,
    });
    expect(result._unsafeUnwrapErr().scriptCode).toBe('TOOL_FAILED');
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('returns TOOL_FAILED on a connect time-out', async () => {
    const client = fakeClient(
      {},
      { listToolsets: vi.fn().mockReturnValue(new Promise(() => undefined)) },
    );
    const result = await createMcpProvider({
      servers: { crm: stdio() },
      toolClasses: {},
      connectTimeoutMs: 20,
      createClient: () => client,
    });
    expect(result._unsafeUnwrapErr().scriptCode).toBe('TOOL_FAILED');
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('never rejects when the client factory throws', async () => {
    const result = await createMcpProvider({
      servers: { crm: stdio() },
      toolClasses: {},
      connectTimeoutMs: 20,
      createClient: () => {
        throw new Error('bad');
      },
    });
    expect(result._unsafeUnwrapErr().scriptCode).toBe('TOOL_FAILED');
  });

  it('close is idempotent, never rejects, and calls fail afterwards', async () => {
    const client = fakeClient(
      { crm: { a: { execute: vi.fn() } } },
      { disconnect: vi.fn().mockRejectedValue(new Error('x')) },
    );
    const provider = await build(client);
    await expect(provider.close()).resolves.toBeUndefined();
    await expect(provider.close()).resolves.toBeUndefined();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    const error = (await provider.call('crm.a', {}, live))._unsafeUnwrapErr();
    expect(error.scriptCode).toBe('TOOL_FAILED');
  });

  it('bounds close to 5 seconds', async () => {
    vi.useFakeTimers();
    const client = fakeClient(
      { crm: { a: { execute: vi.fn() } } },
      { disconnect: vi.fn().mockReturnValue(new Promise(() => undefined)) },
    );
    const provider = await build(client);
    let done = false;
    const closing = provider.close().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await closing;
    expect(done).toBe(true);
  });
});

describe('createMcpProvider with the real MCPClient', () => {
  it('lists, calls, classifies and disconnects against a stdio server', async () => {
    const fixture = fileURLToPath(
      new URL('../../../fixtures/scripts/mcp-fixture-server.mjs', import.meta.url),
    );
    const result = await createMcpProvider({
      servers: { fx: { transport: 'stdio', command: process.execPath, args: [fixture] } },
      toolClasses: {},
      connectTimeoutMs: 15_000,
    });
    const provider = result._unsafeUnwrap();
    try {
      expect(provider.describe('fx.list_items')).toEqual({ toolClass: 'read' });
      expect(provider.describe('fx.add_item')).toEqual({ toolClass: 'write' });

      const listed = (await provider.call('fx.list_items', {}, live))._unsafeUnwrap();
      expect(JSON.stringify(listed)).toContain('apple');
      const added = (await provider.call('fx.add_item', { name: 'pear' }, live))._unsafeUnwrap();
      expect(JSON.stringify(added)).toContain('added pear');
      const failed = (await provider.call('fx.fail', {}, live))._unsafeUnwrapErr();
      expect(failed.scriptCode).toBe('TOOL_FAILED');
    } finally {
      await provider.close();
    }
  }, 20_000);
});
