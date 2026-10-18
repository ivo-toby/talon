/**
 * ImageService — the runtime implementation of the TASK-001 `ImageAccess`
 * port against the real Image repository and durable image store.
 *
 * Responsibilities:
 * - Thread-scoped resolution: an Image from another thread is
 *   indistinguishable from an unknown Image (`not_found`).
 * - Durable availability refresh on read: an Available Image past its
 *   `expires_at` (counted from the original durable Admission receipt) is
 *   transitioned to `Unavailable(expired)` and its normalized file removed
 *   BEFORE any other condition is considered. Only afterwards may a missing
 *   file establish `file_missing`. Recorded terminal reasons are never
 *   overwritten, and a late read never restores availability of deleted
 *   content.
 * - Inspection bytes come only from the durable normalized JPEG — never a
 *   source path, staging reference, or channel credential.
 *
 * Privacy: errors and logs carry identifiers and sanitized reasons only —
 * never pixels, URLs, filesystem paths, or download handles.
 */

import fs from 'node:fs';
import { ok, err } from '../core/types/result.js';
import type { Result } from '../core/types/result.js';
import type { AuditEntry, AuditStore } from '../core/logging/audit-logger.js';
import type {
  ImageAccess,
  ImageAccessError,
  ImageAvailability,
  ImageDescriptor,
  ImageExifMetadata,
  ImageInspectionBytes,
} from './image-types.js';
import type {
  ImageRepository,
  ImageRow,
} from '../core/database/repositories/image-repository.js';
import type { ImageStore } from './image-store.js';
import type pino from 'pino';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Upper bound for a single inspection read. Normalized JPEGs are produced
 * by our own encoder from inputs capped at `maxInputBytes`, but the
 * ENCODED output is not bounded by the input size (an input-compressed
 * source can decompress past the input cap), so inspection reads are sized
 * to the actual file up to this generous ceiling instead of reusing the
 * transport-level `maxInputBytes` admission limit (P2-6).
 */
export const IMAGE_INSPECTION_READ_CEILING_BYTES = 64 * 1024 * 1024;

