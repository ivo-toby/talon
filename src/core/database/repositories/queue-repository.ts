/**
 * Repository for the `queue_items` table.
 *
 * Implements a durable FIFO queue with per-thread ordering, exponential
 * retry with configurable max attempts, and a dead-letter state for items
 * that exhaust all retries.
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';

/** Valid queue item status values. */
export type QueueStatus = 'pending' | 'claimed' | 'processing' | 'completed' | 'failed' | 'dead_letter';

/** Valid queue item type values. */
export type QueueType = 'message' | 'schedule' | 'collaboration';

/** Row shape matching the `queue_items` table exactly. */
export interface QueueItemRow {
  id: string;
  thread_id: string;
  message_id: string | null;
  type: QueueType;
  status: QueueStatus;
  attempts: number;
  max_attempts: number;
  next_retry_at: number | null;
  error: string | null;
  payload: string;
  claimed_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Fields accepted when enqueueing a new item. */
export type EnqueueInput = Pick<
  QueueItemRow,
  'id' | 'thread_id' | 'message_id' | 'type' | 'payload' | 'max_attempts'
>;

/** Repository for durable queue operations. */
export class QueueRepository extends BaseRepository {
  private readonly enqueueStmt: Database.Statement;
  private readonly claimNextStmt: Database.Statement;
  private readonly completeStmt: Database.Statement;
  private readonly markDeadLetterStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly findPendingStmt: Database.Statement;
  private readonly findDeadLetterStmt: Database.Statement;
  private readonly countByStatusStmt: Database.Statement;
  private readonly hasInflightItemStmt: Database.Statement;
  private readonly claimNextCollaborationStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.enqueueStmt = db.prepare(`
      INSERT INTO queue_items
        (id, thread_id, message_id, type, status, attempts, max_attempts,
         next_retry_at, error, payload, claimed_at, created_at, updated_at)
      VALUES
        (@id, @thread_id, @message_id, @type, 'pending', 0, @max_attempts,
         NULL, NULL, @payload, NULL, @created_at, @updated_at)
    `);

    // Atomically claim the oldest pending/retryable item for a given thread.
    // Uses a sub-select to find the target row and UPDATE to claim it in one
    // statement, preventing races in SQLite's serialized write model.
    this.claimNextStmt = db.prepare(`
      UPDATE queue_items
      SET status = 'claimed', claimed_at = @now, updated_at = @now
      WHERE id = (
        SELECT id FROM queue_items
        WHERE thread_id = @thread_id
          AND status IN ('pending', 'failed')
          AND (next_retry_at IS NULL OR next_retry_at <= @now)
        ORDER BY created_at ASC
        LIMIT 1
      )
      RETURNING *
    `);

    // Atomically claim the oldest pending/retryable collaboration item for a
    // given thread. Used to bypass the per-thread single-inflight invariant
    // when a collaboration item is pending behind a regular item.
    this.claimNextCollaborationStmt = db.prepare(`
      UPDATE queue_items
      SET status = 'claimed', claimed_at = @now, updated_at = @now
      WHERE id = (
        SELECT id FROM queue_items
        WHERE thread_id = @thread_id
          AND type = 'collaboration'
          AND status IN ('pending', 'failed')
          AND (next_retry_at IS NULL OR next_retry_at <= @now)
        ORDER BY created_at ASC
        LIMIT 1
      )
      RETURNING *
    `);

    this.completeStmt = db.prepare(`
      UPDATE queue_items
      SET status = 'completed', updated_at = @now
      WHERE id = @id
    `);

    this.markDeadLetterStmt = db.prepare(`
      UPDATE queue_items
      SET status = 'dead_letter', error = @error, updated_at = @now
      WHERE id = @id
    `);

    this.findByIdStmt = db.prepare(`SELECT * FROM queue_items WHERE id = ?`);

    this.findPendingStmt = db.prepare(`
      SELECT * FROM queue_items
      WHERE status IN ('pending', 'failed')
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY created_at ASC
    `);

    this.findDeadLetterStmt = db.prepare(`
      SELECT * FROM queue_items
      WHERE status = 'dead_letter'
      ORDER BY updated_at DESC
    `);

    this.countByStatusStmt = db.prepare(`
      SELECT status, COUNT(*) as count FROM queue_items GROUP BY status
    `);

    this.hasInflightItemStmt = db.prepare(`
      SELECT 1 FROM queue_items
      WHERE thread_id = ?
        AND status IN ('claimed', 'processing')
      LIMIT 1
    `);
  }

