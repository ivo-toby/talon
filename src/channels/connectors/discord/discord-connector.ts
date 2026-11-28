/**
 * Discord channel connector.
 *
 * Implements the ChannelConnector interface using Discord's REST API for
 * outbound messages and an external Gateway event feed for inbound messages.
 * This connector is push-based: a caller feeds Gateway events via
 * `feedEvent()` rather than the connector managing the WebSocket itself.
 */

import type pino from 'pino';
import type {
  ChannelConnector,
  InboundEvent,
  AgentOutput,
  AttachmentDeliveryReceipt,
  OutboundAttachment,
  OutboundAttachmentSupport,
  SendReceipt,
} from '../../channel-types.js';
import type { Result } from '../../../core/types/result.js';
import { ok, err } from '../../../core/types/result.js';
import { ChannelError } from '../../../core/errors/error-types.js';
import type {
  DiscordConfig,
  DiscordGatewayEvent,
  DiscordMessage,
  DiscordSendMessageBody,
  DiscordSendMessageResult,
  DiscordApiError,
} from './discord-types.js';
import { markdownToDiscord } from './discord-format.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Discord REST API base URL. */
const DISCORD_API_BASE = 'https://discord.com/api/v10';

/**
 * Discord Gateway opcode for a DISPATCH event.
 * Inbound MESSAGE_CREATE events arrive with op=0.
 */
const GATEWAY_OP_DISPATCH = 0;

/** Maximum number of retry attempts on a rate-limited request. */
const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * Outbound attachment limits. Discord's default upload limit for bots and
 * non-Nitro users is 20 MB per file (servers with boosts allow more, which
 * Talon does not assume); one attachment travels per message.
 */
export const DISCORD_OUTBOUND_ATTACHMENTS: OutboundAttachmentSupport = {
  maxBytes: 20 * 1024 * 1024,
  maxFiles: 10,
};

/** Longest message content Discord accepts. */
const DISCORD_MAX_CONTENT_LENGTH = 2000;

/** A request body for Create Message: JSON, or multipart with files. */
type DiscordRequestBody =
  | { kind: 'json'; body: DiscordSendMessageBody }
  | { kind: 'multipart'; build: () => FormData };

// ---------------------------------------------------------------------------
// Thread ID encoding
// ---------------------------------------------------------------------------

/**
 * Encode a Discord channel ID and optional reply message ID as an external
 * thread ID string used by the rest of the system.
 *
 * Format: `<channelId>` or `<channelId>:<messageId>` when a reply target
 * is known.
 *
 * @param channelId - Discord channel snowflake ID.
 * @param messageId - Optional message snowflake ID to reply to.
 * @returns Encoded external thread ID.
 */
export function encodeThreadId(channelId: string, messageId?: string): string {
  if (messageId) {
    return `${channelId}:${messageId}`;
  }
  return channelId;
}

/**
 * Decode an external thread ID back into a channel ID and optional message ID.
 *
 * @param externalThreadId - The encoded thread ID (from `encodeThreadId`).
 * @returns Object with `channelId` and optional `messageId`.
 */
export function decodeThreadId(externalThreadId: string): {
  channelId: string;
  messageId?: string;
} {
  const colonIndex = externalThreadId.indexOf(':');
  if (colonIndex === -1) {
    return { channelId: externalThreadId };
  }
  return {
    channelId: externalThreadId.slice(0, colonIndex),
    messageId: externalThreadId.slice(colonIndex + 1),
  };
}

// ---------------------------------------------------------------------------
// DiscordConnector
// ---------------------------------------------------------------------------

/**
 * Channel connector for Discord via REST API + external Gateway event feed.
 *
 * The Gateway WebSocket connection is managed externally. Callers should feed
 * MESSAGE_CREATE events to this connector using `feedEvent()`.
 *
 * Usage:
 * 1. Construct with a DiscordConfig and a channel name.
 * 2. Call `onMessage()` to register an inbound event handler.
 * 3. Call `start()` to mark the connector as active.
 * 4. Feed Gateway events via `feedEvent()`.
 * 5. Call `stop()` to mark the connector as inactive.
 */
export class DiscordConnector implements ChannelConnector {
  /** One file per message, up to Discord's default 20 MB. */
  readonly outboundAttachments: OutboundAttachmentSupport = DISCORD_OUTBOUND_ATTACHMENTS;
  readonly type = 'discord';
  readonly name: string;

  private handler?: (event: InboundEvent) => void | Promise<void>;
  private active = false;

  constructor(
    private readonly config: DiscordConfig,
    private readonly channelName: string,
    private readonly logger: pino.Logger,
  ) {
    this.name = channelName;
  }

  // ---------------------------------------------------------------------------
  // ChannelConnector lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Mark the connector as active. Idempotent — no-op if already active.
   */
  start(): Promise<void> {
    if (this.active) {
      this.logger.debug({ channelName: this.name }, 'discord connector already active');
      return Promise.resolve();
    }
    this.active = true;
    this.logger.info({ channelName: this.name }, 'discord connector started');
    return Promise.resolve();
  }

