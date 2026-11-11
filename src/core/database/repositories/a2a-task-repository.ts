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
  private readonly countQueuedByTargetStmt: Database.Statement;
  private readonly findNonTerminalStmt: Database.Statement;
  private readonly countOthersRunningStmt: Database.Statement;
  private readonly countOlderSubmittedStmt: Database.Statement;
  private readonly admitStmt: Database.Statement;
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

    // All lifecycle transitions are guarded in SQL: terminal states
    // (completed/failed/canceled) are never overwritten.
    this.markWorkingStmt = db.prepare(`
      UPDATE a2a_tasks
      SET state = 'working', run_id = @run_id, updated_at = @updated_at
      WHERE id = @id AND state IN ('submitted', 'working')
    `);

    this.markCompletedStmt = db.prepare(`
      UPDATE a2a_tasks
      SET state = 'completed',
          result_payload = @result_payload,
          completed_at = @completed_at,
          updated_at = @updated_at
      WHERE id = @id AND state IN ('submitted', 'working')
    `);

    this.markFailedStmt = db.prepare(`
      UPDATE a2a_tasks
      SET state = 'failed',
          error_code = @error_code,
          error_message = @error_message,
          completed_at = @now,
          updated_at = @now
      WHERE id = @id AND state IN ('submitted', 'working', 'input-required')
    `);

    this.markCanceledStmt = db.prepare(`
      UPDATE a2a_tasks
      SET state = 'canceled',
          error_code = 'CANCELED',
          error_message = @reason,
          completed_at = @now,
          updated_at = @now
      WHERE id = @id AND state IN ('submitted', 'working', 'input-required')
    `);

    this.countQueuedByTargetStmt = db.prepare(`
      SELECT COUNT(*) as count FROM a2a_tasks
      WHERE target_persona = ? AND state = 'submitted'
    `);

    this.findNonTerminalStmt = db.prepare(`
      SELECT t.*, q.status AS queue_status
      FROM a2a_tasks t
      LEFT JOIN queue_items q ON q.id = t.queue_item_id
      WHERE t.state IN ('submitted', 'working', 'input-required')
      ORDER BY t.submitted_at ASC
    `);

    this.countOthersRunningStmt = db.prepare(`
      SELECT COUNT(*) as count FROM a2a_tasks
      WHERE target_persona = @target AND id != @id
        AND state IN ('working', 'input-required')
    `);

    this.countOlderSubmittedStmt = db.prepare(`
      SELECT COUNT(*) as count FROM a2a_tasks
      WHERE target_persona = @target AND state = 'submitted'
        AND (submitted_at < @submitted_at OR (submitted_at = @submitted_at AND id < @id))
    `);

    this.admitStmt = db.prepare(`
      UPDATE a2a_tasks SET state = 'working', updated_at = @now
      WHERE id = @id AND state = 'submitted'
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
   * Records the run ID and (re)asserts 'working'. Only valid from
   * 'submitted'/'working'. Returns Ok(true) if transitioned, Ok(false) if the
   * task is terminal or unknown (no-op).
   */
  markWorking(taskId: string, runId: string): Result<boolean, DbError> {
    return this.guarded(`mark A2A task ${taskId} as working`, () =>
      this.markWorkingStmt.run({ id: taskId, run_id: runId, updated_at: this.now() }).changes > 0,
    );
  }

  /**
   * Transitions the task to 'completed' with the result text. Only valid from
   * 'submitted'/'working'. Ok(false) if already terminal or unknown.
   */
  markCompleted(taskId: string, resultText: string): Result<boolean, DbError> {
    return this.guarded(`mark A2A task ${taskId} as completed`, () => {
      const now = this.now();
      return (
        this.markCompletedStmt.run({
          id: taskId,
          result_payload: JSON.stringify({ text: resultText }),
          completed_at: now,
          updated_at: now,
        }).changes > 0
      );
    });
  }

  /**
   * Transitions a non-terminal task to 'failed'. Ok(false) if already terminal or unknown.
   */
  markFailed(taskId: string, errorCode: string, errorMessage: string): Result<boolean, DbError> {
    return this.guarded(`mark A2A task ${taskId} as failed`, () =>
      this.markFailedStmt.run({
        id: taskId,
        error_code: errorCode,
        error_message: errorMessage,
        now: this.now(),
      }).changes > 0,
    );
  }

  /**
   * Transitions a non-terminal task to 'canceled', recording the reason as
   * error_code 'CANCELED' / error_message. Ok(false) if already terminal or unknown.
   */
  markCanceled(taskId: string, reason: string): Result<boolean, DbError> {
    return this.guarded(`mark A2A task ${taskId} as canceled`, () =>
      this.markCanceledStmt.run({ id: taskId, reason, now: this.now() }).changes > 0,
    );
  }

  /**
   * Atomically decides whether a task may start running (single transaction).
   *
   * - 'working'   -> 'admitted' (retry / crash-recovery re-entry)
   * - terminal    -> 'terminal'
   * - 'submitted' -> admitted (and set to 'working') iff
   *     (other tasks for the target running) + (older submitted tasks for the target) < limit,
   *   else 'wait' (FIFO fairness by submitted_at then id).
   * - unknown id  -> 'missing'
   */
  tryAdmit(
    taskId: string,
    maxConcurrentPerTarget: number,
  ): Result<'admitted' | 'wait' | 'terminal' | 'missing', DbError> {
    try {
      const run = this.db.transaction((): 'admitted' | 'wait' | 'terminal' | 'missing' => {
        const row = this.findByIdStmt.get(taskId) as A2ATaskRow | undefined;
        if (!row) return 'missing';
        if (row.state === 'working') return 'admitted';
        if (row.state === 'completed' || row.state === 'failed' || row.state === 'canceled') return 'terminal';
        if (row.state === 'input-required') return 'admitted';
        const running = (this.countOthersRunningStmt.get({ target: row.target_persona, id: row.id }) as { count: number }).count;
        const older = (
          this.countOlderSubmittedStmt.get({
            target: row.target_persona,
            submitted_at: row.submitted_at,
            id: row.id,
          }) as { count: number }
        ).count;
        if (running + older >= maxConcurrentPerTarget) return 'wait';
        this.admitStmt.run({ id: row.id, now: this.now() });
        return 'admitted';
      });
      return ok(run());
    } catch (cause) {
      return err(
        new DbError(
          `Failed to admit A2A task ${taskId}: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Returns all non-terminal tasks joined with their queue item status
   * (`queue_status` is null when no queue item is attached or the row is gone).
   * Used by the reaper.
   */
  findNonTerminalWithQueueStatus(): Result<Array<A2ATaskRow & { queue_status: string | null }>, DbError> {
    try {
      return ok(this.findNonTerminalStmt.all() as Array<A2ATaskRow & { queue_status: string | null }>);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to list non-terminal A2A tasks: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /** Returns the count of tasks waiting ('submitted') for the target persona. */
  countQueuedByTarget(targetPersona: string): Result<number, DbError> {
    try {
      return ok((this.countQueuedByTargetStmt.get(targetPersona) as { count: number }).count);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to count queued A2A tasks for persona ${targetPersona}: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  private guarded(what: string, fn: () => boolean): Result<boolean, DbError> {
    try {
      return ok(fn());
    } catch (cause) {
      return err(new DbError(`Failed to ${what}: ${String(cause)}`, cause instanceof Error ? cause : undefined));
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
