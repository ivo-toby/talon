/**
 * Repository for the `messages` table.
 *
 * Uses INSERT OR IGNORE to silently deduplicate messages with the same
 * idempotency_key (unique index on the column), making ingestion idempotent.
 * Callers should scope the key by channel to preserve per-channel semantics.
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';

/** Row shape matching the `messages` table exactly. */
export interface MessageRow {
  id: string;
  thread_id: string;
  direction: 'inbound' | 'outbound';
  content: string;
  idempotency_key: string;
  provider_id: string | null;
  run_id: string | null;
  created_at: number;
}

/** Fields accepted when inserting a new message. `created_at` is set automatically. */
export type InsertMessageInput = Omit<MessageRow, 'created_at'>;

/**
 * An outbound message persisted to a thread by a run on another thread (or by
 * a background task, whose ID has no `runs` row), with the context needed to
 * render it to the recipient thread's resumed session.
 */
export interface CrossThreadOutboundRow extends MessageRow {
  /** Thread of the run that sent it; null when the sender has no `runs` row. */
  source_thread_id: string | null;
  /** External ID of that thread (`schedule:…` for a dedicated schedule thread). */
  source_thread_external_id: string | null;
  /** Queue item type of the sending run (`schedule`, `message`, …), when still known. */
  source_queue_type: string | null;
  /** Latest provider message ID recorded for it in the ledger, if any. */
  external_message_id: string | null;
}

/** Result of {@link MessageRepository.findCrossThreadOutbound}. */
export interface CrossThreadOutboundPage {
  /** Total number of matching messages in the window. */
  total: number;
  /** The newest `limit` matches, in chronological order. */
  messages: CrossThreadOutboundRow[];
}

