/**
 * Plain-text renderings of outbound attachments: what the human reads when an
 * attachment fails, what the message ledger stores as an attachment
 * message's excerpt, and the bracketed line the persisted outbound message
 * carries so later context shows the agent what it sent. None of these
 * contain bytes or host paths — only sanitized filenames, types and sizes.
 */

import type {
  OutboundAttachment,
  OutboundAttachmentMetadata,
} from './outbound-attachment-types.js';

/** Human-readable size: bytes, KB or MB with one decimal. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The notice the human receives when some attachments could not be sent. */
export function attachmentFailureNotice(filenames: readonly string[]): string {
  if (filenames.length === 1) {
    return `⚠️ An attachment could not be sent: ${filenames[0]}`;
  }
  return `⚠️ ${filenames.length} attachments could not be sent: ${filenames.join(', ')}`;
}

/** Ledger excerpt for a message that carries an attachment. */
export function attachmentLedgerText(
  attachment: Pick<OutboundAttachment, 'filename' | 'caption'>,
): string {
  return attachment.caption !== undefined && attachment.caption !== ''
    ? `[Attachment: ${attachment.filename}] ${attachment.caption}`
    : `[Attachment: ${attachment.filename}]`;
}

/**
 * The persisted body of an outbound message: its text followed by one
 * bracketed line listing what was attached, so the conversation history shows
 * the agent which files it already sent.
 */
export function attachmentSummaryLine(
  body: string,
  attachments: readonly OutboundAttachmentMetadata[],
): string {
  if (attachments.length === 0) return body;
  const list = attachments
    .map((a) => `${a.filename} (${a.mimeType}, ${formatSize(a.size)})`)
    .join(', ');
  const line = `[Attached: ${list}]`;
  return body.trim() === '' ? line : `${body}\n${line}`;
}
