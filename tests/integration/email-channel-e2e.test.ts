/**
 * End-to-end integration tests for the Email channel connector.
 *
 * Tests the full inbound + outbound flow using injected mock transports:
 *   IMAP poll → ParsedEmail → EmailConnector → onMessage handler fires
 *   send()   → SmtpTransport.send() called with correct parameters
 *
 * No real IMAP/SMTP connections are made.
 * No internal connector code is mocked — only the transport boundary is stubbed.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { ok, err } from 'neverthrow';
import pino from 'pino';

import {
  EmailConnector,
  type SmtpTransport,
  type ImapClient,
} from '../../src/channels/connectors/email/email-connector.js';
import type { EmailConfig, ParsedEmail } from '../../src/channels/connectors/email/email-types.js';
import type { InboundEvent, AgentOutput } from '../../src/channels/channel-types.js';
import { ChannelError } from '../../src/core/errors/error-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function makeConfig(overrides?: Partial<EmailConfig>): EmailConfig {
  return {
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpUser: 'bot@example.com',
    smtpPass: 'secret',
    smtpSecure: false,
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapUser: 'bot@example.com',
    imapPass: 'secret',
    imapSecure: true,
    fromAddress: 'bot@example.com',
    pollingIntervalMs: 50, // fast polling for tests
    ...overrides,
  };
}

function makeEmail(overrides?: Partial<ParsedEmail>): ParsedEmail {
  return {
    messageId: '<msg-001@example.com>',
    from: 'alice@example.com',
    to: 'bot@example.com',
    subject: 'Hello bot!',
    text: 'Can you help me?',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Build a mock IMAP client that returns the given emails on the first poll,
 * then empty on subsequent polls.
 */
function makeImapClient(emails: ParsedEmail[]): ImapClient {
  let firstCall = true;
  return {
    async fetchUnseen() {
      if (firstCall) {
        firstCall = false;
        return emails.map((email, i) => ({ email, uid: String(i + 1) }));
      }
      return [];
    },
    async markSeen() {
      // no-op in tests — connector calls this after successful handling
    },
  };
}

/**
 * Mock SMTP transport that records all send() calls and returns ok.
 */
type TrackingSmtp = SmtpTransport & { calls: Parameters<SmtpTransport['send']>[] };

function makeSmtpTransport(): TrackingSmtp {
  const calls: Parameters<SmtpTransport['send']>[] = [];
  return {
    calls,
    async send(from, options) {
      calls.push([from, options]);
      return ok(undefined);
    },
  };
}

/**
 * SMTP transport that always fails.
 */
