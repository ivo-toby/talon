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
  /**
   * Allow messages from group and supergroup chats.
   * In group chats the bot only responds when @mentioned by username or when
   * a message starts with one of the configured triggerWords.
   * Defaults to false.
   */
  allowGroupChats?: boolean;
  /**
   * Optional trigger words. A message must start with one of these (case-
   * insensitive) for the bot to respond. The matched prefix is stripped before
   * the message reaches the agent. Applies to both DMs and group chats.
   */
  triggerWords?: string[];
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
 * A Telegram message entity (bold, mention, etc.).
 */
export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  /** For type 'text_mention', the user object. */
  user?: TelegramUser;
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
  /** Special entities in the message text (mentions, commands, etc.). */
  entities?: TelegramMessageEntity[];
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
