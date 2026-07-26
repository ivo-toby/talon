import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { QueueRepository } from '../../../../../src/core/database/repositories/queue-repository.js';
import { ThreadRepository } from '../../../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { createTestDb, uuid } from './helpers.js';

describe('QueueRepository', () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let threadId: string;

  beforeEach(() => {
    db = createTestDb();
    repo = new QueueRepository(db);

    const channels = new ChannelRepository(db);
    const channelId = uuid();
    channels.insert({
      id: channelId,
      type: 'telegram',
      name: `ch-${uuid()}`,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    const threads = new ThreadRepository(db);
    threadId = uuid();
    threads.insert({
      id: threadId,
      channel_id: channelId,
      external_id: `ext-${uuid()}`,
      metadata: '{}',
    });
  });

  afterEach(() => {
    db.close();
  });

  function makeItem(overrides: Partial<Parameters<QueueRepository['enqueue']>[0]> = {}) {
    return {
      id: uuid(),
      thread_id: threadId,
      message_id: null,
      type: 'message' as const,
      payload: '{}',
      max_attempts: 3,
      ...overrides,
    };
  }

  describe('enqueue', () => {
    it('enqueues an item with status=pending', () => {
      const input = makeItem();
      const result = repo.enqueue(input);
      expect(result.isOk()).toBe(true);
      const row = result._unsafeUnwrap();
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(0);
      expect(row.claimed_at).toBeNull();
    });

    it('idempotently returns an existing deterministic item', () => {
      const input = makeItem({ id: 'context-rotation-continue:qi-001' });

      const first = repo.enqueueIfAbsent(input);
      const second = repo.enqueueIfAbsent(input);

      expect(first.isOk()).toBe(true);
      expect(second.isOk()).toBe(true);
      expect(first._unsafeUnwrap().inserted).toBe(true);
      expect(second._unsafeUnwrap().inserted).toBe(false);
      expect(second._unsafeUnwrap().item.id).toBe(input.id);
      expect(
        (db.prepare('SELECT COUNT(*) AS count FROM queue_items').get() as { count: number }).count,
      ).toBe(1);
    });

    it('rejects deterministic id collisions with different work payloads', () => {
      const input = makeItem({ id: 'context-rotation-continue:qi-001' });
      const collision = makeItem({
        ...input,
        payload: JSON.stringify({ different: true }),
      });

      expect(repo.enqueueIfAbsent(input).isOk()).toBe(true);
      const result = repo.enqueueIfAbsent(collision);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Queue item id collision');
    });
  });

  describe('claimNext', () => {
    it('claims the oldest pending item for a thread', () => {
      const a = makeItem();
      const b = makeItem();
      repo.enqueue(a);
      repo.enqueue(b);

      const result = repo.claimNext(threadId);
      expect(result.isOk()).toBe(true);
      const row = result._unsafeUnwrap();
      expect(row).not.toBeNull();
      expect(row!.status).toBe('claimed');
      expect(row!.id).toBe(a.id); // oldest first
    });

    it('returns null when no pending items exist', () => {
      const result = repo.claimNext(threadId);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('does not claim an item whose next_retry_at is in the future', () => {
      const input = makeItem();
      repo.enqueue(input);
      // Fail it to set a future retry time.
      repo.claimNext(threadId);
      repo.fail(input.id, 'transient error', Date.now() + 60_000);

      const result = repo.claimNext(threadId);
      expect(result._unsafeUnwrap()).toBeNull();
    });
  });

  describe('complete', () => {
    it('sets status to completed', () => {
      const input = makeItem();
      repo.enqueue(input);
      repo.claimNext(threadId);
      repo.complete(input.id);

      const row = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(input.id) as {
        status: string;
      };
      expect(row.status).toBe('completed');
    });
  });

  describe('fail', () => {
    it('increments attempts and sets failed status with retry time', () => {
      const input = makeItem({ max_attempts: 3 });
      repo.enqueue(input);
      repo.claimNext(threadId);

      const retryAt = Date.now() + 5000;
      repo.fail(input.id, 'oops', retryAt);

      const row = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(input.id) as {
        status: string;
        attempts: number;
        next_retry_at: number;
        error: string;
      };
      expect(row.status).toBe('failed');
      expect(row.attempts).toBe(1);
      expect(row.next_retry_at).toBe(retryAt);
      expect(row.error).toBe('oops');
    });

    it('moves to dead_letter when max_attempts is reached', () => {
      const input = makeItem({ max_attempts: 1 });
      repo.enqueue(input);
      repo.claimNext(threadId);
      repo.fail(input.id, 'fatal', Date.now() + 1000);

      const row = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(input.id) as {
        status: string;
      };
      expect(row.status).toBe('dead_letter');
    });

    it('returns err for unknown id', () => {
      expect(repo.fail(uuid(), 'err', Date.now() + 1000).isErr()).toBe(true);
    });
  });

  describe('markDeadLetter', () => {
    it('sets status to dead_letter', () => {
      const input = makeItem();
      repo.enqueue(input);
      repo.markDeadLetter(input.id, 'manual DLQ');

      const row = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(input.id) as {
        status: string;
        error: string;
      };
      expect(row.status).toBe('dead_letter');
      expect(row.error).toBe('manual DLQ');
    });
  });

  describe('findPending', () => {
    it('returns items with elapsed retry times', () => {
      const a = makeItem();
      repo.enqueue(a);
      const rows = repo.findPending()._unsafeUnwrap();
      expect(rows.some((r) => r.id === a.id)).toBe(true);
    });

    it('excludes completed and dead-letter items', () => {
      const a = makeItem();
      const b = makeItem();
      repo.enqueue(a);
      repo.enqueue(b);
      repo.claimNext(threadId);
      repo.complete(a.id);
      repo.markDeadLetter(b.id, 'dead');

      const rows = repo.findPending()._unsafeUnwrap();
      expect(rows.every((r) => r.status !== 'completed' && r.status !== 'dead_letter')).toBe(true);
    });
  });

  describe('findDeadLetter', () => {
    it('returns dead-letter items', () => {
      const a = makeItem();
      repo.enqueue(a);
      repo.markDeadLetter(a.id, 'gone');
      const rows = repo.findDeadLetter()._unsafeUnwrap();
      expect(rows.some((r) => r.id === a.id)).toBe(true);
    });
  });

  describe('countByStatus', () => {
    it('returns counts grouped by status', () => {
      // Enqueue 3 items.
      const a = makeItem();
      const b = makeItem();
      repo.enqueue(a);
      repo.enqueue(b);
      repo.enqueue(makeItem());

      // Claim the oldest (a), then complete it — leaving b and the third as pending.
      repo.claimNext(threadId);
      repo.complete(a.id);

      const counts = repo.countByStatus()._unsafeUnwrap();
      // 2 items remain in pending, 1 completed.
      expect(counts['pending']).toBeGreaterThanOrEqual(2);
      expect(counts['completed']).toBeGreaterThanOrEqual(1);
    });
  });

  describe('purge', () => {
    it('returns ok(0) and deletes nothing when given an empty array', () => {
      const a = makeItem();
      repo.enqueue(a);

      const result = repo.purge([]);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe(0);

      // Item should still exist.
      const row = repo.findById(a.id)._unsafeUnwrap();
      expect(row).not.toBeNull();
    });

    it('deletes only items matching the specified statuses', () => {
      const pending1 = makeItem();
      const pending2 = makeItem();
      const completed1 = makeItem();
      repo.enqueue(pending1);
      repo.enqueue(pending2);
      repo.enqueue(completed1);

      // Move completed1 through claimed -> completed.
      repo.claimNext(threadId);
      repo.complete(pending1.id);

      // Now pending1 is completed, pending2 and completed1 are pending.
      // Purge only completed items.
      const result = repo.purge(['completed']);
      expect(result._unsafeUnwrap()).toBe(1);

      // The completed item should be gone.
      expect(repo.findById(pending1.id)._unsafeUnwrap()).toBeNull();
      // The pending items should remain.
      expect(repo.findById(pending2.id)._unsafeUnwrap()).not.toBeNull();
      expect(repo.findById(completed1.id)._unsafeUnwrap()).not.toBeNull();
    });

    it('returns the correct count of deleted items', () => {
      // Create 3 items and complete all of them.
      const items = [makeItem(), makeItem(), makeItem()];
      for (const item of items) {
        repo.enqueue(item);
      }
      for (const item of items) {
        repo.claimNext(threadId);
        repo.complete(item.id);
      }

      const result = repo.purge(['completed']);
      expect(result._unsafeUnwrap()).toBe(3);
    });

    it('purges items across multiple statuses in a single call', () => {
      const a = makeItem();
      const b = makeItem();
      const c = makeItem();
      const d = makeItem();
      repo.enqueue(a);
      repo.enqueue(b);
      repo.enqueue(c);
      repo.enqueue(d);

      // a -> completed
      repo.claimNext(threadId);
      repo.complete(a.id);

      // b -> dead_letter
      repo.markDeadLetter(b.id, 'permanent failure');

      // c, d remain pending.

      const result = repo.purge(['completed', 'dead_letter']);
      expect(result._unsafeUnwrap()).toBe(2);

      expect(repo.findById(a.id)._unsafeUnwrap()).toBeNull();
      expect(repo.findById(b.id)._unsafeUnwrap()).toBeNull();
      expect(repo.findById(c.id)._unsafeUnwrap()).not.toBeNull();
      expect(repo.findById(d.id)._unsafeUnwrap()).not.toBeNull();
    });

    it('returns ok(0) when no items match the given statuses', () => {
      const a = makeItem();
      repo.enqueue(a); // status = pending

      const result = repo.purge(['completed', 'dead_letter']);
      expect(result._unsafeUnwrap()).toBe(0);

      // The pending item should be untouched.
      expect(repo.findById(a.id)._unsafeUnwrap()).not.toBeNull();
    });

    it('leaves remaining items fully queryable after purge', () => {
      const toRemove = makeItem();
      const toKeep = makeItem();
      repo.enqueue(toRemove);
      repo.enqueue(toKeep);

      // claimNext claims oldest first (toRemove), then complete it.
      repo.claimNext(threadId);
      repo.complete(toRemove.id);

      // toRemove is now completed, toKeep is still pending.
      repo.purge(['completed']);

      // toKeep is still pending and queryable.
      const row = repo.findById(toKeep.id)._unsafeUnwrap();
      expect(row).not.toBeNull();
      expect(row!.status).toBe('pending');

      // toRemove is gone.
      expect(repo.findById(toRemove.id)._unsafeUnwrap()).toBeNull();

      // countByStatus should still work correctly.
      const counts = repo.countByStatus()._unsafeUnwrap();
      expect(counts['pending']).toBeGreaterThanOrEqual(1);
      expect(counts['completed']).toBeUndefined();
    });
  });
});
