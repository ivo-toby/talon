/**
 * Queue manager — high-level orchestration of the durable work queue.
 *
 * Provides the public API for enqueueing work items and running the
 * background processing loop. The processing loop polls for available items
 * at a configurable interval and dispatches them to the registered handler.
 */

import { v4 as uuidv4 } from 'uuid';
import type pino from 'pino';
import { ok, err, type Result } from 'neverthrow';
import { QueueError } from '../core/errors/index.js';
import type { QueueRepository } from '../core/database/repositories/queue-repository.js';
import type { ThreadRepository } from '../core/database/repositories/thread-repository.js';
import type { ChannelRepository } from '../core/database/repositories/channel-repository.js';
import { calculateBackoff } from './retry-strategy.js';
import { DeadLetterHandler } from './dead-letter.js';
import {
  logQueueDiagnostic,
  QueueProcessor,
  type QueueDiagnosticResolver,
  type VoiceQueueClaimer,
} from './queue-processor.js';
import { type QueueItem, QueueItemStatus } from './queue-types.js';
import { rowToQueueItem } from './queue-mapper.js';
import {
  classifyVoiceChannelType,
  type VoicePrivacyClassification,
} from '../observability/langfuse/voice-observation.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for the queue processing loop. */
export interface QueueConfig {
  /** Maximum number of processing attempts before dead-lettering. */
  maxAttempts: number;
  /** Base backoff delay in milliseconds for retry calculation. */
  backoffBaseMs: number;
  /** Maximum backoff delay in milliseconds (upper cap before jitter). */
  backoffMaxMs: number;
  /** Maximum number of items that may be processed concurrently. */
  concurrencyLimit: number;
}

