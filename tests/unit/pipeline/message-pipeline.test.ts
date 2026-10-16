/**
 * Unit tests for MessagePipeline.
 *
 * Uses vi.fn() mocks for all repositories and collaborators so that each test
 * exercises the pipeline's orchestration logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from 'neverthrow';
import pino from 'pino';
import { MessagePipeline } from '../../../src/pipeline/message-pipeline.js';
import { PipelineError } from '../../../src/core/errors/index.js';
import { DbError, ChannelError, QueueError } from '../../../src/core/errors/index.js';
import type { InboundEvent } from '../../../src/channels/channel-types.js';
import type { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import type { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import type { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import type { ChannelRouter } from '../../../src/channels/channel-router.js';
import type { QueueManager } from '../../../src/queue/queue-manager.js';
import type { AuditLogger } from '../../../src/core/logging/audit-logger.js';
import type { ChannelRow } from '../../../src/core/database/repositories/channel-repository.js';
import type { ThreadRow } from '../../../src/core/database/repositories/thread-repository.js';
import type { MessageRow } from '../../../src/core/database/repositories/message-repository.js';
import type { QueueItem } from '../../../src/queue/queue-types.js';
import { QueueItemStatus } from '../../../src/queue/queue-types.js';

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
      vi.mocked(mocks.router.resolvePersona).mockReturnValue(ok('persona-uuid-1'));
      vi.mocked(mocks.queueManager.enqueue).mockReturnValue(ok(makeQueueItem()));
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

  // -------------------------------------------------------------------------
  // Image ingestion path (coordinator injected)
  // -------------------------------------------------------------------------

  describe('image ingestion path', () => {
    const imageAttachment = {
      filename: 'a.png',
      mimeType: 'image/png',
      data: Buffer.from('BYTES'),
      size: 5,
    };

    let ingestion: { ingestMessage: ReturnType<typeof vi.fn> };
    let imgPipeline: MessagePipeline;

    beforeEach(() => {
      ingestion = { ingestMessage: vi.fn() };
      imgPipeline = new MessagePipeline(
        mocks.messageRepo,
        mocks.threadRepo,
        mocks.channelRepo,
        mocks.queueManager,
        mocks.router,
        mocks.auditLogger,
        silentLogger(),
        ingestion as unknown as import('../../../src/images/image-ingestion.js').ImageIngestionService,
      );
      vi.mocked(mocks.channelRepo.findByName).mockReturnValue(ok(makeChannelRow()));
      vi.mocked(mocks.threadRepo.findByExternalId).mockReturnValue(ok(makeThreadRow()));
      vi.mocked(mocks.router.resolvePersona).mockReturnValue(ok('persona-uuid-1'));
    });

    it('delegates image-bearing events to the coordinator and bypasses the text writes', async () => {
      ingestion.ingestMessage.mockResolvedValue(ok('enqueued'));

      const result = await imgPipeline.handleInboundEvent(
        makeEvent({ attachments: [imageAttachment] }),
      );

      expect(result._unsafeUnwrap()).toBe('enqueued');
      expect(ingestion.ingestMessage).toHaveBeenCalledTimes(1);
      const request = ingestion.ingestMessage.mock.calls[0][0];
      expect(request.channelId).toBe('chan-uuid-1');
      expect(request.channelName).toBe('test-bot');
      expect(request.externalMessageId).toBe('idempotency-key-001');
      expect(request.externalChatId).toBe('ext-thread-001');
      expect(request.threadId).toBe('thread-uuid-1');
      expect(request.personaId).toBe('persona-uuid-1');
      expect(request.attachments).toHaveLength(1);
      expect(request.message.content).toBe('Hello pipeline!');
      // The request carries no queue-payload view: completion payloads are
      // rebuilt by the coordinator from the committed Message row and the
      // route persisted with the Ingestion.
      expect(request.queuePayload).toBeUndefined();
      // The text path must stay fully bypassed for image events.
      expect(mocks.messageRepo.existsByIdempotencyKey).not.toHaveBeenCalled();
      expect(mocks.messageRepo.insert).not.toHaveBeenCalled();
      expect(mocks.queueManager.enqueue).not.toHaveBeenCalled();
    });

    it('does not involve the coordinator for text-only events', async () => {
      vi.mocked(mocks.messageRepo.existsByIdempotencyKey).mockReturnValue(false);
      vi.mocked(mocks.messageRepo.insert).mockReturnValue(ok(makeMessageRow()));
      vi.mocked(mocks.queueManager.enqueue).mockReturnValue(ok(makeQueueItem()));

      const result = await imgPipeline.handleInboundEvent(makeEvent());

      expect(result._unsafeUnwrap()).toBe('enqueued');
      expect(ingestion.ingestMessage).not.toHaveBeenCalled();
    });

    it('keeps the plain text path when no coordinator is injected', async () => {
      vi.mocked(mocks.messageRepo.existsByIdempotencyKey).mockReturnValue(false);
      vi.mocked(mocks.messageRepo.insert).mockReturnValue(ok(makeMessageRow()));
      vi.mocked(mocks.queueManager.enqueue).mockReturnValue(ok(makeQueueItem()));

      const result = await pipeline.handleInboundEvent(
        makeEvent({ attachments: [imageAttachment] }),
      );

      expect(result._unsafeUnwrap()).toBe('enqueued');
      expect(mocks.messageRepo.insert).toHaveBeenCalled();
      expect(mocks.queueManager.enqueue).toHaveBeenCalled();
    });

    it('maps no_persona with the audit record and passes personaId null', async () => {
      vi.mocked(mocks.router.resolvePersona).mockReturnValue(ok(null));
      ingestion.ingestMessage.mockResolvedValue(ok('no_persona'));

      const result = await imgPipeline.handleInboundEvent(
        makeEvent({ attachments: [imageAttachment] }),
      );

      expect(result._unsafeUnwrap()).toBe('no_persona');
      expect(ingestion.ingestMessage.mock.calls[0][0].personaId).toBeNull();
      expect(imgPipeline.stats().noPersona).toBe(1);
      expect(mocks.auditLogger.logChannelSend).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-uuid-1',
          action: 'pipeline.message.dropped',
          details: expect.objectContaining({ reason: 'no_persona' }),
        }),
      );
    });

    it('maps the duplicate outcome to the duplicate counter', async () => {
      ingestion.ingestMessage.mockResolvedValue(ok('duplicate'));

      const result = await imgPipeline.handleInboundEvent(
        makeEvent({ attachments: [imageAttachment] }),
      );

      expect(result._unsafeUnwrap()).toBe('duplicate');
      expect(imgPipeline.stats().duplicates).toBe(1);
    });

    it('propagates coordinator failures as PipelineError and counts an error', async () => {
      ingestion.ingestMessage.mockResolvedValue(err(new PipelineError('ingestion exploded')));

      const result = await imgPipeline.handleInboundEvent(
        makeEvent({ attachments: [imageAttachment] }),
      );

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('ingestion exploded');
      expect(imgPipeline.stats().errors).toBe(1);
    });

    it('reports persona resolution failures before consulting the coordinator', async () => {
      vi.mocked(mocks.router.resolvePersona).mockReturnValue(
        err(new ChannelError('binding lookup failed')),
      );

      const result = await imgPipeline.handleInboundEvent(
        makeEvent({ attachments: [imageAttachment] }),
      );

      expect(result.isErr()).toBe(true);
      expect(ingestion.ingestMessage).not.toHaveBeenCalled();
    });
  });
});
