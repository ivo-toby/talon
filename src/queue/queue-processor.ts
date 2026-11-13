/**
 * Queue processor — dequeues items and dispatches them to handlers.
 *
 * Enforces per-thread FIFO ordering and prevents interleaved runs for the
 * same thread. On failure, applies exponential backoff retry or dead-letters
 * the item if max attempts have been exhausted.
 */

import type pino from 'pino';
import { ok, err, type Result } from 'neverthrow';
import {
  DbError,
  DeliveryCancelled,
  DeliveryDeferredError,
  NonRetryableRunError,
  QueueError,
  SignalDeliveryError,
} from '../core/errors/index.js';
import { SignalStateError } from '../core/database/repositories/signal-account-state-repository.js';
import {
  SignalCheckpointError,
  type SignalDeliveryCheckpoint,
} from './signal-delivery-checkpoint.js';
import type { SignalQueueFailure } from './signal-delivery-state.js';
import type { QueueRepository } from '../core/database/repositories/queue-repository.js';
import type { calculateBackoff } from './retry-strategy.js';
import type { DeadLetterHandler } from './dead-letter.js';
import type { QueueItem, QueueHandler, SavedSignalDeliveryHandler } from './queue-types.js';
import { rowToQueueItem } from './queue-mapper.js';

/**
 * Sentinel error a handler may return to defer an item without consuming a
 * retry attempt (e.g. waiting for A2A admission). The item returns to
 * 'pending' and is retried after `delayMs`. Deferral never dead-letters.
 */
export class QueueDeferral extends Error {
  constructor(
    message: string,
    public readonly delayMs: number = 2000,
  ) {
    super(message);
    this.name = 'QueueDeferral';
  }
}

/**
 * Processes queue items with retry and dead-letter support.
 *
 * Key invariants:
 * - Items within a thread are processed in FIFO (oldest-first) order.
 * - Ordinary dispatches exclude their thread through handler and state settlement,
 *   even if the durable row is completed or purged before the dispatch returns.
 *   Exception: a collaboration item may bypass an active thread to prevent
 *   persona_send await_reply deadlocks.
 * - Ordinary provider failures increment attempts; saved delivery never does.
 * - Items that exhaust max attempts are moved to the dead-letter queue.
 */
