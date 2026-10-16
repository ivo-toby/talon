import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ok, err } from 'neverthrow';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import {
  createQueueDiagnosticResolver,
  QueueManager,
  type QueueConfig,
} from '../../../src/queue/queue-manager.js';
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

  describe('trusted queue diagnostic privacy', () => {
    it('injects one persisted resolver into processor and dead-letter handlers', async () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn().mockReturnThis(),
      } as any;
      const resolver = {
        resolveThread: vi.fn().mockReturnValue('voice'),
        resolveRow: vi.fn().mockReturnValue('voice'),
      };
      const isolatedManager = new QueueManager(
        queueRepo,
        threadRepo,
        { ...DEFAULT_CONFIG, maxAttempts: 1 },
        logger,
        undefined,
        resolver,
      );
      const internals = isolatedManager as any;
      expect(internals.processor.diagnosticResolver).toBe(resolver);
      expect(internals.deadLetterHandler.diagnosticResolver).toBe(resolver);

      const item = isolatedManager.enqueue(threadId, 'message', {})._unsafeUnwrap();
      const processed = await internals.processor.processNext(async () =>
        err(new Error('VOICE_QUEUE_FAILURE_SENTINEL')),
      );

      expect(processed?.id).toBe(item.id);
      expect(resolver.resolveRow).toHaveBeenCalled();
      expect(
        (queueRepo.findById(item.id)._unsafeUnwrap() as { error: string }).error,
      ).toBe('VOICE_QUEUE_FAILURE_SENTINEL');
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('VOICE_QUEUE_FAILURE_SENTINEL');
      isolatedManager.stopProcessing();
    });

    it('classifies from persisted thread and channel rows', () => {
      const channelId = (db.prepare('SELECT channel_id FROM threads WHERE id = ?').get(threadId) as {
        channel_id: string;
      }).channel_id;
      db.prepare('UPDATE channels SET type = ? WHERE id = ?').run('voice', channelId);
      const channelRepo = new ChannelRepository(db);
      const resolver = createQueueDiagnosticResolver(threadRepo, channelRepo);

      expect(resolver.resolveThread(threadId)).toBe('voice');
      expect(resolver.resolveThread(uuid())).toBe('unknown');
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
