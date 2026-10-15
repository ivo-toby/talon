import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { ImageRepository } from '../../../../../src/core/database/repositories/image-repository.js';
import type { ImageRow, InsertImageInput } from '../../../../../src/core/database/repositories/image-repository.js';
import { ThreadRepository } from '../../../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { MessageRepository } from '../../../../../src/core/database/repositories/message-repository.js';
import { BaseRepository } from '../../../../../src/core/database/repositories/base-repository.js';
import { createTestDb, uuid } from './helpers.js';

/**
 * Contract under test: the durable Image ledger.
 *
 * These tests exercise a real migrated SQLite database — real UNIQUE, CHECK and
 * FOREIGN KEY enforcement, real rollback — because the ledger's guarantees are
 * storage guarantees. Inserts are never mocked.
 */
describe('ImageRepository', () => {
  let db: Database.Database;
  let repo: ImageRepository;
  let threads: ThreadRepository;
  let messages: MessageRepository;
  let threadId: string;
  let otherThreadId: string;
  let sourceRef: string;
  let otherSourceRef: string;
  let messageId: string;

  beforeEach(() => {
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    repo = new ImageRepository(db);

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

    threads = new ThreadRepository(db);
    threadId = uuid();
    threads.insert({ id: threadId, channel_id: channelId, external_id: `ext-${uuid()}`, metadata: '{}' });
    otherThreadId = uuid();
    threads.insert({
      id: otherThreadId,
      channel_id: channelId,
      external_id: `ext-${uuid()}`,
      metadata: '{}',
    });

    messages = new MessageRepository(db);
    messageId = uuid();
    messages.insert({
      id: messageId,
      thread_id: threadId,
      direction: 'inbound',
      content: '{"text":"look"}',
      idempotency_key: `idem-${uuid()}`,
      provider_id: null,
      run_id: null,
    });

    sourceRef = insertSource('42');
    otherSourceRef = insertSource('43');
  });

  afterEach(() => {
    db.close();
  });

  function insertSource(externalMessageId: string): string {
    const id = uuid();
    db.prepare(
      'INSERT INTO image_source_messages (id, channel, external_message_id, external_chat_id, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, 'telegram', externalMessageId, 'chat-1', 1_700_000_000_000);
    return id;
  }

  function makeMessage(thread: string, direction: 'inbound' | 'outbound' = 'inbound'): string {
    const id = uuid();
    messages.insert({
      id,
      thread_id: thread,
      direction,
      content: '{"text":"x"}',
      idempotency_key: `idem-${uuid()}`,
      provider_id: null,
      run_id: null,
    });
    return id;
  }

  function makeInput(overrides: Partial<InsertImageInput> = {}): InsertImageInput {
    return {
      id: uuid(),
      messageId,
      ordinal: 0,
      threadId,
      sourceRef,
      expiresAt: 1_700_003_600_000,
      processingDeadlineAt: 1_700_000_060_000,
      ...overrides,
    };
  }

  function insertRaw(sqlOverrides: Record<string, unknown> = {}): void {
    const cols = {
      id: uuid(),
      message_id: messageId,
      ordinal: 7,
      thread_id: threadId,
      source_ref: sourceRef,
      state: 'processing',
      rejection_reason: null,
      unavailability_reason: null,
      expires_at: 1_700_003_600_000,
      processing_deadline_at: 1_700_000_060_000,
      received_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      ...sqlOverrides,
    };
    db.prepare(
      `INSERT INTO images (id, message_id, ordinal, thread_id, source_ref, state,
         rejection_reason, unavailability_reason, expires_at, processing_deadline_at,
         received_at, updated_at)
       VALUES (@id, @message_id, @ordinal, @thread_id, @source_ref, @state,
         @rejection_reason, @unavailability_reason, @expires_at, @processing_deadline_at,
         @received_at, @updated_at)`,
    ).run(cols);
  }

  describe('insert', () => {
    it('creates a Processing Image stamped with the local Admission receipt', () => {
      const before = Date.now();
      const result = repo.insert(makeInput({ filename: 'photo.jpg', mimeType: 'image/jpeg' }));

      expect(result.isOk()).toBe(true);
      const row = result._unsafeUnwrap();
      expect(row.state).toBe('processing');
      expect(row.rejection_reason).toBeNull();
      expect(row.unavailability_reason).toBeNull();
      expect(row.attempt_count).toBe(0);
      // The receipt is the local clock at durable Admission, not a caller value:
      // it never lands before the call started.
      expect(row.received_at).toBeGreaterThanOrEqual(before);
      // BaseRepository.now() is strictly monotonic and may run a handful of
      // milliseconds ahead of wall clock when several rows share a millisecond
      // (see BaseRepository), so containment in [before, after] is unsound.
      // The drift is bounded, and a 10 s bound is far below any retention period
      // while still proving the stamp is "now" and not a caller value.
      expect(row.received_at).toBeLessThan(before + 10_000);
      expect(row.expires_at).toBe(1_700_003_600_000);
      expect(row.processing_deadline_at).toBe(1_700_000_060_000);
      expect(row.filename).toBe('photo.jpg');
      expect(repo.findById(row.id)._unsafeUnwrap()).toEqual(row);
    });

    it('creates a Rejected Image when selection already decided the outcome', () => {
      const row = repo
        .insert(makeInput({ state: 'rejected', rejectionReason: 'size_limit' }))
        ._unsafeUnwrap();
      expect(row.state).toBe('rejected');
      expect(row.rejection_reason).toBe('size_limit');
    });

    it('rejects a duplicate (message_id, ordinal) with the real UNIQUE constraint', () => {
      expect(repo.insert(makeInput({ ordinal: 2 })).isOk()).toBe(true);

      const duplicate = repo.insert(makeInput({ id: uuid(), ordinal: 2 }));
      expect(duplicate.isErr()).toBe(true);
      expect(String(duplicate._unsafeUnwrapErr().message)).toMatch(/UNIQUE/i);
      // Only the one accepted row exists for that slot.
      expect(repo.findByMessage(messageId)._unsafeUnwrap()).toHaveLength(1);
    });

    it('allows the same ordinal on a different message', () => {
      const second = makeMessage(threadId);
      expect(repo.insert(makeInput({ ordinal: 0 })).isOk()).toBe(true);
      expect(repo.insert(makeInput({ messageId: second, ordinal: 0 })).isOk()).toBe(true);
    });

    it('rejects a duplicate globally unique Image id (PRIMARY KEY)', () => {
      const id = uuid();
      expect(repo.insert(makeInput({ id, ordinal: 0 })).isOk()).toBe(true);
      const other = makeMessage(threadId);
      const dup = repo.insert(makeInput({ id, messageId: other, ordinal: 1 }));
      expect(dup.isErr()).toBe(true);
      expect(String(dup._unsafeUnwrapErr().message)).toMatch(/PRIMARY KEY|UNIQUE/i);
    });

    it('rejects an unknown owning message and writes nothing', () => {
      const result = repo.insert(makeInput({ messageId: uuid() }));
      expect(result.isErr()).toBe(true);
      expect(String(result._unsafeUnwrapErr().message)).toMatch(/unknown message/i);
      expect(db.prepare('SELECT COUNT(*) AS c FROM images').get()).toEqual({ c: 0 });
    });

    it('rejects a cross-owner Image whose thread disagrees with its Message', () => {
      const result = repo.insert(makeInput({ threadId: otherThreadId }));
      expect(result.isErr()).toBe(true);
      expect(String(result._unsafeUnwrapErr().message)).toMatch(/belongs to thread/i);
      expect(db.prepare('SELECT COUNT(*) AS c FROM images').get()).toEqual({ c: 0 });
    });

    it('rejects an Image attached to an outbound message', () => {
      const outbound = makeMessage(threadId, 'outbound');
      const result = repo.insert(makeInput({ messageId: outbound }));
      expect(result.isErr()).toBe(true);
      expect(String(result._unsafeUnwrapErr().message)).toMatch(/outbound, not inbound/i);
    });

    it('rejects an unknown source reference and writes nothing', () => {
      const result = repo.insert(makeInput({ sourceRef: uuid() }));
      expect(result.isErr()).toBe(true);
      expect(String(result._unsafeUnwrapErr().message)).toMatch(/unknown source_ref/i);
      expect(db.prepare('SELECT COUNT(*) AS c FROM images').get()).toEqual({ c: 0 });
    });

    it('rejects a negative ordinal with the CHECK constraint', () => {
      const result = repo.insert(makeInput({ ordinal: -1 }));
      expect(result.isErr()).toBe(true);
      expect(String(result._unsafeUnwrapErr().message)).toMatch(/CHECK/i);
    });

    it('rejects a reason/state mismatch in both directions', () => {
      const missing = repo.insert(makeInput({ state: 'rejected' }));
      expect(missing.isErr()).toBe(true);
      expect(String(missing._unsafeUnwrapErr().message)).toMatch(/requires one reason/i);

      const extra = repo.insert(
        makeInput({ rejectionReason: 'size_limit' as InsertImageInput['rejectionReason'] }),
      );
      expect(extra.isErr()).toBe(true);
      expect(String(extra._unsafeUnwrapErr().message)).toMatch(/must not carry a rejection reason/i);
    });

    it('stores no binary column: the ledger holds text and numbers only', () => {
      const columns = db.prepare(`PRAGMA table_info(images)`).all() as { type: string }[];
      expect(columns.length).toBeGreaterThan(0);
      for (const column of columns) {
        expect(['TEXT', 'INTEGER']).toContain(column.type);
      }
    });
  });

  describe('storage invariants (explicit constraint fixtures)', () => {
    it('blocks a rejection reason outside the closed vocabulary', () => {
      // state is 'rejected' so the state/reason pairing CHECK is satisfied and
      // only the closed-vocabulary CHECK on rejection_reason can reject this row.
      expect(() =>
        insertRaw({ state: 'rejected', rejection_reason: 'my_mind_blew' }),
      ).toThrow(/CHECK/i);
      try {
        insertRaw({ state: 'rejected', rejection_reason: 'my_mind_blew' });
      } catch (cause) {
        expect(String(cause)).toMatch(/CHECK/i);
      }
      // Positive control: the same shape with an in-vocabulary reason passes
      // both CHECKs, so the rejection above is the vocabulary, not the pairing.
      expect(() =>
        insertRaw({ state: 'rejected', rejection_reason: 'size_limit' }),
      ).not.toThrow();
    });

    it('blocks a rejected row with no reason, and an available row carrying one', () => {
      expect(() => insertRaw({ state: 'rejected', rejection_reason: null })).toThrow(/CHECK/i);
      expect(() =>
        insertRaw({ state: 'available', rejection_reason: 'size_limit', ordinal: 8 }),
      ).toThrow(/CHECK/i);
      expect(() =>
        insertRaw({ state: 'unavailable', unavailability_reason: 'gone_mining', ordinal: 9 }),
      ).toThrow(/CHECK/i);
    });

    it('rejects an Image row pointing at another thread via foreign key', () => {
      expect(() => insertRaw({ thread_id: uuid() })).toThrow(/FOREIGN KEY/i);
      expect(() => insertRaw({ source_ref: uuid() })).toThrow(/FOREIGN KEY/i);
    });
  });

  describe('insertMany', () => {
    it('inserts the ordered Images of one message', () => {
      const rows = repo
        .insertMany([
          makeInput({ ordinal: 0 }),
          makeInput({ ordinal: 1, state: 'rejected', rejectionReason: 'animated' }),
          makeInput({ ordinal: 2, mimeType: 'image/jpeg' }),
        ])
        ._unsafeUnwrap();

      expect(rows.map((r) => r.ordinal)).toEqual([0, 1, 2]);
      expect(repo.findByMessage(messageId)._unsafeUnwrap().map((r) => r.state)).toEqual([
        'processing',
        'rejected',
        'processing',
      ]);
    });

    it('rolls the whole set back when a later row collides', () => {
      const result = repo.insertMany([
        makeInput({ ordinal: 0 }),
        makeInput({ ordinal: 1 }),
        makeInput({ id: uuid(), ordinal: 1 }),
      ]);

      expect(result.isErr()).toBe(true);
      // Rollback is the point: a partially admitted message must never be observable.
      expect(db.prepare('SELECT COUNT(*) AS c FROM images').get()).toEqual({ c: 0 });
    });
  });

  describe('lookups', () => {
    beforeEach(() => {
      // Two messages, three Images here, one Image in another thread.
      repo.insert(makeInput({ id: 'img-a', ordinal: 0 }));
      repo.insert(makeInput({ id: 'img-b', ordinal: 1, state: 'rejected', rejectionReason: 'size_limit' }));
      const second = makeMessage(threadId);
      repo.insert(makeInput({ id: 'img-c', messageId: second, ordinal: 0 }));
      repo.insert(makeInput({ id: 'img-other', messageId: makeMessage(otherThreadId), threadId: otherThreadId }));
    });

    it('finds by globally unique id and returns null when unknown', () => {
      expect(repo.findById('img-a')._unsafeUnwrap()?.id).toBe('img-a');
      expect(repo.findById('nope')._unsafeUnwrap()).toBeNull();
    });

    it('returns a message Images in source order', () => {
      expect(repo.findByMessage(messageId)._unsafeUnwrap().map((r) => r.id)).toEqual([
        'img-a',
        'img-b',
      ]);
    });

    it('scopes a thread query to that thread only', () => {
      const rows = repo.findByThread(threadId)._unsafeUnwrap();
      expect(rows.map((r) => r.id)).not.toContain('img-other');
      expect(rows).toHaveLength(3);
    });

    it('sorts newest receipt first, then id ascending', () => {
      // The monotonic clock guarantees strictly increasing receipts, so insertion
      // order reverses: img-c was admitted last, img-a first.
      expect(repo.findByThread(threadId)._unsafeUnwrap().map((r) => r.id)).toEqual([
        'img-c',
        'img-b',
        'img-a',
      ]);
    });

    it('includes terminal Images unless the query narrows states', () => {
      const all = repo.findByThread(threadId)._unsafeUnwrap();
      expect(all.map((r) => r.state)).toContain('rejected');

      const terminal = repo
        .findByThread(threadId, { states: ['rejected', 'unavailable'] })
        ._unsafeUnwrap();
      expect(terminal.map((r) => r.id)).toEqual(['img-b']);

      const live = repo.findByThread(threadId, { states: ['processing'] })._unsafeUnwrap();
      expect(live.map((r) => r.id)).toEqual(['img-c', 'img-a']);
    });

    it('bounds the thread query', () => {
      expect(repo.findByThread(threadId, { limit: 2 })._unsafeUnwrap()).toHaveLength(2);
    });

    it('finds Processing Images oldest-first for recovery, excluding terminal ones', () => {
      const rows = repo.findProcessingByThread(threadId)._unsafeUnwrap();
      expect(rows.map((r) => r.id)).toEqual(['img-a', 'img-c']);
      expect(repo.findProcessingByThread(threadId, { limit: 1 })._unsafeUnwrap().map((r) => r.id)).toEqual([
        'img-a',
      ]);
    });
  });

  describe('findExpirable', () => {
    it('selects non-terminal Images at or past expiry, in expiry order', () => {
      repo.insert(makeInput({ id: 'exp-now', expiresAt: 1_700_001_000_000 }));
      repo.insert(makeInput({ id: 'exp-past', ordinal: 1, expiresAt: 1_700_000_500_000 }));
      repo.insert(makeInput({ id: 'exp-later', ordinal: 2, expiresAt: 1_700_002_000_000 }));
      repo.insert(
        makeInput({ id: 'exp-dead', ordinal: 3, expiresAt: 1_700_000_400_000, state: 'rejected', rejectionReason: 'animated' }),
      );

      const rows = repo.findExpirable({ now: 1_700_001_000_000 })._unsafeUnwrap();
      // Inclusive boundary: expires_at === now is already expired. Terminal rows and
      // future expiries are excluded.
      expect(rows.map((r) => r.id)).toEqual(['exp-past', 'exp-now']);
      expect(repo.findExpirable({ now: 1_700_001_000_000, limit: 1 })._unsafeUnwrap().map((r) => r.id)).toEqual([
        'exp-past',
      ]);
    });
  });

  describe('incrementAttempts', () => {
    it('persists one real attempt at a time', () => {
      const row = repo.insert(makeInput())._unsafeUnwrap();
      expect(repo.incrementAttempts(row.id)._unsafeUnwrap()).toBe(1);
      expect(repo.incrementAttempts(row.id)._unsafeUnwrap()).toBe(2);
      expect(repo.findById(row.id)._unsafeUnwrap()?.attempt_count).toBe(2);
    });

    it('leaves the receipt, expiry, and processing deadline untouched', () => {
      const row = repo.insert(makeInput())._unsafeUnwrap();
      repo.incrementAttempts(row.id);
      const after = repo.findById(row.id)._unsafeUnwrap() as ImageRow;
      expect(after.received_at).toBe(row.received_at);
      expect(after.expires_at).toBe(row.expires_at);
      expect(after.processing_deadline_at).toBe(row.processing_deadline_at);
      expect(after.state).toBe('processing');
    });

    it('errs for an unknown Image', () => {
      expect(repo.incrementAttempts(uuid()).isErr()).toBe(true);
    });

    it('errs and changes nothing for a terminal Image', () => {
      const row = repo.insert(makeInput())._unsafeUnwrap();
      repo.markAvailable(row.id, { mimeType: 'image/jpeg', width: 800, height: 600 });
      const result = repo.incrementAttempts(row.id);
      expect(result.isErr()).toBe(true);
      expect(repo.findById(row.id)._unsafeUnwrap()?.attempt_count).toBe(0);
    });
  });

  describe('state transitions', () => {
    it('moves Processing to Available with the normalization result', () => {
      const row = repo.insert(makeInput())._unsafeUnwrap();
      const available = repo
        .markAvailable(row.id, {
          mimeType: 'image/jpeg',
          width: 1600,
          height: 1200,
          exif: '{"gps":{"latitude":52.5,"longitude":13.4}}',
        })
        ._unsafeUnwrap();

      expect(available.state).toBe('available');
      expect(available.mime_type).toBe('image/jpeg');
      expect(available.width).toBe(1600);
      expect(available.height).toBe(1200);
      expect(available.exif).toContain('52.5');
      // Availability never rewrites the budget the Image was admitted with.
      expect(available.received_at).toBe(row.received_at);
      expect(available.expires_at).toBe(row.expires_at);
      expect(available.processing_deadline_at).toBe(row.processing_deadline_at);
    });

    it('keeps unknown metadata unknown instead of inventing it', () => {
      const row = repo.insert(makeInput())._unsafeUnwrap();
      const available = repo.markAvailable(row.id)._unsafeUnwrap();
      expect(available.state).toBe('available');
      expect(available.mime_type).toBeNull();
      expect(available.width).toBeNull();
      expect(available.exif).toBeNull();
    });

    it('rejects with exactly one reason', () => {
      const row = repo.insert(makeInput())._unsafeUnwrap();
      const rejected = repo.reject(row.id, 'processing_interrupted')._unsafeUnwrap();
      expect(rejected.state).toBe('rejected');
      expect(rejected.rejection_reason).toBe('processing_interrupted');
      expect(rejected.unavailability_reason).toBeNull();
    });

    it('makes an Available Image unavailable with exactly one reason', () => {
      const row = repo.insert(makeInput())._unsafeUnwrap();
      repo.markAvailable(row.id, { mimeType: 'image/jpeg' });
      const gone = repo.markUnavailable(row.id, 'file_missing')._unsafeUnwrap();
      expect(gone.state).toBe('unavailable');
      expect(gone.unavailability_reason).toBe('file_missing');
      expect(gone.rejection_reason).toBeNull();
    });

    it('treats terminal states as final so late results cannot overwrite them', () => {
      const row = repo.insert(makeInput())._unsafeUnwrap();
      repo.reject(row.id, 'conversion_failed');

      const late = repo.markAvailable(row.id, { mimeType: 'image/jpeg' });
      expect(late.isErr()).toBe(true);
      expect(String(late._unsafeUnwrapErr().message)).toMatch(/is rejected, not processing/i);

      const lateReject = repo.reject(row.id, 'processing_failed');
      expect(lateReject.isErr()).toBe(true);

      const lateUnavailable = repo.markUnavailable(row.id, 'expired');
      expect(lateUnavailable.isErr()).toBe(true);
      const still = repo.findById(row.id)._unsafeUnwrap() as ImageRow;
      expect(still.state).toBe('rejected');
      expect(still.rejection_reason).toBe('conversion_failed');
    });

    it('retains the first recorded unavailability reason', () => {
      const row = repo.insert(makeInput())._unsafeUnwrap();
      repo.markAvailable(row.id);
      repo.markUnavailable(row.id, 'file_missing');

      // A later expiry sweep must not replace the reason already on record.
      const expiry = repo.markUnavailable(row.id, 'expired');
      expect(expiry.isErr()).toBe(true);
      expect(String(expiry._unsafeUnwrapErr().message)).toMatch(/already records file_missing/i);
      expect(repo.findById(row.id)._unsafeUnwrap()?.unavailability_reason).toBe('file_missing');
    });

    it('errs for an unknown Image on every transition', () => {
      const missing = uuid();
      expect(repo.markAvailable(missing).isErr()).toBe(true);
      expect(repo.reject(missing, 'size_limit').isErr()).toBe(true);
      expect(repo.markUnavailable(missing, 'expired').isErr()).toBe(true);
    });

    it('persists transitions across a new repository instance on the same database', () => {
      const row = repo.insert(makeInput())._unsafeUnwrap();
      repo.markUnavailable(row.id, 'expired');
      const reopened = new ImageRepository(db);
      const stored = reopened.findById(row.id)._unsafeUnwrap() as ImageRow;
      expect(stored.state).toBe('unavailable');
      expect(stored.unavailability_reason).toBe('expired');
    });
  });
});
