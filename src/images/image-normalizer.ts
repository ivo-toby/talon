/**
 * JPEG normalization: bounded, oriented, metadata-free outputs.
 *
 * Pipeline (inventory E10): auto-orient (including the mirroring
 * orientations) → fit-inside resize without enlargement or crop → white
 * flatten → JPEG encode at the requested quality. Sharp's JPEG encoder
 * strips EXIF/XMP/ICC by default (no `withMetadata`), so Normalized files
 * carry no source metadata.
 *
 * Format confirmation and animation detection happen **before** conversion
 * and use the decoder's own metadata only (inventory E6/E7) — there is no
 * separate signature/extension scanner:
 * - `metadata().format` must be jpeg, png, or webp.
 * - PNG: a bounds-checked chunk walk looks for `acTL`, because sharp reports
 *   neither pages nor animation for APNG. A single-frame APNG is still an
 *   animated image and is rejected.
 * - WebP: sharp's frame information (`pages`, `delay`) reflects the actual
 *   animation container; a frame count of exactly 1 with animation data is
 *   still animated and is rejected. A convertible first frame is never a
 *   static-image test.
 *
 * EXIF is extracted from the decoded metadata **before** conversion
 * (see `image-metadata.ts`); a malformed EXIF block never blocks conversion
 * of an otherwise decodable image — the EXIF is simply omitted.
 *
 * A native sharp timeout (integer seconds 1..3600, E11) supplements — but
 * cannot replace — the caller's outer persisted deadline: the native timer
 * starts at input processing and excludes waiting for a libuv thread. Every
 * await in the pipeline — metadata, EXIF, encode, AND the destination write
 * — is raced against the caller's signal so cancellation settles promptly.
 * A late sharp encode writes nothing (the file is only written after every
 * cancellation checkpoint); if the abort lands while the write is in
 * flight, cleanup attached to the write's eventual settlement removes any
 * bytes it lands.
 *
 * Encoding and filesystem writing are deliberately separated:
 * `pipeline.toBuffer()` runs the full conversion first, so ANY decoder or
 * encoder failure surfaces while sharp still owns the context (sharp's own
 * error text), and only then is the JPEG written via `fs`, whose failures
 * carry real errno codes (ENOSPC, EIO, EACCES, …) and classify as the
 * retryable `io` outcome. Sharp's `toFile()` cannot provide this: on a
 * post-open write failure (e.g. an attempt path symlinked to `/dev/full`)
 * it rejects with a plain Error without `code`/`errno`, indistinguishable
 * from content failures. Memory trade: the encoded JPEG is held in one
 * buffer between the stages — bounded by `maxEdge` and `jpegQuality` for
 * pixel area, with input bytes already bounded by the caller — while
 * libvips streams intermediate pixels either way, so peak usage is
 * dominated by the (bounded) final output.
 *
 * Results are `Result`s; errors never contain source bytes or raw buffers.
 */

import fs from 'node:fs';
import sharp from 'sharp';
import { ok, err, type Result } from '../core/types/result.js';
import type { ImageDimensions, ImageExifMetadata } from './image-types.js';
import { extractImageExif } from './image-metadata.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for one normalization attempt. */
export interface ImageNormalizationOptions {
  /** Longest output edge in pixels; aspect ratio preserved, never enlarged. */
  maxEdge: number;
  /** JPEG quality, 1–100. */
  jpegQuality: number;
  /**
   * Attempt-owned temporary file the Normalized JPEG is written to. The
   * caller owns this path (creation, publishing, and cleanup of leftovers).
   * The path is an opaque attempt-owned identifier — never a user filename
   * — so the write follows whatever the path currently is (including a
   * symlink); destination failures are reported as retryable `io`.
   */
  tempFilePath: string;
  /**
   * Native sharp timeout in whole seconds. Supplements the outer deadline;
   * must be a positive integer when provided.
   */
  timeoutSeconds?: number;
  /** Caller deadline/abort signal. Late output is fenced and discarded. */
  signal?: AbortSignal;
}

