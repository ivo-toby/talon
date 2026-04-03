/**
 * Slack channel connector.
 *
 * Implements the ChannelConnector interface for Slack via the Web API.
 * When an `appToken` is configured, the connector establishes a Socket Mode
 * WebSocket connection to receive inbound events automatically. Otherwise,
 * events must be pushed externally via `feedEvent()`.
 *
 * Outbound messages are sent via the `chat.postMessage` Web API endpoint
 * using the bot token for Bearer authentication.
 */

import type pino from 'pino';
import WebSocket from 'ws';
import type { ChannelConnector, InboundEvent, AgentOutput } from '../../channel-types.js';
import type { Result } from '../../../core/types/result.js';
import { ok, err } from '../../../core/types/result.js';
import { ChannelError } from '../../../core/errors/error-types.js';
import type { SlackConfig, SlackEvent, SlackPostMessageResult } from './slack-types.js';
import { markdownToSlackMrkdwn } from './slack-format.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Slack Web API base URL. */
const SLACK_API_BASE = 'https://slack.com/api';

/** Initial backoff after a Socket Mode connection error, in milliseconds. */
const INITIAL_BACKOFF_MS = 1_000;
/** Maximum backoff after repeated connection errors, in milliseconds. */
const MAX_BACKOFF_MS = 60_000;
/** Timeout for the auth.test identity resolution call, in milliseconds. */
const AUTH_TEST_TIMEOUT_MS = 10_000;

/**
 * Regex matching a Slack user mention: `<@U12345678>`.
 * Used to detect whether a channel message is directed at a specific bot.
 */
const MENTION_RE = /<@(U[A-Z0-9]+)>/g;

// ---------------------------------------------------------------------------
// SlackConnector
// ---------------------------------------------------------------------------

/**
 * Channel connector for Slack via the Web API + Socket Mode.
 *
 * When `appToken` is configured, `start()` opens a Socket Mode WebSocket
 * connection that receives events from Slack and feeds them into the pipeline
 * automatically — no public URL required.
 *
 * Without `appToken`, events must be pushed externally via `feedEvent()`.
 *
 * Usage:
 * 1. Construct with a SlackConfig and a channel name.
 * 2. Call `onMessage()` to register an inbound event handler.
 * 3. Call `start()` to connect via Socket Mode (or just mark active).
 * 4. Call `stop()` to disconnect gracefully.
 */
export class SlackConnector implements ChannelConnector {
  readonly type = 'slack';
  readonly name: string;

  private handler?: (event: InboundEvent) => void | Promise<void>;
  private running = false;

  /** This bot's Slack user ID, resolved during start() via auth.test. */
  private _botUserId: string | undefined;

  /** Active Socket Mode WebSocket, if connected. */
  private ws?: WebSocket;
  /** Promise tracking the Socket Mode reconnect loop. */
  private socketLoopPromise?: Promise<void>;
  /** AbortController for cancelling sleep and in-flight fetch during stop(). */
  private abortController?: AbortController;

  constructor(
    private readonly config: SlackConfig,
    private readonly channelName: string,
    private readonly logger: pino.Logger,
  ) {
    this.name = channelName;
  }