export class QueueProcessor {
  // Per-instance live ownership, not a durable/cross-process claim. A handler may
  // complete or purge its row before its remaining work and local retries settle.
  private readonly activeOrdinaryThreads = new Set<string>();

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
   * to claim the oldest one. Ordinary work is skipped if its thread has a live
   * ordinary dispatch or a claimed/processing row (preventing interleaved runs).
   *
   * The caller-supplied `handler` receives the claimed item and must return
   * a Result. If the handler succeeds the item is completed; if it fails
   * the item is failed (with retry or dead-letter logic applied).
   *
   * @param handler - Async function that processes the item.
   * @returns The claimed QueueItem, or null if nothing was available.
   */
  async processNext(
    handler: QueueHandler,
    savedDeliveryHandler?: SavedSignalDeliveryHandler,
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
    // per-thread pending item characteristics.
    // findPending orders by created_at ASC, so the first occurrence of each
    // thread ID corresponds to the oldest eligible item for that thread.
    const seenThreads = new Set<string>();
    const threadIds: string[] = [];
    const oldestPendingTypeByThread = new Map<string, string>();
    const threadsWithPendingCollaboration = new Set<string>();
    for (const row of pending) {
      if (!seenThreads.has(row.thread_id)) {
        seenThreads.add(row.thread_id);
        threadIds.push(row.thread_id);
        oldestPendingTypeByThread.set(row.thread_id, row.type);
      }
      if (row.type === 'collaboration') {
        threadsWithPendingCollaboration.add(row.thread_id);
      }
    }

    for (const threadId of threadIds) {
      // Collaboration items are dispatched to a different persona and may be
      // submitted while the source thread's current run is in-flight (when a
      // persona calls persona_send with await_reply: true and waits for the
      // result). To prevent a deadlock, collaboration items bypass the
      // per-thread single-inflight invariant.
      const oldestIsCollaboration = oldestPendingTypeByThread.get(threadId) === 'collaboration';

      // Whether to claim only collaboration — when durable or live ownership
      // still excludes ordinary work on this thread.
      let claimCollaborationOnly = false;

      if (!oldestIsCollaboration) {
        // Durable inflight rows and full live ordinary dispatches both exclude
        // ordinary work; only a specifically claimed collaboration may bypass.
        const inflightResult = this.queueRepo.hasInflightItem(threadId);
        if (inflightResult.isErr()) {
          this.logger.error(
            { err: inflightResult.error, threadId },
            'processNext: failed to check inflight items',
          );
          continue;
        }
        if (inflightResult.value || this.activeOrdinaryThreads.has(threadId)) {
          // Thread is busy. Check whether a collaboration item is pending
          // further back in the queue — if so we can bypass the block and claim
          // just the collaboration item to avoid deadlock.
          if (!threadsWithPendingCollaboration.has(threadId)) {
            // No collaboration item waiting — skip the thread entirely.
            continue;
          }
          // Collaboration item is pending behind a regular item. Fall through
          // and use the type-filtered claim.
          claimCollaborationOnly = true;
        }
      }

      // Re-check both ownership sources before a type-filtered claim. SQL
      // completion alone cannot disable bypass while the ordinary tail is live.
      if (claimCollaborationOnly) {
        const inflightRecheckResult = this.queueRepo.hasInflightItem(threadId);
        if (inflightRecheckResult.isErr()) {
          this.logger.error(
            { err: inflightRecheckResult.error, threadId },
            'processNext: failed to re-check inflight items before claim',
          );
          continue;
        }
        if (!inflightRecheckResult.value && !this.activeOrdinaryThreads.has(threadId)) {
          // Neither owner remains; do not bypass the regular FIFO item.
          claimCollaborationOnly = false;
        }
      }

      // Head collaboration also requires a type-filtered claim: saved wall-time
      // eligibility may change after discovery. An unfiltered claim could then
      // select ordinary work through the collaboration-only admission path.
      const claimResult =
        claimCollaborationOnly || oldestIsCollaboration
          ? this.queueRepo.claimNextCollaboration(threadId)
          : this.queueRepo.claimNext(threadId);
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

      // Claim/admission and live ownership are synchronous up to the first await.
      // Collaboration owns no ordinary slot, so its cleanup cannot release one.
      const ordinaryDispatch = row.type !== 'collaboration';
      if (ordinaryDispatch) this.activeOrdinaryThreads.add(threadId);
      try {
        const item = rowToQueueItem(row);
        this.logger.info({ itemId: item.id, threadId, type: item.type }, 'queue item claimed');

        // Inspect persisted bytes before mapping/caller state can hide a reserved replay boundary.
        const inspection = await this.retryStateWrite(() =>
          this.queueRepo.inspectSignalDelivery(item.id, Date.now()),
        );
        if (inspection.isErr()) {
          if (inspection.error instanceof SignalCheckpointError) {
            await this.retryStateWrite(() => this.queueRepo.rejectSignalReplay(item.id, Date.now()));
          }
          return item;
        }
        const state = inspection.value;
        if (state.kind === 'invoked') {
          await this.retryStateWrite(() => this.queueRepo.rejectSignalReplay(item.id, Date.now()));
          return item;
        }
        if (
          state.kind === 'checkpoint' &&
          (state.checkpoint.phase === 'in_flight' || state.checkpoint.phase === 'terminal')
        ) {
          // Only quiesced recovery may classify interrupted ownership. Keep the claim out of polling.
          this.logger.warn({ itemId: item.id }, 'saved delivery requires quiesced recovery');
          return item;
        }
        if (
          state.kind === 'checkpoint' &&
          state.checkpoint.phase === 'ready' &&
          state.checkpoint.expiresAt <= Date.now()
        ) {
          await this.retryStateWrite(() => this.deferOrTerminate(state.checkpoint));
          return item;
        }

        let handlerResult: Result<void, Error>;
        try {
          handlerResult =
            state.kind === 'checkpoint'
              ? savedDeliveryHandler === undefined
                ? ok(undefined)
                : await savedDeliveryHandler(item, state.checkpoint)
              : await handler(item);
        } catch (caught) {
          // Preserve typed identity. Unknown throws never become remote diagnostic strings.
          handlerResult = err(caught instanceof Error ? caught : new Error('Queue handler failed'));
        }

        const transition = await this.retryStateWrite(
          () =>
            handlerResult.isErr()
              ? state.kind === 'checkpoint'
                ? this.fail(item.id, handlerResult.error, true)
                : this.fail(item.id, handlerResult.error)
              : this.settleSuccess(item.id, state.kind === 'checkpoint'),
          handlerResult.isErr() ? handlerResult.error : undefined,
        );
        if (transition.isErr() && !(transition.error instanceof DeliveryCancelled)) {
          this.logger.warn({ itemId: item.id }, 'queue state transition refused; no work replayed');
        }

        return item;
      } finally {
        if (ordinaryDispatch) this.activeOrdinaryThreads.delete(threadId);
      }
    }

    return null;
  }

