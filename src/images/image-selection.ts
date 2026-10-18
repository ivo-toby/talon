/**
 * Shared image selection contract for the scoped connectors (TASK-004).
 *
 * Selection is a pure decision over a message's delivered media, in source
 * order, and it **never downloads anything**. Connectors hand in the media
 * items they received (channel photo/image items, document or email parts,
 * plus legacy in-hand Buffer/path payloads) and receive, per delivered item,
 * either a source-order upload slot or a closed metadata-only rejection from
 * the Image rejection vocabulary (`IMAGE_REJECTION_REASONS`).
 *
 * The decision is strictly three-phase (spec: "Exclusions and slot selection
 * precede supported-format, size, animation, and conversion checks"):
 *
 * 1. **Exclusion (before slots, never downloaded).** Silently dropped — no
 *    Image, no slot, no user-visible notice:
 *    - platform stickers, including static WebP stickers
 *    - email parts marked inline or classified as related CID content
 *    - another size/thumbnail rendition of the same photo
 *    - document/email parts with absent or non-image MIME.
 *    MIME is matched case-insensitively **without parameters** (`;param`
 *    suffixes are stripped). A filename never establishes MIME.
 * 2. **Slot assignment, in source order.** Every remaining item consumes the
 *    next upload slot. Items beyond `maxPerMessage` overflow as
 *    `Rejected/count_limit` without any download. A slotted item that later
 *    fails a post-slot check keeps its slot — a failed slot is never
 *    backfilled by a later candidate.
 * 3. **Post-slot checks.** Only after a slot is assigned: supported MIME
 *    (JPEG/PNG/WebP; any other image MIME such as HEIC or SVG is
 *    `Rejected/unsupported_mime`) and declared/actual size
 *    (`Rejected/size_limit`). In-hand Buffer payloads are measured on their
 *    actual byte length, so an oversized email attachment is rejected here —
 *    before any staging write can happen.
 *
 * Animation detection (APNG / animated WebP) needs decoded bytes and belongs
 * to the normalizer; selection reasons only about declared MIME, flags, and
 * sizes. No sharp invocation and no filesystem access happen in this module.
 */

import type { ImageRejectionReason } from './image-types.js';

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/** Image MIME types Talon accepts as input; any other image MIME is rejected. */
export const SUPPORTED_IMAGE_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
] as const);

const SUPPORTED_MIME_SET: ReadonlySet<string> = new Set<string>(SUPPORTED_IMAGE_MIME_TYPES);

/**
 * Why a delivered item is silently excluded before slot assignment. This is a
 * selection-local diagnostic vocabulary, NOT the durable Image rejection
 * vocabulary: excluded items create no Image and never reach durable output.
 */
export const MEDIA_EXCLUSION_REASONS = Object.freeze([
  /** Document/email part with absent MIME or a MIME outside `image/*`. */
  'non_image_mime',
  /** Email part marked inline or classified as related CID content. */
  'inline_related',
  /** Platform sticker, including a static WebP sticker. */
  'sticker',
  /** Another size/thumbnail rendition of a photo already represented. */
  'duplicate_photo',
] as const);

export type MediaExclusionReason = (typeof MEDIA_EXCLUSION_REASONS)[number];

/**
 * How the channel delivered the item:
 * - `photo`: a channel photo/image message item — image content by channel
 *   declaration, eligible even when it declares no MIME.
 * - `document`: a document or email part — eligible only when its declared
 *   MIME is `image/*`; a filename never establishes MIME.
 */
export type MediaOrigin = 'photo' | 'document';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * One delivered media item. The input array order IS source order; each
 * candidate's index is echoed back as `sourcePosition` so connectors can build
 * source-ordered inbound attachments without re-deriving positions.
 */
