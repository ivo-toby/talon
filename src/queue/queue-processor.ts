/**
 * Queue processor — dequeues items and dispatches them to handlers.
 *
 * Enforces per-thread FIFO ordering and prevents interleaved runs for the
 * same thread. On failure, applies exponential backoff retry or dead-letters
 * the item if max attempts have been exhausted.
 */

import type pino from 'pino';
import { ok, err, type Result } from 'neverthrow';
import { QueueError } from '../core/errors/index.js';
import type { QueueRepository } from '../core/database/repositories/queue-repository.js';
import type { calculateBackoff } from './retry-strategy.js';
import type { DeadLetterHandler } from './dead-letter.js';
import { type QueueItem } from './queue-types.js';
import { rowToQueueItem } from './queue-mapper.js';

/**
 * Processes queue items with retry and dead-letter support.
 *
 * Key invariants:
 * - Items within a thread are processed in FIFO (oldest-first) order.
 * - Only one item per thread may be claimed at a time (no interleaved runs).
 * - Failures increment the attempt counter and schedule the next retry.
 * - Items that exhaust max attempts are moved to the dead-letter queue.
 */
export class QueueProcessor {
  constructor(
    private readonly queueRepo: QueueRepository,
    private readonly retryStrategy: typeof calculateBackoff,
    private readonly deadLetterHandler: DeadLetterHandler,
    private readonly logger: pino.Logger,
    private readonly backoffBaseMs: number = 1000,
    private readonly backoffMaxMs: number = 60_000,
  ) {}

  /**
   * Claims and processes the next available item for any eligible thread.
   *
   * Iterates through threads that have pending/retryable items and attempts
   * to claim the oldest one. A thread is skipped if it already has a
   * claimed or processing item (preventing interleaved runs).
   *
   * The caller-supplied `handler` receives the claimed item and must return
   * a Result. If the handler succeeds the item is completed; if it fails
   * the item is failed (with retry or dead-letter logic applied).
   *
   * @param handler - Async function that processes the item.
   * @returns The claimed QueueItem, or null if nothing was available.
   */
  async processNext(
    handler: (item: QueueItem) => Promise<Result<void, Error>>,
  ): Promise<QueueItem | null> {
    // Find all pending items to discover eligible thread IDs.
    const pendingResult = this.queueRepo.findPending();
    if (pendingResult.isErr()) {
      this.logger.error({ err: pendingResult.error }, 'processNext: failed to find pending items');
      return null;
    }

    const pending = pendingResult.value;
    if (pending.length === 0) {
      return null;
    }

    // Build a deduplicated list of thread IDs preserving FIFO order, and track
    // the type of the oldest pending item per thread.
    // findPending orders by created_at ASC, so the first occurrence of each
    // thread ID corresponds to the oldest eligible item for that thread.
    const seenThreads = new Set<string>();
    const threadIds: string[] = [];
    const oldestPendingTypeByThread = new Map<string, string>();
    for (const row of pending) {
      if (!seenThreads.has(row.thread_id)) {
        seenThreads.add(row.thread_id);
        threadIds.push(row.thread_id);
        oldestPendingTypeByThread.set(row.thread_id, row.type);
      }
    }

    for (const threadId of threadIds) {
      // Collaboration items are dispatched to a different persona and may be
      // submitted while the source thread's current run is in-flight (when a
      // persona calls persona_send with await_reply: true and waits for the
      // result). To prevent a deadlock, collaboration items bypass the
      // per-thread single-inflight invariant.
      const isCollaboration = oldestPendingTypeByThread.get(threadId) === 'collaboration';

      if (!isCollaboration) {
        // Enforce the "no interleaved runs" invariant: skip threads that already
        // have a claimed or processing item in flight.
        const inflightResult = this.queueRepo.hasInflightItem(threadId);
        if (inflightResult.isErr()) {
          this.logger.error(
            { err: inflightResult.error, threadId },
            'processNext: failed to check inflight items',
          );
          continue;
        }
        if (inflightResult.value) {
          continue;
        }
      }

      // Atomically claim the next item for this thread.
      const claimResult = this.queueRepo.claimNext(threadId);
      if (claimResult.isErr()) {
        this.logger.error(
          { err: claimResult.error, threadId },
          'processNext: failed to claim item',
        );
        continue;
      }

      const row = claimResult.value;
      if (!row) {
        // Another worker may have claimed it concurrently.
        continue;
      }

      const item = rowToQueueItem(row);
      this.logger.info({ itemId: item.id, threadId, type: item.type }, 'queue item claimed');

      // Dispatch to handler.
      let handlerResult: Result<void, Error>;
      try {
        handlerResult = await handler(item);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        handlerResult = err(new Error(message));
      }

      if (handlerResult.isOk()) {
        const completeResult = this.complete(item.id);
        if (completeResult.isErr()) {
          this.logger.error(
            { err: completeResult.error, itemId: item.id },
            'processNext: failed to complete item',
          );
        }
      } else {
        const failResult = this.fail(item.id, handlerResult.error.message);
        if (failResult.isErr()) {
          this.logger.error(
            { err: failResult.error, itemId: item.id },
            'processNext: failed to record item failure',
          );
        }
      }

      return item;
    }

    return null;
  }

