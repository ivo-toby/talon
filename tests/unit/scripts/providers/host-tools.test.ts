import { describe, it, expect, vi } from 'vitest';
import { createHostToolProvider } from '../../../../src/scripts/providers/host-tools.js';
import type { HostToolExecutor } from '../../../../src/scripts/providers/host-tools.js';
import type { RunContext } from '../../../../src/scripts/types.js';

const context: RunContext = {
  personaId: 'persona-1',
  threadId: 'thread-1',
  scriptRunId: 'srun-1',
  scriptName: 'demo',
  channels: ['telegram-main'],
  versionDir: '/v',
};

function setup(
  result: Awaited<ReturnType<HostToolExecutor['executeInProcess']>> = {
    requestId: 'r',
    tool: 't',
    status: 'success',
    result: { ok: 1 },
  },
) {
  const executeInProcess = vi.fn().mockResolvedValue(result);
  const provider = createHostToolProvider({ executeInProcess }, context);
  return { executeInProcess, provider };
}

const live = new AbortController().signal;

describe('createHostToolProvider', () => {
  it('describes only the six talon names', () => {
    const { provider } = setup();
    expect(provider.describe('talon.memory_read')).toEqual({ toolClass: 'read' });
    expect(provider.describe('talon.memory_list')).toEqual({ toolClass: 'read' });
    expect(provider.describe('talon.memory_write')).toEqual({ toolClass: 'write' });
    expect(provider.describe('talon.memory_delete')).toEqual({ toolClass: 'write' });
    expect(provider.describe('talon.channel_list')).toEqual({ toolClass: 'read' });
    expect(provider.describe('talon.channel_send')).toEqual({ toolClass: 'write' });
    expect(provider.describe('talon.net_http')).toBeUndefined();
    expect(provider.describe('memory_read')).toBeUndefined();
    expect(provider.describe('toString')).toBeUndefined();
  });

  it.each([
    [
      'talon.memory_read',
      { key: 'k', namespace: 'fact' },
      'memory.access',
      { operation: 'read', key: 'k', namespace: 'fact' },
    ],
    ['talon.memory_read', { key: 'k' }, 'memory.access', { operation: 'read', key: 'k' }],
    ['talon.memory_list', {}, 'memory.access', { operation: 'list' }],
    [
      'talon.memory_write',
      { key: 'k', value: { a: 1 } },
      'memory.access',
      { operation: 'write', key: 'k', value: { a: 1 } },
    ],
    ['talon.memory_delete', { key: 'k' }, 'memory.access', { operation: 'delete', key: 'k' }],
    ['talon.channel_list', {}, 'channel.list', {}],
    [
      'talon.channel_send',
      { channelId: 'telegram-main', content: 'hi', externalChatId: 'c1' },
      'channel.send',
      { channelId: 'telegram-main', content: 'hi', externalChatId: 'c1' },
    ],
  ])('maps %s to the bridge', async (name, input, tool, args) => {
    const { provider, executeInProcess } = setup();
    const r = await provider.call(name, input, live);
    expect(r._unsafeUnwrap()).toEqual({ ok: 1 });
    expect(executeInProcess).toHaveBeenCalledTimes(1);
    const [t, a, ctx] = executeInProcess.mock.calls[0];
    expect(t).toBe(tool);
    expect(a).toEqual(args);
    expect(ctx).toMatchObject({ runId: 'srun-1', threadId: 'thread-1', personaId: 'persona-1' });
    expect(ctx.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses a fresh request id per call', async () => {
    const { provider, executeInProcess } = setup();
    await provider.call('talon.channel_list', {}, live);
    await provider.call('talon.channel_list', {}, live);
    expect(executeInProcess.mock.calls[0][2].requestId).not.toBe(
      executeInProcess.mock.calls[1][2].requestId,
    );
  });

  it.each([
    ['talon.memory_read', {}],
    ['talon.memory_read', { key: '' }],
    ['talon.memory_read', { key: 'x'.repeat(257) }],
    ['talon.memory_read', { key: 'k', namespace: 'x'.repeat(129) }],
    ['talon.memory_read', { key: 'k', extra: 1 }],
    ['talon.memory_write', { key: 'k' }],
    ['talon.memory_list', 'nope'],
    ['talon.channel_list', { a: 1 }],
    ['talon.channel_send', { channelId: 'telegram-main', content: '' }],
    ['talon.channel_send', { channelId: 'telegram-main', content: 'x'.repeat(4001) }],
    ['talon.channel_send', { channelId: 'telegram-main', content: 'hi', externalChatId: '' }],
  ])('rejects bad input for %s with INVALID_ARGUMENT', async (name, input) => {
    const { provider, executeInProcess } = setup();
    const r = await provider.call(name, input, live);
    expect(r._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
    expect(executeInProcess).not.toHaveBeenCalled();
  });

  it('accepts a null value for memory_write input validation', async () => {
    const { provider, executeInProcess } = setup();
    await provider.call('talon.memory_write', { key: 'k', value: null }, live);
    expect(executeInProcess).toHaveBeenCalled();
  });

  it('refuses a channel that is not in the manifest', async () => {
    const { provider, executeInProcess } = setup();
    const r = await provider.call(
      'talon.channel_send',
      { channelId: 'Telegram-Main', content: 'hi' },
      live,
    );
    expect(r._unsafeUnwrapErr().scriptCode).toBe('NOT_IN_MANIFEST');
    expect(executeInProcess).not.toHaveBeenCalled();
  });

  it('maps a denied capability to UNKNOWN_TOOL', async () => {
    const { provider } = setup({
      requestId: 'r',
      tool: 't',
      status: 'error',
      error: 'x',
      denied: true,
    });
    const r = await provider.call('talon.channel_list', {}, live);
    expect(r._unsafeUnwrapErr().scriptCode).toBe('UNKNOWN_TOOL');
  });

  it('does not treat error text as a denial', async () => {
    const { provider } = setup({
      requestId: 'r',
      tool: 't',
      status: 'error',
      error: 'Tool "x" is not allowed for persona "p"',
    });
    const r = await provider.call('talon.channel_list', {}, live);
    expect(r._unsafeUnwrapErr().scriptCode).toBe('TOOL_FAILED');
  });

  it.each(['error', 'timeout'] as const)(
    'maps status %s to TOOL_FAILED without leaking the text',
    async (status) => {
      const { provider } = setup({
        requestId: 'r',
        tool: 't',
        status,
        error: 'secret detail /home/x',
      });
      const e = (await provider.call('talon.memory_list', {}, live))._unsafeUnwrapErr();
      expect(e.scriptCode).toBe('TOOL_FAILED');
      expect(e.message).not.toContain('secret');
    },
  );

  it('maps an executor rejection to TOOL_FAILED', async () => {
    const executeInProcess = vi.fn().mockRejectedValue(new Error('boom'));
    const provider = createHostToolProvider({ executeInProcess }, context);
    const e = (await provider.call('talon.memory_list', {}, live))._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('TOOL_FAILED');
  });

  it('does not call the executor when already aborted', async () => {
    const { provider, executeInProcess } = setup();
    const ac = new AbortController();
    ac.abort();
    const r = await provider.call('talon.memory_list', {}, ac.signal);
    expect(r._unsafeUnwrapErr().scriptCode).toBe('TOOL_FAILED');
    expect(executeInProcess).not.toHaveBeenCalled();
  });

  it('resolves at once when aborted during the call and ignores the late result', async () => {
    let finish: (v: unknown) => void = () => {};
    const executeInProcess = vi.fn().mockReturnValue(new Promise((res) => (finish = res)));
    const provider = createHostToolProvider({ executeInProcess }, context);
    const ac = new AbortController();
    const pending = provider.call('talon.memory_list', {}, ac.signal);
    ac.abort();
    const r = await pending;
    expect(r._unsafeUnwrapErr().scriptCode).toBe('TOOL_FAILED');
    finish({ requestId: 'r', tool: 't', status: 'success', result: 1 });
  });
});