/** Repository for reading and writing message records. */
export class MessageRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly findByThreadStmt: Database.Statement;
  private readonly findLatestByThreadStmt: Database.Statement;
  private readonly findLatestByThreadSinceStmt: Database.Statement;
  private readonly findLatestByThreadPageStmt: Database.Statement;
  private readonly findLatestByThreadSincePageStmt: Database.Statement;
  private readonly findByIdempotencyKeyStmt: Database.Statement;
  private readonly updateVoiceTranscriptStmt: Database.Statement;
  private crossThreadOutboundStmts?: { count: Database.Statement; page: Database.Statement };

  constructor(db: Database.Database) {
    super(db);

    // INSERT OR IGNORE: if idempotency_key already exists the statement is a
    // no-op — the existing row is preserved and no error is raised.
    this.insertStmt = db.prepare(`
      INSERT OR IGNORE INTO messages
        (id, thread_id, direction, content, idempotency_key, provider_id, run_id, created_at)
      VALUES
        (@id, @thread_id, @direction, @content, @idempotency_key, @provider_id, @run_id, @created_at)
    `);

    this.findByIdStmt = db.prepare(`SELECT * FROM messages WHERE id = ?`);

    this.findByThreadStmt = db.prepare(`
      SELECT * FROM messages
      WHERE thread_id = ?
      ORDER BY created_at ASC
      LIMIT ? OFFSET ?
    `);

    this.findLatestByThreadStmt = db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages
        WHERE thread_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) sub ORDER BY created_at ASC, id ASC
    `);

    this.findLatestByThreadSinceStmt = db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages
        WHERE thread_id = ? AND created_at > ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) sub ORDER BY created_at ASC, id ASC
    `);

    this.findLatestByThreadPageStmt = db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages
        WHERE thread_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      ) sub ORDER BY created_at ASC, id ASC
    `);

    this.findLatestByThreadSincePageStmt = db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages
        WHERE thread_id = ? AND created_at > ?
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      ) sub ORDER BY created_at ASC, id ASC
    `);

    this.findByIdempotencyKeyStmt = db.prepare(`
      SELECT * FROM messages WHERE idempotency_key = ?
    `);

    this.updateVoiceTranscriptStmt = db.prepare(`
      UPDATE messages
      SET content = @content, provider_id = @provider_id, run_id = @run_id
      WHERE idempotency_key = @idempotency_key
        AND thread_id = @thread_id
        AND direction = @direction
    `);
  }

  /**
   * Inserts a new message with idempotent deduplication.
   *
   * If a message with the same idempotency_key already exists the operation
   * succeeds but returns the existing row unchanged.
   */
  insert(input: InsertMessageInput): Result<MessageRow, DbError> {
    try {
      const row: MessageRow = { ...input, created_at: this.now() };
      this.insertStmt.run(row);
      // Re-fetch so we always return the authoritative persisted row.
      const persisted = this.findByIdempotencyKeyStmt.get(input.idempotency_key) as MessageRow;
      return ok(persisted);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to insert message: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Inserts or corrects a voice transcript row. A correction uses the same
   * idempotency key, so UPDATE preserves the original row identity and order.
   */
  upsertVoiceTranscript(input: InsertMessageInput): Result<MessageRow, DbError> {
    try {
      const existing = this.findByIdempotencyKeyStmt.get(input.idempotency_key) as
        | MessageRow
        | undefined;
      if (existing) {
        if (existing.thread_id !== input.thread_id || existing.direction !== input.direction) {
          return err(new DbError('Voice transcript idempotency key belongs to another message'));
        }
        this.updateVoiceTranscriptStmt.run(input);
        const persisted = this.findByIdempotencyKeyStmt.get(input.idempotency_key) as MessageRow;
        return ok(persisted);
      }

      const row: MessageRow = { ...input, created_at: this.now() };
      this.insertStmt.run(row);
      const persisted = this.findByIdempotencyKeyStmt.get(input.idempotency_key) as MessageRow;
      return ok(persisted);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to upsert voice transcript: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /** Finds a message by its primary key. */
  findById(id: string): Result<MessageRow | null, DbError> {
    try {
      const row = this.findByIdStmt.get(id) as MessageRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find message by id: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Returns messages for a thread in ascending chronological order.
   *
   * @param threadId - Thread primary key.
   * @param limit    - Maximum number of rows to return.
   * @param offset   - Number of rows to skip (for pagination).
   */
  findByThread(threadId: string, limit: number, offset: number): Result<MessageRow[], DbError> {
    try {
      const rows = this.findByThreadStmt.all(threadId, limit, offset) as MessageRow[];
      return ok(rows);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find messages by thread: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Prepared on first use: the query joins `runs`, `threads`, `queue_items`
   * and `message_refs`, which partial test schemas may not have.
   */
  private getCrossThreadOutboundStmts(): { count: Database.Statement; page: Database.Statement } {
    if (!this.crossThreadOutboundStmts) {
      // Outbound rows on a thread whose producing run lives on a different
      // thread. `run_id` without a `runs` row (background tasks) counts as
      // cross-thread too: the thread's own session never produced it.
      const crossThreadWhere = `
        FROM messages m
        LEFT JOIN runs r ON r.id = m.run_id
        WHERE m.thread_id = @thread_id
          AND m.direction = 'outbound'
          AND m.run_id IS NOT NULL
          AND (r.thread_id IS NULL OR r.thread_id != @thread_id)
          AND m.created_at >= @from_inclusive
          AND m.created_at < @before_exclusive
      `;
      const count = this.db.prepare(
        `SELECT COUNT(*) AS total ${crossThreadWhere}`,
      );
      const page = this.db.prepare(`
        SELECT * FROM (
          SELECT m.*, m.rowid AS row_order, r.thread_id AS source_thread_id,
            (SELECT st.external_id FROM threads st WHERE st.id = r.thread_id)
              AS source_thread_external_id,
            (SELECT sq.type FROM queue_items sq WHERE sq.id = r.queue_item_id)
              AS source_queue_type,
            (SELECT mr.external_id FROM message_refs mr
              WHERE mr.thread_id = m.thread_id AND mr.message_id = m.id
              ORDER BY mr.created_at DESC LIMIT 1) AS external_message_id
          ${crossThreadWhere}
          ORDER BY m.created_at DESC, m.rowid DESC
          LIMIT @limit
        ) sub ORDER BY created_at ASC, row_order ASC
      `);
      this.crossThreadOutboundStmts = { count, page };
    }
    return this.crossThreadOutboundStmts;
  }

  /**
   * Returns the outbound messages persisted to `threadId` by runs on other
   * threads within `[fromInclusive, beforeExclusive)` of `created_at`, newest
   * `limit` in chronological order, plus the total count in the window.
   *
   * The half-open window lets consecutive runs partition the timeline without
   * gaps or overlaps: a row is created with the current clock, so a row
   * inserted after a run's row can never fall before that run's `created_at`.
   */
  findCrossThreadOutbound(
    threadId: string,
    window: { fromInclusive: number; beforeExclusive: number; limit: number },
  ): Result<CrossThreadOutboundPage, DbError> {
    try {
      const params = {
        thread_id: threadId,
        from_inclusive: window.fromInclusive,
        before_exclusive: window.beforeExclusive,
      };
      const stmts = this.getCrossThreadOutboundStmts();
      const countRow = stmts.count.get(params) as { total: number };
      if (countRow.total === 0 || window.limit <= 0) {
        return ok({ total: countRow.total, messages: [] });
      }
      const rows = stmts.page.all({ ...params, limit: window.limit }) as Array<
        CrossThreadOutboundRow & { row_order?: number }
      >;
      const messages = rows.map(({ row_order: _rowOrder, ...row }) => row);
      return ok({ total: countRow.total, messages });
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find cross-thread outbound messages: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Returns the most recent N messages for a thread in chronological order.
   * Useful for reconstructing recent conversation context.
   */
  findLatestByThread(threadId: string, limit: number): Result<MessageRow[], DbError> {
    try {
      const rows = this.findLatestByThreadStmt.all(threadId, limit) as MessageRow[];
      return ok(rows);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find latest messages by thread: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Returns the most recent N messages for a thread created strictly AFTER
   * the given timestamp, in chronological order. Used by ContextAssembler
   * to include only post-rotation messages in the "Recent Messages" block
   * so the pre-rotation user instruction is not replayed as an instruction
   * on the next turn.
   */
  findLatestByThreadSince(
    threadId: string,
    sinceTimestamp: number,
    limit: number,
  ): Result<MessageRow[], DbError> {
    try {
      const rows = this.findLatestByThreadSinceStmt.all(
        threadId,
        sinceTimestamp,
        limit,
      ) as MessageRow[];
      return ok(rows);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find latest messages by thread since timestamp: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /** Returns one newest-first page, rendered in chronological order. */
  findLatestByThreadPage(
    threadId: string,
    limit: number,
    offset: number,
  ): Result<MessageRow[], DbError> {
    try {
      const rows = this.findLatestByThreadPageStmt.all(threadId, limit, offset) as MessageRow[];
      return ok(rows);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find latest message page by thread: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /** Returns one newest-first page after a boundary, rendered chronologically. */
  findLatestByThreadSincePage(
    threadId: string,
    sinceTimestamp: number,
    limit: number,
    offset: number,
  ): Result<MessageRow[], DbError> {
    try {
      const rows = this.findLatestByThreadSincePageStmt.all(
        threadId,
        sinceTimestamp,
        limit,
        offset,
      ) as MessageRow[];
      return ok(rows);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find latest message page by thread since timestamp: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Returns true if a message with the given idempotency key already exists.
   * Does NOT return a Result because this is a fast read used in hot paths.
   */
  existsByIdempotencyKey(key: string): boolean {
    return this.findByIdempotencyKeyStmt.get(key) !== undefined;
  }
}