  // ---------------------------------------------------------------------------
  // ChannelConnector lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the connector. If `appToken` is configured, opens a Socket Mode
   * WebSocket connection with automatic reconnect. Otherwise, marks the
   * connector as active for external event delivery via `feedEvent()`.
   *
   * Idempotent — no-op if already running.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.debug({ channelName: this.name }, 'slack connector already running');
      return;
    }
    this.running = true;
    this._botUserId = undefined; // Clear stale value from previous start cycle.
    this.abortController = new AbortController();

    // Resolve bot identity so we can filter @mentions in shared channels.
    // When botUserId is configured, validate it against the API response.
    try {
      const response = await fetch(`${SLACK_API_BASE}/auth.test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${this.config.botToken}`,
        },
        signal: AbortSignal.any([
          this.abortController.signal,
          AbortSignal.timeout(AUTH_TEST_TIMEOUT_MS),
        ]),
      });
      const data = (await response.json()) as { ok: boolean; user_id?: string };
      if (data.ok && data.user_id) {
        if (this.config.botUserId && this.config.botUserId !== data.user_id) {
          this.logger.error(
            {
              channelName: this.name,
              configured: this.config.botUserId,
              actual: data.user_id,
            },
            'slack botUserId mismatch — configured ID does not match auth.test result; check that the correct botToken is paired with the correct botUserId',
          );
          this.running = false;
          return;
        }
        this._botUserId = data.user_id;
        this.logger.info(
          { channelName: this.name, botUserId: this._botUserId },
          'slack bot identity resolved',
        );
      } else {
        if (this.config.botUserId) {
          // Config provides an ID but we can't verify it — trust the config.
          this._botUserId = this.config.botUserId;
          this.logger.warn(
            { channelName: this.name, botUserId: this._botUserId },
            'slack auth.test returned ok=false, using configured botUserId',
          );
        } else {
          this.logger.warn(
            { channelName: this.name },
            'slack auth.test returned ok=false, bot identity unknown — mention filtering disabled',
          );
        }
      }
    } catch (authErr) {
      if (this.config.botUserId) {
        this._botUserId = this.config.botUserId;
        this.logger.warn(
          { channelName: this.name, botUserId: this._botUserId, err: authErr },
          'slack auth.test failed, using configured botUserId',
        );
      } else {
        this.logger.warn(
          { channelName: this.name, err: authErr },
          'slack auth.test failed, bot identity unknown — mention filtering disabled',
        );
      }
    }

    if (this.config.appToken) {
      this.logger.info({ channelName: this.name }, 'slack connector starting (socket mode)');
      this.socketLoopPromise = this.socketModeLoop();
    } else {
      this.logger.info(
        { channelName: this.name },
        'slack connector started (no appToken — external event delivery only)',
      );
    }
  }

  /**
   * Stop the connector gracefully. Closes the Socket Mode WebSocket if active.
   * Idempotent — no-op if already stopped.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.logger.info({ channelName: this.name }, 'slack connector stopping');

    // Abort any in-flight fetch or sleep so the reconnect loop unblocks.
    this.abortController?.abort();

    // Close the WebSocket so the reconnect loop exits.
    if (this.ws) {
      this.ws.close(1000, 'connector stopping');
      this.ws = undefined;
    }

    // Wait for the reconnect loop to exit cleanly.
    await this.socketLoopPromise;
    this.socketLoopPromise = undefined;
    this.logger.info({ channelName: this.name }, 'slack connector stopped');
  }

  /**
   * Register the inbound message handler.
   * A second call replaces the previous handler.
   */
  onMessage(handler: (event: InboundEvent) => void | Promise<void>): void {
    this.handler = handler;
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  /**
   * Send an AgentOutput to a Slack channel or thread.
   *
   * The `externalThreadId` encodes both the channel and the optional thread_ts
   * in the format `<channelId>:<thread_ts>`. If no colon is present, the entire
   * string is treated as a channel ID with no thread reply.
   *
   * @param externalThreadId - Encoded as `<channelId>` or `<channelId>:<thread_ts>`.
   * @param output            - Agent output to deliver.
   */
  async send(externalThreadId: string, output: AgentOutput): Promise<Result<void, ChannelError>> {
    const text = this.format(output.body);

    // Decode the compound thread ID.
    let { channelId, threadTs } = decodeThreadId(externalThreadId);

    // Fall back to defaultChannel when the resolved ID doesn't look like a
    // Slack channel ID (e.g. when sending cross-channel from a non-Slack thread).
    if (!channelId.startsWith('C') && !channelId.startsWith('G') && !channelId.startsWith('D')) {
      if (this.config.defaultChannel) {
        this.logger.debug(
          { channelName: this.name, original: channelId, fallback: this.config.defaultChannel },
          'externalThreadId is not a Slack channel ID, falling back to defaultChannel',
        );
        channelId = this.config.defaultChannel;
        threadTs = undefined;
      }
    }

    const payload: Record<string, unknown> = {
      channel: channelId,
      text,
    };

    if (threadTs) {
      payload.thread_ts = threadTs;
    }

    let response: Response;
    try {
      response = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.botToken}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (fetchErr) {
      const cause = fetchErr instanceof Error ? fetchErr : undefined;
      return err(
        new ChannelError(`Slack chat.postMessage network error: ${String(fetchErr)}`, cause),
      );
    }

    let data: SlackPostMessageResult;
    try {
      data = (await response.json()) as SlackPostMessageResult;
    } catch {
      return err(
        new ChannelError(
          `Slack chat.postMessage: could not parse response (HTTP ${response.status})`,
        ),
      );
    }

    if (!data.ok) {
      const errorCode = data.error ?? 'unknown_error';
      return err(new ChannelError(`Slack chat.postMessage failed: ${errorCode}`));
    }

    return ok(undefined);
  }

  /**
   * Convert a Markdown string to Slack mrkdwn format.
   */
  format(markdown: string): string {
    return markdownToSlackMrkdwn(markdown);
  }

  get botUserId(): string | undefined {
    return this._botUserId;
  }

  setSiblingBotIds(_ids: Set<string>): void {
    // No-op: Slack connector already drops all messages with bot_id set.
  }

  // ---------------------------------------------------------------------------
  // Inbound event ingestion
  // ---------------------------------------------------------------------------

  /**
   * Feed a raw Slack event payload into the connector.
   *
   * This method is the entry point for inbound events from the Slack Events API
   * or Socket Mode. It normalizes the Slack event into an `InboundEvent` and
   * invokes the registered handler.
   *
   * Thread mapping:
   * - `externalThreadId` = `<channel>:<thread_ts>` when `thread_ts` is present
   * - `externalThreadId` = `<channel>` when there is no thread context
   *
   * Idempotency key:
   * - Prefers `event_id` from the envelope (globally unique per delivery)
   * - Falls back to `client_msg_id` from the message
   * - Falls back to `<channel>:<ts>` as a last resort
   *
   * Bot messages (those with a `bot_id` field) are silently dropped to prevent
   * the connector from reacting to its own outbound messages.
   *
   * @param event - Raw Slack event envelope payload.
   */
  async feedEvent(event: SlackEvent): Promise<void> {
    const message = event.event;

    if (!message) {
      this.logger.debug(
        { channelName: this.name },
        'slack event has no inner event object, skipping',
      );
      return;
    }

    // Only process message events.
    if (message.subtype && message.subtype !== 'bot_message') {
      this.logger.debug(
        { channelName: this.name, subtype: message.subtype },
        'slack message has non-standard subtype, skipping',
      );
      return;
    }

    // Drop bot messages (including from this bot itself).
    if (message.bot_id) {
      this.logger.debug(
        { channelName: this.name, botId: message.bot_id },
        'slack message from bot, skipping',
      );
      return;
    }

    if (!message.text) {
      this.logger.debug({ channelName: this.name }, 'slack message has no text, skipping');
      return;
    }

    // --- @mention filtering for shared channels ---
    // When the bot identity is known, enforce mention-based routing in
    // channels and groups (C/G prefixed IDs). DMs (D prefix) always pass.
    const channelId = message.channel;
    if (this._botUserId && channelId && !channelId.startsWith('D')) {
      const mentions = extractMentionedUserIds(message.text);
      if (mentions.size > 0 && !mentions.has(this._botUserId)) {
        // Message @mentions one or more bots, but not this one — skip.
        this.logger.debug(
          { channelName: this.name, mentions: [...mentions], botUserId: this._botUserId },
          'slack message mentions other bot(s), not this one — skipping',
        );
        return;
      }
      if (mentions.size === 0) {
        // No @mentions at all in a channel message — skip to avoid
        // multiple bots all responding to undirected messages.
        this.logger.debug(
          { channelName: this.name, botUserId: this._botUserId },
          'slack channel message has no @mentions — skipping',
        );
        return;
      }
    }
    const threadTs = message.thread_ts;

    // Build a compound external thread ID that encodes both channel and thread.
    const externalThreadId = threadTs ? encodeThreadId(channelId, threadTs) : channelId;

    // Determine sender ID.
    const senderId = message.user ?? channelId;

    // Determine idempotency key.
    const idempotencyKey = event.event_id ?? message.client_msg_id ?? `${channelId}:${message.ts}`;

    // Determine timestamp (Slack ts is a decimal string of Unix seconds).
    const timestamp = parseSlackTimestamp(message.ts);

    const inboundEvent: InboundEvent = {
      channelType: this.type,
      channelName: this.name,
      externalThreadId,
      senderId,
      idempotencyKey,
      content: message.text,
      timestamp,
      raw: event,
    };

    if (!this.handler) {
      this.logger.warn(
        { channelName: this.name },
        'slack connector received message but no handler is registered',
      );
      return;
    }

    try {
      await this.handler(inboundEvent);
    } catch (handlerErr) {
      this.logger.error(
        { channelName: this.name, err: handlerErr },
        'slack connector handler threw an error',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Socket Mode
  // ---------------------------------------------------------------------------

  /**
   * Reconnect loop for Socket Mode. Obtains a WSS URL via
   * `apps.connections.open`, connects, and re-connects with exponential
   * backoff on failure. Exits when `this.running` is set to false.
   */
  private async socketModeLoop(): Promise<void> {
    let backoffMs = INITIAL_BACKOFF_MS;

    while (this.running) {
      this.abortController = new AbortController();
      try {
        const wssUrl = await this.openSocketModeConnection();
        await this.runSocketMode(wssUrl);
        // Clean close (e.g. server-requested disconnect) — apply a short
        // backoff to avoid tight reconnect loops against the API.
        if (!this.running) break;
        backoffMs = INITIAL_BACKOFF_MS;
        await this.sleep(backoffMs);
      } catch (connectErr) {
        if (!this.running) break;
        this.logger.warn(
          { channelName: this.name, err: connectErr, backoffMs },
          'slack socket mode connection error, backing off',
        );
        await this.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  /**
   * Call `apps.connections.open` to obtain a WebSocket URL for Socket Mode.
   */
  private async openSocketModeConnection(): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${SLACK_API_BASE}/apps.connections.open`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${this.config.appToken}`,
        },
        signal: this.abortController?.signal,
      });
    } catch (fetchErr) {
      throw new ChannelError(
        `Slack apps.connections.open network error: ${String(fetchErr)}`,
      );
    }

    let data: { ok: boolean; url?: string; error?: string };
    try {
      data = (await response.json()) as typeof data;
    } catch {
      throw new ChannelError(
        `Slack apps.connections.open: could not parse response (HTTP ${response.status})`,
      );
    }

    if (!data.ok || !data.url) {
      throw new ChannelError(
        `Slack apps.connections.open failed (HTTP ${response.status}): ${data.error ?? 'no url returned'}`,
      );
    }

    this.logger.debug({ channelName: this.name }, 'obtained socket mode wss url');
    return data.url;
  }

  /**
   * Connect to the Socket Mode WSS URL and process messages until the
   * connection closes or an error occurs. Returns a promise that resolves
   * when the WebSocket closes.
   */
  private runSocketMode(wssUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wssUrl);
      this.ws = ws;

      ws.on('open', () => {
        this.logger.info({ channelName: this.name }, 'slack socket mode connected');
      });

      ws.on('message', (raw: Buffer) => {
        this.handleSocketModeMessage(ws, raw).catch((msgErr) => {
          this.logger.error(
            { channelName: this.name, err: msgErr },
            'error handling socket mode message',
          );
        });
      });

      ws.on('close', (code, reason) => {
        this.logger.info(
          { channelName: this.name, code, reason: reason.toString() },
          'slack socket mode disconnected',
        );
        // Only clear the reference if this is still the active socket —
        // prevents a late-firing stale socket from clearing a newer one.
        if (this.ws === ws) this.ws = undefined;
        resolve();
      });

      ws.on('error', (wsErr) => {
        this.logger.error(
          { channelName: this.name, err: wsErr },
          'slack socket mode websocket error',
        );
        // Terminate the socket to release resources before reconnecting.
        ws.terminate();
        if (this.ws === ws) this.ws = undefined;
        reject(wsErr);
      });
    });
  }

  /**
   * Handle a single Socket Mode envelope. Acknowledges the envelope
   * immediately, then routes the payload based on its type.
   */
  private async handleSocketModeMessage(ws: WebSocket, raw: Buffer): Promise<void> {
    let envelope: {
      envelope_id?: string;
      type?: string;
      payload?: Record<string, unknown>;
    };

    try {
      envelope = JSON.parse(raw.toString()) as typeof envelope;
    } catch {
      this.logger.debug({ channelName: this.name }, 'socket mode: unparseable message, skipping');
      return;
    }

    // Acknowledge the envelope immediately so Slack doesn't redeliver.
    if (envelope.envelope_id && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }

    // Handle hello — connection confirmation from Slack.
    if (envelope.type === 'hello') {
      this.logger.debug({ channelName: this.name }, 'socket mode: received hello');
      return;
    }

    // Handle disconnect — Slack is asking us to reconnect.
    if (envelope.type === 'disconnect') {
      this.logger.info({ channelName: this.name }, 'socket mode: received disconnect, reconnecting');
      ws.close(1000, 'server requested disconnect');
      return;
    }

    // Route events_api envelopes to feedEvent.
    if (envelope.type === 'events_api' && envelope.payload) {
      await this.feedEvent(envelope.payload as unknown as SlackEvent);
      return;
    }

    this.logger.debug(
      { channelName: this.name, type: envelope.type },
      'socket mode: unhandled envelope type',
    );
  }

  /**
   * Resolve after `ms` milliseconds. Resolves early if the abort controller
   * fires (e.g. during stop()), so shutdown is not blocked by long backoffs.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      // If the signal is already aborted (stop() called before sleep()),
      // resolve immediately to avoid stalling shutdown.
      if (this.abortController?.signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      this.abortController?.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Encode a channel ID and optional thread timestamp into a compound thread ID.
 *
 * The format is `<channelId>:<thread_ts>`. If `thread_ts` is not provided the
 * result is just the `channelId`.
 */
