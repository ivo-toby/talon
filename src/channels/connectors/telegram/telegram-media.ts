/**
 * Telegram photo/document ingestion (TASK-006).
 *
 * Turns one authorized Telegram message's delivered media into inbound
 * Attachment outcomes (payload or closed rejection) by consuming the shared
 * TASK-004 ports — `selectImages` for exclusion/slot/vocabulary decisions and
 * `fetchImage` for bounded downloads. This module performs NO authorization:
 * the connector runs all sender/chat/bot/group/trigger checks BEFORE it calls
 * {@link fetchTelegramMedia}, so a denied message makes no media request.
 *
 * Contracts implemented here (inventory E1/E2, spec selection table):
 *
 * - **One photo = one candidate.** `message.photo` is an array of size
 *   renditions of the SAME photo; exactly one Image candidate is produced and
 *   album members arrive as separate updates (no aggregation here).
 * - **Largest fitting rendition.** Attempts are ordered by descending pixel
 *   area, restricted to renditions whose declared size fits BOTH the
 *   configured `images.maxInputBytes` and the Bot API's 20 MB getFile cap
 *   ({@link TELEGRAM_MAX_DOWNLOAD_BYTES}). Unknown-size renditions are tried
 *   with the bounded actual-byte check of `fetchImage`; on byte overflow the
 *   NEXT SMALLER rendition is attempted within the same message fetch budget
 *   (E1 fallback is overflow-only — a `download_failed` is never retried
 *   across renditions).
 * - **All renditions confirmed oversized → `size_limit`** with zero requests;
 *   fetch failure or deadline exhaustion → `download_failed`.
 * - **Stickers are excluded silently** (including static-WebP stickers) and
 *   consume no slot. Document eligibility comes from the DECLARED MIME only —
 *   static image/WebP documents stay eligible; an unsupported image MIME
 *   (HEIC, SVG, …) consumes its slot as `unsupported_mime` without any
 *   download.
 *
 * Hygiene: nothing returned here carries bot tokens, download URLs, or
 * `file_path` handles beyond the transient payload filename derivation, and
 * transport failures surface only through the closed rejection vocabulary
 * with the fixed-text messages of the TASK-004 transport.
 */

