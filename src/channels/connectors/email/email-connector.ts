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
import type {
  EmailConfig,
  ImapClient,
  ParsedEmail,
  SmtpSendOptions,
  SmtpTransport,
} from './email-types.js';
import { markdownToHtml } from './email-format.js';
import { createImapFlowClient } from './email-imap-client.js';
import { createNodemailerTransport } from './email-smtp-transport.js';

export type { ImapClient, SmtpTransport } from './email-types.js';

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
// Thread helpers
// ---------------------------------------------------------------------------

/** Maximum number of thread reply-metadata entries kept in memory. */
const MAX_THREAD_META_ENTRIES = 500;

/**
 * Return the thread anchor (root Message-ID) for an inbound email.
 * The first entry of `References` is the root of the conversation; falls back
 * to `In-Reply-To`, then the message's own Message-ID.
 */
function threadRootOf(email: ParsedEmail): string {
  const firstReference = email.references?.trim().split(/\s+/)[0];
  if (firstReference) return firstReference;
  return email.inReplyTo || email.messageId;
}

/** Wrap a Message-ID in exactly one pair of angle brackets. */
function bracketId(messageId: string): string {
  return `<${messageId.replace(/^<+|>+$/g, '')}>`;
}

/** Matches an optional leading ARC instance tag, e.g. "i=1; ". */
const ARC_INSTANCE_TAG = /^\s*i=\d+\s*;\s*/i;

/**
 * Extract the authserv-id from one Authentication-Results (or ARC-AR) value,
 * normalised for comparison: optional ARC instance tag removed, the first
 * token before `;` taken, any trailing version number dropped, lower-cased and
 * without a trailing dot.
 */
function authServIdOf(value: string): string {
  const withoutInstance = value.replace(ARC_INSTANCE_TAG, '');
  const idToken = withoutInstance.split(';')[0].trim().split(/\s+/)[0] ?? '';
  return idToken.toLowerCase().replace(/\.$/, '');
}

/**
 * Decide whether a message passed DMARC as attested by the trusted mail provider.
 *
 * Only values whose authserv-id equals `trustedAuthServId` are considered; all
 * others are ignored because the sender can forge them. The first trusted value
 * decides: it must report `dmarc=pass` and its `header.from` must equal the
 * sender's domain. Fails closed on every missing input.
 *
 * @param results            - Authentication-Results values (AR headers, then ARC-AR headers).
 * @param trustedAuthServId  - The authserv-id of the receiving provider, e.g. "mx.kpnmail.nl".
 * @param senderAddress      - The sender's address, used for the header.from alignment check.
 */
export function hasDmarcPass(
  results: string[] | undefined,
  trustedAuthServId: string | undefined,
  senderAddress: string,
): boolean {
  if (!results || results.length === 0) return false;
  const trusted = trustedAuthServId?.trim().toLowerCase().replace(/\.$/, '');
  if (!trusted) return false;
  const senderDomain = senderAddress.split('@')[1]?.trim().toLowerCase();
  if (!senderDomain) return false;

  for (const value of results) {
    if (authServIdOf(value) !== trusted) continue;
    // First trusted value decides; do not look at lower values.
    if (!/\bdmarc=pass\b/i.test(value)) return false;
    const headerFrom = /\bheader\.from=([^\s;]+)/i.exec(value)?.[1]?.toLowerCase();
    return headerFrom === senderDomain;
  }
  return false;
}

/** Per-thread reply metadata used to build subject and threading headers. */
interface ThreadReplyMeta {
  /** Subject of the most recent inbound message in the thread. */
  subject: string;
  /** Bracketed Message-ID of the most recent inbound message. */
  lastMessageId: string;
  /** Bracketed, space-separated References chain for the thread. */
  references: string;
}

// ---------------------------------------------------------------------------
// Default SMTP / IMAP factory functions (production implementations)
// ---------------------------------------------------------------------------

/**
 * Build the production SMTP transport (nodemailer, STARTTLS or implicit TLS).
 *
 * The connector delegates to the returned `SmtpTransport`; tests can inject a
 * replacement via `EmailConnectorOptions.smtpTransport`.
 *
 * @param config - Email configuration (SMTP section is used).
 * @returns An SMTP transport backed by nodemailer.
 */
