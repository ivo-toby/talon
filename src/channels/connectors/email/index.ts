/**
 * Email channel connector — public API.
 *
 * Implements the Channel interface for email via SMTP (outbound) and
 * IMAP polling (inbound). Supports both polling-based and webhook-based
 * inbound patterns.
 *
 * Handles MIME thread tracking via In-Reply-To / References headers,
 * Markdown-to-HTML conversion for rich email sends, and idempotency
 * via Message-ID deduplication.
 */

export { EmailConnector, encodeThreadId, decodeThreadId, extractAddress } from './email-connector.js';
export { markdownToHtml, htmlEscape } from './email-format.js';
export type {
  EmailConfig,
  EmailAttachment,
  ParsedEmail,
  SmtpSendOptions,
  SmtpSendResult,
  ImapFetchResult,
} from './email-types.js';
export type {
  SmtpTransport,
  ImapClient,
  EmailConnectorOptions,
} from './email-connector.js';
export {
  DEFAULT_EMAIL_IMAGE_SETTINGS,
  isInlineOrRelatedEmailAttachment,
  planEmailMedia,
  planHasImageSlots,
  stageEmailMedia,
} from './email-media.js';
export type { EmailMediaItem, EmailMediaPlan } from './email-media.js';
