/**
 * Telegram channel connector.
 *
 * Implements the ChannelConnector interface using the Telegram Bot API with
 * long polling. Translates between the canonical InboundEvent / AgentOutput
 * types and Telegram Bot API payloads.
 */

import type pino from 'pino';
import type { ChannelConnector, InboundEvent, AgentOutput } from '../../channel-types.js';
import type { Result } from '../../../core/types/result.js';
import { ok, err } from '../../../core/types/result.js';
import { ChannelError } from '../../../core/errors/error-types.js';
import type {
  TelegramConfig,
  TelegramUpdate,
  TelegramUser,
  TelegramMessage,
  TelegramSendResult,
  TelegramUpdatesResult,
} from './telegram-types.js';
import { markdownToTelegram } from './telegram-format.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POLLING_TIMEOUT_SEC = 30;
/** Initial backoff after a poll error, in milliseconds. */
const INITIAL_BACKOFF_MS = 1_000;
/** Maximum backoff after repeated poll errors, in milliseconds. */
const MAX_BACKOFF_MS = 60_000;
/** Timeout for the getMe identity resolution call, in milliseconds. */
const GET_ME_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// TelegramConnector
// ---------------------------------------------------------------------------

/**
 * Channel connector for Telegram via Bot API long polling.
 *
 * Usage:
 * 1. Construct with a TelegramConfig and a channel name.
 * 2. Call `onMessage()` to register an inbound event handler.
 * 3. Call `start()` to begin polling.
 * 4. Call `stop()` to halt polling gracefully.
 */
export class TelegramConnector implements ChannelConnector {
  readonly type = 'telegram';
  readonly name: string;

  private _botUserId: string | undefined;
  private _botUsername: string | undefined;
  private siblingBotIds: Set<string> = new Set();

  private handler?: (event: InboundEvent) => void | Promise<void>;
  private running = false;
  /** Offset for getUpdates: last seen update_id + 1. */
  private offset = 0;
  private abortController?: AbortController;
  /** Promise tracking the active poll loop (used for clean shutdown). */
  private pollLoopPromise?: Promise<void>;

  constructor(
    private readonly config: TelegramConfig,
    private readonly channelName: string,
    private readonly logger: pino.Logger,
  ) {
    this.name = channelName;
  }

  /** The bot's own Telegram user ID, resolved during start() via getMe. */
  get botUserId(): string | undefined {
    return this._botUserId;
  }

  /**
   * Register sibling bot user IDs to filter from inbound messages.
   * Called by channel-setup after all connectors have started.
   */
  setSiblingBotIds(ids: Set<string>): void {
    this.siblingBotIds = new Set(ids);
  }