export interface ImageServiceDeps {
  imageRepo: ImageRepository;
  store: ImageStore;
  logger: pino.Logger;
  /**
   * Shared audit store (P2-7): read-triggered durable mutations — expiry /
   * file_missing transitions and the normalized-file deletion they cause —
   * are audited through the same store as the lifecycle sweep.
   */
  auditStore?: AuditStore;
  /** Clock for expiry evaluation; injectable for deterministic tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ImageService implements ImageAccess {
  private readonly deps: ImageServiceDeps;
  private readonly clock: () => number;

  constructor(deps: ImageServiceDeps) {
    this.deps = deps;
    this.clock = deps.now ?? ((): number => Date.now());
  }

  // -------------------------------------------------------------------------
  // ImageAccess port
  // -------------------------------------------------------------------------

  resolveImage(request: {
    threadId: string;
    imageId: string;
  }): Promise<Result<ImageDescriptor, ImageAccessError>> {
    return Promise.resolve(
      this.resolve(request).andThen((row): Result<ImageDescriptor, ImageAccessError> =>
        ok(this.toDescriptor(row)),
      ),
    );
  }

  getAvailability(request: {
    threadId: string;
    imageId: string;
  }): Promise<Result<ImageAvailability, ImageAccessError>> {
    return Promise.resolve(
      this.resolve(request).andThen((row): Result<ImageAvailability, ImageAccessError> =>
        ok(this.toAvailability(row)),
      ),
    );
  }

  async fetchInspectionBytes(request: {
    threadId: string;
    imageId: string;
  }): Promise<Result<ImageInspectionBytes, ImageAccessError>> {
    const resolution = this.resolve(request);
    if (resolution.isErr()) return err(resolution.error);
    const row = resolution.value;

    if (row.state !== 'available') {
      return err(this.notAvailableError(row));
    }

    const pathResult = this.deps.store.normalizedPath(row.thread_id, row.id);
    if (pathResult.isErr()) {
      return err({ code: 'storage_failed', message: 'failed to resolve normalized image path' });
    }

    // Size the read to the actual (immutable, already-published) file, up
    // to the inspection ceiling — never to the input-admission cap, which
    // is not a bound on encoded output (P2-6).
    const size = this.normalizedSize(pathResult.value);
    if (size === null) {
      this.deps.logger.warn(
        { imageId: row.id, op: 'inspection_stat', code: 'STAT_FAILED' },
        'image inspection byte stat failed',
      );
      return err({ code: 'storage_failed', message: 'failed to read normalized image bytes' });
    }

    const read = await this.deps.store.readBounded(
      pathResult.value,
      Math.min(size, IMAGE_INSPECTION_READ_CEILING_BYTES),
    );
    if (read.isErr()) {
      // The refresh above confirmed the file moments ago; a failure here is a
      // genuine storage fault. Never echo the path or the underlying cause
      // message — structured code only (P2-5).
      this.deps.logger.warn(
        { imageId: row.id, op: 'inspection_read', code: read.error.code },
        'image inspection byte read failed',
      );
      return err({ code: 'storage_failed', message: 'failed to read normalized image bytes' });
    }

    return ok({
      imageId: row.id,
      bytes: read.value,
      mimeType: 'image/jpeg',
      expiresAt: row.expires_at,
    });
  }

  // -------------------------------------------------------------------------
  // Shared resolution with durable availability refresh
  // -------------------------------------------------------------------------

  /**
   * Loads the row thread-scoped and applies the durable transition order:
   * expiry first (from the original `expires_at`), then file existence.
   */
  private resolve(request: {
    threadId: string;
    imageId: string;
  }): Result<ImageRow, ImageAccessError> {
    if (
      request === null ||
      typeof request?.imageId !== 'string' ||
      typeof request?.threadId !== 'string'
    ) {
      return err({ code: 'not_found', message: 'image reference is not resolvable' });
    }

    const found = this.deps.imageRepo.findById(request.imageId);
    if (found.isErr()) {
      return err({ code: 'storage_failed', message: 'failed to load image record' });
    }
    const row = found.value;
    // Cross-thread ids and unknown ids are indistinguishable by design.
    if (row === null || row.thread_id !== request.threadId) {
      return err({ code: 'not_found', message: 'image not found in this thread' });
    }

    return this.refreshAvailability(row);
  }

  /**
   * Durably transitions a stale Available row. Expiry is evaluated BEFORE
   * file existence so an expired-with-missing-file row records `expired`
   * once and forever. Terminal states are returned untouched.
   */
  private refreshAvailability(row: ImageRow): Result<ImageRow, ImageAccessError> {
    if (row.state !== 'available') {
      return ok(row);
    }

    const now = this.clock();
    if (now >= row.expires_at) {
      const marked = this.deps.imageRepo.markUnavailable(row.id, 'expired');
      if (marked.isErr()) {
        return err({ code: 'storage_failed', message: 'failed to record image expiry' });
      }
      // A read that mutates is audited like any other durable transition
      // (P2-7). Identifiers and closed-vocabulary reasons only.
      this.audit('image.availability.expired', { imageId: row.id });
      this.deps.logger.info(
        { imageId: row.id, threadId: row.thread_id, reason: 'expired' },
        'image availability transitioned to unavailable',
      );
      // Best-effort file removal; a failure is retried by the lifecycle
      // sweep and never resurrects availability.
      this.deleteNormalizedFile(row);
      return this.reread(row.id);
    }

    if (!this.deps.store.normalizedExists(row.thread_id, row.id)) {
      const marked = this.deps.imageRepo.markUnavailable(row.id, 'file_missing');
      if (marked.isErr()) {
        return err({ code: 'storage_failed', message: 'failed to record missing image file' });
      }
      this.audit('image.availability.file_missing', { imageId: row.id });
      this.deps.logger.warn(
        { imageId: row.id, threadId: row.thread_id, reason: 'file_missing' },
        'image availability transitioned to unavailable',
      );
      return this.reread(row.id);
    }

    return ok(row);
  }