/** Successful normalization: where the JPEG went and what was learned. */
export interface ImageNormalizationResult {
  /** Absolute path of the written Normalized JPEG (the attempt temp file). */
  filePath: string;
  /** Output pixel dimensions after orientation and fit-inside resize. */
  dimensions: ImageDimensions;
  /** Source dimensions as decoded, before orientation and resize. */
  sourceDimensions: ImageDimensions;
  /** Selected EXIF from the source, extracted before conversion. */
  exif?: ImageExifMetadata;
}

/**
 * Normalization failures, split by disposition:
 *
 * Immediate (`retryable: false`):
 * - `unsupported_mime`: the decoder identifies a format outside
 *   JPEG/PNG/WebP.
 * - `animated`: animated PNG (acTL, including single-frame) or animated
 *   WebP (actual frame information).
 * - `conversion_failed`: the decoder cannot decode the input at all, or the
 *   encoder failed on fixed input.
 * - `invalid_options`: options violate the contract (not a config-vs-content
 *   failure; surfaced immediately).
 *
 * Operational (`retryable: true`):
 * - `timeout`: the native sharp timeout fired.
 * - `cancelled`: the caller's signal aborted the attempt.
 * - `io`: filesystem failure opening OR writing the attempt destination
 *   (missing directory, read-only path, ENOSPC/EIO disk errors, a
 *   symlinked destination that fails on write) — a valid image must still
 *   be retryable when only the destination is broken.
 */
export type ImageNormalizationError =
  | { code: 'unsupported_mime'; retryable: false; message: string }
  | { code: 'animated'; retryable: false; message: string }
  | { code: 'conversion_failed'; retryable: false; message: string }
  | { code: 'invalid_options'; retryable: false; message: string }
  | { code: 'timeout'; retryable: true; message: string }
  | { code: 'cancelled'; retryable: true; message: string }
  | { code: 'io'; retryable: true; message: string };

/** Formats the decoder is allowed to produce for an Image. */
const SUPPORTED_FORMATS = new Set(['jpeg', 'png', 'webp']);

/** PNG signature (fixed 8 bytes, PNG spec §11). */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize one source image into a bounded, oriented, metadata-free JPEG
 * written to the caller-owned temp file.
 *
 * @param source Decoded-source image bytes (already bounded by the caller).
 */
