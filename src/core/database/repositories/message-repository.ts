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

/** Repository for reading and writing message records. */
export class MessageRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly findByThreadStmt: Database.Statement;
  private readonly findLatestByThreadStmt: Database.Statement;
  private readonly findLatestByThreadSinceStmt: Database.Statement;
  private readonly findByIdempotencyKeyStmt: Database.Statement;

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

    this.findByIdempotencyKeyStmt = db.prepare(`
      SELECT * FROM messages WHERE idempotency_key = ?
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

  /**
   * Returns true if a message with the given idempotency key already exists.
   * Does NOT return a Result because this is a fast read used in hot paths.
   */
  existsByIdempotencyKey(key: string): boolean {
    return this.findByIdempotencyKeyStmt.get(key) !== undefined;
  }
}