  /**
   * Mark the connector as inactive. Idempotent — no-op if already stopped.
   */
  stop(): Promise<void> {
    if (!this.active) {
      return Promise.resolve();
    }
    this.active = false;
    this.logger.info({ channelName: this.name }, 'discord connector stopped');
    return Promise.resolve();
  }

  /**
   * Register the inbound message handler.
   * A second call replaces the previous handler.
   */
  onMessage(handler: (event: InboundEvent) => void | Promise<void>): void {
    this.handler = handler;
  }

  // ---------------------------------------------------------------------------
  // Inbound — Gateway event feed
  // ---------------------------------------------------------------------------

  /**
   * Feed a raw Discord Gateway event into the connector for processing.
   *
   * Only DISPATCH events (op=0) with event type `MESSAGE_CREATE` are handled.
   * All other events are silently ignored.
   *
   * This method is called by external Gateway connection management code
   * whenever a new event is received from the Discord WebSocket.
   *
   * @param event - Raw Discord Gateway event payload.
   */
  async feedEvent(event: DiscordGatewayEvent): Promise<void> {
    if (event.op !== GATEWAY_OP_DISPATCH || event.t !== 'MESSAGE_CREATE') {
      return;
    }

    const message = event.d as DiscordMessage;
    await this.handleMessage(message);
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  /**
   * Send an AgentOutput to a Discord channel.
   *
   * @param externalThreadId - Encoded thread ID (`channelId` or `channelId:messageId`).
   * @param output            - Agent output to deliver.
   * @returns Ok on success, Err(ChannelError) on failure.
   */
  async send(
    externalThreadId: string,
    output: AgentOutput,
  ): Promise<Result<SendReceipt | void, ChannelError>> {
    const { channelId, messageId } = decodeThreadId(externalThreadId);
    const attachments = output.attachments ?? [];

    const reference = messageId ? { message_id: messageId } : undefined;
    if (attachments.length === 0) {
      const sent = await this.sendWithRateLimitRetry(
        channelId,
        { kind: 'json', body: this.textBody(output.body, reference) },
        0,
      );
      return sent.map(() => undefined);
    }

    // Text first (carrying the reply), then one message per attachment with
    // its caption as content. A failed text fails before any upload.
    let receiptId: string | undefined;
    let pendingReference = reference;
    if (output.body.trim() !== '') {
      const text = await this.sendWithRateLimitRetry(
        channelId,
        { kind: 'json', body: this.textBody(output.body, pendingReference) },
        0,
      );
      if (text.isErr()) return err(text.error);
      receiptId = text.value;
      pendingReference = undefined;
    }

    const delivered: AttachmentDeliveryReceipt[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const sent = await this.sendWithRateLimitRetry(
        channelId,
        { kind: 'multipart', build: () => attachmentForm(attachment, pendingReference) },
        0,
      );
      if (sent.isErr()) {
        this.logger.warn(
          { channelName: this.name, index, mimeType: attachment.mimeType, size: attachment.size, err: sent.error.message },
          'discord: attachment send failed',
        );
        delivered.push({ index, status: 'failed', error: sent.error.message });
        continue;
      }
      pendingReference = undefined;
      receiptId ??= sent.value;
      delivered.push({
        index,
        status: 'sent',
        ...(sent.value !== undefined ? { externalMessageId: sent.value } : {}),
      });
    }
    return ok({
      ...(receiptId !== undefined ? { externalMessageId: receiptId } : {}),
      attachments: delivered,
    });
  }

  private textBody(
    markdown: string,
    reference: { message_id: string } | undefined,
  ): DiscordSendMessageBody {
    const body: DiscordSendMessageBody = { content: this.format(markdown) };
    if (reference) {
      body.message_reference = reference;
    }
    return body;
  }

  /**
   * Convert a Markdown string to Discord-compatible format.
   */
  format(markdown: string): string {
    return markdownToDiscord(markdown);
  }

  get botUserId(): string | undefined {
    return undefined; // Discord already filters all bot messages via author.bot
  }

  setSiblingBotIds(_ids: Set<string>): void {
    // No-op: Discord connector already drops all messages from bot authors.
  }

  // ---------------------------------------------------------------------------
  // Internal — message handling
  // ---------------------------------------------------------------------------

  /**
   * Process a Discord MESSAGE_CREATE event and invoke the registered handler.
   */
  private async handleMessage(message: DiscordMessage): Promise<void> {
    // Drop messages from bots (including this bot itself).
    if (message.author.bot) {
      this.logger.debug(
        { channelName: this.name, authorId: message.author.id },
        'discord connector dropping bot message',
      );
      return;
    }

    // Enforce guildId restriction if configured.
    if (this.config.guildId && message.guild_id && message.guild_id !== this.config.guildId) {
      this.logger.warn(
        { channelName: this.name, guildId: message.guild_id },
        'discord connector dropping message from disallowed guild',
      );
      return;
    }

    // Enforce allowedChannelIds restriction if configured.
    if (
      this.config.allowedChannelIds &&
      this.config.allowedChannelIds.length > 0 &&
      !this.config.allowedChannelIds.includes(message.channel_id)
    ) {
      this.logger.warn(
        { channelName: this.name, channelId: message.channel_id },
        'discord connector dropping message from disallowed channel',
      );
      return;
    }

    // Skip messages with no content.
    if (!message.content) {
      this.logger.debug(
        { channelName: this.name, messageId: message.id },
        'discord connector dropping message with empty content',
      );
      return;
    }

    // Build the external thread ID. If the message is a reply, include the
    // original message ID so outbound sends can reference the thread.
    const externalThreadId = encodeThreadId(message.channel_id);

    const timestamp = new Date(message.timestamp).getTime();

    const event: InboundEvent = {
      channelType: this.type,
      channelName: this.name,
      externalThreadId,
      senderId: message.author.id,
      idempotencyKey: message.id,
      content: message.content,
      timestamp: isNaN(timestamp) ? Date.now() : timestamp,
      raw: message,
    };

    if (!this.handler) {
      this.logger.warn(
        { channelName: this.name },
        'discord connector received message but no handler is registered',
      );
      return;
    }

    try {
      await this.handler(event);
    } catch (handlerErr) {
      this.logger.error(
        { channelName: this.name, err: handlerErr },
        'discord connector handler threw an error',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — REST API
  // ---------------------------------------------------------------------------

  /**
   * Send a message to a Discord channel, respecting rate limits.
   *
   * If a 429 rate-limited response is received, the method waits for the
   * `Retry-After` duration and retries up to `MAX_RATE_LIMIT_RETRIES` times.
   *
   * @param channelId  - Discord channel snowflake ID.
   * @param body       - Request body.
   * @param retryCount - Current retry attempt (0 = first attempt).
   */
  private async sendWithRateLimitRetry(
    channelId: string,
    body: DiscordRequestBody,
    retryCount: number,
  ): Promise<Result<string | undefined, ChannelError>> {
    const url = `${DISCORD_API_BASE}/channels/${channelId}/messages`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        // Multipart: fetch sets the boundary Content-Type itself.
        headers: {
          ...(body.kind === 'json' ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `Bot ${this.config.botToken}`,
        },
        body: body.kind === 'json' ? JSON.stringify(body.body) : body.build(),
      });
    } catch (fetchErr) {
      const cause = fetchErr instanceof Error ? fetchErr : undefined;
      return err(new ChannelError(`Discord send network error: ${String(fetchErr)}`, cause));
    }

    // Handle rate limiting (HTTP 429).
    if (response.status === 429) {
      if (retryCount >= MAX_RATE_LIMIT_RETRIES) {
        return err(
          new ChannelError(`Discord send rate limited after ${MAX_RATE_LIMIT_RETRIES} retries`),
        );
      }

      const retryAfterSec = this.parseRetryAfter(response);
      this.logger.warn(
        { channelName: this.name, channelId, retryAfterSec, retryCount },
        'discord send rate limited, retrying',
      );

      await this.sleep(retryAfterSec * 1000);
      return this.sendWithRateLimitRetry(channelId, body, retryCount + 1);
    }

    if (!response.ok) {
      let errorMessage = `Discord send failed (HTTP ${response.status})`;
      try {
        const apiError = (await response.json()) as DiscordApiError;
        errorMessage = `Discord send failed (${apiError.code}): ${apiError.message}`;
      } catch {
        // Could not parse error body — use the HTTP status message.
      }
      return err(new ChannelError(errorMessage));
    }

    // Parse the response to confirm success and report the message ID.
    try {
      const result = (await response.json()) as DiscordSendMessageResult;
      this.logger.debug(
        { channelName: this.name, channelId, messageId: result.id },
        'discord message sent',
      );
      return ok(typeof result.id === 'string' ? result.id : undefined);
    } catch {
      // Non-fatal — the send succeeded (2xx status).
      return ok(undefined);
    }
  }

  /**
   * Parse the `Retry-After` or `X-RateLimit-Reset-After` header from a
   * Discord rate-limit response.
   *
   * @param response - The HTTP 429 response.
   * @returns Seconds to wait before retrying (defaults to 1 second).
   */
  private parseRetryAfter(response: Response): number {
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter !== null) {
      const parsed = parseFloat(retryAfter);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }

    const resetAfter = response.headers.get('X-RateLimit-Reset-After');
    if (resetAfter !== null) {
      const parsed = parseFloat(resetAfter);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return 1;
  }

  /**
   * Resolve after `ms` milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Builds a Create Message multipart body carrying one file, with the caption
 * as plain content (cut to Discord's 2000-character limit) and the filename
 * declared in `attachments` so Discord shows it as given.
 */
function attachmentForm(
  attachment: OutboundAttachment,
  reference: { message_id: string } | undefined,
): FormData {
  const form = new FormData();
  const payload = {
    content: (attachment.caption ?? '').slice(0, DISCORD_MAX_CONTENT_LENGTH),
    attachments: [{ id: 0, filename: attachment.filename }],
    ...(reference ? { message_reference: reference } : {}),
  };
  form.append('payload_json', JSON.stringify(payload));
  form.append(
    'files[0]',
    new Blob([new Uint8Array(attachment.data)], { type: attachment.mimeType }),
    attachment.filename,
  );
  return form;
}