  /** Adds a new item to the queue with status 'pending'. */
  enqueue(input: EnqueueInput): Result<QueueItemRow, DbError> {
    try {
      const ts = this.now();
      this.enqueueStmt.run({ ...input, created_at: ts, updated_at: ts });
      const row = this.findByIdStmt.get(input.id) as QueueItemRow;
      return ok(row);
    } catch (cause) {
      return err(new DbError(`Failed to enqueue item: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /**
   * Atomically claims the next available queue item for the given thread.
   *
   * Returns null if no eligible item exists (pending or failed with an
   * elapsed retry delay).
   */
  claimNext(threadId: string): Result<QueueItemRow | null, DbError> {
    try {
      const now = this.now();
      const row = this.claimNextStmt.get({ thread_id: threadId, now }) as QueueItemRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to claim queue item: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /**
   * Atomically claims the oldest pending/retryable collaboration item for the given thread.
   *
   * Used to bypass the per-thread single-inflight invariant when a collaboration
   * item is blocked behind a regular pending item. Returns null if no eligible
   * collaboration item exists.
   */
  claimNextCollaboration(threadId: string): Result<QueueItemRow | null, DbError> {
    try {
      const now = this.now();
      const row = this.claimNextCollaborationStmt.get({ thread_id: threadId, now }) as QueueItemRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to claim collaboration queue item: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Marks a claimed item as completed. */
  complete(id: string): Result<void, DbError> {
    try {
      this.completeStmt.run({ id, now: this.now() });
      return ok(undefined);
    } catch (cause) {
      return err(new DbError(`Failed to complete queue item: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /**
   * Records a failure on a queue item and schedules the next retry.
   *
   * If the item has reached its max_attempts it is moved to dead_letter instead.
   *
   * @param id           - Queue item primary key.
   * @param errorMessage - Human-readable failure description.
   * @param nextRetryAt  - Absolute Unix ms timestamp for the next attempt.
   */
  fail(id: string, errorMessage: string, nextRetryAt: number): Result<void, DbError> {
    try {
      const now = this.now();
      const row = this.findByIdStmt.get(id) as QueueItemRow | undefined;
      if (!row) {
        return err(new DbError(`Queue item not found: ${id}`));
      }

      const newAttempts = row.attempts + 1;

      if (newAttempts >= row.max_attempts) {
        // Exhausted retries — send to dead letter.
        this.markDeadLetterStmt.run({ id, error: errorMessage, now });
      } else {
        const stmt = this.db.prepare(`
          UPDATE queue_items
          SET status = 'failed', attempts = @attempts, next_retry_at = @next_retry_at,
              error = @error, updated_at = @now
          WHERE id = @id
        `);
        stmt.run({ id, attempts: newAttempts, next_retry_at: nextRetryAt, error: errorMessage, now });
      }

      return ok(undefined);
    } catch (cause) {
      return err(new DbError(`Failed to record queue item failure: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Moves a queue item directly to dead_letter state. */
  markDeadLetter(id: string, errorMessage: string): Result<void, DbError> {
    try {
      this.markDeadLetterStmt.run({ id, error: errorMessage, now: this.now() });
      return ok(undefined);
    } catch (cause) {
      return err(new DbError(`Failed to mark dead letter: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns a single queue item by its primary key, or null if not found. */
  findById(id: string): Result<QueueItemRow | null, DbError> {
    try {
      const row = this.findByIdStmt.get(id) as QueueItemRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to find queue item by id: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns all items that are eligible to be processed (pending or failed with elapsed retry). */
  findPending(now?: number): Result<QueueItemRow[], DbError> {
    try {
      const rows = this.findPendingStmt.all(now ?? this.now()) as QueueItemRow[];
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find pending queue items: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns all dead-letter items. */
  findDeadLetter(): Result<QueueItemRow[], DbError> {
    try {
      const rows = this.findDeadLetterStmt.all() as QueueItemRow[];
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find dead-letter queue items: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns a map of status -> count for all queue items. */
  countByStatus(): Result<Record<string, number>, DbError> {
    try {
      const rows = this.countByStatusStmt.all() as Array<{ status: string; count: number }>;
      const result: Record<string, number> = {};
      for (const r of rows) {
        result[r.status] = r.count;
      }
      return ok(result);
    } catch (cause) {
      return err(new DbError(`Failed to count queue items by status: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /**
   * Returns true if the given thread has any item in claimed or processing state.
   *
   * Used by the queue processor to enforce the "no interleaved runs" invariant:
   * a new item must not be claimed for a thread that already has one in flight.
   */
  hasInflightItem(threadId: string): Result<boolean, DbError> {
    try {
      const row = this.hasInflightItemStmt.get(threadId);
      return ok(row !== undefined);
    } catch (cause) {
      return err(new DbError(`Failed to check inflight item for thread: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /**
   * Deletes queue items matching the given statuses.
   *
   * @param statuses - Array of statuses to purge (e.g. ['pending', 'failed', 'dead_letter']).
   * @returns Ok(number) with the count of deleted rows, or DbError.
   */
  purge(statuses: QueueStatus[]): Result<number, DbError> {
    if (statuses.length === 0) {
      return ok(0);
    }
    try {
      const placeholders = statuses.map(() => '?').join(', ');
      const purgeTransaction = this.db.transaction(() => {
        // Detach referencing rows before deleting (FK constraints without ON DELETE CASCADE).
        this.db.prepare(
          `UPDATE runs SET queue_item_id = NULL WHERE queue_item_id IN (SELECT id FROM queue_items WHERE status IN (${placeholders}))`,
        ).run(...statuses);
        this.db.prepare(
          `UPDATE a2a_tasks SET queue_item_id = NULL WHERE queue_item_id IN (SELECT id FROM queue_items WHERE status IN (${placeholders}))`,
        ).run(...statuses);
        const result = this.db.prepare(
          `DELETE FROM queue_items WHERE status IN (${placeholders})`,
        ).run(...statuses);
        return result.changes;
      });
      return ok(purgeTransaction());
    } catch (cause) {
      return err(new DbError(`Failed to purge queue items: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }
}