export function encodeThreadId(channelId: string, threadTs?: string): string {
  if (!threadTs) return channelId;
  return `${channelId}:${threadTs}`;
}

/**
 * Decode a compound thread ID back into channel ID and optional thread_ts.
 *
 * Slack thread_ts values look like "1234567890.123456" (contains a dot).
 * Channel IDs look like "C01234567" (no colon). The first colon is the separator.
 */
export function decodeThreadId(externalThreadId: string): {
  channelId: string;
  threadTs: string | undefined;
} {
  const colonIndex = externalThreadId.indexOf(':');
  if (colonIndex === -1) {
    return { channelId: externalThreadId, threadTs: undefined };
  }
  return {
    channelId: externalThreadId.slice(0, colonIndex),
    threadTs: externalThreadId.slice(colonIndex + 1),
  };
}

/**
 * Parse a Slack message timestamp string into Unix epoch milliseconds.
 *
 * Slack ts values are decimal strings of Unix seconds, e.g. "1700000000.123456".
 */
function parseSlackTimestamp(ts: string): number {
  const seconds = parseFloat(ts);
  return Math.round(seconds * 1000);
}

/**
 * Extract all Slack user IDs mentioned in a message text.
 *
 * Slack encodes mentions as `<@U12345678>` in the raw message text.
 * Returns a Set of user IDs (e.g. `U12345678`).
 */
export function extractMentionedUserIds(text: string): Set<string> {
  const ids = new Set<string>();
  let match: RegExpExecArray | null;
  // Reset lastIndex since MENTION_RE has the global flag.
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(text)) !== null) {
    ids.add(match[1]);
  }
  return ids;
}
