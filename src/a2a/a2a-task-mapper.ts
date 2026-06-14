/**
 * A2ATaskMapper — validates, persists, and enqueues A2A task submissions.
 *
 * Responsible for:
 * - Validating inbound task requests (content, hop limits, persona existence)
 * - Persisting the initial a2a_tasks row
 * - Enqueueing a collaboration queue item containing an A2ATaskPayload
 * - Exposing task status queries
 */

import { v4 as uuidv4 } from 'uuid';
import { ok, err, type Result } from 'neverthrow';
import type pino from 'pino';
import type { A2ATaskRepository } from '../core/database/repositories/a2a-task-repository.js';
import type { QueueRepository } from '../core/database/repositories/queue-repository.js';
import type { ThreadRepository } from '../core/database/repositories/thread-repository.js';
import type { PersonaRepository } from '../core/database/repositories/persona-repository.js';
import { A2AError } from '../core/errors/index.js';
import {
  type A2AAgentCard,
  type A2ATaskPayload,
  type A2ATaskStatus,
  type A2ALimits,
  defaultA2ALimits,
} from './a2a-types.js';

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface SubmitTaskInput {
  /** Persona originating this task. */
  sourcePersona: string;
  /** Persona that should execute this task. */
  targetPersona: string;
  /** Thread context in which to run the task. */
  sourceThreadId: string;
  /** Text content of the task. */
  content: string;
  /** Current hop depth (0 for first-generation tasks). */
  hopCount: number;
  /** Parent task ID for delegation chains. */
  parentTaskId?: string;
  /** Trace ID for observability. */
  traceId?: string;
}

// ---------------------------------------------------------------------------
// A2ATaskMapper
// ---------------------------------------------------------------------------

/**
 * Validates and submits A2A tasks, bridging the protocol layer to Talon's
 * durable queue and persistence systems.
 */
export class A2ATaskMapper {
  private readonly limits: A2ALimits;

