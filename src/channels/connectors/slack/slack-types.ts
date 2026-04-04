/**
 * Slack API types used by the connector.
 *
 * These represent only the fields that the connector uses from the Slack API
 * responses. Additional fields exist in the real API but are omitted here
 * unless needed.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a SlackConnector instance.
 */
export interface SlackConfig {
  /** Bot User OAuth Token, e.g. "xoxb-..." */
  botToken: string;
  /**
   * App-level token for Socket Mode, e.g. "xapp-...".
   * Optional — only needed if using Socket Mode instead of Events API webhooks.
   */
  appToken?: string;
  /** Signing secret used to verify webhook request signatures from Slack. */
  signingSecret: string;
  /**
   * Default channel to listen on (channel ID, e.g. "C01234567").
   * Optional — used when no specific channel is specified.
   */
  defaultChannel?: string;
  /**
   * The bot's Slack user ID (e.g. "U01234567").
   * Optional — when set, validated against auth.test at startup to catch
   * token/config mismatches. Also used for @mention filtering in shared
   * channels with multiple bots.
   */
  botUserId?: string;
}

// ---------------------------------------------------------------------------
// Slack event objects
// ---------------------------------------------------------------------------

/**
 * A Slack user profile embedded in message events.
 */
export interface SlackUser {
  id: string;
  name?: string;
  username?: string;
}

/**
 * A Slack message event payload.
 *
 * Slack delivers messages inside an event envelope (SlackEvent).
 * Only fields used by the connector are included.
 */
export interface SlackMessage {
  /** Event sub-type — absent for regular messages, set for special subtypes. */
  subtype?: string;
  /** Slack channel ID where the message was posted (e.g. "C01234567"). */
  channel: string;
  /** Slack user ID of the sender (e.g. "U01234567"). */
  user?: string;
  /** Bot ID — present if the message was sent by a bot. */
  bot_id?: string;
  /** Plain text content of the message. */
  text?: string;
  /** Slack message timestamp (e.g. "1234567890.123456"). */
  ts: string;
  /** Thread timestamp — set for replies in a thread. */
  thread_ts?: string;
  /** Provider-assigned unique message ID. */
  client_msg_id?: string;
}

/**
 * A Slack Events API event envelope.
 *
 * Wraps the actual event payload with metadata such as the event ID,
 * type, and timestamp.
 */
export interface SlackEvent {
  /** Unique identifier for this event delivery. */
  event_id?: string;
  /** Unix timestamp when the event was dispatched. */
  event_time?: number;
  /** Type of event, e.g. "message". */
  type?: string;
  /** The inner event object. */
  event?: SlackMessage;
  /** Slack team (workspace) ID. */
  team_id?: string;
  /** API app ID. */
  api_app_id?: string;
}

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

/**
 * Generic Slack API response wrapper.
 *
 * All Slack Web API responses include an `ok` field indicating success.
 */
export interface SlackApiResponse {
  /** Whether the API call was successful. */
  ok: boolean;
  /** Error code if `ok` is false. */
  error?: string;
  /** Warning message, if any. */
  warning?: string;
}

/**
 * Response from a successful `chat.postMessage` API call.
 */
export interface SlackPostMessageResult extends SlackApiResponse {
  /** The channel the message was posted to. */
  channel?: string;
  /** The timestamp of the posted message. */
  ts?: string;
  /** The message object that was posted. */
  message?: SlackMessage;
}