  private reread(imageId: string): Result<ImageRow, ImageAccessError> {
    const found = this.deps.imageRepo.findById(imageId);
    if (found.isErr() || found.value === null) {
      return err({ code: 'storage_failed', message: 'failed to reload image record' });
    }
    return ok(found.value);
  }

  private deleteNormalizedFile(row: ImageRow): void {
    const pathResult = this.deps.store.normalizedPath(row.thread_id, row.id);
    if (pathResult.isErr()) {
      this.audit('image.cleanup.failed', {
        imageId: row.id,
        kind: 'expired_output',
        code: pathResult.error.code,
      });
      return;
    }
    const removed = this.deps.store.removeFile(pathResult.value);
    if (removed.isErr()) {
      // Structured code only; the cause message may embed the path (P2-5).
      this.audit('image.cleanup.failed', {
        imageId: row.id,
        kind: 'expired_output',
        code: removed.error.code,
      });
      this.deps.logger.warn(
        { imageId: row.id, op: 'expired_output_remove', code: removed.error.code },
        'normalized image file removal failed; lifecycle sweep will retry',
      );
      return;
    }
    this.audit('image.cleanup', {
      imageId: row.id,
      kind: 'expired_output',
      deleted: true,
    });
  }

  /** Actual size of the immutable published file; null when unreadable. */
  private normalizedSize(target: string): number | null {
    try {
      const stat = fs.statSync(target);
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  }

  private audit(action: string, details: Record<string, unknown>): void {
    if (!this.deps.auditStore) return;
    const entry: AuditEntry = { action, details };
    this.deps.auditStore.append(entry);
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private notAvailableError(row: ImageRow): ImageAccessError {
    switch (row.state) {
      case 'processing':
        return { code: 'processing', message: 'image is still being processed' };
      case 'rejected':
        return {
          code: 'rejected',
          rejectionReason: row.rejection_reason ?? 'unsupported_mime',
        };
      default:
        return {
          code: 'unavailable',
          unavailabilityReason: row.unavailability_reason ?? 'expired',
        };
    }
  }

  private toAvailability(row: ImageRow): ImageAvailability {
    switch (row.state) {
      case 'available':
        return { state: 'available', available: true, expiresAt: row.expires_at };
      case 'processing':
        return { state: 'processing', available: false };
      case 'rejected':
        return {
          state: 'rejected',
          available: false,
          rejectionReason: row.rejection_reason ?? 'unsupported_mime',
        };
      default:
        return {
          state: 'unavailable',
          available: false,
          unavailabilityReason: row.unavailability_reason ?? 'expired',
        };
    }
  }

  private toDescriptor(row: ImageRow): ImageDescriptor {
    const base = {
      imageId: row.id,
      threadId: row.thread_id,
      messageId: row.message_id,
      ordinal: row.ordinal,
      receivedAt: row.received_at,
      expiresAt: row.expires_at,
      filename: row.filename ?? undefined,
      mimeType: row.mime_type ?? undefined,
      dimensions: readDimensions(row),
      exif: readExif(row),
    };
    switch (row.state) {
      case 'processing':
        return { ...base, state: 'processing' };
      case 'available':
        return { ...base, state: 'available' };
      case 'rejected':
        return {
          ...base,
          state: 'rejected',
          rejectionReason: row.rejection_reason ?? 'unsupported_mime',
        };
      default:
        return {
          ...base,
          state: 'unavailable',
          unavailabilityReason: row.unavailability_reason ?? 'expired',
        };
    }
  }
}

function readDimensions(row: ImageRow): { width: number; height: number } | undefined {
  if (typeof row.width === 'number' && typeof row.height === 'number') {
    return { width: row.width, height: row.height };
  }
  return undefined;
}

function readExif(row: ImageRow): ImageExifMetadata | undefined {
  if (row.exif === null || row.exif === undefined) return undefined;
  try {
    const parsed = JSON.parse(row.exif) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ImageExifMetadata;
    }
  } catch {
    /* stored EXIF is unreadable: descriptor simply omits it */
  }
  return undefined;
}
