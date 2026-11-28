/**
 * Outbound attachment types.
 *
 * An agent asks for an outbound attachment by naming a host file path; the
 * host resolves, validates and reads it (see `outbound-attachment-resolver.ts`)
 * and hands connectors an in-memory {@link OutboundAttachment}. The agent
 * never passes bytes or base64, and no full host path leaves this module in a
 * tool result or log line (see `docs/adr/0003-outbound-attachments.md`).
 */

/**
 * Closed vocabulary of reasons an outbound attachment request is refused.
 * Every refusal happens before any provider call, so a refused request never
 * sends anything — not even the text.
 */
export const OUTBOUND_ATTACHMENT_ERROR_CODES = [
  /** The persona lacks the `channel.attach` capability. */
  'capability_denied',
  /** No `attachments.outbound.allowedRoots` are configured. */
  'attachments_disabled',
  /** The target connector does not declare outbound attachment support. */
  'channel_unsupported',
  /** More items than `maxPerMessage` (or the connector's own cap). */
  'too_many_files',
  /** The item is malformed (missing or non-string path, bad field types). */
  'invalid_request',
  /** The path is not absolute. */
  'path_not_absolute',
  /** The path, after `..` normalization, lies outside every allowed root. */
  'outside_allowed_roots',
  /** The path lies inside a root lexically, but a symlink resolves outside it. */
  'symlink_escape',
  /** The resolved path matches the built-in or configured denylist. */
  'denied_path',
  /** Nothing exists at the path (or it cannot be resolved). */
  'not_found',
  /** The path is a directory. */
  'is_directory',
  /** The path is a socket, FIFO, device or other non-regular file. */
  'special_file',
  /** The file is empty. */
  'empty_file',
  /** The file exceeds the global or the connector's size cap. */
  'too_large',
  /** The sniffed MIME type is not in `allowedMimeTypes`. */
  'mime_not_allowed',
  /** The file changed or could not be read while it was being opened. */
  'read_failed',
] as const;

export type OutboundAttachmentErrorCode = (typeof OUTBOUND_ATTACHMENT_ERROR_CODES)[number];

/** One attachment as the agent asks for it (tool input). */
export interface OutboundAttachmentRequest {
  /** Absolute host path of the file. */
  path: string;
  /** Human-visible filename; sanitized. Defaults to the file's basename. */
  filename?: string;
  /**
   * Declared MIME type. Only used to choose between text subtypes when the
   * content sniffs as text; binary content is always typed by its bytes.
   */
  mimeType?: string;
  /** Caption shown with the attachment, where the channel supports one. */
  caption?: string;
}

/** Broad delivery class a connector uses to pick a native message type. */
export type OutboundAttachmentKind = 'image' | 'file';

/**
 * A validated attachment, read into memory and ready for a connector.
 * Carries no host path: connectors only ever see bytes and safe metadata.
 */
export interface OutboundAttachment {
  /** Sanitized, human-visible filename (never a path). */
  filename: string;
  /** Sniffed MIME type. */
  mimeType: string;
  /** `image` for the raster formats channels show inline, otherwise `file`. */
  kind: OutboundAttachmentKind;
  /** File contents. */
  data: Buffer;
  /** Size in bytes (equals `data.length`). */
  size: number;
  /** Hex SHA-256 of `data`. */
  sha256: string;
  /** Optional caption. */
  caption?: string;
}

/** Metadata persisted with the outbound message — never the bytes or the path. */
export interface OutboundAttachmentMetadata {
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
}

/** A refused attachment request, addressed by its position in the request. */
export interface OutboundAttachmentRefusal {
  /** Zero-based index of the item in the request (or -1 for the whole call). */
  index: number;
  code: OutboundAttachmentErrorCode;
  /** Plain-language reason, safe to show the agent: no host paths. */
  message: string;
}

/**
 * What a connector declares about outbound attachments. Absence on a
 * connector means "not supported".
 */
export interface OutboundAttachmentSupport {
  /** Largest single file the connector can deliver, in bytes. */
  maxBytes: number;
  /** Most attachments the connector accepts in one send. */
  maxFiles: number;
}

/** Converts a resolved attachment to its persisted metadata. */
export function toAttachmentMetadata(attachment: OutboundAttachment): OutboundAttachmentMetadata {
  return {
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    sha256: attachment.sha256,
  };
}
