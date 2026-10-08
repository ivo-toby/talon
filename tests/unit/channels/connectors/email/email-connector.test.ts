/**
 * Unit tests for EmailConnector.
 *
 * All SMTP and IMAP operations are replaced with in-memory stubs.
 * No real network calls are made.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';
import { EmailConnector, encodeThreadId, decodeThreadId, extractAddress, hasDmarcPass } from '../../../../../src/channels/connectors/email/email-connector.js';
import type { EmailConfig, ParsedEmail } from '../../../../../src/channels/connectors/email/email-types.js';
import type { SmtpTransport, ImapClient, EmailConnectorOptions } from '../../../../../src/channels/connectors/email/email-connector.js';
import type { InboundEvent } from '../../../../../src/channels/channel-types.js';
import { ok, err } from '../../../../../src/core/types/result.js';
import { ChannelError } from '../../../../../src/core/errors/error-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function defaultConfig(overrides?: Partial<EmailConfig>): EmailConfig {
  return {
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpUser: 'user@example.com',
    smtpPass: 'secret',
    smtpSecure: false,
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapUser: 'user@example.com',
    imapPass: 'secret',
    imapSecure: true,
    fromAddress: 'bot@example.com',
    pollingIntervalMs: 50, // fast polling for tests
    ...overrides,
  };
}

/** Build a minimal ParsedEmail. */
function makeEmail(overrides?: Partial<ParsedEmail>): ParsedEmail {
  return {
    messageId: '<msg-001@example.com>',
    from: 'alice@example.com',
    to: 'bot@example.com',
    subject: 'Hello',
    text: 'Hi bot!',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

/** Build a no-op SMTP transport that always returns Ok. */
function okSmtpTransport(): SmtpTransport {
  return {
    send: vi.fn().mockResolvedValue(ok(undefined)),
  };
}

/** Build an SMTP transport that always returns Err. */
function errSmtpTransport(msg = 'smtp error'): SmtpTransport {
  return {
    send: vi.fn().mockResolvedValue(err(new ChannelError(msg))),
  };
}

/** Build an SMTP transport that throws. */
function throwingSmtpTransport(): SmtpTransport {
  return {
    send: vi.fn().mockRejectedValue(new Error('network failure')),
  };
}

/**
 * Build an IMAP client that emits the given batches of emails then hangs.
 * Each call to fetchUnseen() returns the next batch.
 */
function makeImapClient(batches: ParsedEmail[][]): ImapClient {
  let callIndex = 0;
  return {
    fetchUnseen: vi.fn().mockImplementation(async () => {
      const idx = callIndex++;
      if (idx < batches.length) return batches[idx];
      // Subsequent calls return empty (connector keeps polling at interval).
      return [];
    }),
  };
}

/** Build an IMAP client that throws on the first call, then succeeds once. */
function flakyImapClient(email: ParsedEmail): ImapClient {
  let callCount = 0;
  return {
    fetchUnseen: vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('imap connection reset');
      if (callCount === 2) return [email];
      return [];
    }),
  };
}

function makeConnector(
  configOverrides?: Partial<EmailConfig>,
  options?: EmailConnectorOptions,
): EmailConnector {
  return new EmailConnector(
    defaultConfig(configOverrides),
    'test-email',
    silentLogger(),
    options,
  );
}

// ---------------------------------------------------------------------------
// encodeThreadId / decodeThreadId helpers
// ---------------------------------------------------------------------------

describe('encodeThreadId', () => {
  it('encodes address and messageId as <address>:<messageId>', () => {
    expect(encodeThreadId('alice@example.com', '<msg-001@example.com>')).toBe(
      'alice@example.com:msg-001@example.com',
    );
  });

  it('strips angle brackets from the messageId', () => {
    const result = encodeThreadId('bob@example.com', '<abc@host>');
    expect(result).toBe('bob@example.com:abc@host');
  });

  it('handles messageId without angle brackets', () => {
    const result = encodeThreadId('bob@example.com', 'abc@host');
    expect(result).toBe('bob@example.com:abc@host');
  });
});