function makeFailingSmtpTransport(): SmtpTransport {
  return {
    async send() {
      return err(new ChannelError('SMTP send failed: Connection refused'));
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Email channel e2e', () => {
  let connector: EmailConnector;

  afterEach(async () => {
    if (connector) {
      await connector.stop();
    }
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Inbound flow
  // -------------------------------------------------------------------------

  it('full inbound flow: IMAP poll → onMessage handler fires with correct event', async () => {
    const email = makeEmail();
    const smtp = makeSmtpTransport();
    connector = new EmailConnector(makeConfig(), 'email-e2e', silentLogger(), {
      smtpTransport: smtp,
      imapClient: makeImapClient([email]),
    });

    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => { received.push(e); });

    await connector.start();
    // Wait for first poll cycle to complete
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('Can you help me?');
    expect(received[0].senderId).toBe('alice@example.com');    // sender address
    expect(received[0].channelName).toBe('email-e2e');
    expect(received[0].channelType).toBe('email');
    expect(received[0].externalThreadId).toBeTruthy();
  });

  it('multiple emails in one poll batch are all delivered', async () => {
    const emails = [
      makeEmail({ messageId: '<msg-1@e.com>', text: 'First', from: 'alice@example.com' }),
      makeEmail({ messageId: '<msg-2@e.com>', text: 'Second', from: 'bob@example.com' }),
      makeEmail({ messageId: '<msg-3@e.com>', text: 'Third', from: 'carol@example.com' }),
    ];
    const smtp = makeSmtpTransport();
    connector = new EmailConnector(makeConfig(), 'email-e2e', silentLogger(), {
      smtpTransport: smtp,
      imapClient: makeImapClient(emails),
    });

    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => { received.push(e); });

    await connector.start();
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(received).toHaveLength(3);
    expect(received.map((e) => e.content)).toEqual(['First', 'Second', 'Third']);
    expect(received.map((e) => e.senderId)).toEqual([
      'alice@example.com', 'bob@example.com', 'carol@example.com',
    ]);
  });

  it('externalThreadId encodes sender-address and message-ID', async () => {
    const email = makeEmail({
      from: 'thread-test@example.com',
      messageId: '<thread-anchor@example.com>',
    });
    const smtp = makeSmtpTransport();
    connector = new EmailConnector(makeConfig(), 'email-e2e', silentLogger(), {
      smtpTransport: smtp,
      imapClient: makeImapClient([email]),
    });

    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => { received.push(e); });

    await connector.start();
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(received[0].externalThreadId).toContain('thread-test@example.com');
    expect(received[0].externalThreadId).toContain('thread-anchor@example.com');
  });

  it('idempotency key is the message-ID without angle brackets', async () => {
    const email = makeEmail({ messageId: '<idempotent-msg@example.com>' });
    const smtp = makeSmtpTransport();
    connector = new EmailConnector(makeConfig(), 'email-e2e', silentLogger(), {
      smtpTransport: smtp,
      imapClient: makeImapClient([email]),
    });

    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => { received.push(e); });

    await connector.start();
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(received[0].idempotencyKey).toBe('idempotent-msg@example.com');
  });

  it('polling stops cleanly on stop() — no further polls after stop', async () => {
    let pollCount = 0;
    const imap: ImapClient = {
      async fetchUnseen() {
        pollCount++;
        return [];
      },
      async markSeen() {},
    };
    const smtp = makeSmtpTransport();
    connector = new EmailConnector(makeConfig({ pollingIntervalMs: 20 }), 'email-e2e', silentLogger(), {
      smtpTransport: smtp,
      imapClient: imap,
    });

    await connector.start();
    await new Promise((resolve) => setTimeout(resolve, 80));

    await connector.stop();
    const countAtStop = pollCount;

    // After stop, polling must not continue
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(pollCount).toBe(countAtStop);
  });

  // -------------------------------------------------------------------------
  // Outbound flow
  // -------------------------------------------------------------------------

  it('full outbound flow: send() calls SMTP transport with correct from/to/html', async () => {
    const smtp = makeSmtpTransport();
    connector = new EmailConnector(makeConfig(), 'email-e2e', silentLogger(), {
      smtpTransport: smtp,
      imapClient: makeImapClient([]),
    });

    await connector.start();

    // externalThreadId format: <address>:<messageId-without-angle-brackets>
    const threadId = 'recipient@example.com:msg-ref-001@example.com';
    const output: AgentOutput = { body: '**Hello** from the bot' };
    const result = await connector.send(threadId, output);

    expect(result.isOk()).toBe(true);
    expect(smtp.calls).toHaveLength(1);
    const [from, options] = smtp.calls[0];
    expect(from).toBe('bot@example.com');          // fromAddress from config
    expect(options.to).toBe('recipient@example.com');
    expect(options.html).toContain('Hello');        // markdown → HTML conversion
  });

  it('send() includes inReplyTo and references when threadId carries a message-ID', async () => {
    const smtp = makeSmtpTransport();
    connector = new EmailConnector(makeConfig(), 'email-e2e', silentLogger(), {
      smtpTransport: smtp,
      imapClient: makeImapClient([]),
    });

    await connector.start();

    const threadId = 'user@example.com:original-msg-123@example.com';
    await connector.send(threadId, { body: 'Reply body' });

    expect(smtp.calls).toHaveLength(1);
    const [, options] = smtp.calls[0];
    expect(options.inReplyTo).toBe('<original-msg-123@example.com>');
    expect(options.references).toContain('original-msg-123@example.com');
  });

  it('send() returns ChannelError when SMTP transport fails', async () => {
    connector = new EmailConnector(makeConfig(), 'email-e2e', silentLogger(), {
      smtpTransport: makeFailingSmtpTransport(),
      imapClient: makeImapClient([]),
    });

    await connector.start();

    const result = await connector.send('recipient@example.com:msg-ref-002@example.com', {
      body: 'Hi',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ChannelError);
    }
  });

  it('send() with invalid threadId returns ChannelError', async () => {
    const smtp = makeSmtpTransport();
    connector = new EmailConnector(makeConfig(), 'email-e2e', silentLogger(), {
      smtpTransport: smtp,
      imapClient: makeImapClient([]),
    });

    await connector.start();

    // threadId without colon separator is invalid
    const result = await connector.send('no-colon-here', { body: 'Hi' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ChannelError);
    }
  });

  // -------------------------------------------------------------------------
  // feedInbound (webhook path)
  // -------------------------------------------------------------------------

  it('feedInbound() bypasses IMAP poll and delivers event directly to handler', async () => {
    const smtp = makeSmtpTransport();
    connector = new EmailConnector(makeConfig(), 'email-e2e', silentLogger(), {
      smtpTransport: smtp,
      imapClient: makeImapClient([]), // no IMAP messages
    });

    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => { received.push(e); });

    await connector.start();

    const email = makeEmail({ text: 'Webhook inbound', from: 'webhook-sender@example.com' });
    await connector.feedInbound(email);

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('Webhook inbound');
    expect(received[0].senderId).toBe('webhook-sender@example.com');
  });

  // -------------------------------------------------------------------------
  // Round-trip: inbound → handler → reply
  // -------------------------------------------------------------------------

  it('round-trip: receive email via feedInbound, handler sends SMTP reply', async () => {
    const smtp = makeSmtpTransport();
    connector = new EmailConnector(makeConfig(), 'email-e2e', silentLogger(), {
      smtpTransport: smtp,
      imapClient: makeImapClient([]),
    });

    connector.onMessage(async (event) => {
      // Simulate agent runner calling send() after processing
      await connector.send(event.externalThreadId, { body: 'Got your message!' });
    });

    await connector.start();

    const inboundEmail = makeEmail({
      from: 'customer@example.com',
      messageId: '<customer-msg-1@example.com>',
      text: 'I need support',
    });
    await connector.feedInbound(inboundEmail);

    expect(smtp.calls).toHaveLength(1);
    const [from, options] = smtp.calls[0];
    expect(from).toBe('bot@example.com');
    expect(options.to).toBe('customer@example.com');
    expect(options.html).toContain('Got your message');
    expect(options.inReplyTo).toBe('<customer-msg-1@example.com>');
  });

  it('round-trip: IMAP poll receives email → handler sends reply via SMTP', async () => {
    const smtp = makeSmtpTransport();
    const inboundEmail = makeEmail({
      from: 'imap-user@example.com',
      messageId: '<imap-msg-42@example.com>',
      text: 'Please respond',
    });

    connector = new EmailConnector(makeConfig(), 'email-e2e', silentLogger(), {
      smtpTransport: smtp,
      imapClient: makeImapClient([inboundEmail]),
    });

    connector.onMessage(async (event) => {
      await connector.send(event.externalThreadId, { body: 'Responding now!' });
    });

    await connector.start();
    // Wait for poll + handler + send to complete
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(smtp.calls).toHaveLength(1);
    const [from, options] = smtp.calls[0];
    expect(from).toBe('bot@example.com');
    expect(options.to).toBe('imap-user@example.com');
    expect(options.inReplyTo).toBe('<imap-msg-42@example.com>');
  });
});
