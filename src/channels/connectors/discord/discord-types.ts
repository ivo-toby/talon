/**
 * Discord API types used by the connector.
 *
 * Covers the Discord REST API v10 and Gateway event payloads that the
 * connector needs. Additional fields exist in the real API but are omitted
 * unless needed.
 *
 * Reference: https://discord.com/developers/docs/reference
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a DiscordConnector instance.
 */
export interface DiscordConfig {
  /** Bot token from the Discord developer portal, e.g. "Bot MTk..." */
  botToken: string;
  /** Discord application ID (snowflake string). */
  applicationId: string;
  /**
   * Optional guild (server) ID restriction.
   * If set, messages from other guilds are silently dropped.
   */
  guildId?: string;
  /**
   * Optional allowlist of Discord channel IDs (as strings).
   * If set, messages from channels not in this list are silently dropped.
   */
  allowedChannelIds?: string[];
  /**
   * Gateway intents bitmask.
   * Defaults to GUILD_MESSAGES (1 << 9) | MESSAGE_CONTENT (1 << 15) = 33280.
   */
  intents?: number;
}

// ---------------------------------------------------------------------------
// Discord Gateway intent constants
// ---------------------------------------------------------------------------

/**
 * Common Discord Gateway intent flags.
 */
export const DiscordIntents = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  MESSAGE_CONTENT: 1 << 15,
  DIRECT_MESSAGES: 1 << 12,
} as const;

/** Default intents: GUILD_MESSAGES + MESSAGE_CONTENT */
export const DEFAULT_INTENTS = DiscordIntents.GUILD_MESSAGES | DiscordIntents.MESSAGE_CONTENT;

// ---------------------------------------------------------------------------
// Discord API objects
// ---------------------------------------------------------------------------

/**
 * A Discord user object.
 */
export interface DiscordUser {
  /** Snowflake ID. */
  id: string;
  username: string;
  discriminator?: string;
  /** Whether this user is a bot. */
  bot?: boolean;
}

/**
 * A Discord guild member object (partial).
 */
export interface DiscordGuildMember {
  user?: DiscordUser;
  nick?: string;
}

/**
 * Message reference for replies and thread metadata.
 */
export interface DiscordMessageReference {
  /** The snowflake ID of the message being replied to. */
  message_id?: string;
  /** The snowflake ID of the channel containing the original message. */
  channel_id?: string;
  /** The snowflake ID of the guild. */
  guild_id?: string;
}

/**
 * A Discord message object.
 * Only fields relevant to the connector are included.
 */
export interface DiscordMessage {
  /** Snowflake ID of this message. */
  id: string;
  /** Snowflake ID of the channel this message was sent in. */
  channel_id: string;
  /** The author of the message. */
  author: DiscordUser;
  /** The content of the message. */
  content: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Optional reference for replies. */
  message_reference?: DiscordMessageReference;
  /** Guild ID if the message was sent in a guild. */
  guild_id?: string;
  /** Guild member info if sent in a guild. */
  member?: DiscordGuildMember;
}

// ---------------------------------------------------------------------------
// Discord REST API payloads
// ---------------------------------------------------------------------------

/**
 * Request body for POST /channels/{channelId}/messages.
 */
export interface DiscordSendMessageBody {
  /** Message content (up to 2000 characters). */
  content: string;
  /** Optional reference for replies. */
  message_reference?: {
    message_id: string;
  };
}

/**
 * Successful response from POST /channels/{channelId}/messages.
 */
export interface DiscordSendMessageResult {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
}

/**
 * Discord REST API error response.
 */
export interface DiscordApiError {
  code: number;
  message: string;
  errors?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Parsed rate-limit information from Discord response headers.
 */
export interface DiscordRateLimitInfo {
  /** Remaining requests in the current window. */
  remaining: number;
  /** Seconds to wait before retrying after hitting a rate limit. */
  resetAfter: number;
  /** Retry-After header value (seconds) if a 429 was received. */
  retryAfter?: number;
}

// ---------------------------------------------------------------------------
// Discord Gateway events
// ---------------------------------------------------------------------------

/**
 * A raw Discord Gateway event dispatch payload.
 * The connector receives these via an external gateway connection and
 * processes them via `feedEvent()`.
 */
export interface DiscordGatewayEvent {
  /** Event opcode. 0 = DISPATCH. */
  op: number;
  /** Dispatch event name (e.g. "MESSAGE_CREATE"). */
  t?: string;
  /** Sequence number for resuming. */
  s?: number;
  /** Event data payload. */
  d?: unknown;
}

/**
 * Data payload of a MESSAGE_CREATE gateway event.
 */
export type DiscordMessageCreateEvent = DiscordMessage;

// ---------------------------------------------------------------------------
// Discord Gateway opcodes and protocol types
// ---------------------------------------------------------------------------

/**
 * Discord Gateway opcode constants.
 * Reference: https://discord.com/developers/docs/topics/opcodes-and-status-codes
 */
export const DiscordGatewayOpcodes = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/**
 * Payload received in OP 10 HELLO — contains the heartbeat interval.
 */
export interface DiscordGatewayHello {
  heartbeat_interval: number;
}

/**
 * Payload received in OP 0 READY dispatch event.
 */
export interface DiscordGatewayReady {
  session_id: string;
  resume_gateway_url: string;
  v: number;
}

/**
 * Payload sent in OP 2 IDENTIFY — authenticates the connection.
 */
export interface DiscordGatewayIdentify {
  token: string;
  intents: number;
  properties: {
    os: string;
    browser: string;
    device: string;
  };
}

/**
 * Payload sent in OP 6 RESUME — resumes a previous session.
 */
export interface DiscordGatewayResume {
  token: string;
  session_id: string;
  seq: number;
}