export interface ImageMediaCandidate {
  origin: MediaOrigin;
  /**
   * Declared MIME exactly as delivered (parameters and case included). It is
   * normalized — lowercased, `;param` stripped — before any matching.
   */
  mimeType?: string;
  /** Declared filename. Metadata only: never a path, never establishes MIME. */
  filename?: string;
  /**
   * Declared size in bytes when the channel supplied one. Untrusted metadata:
   * non-finite or negative values are treated as unknown.
   */
  declaredSize?: number;
  /** Platform sticker (including a static WebP sticker). Excluded before slots. */
  sticker?: boolean;
  /** Email part marked inline or classified as related CID content. Excluded before slots. */
  inlineRelated?: boolean;
  /** Another size/thumbnail rendition of the same photo. Excluded before slots. */
  duplicatePhotoRepresentation?: boolean;
  /**
   * Legacy inbound payload already in hand: a raw Buffer (for example an
   * authorized email attachment) or an owned filesystem path. A candidate with
   * a payload is staged, never downloaded. Buffer payloads are checked against
   * the byte limit on their actual length and rejected before staging.
   */
  payload?: Buffer | string;
}

/**
 * Image settings selection needs (from the `images` config block). Expected to
 * be the config-validated positive integers.
 */
export interface ImageSelectionSettings {
  /** Maximum input bytes per Image (`images.maxInputBytes`). */
  maxInputBytes: number;
  /** Upload slots per message (`images.maxPerMessage`). */
  maxPerMessage: number;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Sanitized declared metadata carried by every selection outcome. */
interface SelectionMetadata {
  /** Normalized MIME (lowercased, parameters stripped), when declared. */
  mimeType?: string;
  /** Sanitized declared filename, when the channel supplied a usable one. */
  filename?: string;
  /** Declared size in bytes, when the channel supplied a usable one. */
  declaredSize?: number;
}

/** An accepted image: it holds an upload slot and needs a fetch, or carries a legacy payload. */
export interface SelectedImage extends SelectionMetadata {
  disposition: 'selected';
  /** Zero-based position of the delivered item in the input (source order). */
  sourcePosition: number;
  /** Zero-based upload slot consumed within the message. */
  slot: number;
  origin: MediaOrigin;
  /** Actual byte length for an in-hand Buffer payload. */
  measuredSize?: number;
  /** False only when a legacy payload is already in hand — such items are never fetched. */
  requiresFetch: boolean;
  /** The legacy in-hand payload (Buffer or owned path) carried through for staging. */
  payload?: Buffer | string;
}

/**
 * A closed metadata-only rejection: the delivered item produced a Rejected
 * Image with exactly one closed reason. `slot` is the item's unique
 * source-order ordinal across all non-excluded items: post-acceptance
 * rejections (`unsupported_mime`, `size_limit`) consume their slot and are
 * never refilled, while `count_limit` overflow carries the slot index at or
 * beyond `maxPerMessage` and is never fetched. It carries no bytes, paths,
 * staging references, or credentials.
 */
export interface RejectedImageSelection extends SelectionMetadata {
  disposition: 'rejected';
  sourcePosition: number;
  /** Unique message-level slot (ordinal); see the interface docs. */
  slot: number;
  rejectionReason: ImageRejectionReason;
}

export type ImageSelectionEntry = SelectedImage | RejectedImageSelection;

/**
 * A silently excluded delivered item. Diagnostics only: callers create no
 * Image, no notice, and no fetch for these. Exposing them lets connectors log
 * the drop without inventing channel-specific vocabulary.
 */
export interface ExcludedMedia extends SelectionMetadata {
  sourcePosition: number;
  exclusionReason: MediaExclusionReason;
}

/** The selection of one message's delivered media, both lists in source order. */
export interface ImageSelectionResult {
  /** Every slot-holding item (accepted and rejected), in source order. */
  images: ImageSelectionEntry[];
  /** Pre-slot silent exclusions, in source order. No Image is created for these. */
  excluded: ExcludedMedia[];
}

// ---------------------------------------------------------------------------
// MIME / filename hygiene (shared with the transport outputs)
// ---------------------------------------------------------------------------

/**
 * RFC 2045 token shape for a MIME type/subtype: any printable ASCII CHAR
 * excluding CTLs, SP, and the tspecials `()<>@,;:"/[]?=` — backslash IS a
 * tspecial and is rejected; `{` and `}` are legitimate token characters
 * (e.g. `image/x{vendor}`). Anything else (spaces, URLs, control-ish junk)
 * is malformed and NEVER retained into matching or output.
 */
const MIME_TOKEN = /^[a-z0-9!#$%&'*+.^_`|~{}-]+$/;

/**
 * Normalize a declared MIME for matching: case-insensitive, without
 * parameters, and VALIDATED to `token/token` syntax —
 * `IMAGE/JPEG;charset=binary` → `image/jpeg`. An empty or parameter-only
 * value, or any value whose type/subtype is not a well-formed token pair
 * (for example a URL-bearing `image/...`-like string), normalizes to
 * `undefined` (absent MIME) and is never retained.
 */
export function normalizeMimeType(mime: string | undefined): string | undefined {
  if (typeof mime !== 'string') {
    return undefined;
  }
  const base = mime.split(';', 1)[0]?.trim().toLowerCase();
  if (base === undefined || base.length === 0) {
    return undefined;
  }
  const slash = base.indexOf('/');
  if (slash < 1 || slash === base.length - 1) {
    return undefined;
  }
  const type = base.slice(0, slash);
  const subtype = base.slice(slash + 1);
  if (!MIME_TOKEN.test(type) || !MIME_TOKEN.test(subtype)) {
    return undefined;
  }
  return `${type}/${subtype}`;
}

/** True when the normalized MIME is one of the accepted input formats. */
export function isSupportedImageMime(mime: string | undefined): boolean {
  return mime !== undefined && SUPPORTED_MIME_SET.has(mime);
}

/** Maximum characters of a declared filename retained in any output. */
export const MAX_FILENAME_LENGTH = 200;

/**
 * Any `://` marker anywhere in the raw filename. Deliberately NOT anchored
 * on a word boundary: prefixes like `photo_https://…` (underscore or digit
 * glued to the scheme) must still fail closed.
 */
const URL_BEARING = /:\/\//;

/**
 * A credential-looking `name=value` / `name: value` pair (the pair marker is
 * enough — the VALUE shape is deliberately not parsed) or a `bearer` token.
 * Quote shapes and escaped quotes cannot defeat a detector that only needs
 * the key: the whole filename is dropped on ANY hit.
 */
const CREDENTIAL_BEARING =
  /\b(authorization|proxy_authorization|access_token|refresh_token|api_key|apikey|token|signature|sig|expires|expiry|password|passwd|secret|credential)\s*[=:]|\bbearer\s+\S/i;

/**
 * Sanitize a declared filename for durable outputs. FAIL-CLOSED: a filename
 * bearing a URL or a credential-looking pair (any quote shape, escaped
 * quotes included) is OMITTED entirely — normalized to `undefined`, so the
 * metadata field is simply absent — because partial redaction of
 * attacker-shaped quote/escape sequences cannot be trusted to catch every
 * suffix. Otherwise separators, NUL, and control characters are replaced,
 * and the result is trimmed and length-capped. Returns `undefined` for
 * credential/URL-bearing filenames or when nothing usable remains.
 */
export function sanitizeFilename(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (URL_BEARING.test(value) || CREDENTIAL_BEARING.test(value)) {
    return undefined;
  }
  const cleaned = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      // Control characters and path separators never survive as metadata.
      return code < 0x20 || code === 0x7f || character === '/' || character === '\\'
        ? '_'
        : character;
    })
    .join('')
    .trim();
  if (cleaned.length === 0) {
    return undefined;
  }
  return cleaned.length > MAX_FILENAME_LENGTH ? cleaned.slice(0, MAX_FILENAME_LENGTH) : cleaned;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Select the message's image upload slots from its delivered media, in source
 * order. Pure: no downloads, no filesystem access, no side effects.
 *
 * See the module header for the three-phase contract (exclude → slot →
 * post-slot checks). Overflow is `count_limit` without download, and a failed
 * slot never backfills another candidate.
 */
export function selectImages(
  candidates: readonly ImageMediaCandidate[],
  settings: ImageSelectionSettings,
): ImageSelectionResult {
  const images: ImageSelectionEntry[] = [];
  const excluded: ExcludedMedia[] = [];
  let nextSlot = 0;

  candidates.forEach((candidate, sourcePosition) => {
    const mime = normalizeMimeType(candidate.mimeType);
    const metadata = selectionMetadata(candidate, mime);

    // -- Phase 1: exclusion, before slots, never downloaded -----------------
    const exclusion = exclusionReason(candidate, mime);
    if (exclusion !== undefined) {
      excluded.push({ sourcePosition, exclusionReason: exclusion, ...metadata });
      return;
    }

    // Every non-excluded item consumes the next slot index (which doubles as
    // the Image ordinal, so it must stay unique per delivered item).
    const slot = nextSlot;
    nextSlot += 1;

    // -- Phase 2: overflow check, before any download ------------------------
    if (slot >= settings.maxPerMessage) {
      // Overflow: closed rejection, no download. A later candidate never
      // backfills into a full slot set.
      images.push({
        disposition: 'rejected',
        sourcePosition,
        slot,
        rejectionReason: 'count_limit',
        ...metadata,
      });
      return;
    }

    // -- Phase 3: post-slot checks — supported MIME, then declared/actual size
    if (mime !== undefined && !isSupportedImageMime(mime)) {
      images.push({
        disposition: 'rejected',
        sourcePosition,
        slot,
        rejectionReason: 'unsupported_mime',
        ...metadata,
      });
      return;
    }

    const declared = usableDeclaredSize(candidate.declaredSize);
    const measured =
      candidate.payload !== undefined && Buffer.isBuffer(candidate.payload)
        ? candidate.payload.byteLength
        : undefined;
    const oversize =
      (declared !== undefined && declared > settings.maxInputBytes) ||
      (measured !== undefined && measured > settings.maxInputBytes);
    if (oversize) {
      // Declared or actual bytes exceed the per-Image limit. The slot stays
      // consumed and no payload is carried out, so nothing is ever staged.
      images.push({
        disposition: 'rejected',
        sourcePosition,
        slot,
        rejectionReason: 'size_limit',
        ...selectionMetadata(candidate, mime, declared),
      });
      return;
    }

    images.push({
      disposition: 'selected',
      sourcePosition,
      slot,
      origin: candidate.origin,
      ...selectionMetadata(candidate, mime, declared),
      ...(measured !== undefined ? { measuredSize: measured } : {}),
      requiresFetch: candidate.payload === undefined,
      ...(candidate.payload !== undefined ? { payload: candidate.payload } : {}),
    });
  });

  return { images, excluded };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The pre-slot exclusion for a candidate, if any. Flag exclusions (sticker,
 * inline/related, duplicate photo rendition) apply regardless of MIME. A
 * `document` origin additionally requires an `image/*` MIME: absent or
 * non-image MIME is silently excluded, while an unsupported *image* MIME
 * (HEIC, SVG, …) still consumes a slot and is rejected post-slot as
 * `unsupported_mime`.
 */
function exclusionReason(
  candidate: ImageMediaCandidate,
  mime: string | undefined,
): MediaExclusionReason | undefined {
  if (candidate.sticker === true) {
    return 'sticker';
  }
  if (candidate.inlineRelated === true) {
    return 'inline_related';
  }
  if (candidate.duplicatePhotoRepresentation === true) {
    return 'duplicate_photo';
  }
  if (candidate.origin === 'document' && (mime === undefined || !mime.startsWith('image/'))) {
    return 'non_image_mime';
  }
  return undefined;
}

/**
 * Sanitized outcome metadata with undefined keys omitted, so durable outputs
 * never carry explicit `undefined` fields.
 */
function selectionMetadata(
  candidate: ImageMediaCandidate,
  mime: string | undefined,
  declaredSize: number | undefined = usableDeclaredSize(candidate.declaredSize),
): SelectionMetadata {
  const filename = sanitizeFilename(candidate.filename);
  return {
    ...(mime !== undefined ? { mimeType: mime } : {}),
    ...(filename !== undefined ? { filename } : {}),
    ...(declaredSize !== undefined ? { declaredSize } : {}),
  };
}

/** Declared size only when it is a usable (finite, non-negative) number. */
function usableDeclaredSize(declared: number | undefined): number | undefined {
  if (typeof declared !== 'number' || !Number.isFinite(declared) || declared < 0) {
    return undefined;
  }
  return declared;
}
