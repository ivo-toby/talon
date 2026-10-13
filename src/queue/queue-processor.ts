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
import type {
  QueueItemRow,
  QueueRepository,
} from '../core/database/repositories/queue-repository.js';
import type { calculateBackoff } from './retry-strategy.js';
import type { DeadLetterHandler } from './dead-letter.js';
import { isVoiceQueuePayload, type QueueItem } from './queue-types.js';
import { rowToQueueItem } from './queue-mapper.js';
import type { VoicePrivacyClassification } from '../observability/langfuse/voice-observation.js';

/**
 * Claims a voice queue row through VoiceStore's delegation CAS boundary.
 * Returning null means another lifecycle transition won the race and the
 * generic queue must not claim the row afterwards.
 */
export type VoiceQueueClaimer = (row: QueueItemRow) => Result<QueueItemRow | null, Error>;

/** Server-owned persisted channel classification for queue diagnostics. */
export interface QueueDiagnosticResolver {
  resolveThread(threadId: string): VoicePrivacyClassification;
  resolveRow(row: QueueItemRow): VoicePrivacyClassification;
}

type QueueLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'trace';

const SAFE_QUEUE_LOG_KEYS = new Set([
  'itemId',
  'threadId',
  'type',
  'attempts',
  'maxAttempts',
  'nextRetryAt',
]);