  constructor(
    private readonly taskRepo: A2ATaskRepository,
    private readonly queueRepo: QueueRepository,
    private readonly threadRepo: ThreadRepository,
    private readonly personaRepo: PersonaRepository,
    private readonly cardRegistry: Map<string, A2AAgentCard>,
    private readonly logger: pino.Logger,
    limits?: A2ALimits,
  ) {
    this.limits = limits ?? defaultA2ALimits();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Validates, persists, and enqueues an A2A task.
   *
   * Steps:
   * 1. Validate content is non-empty
   * 2. Check hop limit
   * 3. Verify target persona exists in registry and DB
   * 4. Verify source thread exists
   * 5. Check concurrency admission control
   * 6. Persist the task record as 'submitted'
   * 7. Enqueue a 'collaboration' queue item
   * 8. Attach the queue item ID to the task record
   *
   * @returns Ok(A2ATaskStatus) on success, Err(A2AError) on validation/persistence failure.
   */
  submitTask(input: SubmitTaskInput): Result<A2ATaskStatus, A2AError> {
    const { sourcePersona, targetPersona, sourceThreadId, content, hopCount, parentTaskId, traceId } = input;

    // 1. Validate content
    if (!content.trim()) {
      return err(new A2AError('Task content must not be empty'));
    }

    // 2. Check hop limit
    if (hopCount >= this.limits.maxHops) {
      return err(
        new A2AError(
          `Task rejected: hop count ${hopCount} exceeds maximum allowed hops (${this.limits.maxHops})`,
        ),
      );
    }

    // 3. Verify target persona exists in card registry
    const card = this.cardRegistry.get(targetPersona);
    if (!card) {
      return err(new A2AError(`Unknown target persona: ${targetPersona}`));
    }

    // 4. Resolve target persona DB record
    const personaResult = this.personaRepo.findByName(targetPersona);
    if (personaResult.isErr()) {
      return err(new A2AError(`Failed to look up persona ${targetPersona}: ${personaResult.error.message}`));
    }
    const personaRow = personaResult.value;
    if (!personaRow) {
      return err(new A2AError(`Unknown target persona: ${targetPersona}`));
    }

    // 5. Verify source thread exists
    const threadResult = this.threadRepo.findById(sourceThreadId);
    if (threadResult.isErr()) {
      return err(new A2AError(`Failed to look up thread ${sourceThreadId}: ${threadResult.error.message}`));
    }
    if (!threadResult.value) {
      return err(new A2AError(`Unknown source thread: ${sourceThreadId}`));
    }

    const taskId = uuidv4();
    const now = Date.now();

    // 8. Build queue payload
    const payload: A2ATaskPayload = {
      kind: 'a2a_task',
      taskId,
      sourcePersona,
      targetPersona,
      sourceThreadId,
      personaId: personaRow.id,
      content,
      parentTaskId,
      hopCount,
      submittedAt: now,
      metadata: {
        agentCardId: card.id,
        traceId,
        maxHops: this.limits.maxHops,
        queueType: 'collaboration',
      },
    };

    // 6+7+9+10. Atomically check concurrency, insert the task, enqueue, and attach
    // the queue item. The concurrency check runs INSIDE the transaction so that two
    // concurrent submissions cannot both pass the admission gate — SQLite serialises
    // writes, so the second transaction will see the first insert.
    let queueItemId = '';
    let txError: A2AError | null = null;

    try {
      this.taskRepo.transaction(() => {
        // 6. Concurrency admission inside the transaction (atomic with the insert).
        const activeResult = this.taskRepo.countActiveByTarget(targetPersona);
        if (activeResult.isErr()) {
          txError = new A2AError(`Failed to check concurrency for ${targetPersona}: ${activeResult.error.message}`);
          throw activeResult.error;
        }
        if (activeResult.value >= this.limits.maxConcurrentPerTarget) {
          txError = new A2AError(
            `Target persona ${targetPersona} already has ${activeResult.value} active task(s). Max allowed: ${this.limits.maxConcurrentPerTarget}`,
          );
          throw new Error(txError.message);
        }

        // 7. Persist the task as 'submitted' with the full request payload for audit.
        const insertResult = this.taskRepo.insertSubmitted({
          id: taskId,
          source_persona: sourcePersona,
          target_persona: targetPersona,
          thread_id: sourceThreadId,
          request_payload: JSON.stringify({ content, sourcePersona, targetPersona, sourceThreadId, hopCount, parentTaskId, traceId }),
          hop_count: hopCount,
          parent_task_id: parentTaskId ?? null,
          submitted_at: now,
        });
        if (insertResult.isErr()) {
          txError = new A2AError(`Failed to persist A2A task: ${insertResult.error.message}`);
          throw insertResult.error;
        }

        // 9. Enqueue collaboration item
        const enqueueResult = this.queueRepo.enqueue({
          id: uuidv4(),
          thread_id: sourceThreadId,
          message_id: null,
          type: 'collaboration',
          payload: JSON.stringify(payload),
          max_attempts: this.limits.maxAttempts,
        });
        if (enqueueResult.isErr()) {
          txError = new A2AError(`Failed to enqueue A2A task ${taskId}: ${enqueueResult.error.message}`);
          throw enqueueResult.error;
        }
        queueItemId = enqueueResult.value.id;

        // 10. Attach queue item to task record (best-effort within the transaction)
        const attachResult = this.taskRepo.attachQueueItem(taskId, queueItemId);
        if (attachResult.isErr()) {
          this.logger.warn(
            { taskId, queueItemId, err: attachResult.error.message },
            'Failed to attach queue item to A2A task — task will still run',
          );
        }
      });
    } catch {
      if (txError) return err(txError);
      return err(new A2AError(`Unexpected error during A2A task submission for ${taskId}`));
    }

    this.logger.info(
      { taskId, sourcePersona, targetPersona, sourceThreadId, queueItemId, hopCount },
      'A2A task submitted',
    );

    return ok({
      taskId,
      state: 'submitted',
      sourcePersona,
      targetPersona,
      threadId: sourceThreadId,
      queueItemId,
      submittedAt: now,
      updatedAt: now,
    });
  }

  /**
   * Returns the current status of an A2A task.
   *
   * @param taskId - The A2A task ID.
   * @returns Ok(A2ATaskStatus | null) — null if the task does not exist.
   */
  getTaskStatus(taskId: string): Result<A2ATaskStatus | null, A2AError> {
    const result = this.taskRepo.findById(taskId);
    if (result.isErr()) {
      return err(new A2AError(`Failed to load task ${taskId}: ${result.error.message}`));
    }
    const row = result.value;
    if (!row) return ok(null);

    const status: A2ATaskStatus = {
      taskId: row.id,
      state: row.state,
      sourcePersona: row.source_persona,
      targetPersona: row.target_persona,
      threadId: row.thread_id,
      queueItemId: row.queue_item_id ?? undefined,
      runId: row.run_id ?? undefined,
      submittedAt: row.submitted_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined,
    };

    if (row.result_payload) {
      try {
        status.result = JSON.parse(row.result_payload) as { text: string };
      } catch {
        // malformed result — omit
      }
    }

    if (row.error_code) {
      status.error = {
        code: row.error_code,
        message: row.error_message ?? '',
      };
    }

    return ok(status);
  }
}
