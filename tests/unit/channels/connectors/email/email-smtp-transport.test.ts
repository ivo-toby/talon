/**
 * Unit tests for the nodemailer-backed SMTP transport.
 *
 * nodemailer is mocked; no SMTP connection is made.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { EmailConfig } from '../../../../../src/channels/connectors/email/email-types.js';
import {
  createNodemailerTransport,
  htmlToPlainText,
} from '../../../../../src/channels/connectors/email/email-smtp-transport.js';
import { ChannelError } from '../../../../../src/core/errors/error-types.js';

const h = vi.hoisted(() => ({
  sendMail: vi.fn(),
  createTransport: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: h.createTransport },
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

beforeEach(() => {
  vi.clearAllMocks();
  h.sendMail.mockResolvedValue({ messageId: '<sent@example.com>' });
  h.createTransport.mockReturnValue({ sendMail: h.sendMail });
});

describe('createNodemailerTransport', () => {
  it('creates the nodemailer transport lazily, with STARTTLS settings for port 587', async () => {
    const transport = createNodemailerTransport(config());
    expect(h.createTransport).not.toHaveBeenCalled();

    await transport.send('bot@example.com', {
      to: 'alice@example.com',
      subject: 'Re: x',
      html: '<p>hi</p>',
    });

    expect(h.createTransport).toHaveBeenCalledTimes(1);
    expect(h.createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'bot@example.com', pass: 'smtp-pass' },
    });
  });

  it('uses implicit TLS and does not require STARTTLS when smtpSecure is true', async () => {
    const transport = createNodemailerTransport(config({ smtpPort: 465, smtpSecure: true }));
    await transport.send('bot@example.com', { to: 'alice@example.com', subject: 's', html: 'h' });

    expect(h.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true, requireTLS: false }),
    );
  });

  it('reuses one transporter across sends', async () => {
    const transport = createNodemailerTransport(config());
    await transport.send('bot@example.com', { to: 'a@example.com', subject: 's', html: 'h' });
    await transport.send('bot@example.com', { to: 'b@example.com', subject: 's', html: 'h' });

    expect(h.createTransport).toHaveBeenCalledTimes(1);
    expect(h.sendMail).toHaveBeenCalledTimes(2);
  });

  it('sends the message with threading headers and a plain-text fallback', async () => {
    const transport = createNodemailerTransport(config());

    const result = await transport.send('bot@example.com', {
      to: 'alice@example.com',
      subject: 'Re: Status',
      html: '<p>Hello <strong>Alice</strong></p>',
      inReplyTo: '<latest@example.com>',
      references: '<root@example.com> <latest@example.com>',
    });

    expect(result.isOk()).toBe(true);
    expect(h.sendMail).toHaveBeenCalledWith({
      from: 'bot@example.com',
      to: 'alice@example.com',
      subject: 'Re: Status',
      html: '<p>Hello <strong>Alice</strong></p>',
      text: 'Hello Alice',
      inReplyTo: '<latest@example.com>',
      references: '<root@example.com> <latest@example.com>',
    });
  });

  it('returns Err(ChannelError) with the original error as cause when sending fails', async () => {
    const original = new Error('535 authentication failed');
    h.sendMail.mockRejectedValue(original);
    const transport = createNodemailerTransport(config());

    const result = await transport.send('bot@example.com', {
      to: 'a@example.com',
      subject: 's',
      html: 'h',
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(ChannelError);
    expect(error.message).toContain('authentication failed');
    expect(error.cause).toBe(original);
  });
});

describe('htmlToPlainText', () => {
  it('strips tags and decodes common entities', () => {
    expect(htmlToPlainText('<p>a &amp; b &lt;c&gt;</p>')).toBe('a & b <c>');
  });

  it('turns block and line-break tags into newlines', () => {
    expect(htmlToPlainText('<p>one</p><p>two<br>three</p>')).toBe('one\ntwo\nthree');
  });

  it('removes style and script contents', () => {
    expect(htmlToPlainText('<style>p{color:red}</style><script>x()</script>ok')).toBe('ok');
  });
});
