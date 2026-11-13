/**
 * Queue domain types.
 *
 * Defines the QueueItem entity and its status lifecycle used throughout the
 * durable queue system. The row-level representation is owned by
 * QueueRepository; this module provides the application-layer view with
 * camelCase fields and a typed status enum.
 */

// ---------------------------------------------------------------------------
// Status enum
// ---------------------------------------------------------------------------

/** All possible lifecycle states for a queue item. */
export enum QueueItemStatus {
  Pending = 'pending',
  Claimed = 'claimed',
  Processing = 'processing',
  Completed = 'completed',
  Failed = 'failed',
  DeadLetter = 'dead_letter',
}

// ---------------------------------------------------------------------------
// Queue item
// ---------------------------------------------------------------------------

/** Application-layer representation of a queue item (camelCase fields). */
export interface QueueItem {
  /** Unique identifier for the queue item. */
  id: string;
  /** The thread this item belongs to. */
  threadId: string;
  /** Optional message ID that triggered this item. */
  messageId?: string;
  /** Payload category — drives which handler processes the item. */
  type: 'message' | 'schedule' | 'collaboration';
  /** Current lifecycle state. */
  status: QueueItemStatus;
  /** Total number of processing attempts so far. */
  attempts: number;
  /** Maximum number of attempts before the item is dead-lettered. */
  maxAttempts: number;
  /** Unix epoch ms at which the next attempt may be made (set after a failure). */
  nextRetryAt?: number;
  /** Description of the most recent failure, if any. */
  error?: string;
  /** Type-specific data passed to the handler. */
  payload: Record<string, unknown>;
  /** Unix epoch ms when the item was last claimed. */
  claimedAt?: number;
  /** Unix epoch ms when the item was created. */
  createdAt: number;
  /** Unix epoch ms when the item was last modified. */
  updatedAt: number;
}

/**
 * Returns true for the durable voice work payload written by VoiceStore.
 * Voice work is stored as collaboration data for queue compatibility, but it
 * must be claimed through VoiceStore's compare-and-set boundary.
 */
export function isVoiceQueuePayload(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'kind' in payload &&
    (payload as { kind?: unknown }).kind === 'voice_backend'
  );
}
