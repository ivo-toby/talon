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
import { calculateBackoff } from './retry-strategy.js';
import { DeadLetterHandler } from './dead-letter.js';
import { QueueProcessor } from './queue-processor.js';
import { type QueueItem, QueueItemStatus } from './queue-types.js';
import { rowToQueueItem } from './queue-mapper.js';
import type { LifecycleRuntime } from '../lifecycle/lifecycle-runtime.js';
import type { LifecycleEventEnvelope, LifecycleItemType } from '../lifecycle/contracts/index.js';
import type { LifecycleEventPublishInput } from '../lifecycle/lifecycle-event-bus.js';
import type { TransactionContext } from '../lifecycle/transaction-context.js';

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

export interface QueueDrainResult {
  readonly status: 'drained' | 'timed_out';
}

/** Bootstrap/pipeline-owned scope; never inferred from arbitrary work payloads. */
export interface LifecycleQueueScope {
  readonly persona: string;
  readonly itemType: Extract<LifecycleItemType, 'message' | 'schedule'>;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/** Polling interval for the processing loop in milliseconds. */
const POLL_INTERVAL_MS = 500;
const DEFAULT_DRAIN_TIMEOUT_MS = 25_000;

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
  private processing = false;
  private readonly activeWork = new Set<Promise<QueueItem | null>>();
  private readonly activeControllers = new Set<AbortController>();