import {
  selectImages,
  sanitizeFilename,
  type ImageMediaCandidate,
  type ImageSelectionResult,
  type ImageSelectionSettings,
  type MediaOrigin,
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
import type { TelegramMessage, TelegramPhotoSize } from './telegram-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Bot API hard cap on files a bot may download via getFile
 * (https://core.telegram.org/bots/api#getfile, inventory E2). Larger files are
 * never downloadable, so they are treated as confirmed oversized without any
 * request.
 */
export const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Fallback selection settings, mirroring the `images` config block defaults
 * (`images.maxInputBytes` / `images.maxPerMessage` in config-schema.ts). The
 * channel factory injects the operator's validated settings; these apply only
 * when a connector is constructed without them.
 */
export const DEFAULT_TELEGRAM_IMAGE_SETTINGS: ImageSelectionSettings = Object.freeze({
  maxInputBytes: 10_485_760,
  maxPerMessage: 5,
});

// ---------------------------------------------------------------------------
// Planning (pure — runs before authorization gates resolve the message)
// ---------------------------------------------------------------------------

/** Ordered download attempts for one photo message (renditions of one photo). */
export interface PhotoPlan {
  origin: 'photo';
  /**
   * Renditions to attempt, largest pixel area first. A rendition is present
   * only when its declared size is unknown or fits the effective byte cap;
   * an empty list means every rendition is CONFIRMED oversized (declared size
   * over the cap) → `size_limit` without any request.
   */
  attempts: TelegramPhotoSize[];
}

/** Download plan for one document message (single file, no renditions). */
export interface DocumentPlan {
  origin: 'document';
  fileId: string;
  /** Usable declared size, when Telegram supplied one. */
  declaredSize: number | undefined;
}

export type MediaPlan = PhotoPlan | DocumentPlan;

/**
 * Sanitized selection metadata subset every outcome arm carries: slot and
 * source order plus the already-sanitized filename/MIME/declared size.
 * Both `SelectedImage` and `RejectedImageSelection` satisfy this shape.
 */
type EntryMetadata = Pick<
  SelectedImage,
  'slot' | 'sourcePosition' | 'filename' | 'mimeType' | 'declaredSize'
>;

/** One delivered media item: its selectImages candidate plus its download plan. */
export interface MediaItem {
  candidate: ImageMediaCandidate;
  plan: MediaPlan;
}

/**
 * A message's media plan: the selectImages candidate list with its selection
 * result (both in source order), computed WITHOUT any request. Empty items
 * mean the message carried no image-bearing media (text, stickers, other
 * media kinds, or nothing).
 */
export interface TelegramMediaPlan {
  /** Effective per-download byte cap: min(configured, 20 MB getFile cap). */
  maxBytes: number;
  items: MediaItem[];
  selection: ImageSelectionResult;
}

/**
 * Build the media plan for a message: at most one item exists in practice
 * (a Telegram message carries one media kind — photo, document or sticker —
 * and album members are separate updates), but the loop keeps source order
 * generic. Stickers produce NO item: they are silently excluded and consume
 * no slot.
 */
export function planTelegramMedia(
  message: TelegramMessage,
  settings: ImageSelectionSettings,
): TelegramMediaPlan {
  const maxBytes = Math.min(settings.maxInputBytes, TELEGRAM_MAX_DOWNLOAD_BYTES);
  const items: MediaItem[] = [];

  const renditions = usableRenditions(message.photo);
  if (renditions.length > 0) {
    items.push({
      candidate: photoCandidate(renditions),
      plan: { origin: 'photo', attempts: orderedAttempts(renditions, maxBytes) },
    });
  }

  const document = message.document;
  if (
    document !== undefined &&
    typeof document.file_id === 'string' &&
    document.file_id.length > 0
  ) {
    items.push({
      candidate: {
        origin: 'document',
        ...(document.mime_type !== undefined ? { mimeType: document.mime_type } : {}),
        ...(document.file_name !== undefined ? { filename: document.file_name } : {}),
        ...(usableSize(document.file_size) !== undefined
          ? { declaredSize: usableSize(document.file_size) }
          : {}),
      },
      plan: {
        origin: 'document',
        fileId: document.file_id,
        declaredSize: usableSize(document.file_size),
      },
    });
  }

  return {
    maxBytes,
    items,
    selection: selectImages(
      items.map((item) => item.candidate),
      settings,
    ),
  };
}

/**
 * True when the plan has at least one slot-consuming item (selected or
 * rejected). Used by the connector's trigger rules: a media message whose
 * media is entirely excluded (sticker, non-image document) behaves like a
 * plain text message when its stripped caption is empty.
 */
export function planHasImageSlots(plan: TelegramMediaPlan): boolean {
  return plan.selection.images.length > 0;
}

// ---------------------------------------------------------------------------
// Fetching (runs ONLY after every authorization/trigger check passed)
// ---------------------------------------------------------------------------

/** One opened Telegram file: the byte stream plus the server-assigned path. */
export interface OpenedTelegramFile {
  /** Raw byte stream of the file body (the download is NOT JSON). */
  stream: MediaStream;
  /**
   * Server-assigned `file_path` (e.g. `photos/file_10.jpg`). Transient
   * download metadata only: used solely to derive the payload's display
   * filename/MIME, never persisted or logged.
   */
  filePath: string;
}

/** Dependencies supplied by the connector (the only token-aware layer). */
export interface TelegramMediaDeps {
  /**
   * Resolve a `file_id` via getFile and open the byte download, honoring the
   * shared budget signal. MUST reject with token-free, URL-free errors — the
   * transport maps open failures to fixed-text `download_failed`.
   */
  openFile: (fileId: string, signal: AbortSignal) => Promise<OpenedTelegramFile>;
  /** Per-message budget factory; defaults to the shared 60-second budget. */
  createFetchBudget?: () => MessageFetchBudget;
}

/**
 * Download every slot-holding item of an already-planned, already-authorized
 * message and return the inbound Attachments in source order: a payload
 * `Attachment` on success or a metadata-only `InboundAttachmentRejection`
 * carrying exactly one closed reason. Items excluded before slots (stickers,
 * non-image documents) produce NO attachment.
 *
 * All attempts of the message share ONE `createMessageFetchBudget` deadline;
 * the budget is disposed before returning.
 */
export async function fetchTelegramMedia(
  plan: TelegramMediaPlan,
  deps: TelegramMediaDeps,
): Promise<InboundAttachment[]> {
  const attachments: InboundAttachment[] = [];
  const selectedEntries = plan.selection.images.filter((entry) => entry.disposition === 'selected');
  if (selectedEntries.length === 0) {
    // Every delivered item already carries a closed rejection (or was
    // excluded): no media request of any kind.
    for (const entry of plan.selection.images) {
      if (entry.disposition === 'rejected') {
        attachments.push(rejection(entry.rejectionReason, entry.sourcePosition, entry));
      }
    }
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
      if (item.plan.origin === 'photo') {
        attachments.push(await fetchPhoto(entry, item.plan, plan.maxBytes, budget, deps));
      } else {
        attachments.push(await fetchDocument(entry, item.plan, plan.maxBytes, budget, deps));
      }
    }
  } finally {
    budget.dispose();
  }
  return attachments;
}

// ---------------------------------------------------------------------------
// Photo renditions
// ---------------------------------------------------------------------------

/** Renditions with a usable file_id and positive pixel dimensions. */
function usableRenditions(photo: TelegramPhotoSize[] | undefined): TelegramPhotoSize[] {
  if (!Array.isArray(photo)) {
    return [];
  }
  return photo.filter(
    (size) =>
      typeof size?.file_id === 'string' &&
      size.file_id.length > 0 &&
      Number.isFinite(size.width) &&
      Number.isFinite(size.height) &&
      size.width > 0 &&
      size.height > 0,
  );
}

/**
 * Attempt order: descending pixel area, dropping renditions whose DECLARED
 * size is confirmed over the effective cap (they cannot fit and the Bot API
 * would refuse them anyway). Unknown-size renditions stay in the list and are
 * bounded by `fetchImage`'s actual-byte cutoff instead.
 */
function orderedAttempts(
  renditions: readonly TelegramPhotoSize[],
  maxBytes: number,
): TelegramPhotoSize[] {
  return renditions
    .filter((size) => {
      const declared = usableSize(size.file_size);
      return declared === undefined || declared <= maxBytes;
    })
    .sort((a, b) => b.width * b.height - a.width * a.height);
}

/**
 * The single selectImages candidate for a photo message. The declared size
 * handed to selection is the MINIMUM declared size across renditions — the
 * most optimistic figure — because a rendition only has to FIT to be chosen:
 * when even the minimum exceeds `maxInputBytes`, every rendition is confirmed
 * oversized and selection rejects with `size_limit`. If any rendition's size
 * is unknown, the candidate's size is unknown (a bounded download check, not
 * a declared-size rejection, decides).
 */
function photoCandidate(renditions: readonly TelegramPhotoSize[]): ImageMediaCandidate {
  const declaredSizes = renditions
    .map((size) => usableSize(size.file_size))
    .filter((size): size is number => size !== undefined);
  const allDeclared = declaredSizes.length === renditions.length;
  return {
    origin: 'photo',
    ...(allDeclared ? { declaredSize: Math.min(...declaredSizes) } : {}),
  };
}

async function fetchPhoto(
  entry: EntryMetadata,
  plan: PhotoPlan,
  maxBytes: number,
  budget: MessageFetchBudget,
  deps: TelegramMediaDeps,
): Promise<InboundAttachment> {
  if (plan.attempts.length === 0) {
    // Every rendition's declared size exceeds the effective cap: confirmed
    // oversized without needing a request (the 20 MB cap case is invisible
    // to selectImages, so the connector reports it here).
    return rejection('size_limit', entry.sourcePosition, entry);
  }
  for (const rendition of plan.attempts) {
    if (budget.expired()) {
      return rejection('download_failed', entry.sourcePosition, entry);
    }
    let openedPath: string | undefined;
    const result = await fetchImage(budget, {
      candidateIndex: entry.slot,
      mediaRef: rendition.file_id,
      maxBytes,
      open: async (signal) => {
        const opened = await deps.openFile(rendition.file_id, signal);
        openedPath = opened.filePath;
        return opened.stream;
      },
    });
    if (result.isOk()) {
      const filePath = openedPath ?? '';
      return {
        filename: payloadFilename(entry, filePath, 'photo'),
        mimeType: photoPayloadMimeType(filePath),
        data: result.value.bytes,
        size: result.value.size,
      };
    }
    if (result.error.code === 'download_failed') {
      // E1: fallback is overflow-only. A failed/deadlined fetch is final —
      // no retry across renditions for the same source.
      return rejection('download_failed', entry.sourcePosition, entry);
    }
    // size_limit: actual bytes overflowed the cap — fall back to the next
    // (smaller) rendition within the SAME message budget. When every attempt
    // overflows, this same line is the final `size_limit` outcome.
  }
  return rejection('size_limit', entry.sourcePosition, entry);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

async function fetchDocument(
  entry: EntryMetadata,
  plan: DocumentPlan,
  maxBytes: number,
  budget: MessageFetchBudget,
  deps: TelegramMediaDeps,
): Promise<InboundAttachment> {
  if (plan.declaredSize !== undefined && plan.declaredSize > TELEGRAM_MAX_DOWNLOAD_BYTES) {
    // Confirmed oversized against the Bot API download cap: the request
    // would fail anyway, so report the closed reason without making it.
    return rejection('size_limit', entry.sourcePosition, entry);
  }
  let openedPath: string | undefined;
  const result = await fetchImage(budget, {
    candidateIndex: entry.slot,
    mediaRef: plan.fileId,
    ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
    ...(entry.filename !== undefined ? { filename: entry.filename } : {}),
    maxBytes,
    open: async (signal) => {
      const opened = await deps.openFile(plan.fileId, signal);
      openedPath = opened.filePath;
      return opened.stream;
    },
  });
  if (result.isOk()) {
    return {
      filename: payloadFilename(entry, openedPath ?? '', 'document'),
      // Eligibility guaranteed a declared image MIME for documents.
      mimeType: entry.mimeType ?? 'application/octet-stream',
      data: result.value.bytes,
      size: result.value.size,
    };
  }
  return rejection(result.error.code, entry.sourcePosition, entry);
}

// ---------------------------------------------------------------------------
// Payload metadata hygiene
// ---------------------------------------------------------------------------

/** MIME types recognized from the server-assigned file_path extension. */
const PAYLOAD_MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
});

