/**
 * Email image attachment ingestion (TASK-009).
 *
 * Turns one already-authorized email's parsed ordinary image attachments into
 * inbound Attachment outcomes (payload or closed rejection) on the shared
 * TASK-004 selection port (`selectImages`) for exclusion/slot/vocabulary
 * decisions. This module performs NO authorization: the connector runs the
 * sender allowlist and DMARC checks BEFORE it plans or resolves media, so a
 * denied or DMARC-failed email stages no image bytes and emits no event.
 *
 * Email differs from the Telegram/WhatsApp mappers in ONE respect: the bytes
 * are ALREADY in hand. The IMAP client fetches the whole message within the
 * existing 10 MiB cap and mailparser decodes every attachment into a Buffer
 * BEFORE the connector sees anything, so there is nothing to download and the
 * TASK-004 fetch budget never applies — the shared port's in-hand-payload path
 * is used instead ("a candidate with a payload is staged, never fetched").
 * Selection still measures the ACTUAL Buffer length, so an oversized
 * attachment is rejected with the closed `size_limit` reason before its bytes
 * can be handed to the pipeline.
 *
 * Classification follows the ACTUAL MailParser 3.9.37 attachment shape
 * (contract inventory E5):
 *
 * - `contentDisposition === 'inline'` OR `related === true` (a CID part under
 *   a `multipart/related` ancestor) → flagged `inlineRelated` and silently
 *   excluded BEFORE slots — inline photos included, no slot, no Image.
 * - A Content-ID header ALONE does not exclude: an ordinary attachment with
 *   `Content-ID` but `attachment` disposition outside `multipart/related`
 *   carries `contentId`/`cid` and NO `related` flag in the actual parser
 *   output, and follows the normal document classification. Disposition and
 *   the related flag decide, not the mere presence of a content ID. The
 *   forwarded {@link EmailAttachment} shape does not carry a content ID at
 *   all — downstream classification is provably blind to it.
 * - Absent or non-image declared MIME (`contentType`) is silently excluded
 *   before slots; an unsupported IMAGE MIME (HEIC, SVG, …) consumes its slot
 *   and is rejected post-slot as `unsupported_mime` without staging.
 *
 * Hygiene: outputs carry only sanitized declared metadata (the shared
 * sanitizer runs inside `selectImages`), the actual byte length, and the
 * in-hand payload. Attachment buffers are handed to the event exactly as
 * parsed; nothing is logged, and no raw MIME source is retained here.
 */

import {
  selectImages,
  type ImageMediaCandidate,
  type ImageSelectionResult,
  type ImageSelectionSettings,
  type SelectedImage,
} from '../../../images/image-selection.js';
import type { InboundAttachment, InboundAttachmentRejection } from '../../channel-types.js';
import type { ImageRejectionReason } from '../../../images/image-types.js';
import type { EmailAttachment } from './email-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fallback selection settings, mirroring the `images` config block defaults
 * (`images.maxInputBytes` / `images.maxPerMessage` in config-schema.ts). The
 * channel factory injects the operator's validated settings; these apply only
 * when a connector is constructed without them.
 *
 * There is deliberately NO additional channel-specific byte cap: the whole
 * email (body + every attachment) was already bounded by the IMAP client's
 * 10 MiB fetch cap before parsing, and `selectImages` enforces the ACTUAL
 * Buffer length against `maxInputBytes` before any staging happens.
 */
export const DEFAULT_EMAIL_IMAGE_SETTINGS: ImageSelectionSettings = Object.freeze({
  maxInputBytes: 10_485_760,
  maxPerMessage: 5,
});

// ---------------------------------------------------------------------------
// Classification (pure — mirrors the actual mailparser E5 shape)
// ---------------------------------------------------------------------------

/**
 * True when the parsed part is inline or related CID content per the ACTUAL
 * mailparser fields: normalized `contentDisposition === 'inline'` or
 * `related === true`. Content-ID presence is irrelevant here on purpose —
 * mailparser sets `related` only for CID parts under a `multipart/related`
 * ancestor, and that flag (or the inline disposition) is what excludes the
 * part; a normal `attachment`-disposition part with a Content-ID stays
 * eligible.
 */
export function isInlineOrRelatedEmailAttachment(attachment: EmailAttachment): boolean {
  // Webhook entries are operator-controlled: a non-string disposition is
  // treated as absent (never inline) instead of throwing on `.trim()`.
  const rawDisposition = attachment.contentDisposition;
  const disposition =
    typeof rawDisposition === 'string' ? rawDisposition.trim().toLowerCase() : undefined;
  return disposition === 'inline' || attachment.related === true;
}

// ---------------------------------------------------------------------------
// Planning (pure — no bytes leave the parsed message here)
// ---------------------------------------------------------------------------

/** Sanitized selection metadata subset every outcome arm carries. */
type EntryMetadata = Pick<
  SelectedImage,
  'slot' | 'sourcePosition' | 'filename' | 'mimeType' | 'declaredSize'
>;

/** One delivered attachment: its selectImages candidate plus its in-hand bytes. */
export interface EmailMediaItem {
  candidate: ImageMediaCandidate;
  /** Decoded attachment bytes (in hand from the parse; never fetched). */
  content: Buffer;
}

/** A message's media plan, computed WITHOUT staging anything. */
export interface EmailMediaPlan {
  items: EmailMediaItem[];
  selection: ImageSelectionResult;
}