export function createDefaultSmtpTransport(config: EmailConfig): SmtpTransport {
  return createNodemailerTransport(config);
}

/**
 * Build the production IMAP client (imapflow, poll-by-connect-fetch-logout).
 *
 * @param config - Email configuration (IMAP section is used).
 * @param logger - Optional logger for connection-level diagnostics.
 * @returns An IMAP client that fetches unseen messages on each call.
 */
export function createDefaultImapClient(config: EmailConfig, logger?: pino.Logger): ImapClient {
  return createImapFlowClient(config, logger);
}

// ---------------------------------------------------------------------------
// EmailConnector
// ---------------------------------------------------------------------------

/**
 * Options for constructing an EmailConnector.
 */
export interface EmailConnectorOptions {
  /** Inject a custom SMTP transport (defaults to the nodemailer-backed transport). */
  smtpTransport?: SmtpTransport;
  /** Inject a custom IMAP client (defaults to the imapflow-backed client). */
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
  /** Reply metadata keyed by externalThreadId (bounded to MAX_THREAD_META_ENTRIES). */
  private readonly threadMeta = new Map<string, ThreadReplyMeta>();

  constructor(
    private readonly config: EmailConfig,
    private readonly channelName: string,
    private readonly logger: pino.Logger,
    options: EmailConnectorOptions = {},
  ) {
    this.name = channelName;
    this.smtpTransport = options.smtpTransport ?? createDefaultSmtpTransport(config);
    this.imapClient = options.imapClient ?? createDefaultImapClient(config, logger);
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
    const meta = this.threadMeta.get(externalThreadId);

    const sendOptions: SmtpSendOptions = {
      to: address,
      subject: replySubject(meta?.subject),
      html,
      inReplyTo: meta?.lastMessageId ?? bracketId(messageId),
      references: meta?.references ?? bracketId(messageId),
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

    // Enforce DMARC alignment if configured. The From header is trivially forged,
    // so only trust a dmarc=pass result written by the configured provider.
    if (
      this.config.requireDmarcPass &&
      !hasDmarcPass(email.authenticationResults, this.config.trustedAuthServId, senderAddress)
    ) {
      this.logger.warn(
        { channelName: this.name, sender: senderAddress },
        'email failed DMARC check (requireDmarcPass), dropping',
      );
      return;
    }

    // The thread anchor is the root of the conversation so that every reply
    // in a chain maps to the same externalThreadId.
    const externalThreadId = encodeThreadId(senderAddress, threadRootOf(email));
    this.rememberThread(externalThreadId, email);

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
   * Record reply metadata for an accepted inbound email so that outbound replies
   * carry a matching subject and In-Reply-To / References chain.
   * The map is bounded: the oldest entry is evicted when the limit is exceeded.
   */
  private rememberThread(externalThreadId: string, email: ParsedEmail): void {
    const ownId = bracketId(email.messageId);
    const chain = [...(email.references ?? '').trim().split(/\s+/), ownId]
      .filter((id) => id.length > 0)
      .map((id) => bracketId(id));
    const references = [...new Set(chain)].join(' ');

    // Re-insert so the most recently active thread is the newest entry.
    this.threadMeta.delete(externalThreadId);
    this.threadMeta.set(externalThreadId, {
      subject: email.subject,
      lastMessageId: ownId,
      references,
    });
    if (this.threadMeta.size > MAX_THREAD_META_ENTRIES) {
      const oldest = this.threadMeta.keys().next();
      if (!oldest.done) this.threadMeta.delete(oldest.value);
    }
  }

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

/**
 * Build the outbound reply subject from the inbound subject.
 * Adds a `Re: ` prefix unless one is already present (no `Re: Re:`).
 *
 * @param inboundSubject - Subject of the message being replied to, if known.
 */
function replySubject(inboundSubject: string | undefined): string {
  const trimmed = inboundSubject?.trim() ?? '';
  if (!trimmed) return 'Re: message';
  return /^re:\s/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
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