/**
 * Payload MIME for a downloaded photo. Telegram re-encodes photo renditions
 * server-side and the `file_path` extension reflects the delivered format;
 * the Bot API's photo format is JPEG, so an extension-less or unknown path
 * keeps `image/jpeg` rather than inventing another type. This maps the
 * SERVER-assigned path — user-declared document names are never consulted
 * here (a filename never establishes MIME for eligibility; documents carry
 * their declared MIME instead).
 */
export function photoPayloadMimeType(filePath: string): string {
  const base = filePath.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot >= 0 && dot < base.length - 1) {
    const mime = PAYLOAD_MIME_BY_EXTENSION[base.slice(dot + 1).toLowerCase()];
    if (mime !== undefined) {
      return mime;
    }
  }
  return 'image/jpeg';
}

/**
 * Payload filename: the sanitized DECLARED name first (documents), then the
 * sanitized last segment of the server-assigned path (credential-free — the
 * bot token lives in the URL prefix, never in `file_path`), then a neutral
 * origin word. Telegram always has a server-assigned path, so a neutral
 * fallback beats fabricating an extension.
 */
function payloadFilename(
  entry: { filename?: string },
  filePath: string,
  origin: MediaOrigin,
): string {
  if (entry.filename !== undefined) {
    return entry.filename;
  }
  const fromPath = sanitizeFilename(filePath.split('/').pop());
  if (fromPath !== undefined) {
    return fromPath;
  }
  return origin === 'photo' ? 'photo' : 'document';
}

/** Build the metadata-only rejection arm (no bytes, paths, or credentials). */
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