/** Queue statistics snapshot. */
export interface QueueStats {
  pending: number;
  claimed: number;
  processing: number;
  deadLetter: number;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/** Polling interval for the processing loop in milliseconds. */
const POLL_INTERVAL_MS = 500;

/** Build the server-owned queue diagnostic resolver from persisted repositories. */
export function createQueueDiagnosticResolver(
  threadRepo: Pick<ThreadRepository, 'findById'>,
  channelRepo: Pick<ChannelRepository, 'findById'>,
): QueueDiagnosticResolver {
  const resolveThread = (threadId: string): VoicePrivacyClassification => {
    try {
      const threadResult = threadRepo.findById(threadId);
      if (threadResult.isErr() || threadResult.value === null) return 'unknown';
      const channelResult = channelRepo.findById(threadResult.value.channel_id);
      if (channelResult.isErr() || channelResult.value === null) return 'unknown';
      return classifyVoiceChannelType(channelResult.value.type);
    } catch {
      return 'unknown';
    }
  };

  return {
    resolveThread,
    resolveRow: (row) => resolveThread(row.thread_id),
  };
}

function classifyQueueThread(
  resolver: QueueDiagnosticResolver,
  threadId: string,
): VoicePrivacyClassification {
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
 * Internal marker: the enqueue write or a companion commit write produced an
 * Err inside the transaction. Thrown only inside `enqueueWithCommit`'s
 * transaction callback so that `BaseRepository.transaction` rolls back; the
 * original error is restored at the public boundary.
 */
class EnqueueRollback extends Error {
  constructor(readonly inner: Error) {
    super(inner.message);
    this.name = 'EnqueueRollback';
  }
}

/**
 * Orchestrates enqueueing, background processing, and queue statistics.
 *
 * The processing loop calls `QueueProcessor.processNext` on each tick and
 * respects the concurrency limit by tracking the number of items currently
 * being processed.
 */
export class QueueManager {
  private readonly processor: QueueProcessor;
  private readonly deadLetterHandler: DeadLetterHandler;
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private activeCount = 0;
  /** Slots released by runs that are waiting on delegated work. */
  private suspendedCount = 0;
  /** Concurrent waiter count per key (run id) so one run frees at most one slot. */
  private readonly suspendedKeys = new Map<string, number>();

  constructor(
    private readonly queueRepo: QueueRepository,
    private readonly threadRepo: ThreadRepository,
    private readonly config: QueueConfig,
    private readonly logger: pino.Logger,
    voiceClaimer?: VoiceQueueClaimer,
    private readonly diagnosticResolver?: QueueDiagnosticResolver,
  ) {
    this.deadLetterHandler = new DeadLetterHandler(queueRepo, logger, diagnosticResolver);
    this.processor = new QueueProcessor(
      queueRepo,
      calculateBackoff,
      this.deadLetterHandler,
      logger,
      config.backoffBaseMs,
      config.backoffMaxMs,
      voiceClaimer,
      diagnosticResolver,
    );
  }

  /**
   * Adds a new item to the work queue.
   *
   * Validates that the referenced thread exists before inserting. The item is
   * created with status 'pending' and the configured max attempts.
   *
   * @param threadId  - The thread that owns this work item.
   * @param type      - Payload category ('message' | 'schedule' | 'collaboration').
   * @param payload   - Type-specific data for the handler.
   * @param messageId - Optional message that triggered this item.
   * @returns Ok(QueueItem) on success, or a QueueError.
   */
  enqueue(
    threadId: string,
    type: 'message' | 'schedule' | 'collaboration',
    payload: Record<string, unknown>,
    messageId?: string,
  ): Result<QueueItem, QueueError> {
    // Verify the thread exists.
    const threadResult = this.threadRepo.findById(threadId);
    if (threadResult.isErr()) {
      return err(
        new QueueError(
          `Failed to look up thread ${threadId}: ${threadResult.error.message}`,
          threadResult.error,
        ),
      );
    }
    if (!threadResult.value) {
      return err(new QueueError(`Thread not found: ${threadId}`));
    }

    const result = this.queueRepo.enqueue({
      id: uuidv4(),
      thread_id: threadId,
      message_id: messageId ?? null,
      type,
      payload: JSON.stringify(payload),
      max_attempts: this.config.maxAttempts,
    });

    if (result.isErr()) {
      return err(
        new QueueError(
          `Failed to enqueue item for thread ${threadId}: ${result.error.message}`,
          result.error,
        ),
      );
    }

    const item = rowToQueueItem(result.value);
    const privacy = this.diagnosticResolver
      ? classifyQueueThread(this.diagnosticResolver, threadId)
      : 'unknown';
    logQueueDiagnostic(
      this.logger,
      privacy,
      'info',
      { itemId: item.id, threadId, type },
      'queue item enqueued',
    );
    return ok(item);
  }

  /**
   * Enqueues a work item and commits caller-owned companion writes atomically
   * with it, on the same database transaction.
   *
   * The `commit` callback runs inside the enqueue transaction (synchronous,
   * never awaited) with the freshly created item and may write companion
   * ledger rows — for example marking an image Ingestion completed with this
   * queue item id. If the enqueue write or the callback fails, the whole
   * transaction rolls back: no queue item, no companion rows, and NO success
   * log. The success log fires only after the outer transaction commits,
   * which is what makes "enqueued" a durable fact (inventory I4).
   *
   * Ordinary `enqueue()` keeps its existing autocommit behavior and logging;
   * only callers that need commit-together semantics use this API.
   *
   * @param threadId    - The thread that owns this work item.
   * @param type        - Payload category ('message' | 'schedule' | 'collaboration').
   * @param payload     - Type-specific data for the handler.
   * @param messageId   - Optional message that triggered this item.
   * @param commit      - Synchronous companion write, committed with the item.
   * @returns Ok({ item, value }) after commit, or a QueueError (no log, rolled back).
   */
  enqueueWithCommit<T>(
    threadId: string,
    type: 'message' | 'schedule' | 'collaboration',
    payload: Record<string, unknown>,
    messageId: string | undefined,
    commit: (item: QueueItem) => Result<T, Error>,
  ): Result<{ item: QueueItem; value: T }, QueueError> {
    // Nested-invocation fence. Inside an enclosing transaction (including a
    // raw queueRepo.transaction() savepoint) this method's own transaction
    // degrades to a savepoint: it would return Ok while the OUTER transaction
    // can still roll back later, emitting a success log for a phantom queue
    // item. "Committed" must equal durable here, so refuse nested use
    // instead of deferring the log to an outer commit this class cannot see.
    if (this.queueRepo.inTransaction) {
      return err(
        new QueueError(
          `enqueueWithCommit cannot run inside an enclosing transaction (thread ${threadId}): ` +
            'commit-together semantics require a top-level transaction',
        ),
      );
    }

    const threadResult = this.threadRepo.findById(threadId);
    if (threadResult.isErr()) {
      return err(
        new QueueError(
          `Failed to look up thread ${threadId}: ${threadResult.error.message}`,
          threadResult.error,
        ),
      );
    }
    if (!threadResult.value) {
      return err(new QueueError(`Thread not found: ${threadId}`));
    }

    let committed: { item: QueueItem; value: T };
    try {
      committed = this.queueRepo.transaction(() => {
        const result = this.queueRepo.enqueue({
          id: uuidv4(),
          thread_id: threadId,
          message_id: messageId ?? null,
          type,
          payload: JSON.stringify(payload),
          max_attempts: this.config.maxAttempts,
        });
        if (result.isErr()) {
          throw new EnqueueRollback(result.error);
        }
        const item = rowToQueueItem(result.value);
        const hookResult = commit(item);
        if (hookResult.isErr()) {
          throw new EnqueueRollback(hookResult.error);
        }
        return { item, value: hookResult.value };
      });
    } catch (cause) {
      if (cause instanceof EnqueueRollback) {
        return err(
          new QueueError(
            `Failed to enqueue item for thread ${threadId}: ${cause.inner.message}`,
            cause.inner,
          ),
        );
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      return err(
        new QueueError(
          `Failed to enqueue item for thread ${threadId}: ${message}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }

    // Success log only after the transaction committed; rollback never logs.
    this.logger.info(
      { itemId: committed.item.id, threadId, type },
      'queue item enqueued',
    );
    return ok(committed);
  }

  /**
   * Starts the background processing loop.
   *
   * On each poll tick, up to `concurrencyLimit - activeCount` new items are
   * dispatched. The loop runs until `stopProcessing()` is called.
   *
   * @param handler - Async function invoked for each claimed queue item.
   */
  startProcessing(handler: (item: QueueItem) => Promise<Result<void, Error>>): void {
    if (this.loopTimer !== null) {
      this.logger.warn('startProcessing called while loop is already running');
      return;
    }

    this.logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'queue processing loop started');

    this.loopTimer = setInterval(() => {
      void this.tick(handler);
    }, POLL_INTERVAL_MS);
  }

  /**
   * Stops the processing loop.
   *
   * Any items currently being processed will run to completion; no new items
   * will be claimed after this call.
   */
  stopProcessing(): void {
    if (this.loopTimer !== null) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
      this.logger.info('queue processing loop stopped');
    }
  }

  /**
   * Returns a snapshot of queue item counts by status.
   */
  stats(): QueueStats {
    const result = this.queueRepo.countByStatus();
    if (result.isErr()) {
      logQueueDiagnostic(this.logger, 'unknown', 'error', {}, 'failed to read queue stats');
      return { pending: 0, claimed: 0, processing: 0, deadLetter: 0 };
    }

    const counts = result.value;
    return {
      pending: counts[QueueItemStatus.Pending] ?? 0,
      claimed: counts[QueueItemStatus.Claimed] ?? 0,
      processing: counts[QueueItemStatus.Processing] ?? 0,
      deadLetter: counts[QueueItemStatus.DeadLetter] ?? 0,
    };
  }

  /**
   * Runs `fn` while the caller's queue slot is made available to other items.
   *
   * Used by long waits (A2A await_reply / task_status polling) executed from
   * inside a queue-dispatched run: the waiting parent would otherwise hold a
   * slot while its delegated children cannot get one. The slot is restored in
   * `finally`; the waiter resuming may briefly oversubscribe the limit.
   *
   * The released count is clamped to the number of active items, so it can
   * never go negative or exceed `activeCount`. When `key` is given (e.g. the
   * run id), only the first concurrent waiter for that key frees a slot, so
   * parallel tool calls from one run cannot free more than the one slot it
   * holds. Callers that do not hold a slot must not call this.
   */
  async runWithSlotReleased<T>(fn: () => Promise<T>, key?: string): Promise<T> {
    const holders = key === undefined ? 0 : (this.suspendedKeys.get(key) ?? 0);
    if (key !== undefined) {
      this.suspendedKeys.set(key, holders + 1);
    }
    // Only the first waiter for a key frees a slot.
    const freesSlot = holders === 0;
    if (freesSlot) {
      this.suspendedCount++;
    }
    try {
      return await fn();
    } finally {
      let restore = freesSlot;
      if (key !== undefined) {
        const remaining = (this.suspendedKeys.get(key) ?? 1) - 1;
        if (remaining <= 0) {
          this.suspendedKeys.delete(key);
          // Last waiter for the key ends: restore the one slot it freed.
          restore = true;
        } else {
          this.suspendedKeys.set(key, remaining);
          restore = false;
        }
      }
      if (restore) {
        this.suspendedCount = Math.max(0, this.suspendedCount - 1);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Number of slots currently released by waiting runs, clamped to [0, activeCount]. */
  private get effectiveSuspended(): number {
    return Math.min(Math.max(0, this.suspendedCount), this.activeCount);
  }

  /**
   * Single processing loop tick: dispatches items up to the concurrency limit.
   */
  private async tick(
    handler: (item: QueueItem) => Promise<Result<void, Error>>,
  ): Promise<void> {
    const slots = this.config.concurrencyLimit - (this.activeCount - this.effectiveSuspended);
    if (slots <= 0) {
      return;
    }

    // Dispatch up to `slots` items in parallel.
    const dispatches: Promise<QueueItem | null>[] = [];
    for (let i = 0; i < slots; i++) {
      dispatches.push(this.dispatchOne(handler));
    }

    await Promise.all(dispatches);
  }

  /**
   * Claims and processes a single item, tracking the active count.
   */
  private async dispatchOne(
    handler: (item: QueueItem) => Promise<Result<void, Error>>,
  ): Promise<QueueItem | null> {
    this.activeCount++;
    try {
      return await this.processor.processNext(handler);
    } finally {
      this.activeCount--;
    }
  }
}
