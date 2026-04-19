import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MessageRepository } from '../../../../../src/core/database/repositories/message-repository.js';
import { ThreadRepository } from '../../../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { BaseRepository } from '../../../../../src/core/database/repositories/base-repository.js';
import { createTestDb, uuid } from './helpers.js';

describe('MessageRepository', () => {
  let db: Database.Database;
  let repo: MessageRepository;
  let threadId: string;

  beforeEach(() => {
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    repo = new MessageRepository(db);

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

  function makeMsg(overrides: Partial<Parameters<MessageRepository['insert']>[0]> = {}) {
    return {
      id: uuid(),
      thread_id: threadId,
      direction: 'inbound' as const,
      content: '{"text":"hello"}',
      idempotency_key: `idem-${uuid()}`,
      provider_id: null,
      run_id: null,
      ...overrides,
    };
  }

  describe('insert', () => {
    it('inserts and returns the message', () => {
      const input = makeMsg();
      const result = repo.insert(input);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().id).toBe(input.id);
    });

    it('is idempotent: re-inserting same idempotency_key returns existing row', () => {
      const key = `idem-${uuid()}`;
      const first = repo.insert(makeMsg({ idempotency_key: key }));
      const second = repo.insert(makeMsg({ idempotency_key: key }));
      expect(second.isOk()).toBe(true);
      expect(second._unsafeUnwrap().id).toBe(first._unsafeUnwrap().id);
    });

    it('returns err for non-existent thread_id (FK)', () => {
      expect(repo.insert(makeMsg({ thread_id: uuid() })).isErr()).toBe(true);
    });
  });

  describe('findById', () => {
    it('finds by primary key', () => {
      const input = makeMsg();
      repo.insert(input);
      expect(repo.findById(input.id)._unsafeUnwrap()?.id).toBe(input.id);
    });

    it('returns null for unknown id', () => {
      expect(repo.findById(uuid())._unsafeUnwrap()).toBeNull();
    });
  });

  describe('findByThread', () => {
    it('returns messages in chronological order', () => {
      // Insert three messages and verify ordering.
      const m1 = makeMsg({ idempotency_key: `k1-${uuid()}` });
      const m2 = makeMsg({ idempotency_key: `k2-${uuid()}` });
      const m3 = makeMsg({ idempotency_key: `k3-${uuid()}` });
      repo.insert(m1);
      repo.insert(m2);
      repo.insert(m3);

      const rows = repo.findByThread(threadId, 10, 0)._unsafeUnwrap();
      expect(rows).toHaveLength(3);
      // created_at values should be non-decreasing.
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].created_at).toBeGreaterThanOrEqual(rows[i - 1].created_at);
      }
    });

    it('respects limit and offset', () => {
      for (let i = 0; i < 5; i++) {
        repo.insert(makeMsg({ idempotency_key: `k${i}-${uuid()}` }));
      }
      const page1 = repo.findByThread(threadId, 2, 0)._unsafeUnwrap();
      const page2 = repo.findByThread(threadId, 2, 2)._unsafeUnwrap();
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0].id).not.toBe(page2[0].id);
    });

    it('returns empty array for unknown thread', () => {
      expect(repo.findByThread(uuid(), 10, 0)._unsafeUnwrap()).toHaveLength(0);
    });
  });

  describe('findLatestByThread', () => {
    it('returns the most recent N messages in chronological order', () => {
      for (let i = 0; i < 5; i++) {
        repo.insert(makeMsg({ id: `msg-${i}`, idempotency_key: `k-latest-${i}-${uuid()}` }));
      }

      const result = repo.findLatestByThread(threadId, 3);
      expect(result.isOk()).toBe(true);
      const rows = result._unsafeUnwrap();
      expect(rows).toHaveLength(3);
      // Should be the last 3 in chronological (ASC) order
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].created_at).toBeGreaterThanOrEqual(rows[i - 1].created_at);
      }
    });

    it('returns all messages when fewer than limit exist', () => {
      repo.insert(makeMsg());

      const result = repo.findLatestByThread(threadId, 10);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toHaveLength(1);
    });

    it('returns empty array for unknown thread', () => {
      const result = repo.findLatestByThread('nonexistent', 5);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toHaveLength(0);
    });
  });

  describe('findLatestByThreadSince', () => {
    it('returns only messages created strictly after the given timestamp', () => {
      // Insert messages and capture created_at values. The repository uses
      // its own clock, so we read the persisted rows to find a real boundary.
      // To guarantee timestamp progression even when Date.now() resolution
      // coincides with the insertion rate, we use a synthetic clock override.
      const clock = vi.spyOn(Date, 'now');
      let tick = 1_700_000_000_000;
      clock.mockImplementation(() => ++tick);

      try {
        for (let i = 0; i < 5; i++) {
          repo.insert(makeMsg({ id: `msg-since-${i}`, idempotency_key: `k-since-${i}-${uuid()}` }));
        }
        const all = repo.findLatestByThread(threadId, 100)._unsafeUnwrap();
        expect(all).toHaveLength(5);
        // All timestamps are distinct thanks to the clock override.
        const timestamps = all.map((m) => m.created_at);
        expect(new Set(timestamps).size).toBe(5);

        // Pick the middle message's created_at as the boundary.
        const boundary = all[2].created_at;

        const result = repo.findLatestByThreadSince(threadId, boundary, 100);
        expect(result.isOk()).toBe(true);
        const rows = result._unsafeUnwrap();
        // Strictly greater than boundary — excludes boundary row itself.
        // Boundary is the 3rd of 5, so 2 rows must remain.
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.created_at).toBeGreaterThan(boundary);
        }
      } finally {
        clock.mockRestore();
      }
    });

    it('issues strictly-greater timestamps than DB max after seedMonotonicClockFromDb', () => {
      // Simulate a prior process that persisted a row with a drift-inflated
      // timestamp (well above current wall). A new process calling
      // seedMonotonicClockFromDb must resume issuance strictly above that.
      const futureTs = Date.now() + 60_000;
      // Insert a memory_items row with a synthetic future created_at so
      // the seeder picks it up. (messages table would work too, but
      // memory_items is also covered by the seed query.)
      db.prepare(
        `INSERT INTO memory_items (id, thread_id, type, content, embedding_ref, metadata, created_at, updated_at)
         VALUES (?, ?, 'note', 'seed-marker', NULL, '{}', ?, ?)`,
      ).run(uuid(), threadId, futureTs, futureTs);

      BaseRepository.__resetMonotonicClockForTests();
      BaseRepository.seedMonotonicClockFromDb(db);

      // Next insert gets a timestamp > futureTs even though wall clock < futureTs.
      const inserted = repo.insert(makeMsg({ id: 'after-seed', idempotency_key: `k-seed-${uuid()}` }));
      expect(inserted.isOk()).toBe(true);
      expect(inserted._unsafeUnwrap().created_at).toBeGreaterThan(futureTs);
    });

    it('never issues duplicate timestamps even when wall clock is frozen', () => {
      // BaseRepository.now() is strictly monotonic, so even if Date.now()
      // is pinned to a single value (e.g. two inserts within the same ms
      // under burst load) the persisted created_at values still progress.
      // This is what keeps the rotation-boundary > comparison safe.
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      try {
        for (let i = 0; i < 3; i++) {
          repo.insert(makeMsg({ id: `msg-mono-${i}`, idempotency_key: `k-mono-${i}-${uuid()}` }));
        }
        const all = repo.findLatestByThread(threadId, 100)._unsafeUnwrap();
        expect(all).toHaveLength(3);
        const timestamps = all.map((m) => m.created_at);
        expect(new Set(timestamps).size).toBe(3);
        // Timestamps are strictly increasing in insertion order.
        for (let i = 1; i < timestamps.length; i++) {
          expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]);
        }
      } finally {
        clock.mockRestore();
      }
    });

    it('caps result at the given limit', () => {
      for (let i = 0; i < 5; i++) {
        repo.insert(makeMsg({ id: `msg-cap-${i}`, idempotency_key: `k-cap-${i}-${uuid()}` }));
      }
      const result = repo.findLatestByThreadSince(threadId, 0, 2);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toHaveLength(2);
    });

    it('returns empty array when no messages exist after boundary', () => {
      repo.insert(makeMsg());
      const all = repo.findLatestByThread(threadId, 100)._unsafeUnwrap();
      const boundary = all[0].created_at;
      const result = repo.findLatestByThreadSince(threadId, boundary, 10);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toHaveLength(0);
    });
  });

  describe('existsByIdempotencyKey', () => {
    it('returns true when key exists', () => {
      const key = `idem-${uuid()}`;
      repo.insert(makeMsg({ idempotency_key: key }));
      expect(repo.existsByIdempotencyKey(key)).toBe(true);
    });

    it('returns false when key does not exist', () => {
      expect(repo.existsByIdempotencyKey('nonexistent')).toBe(false);
    });
  });
});
