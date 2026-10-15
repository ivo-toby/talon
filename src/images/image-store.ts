/**
 * Owned image files on the daemon filesystem.
 *
 * Two locations exist and nothing else may hold image payloads:
 *
 * - **Staging** — `{dataDir}/image-staging/{deliveryUuid}/`: durable,
 *   pre-admission source bytes keyed by delivery. Files here belong to a
 *   transport attempt and are removed by transport/Ingestion cleanup.
 * - **Normalized file** — `{dataDir}/threads/{threadId}/attachments/images/{imageId}.jpg`:
 *   the final, owned JPEG of an accepted Image inside the thread workspace
 *   (inventory I6).
 *
 * **User filenames are metadata, never path segments.** Every path this class
 * builds comes from Talon-generated identifiers (`deliveryUuid`, `imageId`) or
 * the thread ID — never from a channel-supplied filename. Identifiers are
 * additionally validated as single safe path segments.
 *
 * Publishing (making a staged/normalized file the thread's durable file) is a
 * synchronous rename exposed here as a primitive; the transaction guard that
 * authorizes publishing belongs to TASK-005.
 *
 * Errors are a plain discriminated union (matching `image-types.ts`), split
 * into immediate failures and operational `io` failures that may be retried.
 * Messages never contain file contents.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ok, err, type Result } from '../core/types/result.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Image store failures:
 *
 * - `invalid_id`: an identifier is not a single safe path segment. Immediate.
 * - `not_found`: the file or directory does not exist. Immediate for the
 *   current operation; recovery decisions belong to callers.
 * - `too_large`: actual bytes exceed the caller's bound. Immediate.
 * - `io`: filesystem failure not attributable to the request itself
 *   (permissions, disk, transient). Operationally retryable.
 */
export type ImageStoreError =
  | { code: 'invalid_id'; retryable: false; message: string }
  | { code: 'not_found'; retryable: false; message: string }
  | { code: 'too_large'; retryable: false; message: string }
  | { code: 'io'; retryable: true; message: string };

/** A staged source file written for one delivery attempt. */
export interface StagedSourceFile {
  /** Absolute path of the owned staging file. */
  path: string;
  /** Bytes actually written (measured, not declared). */
  size: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directory name for durable pre-admission staging under the data dir. */
export const IMAGE_STAGING_DIR = 'image-staging';

/** Fixed staging source filename — user filenames never enter paths. */
const STAGING_SOURCE_FILENAME = 'source.bin';

/** Subtree under the thread attachments directory for Normalized files. */
const THREAD_IMAGE_SUBTREE = path.join('images');

/** Normalized files are JPEG. */
const NORMALIZED_EXTENSION = '.jpg';

// ---------------------------------------------------------------------------
// Identifier validation
// ---------------------------------------------------------------------------

/**
 * Returns the segment when it is a single safe path segment, else `undefined`.
 * Rejects empty strings, `.`, `..`, separators, and NUL bytes so no identifier
 * can escape its parent directory.
 */
export function safePathSegment(value: string): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    return undefined;
  }
  return value;
}

// ---------------------------------------------------------------------------
// ImageStore
// ---------------------------------------------------------------------------

export class ImageStore {
  constructor(private readonly dataDir: string) {}

  // -------------------------------------------------------------------------
  // Path helpers (pure)
  // -------------------------------------------------------------------------

  /**
   * Absolute staging directory for one delivery attempt, or an
   * `invalid_id` error when `deliveryUuid` is not a safe single segment.
   */
  stagingDir(deliveryUuid: string): Result<string, ImageStoreError> {
    const segment = safePathSegment(deliveryUuid);
    if (segment === undefined) {
      return err({
        code: 'invalid_id',
        retryable: false,
        message: 'deliveryUuid is not a safe single path segment',
      });
    }
    return ok(path.join(this.dataDir, IMAGE_STAGING_DIR, segment));
  }

  /** Absolute staging source-file path for one delivery attempt. */
  stagingSourcePath(deliveryUuid: string): Result<string, ImageStoreError> {
    const dir = this.stagingDir(deliveryUuid);
    return dir.map((d) => path.join(d, STAGING_SOURCE_FILENAME));
  }

  /**
   * Absolute final Normalized-file path for one Image, or an `invalid_id`
   * error when `threadId`/`imageId` is not a safe single segment.
   */
  normalizedPath(threadId: string, imageId: string): Result<string, ImageStoreError> {
    const threadSegment = safePathSegment(threadId);
    const imageSegment = safePathSegment(imageId);
    if (threadSegment === undefined || imageSegment === undefined) {
      return err({
        code: 'invalid_id',
        retryable: false,
        message: 'threadId and imageId must be safe single path segments',
      });
    }
    return ok(
      path.join(
        this.dataDir,
        'threads',
        threadSegment,
        'attachments',
        THREAD_IMAGE_SUBTREE,
        imageSegment + NORMALIZED_EXTENSION,
      ),
    );
  }

  /** Absolute attachments/images directory for one thread. */
  threadImagesDir(threadId: string): Result<string, ImageStoreError> {
    const threadSegment = safePathSegment(threadId);
    if (threadSegment === undefined) {
      return err({
        code: 'invalid_id',
        retryable: false,
        message: 'threadId is not a safe single path segment',
      });
    }
    return ok(path.join(this.dataDir, 'threads', threadSegment, 'attachments', THREAD_IMAGE_SUBTREE));
  }

  // -------------------------------------------------------------------------
  // Byte loading / writing (async)
  // -------------------------------------------------------------------------

