/**
 * imapflow + mailparser IMAP client for the email channel connector.
 *
 * Implements the ImapClient interface defined in email-connector.ts using
 * imapflow for IMAP operations and mailparser for MIME parsing.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { FetchedEmail, ImapClient } from './email-connector.js';
import type { EmailConfig, ParsedEmail } from './email-types.js';

/**
 * Maximum raw message size (in bytes) that will be parsed.
 * Messages larger than this are skipped with an error log.
 * Default: 10 MiB — large enough for typical email, small enough to prevent
 * memory exhaustion from attachment-heavy or malformed messages.
 */
const MAX_MESSAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * Open a fresh ImapFlow connection, run `fn`, and always disconnect cleanly.
 */
async function withImapConnection<T>(
  config: EmailConfig,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: {
      user: config.imapUser,
      pass: config.imapPass,
    },
    logger: false,
    // Prevent indefinite hangs on slow/unresponsive IMAP servers so that
    // stop() can complete in a reasonable time. Both values are in milliseconds.
    connectionTimeout: 30_000,
    socketTimeout: 60_000,
  });

  try {
    await client.connect();
  } catch (connectErr) {
    try {
      await client.logout();
    } catch {
      // Ignore cleanup errors.
    }
    throw connectErr;
  }

  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      // Ignore logout errors.
    }
  }
}

/**
 * Create an imapflow + mailparser backed IMAP client.
 *
 * @param config - Email configuration containing IMAP credentials and settings.
 * @returns An ImapClient that fetches unseen messages and marks them seen on demand.
 */
export function createImapFlowClient(config: EmailConfig): ImapClient {
  return {
    /**
     * Fetch unseen messages from the mailbox WITHOUT marking them as seen.
     * The caller (polling loop) is responsible for calling markSeen after
     * successful pipeline processing so failures can be retried.
     */
    async fetchUnseen(mailbox: string): Promise<FetchedEmail[]> {
      return withImapConnection(config, async (client) => {
        const results: FetchedEmail[] = [];
        let lock: { release: () => void } | undefined;

        try {
          lock = await client.getMailboxLock(mailbox);

          // client.search() returns number[] | false; treat false as empty.
          const searchResult = await client.search({ seen: false }, { uid: true });
          const uids: number[] = searchResult === false ? [] : searchResult;

          for (const uid of uids) {
            const uidStr = String(uid);

            // Fetch the raw message source.
            const msg = await client.fetchOne(uidStr, { source: true }, { uid: true });
            if (msg === false || !msg?.source) {
              // Message disappeared between search and fetch — skip silently.
              // Do NOT mark seen; it's gone anyway.
              continue;
            }

            // Guard against oversized messages to prevent memory exhaustion.
            if (msg.source.length > MAX_MESSAGE_SIZE_BYTES) {
              console.error(
                `EmailConnector: message uid=${uid} exceeds size limit ` +
                  `(${msg.source.length} bytes > ${MAX_MESSAGE_SIZE_BYTES}), skipping`,
              );
              continue;
            }

            let parsed: ParsedEmail;
            try {
              const mail = await simpleParser(msg.source);

              // Extract plain text body.
              const text = mail.text ?? '';

              // Extract From address string.
              const fromAddr = mail.from?.text ?? '';

              // Extract To address string.
              const toAddr = mail.to
                ? Array.isArray(mail.to)
                  ? mail.to.map((a) => a.text).join(', ')
                  : mail.to.text
                : '';

              // Message-ID must have angle brackets per RFC 2822.
              const rawMessageId = mail.messageId ?? `<unknown-${uid}@talon>`;
              const messageId = rawMessageId.startsWith('<')
                ? rawMessageId
                : `<${rawMessageId}>`;

              // In-Reply-To header.
              const inReplyTo = mail.inReplyTo ?? undefined;

              // References header — mailparser may return string | string[].
              const rawRefs = (mail as { references?: string | string[] }).references;
              const references =
                rawRefs === undefined
                  ? undefined
                  : Array.isArray(rawRefs)
                    ? rawRefs.join(' ')
                    : rawRefs;

              parsed = {
                messageId,
                from: fromAddr,
                to: toAddr,
                subject: mail.subject ?? '',
                text,
                inReplyTo,
                references,
                timestamp: (mail.date ?? new Date()).getTime(),
              };
            } catch (parseErr) {
              // Log and skip — do NOT mark as seen so the operator can inspect
              // the raw message and the next poll will try again. If the message
              // is permanently malformed, the operator should delete or move it.
              console.error(
                `EmailConnector: failed to parse message uid=${uid}, ` +
                  `will retry on next poll:`,
                parseErr,
              );
              continue;
            }

            results.push({ email: parsed, uid: uidStr });
          }
        } finally {
          lock?.release();
        }

        return results;
      });
    },

    /**
     * Mark the given UIDs as seen (\\Seen flag) in the mailbox.
     * Called after each email has been successfully processed by the pipeline.
     */
    async markSeen(mailbox: string, uids: string[]): Promise<void> {
      if (uids.length === 0) return;

      await withImapConnection(config, async (client) => {
        let lock: { release: () => void } | undefined;
        try {
          lock = await client.getMailboxLock(mailbox);
          for (const uid of uids) {
            try {
              await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            } catch (flagErr) {
              // Non-fatal — worst case we re-process this message on next poll.
              console.error(`EmailConnector: failed to mark uid=${uid} as seen:`, flagErr);
            }
          }
        } finally {
          lock?.release();
        }
      });
    },
  };
}
