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
}
