/**
 * Unit tests for email-smtp-transport.ts
 *
 * Mocks nodemailer so no real SMTP connection is made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelError } from '../../../../../src/core/errors/error-types.js';

// ---------------------------------------------------------------------------
// Mock nodemailer before importing the module under test
// ---------------------------------------------------------------------------

const mockSendMail = vi.fn();
const mockCreateTransport = vi.fn(() => ({ sendMail: mockSendMail }));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
}));

// Import after mock is set up
const { createNodemailerSmtpTransport } = await import(
  '../../../../../src/channels/connectors/email/email-smtp-transport.js'
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createNodemailerSmtpTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls createTransport with correct SMTP config', () => {
    const config = makeConfig();
    createNodemailerSmtpTransport(config);

    expect(mockCreateTransport).toHaveBeenCalledWith({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: {
        user: config.smtpUser,
        pass: config.smtpPass,
      },
    });
  });

  it('returns ok(undefined) on successful send', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<test@example.com>' });

    const transport = createNodemailerSmtpTransport(makeConfig());
    const result = await transport.send('bot@example.com', {
      to: 'alice@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBeUndefined();
    }
  });

  it('passes correct fields to sendMail', async () => {
    mockSendMail.mockResolvedValue({});

    const transport = createNodemailerSmtpTransport(makeConfig());
    await transport.send('bot@example.com', {
      to: 'alice@example.com',
      subject: 'Re: Hello',
      html: '<p>Reply body</p>',
      inReplyTo: '<original@example.com>',
      references: '<original@example.com>',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'bot@example.com',
        to: 'alice@example.com',
        subject: 'Re: Hello',
        html: '<p>Reply body</p>',
        inReplyTo: '<original@example.com>',
        references: '<original@example.com>',
      }),
    );
  });

  it('omits inReplyTo and references when not provided', async () => {
    mockSendMail.mockResolvedValue({});

    const transport = createNodemailerSmtpTransport(makeConfig());
    await transport.send('bot@example.com', {
      to: 'alice@example.com',
      subject: 'New message',
      html: '<p>Body</p>',
    });

    const callArg = mockSendMail.mock.calls[0][0] as Record<string, unknown>;
    expect('inReplyTo' in callArg).toBe(false);
    expect('references' in callArg).toBe(false);
  });

  it('returns err(ChannelError) when sendMail throws', async () => {
    mockSendMail.mockRejectedValue(new Error('Connection refused'));

    const transport = createNodemailerSmtpTransport(makeConfig());
    const result = await transport.send('bot@example.com', {
      to: 'alice@example.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ChannelError);
      expect(result.error.message).toContain('SMTP send failed');
      expect(result.error.message).toContain('Connection refused');
    }
  });

  it('wraps non-Error throws in ChannelError', async () => {
    mockSendMail.mockRejectedValue('string error');

    const transport = createNodemailerSmtpTransport(makeConfig());
    const result = await transport.send('bot@example.com', {
      to: 'alice@example.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ChannelError);
      expect(result.error.message).toContain('string error');
    }
  });
});
