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
