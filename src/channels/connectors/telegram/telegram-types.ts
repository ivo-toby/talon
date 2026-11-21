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
  /**
   * When Talon's answer is sent as a native reply to the message that
   * triggered it: `groups` (default) in group chats only, `always`, or
   * `never`. A reply the agent requests explicitly is always sent as one.
   */
  replyToTrigger?: 'never' | 'groups' | 'always';
  /**
   * Forward emoji reactions that users place on Talon's messages to the
   * agent. Defaults to true. Telegram only delivers reactions in private
   * chats and in groups where the bot is an administrator.
   */
  inboundReactions?: boolean;
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
 * One delivered size/thumbnail rendition of a photo (Bot API `PhotoSize`).
 * A photo message carries an array of these; they are renditions of the SAME
 * photo (inventory E1), so they produce at most ONE Image candidate.
 * `file_size` is optional: unknown sizes need a bounded download check.
 */
export interface TelegramPhotoSize {
  /** File identifier — an opaque, token-free handle for getFile/download. */
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/**
 * A general file attached to a message (Bot API `Document`).
 * Eligibility is established by the DECLARED `mime_type` only — never by
 * `file_name` (inventory E1). Static image documents (e.g. image/webp) are
 * eligible image media.
 */
export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  /** Declared filename. Metadata only; never establishes MIME. */
  file_name?: string;
  /** Declared MIME type, e.g. "image/webp". */
  mime_type?: string;
  file_size?: number;
}

/**
 * A sticker (Bot API `Sticker`). Parsed so the connector can EXCLUDE stickers
 * silently (spec selection table): sticker content — including `thumb` and
 * static-WebP stickers — never becomes an Image candidate and is never
 * downloaded. The fields themselves are not consumed.
 */
export interface TelegramSticker {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  is_animated?: boolean;
  is_video?: boolean;
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
  /** Caption of a photo/document message; feeds the mention/trigger rules. */
  caption?: string;
  /** Special entities in the caption (mentions etc.); feeds the mention rules. */
  caption_entities?: TelegramMessageEntity[];
  /** Photo renditions (same photo); at most one Image candidate. */
  photo?: TelegramPhotoSize[];
  /** General file attachment; eligibility by declared mime_type only. */
  document?: TelegramDocument;
  /** Platform sticker — always excluded from image ingestion. */
  sticker?: TelegramSticker;
  /** Topic the message belongs to (forum supergroups and private chats). */
  message_thread_id?: number;
  /** True when the message was sent inside a topic. */
  is_topic_message?: boolean;
  /**
   * The message this one replies to. In a topic, a message that replies to
   * nothing still points at the topic's creation service message.
   */
  reply_to_message?: TelegramMessage;
  /** The part of the replied-to message the sender chose to quote. */
  quote?: { text?: string };
  /** Present on the service message that created a forum topic. */
  forum_topic_created?: unknown;
}

/**
 * One reaction on a message (Bot API `ReactionType`). Only `emoji` reactions
 * carry a portable emoji; `custom_emoji` and `paid` do not.
 */
export interface TelegramReactionType {
  type: string;
  emoji?: string;
}

/**
 * A change of a user's reactions on a message (Bot API
 * `MessageReactionUpdated`). Delivered only when `message_reaction` is listed
 * in `allowed_updates`, and never for reactions set by bots.
 */
export interface TelegramMessageReactionUpdated {
  chat: TelegramChat;
  message_id: number;
  /** The reacting user; absent for anonymous reactions. */
  user?: TelegramUser;
  /** The chat an anonymous reaction was made on behalf of. */
  actor_chat?: TelegramChat;
  /** Unix timestamp of the change. */
  date: number;
  old_reaction?: TelegramReactionType[];
  new_reaction?: TelegramReactionType[];
}

/**
 * A single update received from the Telegram Bot API.
 * Each update has a unique `update_id` used for offset tracking.
 */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  message_reaction?: TelegramMessageReactionUpdated;
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
 * Result of a Bot API call that returns `True` (setMessageReaction).
 */
export interface TelegramBooleanResult {
  ok: boolean;
  result?: boolean;
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

// ---------------------------------------------------------------------------
// File lookup / download (Bot API getFile — inventory E2)
// ---------------------------------------------------------------------------

/**
 * The `File` object returned inside a getFile envelope. `file_path` is present
 * ONLY for files the bot can download (≤ 20 MB, see
 * `TELEGRAM_MAX_DOWNLOAD_BYTES`); the bytes themselves are then served from
 * `https://api.telegram.org/file/bot<token>/<file_path>` as raw bytes, not
 * JSON. `file_path` is a download handle: never persisted or echoed.
 */
export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

/**
 * Response envelope of a getFile call (the general Bot API
 * ok/result/description/error_code envelope, pinned to inventory E2).
 */
export interface TelegramFileResult {
  ok: boolean;
  result?: TelegramFile;
  description?: string;
  error_code?: number;
}
