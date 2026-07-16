/**
 * Shared type definitions for the message ingestion pipeline.
 *
 * These types represent the canonical shapes used throughout the pipeline,
 * from inbound event normalization through to queue submission.
 */

// ---------------------------------------------------------------------------
// NormalizedMessage
// ---------------------------------------------------------------------------

/**
 * The canonical internal representation of an inbound message, produced by
 * the MessageNormalizer from a raw InboundEvent.
 *
 * All channel-specific details have been abstracted away at this point;
 * downstream components operate only on this shape.
 */
export interface NormalizedMessage {
  /** Unique message identifier (UUID v4). */
  id: string;
  /** Internal thread identifier (UUID v4). */
  threadId: string;
  /** Internal channel identifier (UUID v4). */
  channelId: string;
  /** Channel-specific sender identity (e.g. Telegram user_id). */
  senderId: string;
  /** Plain text content of the message. */
  content: string;
  /**
   * Stable key for deduplication — propagated verbatim from the InboundEvent.
   * Must be unique per channel connector.
   */
  idempotencyKey: string;
  /** Unix epoch milliseconds when the message was received. */
  timestamp: number;
  /** Original provider payload, preserved for debugging. */
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// PipelineResult
// ---------------------------------------------------------------------------

/**
 * Outcome of processing a single InboundEvent through the pipeline.
 *
 * - `'enqueued'`   — message was persisted and a queue item was created.
 * - `'duplicate'`  — message was already present (idempotency_key matched).
 * - `'no_persona'` — no persona binding found for the channel+thread pair.
 * - `'denied'`     — an enabled native lifecycle policy rejected the inbound message.
 * - `'error'`      — an unexpected error occurred (details in the Err wrapper).
 */
export type PipelineResult = 'enqueued' | 'duplicate' | 'no_persona' | 'denied' | 'error';

// ---------------------------------------------------------------------------
// PipelineStats
// ---------------------------------------------------------------------------

/**
 * Cumulative counters for monitoring the pipeline's processing activity.
 * Updated in-memory on each call to `handleInboundEvent`.
 */
export interface PipelineStats {
  /** Total number of events processed (all outcomes). */
  processed: number;
  /** Number of events that were duplicates (already in the DB). */
  duplicates: number;
  /** Number of events that could not be routed to a persona. */
  noPersona: number;
  /** Number of events that produced an error result. */
  errors: number;
}
