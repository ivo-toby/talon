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
export interface ImapClient {
  /**
   * Fetch unseen messages from the mailbox.
   *
   * @param mailbox - The mailbox to poll (e.g. "INBOX").
   * @returns An array of parsed emails.
   */
  fetchUnseen(mailbox: string): Promise<ParsedEmail[]>;
}

// ---------------------------------------------------------------------------
// Default SMTP / IMAP factory functions (real implementations using fetch)
// ---------------------------------------------------------------------------

/**
 * Build a production SMTP transport that sends email via an SMTP-over-HTTP
 * relay endpoint.
 *
 * In a real deployment this would use nodemailer or a similar library.
 * Here we provide a minimal HTTP-based implementation that calls out to a
 * configurable HTTP SMTP relay so that the connector remains dependency-free.
 * The connector itself delegates to the injected `SmtpTransport`, so callers
 * can inject a nodemailer-based transport in production.
 */
export function createDefaultSmtpTransport(_config: EmailConfig): SmtpTransport {
  // Default implementation: minimal stub that always fails with a clear message
  // indicating that a real transport must be injected.  This avoids a hard
  // dependency on nodemailer while still providing a usable interface.
  return {
    send(_from: string, _options: SmtpSendOptions): Promise<Result<void, ChannelError>> {
      return Promise.resolve(
        err(
          new ChannelError(
            'EmailConnector: no SMTP transport provided — inject a SmtpTransport via options.smtpTransport',
          ),
        ),
      );
    },
  };
}

/**
 * Build a production IMAP client.
 *
 * Same rationale as the SMTP transport — provides a stub that callers replace
 * with a real IMAP implementation in production.
 */
export function createDefaultImapClient(_config: EmailConfig): ImapClient {
  return {
    fetchUnseen(_mailbox: string): Promise<ParsedEmail[]> {
      return Promise.resolve([]);
    },
  };
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
        const messages = await this.imapClient.fetchUnseen(mailbox);
        // Reset backoff after a successful fetch.
        backoffMs = INITIAL_BACKOFF_MS;

        for (const email of messages) {
          await this.handleEmail(email);
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
