/**
 * Unit tests for ChannelBroadcastHandler.
 *
 * Tests cover:
 *   - Fan-out to multiple bound threads with persistence per thread
 *   - Null-thread bindings skipped with warning + reported in summary
 *   - All-null bindings returns delivered=0 with all channels skipped
 *   - Partial connector failure still delivers to remaining channels
 */

import { describe, it, expect, vi } from 'vitest';
import { ok, err } from 'neverthrow';
import { ChannelBroadcastHandler } from '../../../../src/tools/host-tools/channel-broadcast.js';

function makeBindingRepo(rows: any[]) {
  return { findByPersona: vi.fn().mockReturnValue(ok(rows)) } as any;
}

function makeChannelRepo(channels: Record<string, any>) {
  return {
    findById: vi.fn().mockImplementation((id: string) =>
      ok(channels[id] ?? null),
    ),
  } as any;
}

function makeThreadRepo(threads: Record<string, any>) {
  return {
    findById: vi.fn().mockImplementation((id: string) => ok(threads[id] ?? null)),
    findByExternalId: vi.fn().mockImplementation((channelId: string, externalId: string) =>
      ok(Object.values(threads).find((t: any) => t.channel_id === channelId && t.external_id === externalId) ?? null),
    ),
    insert: vi.fn().mockImplementation((input: any) => ok({ ...input, created_at: 0, updated_at: 0 })),
  } as any;
}

function makeMessageRepo() {
  return { insert: vi.fn().mockReturnValue(ok({})) } as any;
}

function makeConnector(result: any) {
  return { send: vi.fn().mockResolvedValue(result) } as any;
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any;
}

const PERSONA_ID = 'persona-1';
const RUN_ID = 'run-001';

