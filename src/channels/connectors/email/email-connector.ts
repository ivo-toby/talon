/**
 * Email channel connector.
 *
 * Implements the ChannelConnector interface for email delivery using:
 * - SMTP for outbound message sending (HTML emails)
 * - IMAP polling for inbound message ingestion
 *
 * Also supports a `feedInbound()` method for webhook-based inbound delivery,
 * which allows external systems to push parsed emails directly.
 *
 * Thread tracking is done via In-Reply-To / References headers.
 * The `externalThreadId` encoding is `<recipientAddress>:<messageId>`.
 */

import type pino from 'pino';
import type { ChannelConnector, InboundEvent, AgentOutput } from '../../channel-types.js';
import type { Result } from '../../../core/types/result.js';
import { err } from '../../../core/types/result.js';
import { ChannelError } from '../../../core/errors/error-types.js';
import type { EmailConfig, ParsedEmail, SmtpSendOptions } from './email-types.js';
import { markdownToHtml } from './email-format.js';
import { createNodemailerSmtpTransport } from './email-smtp-transport.js';
import { createImapFlowClient } from './email-imap-client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POLLING_INTERVAL_MS = 30_000;
const DEFAULT_MAILBOX = 'INBOX';
/** Initial backoff after a poll error, in milliseconds. */
const INITIAL_BACKOFF_MS = 1_000;
/** Maximum backoff after repeated poll errors, in milliseconds. */
const MAX_BACKOFF_MS = 60_000;

// ---------------------------------------------------------------------------
// Thread ID encoding / decoding
// ---------------------------------------------------------------------------

/**
 * Encode an email address and Message-ID into the canonical `externalThreadId`
 * format used by the email connector: `<address>:<messageId>`.
 *
 * The Message-ID is stripped of angle brackets for consistency.
 *
 * @param address   - Sender email address.
 * @param messageId - The Message-ID to use as the thread anchor.
 * @returns Encoded external thread ID string.
 */
export function encodeThreadId(address: string, messageId: string): string {
  const cleanId = messageId.replace(/^<|>$/g, '');
  return `${address}:${cleanId}`;
}

/**
 * Decode an `externalThreadId` string back into address and Message-ID parts.
 *
 * @param externalThreadId - The thread ID as produced by `encodeThreadId`.
 * @returns An object with `address` and `messageId`, or null if malformed.
 */
export function decodeThreadId(
  externalThreadId: string,
): { address: string; messageId: string } | null {
  const colonIndex = externalThreadId.indexOf(':');
  if (colonIndex === -1) return null;
  const address = externalThreadId.slice(0, colonIndex);
  const messageId = externalThreadId.slice(colonIndex + 1);
  if (!address || !messageId) return null;
  return { address, messageId };
}

// ---------------------------------------------------------------------------
// SMTP transport abstraction (injectable for testing)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// IMAP transport abstraction (injectable for testing)
// ---------------------------------------------------------------------------

/**
 * Minimal IMAP client interface.
 * Injected into the connector so unit tests can replace it without a real
 * IMAP connection.
 */
/** A fetched email paired with its IMAP UID for post-processing acknowledgement. */
export interface FetchedEmail {
  email: ParsedEmail;
  /** IMAP UID as a string — passed back to `markSeen` after successful handling. */
  uid: string;
}

export interface ImapClient {
  /**
   * Fetch unseen messages from the mailbox WITHOUT marking them as seen.
   * The caller is responsible for calling `markSeen` after successful handling
   * so that transient pipeline failures leave the message available for retry.
   *
   * @param mailbox - The mailbox to poll (e.g. "INBOX").
   * @returns An array of fetched emails with their UIDs.
   */
  fetchUnseen(mailbox: string): Promise<FetchedEmail[]>;

