/**
 * EXIF extraction for inbound images, performed **before** conversion.
 *
 * The input is the raw EXIF block that the decoder (sharp) surfaces alongside
 * image metadata; its shape varies by container:
 * - JPEG/WebP: the `Exif\0\0` prefix followed by the TIFF block.
 * - PNG (eXIf): the bare TIFF block, no prefix.
 *
 * Parsing follows inventory rows E8/E9: exifr parses the TIFF block with
 * `translateValues: false` and `reviveValues: false` so nothing is revived
 * into a JavaScript `Date` on the daemon's local timezone. Raw
 * `DateTimeOriginal` / `OffsetTimeOriginal` strings are kept verbatim, GPS
 * latitude/longitude are derived here from the DMS values plus their N/S and
 * E/W reference tags, and `GPSAltitudeRef` is mapped explicitly
 * (`0 = aboveSeaLevel`, `1 = belowSeaLevel`). Anything absent, malformed, or
 * out of range is omitted — a timezone or location is **never invented**.
 *
 * Parser output is untrusted and is only exposed through the local typed
 * validator below. Error messages never contain source bytes or raw parser
 * buffers.
 */

import { ok, err, type Result } from '../core/types/result.js';
import type {
  ImageExifMetadata,
  ImageGpsAltitudeRef,
  ImageGpsMetadata,
} from './image-types.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * EXIF extraction failures, split by disposition:
 *
 * - `malformed`: the EXIF block itself is broken (bad TIFF header, decoder
 *   rejection). Immediate — retrying cannot change the outcome. Callers map
 *   this to their own rejection vocabulary.
 * - `retryable`: the parser violated its output contract or failed in a way
 *   not attributable to the input bytes. Operational — a retry is permitted.
 */
export type ImageExifExtractionError =
  | { code: 'malformed'; retryable: false; message: string }
  | { code: 'retryable'; retryable: true; message: string };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The `Exif\0\0` block prefix used by JPEG/APP1 and WebP EXIF chunks. */
const EXIF_BLOCK_PREFIX = Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);

/** TIFF little-endian magic `II*\0`. */
const TIFF_LE_MAGIC = Buffer.from([0x49, 0x49, 0x2a, 0x00]);
/** TIFF big-endian magic `MM\0*`. */
const TIFF_BE_MAGIC = Buffer.from([0x4d, 0x4d, 0x00, 0x2a]);

/** Strip the `Exif\0\0` prefix when present (JPEG/WebP); PNG eXIf has none. */
export function stripExifBlockPrefix(exif: Buffer): Buffer {
  return exif.subarray(0, EXIF_BLOCK_PREFIX.length).equals(EXIF_BLOCK_PREFIX)
    ? exif.subarray(EXIF_BLOCK_PREFIX.length)
    : exif;
}

/**
 * Extract the approved EXIF subset ({@link ImageExifMetadata}) from a raw
 * decoder-supplied EXIF block.
 *
 * Returns `Ok(undefined)` when there is no EXIF or when no approved field was
 * present/parseable — absent metadata is a normal outcome, not an error.
 *
 * @param exif Raw EXIF block from `sharp` metadata (`undefined` when the
 *             decoder found none).
 */