  /**
   * Load bytes from an owned file, bounded by `maxBytes`.
   *
   * The bound is enforced from the file size before reading and again on the
   * bytes actually read, so an oversized file never enters memory wholesale.
   */
  async readBounded(
    filePath: string,
    maxBytes: number,
  ): Promise<Result<Buffer, ImageStoreError>> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      return err({ code: 'invalid_id', retryable: false, message: 'maxBytes must be a positive integer' });
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (cause) {
      if (isNotFound(cause)) {
        return err({ code: 'not_found', retryable: false, message: 'file does not exist' });
      }
      return ioError(cause);
    }
    if (!stat.isFile()) {
      return err({ code: 'not_found', retryable: false, message: 'path is not a regular file' });
    }
    if (stat.size > maxBytes) {
      return err({
        code: 'too_large',
        retryable: false,
        message: `file exceeds the ${maxBytes} byte bound`,
      });
    }
    try {
      const buffer = await fs.promises.readFile(filePath);
      if (buffer.length > maxBytes) {
        return err({
          code: 'too_large',
          retryable: false,
          message: `read bytes exceed the ${maxBytes} byte bound`,
        });
      }
      return ok(buffer);
    } catch (cause) {
      if (isNotFound(cause)) {
        return err({ code: 'not_found', retryable: false, message: 'file does not exist' });
      }
      return ioError(cause);
    }
  }

  /**
   * Write source bytes into the delivery's staging directory under the fixed
   * `source.bin` name. Creates the staging directory when needed.
   */
  async writeStagingSource(
    deliveryUuid: string,
    bytes: Buffer,
  ): Promise<Result<StagedSourceFile, ImageStoreError>> {
    const dir = this.stagingDir(deliveryUuid);
    if (dir.isErr()) {
      return err(dir.error);
    }
    const filePath = path.join(dir.value, STAGING_SOURCE_FILENAME);
    try {
      await fs.promises.mkdir(dir.value, { recursive: true });
      await fs.promises.writeFile(filePath, bytes);
      return ok({ path: filePath, size: bytes.length });
    } catch (cause) {
      return ioError(cause);
    }
  }

  // -------------------------------------------------------------------------
  // Directory helpers (synchronous)
  // -------------------------------------------------------------------------

  /** Create the thread's `attachments/images` directory. Idempotent. */
  ensureThreadImagesDir(threadId: string): Result<string, ImageStoreError> {
    const dir = this.threadImagesDir(threadId);
    if (dir.isErr()) {
      return err(dir.error);
    }
    try {
      fs.mkdirSync(dir.value, { recursive: true });
      return ok(dir.value);
    } catch (cause) {
      return ioError(cause);
    }
  }

  /** Create the staging directory for one delivery. Idempotent. */
  ensureStagingDir(deliveryUuid: string): Result<string, ImageStoreError> {
    const dir = this.stagingDir(deliveryUuid);
    if (dir.isErr()) {
      return err(dir.error);
    }
    try {
      fs.mkdirSync(dir.value, { recursive: true });
      return ok(dir.value);
    } catch (cause) {
      return ioError(cause);
    }
  }

  // -------------------------------------------------------------------------
  // Publish / cleanup primitives (synchronous)
  // -------------------------------------------------------------------------

  /**
   * Synchronous rename primitive used when publishing a file. TASK-005 owns
   * the transaction guard that decides *when* publishing is authorized; this
   * only performs the filesystem operation.
   */
  rename(from: string, to: string): Result<void, ImageStoreError> {
    try {
      fs.renameSync(from, to);
      return ok(undefined);
    } catch (cause) {
      if (isNotFound(cause)) {
        return err({ code: 'not_found', retryable: false, message: 'source path does not exist' });
      }
      return ioError(cause);
    }
  }

  /**
   * Delete one file. Missing files are not an error (cleanup is idempotent).
   */
  removeFile(filePath: string): Result<void, ImageStoreError> {
    try {
      fs.rmSync(filePath, { force: true });
      return ok(undefined);
    } catch (cause) {
      return ioError(cause);
    }
  }

  /**
   * Remove a whole directory tree (used by transport/Ingestion staging
   * cleanup). Missing directories are not an error.
   */
  removeTree(dirPath: string): Result<void, ImageStoreError> {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return ok(undefined);
    } catch (cause) {
      return ioError(cause);
    }
  }

  /**
   * Remove the staging directory of one delivery, including any partial
   * source or attempt files. Missing staging is not an error.
   */
  removeStagingDir(deliveryUuid: string): Result<void, ImageStoreError> {
    const dir = this.stagingDir(deliveryUuid);
    if (dir.isErr()) {
      return err(dir.error);
    }
    return this.removeTree(dir.value);
  }

  /**
   * List delivery UUIDs that currently have staging directories (used by
   * orphaned-staging recovery sweeps). Returns an empty list when the
   * staging root does not exist; unreadable entries are skipped.
   */
  listStagingDeliveries(): string[] {
    try {
      const entries = fs.readdirSync(path.join(this.dataDir, IMAGE_STAGING_DIR), {
        withFileTypes: true,
      });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  /** True when the Normalized file for an Image currently exists. */
  normalizedExists(threadId: string, imageId: string): boolean {
    const filePath = this.normalizedPath(threadId, imageId);
    if (filePath.isErr()) {
      return false;
    }
    try {
      return fs.statSync(filePath.value).isFile();
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === 'ENOENT'
  );
}

function ioError(cause: unknown): Result<never, ImageStoreError> {
  return err({
    code: 'io',
    retryable: true,
    message: `image storage I/O failed (${cause instanceof Error ? cause.name : 'unknown'})`,
  });
}
