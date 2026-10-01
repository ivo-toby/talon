import { describe, expect, it, vi } from 'vitest';
import { Tool, type ToolExecutionContext } from '@mastra/core/tools';
import {
  DEFAULT_FETCH_SLICE_CAP,
  DEFAULT_TOOL_OUTPUT_CAP,
  ToolOutputStore,
} from '../../../src/providers/openai-compatible/agent-cli/tool-output-excerpter.js';
import {
  applyMcpToolLimits,
  isSerializableMcpServer,
  resolveMcpToolOutputCap,
  toMastraMcpServers,
} from '../../../src/providers/openai-compatible/agent-cli/mcp-tool-limits.js';

type AnyTool = Tool<unknown, unknown, unknown, unknown>;

const stdioServer = (overrides: Record<string, unknown> = {}) => ({
  transport: 'stdio' as const,
  command: '/usr/bin/fake-mcp',
  args: ['--serve'],
  ...overrides,
});

const httpServer = (overrides: Record<string, unknown> = {}) => ({
  transport: 'http' as const,
  url: 'https://mcp.example.com/mcp',
  ...overrides,
});

const sseServer = (overrides: Record<string, unknown> = {}) => ({
  transport: 'sse' as const,
  url: 'https://mcp.example.com/sse',
  ...overrides,
});

function makeTool(
  id: string,
  execute?: (
    this: AnyTool,
    input: unknown,
    ctx?: ToolExecutionContext<unknown, unknown, unknown>,
  ) => Promise<unknown>,
): AnyTool {
  return new Tool<unknown, unknown, unknown, unknown>({
    id,
    description: `fake tool ${id}`,
    execute,
  });
}

// The SDK wraps constructor callbacks, so observe the Tool.execute boundary directly.
class ExecutionObservingTool extends Tool<unknown, unknown, unknown, unknown> {
  override execute = async function (
    this: ExecutionObservingTool,
    input: unknown,
    ctx: ToolExecutionContext,
  ): Promise<unknown> {
    return { toolId: this.id, input, ctx };
  };
}

function makeThisObservingTool(id: string): AnyTool {
  return new ExecutionObservingTool({ id, description: `fake tool ${id}` });
}

interface ToolCallIdContext extends Partial<ToolExecutionContext<unknown, unknown, unknown>> {
  toolCallId: string;
}
interface OptionsToolCallIdContext extends Partial<
  ToolExecutionContext<unknown, unknown, unknown>
> {
  options: { toolCallId: string };
}

function makeCallIdContext(toolCallId: string): ToolCallIdContext {
  return { toolCallId };
}

function makeOptionsCallIdContext(toolCallId: string): OptionsToolCallIdContext {
  return { options: { toolCallId } };
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new Error('Expected a string tool result');
}

const BIG_OUTPUT = 'x'.repeat(20000);

