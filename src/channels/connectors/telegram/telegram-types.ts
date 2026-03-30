/**
 * Telegram Bot API types used by the connector.
 *
 * These represent only the fields that the connector uses from the Telegram
 * Bot API responses. Additional fields exist in the real API but are omitted
 * here unless needed.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a TelegramConnector instance.
 */
export interface TelegramConfig {
  /** Bot token from BotFather, e.g. "123456:ABC-DEF..." */
  botToken: string;
  /**
   * Long-poll timeout in seconds passed to getUpdates.
   * Defaults to 30 if not set.
   */
  pollingTimeoutSec?: number;
  /**
   * Optional allowlist of Telegram chat IDs (as strings).
   * If set, messages from chats not in this list are silently dropped.
   */
  allowedChatIds?: string[];
}

// ---------------------------------------------------------------------------
// Telegram API objects
// ---------------------------------------------------------------------------

/**
 * A Telegram user or bot.
 */
export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

/**
 * A Telegram chat (private, group, supergroup, or channel).
 */
export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
}

/**
 * A Telegram message object.
 * Only fields relevant to the connector are included.
 */
export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  /** Unix timestamp of the message. */
  date: number;
  /** Text of the message (absent for non-text messages). */
  text?: string;
}

/**
 * A single update received from the Telegram Bot API.
 * Each update has a unique `update_id` used for offset tracking.
 */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

// ---------------------------------------------------------------------------
// API response wrappers
// ---------------------------------------------------------------------------

/**
 * Result of a sendMessage API call.
 */
export interface TelegramSendResult {
  ok: boolean;
  result?: TelegramMessage;
  description?: string;
  error_code?: number;
}

/**
 * Result of a getUpdates API call.
 */
export interface TelegramUpdatesResult {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
  error_code?: number;
}