  constructor(
    private readonly queueRepo: QueueRepository,
    private readonly threadRepo: ThreadRepository,
    private readonly config: QueueConfig,
    private readonly logger: pino.Logger,
    private readonly lifecycleRuntime?: LifecycleRuntime,
  ) {
    this.deadLetterHandler = new DeadLetterHandler(queueRepo, logger);
    this.processor = new QueueProcessor(
      queueRepo,
      calculateBackoff,
      this.deadLetterHandler,
      logger,
      config.backoffBaseMs,
      config.backoffMaxMs,
      lifecycleRuntime,
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
    lifecycleScope?: LifecycleQueueScope,
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

    // Producers always supply their trusted scope; disabled mode must remain
    // byte-for-byte on the legacy queue path and retain no lifecycle metadata.
    const enabledLifecycleScope = this.lifecycleRuntime ? lifecycleScope : undefined;
    if (
      this.lifecycleRuntime &&
      (type === 'message' || type === 'schedule') &&
      !enabledLifecycleScope
    ) {
      return err(
        new QueueError(
          'Lifecycle-enabled message and schedule queue items require manager-owned lifecycle scope',
        ),
      );
    }
    const scopeError = this.validateLifecycleScope(type, enabledLifecycleScope);
    if (scopeError) return err(scopeError);
    const input = {
      id: uuidv4(),
      thread_id: threadId,
      message_id: messageId ?? null,
      type,
      payload: JSON.stringify(payload),
      max_attempts: this.config.maxAttempts,
      lifecycle_persona: enabledLifecycleScope?.persona ?? null,
      lifecycle_item_type: enabledLifecycleScope?.itemType ?? null,
    };

    const result =
      this.lifecycleRuntime && enabledLifecycleScope
        ? this.lifecycleRuntime.transaction((transaction) => {
            const queued = this.queueRepo.enqueue(input);
            if (queued.isErr())
              return err(
                new QueueError(
                  `Failed to enqueue item for lifecycle event: ${queued.error.message}`,
                ),
              );
            const publication = this.lifecycleRuntime!.publish(
              this.lifecyclePublishInput(
                'queue.item.enqueued.v1',
                queued.value.id,
                threadId,
                enabledLifecycleScope,
                queued.value.message_id,
              ),
              transaction,
            );
            if (publication.isErr())
              return err(
                new QueueError(
                  `Failed to publish queue enqueue event: ${publication.error.message}`,
                ),
              );
            return ok(queued.value);
          })
        : this.queueRepo.enqueue(input);

    if (result.isErr()) {
      return err(
        new QueueError(
          `Failed to enqueue item for thread ${threadId}: ${result.error.message}`,
          result.error,
        ),
      );
    }

    const item = rowToQueueItem(result.value);
    this.logger.info({ itemId: item.id, threadId, type }, 'queue item enqueued');
    return ok(item);
  }

  /**
   * Idempotently enqueue a caller-owned deterministic work item.
   *
   * Used only for crash-recovery paths that can first persist a message and
   * then need to ensure the matching queue row exists on retry. Fresh inserts
   * still publish queue lifecycle events in the same transaction as the row.
   */
  enqueueWithId(
    id: string,
    threadId: string,
    type: 'message' | 'schedule' | 'collaboration',
    payload: Record<string, unknown>,
    messageId?: string,
    lifecycleScope?: LifecycleQueueScope,
  ): Result<QueueItem, QueueError> {
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

    const enabledLifecycleScope = this.lifecycleRuntime ? lifecycleScope : undefined;
    if (
      this.lifecycleRuntime &&
      (type === 'message' || type === 'schedule') &&
      !enabledLifecycleScope
    ) {
      return err(
        new QueueError(
          'Lifecycle-enabled message and schedule queue items require manager-owned lifecycle scope',
        ),
      );
    }
    const scopeError = this.validateLifecycleScope(type, enabledLifecycleScope);
    if (scopeError) return err(scopeError);

    const input = {
      id,
      thread_id: threadId,
      message_id: messageId ?? null,
      type,
      payload: JSON.stringify(payload),
      max_attempts: this.config.maxAttempts,
      lifecycle_persona: enabledLifecycleScope?.persona ?? null,
      lifecycle_item_type: enabledLifecycleScope?.itemType ?? null,
    };

    const result =
      this.lifecycleRuntime && enabledLifecycleScope
        ? this.lifecycleRuntime.transaction((transaction) => {
            const queued = this.queueRepo.enqueueIfAbsent(input);
            if (queued.isErr())
              return err(
                new QueueError(
                  `Failed to idempotently enqueue item for lifecycle event: ${queued.error.message}`,
                ),
              );
            if (!queued.value.inserted) return ok(queued.value.item);
            const publication = this.lifecycleRuntime!.publish(
              this.lifecyclePublishInput(
                'queue.item.enqueued.v1',
                queued.value.item.id,
                threadId,
                enabledLifecycleScope,
                queued.value.item.message_id,
              ),
              transaction,
            );
            if (publication.isErr())
              return err(
                new QueueError(
                  `Failed to publish queue enqueue event: ${publication.error.message}`,
                ),
              );
            return ok(queued.value.item);
          })
        : this.queueRepo.enqueueIfAbsent(input).map((queued) => queued.item);

    if (result.isErr()) {
      return err(
        new QueueError(
          `Failed to idempotently enqueue item for thread ${threadId}: ${result.error.message}`,
          result.error,
        ),
      );
    }

    const item = rowToQueueItem(result.value);
    this.logger.info({ itemId: item.id, threadId, type }, 'queue item ensured');
    return ok(item);
  }

  /**
   * Enqueues and publishes through an already-open lifecycle bus transaction.
   * This is intentionally not a general transaction API: callers receive the
   * opaque context only from LifecycleRuntime, preserving exact bus authority.
   */
  enqueueInLifecycleTransaction(
    threadId: string,
    type: 'message' | 'schedule' | 'collaboration',
    payload: Record<string, unknown>,
    lifecycleScope: LifecycleQueueScope,
    transaction: TransactionContext,
    messageId?: string,
  ): Result<QueueItem, QueueError> {
    if (!this.lifecycleRuntime) {
      return err(new QueueError('Lifecycle queue enqueue requires an enabled lifecycle runtime'));
    }
    const scopeError = this.validateLifecycleScope(type, lifecycleScope);
    if (scopeError) return err(scopeError);
    const authority = this.lifecycleRuntime.assertTransaction(transaction);
    if (authority.isErr()) return err(new QueueError(authority.error.message, authority.error));
    const threadResult = this.threadRepo.findById(threadId);
    if (threadResult.isErr()) {
      return err(
        new QueueError(`Failed to look up thread ${threadId}: ${threadResult.error.message}`),
      );
    }
    if (!threadResult.value) return err(new QueueError(`Thread not found: ${threadId}`));
    const queued = this.queueRepo.enqueue({
      id: uuidv4(),
      thread_id: threadId,
      message_id: messageId ?? null,
      type,
      payload: JSON.stringify(payload),
      max_attempts: this.config.maxAttempts,
      lifecycle_persona: lifecycleScope.persona,
      lifecycle_item_type: lifecycleScope.itemType,
    });
    if (queued.isErr())
      return err(new QueueError(`Failed to enqueue item: ${queued.error.message}`));
    const publication = this.lifecycleRuntime.publish(
      this.lifecyclePublishInput(
        'queue.item.enqueued.v1',
        queued.value.id,
        threadId,
        lifecycleScope,
        queued.value.message_id,
      ),
      transaction,
    );
    if (publication.isErr()) {
      return err(
        new QueueError(`Failed to publish queue enqueue event: ${publication.error.message}`),
      );
    }
    return ok(rowToQueueItem(queued.value));
  }

  private validateLifecycleScope(
    queueType: 'message' | 'schedule' | 'collaboration',
    scope: LifecycleQueueScope | undefined,
  ): QueueError | undefined {
    if (!scope) return undefined;
    if (!this.lifecycleRuntime) return undefined;
    if (queueType === 'collaboration') {
      return new QueueError('Collaboration queue items have no lifecycle publication scope');
    }
    const expected = queueType === 'schedule' ? 'schedule' : 'message';
    if (scope.persona.length === 0 || scope.itemType !== expected) {
      return new QueueError(
        'Lifecycle queue scope does not match the authoritative queue item type',
      );
    }
    return undefined;
  }

  private lifecyclePublishInput(
    type: LifecycleEventEnvelope['type'],
    itemId: string,
    threadId: string,
    lifecycleScope: LifecycleQueueScope,
    messageId: string | null,
  ): LifecycleEventPublishInput {
    return {
      event: {
        version: 'v1' as const,
        type,
        eventId: uuidv4(),
        occurredAt: new Date().toISOString(),
        context: {
          aggregate: { type: 'queue_item', id: itemId },
          correlationId: messageId ?? itemId,
          recursion: { depth: 0, maxDepth: 8 },
          provenance: { source: 'queue', sourceEventIds: [], sourceReferences: [] },
        },
        payload: {
          references: [
            { type: 'queue_item', id: itemId },
            { type: 'thread', id: threadId },
          ],
          metadata: { itemType: lifecycleScope.itemType },
        },
      },
      persona: lifecycleScope.persona,
      itemOrigin: 'queue' as const,
      itemType: lifecycleScope.itemType,
    };
  }

  /**
   * Starts the background processing loop.
   *
   * On each poll tick, up to `concurrencyLimit - activeCount` new items are
   * dispatched. The loop runs until `stopProcessing()` is called.
   *
   * @param handler - Async function invoked for each claimed queue item.
   */
  startProcessing(
    handler: (item: QueueItem, signal?: AbortSignal) => Promise<Result<void, Error>>,
  ): void {
    if (this.loopTimer !== null) {
      this.logger.warn('startProcessing called while loop is already running');
      return;
    }

    this.logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'queue processing loop started');
    this.processing = true;

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
  async stopProcessing(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<QueueDrainResult> {
    this.processing = false;
    if (this.loopTimer !== null) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
      this.logger.info('queue processing loop stopped');
    }
    for (const controller of this.activeControllers) controller.abort();
    // AgentRunner bounds provider execution. Joining these already-claimed
    // items before callers close the database prevents an in-flight handler
    // from writing through a closed repository during failed startup/restart.
    const settled = Promise.allSettled([...this.activeWork]).then(() => 'drained' as const);
    let timer: NodeJS.Timeout | undefined;
    try {
      const status = await Promise.race([
        settled,
        new Promise<'timed_out'>((resolve) => {
          timer = setTimeout(() => resolve('timed_out'), timeoutMs);
          timer.unref();
        }),
      ]);
      return { status };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  waitForDrain(): Promise<void> {
    return Promise.allSettled([...this.activeWork]).then(() => undefined);
  }

  /**
   * Returns a snapshot of queue item counts by status.
   */
  stats(): QueueStats {
    const result = this.queueRepo.countByStatus();
    if (result.isErr()) {
      this.logger.error({ err: result.error }, 'failed to read queue stats');
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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Single processing loop tick: dispatches items up to the concurrency limit.
   */
  private async tick(
    handler: (item: QueueItem, signal?: AbortSignal) => Promise<Result<void, Error>>,
  ): Promise<void> {
    if (!this.processing) return;
    const slots = this.config.concurrencyLimit - this.activeCount;
    if (slots <= 0) {
      return;
    }

    // Dispatch up to `slots` items in parallel.
    const dispatches: Promise<QueueItem | null>[] = [];
    for (let i = 0; i < slots; i++) {
      if (!this.processing) break;
      const controller = new AbortController();
      const dispatch = this.dispatchOne(handler, controller.signal);
      this.activeWork.add(dispatch);
      this.activeControllers.add(controller);
      void dispatch.finally(() => {
        this.activeWork.delete(dispatch);
        this.activeControllers.delete(controller);
      });
      dispatches.push(dispatch);
    }

    await Promise.all(dispatches);
  }

  /**
   * Claims and processes a single item, tracking the active count.
   */
  private async dispatchOne(
    handler: (item: QueueItem, signal?: AbortSignal) => Promise<Result<void, Error>>,
    signal: AbortSignal,
  ): Promise<QueueItem | null> {
    this.activeCount++;
    try {
      return await this.processor.processNext(handler, signal);
    } finally {
      this.activeCount--;
    }
  }

}