export async function normalizeImage(
  source: Buffer,
  options: ImageNormalizationOptions,
): Promise<Result<ImageNormalizationResult, ImageNormalizationError>> {
  const invalid = validateOptions(options);
  if (invalid !== undefined) {
    return err(invalid);
  }
  if (options.signal?.aborted) {
    return err({ code: 'cancelled', retryable: true, message: 'attempt aborted before start' });
  }

  // -- Decode metadata (this is the format validation; no side scanner) ----
  // Every await below runs inside cancellation fencing: an abort that lands
  // during metadata or EXIF work must report cancellation *before* the
  // encoder job is ever constructed.
  let metadata: sharp.Metadata;
  try {
    const metaOutcome = await awaitOrAbort(sharp(source).metadata(), options.signal);
    if (metaOutcome.type === 'aborted') {
      return cancelledError('attempt aborted during metadata decode');
    }
    if (metaOutcome.type === 'error') {
      return err(classifySharpError(metaOutcome.error, 'source could not be decoded'));
    }
    metadata = metaOutcome.value;
  } catch (cause) {
    // Synchronous failure constructing/starting the metadata read.
    return err(classifySharpError(cause, 'source could not be decoded'));
  }

  const format = metadata.format;
  if (format === undefined || !SUPPORTED_FORMATS.has(format)) {
    return err({
      code: 'unsupported_mime',
      retryable: false,
      message: `decoded image format is not supported (${String(format)})`,
    });
  }

  // `Metadata.buffer` (the decoder's input bytes) exists at runtime for
  // Buffer inputs but is missing from sharp's Metadata type in 0.34.5.
  const decodedInput: Buffer | undefined = (metadata as { buffer?: Buffer }).buffer;
  if (format === 'png' && hasPngAcTL(decodedInput ?? source)) {
    return err({
      code: 'animated',
      retryable: false,
      message: 'PNG declares animation via an acTL chunk',
    });
  }
  if (format === 'webp' && webpHasAnimation(metadata)) {
    return err({
      code: 'animated',
      retryable: false,
      message: 'WebP container carries animation frame information',
    });
  }

  const width = metadata.width;
  const height = metadata.height;
  if (width === undefined || height === undefined) {
    return err({
      code: 'conversion_failed',
      retryable: false,
      message: 'decoder reported no image dimensions',
    });
  }

  // -- EXIF before conversion (malformed EXIF never blocks conversion) ----
  const exifOutcome = await awaitOrAbort(extractImageExif(metadata.exif), options.signal);
  if (exifOutcome.type === 'aborted') {
    return cancelledError('attempt aborted during EXIF extraction');
  }
  const exifResult = exifOutcome.type === 'ok' ? exifOutcome.value : undefined;
  // A malformed EXIF block never blocks conversion; the EXIF is omitted.
  const exif = exifResult !== undefined && exifResult.isOk() ? exifResult.value : undefined;

  // Final checkpoint: never start the encoder for an already-cancelled attempt.
  if (options.signal?.aborted) {
    return cancelledError('attempt aborted before conversion started');
  }

  // -- Normalize -----------------------------------------------------------
  // Pipeline configuration (including sharp's synchronous timeout bounds)
  // is contained: a synchronous throw becomes a typed invalid_options Result,
  // never a rejection out of normalizeImage. Encode to a buffer FIRST so
  // every decoder/encoder failure is sharp's, and the file write is ours
  // (real errno classification; see the module header trade-off).
  let encodePromise: Promise<{ info: sharp.OutputInfo; data: Buffer }>;
  try {
    let pipeline = sharp(source)
      .autoOrient()
      .resize(options.maxEdge, options.maxEdge, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: options.jpegQuality });
    if (options.timeoutSeconds !== undefined) {
      pipeline = pipeline.timeout({ seconds: options.timeoutSeconds });
    }
    encodePromise = pipeline.toBuffer({ resolveWithObject: true });
  } catch (cause) {
    return err({
      code: 'invalid_options',
      retryable: false,
      message: `sharp rejected the pipeline configuration (${errorName(cause)})`,
    });
  }
  const outcome = options.signal
    ? await raceWithAbort(encodePromise, options.signal)
    : await settle(encodePromise);

  if (outcome.type === 'aborted') {
    // The late sharp encode has no destination: nothing is written after
    // cancellation, so there is nothing to discard here either.
    return cancelledError('attempt aborted during normalization');
  }
  // The signal may fire between settle and resumption; the output is then
  // no longer admissible even though sharp finished first — never write it.
  if (options.signal?.aborted) {
    return cancelledError('attempt aborted as normalization finished');
  }
  if (outcome.type === 'error') {
    return err(
      classifySharpError(outcome.error, 'image could not be converted to JPEG'),
    );
  }

  const info = outcome.value.info;
  if (info.format !== 'jpeg' || info.width === undefined || info.height === undefined) {
    return err({
      code: 'conversion_failed',
      retryable: false,
      message: 'encoder did not report a JPEG output with dimensions',
    });
  }

  // -- Write the encoded JPEG to the attempt destination -------------------
  // Content failures are exhausted at this point, so every writeFile
  // failure is a destination filesystem problem with a real errno. The
  // write is raced against cancellation like every other await: an aborted
  // attempt settles PROMPTLY, and cleanup is attached to the eventual
  // in-flight write settlement (its output must not survive: if it
  // resolved, the file is removed; if it rejected, nothing was written).
  let writePromise: Promise<void>;
  try {
    writePromise = fs.promises.writeFile(options.tempFilePath, outcome.value.data);
  } catch (cause) {
    // Synchronous launch failure on the destination.
    discardTemp(options.tempFilePath);
    return err(classifyWriteError(cause));
  }
  const writeOutcome = options.signal
    ? await raceWithAbort(writePromise, options.signal)
    : await settle(writePromise);

  if (writeOutcome.type === 'aborted') {
    // Only the abort branch returns a Result. The settlement branch below
    // performs cleanup exclusively — a write failing after this point must
    // not double-classify the already-returned cancellation.
    void writePromise.then(
      () => discardTemp(options.tempFilePath),
      () => discardTemp(options.tempFilePath),
    );
    return cancelledError('attempt aborted while the output was being written');
  }
  if (writeOutcome.type === 'error') {
    // A partial write may exist; it is not admissible output.
    discardTemp(options.tempFilePath);
    return err(classifyWriteError(writeOutcome.error));
  }
  // The abort may land between the write settling and our resumption; the
  // bytes are then no longer admissible even though the write succeeded.
  if (options.signal?.aborted) {
    discardTemp(options.tempFilePath);
    return cancelledError('attempt aborted as the output finished writing');
  }

  return ok({
    filePath: options.tempFilePath,
    dimensions: { width: info.width, height: info.height },
    sourceDimensions: { width, height },
    ...(exif !== undefined ? { exif } : {}),
  });
}

