/**
 * Dead-letter queue handler.
 *
 * Provides operations for moving items to dead-letter state and listing
 * all dead-letter items. Dead-lettered items are items that have exhausted
 * all retry attempts and require manual inspection or replay.
 */

import type pino from 'pino';
import { ok, err, type Result } from 'neverthrow';
import { QueueError } from '../core/errors/index.js';
import type { QueueRepository } from '../core/database/repositories/queue-repository.js';
import { type QueueItem } from './queue-types.js';
import { rowToQueueItem } from './queue-mapper.js';
import {
  classifyQueueRow,
  logQueueDiagnostic,
  type QueueDiagnosticResolver,
} from './queue-processor.js';

/**
 * Handles dead-letter queue operations.
 *
 * Items reach the dead-letter queue when they exhaust all retry attempts.
 * Dead-lettered items can be listed for manual inspection and, in a future
 * version, replayed back into the main queue.
 */
export class DeadLetterHandler {
  constructor(
    private readonly queueRepo: QueueRepository,
    private readonly logger: pino.Logger,
    private readonly diagnosticResolver?: QueueDiagnosticResolver,
  ) {}

  /**
   * Moves a queue item directly to dead-letter state with a reason.
   *
   * This is typically called by the queue processor after max attempts are
   * exhausted, but can also be invoked manually via operator tooling.
   *
   * @param itemId - Primary key of the queue item.
   * @param reason - Human-readable explanation for why the item was dead-lettered.
   * @returns Ok(void) on success, or a QueueError if the operation fails.
   */
  moveToDeadLetter(itemId: string, reason: string): Result<void, QueueError> {
    const rowResult = this.queueRepo.findById(itemId);
    const privacy = rowResult.isOk() && rowResult.value
      ? classifyQueueRow(this.diagnosticResolver, rowResult.value)
      : 'unknown';
    const result = this.queueRepo.markDeadLetter(itemId, reason);
    if (result.isErr()) {
      const queueErr = new QueueError(
        `Failed to move item ${itemId} to dead letter: ${result.error.message}`,
        result.error,
      );
      logQueueDiagnostic(
        this.logger,
        privacy,
        'error',
        { itemId, reason, err: queueErr },
        'dead-letter move failed',
      );
      return err(queueErr);
    }

    logQueueDiagnostic(
      this.logger,
      privacy,
      'warn',
      { itemId, reason },
      'queue item moved to dead letter',
    );
    return ok(undefined);
  }

  /**
   * Returns all items currently in dead-letter state, ordered by most recently updated.
   *
   * @returns Ok(QueueItem[]) with the dead-letter items, or a QueueError on failure.
   */
  listDeadLetterItems(): Result<QueueItem[], QueueError> {
    const result = this.queueRepo.findDeadLetter();
    if (result.isErr()) {
      const queueErr = new QueueError(
        `Failed to list dead-letter items: ${result.error.message}`,
        result.error,
      );
      logQueueDiagnostic(this.logger, 'unknown', 'error', { err: queueErr }, 'dead-letter list failed');
      return err(queueErr);
    }

    // findDeadLetter() already filters for dead_letter status in SQL.
    const items = result.value.map(rowToQueueItem);

    return ok(items);
  }
}
