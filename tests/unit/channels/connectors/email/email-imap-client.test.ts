/**
 * Unit tests for email-imap-client.ts
 *
 * Mocks imapflow and mailparser so no real IMAP connection is made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock imapflow and mailparser before importing the module under test
// ---------------------------------------------------------------------------

const mockSearch = vi.fn();
const mockFetchOne = vi.fn();
const mockMessageFlagsAdd = vi.fn();
const mockGetMailboxLock = vi.fn();
const mockConnect = vi.fn();
const mockLogout = vi.fn();
const mockLockRelease = vi.fn();

// Track ImapFlow constructor calls
const ImapFlowMock = vi.fn().mockImplementation(() => ({
  connect: mockConnect,
  getMailboxLock: mockGetMailboxLock,
  search: mockSearch,
  fetchOne: mockFetchOne,
  messageFlagsAdd: mockMessageFlagsAdd,
  logout: mockLogout,
}));

vi.mock('imapflow', () => ({
  ImapFlow: ImapFlowMock,
}));

const mockSimpleParser = vi.fn();

vi.mock('mailparser', () => ({
  simpleParser: mockSimpleParser,
}));

// Import after mocks
const { createImapFlowClient } = await import(
  '../../../../../src/channels/connectors/email/email-imap-client.js'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig() {
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
  };
}

function makeParsedMail(overrides?: Record<string, unknown>) {
  return {
    messageId: '<msg-001@example.com>',
    from: { text: 'Alice <alice@example.com>' },
    to: { text: 'bot@example.com' },
    subject: 'Hello',
    text: 'Hello bot!',
    date: new Date('2024-01-01T00:00:00Z'),
    inReplyTo: undefined,
    references: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createImapFlowClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: lock resolves with a release function
    mockGetMailboxLock.mockResolvedValue({ release: mockLockRelease });
    mockConnect.mockResolvedValue(undefined);
    mockLogout.mockResolvedValue(undefined);
    mockMessageFlagsAdd.mockResolvedValue(undefined);
  });

  it('constructs ImapFlow with correct IMAP config', async () => {
    mockSearch.mockResolvedValue([]);

    const config = makeConfig();
    const client = createImapFlowClient(config);
    await client.fetchUnseen('INBOX');

    expect(ImapFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: config.imapHost,
        port: config.imapPort,
        secure: config.imapSecure,
        auth: {
          user: config.imapUser,
          pass: config.imapPass,
        },
        logger: false,
      }),
    );
  });

  it('returns empty array when no unseen messages', async () => {
    mockSearch.mockResolvedValue([]);

    const client = createImapFlowClient(makeConfig());
    const result = await client.fetchUnseen('INBOX');

    expect(result).toEqual([]);
  });

  it('returns parsed emails for unseen messages', async () => {
    const uid = 42;
    mockSearch.mockResolvedValue([uid]);
    mockFetchOne.mockResolvedValue({ source: Buffer.from('raw mime source') });
    mockSimpleParser.mockResolvedValue(makeParsedMail());

    const client = createImapFlowClient(makeConfig());
    const result = await client.fetchUnseen('INBOX');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      messageId: '<msg-001@example.com>',
      from: 'Alice <alice@example.com>',
      to: 'bot@example.com',
      subject: 'Hello',
      text: 'Hello bot!',
      timestamp: new Date('2024-01-01T00:00:00Z').getTime(),
    });
  });

  it('marks messages as seen after fetching', async () => {
    const uid = 42;
    mockSearch.mockResolvedValue([uid]);
    mockFetchOne.mockResolvedValue({ source: Buffer.from('raw mime') });
    mockSimpleParser.mockResolvedValue(makeParsedMail());

    const client = createImapFlowClient(makeConfig());
    await client.fetchUnseen('INBOX');

    expect(mockMessageFlagsAdd).toHaveBeenCalledWith(
      String(uid),
      ['\\Seen'],
      { uid: true },
    );
  });

  it('handles parse errors gracefully — logs, skips, and marks seen', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockSearch.mockResolvedValue([1, 2]);
    mockFetchOne
      .mockResolvedValueOnce({ source: Buffer.from('good message') })
      .mockResolvedValueOnce({ source: Buffer.from('bad message') });
    mockSimpleParser
      .mockResolvedValueOnce(makeParsedMail({ messageId: '<msg-1@example.com>' }))
      .mockRejectedValueOnce(new Error('Parse failure'));

    const client = createImapFlowClient(makeConfig());
    const result = await client.fetchUnseen('INBOX');

    // Only the successfully parsed message should be returned
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('<msg-1@example.com>');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to parse message'),
      expect.any(Error),
    );
    // The failing message should also be marked as seen to avoid re-fetch loop
    expect(mockMessageFlagsAdd).toHaveBeenCalledTimes(2); // once for good, once for bad

    consoleErrorSpy.mockRestore();
  });

  it('handles false returned by search (empty mailbox edge case)', async () => {
    // imapflow can return false when no messages match
    mockSearch.mockResolvedValue(false);

    const client = createImapFlowClient(makeConfig());
    const result = await client.fetchUnseen('INBOX');

    expect(result).toEqual([]);
    expect(mockFetchOne).not.toHaveBeenCalled();
  });

  it('handles false returned by fetchOne (message disappeared)', async () => {
    mockSearch.mockResolvedValue([99]);
    mockFetchOne.mockResolvedValue(false);

    const client = createImapFlowClient(makeConfig());
    const result = await client.fetchUnseen('INBOX');

    expect(result).toEqual([]);
    // Should mark as seen to avoid re-fetching
    expect(mockMessageFlagsAdd).toHaveBeenCalledWith('99', ['\\Seen'], { uid: true });
  });

  it('releases the mailbox lock in a finally block', async () => {
    mockSearch.mockResolvedValue([]);

    const client = createImapFlowClient(makeConfig());
    await client.fetchUnseen('INBOX');

    expect(mockLockRelease).toHaveBeenCalled();
  });

  it('releases lock and calls logout even when an error occurs during fetch', async () => {
    mockSearch.mockRejectedValue(new Error('IMAP search failed'));

    const client = createImapFlowClient(makeConfig());

    await expect(client.fetchUnseen('INBOX')).rejects.toThrow('IMAP search failed');

    expect(mockLockRelease).toHaveBeenCalled();
    expect(mockLogout).toHaveBeenCalled();
  });

  it('wraps message IDs without angle brackets', async () => {
    mockSearch.mockResolvedValue([1]);
    mockFetchOne.mockResolvedValue({ source: Buffer.from('raw') });
    mockSimpleParser.mockResolvedValue(
      makeParsedMail({ messageId: 'no-brackets@example.com' }),
    );

    const client = createImapFlowClient(makeConfig());
    const result = await client.fetchUnseen('INBOX');

    expect(result[0].messageId).toBe('<no-brackets@example.com>');
  });

  it('uses current date when mail.date is missing', async () => {
    const before = Date.now();
    mockSearch.mockResolvedValue([1]);
    mockFetchOne.mockResolvedValue({ source: Buffer.from('raw') });
    mockSimpleParser.mockResolvedValue(makeParsedMail({ date: undefined }));

    const client = createImapFlowClient(makeConfig());
    const result = await client.fetchUnseen('INBOX');
    const after = Date.now();

    expect(result[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(result[0].timestamp).toBeLessThanOrEqual(after);
  });

  it('skips messages with no source', async () => {
    mockSearch.mockResolvedValue([1]);
    mockFetchOne.mockResolvedValue({ source: null });

    const client = createImapFlowClient(makeConfig());
    const result = await client.fetchUnseen('INBOX');

    expect(result).toHaveLength(0);
    expect(mockSimpleParser).not.toHaveBeenCalled();
  });

  it('fetches from the specified mailbox', async () => {
    mockSearch.mockResolvedValue([]);

    const client = createImapFlowClient(makeConfig());
    await client.fetchUnseen('Sent');

    expect(mockGetMailboxLock).toHaveBeenCalledWith('Sent');
  });

  it('passes inReplyTo and references (string) when present', async () => {
    mockSearch.mockResolvedValue([1]);
    mockFetchOne.mockResolvedValue({ source: Buffer.from('raw') });
    mockSimpleParser.mockResolvedValue(
      makeParsedMail({
        inReplyTo: '<parent@example.com>',
        references: '<root@example.com> <parent@example.com>',
      }),
    );

    const client = createImapFlowClient(makeConfig());
    const result = await client.fetchUnseen('INBOX');

    expect(result[0].inReplyTo).toBe('<parent@example.com>');
    expect(result[0].references).toBe('<root@example.com> <parent@example.com>');
  });

  it('normalises references string[] to space-separated string', async () => {
    mockSearch.mockResolvedValue([1]);
    mockFetchOne.mockResolvedValue({ source: Buffer.from('raw') });
    mockSimpleParser.mockResolvedValue(
      makeParsedMail({
        references: ['<root@example.com>', '<parent@example.com>'],
      }),
    );

    const client = createImapFlowClient(makeConfig());
    const result = await client.fetchUnseen('INBOX');

    expect(result[0].references).toBe('<root@example.com> <parent@example.com>');
  });

  it('calls logout even when connect() throws', async () => {
    mockConnect.mockRejectedValue(new Error('Auth failed'));

    const client = createImapFlowClient(makeConfig());
    await expect(client.fetchUnseen('INBOX')).rejects.toThrow('Auth failed');

    expect(mockLogout).toHaveBeenCalled();
  });
});
