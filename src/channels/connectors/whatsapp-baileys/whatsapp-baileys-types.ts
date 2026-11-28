/**
 * WhatsApp Baileys connector types.
 *
 * Baileys connects to WhatsApp Web (not the Cloud API), acting as a regular
 * WhatsApp Web client without requiring a Meta Business account.
 *
 * @see https://github.com/WhiskeySockets/Baileys
 */

/**
 * Configuration for a WhatsAppBaileysConnector instance.
 */
export interface WhatsAppBaileysConfig {
  /**
   * Directory to persist multi-file auth state (session credentials).
   * Defaults to './baileys-auth'.
   */
  authDir?: string;
  /**
   * Browser name tuple shown in WhatsApp Web "Linked Devices" list.
   * Format: [clientName, browserName, version].
   * Defaults to Browsers.appropriate('Talon').
   */
  browser?: [string, string, string];
  /**
   * Whether to mark as online when connecting.
   * Defaults to false.
   */
  markOnlineOnConnect?: boolean;
  /**
   * Optional allowlist of sender identifiers permitted to chat with the bot.
   * Use the bare ID part of the JID visible in logs — either a phone number
   * (e.g. '31612345678') or a LID (e.g. '96490886312027'), depending on what
   * WhatsApp sends for your contacts. When empty or omitted, all senders are
   * accepted (open mode).
   */
  allowedSenders?: string[];
  /**
   * Enable self-chat mode: the bot listens only to messages in your own
   * "Message Yourself" thread. This lets you use your personal WhatsApp
   * number without a second phone. `fromMe` messages are accepted and
   * all other JIDs are ignored. `allowedSenders` is irrelevant in this mode.
   * Defaults to false.
   */
  selfChat?: boolean;
  /**
   * Optional list of trigger words that must appear at the start of a message
   * for it to be processed (case-insensitive). The trigger word is stripped
   * before the message reaches the agent. Example: ['@Talon', '@Bot'].
   * When empty or omitted, direct and self-chat messages pass through without
   * filtering. In group chats a trigger word is one of the ways to address
   * the bot; see `allowGroupChats`.
   */
  triggerWords?: string[];
  /**
   * Allow messages from WhatsApp group chats (JIDs ending in @g.us).
   * In group chats the bot only responds when its account is @mentioned,
   * when a message starts with one of the configured triggerWords, or when a
   * message quotes a message from the bot's account — unless
   * `requireMention` is false.
   * Defaults to false.
   */
  allowGroupChats?: boolean;
  /**
   * Whether a group message must address the bot (an @mention, a trigger
   * word, or a reply to the bot) to be answered. Defaults to true. Set to
   * false to answer every message in the group chats the bot is in. Combine
   * with `allowedSenders`: without it the bot answers anyone in any group it
   * is added to. Direct chats are not affected.
   */
  requireMention?: boolean;
  /**
   * When Talon's answer is sent as a quoted reply to the message that
   * triggered it: `groups` (default) in group chats only, `always`, or
   * `never`. A reply the agent requests explicitly is always quoted.
   */
  replyToTrigger?: 'never' | 'groups' | 'always';
  /**
   * Forward emoji reactions that users place on Talon's messages to the
   * agent. Defaults to true.
   */
  inboundReactions?: boolean;
}