/** Keep queue diagnostics content-free when persisted channel state is voice or unknown. */
export function logQueueDiagnostic(
  logger: pino.Logger,
  privacy: VoicePrivacyClassification,
  level: QueueLogLevel,
  fields: Record<string, unknown>,
  message: string,
): void {
  const emit = (payload: Record<string, unknown>, text: string): void => {
    try {
      logger[level](payload, text);
    } catch {
      // Queue diagnostics are best effort; never change a transition or retry outcome.
    }
  };
  if (privacy === 'nonvoice') {
    emit(fields, message);
    return;
  }

  const safeFields: Record<string, string | number | boolean> = {
    voice: true,
    errorCategory: 'unknown',
  };
  for (const [key, value] of Object.entries(fields)) {
    if (
      SAFE_QUEUE_LOG_KEYS.has(key) &&
      (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    ) {
      safeFields[key] = value;
    }
  }
  emit(safeFields, 'queue diagnostic event');
}

export function classifyQueueRow(
  resolver: QueueDiagnosticResolver | undefined,
  row: QueueItemRow | undefined,
): VoicePrivacyClassification {
  if (!resolver || !row) return 'unknown';
  try {
    const classification = resolver.resolveRow(row);
    return classification === 'voice' || classification === 'nonvoice' || classification === 'unknown'
      ? classification
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

function classifyThread(
  resolver: QueueDiagnosticResolver | undefined,
  threadId: string,
): VoicePrivacyClassification {
  if (!resolver) return 'unknown';
  try {
    const classification = resolver.resolveThread(threadId);
    return classification === 'voice' || classification === 'nonvoice' || classification === 'unknown'
      ? classification
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Processes queue items with retry and dead-letter support.
 *
 * Key invariants:
 * - Items within a thread are processed in FIFO (oldest-first) order.
 * - Only one item per thread may be claimed at a time (no interleaved runs).
 *   Exception: a collaboration item may be claimed for a thread that already
 *   has an in-flight item, to prevent persona_send await_reply deadlocks.
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
    private readonly voiceClaimer?: VoiceQueueClaimer,
    private readonly diagnosticResolver?: QueueDiagnosticResolver,
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
      logQueueDiagnostic(
        this.logger,
        'unknown',
        'error',
        {},
        'processNext: failed to find pending items',
      );
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
    const pendingRowsByThread = new Map<string, QueueItemRow[]>();
    for (const row of pending) {
      const rows = pendingRowsByThread.get(row.thread_id) ?? [];
      rows.push(row);
      pendingRowsByThread.set(row.thread_id, rows);
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
      const threadPendingRows = pendingRowsByThread.get(threadId) ?? [];
      const oldestRow = threadPendingRows[0];
      const oldestIsVoice = oldestRow !== undefined && isVoiceQueueRow(oldestRow);
      const collaborationRow = threadPendingRows.find((row) => row.type === 'collaboration');
      const collaborationIsVoice =
        collaborationRow !== undefined && isVoiceQueueRow(collaborationRow);
      // Collaboration items are dispatched to a different persona and may be
      // submitted while the source thread's current run is in-flight (when a
      // persona calls persona_send with await_reply: true and waits for the
      // result). To prevent a deadlock, collaboration items bypass the
      // per-thread single-inflight invariant.
      const oldestIsCollaboration = oldestPendingTypeByThread.get(threadId) === 'collaboration';

      // Whether to claim only a collaboration item — determined below only
      // when the thread is confirmed to be in-flight.
      let claimCollaborationOnly = false;

      if (!oldestIsCollaboration || oldestIsVoice) {
        // Enforce the "no interleaved runs" invariant: skip threads that already
        // have a claimed or processing item in flight — unless we can bypass by
        // claiming a collaboration item specifically.
        const inflightResult = this.queueRepo.hasInflightItem(threadId);
        if (inflightResult.isErr()) {
          logQueueDiagnostic(
            this.logger,
            classifyThread(this.diagnosticResolver, threadId),
            'error',
            { err: inflightResult.error, threadId },
            'processNext: failed to check inflight items',
          );
          continue;
        }
        if (inflightResult.value) {
          // Thread is busy. Check whether a collaboration item is pending
          // further back in the queue — if so we can bypass the block and claim
          // just the collaboration item to avoid deadlock.
          if (!threadsWithPendingCollaboration.has(threadId) || collaborationIsVoice) {
            // No collaboration item waiting — skip the thread entirely.
            continue;
          }
          // Collaboration item is pending behind a regular item. Fall through
          // and use the type-filtered claim.
          claimCollaborationOnly = true;
        }
      }

      // Re-check inflight status immediately before the type-filtered claim to
      // guard against a TOCTOU race: if the thread finished between the initial
      // check and now, skip the bypass so we don't jump a regular FIFO item.
      if (claimCollaborationOnly) {
        const inflightRecheckResult = this.queueRepo.hasInflightItem(threadId);
        if (inflightRecheckResult.isErr()) {
          logQueueDiagnostic(
            this.logger,
            classifyThread(this.diagnosticResolver, threadId),
            'error',
            { err: inflightRecheckResult.error, threadId },
            'processNext: failed to re-check inflight items before claim',
          );
          continue;
        }
        if (!inflightRecheckResult.value) {
          // Thread is no longer in-flight; do not bypass the regular FIFO item.
          claimCollaborationOnly = false;
        }
      }

      // Atomically claim the next item for this thread.
      // When the thread is in-flight and we must unblock a collaboration item,
      // use the type-filtered claim so we don't accidentally claim the regular
      // pending item that is blocked behind the in-flight one.
      const candidateRow = claimCollaborationOnly ? collaborationRow : oldestRow;
      const candidateIsVoice = candidateRow !== undefined && isVoiceQueueRow(candidateRow);
      let claimResult: Result<QueueItemRow | null, Error>;
      if (candidateIsVoice) {
        if (!this.voiceClaimer) {
          logQueueDiagnostic(
            this.logger,
            classifyQueueRow(this.diagnosticResolver, candidateRow),
            'warn',
            { itemId: candidateRow.id, threadId },
            'processNext: voice queue item has no transactional claimer',
          );
          continue;
        }
        claimResult = this.voiceClaimer(candidateRow);
      } else {
        claimResult = claimCollaborationOnly
          ? this.queueRepo.claimNextCollaboration(threadId)
          : this.queueRepo.claimNext(threadId);
      }
      if (claimResult.isErr()) {
        logQueueDiagnostic(
          this.logger,
          classifyQueueRow(this.diagnosticResolver, candidateRow),
          'error',
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
      logQueueDiagnostic(
        this.logger,
        classifyQueueRow(this.diagnosticResolver, row),
        'info',
        { itemId: item.id, threadId, type: item.type },
        'queue item claimed',
      );

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
          logQueueDiagnostic(
            this.logger,
            classifyQueueRow(this.diagnosticResolver, row),
            'error',
            { err: completeResult.error, itemId: item.id, threadId: item.threadId },
            'processNext: failed to complete item',
          );
        }
      } else {
        const failResult = this.fail(item.id, handlerResult.error.message);
        if (failResult.isErr()) {
          logQueueDiagnostic(
            this.logger,
            classifyQueueRow(this.diagnosticResolver, row),
            'error',
            { err: failResult.error, itemId: item.id, threadId: item.threadId },
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
    const rowResult = this.queueRepo.findById(itemId);
    const privacy = rowResult.isOk() && rowResult.value
      ? classifyQueueRow(this.diagnosticResolver, rowResult.value)
      : 'unknown';
    logQueueDiagnostic(this.logger, privacy, 'info', { itemId }, 'queue item completed');
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
      logQueueDiagnostic(
        this.logger,
        classifyQueueRow(this.diagnosticResolver, row),
        'warn',
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

    logQueueDiagnostic(
      this.logger,
      classifyQueueRow(this.diagnosticResolver, row),
      'warn',
      { itemId, attempts: newAttempts, nextRetryAt, error },
      'queue item failed, scheduled for retry',
    );
    return ok(undefined);
  }
}

function isVoiceQueueRow(row: QueueItemRow): boolean {
  try {
    return isVoiceQueuePayload(JSON.parse(row.payload) as unknown);
  } catch {
    return false;
  }
}
