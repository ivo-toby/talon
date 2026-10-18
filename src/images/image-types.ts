/**
 * Shared Image vocabulary: closed states, closed reasons, metadata DTOs, and
 * the thread-scoped `ImageAccess` port.
 *
 * These are contracts only — no storage, downloads, normalization, or vision
 * runtime lives here. The concrete `ImageAccess` adapter is supplied later
 * (TASK-010); consumers depend on this port and can be tested with
 * deterministic fakes in the meantime.
 *
 * Terminology (see CONTEXT.md):
 * - An **Attachment** is a delivery payload; it is not a durable Image.
 * - An **Image** is the durable record of an accepted or rejected image
 *   Attachment. It carries state, metadata, and an expiry, and it survives the
 *   Normalized file it was produced from.
 * - An **Image descriptor** is the textual representation of an Image: identity,
 *   origin, availability, expiry, and selected metadata. It never carries
 *   pixels, local paths, staging references, or media credentials.
 */

import type { Result } from '../core/types/result.js';

// ---------------------------------------------------------------------------
// Closed state list
// ---------------------------------------------------------------------------

/**
 * The four Image states. `processing` is internal to Ingestion and is never
 * exposed to Inspection or lookup; `rejected` and `unavailable` are terminal.
 */
export const IMAGE_STATES = Object.freeze([
  'processing',
  'available',
  'rejected',
  'unavailable',
] as const);

export type ImageState = (typeof IMAGE_STATES)[number];

// ---------------------------------------------------------------------------
// Closed reason lists
// ---------------------------------------------------------------------------

/**
 * The complete rejection vocabulary. Reasons are connector-neutral: no
 * channel-specific values may be added, and a Rejected Image carries exactly
 * one of them.
 *
 * - unsupported_mime: eligible image MIME is outside the supported formats
 * - count_limit: eligible Attachment exceeds the message's upload slots
 * - size_limit: declared or actual input bytes exceed the per-Image limit
 * - animated: input is an animated image, including APNG
 * - download_failed: channel media fetch fails or times out
 * - conversion_failed: input cannot be decoded/normalized
 * - processing_interrupted: recovery has no usable source before the deadline
 * - processing_failed: operational retries are exhausted or the deadline elapsed
 */
export const IMAGE_REJECTION_REASONS = Object.freeze([
  'unsupported_mime',
  'count_limit',
  'size_limit',
  'animated',
  'download_failed',
  'conversion_failed',
  'processing_interrupted',
  'processing_failed',
] as const);

export type ImageRejectionReason = (typeof IMAGE_REJECTION_REASONS)[number];

/**
 * Why an Image's visual content cannot be read. Both reasons mean the same
 * recovery for the user: re-upload creates a new Image ID and a new deadline.
 * Metadata and existing Findings stay accessible.
 */
export const IMAGE_UNAVAILABILITY_REASONS = Object.freeze([
  'expired',
  'file_missing',
] as const);

export type ImageUnavailabilityReason = (typeof IMAGE_UNAVAILABILITY_REASONS)[number];

// ---------------------------------------------------------------------------
// Selected metadata DTOs
//
// Every field below is derived from untrusted parser output (declared channel
// metadata, raw EXIF) and must be validated before it reaches these DTOs.
// Absent optional fields mean "unknown" — nothing here is ever invented,
// defaulted, or guessed (no fabricated location, no fabricated timezone).
// ---------------------------------------------------------------------------

/** Pixel dimensions of the source image as decoded, before normalization. */
export interface ImageDimensions {
  width: number;
  height: number;
}

/** Interpretation of the EXIF GPSAltitudeRef tag. Absent means the tag was absent. */
export type ImageGpsAltitudeRef = 'aboveSeaLevel' | 'belowSeaLevel';

/**
 * GPS position from EXIF. This is EXIF location, which is distinct from any
 * location a model might infer from the picture.
 */
export interface ImageGpsMetadata {
  /** Decimal degrees, WGS84. */
  latitude: number;
  /** Decimal degrees, WGS84. */
  longitude: number;
  /** Altitude in metres, interpreted with `altitudeRef`. */
  altitude?: number;
  altitudeRef?: ImageGpsAltitudeRef;
}

/**
 * The approved EXIF subset. Capture time and its offset stay plain strings so
 * the daemon's local timezone is never smuggled into a photographed timestamp.
 */
export interface ImageExifMetadata {
  gps?: ImageGpsMetadata;
  /** Raw EXIF DateTimeOriginal, e.g. `2026-03-01 09:15:23`. */
  capturedAt?: string;
  /** Raw EXIF OffsetTimeOriginal, e.g. `+02:00`. Never derived from the daemon clock. */
  capturedAtOffset?: string;
  cameraMake?: string;
  cameraModel?: string;
  /** Original EXIF orientation value before auto-orientation was applied. */
  orientation?: number;
}

// ---------------------------------------------------------------------------
// Image descriptor
// ---------------------------------------------------------------------------

