/**
 * imapflow + mailparser IMAP client for the email channel connector.
 *
 * Implements the ImapClient interface defined in email-connector.ts using
 * imapflow for IMAP operations and mailparser for MIME parsing.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { ImapClient } from './email-connector.js';
import type { EmailConfig, ParsedEmail } from './email-types.js';

/**
 * Create an imapflow + mailparser backed IMAP client.
 *
 * @param config - Email configuration containing IMAP credentials and settings.
 * @returns An ImapClient instance that fetches and marks unseen messages.
 */
export function createImapFlowClient(config: EmailConfig): ImapClient {
  return {
    async fetchUnseen(mailbox: string): Promise<ParsedEmail[]> {
      const client = new ImapFlow({
        host: config.imapHost,
        port: config.imapPort,
        secure: config.imapSecure,
        auth: {
          user: config.imapUser,
          pass: config.imapPass,
        },
        logger: false,
      });

      // Connect — if this throws, let it propagate to the poll loop for backoff.
      // We wrap in a try/finally so that even a partial connect gets a logout attempt.
      try {
        await client.connect();
      } catch (connectErr) {
        // Attempt cleanup of any partially-opened socket, then re-throw.
        try {
          await client.logout();
        } catch {
          // Ignore — nothing useful we can do.
        }
        throw connectErr;
      }

      const results: ParsedEmail[] = [];
      let lock: { release: () => void } | undefined;
      try {
        lock = await client.getMailboxLock(mailbox);

        // client.search() returns number[] | false; treat false as empty set.
        const searchResult = await client.search({ seen: false }, { uid: true });
        const uids: number[] = searchResult === false ? [] : searchResult;

        for (const uid of uids) {
          let parsed: ParsedEmail | null = null;
          try {
            // client.fetchOne() returns FetchMessageObject | false.
            const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (msg === false || !msg?.source) {
              // Message disappeared between search and fetch — mark seen to avoid
              // re-fetching on the next poll, then skip.
              try {
                await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
              } catch {
                // Non-fatal.
              }
              continue;
            }

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

            // In-Reply-To header (keep as-is from mailparser).
            const inReplyTo = mail.inReplyTo ?? undefined;

            // References header — mailparser may return string | string[].
            // Normalise to a single space-separated string.
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
            // Log parse errors and mark the message as seen anyway so it won't
            // be re-fetched and re-logged on every subsequent poll.
            console.error(`EmailConnector: failed to parse message uid=${uid}:`, parseErr);
            try {
              await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
            } catch (flagErr) {
              console.error(
                `EmailConnector: failed to mark uid=${uid} as seen after parse error:`,
                flagErr,
              );
            }
            continue;
          }

          if (parsed !== null) {
            results.push(parsed);
            // Mark message as seen so it won't be re-fetched on the next poll.
            try {
              await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
            } catch (flagErr) {
              // Non-fatal — worst case we re-process this message on next poll.
              console.error(`EmailConnector: failed to mark uid=${uid} as seen:`, flagErr);
            }
          }
        }
      } finally {
        // Always release the mailbox lock to prevent connection leaks.
        lock?.release();
        // Always logout regardless of success or error.
        try {
          await client.logout();
        } catch {
          // Ignore logout errors — nothing we can do at this point.
        }
      }

      return results;
    },
  };
}
