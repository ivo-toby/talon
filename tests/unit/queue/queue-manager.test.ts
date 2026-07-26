import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ok, err } from 'neverthrow';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { QueueManager, type QueueConfig } from '../../../src/queue/queue-manager.js';
import { QueueItemStatus, type QueueItem } from '../../../src/queue/queue-types.js';
import { LifecycleEventRepository } from '../../../src/core/database/repositories/lifecycle-event-repository.js';
import { LifecycleEventBus } from '../../../src/lifecycle/lifecycle-event-bus.js';
import { LifecycleRuntime } from '../../../src/lifecycle/lifecycle-runtime.js';
import { LifecycleInterceptorEngine } from '../../../src/lifecycle/interceptors/interceptor-engine.js';
import { TransactionContext } from '../../../src/lifecycle/transaction-context.js';
import { createTestDb, createTestLogger, seedThread, uuid } from './helpers.js';

const DEFAULT_CONFIG: QueueConfig = {
  maxAttempts: 3,
  backoffBaseMs: 100,
  backoffMaxMs: 5000,
  concurrencyLimit: 2,
};

describe('QueueManager', () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let threadRepo: ThreadRepository;
  let manager: QueueManager;
  let threadId: string;

  beforeEach(() => {
    db = createTestDb();
    queueRepo = new QueueRepository(db);
    threadRepo = new ThreadRepository(db);
    manager = new QueueManager(queueRepo, threadRepo, DEFAULT_CONFIG, createTestLogger());
    threadId = seedThread(db);
  });

  afterEach(() => {
    manager.stopProcessing();
    db.close();
  });

  // -------------------------------------------------------------------------
  // enqueue
  // -------------------------------------------------------------------------

  describe('enqueue', () => {
    it('returns a QueueItem with status=pending', () => {
      const result = manager.enqueue(threadId, 'message', { text: 'hello' });
      expect(result.isOk()).toBe(true);

      const item = result._unsafeUnwrap();
      expect(item.status).toBe(QueueItemStatus.Pending);
      expect(item.threadId).toBe(threadId);
      expect(item.type).toBe('message');
      expect(item.maxAttempts).toBe(DEFAULT_CONFIG.maxAttempts);
    });

    it('stores the payload as a parsed object', () => {
      const payload = { key: 'value', num: 42 };
      const item = manager.enqueue(threadId, 'message', payload)._unsafeUnwrap();
      expect(item.payload).toEqual(payload);
    });

    it('stores items without a messageId (messageId is optional)', () => {
      // messageId references messages(id) FK — omitting is valid.
      const item = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
      expect(item.messageId).toBeUndefined();
    });

    it('returns QueueError for a non-existent thread', () => {
      const result = manager.enqueue(uuid(), 'message', {});
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('QUEUE_ERROR');
    });

    it('supports all item types', () => {
      for (const type of ['message', 'schedule', 'collaboration'] as const) {
        const result = manager.enqueue(threadId, type, {});
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().type).toBe(type);
      }
    });

    it('generates a unique id for each item', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const item = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
        ids.add(item.id);
      }
      expect(ids.size).toBe(10);
    });

    it('atomically publishes a bounded lifecycle event for a scoped enqueue', () => {
      const lifecycleRuntime = {
        transaction: vi.fn((callback) => callback({})),
        publish: vi.fn(() => ok({})),
      };
      const lifecycleManager = new QueueManager(
        queueRepo,
        threadRepo,
        DEFAULT_CONFIG,
        createTestLogger(),
        lifecycleRuntime as any,
      );

      const result = lifecycleManager.enqueue(
        threadId,
        'message',
        {
          content: 'must not enter lifecycle payloads',
        },
        undefined,
        { persona: 'assistant', itemType: 'message' },
      );

      expect(result.isOk()).toBe(true);
      expect(lifecycleRuntime.transaction).toHaveBeenCalledOnce();
      expect(lifecycleRuntime.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            type: 'queue.item.enqueued.v1',
            payload: expect.objectContaining({
              references: expect.arrayContaining([expect.objectContaining({ type: 'queue_item' })]),
              metadata: { itemType: 'message' },
            }),
          }),
          persona: 'assistant',
          itemOrigin: 'queue',
        }),
        expect.anything(),
      );
      expect(lifecycleRuntime.publish.mock.calls[0]?.[0].event.payload).not.toHaveProperty(
        'content',
      );
      const stored = queueRepo.findById(result._unsafeUnwrap().id)._unsafeUnwrap();
      expect(stored?.payload).toBe(
        JSON.stringify({ content: 'must not enter lifecycle payloads' }),
      );
      expect(stored?.lifecycle_persona).toBe('assistant');
      expect(stored?.lifecycle_item_type).toBe('message');
    });

    it('uses the message id as one stable lifecycle correlation chain', () => {
      const lifecycleRuntime = {
        transaction: vi.fn((callback) => callback({})),
        publish: vi.fn(() => ok({})),
      };
      const lifecycleManager = new QueueManager(
        queueRepo,
        threadRepo,
        DEFAULT_CONFIG,
        createTestLogger(),
        lifecycleRuntime as any,
      );
      const messageId = uuid();
      expect(
        new MessageRepository(db)
          .insert({
            id: messageId,
            thread_id: threadId,
            direction: 'inbound',
            content: '{}',
            idempotency_key: uuid(),
            provider_id: null,
            run_id: null,
          })
          .isOk(),
      ).toBe(true);

      expect(
        lifecycleManager
          .enqueue(threadId, 'message', {}, messageId, {
            persona: 'assistant',
            itemType: 'message',
          })
          .isOk(),
      ).toBe(true);

      expect(lifecycleRuntime.publish.mock.calls[0]?.[0].event.context.correlationId).toBe(
        messageId,
      );
    });

    it('idempotently ensures deterministic queue work and publishes only fresh inserts', () => {
      const lifecycleRuntime = {
        transaction: vi.fn((callback) => callback({})),
        publish: vi.fn(() => ok({})),
      };
      const lifecycleManager = new QueueManager(
        queueRepo,
        threadRepo,
        DEFAULT_CONFIG,
        createTestLogger(),
        lifecycleRuntime as any,
      );
      const messageId = uuid();
      expect(
        new MessageRepository(db)
          .insert({
            id: messageId,
            thread_id: threadId,
            direction: 'inbound',
            content: '{}',
            idempotency_key: uuid(),
            provider_id: null,
            run_id: null,
          })
          .isOk(),
      ).toBe(true);

      const first = lifecycleManager.enqueueWithId(
        'context-rotation-continue:qi-001',
        threadId,
        'message',
        { personaId: 'persona-001', content: 'continue' },
        messageId,
        { persona: 'assistant', itemType: 'message' },
      );
      const second = lifecycleManager.enqueueWithId(
        'context-rotation-continue:qi-001',
        threadId,
        'message',
        { personaId: 'persona-001', content: 'continue' },
        messageId,
        { persona: 'assistant', itemType: 'message' },
      );

      expect(first.isOk()).toBe(true);
      expect(second.isOk()).toBe(true);
      expect(first._unsafeUnwrap().id).toBe('context-rotation-continue:qi-001');
      expect(second._unsafeUnwrap().id).toBe('context-rotation-continue:qi-001');
      expect(lifecycleRuntime.transaction).toHaveBeenCalledTimes(2);
      expect(lifecycleRuntime.publish).toHaveBeenCalledTimes(1);
      expect(
        (db.prepare('SELECT COUNT(*) AS count FROM queue_items').get() as { count: number }).count,
      ).toBe(1);
    });

    it('uses the queue item id as the stable schedule correlation chain', () => {
      const lifecycleRuntime = {
        transaction: vi.fn((callback) => callback({})),
        publish: vi.fn(() => ok({})),
      };
      const lifecycleManager = new QueueManager(
        queueRepo,
        threadRepo,
        DEFAULT_CONFIG,
        createTestLogger(),
        lifecycleRuntime as any,
      );

      expect(
        lifecycleManager
          .enqueue(threadId, 'schedule', {}, undefined, {
            persona: 'assistant',
            itemType: 'schedule',
          })
          .isOk(),
      ).toBe(true);

      const event = lifecycleRuntime.publish.mock.calls[0]?.[0].event;
      expect(event.context.correlationId).toBe(event.context.aggregate.id);
    });

    it('uses the unchanged legacy enqueue path without a lifecycle runtime', () => {
      const result = manager.enqueue(threadId, 'message', { personaName: 'assistant' });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().status).toBe(QueueItemStatus.Pending);
    });

    it('discards trusted producer lifecycle scope when lifecycle is disabled', () => {
      const result = manager.enqueue(threadId, 'message', { content: 'legacy work' }, undefined, {
        persona: 'assistant',
        itemType: 'message',
      });

      expect(result.isOk()).toBe(true);
      const stored = queueRepo.findById(result._unsafeUnwrap().id)._unsafeUnwrap();
      expect(stored?.lifecycle_persona).toBeNull();
      expect(stored?.lifecycle_item_type).toBeNull();
    });

    it('rejects a new lifecycle-enabled message enqueue without trusted scope', () => {
      const lifecycleRuntime = {
        transaction: vi.fn(),
        publish: vi.fn(),
      };
      const lifecycleManager = new QueueManager(
        queueRepo,
        threadRepo,
        DEFAULT_CONFIG,
        createTestLogger(),
        lifecycleRuntime as any,
      );

      const result = lifecycleManager.enqueue(threadId, 'message', { content: 'ordinary work' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('require manager-owned lifecycle scope');
      expect(lifecycleRuntime.transaction).not.toHaveBeenCalled();
      expect(lifecycleRuntime.publish).not.toHaveBeenCalled();
      expect(
        (db.prepare('SELECT COUNT(*) AS count FROM queue_items').get() as { count: number }).count,
      ).toBe(0);
    });

    it('keeps lifecycle-enabled collaboration work on the compatibility path without scope', () => {
      const lifecycleRuntime = {
        transaction: vi.fn(),
        publish: vi.fn(),
      };
      const lifecycleManager = new QueueManager(
        queueRepo,
        threadRepo,
        DEFAULT_CONFIG,
        createTestLogger(),
        lifecycleRuntime as any,
      );

      expect(lifecycleManager.enqueue(threadId, 'collaboration', { kind: 'notice' }).isOk()).toBe(
        true,
      );
      expect(lifecycleRuntime.transaction).not.toHaveBeenCalled();
      expect(lifecycleRuntime.publish).not.toHaveBeenCalled();
    });

    it('rejects forged and cross-runtime transaction contexts before queue mutation', () => {
      const createRuntime = () =>
        new LifecycleRuntime(
          new LifecycleEventBus(new LifecycleEventRepository(db), {
            resolveEventHandlers: () => [],
          }),
          new LifecycleInterceptorEngine({ resolveHandlers: () => [], implementations: {} }),
          {} as any,
        );
      const owner = createRuntime();
      const other = createRuntime();
      const lifecycleManager = new QueueManager(
        queueRepo,
        threadRepo,
        DEFAULT_CONFIG,
        createTestLogger(),
        owner,
      );
      const scope = { persona: 'assistant', itemType: 'message' as const };
      const before = db.prepare('SELECT COUNT(*) AS count FROM queue_items').get() as {
        count: number;
      };

      expect(
        lifecycleManager
          .enqueueInLifecycleTransaction(threadId, 'message', {}, scope, new TransactionContext())
          .isErr(),
      ).toBe(true);
      other.transaction((transaction) => {
        const result = lifecycleManager.enqueueInLifecycleTransaction(
          threadId,
          'message',
          {},
          scope,
          transaction,
        );
        expect(result.isErr()).toBe(true);
        return ok(undefined);
      });

      const after = db.prepare('SELECT COUNT(*) AS count FROM queue_items').get() as {
        count: number;
      };
      expect(after.count).toBe(before.count);
    });
  });

  // -------------------------------------------------------------------------
  // stats
  // -------------------------------------------------------------------------

  describe('stats', () => {
    it('returns zero counts for an empty queue', () => {
      const stats = manager.stats();
      expect(stats).toEqual({ pending: 0, claimed: 0, processing: 0, deadLetter: 0 });
    });

    it('reflects enqueued items as pending', () => {
      manager.enqueue(threadId, 'message', {});
      manager.enqueue(threadId, 'message', {});
      const stats = manager.stats();
      expect(stats.pending).toBe(2);
    });

    it('reflects dead-letter items', () => {
      manager.enqueue(threadId, 'message', {});
      // Claim and immediately dead-letter via direct repo call
      const row = queueRepo.claimNext(threadId)._unsafeUnwrap();
      if (row) {
        queueRepo.markDeadLetter(row.id, 'manual');
      }
      const stats = manager.stats();
      expect(stats.deadLetter).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // processing loop
  // -------------------------------------------------------------------------

  describe('startProcessing / stopProcessing', () => {
    it('returns a bounded timeout and aborts a non-settling handler without a later repository transition', async () => {
      vi.useFakeTimers();
      const item = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
      let resolveHandler!: (value: ReturnType<typeof ok>) => void;
      const pending = new Promise<ReturnType<typeof ok>>((resolve) => {
        resolveHandler = resolve;
      });
      let signal: AbortSignal | undefined;
      manager.startProcessing(async (_item, handlerSignal) => {
        signal = handlerSignal;
        return pending;
      });
      await vi.advanceTimersByTimeAsync(500);

      const stopping = manager.stopProcessing(10);
      await vi.advanceTimersByTimeAsync(10);
      expect(await stopping).toEqual({ status: 'timed_out' });
      expect(signal?.aborted).toBe(true);

      resolveHandler(ok(undefined));
      await vi.runAllTimersAsync();
      expect(queueRepo.findById(item.id)._unsafeUnwrap()?.status).toBe('claimed');
      vi.useRealTimers();
    });

    it('processes an enqueued item within the poll interval', async () => {
      manager.enqueue(threadId, 'message', { task: 'do-work' });
      const processed: QueueItem[] = [];

      manager.startProcessing(async (item) => {
        processed.push(item);
        return ok(undefined);
      });

      // Wait for at least 2 poll intervals
      await new Promise((r) => setTimeout(r, 1200));
      manager.stopProcessing();

      expect(processed.length).toBeGreaterThanOrEqual(1);
      expect(processed[0]?.type).toBe('message');
    });

    it('marks the item as completed after successful handler', async () => {
      const item = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();

      manager.startProcessing(async () => ok(undefined));
      await new Promise((r) => setTimeout(r, 1200));
      manager.stopProcessing();

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(item.id) as {
        status: string;
      };
      expect(row.status).toBe('completed');
    });

    it('marks the item as failed after handler error', async () => {
      const item = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();

      manager.startProcessing(async () => err(new Error('test failure')));
      await new Promise((r) => setTimeout(r, 1200));
      manager.stopProcessing();

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(item.id) as {
        status: string;
      };
      expect(row.status).toBe('failed');
    });

    it('stops processing after stopProcessing is called', async () => {
      let callCount = 0;

      manager.startProcessing(async () => {
        callCount++;
        return ok(undefined);
      });

      // No items enqueued — let the loop tick a few times with nothing to do.
      await new Promise((r) => setTimeout(r, 600));
      manager.stopProcessing();

      const countAfterStop = callCount;
      await new Promise((r) => setTimeout(r, 600));

      // callCount should not have increased after stopProcessing.
      expect(callCount).toBe(countAfterStop);
    });

    it('warns and returns early if startProcessing called twice', () => {
      // No items, just verify it doesn't throw.
      manager.startProcessing(async () => ok(undefined));
      manager.startProcessing(async () => ok(undefined)); // should be a no-op warning
      manager.stopProcessing();
    });
  });

  // -------------------------------------------------------------------------
  // concurrency limit
  // -------------------------------------------------------------------------

  describe('concurrency limit', () => {
    it('does not exceed concurrencyLimit active handlers', async () => {
      // Enqueue more items than the concurrency limit across different threads.
      const thread2 = seedThread(db);
      const thread3 = seedThread(db);

      manager.enqueue(threadId, 'message', {});
      manager.enqueue(thread2, 'message', {});
      manager.enqueue(thread3, 'message', {});

      let maxConcurrent = 0;
      let currentConcurrent = 0;

      manager.startProcessing(async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((r) => setTimeout(r, 50));
        currentConcurrent--;
        return ok(undefined);
      });

      await new Promise((r) => setTimeout(r, 800));
      manager.stopProcessing();

      // Should never exceed the configured concurrency limit of 2.
      expect(maxConcurrent).toBeLessThanOrEqual(DEFAULT_CONFIG.concurrencyLimit);
    });
  });
});