describe('decodeThreadId', () => {
  it('decodes a valid thread ID', () => {
    const result = decodeThreadId('alice@example.com:msg-001@example.com');
    expect(result).toEqual({ address: 'alice@example.com', messageId: 'msg-001@example.com' });
  });

  it('returns null for a string with no colon', () => {
    expect(decodeThreadId('nocohere')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(decodeThreadId('')).toBeNull();
  });

  it('returns null when address part is empty', () => {
    expect(decodeThreadId(':msg-id')).toBeNull();
  });

  it('returns null when messageId part is empty', () => {
    expect(decodeThreadId('alice@example.com:')).toBeNull();
  });

  it('round-trips with encodeThreadId', () => {
    const original = { address: 'alice@example.com', messageId: 'msg-001@example.com' };
    const encoded = encodeThreadId(original.address, original.messageId);
    const decoded = decodeThreadId(encoded);
    expect(decoded).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// extractAddress
// ---------------------------------------------------------------------------

describe('extractAddress', () => {
  it('extracts address from "Display Name <addr@example.com>" format', () => {
    expect(extractAddress('Alice Smith <alice@example.com>')).toBe('alice@example.com');
  });

  it('returns bare address when no display name', () => {
    expect(extractAddress('alice@example.com')).toBe('alice@example.com');
  });

  it('lowercases the result', () => {
    expect(extractAddress('ALICE@EXAMPLE.COM')).toBe('alice@example.com');
  });

  it('trims whitespace', () => {
    expect(extractAddress('  alice@example.com  ')).toBe('alice@example.com');
  });

  it('handles angle brackets in display name format', () => {
    expect(extractAddress('Bot Name <bot@example.com>')).toBe('bot@example.com');
  });
});

// ---------------------------------------------------------------------------
// Constructor / metadata
// ---------------------------------------------------------------------------

describe('EmailConnector constructor', () => {
  it('exposes type = "email"', () => {
    const connector = makeConnector();
    expect(connector.type).toBe('email');
  });

  it('exposes the channel name', () => {
    const connector = new EmailConnector(defaultConfig(), 'my-email', silentLogger());
    expect(connector.name).toBe('my-email');
  });
});

// ---------------------------------------------------------------------------
// Start / stop lifecycle
// ---------------------------------------------------------------------------

describe('EmailConnector start/stop lifecycle', () => {
  let connector: EmailConnector;

  beforeEach(() => {
    connector = makeConnector({}, { imapClient: makeImapClient([]) });
  });

  afterEach(async () => {
    await connector.stop();
  });

  it('starts and stops without error', async () => {
    await connector.start();
    await connector.stop();
  });

  it('start() is idempotent — calling twice does not create two loops', async () => {
    await connector.start();
    await connector.start(); // second call is a no-op
    await connector.stop();
  });

  it('stop() is idempotent when not running', async () => {
    await connector.stop(); // should not throw
  });

  it('stop() after stop() is a no-op', async () => {
    await connector.start();
    await connector.stop();
    await connector.stop(); // second stop should not throw
  });
});

// ---------------------------------------------------------------------------
// feedInbound (webhook-based inbound)
// ---------------------------------------------------------------------------

describe('EmailConnector feedInbound()', () => {
  let connector: EmailConnector;

  beforeEach(() => {
    connector = makeConnector();
  });

  it('dispatches an InboundEvent to the registered handler', async () => {
    const received: InboundEvent[] = [];
    connector.onMessage(async (event) => { received.push(event); });

    const email = makeEmail();
    await connector.feedInbound(email);

    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event.channelType).toBe('email');
    expect(event.channelName).toBe('test-email');
    expect(event.content).toBe('Hi bot!');
    expect(event.senderId).toBe('alice@example.com');
    expect(event.timestamp).toBe(1_700_000_000_000);
  });

  it('uses Message-ID as idempotency key (stripped of angle brackets)', async () => {
    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => { received.push(e); });

    await connector.feedInbound(makeEmail({ messageId: '<unique-id-123@host.com>' }));

    expect(received[0].idempotencyKey).toBe('unique-id-123@host.com');
  });

  it('encodes externalThreadId as <sender>:<messageId>', async () => {
    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => { received.push(e); });

    await connector.feedInbound(makeEmail({
      messageId: '<msg-001@example.com>',
      from: 'alice@example.com',
    }));

    expect(received[0].externalThreadId).toBe('alice@example.com:msg-001@example.com');
  });

  it('uses In-Reply-To as the thread anchor when present', async () => {
    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => { received.push(e); });

    await connector.feedInbound(makeEmail({
      messageId: '<reply-002@example.com>',
      inReplyTo: '<original-001@example.com>',
      from: 'alice@example.com',
    }));

    // The thread ID is built via encodeThreadId which strips angle brackets
    // from the In-Reply-To value.
    expect(received[0].externalThreadId).toBe('alice@example.com:original-001@example.com');
  });

  it('handles sender in "Display Name <addr>" format', async () => {
    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => { received.push(e); });

    await connector.feedInbound(makeEmail({ from: 'Alice Smith <alice@example.com>' }));

    expect(received[0].senderId).toBe('alice@example.com');
  });

  it('attaches the raw email as event.raw', async () => {
    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => { received.push(e); });

    const email = makeEmail();
    await connector.feedInbound(email);

    expect(received[0].raw).toBe(email);
  });

  it('logs a warning but does not throw when no handler is registered', async () => {
    // No onMessage() call — should not throw.
    await expect(connector.feedInbound(makeEmail())).resolves.toBeUndefined();
  });

  it('catches and logs handler errors without throwing', async () => {
    connector.onMessage(async () => { throw new Error('handler blew up'); });
    await expect(connector.feedInbound(makeEmail())).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// allowedSenders filtering
// ---------------------------------------------------------------------------

describe('EmailConnector allowedSenders filtering', () => {
  it('drops emails from senders not in the allowlist', async () => {
    const received: InboundEvent[] = [];
    const connector = makeConnector({ allowedSenders: ['alice@example.com'] });
    connector.onMessage(async (e) => { received.push(e); });

    await connector.feedInbound(makeEmail({ from: 'alice@example.com' }));
    await connector.feedInbound(makeEmail({ from: 'mallory@evil.com' }));

    expect(received).toHaveLength(1);
    expect(received[0].senderId).toBe('alice@example.com');
  });

  it('allows all senders when allowedSenders is not set', async () => {
    const received: InboundEvent[] = [];
    const connector = makeConnector();
    connector.onMessage(async (e) => { received.push(e); });

    await connector.feedInbound(makeEmail({ from: 'alice@example.com' }));
    await connector.feedInbound(makeEmail({ from: 'bob@example.com' }));

    expect(received).toHaveLength(2);
  });

  it('allows all senders when allowedSenders is an empty array', async () => {
    const received: InboundEvent[] = [];
    const connector = makeConnector({ allowedSenders: [] });
    connector.onMessage(async (e) => { received.push(e); });

    await connector.feedInbound(makeEmail({ from: 'anyone@example.com' }));

    expect(received).toHaveLength(1);
  });

  it('matches sender address case-insensitively via extractAddress', async () => {
    const received: InboundEvent[] = [];
    const connector = makeConnector({ allowedSenders: ['alice@example.com'] });
    connector.onMessage(async (e) => { received.push(e); });

    // extractAddress lowercases the result, so ALICE@EXAMPLE.COM matches alice@example.com
    await connector.feedInbound(makeEmail({ from: 'ALICE@EXAMPLE.COM' }));

    expect(received).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// IMAP polling loop (inbound via poll)
// ---------------------------------------------------------------------------

describe('EmailConnector IMAP polling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches emails fetched by the IMAP client', async () => {
    const received: InboundEvent[] = [];
    const email = makeEmail({ messageId: '<poll-001@example.com>' });

    const connector = makeConnector(
      { pollingIntervalMs: 10 },
      { imapClient: makeImapClient([[email]]) },
    );
    connector.onMessage(async (e) => { received.push(e); });

    await connector.start();
    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(1), { timeout: 2000 });
    await connector.stop();

    expect(received[0].idempotencyKey).toBe('poll-001@example.com');
  });

  it('processes multiple emails in a single poll batch', async () => {
    const received: InboundEvent[] = [];
    const emails = [
      makeEmail({ messageId: '<m1@h>', text: 'first' }),
      makeEmail({ messageId: '<m2@h>', text: 'second' }),
      makeEmail({ messageId: '<m3@h>', text: 'third' }),
    ];

    const connector = makeConnector(
      { pollingIntervalMs: 10 },
      { imapClient: makeImapClient([emails]) },
    );
    connector.onMessage(async (e) => { received.push(e); });

    await connector.start();
    await vi.waitFor(() => expect(received.length).toBe(3), { timeout: 2000 });
    await connector.stop();

    expect(received.map((e) => e.content)).toEqual(['first', 'second', 'third']);
  });

  it('continues polling after an IMAP error (exponential backoff)', { timeout: 10_000 }, async () => {
    const received: InboundEvent[] = [];
    const email = makeEmail({ messageId: '<after-error@h>' });

    const connector = makeConnector(
      { pollingIntervalMs: 10 },
      { imapClient: flakyImapClient(email) },
    );
    connector.onMessage(async (e) => { received.push(e); });

    await connector.start();
    // The second poll (after backoff) should succeed.
    await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 8000 });
    await connector.stop();
  });

  it('respects the configured pollingIntervalMs', async () => {
    let fetchCallCount = 0;
    const imapClient: ImapClient = {
      fetchUnseen: vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        return [];
      }),
    };

    const connector = makeConnector(
      { pollingIntervalMs: 50 },
      { imapClient },
    );

    await connector.start();
    // Wait a bit less than two poll cycles; should have been called at least once.
    await new Promise((r) => setTimeout(r, 80));
    await connector.stop();

    expect(fetchCallCount).toBeGreaterThanOrEqual(1);
  });

  it('uses the configured mailbox when polling', async () => {
    const fetchMock = vi.fn().mockResolvedValue([]);
    const imapClient: ImapClient = { fetchUnseen: fetchMock };

    const connector = makeConnector(
      { pollingIntervalMs: 10, mailbox: 'Sent' },
      { imapClient },
    );

    await connector.start();
    await new Promise((r) => setTimeout(r, 30));
    await connector.stop();

    expect(fetchMock).toHaveBeenCalledWith('Sent');
  });

  it('defaults to INBOX mailbox when mailbox is not configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue([]);
    const imapClient: ImapClient = { fetchUnseen: fetchMock };

    const connector = makeConnector({ pollingIntervalMs: 10 }, { imapClient });

    await connector.start();
    await new Promise((r) => setTimeout(r, 30));
    await connector.stop();

    expect(fetchMock).toHaveBeenCalledWith('INBOX');
  });
});