describe('isSerializableMcpServer', () => {
  it.each([
    ['stdio', stdioServer()],
    ['http', httpServer()],
    ['sse', sseServer()],
  ])('accepts %s without optional fields', (_label, server) => {
    expect(isSerializableMcpServer(server)).toBe(true);
  });

  it.each([
    ['stdio', stdioServer({ env: { A: '1' }, timeoutMs: 1000, toolOutputCap: 0 })],
    ['http', httpServer({ headers: { 'x-a': 'b' }, timeoutMs: 5000, toolOutputCap: 4096 })],
    ['sse', sseServer({ timeoutMs: 1000, toolOutputCap: 0 })],
  ])('accepts %s with valid limits', (_label, server) => {
    expect(isSerializableMcpServer(server)).toBe(true);
  });

  it('rejects unknown transport and non-object inputs', () => {
    expect(isSerializableMcpServer({ transport: 'grpc', url: 'x' })).toBe(false);
    expect(isSerializableMcpServer(null)).toBe(false);
    expect(isSerializableMcpServer('stdio')).toBe(false);
    expect(isSerializableMcpServer({ transport: 5 })).toBe(false);
  });

  it('preserves existing stdio transport validation', () => {
    expect(isSerializableMcpServer({ transport: 'stdio', command: 1, args: [] })).toBe(false);
    expect(isSerializableMcpServer({ transport: 'stdio', command: 'a', args: ['b', 2] })).toBe(
      false,
    );
    expect(
      isSerializableMcpServer({ transport: 'stdio', command: 'a', args: [], env: { A: 1 } }),
    ).toBe(false);
  });

  it('preserves existing remote transport validation', () => {
    expect(isSerializableMcpServer({ transport: 'http', url: 1 })).toBe(false);
    expect(isSerializableMcpServer({ transport: 'http', url: 'u', headers: { A: 1 } })).toBe(false);
    expect(isSerializableMcpServer({ transport: 'sse' })).toBe(false);
  });

  it.each([
    ['timeoutMs 999 (below minimum)', { timeoutMs: 999 }],
    ['timeoutMs negative', { timeoutMs: -1000 }],
    ['timeoutMs fractional', { timeoutMs: 1000.5 }],
    ['timeoutMs non-finite', { timeoutMs: Number.POSITIVE_INFINITY }],
    ['timeoutMs string', { timeoutMs: '1000' }],
    ['timeoutMs null', { timeoutMs: null }],
    ['toolOutputCap negative', { toolOutputCap: -1 }],
    ['toolOutputCap fractional', { toolOutputCap: 0.5 }],
    ['toolOutputCap non-finite', { toolOutputCap: Number.NaN }],
    ['toolOutputCap string', { toolOutputCap: '0' }],
    ['toolOutputCap null', { toolOutputCap: null }],
  ])('rejects %s independently on all transports', (_label, overrides) => {
    expect(isSerializableMcpServer(stdioServer(overrides))).toBe(false);
    expect(isSerializableMcpServer(httpServer(overrides))).toBe(false);
    expect(isSerializableMcpServer(sseServer(overrides))).toBe(false);
  });
});

