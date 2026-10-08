/**
 * Production IMAP client for the email connector, built on imapflow.
 *
 * Each `fetchUnseen()` call opens a fresh connection, reads unseen messages
 * from the mailbox, marks each successfully parsed message as seen, and logs
 * out. Connection, authentication and lock failures are thrown so the
 * connector's poll loop can back off.
 */

import type pino from 'pino';
import { ImapFlow, type MailboxLockObject } from 'imapflow';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { EmailConfig, ImapClient, ParsedEmail } from './email-types.js';

/** Maximum number of unseen messages processed per poll. */
const MAX_MESSAGES_PER_POLL = 20;

/** Messages larger than this are not downloaded; they are marked seen and skipped. */
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/** Result of fetching one message: parsed, oversized (skipped), or failed (retried later). */
type FetchOutcome =
  | { kind: 'parsed'; email: ParsedEmail }
  | { kind: 'oversize' }
  | { kind: 'failed' };

/**
 * Create an IMAP client that fetches unseen messages from the configured server.
 *
 * @param config - Email configuration (IMAP section is used).
 * @param logger - Optional logger for diagnostics.
 * @returns An ImapClient whose `fetchUnseen()` opens and closes a connection per call.
 */
export function createImapFlowClient(config: EmailConfig, logger?: pino.Logger): ImapClient {
  return {
    fetchUnseen: (mailbox: string): Promise<ParsedEmail[]> =>
      fetchUnseenMessages(config, mailbox, logger),
  };
}

async function fetchUnseenMessages(
  config: EmailConfig,
  mailbox: string,
  logger?: pino.Logger,
): Promise<ParsedEmail[]> {
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: { user: config.imapUser, pass: config.imapPass },
    logger: false,
  });

  // Socket-level errors are emitted as events; without a listener they would
  // crash the process. Connection failures are still surfaced via connect().
  client.on('error', (socketErr: unknown) => {
    logger?.warn({ err: socketErr, mailbox }, 'imap client socket error');
  });

  let lock: MailboxLockObject | undefined;
  try {
    await client.connect();
    lock = await client.getMailboxLock(mailbox);

    const unseen = await client.search({ seen: false }, { uid: true });
    if (!unseen || unseen.length === 0) {
      return [];
    }

    // Oldest first (lowest UID), capped per poll.
    const batch = [...unseen].sort((a, b) => a - b).slice(0, MAX_MESSAGES_PER_POLL);
    const results: ParsedEmail[] = [];

    for (const uid of batch) {
      const outcome = await fetchMessage(client, uid, logger);

      if (outcome.kind === 'failed') {
        // Left unseen so it is retried on the next poll.
        continue;
      }

      // Oversized messages are marked seen so they are not retried forever.
      // Parsed messages are marked seen before they are returned to the connector.
      // KNOWN TRADE-OFF: the ImapClient interface returns messages rather than
      // taking a commit hook, so the message is already \Seen when the connector
      // dispatches it. If the process crashes between this flag and dispatch,
      // that one message is lost (it will not be fetched again as unseen).
      // Accepted for now; a commit-after-dispatch hook would close the gap.
      const marked = await markSeen(client, uid, mailbox, logger);
      if (!marked) {
        // The connection is likely broken. Keep what was already marked and stop;
        // this message stays unseen and will be fetched again.
        break;
      }
      if (outcome.kind === 'parsed') {
        results.push(outcome.email);
      }
    }

    return results;
  } finally {
    lock?.release();
    await logoutQuietly(client, logger);
  }
}

/**
 * Fetch one message's size, then (if within the limit) its source, and parse it.
 * Never throws for per-message problems; those are reported as `failed`.
 */
async function fetchMessage(
  client: ImapFlow,
  uid: number,
  logger?: pino.Logger,
): Promise<FetchOutcome> {
  try {
    const meta = await client.fetchOne(uid, { size: true }, { uid: true });
    if (!meta) {
      logger?.warn({ uid }, 'imap message not found, skipping');
      return { kind: 'failed' };
    }
    if (typeof meta.size === 'number' && meta.size > MAX_MESSAGE_BYTES) {
      logger?.warn({ uid, size: meta.size }, 'imap message exceeds size limit, skipping');
      return { kind: 'oversize' };
    }

    const message = await client.fetchOne(uid, { source: true }, { uid: true });
    if (!message || !message.source) {
      logger?.warn({ uid }, 'imap message has no source, skipping');
      return { kind: 'failed' };
    }
    const parsed = await simpleParser(message.source);
    return { kind: 'parsed', email: mapParsedMail(parsed, uid) };
  } catch (parseErr) {
    logger?.warn({ err: parseErr, uid }, 'failed to parse imap message, skipping');
    return { kind: 'failed' };
  }
}

/** Set the \Seen flag on one message. Returns false (and logs) if the flag could not be set. */
async function markSeen(
  client: ImapFlow,
  uid: number,
  mailbox: string,
  logger?: pino.Logger,
): Promise<boolean> {
  try {
    await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
    return true;
  } catch (flagErr) {
    logger?.warn({ err: flagErr, uid, mailbox }, 'failed to mark imap message as seen');
    return false;
  }
}

/** Map a mailparser result to the connector's ParsedEmail shape. */
export function mapParsedMail(parsed: ParsedMail, uid: number): ParsedEmail {
  const references = Array.isArray(parsed.references)
    ? parsed.references.join(' ')
    : parsed.references;

  return {
    messageId: parsed.messageId ?? `<no-id-${uid}@local>`,
    from: firstAddress(parsed.from),
    to: firstAddress(parsed.to),
    subject: parsed.subject ?? '',
    text: parsed.text ?? '',
    inReplyTo: parsed.inReplyTo,
    references,
    timestamp: parsed.date?.getTime() ?? Date.now(),
    authenticationResults: readAuthenticationResults(parsed),
  };
}

function firstAddress(addresses: AddressObject | AddressObject[] | undefined): string {
  const first = Array.isArray(addresses) ? addresses[0] : addresses;
  return first?.value[0]?.address ?? '';
}

/**
 * Read all `Authentication-Results` values (top to bottom), followed by all
 * `ARC-Authentication-Results` values (top to bottom). mailparser may return a
 * single value, an array, or structured objects; only string values are kept.
 */
function readAuthenticationResults(parsed: ParsedMail): string[] {
  return [
    ...readStringHeader(parsed, 'authentication-results'),
    ...readStringHeader(parsed, 'arc-authentication-results'),
  ];
}

function readStringHeader(parsed: ParsedMail, name: string): string[] {
  const raw: unknown = parsed.headers.get(name);
  const values: unknown[] = Array.isArray(raw) ? raw : [raw];
  return values.filter((v): v is string => typeof v === 'string');
}

async function logoutQuietly(client: ImapFlow, logger?: pino.Logger): Promise<void> {
  try {
    await client.logout();
  } catch (logoutErr) {
    logger?.debug({ err: logoutErr }, 'imap logout failed, closing connection');
    client.close();
  }
}