/**
 * Build the media plan for one email's parsed attachments, in MIME source
 * order. Every forwarded attachment becomes a `document`-origin candidate:
 * eligibility comes from the declared `contentType` only (a filename never
 * establishes MIME), inline/related parts are flagged for pre-slot exclusion,
 * and the decoded Buffer travels as the in-hand `payload` so selection can
 * reject oversized bytes on their ACTUAL length before staging.
 *
 * Planning is pure and stages nothing; it may run for any message. Only the
 * connector — after authorization — calls {@link stageEmailMedia}, so denied
 * mail never resolves a payload.
 *
 * Boundary note: `ParsedEmail` can also arrive through `feedInbound()` from an
 * external webhook, whose `attachments` are operator-controlled. `null`,
 * non-object, or non-Buffer-content entries are skipped (not staged, never
 * throwing) and malformed `size` values degrade to an unknown declared size;
 * the ACTUAL Buffer length still bounds staging.
 */
export function planEmailMedia(
  attachments: readonly EmailAttachment[] | undefined,
  settings: ImageSelectionSettings,
): EmailMediaPlan {
  const items: EmailMediaItem[] = [];
  for (const attachment of attachments ?? []) {
    if (
      attachment === null ||
      typeof attachment !== 'object' ||
      !Buffer.isBuffer(attachment.content)
    ) {
      // Malformed webhook entry (null, non-object, or non-Buffer bytes):
      // nothing to stage, nothing to plan.
      continue;
    }
    const declaredSize = usableSize(attachment.size);
    items.push({
      content: attachment.content,
      candidate: {
        origin: 'document',
        ...(attachment.contentType !== undefined ? { mimeType: attachment.contentType } : {}),
        ...(attachment.filename !== undefined ? { filename: attachment.filename } : {}),
        ...(declaredSize !== undefined ? { declaredSize } : {}),
        inlineRelated: isInlineOrRelatedEmailAttachment(attachment),
        payload: attachment.content,
      },
    });
  }

  return {
    items,
    selection: selectImages(
      items.map((item) => item.candidate),
      settings,
    ),
  };
}

/**
 * True when the plan has at least one slot-consuming item (selected or
 * closed-rejected). The connector attaches resolved media only when this
 * holds: a message whose attachments are entirely EXCLUDED (inline photos,
 * non-image documents) carries no `attachments` field, matching the
 * pre-media event shape for its body text.
 */
export function planHasImageSlots(plan: EmailMediaPlan): boolean {
  return plan.selection.images.length > 0;
}

// ---------------------------------------------------------------------------
// Staging (runs ONLY after sender + DMARC authorization passed)
// ---------------------------------------------------------------------------

/**
 * Resolve every slot-holding item of an already-planned, already-authorized
 * message into inbound Attachments in source order: a payload `Attachment`
 * for each selected item (bytes already in hand), or a metadata-only
 * {@link InboundAttachmentRejection} carrying exactly one closed reason.
 * Items excluded before slots (inline/related parts, absent/non-image MIME)
 * produce NO attachment.
 *
 * No download and no fetch budget: the payload path of the shared port means
 * "staged, never fetched". Oversized payloads were already rejected on their
 * actual length by `selectImages`, so nothing oversized reaches this point as
 * selected.
 */
export function stageEmailMedia(plan: EmailMediaPlan): InboundAttachment[] {
  const attachments: InboundAttachment[] = [];
  for (const entry of plan.selection.images) {
    const item = plan.items[entry.sourcePosition];
    if (item === undefined) {
      continue;
    }
    if (entry.disposition === 'rejected') {
      attachments.push(rejection(entry.rejectionReason, entry.sourcePosition, entry));
      continue;
    }
    attachments.push(payload(entry, item.content));
  }
  return attachments;
}

// ---------------------------------------------------------------------------
// Payload metadata hygiene
// ---------------------------------------------------------------------------

/** MIME types accepted by selection, mapped to neutral payload filename hints. */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': 'photo.jpg',
  'image/png': 'photo.png',
  'image/webp': 'photo.webp',
});

/**
 * Payload Attachment: the sanitized declared filename when the sender
 * supplied a usable one, else a neutral MIME-derived hint (`Attachment.filename`
 * is a required string). MIME comes from the declared, normalized, already
 * eligibility-checked value, and `size` is the ACTUAL byte length — never the
 * sender-declared `size` field.
 */
function payload(entry: EntryMetadata, content: Buffer): InboundAttachment {
  const mimeType = entry.mimeType ?? 'application/octet-stream';
  return {
    filename: entry.filename ?? EXTENSION_BY_MIME[mimeType] ?? 'image',
    mimeType,
    data: content,
    size: content.byteLength,
  };
}

/** Build the metadata-only rejection arm (no bytes or credentials). */
function rejection(
  reason: ImageRejectionReason,
  sourcePosition: number,
  metadata: EntryMetadata,
): InboundAttachmentRejection {
  return {
    kind: 'rejected',
    rejectionReason: reason,
    ...(metadata.filename !== undefined ? { filename: metadata.filename } : {}),
    ...(metadata.mimeType !== undefined ? { mimeType: metadata.mimeType } : {}),
    ...(metadata.declaredSize !== undefined ? { size: metadata.declaredSize } : {}),
    sourcePosition,
  };
}

/** Declared size only when usable (finite, non-negative), else undefined. */
function usableSize(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}
