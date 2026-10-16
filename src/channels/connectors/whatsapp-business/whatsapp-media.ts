/**
 * WhatsApp Business (Cloud API) media ingestion (TASK-008).
 *
 * Turns one already-authorized webhook message's delivered media into inbound
 * Attachment outcomes (payload or closed rejection) on the shared TASK-004
 * ports — `selectImages` for exclusion/slot/vocabulary decisions and
 * `fetchImage` for bounded byte downloads.
 *
 * The media contract implemented here is the VERIFIED current contract recorded
 * in
 * `.wdd/epics/image-processing/research/whatsapp-business-verified-contract.md`
 * (which replaces the `NOT READ` state of contract-inventory E3):
 *
 * - **Metadata lookup** `GET https://graph.facebook.com/<API_VERSION>/<MEDIA_ID>`
 *   (plus `phone_number_id`) with `Authorization: Bearer <existing token>`,
 *   returning a DIRECT (unwrapped) JSON envelope
 *   `{ messaging_product, url, mime_type, sha256, file_size, id }`. The returned
 *   media URL is only valid for 5 minutes.
 * - **Byte download** `GET <MEDIA_URL>` with the SAME bearer token re-attached
 *   (Meta: "If you omit your token, the request will fail."), returning RAW
 *   BYTES — not JSON — with a `content-type` response header.
 *
 * The two steps are verified SEPARATELY, in that order: the envelope is checked
 * (`messaging_product`, an `https:` `url`) before any download URL is selected,
 * and the byte response is validated on its own. Because `file_size` and
 * `mime_type` arrive before the download, a confirmed oversized or ineligible
 * asset is rejected with a closed reason WITHOUT transferring a single byte —
 * something the Telegram mapper cannot do (E1/E2 carry no pre-download size for
 * photos).
 *
 * No authorization happens in this module: the connector runs webhook
 * signature validation, payload `object`/`field` checks, and message admission
 * BEFORE calling {@link fetchWhatsAppMedia}, so a denied or ignored message makes
 * zero Graph API requests.
 *
 * Hygiene: a media URL is pre-signed and therefore sensitive. It is transient
 * download material only — never returned in an Attachment, never logged, never
 * persisted. Metadata and open failures surface as fixed-text errors with no
 * token, no URL, and no cause object, so nothing credential-bearing can reach the
 * transport's closed errors, durable results, or logs.
 */

import {
  isSupportedImageMime,
  normalizeMimeType,
  sanitizeFilename,
  selectImages,
  type ImageMediaCandidate,
  type ImageSelectionResult,
  type ImageSelectionSettings,
  type SelectedImage,
} from '../../../images/image-selection.js';
import {
  createMessageFetchBudget,
  fetchImage,
  type MediaStream,
  type MessageFetchBudget,
} from '../../../images/image-transport.js';
import type { InboundAttachment, InboundAttachmentRejection } from '../../channel-types.js';
import type { ImageRejectionReason } from '../../../images/image-types.js';
import type { WhatsAppMediaBody, WhatsAppMessage } from './whatsapp-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fallback selection settings, mirroring the `images` config block defaults
 * (`images.maxInputBytes` / `images.maxPerMessage` in config-schema.ts). The
 * channel factory injects the operator's validated settings; these apply only
 * when a connector is constructed without them.
 *
 * There is deliberately NO channel-specific byte cap here. Meta's supported
 * media table lists 5 MB for JPEG/PNG, but that is a supported-type figure, not
 * a documented download ceiling for received media, and inventing a stricter
 * channel limit would be a channel policy change. Sizing uses the shared
 * `images.maxInputBytes`: the verified `file_size` rejects confirmed oversized
 * assets before download, and `fetchImage` enforces ACTUAL bytes while
 * consuming. Both map to the closed `size_limit`.
 */
export const DEFAULT_WHATSAPP_IMAGE_SETTINGS: ImageSelectionSettings = Object.freeze({
  maxInputBytes: 10_485_760,
  maxPerMessage: 5,
});

// ---------------------------------------------------------------------------
// Verified metadata envelope
// ---------------------------------------------------------------------------

/**
 * The subset of the verified direct response envelope this mapper consumes:
 * `GET /{apiVersion}/{media-id}` → `{ messaging_product, url, mime_type,
 * sha256, file_size, id }`.
 *
 * `url` is pre-signed and transient: it exists only between the verified lookup
 * and the byte download, and never leaves this layer. `sha256` and `id` are not
 * consumed (there is no expected digest or ID to compare against).
 */
export interface WhatsAppMediaMetadata {
  /** The media download URL, verified `https:` by the connector lookup. */
  url: string;
  /** Envelope `mime_type`, normalized. Absent when the API declared none. */
  mimeType?: string;
  /** Envelope `file_size` in bytes. Absent when undeclared or unparseable. */
  fileSize?: number;
}