// ---------------------------------------------------------------------------
// send()
// ---------------------------------------------------------------------------

describe('EmailConnector send()', () => {
  it('returns Ok on successful SMTP send', async () => {
    const smtp = okSmtpTransport();
    const connector = makeConnector({}, { smtpTransport: smtp });

    const result = await connector.send('alice@example.com:msg-001@example.com', {
      body: 'Hello **world**',
    });

    expect(result.isOk()).toBe(true);
  });

  it('calls the SMTP transport with the correct from address', async () => {
    const smtp = okSmtpTransport();
    const connector = makeConnector({ fromAddress: 'bot@example.com' }, { smtpTransport: smtp });

    await connector.send('alice@example.com:msg-001@example.com', { body: 'Hello' });

    expect(smtp.send).toHaveBeenCalledWith(
      'bot@example.com',
      expect.objectContaining({ to: 'alice@example.com' }),
    );
  });

  it('sets In-Reply-To and References headers for threading', async () => {
    const smtp = okSmtpTransport();
    const connector = makeConnector({}, { smtpTransport: smtp });

    await connector.send('alice@example.com:original-msg-id@example.com', { body: 'Reply' });

    expect(smtp.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        inReplyTo: '<original-msg-id@example.com>',
        references: '<original-msg-id@example.com>',
      }),
    );
  });

  it('sends the HTML-formatted body', async () => {
    const smtp = okSmtpTransport();
    const connector = makeConnector({}, { smtpTransport: smtp });

    await connector.send('alice@example.com:msg-id@h', { body: '**bold**' });

    const callArgs = (smtp.send as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { html: string }];
    expect(callArgs[1].html).toContain('<strong>bold</strong>');
  });

  it('returns Err(ChannelError) when SMTP transport returns Err', async () => {
    const smtp = errSmtpTransport('authentication failed');
    const connector = makeConnector({}, { smtpTransport: smtp });

    const result = await connector.send('alice@example.com:msg@h', { body: 'test' });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('authentication failed');
  });

  it('returns Err(ChannelError) when SMTP transport throws', async () => {
    const smtp = throwingSmtpTransport();
    const connector = makeConnector({}, { smtpTransport: smtp });

    const result = await connector.send('alice@example.com:msg@h', { body: 'test' });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('network failure');
  });

  it('returns Err(ChannelError) for malformed externalThreadId', async () => {
    const connector = makeConnector({}, { smtpTransport: okSmtpTransport() });

    const result = await connector.send('not-a-valid-thread-id', { body: 'test' });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('invalid externalThreadId format');
  });

  it('returns Err for externalThreadId with no colon', async () => {
    const connector = makeConnector({}, { smtpTransport: okSmtpTransport() });
    const result = await connector.send('alice@example.com', { body: 'hi' });
    expect(result.isErr()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// format()
// ---------------------------------------------------------------------------

describe('EmailConnector format()', () => {
  it('delegates to markdownToHtml', () => {
    const connector = makeConnector();
    const result = connector.format('**hello**');
    expect(result).toContain('<strong>hello</strong>');
  });

  it('produces HTML for a heading', () => {
    const connector = makeConnector();
    expect(connector.format('# Title')).toContain('<h1>Title</h1>');
  });

  it('wraps plain text in <p>', () => {
    const connector = makeConnector();
    expect(connector.format('plain text')).toContain('<p>plain text</p>');
  });
});

// ---------------------------------------------------------------------------
// onMessage replacement
// ---------------------------------------------------------------------------

describe('EmailConnector onMessage()', () => {
  it('replaces the handler on a second call', async () => {
    const received1: InboundEvent[] = [];
    const received2: InboundEvent[] = [];

    const connector = makeConnector();

    connector.onMessage(async (e) => { received1.push(e); });
    connector.onMessage(async (e) => { received2.push(e); });

    await connector.feedInbound(makeEmail());

    // Only the second handler should have been called.
    expect(received1).toHaveLength(0);
    expect(received2).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Thread anchoring (root of References)
// ---------------------------------------------------------------------------

describe('EmailConnector thread anchoring', () => {
  it('maps a reply-to-a-reply to the same externalThreadId as the first mail', async () => {
    const connector = makeConnector({}, { smtpTransport: okSmtpTransport() });
    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => {
      received.push(e);
    });

    await connector.feedInbound(
      makeEmail({
        messageId: '<first@example.com>',
      }),
    );
    await connector.feedInbound(
      makeEmail({
        messageId: '<second@example.com>',
        inReplyTo: '<first@example.com>',
        references: '<first@example.com>',
      }),
    );
    await connector.feedInbound(
      makeEmail({
        messageId: '<third@example.com>',
        inReplyTo: '<second@example.com>',
        references: '<first@example.com> <second@example.com>',
      }),
    );

    expect(received.map((e) => e.externalThreadId)).toEqual([
      'alice@example.com:first@example.com',
      'alice@example.com:first@example.com',
      'alice@example.com:first@example.com',
    ]);
  });

  it('uses the first References entry (root), not In-Reply-To, as the anchor', async () => {
    const connector = makeConnector();
    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => {
      received.push(e);
    });

    await connector.feedInbound(
      makeEmail({
        messageId: '<c@example.com>',
        inReplyTo: '<b@example.com>',
        references: '<a@example.com> <b@example.com>',
      }),
    );

    expect(received[0].externalThreadId).toBe('alice@example.com:a@example.com');
  });

  it('falls back to In-Reply-To when References is empty', async () => {
    const connector = makeConnector();
    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => {
      received.push(e);
    });

    await connector.feedInbound(
      makeEmail({
        messageId: '<c@example.com>',
        inReplyTo: '<b@example.com>',
        references: '   ',
      }),
    );

    expect(received[0].externalThreadId).toBe('alice@example.com:b@example.com');
  });
});

// ---------------------------------------------------------------------------
// Reply metadata: subject and In-Reply-To / References on send()
// ---------------------------------------------------------------------------

describe('EmailConnector reply metadata', () => {
  async function sendReplyFor(
    email: Partial<ParsedEmail>,
  ): Promise<{ subject: string; inReplyTo: string; references: string }> {
    const smtp = okSmtpTransport();
    const connector = makeConnector({}, { smtpTransport: smtp });
    connector.onMessage(async () => {});
    await connector.feedInbound(makeEmail(email));
    const threadId = encodeThreadId(
      'alice@example.com',
      email.references?.split(' ')[0] ??
        email.inReplyTo ??
        email.messageId ??
        '<msg-001@example.com>',
    );
    await connector.send(threadId, { body: 'reply' });
    const opts = (smtp.send as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      subject: string;
      inReplyTo: string;
      references: string;
    };
    return opts;
  }

  it('prefixes the inbound subject with "Re: "', async () => {
    const opts = await sendReplyFor({ subject: 'Project status' });
    expect(opts.subject).toBe('Re: Project status');
  });

  it('does not double the "Re:" prefix', async () => {
    const opts = await sendReplyFor({ subject: 'RE: Project status' });
    expect(opts.subject).toBe('RE: Project status');
  });

  it('falls back to "Re: message" when no inbound metadata is known', async () => {
    const smtp = okSmtpTransport();
    const connector = makeConnector({}, { smtpTransport: smtp });
    await connector.send('alice@example.com:unknown@h', { body: 'hi' });
    const opts = (smtp.send as ReturnType<typeof vi.fn>).mock.calls[0][1] as { subject: string };
    expect(opts.subject).toBe('Re: message');
  });

  it('sets In-Reply-To to the latest inbound Message-ID and References to the full chain', async () => {
    const smtp = okSmtpTransport();
    const connector = makeConnector({}, { smtpTransport: smtp });
    connector.onMessage(async () => {});

    await connector.feedInbound(makeEmail({ messageId: '<first@example.com>' }));
    await connector.feedInbound(
      makeEmail({
        messageId: '<second@example.com>',
        inReplyTo: '<first@example.com>',
        references: '<first@example.com>',
      }),
    );

    await connector.send('alice@example.com:first@example.com', { body: 'reply' });

    expect(smtp.send).toHaveBeenCalledWith(
      'bot@example.com',
      expect.objectContaining({
        inReplyTo: '<second@example.com>',
        references: '<first@example.com> <second@example.com>',
      }),
    );
  });

  it('keeps exactly one pair of angle brackets on every Message-ID header', async () => {
    const smtp = okSmtpTransport();
    const connector = makeConnector({}, { smtpTransport: smtp });
    connector.onMessage(async () => {});

    await connector.feedInbound(
      makeEmail({
        messageId: '<<bracketed@example.com>>',
        references: '<root@example.com>  <<mid@example.com>>',
      }),
    );
    await connector.send('alice@example.com:root@example.com', { body: 'reply' });

    const opts = (smtp.send as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      inReplyTo: string;
      references: string;
    };
    expect(opts.inReplyTo).toBe('<bracketed@example.com>');
    expect(opts.references).toBe('<root@example.com> <mid@example.com> <bracketed@example.com>');
  });

  it('bounds the thread metadata map and evicts the oldest thread', async () => {
    const smtp = okSmtpTransport();
    const connector = makeConnector({}, { smtpTransport: smtp });
    connector.onMessage(async () => {});

    // Thread "first" is inserted before 500 newer threads, so it is evicted.
    await connector.feedInbound(makeEmail({ messageId: '<first@example.com>', subject: 'Oldest' }));
    for (let i = 0; i < 500; i++) {
      await connector.feedInbound(
        makeEmail({ messageId: `<t${i}@example.com>`, subject: `S${i}` }),
      );
    }

    await connector.send('alice@example.com:first@example.com', { body: 'x' });
    const evicted = (smtp.send as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      subject: string;
      inReplyTo: string;
    };
    expect(evicted.subject).toBe('Re: message');
    expect(evicted.inReplyTo).toBe('<first@example.com>');

    await connector.send('alice@example.com:t499@example.com', { body: 'y' });
    const kept = (smtp.send as ReturnType<typeof vi.fn>).mock.calls[1][1] as { subject: string };
    expect(kept.subject).toBe('Re: S499');
  });
});

// ---------------------------------------------------------------------------
// DMARC gate (requireDmarcPass)
// ---------------------------------------------------------------------------

/** Real-world KPN ARC-Authentication-Results shape (instance tag, trusted id). */
const KPN_ARC_PASS =
  'i=1; mx.kpnmail.nl; spf=pass smtp.mailfrom=alice@example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com; arc=none';

describe('hasDmarcPass()', () => {
  const trusted = 'mx.kpnmail.nl';

  it('accepts a trusted ARC header with dmarc=pass and matching header.from', () => {
    expect(hasDmarcPass([KPN_ARC_PASS], trusted, 'alice@example.com')).toBe(true);
  });

  it('rejects when header.from is for another domain', () => {
    expect(hasDmarcPass([KPN_ARC_PASS], trusted, 'alice@other.example')).toBe(false);
  });

  it('rejects dmarc=fail from the trusted id', () => {
    const failed = KPN_ARC_PASS.replace('dmarc=pass', 'dmarc=fail');
    expect(hasDmarcPass([failed], trusted, 'alice@example.com')).toBe(false);
  });

  it('ignores a dmarc=pass header from an untrusted authserv-id', () => {
    const forged = 'i=1; evil.example; dmarc=pass header.from=example.com';
    expect(hasDmarcPass([forged], trusted, 'alice@example.com')).toBe(false);
  });

  it('lets the trusted value decide over a forged header below it', () => {
    const trustedFail = 'i=1; mx.kpnmail.nl; dmarc=fail header.from=example.com';
    const forgedPass = 'evil.example; dmarc=pass header.from=example.com';
    expect(hasDmarcPass([trustedFail, forgedPass], trusted, 'alice@example.com')).toBe(false);
  });

  it('rejects a forged header that only claims dmarc=pass (no trusted value)', () => {
    const forged = 'evil.example; dmarc=pass header.from=example.com';
    expect(hasDmarcPass([forged], trusted, 'alice@example.com')).toBe(false);
  });

  it('fails closed when trustedAuthServId is unset or empty', () => {
    expect(hasDmarcPass([KPN_ARC_PASS], undefined, 'alice@example.com')).toBe(false);
    expect(hasDmarcPass([KPN_ARC_PASS], '', 'alice@example.com')).toBe(false);
  });

  it('fails closed on empty results', () => {
    expect(hasDmarcPass(undefined, trusted, 'alice@example.com')).toBe(false);
    expect(hasDmarcPass([], trusted, 'alice@example.com')).toBe(false);
  });

  it('fails closed when the sender has no domain', () => {
    expect(hasDmarcPass([KPN_ARC_PASS], trusted, 'alice')).toBe(false);
  });

  it('matches the authserv-id case-insensitively and ignoring a trailing dot', () => {
    const value = 'i=1; MX.KPNMAIL.NL.; dmarc=pass header.from=example.com';
    expect(hasDmarcPass([value], trusted, 'alice@example.com')).toBe(true);
  });

  it('accepts a plain Authentication-Results value (no i= tag) from the trusted id', () => {
    const value = 'mx.kpnmail.nl; dkim=pass; dmarc=pass header.from=example.com';
    expect(hasDmarcPass([value], trusted, 'alice@example.com')).toBe(true);
  });

  it('ignores a trailing version number after the authserv-id', () => {
    const value = 'mx.kpnmail.nl 1; dmarc=pass header.from=example.com';
    expect(hasDmarcPass([value], trusted, 'alice@example.com')).toBe(true);
  });
});

describe('EmailConnector requireDmarcPass', () => {
  const dmarcConfig = { requireDmarcPass: true, trustedAuthServId: 'mx.kpnmail.nl' };

  it('dispatches mail with a trusted dmarc=pass result when requireDmarcPass is true', async () => {
    const connector = makeConnector(dmarcConfig);
    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => {
      received.push(e);
    });

    await connector.feedInbound(makeEmail({ authenticationResults: [KPN_ARC_PASS] }));

    expect(received).toHaveLength(1);
  });

  it('drops mail whose trusted result is dmarc=fail', async () => {
    const connector = makeConnector(dmarcConfig);
    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => {
      received.push(e);
    });

    await connector.feedInbound(
      makeEmail({
        authenticationResults: [KPN_ARC_PASS.replace('dmarc=pass', 'dmarc=fail')],
      }),
    );

    expect(received).toHaveLength(0);
  });

  it('drops mail with no authentication results (fail closed)', async () => {
    const connector = makeConnector(dmarcConfig);
    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => {
      received.push(e);
    });

    await connector.feedInbound(makeEmail());

    expect(received).toHaveLength(0);
  });

  it('drops everything when requireDmarcPass is set without trustedAuthServId', async () => {
    const connector = makeConnector({ requireDmarcPass: true });
    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => {
      received.push(e);
    });

    await connector.feedInbound(makeEmail({ authenticationResults: [KPN_ARC_PASS] }));

    expect(received).toHaveLength(0);
  });

  it('is off by default, so mail without DMARC results is dispatched', async () => {
    const connector = makeConnector();
    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => {
      received.push(e);
    });

    await connector.feedInbound(makeEmail());

    expect(received).toHaveLength(1);
  });
});