describe('ChannelBroadcastHandler', () => {
  it('fans out to all bound threads and persists outbound on each', async () => {
    const bindings = [
      { id: 'b1', channel_id: 'chan-001', thread_id: 'thread-a', persona_id: PERSONA_ID, is_default: 0, created_at: 0, updated_at: 0 },
      { id: 'b2', channel_id: 'chan-002', thread_id: 'thread-b', persona_id: PERSONA_ID, is_default: 0, created_at: 0, updated_at: 0 },
    ];
    const channels = {
      'chan-001': { id: 'chan-001', type: 'telegram', name: 'telegram-main', config: '{}', credentials_ref: null, enabled: 1, created_at: 0, updated_at: 0 },
      'chan-002': { id: 'chan-002', type: 'slack', name: 'slack-work', config: '{}', credentials_ref: null, enabled: 1, created_at: 0, updated_at: 0 },
    };
    const threads = {
      'thread-a': { id: 'thread-a', channel_id: 'chan-001', external_id: 'chat-1', metadata: '{}', created_at: 0, updated_at: 0 },
      'thread-b': { id: 'thread-b', channel_id: 'chan-002', external_id: 'C12345', metadata: '{}', created_at: 0, updated_at: 0 },
    };
    const tgConnector = makeConnector(ok(undefined));
    const slackConnector = makeConnector(ok(undefined));
    const channelRegistry = {
      get: vi.fn().mockImplementation((name: string) =>
        name === 'telegram-main' ? tgConnector : name === 'slack-work' ? slackConnector : undefined,
      ),
    } as any;

    const messageRepo = makeMessageRepo();
    const handler = new ChannelBroadcastHandler({
      channelRegistry,
      bindingRepository: makeBindingRepo(bindings),
      channelRepository: makeChannelRepo(channels),
      threadRepository: makeThreadRepo(threads),
      messageRepository: messageRepo,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      { content: 'morning briefing' },
      { runId: RUN_ID, threadId: 'any', personaId: PERSONA_ID, requestId: 'req-1' },
    );

    expect(result.status).toBe('success');
    expect(tgConnector.send).toHaveBeenCalledWith('chat-1', expect.objectContaining({ body: 'morning briefing' }));
    expect(slackConnector.send).toHaveBeenCalledWith('C12345', expect.objectContaining({ body: 'morning briefing' }));
    expect(messageRepo.insert).toHaveBeenCalledTimes(2);
    expect(messageRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ thread_id: 'thread-a', direction: 'outbound' }));
    expect(messageRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ thread_id: 'thread-b', direction: 'outbound' }));
  });

  it('skips null-thread bindings with a warning and excludes them from delivered count', async () => {
    const bindings = [
      { id: 'b1', channel_id: 'chan-001', thread_id: null, persona_id: PERSONA_ID, is_default: 1, created_at: 0, updated_at: 0 },
      { id: 'b2', channel_id: 'chan-001', thread_id: 'thread-a', persona_id: PERSONA_ID, is_default: 0, created_at: 0, updated_at: 0 },
    ];
    const channels = {
      'chan-001': { id: 'chan-001', type: 'telegram', name: 'telegram-main', config: '{}', credentials_ref: null, enabled: 1, created_at: 0, updated_at: 0 },
    };
    const threads = {
      'thread-a': { id: 'thread-a', channel_id: 'chan-001', external_id: 'chat-1', metadata: '{}', created_at: 0, updated_at: 0 },
    };
    const connector = makeConnector(ok(undefined));
    const channelRegistry = {
      get: vi.fn().mockImplementation((name: string) =>
        name === 'telegram-main' ? connector : undefined,
      ),
    } as any;
    const logger = makeLogger();
    const handler = new ChannelBroadcastHandler({
      channelRegistry,
      bindingRepository: makeBindingRepo(bindings),
      channelRepository: makeChannelRepo(channels),
      threadRepository: makeThreadRepo(threads),
      messageRepository: makeMessageRepo(),
      logger,
    });

    const result = await handler.execute(
      { content: 'ping' },
      { runId: RUN_ID, threadId: 'any', personaId: PERSONA_ID, requestId: 'req-1' },
    );

    expect(result.status).toBe('success');
    expect(connector.send).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'chan-001' }),
      expect.stringMatching(/no thread binding/),
    );
    expect(result.result).toEqual(
      expect.objectContaining({
        delivered: 1,
        skipped: expect.arrayContaining([
          expect.objectContaining({ channelName: 'telegram-main', reason: 'no_thread_binding' }),
        ]),
      }),
    );
  });

  it('returns success with delivered=0 and lists all skipped channels when persona has only null-thread bindings', async () => {
    const bindings = [
      { id: 'b1', channel_id: 'chan-001', thread_id: null, persona_id: PERSONA_ID, is_default: 1, created_at: 0, updated_at: 0 },
    ];
    const channels = {
      'chan-001': { id: 'chan-001', type: 'telegram', name: 'telegram-main', config: '{}', credentials_ref: null, enabled: 1, created_at: 0, updated_at: 0 },
    };
    const handler = new ChannelBroadcastHandler({
      channelRegistry: {
        get: vi.fn().mockImplementation((name: string) =>
          name === 'telegram-main' ? makeConnector(ok(undefined)) : undefined,
        ),
      } as any,
      bindingRepository: makeBindingRepo(bindings),
      channelRepository: makeChannelRepo(channels),
      threadRepository: makeThreadRepo({}),
      messageRepository: makeMessageRepo(),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      { content: 'ping' },
      { runId: RUN_ID, threadId: 'any', personaId: PERSONA_ID, requestId: 'req-1' },
    );

    expect(result.status).toBe('success');
    expect(result.result).toEqual(
      expect.objectContaining({
        delivered: 0,
        skipped: expect.arrayContaining([
          expect.objectContaining({ channelName: 'telegram-main', reason: 'no_thread_binding' }),
        ]),
      }),
    );
  });

  it('continues delivery if one connector fails and reports the failure in the summary', async () => {
    const bindings = [
      { id: 'b1', channel_id: 'chan-001', thread_id: 'thread-a', persona_id: PERSONA_ID, is_default: 0, created_at: 0, updated_at: 0 },
      { id: 'b2', channel_id: 'chan-002', thread_id: 'thread-b', persona_id: PERSONA_ID, is_default: 0, created_at: 0, updated_at: 0 },
    ];
    const channels = {
      'chan-001': { id: 'chan-001', type: 'telegram', name: 'telegram-main', config: '{}', credentials_ref: null, enabled: 1, created_at: 0, updated_at: 0 },
      'chan-002': { id: 'chan-002', type: 'slack', name: 'slack-work', config: '{}', credentials_ref: null, enabled: 1, created_at: 0, updated_at: 0 },
    };
    const threads = {
      'thread-a': { id: 'thread-a', channel_id: 'chan-001', external_id: 'chat-1', metadata: '{}', created_at: 0, updated_at: 0 },
      'thread-b': { id: 'thread-b', channel_id: 'chan-002', external_id: 'C12345', metadata: '{}', created_at: 0, updated_at: 0 },
    };
    const tgConnector = makeConnector(err(new Error('telegram down')));
    const slackConnector = makeConnector(ok(undefined));
    const channelRegistry = {
      get: vi.fn().mockImplementation((name: string) =>
        name === 'telegram-main' ? tgConnector : name === 'slack-work' ? slackConnector : undefined,
      ),
    } as any;

    const handler = new ChannelBroadcastHandler({
      channelRegistry,
      bindingRepository: makeBindingRepo(bindings),
      channelRepository: makeChannelRepo(channels),
      threadRepository: makeThreadRepo(threads),
      messageRepository: makeMessageRepo(),
      logger: makeLogger(),
    });

    const out = await handler.execute(
      { content: 'ping' },
      { runId: RUN_ID, threadId: 'any', personaId: PERSONA_ID, requestId: 'req-1' },
    );

    expect(out.status).toBe('success');
    expect(out.result).toEqual(
      expect.objectContaining({
        delivered: 1,
        failed: expect.arrayContaining([
          expect.objectContaining({ channelName: 'telegram-main', reason: 'send_failed' }),
        ]),
      }),
    );
    expect(slackConnector.send).toHaveBeenCalled();
  });

  it('force-rotates each recipient session when broadcasting from a different thread (scheduled-task case)', async () => {
    const bindings = [
      { id: 'b1', channel_id: 'chan-001', thread_id: 'thread-a', persona_id: PERSONA_ID, is_default: 0, created_at: 0, updated_at: 0 },
      { id: 'b2', channel_id: 'chan-002', thread_id: 'thread-b', persona_id: PERSONA_ID, is_default: 0, created_at: 0, updated_at: 0 },
    ];
    const channels = {
      'chan-001': { id: 'chan-001', type: 'telegram', name: 'telegram-main', config: '{}', credentials_ref: null, enabled: 1, created_at: 0, updated_at: 0 },
      'chan-002': { id: 'chan-002', type: 'slack', name: 'slack-work', config: '{}', credentials_ref: null, enabled: 1, created_at: 0, updated_at: 0 },
    };
    const threads = {
      'thread-a': { id: 'thread-a', channel_id: 'chan-001', external_id: 'chat-1', metadata: '{}', created_at: 0, updated_at: 0 },
      'thread-b': { id: 'thread-b', channel_id: 'chan-002', external_id: 'C12345', metadata: '{}', created_at: 0, updated_at: 0 },
    };
    const tgConnector = makeConnector(ok(undefined));
    const slackConnector = makeConnector(ok(undefined));
    const channelRegistry = {
      get: vi.fn().mockImplementation((name: string) =>
        name === 'telegram-main' ? tgConnector : name === 'slack-work' ? slackConnector : undefined,
      ),
    } as any;

    const sessionTracker = { rotateSession: vi.fn() };
    const handler = new ChannelBroadcastHandler({
      channelRegistry,
      bindingRepository: makeBindingRepo(bindings),
      channelRepository: makeChannelRepo(channels),
      threadRepository: makeThreadRepo(threads),
      messageRepository: makeMessageRepo(),
      sessionTracker,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      { content: 'morning briefing' },
      // Run is on the schedule thread — both recipients are cross-thread.
      { runId: RUN_ID, threadId: 'schedule-thread-001', personaId: PERSONA_ID, requestId: 'req-1' },
    );

    expect(result.status).toBe('success');
    expect(sessionTracker.rotateSession).toHaveBeenCalledWith('thread-a');
    expect(sessionTracker.rotateSession).toHaveBeenCalledWith('thread-b');
    expect(sessionTracker.rotateSession).toHaveBeenCalledTimes(2);
  });

  it('does NOT rotate a recipient whose thread is the same as the run thread', async () => {
    const bindings = [
      { id: 'b1', channel_id: 'chan-001', thread_id: 'thread-a', persona_id: PERSONA_ID, is_default: 0, created_at: 0, updated_at: 0 },
    ];
    const channels = {
      'chan-001': { id: 'chan-001', type: 'telegram', name: 'telegram-main', config: '{}', credentials_ref: null, enabled: 1, created_at: 0, updated_at: 0 },
    };
    const threads = {
      'thread-a': { id: 'thread-a', channel_id: 'chan-001', external_id: 'chat-1', metadata: '{}', created_at: 0, updated_at: 0 },
    };
    const connector = makeConnector(ok(undefined));
    const channelRegistry = {
      get: vi.fn().mockReturnValue(connector),
    } as any;

    const sessionTracker = { rotateSession: vi.fn() };
    const handler = new ChannelBroadcastHandler({
      channelRegistry,
      bindingRepository: makeBindingRepo(bindings),
      channelRepository: makeChannelRepo(channels),
      threadRepository: makeThreadRepo(threads),
      messageRepository: makeMessageRepo(),
      sessionTracker,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      { content: 'inline broadcast' },
      // Run is on the same thread as the only recipient.
      { runId: RUN_ID, threadId: 'thread-a', personaId: PERSONA_ID, requestId: 'req-1' },
    );

    expect(result.status).toBe('success');
    expect(sessionTracker.rotateSession).not.toHaveBeenCalled();
  });
});