  /** Records typed failures without converting delivery/cancellation into provider retries. */
  fail(
    itemId: string,
    failure: string | Error,
    savedDispatch = false,
  ): Result<void, QueueError | DeliveryCancelled | SignalStateError> {
    if (failure instanceof DeliveryCancelled) return err(failure);
    return this.settle(itemId, failure, savedDispatch);
  }

  private settleSuccess(
    itemId: string,
    savedDispatch: boolean,
  ): Result<void, QueueError | DeliveryCancelled | SignalStateError> {
    return this.settle(itemId, undefined, savedDispatch);
  }

  private settle(
    itemId: string,
    failure?: string | Error,
    savedDispatch = false,
  ): Result<void, QueueError | DeliveryCancelled | SignalStateError> {
    const row = this.queueRepo.findById(itemId);
    if (row.isErr()) return err(new QueueError('Queue state read failed', row.error));
    if (row.value === null) {
      return failure !== undefined &&
        !savedDispatch &&
        !(failure instanceof DeliveryDeferredError) &&
        !(failure instanceof QueueDeferral) &&
        !(failure instanceof NonRetryableRunError) &&
        !(failure instanceof SignalDeliveryError)
        ? err(new QueueError(`Queue item not found: ${itemId}`))
        : err(new DeliveryCancelled());
    }
    // Late completion/failure cannot overwrite an already committed decision.
    if (row.value.status === 'completed' || row.value.status === 'dead_letter')
      return ok(undefined);
    const inspection = this.queueRepo.inspectSignalDelivery(itemId, Date.now());
    if (inspection.isErr()) {
      return inspection.error instanceof SignalCheckpointError
        ? this.queueRepo.rejectSignalReplay(itemId, Date.now())
        : err(inspection.error);
    }
    const state = inspection.value;
    if (state.kind === 'checkpoint') return this.deferOrTerminate(state.checkpoint, failure);
    if (
      state.kind === 'invoked' &&
      (failure !== undefined ||
        savedDispatch ||
        !['explicit', 'progress'].includes(state.marker.purpose))
    ) {
      return this.queueRepo.rejectSignalReplay(itemId, Date.now());
    }
    // A callback must retain and retry its own failed checkpoint/receipt write. We cannot
    // reconstruct that transition from an Error, and must not retry its provider instead.
    if (failure instanceof SignalStateError || failure instanceof SignalCheckpointError) {
      return err(failure);
    }
    if (savedDispatch) return err(new SignalStateError('CONFLICT'));
    if (failure === undefined) {
      // Only this successful execution, which began ordinary, may finish its new tool guard.
      return state.kind === 'invoked' ? this.completeOrdinary(itemId) : this.complete(itemId);
    }
    if (failure instanceof QueueDeferral) {
      // A2A admission wait: back to pending without consuming an attempt. Never dead-letters.
      // Signal-checkpointed or invoked items never reach here (handled above).
      const deferred = this.queueRepo.defer(itemId, Date.now() + failure.delayMs);
      if (deferred.isErr()) return err(new QueueError('Queue state write failed', deferred.error));
      this.logger.debug(
        { itemId, delayMs: failure.delayMs, reason: failure.message },
        'queue item deferred',
      );
      return ok(undefined);
    }
    if (
      failure instanceof NonRetryableRunError ||
      failure instanceof SignalDeliveryError ||
      failure instanceof DeliveryDeferredError
    ) {
      const reason =
        failure instanceof NonRetryableRunError
          ? (failure.deliveryError?.reason ?? 'UNKNOWN_ACCEPTANCE')
          : failure instanceof SignalDeliveryError
            ? failure.reason
            : 'CHECKPOINT_INVALID';
      return this.deadLetterHandler.moveToDeadLetter(itemId, reason);
    }
    return this.failOrdinary(itemId, typeof failure === 'string' ? failure : failure.message);
  }