/** One opened media download: the raw byte stream plus the response MIME. */
export interface OpenedWhatsAppMedia {
  /** Raw byte stream — the download response is NOT JSON. */
  stream: MediaStream;
  /** Response `content-type` header, when present. MIME metadata only. */
  contentType?: string;
}

/**
 * Token-aware dependencies supplied by the connector. Both calls receive the
 * SHARED message budget signal and must throw token-free, URL-free errors: the
 * transport and this module map failures to fixed-text closed outcomes.
 */
export interface WhatsAppMediaDeps {
  /**
   * Perform the media-ID lookup and verify the direct response envelope
   * (`messaging_product` + `https:` `url`) BEFORE returning a download URL.
   */
  lookupMedia: (mediaId: string, signal: AbortSignal) => Promise<WhatsAppMediaMetadata>;
  /** Re-attach the bearer token to the media URL and open the byte download. */
  openMedia: (metadata: WhatsAppMediaMetadata, signal: AbortSignal) => Promise<OpenedWhatsAppMedia>;
  /** Per-message budget factory; defaults to the shared 60-second budget. */
  createFetchBudget?: () => MessageFetchBudget;
}

// ---------------------------------------------------------------------------
// Planning (pure — no request of any kind)
// ---------------------------------------------------------------------------

/** Sanitized selection metadata subset carried by every outcome arm. */
type EntryMetadata = Pick<
  SelectedImage,
  'slot' | 'sourcePosition' | 'filename' | 'mimeType' | 'declaredSize'
>;

/** One delivered media item: its selectImages candidate plus its media handle. */
export interface WhatsAppMediaItem {
  candidate: ImageMediaCandidate;
  /** The webhook `media.id`. An opaque handle: never echoed, logged, or persisted. */
  mediaId: string;
  /** Channel-declared MIME exactly as delivered (may be absent or malformed). */
  declaredMimeType?: string;
}

/** A message's media plan, computed WITHOUT any request. */
export interface WhatsAppMediaPlan {
  /** Effective per-download byte cap (`images.maxInputBytes`). */
  maxBytes: number;
  items: WhatsAppMediaItem[];
  selection: ImageSelectionResult;
}

/**
 * Build the media plan for one webhook message.
 *
 * A WhatsApp message carries exactly one media object, so at most one item is
 * produced. Mappings:
 *
 * - `image` → a `photo` candidate (image content by channel declaration) plus
 *   its declared MIME, so an unsupported image MIME is rejected post-slot
 *   without a download.
 * - `document` → a `document` candidate: eligible ONLY when its declared MIME is
 *   `image/*` (a filename never establishes MIME).
 * - `sticker` → a flagged candidate that `selectImages` silently excludes, so a
 *   sticker consumes no slot and produces no request (static WebP included).
 * - `audio`, `video`, and every other type produce NO item.
 *
 * The webhook carries no declared size, so `declaredSize` stays unknown here;
 * the verified `file_size` from the envelope performs the pre-download size
 * check inside {@link fetchWhatsAppMedia}.
 */
export function planWhatsAppMedia(
  message: WhatsAppMessage,
  settings: ImageSelectionSettings,
): WhatsAppMediaPlan {
  const items: WhatsAppMediaItem[] = [];

  if (message.type === 'image') {
    const body = usableMedia(message.image);
    if (body !== undefined) {
      items.push({
        mediaId: body.id,
        ...(body.mime_type !== undefined ? { declaredMimeType: body.mime_type } : {}),
        candidate: {
          origin: 'photo',
          ...(body.mime_type !== undefined ? { mimeType: body.mime_type } : {}),
          ...(body.filename !== undefined ? { filename: body.filename } : {}),
        },
      });
    }
  } else if (message.type === 'document') {
    const body = usableMedia(message.document);
    if (body !== undefined) {
      items.push({
        mediaId: body.id,
        ...(body.mime_type !== undefined ? { declaredMimeType: body.mime_type } : {}),
        candidate: {
          origin: 'document',
          ...(body.mime_type !== undefined ? { mimeType: body.mime_type } : {}),
          ...(body.filename !== undefined ? { filename: body.filename } : {}),
        },
      });
    }
  } else if (message.type === 'sticker') {
    // Flagged so the shared selector excludes it BEFORE slots: no Image, no
    // slot, no request. It is still recorded in `selection.excluded` so the
    // drop is observable without inventing channel-specific vocabulary.
    const body = usableMedia(message.sticker);
    if (body !== undefined) {
      items.push({
        mediaId: body.id,
        ...(body.mime_type !== undefined ? { declaredMimeType: body.mime_type } : {}),
        candidate: { origin: 'photo', sticker: true },
      });
    }
  }

  return {
    maxBytes: settings.maxInputBytes,
    items,
    selection: selectImages(
      items.map((item) => item.candidate),
      settings,
    ),
  };
}

