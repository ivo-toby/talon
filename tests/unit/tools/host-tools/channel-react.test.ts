/**
 * Unit tests for ChannelReactHandler (channel.react host tool).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from 'neverthrow';
import { ChannelReactHandler } from '../../../../src/tools/host-tools/channel-react.js';
import type { ChannelReactArgs } from '../../../../src/tools/host-tools/channel-react.js';
import type { ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import { ChannelError } from '../../../../src/core/errors/error-types.js';
import type { ChannelRegistry } from '../../../../src/channels/channel-registry.js';
import type { MessageRefRow } from '../../../../src/core/database/repositories/message-ref-repository.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as import('pino').Logger;
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: 'run-001',
    threadId: 'thread-001',
    personaId: 'persona-001',
    requestId: 'req-001',
    ...overrides,
  };
}

function makeRef(overrides: Partial<MessageRefRow> = {}): MessageRefRow {
  return {
    thread_id: 'thread-001',
    external_id: '900',
    direction: 'inbound',
    message_id: 'msg-in',
    sender_id: 'alice',
    excerpt: 'remember the dentist tomorrow',
    created_at: 1,
    ...overrides,
  };
}

describe('ChannelReactHandler', () => {
  let react: ReturnType<typeof vi.fn>;
  let connector: Record<string, unknown>;
  let threadRow: { id: string; external_id: string; channel_id: string; metadata: string | null };
  let find: ReturnType<typeof vi.fn>;
  let findTriggerForRun: ReturnType<typeof vi.fn>;

  function makeHandler(options: { withRefs?: boolean } = {}): ChannelReactHandler {
    return new ChannelReactHandler({
      channelRegistry: {
        get: vi.fn((name: string) => (name === 'my-telegram' ? connector : undefined)),
      } as unknown as ChannelRegistry,
      threadRepository: { findById: vi.fn(() => ok(threadRow)) } as any,
      channelRepository: {
        findById: vi.fn(() => ok({ id: 'chan-001', name: 'my-telegram', type: 'telegram' })),
      } as any,
      ...(options.withRefs === false ? {} : { messageRefRepository: { find, findTriggerForRun } }),
      logger: makeLogger(),
    });
  }

  function run(args: ChannelReactArgs, context: Partial<ToolExecutionContext> = {}) {
    return makeHandler().execute(args, makeContext(context));
  }

  beforeEach(() => {
    react = vi.fn().mockResolvedValue(ok(undefined));
    connector = { type: 'telegram', name: 'my-telegram', react };
    threadRow = {
      id: 'thread-001',
      external_id: 'chat-42',
      channel_id: 'chan-001',
      metadata: '{}',
    };
    find = vi.fn().mockReturnValue(ok(null));
    findTriggerForRun = vi.fn().mockReturnValue(ok(makeRef()));
  });

  it('declares the channel.react capability', () => {
    expect(ChannelReactHandler.manifest.name).toBe('channel.react');
    expect(ChannelReactHandler.manifest.capabilities).toEqual(['channel.react:*']);
  });

  it('reacts to the message that triggered the run when no messageId is given', async () => {
    const result = await run({ emoji: '👍' });

    expect(result).toMatchObject({
      tool: 'channel.react',
      status: 'success',
      result: { messageId: '900', emoji: '👍' },
    });
    expect(findTriggerForRun).toHaveBeenCalledWith('run-001');
    expect(react).toHaveBeenCalledWith(
      'chat-42',
      {
        externalMessageId: '900',
        fromSelf: false,
        author: 'alice',
        text: 'remember the dentist tomorrow',
      },
      '👍',
    );
  });

  it('reacts to an explicit messageId completed from the ledger', async () => {
    find.mockReturnValue(
      ok(
        makeRef({ external_id: '4521', direction: 'outbound', sender_id: null, excerpt: 'Done.' }),
      ),
    );

    const result = await run({ emoji: '🎉', messageId: ' 4521 ' });

    expect(result.status).toBe('success');
    expect(find).toHaveBeenCalledWith('thread-001', '4521');
    expect(findTriggerForRun).not.toHaveBeenCalled();
    expect(react).toHaveBeenCalledWith(
      'chat-42',
      { externalMessageId: '4521', fromSelf: true, text: 'Done.' },
      '🎉',
    );
  });

  it('passes an explicit messageId the ledger does not know through by id alone', async () => {
    await run({ emoji: '👍', messageId: '77' });
    expect(react).toHaveBeenCalledWith('chat-42', { externalMessageId: '77' }, '👍');
  });

  it('clears the reaction with remove: true, ignoring any emoji', async () => {
    const result = await run({ remove: true, emoji: '👍' });
    expect(result).toMatchObject({
      status: 'success',
      result: { messageId: '900', removed: true },
    });
    expect(react).toHaveBeenCalledWith(
      'chat-42',
      expect.objectContaining({ externalMessageId: '900' }),
      '',
    );
  });

  it('trims the emoji', async () => {
    await run({ emoji: '  👍 ' });
    expect(react.mock.calls[0][2]).toBe('👍');
  });

  it.each([{}, { emoji: '' }, { emoji: '   ' }, { emoji: 42 as unknown as string }])(
    'rejects a missing emoji: %j',
    async (args) => {
      const result = await run(args);
      expect(result.status).toBe('error');
      expect(result.error).toContain('emoji is required');
      expect(react).not.toHaveBeenCalled();
    },
  );

  it('rejects text that is not a single emoji', async () => {
    const result = await run({ emoji: 'this is a whole sentence, not an emoji at all' });
    expect(result.status).toBe('error');
    expect(react).not.toHaveBeenCalled();
  });

  it('refuses delegated (A2A) runs', async () => {
    const result = await run({ emoji: '👍' }, { a2aTaskId: 'task-1' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('delegated');
    expect(react).not.toHaveBeenCalled();
  });

  it('errors when the run has no trigger message and no messageId was given', async () => {
    findTriggerForRun.mockReturnValue(ok(null));
    const result = await run({ emoji: '👍' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('messageId');
    expect(react).not.toHaveBeenCalled();
  });

  it('errors without a ledger unless a messageId is given', async () => {
    const handler = makeHandler({ withRefs: false });
    expect((await handler.execute({ emoji: '👍' }, makeContext())).status).toBe('error');

    const explicit = await handler.execute({ emoji: '👍', messageId: '5' }, makeContext());
    expect(explicit.status).toBe('success');
    expect(react).toHaveBeenCalledWith('chat-42', { externalMessageId: '5' }, '👍');
  });

  it('errors when the channel does not support reactions', async () => {
    connector = { type: 'email', name: 'my-telegram' };
    const result = await run({ emoji: '👍' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('does not support reactions');
  });

  it('errors when the channel connector is not running', async () => {
    connector = undefined as unknown as Record<string, unknown>;
    const result = await run({ emoji: '👍' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('not running');
  });

  it('surfaces the connector error so the agent can pick another emoji', async () => {
    react.mockResolvedValue(
      err(new ChannelError('Telegram does not allow "✅" as a reaction. Use one of: 👍 ❤')),
    );
    const result = await run({ emoji: '✅' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('Use one of: 👍 ❤');
  });

  it('reacts in the origin chat of a schedule thread', async () => {
    threadRow = {
      id: 'thread-001',
      external_id: 'schedule:persona:my-telegram',
      channel_id: 'chan-001',
      metadata: JSON.stringify({ kind: 'schedule', originExternalId: 'chat-42' }),
    };
    await run({ emoji: '👍', messageId: '5' });
    expect(react).toHaveBeenCalledWith('chat-42', { externalMessageId: '5' }, '👍');
  });

  it('errors on a schedule thread that has no origin chat', async () => {
    threadRow = {
      id: 'thread-001',
      external_id: 'schedule:persona:my-telegram',
      channel_id: 'chan-001',
      metadata: '{}',
    };
    const result = await run({ emoji: '👍', messageId: '5' });
    expect(result.status).toBe('error');
    expect(react).not.toHaveBeenCalled();
  });
});