// ---------------------------------------------------------------------------
// Animation detection (decoder metadata + bounds-checked PNG chunk walk)
// ---------------------------------------------------------------------------

/**
 * Animated WebP via actual frame information: libvips reports `pages`/
 * `delay` only for animated containers, and a single-frame animation still
 * reports them (pages === 1 with a delay entry). Static WebP reports
 * neither.
 */
export function webpHasAnimation(metadata: sharp.Metadata): boolean {
  return metadata.pages !== undefined || metadata.delay !== undefined;
}

/**
 * Bounds-checked PNG chunk walk looking for an `acTL` chunk (E7).
 *
 * `acTL` declares animation regardless of frame count — a valid
 * single-frame APNG is an animated image and sharp's metadata reports no
 * `pages` for it, so the chunk walk is the detection. Malformed framing
 * stops the walk without treating the file as animated (the subsequent
 * decode fails as `conversion_failed`).
 */
export function hasPngAcTL(buffer: Buffer): boolean {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return false;
  }
  // Chunks: 4-byte length, 4-byte type, data, 4-byte CRC. A chunk only
  // counts when it is COMPLETE (length prefix, type, declared payload, and
  // CRC all fit inside the file); a truncated acTL header is broken framing,
  // not an animation declaration, and the subsequent decode surfaces the
  // damage as conversion_failed.
  const MAX_CHUNK_LENGTH = 0x7fffffff; // signed int32 ceiling; guards readUInt32BE overflow
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > MAX_CHUNK_LENGTH) {
      return false;
    }
    // Full chunk bounds (8 header + payload + 4 CRC) validated BEFORE the
    // type is interpreted.
    const next = offset + 12 + length;
    if (next <= offset || next > buffer.length) {
      // Truncated or non-monotonic framing: stop; not provably animated.
      return false;
    }
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    if (type === 'acTL') {
      return true;
    }
    if (type === 'IEND') {
      return false;
    }
    offset = next;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateOptions(
  options: ImageNormalizationOptions,
): ImageNormalizationError | undefined {
  if (!Number.isInteger(options.maxEdge) || options.maxEdge < 1) {
    return { code: 'invalid_options', retryable: false, message: 'maxEdge must be a positive integer' };
  }
  if (!Number.isInteger(options.jpegQuality) || options.jpegQuality < 1 || options.jpegQuality > 100) {
    return { code: 'invalid_options', retryable: false, message: 'jpegQuality must be an integer from 1 to 100' };
  }
  if (typeof options.tempFilePath !== 'string' || options.tempFilePath.length === 0) {
    return { code: 'invalid_options', retryable: false, message: 'tempFilePath is required' };
  }
  // Sharp's native timeout accepts 1..3600 whole seconds and throws
  // synchronously above 3600 (node_modules/sharp/lib/output.js); validate the
  // upper bound so out-of-range configuration is a typed invalid_options
  // result rather than an exception.
  if (
    options.timeoutSeconds !== undefined &&
    (!Number.isInteger(options.timeoutSeconds) ||
      options.timeoutSeconds < 1 ||
      options.timeoutSeconds > 3600)
  ) {
    return {
      code: 'invalid_options',
      retryable: false,
      message: 'timeoutSeconds must be an integer from 1 to 3600',
    };
  }
  return undefined;
}

