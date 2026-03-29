/**
 * Repository for the `a2a_tasks` table.
 *
 * Manages the lifecycle state of A2A protocol tasks, from initial submission
 * through working, to completion or failure.
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';
import type { A2ATaskRow } from '../../../a2a/a2a-types.js';

/** Fields required when inserting a new submitted task. */
export interface InsertA2ATaskInput {
  id: string;
  source_persona: string;
  target_persona: string;
  thread_id: string;
  request_payload: string;
  hop_count: number;
  parent_task_id: string | null;
  submitted_at: number;
}

/** Repository for A2A task persistence and lifecycle management. */
export class A2ATaskRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly attachQueueItemStmt: Database.Statement;
  private readonly markWorkingStmt: Database.Statement;
  private readonly markCompletedStmt: Database.Statement;
  private readonly markFailedStmt: Database.Statement;
  private readonly markCanceledStmt: Database.Statement;
  private readonly countActiveByTargetStmt: Database.Statement;
  private readonly findAllStmt: Database.Statement;
  private readonly findAllByStateStmt: Database.Statement;
  private readonly findAllByTargetStmt: Database.Statement;
  private readonly findAllByStateAndTargetStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.findAllStmt = db.prepare(`
      SELECT * FROM a2a_tasks ORDER BY submitted_at DESC LIMIT ?
    `);

    this.findAllByStateStmt = db.prepare(`
      SELECT * FROM a2a_tasks WHERE state = ? ORDER BY submitted_at DESC LIMIT ?
    `);

    this.findAllByTargetStmt = db.prepare(`
      SELECT * FROM a2a_tasks WHERE target_persona = ? ORDER BY submitted_at DESC LIMIT ?
    `);

    this.findAllByStateAndTargetStmt = db.prepare(`
      SELECT * FROM a2a_tasks WHERE state = ? AND target_persona = ? ORDER BY submitted_at DESC LIMIT ?
    `);

    this.insertStmt = db.prepare(`
      INSERT INTO a2a_tasks
        (id, source_persona, target_persona, thread_id, state,
         request_payload, hop_count, parent_task_id, submitted_at, updated_at)
      VALUES
        (@id, @source_persona, @target_persona, @thread_id, 'submitted',
         @request_payload, @hop_count, @parent_task_id, @submitted_at, @updated_at)
    `);

    this.findByIdStmt = db.prepare(`
      SELECT * FROM a2a_tasks WHERE id = ?
    `);

    this.attachQueueItemStmt = db.prepare(`
      UPDATE a2a_tasks
      SET queue_item_id = @queue_item_id, updated_at = @updated_at
      WHERE id = @id
    `);

    this.markWorkingStmt = db.prepare(`
      UPDATE a2a_tasks
      SET state = 'working', run_id = @run_id, updated_at = @updated_at
      WHERE id = @id
    `);

    this.markCompletedStmt = db.prepare(`
      UPDATE a2a_tasks
      SET state = 'completed',
          result_payload = @result_payload,
          completed_at = @completed_at,
          updated_at = @updated_at
      WHERE id = @id
    `);

    this.markFailedStmt = db.prepare(`
      UPDATE a2a_tasks
      SET state = 'failed',
          error_code = @error_code,
          error_message = @error_message,
          updated_at = @updated_at
      WHERE id = @id
    `);

    this.markCanceledStmt = db.prepare(`
      UPDATE a2a_tasks
      SET state = 'canceled', updated_at = @updated_at
      WHERE id = @id
    `);

    this.countActiveByTargetStmt = db.prepare(`
      SELECT COUNT(*) as count FROM a2a_tasks
      WHERE target_persona = ?
        AND state IN ('submitted', 'working', 'input-required')
    `);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Inserts a new A2A task in the 'submitted' state.
   */
  insertSubmitted(input: InsertA2ATaskInput): Result<A2ATaskRow, DbError> {
    try {
      this.insertStmt.run({ ...input, updated_at: this.now() });
      return this.findById(input.id).andThen((row) =>
        row ? ok(row) : err(new DbError('A2A task not found after insert')),
      );
    } catch (cause) {
      return err(
        new DbError(
          `Failed to insert A2A task ${input.id}: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Links a queue item ID to the task after it has been enqueued.
   */
  attachQueueItem(taskId: string, queueItemId: string): Result<void, DbError> {
    try {
      const result = this.attachQueueItemStmt.run({
        id: taskId,
        queue_item_id: queueItemId,
        updated_at: this.now(),
      });
      if (result.changes === 0) {
        return err(new DbError(`Task not found or already in terminal state: ${taskId}`));
      }
      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to attach queue item to A2A task ${taskId}: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Transitions the task to 'working' state, recording the run ID.
   */
  markWorking(taskId: string, runId: string): Result<void, DbError> {
    try {
      const result = this.markWorkingStmt.run({ id: taskId, run_id: runId, updated_at: this.now() });
      if (result.changes === 0) {
        return err(new DbError(`Task not found or already in terminal state: ${taskId}`));
      }
      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to mark A2A task ${taskId} as working: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Transitions the task to 'completed' state with the result text.
   */
  markCompleted(taskId: string, resultText: string): Result<void, DbError> {
    try {
      const now = this.now();
      const result = this.markCompletedStmt.run({
        id: taskId,
        result_payload: JSON.stringify({ text: resultText }),
        completed_at: now,
        updated_at: now,
      });
      if (result.changes === 0) {
        return err(new DbError(`Task not found or already in terminal state: ${taskId}`));
      }
      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to mark A2A task ${taskId} as completed: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Transitions the task to 'failed' state with an error code and message.
   */
  markFailed(taskId: string, errorCode: string, errorMessage: string): Result<void, DbError> {
    try {
      const result = this.markFailedStmt.run({
        id: taskId,
        error_code: errorCode,
        error_message: errorMessage,
        updated_at: this.now(),
      });
      if (result.changes === 0) {
        return err(new DbError(`Task not found or already in terminal state: ${taskId}`));
      }
      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to mark A2A task ${taskId} as failed: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Transitions the task to 'canceled' state.
   */
  markCanceled(taskId: string): Result<void, DbError> {
    try {
      const result = this.markCanceledStmt.run({ id: taskId, updated_at: this.now() });
      if (result.changes === 0) {
        return err(new DbError(`Task not found or already in terminal state: ${taskId}`));
      }
      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to mark A2A task ${taskId} as canceled: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Looks up a task by its primary key.
   */
  findById(taskId: string): Result<A2ATaskRow | null, DbError> {
    try {
      const row = this.findByIdStmt.get(taskId) as A2ATaskRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find A2A task ${taskId}: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Returns a list of A2A tasks, optionally filtered by state and/or target persona.
   *
   * @param options.state - Filter by task lifecycle state.
   * @param options.targetPersona - Filter by target persona name.
   * @param options.limit - Max rows to return (default 20).
   */
  findAll(options?: { state?: string; targetPersona?: string; limit?: number }): Result<A2ATaskRow[], DbError> {
    try {
      const limit = options?.limit ?? 20;
      const { state, targetPersona } = options ?? {};
      let rows: A2ATaskRow[];
      if (state && targetPersona) {
        rows = this.findAllByStateAndTargetStmt.all(state, targetPersona, limit) as A2ATaskRow[];
      } else if (state) {
        rows = this.findAllByStateStmt.all(state, limit) as A2ATaskRow[];
      } else if (targetPersona) {
        rows = this.findAllByTargetStmt.all(targetPersona, limit) as A2ATaskRow[];
      } else {
        rows = this.findAllStmt.all(limit) as A2ATaskRow[];
      }
      return ok(rows);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to list A2A tasks: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Returns the count of active (non-terminal) tasks for the given target persona.
   * Used for concurrency admission control.
   */
  countActiveByTarget(targetPersona: string): Result<number, DbError> {
    try {
      const row = this.countActiveByTargetStmt.get(targetPersona) as { count: number };
      return ok(row.count);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to count active A2A tasks for persona ${targetPersona}: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }
}
