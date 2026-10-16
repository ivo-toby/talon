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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Single processing loop tick: dispatches items up to the concurrency limit.
   */
  private async tick(handler: (item: QueueItem) => Promise<Result<void, Error>>): Promise<void> {
    const slots = this.config.concurrencyLimit - this.activeCount;
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