  /**
   * Marks a queue item as successfully completed.
   *
   * @param itemId - Primary key of the claimed item.
   * @returns Ok(void) on success, or a QueueError.
   */
  complete(itemId: string): Result<void, QueueError> {
    const result = this.queueRepo.complete(itemId);
    if (result.isErr()) {
      return err(
        new QueueError(
          `Failed to complete queue item ${itemId}: ${result.error.message}`,
          result.error,
        ),
      );
    }
    this.logger.info({ itemId }, 'queue item completed');
    return ok(undefined);
  }

  /**
   * Records a failure on a queue item and applies retry or dead-letter logic.
   *
   * Reads the current item to determine remaining attempts, then either
   * schedules a retry (via the retry strategy) or moves the item to the
   * dead-letter queue if max attempts have been exhausted.
   *
   * @param itemId - Primary key of the claimed item.
   * @param error  - Human-readable error description.
   * @returns Ok(void) on success, or a QueueError.
   */
  fail(itemId: string, error: string): Result<void, QueueError> {
    const findResult = this.queueRepo.findById(itemId);
    if (findResult.isErr()) {
      return err(
        new QueueError(
          `Failed to read queue item ${itemId}: ${findResult.error.message}`,
          findResult.error,
        ),
      );
    }

    const row = findResult.value;
    if (!row) {
      return err(new QueueError(`Queue item not found: ${itemId}`));
    }

    const newAttempts = row.attempts + 1;

    if (newAttempts >= row.max_attempts) {
      // Exhausted all retries — dead-letter the item.
      const dlResult = this.deadLetterHandler.moveToDeadLetter(itemId, error);
      if (dlResult.isErr()) {
        return err(
          new QueueError(
            `Failed to dead-letter item ${itemId}: ${dlResult.error.message}`,
            dlResult.error,
          ),
        );
      }
      this.logger.warn(
        { itemId, attempts: newAttempts, maxAttempts: row.max_attempts },
        'queue item dead-lettered after exhausting retries',
      );
      return ok(undefined);
    }

    // Schedule the next retry using exponential backoff.
    const delayMs = this.retryStrategy(row.attempts, this.backoffBaseMs, this.backoffMaxMs);
    const nextRetryAt = Date.now() + delayMs;

    const result = this.queueRepo.fail(itemId, error, nextRetryAt);
    if (result.isErr()) {
      return err(
        new QueueError(
          `Failed to record failure for queue item ${itemId}: ${result.error.message}`,
          result.error,
        ),
      );
    }

    this.logger.warn(
      { itemId, attempts: newAttempts, nextRetryAt, error },
      'queue item failed, scheduled for retry',
    );
    return ok(undefined);
  }
}
