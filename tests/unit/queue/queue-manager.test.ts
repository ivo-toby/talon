import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import pino from 'pino';
import { ok, err } from 'neverthrow';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { QueueManager, type QueueConfig } from '../../../src/queue/queue-manager.js';
import { QueueItemStatus, type QueueItem } from '../../../src/queue/queue-types.js';
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
  });

  // -------------------------------------------------------------------------
  // enqueueWithCommit
  // -------------------------------------------------------------------------

  describe('enqueueWithCommit', () => {
    /** Logger capturing emitted lines so success-log timing is observable. */
    function capturingLogger(): { logger: pino.Logger; lines: string[] } {
      const lines: string[] = [];
      const logger = pino({ level: 'info' }, { write: (chunk: unknown) => lines.push(String(chunk)) });
      return { logger, lines };
    }

    function companionInsert(messageId: string) {
      return db
        .prepare(
          `INSERT INTO messages (id, thread_id, direction, content, idempotency_key, provider_id, run_id, created_at)
           VALUES (?, ?, 'inbound', 'companion', ?, 'p', NULL, 1700000000000)`,
        )
        .run(messageId, threadId, `key-${messageId}`).changes;
    }

    function countQueueItems(): number {
      return (
        db.prepare('SELECT COUNT(*) AS n FROM queue_items').get() as { n: number }
      ).n;
    }

    it('commits the queue item and the companion write together', () => {
      const result = manager.enqueueWithCommit(threadId, 'message', { a: 1 }, undefined, () => {
        companionInsert('companion-msg');
        return ok(true);
      });

      expect(result.isOk()).toBe(true);
      const { item, value } = result._unsafeUnwrap();
      expect(value).toBe(true);
      expect(item.threadId).toBe(threadId);
      expect(countQueueItems()).toBe(1);
      const message = db
        .prepare('SELECT id FROM messages WHERE id = ?')
        .get('companion-msg');
      expect(message).toBeDefined();
    });

    it('rolls back BOTH the queue item and the companion write when the companion fails', () => {
      const result = manager.enqueueWithCommit(threadId, 'message', { a: 1 }, undefined, () => {
        companionInsert('companion-msg');
        return err(new Error('companion failed'));
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('companion failed');
      // No queue item and no companion row: the transaction rolled back.
      expect(countQueueItems()).toBe(0);
      expect(db.prepare('SELECT id FROM messages WHERE id = ?').get('companion-msg')).toBeUndefined();
    });

    it('logs success only after the transaction commits', () => {
      const { logger, lines } = capturingLogger();
      const managerWithLog = new QueueManager(queueRepo, threadRepo, DEFAULT_CONFIG, logger);

      managerWithLog.enqueueWithCommit(threadId, 'message', {}, undefined, () => ok(undefined));
      expect(lines.some((line) => line.includes('queue item enqueued'))).toBe(true);

      lines.length = 0;
      managerWithLog.enqueueWithCommit(threadId, 'message', {}, undefined, () =>
        err(new Error('boom')),
      );
      // A rolled back enqueue must NOT claim success in the log.
      expect(lines.some((line) => line.includes('queue item enqueued'))).toBe(false);
      managerWithLog.stopProcessing();
    });

    it('returns QueueError for a non-existent thread without logging success', () => {
      const { logger, lines } = capturingLogger();
      const managerWithLog = new QueueManager(queueRepo, threadRepo, DEFAULT_CONFIG, logger);

      const result = managerWithLog.enqueueWithCommit(uuid(), 'message', {}, undefined, () =>
        ok(undefined),
      );
      expect(result.isErr()).toBe(true);
      expect(countQueueItems()).toBe(0);
      expect(lines.some((line) => line.includes('queue item enqueued'))).toBe(false);
      managerWithLog.stopProcessing();
    });

    it('rejects nested invocation inside an enclosing ledger transaction without enqueueing or logging', () => {
      const { logger, lines } = capturingLogger();
      const managerWithLog = new QueueManager(queueRepo, threadRepo, DEFAULT_CONFIG, logger);

      // Nested ownership would silently join the enclosing transaction and
      // its post-commit success log could fire for an enclosing rollback.
      // The helper must refuse the call instead.
      const outer = db.transaction(() => {
        const nested = managerWithLog.enqueueWithCommit(
          threadId,
          'message',
          {},
          undefined,
          () => ok(undefined),
        );
        expect(nested.isErr()).toBe(true);
        expect(nested._unsafeUnwrapErr().message).toContain('enclosing transaction');
        return 'outer-done';
      });
      outer();

      expect(countQueueItems()).toBe(0);
      expect(lines.some((line) => line.includes('queue item enqueued'))).toBe(false);
      managerWithLog.stopProcessing();
    });

    it('emits no success log when the enclosing transaction rolls back after a rejected nested call', () => {
      const { logger, lines } = capturingLogger();
      const managerWithLog = new QueueManager(queueRepo, threadRepo, DEFAULT_CONFIG, logger);

      const outer = db.transaction(() => {
        managerWithLog.enqueueWithCommit(threadId, 'message', {}, undefined, () => ok(undefined));
        // The enclosing ledger transaction fails and rolls everything back.
        throw new Error('enclosing ledger rollback');
      });
      expect(() => outer()).toThrow('enclosing ledger rollback');

      expect(countQueueItems()).toBe(0);
      // Critically: no success claim was logged for the rolled-back scope.
      expect(lines.some((line) => line.includes('queue item enqueued'))).toBe(false);
      managerWithLog.stopProcessing();
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