/**
 * True when the plan has at least one slot-consuming item (selected or
 * closed-rejected). The connector's admission rule uses this: a message whose
 * media is entirely EXCLUDED (sticker, non-image document) and which carries no
 * text or caption behaves like a plain unsupported message and is dropped,
 * matching the pre-media behavior.
 */
export function planHasImageSlots(plan: WhatsAppMediaPlan): boolean {
  return plan.selection.images.length > 0;
}

/**
 * The message's effective caption, when the delivered media object carries one.
 * WhatsApp puts the caption INSIDE the media object, so a photo's text lives on
 * `image.caption`, not on a message-level field.
 */
export function whatsappMediaCaption(message: WhatsAppMessage): string | undefined {
  for (const body of [message.image, message.document, message.sticker, message.video, message.audio]) {
    const caption = body?.caption;
    if (typeof caption === 'string') {
      return caption;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fetching (runs ONLY after every authorization/admission check passed)
// ---------------------------------------------------------------------------

/**
 * Resolve every slot-holding item of an already-planned, already-authorized
 * message into inbound Attachments in source order: a payload `Attachment` on
 * success, or a metadata-only {@link InboundAttachmentRejection} carrying
 * exactly one closed reason. Items excluded before slots (stickers, non-image
 * documents) produce NO attachment.
 *
 * The metadata lookup and the byte download of every item share ONE
 * `createMessageFetchBudget` deadline — there is no per-call reset — and the
 * budget is disposed before returning.
 */
export async function fetchWhatsAppMedia(
  plan: WhatsAppMediaPlan,
  deps: WhatsAppMediaDeps,
): Promise<InboundAttachment[]> {
  const attachments: InboundAttachment[] = [];
  if (plan.selection.images.length === 0) {
    return attachments;
  }

  const createBudget = deps.createFetchBudget ?? createMessageFetchBudget;
  const budget = createBudget();
  try {
    for (const entry of plan.selection.images) {
      const item = plan.items[entry.sourcePosition];
      if (item === undefined) {
        continue;
      }
      if (entry.disposition === 'rejected') {
        attachments.push(rejection(entry.rejectionReason, entry.sourcePosition, entry));
        continue;
      }
      attachments.push(await fetchItem(entry, item, plan.maxBytes, budget, deps));
    }
  } finally {
    budget.dispose();
  }
  return attachments;
}

/**
 * Resolve one selected item: verified metadata lookup first, then — only when
 * the envelope's MIME and declared size are admissible — one bounded byte
 * download.
 */
async function fetchItem(
  entry: EntryMetadata,
  item: WhatsAppMediaItem,
  maxBytes: number,
  budget: MessageFetchBudget,
  deps: WhatsAppMediaDeps,
): Promise<InboundAttachment> {
  if (budget.expired()) {
    return rejection('download_failed', entry.sourcePosition, entry);
  }

  // -- Step 1: metadata lookup, fenced by the SHARED budget ----------------
  // The lookup is a JSON request outside the byte transport, so it needs the
  // same abort racing as `fetchImage`'s open (the house `raceWithAbort`
  // pattern from image-normalizer.ts / image-transport.ts): a lookup that
  // ignores the signal can never delay the outcome, and a late envelope is
  // discarded rather than turned into a download.
  const lookupOutcome = await settleWithinDeadline(deps.lookupMedia(item.mediaId, budget.signal), budget);
  if (lookupOutcome.type === 'aborted') {
    return rejection('download_failed', entry.sourcePosition, entry);
  }
  if (lookupOutcome.type === 'error') {
    // Fixed outcome: the lookup error text is server- and URL-bearing and is
    // deliberately never carried forward.
    return rejection('download_failed', entry.sourcePosition, entry);
  }

  const metadata = lookupOutcome.value;

  // -- Step 2: eligibility from VERIFIED metadata, before any byte transfer --
  const mime = eligibleMimeType(metadata, entry, item);
  if (mime === null) {
    return rejection('unsupported_mime', entry.sourcePosition, entry);
  }
  if (metadata.fileSize !== undefined && metadata.fileSize > maxBytes) {
    // Confirmed oversized from the verified envelope: reject without opening
    // the download at all.
    return rejection('size_limit', entry.sourcePosition, {
      ...entry,
      declaredSize: metadata.fileSize,
    });
  }
  if (budget.expired()) {
    return rejection('download_failed', entry.sourcePosition, entry);
  }

  // -- Step 3: bounded byte download on the shared budget -------------------
  let responseContentType: string | undefined;
  const result = await fetchImage(budget, {
    candidateIndex: entry.slot,
    // Opaque handle only; the transport never echoes it.
    mediaRef: item.mediaId,
    ...(mime !== undefined ? { mimeType: mime } : {}),
    ...(entry.filename !== undefined ? { filename: entry.filename } : {}),
    maxBytes,
    open: async (signal) => {
      const opened = await deps.openMedia(metadata, signal);
      responseContentType = opened.contentType;
      return opened.stream;
    },
  });

  if (result.isOk()) {
    // Payload MIME precedence: the verified envelope / webhook-declared MIME
    // (already normalized), then the download response's `content-type` when
    // the envelope declared none, then a neutral octet-stream. The response
    // header only LABELS an already-admitted payload — it never widened
    // eligibility — and it also drives the generated filename below.
    const payloadMime =
      mime ?? normalizeMimeType(responseContentType) ?? 'application/octet-stream';
    return {
      filename: payloadFilename(entry, payloadMime),
      mimeType: payloadMime,
      data: result.value.bytes,
      size: result.value.size,
    };
  }
  // The transport already speaks only the closed vocabulary
  // (`download_failed` | `size_limit`) with fixed-text messages.
  return rejection(result.error.code, entry.sourcePosition, {
    ...entry,
    ...(entry.mimeType === undefined && responseContentType !== undefined
      ? { mimeType: normalizeMimeType(responseContentType) }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Eligibility and metadata
// ---------------------------------------------------------------------------

/**
 * The payload MIME to use, or `null` when the asset is not an eligible image.
 *
 * The verified envelope's `mime_type` is authoritative and is preferred over the
 * webhook-declared value; the normalized declared MIME is the fallback when the
 * envelope declares none. Eligibility is:
 *
 * - a declared MIME must be a SUPPORTED image type (JPEG/PNG/WebP) — anything
 *   else, including an `image/heic`/`image/svg+xml` or a non-image type the
 *   envelope revealed on an `image`-typed message, is `unsupported_mime`;
 * - a `photo` item whose MIME is unknown on BOTH the envelope and the webhook
 *   stays eligible, matching `selectImages`' photo rule (image content by
 *   channel declaration), and its payload MIME is then taken from the download
 *   response's `content-type` when usable.
 *
 * The download response's `content-type` is never used to WIDEN eligibility; it
 * only labels a payload whose content was already admitted.
 */
function eligibleMimeType(
  metadata: WhatsAppMediaMetadata,
  entry: EntryMetadata,
  item: WhatsAppMediaItem,
): string | undefined | null {
  const declared = normalizeMimeType(metadata.mimeType ?? entry.mimeType ?? item.declaredMimeType);
  if (declared === undefined) {
    return entry.mimeType === undefined && item.candidate.origin === 'photo' ? undefined : null;
  }
  return isSupportedImageMime(declared) ? declared : null;
}

/**
 * Payload filename: the sanitized DECLARED name when the channel supplied a
 * usable one, then a neutral origin word. `Attachment.filename` is a required
 * string, and a media URL is never consulted for a name (it is pre-signed and
 * carries no usable display name).
 */
function payloadFilename(entry: { filename?: string }, mime: string | undefined): string {
  if (entry.filename !== undefined) {
    return entry.filename;
  }
  const fromMime = sanitizeFilename(extensionForMime(mime));
  return fromMime ?? 'image';
}

/** Neutral extension-only hint; `undefined` for an unknown MIME. */
function extensionForMime(mime: string | undefined): string | undefined {
  if (mime === 'image/jpeg') {
    return 'photo.jpg';
  }
  if (mime === 'image/png') {
    return 'photo.png';
  }
  if (mime === 'image/webp') {
    return 'photo.webp';
  }
  return undefined;
}

/** Build the metadata-only rejection arm (no bytes, URLs, or credentials). */
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Settled<T> = { type: 'ok'; value: T } | { type: 'error' } | { type: 'aborted' };

/**
 * Await `promise` unless the shared budget deadline elapses first. An already
 * expired budget short-circuits before the lookup is given any more of the
 * attempt. Errors collapse to a marker with no text, because a Graph API error
 * string can carry the request URL.
 */
async function settleWithinDeadline<T>(promise: Promise<T>, budget: MessageFetchBudget): Promise<Settled<T>> {
  if (budget.expired()) {
    return { type: 'aborted' };
  }
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race<Settled<T>>([
      promise.then(
        (value): Settled<T> => ({ type: 'ok', value }),
        (): Settled<T> => ({ type: 'error' }),
      ),
      new Promise<Settled<T>>((resolve): void => {
        onAbort = (): void => resolve({ type: 'aborted' });
        budget.signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) {
      budget.signal.removeEventListener('abort', onAbort);
    }
  }
}

/** A webhook media object is usable only when it carries a non-empty media ID. */
function usableMedia(body: WhatsAppMediaBody | undefined): WhatsAppMediaBody | undefined {
  if (body === undefined || typeof body.id !== 'string' || body.id.length === 0) {
    return undefined;
  }
  return body;
}
