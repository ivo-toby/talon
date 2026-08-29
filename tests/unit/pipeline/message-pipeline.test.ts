/**
 * Unit tests for MessagePipeline.
 *
 * Uses vi.fn() mocks for all repositories and collaborators so that each test
 * exercises the pipeline's orchestration logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from 'neverthrow';
import pino from 'pino';
import Database from 'better-sqlite3';
import { MessagePipeline } from '../../../src/pipeline/message-pipeline.js';
import { PipelineError } from '../../../src/core/errors/index.js';
import { DbError, ChannelError, QueueError } from '../../../src/core/errors/index.js';
import type { InboundEvent } from '../../../src/channels/channel-types.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import type { ChannelRouter } from '../../../src/channels/channel-router.js';
import type { QueueManager } from '../../../src/queue/queue-manager.js';
import type { AuditLogger } from '../../../src/core/logging/audit-logger.js';
import type { ChannelRow } from '../../../src/core/database/repositories/channel-repository.js';
import type { ThreadRow } from '../../../src/core/database/repositories/thread-repository.js';
import type { MessageRow } from '../../../src/core/database/repositories/message-repository.js';
import type { QueueItem } from '../../../src/queue/queue-types.js';
import { QueueItemStatus } from '../../../src/queue/queue-types.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { LifecycleEventRepository } from '../../../src/core/database/repositories/lifecycle-event-repository.js';
import { LifecycleEventBus } from '../../../src/lifecycle/lifecycle-event-bus.js';
import { LifecycleRuntime } from '../../../src/lifecycle/lifecycle-runtime.js';
import { LifecycleInterceptorEngine } from '../../../src/lifecycle/interceptors/interceptor-engine.js';
import { QueueManager } from '../../../src/queue/queue-manager.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function makeEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    channelType: 'telegram',
    channelName: 'test-bot',
    externalThreadId: 'ext-thread-001',
    senderId: 'user-123',
    idempotencyKey: 'idempotency-key-001',
    content: 'Hello pipeline!',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

function makeChannelRow(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: 'chan-uuid-1',
    type: 'telegram',
    name: 'test-bot',
    config: '{}',
    credentials_ref: null,
    enabled: 1,
    created_at: 1_000_000,
    updated_at: 1_000_000,
    ...overrides,
  };
}

function makeThreadRow(overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: 'thread-uuid-1',
    channel_id: 'chan-uuid-1',
    external_id: 'ext-thread-001',
    metadata: '{}',
    created_at: 1_000_000,
    updated_at: 1_000_000,
    ...overrides,
  };
}

function makeMessageRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'msg-uuid-1',
    thread_id: 'thread-uuid-1',
    direction: 'inbound',
    content: 'Hello pipeline!',
    idempotency_key: 'idempotency-key-001',
    provider_id: 'user-123',
    run_id: null,
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

function makeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'queue-item-1',
    threadId: 'thread-uuid-1',
    messageId: 'msg-uuid-1',
    type: 'message',
    payload: {},
    status: QueueItemStatus.Pending,
    attempts: 0,
    maxAttempts: 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMocks() {
  const messageRepo = {
    insert: vi.fn(),
    insertIfAbsent: vi.fn(),
    findById: vi.fn(),
    findByThread: vi.fn(),
    existsByIdempotencyKey: vi.fn(),
  } as unknown as MessageRepository;

  const threadRepo = {
    insert: vi.fn(),
    findById: vi.fn(),
    findByExternalId: vi.fn(),
    update: vi.fn(),
  } as unknown as ThreadRepository;

  const channelRepo = {
    insert: vi.fn(),
    findById: vi.fn(),
    findByName: vi.fn(),
    findByType: vi.fn(),
    findEnabled: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as ChannelRepository;

  const queueManager = {
    enqueue: vi.fn(),
    enqueueInLifecycleTransaction: vi.fn(),
    startProcessing: vi.fn(),
    stopProcessing: vi.fn(),
    stats: vi.fn(),
  } as unknown as QueueManager;

  const router = {
    resolvePersona: vi.fn(),
  } as unknown as ChannelRouter;

  const auditLogger = {
    logToolExecution: vi.fn(),
    logApprovalDecision: vi.fn(),
    logChannelSend: vi.fn(),
    logScheduleTrigger: vi.fn(),
    logConfigReload: vi.fn(),
  } as unknown as AuditLogger;

  return { messageRepo, threadRepo, channelRepo, queueManager, router, auditLogger };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('MessagePipeline', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let pipeline: MessagePipeline;

  beforeEach(() => {
    mocks = makeMocks();
    pipeline = new MessagePipeline(
      mocks.messageRepo,
      mocks.threadRepo,
      mocks.channelRepo,
      mocks.queueManager,
      mocks.router,
      mocks.auditLogger,
      silentLogger(),
    );
  });

  // -------------------------------------------------------------------------
  // Happy path: enqueued
  // -------------------------------------------------------------------------

  describe('happy path (enqueued)', () => {
    beforeEach(() => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(makeChannelRow()));
      vi.mocked(mocks.threadRepo.findByExternalId).mockReturnValue(ok(makeThreadRow()));
      vi.mocked(mocks.messageRepo.existsByIdempotencyKey).mockReturnValue(false);
      vi.mocked(mocks.messageRepo.insert).mockReturnValue(ok(makeMessageRow()));
      vi.mocked(mocks.messageRepo.insertIfAbsent).mockReturnValue(
        ok({ message: makeMessageRow(), inserted: true }),
      );
      vi.mocked(mocks.router.resolvePersona).mockReturnValue(ok('persona-uuid-1'));
      vi.mocked(mocks.queueManager.enqueue).mockReturnValue(ok(makeQueueItem()));
      vi.mocked(mocks.queueManager.enqueueInLifecycleTransaction).mockReturnValue(
        ok(makeQueueItem()),
      );
    });

    it('returns Ok("enqueued") on a successful end-to-end run', async () => {
      const result = await pipeline.handleInboundEvent(makeEvent());
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('enqueued');
    });

    it('calls channelRepo.findByName with the event channelName', async () => {
      const event = makeEvent({ channelName: 'my-channel' });
      await pipeline.handleInboundEvent(event);
      expect(mocks.channelRepo.findByName).toHaveBeenCalledWith('my-channel');
    });

    it('calls threadRepo.findByExternalId with the resolved channelId and externalThreadId', async () => {
      const event = makeEvent({ externalThreadId: 'ext-42' });
      await pipeline.handleInboundEvent(event);
      expect(mocks.threadRepo.findByExternalId).toHaveBeenCalledWith('chan-uuid-1', 'ext-42');
    });

    it('calls messageRepo.existsByIdempotencyKey with a channel-scoped idempotency key', async () => {
      const event = makeEvent({ idempotencyKey: 'my-key' });
      await pipeline.handleInboundEvent(event);
      expect(mocks.messageRepo.existsByIdempotencyKey).toHaveBeenCalledWith('chan-uuid-1:my-key');
    });

    it('calls router.resolvePersona with the channelId and threadId', async () => {
      await pipeline.handleInboundEvent(makeEvent());
      expect(mocks.router.resolvePersona).toHaveBeenCalledWith('chan-uuid-1', 'thread-uuid-1');
    });

    it('calls queueManager.enqueue with the correct threadId and type', async () => {
      await pipeline.handleInboundEvent(makeEvent());
      expect(mocks.queueManager.enqueue).toHaveBeenCalledWith(
        'thread-uuid-1',
        'message',
        expect.objectContaining({ personaId: 'persona-uuid-1' }),
        expect.any(String),
      );
    });

    it('increments the processed counter', async () => {
      await pipeline.handleInboundEvent(makeEvent());
      expect(pipeline.stats().processed).toBe(1);
    });

    it('does not increment error, duplicate, or noPersona counters', async () => {
      await pipeline.handleInboundEvent(makeEvent());
      const stats = pipeline.stats();
      expect(stats.errors).toBe(0);
      expect(stats.duplicates).toBe(0);
      expect(stats.noPersona).toBe(0);
    });
  });

  describe('enabled lifecycle inbound boundary', () => {
    beforeEach(() => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(makeChannelRow()));
      vi.mocked(mocks.threadRepo.findByExternalId).mockReturnValue(ok(makeThreadRow()));
      vi.mocked(mocks.messageRepo.existsByIdempotencyKey).mockReturnValue(false);
      vi.mocked(mocks.messageRepo.insert).mockReturnValue(ok(makeMessageRow()));
      vi.mocked(mocks.messageRepo.insertIfAbsent).mockReturnValue(
        ok({ message: makeMessageRow(), inserted: true }),
      );
      vi.mocked(mocks.router.resolvePersona).mockReturnValue(ok('persona-uuid-1'));
      vi.mocked(mocks.queueManager.enqueue).mockReturnValue(ok(makeQueueItem()));
      vi.mocked(mocks.queueManager.enqueueInLifecycleTransaction).mockReturnValue(
        ok(makeQueueItem()),
      );
    });

    it('transforms before persistence and publishes bounded persisted/routed events', () => {
      const runtime = {
        transaction: vi.fn((callback) => callback({})),
        intercept: vi.fn(() =>
          ok({
            outcome: 'allow' as const,
            signals: [],
            input: {
              hook: 'message.before_persist' as const,
              input: { content: 'redacted' },
            },
          }),
        ),
        publish: vi.fn(() => ok({})),
      };
      pipeline = new MessagePipeline(
        mocks.messageRepo,
        mocks.threadRepo,
        mocks.channelRepo,
        mocks.queueManager,
        mocks.router,
        mocks.auditLogger,
        silentLogger(),
        runtime as any,
        () => ok('assistant'),
      );

      const result = pipeline.handleInboundEvent(makeEvent({ content: 'secret source text' }));

      expect(result._unsafeUnwrap()).toBe('enqueued');
      expect(mocks.messageRepo.insertIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'redacted' }),
      );
      expect(mocks.queueManager.enqueueInLifecycleTransaction).toHaveBeenCalledWith(
        expect.any(String),
        'message',
        expect.objectContaining({ content: 'redacted' }),
        { persona: 'assistant', itemType: 'message' },
        expect.anything(),
        expect.any(String),
      );
      expect(runtime.publish).toHaveBeenCalledTimes(2);
      for (const [input] of runtime.publish.mock.calls) {
        expect(input.event.payload).not.toHaveProperty('content');
      }
      expect(runtime.publish.mock.calls[1]?.[0].event.payload.references).toContainEqual({
        type: 'persona',
        id: 'persona-uuid-1',
      });
    });

    it('does not persist or enqueue a message denied before persistence', () => {
      const runtime = {
        transaction: vi.fn((callback) => callback({})),
        intercept: vi.fn(() =>
          ok({
            outcome: 'deny' as const,
            reason: 'native_policy',
            signals: [],
            input: { hook: 'message.before_persist' as const, input: { content: 'ignored' } },
          }),
        ),
        publish: vi.fn(() => ok({})),
      };
      pipeline = new MessagePipeline(
        mocks.messageRepo,
        mocks.threadRepo,
        mocks.channelRepo,
        mocks.queueManager,
        mocks.router,
        mocks.auditLogger,
        silentLogger(),
        runtime as any,
        () => ok('assistant'),
      );

      const result = pipeline.handleInboundEvent(makeEvent());

      expect(result._unsafeUnwrap()).toBe('denied');
      expect(mocks.messageRepo.insert).not.toHaveBeenCalled();
      expect(mocks.queueManager.enqueue).not.toHaveBeenCalled();
      expect(runtime.publish).not.toHaveBeenCalled();
    });

    it.each([1, 2, 3])(
      'persists and deduplicates when lifecycle publication stage %i fails',
      (failureAt) => {
        const db: Database.Database = createTestDb();
        const channels = new ChannelRepository(db);
        const threads = new ThreadRepository(db);
        const messages = new MessageRepository(db);
        const queue = new QueueRepository(db);
        const channelId = uuid();
        const threadId = uuid();
        const personaId = uuid();
        let injectFailure = true;
        channels.insert({
          id: channelId,
          type: 'terminal',
          name: 'test-bot',
          config: '{}',
          credentials_ref: null,
          enabled: 1,
        });
        threads.insert({
          id: threadId,
          channel_id: channelId,
          external_id: 'ext-thread-001',
          metadata: '{}',
        });
        let publications = 0;
        const runtime = new LifecycleRuntime(
          new LifecycleEventBus(new LifecycleEventRepository(db), {
            resolveEventHandlers: () => {
              publications += 1;
              if (injectFailure && publications === failureAt)
                throw new Error('injected publication failure');
              return [];
            },
          }),
          new LifecycleInterceptorEngine({ resolveHandlers: () => [], implementations: {} }),
          {} as any,
        );
        const pipelineUnderTest = new MessagePipeline(
          messages,
          threads,
          channels,
          new QueueManager(
            queue,
            threads,
            { maxAttempts: 3, backoffBaseMs: 10, backoffMaxMs: 100, concurrencyLimit: 1 },
            silentLogger(),
            runtime,
          ),
          { resolvePersona: () => ok(personaId) } as unknown as ChannelRouter,
          mocks.auditLogger,
          silentLogger(),
          runtime,
          () => ok('assistant'),
        );

        expect(pipelineUnderTest.handleInboundEvent(makeEvent())._unsafeUnwrap()).toBe('enqueued');
        expect(
          (db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count,
        ).toBe(1);
        expect(
          (db.prepare('SELECT COUNT(*) AS count FROM queue_items').get() as { count: number })
            .count,
        ).toBe(1);
        expect(
          (db.prepare('SELECT COUNT(*) AS count FROM lifecycle_events').get() as { count: number })
            .count,
        ).toBe(2);

        publications = 0;
        injectFailure = false;
        expect(pipelineUnderTest.handleInboundEvent(makeEvent())._unsafeUnwrap()).toBe('duplicate');
        expect(
          (db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count,
        ).toBe(1);
        expect(
          (db.prepare('SELECT COUNT(*) AS count FROM queue_items').get() as { count: number })
            .count,
        ).toBe(1);
        expect(
          (db.prepare('SELECT COUNT(*) AS count FROM lifecycle_events').get() as { count: number })
            .count,
        ).toBe(2);
        db.close();
      },
    );

    it('logs that lifecycle interception is skipped for unbound inbound messages', () => {
      const runtime = {
        transaction: vi.fn((callback) => callback({})),
        intercept: vi.fn(() =>
          ok({
            outcome: 'allow' as const,
            signals: [],
            input: {
              hook: 'message.before_persist' as const,
              input: { content: 'redacted' },
            },
          }),
        ),
        publish: vi.fn(() => ok({})),
      };
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child: vi.fn().mockReturnThis(),
      } as unknown as pino.Logger;
      vi.mocked(mocks.router.resolvePersona).mockReturnValue(ok(null));
      pipeline = new MessagePipeline(
        mocks.messageRepo,
        mocks.threadRepo,
        mocks.channelRepo,
        mocks.queueManager,
        mocks.router,
        mocks.auditLogger,
        logger,
        runtime as any,
        () => ok(undefined),
      );

      const result = pipeline.handleInboundEvent(makeEvent());

      expect(result._unsafeUnwrap()).toBe('no_persona');
      expect(runtime.intercept).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ hook: 'message.before_persist' }),
        expect.stringContaining('lifecycle inbound interception skipped'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Duplicate detection
  // -------------------------------------------------------------------------

  describe('duplicate detection', () => {
    it('returns Ok("duplicate") when the idempotency key already exists', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(makeChannelRow()));
      vi.mocked(mocks.threadRepo.findByExternalId).mockReturnValue(ok(makeThreadRow()));
      vi.mocked(mocks.messageRepo.existsByIdempotencyKey).mockReturnValue(true);

      const result = await pipeline.handleInboundEvent(makeEvent());
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('duplicate');
    });

    it('does not call messageRepo.insert for a duplicate', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(makeChannelRow()));
      vi.mocked(mocks.threadRepo.findByExternalId).mockReturnValue(ok(makeThreadRow()));
      vi.mocked(mocks.messageRepo.existsByIdempotencyKey).mockReturnValue(true);

      await pipeline.handleInboundEvent(makeEvent());
      expect(mocks.messageRepo.insert).not.toHaveBeenCalled();
    });

    it('does not call router.resolvePersona for a duplicate', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(makeChannelRow()));
      vi.mocked(mocks.threadRepo.findByExternalId).mockReturnValue(ok(makeThreadRow()));
      vi.mocked(mocks.messageRepo.existsByIdempotencyKey).mockReturnValue(true);

      await pipeline.handleInboundEvent(makeEvent());
      expect(mocks.router.resolvePersona).not.toHaveBeenCalled();
    });

    it('does not enqueue for a duplicate', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(makeChannelRow()));
      vi.mocked(mocks.threadRepo.findByExternalId).mockReturnValue(ok(makeThreadRow()));
      vi.mocked(mocks.messageRepo.existsByIdempotencyKey).mockReturnValue(true);

      await pipeline.handleInboundEvent(makeEvent());
      expect(mocks.queueManager.enqueue).not.toHaveBeenCalled();
    });

    it('increments the duplicates counter', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(makeChannelRow()));
      vi.mocked(mocks.threadRepo.findByExternalId).mockReturnValue(ok(makeThreadRow()));
      vi.mocked(mocks.messageRepo.existsByIdempotencyKey).mockReturnValue(true);

      await pipeline.handleInboundEvent(makeEvent());
      expect(pipeline.stats().duplicates).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // No persona case
  // -------------------------------------------------------------------------

  describe('no persona found', () => {
    beforeEach(() => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(makeChannelRow()));
      vi.mocked(mocks.threadRepo.findByExternalId).mockReturnValue(ok(makeThreadRow()));
      vi.mocked(mocks.messageRepo.existsByIdempotencyKey).mockReturnValue(false);
      vi.mocked(mocks.messageRepo.insert).mockReturnValue(ok(makeMessageRow()));
      // Router returns null — no binding
      vi.mocked(mocks.router.resolvePersona).mockReturnValue(ok(null));
    });

    it('returns Ok("no_persona") when no binding is found', async () => {
      const result = await pipeline.handleInboundEvent(makeEvent());
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('no_persona');
    });

    it('does not enqueue when no persona is found', async () => {
      await pipeline.handleInboundEvent(makeEvent());
      expect(mocks.queueManager.enqueue).not.toHaveBeenCalled();
    });

    it('calls auditLogger.logChannelSend when dropping the message', async () => {
      await pipeline.handleInboundEvent(makeEvent());
      expect(mocks.auditLogger.logChannelSend).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'pipeline.message.dropped',
          details: expect.objectContaining({ reason: 'no_persona' }),
        }),
      );
    });

    it('increments the noPersona counter', async () => {
      await pipeline.handleInboundEvent(makeEvent());
      expect(pipeline.stats().noPersona).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Channel not found
  // -------------------------------------------------------------------------

  describe('channel not found', () => {
    it('returns Err(PipelineError) when the channel is not found', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(null));

      const result = await pipeline.handleInboundEvent(makeEvent());
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(PipelineError);
    });

    it('returns Err(PipelineError) on channel DB error', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(
        err(new DbError('connection failed')),
      );

      const result = await pipeline.handleInboundEvent(makeEvent());
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('PIPELINE_ERROR');
    });

    it('increments the errors counter when channel is not found', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(null));
      await pipeline.handleInboundEvent(makeEvent());
      expect(pipeline.stats().errors).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Thread creation
  // -------------------------------------------------------------------------

  describe('thread creation', () => {
    it('creates a new thread when findByExternalId returns null', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(makeChannelRow()));
      vi.mocked(mocks.threadRepo.findByExternalId).mockReturnValue(ok(null));
      vi.mocked(mocks.threadRepo.insert).mockReturnValue(ok(makeThreadRow({ id: 'new-thread' })));
      vi.mocked(mocks.messageRepo.existsByIdempotencyKey).mockReturnValue(false);
      vi.mocked(mocks.messageRepo.insert).mockReturnValue(
        ok(makeMessageRow({ thread_id: 'new-thread' })),
      );
      vi.mocked(mocks.router.resolvePersona).mockReturnValue(ok('persona-uuid-1'));
      vi.mocked(mocks.queueManager.enqueue).mockReturnValue(ok(makeQueueItem()));

      const result = await pipeline.handleInboundEvent(makeEvent());
      expect(result._unsafeUnwrap()).toBe('enqueued');
      expect(mocks.threadRepo.insert).toHaveBeenCalledOnce();
    });

    it('passes the new thread id to the router and queue', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(makeChannelRow()));
      vi.mocked(mocks.threadRepo.findByExternalId).mockReturnValue(ok(null));
      vi.mocked(mocks.threadRepo.insert).mockImplementation((input) =>
        ok({ ...input, created_at: 1000, updated_at: 1000 }),
      );
      vi.mocked(mocks.messageRepo.existsByIdempotencyKey).mockReturnValue(false);
      vi.mocked(mocks.messageRepo.insert).mockReturnValue(ok(makeMessageRow()));
      vi.mocked(mocks.router.resolvePersona).mockReturnValue(ok('persona-uuid-1'));
      vi.mocked(mocks.queueManager.enqueue).mockReturnValue(ok(makeQueueItem()));

      await pipeline.handleInboundEvent(makeEvent());

      // The new thread id should match what was passed to insert
      const insertCall = vi.mocked(mocks.threadRepo.insert).mock.calls[0]?.[0];
      const newThreadId = insertCall?.id;
      expect(newThreadId).toBeTruthy();
      expect(mocks.router.resolvePersona).toHaveBeenCalledWith('chan-uuid-1', newThreadId);
    });

    it('returns Err on thread insert failure', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(makeChannelRow()));
      vi.mocked(mocks.threadRepo.findByExternalId).mockReturnValue(ok(null));
      vi.mocked(mocks.threadRepo.insert).mockReturnValue(err(new DbError('thread insert failed')));

      const result = await pipeline.handleInboundEvent(makeEvent());
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(PipelineError);
    });

    it('returns Err on findByExternalId failure', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(makeChannelRow()));
      vi.mocked(mocks.threadRepo.findByExternalId).mockReturnValue(
        err(new DbError('thread lookup failed')),
      );

      const result = await pipeline.handleInboundEvent(makeEvent());
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(PipelineError);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('returns Err(PipelineError) when messageRepo.insert fails', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(makeChannelRow()));
      vi.mocked(mocks.threadRepo.findByExternalId).mockReturnValue(ok(makeThreadRow()));
      vi.mocked(mocks.messageRepo.existsByIdempotencyKey).mockReturnValue(false);
      vi.mocked(mocks.messageRepo.insert).mockReturnValue(err(new DbError('disk full')));

      const result = await pipeline.handleInboundEvent(makeEvent());
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('PIPELINE_ERROR');
    });

    it('returns Err(PipelineError) when router.resolvePersona fails', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(makeChannelRow()));
      vi.mocked(mocks.threadRepo.findByExternalId).mockReturnValue(ok(makeThreadRow()));
      vi.mocked(mocks.messageRepo.existsByIdempotencyKey).mockReturnValue(false);
      vi.mocked(mocks.messageRepo.insert).mockReturnValue(ok(makeMessageRow()));
      vi.mocked(mocks.router.resolvePersona).mockReturnValue(
        err(new ChannelError('binding DB error')),
      );

      const result = await pipeline.handleInboundEvent(makeEvent());
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('PIPELINE_ERROR');
    });

    it('returns Err(PipelineError) when queueManager.enqueue fails', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(makeChannelRow()));
      vi.mocked(mocks.threadRepo.findByExternalId).mockReturnValue(ok(makeThreadRow()));
      vi.mocked(mocks.messageRepo.existsByIdempotencyKey).mockReturnValue(false);
      vi.mocked(mocks.messageRepo.insert).mockReturnValue(ok(makeMessageRow()));
      vi.mocked(mocks.router.resolvePersona).mockReturnValue(ok('persona-uuid-1'));
      vi.mocked(mocks.queueManager.enqueue).mockReturnValue(err(new QueueError('queue full')));

      const result = await pipeline.handleInboundEvent(makeEvent());
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('PIPELINE_ERROR');
    });

    it('catches unexpected thrown exceptions and returns Err(PipelineError)', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockImplementation(() => {
        throw new Error('unexpected crash');
      });

      const result = await pipeline.handleInboundEvent(makeEvent());
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(PipelineError);
    });

    it('increments the errors counter on all error outcomes', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(null));
      await pipeline.handleInboundEvent(makeEvent());
      expect(pipeline.stats().errors).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  describe('stats()', () => {
    it('returns zero counters initially', () => {
      expect(pipeline.stats()).toEqual({
        processed: 0,
        duplicates: 0,
        noPersona: 0,
        errors: 0,
      });
    });

    it('accumulates counters across multiple events', async () => {
      // Event 1: enqueued
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(makeChannelRow()));
      vi.mocked(mocks.threadRepo.findByExternalId).mockReturnValue(ok(makeThreadRow()));
      vi.mocked(mocks.messageRepo.existsByIdempotencyKey).mockReturnValue(false);
      vi.mocked(mocks.messageRepo.insert).mockReturnValue(ok(makeMessageRow()));
      vi.mocked(mocks.router.resolvePersona).mockReturnValue(ok('persona-1'));
      vi.mocked(mocks.queueManager.enqueue).mockReturnValue(ok(makeQueueItem()));
      await pipeline.handleInboundEvent(makeEvent({ idempotencyKey: 'k1' }));

      // Event 2: duplicate
      vi.mocked(mocks.messageRepo.existsByIdempotencyKey).mockReturnValue(true);
      await pipeline.handleInboundEvent(makeEvent({ idempotencyKey: 'k2' }));

      // Event 3: channel not found (error)
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(null));
      await pipeline.handleInboundEvent(makeEvent({ idempotencyKey: 'k3' }));

      const stats = pipeline.stats();
      expect(stats.processed).toBe(3);
      expect(stats.duplicates).toBe(1);
      expect(stats.errors).toBe(1);
    });

    it('returns a snapshot (not the live object)', () => {
      const snapshot1 = pipeline.stats();
      const snapshot2 = pipeline.stats();
      expect(snapshot1).not.toBe(snapshot2); // different object references
      expect(snapshot1).toEqual(snapshot2);
    });
  });

  // -------------------------------------------------------------------------
  // PipelineError code
  // -------------------------------------------------------------------------

  describe('PipelineError', () => {
    it('has code PIPELINE_ERROR', async () => {
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(null));
      const result = await pipeline.handleInboundEvent(makeEvent());
      expect(result._unsafeUnwrapErr().code).toBe('PIPELINE_ERROR');
    });
  });
});