describe('toMastraMcpServers', () => {
  it('converts stdio preserving command/args/env/cwd and omits Talon fields', () => {
    const result = toMastraMcpServers({
      s1: stdioServer({ env: { K: 'v' } }),
      s2: stdioServer(),
    });
    expect(Object.keys(result)).toEqual(['s1', 's2']);
    expect(result.s1).toEqual({
      command: '/usr/bin/fake-mcp',
      args: ['--serve'],
      env: { K: 'v' },
      cwd: process.cwd(),
    });
    expect(result.s2).toEqual({
      command: '/usr/bin/fake-mcp',
      args: ['--serve'],
      cwd: process.cwd(),
    });
    expect('timeoutMs' in result.s1).toBe(false);
    expect('toolOutputCap' in result.s1).toBe(false);
    expect('timeout' in result.s1).toBe(false);
  });

  it('maps timeout on all transports without forwarding Talon metadata', () => {
    const result = toMastraMcpServers({
      timed: stdioServer({ timeoutMs: 1234 }),
      remote: httpServer({ timeoutMs: 4321, toolOutputCap: 0 }),
      sse: sseServer({ timeoutMs: 1000, toolOutputCap: 0 }),
      plain: httpServer(),
    });
    expect('timeout' in result.timed).toBe(true);
    expect(result.timed.timeout).toBe(1234);
    expect('timeout' in result.remote).toBe(true);
    expect(result.remote.timeout).toBe(4321);
    expect('timeout' in result.plain).toBe(false);
    expect('timeoutMs' in result.remote).toBe(false);
    expect('toolOutputCap' in result.remote).toBe(false);
    expect(result.sse.timeout).toBe(1000);
    expect(result.sse).not.toHaveProperty('timeoutMs');
    expect(result.sse).not.toHaveProperty('toolOutputCap');
  });

  it('converts remote servers to URL and preserves header adapter behavior', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        return new Response(null, {
          headers: {
            captured: headers.get('x-api-key') ?? '',
            accept: headers.get('Accept') ?? '',
            mode: init?.mode ?? '',
            cache: init?.cache ?? '',
            redirect: init?.redirect ?? '',
          },
        });
      },
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const result = toMastraMcpServers({
        remote: httpServer({ headers: { 'x-api-key': 'secret' } }),
      });
      const def = result.remote;
      expect(def).toHaveProperty('url', new URL('https://mcp.example.com/mcp'));
      if (!('requestInit' in def) || !('eventSourceInit' in def)) {
        throw new Error('expected header adapter fields on remote definition');
      }
      expect(def.requestInit?.headers).toEqual({ 'x-api-key': 'secret' });
      const sseFetch = def.eventSourceInit?.fetch;
      expect(sseFetch).toBeTypeOf('function');

      const response = await sseFetch!(new URL('https://mcp.example.com/sse'), {
        signal: new AbortController().signal,
        mode: 'cors',
        cache: 'no-store',
        redirect: 'follow',
        headers: { Accept: 'text/event-stream', 'x-api-key': 'overridden-by-adapter' },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response.headers.get('captured')).toBe('secret');
      expect(response.headers.get('accept')).toBe('text/event-stream');
      expect(response.headers.get('mode')).toBe('cors');
      expect(response.headers.get('cache')).toBe('no-store');
      expect(response.headers.get('redirect')).toBe('follow');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('omits requestInit/eventSourceInit when headers are absent', () => {
    const result = toMastraMcpServers({ remote: sseServer() });
    expect('requestInit' in result.remote).toBe(false);
    expect('eventSourceInit' in result.remote).toBe(false);
  });
});

describe('resolveMcpToolOutputCap', () => {
  const servers = {
    a: stdioServer({ toolOutputCap: 512 }),
    a_long: stdioServer(),
    a_longer: stdioServer({ toolOutputCap: 0 }),
  };

  it.each([
    ['a_search', 800, 512],
    ['a_search', 0, 512],
    ['a_long_search', 800, 800],
    ['a_long_search', undefined, 4000],
    ['a_longer_search', 800, 0],
    ['aa_search', 800, 800],
    ['other_search', undefined, 4000],
    ['other_search', 0, 0],
  ])('resolves %s (provider=%s) to %i', (tool, providerCap, expected) => {
    expect(resolveMcpToolOutputCap(tool, servers, providerCap)).toBe(expected);
  });

  it('does not inherit a shorter owner cap for a longer owner that omits its cap', () => {
    expect(resolveMcpToolOutputCap('a_long_search', servers, 800)).toBe(800);
  });

  it('defaults to the provider cap, then the existing default, when nothing is configured', () => {
    const empty: Record<string, ReturnType<typeof stdioServer>> = {};
    expect(resolveMcpToolOutputCap('any_tool', empty, 1234)).toBe(1234);
    expect(resolveMcpToolOutputCap('any_tool', empty, undefined)).toBe(DEFAULT_TOOL_OUTPUT_CAP);
  });
});

describe('applyMcpToolLimits — no-wrap cases', () => {
  it('returns the original map unchanged for an empty tools map', () => {
    const tools: Record<string, AnyTool> = {};
    const store = new ToolOutputStore();
    const collision = vi.fn();
    const result = applyMcpToolLimits(
      tools,
      { s: stdioServer() },
      undefined,
      store,
      () => 'id',
      collision,
    );
    expect(result).toBe(tools);
    expect(store.size()).toBe(0);
    expect(collision).not.toHaveBeenCalled();
  });

  it('returns the original map when every tool resolves to cap zero, even with a positive provider cap', () => {
    const tools = { s_tool: makeTool('s_tool') };
    const store = new ToolOutputStore();
    const collision = vi.fn();
    const result = applyMcpToolLimits(
      tools,
      { s: stdioServer({ toolOutputCap: 0 }) },
      800,
      store,
      () => 'id',
      collision,
    );
    expect(result).toBe(tools);
    expect('fetch_tool_output' in result).toBe(false);
    expect(collision).not.toHaveBeenCalled();
  });

  it('returns the original map when the only owner cap is zero and provider is undefined', () => {
    const tools = { s_tool: makeTool('s_tool') };
    const result = applyMcpToolLimits(
      tools,
      { s: stdioServer({ toolOutputCap: 0 }) },
      undefined,
      new ToolOutputStore(),
      () => 'id',
      vi.fn(),
    );
    expect(result).toBe(tools);
  });
});

describe('applyMcpToolLimits — wrapping behavior', () => {
  it('wraps mixed positive/zero tools, truncates only the positive-cap output and records full outputs', async () => {
    const tools = {
      pos_tool: makeTool('pos_tool', async () => BIG_OUTPUT),
      zero_tool: makeTool('zero_tool', async () => BIG_OUTPUT),
    };
    const servers = {
      pos: httpServer({ toolOutputCap: 512 }),
      zero: httpServer({ toolOutputCap: 0 }),
    };
    const store = new ToolOutputStore();
    const result = applyMcpToolLimits(tools, servers, 800, store, () => 'synthetic-id', vi.fn());

    expect(Object.keys(result).sort()).toEqual(['fetch_tool_output', 'pos_tool', 'zero_tool']);
    expect(result['pos_tool']).not.toBe(tools['pos_tool']);
    expect(result['zero_tool']).not.toBe(tools['zero_tool']);
    expect(result['fetch_tool_output'].id).toBe('fetch_tool_output');

    const [posResult, zeroResult] = await Promise.all([
      result['pos_tool'].execute!(undefined, makeCallIdContext('call-pos')),
      result['zero_tool'].execute!(undefined, makeCallIdContext('call-zero')),
    ]);

    assertString(posResult);
    const posString = posResult;
    expect(posString).not.toBe(BIG_OUTPUT);
    expect(posString).toContain('TRUNCATED BY TALON');
    expect(posString).toContain('call-pos');

    expect(zeroResult).toBe(BIG_OUTPUT);

    expect(store.size()).toBe(2);
    expect(store.get('call-pos')).toEqual({
      toolName: 'pos_tool',
      fullOutput: BIG_OUTPUT,
      originalChars: 20000,
      truncated: true,
      excerptChars: posString.length,
    });
    expect(store.get('call-zero')).toEqual({
      toolName: 'zero_tool',
      fullOutput: BIG_OUTPUT,
      originalChars: 20000,
      truncated: false,
      excerptChars: 20000,
    });
  });

  it('lets a server cap override a zero provider cap during registration and wrapping', async () => {
    const tools = { a_search: makeTool('a_search', async () => 'y'.repeat(600)) };
    const store = new ToolOutputStore();
    const result = applyMcpToolLimits(
      tools,
      { a: stdioServer({ toolOutputCap: 512 }) },
      0,
      store,
      () => 'id',
      vi.fn(),
    );
    expect('fetch_tool_output' in result).toBe(true);
    expect(result['a_search']).not.toBe(tools['a_search']);

    const value = await result['a_search'].execute!(undefined, makeCallIdContext('call-override'));
    assertString(value);
    expect(value).toContain('TRUNCATED BY TALON');
    expect(value.length).toBeLessThan(600);
    expect(value.length).toBeLessThanOrEqual(512);
    expect(store.get('call-override')).toEqual({
      toolName: 'a_search',
      fullOutput: 'y'.repeat(600),
      originalChars: 600,
      truncated: true,
      excerptChars: value.length,
    });
  });

  it('preserves prototype, id, description and this-binding, forwarding input and context', async () => {
    const original = makeThisObservingTool('s_tool');
    const tools = { s_tool: original };
    const store = new ToolOutputStore();
    const result = applyMcpToolLimits(
      tools,
      { s: stdioServer({ toolOutputCap: 512 }) },
      undefined,
      store,
      () => 'synthetic-fallback',
      vi.fn(),
    );
    const wrapped = result['s_tool'];
    expect(wrapped).toBeInstanceOf(Tool);
    expect(wrapped.id).toBe('s_tool');
    expect(wrapped.description).toBe('fake tool s_tool');

    const ctx = makeCallIdContext('this-ctx');
    const payload = { marker: 'input-seen' };
    const value = await wrapped.execute!(payload, ctx);
    if (
      value === null ||
      typeof value !== 'object' ||
      !('toolId' in value) ||
      !('input' in value) ||
      !('ctx' in value)
    ) {
      throw new Error('Expected execution-boundary observation');
    }
    expect(value.toolId).toBe('s_tool');
    expect(value.input).toBe(payload);
    expect(value.ctx).toBe(ctx);
    expect(store.get('this-ctx')?.fullOutput).toBe(
      JSON.stringify({ toolId: 's_tool', input: payload, ctx }),
    );
  });

  it('records via fallback id when the context carries none', async () => {
    const tools = { s_tool: makeTool('s_tool', async () => 'small') };
    const store = new ToolOutputStore();
    const result = applyMcpToolLimits(
      tools,
      { s: stdioServer({ toolOutputCap: 100 }) },
      undefined,
      store,
      () => 'synthetic-fallback',
      vi.fn(),
    );
    const value = await result['s_tool'].execute!(undefined, {});
    expect(value).toBe('small');
    const entry = store.get('synthetic-fallback');
    expect(entry?.toolName).toBe('s_tool');
    expect(entry?.fullOutput).toBe('small');
    expect(entry?.truncated).toBe(false);
    expect(entry?.originalChars).toBe(5);
    expect(entry?.excerptChars).toBe(5);
  });

  it('passes error results through unchanged but still records untruncated metadata', async () => {
    const longError = 'E'.repeat(120);
    const errorResult = { content: [{ type: 'text', text: longError }], isError: true };
    const tools = { s_tool: makeTool('s_tool', async () => errorResult) };
    const store = new ToolOutputStore();
    const result = applyMcpToolLimits(
      tools,
      { s: stdioServer({ toolOutputCap: 100 }) },
      undefined,
      store,
      () => 'synthetic',
      vi.fn(),
    );
    const value = await result['s_tool'].execute!(undefined, makeCallIdContext('call-err'));
    expect(value).toBe(errorResult);
    expect(store.get('call-err')).toEqual({
      toolName: 's_tool',
      fullOutput: JSON.stringify({ content: [{ type: 'text', text: longError }], isError: true }),
      originalChars: JSON.stringify({ content: [{ type: 'text', text: longError }], isError: true })
        .length,
      truncated: false,
      excerptChars: JSON.stringify({ content: [{ type: 'text', text: longError }], isError: true })
        .length,
    });
  });

  it('extracts direct, nested and fallback call ids', async () => {
    const tools = { s_tool: makeTool('s_tool', async () => 'v') };
    const store = new ToolOutputStore();
    const result = applyMcpToolLimits(
      tools,
      { s: stdioServer({ toolOutputCap: 100 }) },
      undefined,
      store,
      () => 'fallback-id',
      vi.fn(),
    );
    const wrapped = result['s_tool'];

    await wrapped.execute!(undefined, makeCallIdContext('direct-id'));
    await wrapped.execute!(undefined, makeOptionsCallIdContext('nested-id'));
    await wrapped.execute!(undefined, {});
    await wrapped.execute!(undefined, {});

    expect(store.get('direct-id')?.fullOutput).toBe('v');
    expect(store.get('nested-id')?.fullOutput).toBe('v');
    expect(store.get('fallback-id')?.fullOutput).toBe('v');
    expect(store.size()).toBe(3);
  });

  it('registers a synthetic fetch_tool_output that returns the fixed 8000-char slice bound', async () => {
    const tools = { s_tool: makeTool('s_tool', async () => BIG_OUTPUT) };
    const store = new ToolOutputStore();
    const result = applyMcpToolLimits(
      tools,
      { s: stdioServer({ toolOutputCap: 512 }) },
      undefined,
      store,
      () => 'synthetic',
      vi.fn(),
    );
    const recovery = result['fetch_tool_output'];
    expect(recovery).toBeDefined();
    expect(recovery.id).toBe('fetch_tool_output');
    expect(recovery.description).toContain(String(DEFAULT_FETCH_SLICE_CAP));

    await result['s_tool'].execute!(undefined, makeCallIdContext('call-big'));

    // Request the whole stored range: the stored-content slice between the
    // framing lines is exactly 8000 chars; the frame adds prefix + hint.
    const slice = await recovery.execute!(
      { toolCallId: 'call-big', startChar: 0, endChar: 20000 },
      {},
    );
    assertString(slice);
    const frame = slice;
    expect(frame).toContain('[range 0-8000 of 20000');
    expect(frame).toContain('startChar=8000 to continue');
    const bodyStart = frame.indexOf('\n', frame.indexOf('[range')) + 1;
    const bodyEnd = frame.lastIndexOf('\n[slice capped');
    expect(frame.slice(bodyStart, bodyEnd)).toBe('x'.repeat(DEFAULT_FETCH_SLICE_CAP));
    expect(frame.length).toBeGreaterThan(DEFAULT_FETCH_SLICE_CAP);
  });

  it('retains an existing MCP fetch_tool_output, calls the collision callback once and keeps cap enforcement on the retained tool', async () => {
    const collision = vi.fn();
    const mcpRecovery = makeTool('fetch_tool_output', async () => 'z'.repeat(10000));
    const tools = {
      s_tool: makeTool('s_tool', async () => 'small'),
      fetch_tool_output: mcpRecovery,
    };
    const store = new ToolOutputStore();
    const result = applyMcpToolLimits(
      tools,
      { s: stdioServer({ toolOutputCap: 128 }) },
      128,
      store,
      () => 'synthetic',
      collision,
    );

    expect(result['fetch_tool_output']).not.toBe(mcpRecovery);
    expect(result['fetch_tool_output']).toBeInstanceOf(Tool);
    expect(result['fetch_tool_output'].id).toBe('fetch_tool_output');
    expect(result['fetch_tool_output'].description).toBe('fake tool fetch_tool_output');
    expect(collision).toHaveBeenCalledTimes(1);

    const value = await result['fetch_tool_output'].execute!(
      undefined,
      makeCallIdContext('call-collision'),
    );
    assertString(value);
    const truncated = value;
    expect(truncated).not.toBe('z'.repeat(10000));
    expect(truncated).toContain('TRUNCATED BY TALON');
    expect(store.get('call-collision')).toEqual({
      toolName: 'fetch_tool_output',
      fullOutput: 'z'.repeat(10000),
      originalChars: 10000,
      truncated: true,
      excerptChars: truncated.length,
    });
  });

  it('does not throw on tools without an execute property', async () => {
    const noExec = new Tool<unknown, unknown, unknown, unknown>({
      id: 'no_exec',
      description: 'no execute',
    });
    const tools = { s_tool: noExec };
    const store = new ToolOutputStore();
    const result = applyMcpToolLimits(
      tools,
      { s: stdioServer({ toolOutputCap: 100 }) },
      undefined,
      store,
      () => 'synthetic',
      vi.fn(),
    );
    expect(result['s_tool']).toBe(noExec);
    expect('fetch_tool_output' in result).toBe(true);
  });
});
