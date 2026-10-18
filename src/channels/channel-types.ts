/**
 * Channel connector interface and shared channel types.
 *
 * Defines the contract that all channel connectors must implement, as well as
 * the canonical inbound/outbound message structures used throughout the daemon.
 */

import type { Result } from '../core/types/result.js';
import type { ChannelError } from '../core/errors/error-types.js';
import type { ImageRejectionReason } from '../images/image-types.js';

// ---------------------------------------------------------------------------
// Attachment
// ---------------------------------------------------------------------------

/**
 * A file attachment that may accompany an inbound or outbound message.
 * `data` is either a raw Buffer (when loaded into memory) or a filesystem path
 * (when the file has been written to the thread's attachments directory).
 *
 * `filename` and `mimeType` are DECLARED metadata: many channels deliver
 * photos without either (a Baileys `imageMessage` carries no filename at all).
 * Absent stays absent — connectors must not manufacture an empty string, and
 * downstream ledger writers coerce absence to NULL rather than to `''`, which
 * the Image ledger's nonempty CHECK constraints reject.
 */
export interface Attachment {
  filename?: string;
  mimeType?: string;
  data: Buffer | string;
  size: number;
}

// ---------------------------------------------------------------------------
// Inbound attachment (payload or closed rejection)
// ---------------------------------------------------------------------------

/**
 * A metadata-only outcome for a delivered Attachment that the connector could
 * not hand over as a payload — for example an unsupported image MIME, a slot
 * overflow, or a failed media fetch.
 *
 * Rejections carry no bytes, paths, staging references, or credentials; they
 * exist so the pipeline can record a closed Rejected Image in source order
 * instead of silently losing the delivered item. The reason vocabulary is the
 * shared Image rejection list (`IMAGE_REJECTION_REASONS`), so connectors must
 * not invent channel-specific reasons.
 *
 * Payload `Attachment`s are identified by the absence of `kind`.
 */
export interface InboundAttachmentRejection {
  /** Discriminates this arm from a payload `Attachment`. */
  readonly kind: 'rejected';
  /** Closed rejection reason, never a channel-specific value. */
  rejectionReason: ImageRejectionReason;
  /** Declared filename when the channel supplied one. */
  filename?: string;
  /** Declared MIME type when the channel supplied one; a filename never establishes MIME. */
  mimeType?: string;
  /** Declared size in bytes when the channel supplied one. */
  size?: number;
  /** Zero-based position of the delivered item, preserving source order. */
  sourcePosition: number;
}

/**
 * One inbound Attachment: either the delivered payload or a metadata-only
 * rejection. Array position in {@link InboundEvent.attachments} is source order
 * for both arms. Outbound Attachments keep requiring a payload.
 */
export type InboundAttachment = Attachment | InboundAttachmentRejection;

// ---------------------------------------------------------------------------
// Actions (interactive elements)
// ---------------------------------------------------------------------------

/**
 * An interactive action element that may be included in agent output.
 * Channels that don't support actions should silently drop them (with audit log).
 */
export interface Action {
  type: 'button' | 'approval';
  label: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Agent output
// ---------------------------------------------------------------------------

/**
 * The normalised outbound payload produced by an agent run.
 * `body` is Markdown — each connector converts it to channel-native format.
 */
export interface AgentOutput {
  /** Markdown body text. */
  body: string;
  /** Optional file attachments. */
  attachments?: Attachment[];
  /** Optional interactive actions (buttons, approval prompts). */
  actions?: Action[];
}

// ---------------------------------------------------------------------------
// Inbound event
// ---------------------------------------------------------------------------

/**
 * A normalised inbound message received from a channel connector.
 *
 * All channel-specific details are abstracted away; consumers only interact
 * with this canonical representation.
 */
export interface InboundEvent {
  /** Channel type (e.g. 'telegram', 'slack'). */
  channelType: string;
  /** Instance name from config (e.g. 'my-telegram-bot'). */
  channelName: string;
  /** Channel-specific thread identifier (e.g. Telegram chat_id). */
  externalThreadId: string;
  /** Channel-specific sender identity (e.g. Telegram user_id). */
  senderId: string;
  /**
   * Stable key for deduplication — must be unique per channel.
   * For Telegram this is the `update_id`; for Slack it is the `event_id`, etc.
   */
  idempotencyKey: string;
  /** Plain text content of the message. */
  content: string;
  /**
   * Attachments delivered with the message, in source order. Each entry is
   * either the delivered payload or a metadata-only rejection outcome.
   */
  attachments?: InboundAttachment[];
  /** Original provider payload — preserved for debugging and audit purposes. */
  raw?: unknown;
  /** Unix epoch milliseconds when the event was received. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Channel connector interface
// ---------------------------------------------------------------------------

/**
 * Contract that every channel connector must implement.
 *
 * Connectors are responsible for:
 * - Providing stable idempotency keys for inbound events.
 * - Ingesting attachments into the thread `attachments/` directory.
 * - Rate-limiting and retrying outbound sends with provider-specific backoff.
 * - Converting Markdown output to channel-native format via `format()`.
 */
export interface ChannelConnector {
  /** Channel type string, e.g. 'telegram'. */
  readonly type: string;
  /** Instance name from config, e.g. 'personal-telegram'. */
  readonly name: string;

  /**
   * The resolved bot/service user ID for this connector instance.
   * Set during start() by connectors that can resolve their own identity
   * (e.g. Slack auth.test, Telegram getMe). Undefined if not yet started
   * or if the connector type has no bot identity concept.
   */
  readonly botUserId?: string;

  /**
   * Provides the set of sibling bot user IDs (same connector type) to
   * filter out from inbound messages. Called by channel-setup after all
   * connectors have started. Connectors that don't need filtering can
   * implement this as a no-op.
   */
  setSiblingBotIds?(ids: Set<string>): void;

  /**
   * Start the connector — open webhooks, begin polling, etc.
   * Must be idempotent (safe to call when already started).
   */
  start(): Promise<void>;

  /**
   * Stop the connector gracefully — close connections, flush pending work.
   * Must be idempotent (safe to call when already stopped).
   */
  stop(): Promise<void>;

  /**
   * Register a handler that will be called for every normalised inbound event.
   * Only one handler is supported; a second call replaces the previous one.
   */
  onMessage(handler: (event: InboundEvent) => void | Promise<void>): void;

  /**
   * Send an agent output to the given external thread.
   *
   * @param externalThreadId - The channel-specific thread identifier.
   * @param output            - The agent output to deliver.
   * @returns Ok on success, Err(ChannelError) on failure.
   */
  send(externalThreadId: string, output: AgentOutput): Promise<Result<void, ChannelError>>;

  /**
   * Signal that the agent is working (e.g. "typing" indicator).
   * No-op by default if the channel doesn't support it.
   *
   * @param externalThreadId - The channel-specific thread identifier.
   */
  sendTyping?(externalThreadId: string): Promise<void>;

  /**
   * Convert a Markdown string to the channel's native format.
   * This is a pure, synchronous transformation — no I/O.
   *
   * @param markdown - Markdown input.
   * @returns Channel-native formatted string.
   */
  format(markdown: string): string;
}
