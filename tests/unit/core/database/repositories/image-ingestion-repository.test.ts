import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { ImageIngestionRepository } from '../../../../../src/core/database/repositories/image-ingestion-repository.js';
import type {
  ImageAdmissionRecordRow,
  ImageIngestionRow,
  InsertTerminalAdmissionInput,
} from '../../../../../src/core/database/repositories/image-ingestion-repository.js';
import { ThreadRepository } from '../../../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { MessageRepository } from '../../../../../src/core/database/repositories/message-repository.js';
import { BaseRepository } from '../../../../../src/core/database/repositories/base-repository.js';
import { createTestDb, uuid } from './helpers.js';

/**
 * Contract under test: the admission side of the image ledger — recovery source
 * references, per-message pending Ingestion, and terminal admission records.
 *
 * These tests exercise a real migrated SQLite database: real UNIQUE, CHECK, and
 * FOREIGN KEY enforcement against `messages`, `threads`, and `queue_items`.
 * Nothing is mocked, because the guarantees under test are storage guarantees:
 *   * redelivery resolves to the same source reference and the same Ingestion row;
 *   * completion is durable and survives deletion of the queue item;
 *   * an intentionally unrouted image message has exactly one terminal record.
 */
describe('ImageIngestionRepository', () => {
  let db: Database.Database;
  let repo: ImageIngestionRepository;
  let threads: ThreadRepository;
  let messages: MessageRepository;
  let threadId: string;
  let otherThreadId: string;
  let messageId: string;

  beforeEach(() => {
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    repo = new ImageIngestionRepository(db);

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
    threads.insert({
      id: threadId,
      channel_id: channelId,
      external_id: `ext-${uuid()}`,
      metadata: '{}',
    });
    otherThreadId = uuid();
    threads.insert({
      id: otherThreadId,
      channel_id: channelId,
      external_id: `ext-${uuid()}`,
      metadata: '{}',
    });

    messages = new MessageRepository(db);
    messageId = insertMessage(threadId);
  });

  afterEach(() => {
    db.close();
  });

  function insertMessage(
    thread: string,
    direction: 'inbound' | 'outbound' = 'inbound',
  ): string {
    const id = uuid();
    const result = messages.insert({
      id,
      thread_id: thread,
      direction,
      content: '{"text":"photo?"}',
      idempotency_key: `idem-${uuid()}`,
      provider_id: null,
      run_id: null,
    });
    if (result.isErr()) {
      throw new Error(`test fixture message insert failed: ${result.error.message}`);
    }
    return id;
  }

  function insertQueueItem(thread: string, message: string): string {
    const id = uuid();
    const ts = Date.now();
    db.prepare(
      `INSERT INTO queue_items (id, thread_id, message_id, type, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, 'message', 'pending', '{}', ?, ?)`,
    ).run(id, thread, message, ts, ts);
    return id;
  }

  function count(table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  }

  describe('resolveSourceMessage', () => {
    it('creates a trusted recovery reference for a first delivery', () => {
      const before = Date.now();
      const result = repo.resolveSourceMessage({
        channel: 'telegram',
        externalMessageId: '42',
        externalChatId: 'chat-1',
      });
      expect(result.isOk()).toBe(true);
      const row = result._unsafeUnwrap();
      expect(row.channel).toBe('telegram');
      expect(row.external_message_id).toBe('42');
      expect(row.external_chat_id).toBe('chat-1');
      expect(row.created_at).toBeGreaterThanOrEqual(before);
      expect(repo.findSourceMessage(row.id)._unsafeUnwrap()).toEqual(row);
    });

    it('re-admits the same external message to the same reference without row explosion', () => {
      const first = repo
        .resolveSourceMessage({
          channel: 'telegram',
          externalMessageId: '42',
          externalChatId: 'chat-1',
        })
        ._unsafeUnwrap();

      // Redelivery (and a caller that guessed a different id) must adopt the
      // existing reference: one ledger lineage per external message per chat.
      const second = repo
        .resolveSourceMessage({
          id: uuid(),
          channel: 'telegram',
          externalMessageId: '42',
          externalChatId: 'chat-1',
        })
        ._unsafeUnwrap();

      expect(second.id).toBe(first.id);
      expect(second.created_at).toBe(first.created_at);
      expect(count('image_source_messages')).toBe(1);
    });

    it('keeps different chats and different channels as separate references', () => {
      const base = { channel: 'telegram', externalMessageId: '42' };
      const a = repo.resolveSourceMessage({ ...base, externalChatId: 'chat-1' })._unsafeUnwrap();
      const b = repo
        .resolveSourceMessage({ ...base, externalChatId: 'chat-2' })
        ._unsafeUnwrap();
      const c = repo
        .resolveSourceMessage({ channel: 'email', externalMessageId: '42', externalChatId: 'chat-1' })
        ._unsafeUnwrap();
      expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    });

    it('blocks a duplicate external identity directly at the UNIQUE index', () => {
      const insert = db.prepare(
        `INSERT INTO image_source_messages (id, channel, external_message_id, external_chat_id, created_at)
         VALUES (?, 'telegram', 'dup', 'chat-9', 1700000000000)`,
      );
      insert.run(uuid());
      expect(() => insert.run(uuid())).toThrow(/UNIQUE/i);
    });

    it('returns null for an unknown source reference', () => {
      expect(repo.findSourceMessage(uuid())._unsafeUnwrap()).toBeNull();
    });
  });

  describe('createPending', () => {
    it('opens pending Ingestion stamped with the admission time', () => {
      const before = Date.now();
      const result = repo.createPending({ messageId, threadId, personaId: 'persona-route-1' });
      expect(result.isOk()).toBe(true);
      const { ingestion, created } = result._unsafeUnwrap();
      expect(created).toBe(true);
      expect(ingestion.status).toBe('pending');
      expect(ingestion.queue_item_id).toBeNull();
      expect(ingestion.completed_at).toBeNull();
      expect(ingestion.admitted_at).toBeGreaterThanOrEqual(before);
      expect(repo.findByMessage(messageId)._unsafeUnwrap()).toEqual(ingestion);
    });

    it('persists the admitted route with the pending row, in the database itself', () => {
      const { ingestion } = repo
        .createPending({ messageId, threadId, personaId: 'persona-route-9' })
        ._unsafeUnwrap();
      expect(ingestion.persona_id).toBe('persona-route-9');
      const raw = db.prepare('SELECT persona_id FROM image_ingestions WHERE message_id = ?').get(messageId) as {
        persona_id: string;
      };
      expect(raw.persona_id).toBe('persona-route-9');
    });

    it('adopts the existing row on repeated recovery without resetting it', () => {
      const first = repo.createPending({ messageId, threadId, personaId: 'persona-route-1' })._unsafeUnwrap();

      const again = repo.createPending({ messageId, threadId, personaId: 'persona-route-1' })._unsafeUnwrap();
      expect(again.created).toBe(false);
      expect(again.ingestion.id).toBe(first.ingestion.id);
      // The admission clock must not move: redelivery cannot reset the budget.
      expect(again.ingestion.admitted_at).toBe(first.ingestion.admitted_at);
      // UNIQUE (message_id): exactly one Ingestion owns this message.
      expect(count('image_ingestions')).toBe(1);
    });

    it('adopts a completed row instead of reopening it', () => {
      repo.createPending({ messageId, threadId, personaId: 'persona-route-1' });
      const queueItemId = insertQueueItem(threadId, messageId);
      repo.markComplete({ messageId, queueItemId });

      const { ingestion, created } = repo.createPending({ messageId, threadId, personaId: 'persona-route-1' })._unsafeUnwrap();
      expect(created).toBe(false);
      expect(ingestion.status).toBe('completed');
    });

    it('blocks a second Ingestion owner for one message directly at the UNIQUE index', () => {
      repo.createPending({ messageId, threadId, personaId: 'persona-route-1' });
      // UNIQUE (message_id) is the storage-level "one owner per message" guard:
      // even a writer that bypasses the repository cannot admit twice.
      expect(() =>
        db
          .prepare(
            `INSERT INTO image_ingestions (id, message_id, thread_id, status, admitted_at)
             VALUES (?, ?, ?, 'pending', 1700000000001)`,
          )
          .run(uuid(), messageId, threadId),
      ).toThrow(/UNIQUE/i);
      expect(count('image_ingestions')).toBe(1);
    });

    it('rejects an unknown message and writes nothing', () => {
      const result = repo.createPending({ messageId: uuid(), threadId, personaId: 'persona-route-1' });
      expect(result.isErr()).toBe(true);
      expect(String(result._unsafeUnwrapErr().message)).toMatch(/unknown message/i);
      expect(count('image_ingestions')).toBe(0);
    });

    it('rejects a cross-owner admission whose thread disagrees with its Message', () => {
      const result = repo.createPending({ messageId, threadId: otherThreadId, personaId: 'persona-route-1' });
      expect(result.isErr()).toBe(true);
      expect(String(result._unsafeUnwrapErr().message)).toMatch(/belongs to thread/i);
      expect(count('image_ingestions')).toBe(0);
    });

    it('rejects an outbound message', () => {
      const outbound = insertMessage(threadId, 'outbound');
      const result = repo.createPending({ messageId: outbound, threadId, personaId: 'persona-route-1' });
      expect(result.isErr()).toBe(true);
      expect(String(result._unsafeUnwrapErr().message)).toMatch(/outbound, not inbound/i);
    });
  });

  describe('markComplete', () => {
    it('completes once with the queue item the Message was admitted as', () => {
      repo.createPending({ messageId, threadId, personaId: 'persona-route-1' });
      const queueItemId = insertQueueItem(threadId, messageId);

      const result = repo.markComplete({ messageId, queueItemId });
      expect(result.isOk()).toBe(true);
      const { ingestion, alreadyCompleted } = result._unsafeUnwrap();
      expect(alreadyCompleted).toBe(false);
      expect(ingestion.status).toBe('completed');
      expect(ingestion.queue_item_id).toBe(queueItemId);
      expect(ingestion.completed_at).not.toBeNull();
      expect(repo.isComplete(messageId)._unsafeUnwrap()).toBe(true);
    });

    it('reports alreadyCompleted and keeps the original queue item on repeats', () => {
      repo.createPending({ messageId, threadId, personaId: 'persona-route-1' });
      const firstItem = insertQueueItem(threadId, messageId);
      repo.markComplete({ messageId, queueItemId: firstItem });

      // Recovery must learn which item was already admitted, never enqueue twice.
      const repeated = repo
        .markComplete({ messageId, queueItemId: insertQueueItem(threadId, messageId) })
        ._unsafeUnwrap();
      expect(repeated.alreadyCompleted).toBe(true);
      expect(repeated.ingestion.queue_item_id).toBe(firstItem);
    });

    it('survives deletion of the queue item and is never inferred from queue existence', () => {
      repo.createPending({ messageId, threadId, personaId: 'persona-route-1' });
      const queueItemId = insertQueueItem(threadId, messageId);
      repo.markComplete({ messageId, queueItemId });

      // Queue retention purges items. There is deliberately no foreign key from
      // image_ingestions to queue_items, so the purge succeeds and the completion
      // record — the proof that the message must not be enqueued again — remains.
      expect(() => db.prepare('DELETE FROM queue_items WHERE id = ?').run(queueItemId)).not.toThrow();
      expect(count('queue_items')).toBe(0);
      expect(repo.isComplete(messageId)._unsafeUnwrap()).toBe(true);

      const stored = repo.findByMessage(messageId)._unsafeUnwrap() as ImageIngestionRow;
      expect(stored.status).toBe('completed');
      expect(stored.queue_item_id).toBe(queueItemId);

      // And the recovery sweep no longer offers this message at all.
      expect(repo.findPending({})._unsafeUnwrap()).toEqual([]);
    });

    it('errs when there is no ledger row, and never fabricates one', () => {
      const result = repo.markComplete({ messageId, queueItemId: uuid() });
      expect(result.isErr()).toBe(true);
      expect(String(result._unsafeUnwrapErr().message)).toMatch(/no ledger row/i);
      expect(count('image_ingestions')).toBe(0);
    });

    it('errs on an empty queue item id', () => {
      repo.createPending({ messageId, threadId, personaId: 'persona-route-1' });
      expect(repo.markComplete({ messageId, queueItemId: '' }).isErr()).toBe(true);
    });

    it('cannot be forced back to pending at the storage level', () => {
      repo.createPending({ messageId, threadId, personaId: 'persona-route-1' });
      repo.markComplete({ messageId, queueItemId: insertQueueItem(threadId, messageId) });
      expect(() =>
        db.prepare(`UPDATE image_ingestions SET status = 'pending' WHERE message_id = ?`).run(messageId),
      ).toThrow(/CHECK/i);
    });
  });

  describe('findPending', () => {
    it('sweeps globally oldest-first and excludes completed work', () => {
      const m1 = insertMessage(threadId);
      const m2 = insertMessage(threadId);
      const m3 = insertMessage(otherThreadId);
      repo.createPending({ messageId: m1, threadId, personaId: 'persona-route-1' });
      repo.createPending({ messageId: m2, threadId, personaId: 'persona-route-1' });
      repo.createPending({ messageId: m3, threadId: otherThreadId, personaId: 'persona-route-1' });
      repo.markComplete({ messageId: m2, queueItemId: insertQueueItem(threadId, m2) });

      const rows = repo.findPending({})._unsafeUnwrap();
      expect(rows.map((r) => r.message_id)).toEqual([m1, m3]);
      expect(rows.every((r) => r.status === 'pending')).toBe(true);
    });

    it('scopes by thread and never shows another thread row', () => {
      const mine = insertMessage(threadId);
      const theirs = insertMessage(otherThreadId);
      repo.createPending({ messageId: mine, threadId, personaId: 'persona-route-1' });
      repo.createPending({ messageId: theirs, threadId: otherThreadId, personaId: 'persona-route-1' });

      expect(repo.findPending({ threadId })._unsafeUnwrap().map((r) => r.message_id)).toEqual([mine]);
      expect(
        repo.findPending({ threadId: otherThreadId })._unsafeUnwrap().map((r) => r.message_id),
      ).toEqual([theirs]);
    });

    it('scopes by message and by both filters together', () => {
      const other = insertMessage(threadId);
      repo.createPending({ messageId, threadId, personaId: 'persona-route-1' });
      repo.createPending({ messageId: other, threadId, personaId: 'persona-route-1' });

      expect(repo.findPending({ messageId })._unsafeUnwrap().map((r) => r.message_id)).toEqual([
        messageId,
      ]);
      // A thread filter that disagrees with the message filter finds nothing.
      expect(repo.findPending({ messageId, threadId: otherThreadId })._unsafeUnwrap()).toEqual([]);
    });

    it('bounds the sweep', () => {
      const ids = [insertMessage(threadId), insertMessage(threadId), insertMessage(threadId)];
      for (const id of ids) {
        repo.createPending({ messageId: id, threadId, personaId: 'persona-route-1' });
      }
      const limited = repo.findPending({ threadId, limit: 2 })._unsafeUnwrap();
      expect(limited).toHaveLength(2);
      expect(limited.map((r) => r.message_id)).toEqual([ids[0], ids[1]]);
    });

    it('rejects invalid limits instead of letting SQLite sweep unbounded', () => {
      // SQLite treats a negative LIMIT as unbounded, so an unchecked -1 would
      // select every pending row and break the documented bounded-sweep guarantee.
      for (let i = 0; i < 3; i += 1) {
        repo.createPending({ messageId: insertMessage(threadId), threadId, personaId: 'persona-route-1' });
      }

      for (const bad of [-1, -100, 0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5]) {
        const result = repo.findPending({ limit: bad });
        expect(result.isErr()).toBe(true);
        expect(String(result._unsafeUnwrapErr().message)).toMatch(/positive integer limit/i);
      }
      // Same invalid values on the unscoped global sweep, the documented
      // startup/periodic recovery entry point.
      expect(repo.findPending({ limit: -1 }).isErr()).toBe(true);

      // A valid bound still caps the unscoped sweep, and the omitted default works.
      expect(repo.findPending({ limit: 2 })._unsafeUnwrap()).toHaveLength(2);
      expect(repo.findPending({})._unsafeUnwrap()).toHaveLength(3);
    });

    it('answers the sweep from the ledger alone, with no messages or queue join', () => {
      // Pending recovery must be independent of message history cutoffs, so the
      // plan may only ever touch the ledger table and its partial index.
      repo.createPending({ messageId, threadId, personaId: 'persona-route-1' });
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT * FROM image_ingestions
           WHERE status = 'pending'
             AND (? IS NULL OR thread_id = ?)
             AND (? IS NULL OR message_id = ?)
           ORDER BY admitted_at ASC, message_id ASC
           LIMIT ?`,
        )
        .all(null, threadId, null, null, 100) as { detail: string }[];
      const details = plan.map((step) => step.detail).join(' ');
      expect(details).toMatch(/image_ingestions/i);
      expect(details).not.toMatch(/messages/i);
      expect(details).not.toMatch(/queue_items/i);

      // And the rows come back regardless of how much newer message history exists.
      for (let i = 0; i < 5; i += 1) {
        insertMessage(threadId);
      }
      expect(repo.findPending({ threadId })._unsafeUnwrap().map((r) => r.message_id)).toEqual([
        messageId,
      ]);
    });
  });

  describe('terminal admission records', () => {
    function makeInput(
      overrides: Partial<InsertTerminalAdmissionInput> = {},
    ): InsertTerminalAdmissionInput {
      return {
        messageId,
        threadId,
        channel: 'telegram',
        reason: 'no_binding',
        ...overrides,
      };
    }

    it('records one terminal outcome for an intentionally unrouted image message', () => {
      const result = repo.insertTerminalAdmission(makeInput());
      expect(result.isOk()).toBe(true);
      const row = result._unsafeUnwrap();
      expect(row).toMatchObject({
        message_id: messageId,
        thread_id: threadId,
        channel: 'telegram',
        reason: 'no_binding',
      });
      expect(row.created_at).toBeGreaterThan(0);
      expect(repo.findAdmissionByMessage(messageId)._unsafeUnwrap()).toEqual(row);
    });

    it('accepts exactly one record per message and rejects a second', () => {
      expect(repo.insertTerminalAdmission(makeInput()).isOk()).toBe(true);
      const second = repo.insertTerminalAdmission(makeInput({ reason: 'policy_denied' }));
      expect(second.isErr()).toBe(true);
      expect(count('image_admission_records')).toBe(1);
      // The terminal record is final on write: the rejected second reason is not stored.
      expect(repo.findAdmissionByMessage(messageId)._unsafeUnwrap()?.reason).toBe('no_binding');
    });

    it('rejects unknown, cross-owner, and outbound messages and writes nothing', () => {
      expect(repo.insertTerminalAdmission(makeInput({ messageId: uuid() })).isErr()).toBe(true);
      expect(repo.insertTerminalAdmission(makeInput({ threadId: otherThreadId })).isErr()).toBe(true);
      const outbound = insertMessage(threadId, 'outbound');
      expect(repo.insertTerminalAdmission(makeInput({ messageId: outbound })).isErr()).toBe(true);
      expect(count('image_admission_records')).toBe(0);
    });

    it('returns null when a message has no admission record', () => {
      expect(repo.findAdmissionByMessage(messageId)._unsafeUnwrap()).toBeNull();
    });

    it('records no Images, Ingestion, or admission for text-only and routed messages', () => {
      // Routing decides the ledger: only the unrouted branch writes admission
      // records. A routed message gets Ingestion and no admission record; a
      // text-only message gets neither.
      repo.createPending({ messageId, threadId, personaId: 'persona-route-1' })._unsafeUnwrap();
      const routed = repo.findByMessage(messageId)._unsafeUnwrap() as ImageIngestionRow;
      expect(routed.status).toBe('pending');
      expect(repo.findAdmissionByMessage(messageId)._unsafeUnwrap()).toBeNull();
    });
  });

  describe('storage invariants (explicit constraint fixtures)', () => {
    it('blocks an admission reason outside the closed vocabulary', () => {
      const insert = db.prepare(
        `INSERT INTO image_admission_records (message_id, thread_id, channel, reason, created_at)
         VALUES (?, ?, 'telegram', ?, 1700000000000)`,
      );
      // The owning message exists, so only the reason CHECK can reject this row.
      expect(() => insert.run(messageId, threadId, 'because_i_said_so')).toThrow(/CHECK/i);
      // Positive control with a real owning message: the vocabulary itself is accepted.
      expect(() => insert.run(insertMessage(threadId), threadId, 'no_binding')).not.toThrow();
    });

    it('blocks a cross-owner admission record via foreign key', () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO image_admission_records (message_id, thread_id, channel, reason, created_at)
             VALUES (?, ?, 'telegram', 'no_binding', 1700000000000)`,
          )
          .run(messageId, uuid()),
      ).toThrow(/FOREIGN KEY/i);
    });

    it('blocks an Ingestion row that leaves completed without a completion time', () => {
      repo.createPending({ messageId, threadId, personaId: 'persona-route-1' });
      expect(() =>
        db.prepare(`UPDATE image_ingestions SET status = 'completed' WHERE message_id = ?`).run(messageId),
      ).toThrow(/CHECK/i);
    });

    it('blocks an Ingestion row for an unknown thread via foreign key', () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO image_ingestions (id, message_id, thread_id, status, admitted_at)
             VALUES (?, ?, ?, 'pending', 1700000000000)`,
          )
          .run(uuid(), messageId, uuid()),
      ).toThrow(/FOREIGN KEY/i);
    });

    it('stores no binary column: the ledger holds text and numbers only', () => {
      for (const table of ['image_ingestions', 'image_source_messages', 'image_admission_records']) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { type: string }[];
        expect(columns.length).toBeGreaterThan(0);
        for (const column of columns) {
          expect(['TEXT', 'INTEGER']).toContain(column.type);
        }
      }
    });
  });

  describe('persistence across repository instances', () => {
    it('recovered processes see the same pending and completed rows', () => {
      const settled = insertMessage(threadId);
      repo.createPending({ messageId, threadId, personaId: 'persona-route-1' });
      repo.createPending({ messageId: settled, threadId, personaId: 'persona-route-1' });
      repo.markComplete({ messageId: settled, queueItemId: insertQueueItem(threadId, settled) });

      const reopened = new ImageIngestionRepository(db);
      expect(reopened.findPending({})._unsafeUnwrap().map((r) => r.message_id)).toEqual([messageId]);
      expect(reopened.isComplete(settled)._unsafeUnwrap()).toBe(true);
      const row = reopened.findByMessage(messageId)._unsafeUnwrap() as ImageIngestionRow;
      expect(row.status).toBe('pending');
    });

    it('keeps terminal admission records readable from a new instance', () => {
      const record: ImageAdmissionRecordRow = repo
        .insertTerminalAdmission({ messageId, threadId, channel: 'email', reason: 'images_disallowed' })
        ._unsafeUnwrap();
      const reopened = new ImageIngestionRepository(db);
      expect(reopened.findAdmissionByMessage(messageId)._unsafeUnwrap()).toEqual(record);
    });
  });
});
