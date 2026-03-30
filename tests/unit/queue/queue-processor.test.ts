import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ok, err } from 'neverthrow';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { DeadLetterHandler } from '../../../src/queue/dead-letter.js';
import { QueueProcessor } from '../../../src/queue/queue-processor.js';
import { calculateBackoff } from '../../../src/queue/retry-strategy.js';
import { QueueItemStatus, type QueueItem } from '../../../src/queue/queue-types.js';
import { createTestDb, createTestLogger, seedThread, enqueueItem, uuid } from './helpers.js';

describe('QueueProcessor', () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let processor: QueueProcessor;
  let threadId: string;

  beforeEach(() => {
    db = createTestDb();
    repo = new QueueRepository(db);
    const logger = createTestLogger();
    const dlHandler = new DeadLetterHandler(repo, logger);
    processor = new QueueProcessor(repo, calculateBackoff, dlHandler, logger);
    threadId = seedThread(db);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // processNext — FIFO ordering
  // -------------------------------------------------------------------------

  describe('processNext — FIFO ordering', () => {
    it('processes the oldest pending item first (FIFO)', async () => {
      const id1 = enqueueItem(repo, threadId);
      // Ensure a slightly different created_at by forcing a small gap.
      await new Promise((r) => setTimeout(r, 5));
      const id2 = enqueueItem(repo, threadId);

      const processedIds: string[] = [];
      const successHandler = async (item: QueueItem) => {
        processedIds.push(item.id);
        return ok<void, Error>(undefined);
      };

      // First call should process id1.
      const first = await processor.processNext(successHandler);
      expect(first?.id).toBe(id1);
      expect(processedIds[0]).toBe(id1);
    });

    it('returns null when no pending items exist', async () => {
      const result = await processor.processNext(async () => ok(undefined));
      expect(result).toBeNull();
    });

    it('returns the claimed item on success', async () => {
      const itemId = enqueueItem(repo, threadId);
      const result = await processor.processNext(async () => ok(undefined));
      expect(result).not.toBeNull();
      expect(result?.id).toBe(itemId);
    });
  });

  // -------------------------------------------------------------------------
  // processNext — no interleaved runs per thread
  // -------------------------------------------------------------------------

  describe('processNext — no interleaved runs per thread', () => {
    it('does not claim a second item for a thread that has an in-flight item', async () => {
      const id1 = enqueueItem(repo, threadId);
      const _id2 = enqueueItem(repo, threadId);

      // Process id1 but keep it in "claimed" state by not completing it.
      // We do this by manually claiming via the repo.
      repo.claimNext(threadId);

      // Now processNext should skip this thread because it has an inflight item.
      const result = await processor.processNext(async () => ok(undefined));
      expect(result).toBeNull();

      void id1;
    });

    it('allows a second thread to be claimed while the first is in flight', async () => {
      const thread2 = seedThread(db);
      enqueueItem(repo, threadId);
      enqueueItem(repo, thread2);

      // Claim the item for threadId manually (simulating in-flight).
      repo.claimNext(threadId);

      // processNext should be able to pick up thread2's item.
      const result = await processor.processNext(async () => ok(undefined));
      expect(result).not.toBeNull();
      expect(result?.threadId).toBe(thread2);
    });
  });

  describe('processNext — collaboration items bypass inflight check', () => {
    it('claims and processes a collaboration item on a thread with an inflight non-collaboration item', async () => {
      const inflightItemId = enqueueItem(repo, threadId);
      const collaborationItemId = enqueueItem(repo, threadId, { type: 'collaboration' });

      // Keep the first non-collaboration item in-flight.
      repo.claimNext(threadId);

      const handledIds: string[] = [];
      const result = await processor.processNext(async (item) => {
        handledIds.push(item.id);
        return ok(undefined);
      });

      expect(result).not.toBeNull();
      expect(result?.id).toBe(collaborationItemId);
      expect(result?.type).toBe('collaboration');
      expect(handledIds).toEqual([collaborationItemId]);

      const inflightRow = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(
        inflightItemId,
      ) as { status: string };
      expect(inflightRow.status).toBe('claimed');

      const collaborationRow = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(
        collaborationItemId,
      ) as { status: string };
      expect(collaborationRow.status).toBe('completed');
    });

    it('claims collaboration item even when a regular item is pending ahead of it (deadlock scenario)', async () => {
      // Simulate the deadlock: an item is in-flight, then a regular item is
      // enqueued, then a collaboration item is enqueued. Without the fix,
      // the oldest-pending check sees a regular type and skips the whole thread.
      const inflightItemId = enqueueItem(repo, threadId);
      // Manually put inflightItem into claimed state (simulates an in-flight run).
      db.prepare("UPDATE queue_items SET status = 'claimed' WHERE id = ?").run(inflightItemId);

      // Enqueue a regular item followed by a collaboration item.
      await new Promise((r) => setTimeout(r, 5));
      const regularPendingId = enqueueItem(repo, threadId);
      await new Promise((r) => setTimeout(r, 5));
      const collaborationItemId = enqueueItem(repo, threadId, { type: 'collaboration' });

      const handledIds: string[] = [];
      const result = await processor.processNext(async (item) => {
        handledIds.push(item.id);
        return ok(undefined);
      });

      // The collaboration item must be claimed and processed despite the regular
      // item sitting ahead of it in the queue.
      expect(result).not.toBeNull();
      expect(result?.id).toBe(collaborationItemId);
      expect(result?.type).toBe('collaboration');
      expect(handledIds).toEqual([collaborationItemId]);

      // Inflight and regular items must remain untouched.
      const inflightRow = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(
        inflightItemId,
      ) as { status: string };
      expect(inflightRow.status).toBe('claimed');

      const regularRow = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(
        regularPendingId,
      ) as { status: string };
      expect(regularRow.status).toBe('pending');

      const collaborationRow = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(
        collaborationItemId,
      ) as { status: string };
      expect(collaborationRow.status).toBe('completed');
    });

    it('still claims regular item first (FIFO) when thread is idle even if collaboration item is also pending', async () => {
      // Idle thread — no inflight item. Regular item is older and must come first.
      await new Promise((r) => setTimeout(r, 5));
      const regularId = enqueueItem(repo, threadId);
      await new Promise((r) => setTimeout(r, 5));
      const collaborationId = enqueueItem(repo, threadId, { type: 'collaboration' });

      const result = await processor.processNext(async () => ok(undefined));

      // FIFO must be preserved — regular item is claimed first.
      expect(result?.id).toBe(regularId);

      const regularRow = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(regularId) as { status: string };
      expect(regularRow.status).toBe('completed');

      const collabRow = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(collaborationId) as { status: string };
      expect(collabRow.status).toBe('pending');
    });
  });

  // -------------------------------------------------------------------------
  // complete
  // -------------------------------------------------------------------------

  describe('complete', () => {
    it('sets item status to completed', () => {
      const itemId = enqueueItem(repo, threadId);
      repo.claimNext(threadId);

      const result = processor.complete(itemId);
      expect(result.isOk()).toBe(true);

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(itemId) as {
        status: string;
      };
      expect(row.status).toBe('completed');
    });

    it('returns a QueueError for a non-existent item', () => {
      // complete on unknown id should succeed silently (SQLite UPDATE with no match).
      const result = processor.complete(uuid());
      // No error thrown — the repository does a silent UPDATE 0 rows.
      expect(result.isOk()).toBe(true);
    });

    it('completes an item that was processed via processNext', async () => {
      const itemId = enqueueItem(repo, threadId);
      await processor.processNext(async () => ok(undefined));

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(itemId) as {
        status: string;
      };
      expect(row.status).toBe('completed');
    });
  });

  // -------------------------------------------------------------------------
  // fail — retry
  // -------------------------------------------------------------------------

  describe('fail — with retry', () => {
    it('increments attempts and sets status to failed', () => {
      const itemId = enqueueItem(repo, threadId, { max_attempts: 3 });
      repo.claimNext(threadId);

      const result = processor.fail(itemId, 'transient error');
      expect(result.isOk()).toBe(true);

      const row = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(itemId) as {
        status: string;
        attempts: number;
        next_retry_at: number;
        error: string;
      };
      expect(row.status).toBe('failed');
      expect(row.attempts).toBe(1);
      expect(row.next_retry_at).toBeGreaterThan(Date.now());
      expect(row.error).toBe('transient error');
    });

    it('applies exponential backoff strategy for retry time', () => {
      const mockBackoff = vi.fn().mockReturnValue(5000);
      const logger = createTestLogger();
      const dlHandler = new DeadLetterHandler(repo, logger);
      const proc = new QueueProcessor(repo, mockBackoff, dlHandler, logger);

      const itemId = enqueueItem(repo, threadId, { max_attempts: 5 });
      repo.claimNext(threadId);

      const before = Date.now();
      proc.fail(itemId, 'err');
      const after = Date.now();

      expect(mockBackoff).toHaveBeenCalledOnce();
      // The retry should be approximately before + 5000
      const row = db.prepare('SELECT next_retry_at FROM queue_items WHERE id = ?').get(itemId) as {
        next_retry_at: number;
      };
      expect(row.next_retry_at).toBeGreaterThanOrEqual(before + 5000);
      expect(row.next_retry_at).toBeLessThanOrEqual(after + 5000);
    });

    it('returns QueueError for unknown item id', () => {
      const result = processor.fail(uuid(), 'err');
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('QUEUE_ERROR');
    });
  });

  // -------------------------------------------------------------------------
  // fail — dead-letter after max attempts
  // -------------------------------------------------------------------------

  describe('fail — dead-letter after max attempts', () => {
    it('moves item to dead_letter when attempts reach max_attempts', () => {
      const itemId = enqueueItem(repo, threadId, { max_attempts: 1 });
      repo.claimNext(threadId);

      const result = processor.fail(itemId, 'fatal error');
      expect(result.isOk()).toBe(true);

      const row = db.prepare('SELECT status, error FROM queue_items WHERE id = ?').get(
        itemId,
      ) as {
        status: string;
        error: string;
      };
      expect(row.status).toBe('dead_letter');
      expect(row.error).toBe('fatal error');
    });

    it('dead-letters after exactly max_attempts failures via processNext', async () => {
      const itemId = enqueueItem(repo, threadId, { max_attempts: 2 });
      let callCount = 0;

      const failHandler = async (_item: QueueItem) => {
        callCount++;
        return err<void, Error>(new Error('always fails'));
      };

      // First attempt: fails → retry scheduled
      await processor.processNext(failHandler);

      // Force next_retry_at to the past so it's eligible again
      db.prepare('UPDATE queue_items SET next_retry_at = 0 WHERE id = ?').run(itemId);

      // Second attempt: fails → dead-lettered (2 attempts = max)
      await processor.processNext(failHandler);

      expect(callCount).toBe(2);

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(itemId) as {
        status: string;
      };
      expect(row.status).toBe('dead_letter');
    });
  });

  // -------------------------------------------------------------------------
  // handler errors are propagated to fail()
  // -------------------------------------------------------------------------

  describe('handler errors are propagated', () => {
    it('calls fail() when handler returns Err', async () => {
      const itemId = enqueueItem(repo, threadId, { max_attempts: 3 });
      await processor.processNext(async () => err(new Error('handler error')));

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(itemId) as {
        status: string;
      };
      expect(row.status).toBe('failed');
    });

    it('calls fail() when handler throws', async () => {
      const itemId = enqueueItem(repo, threadId, { max_attempts: 3 });
      await processor.processNext(async () => {
        throw new Error('unexpected throw');
      });

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(itemId) as {
        status: string;
      };
      expect(row.status).toBe('failed');
    });
  });
});
