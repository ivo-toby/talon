/**
 * Unit tests for the imapflow-backed IMAP client.
 *
 * imapflow and mailparser are mocked; no network connection is made.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type pino from 'pino';
import type { EmailConfig } from '../../../../../src/channels/connectors/email/email-types.js';
import { createImapFlowClient } from '../../../../../src/channels/connectors/email/email-imap-client.js';

const h = vi.hoisted(() => {
  const client = {
    on: vi.fn(),
    connect: vi.fn(),
    getMailboxLock: vi.fn(),
    search: vi.fn(),
    fetchOne: vi.fn(),
    messageFlagsAdd: vi.fn(),
    logout: vi.fn(),
    close: vi.fn(),
  };
  const lock = { release: vi.fn() };
  return { client, lock, ctor: vi.fn(), simpleParser: vi.fn() };
});

vi.mock('imapflow', () => ({
  ImapFlow: class {
    constructor(opts: unknown) {
      h.ctor(opts);
      return h.client as unknown as object;
    }
  },
}));

vi.mock('mailparser', () => ({
  simpleParser: h.simpleParser,
}));

function config(overrides: Partial<EmailConfig> = {}): EmailConfig {
  return {
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpUser: 'bot@example.com',
    smtpPass: 'smtp-pass',
    smtpSecure: false,
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapUser: 'bot@example.com',
    imapPass: 'imap-pass',
    imapSecure: true,
    fromAddress: 'bot@example.com',
    ...overrides,
  };
}

function fakeLogger(): { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), debug: vi.fn() };
}

/** Build a mailparser-like result for a message. */
function parsedMail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: '<m1@example.com>',
    from: { value: [{ address: 'alice@example.com', name: 'Alice' }] },
    to: { value: [{ address: 'bot@example.com' }] },
    subject: 'Hello',
    text: 'Hi bot',
    inReplyTo: '<root@example.com>',
    references: ['<root@example.com>', '<mid@example.com>'],
    date: new Date('2024-01-02T03:04:05Z'),
    headers: new Map<string, unknown>([['authentication-results', ['mx.example.com; dmarc=pass']]]),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.client.connect.mockResolvedValue(undefined);
  h.client.getMailboxLock.mockResolvedValue(h.lock);
  h.client.search.mockResolvedValue([]);
  h.client.fetchOne.mockResolvedValue({ source: Buffer.from('raw') });
  h.client.messageFlagsAdd.mockResolvedValue(true);
  h.client.logout.mockResolvedValue(undefined);
  h.simpleParser.mockResolvedValue(parsedMail());
});