  private deferOrTerminate(
    checkpoint: SignalDeliveryCheckpoint,
    failure?: string | Error,
  ): Result<void, SignalQueueFailure> {
    const now = Date.now();
    if (checkpoint.phase === 'in_flight' || checkpoint.phase === 'terminal') {
      // Do not repeat the actor, or turn an uncertain saved send into a generic retry/completion.
      return err(new SignalStateError('CONFLICT'));
    }
    const deliveryError =
      failure instanceof NonRetryableRunError || failure instanceof DeliveryDeferredError
        ? failure.deliveryError
        : failure instanceof SignalDeliveryError
          ? failure
          : undefined;
    if (checkpoint.phase === 'ready' && checkpoint.expiresAt <= now) {
      return this.queueRepo
        .terminateSignalDelivery(
          checkpoint,
          new SignalDeliveryError({
            reason: 'CHECKPOINT_EXPIRED',
            outcome: checkpoint.acceptedChunks > 0 ? 'PARTIAL' : 'NOT_SENT',
            acceptedChunks: checkpoint.acceptedChunks,
            currentChunkAcceptance: checkpoint.currentChunkAcceptance,
            successCount: checkpoint.successCount,
            failureCount: checkpoint.failureCount,
            retryScope: 'none',
          }),
          now,
        )
        .map(() => undefined);
    }
    if (
      checkpoint.phase === 'ready' &&
      deliveryError !== undefined &&
      deliveryError.retryScope === 'none'
    ) {
      return this.queueRepo
        .terminateSignalDelivery(checkpoint, deliveryError, now)
        .map(() => undefined);
    }
    const delay = Math.max(
      1_000,
      Math.min(60_000, this.retryStrategy(0, this.backoffBaseMs, this.backoffMaxMs)),
    );
    const hint =
      failure instanceof DeliveryDeferredError ? failure.notBefore : deliveryError?.notBefore;
    return this.queueRepo.deferSignalDelivery(checkpoint, delay, now, hint).map(() => undefined);
  }

  /** Retry only local Result transitions. The handler/actor is never enclosed in this loop. */
  private async retryStateWrite<T, E extends Error>(
    operation: () => Result<T, E>,
    callbackFailure?: Error,
  ): Promise<Result<T, E>> {
    let attempt = 0;
    for (;;) {
      const result = operation();
      if (result.isOk()) return result;
      const failure = result.error;
      if (failure === callbackFailure) return result;
      if (!this.isDatabaseFailure(failure)) return result;
      this.logger.warn('queue state write unavailable; retrying local state only');
      const delay = Math.max(
        1_000,
        Math.min(60_000, this.retryStrategy(attempt, this.backoffBaseMs, this.backoffMaxMs)),
      );
      attempt = Math.min(attempt + 1, 16);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  private isDatabaseFailure(failure: Error): boolean {
    if (failure instanceof SignalStateError) return failure.reason === 'DATABASE';
    if (failure instanceof QueueError && failure.cause !== undefined) {
      return this.isDatabaseFailure(failure.cause);
    }
    return failure instanceof DbError;
  }

  /**
   * Marks a queue item as successfully completed.
   *
   * @param itemId - Primary key of the claimed item.
   * @returns Ok(void) on success, or a QueueError.
   */
  complete(itemId: string): Result<void, QueueError> {
    const row = this.queueRepo.findById(itemId);
    if (row.isErr()) return err(new QueueError('Queue state read failed', row.error));
    // Preserve the historical idempotent generic API, but never bypass saved finalization.
    if (
      row.value === null ||
      row.value.status === 'completed' ||
      row.value.status === 'dead_letter'
    ) {
      return ok(undefined);
    }
    const inspection = this.queueRepo.inspectSignalDelivery(itemId, Date.now());
    if (inspection.isErr())
      return err(
        inspection.error instanceof QueueError
          ? inspection.error
          : new QueueError('Queue completion refused', inspection.error),
      );
    if (inspection.value.kind !== 'ordinary') {
      return err(new QueueError('Signal work requires guarded completion'));
    }
    return this.completeOrdinary(itemId);
  }

  private completeOrdinary(itemId: string): Result<void, QueueError> {
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
  private failOrdinary(itemId: string, error: string): Result<void, QueueError> {
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
