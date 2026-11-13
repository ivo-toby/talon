/**
 * Durable work queue.
 *
 * SQLite-backed FIFO queue with per-thread ordering, retry with exponential
 * backoff and jitter, configurable attempt cap, and a dead-letter queue for
 * exhausted items. Quiesced crash recovery resets ordinary orphan claims;
 * saved Signal replies resume delivery/local finalization, never providers.
 */

export {
  QueueItemStatus,
  type QueueItem,
  type QueueHandler,
  type SavedSignalDeliveryHandler,
} from './queue-types.js';
export type { SignalDeliveryCheckpoint } from './signal-delivery-checkpoint.js';
export type {
  SignalChunkOwnership,
  SignalChunkSettlement,
  SignalDeliveryState,
  SignalQueueFailure,
  SignalQueueRecovery,
} from './signal-delivery-state.js';
export { calculateBackoff } from './retry-strategy.js';
export { DeadLetterHandler } from './dead-letter.js';
export { QueueProcessor, QueueDeferral } from './queue-processor.js';
export { QueueManager, type QueueConfig, type QueueStats } from './queue-manager.js';
export { rowToQueueItem } from './queue-mapper.js';
