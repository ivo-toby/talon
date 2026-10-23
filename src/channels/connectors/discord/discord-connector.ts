/**
 * Discord channel connector.
 *
 * Implements the ChannelConnector interface using Discord's REST API for
 * outbound messages and a self-managed Gateway WebSocket for inbound events.
 * The connector establishes a persistent Gateway connection with automatic
 * reconnect (exponential backoff), heartbeat management, and RESUME support.
 */

import type pino from 'pino';
import WebSocket from 'ws';
import type { ChannelConnector, InboundEvent, AgentOutput } from '../../channel-types.js';
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
  DiscordGatewayHello,
  DiscordGatewayReady,
} from './discord-types.js';
import { DEFAULT_INTENTS } from './discord-types.js';
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

/** Initial backoff after a Gateway connection error, in milliseconds. */
const INITIAL_BACKOFF_MS = 1_000;

/** Maximum backoff after repeated connection errors, in milliseconds. */
const MAX_BACKOFF_MS = 60_000;

/** Discord Gateway protocol version to use. */
const DISCORD_GATEWAY_VERSION = 10;

/**
 * Discord WebSocket close codes that require clearing session state and
 * re-IDENTIFYing rather than attempting a RESUME.
 */
const NON_RESUMABLE_CLOSE_CODES = new Set([4007, 4009]);

/**
 * Discord WebSocket close codes that indicate a fatal configuration error.
 * The connector stops reconnecting when it receives one of these.
 * 4004 = Authentication failed, 4010 = Invalid shard, 4011 = Sharding required,
 * 4012 = Invalid API version, 4013 = Invalid intent(s), 4014 = Disallowed intent(s).
 */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

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
 * Channel connector for Discord via REST API + Gateway WebSocket.
 *
 * `start()` opens a persistent Gateway WebSocket connection with automatic
 * reconnect (exponential backoff 1s → 60s). The connector manages heartbeats,
 * handles IDENTIFY on fresh connections, and sends RESUME when a prior session
 * exists after a disconnect.
 *
 * Usage:
 * 1. Construct with a DiscordConfig and a channel name.
 * 2. Call `onMessage()` to register an inbound event handler.
 * 3. Call `start()` to open the Gateway connection.
 * 4. Call `stop()` to disconnect gracefully.
 */
export class DiscordConnector implements ChannelConnector {
  readonly type = 'discord';
  readonly name: string;

  private handler?: (event: InboundEvent) => void | Promise<void>;

  // Lifecycle
  private running = false;
  /** Active Gateway WebSocket, if connected. */
  private ws?: WebSocket;
  /** Promise tracking the Gateway reconnect loop. */
  private gatewayLoopPromise?: Promise<void>;
  /** AbortController for cancelling sleep and in-flight fetch during stop(). */
  private abortController?: AbortController;

  // Gateway session state
  private sessionId?: string;
  private resumeGatewayUrl?: string;
  private lastSequence: number | null = null;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  /** Jitter setTimeout handle — stored so it can be cleared on stop/reconnect. */
  private heartbeatJitterTimer?: ReturnType<typeof setTimeout>;
  /**
   * Set to true when a heartbeat is sent; cleared when op 11 ACK is received.
   * If a second heartbeat fires while this is true the socket is considered a
   * zombie and is terminated so the reconnect loop can establish a new session.
   */
  private awaitingHeartbeatAck = false;
  /**
   * The close code received from the last WebSocket close event.
   * Used by gatewayLoop to decide whether to reconnect, clear session, or stop.
   */
  private lastCloseCode: number | null = null;

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
   * Start the connector. Opens a Discord Gateway WebSocket connection with
   * automatic reconnect on failure. Idempotent — no-op if already running.
   */
  start(): Promise<void> {
    if (this.running) {
      this.logger.debug({ channelName: this.name }, 'discord connector already running');
      return Promise.resolve();
    }
    this.running = true;
    this.logger.info({ channelName: this.name }, 'discord connector starting (gateway)');
    this.gatewayLoopPromise = this.gatewayLoop();
    return Promise.resolve();
  }