  /**
   * Mark the given UIDs as seen (\\Seen flag) in the mailbox.
   * Called by the polling loop after the inbound handler has successfully
   * processed each message.
   *
   * @param mailbox - The mailbox containing the messages.
   * @param uids    - UIDs to mark as seen.
   */
  markSeen(mailbox: string, uids: string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default SMTP / IMAP factory functions (real implementations using fetch)
// ---------------------------------------------------------------------------

/**
 * Build a production SMTP transport using nodemailer.
 *
 * Creates a real SMTP transport backed by nodemailer that sends email using
 * the SMTP credentials from the provided config.
 */
export function createDefaultSmtpTransport(config: EmailConfig): SmtpTransport {
  return createNodemailerSmtpTransport(config);
}

/**
 * Build a production IMAP client using imapflow + mailparser.
 *
 * Creates a real IMAP client that connects to the IMAP server, fetches unseen
 * messages, parses them, and marks them as seen.
 */
export function createDefaultImapClient(config: EmailConfig): ImapClient {
  return createImapFlowClient(config);
}

// ---------------------------------------------------------------------------
// EmailConnector
// ---------------------------------------------------------------------------

/**
 * Options for constructing an EmailConnector.
 */
export interface EmailConnectorOptions {
  /** Inject a custom SMTP transport (e.g. nodemailer wrapper). */
  smtpTransport?: SmtpTransport;
  /** Inject a custom IMAP client (e.g. imap-simple wrapper). */
  imapClient?: ImapClient;
}

/**
 * Channel connector for email via SMTP (outbound) and IMAP polling (inbound).
 *
 * Supports two inbound patterns:
 * 1. IMAP polling — started via `start()`, polls the mailbox at a configurable
 *    interval and emits InboundEvents via the registered handler.
 * 2. Webhook / feedInbound — external systems call `feedInbound()` with a
 *    pre-parsed ParsedEmail, which is normalised and dispatched to the handler.
 *
 * Usage:
 * 1. Construct with an EmailConfig, channel name, and pino logger.
 * 2. Call `onMessage()` to register an inbound event handler.
 * 3. Call `start()` to begin IMAP polling (or use `feedInbound()` for webhooks).
 * 4. Call `stop()` to halt polling gracefully.
 */
export class EmailConnector implements ChannelConnector {
  readonly type = 'email';
  readonly name: string;

  private handler?: (event: InboundEvent) => void | Promise<void>;
  private running = false;
  private abortController?: AbortController;
  /** Promise tracking the active poll loop (used for clean shutdown). */
  private pollLoopPromise?: Promise<void>;

  private readonly smtpTransport: SmtpTransport;
  private readonly imapClient: ImapClient;

  constructor(
    private readonly config: EmailConfig,
    private readonly channelName: string,
    private readonly logger: pino.Logger,
    options: EmailConnectorOptions = {},
  ) {
    this.name = channelName;
    this.smtpTransport = options.smtpTransport ?? createDefaultSmtpTransport(config);
    this.imapClient = options.imapClient ?? createDefaultImapClient(config);
  }

  // ---------------------------------------------------------------------------
  // ChannelConnector lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start IMAP polling. Idempotent — no-op if already running.
   */
  start(): Promise<void> {
    if (this.running) {
      this.logger.debug({ channelName: this.name }, 'email connector already running');
      return Promise.resolve();
    }
    this.running = true;
    this.abortController = new AbortController();
    this.logger.info({ channelName: this.name }, 'email connector starting');
    // Launch the poll loop in the background.
    this.pollLoopPromise = this.pollLoop();
    return Promise.resolve();
  }

  /**
   * Stop IMAP polling gracefully. Idempotent — no-op if already stopped.
   * Waits for the current in-flight poll to finish before returning.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.logger.info({ channelName: this.name }, 'email connector stopping');
    // Abort any pending sleep so the poll loop exits immediately.
    this.abortController?.abort();
    await this.pollLoopPromise;
    this.pollLoopPromise = undefined;
    this.logger.info({ channelName: this.name }, 'email connector stopped');
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
   * Send an AgentOutput as an HTML email.
   *
   * The `externalThreadId` must be in the format `<address>:<messageId>` where:
   * - `address` is the recipient's email address.
   * - `messageId` is the Message-ID of the email being replied to (for threading).
   *
   * If the `messageId` portion is non-empty, the email will carry In-Reply-To
   * and References headers to maintain the email thread.
   *
   * @param externalThreadId - Encoded thread ID: `<address>:<messageId>`.
   * @param output            - Agent output to deliver.
   */
  async send(externalThreadId: string, output: AgentOutput): Promise<Result<void, ChannelError>> {
    const decoded = decodeThreadId(externalThreadId);
    if (!decoded) {
      return err(
        new ChannelError(
          `EmailConnector: invalid externalThreadId format "${externalThreadId}" — expected "<address>:<messageId>"`,
        ),
      );
    }

    const { address, messageId } = decoded;
    const html = this.format(output.body);

    const sendOptions: SmtpSendOptions = {
      to: address,
      subject: 'Re: message', // Default subject for replies
      html,
      inReplyTo: `<${messageId}>`,
      references: `<${messageId}>`,
    };

    try {
      return await this.smtpTransport.send(this.config.fromAddress, sendOptions);
    } catch (smtpErr) {
      const cause = smtpErr instanceof Error ? smtpErr : undefined;
      return err(new ChannelError(`EmailConnector: SMTP send failed: ${String(smtpErr)}`, cause));
    }
  }

  /**
   * Convert a Markdown string to HTML for email delivery.
   */
  format(markdown: string): string {
    return markdownToHtml(markdown);
  }

  get botUserId(): string | undefined {
    return this.config.fromAddress;
  }

  setSiblingBotIds(_ids: Set<string>): void {
    // No-op: email connector does not receive messages from other Talon bots.
  }

  // ---------------------------------------------------------------------------
  // Webhook / feedInbound
  // ---------------------------------------------------------------------------

  /**
   * Feed a pre-parsed inbound email to the connector.
   *
   * This is the entry point for webhook-based inbound setups where an external
   * system parses the raw MIME and hands it to us as a `ParsedEmail`.
   *
   * @param email - The parsed email to process.
   */
  async feedInbound(email: ParsedEmail): Promise<void> {
    await this.handleEmail(email);
  }

  // ---------------------------------------------------------------------------
  // Polling loop
  // ---------------------------------------------------------------------------

  /**
   * IMAP poll loop. Runs until `running` is set to false.
   * Applies exponential backoff on errors.
   */
  private async pollLoop(): Promise<void> {
    const intervalMs = this.config.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
    const mailbox = this.config.mailbox ?? DEFAULT_MAILBOX;
    let backoffMs = INITIAL_BACKOFF_MS;

    while (this.running) {
      try {
        const fetched = await this.imapClient.fetchUnseen(mailbox);
        // Reset backoff after a successful fetch.
        backoffMs = INITIAL_BACKOFF_MS;

        // Process each email and collect the UIDs of those that were handled
        // successfully. Only those are marked as seen — failures stay unseen
        // so the next poll can retry them.
        const seenUids: string[] = [];
        for (const { email, uid } of fetched) {
          try {
            await this.handleEmail(email);
            seenUids.push(uid);
          } catch (handlerErr) {
            this.logger.error(
              { channelName: this.name, uid, err: handlerErr },
              'email handler failed — message left unseen for retry',
            );
          }
        }
        if (seenUids.length > 0) {
          await this.imapClient.markSeen(mailbox, seenUids);
        }

        // Wait for the configured interval before polling again.
        // Use abortable sleep so stop() can interrupt the wait immediately.
        await this.abortableSleep(intervalMs);
      } catch (pollErr) {
        if (!this.running) {
          // Aborted by stop() — exit cleanly.
          break;
        }

        this.logger.warn(
          { channelName: this.name, err: pollErr, backoffMs },
          'email poll error, backing off',
        );

        await this.abortableSleep(backoffMs);
        // Exponential backoff capped at MAX_BACKOFF_MS.
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Email handling
  // ---------------------------------------------------------------------------

  /**
   * Normalise a ParsedEmail into an InboundEvent and invoke the handler.
   * Applies allowedSenders filtering if configured.
   */
  private async handleEmail(email: ParsedEmail): Promise<void> {
    const senderAddress = extractAddress(email.from);

    // Enforce allowedSenders allowlist if configured.
    if (
      this.config.allowedSenders &&
      this.config.allowedSenders.length > 0 &&
      !this.config.allowedSenders.includes(senderAddress)
    ) {
      this.logger.warn(
        { channelName: this.name, sender: senderAddress },
        'email from disallowed sender, dropping',
      );
      return;
    }

    // Determine the thread ID from In-Reply-To / References if this is a reply,
    // otherwise use the message's own Message-ID as the thread anchor.
    const threadAnchorId = email.inReplyTo ?? email.messageId;
    const externalThreadId = encodeThreadId(senderAddress, threadAnchorId);

    // Use the Message-ID as the idempotency key (stripped of angle brackets).
    const idempotencyKey = email.messageId.replace(/^<|>$/g, '');

    const event: InboundEvent = {
      channelType: this.type,
      channelName: this.name,
      externalThreadId,
      senderId: senderAddress,
      idempotencyKey,
      content: email.text,
      timestamp: email.timestamp,
      raw: email,
    };

    if (!this.handler) {
      this.logger.warn(
        { channelName: this.name },
        'email connector received message but no handler is registered',
      );
      return;
    }

    try {
      await this.handler(event);
    } catch (handlerErr) {
      this.logger.error(
        { channelName: this.name, err: handlerErr },
        'email connector handler threw an error',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Internal utilities
  // ---------------------------------------------------------------------------

  /**
   * Sleep for `ms` milliseconds. Resolves early if the abort controller fires.
   */
  private abortableSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const signal = this.abortController?.signal;
      if (signal) {
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve();
        };
        if (signal.aborted) {
          clearTimeout(timer);
          resolve();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Address parsing helper
// ---------------------------------------------------------------------------

/**
 * Extract the bare email address from a "Display Name <addr@example.com>"
 * formatted string or return the input trimmed if no angle brackets are found.
 *
 * @param from - Raw "From" header value.
 * @returns Bare email address in lower case.
 */
export function extractAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase().trim();
  return from.toLowerCase().trim();
}