  // ---------------------------------------------------------------------------
  // ChannelConnector lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start long polling. Idempotent — no-op if already running.
   * Resolves the bot's own user ID via getMe before entering the poll loop.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.debug({ channelName: this.name }, 'telegram connector already running');
      return;
    }
    this.running = true;
    this._botUserId = undefined; // Clear stale value from previous start cycle.
    this.abortController = new AbortController();
    this.logger.info({ channelName: this.name }, 'telegram connector starting');

    // Resolve bot identity so we can filter our own messages.
    try {
      const response = await fetch(this.apiUrl('getMe'), {
        signal: AbortSignal.any([
          this.abortController.signal,
          AbortSignal.timeout(GET_ME_TIMEOUT_MS),
        ]),
      });
      const data = (await response.json()) as { ok: boolean; result?: TelegramUser };
      if (data.ok && data.result) {
        this._botUserId = String(data.result.id);
        this._botUsername = data.result.username;
        this.logger.info(
          { channelName: this.name, botUserId: this._botUserId, botUsername: this._botUsername },
          'telegram bot identity resolved',
        );
      } else {
        this.logger.warn(
          { channelName: this.name },
          'telegram getMe returned ok=false, bot identity unknown',
        );
      }
    } catch (getMeErr) {
      this.logger.warn(
        { channelName: this.name, err: getMeErr },
        'telegram getMe failed, bot identity unknown',
      );
    }

    // Launch the poll loop in the background; store the promise for stop().
    this.pollLoopPromise = this.pollLoop();
  }

  /**
   * Stop polling gracefully. Idempotent — no-op if already stopped.
   * Waits for the current in-flight getUpdates request to be aborted before
   * returning.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.logger.info({ channelName: this.name }, 'telegram connector stopping');
    // Abort any pending fetch so the poll loop unblocks immediately.
    this.abortController?.abort();
    // Wait for the loop to exit cleanly.
    await this.pollLoopPromise;
    this.pollLoopPromise = undefined;
    this.logger.info({ channelName: this.name }, 'telegram connector stopped');
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
   * Send an AgentOutput to a Telegram chat.
   *
   * @param externalThreadId - Telegram chat_id (as a string).
   * @param output            - Agent output to deliver.
   */
  async send(externalThreadId: string, output: AgentOutput): Promise<Result<void, ChannelError>> {
    const text = this.format(output.body);

    const url = this.apiUrl('sendMessage');
    const body = JSON.stringify({
      chat_id: externalThreadId,
      text,
      parse_mode: 'MarkdownV2',
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (fetchErr) {
      const cause = fetchErr instanceof Error ? fetchErr : undefined;
      return err(
        new ChannelError(`Telegram sendMessage network error: ${String(fetchErr)}`, cause),
      );
    }

    let data: TelegramSendResult;
    try {
      data = (await response.json()) as TelegramSendResult;
    } catch {
      return err(
        new ChannelError(
          `Telegram sendMessage: could not parse response (HTTP ${response.status})`,
        ),
      );
    }

    if (!data.ok) {
      const description = data.description ?? 'unknown error';
      const code = data.error_code ?? response.status;
      return err(new ChannelError(`Telegram sendMessage failed (${code}): ${description}`));
    }

    return ok(undefined);
  }

  /**
   * Send a "typing" chat action to Telegram.
   * The indicator auto-expires after ~5 seconds on the client side.
   */
  async sendTyping(externalThreadId: string): Promise<void> {
    try {
      await fetch(this.apiUrl('sendChatAction'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: externalThreadId, action: 'typing' }),
      });
    } catch {
      // Non-critical — swallow errors silently.
    }
  }

  /**
   * Convert a Markdown string to Telegram MarkdownV2 format.
   */
  format(markdown: string): string {
    return markdownToTelegram(markdown);
  }

  // ---------------------------------------------------------------------------
  // Polling loop
  // ---------------------------------------------------------------------------

  /**
   * Long-poll loop. Runs until `running` is set to false.
   * Applies exponential backoff on errors with a maximum cap.
   */
  private async pollLoop(): Promise<void> {
    let backoffMs = INITIAL_BACKOFF_MS;

    while (this.running) {
      try {
        const updates = await this.getUpdates();
        // Reset backoff after a successful request.
        backoffMs = INITIAL_BACKOFF_MS;

        for (const update of updates) {
          // Always advance offset regardless of whether we handle the update,
          // to avoid re-processing updates that fail validation.
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (err) {
        if (!this.running) {
          // Aborted by stop() — exit the loop cleanly.
          break;
        }

        this.logger.warn(
          { channelName: this.name, err, backoffMs },
          'telegram poll error, backing off',
        );

        await this.sleep(backoffMs);
        // Exponential backoff capped at MAX_BACKOFF_MS.
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  /**
   * Fetch the next batch of updates from the Telegram Bot API.
   * Uses AbortController so that stop() can cancel an in-flight request.
   */
  private async getUpdates(): Promise<TelegramUpdate[]> {
    const timeoutSec = this.config.pollingTimeoutSec ?? DEFAULT_POLLING_TIMEOUT_SEC;
    const url = this.apiUrl('getUpdates');
    const params = new URLSearchParams({
      offset: String(this.offset),
      timeout: String(timeoutSec),
    });

    this.abortController = new AbortController();

    const response = await fetch(`${url}?${params}`, {
      signal: this.abortController.signal,
    });

    const data = (await response.json()) as TelegramUpdatesResult;

    if (!data.ok) {
      throw new ChannelError(
        `Telegram getUpdates failed (${data.error_code ?? response.status}): ${data.description ?? 'unknown error'}`,
      );
    }

    return data.result ?? [];
  }

  // ---------------------------------------------------------------------------
  // Update handling
  // ---------------------------------------------------------------------------

  /**
   * Normalise a TelegramUpdate into an InboundEvent and invoke the handler.
   * Updates without a text message (e.g. photos, stickers) are dropped.
   */
  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;

    if (!message?.text) {
      this.logger.debug(
        { channelName: this.name, updateId: update.update_id },
        'telegram update has no text, skipping',
      );
      return;
    }

    const chatId = String(message.chat.id);
    const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup';

    // Drop group messages unless explicitly enabled.
    if (isGroup && !this.config.allowGroupChats) {
      this.logger.debug(
        { channelName: this.name, chatId, chatType: message.chat.type },
        'telegram group message received but allowGroupChats is not enabled, dropping',
      );
      return;
    }

    // Enforce allowedChatIds restriction if configured.
    if (
      this.config.allowedChatIds &&
      this.config.allowedChatIds.length > 0 &&
      !this.config.allowedChatIds.includes(chatId)
    ) {
      this.logger.warn(
        { channelName: this.name, chatId },
        'telegram message from disallowed chat, dropping',
      );
      return;
    }

    // Drop messages from bots to prevent feedback loops.
    if (message.from?.is_bot) {
      this.logger.debug(
        { channelName: this.name, fromId: message.from.id },
        'telegram message from bot, dropping',
      );
      return;
    }

    // Drop messages from sibling bot user IDs.
    const fromId = message.from ? String(message.from.id) : undefined;
    if (fromId && this.siblingBotIds.has(fromId)) {
      this.logger.debug(
        { channelName: this.name, fromId },
        'telegram message from sibling bot, dropping',
      );
      return;
    }

    // Apply mention/trigger filter and resolve final message text.
    let content = message.text;

    if (isGroup) {
      // In groups the bot only responds when @mentioned by username or when a
      // triggerWord matches. Strip the matched prefix before forwarding.
      const result = this.extractGroupContent(message);
      if (!result) {
        this.logger.debug(
          { channelName: this.name, chatId },
          'telegram group message has no @mention or trigger word, dropping',
        );
        return;
      }
      content = result;
    } else {
      // In DMs, apply triggerWords filter if configured.
      const triggerWords = this.config.triggerWords;
      if (triggerWords && triggerWords.length > 0) {
        const lower = content.toLowerCase();
        const matched = triggerWords.find((tw) => lower.startsWith(tw.toLowerCase()));
        if (!matched) {
          this.logger.debug(
            { channelName: this.name, chatId },
            'telegram DM message has no trigger word, dropping',
          );
          return;
        }
        content = content.slice(matched.length).trimStart();
        if (!content) return;
      }
    }

    const senderId = message.from ? String(message.from.id) : chatId;

    const event: InboundEvent = {
      channelType: this.type,
      channelName: this.name,
      externalThreadId: chatId,
      senderId,
      idempotencyKey: String(update.update_id),
      content,
      timestamp: message.date * 1000, // Telegram sends seconds; we want ms
      raw: update,
    };

    if (!this.handler) {
      this.logger.warn(
        { channelName: this.name },
        'telegram connector received message but no handler is registered',
      );
      return;
    }

    try {
      await this.handler(event);
    } catch (handlerErr) {
      this.logger.error(
        { channelName: this.name, err: handlerErr },
        'telegram connector handler threw an error',
      );
    }
  }

  /**
   * For group messages: check if the text contains the bot's @mention (detected
   * via Telegram entities for precision) or starts with a configured trigger word.
   * Returns the stripped content on match, or null if neither condition is met.
   */
  private extractGroupContent(message: TelegramMessage): string | null {
    const text = message.text;
    if (!text) return null;

    const botUsername = this._botUsername;

    // Use Telegram entities for exact @mention detection — avoids false
    // positives like "@talon" matching "@talon2".
    if (botUsername && message.entities) {
      for (const entity of message.entities) {
        if (entity.type === 'mention') {
          const mentionText = text.slice(entity.offset, entity.offset + entity.length);
          if (mentionText.toLowerCase() === `@${botUsername.toLowerCase()}`) {
            // Strip the specific mention by position, then clean up surrounding whitespace.
            const stripped = (
              text.slice(0, entity.offset) + text.slice(entity.offset + entity.length)
            ).trim();
            return stripped || null;
          }
        }
      }
    }

    // Fall back to triggerWords prefix match.
    const triggerWords = this.config.triggerWords;
    if (triggerWords && triggerWords.length > 0) {
      const lower = text.toLowerCase();
      const matched = triggerWords.find((tw) => lower.startsWith(tw.toLowerCase()));
      if (matched) {
        const stripped = text.slice(matched.length).trimStart();
        return stripped || null;
      }
    }

    return null;
  }

  /**
   * Public wrapper around handleUpdate for testing purposes.
   * Accepts an unknown payload and casts it to TelegramUpdate.
   */
  async handleUpdatePublic(update: unknown): Promise<void> {
    await this.handleUpdate(update as TelegramUpdate);
  }

  // ---------------------------------------------------------------------------
  // Internal utilities
  // ---------------------------------------------------------------------------

  /**
   * Build a Telegram Bot API URL for the given method.
   */
  private apiUrl(method: string): string {
    return `https://api.telegram.org/bot${this.config.botToken}/${method}`;
  }

  /**
   * Resolve after `ms` milliseconds. Respects abort during shutdown.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
