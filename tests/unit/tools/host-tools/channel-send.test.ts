/**
 * Unit tests for ChannelSendHandler.
 *
 * Tests cover:
 *   - Successful message send
 *   - Missing/invalid channelId
 *   - Missing/invalid content
 *   - Channel not found in registry
 *   - Connector send failure
 *   - Optional replyTo field
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import type Database from 'better-sqlite3';
import pino from 'pino';
import { createTestDb } from '../../core/database/repositories/helpers.js';
import { ChannelRegistry as LiveChannelRegistry } from '../../../../src/channels/channel-registry.js';
import { ChannelRepository } from '../../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../../src/core/database/repositories/thread-repository.js';
import { PersonaRepository } from '../../../../src/core/database/repositories/persona-repository.js';
import { RunRepository } from '../../../../src/core/database/repositories/run-repository.js';
import { QueueRepository } from '../../../../src/core/database/repositories/queue-repository.js';
import { MessageRepository } from '../../../../src/core/database/repositories/message-repository.js';
import { BindingRepository } from '../../../../src/core/database/repositories/binding-repository.js';
import { SignalAccountStateRepository } from '../../../../src/core/database/repositories/signal-account-state-repository.js';
import { SignalDestinationLeaseRepository } from '../../../../src/core/database/repositories/signal-destination-lease-repository.js';
import { SignalConnector } from '../../../../src/channels/connectors/signal/signal-connector.js';
import { SignalDeviceRegistry } from '../../../../src/channels/connectors/signal/signal-device-registry.js';
import { SignalConfigSchema } from '../../../../src/channels/connectors/signal/signal-config.js';
import type { SignalRpcRequest } from '../../../../src/channels/connectors/signal/signal-wire.js';
import { ok, err } from 'neverthrow';
import { ChannelSendHandler } from '../../../../src/tools/host-tools/channel-send.js';
import { ChannelBroadcastHandler } from '../../../../src/tools/host-tools/channel-broadcast.js';
import { ChannelListHandler } from '../../../../src/tools/host-tools/channel-list.js';
import { SignalInvocationGuard } from '../../../../src/daemon/signal-invocation-guard.js';
import { SignalToolExecutionRegistry, signalToolFailure } from '../../../../src/tools/host-tools/signal-tool-execution.js';
import { PersonaLoader } from '../../../../src/personas/persona-loader.js';
import { isToolAllowed } from '../../../../src/tools/tool-filter.js';
import { PersonaConfigSchema } from '../../../../src/core/config/config-schema.js';
import { DbError, SignalDeliveryError } from '../../../../src/core/errors/error-types.js';
import type { ChannelSendArgs, ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import { ChannelError } from '../../../../src/core/errors/error-types.js';
import type { ChannelRegistry } from '../../../../src/channels/channel-registry.js';
import type { ChannelConnector } from '../../../../src/channels/channel-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeThreadRepo() {
  return {
    findById: vi.fn().mockReturnValue(ok({ id: 'thread-001', external_id: 'ext-001', channel_id: 'chan-001' })),
  } as any;
}

function makeChannelRepo() {
  return {
    findByName: vi.fn().mockReturnValue(ok({
      id: 'chan-001',
      type: 'telegram',
      name: 'my-telegram',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
      created_at: 0,
      updated_at: 0,
    })),
  } as any;
}

function makeMessageRepo() {
  return {
    insert: vi.fn().mockReturnValue(ok({})),
  } as any;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
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

function makeArgs(overrides: Partial<ChannelSendArgs> = {}): ChannelSendArgs {
  return {
    channelId: 'my-telegram',
    content: 'Hello from persona!',
    ...overrides,
  };
}

function makeConnector(sendResult: Awaited<ReturnType<ChannelConnector['send']>> = ok(undefined)): ChannelConnector {
  return {
    type: 'telegram',
    name: 'my-telegram',
    start: vi.fn(),
    stop: vi.fn(),
    onMessage: vi.fn(),
    send: vi.fn().mockResolvedValue(sendResult),
    format: vi.fn((s: string) => s),
  };
}

function makeRegistry(connector?: ChannelConnector): ChannelRegistry {
  return {
    get: vi.fn().mockReturnValue(connector),
    register: vi.fn(),
    unregister: vi.fn(),
    getByType: vi.fn(),
    listAll: vi.fn(),
    startAll: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as ChannelRegistry;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — manifest', () => {
  it('has the correct tool name', () => {
    expect(ChannelSendHandler.manifest.name).toBe('channel.send');
  });

  it('has executionLocation set to host', () => {
    expect(ChannelSendHandler.manifest.executionLocation).toBe('host');
  });

  it('declares channel.send:* capability', () => {
    expect(ChannelSendHandler.manifest.capabilities).toContain('channel.send:*');
  });
});

// ---------------------------------------------------------------------------
// Successful execution
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — success', () => {
  it('sends a message and returns success result', async () => {
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('success');
    expect(result.tool).toBe('channel.send');
    expect(result.requestId).toBe('req-001');
    expect(result.result).toEqual({ channelId: 'my-telegram', sent: true });
  });

  it('calls connector.send with thread-scoped externalThreadId', async () => {
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    await handler.execute(makeArgs(), makeContext({ threadId: 'thread-xyz' }));

    expect(connector.send).toHaveBeenCalledWith('ext-001', expect.objectContaining({ body: 'Hello from persona!' }));
  });

  it('uses one stable messageId for connector delivery and outbound persistence', async () => {
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: {
        findById: vi.fn().mockReturnValue(ok({
          id: 'thread-001',
          external_id: 'ext-001',
          channel_id: 'chan-001',
          metadata: '{}',
        })),
        findByExternalId: vi.fn().mockReturnValue(ok({
          id: 'thread-001',
          external_id: 'ext-001',
          channel_id: 'chan-001',
          metadata: '{}',
          created_at: 0,
          updated_at: 0,
        })),
      } as any,
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      logger: makeLogger(),
    });

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('success');
    const connectorOutput = vi.mocked(connector.send).mock.calls[0]?.[1] as { messageId?: string };
    const persistedMessage = vi.mocked(messageRepo.insert).mock.calls[0]?.[0] as { id?: string };
    expect(connectorOutput.messageId).toBeDefined();
    expect(connectorOutput.messageId).toBe(persistedMessage.id);
  });

  it('uses the trusted context runId for sourceRunId', async () => {
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepo(),
      logger: makeLogger(),
    });
    const args = {
      ...makeArgs(),
      sourceRunId: 'attacker-supplied-source-run-id',
      runId: 'attacker-supplied-run-id',
    } as ChannelSendArgs;

    await handler.execute(args, makeContext({ runId: 'trusted-context-run-id' }));

    const output = vi.mocked(connector.send).mock.calls[0]?.[1] as {
      messageId?: string;
      sourceRunId?: string;
      runId?: string;
    };
    expect(output.sourceRunId).toBe('trusted-context-run-id');
    expect(output.sourceRunId).not.toBe('attacker-supplied-source-run-id');
    expect(output.runId).toBeUndefined();
    expect(output.messageId).toBeDefined();
  });

  it('keeps same-text deliveries distinct', async () => {
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const threadRepository = {
      findById: vi.fn().mockReturnValue(ok({
        id: 'thread-001',
        external_id: 'ext-001',
        channel_id: 'chan-001',
        metadata: '{}',
      })),
      findByExternalId: vi.fn().mockReturnValue(ok({
        id: 'thread-001',
        external_id: 'ext-001',
        channel_id: 'chan-001',
        metadata: '{}',
        created_at: 0,
        updated_at: 0,
      })),
    } as any;
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository,
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      logger: makeLogger(),
    });

    await handler.execute(makeArgs({ content: 'same text' }), makeContext({ requestId: 'req-001' }));
    await handler.execute(makeArgs({ content: 'same text' }), makeContext({ requestId: 'req-002' }));

    const firstId = vi.mocked(messageRepo.insert).mock.calls[0]?.[0].id;
    const secondId = vi.mocked(messageRepo.insert).mock.calls[1]?.[0].id;
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);
    expect(vi.mocked(connector.send).mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ messageId: firstId }),
    );
    expect(vi.mocked(connector.send).mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ messageId: secondId }),
    );
  });

  it('passes replyTo to the connector as an explicit reply target', async () => {
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    await handler.execute(makeArgs({ replyTo: 'msg-123' }), makeContext());

    expect(connector.send).toHaveBeenCalledWith(
      'ext-001',
      expect.objectContaining({ replyTo: { externalMessageId: 'msg-123' } }),
    );
  });

  it('sends no reply target when replyTo is absent or blank', async () => {
    const connector = makeConnector(ok(undefined));
    const handler = new ChannelSendHandler({ channelRegistry: makeRegistry(connector), threadRepository: makeThreadRepo(), logger: makeLogger() });

    await handler.execute(makeArgs(), makeContext());
    await handler.execute(makeArgs({ replyTo: '   ' }), makeContext());

    for (const call of vi.mocked(connector.send).mock.calls) {
      expect(call[1]).not.toHaveProperty('replyTo');
    }
  });

  it('completes the reply target from the ledger of the recipient thread', async () => {
    const connector = makeConnector(ok(undefined));
    const threadRepository = {
      findById: vi.fn().mockReturnValue(ok({ id: 'thread-001', external_id: 'ext-001', channel_id: 'chan-001' })),
      findByExternalId: vi.fn().mockReturnValue(ok({ id: 'thread-001', external_id: 'ext-001', channel_id: 'chan-001' })),
    } as any;
    const messageRefRepository = {
      find: vi.fn().mockReturnValue(ok({
        thread_id: 'thread-001',
        external_id: 'msg-123',
        direction: 'inbound',
        message_id: 'm1',
        sender_id: 'alice@s.whatsapp.net',
        excerpt: 'can you check this?',
        created_at: 1,
      })),
      record: vi.fn().mockReturnValue(ok(undefined)),
    };
    const handler = new ChannelSendHandler({
      channelRegistry: makeRegistry(connector),
      threadRepository,
      channelRepository: makeChannelRepo(),
      messageRefRepository,
      logger: makeLogger(),
    });

    await handler.execute(makeArgs({ replyTo: 'msg-123' }), makeContext());

    expect(messageRefRepository.find).toHaveBeenCalledWith('thread-001', 'msg-123');
    expect(connector.send).toHaveBeenCalledWith(
      'ext-001',
      expect.objectContaining({
        replyTo: {
          externalMessageId: 'msg-123',
          fromSelf: false,
          author: 'alice@s.whatsapp.net',
          text: 'can you check this?',
        },
      }),
    );
  });

  it('records the sent message in the ledger of the thread it was persisted to', async () => {
    const connector = makeConnector(ok({ externalMessageId: 'tg-555' }));
    const threadRepository = {
      findById: vi.fn().mockReturnValue(ok({ id: 'thread-001', external_id: 'ext-001', channel_id: 'chan-001' })),
      findByExternalId: vi.fn().mockReturnValue(ok({ id: 'thread-001', external_id: 'ext-001', channel_id: 'chan-001' })),
    } as any;
    const messageRepository = makeMessageRepo();
    const messageRefRepository = {
      find: vi.fn().mockReturnValue(ok(null)),
      record: vi.fn().mockReturnValue(ok(undefined)),
    };
    const handler = new ChannelSendHandler({
      channelRegistry: makeRegistry(connector),
      threadRepository,
      channelRepository: makeChannelRepo(),
      messageRepository,
      messageRefRepository,
      logger: makeLogger(),
    });

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('success');
    const persisted = vi.mocked(messageRepository.insert).mock.calls[0][0] as { id: string };
    expect(messageRefRepository.record).toHaveBeenCalledWith({
      thread_id: 'thread-001',
      external_id: 'tg-555',
      direction: 'outbound',
      message_id: persisted.id,
      text: 'Hello from persona!',
    });
  });

  it('records no ledger ref when the connector returns no receipt', async () => {
    const connector = makeConnector(ok(undefined));
    const threadRepository = {
      findById: vi.fn().mockReturnValue(ok({ id: 'thread-001', external_id: 'ext-001', channel_id: 'chan-001' })),
      findByExternalId: vi.fn().mockReturnValue(ok({ id: 'thread-001', external_id: 'ext-001', channel_id: 'chan-001' })),
    } as any;
    const messageRefRepository = {
      find: vi.fn().mockReturnValue(ok(null)),
      record: vi.fn().mockReturnValue(ok(undefined)),
    };
    const handler = new ChannelSendHandler({
      channelRegistry: makeRegistry(connector),
      threadRepository,
      channelRepository: makeChannelRepo(),
      messageRepository: makeMessageRepo(),
      messageRefRepository,
      logger: makeLogger(),
    });

    await handler.execute(makeArgs(), makeContext());

    expect(messageRefRepository.record).not.toHaveBeenCalled();
  });

  it('uses unknown as requestId when context.requestId is not provided', async () => {
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const context = makeContext();
    delete (context as Partial<ToolExecutionContext>).requestId;
    const result = await handler.execute(makeArgs(), context);

    expect(result.requestId).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Arg validation failures
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — arg validation', () => {
  it('returns error when channelId is missing', async () => {
    const registry = makeRegistry();
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs({ channelId: '' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/channelId is required/);
  });

  it('returns error when channelId is whitespace', async () => {
    const registry = makeRegistry();
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs({ channelId: '   ' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/channelId is required/);
  });

  it('returns error when content is missing', async () => {
    const registry = makeRegistry();
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs({ content: '' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/content is required/);
  });

  it('returns error when content is whitespace', async () => {
    const registry = makeRegistry();
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs({ content: '   ' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/content is required/);
  });
});

// ---------------------------------------------------------------------------
// Channel not found
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — channel not found', () => {
  it('returns error when channel is not in registry', async () => {
    const registry = makeRegistry(undefined);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs({ channelId: 'unknown-channel' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/not found in registry/);
  });
});

// ---------------------------------------------------------------------------
// Connector send failure
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — connector send failure', () => {
  it('returns error when connector.send returns an Err result', async () => {
    const channelErr = new ChannelError('Telegram API timeout');
    const connector = makeConnector(err(channelErr));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/failed to send message/);
    expect(result.error).toMatch(/Telegram API timeout/);
  });
});

// ---------------------------------------------------------------------------
// Schedule-thread delivery routing
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — schedule-thread routing', () => {
  it('delivers to the origin external_id when the thread metadata marks it as a schedule thread', async () => {
    // Dedicated schedule execution threads created by schedule.manage have
    // kind='schedule' + originExternalId set — channel.send must route to the
    // origin chat, not the synthetic schedule thread id (issue #200).
    const threadRepo = {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'dedicated-schedule-thread-001',
          channel_id: 'chan-001',
          external_id: 'schedule:assistant:telegram-main:chat-42',
          metadata: JSON.stringify({
            kind: 'schedule',
            originExternalId: 'chat-42',
            personaName: 'assistant',
            channelName: 'telegram-main',
          }),
        }),
      ),
    } as any;
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threadRepo,
      logger: makeLogger(),
    });

    await handler.execute(makeArgs(), makeContext({ threadId: 'dedicated-schedule-thread-001' }));

    expect(connector.send).toHaveBeenCalledWith(
      'chat-42',
      expect.objectContaining({ body: 'Hello from persona!' }),
    );
  });

  it('persists scheduled channel_send output to the origin live thread', async () => {
    const liveThread = {
      id: 'live-thread-001',
      channel_id: 'chan-001',
      external_id: 'chat-42',
      metadata: '{}',
      created_at: 0,
      updated_at: 0,
    };
    const threadRepo = {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'dedicated-schedule-thread-001',
          channel_id: 'chan-001',
          external_id: 'schedule:assistant:telegram-main:chat-42',
          metadata: JSON.stringify({
            kind: 'schedule',
            originExternalId: 'chat-42',
            personaName: 'assistant',
            channelName: 'telegram-main',
          }),
        }),
      ),
      findByExternalId: vi.fn().mockReturnValue(ok(liveThread)),
      insert: vi.fn(),
    } as any;
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threadRepo,
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'Are you still joining the 16:30 sync?' }),
      makeContext({
        runId: 'run-schedule-001',
        requestId: 'tool-call-001',
        threadId: 'dedicated-schedule-thread-001',
      }),
    );

    expect(result.status).toBe('success');
    expect(connector.send).toHaveBeenCalledWith(
      'chat-42',
      expect.objectContaining({ body: 'Are you still joining the 16:30 sync?' }),
    );
    expect(threadRepo.findByExternalId).toHaveBeenCalledWith('chan-001', 'chat-42');
    expect(messageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: 'live-thread-001',
        direction: 'outbound',
        content: JSON.stringify({ body: 'Are you still joining the 16:30 sync?' }),
        idempotency_key: 'channel-send:run-schedule-001:tool-call-001',
        run_id: 'run-schedule-001',
      }),
    );
  });

  it('falls back to the thread external_id when metadata is not a schedule marker', async () => {
    const threadRepo = {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'live-thread-001',
          channel_id: 'chan-001',
          external_id: 'chat-42',
          metadata: JSON.stringify({ kind: 'live' }),
        }),
      ),
    } as any;
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threadRepo,
      logger: makeLogger(),
    });

    await handler.execute(makeArgs(), makeContext());

    expect(connector.send).toHaveBeenCalledWith(
      'chat-42',
      expect.any(Object),
    );
  });

  it('ignores malformed metadata JSON and falls back to the thread external_id', async () => {
    const threadRepo = {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'live-thread-001',
          channel_id: 'chan-001',
          external_id: 'chat-42',
          metadata: '{not-json',
        }),
      ),
    } as any;
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threadRepo,
      logger: makeLogger(),
    });

    await handler.execute(makeArgs(), makeContext());

    expect(connector.send).toHaveBeenCalledWith('chat-42', expect.any(Object));
  });
});

// ---------------------------------------------------------------------------
// Fail-loud on missing thread
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — missing thread fail-loud', () => {
  it('returns a ToolError and does not call connector.send when the thread row is missing', async () => {
    // Regression: before PR #201 review feedback, channel.send fell back
    // to context.threadId (a UUID) when the thread row was missing,
    // sending an unresolvable recipient to Telegram/Slack/Discord and
    // producing "chat not found" errors the agent paraphrased as
    // "channel unreachable — delivering inline" (silent delivery loss).
    const threadRepo = {
      findById: vi.fn().mockReturnValue(ok(null)),
    } as any;
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threadRepo,
      logger: makeLogger(),
    });

    const result = await handler.execute(makeArgs(), makeContext({ threadId: 'missing-thread-uuid' }));

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/thread "missing-thread-uuid" not found/);
    expect(connector.send).not.toHaveBeenCalled();
  });

  it('returns a ToolError when the thread lookup itself fails', async () => {
    const { DbError } = await import('../../../../src/core/errors/error-types.js');
    const { err: errFn } = await import('neverthrow');
    const threadRepo = {
      findById: vi.fn().mockReturnValue(errFn(new DbError('db locked'))),
    } as any;
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threadRepo,
      logger: makeLogger(),
    });

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/failed to resolve thread/);
    expect(connector.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// externalChatId resolution
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — externalChatId resolution', () => {
  it('uses explicit externalChatId in preference to schedule-thread originExternalId', async () => {
    const threadRepo = {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'dedicated-schedule-thread-001',
          channel_id: 'chan-001',
          external_id: 'schedule:assistant:telegram-main:chat-42',
          metadata: JSON.stringify({
            kind: 'schedule',
            originExternalId: 'chat-42',
            personaName: 'assistant',
            channelName: 'telegram-main',
          }),
        }),
      ),
      findByExternalId: vi.fn().mockReturnValue(
        ok({
          id: 'live-thread-999',
          channel_id: 'chan-001',
          external_id: 'chat-999',
          metadata: '{}',
          created_at: 0,
          updated_at: 0,
        }),
      ),
      insert: vi.fn(),
    } as any;
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threadRepo,
      channelRepository: makeChannelRepo(),
      messageRepository: makeMessageRepo(),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ channelId: 'my-telegram', content: 'ping', externalChatId: 'chat-999' }),
      makeContext({
        runId: 'run-001',
        requestId: 'tool-001',
        threadId: 'dedicated-schedule-thread-001',
      }),
    );

    expect(result.status).toBe('success');
    expect(connector.send).toHaveBeenCalledWith(
      'chat-999',
      expect.objectContaining({ body: 'ping' }),
    );
    expect(threadRepo.findByExternalId).toHaveBeenCalledWith('chan-001', 'chat-999');
  });

  it('errors with a pointer to channel.list / channel.broadcast when no originExternalId and no externalChatId and synthetic thread external_id', async () => {
    const threadRepo = {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'cli-schedule-thread-001',
          channel_id: 'chan-001',
          external_id: 'schedule:assistant:telegram-main',
          metadata: '{}',
        }),
      ),
      findByExternalId: vi.fn(),
      insert: vi.fn(),
    } as any;
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threadRepo,
      channelRepository: makeChannelRepo(),
      messageRepository: makeMessageRepo(),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ channelId: 'my-telegram', content: 'ping' }),
      makeContext({
        runId: 'run-001',
        requestId: 'tool-001',
        threadId: 'cli-schedule-thread-001',
      }),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/externalChatId/);
    expect(result.error).toMatch(/channel\.list|channel\.broadcast/);
    expect(connector.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Binding-gated outbound persistence
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — binding-gated persistence', () => {
  function makeBindingRepo(opts: { scoped?: any | null; default?: any | null }) {
    return {
      findByChannelAndThread: vi.fn().mockReturnValue(ok(opts.scoped ?? null)),
      findDefaultForChannel: vi.fn().mockReturnValue(ok(opts.default ?? null)),
    } as any;
  }

  function makeThreadRepoWithExternal(externalThread: any) {
    return {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'dedicated-schedule-thread-001',
          channel_id: 'chan-001',
          external_id: 'schedule:assistant:telegram-main:chat-42',
          metadata: JSON.stringify({ kind: 'schedule', originExternalId: 'chat-42' }),
        }),
      ),
      findByExternalId: vi.fn().mockReturnValue(ok(externalThread)),
      insert: vi.fn(),
    } as any;
  }

  const liveThread = {
    id: 'live-thread-001',
    channel_id: 'chan-001',
    external_id: 'chat-42',
    metadata: '{}',
    created_at: 0,
    updated_at: 0,
  };

  it('persists outbound when a thread-scoped binding matches the current persona', async () => {
    const binding = {
      id: 'b1',
      channel_id: 'chan-001',
      thread_id: 'live-thread-001',
      persona_id: 'persona-001',
      is_default: 0,
      created_at: 0,
      updated_at: 0,
    };
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: makeBindingRepo({ scoped: binding }),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'hi' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001' }),
    );

    expect(result.status).toBe('success');
    expect(messageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ thread_id: 'live-thread-001', direction: 'outbound' }),
    );
  });

  it('persists outbound when only a channel-default binding matches (no thread-scoped binding)', async () => {
    // Regression guard: default-bound conversations (thread_id IS NULL on
    // the binding) must still persist outbound context, mirroring
    // ChannelRouter.resolvePersona's fallback to the channel-default
    // binding.
    const defaultBinding = {
      id: 'bd',
      channel_id: 'chan-001',
      thread_id: null,
      persona_id: 'persona-001',
      is_default: 1,
      created_at: 0,
      updated_at: 0,
    };
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: makeBindingRepo({ scoped: null, default: defaultBinding }),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'hi', externalChatId: 'chat-42' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001', personaId: 'persona-001' }),
    );

    expect(result.status).toBe('success');
    expect(messageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ thread_id: 'live-thread-001', direction: 'outbound' }),
    );
  });

  it('skips outbound persistence when no binding exists for the target channel/thread', async () => {
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: makeBindingRepo({ scoped: null, default: null }),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'hi', externalChatId: 'chat-42' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001' }),
    );

    expect(result.status).toBe('success');
    expect(connector.send).toHaveBeenCalledWith('chat-42', expect.any(Object));
    expect(messageRepo.insert).not.toHaveBeenCalled();
  });

  it('skips outbound persistence when both scoped and default bindings belong to a different persona', async () => {
    const otherScoped = {
      id: 'b9',
      channel_id: 'chan-001',
      thread_id: 'live-thread-001',
      persona_id: 'persona-other',
      is_default: 0,
      created_at: 0,
      updated_at: 0,
    };
    const otherDefault = {
      id: 'bd2',
      channel_id: 'chan-001',
      thread_id: null,
      persona_id: 'persona-other',
      is_default: 1,
      created_at: 0,
      updated_at: 0,
    };
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: makeBindingRepo({ scoped: otherScoped, default: otherDefault }),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'hi', externalChatId: 'chat-42' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001', personaId: 'persona-001' }),
    );

    expect(result.status).toBe('success');
    expect(connector.send).toHaveBeenCalledWith('chat-42', expect.any(Object));
    expect(messageRepo.insert).not.toHaveBeenCalled();
  });

  it('skips persistence when thread is scoped to a different persona even if channel-default matches current persona', async () => {
    // Mirrors ChannelRouter.resolvePersona: a thread-scoped binding for a
    // different persona blocks the current persona from claiming the
    // thread via the channel-default binding. Persistence must follow the
    // same rule or the persona would pollute a thread the router would
    // never route its inbound to.
    const otherScoped = {
      id: 'b9',
      channel_id: 'chan-001',
      thread_id: 'live-thread-001',
      persona_id: 'persona-other',
      is_default: 0,
      created_at: 0,
      updated_at: 0,
    };
    const myDefault = {
      id: 'bd3',
      channel_id: 'chan-001',
      thread_id: null,
      persona_id: 'persona-001',
      is_default: 1,
      created_at: 0,
      updated_at: 0,
    };
    const messageRepo = makeMessageRepo();
    const bindingRepo = makeBindingRepo({ scoped: otherScoped, default: myDefault });
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: bindingRepo,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'hi', externalChatId: 'chat-42' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001', personaId: 'persona-001' }),
    );

    expect(result.status).toBe('success');
    expect(connector.send).toHaveBeenCalledWith('chat-42', expect.any(Object));
    expect(bindingRepo.findDefaultForChannel).not.toHaveBeenCalled();
    expect(messageRepo.insert).not.toHaveBeenCalled();
  });
});

describe('ChannelSendHandler — cross-thread session rotation', () => {
  function makeBindingRepo(opts: { scoped?: any | null; default?: any | null }) {
    return {
      findByChannelAndThread: vi.fn().mockReturnValue(ok(opts.scoped ?? null)),
      findDefaultForChannel: vi.fn().mockReturnValue(ok(opts.default ?? null)),
    } as any;
  }

  function makeThreadRepoWithExternal(externalThread: any) {
    return {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'schedule-thread-001',
          channel_id: 'chan-001',
          external_id: 'schedule:assistant:telegram-main:chat-42',
          metadata: JSON.stringify({ kind: 'schedule', originExternalId: 'chat-42' }),
        }),
      ),
      findByExternalId: vi.fn().mockReturnValue(ok(externalThread)),
      insert: vi.fn(),
    } as any;
  }

  const liveThread = {
    id: 'live-thread-001',
    channel_id: 'chan-001',
    external_id: 'chat-42',
    metadata: '{}',
    created_at: 0,
    updated_at: 0,
  };

  const scopedBinding = {
    id: 'b1',
    channel_id: 'chan-001',
    thread_id: 'live-thread-001',
    persona_id: 'persona-001',
    is_default: 0,
    created_at: 0,
    updated_at: 0,
  };

  it('force-rotates the recipient session when the run is on a different thread (scheduled-task case)', async () => {
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const sessionTracker = { rotateSession: vi.fn() };
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: makeBindingRepo({ scoped: scopedBinding }),
      sessionTracker,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'What is on your plate today?' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001', threadId: 'schedule-thread-001' }),
    );

    expect(result.status).toBe('success');
    expect(messageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ thread_id: 'live-thread-001', direction: 'outbound' }),
    );
    // Recipient thread's session is rotated so the next run there starts
    // fresh and ContextAssembler injects the scheduled outbound.
    expect(sessionTracker.rotateSession).toHaveBeenCalledWith('live-thread-001');
  });

  it('does NOT rotate when the recipient thread is the same as the run thread (inline reply)', async () => {
    // Same-thread delivery: the outbound is part of the current run's own
    // conversation. The codex session for this thread already includes it
    // (the agent just generated it). Rotating would needlessly destroy
    // the session and force a cache miss on the next run.
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const sessionTracker = { rotateSession: vi.fn() };
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: makeBindingRepo({ scoped: scopedBinding }),
      sessionTracker,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'inline reply' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001', threadId: 'live-thread-001' }),
    );

    expect(result.status).toBe('success');
    expect(messageRepo.insert).toHaveBeenCalled();
    expect(sessionTracker.rotateSession).not.toHaveBeenCalled();
  });

  it('does NOT rotate when persistence fails (message not in DB, rotation would not help)', async () => {
    const messageRepo = makeMessageRepo();
    (messageRepo.insert as any).mockReturnValue(err(new Error('disk full')));
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const sessionTracker = { rotateSession: vi.fn() };
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: makeBindingRepo({ scoped: scopedBinding }),
      sessionTracker,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'hi' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001', threadId: 'schedule-thread-001' }),
    );

    expect(result.status).toBe('success');
    expect(sessionTracker.rotateSession).not.toHaveBeenCalled();
  });

  it('works without a sessionTracker (no rotation, no error)', async () => {
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: makeBindingRepo({ scoped: scopedBinding }),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'hi' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001', threadId: 'schedule-thread-001' }),
    );

    expect(result.status).toBe('success');
    expect(messageRepo.insert).toHaveBeenCalled();
  });
});

describe('ChannelSendHandler — inbound channel and recipient resolution', () => {
  function setup(
    threadExternalId = 'chat-123',
    currentChannelType = 'telegram',
  ) {
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    vi.mocked(registry.get).mockImplementation((name: string) =>
      name === connector.name ? connector : undefined);
    const threadRepository = {
      findById: vi.fn().mockReturnValue(ok({
        id: 'thread-001',
        channel_id: 'chan-001',
        external_id: threadExternalId,
        metadata: '{}',
      })),
    } as any;
    const channelRepository = {
      findById: vi.fn().mockReturnValue(ok({
        id: 'chan-001', name: 'my-telegram', type: currentChannelType,
      })),
      findByName: vi.fn(),
    } as any;
    return {
      connector,
      registry,
      threadRepository,
      channelRepository,
      handler: new ChannelSendHandler({
        channelRegistry: registry,
        threadRepository,
        channelRepository,
        logger: makeLogger(),
      }),
    };
  }

  it('prefers an existing channel literally named telegram over the inbound alias', async () => {
    const { handler, connector, registry } = setup();
    const main = { ...makeConnector(ok(undefined)), name: 'telegram', send: vi.fn().mockResolvedValue(ok(undefined)) };
    vi.mocked(registry.get).mockImplementation((name: string) =>
      name === 'telegram' ? main : name === 'my-telegram' ? connector : undefined);
    const result = await handler.execute(makeArgs({ channelId: 'telegram' }), makeContext());
    expect(result.status).toBe('success');
    expect(result.result).toEqual({ channelId: 'telegram', sent: true });
    expect(main.send).toHaveBeenCalledWith('chat-123', expect.anything());
    expect(connector.send).not.toHaveBeenCalled();
  });

  it('resolves a Slack provider-type alias against the inbound Slack channel', async () => {
    const { handler, connector, registry, channelRepository } = setup('chat-123', 'slack');
    vi.mocked(registry.get).mockImplementation((name: string) =>
      name === 'my-telegram' ? connector : undefined);
    const result = await handler.execute(makeArgs({ channelId: 'slack' }), makeContext());
    expect(result.status).toBe('success');
    expect(result.result).toEqual({ channelId: 'my-telegram', sent: true });
    expect(connector.send).toHaveBeenCalledWith('chat-123', expect.anything());
    expect(channelRepository.findById).toHaveBeenCalled();
  });

  it('never resolves provider-type aliases for explicit cross-chat recipients', async () => {
    const { handler, connector, registry } = setup();
    vi.mocked(registry.get).mockImplementation((name: string) =>
      name === 'my-telegram' ? connector : undefined);
    const result = await handler.execute(
      makeArgs({ channelId: 'telegram', externalChatId: 'chat-456' }), makeContext());
    expect(result.status).toBe('error');
    expect(connector.send).not.toHaveBeenCalled();
  });

  it('maps the telegram provider alias to the registered inbound channel', async () => {
    const { handler, connector } = setup();
    const result = await handler.execute(makeArgs({ channelId: 'telegram' }), makeContext());
    expect(result.status).toBe('success');
    expect(result.result).toEqual({ channelId: 'my-telegram', sent: true });
    expect(connector.send).toHaveBeenCalledWith('chat-123', expect.anything());
  });

  it('uses the current chat when the optional explicit recipient is blank', async () => {
    const { handler, connector } = setup();
    const result = await handler.execute(makeArgs({
      channelId: 'telegram',
      externalChatId: '   ',
    }), makeContext());
    expect(result.status).toBe('success');
    expect(connector.send).toHaveBeenCalledWith('chat-123', expect.anything());
  });

  it('falls back to the current chat for blank explicit recipient on the configured channel', async () => {
    const { handler, connector } = setup();
    const result = await handler.execute(makeArgs({ externalChatId: '' }), makeContext());
    expect(result.status).toBe('success');
    expect(connector.send).toHaveBeenCalledWith('chat-123', expect.anything());
  });

  it('preserves nonblank explicit cross-chat destinations', async () => {
    const { handler, connector } = setup();
    const result = await handler.execute(makeArgs({ externalChatId: '  chat-456  ' }), makeContext());
    expect(result.status).toBe('success');
    expect(connector.send).toHaveBeenCalledWith('chat-456', expect.anything());
  });

  it('does not resolve a telegram alias against a different provider type', async () => {
    const { handler, connector } = setup('chat-123', 'discord');
    const result = await handler.execute(makeArgs({ channelId: 'telegram' }), makeContext());
    expect(result.status).toBe('error');
    expect(connector.send).not.toHaveBeenCalled();
  });

  it('does not route a provider alias from a synthetic schedule thread', async () => {
    const { handler, connector } = setup('schedule:assistant:telegram-main');
    const result = await handler.execute(makeArgs({ channelId: 'telegram' }), makeContext());
    expect(result.status).toBe('error');
    expect(connector.send).not.toHaveBeenCalled();
  });
});

// Private source-shaped Unix peer, never real Signal/live bridge evidence.
// v0.14.9/3997429779095ff3a2d64c877126e84fce9852aa:
// VersionCommand.java:60-66; ListAccountsCommand.java:12-47;
// ListDevicesCommand.java:40-67; SignalJsonRpcDispatcherHandler.java:255-280;
// JsonRpcResponse.java:13-46; ListContactsCommand.java:30-65,117-167;
// JsonContact.java:9-29; ListGroupsCommand.java:105-179;
// JsonSendMessageResult.java:10-48; JsonRecipientAddress.java:9-15;
// SendMessageResultUtils.java:43-68; SignalJsonRpcCommandHandler.java:229-290.
describe('Signal channel tools — actual connector/guard/SQLite boundary', () => {
  const account = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const otherAccount = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const self = `signal:v1:${account}:self`;
  const group = `signal:v1:${account}:group:QQ`;
  type Request = SignalRpcRequest & { readonly id: string };
  type SendRequest = Extract<Request, { method: 'send' }>;
  let db: Database.Database;
  let queue: QueueRepository;
  let runs: RunRepository;
  let threads: ThreadRepository;
  let channels: ChannelRepository;
  let messages: MessageRepository;
  let bindings: BindingRepository;
  let accounts: SignalAccountStateRepository;
  let leases: SignalDestinationLeaseRepository;
  let registry: LiveChannelRegistry;
  let connectors: SignalConnector[];
  let directory: string;
  let server: Server;
  let sockets: Socket[];
  let requests: Request[];
  let answerSend: (request: SendRequest, socket: Socket) => void;
  let blockedTarget: boolean;
  let context: ToolExecutionContext;
  let executions: SignalToolExecutionRegistry | undefined;
  let personas: PersonaLoader;
  let guards: SignalInvocationGuard[];
  const logger = pino({ level: 'silent' });

  function reply(socket: Socket, request: Request, result: unknown): void {
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  }
  function recipient(type = 'SUCCESS'): {
    type: string;
    recipientAddress: { uuid: string; number: null; username: null };
  } {
    return { type, recipientAddress: { uuid: account, number: null, username: null } };
  }
  async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 2000 && !predicate(); i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(predicate()).toBe(true);
  }
  async function finish<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    void promise.then(() => {
      done = true;
    });
    for (let i = 0; i < 200 && !done; i++) {
      for (let j = 0; j < 10; j++) await new Promise<void>((resolve) => setImmediate(resolve));
      if (!done) await vi.advanceTimersByTimeAsync(1000);
    }
    expect(done).toBe(true);
    return promise;
  }
  function handler(): ChannelSendHandler {
    return new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threads,
      channelRepository: channels,
      messageRepository: messages,
      bindingRepository: bindings,
      signalExecutions: executions,
      logger,
    });
  }
  function broadcast(): ChannelBroadcastHandler {
    return new ChannelBroadcastHandler({
      channelRegistry: registry,
      threadRepository: threads,
      channelRepository: channels,
      messageRepository: messages,
      bindingRepository: bindings,
      signalExecutions: executions,
      logger,
    });
  }
  function register() {
    const entry = SignalInvocationGuard.enter(queue, 'queue')._unsafeUnwrap();
    if (entry.kind !== 'execution') throw new Error('Expected live execution');
    guards.push(entry.guard);
    entry.guard.attachRunId('run')._unsafeUnwrap();
    executions ??= new SignalToolExecutionRegistry({ queue, runs, personas });
    const input = { ...context, queueItemId: 'queue', guard: entry.guard };
    const registration = executions.register(input)._unsafeUnwrap();
    return { guard: entry.guard, registration, input };
  }
  function sendRequests(): SendRequest[] {
    return requests.filter((r) => r.method === 'send');
  }
  function insertThread(id: string, channelId: string, externalId: string, metadata = '{}'): void {
    threads
      .insert({ id, channel_id: channelId, external_id: externalId, metadata })
      ._unsafeUnwrap();
  }
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    vi.setSystemTime(1_000_000);
    db = createTestDb();
    queue = new QueueRepository(db);
    runs = new RunRepository(db);
    threads = new ThreadRepository(db);
    channels = new ChannelRepository(db);
    messages = new MessageRepository(db);
    bindings = new BindingRepository(db);
    accounts = new SignalAccountStateRepository(db);
    leases = new SignalDestinationLeaseRepository(db);
    registry = new LiveChannelRegistry(logger);
    connectors = [];
    sockets = [];
    requests = [];
    blockedTarget = false;
    executions = undefined;
    guards = [];
    context = { runId: 'run', threadId: 'origin', personaId: 'persona', requestId: 'request' };
    new PersonaRepository(db)
      .insert({
        id: 'persona',
        name: 'fixture',
        model: 'fixture',
        system_prompt_file: null,
        skills: '[]',
        capabilities: '{}',
        mounts: '[]',
        max_concurrent: null,
      })
      ._unsafeUnwrap();
    personas = new PersonaLoader(new PersonaRepository(db), logger);
    (
      await personas.loadFromConfig([
        PersonaConfigSchema.parse({
          name: 'fixture',
          model: 'fixture',
          capabilities: { allow: ['channel.send:*'], requireApproval: [] },
        }),
      ])
    )._unsafeUnwrap();
    channels
      .insert({
        id: 'telegram',
        name: 'telegram',
        type: 'telegram',
        config: '{}',
        credentials_ref: null,
        enabled: 1,
      })
      ._unsafeUnwrap();
    insertThread('origin', 'telegram', 'chat-origin');
    queue
      .enqueue({
        id: 'queue',
        thread_id: 'origin',
        message_id: null,
        type: 'message',
        payload: JSON.stringify({ personaId: 'persona', content: 'command' }),
        max_attempts: 3,
      })
      ._unsafeUnwrap();
    runs
      .insert({
        id: 'run',
        thread_id: 'origin',
        persona_id: 'persona',
        queue_item_id: 'queue',
        status: 'running',
        provider_name: 'fixture',
        sandbox_id: null,
        session_id: null,
        parent_run_id: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: 0,
        error: null,
        started_at: Date.now(),
        ended_at: null,
      })
      ._unsafeUnwrap();
    directory = fs.mkdtempSync(join(homedir(), '.sig-tools-'));
    fs.chmodSync(directory, 0o700);
    answerSend = (request, socket) =>
      reply(socket, request, { timestamp: 900, results: [recipient()] });
    server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString('utf8');
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          // Only actual allowlisted-client output enters this synthetic peer, not model input.
          const request: Request = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          requests.push(request);
          if (request.method === 'version') reply(socket, request, { version: '0.14.9' });
          else if (request.method === 'listAccounts')
            reply(socket, request, [
              { number: null, aci: account },
              { number: null, aci: otherAccount },
            ]);
          else if (request.method === 'listDevices')
            reply(socket, request, [
              { id: 1, name: null, createdTimestamp: 100, lastSeenTimestamp: 500 },
              { id: 3, name: null, createdTimestamp: 200, lastSeenTimestamp: 500 },
            ]);
          else if (request.method === 'subscribeReceive') reply(socket, request, 7);
          else if (request.method === 'listContacts')
            reply(socket, request, [
              {
                uuid: request.params.recipient[0],
                isBlocked: blockedTarget,
                unregistered: false,
                messageExpirationTime: 0,
              },
            ]);
          else if (request.method === 'listGroups')
            reply(socket, request, [
              {
                id: request.params.groupId?.[0],
                name: 'synthetic',
                description: null,
                isMember: true,
                isBlocked: blockedTarget,
                isTerminated: false,
                messageExpirationTime: 0,
                members: [{ uuid: account, number: null, isAdmin: false }],
                pendingMembers: [],
                requestingMembers: [],
                admins: [],
                banned: [],
                permissionAddMember: 'EVERY_MEMBER',
                permissionEditDetails: 'EVERY_MEMBER',
                permissionSendMessage: 'EVERY_MEMBER',
                groupInviteLink: null,
              },
            ]);
          else if (request.method === 'send') answerSend(request, socket);
          else reply(socket, request, {});
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(join(directory, 'rpc.sock'), resolve);
    });
    fs.chmodSync(join(directory, 'rpc.sock'), 0o600);
    const configs = [account, otherAccount].map((aci) =>
      SignalConfigSchema.parse({
        accountMode: 'personal',
        socketPath: join(directory, 'rpc.sock'),
        account: aci,
        accountUuid: aci,
        deviceId: 3,
        deviceCreatedTimestamp: 200,
        allowedGroups: ['QQ=='],
      }),
    );
    const devices = SignalDeviceRegistry.create(1, configs)._unsafeUnwrap();
    for (const [index, config] of configs.entries()) {
      const name = `signal-${index}`;
      channels
        .insert({
          id: name,
          name,
          type: 'signal',
          config: JSON.stringify(config),
          credentials_ref: null,
          enabled: 1,
        })
        ._unsafeUnwrap();
      const connector = new SignalConnector(config, name, logger, {
        queue,
        accounts,
        leases,
        registry: devices,
        monotonicNow: () => performance.now(),
        random: () => 0.5,
      });
      connector.onMessageWithReceipt(() => ok('accepted'));
      registry.register(connector);
      connectors.push(connector);
      await connector.start();
      expect(connector.status().state).toBe('ready');
    }
    insertThread('self', 'signal-0', self);
    insertThread('group', 'signal-0', group);
    bindings
      .insert({
        id: 'self-binding',
        channel_id: 'signal-0',
        thread_id: 'self',
        persona_id: 'persona',
        is_default: 0,
      })
      ._unsafeUnwrap();
  });
  afterEach(async () => {
    for (const guard of guards) guard.close();
    for (const connector of connectors) await finish(connector.stopWithResult());
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('refuses missing live execution with a fixed safe not-queued DTO before any send', async () => {
    const result = await handler().execute(
      { channelId: 'signal-0', externalChatId: self, content: 'hello' },
      context,
    );
    expect(result.status).toBe('error');
    expect(result.result).toEqual({
      reason: 'EXECUTION_UNAVAILABLE',
      providerRetryable: false,
      queued: false,
      action: 'repair_context',
    });
    expect(sendRequests()).toHaveLength(0);
    expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap()).toEqual({
      kind: 'ordinary',
    });
  });

  it('uses the registered real guard and current marker for deliberate sends and persists recipient context', async () => {
    const { guard } = register();
    const seen: unknown[] = [];
    answerSend = (request, socket) => {
      seen.push(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap());
      reply(socket, request, { timestamp: 900, results: [recipient()] });
    };
    const result = await finish(
      handler().execute(
        { channelId: 'signal-0', externalChatId: self, content: '**hello** 😀' },
        context,
      ),
    );
    expect(result.status).toBe('success');
    expect(sendRequests()).toHaveLength(1);
    expect(sendRequests()[0]).toMatchObject({
      params: { account, noteToSelf: true, message: 'hello 😀' },
    });
    expect(seen).toEqual([
      expect.objectContaining({
        kind: 'invoked',
        marker: expect.objectContaining({
          queueItemId: 'queue',
          runId: 'run',
          purpose: 'explicit',
        }),
      }),
    ]);
    const next = await finish(
      handler().execute(
        { channelId: 'signal-0', externalChatId: self, content: 'second' },
        { ...context, requestId: 'second' },
      ),
    );
    expect(next.status).toBe('success');
    expect(sendRequests()).toHaveLength(2);
    expect(
      messages
        .findByThread('self', 100, 0)
        ._unsafeUnwrap()
        .map((m) => JSON.parse(m.content)),
    ).toEqual([{ body: '**hello** 😀' }, { body: 'second' }]);
    expect(guard.checkTarget(account, self).isOk()).toBe(true);
    expect(leases.find(account, self)._unsafeUnwrap()).toBeNull();
  });

  it('does not log the Signal external ID as recipient or recipientSource on success', async () => {
    register();
    const info = vi.spyOn(logger, 'info');
    answerSend = (request, socket) => {
      reply(socket, request, { timestamp: 901, results: [recipient()] });
    };
    const result = await finish(
      handler().execute({ channelId: 'signal-0', externalChatId: self, content: 'hi' }, context),
    );
    expect(result.status).toBe('success');
    const sent = info.mock.calls.filter((c) => c[1] === 'channel.send: message sent successfully');
    expect(sent).toHaveLength(1);
    const fields = sent[0]?.[0] as Record<string, unknown>;
    expect(fields).not.toHaveProperty('recipient');
    expect(fields).not.toHaveProperty('recipientSource');
    expect(JSON.stringify(info.mock.calls)).not.toContain(account);
    info.mockRestore();
  });

  it.each(['runId', 'threadId', 'personaId'] as const)(
    'refuses mismatched %s and ignores spoofed model authority fields',
    async (field) => {
      register();
      const args = {
        channelId: 'signal-0',
        externalChatId: self,
        content: 'no',
        runId: 'run',
        queueItemId: 'queue',
        deliveryId: 'model',
        trustedDelivery: {
          queueItemId: 'queue',
          runId: 'run',
          purpose: 'explicit',
          deliveryId: 'model',
        },
      };
      const result = await handler().execute(args, { ...context, [field]: 'foreign' });
      expect(result.status).toBe('error');
      expect(sendRequests()).toHaveLength(0);
      expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap()).toEqual({
        kind: 'ordinary',
      });
    },
  );

  it('does not let copied delivery metadata or another registry mint live permission', async () => {
    const { guard } = register();
    const other = new SignalToolExecutionRegistry({ queue, runs, personas });
    const metadata = guard.context('copied', 'explicit')._unsafeUnwrap();
    const result = await other.invoke({ ...context, ...metadata }, connectors[0], self, {
      body: 'no',
      trustedDelivery: metadata,
    });
    expect(result.isErr()).toBe(true);
    expect(sendRequests()).toHaveLength(0);
    expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap()).toEqual({
      kind: 'ordinary',
    });
  });

  it('refuses foreign overwrite and duplicate guard ownership, and closes permanently without stale-close deletion', async () => {
    const { input, registration, guard } = register();
    expect(executions?.register(input).isErr()).toBe(true);
    const foreign = SignalInvocationGuard.enter(queue, 'queue')._unsafeUnwrap();
    if (foreign.kind !== 'execution') throw new Error('Expected ordinary guard');
    guards.push(foreign.guard);
    foreign.guard.attachRunId('run')._unsafeUnwrap();
    expect(executions?.register({ ...input, guard: foreign.guard }).isErr()).toBe(true);
    registration.close();
    registration.close();
    expect(guard.context('closed', 'explicit').isErr()).toBe(true);
    expect(executions?.resolve(context).isErr()).toBe(true);
    const replacement = executions?.register({ ...input, guard: foreign.guard })._unsafeUnwrap();
    registration.close();
    expect(executions?.resolve(context)._unsafeUnwrap()).toBe(foreign.guard);
    replacement?.close();
    expect(executions?.resolve(context).isErr()).toBe(true);
  });

  it.each(['completed-run', 'purged-queue', 'closed-guard'] as const)(
    'rechecks live ownership after %s',
    async (change) => {
      const { guard } = register();
      if (change === 'completed-run') runs.updateStatus('run', 'completed')._unsafeUnwrap();
      else if (change === 'purged-queue') queue.purge(['pending'])._unsafeUnwrap();
      else guard.close();
      const result = await handler().execute(
        { channelId: 'signal-0', externalChatId: self, content: 'no' },
        context,
      );
      expect(result.status).toBe('error');
      expect(sendRequests()).toHaveLength(0);
    },
  );

  it('refuses registration when actual guard/queue/run identity does not match', () => {
    const { input, registration } = register();
    registration.close();
    const entry = SignalInvocationGuard.enter(queue, 'queue')._unsafeUnwrap();
    if (entry.kind !== 'execution') throw new Error('Expected ordinary guard');
    guards.push(entry.guard);
    entry.guard.attachRunId('run')._unsafeUnwrap();
    for (const wrong of [
      { queueItemId: 'foreign' },
      { threadId: 'self' },
      { personaId: 'foreign' },
      { runId: 'foreign' },
    ]) {
      expect(executions?.register({ ...input, guard: entry.guard, ...wrong }).isErr()).toBe(true);
    }
    expect(sendRequests()).toHaveLength(0);
  });

  it('fails closed on live capability revocation using actual loaded effective capabilities', async () => {
    register();
    (
      await personas.loadFromConfig([
        PersonaConfigSchema.parse({
          name: 'fixture',
          model: 'fixture',
          capabilities: { allow: [], requireApproval: [] },
        }),
      ])
    )._unsafeUnwrap();
    const result = await handler().execute(
      { channelId: 'signal-0', externalChatId: self, content: 'no' },
      context,
    );
    expect(result.status).toBe('error');
    expect(result.result).toMatchObject({
      reason: 'CAPABILITY_DENIED',
      providerRetryable: false,
      queued: false,
    });
    expect(sendRequests()).toHaveLength(0);
    expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap()).toEqual({
      kind: 'ordinary',
    });
  });

  it.each(['NETWORK_FAILURE', 'partial'] as const)(
    'latches exact target on %s across send/broadcast/final purposes but not healthy targets/accounts',
    async (kind) => {
      const { guard } = register();
      answerSend = (request, socket) =>
        reply(socket, request, {
          timestamp: 900,
          results:
            kind === 'partial'
              ? [recipient(), recipient('IDENTITY_FAILURE')]
              : [recipient('NETWORK_FAILURE')],
        });
      const result = await finish(
        handler().execute(
          { channelId: 'signal-0', externalChatId: self, content: 'uncertain' },
          context,
        ),
      );
      expect(result.status).toBe('error');
      expect(result.result).toMatchObject({
        outcome: kind === 'partial' ? 'PARTIAL' : 'UNKNOWN',
        action: 'inspect_do_not_repeat',
        providerRetryable: false,
        queued: false,
      });
      expect(guard.checkTarget(account, self).isErr()).toBe(true);
      expect(guard.checkTarget(account, group).isOk()).toBe(true);
      expect(guard.checkTarget(otherAccount, `signal:v1:${otherAccount}:self`).isOk()).toBe(true);
      const repeated = await handler().execute(
        { channelId: 'signal-0', externalChatId: self, content: 'again' },
        { ...context, requestId: 'new' },
      );
      expect(repeated.result).toMatchObject({
        reason: 'TARGET_LATCHED',
        outcome: 'NOT_SENT',
        action: 'inspect_do_not_repeat',
      });
      const fanout = await broadcast().execute(
        { content: 'again' },
        { ...context, requestId: 'broadcast' },
      );
      expect(fanout.result).toMatchObject({
        delivered: 0,
        failed: [
          expect.objectContaining({
            signal: expect.objectContaining({ reason: 'TARGET_LATCHED' }),
          }),
        ],
      });
      const final = await guard.invoke(
        { accountUuid: account, destination: self, deliveryId: 'final-new', purpose: 'reply' },
        (trusted) => connectors[0].send(self, { body: 'final', trustedDelivery: trusted }),
      );
      expect(final.isErr()).toBe(true);
      expect(sendRequests()).toHaveLength(1);
      answerSend = (request, socket) =>
        reply(socket, request, { timestamp: 900, results: [recipient()] });
      const other = await finish(
        handler().execute(
          {
            channelId: 'signal-1',
            externalChatId: `signal:v1:${otherAccount}:self`,
            content: 'healthy',
          },
          { ...context, requestId: 'other' },
        ),
      );
      expect(other.status).toBe('success');
      expect(sendRequests()).toHaveLength(2);
      if (kind === 'NETWORK_FAILURE') await vi.advanceTimersByTimeAsync(60_000);
      const distinct = await finish(
        handler().execute(
          { channelId: 'signal-0', externalChatId: group, content: 'healthy distinct' },
          { ...context, requestId: 'group' },
        ),
      );
      expect(distinct.status).toBe('success');
      expect(sendRequests()).toHaveLength(3);
    },
  );

  it('rejects exact-target overlap before second marker/send and latches before admission release', async () => {
    const { guard } = register();
    let pending: { request: Request; socket: Socket } | undefined;
    answerSend = (request, socket) => {
      pending = { request, socket };
    };
    const first = handler().execute(
      { channelId: 'signal-0', externalChatId: self, content: 'first' },
      context,
    );
    await until(() => pending !== undefined);
    const second = await handler().execute(
      { channelId: 'signal-0', externalChatId: self, content: 'second' },
      { ...context, requestId: 'second' },
    );
    expect(second.result).toMatchObject({ reason: 'ACCOUNT_BUSY', outcome: 'NOT_SENT' });
    expect(sendRequests()).toHaveLength(1);
    if (pending === undefined) throw new Error('Expected submitted request');
    reply(pending.socket, pending.request, {
      timestamp: 900,
      results: [recipient('NETWORK_FAILURE')],
    });
    expect((await first).status).toBe('error');
    expect(guard.checkTarget(account, self).isErr()).toBe(true);
    expect(sendRequests()).toHaveLength(1);
  });

  it('definite NOT_SENT releases the actual destination lease and permits later deliberate send', async () => {
    const { guard } = register();
    blockedTarget = true;
    const failed = await finish(
      handler().execute(
        { channelId: 'signal-0', externalChatId: self, content: 'refused' },
        context,
      ),
    );
    expect(failed.result).toMatchObject({
      outcome: 'NOT_SENT',
      reason: 'TARGET_REFUSED',
      action: 'later_explicit_call',
    });
    expect(sendRequests()).toHaveLength(0);
    expect(leases.find(account, self)._unsafeUnwrap()).toBeNull();
    expect(guard.checkTarget(account, self).isOk()).toBe(true);
    blockedTarget = false;
    const next = await finish(
      handler().execute(
        { channelId: 'signal-0', externalChatId: self, content: 'allowed' },
        { ...context, requestId: 'next' },
      ),
    );
    expect(next.status).toBe('success');
    expect(sendRequests()).toHaveLength(1);
  });

  it('close removes future authority but does not cancel or certify drain of a submitted send', async () => {
    const { registration } = register();
    let pending: { request: Request; socket: Socket } | undefined;
    answerSend = (request, socket) => {
      pending = { request, socket };
    };
    const first = handler().execute(
      { channelId: 'signal-0', externalChatId: self, content: 'submitted' },
      context,
    );
    await until(() => pending !== undefined);
    registration.close();
    const blocked = await handler().execute(
      { channelId: 'signal-0', externalChatId: group, content: 'no' },
      context,
    );
    expect(blocked.status).toBe('error');
    expect(sendRequests()).toHaveLength(1);
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).not.toBeNull();
    if (pending === undefined) throw new Error('Expected submitted request');
    reply(pending.socket, pending.request, { timestamp: 900, results: [recipient()] });
    expect((await first).status).toBe('success');
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).toBeNull();
    expect(sendRequests()).toHaveLength(1);
  });

  it('retains actual Result error identity internally and projects no private diagnostics', async () => {
    const { input } = register();
    const closed = createTestDb();
    const closedRuns = new RunRepository(closed);
    closed.close();
    const actualFailure = closedRuns.findById('run');
    expect(actualFailure.isErr()).toBe(true);
    const original = actualFailure._unsafeUnwrapErr();
    let failReads = false;
    const failing = new SignalToolExecutionRegistry({
      queue,
      runs: { findById: (id) => (failReads ? actualFailure : runs.findById(id)) },
      personas,
    });
    failing.register(input)._unsafeUnwrap();
    failReads = true;
    const result = failing.resolve(context);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(original);
    expect(
      (await failing.invoke(context, connectors[0], self, { body: 'no' }))._unsafeUnwrapErr(),
    ).toBe(original);
    db.pragma('query_only = ON');
    const failed = await executions?.invoke(context, connectors[0], self, { body: 'no bytes' });
    expect(failed?.isErr()).toBe(true);
    expect(sendRequests()).toHaveLength(0);
    db.pragma('query_only = OFF');
    expect(JSON.stringify(signalToolFailure(original))).not.toMatch(/database|closed|cause|SQLite/);
    expect(
      JSON.stringify(
        signalToolFailure(new DbError('secret /private/socket body uuid', new Error('raw cause'))),
      ),
    ).not.toMatch(/secret|private|socket|uuid|raw cause/);
    expect(signalToolFailure(original)).toMatchObject({
      reason: 'STATE_WRITE_FAILED',
      providerRetryable: false,
      queued: false,
    });
  });

  it.each([-5, -6] as const)(
    'broadcast stops only the actual restricted account after RPC %s and preserves counts/default skipping',
    async (code) => {
      register();
      bindings
        .insert({
          id: 'group-binding',
          channel_id: 'signal-0',
          thread_id: 'group',
          persona_id: 'persona',
          is_default: 0,
        })
        ._unsafeUnwrap();
      bindings
        .insert({
          id: 'default-binding',
          channel_id: 'signal-0',
          thread_id: null,
          persona_id: 'persona',
          is_default: 1,
        })
        ._unsafeUnwrap();
      insertThread('other-self', 'signal-1', `signal:v1:${otherAccount}:self`);
      bindings
        .insert({
          id: 'other-binding',
          channel_id: 'signal-1',
          thread_id: 'other-self',
          persona_id: 'persona',
          is_default: 0,
        })
        ._unsafeUnwrap();
      answerSend = (request, socket) => {
        if (request.params.account === account)
          socket.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code, message: 'PRIVATE challenge /private/path', data: { response: { timestamp: 900, results: [{ ...recipient('RATE_LIMIT_FAILURE'), retryAfterSeconds: 0, ...(code === -6 ? { token: 'SECRET' } : {}) }] } } } })}\n`,
          );
        else reply(socket, request, { timestamp: 900, results: [recipient()] });
      };
      const started = Date.now();
      const result = await finish(broadcast().execute({ content: 'fanout' }, context));
      expect(result.status).toBe('success');
      expect(result.result).toMatchObject({
        delivered: 1,
        skipped: [{ channelName: 'signal-0', reason: 'no_thread_binding' }],
        failed: [
          expect.objectContaining({
            channelName: 'signal-0',
            signal: expect.objectContaining({
              reason: code === -5 ? 'RATE_LIMITED' : 'CHALLENGE_REQUIRED',
              providerRetryable: false,
              queued: false,
            }),
          }),
          expect.objectContaining({
            channelName: 'signal-0',
            signal: expect.objectContaining({
              reason: code === -5 ? 'RATE_LIMITED' : 'CHALLENGE_REQUIRED',
            }),
          }),
        ],
      });
      expect(sendRequests().filter((request) => request.params.account === account)).toHaveLength(
        1,
      );
      expect(
        sendRequests().filter((request) => request.params.account === otherAccount),
      ).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(accounts.findByAccount(account)._unsafeUnwrap()?.pauseKind).toBe(
        code === -5 ? 'rate_limit' : 'challenge',
      );
      expect(accounts.findByAccount(otherAccount)._unsafeUnwrap()?.pauseKind).toBe('none');
      expect(messages.findByThread('other-self', 100, 0)._unsafeUnwrap()).toHaveLength(1);
      expect(messages.findByThread('self', 100, 0)._unsafeUnwrap()).toHaveLength(0);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|private\/path|aaaaaaaa/);
    },
  );

  it('a recipient refusal in broadcast does not stop another destination on the same account', async () => {
    register();
    bindings
      .insert({
        id: 'group-binding',
        channel_id: 'signal-0',
        thread_id: 'group',
        persona_id: 'persona',
        is_default: 0,
      })
      ._unsafeUnwrap();
    answerSend = (request, socket) =>
      reply(socket, request, { timestamp: 900, results: [recipient('IDENTITY_FAILURE')] });
    const result = await finish(broadcast().execute({ content: 'refused' }, context));
    expect(result.result).toMatchObject({
      delivered: 0,
      failed: [
        expect.objectContaining({ signal: expect.objectContaining({ outcome: 'NOT_SENT' }) }),
        expect.objectContaining({ signal: expect.objectContaining({ outcome: 'NOT_SENT' }) }),
      ],
    });
    expect(sendRequests()).toHaveLength(2);
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.pauseKind).toBe('none');
  });

  it('preserves live Signal discovery and schedule explicit/origin/no-origin recipient semantics with real bindings', async () => {
    const { registration } = register();
    registration.close();
    insertThread(
      'schedule',
      'telegram',
      'schedule:fixture:telegram',
      JSON.stringify({ kind: 'schedule', originExternalId: self }),
    );
    queue
      .enqueue({
        id: 'schedule-queue',
        thread_id: 'schedule',
        type: 'schedule',
        message_id: null,
        payload: JSON.stringify({ personaId: 'persona', content: 'scheduled' }),
        max_attempts: 3,
      })
      ._unsafeUnwrap();
    runs
      .insert({
        id: 'schedule-run',
        thread_id: 'schedule',
        persona_id: 'persona',
        queue_item_id: 'schedule-queue',
        status: 'running',
        provider_name: 'fixture',
        sandbox_id: null,
        session_id: null,
        parent_run_id: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: 0,
        error: null,
        started_at: Date.now(),
        ended_at: null,
      })
      ._unsafeUnwrap();
    const entry = SignalInvocationGuard.enter(queue, 'schedule-queue')._unsafeUnwrap();
    if (entry.kind !== 'execution') throw new Error('Expected scheduled execution');
    guards.push(entry.guard);
    entry.guard.attachRunId('schedule-run')._unsafeUnwrap();
    context = { ...context, threadId: 'schedule', runId: 'schedule-run' };
    executions
      ?.register({ ...context, queueItemId: 'schedule-queue', guard: entry.guard })
      ._unsafeUnwrap();
    const list = new ChannelListHandler({
      bindingRepository: bindings,
      threadRepository: threads,
      channelRepository: channels,
      logger,
    });
    expect(list.execute({}, context).result).toEqual([
      { channelName: 'signal-0', channelType: 'signal', threadId: 'self', externalChatId: self },
    ]);
    const origin = await finish(
      handler().execute({ channelId: 'signal-0', content: 'schedule origin' }, context),
    );
    expect(origin.status).toBe('success');
    expect(sendRequests()[0]).toMatchObject({
      params: { noteToSelf: true, message: 'schedule origin' },
    });
    const explicit = await finish(
      handler().execute(
        { channelId: 'signal-0', externalChatId: group, content: 'explicit wins' },
        { ...context, requestId: 'explicit' },
      ),
    );
    expect(explicit.status).toBe('success');
    expect(sendRequests()[1]).toMatchObject({
      params: { groupId: 'QQ==', message: 'explicit wins' },
    });
    threads.update('schedule', { metadata: '{}' })._unsafeUnwrap();
    const missing = await handler().execute(
      { channelId: 'signal-0', content: 'no origin' },
      context,
    );
    expect(missing.status).toBe('error');
    expect(missing.error).toMatch(/externalChatId/);
    expect(sendRequests()).toHaveLength(2);
    expect(messages.findByThread('schedule', 100, 0)._unsafeUnwrap()).toHaveLength(0);
    expect(messages.findByThread('self', 100, 0)._unsafeUnwrap()[0]).toMatchObject({
      run_id: 'schedule-run',
      content: JSON.stringify({ body: 'schedule origin' }),
    });
    expect(messages.findByThread('group', 100, 0)._unsafeUnwrap()).toHaveLength(0); // no binding: send allowed, no pollution
  });

  it('preserves Unicode fixed chunks and one formatting pass through the actual sender', async () => {
    register();
    const body = '**' + '😀'.repeat(501) + '**';
    const result = await finish(
      handler().execute({ channelId: 'signal-0', externalChatId: self, content: body }, context),
    );
    expect(result.status).toBe('success');
    expect(sendRequests()).toHaveLength(2);
    expect(sendRequests().map((request) => request.params.message)).toEqual([
      '😀'.repeat(500),
      '😀',
    ]);
    expect(messages.findByThread('self', 100, 0)._unsafeUnwrap()[0].content).toBe(
      JSON.stringify({ body }),
    );
  });

  it('does not forward a handled Signal failure into a healthy ordinary origin send', async () => {
    register();
    answerSend = (request, socket) =>
      reply(socket, request, { timestamp: 900, results: [recipient('NETWORK_FAILURE')] });
    expect(
      (
        await finish(
          handler().execute(
            { channelId: 'signal-0', externalChatId: self, content: 'failed' },
            context,
          ),
        )
      ).status,
    ).toBe('error');
    const delivered: string[] = [];
    registry.register({
      type: 'telegram',
      name: 'telegram',
      start: async () => undefined,
      stop: async () => undefined,
      onMessage: () => undefined,
      format: (text) => text,
      send: async (destination, output) => {
        delivered.push(destination + ':' + output.body);
        return ok(undefined);
      },
    });
    const explanation = await handler().execute(
      { channelId: 'telegram', content: 'Signal did not complete.' },
      context,
    );
    expect(explanation.status).toBe('success');
    expect(delivered).toEqual(['chat-origin:Signal did not complete.']);
    expect(queue.findById('queue')._unsafeUnwrap()?.status).toBe('pending');
    expect(runs.findById('run')._unsafeUnwrap()?.status).toBe('running');
  });

  it('never falls back to a generic connector for a persisted Signal channel', async () => {
    register();
    registry.unregister('signal-0');
    const leaked: string[] = [];
    registry.register({
      type: 'telegram',
      name: 'signal-0',
      start: async () => undefined,
      stop: async () => undefined,
      onMessage: () => undefined,
      format: (text) => text,
      send: async (_destination, output) => {
        leaked.push(output.body);
        return ok(undefined);
      },
    });
    const result = await handler().execute(
      { channelId: 'signal-0', externalChatId: self, content: 'do not bypass' },
      context,
    );
    expect(result.status).toBe('error');
    expect(leaked).toEqual([]);
    expect(sendRequests()).toHaveLength(0);
  });

  it('a stale-account target does not mark the healthy destination account restricted during broadcast', async () => {
    register();
    bindings.delete('self-binding')._unsafeUnwrap();
    insertThread('stale', 'signal-0', `signal:v1:${otherAccount}:self`);
    bindings
      .insert({
        id: 'stale-binding',
        channel_id: 'signal-0',
        thread_id: 'stale',
        persona_id: 'persona',
        is_default: 0,
      })
      ._unsafeUnwrap();
    insertThread('healthy', 'signal-1', `signal:v1:${otherAccount}:self`);
    bindings
      .insert({
        id: 'healthy-binding',
        channel_id: 'signal-1',
        thread_id: 'healthy',
        persona_id: 'persona',
        is_default: 0,
      })
      ._unsafeUnwrap();
    const result = await finish(broadcast().execute({ content: 'broadcast' }, context));
    expect(result.result).toMatchObject({
      delivered: 1,
      failed: [
        expect.objectContaining({
          signal: expect.objectContaining({ reason: 'ACCOUNT_MISMATCH' }),
        }),
      ],
    });
    expect(sendRequests()).toHaveLength(1);
    expect(sendRequests()[0]).toMatchObject({ params: { account: otherAccount } });
    expect(messages.findByThread('healthy', 100, 0)._unsafeUnwrap()).toHaveLength(1);
  });

  it.each([-1, 0, 1])(
    'retains the actual inclusive 1MiB text ceiling at offset %s without increasing account quotas',
    async (offset) => {
      register();
      answerSend = (request, socket) =>
        reply(socket, request, { timestamp: 900, results: [recipient('NETWORK_FAILURE')] });
      const result = await finish(
        handler().execute(
          { channelId: 'signal-0', externalChatId: self, content: 'x'.repeat(1_048_576 + offset) },
          context,
        ),
      );
      expect(result.status).toBe('error');
      if (offset > 0) {
        expect(result.result).toMatchObject({ reason: 'OUTPUT_TOO_LARGE', outcome: 'NOT_SENT' });
        expect(sendRequests()).toHaveLength(0);
      } else {
        expect(result.result).toMatchObject({
          outcome: 'UNKNOWN',
          action: 'inspect_do_not_repeat',
        });
        expect(sendRequests()).toHaveLength(1);
        expect(sendRequests()[0]).toMatchObject({ params: { message: 'x'.repeat(2000) } });
      }
      expect(messages.findByThread('self', 100, 0)._unsafeUnwrap()).toHaveLength(0);
    },
  );

  it.each([
    { name: 'named scope', allow: ['channel.send:another-channel'], requireApproval: [] },
    { name: 'requireApproval only', allow: [], requireApproval: ['channel.send:another-channel'] },
    {
      name: 'allow plus unrelated approval',
      allow: ['channel.send:*'],
      requireApproval: ['db.query:own'],
    },
  ])(
    'preserves approved isToolAllowed compatibility for $name on live send and broadcast',
    async ({ allow, requireApproval }) => {
      register();
      (
        await personas.loadFromConfig([
          PersonaConfigSchema.parse({
            name: 'fixture',
            model: 'fixture',
            capabilities: { allow, requireApproval },
          }),
        ])
      )._unsafeUnwrap();
      const loaded = personas.getById(context.personaId)._unsafeUnwrap();
      if (loaded === undefined) throw new Error('Expected actual loaded persona');
      expect(isToolAllowed('channel.send', loaded.resolvedCapabilities)).toBe(true);
      expect(isToolAllowed('channel.broadcast', loaded.resolvedCapabilities)).toBe(true);
      const sent = await finish(
        handler().execute(
          { channelId: 'signal-0', externalChatId: self, content: 'compatible send' },
          context,
        ),
      );
      expect(sent.status).toBe('success');
      const fanout = await finish(
        broadcast().execute(
          { content: 'compatible broadcast' },
          { ...context, requestId: 'broadcast-policy' },
        ),
      );
      expect(fanout.result).toEqual({ delivered: 1, skipped: [], failed: [] });
      expect(sendRequests().map((request) => request.params.message)).toEqual([
        'compatible send',
        'compatible broadcast',
      ]);
      expect(messages.findByThread('self', 100, 0)._unsafeUnwrap()).toHaveLength(2);
    },
  );

  it.each([
    { allow: ['memory.access:thread'], requireApproval: [] },
    { allow: [], requireApproval: ['db.query:own'] },
  ])(
    'denies unrelated live capabilities under the same actual filter: %j',
    async (capabilities) => {
      register();
      (
        await personas.loadFromConfig([
          PersonaConfigSchema.parse({ name: 'fixture', model: 'fixture', capabilities }),
        ])
      )._unsafeUnwrap();
      const loaded = personas.getById(context.personaId)._unsafeUnwrap();
      if (loaded === undefined) throw new Error('Expected actual loaded persona');
      expect(isToolAllowed('channel.send', loaded.resolvedCapabilities)).toBe(false);
      const sent = await handler().execute(
        { channelId: 'signal-0', externalChatId: self, content: 'denied' },
        context,
      );
      expect(sent.status).toBe('error');
      expect(sent.result).toMatchObject({
        reason: 'CAPABILITY_DENIED',
        providerRetryable: false,
        queued: false,
      });
      expect(sendRequests()).toHaveLength(0);
      expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap()).toEqual({
        kind: 'ordinary',
      });
    },
  );

  it('denies a missing live loaded persona even when registration predates removal', async () => {
    register();
    (await personas.loadFromConfig([]))._unsafeUnwrap();
    expect(personas.getById(context.personaId)._unsafeUnwrap()).toBeUndefined();
    const sent = await handler().execute(
      { channelId: 'signal-0', externalChatId: self, content: 'denied' },
      context,
    );
    expect(sent.status).toBe('error');
    expect(sent.result).toMatchObject({ reason: 'CAPABILITY_DENIED', queued: false });
    expect(sendRequests()).toHaveLength(0);
    expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap()).toEqual({
      kind: 'ordinary',
    });
  });

  it.each(['rate', 'unknown', 'challenge'] as const)(
    'broadcast keeps the accepted-prefix %s receipt local to the attempted target',
    async (restriction) => {
      const { guard } = register();
      if (executions === undefined) throw new Error('Expected registered execution');
      const invoked = vi.spyOn(executions, 'invoke');
      const guarded = vi.spyOn(guard, 'invoke');
      const sent = vi.spyOn(connectors[0], 'send');
      bindings.insert({
        id: 'group-binding', channel_id: 'signal-0', thread_id: 'group',
        persona_id: 'persona', is_default: 0,
      })._unsafeUnwrap();
      const independent = `signal:v1:${otherAccount}:self`;
      insertThread('other-self', 'signal-1', independent);
      bindings.insert({
        id: 'other-binding', channel_id: 'signal-1', thread_id: 'other-self',
        persona_id: 'persona', is_default: 0,
      })._unsafeUnwrap();
      let accountChunks = 0;
      let restrictedAt = 0;
      // Pinned JsonSendMessageResult.java:10-48 and Utils:43-68: a complete first
      // chunk followed by an explicit refusal retains the accepted prefix counts.
      answerSend = (request, socket) => {
        if (request.params.account !== account || ++accountChunks === 1) {
          reply(socket, request, { timestamp: 900, results: [recipient()] });
          return;
        }
        restrictedAt = Date.now();
        if (restriction === 'unknown') {
          reply(socket, request, { timestamp: 901, results: [recipient('NETWORK_FAILURE')] });
          return;
        }
        socket.write(`${JSON.stringify({
          jsonrpc: '2.0', id: request.id,
          error: {
            code: restriction === 'rate' ? -5 : -6, message: 'PRIVATE restriction',
            data: { response: { timestamp: 901, results: [
              restriction === 'rate'
                ? { ...recipient('RATE_LIMIT_FAILURE'), retryAfterSeconds: 1800 }
                : { ...recipient('IDENTITY_FAILURE'), token: 'SECRET' },
            ] } },
          },
        })}\n`);
      };
      const result = await finish(broadcast().execute({ content: 'x'.repeat(2001) }, context));
      // Pass-through spies observe the real registry/guard/sender, never replace dispatch.
      expect(invoked.mock.calls.map((call) => call[2])).toEqual([self, independent]);
      expect(guarded).toHaveBeenCalledTimes(2);
      expect(sent).toHaveBeenCalledTimes(1);
      expect(sendRequests().map((request) => request.params)).toEqual([
        { account, noteToSelf: true, message: 'x'.repeat(2000) },
        { account, noteToSelf: true, message: 'x' },
        { account: otherAccount, noteToSelf: true, message: 'x'.repeat(2000) },
        { account: otherAccount, noteToSelf: true, message: 'x' },
      ]);
      expect(requests.filter((request) => request.method === 'listGroups')).toEqual([]);
      const connectorResult = await sent.mock.results[0].value;
      const invocationResult = await invoked.mock.results[0].value;
      expect(invocationResult).toBe(connectorResult);
      const original = invocationResult._unsafeUnwrapErr();
      expect(original).toBeInstanceOf(SignalDeliveryError);
      const reason = restriction === 'rate' ? 'RATE_LIMITED'
        : restriction === 'unknown' ? 'NETWORK_FAILURE' : 'CHALLENGE_REQUIRED';
      const hint = restriction === 'challenge' ? {}
        : { notBefore: restrictedAt + (restriction === 'rate' ? 1_800_000 : 60_000) };
      const firstReceipt = {
        reason, outcome: restriction === 'unknown' ? 'UNKNOWN' : 'PARTIAL',
        acceptedChunks: 1, currentChunkAcceptance: restriction === 'unknown' ? 'unknown' : 'refused',
        successCount: 1, failureCount: 1, ...hint,
        providerRetryable: false, queued: false, action: 'inspect_do_not_repeat',
      };
      expect(original).toMatchObject({
        reason, outcome: restriction === 'unknown' ? 'UNKNOWN' : 'PARTIAL',
        acceptedChunks: 1, currentChunkAcceptance: restriction === 'unknown' ? 'unknown' : 'refused',
        successCount: 1, failureCount: 1, ...hint,
      });
      expect(signalToolFailure(original)).toEqual(firstReceipt);
      expect(result.status).toBe('success');
      expect(result.result).toEqual({
        delivered: 1, skipped: [], failed: [
          { channelName: 'signal-0', reason: 'send_failed',
            message: 'Signal send failed; inspect the structured outcome before another explicit call.',
            signal: firstReceipt },
          { channelName: 'signal-0', reason: 'send_failed',
            message: 'Signal send failed; inspect the structured outcome before another explicit call.',
            signal: {
              reason, outcome: 'NOT_SENT', acceptedChunks: 0, currentChunkAcceptance: 'unwritten',
              successCount: 0, failureCount: 0, ...hint,
              providerRetryable: false, queued: false, action: 'later_explicit_call',
            } },
        ],
      });
      const state = accounts.findByAccount(account)._unsafeUnwrap();
      expect(state?.pauseKind).toBe(restriction === 'rate' ? 'rate_limit'
        : restriction === 'unknown' ? 'recovery' : 'challenge');
      if (restriction !== 'challenge') expect(state?.notBefore).toBe(hint.notBefore);
      expect(accounts.findByAccount(otherAccount)._unsafeUnwrap()?.pauseKind).toBe('none');
      expect(guard.checkTarget(account, self).isErr()).toBe(true);
      expect(guard.checkTarget(account, group).isOk()).toBe(true);
      expect(messages.findByThread('self', 100, 0)._unsafeUnwrap()).toEqual([]);
      expect(messages.findByThread('group', 100, 0)._unsafeUnwrap()).toEqual([]);
      expect(messages.findByThread('other-self', 100, 0)._unsafeUnwrap()).toHaveLength(1);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|aaaaaaaa/);
      expect(signalToolFailure(original)).toEqual(firstReceipt);
      invoked.mockRestore();
      guarded.mockRestore();
      sent.mockRestore();
    },
  );

  it.each([
    { kind: 'rate', reason: 'RATE_LIMITED', failureCount: 1, pauseKind: 'rate_limit', stopsAccount: true, hasRate: true },
    { kind: 'challenge', reason: 'CHALLENGE_REQUIRED', failureCount: 1, pauseKind: 'challenge', stopsAccount: true, hasRate: false },
    { kind: 'both', reason: 'CHALLENGE_REQUIRED', failureCount: 2, pauseKind: 'challenge', stopsAccount: true, hasRate: true },
    { kind: 'recipient-only', reason: 'PARTIAL_ACCEPTANCE', failureCount: 1, pauseKind: 'none', stopsAccount: false, hasRate: false },
  ] as const)(
    'broadcast preserves SAME-RPC mixed $kind acceptance and account-local stopping',
    async ({ kind, reason, failureCount, pauseKind, stopsAccount, hasRate }) => {
      const { guard } = register();
      if (executions === undefined) throw new Error('Expected registered execution');
      bindings.delete('self-binding')._unsafeUnwrap();
      bindings.insert({
        id: 'mixed-group-binding', channel_id: 'signal-0', thread_id: 'group',
        persona_id: 'persona', is_default: 0,
      })._unsafeUnwrap();
      bindings.insert({
        id: 'mixed-self-binding', channel_id: 'signal-0', thread_id: 'self',
        persona_id: 'persona', is_default: 0,
      })._unsafeUnwrap();
      const independent = `signal:v1:${otherAccount}:self`;
      insertThread('mixed-other-self', 'signal-1', independent);
      bindings.insert({
        id: 'mixed-other-binding', channel_id: 'signal-1', thread_id: 'mixed-other-self',
        persona_id: 'persona', is_default: 0,
      })._unsafeUnwrap();
      expect(bindings.findByPersona('persona')._unsafeUnwrap().map((binding) => binding.thread_id))
        .toEqual(['group', 'self', 'mixed-other-self']);
      const invoked = vi.spyOn(executions, 'invoke');
      const guarded = vi.spyOn(guard, 'invoke');
      const sent = vi.spyOn(connectors[0], 'send');
      const otherSent = vi.spyOn(connectors[1], 'send');
      const marked = vi.spyOn(queue, 'markSignalDeliveryStarted');
      try {
        let detectedAt: number | undefined;
        // Pinned JsonSendMessageResult.java:10-48, JsonRecipientAddress.java:9-15,
        // Utils:43-68: a successful envelope can contain mixed recipient results.
        // Minimal fixture metadata is not native group-roster/recipient-consistency proof.
        answerSend = (request, socket) => {
          if (request.params.account !== account || !('groupId' in request.params)) {
            reply(socket, request, { timestamp: 900, results: [recipient()] });
            return;
          }
          detectedAt = Date.now();
          const success = {
            type: 'SUCCESS',
            recipientAddress: { uuid: 'cccccccc-cccc-cccc-cccc-cccccccccccc', number: null, username: null },
          };
          const rate = {
            type: 'RATE_LIMIT_FAILURE', retryAfterSeconds: 1800,
            recipientAddress: { uuid: 'dddddddd-dddd-dddd-dddd-dddddddddddd', number: null, username: null },
          };
          const challenge = {
            type: 'IDENTITY_FAILURE', token: 'SECRET mixed challenge',
            recipientAddress: { uuid: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', number: null, username: null },
          };
          const refused = {
            type: 'IDENTITY_FAILURE',
            recipientAddress: { uuid: 'dddddddd-dddd-dddd-dddd-dddddddddddd', number: null, username: null },
          };
          reply(socket, request, {
            timestamp: 901,
            results: kind === 'both' ? [success, rate, challenge]
              : [success, kind === 'rate' ? rate : kind === 'challenge' ? challenge : refused],
          });
        };
        const body = 'x'.repeat(2001);
        const result = await finish(broadcast().execute({ content: body }, context));
        if (detectedAt === undefined) throw new Error('Expected actual mixed group response');
        const hint = hasRate ? { notBefore: detectedAt + 1_800_000 } : {};
        const connectorResult = await sent.mock.results[0].value;
        const guardedResult = await guarded.mock.results[0].value;
        const invocationResult = await invoked.mock.results[0].value;
        expect(invocationResult).toBe(connectorResult);
        expect(guardedResult).toBe(connectorResult);
        const original = connectorResult._unsafeUnwrapErr();
        expect(original).toBeInstanceOf(SignalDeliveryError);
        expect(original).toMatchObject({
          reason, outcome: 'PARTIAL', acceptedChunks: 0, currentChunkAcceptance: 'partial',
          successCount: 1, failureCount, retryScope: 'none', ...hint,
        });
        if (!hasRate) expect(original.notBefore).toBeUndefined();
        const firstReceipt = {
          reason, outcome: 'PARTIAL', acceptedChunks: 0, currentChunkAcceptance: 'partial',
          successCount: 1, failureCount, ...hint,
          providerRetryable: false, queued: false, action: 'inspect_do_not_repeat',
        };
        expect(signalToolFailure(original)).toEqual(firstReceipt);
        const firstFailure = {
          channelName: 'signal-0', reason: 'send_failed',
          message: 'Signal send failed; inspect the structured outcome before another explicit call.',
          signal: firstReceipt,
        };
        expect(result.status).toBe('success');
        expect(result.result).toEqual({
          delivered: stopsAccount ? 1 : 2, skipped: [],
          failed: stopsAccount ? [firstFailure, {
            channelName: 'signal-0', reason: 'send_failed',
            message: 'Signal send failed; inspect the structured outcome before another explicit call.',
            signal: {
              reason, outcome: 'NOT_SENT', acceptedChunks: 0, currentChunkAcceptance: 'unwritten',
              successCount: 0, failureCount: 0, ...hint,
              providerRetryable: false, queued: false, action: 'later_explicit_call',
            },
          }] : [firstFailure],
        });
        const targets = stopsAccount ? [group, independent] : [group, self, independent];
        expect(invoked.mock.calls.map((call) => call[2])).toEqual(targets);
        expect(guarded.mock.calls.map((call) => call[0].destination)).toEqual(targets);
        expect(sent.mock.calls.map((call) => call[0])).toEqual(stopsAccount ? [group] : [group, self]);
        expect(otherSent.mock.calls.map((call) => call[0])).toEqual([independent]);
        const issuedIds = guarded.mock.calls.map((call) => call[0].deliveryId);
        expect(new Set(issuedIds).size).toBe(targets.length);
        expect([...new Set(marked.mock.calls.map((call) => call[0].deliveryId))]).toEqual(issuedIds);
        expect(sendRequests().map((request) => request.params)).toEqual([
          { account, groupId: 'QQ==', message: 'x'.repeat(2000) },
          ...(!stopsAccount ? [
            { account, noteToSelf: true, message: 'x'.repeat(2000) },
            { account, noteToSelf: true, message: 'x' },
          ] : []),
          { account: otherAccount, noteToSelf: true, message: 'x'.repeat(2000) },
          { account: otherAccount, noteToSelf: true, message: 'x' },
        ]);
        expect(requests.filter((request) => request.method === 'listGroups').map((request) => request.params))
          .toEqual([{ account, groupId: ['QQ=='] }]);
        expect(requests.filter((request) => request.method === 'listContacts').map((request) => request.params))
          .toEqual([
            ...(!stopsAccount ? [
              { account, recipient: [account], allRecipients: true },
              { account, recipient: [account], allRecipients: true },
            ] : []),
            { account: otherAccount, recipient: [otherAccount], allRecipients: true },
            { account: otherAccount, recipient: [otherAccount], allRecipients: true },
          ]);
        // No skipped-target invocation means no marker, preflight, RPC, or coordinator wait.
        expect(Date.now() - detectedAt).toBeLessThan(30_000);
        expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
          pauseKind, reservation: null, recoveryNotBefore: 0,
          rateLimitNotBefore: hasRate ? detectedAt + 1_800_000 : 0,
          notBefore: hasRate ? detectedAt + 1_800_000 : 0,
        });
        expect(accounts.findByAccount(otherAccount)._unsafeUnwrap()).toMatchObject({
          pauseKind: 'none', reservation: null, notBefore: 0,
          rateLimitNotBefore: 0, recoveryNotBefore: 0,
        });
        expect(guard.checkTarget(account, group)._unsafeUnwrapErr()).toMatchObject({ reason: 'TARGET_LATCHED' });
        expect(guard.checkTarget(account, self).isOk()).toBe(true);
        expect(guard.checkTarget(otherAccount, independent).isOk()).toBe(true);
        for (const [aci, destination] of [[account, group], [account, self], [otherAccount, independent]])
          expect(leases.find(aci, destination)._unsafeUnwrap()).toBeNull();
        expect(messages.findByThread('group', 100, 0)._unsafeUnwrap()).toEqual([]);
        const selfHistory = messages.findByThread('self', 100, 0)._unsafeUnwrap();
        expect(selfHistory).toHaveLength(stopsAccount ? 0 : 1);
        if (!stopsAccount) expect(selfHistory[0]).toMatchObject({ run_id: 'run', content: JSON.stringify({ body }) });
        expect(messages.findByThread('mixed-other-self', 100, 0)._unsafeUnwrap()).toEqual([
          expect.objectContaining({ run_id: 'run', content: JSON.stringify({ body }) }),
        ]);
        expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap()).toMatchObject({
          kind: 'invoked', marker: { queueItemId: 'queue', runId: 'run', purpose: 'explicit', deliveryId: issuedIds.at(-1) },
        });
        expect(runs.findById('run')._unsafeUnwrap()?.status).toBe('running');
        expect(signalToolFailure(original)).toEqual(firstReceipt);
        expect(JSON.stringify(result)).not.toMatch(/SECRET|cccccccc|dddddddd|eeeeeeee|recipientAddress|token|timestamp/);
      } finally {
        invoked.mockRestore();
        guarded.mockRestore();
        sent.mockRestore();
        otherSent.mockRestore();
        marked.mockRestore();
      }
    },
  );

  it('retains an actual persona resolver failure internally and refuses before network with a safe DTO', async () => {
    const failed = await personas.loadFromConfig([
      PersonaConfigSchema.parse({
        name: 'fixture',
        model: 'fixture',
        systemPromptFile: join(directory, 'missing-policy-system.md'),
      }),
    ]);
    expect(failed.isErr()).toBe(true);
    const original = failed._unsafeUnwrapErr();
    executions = new SignalToolExecutionRegistry({
      queue,
      runs,
      personas: { getById: () => err(original) },
    });
    register();
    const invoked = await executions.invoke(context, connectors[0], self, { body: 'denied' });
    expect(invoked.isErr()).toBe(true);
    expect(invoked._unsafeUnwrapErr()).toBe(original);
    const sent = await handler().execute(
      { channelId: 'signal-0', externalChatId: self, content: 'denied' },
      context,
    );
    expect(sent.status).toBe('error');
    expect(sent.result).toMatchObject({
      reason: 'INTERNAL_ERROR',
      queued: false,
      providerRetryable: false,
    });
    expect(JSON.stringify(sent)).not.toContain('missing-policy-system');
    expect(JSON.stringify(sent)).not.toContain(directory);
    expect(sendRequests()).toHaveLength(0);
    expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap()).toEqual({
      kind: 'ordinary',
    });
  });
});
