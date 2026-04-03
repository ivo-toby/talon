/**
 * Nodemailer-based SMTP transport for the email channel connector.
 *
 * Implements the SmtpTransport interface defined in email-connector.ts using
 * the nodemailer library for real email delivery.
 */

import nodemailer from 'nodemailer';
import type { SmtpTransport } from './email-connector.js';
import type { EmailConfig, SmtpSendOptions } from './email-types.js';
import type { Result } from '../../../core/types/result.js';
import { ok, err } from '../../../core/types/result.js';
import { ChannelError } from '../../../core/errors/error-types.js';

/**
 * Create a nodemailer-based SMTP transport.
 *
 * @param config - Email configuration containing SMTP credentials and settings.
 * @returns A SmtpTransport instance backed by nodemailer.
 */
export function createNodemailerSmtpTransport(config: EmailConfig): SmtpTransport {
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  });

  return {
    async send(from: string, options: SmtpSendOptions): Promise<Result<void, ChannelError>> {
      try {
        await transporter.sendMail({
          from,
          to: options.to,
          subject: options.subject,
          html: options.html,
          ...(options.inReplyTo !== undefined ? { inReplyTo: options.inReplyTo } : {}),
          ...(options.references !== undefined ? { references: options.references } : {}),
        });
        return ok(undefined);
      } catch (smtpErr) {
        const cause = smtpErr instanceof Error ? smtpErr : undefined;
        return err(
          new ChannelError(
            `EmailConnector: SMTP send failed: ${String(smtpErr)}`,
            cause,
          ),
        );
      }
    },
  };
}
