/**
 * Production SMTP transport for the email connector, built on nodemailer.
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { ok, err, type Result } from '../../../core/types/result.js';
import { ChannelError } from '../../../core/errors/error-types.js';
import type { EmailConfig, SmtpSendOptions, SmtpTransport } from './email-types.js';

/**
 * Derive a plain-text alternative from HTML by stripping tags and collapsing
 * whitespace. Intentionally simple: it is only a fallback for clients that do
 * not render HTML.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Create an SMTP transport backed by a lazily created nodemailer transporter.
 *
 * @param config - Email configuration (SMTP section is used).
 * @returns An SmtpTransport that sends via the configured SMTP server.
 */
export function createNodemailerTransport(config: EmailConfig): SmtpTransport {
  let transporter: Transporter | undefined;
  const getTransporter = (): Transporter => {
    transporter ??= nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      requireTLS: !config.smtpSecure,
      auth: { user: config.smtpUser, pass: config.smtpPass },
    });
    return transporter;
  };

  return {
    async send(from: string, options: SmtpSendOptions): Promise<Result<void, ChannelError>> {
      try {
        await getTransporter().sendMail({
          from,
          to: options.to,
          subject: options.subject,
          html: options.html,
          text: htmlToPlainText(options.html),
          inReplyTo: options.inReplyTo,
          references: options.references,
        });
        return ok(undefined);
      } catch (sendErr) {
        const cause = sendErr instanceof Error ? sendErr : undefined;
        return err(new ChannelError(`SMTP send failed: ${String(sendErr)}`, cause));
      }
    },
  };
}
