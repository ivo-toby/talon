/**
 * Email channel connector types.
 *
 * Defines configuration and API types for the email connector, which supports
 * SMTP for outbound and IMAP for inbound (polling).
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

import type { Result } from '../../../core/types/result.js';
import type { ChannelError } from '../../../core/errors/error-types.js';

/**
 * Configuration for an EmailConnector instance.
 */
export interface EmailConfig {
  // ---- SMTP (outbound) ---------------------------------------------------
  /** SMTP server hostname. */
  smtpHost: string;
  /** SMTP server port (e.g. 587 for STARTTLS, 465 for TLS). */
  smtpPort: number;
  /** SMTP authentication username. */
  smtpUser: string;
  /** SMTP authentication password. */
  smtpPass: string;
  /** Whether to use TLS/SSL for the SMTP connection. */
  smtpSecure: boolean;

  // ---- IMAP (inbound) ----------------------------------------------------
  /** IMAP server hostname. */
  imapHost: string;
  /** IMAP server port (e.g. 993 for TLS, 143 for STARTTLS). */
  imapPort: number;
  /** IMAP authentication username. */
  imapUser: string;
  /** IMAP authentication password. */
  imapPass: string;
  /** Whether to use TLS/SSL for the IMAP connection. */
  imapSecure: boolean;

  // ---- General -----------------------------------------------------------
  /** The "From" address to use for outbound emails, e.g. "Bot <bot@example.com>". */
  fromAddress: string;

  /**
   * Optional allowlist of sender email addresses.
   * If set, inbound emails from addresses not in this list are silently dropped.
   */
  allowedSenders?: string[];

  /**
   * How often to poll for new IMAP messages, in milliseconds.
   * Defaults to 30000 (30 seconds).
   */
  pollingIntervalMs?: number;

  /**
   * IMAP mailbox to poll.
   * Defaults to "INBOX".
   */
  mailbox?: string;

  /**
   * When true, inbound mail is dropped unless the topmost `Authentication-Results`
   * header contains `dmarc=pass`. This guards against forged From headers, since
   * `allowedSenders` only inspects the (spoofable) From address.
   * Defaults to false.
   */
  requireDmarcPass?: boolean;

  /**
   * The authserv-id your mail provider writes at the start of its
   * `Authentication-Results` / `ARC-Authentication-Results` header, e.g.
   * "mx.kpnmail.nl". Only header values carrying this id are trusted for the
   * DMARC check; values with any other id are ignored (they may be forged by the
   * sender). Required for `requireDmarcPass` to ever accept mail.
   */
  trustedAuthServId?: string;
}

// ---------------------------------------------------------------------------
// MIME / Email types
// ---------------------------------------------------------------------------

/**
 * One parsed MIME attachment forwarded from the mailparser result.
 *
 * This is the MINIMAL field set the connector needs from the actual
 * MailParser 3.9.37 attachment shape (contract inventory E5): `filename?`,
 * `contentType`, `contentDisposition?`, `size`, `content: Buffer`,
 * `related?`. Parser internals (`checksum`, `headers`, `partId`, `release`)
 * and the `contentId`/`cid` values are deliberately NOT forwarded: inline /
 * related exclusion is decided by the disposition and the `related` flag, so
 * a content ID is not needed downstream and forwarding it would only widen
 * the durable surface.
 *
 * `size` is sender-declared metadata and stays untrusted — the shared
 * selection port re-measures the actual `content` length before staging.
 */
export interface EmailAttachment {
  /** Declared filename, when the MIME part carried one. Never establishes MIME. */
  filename?: string;
  /** Declared MIME type exactly as parsed (parameters and case included). */
  contentType?: string;
  /** Normalized disposition (`"attachment"` / `"inline"`), when declared. */
  contentDisposition?: string;
  /** Declared size in bytes; untrusted metadata. */
  size?: number;
  /** `true` only for CID parts under a `multipart/related` ancestor. */
  related?: boolean;
  /** Decoded attachment bytes, already in hand from the bounded parse. */
  content: Buffer;
}

/**
 * A raw parsed email message as produced by the IMAP poll.
 */
export interface ParsedEmail {
  /** The RFC 2822 Message-ID header value (with angle brackets), e.g. "<abc@example.com>". */
  messageId: string;
  /** The sender's email address. */
  from: string;
  /** The primary recipient's email address. */
  to: string;
  /** Subject line. */
  subject: string;
  /** Plain text body. */
  text: string;
  /**
   * In-Reply-To header value, if present.
   * Used for thread tracking.
   */
  inReplyTo?: string;
  /**
   * References header value, if present.
   * Space-separated list of Message-IDs in the thread.
   */
  references?: string;
  /** Unix epoch milliseconds when the message was received. */
  timestamp: number;
  /**
   * Values of all `Authentication-Results` headers (top to bottom), followed by
   * the values of all `ARC-Authentication-Results` headers (top to bottom).
   */
  authenticationResults?: string[];
  /**
   * Parsed MIME attachments in source order, forwarded with the minimal
   * {@link EmailAttachment} fields. Absent when the message carried none.
   * Presence here does NOT mean the content is admissible: image eligibility
   * and inline/related exclusion run in `email-media.ts`, and staging happens
   * only after the sender allowlist and DMARC checks pass.
   */
  attachments?: EmailAttachment[];
}

/**
 * Minimal SMTP transport interface.
 * Injected into the connector so unit tests can replace it without a real
 * SMTP connection.
 */
export interface SmtpTransport {
  /**
   * Send an email.
   *
   * @param from    - Sender address.
   * @param options - The message payload.
   * @returns A Result indicating success or failure.
   */
  send(from: string, options: SmtpSendOptions): Promise<Result<void, ChannelError>>;
}

/**
 * Minimal IMAP client interface.
 * Injected into the connector so unit tests can replace it without a real
 * IMAP connection.
 */
export interface ImapClient {
  /**
   * Fetch unseen messages from the mailbox.
   *
   * @param mailbox - The mailbox to poll (e.g. "INBOX").
   * @returns An array of parsed emails.
   */
  fetchUnseen(mailbox: string): Promise<ParsedEmail[]>;
}

/**
 * Payload for sending an email via the SMTP transporter.
 */
export interface SmtpSendOptions {
  /** Recipient email address. */
  to: string;
  /** Email subject line. */
  subject: string;
  /** HTML body of the email. */
  html: string;
  /**
   * In-Reply-To header value, for threading.
   * Should be the Message-ID of the email being replied to.
   */
  inReplyTo?: string;
  /**
   * References header value, for threading.
   * Should be the full chain of Message-IDs in the thread.
   */
  references?: string;
}

/**
 * Result returned by the SMTP send operation.
 */
export interface SmtpSendResult {
  /** Whether the send was accepted by the SMTP server. */
  accepted: boolean;
  /** The Message-ID assigned to the sent message. */
  messageId?: string;
  /** Error description if the send was rejected. */
  errorMessage?: string;
}

/**
 * Result of an IMAP fetch operation.
 */
export interface ImapFetchResult {
  /** Messages fetched in this poll cycle. */
  messages: ParsedEmail[];
  /** Any error that occurred during the fetch. */
  error?: Error;
}
