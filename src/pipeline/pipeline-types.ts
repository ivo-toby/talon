/**
 * Shared type definitions for the message ingestion pipeline.
 *
 * These types represent the canonical shapes used throughout the pipeline,
 * from inbound event normalization through to queue submission.
 */

import type { Result } from 'neverthrow';
import type { InboundEvent } from '../channels/channel-types.js';

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
 * - `'ignored'`    — a reaction event that does not target a message Talon
 *                    sent (or a removed reaction), or a command consumed by
 *                    the inbound command handler; nothing was persisted.
 * - `'error'`      — an unexpected error occurred (details in the Err wrapper).
 */
export type PipelineResult = 'enqueued' | 'duplicate' | 'no_persona' | 'ignored' | 'error';

// ---------------------------------------------------------------------------
// Inbound commands
// ---------------------------------------------------------------------------

/**
 * Claims inbound chat commands (for example `/approve CODE`) before they can
 * reach a thread, the message store or an agent.
 */
export interface InboundCommandHandler {
  /**
   * Synchronous and cheap. Offered every non-reaction event, whatever its
   * length or attachments. True only for a message that the handler claims.
   * Must not throw.
   */
  matches(event: InboundEvent): boolean;
  /**
   * Called only after matches() returned true. An object means the event is
   * consumed: the pipeline sends `reply` if present and stops. `undefined`
   * means not handled: the event continues as a normal message. Never throws.
   */
  handle(event: InboundEvent): Promise<{ reply?: string } | undefined>;
}

/**
 * Sends a command reply to a chat. Resolves the connector by channel name;
 * a missing connector or a failed send is reported as an Err.
 */
export type InboundReplySender = (
  channelName: string,
  externalThreadId: string,
  body: string,
) => Promise<Result<unknown, unknown>>;

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
