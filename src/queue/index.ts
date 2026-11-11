/**
 * Durable work queue.
 *
 * SQLite-backed FIFO queue with per-thread ordering, retry with exponential
 * backoff and jitter, configurable attempt cap, and a dead-letter queue for
 * exhausted items. Crash recovery restores in-flight items on startup.
 */

export { QueueItemStatus, type QueueItem } from './queue-types.js';
export { calculateBackoff } from './retry-strategy.js';
export { DeadLetterHandler } from './dead-letter.js';
export { QueueProcessor, QueueDeferral } from './queue-processor.js';
export { QueueManager, type QueueConfig, type QueueStats } from './queue-manager.js';
export { rowToQueueItem } from './queue-mapper.js';
