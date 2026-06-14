/**
 * Repository for the `memory_items` table.
 *
 * Memory items capture facts, summaries, notes, and embedding references
 * scoped to a thread. They form the per-thread long-term memory layer.
 *
 * The primary key is compound: (thread_id, id). This allows different
 * threads to use the same key (e.g. "user_name") without collisions.
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';

/** Valid memory item type values. */
export type MemoryType = 'fact' | 'summary' | 'note' | 'embedding_ref' | 'observation' | 'pre-roll-tail';

/** Row shape matching the `memory_items` table exactly. */
export interface MemoryItemRow {
  id: string;
  thread_id: string;
  type: MemoryType;
  content: string;
  embedding_ref: string | null;
  metadata: string;
  created_at: number;
  updated_at: number;
}

/** Fields accepted when inserting a new memory item. */
export type InsertMemoryItemInput = Omit<MemoryItemRow, 'created_at' | 'updated_at'>;

/** Fields that may be updated on an existing memory item. */
export type UpdateMemoryItemInput = Partial<Pick<MemoryItemRow, 'content' | 'embedding_ref' | 'metadata'>>;

/** Repository for reading and writing memory item records. */
export class MemoryRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly findByThreadStmt: Database.Statement;
  private readonly findByThreadAndTypeStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO memory_items
        (id, thread_id, type, content, embedding_ref, metadata, created_at, updated_at)
      VALUES
        (@id, @thread_id, @type, @content, @embedding_ref, @metadata, @created_at, @updated_at)
    `);

    this.findByIdStmt = db.prepare(`SELECT * FROM memory_items WHERE thread_id = ? AND id = ?`);

    this.findByThreadStmt = db.prepare(`
      SELECT * FROM memory_items WHERE thread_id = ? ORDER BY created_at DESC
    `);

    this.findByThreadAndTypeStmt = db.prepare(`
      SELECT * FROM memory_items WHERE thread_id = ? AND type = ? ORDER BY created_at DESC
    `);

    this.deleteStmt = db.prepare(`DELETE FROM memory_items WHERE thread_id = ? AND id = ?`);
  }

  /** Inserts a new memory item. */
  insert(input: InsertMemoryItemInput): Result<MemoryItemRow, DbError> {
    try {
      const ts = this.now();
      const row: MemoryItemRow = { ...input, created_at: ts, updated_at: ts };
      this.insertStmt.run(row);
      return ok(row);
    } catch (cause) {
      return err(new DbError(`Failed to insert memory item: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /**
   * Finds a memory item by its compound key (thread_id, id).
   *
   * @param threadId - Thread the item belongs to.
   * @param id       - Item key within the thread.
   */
  findById(threadId: string, id: string): Result<MemoryItemRow | null, DbError> {
    try {
      const row = this.findByIdStmt.get(threadId, id) as MemoryItemRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to find memory item by id: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /**
   * Returns all memory items for a thread, optionally filtered by type.
   *
   * @param threadId - Thread primary key.
   * @param type     - Optional type filter. If omitted, all types are returned.
   */
  findByThread(threadId: string, type?: MemoryType): Result<MemoryItemRow[], DbError> {
    try {
      let rows: MemoryItemRow[];
      if (type !== undefined) {
        rows = this.findByThreadAndTypeStmt.all(threadId, type) as MemoryItemRow[];
      } else {
        rows = this.findByThreadStmt.all(threadId) as MemoryItemRow[];
      }
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find memory items by thread: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /**
   * Updates mutable fields on an existing memory item.
   *
   * @param threadId - Thread the item belongs to.
   * @param id       - Item key within the thread.
   * @param fields   - Fields to update.
   */
  update(threadId: string, id: string, fields: UpdateMemoryItemInput): Result<MemoryItemRow | null, DbError> {
    try {
      const setClause = Object.keys(fields)
        .map((k) => `${k} = @${k}`)
        .join(', ');
      if (!setClause) {
        return this.findById(threadId, id);
      }
      const stmt = this.db.prepare(
        `UPDATE memory_items SET ${setClause}, updated_at = @updated_at WHERE thread_id = @thread_id AND id = @id`,
      );
      stmt.run({ ...fields, updated_at: this.now(), thread_id: threadId, id });
      return this.findById(threadId, id);
    } catch (cause) {
      return err(new DbError(`Failed to update memory item: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /**
   * Upserts a memory item by its compound key (thread_id, id).
   * If the item exists, updates content. Otherwise inserts.
   *
   * @param threadId - Thread the item belongs to.
   * @param id       - Item key within the thread.
   * @param fields   - Content and optional type (for insert) / metadata to set.
   */
  upsertByKey(
    threadId: string,
    id: string,
    fields: { content: string; type?: MemoryType; metadata?: string },
  ): Result<MemoryItemRow, DbError> {
    try {
      const upsertTx = this.db.transaction(
        (
          txThreadId: string,
          txId: string,
          txFields: { content: string; type?: MemoryType; metadata?: string },
        ): Result<MemoryItemRow, DbError> => {
          const existing = this.findByIdStmt.get(txThreadId, txId) as MemoryItemRow | undefined;
          if (existing) {
            const updateFields: UpdateMemoryItemInput = { content: txFields.content };
            if (txFields.metadata !== undefined) updateFields.metadata = txFields.metadata;
            const updateResult = this.update(txThreadId, txId, updateFields);
            if (updateResult.isErr()) return err(updateResult.error);
            if (updateResult.value === null) {
              return err(new DbError('Memory item disappeared during upsert update'));
            }
            return ok(updateResult.value);
          }
          return this.insert({
            id: txId,
            thread_id: txThreadId,
            type: txFields.type ?? 'note',
            content: txFields.content,
            embedding_ref: null,
            metadata: txFields.metadata ?? '{}',
          });
        },
      );
      return upsertTx(threadId, id, fields);
    } catch (cause) {
      return err(new DbError(`Failed to upsert memory item: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /**
   * Runs multiple repository operations inside a single SQLite transaction.
   * If the callback throws, all writes are rolled back atomically.
   */
  runInTransaction<T>(fn: () => T): Result<T, DbError> {
    try {
      const txFn = this.db.transaction(() => fn());
      return ok(txFn());
    } catch (cause) {
      return err(new DbError(`Transaction failed: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /**
   * Deletes a memory item by its compound key.
   *
   * @param threadId - Thread the item belongs to.
   * @param id       - Item key within the thread.
   */
  delete(threadId: string, id: string): Result<void, DbError> {
    try {
      this.deleteStmt.run(threadId, id);
      return ok(undefined);
    } catch (cause) {
      return err(new DbError(`Failed to delete memory item: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }
}