/** Fields present in every Image descriptor regardless of state. */
interface ImageDescriptorBase {
  /** Globally unique Image ID; a re-upload creates a different one. */
  imageId: string;
  /** The single conversation thread that owns this Image. */
  threadId: string;
  /** Owning message (the inbound message that produced this Image). */
  messageId: string;
  /** Zero-based source order within the owning message. */
  ordinal: number;
  /**
   * Unix epoch milliseconds of durable pipeline admission on the local clock.
   * Independent of platform and EXIF timestamps; access and retries never move it.
   */
  receivedAt: number;
  /** Unix epoch milliseconds when the Normalized file stops being retained. */
  expiresAt: number;
  /** Declared filename from the channel. Metadata only — never a path to open. */
  filename?: string;
  /** Declared MIME type; a filename never establishes MIME. */
  mimeType?: string;
  dimensions?: ImageDimensions;
  exif?: ImageExifMetadata;
}

/**
 * The descriptor of one Image at the moment it was read. Availability must be
 * refreshed before every projection, lookup, or Inspection, so descriptors are
 * snapshots: a descriptor rendered earlier in a conversation may already be
 * stale.
 *
 * Exactly one reason is present in a terminal state and none otherwise.
 * Descriptors never carry pixel bytes, local filesystem paths, staging
 * references, or download credentials.
 */
export type ImageDescriptor =
  | (ImageDescriptorBase & {
      state: 'processing' | 'available';
      rejectionReason?: never;
      unavailabilityReason?: never;
    })
  | (ImageDescriptorBase & {
      state: 'rejected';
      rejectionReason: ImageRejectionReason;
      unavailabilityReason?: never;
    })
  | (ImageDescriptorBase & {
      state: 'unavailable';
      unavailabilityReason: ImageUnavailabilityReason;
      rejectionReason?: never;
    });

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * Current visual-content availability of one Image, as reported by
 * {@link ImageAccess.getAvailability}.
 *
 * Availability is only true for an Available Image whose Normalized file still
 * exists before expiry. Expiry takes precedence when first establishing
 * unavailability; an already-recorded unavailability reason is retained.
 */
export type ImageAvailability =
  | { state: 'available'; available: true; expiresAt: number }
  | { state: 'processing'; available: false }
  | { state: 'rejected'; available: false; rejectionReason: ImageRejectionReason }
  | {
      state: 'unavailable';
      available: false;
      unavailabilityReason: ImageUnavailabilityReason;
    };

// ---------------------------------------------------------------------------
// Inspection bytes
// ---------------------------------------------------------------------------

/**
 * Normalized JPEG bytes handed to a single Inspection attempt.
 *
 * These bytes are ephemeral request material: they must never enter durable
 * message/queue content, model text prompts, summaries, or application logs
 * (see docs/adr/0001-vision-subagent.md).
 */
export interface ImageInspectionBytes {
  imageId: string;
  /** Normalized JPEG pixels, in memory only. */
  bytes: Buffer;
  mimeType: 'image/jpeg';
  /**
   * Expiry captured when the bytes were loaded. An attempt that started before
   * expiry may finish, but no new attempt or failover may begin after it.
   */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// ImageAccess port errors
// ---------------------------------------------------------------------------

/**
 * Closed error vocabulary for {@link ImageAccess}.
 *
 * `not_found` deliberately covers both unknown and other-thread Image IDs so
 * callers cannot probe for Images they do not own.
 */
export type ImageAccessError =
  | { code: 'not_found'; message?: string }
  | { code: 'processing'; message?: string }
  | { code: 'rejected'; rejectionReason: ImageRejectionReason }
  | { code: 'unavailable'; unavailabilityReason: ImageUnavailabilityReason }
  /** Operational failure in the record or file layer. Never contains pixels. */
  | { code: 'storage_failed'; message: string };

// ---------------------------------------------------------------------------
// ImageAccess port
// ---------------------------------------------------------------------------

/** Identifies the one Image one thread-scoped operation may touch. */
export interface ImageAccessRequest {
  /**
   * Trusted current conversation thread, supplied by Talon rather than by the
   * model. Every operation is scoped to it; cross-thread IDs resolve as
   * `not_found`.
   */
  threadId: string;
  imageId: string;
}

/**
 * Read port over the current thread's Images.
 *
 * Defined as an interface so the pipeline, projections, Inspection, and lookup
 * can all be built and tested against deterministic fakes. The concrete
 * adapter (SQLite records plus the owned Normalized-file subtree) arrives with
 * the storage task; nothing here imports it.
 */
export interface ImageAccess {
  /**
   * Resolve one Image's current descriptor within `threadId`.
   *
   * Returns descriptors in any state, including `processing`; callers that must
   * hide internal Images (lookup, projections) map that state to their own
   * not-found result.
   */
  resolveImage(request: ImageAccessRequest): Promise<Result<ImageDescriptor, ImageAccessError>>;

  /**
   * Report current availability for one Image, applying expiry rules.
   *
   * Terminal states are successful results that describe why content cannot be
   * read; only `not_found` and operational failures are returned as errors.
   */
  getAvailability(
    request: ImageAccessRequest,
  ): Promise<Result<ImageAvailability, ImageAccessError>>;

  /**
   * Load the Normalized JPEG bytes used by one Inspection of one Image.
   *
   * Fails with `processing`, `rejected` (plus its reason), or `unavailable`
   * (plus its unavailability reason) whenever the content cannot be read.
   */
  fetchInspectionBytes(
    request: ImageAccessRequest,
  ): Promise<Result<ImageInspectionBytes, ImageAccessError>>;
}