type Settled<T> = { type: 'ok'; value: T } | { type: 'error'; error: unknown } | { type: 'aborted' };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { type: 'ok', value: await promise };
  } catch (error) {
    return { type: 'error', error };
  }
}

/**
 * Await `work` unless the signal is (or becomes) aborted. An already-aborted
 * signal short-circuits before the work is given any more of the attempt.
 */
async function awaitOrAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<Settled<T>> {
  return signal === undefined ? settle(work) : raceWithAbort(work, signal);
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<Settled<T>> {
  if (signal.aborted) {
    // Abort landed before registration (e.g. during a preceding await);
    // registering a listener now would never fire.
    return { type: 'aborted' };
  }
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      settle(promise),
      new Promise<Settled<T>>((resolve): void => {
        onAbort = (): void => resolve({ type: 'aborted' });
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

function discardTemp(tempFilePath: string): void {
  try {
    fs.rmSync(tempFilePath, { force: true });
  } catch {
    // Best effort: leftover cleanup belongs to the attempt owner anyway.
  }
}

/**
 * Map a sharp failure to the error vocabulary. Sharp's timeout errors are
 * operational (retryable); anything else on fixed bytes is a conversion
 * failure. Message text is sharp's own — never source bytes.
 */
function classifySharpError(
  cause: unknown,
  fallbackMessage: string,
): ImageNormalizationError {
  const message = cause instanceof Error ? cause.message : '';
  if (/timeout/i.test(message)) {
    return { code: 'timeout', retryable: true, message: 'sharp native timeout' };
  }
  return {
    code: 'conversion_failed',
    retryable: false,
    message: `${fallbackMessage} (${truncateSafe(message)})`,
  };
}

/**
 * Classify a failure from the destination write stage. Because encoding
 * completed successfully, content defects are already exhausted: ANY
 * writeFile failure is a destination filesystem problem (ENOENT, ENOTDIR,
 * EACCES, EROFS, ENOSPC — including a post-open ENOSPC such as a symlinked
 * attempt path pointing at `/dev/full` — EIO, EDQUOT, EFBIG, EMFILE, …)
 * and therefore the retryable `io` outcome. Node's fs errors carry the real
 * errno in `code`; the message includes it, never source bytes.
 */
export function classifyWriteError(cause: unknown): ImageNormalizationError {
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? String((cause as { code?: unknown }).code)
      : '';
  const detail = code.length > 0 ? code : truncateSafe(cause instanceof Error ? cause.message : '');
  return {
    code: 'io',
    retryable: true,
    message: `normalized output could not be written (${detail})`,
  };
}

function cancelledError(message: string): Result<never, ImageNormalizationError> {
  return err({ code: 'cancelled', retryable: true, message });
}

function errorName(cause: unknown): string {
  return cause instanceof Error ? cause.name : 'unknown';
}

function truncateSafe(message: string): string {
  const firstLine = message.split('\n', 1)[0] ?? '';
  return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
}