  /**
   * Stop the connector gracefully. Closes the Gateway WebSocket and waits for
   * the reconnect loop to exit. Idempotent — no-op if already stopped.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.logger.info({ channelName: this.name }, 'discord connector stopping');

    // Abort any in-flight fetch or sleep so the reconnect loop unblocks.
    this.abortController?.abort();

    // Stop heartbeat timer.
    this.stopHeartbeat();

    // Close the WebSocket so the reconnect loop exits.
    if (this.ws) {
      this.ws.close(1000, 'connector stopping');
      this.ws = undefined;
    }

    // Wait for the reconnect loop to exit cleanly.
    await this.gatewayLoopPromise;
    this.gatewayLoopPromise = undefined;
    this.logger.info({ channelName: this.name }, 'discord connector stopped');
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
   * This method is also called internally by the Gateway WebSocket handler
   * whenever a new DISPATCH event is received. It can also be called externally
   * for testing purposes.
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
  async send(externalThreadId: string, output: AgentOutput): Promise<Result<void, ChannelError>> {
    const { channelId, messageId } = decodeThreadId(externalThreadId);
    const content = this.format(output.body);

    const body: DiscordSendMessageBody = { content };
    if (messageId) {
      body.message_reference = { message_id: messageId };
    }

    return this.sendWithRateLimitRetry(channelId, body, 0);
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
  // Gateway — reconnect loop
  // ---------------------------------------------------------------------------

  /**
   * Reconnect loop for the Discord Gateway. Fetches a WSS URL via
   * GET /gateway/bot, connects, and re-connects with exponential backoff on
   * failure. Exits when `this.running` is set to false.
   */
  private async gatewayLoop(): Promise<void> {
    let backoffMs = INITIAL_BACKOFF_MS;

    while (this.running) {
      this.abortController = new AbortController();
      this.lastCloseCode = null;
      try {
        const gatewayUrl = await this.fetchGatewayUrl();
        await this.runGateway(gatewayUrl);

        if (!this.running) break;

        const code = this.lastCloseCode;

        // Fatal codes (bad token, invalid config) — stop reconnecting.
        if (code !== null && FATAL_CLOSE_CODES.has(code)) {
          this.running = false;
          this.logger.error(
            { channelName: this.name, code },
            'discord gateway: fatal close code, connector stopped',
          );
          break;
        }

        // Non-resumable codes — clear session so next connection IDENTIFYs.
        if (code !== null && NON_RESUMABLE_CLOSE_CODES.has(code)) {
          this.logger.warn(
            { channelName: this.name, code },
            'discord gateway: non-resumable close code, clearing session',
          );
          this.sessionId = undefined;
          this.resumeGatewayUrl = undefined;
          this.lastSequence = null;
        }

        // Apply a short backoff to avoid tight reconnect loops.
        backoffMs = INITIAL_BACKOFF_MS;
        await this.sleep(backoffMs);
      } catch (connectErr) {
        if (!this.running) break;
        this.logger.warn(
          { channelName: this.name, err: connectErr, backoffMs },
          'discord gateway connection error, backing off',
        );
        await this.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  /**
   * Fetch the Discord Gateway WebSocket URL via GET /gateway/bot.
   * Returns the URL with version and encoding query parameters appended.
   */
  private async fetchGatewayUrl(): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${DISCORD_API_BASE}/gateway/bot`, {
        headers: { Authorization: `Bot ${this.config.botToken}` },
        signal: this.abortController?.signal,
      });
    } catch (fetchErr) {
      throw new ChannelError(`Discord gateway URL fetch error: ${String(fetchErr)}`);
    }
    if (!response.ok) {
      throw new ChannelError(`Discord /gateway/bot failed (HTTP ${response.status})`);
    }
    const data = (await response.json()) as { url: string };
    if (!data.url) throw new ChannelError('Discord /gateway/bot returned no url');
    return `${data.url}?v=${DISCORD_GATEWAY_VERSION}&encoding=json`;
  }

  /**
   * Connect to the Discord Gateway WSS URL and process messages until the
   * connection closes or an error occurs. Uses `resume_gateway_url` when a
   * prior session exists. Returns a promise that resolves when the WebSocket
   * closes.
   */
  private runGateway(url: string): Promise<void> {
    // Use resume_gateway_url if we have a session to resume.
    const connectUrl =
      this.sessionId && this.resumeGatewayUrl
        ? `${this.resumeGatewayUrl}?v=${DISCORD_GATEWAY_VERSION}&encoding=json`
        : url;

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(connectUrl);
      this.ws = ws;

      ws.on('open', () => {
        this.logger.info({ channelName: this.name }, 'discord gateway connected');
      });

      ws.on('message', (raw: Buffer) => {
        this.handleGatewayMessage(ws, raw).catch((err) => {
          this.logger.error({ channelName: this.name, err }, 'error handling gateway message');
        });
      });

      ws.on('close', (code, reason) => {
        this.logger.info(
          { channelName: this.name, code, reason: reason.toString() },
          'discord gateway disconnected',
        );
        this.stopHeartbeat();
        this.lastCloseCode = code;
        // Only clear the reference if this is still the active socket —
        // prevents a late-firing stale socket from clearing a newer one.
        if (this.ws === ws) this.ws = undefined;
        resolve();
      });

      ws.on('error', (wsErr) => {
        this.logger.error(
          { channelName: this.name, err: wsErr },
          'discord gateway websocket error',
        );
        // Terminate the socket to release resources before reconnecting.
        ws.terminate();
        if (this.ws === ws) this.ws = undefined;
        reject(wsErr);
      });
    });
  }

  /**
   * Handle a single raw Gateway message. Tracks sequence numbers, routes
   * opcodes to the appropriate handler, and delegates DISPATCH events to
   * `feedEvent()`.
   */
  private async handleGatewayMessage(ws: WebSocket, raw: Buffer): Promise<void> {
    let payload: DiscordGatewayEvent;
    try {
      payload = JSON.parse(raw.toString()) as DiscordGatewayEvent;
    } catch {
      this.logger.debug(
        { channelName: this.name },
        'discord gateway: unparseable message, skipping',
      );
      return;
    }

    // Track sequence number for heartbeats and RESUME.
    if (payload.s !== null && payload.s !== undefined) {
      this.lastSequence = payload.s;
    }

    switch (payload.op) {
      case 10: {
        // OP 10 HELLO — start heartbeat and identify/resume
        const hello = payload.d as DiscordGatewayHello;
        this.startHeartbeat(ws, hello.heartbeat_interval);
        if (this.sessionId) {
          // Attempt to resume the previous session.
          // Gateway token payload uses the raw token (no "Bot " prefix).
          this.sendGatewayPayload(ws, 6, {
            token: this.config.botToken,
            session_id: this.sessionId,
            seq: this.lastSequence ?? 0,
          });
          this.logger.debug({ channelName: this.name }, 'discord gateway: sent RESUME');
        } else {
          // Fresh IDENTIFY.
          // Gateway token payload uses the raw token (no "Bot " prefix).
          this.sendGatewayPayload(ws, 2, {
            token: this.config.botToken,
            intents: this.config.intents ?? DEFAULT_INTENTS,
            properties: { os: 'linux', browser: 'talon', device: 'talon' },
          });
          this.logger.debug({ channelName: this.name }, 'discord gateway: sent IDENTIFY');
        }
        break;
      }
      case 0: {
        // OP 0 DISPATCH — inbound event
        if (payload.t === 'READY') {
          const ready = payload.d as DiscordGatewayReady;
          this.sessionId = ready.session_id;
          this.resumeGatewayUrl = ready.resume_gateway_url;
          this.logger.info(
            { channelName: this.name, sessionId: this.sessionId },
            'discord gateway: READY',
          );
        }
        await this.feedEvent(payload);
        break;
      }
      case 1: {
        // OP 1 HEARTBEAT — server is requesting an immediate heartbeat
        this.sendGatewayPayload(ws, 1, this.lastSequence);
        break;
      }
      case 7: {
        // OP 7 RECONNECT — server wants us to reconnect.
        // Use close code 4000 so Discord does NOT invalidate the session,
        // which allows us to attempt RESUME on the next connection.
        // (Codes 1000/1001 are treated by Discord as intent to end the session.)
        this.logger.info(
          { channelName: this.name },
          'discord gateway: server requested reconnect',
        );
        ws.close(4000, 'server requested reconnect');
        break;
      }
      case 9: {
        // OP 9 INVALID_SESSION — session is invalid; resumable if d === true.
        const resumable = payload.d as boolean;
        if (!resumable) {
          // Non-resumable: clear session state so the next connection IDENTIFYs.
          this.sessionId = undefined;
          this.resumeGatewayUrl = undefined;
          this.lastSequence = null;
        }
        this.logger.warn(
          { channelName: this.name, resumable },
          'discord gateway: invalid session',
        );
        // Use 4000 for resumable sessions to preserve them; use 1000 for
        // non-resumable to signal a clean close (session already cleared above).
        ws.close(resumable ? 4000 : 1000, 'invalid session');
        break;
      }
      case 11: {
        // OP 11 HEARTBEAT_ACK — server acknowledged our heartbeat
        this.awaitingHeartbeatAck = false;
        this.logger.debug({ channelName: this.name }, 'discord gateway: heartbeat ack');
        break;
      }
      default:
        this.logger.debug(
          { channelName: this.name, op: payload.op },
          'discord gateway: unhandled opcode',
        );
    }
  }

  // ---------------------------------------------------------------------------
  // Gateway — heartbeat
  // ---------------------------------------------------------------------------

  /**
   * Start sending periodic heartbeats. Uses a random initial jitter delay to
   * avoid thundering-herd reconnects, then sends at the specified interval.
   *
   * Both the jitter setTimeout and the recurring setInterval handles are
   * tracked so stopHeartbeat() can cancel them at any point.
   */
  private startHeartbeat(ws: WebSocket, intervalMs: number): void {
    this.stopHeartbeat();
    this.awaitingHeartbeatAck = false;

    const sendHeartbeat = (label: string) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingHeartbeatAck) {
        // Previous heartbeat was never acknowledged — zombie connection.
        this.logger.warn(
          { channelName: this.name },
          'discord gateway: heartbeat ACK missed, terminating zombie connection',
        );
        ws.terminate();
        return;
      }
      this.awaitingHeartbeatAck = true;
      this.sendGatewayPayload(ws, 1, this.lastSequence);
      this.logger.debug({ channelName: this.name }, `discord gateway: heartbeat sent (${label})`);
    };

    const jitteredTimeout = Math.floor(Math.random() * intervalMs);
    this.heartbeatJitterTimer = setTimeout(() => {
      this.heartbeatJitterTimer = undefined;
      sendHeartbeat('jitter');
      this.heartbeatTimer = setInterval(() => sendHeartbeat('interval'), intervalMs);
    }, jitteredTimeout);
  }

  /**
   * Stop and clear both the heartbeat interval and any pending jitter timeout.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatJitterTimer !== undefined) {
      clearTimeout(this.heartbeatJitterTimer);
      this.heartbeatJitterTimer = undefined;
    }
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.awaitingHeartbeatAck = false;
  }

  /**
   * Send a Gateway payload to Discord via the WebSocket, if it is open.
   */
  private sendGatewayPayload(ws: WebSocket, op: number, d: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ op, d }));
    }
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
    body: DiscordSendMessageBody,
    retryCount: number,
  ): Promise<Result<void, ChannelError>> {
    const url = `${DISCORD_API_BASE}/channels/${channelId}/messages`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${this.config.botToken}`,
        },
        body: JSON.stringify(body),
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

    // Parse the response to confirm success (and log the message ID).
    try {
      const result = (await response.json()) as DiscordSendMessageResult;
      this.logger.debug(
        { channelName: this.name, channelId, messageId: result.id },
        'discord message sent',
      );
    } catch {
      // Non-fatal — the send succeeded (2xx status).
    }

    return ok(undefined);
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
      this.abortController?.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