export async function extractImageExif(
  exif: Buffer | undefined,
): Promise<Result<ImageExifMetadata | undefined, ImageExifExtractionError>> {
  if (exif === undefined || exif.length === 0) {
    return ok(undefined);
  }

  const tiff = stripExifBlockPrefix(exif);
  const magic = tiff.subarray(0, 4);
  if (tiff.length < 8 || !(magic.equals(TIFF_LE_MAGIC) || magic.equals(TIFF_BE_MAGIC))) {
    return err({
      code: 'malformed',
      retryable: false,
      message: 'EXIF block is not a valid TIFF structure',
    });
  }

  // Bounds-check the IFD0 offset: exifr silently returns an empty tag bag for
  // truncated TIFFs, so a structural check here is what surfaces truncation
  // as an immediate malformed failure.
  const ifd0Offset = magic.equals(TIFF_LE_MAGIC)
    ? tiff.readUInt32LE(4)
    : tiff.readUInt32BE(4);
  if (ifd0Offset < 8 || ifd0Offset + 2 > tiff.length) {
    return err({
      code: 'malformed',
      retryable: false,
      message: 'EXIF TIFF block is truncated (IFD0 offset outside the block)',
    });
  }

  let parsed: unknown;
  try {
    // Dynamic import keeps the ESM-only exifr parser out of the module graph
    // of anything that imports this file for its pure helpers.
    const exifr = (await import('exifr')).default;
    // exifr defaults to silentErrors: true and swallows directory-walk
    // failures into an `errors` bag (a truncated IFD entry then yields a
    // deceptively clean result). Disable silence so structural damage rejects
    // here and surfaces as an immediate malformed error. The option is
    // honored at runtime but missing from exifr 7.1.3's index.d.ts, hence
    // the cast.
    const parseOptions = {
      tiff: true,
      exif: true,
      gps: true,
      translateValues: false,
      reviveValues: false,
      silentErrors: false,
    };
    parsed = await exifr.parse(
      tiff,
      parseOptions as unknown as Parameters<typeof exifr.parse>[1],
    );
  } catch (cause) {
    // A rejection while decoding a header-valid block is a decoder failure
    // on fixed bytes: retrying would produce the identical failure.
    return err({
      code: 'malformed',
      retryable: false,
      message: `EXIF decoder rejected the TIFF block (${errorName(cause)})`,
    });
  }

  if (parsed === undefined || parsed === null) {
    // Header claimed a TIFF structure but the decoder read no directory out
    // of it: the block is broken, not merely empty (an absent EXIF block
    // never reaches the parser). Immediate — retrying cannot help.
    return err({
      code: 'malformed',
      retryable: false,
      message: 'EXIF decoder read no directory from the TIFF block',
    });
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err({
      code: 'retryable',
      retryable: true,
      message: 'EXIF parser returned an unexpected non-object result',
    });
  }
  if ('errors' in (parsed as Record<string, unknown>)) {
    // Belt and braces: exifr only attaches an `errors` key when something in
    // the parse failed. Even with silentErrors disabled, a parser variant
    // that returned one means the block is broken, not merely sparse.
    return err({
      code: 'malformed',
      retryable: false,
      message: 'EXIF decoder reported parse errors for the TIFF block',
    });
  }

  return ok(selectApprovedExif(parsed as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// Typed validation of untrusted parser output
// ---------------------------------------------------------------------------

/**
 * Narrow the loose exifr tag bag to the approved {@link ImageExifMetadata}
 * subset. Every field is validated; unknown tags are dropped, unparseable
 * approved tags are omitted. Returns `undefined` when nothing survived.
 */
export function selectApprovedExif(tags: Record<string, unknown>): ImageExifMetadata | undefined {
  const metadata: ImageExifMetadata = {};

  const capturedAt = asNonEmptyString(tags['DateTimeOriginal']);
  if (capturedAt !== undefined) {
    metadata.capturedAt = capturedAt;
  }

  const capturedAtOffset = asNonEmptyString(tags['OffsetTimeOriginal']);
  if (capturedAtOffset !== undefined) {
    metadata.capturedAtOffset = capturedAtOffset;
  }

  const make = asNonEmptyString(tags['Make']);
  if (make !== undefined) {
    metadata.cameraMake = make;
  }

  const model = asNonEmptyString(tags['Model']);
  if (model !== undefined) {
    metadata.cameraModel = model;
  }

  const orientation = asOrientation(tags['Orientation']);
  if (orientation !== undefined) {
    metadata.orientation = orientation;
  }

  const gps = selectGps(tags);
  if (gps !== undefined) {
    metadata.gps = gps;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/** Derive GPS position from the DMS + reference tags; omit anything unusable. */
export function selectGps(tags: Record<string, unknown>): ImageGpsMetadata | undefined {
  const latitude = toDecimalDegrees(
    tags['GPSLatitude'],
    asGpsLatitudeRef(tags['GPSLatitudeRef']),
    MAX_LATITUDE_DEGREES,
  );
  const longitude = toDecimalDegrees(
    tags['GPSLongitude'],
    asGpsLongitudeRef(tags['GPSLongitudeRef']),
    MAX_LONGITUDE_DEGREES,
  );
  if (latitude === undefined || longitude === undefined) {
    return undefined;
  }

  const gps: ImageGpsMetadata = { latitude, longitude };

  const altitude = asFiniteNumber(tags['GPSAltitude']);
  const refTag = asAltitudeRefValue(tags['GPSAltitudeRef']);
  if (altitude !== undefined && refTag !== 'invalid') {
    // `undefined` (tag absent) keeps the altitude with no claimed reference;
    // a present-but-unknown reference byte drops the altitude as well rather
    // than guessing a sea-level sign.
    gps.altitude = altitude;
    if (refTag !== undefined) {
      gps.altitudeRef = refTag;
    }
  }

  return gps;
}

/**
 * Map the EXIF `GPSAltitudeRef` byte explicitly: `0 = aboveSeaLevel`,
 * `1 = belowSeaLevel`. `undefined` means the tag was absent; `'invalid'`
 * means a present byte with an unknown value.
 */
export function mapGpsAltitudeRef(value: unknown): ImageGpsAltitudeRef | 'invalid' | undefined {
  const byte = asAltitudeRefValue(value);
  return byte === 'invalid' ? 'invalid' : byte;
}

/** Accept 0/1 from a raw byte, Uint8Array, or number; anything else is unusable. */
function asAltitudeRefValue(
  value: unknown,
): ImageGpsAltitudeRef | 'invalid' | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  let byte: unknown = value;
  if (ArrayBuffer.isView(value)) {
    const view = value as NodeJS.ArrayBufferView;
    if (view.byteLength === 0) {
      return 'invalid';
    }
    byte = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)[0];
  }
  if (byte === 0) {
    return 'aboveSeaLevel';
  }
  if (byte === 1) {
    return 'belowSeaLevel';
  }
  return 'invalid';
}

function asGpsLatitudeRef(value: unknown): 'north' | 'south' | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const ref = value.trim().toUpperCase();
  if (ref === 'N') {
    return 'north';
  }
  if (ref === 'S') {
    return 'south';
  }
  return undefined;
}

function asGpsLongitudeRef(value: unknown): 'east' | 'west' | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const ref = value.trim().toUpperCase();
  if (ref === 'E') {
    return 'east';
  }
  if (ref === 'W') {
    return 'west';
  }
  return undefined;
}

/** EXIF coordinate limits used to reject nonsense DMS values. */
const MAX_LATITUDE_DEGREES = 90;
const MAX_LONGITUDE_DEGREES = 180;

/**
 * Convert a GPS DMS tag (three rationals: degrees, minutes, seconds) to a
 * signed decimal degree value using the reference tag. Any unusable component
 * yields `undefined` — no defaulting.
 *
 * Component ranges are enforced consistently: degrees in `[0, maxDegrees]`,
 * minutes and seconds in `[0, 60)`; the summed decimal must not exceed
 * `maxDegrees` (latitude 90, longitude 180).
 */
export function toDecimalDegrees(
  dms: unknown,
  ref: 'north' | 'south' | 'east' | 'west' | undefined,
  maxDegrees: number = MAX_LONGITUDE_DEGREES,
): number | undefined {
  if (ref === undefined || !Array.isArray(dms) || dms.length !== 3) {
    return undefined;
  }
  const degrees = asRational(dms[0]);
  const minutes = asRational(dms[1]);
  const seconds = asRational(dms[2]);
  if (degrees === undefined || minutes === undefined || seconds === undefined) {
    return undefined;
  }
  if (
    degrees < 0 ||
    minutes < 0 ||
    seconds < 0 ||
    minutes >= 60 ||
    seconds >= 60 ||
    degrees > maxDegrees
  ) {
    return undefined;
  }
  const decimal = degrees + minutes / 60 + seconds / 3600;
  if (!Number.isFinite(decimal) || decimal > maxDegrees) {
    return undefined;
  }
  return ref === 'south' || ref === 'west' ? -decimal : decimal;
}

/** A TIFF rational is either a plain number or a `[numerator, denominator]` pair. */
function asRational(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    value[1] !== 0
  ) {
    const result = value[0] / value[1];
    return Number.isFinite(result) ? result : undefined;
  }
  return undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  const rational = asRational(value);
  return rational !== undefined && Number.isFinite(rational) ? rational : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asOrientation(value: unknown): number | undefined {
  const num = asFiniteNumber(value);
  if (num === undefined || !Number.isInteger(num)) {
    return undefined;
  }
  return num >= 1 && num <= 8 ? num : undefined;
}

function errorName(cause: unknown): string {
  return cause instanceof Error ? cause.name : 'unknown';
}