describe('createImapFlowClient connection setup', () => {
  it('creates ImapFlow with the IMAP config and attaches an error listener', async () => {
    const client = createImapFlowClient(config());
    await client.fetchUnseen('INBOX');

    expect(h.ctor).toHaveBeenCalledWith({
      host: 'imap.example.com',
      port: 993,
      secure: true,
      auth: { user: 'bot@example.com', pass: 'imap-pass' },
      logger: false,
    });
    expect(h.client.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('logs socket errors from the error listener instead of throwing', async () => {
    const logger = fakeLogger();
    await createImapFlowClient(config(), logger as unknown as pino.Logger).fetchUnseen('INBOX');

    const listener = h.client.on.mock.calls.find((c) => c[0] === 'error')?.[1] as (
      e: unknown,
    ) => void;
    expect(() => listener(new Error('ECONNRESET'))).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('createImapFlowClient fetchUnseen() mapping', () => {
  it('maps a parsed message to ParsedEmail and marks it seen', async () => {
    h.client.search.mockResolvedValue([5]);
    const client = createImapFlowClient(config());

    const emails = await client.fetchUnseen('INBOX');

    expect(h.client.search).toHaveBeenCalledWith({ seen: false }, { uid: true });
    expect(h.client.getMailboxLock).toHaveBeenCalledWith('INBOX');
    expect(h.client.fetchOne).toHaveBeenCalledWith(5, { source: true }, { uid: true });
    expect(emails).toEqual([
      {
        messageId: '<m1@example.com>',
        from: 'alice@example.com',
        to: 'bot@example.com',
        subject: 'Hello',
        text: 'Hi bot',
        inReplyTo: '<root@example.com>',
        references: '<root@example.com> <mid@example.com>',
        timestamp: Date.parse('2024-01-02T03:04:05Z'),
        authenticationResults: ['mx.example.com; dmarc=pass'],
      },
    ]);
    expect(h.client.messageFlagsAdd).toHaveBeenCalledWith(5, ['\\Seen'], { uid: true });
  });

  it('synthesizes a Message-ID and defaults missing fields', async () => {
    h.client.search.mockResolvedValue([9]);
    h.simpleParser.mockResolvedValue(
      parsedMail({
        messageId: undefined,
        from: undefined,
        to: undefined,
        subject: undefined,
        text: undefined,
        inReplyTo: undefined,
        references: '<a@example.com>',
        date: undefined,
        headers: new Map<string, unknown>(),
      }),
    );

    const [email] = await createImapFlowClient(config()).fetchUnseen('INBOX');

    expect(email.messageId).toBe('<no-id-9@local>');
    expect(email.from).toBe('');
    expect(email.to).toBe('');
    expect(email.subject).toBe('');
    expect(email.text).toBe('');
    expect(email.inReplyTo).toBeUndefined();
    expect(email.references).toBe('<a@example.com>');
    expect(email.timestamp).toBeGreaterThan(0);
    expect(email.authenticationResults).toEqual([]);
  });

  it('normalises Authentication-Results values, dropping non-string entries', async () => {
    h.client.search.mockResolvedValue([3]);
    h.simpleParser.mockResolvedValue(
      parsedMail({
        headers: new Map<string, unknown>([
          [
            'authentication-results',
            [
              'top.example.com; dmarc=pass',
              { params: {}, value: 'object-valued' },
              'bottom.example.com; dmarc=none',
            ],
          ],
        ]),
      }),
    );

    const [email] = await createImapFlowClient(config()).fetchUnseen('INBOX');

    expect(email.authenticationResults).toEqual([
      'top.example.com; dmarc=pass',
      'bottom.example.com; dmarc=none',
    ]);
  });

  it('accepts a single string Authentication-Results header', async () => {
    h.client.search.mockResolvedValue([3]);
    h.simpleParser.mockResolvedValue(
      parsedMail({
        headers: new Map<string, unknown>([['authentication-results', 'mx; dmarc=pass']]),
      }),
    );

    const [email] = await createImapFlowClient(config()).fetchUnseen('INBOX');
    expect(email.authenticationResults).toEqual(['mx; dmarc=pass']);
  });

  it('processes at most 20 messages per poll, oldest (lowest UID) first', async () => {
    const uids = [
      30, 2, 25, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ];
    h.client.search.mockResolvedValue(uids);
    h.simpleParser.mockImplementation(async () => parsedMail());

    await createImapFlowClient(config()).fetchUnseen('INBOX');

    const fetched = h.client.fetchOne.mock.calls
      .filter((c) => (c[1] as { source?: boolean }).source)
      .map((c) => c[0] as number);
    expect(fetched).toHaveLength(20);
    expect(fetched).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
  });

  it('returns an empty array and does not fetch when nothing is unseen', async () => {
    h.client.search.mockResolvedValue(false);

    const emails = await createImapFlowClient(config()).fetchUnseen('INBOX');

    expect(emails).toEqual([]);
    expect(h.client.fetchOne).not.toHaveBeenCalled();
  });
});

describe('createImapFlowClient authentication headers', () => {
  it('reads Authentication-Results then ARC-Authentication-Results, each top to bottom', async () => {
    h.client.search.mockResolvedValue([4]);
    h.simpleParser.mockResolvedValue(
      parsedMail({
        headers: new Map<string, unknown>([
          [
            'arc-authentication-results',
            [
              'i=2; mx.kpnmail.nl; dmarc=pass header.from=example.com',
              'i=1; mx.kpnmail.nl; dmarc=none',
            ],
          ],
          ['authentication-results', 'mx.kpnmail.nl; dmarc=pass header.from=example.com'],
        ]),
      }),
    );

    const [email] = await createImapFlowClient(config()).fetchUnseen('INBOX');

    expect(email.authenticationResults).toEqual([
      'mx.kpnmail.nl; dmarc=pass header.from=example.com',
      'i=2; mx.kpnmail.nl; dmarc=pass header.from=example.com',
      'i=1; mx.kpnmail.nl; dmarc=none',
    ]);
  });

  it('keeps only string values from ARC-Authentication-Results', async () => {
    h.client.search.mockResolvedValue([4]);
    h.simpleParser.mockResolvedValue(
      parsedMail({
        headers: new Map<string, unknown>([
          [
            'arc-authentication-results',
            [{ params: {}, value: 'x' }, 'i=1; mx.kpnmail.nl; arc=none'],
          ],
        ]),
      }),
    );

    const [email] = await createImapFlowClient(config()).fetchUnseen('INBOX');

    expect(email.authenticationResults).toEqual(['i=1; mx.kpnmail.nl; arc=none']);
  });
});

describe('createImapFlowClient size cap', () => {
  it('skips an oversized message without downloading it, and marks it seen', async () => {
    const logger = fakeLogger();
    h.client.search.mockResolvedValue([8]);
    h.client.fetchOne.mockImplementation(
      async (_uid: number, query: { size?: boolean; source?: boolean }) =>
        query.size ? { size: 11 * 1024 * 1024 } : { source: Buffer.from('raw') },
    );

    const emails = await createImapFlowClient(
      config(),
      logger as unknown as pino.Logger,
    ).fetchUnseen('INBOX');

    expect(emails).toEqual([]);
    const sourceFetches = h.client.fetchOne.mock.calls.filter(
      (c) => (c[1] as { source?: boolean }).source,
    );
    expect(sourceFetches).toHaveLength(0);
    expect(h.client.messageFlagsAdd).toHaveBeenCalledWith(8, ['\\Seen'], { uid: true });
    expect(logger.warn).toHaveBeenCalledWith(
      { uid: 8, size: 11 * 1024 * 1024 },
      'imap message exceeds size limit, skipping',
    );
  });

  it('downloads a message at or under the limit', async () => {
    h.client.search.mockResolvedValue([8]);
    h.client.fetchOne.mockImplementation(async (_uid: number, query: { size?: boolean }) =>
      query.size ? { size: 1024 } : { source: Buffer.from('raw') },
    );

    const emails = await createImapFlowClient(config()).fetchUnseen('INBOX');

    expect(emails).toHaveLength(1);
  });
});

describe('createImapFlowClient parse failures', () => {
  it('skips a message that fails to parse without marking it seen', async () => {
    const logger = fakeLogger();
    h.client.search.mockResolvedValue([1, 2, 3]);
    // Message 2 has a body that the parser rejects.
    h.client.fetchOne.mockImplementation(async (uid: number) => ({
      source: Buffer.from(uid === 2 ? 'broken' : 'raw'),
    }));
    h.simpleParser.mockImplementation(async (source: Buffer) => {
      if (source.toString() === 'broken') throw new Error('bad MIME');
      return parsedMail();
    });

    const emails = await createImapFlowClient(
      config(),
      logger as unknown as pino.Logger,
    ).fetchUnseen('INBOX');

    expect(emails).toHaveLength(2);
    const seenUids = h.client.messageFlagsAdd.mock.calls.map((c) => c[0]);
    expect(seenUids).toEqual([1, 3]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 2 }),
      'failed to parse imap message, skipping',
    );
  });

  it('marks a message seen only after it has been parsed', async () => {
    h.client.search.mockResolvedValue([7]);
    const order: string[] = [];
    h.simpleParser.mockImplementation(async () => {
      order.push('parse');
      return parsedMail();
    });
    h.client.messageFlagsAdd.mockImplementation(async () => {
      order.push('seen');
      return true;
    });

    await createImapFlowClient(config()).fetchUnseen('INBOX');

    expect(order).toEqual(['parse', 'seen']);
  });
});

describe('createImapFlowClient error handling', () => {
  it('releases the lock and logs out when search fails, and rethrows', async () => {
    h.client.search.mockRejectedValue(new Error('search failed'));

    await expect(createImapFlowClient(config()).fetchUnseen('INBOX')).rejects.toThrow(
      'search failed',
    );

    expect(h.lock.release).toHaveBeenCalledTimes(1);
    expect(h.client.logout).toHaveBeenCalledTimes(1);
  });

  it('throws when connect fails and still attempts logout', async () => {
    h.client.connect.mockRejectedValue(new Error('auth failed'));

    await expect(createImapFlowClient(config()).fetchUnseen('INBOX')).rejects.toThrow(
      'auth failed',
    );

    expect(h.client.getMailboxLock).not.toHaveBeenCalled();
    expect(h.client.logout).toHaveBeenCalledTimes(1);
  });

  it('throws when the mailbox lock cannot be acquired', async () => {
    h.client.getMailboxLock.mockRejectedValue(new Error('no such mailbox'));

    await expect(createImapFlowClient(config()).fetchUnseen('NOPE')).rejects.toThrow(
      'no such mailbox',
    );

    expect(h.lock.release).not.toHaveBeenCalled();
    expect(h.client.logout).toHaveBeenCalledTimes(1);
  });

  it('falls back to close() when logout() throws', async () => {
    h.client.search.mockResolvedValue([]);
    h.client.logout.mockRejectedValue(new Error('logout failed'));

    await createImapFlowClient(config()).fetchUnseen('INBOX');

    expect(h.client.close).toHaveBeenCalledTimes(1);
  });
});
