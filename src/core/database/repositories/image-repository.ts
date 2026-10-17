/**
 * Repository for the durable `images` ledger.
 *
 * An Image is the durable record of an accepted or rejected image Attachment. Its
 * globally unique id is owned by exactly one thread and one position within its
 * owning Message, and it survives the Normalized file it was produced from. The
 * receipt (`received_at`) is the moment of durable Admission on the local clock, so
 * it is stamped here and never accepted from a caller, a platform timestamp, or EXIF.
 *
 * Ledger rows are read without joining `messages`, so a Messages history cutoff or
 * retention purge can never hide an Image or its recovery work. Queue existence is
 * never consulted either: `queue_items` is not part of this repository.
 *
 * Rows are internal durable records. The public descriptor in
 * src/images/image-types.ts excludes recovery-only columns such as `source_ref`;
 * projecting a row to a descriptor is the image use-case layer's job.
 *
 * State and reason follow the closed vocabulary in src/images/image-types.ts:
 * `processing` is internal to Ingestion, `rejected` and `unavailable` are terminal
 * and final, and a late fetch, conversion, or model result can never overwrite them.
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';
import type {
  ImageRejectionReason,
  ImageState,
  ImageUnavailabilityReason,
} from '../../../images/image-types.js';

/** Default bound for a thread-scoped Image query. */
export const DEFAULT_IMAGE_LIMIT = 20;

/** Default bound for one expiry sweep. */
export const DEFAULT_SWEEP_LIMIT = 100;

/** Row shape matching the `images` table exactly. */
export interface ImageRow {
  id: string;
  message_id: string;
  ordinal: number;
  thread_id: string;
  /** Recovery-only provenance. Never projected onto a public descriptor. */
  source_ref: string;
  state: ImageState;
  rejection_reason: ImageRejectionReason | null;
  unavailability_reason: ImageUnavailabilityReason | null;
  filename: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  /** Validated `ImageExifMetadata` JSON, or null when unknown. */
  exif: string | null;
  /** Admission receipt on the local clock. Immovable. */
  received_at: number;
  expires_at: number;
  processing_deadline_at: number;
  attempt_count: number;
  updated_at: number;
}

/**
 * State an Admission may create.
 *
 * `processing` is the normal in-flight state. `rejected` is allowed at creation
 * because selection already decides some outcomes (oversized, over count, animated,
 * unsupported format) before any download or normalization happens. `available`
 * requires a published Normalized file and `unavailable` follows expiry or a missing
 * file, so neither can be created here.
 */
export type InsertableImageState = Extract<ImageState, 'processing' | 'rejected'>;

/** Fields accepted when inserting a new Image. */
export interface InsertImageInput {
  /** Globally unique Image id. A re-upload creates a different one. */
  id: string;
  messageId: string;
  ordinal: number;
  threadId: string;
  sourceRef: string;
  /** Defaults to `processing`. */
  state?: InsertableImageState;
  /** Required exactly when `state` is `rejected`. */
  rejectionReason?: ImageRejectionReason;
  filename?: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  /** Validated `ImageExifMetadata` JSON; never raw parser output. */
  exif?: string | null;
  /** When the Normalized file stops being retained. */
  expiresAt: number;
  /** Fixed post-admission normalization deadline for the owning message. */
  processingDeadlineAt: number;
}

/** Normalization result recorded when an Image becomes Available. */
export interface ImageAvailabilityMetadata {
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  /** Validated `ImageExifMetadata` JSON. */
  exif?: string | null;
}

/** Options for a thread-scoped Image query. */
export interface FindImagesOptions {
  /** Restrict to these states. Defaults to every state, including terminal ones. */
  states?: readonly ImageState[];
  /** Maximum rows. Defaults to `DEFAULT_IMAGE_LIMIT`. */
  limit?: number;
}

/**
 * Keyset position in a thread's Image page.
 *
 * `(receivedAt DESC, id ASC)` is the one ordering every inventory and lookup
 * sorts by, so an anchor is the pair that identifies the last delivered row.
 */
export interface ImageThreadPageAnchor {
  receivedAt: number;
  imageId: string;
}

/** Options for one thread-scoped keyset Image page read. */
export interface FindImageThreadPageOptions {
  threadId: string;
  /**
   * Restrict to these states. Defaults to every state; lookups narrow to the
   * non-Processing states because Processing is internal to Ingestion.
   */
  states?: readonly ImageState[];
  /** Maximum rows. Defaults to `DEFAULT_IMAGE_LIMIT`. */
  limit?: number;
  /**
   * Keyset position: return only the rows strictly after this anchor in
   * `(received_at DESC, id ASC)` order. Absent or null means the first page.
   */
  before?: ImageThreadPageAnchor | null;
}

/** One keyset page of a thread's Image rows. */
export interface ImageThreadPage {
  images: ImageRow[];
  /** Anchor to pass as `before` for the next page, or null when exhausted. */
  nextAnchor: ImageThreadPageAnchor | null;
}

interface MessageOwnerRow {
  thread_id: string;
  direction: 'inbound' | 'outbound';
}

/** Internal signal that a transactional callback produced an Err and must roll back. */
class LedgerRollback extends Error {
  constructor(readonly dbError: DbError) {
    super(dbError.message);
    this.name = 'LedgerRollback';
  }
}

/**
 * Runs a ledger transaction whose callback returns a Result.
 *
 * `BaseRepository.transaction` rolls back only when its callback throws, so an Err
 * returned from the middle of a multi-write sequence would otherwise COMMIT the
 * writes that did succeed. Every image-ledger transaction routes through this seam:
 * an Err becomes a rollback and the original DbError is restored at the boundary
 * instead of leaking an exception to callers.
 *
 * Nested use is safe — better-sqlite3 turns the nested call into a SAVEPOINT, so a
 * coordinator that wraps these repositories in its own transaction keeps authority
 * over the outer commit.
 */
export function runLedgerTransaction<T>(
  repo: BaseRepository,
  fn: () => Result<T, DbError>,
): Result<T, DbError> {
  try {
    const value = repo.transaction(() => {
      const result = fn();
      if (result.isErr()) {
        throw new LedgerRollback(result.error);
      }
      return result.value;
    });
    return ok(value);
  } catch (cause) {
    if (cause instanceof LedgerRollback) {
      return err(cause.dbError);
    }
    return err(
      new DbError(
        `Image ledger transaction failed: ${String(cause)}`,
        cause instanceof Error ? cause : undefined,
      ),
    );
  }
}

/** Maps a raw `images` row without mutation so sibling ledgers stay consistent. */
export function mapImageRow(row: ImageRow): ImageRow {
  return {
    id: row.id,
    message_id: row.message_id,
    ordinal: row.ordinal,
    thread_id: row.thread_id,
    source_ref: row.source_ref,
    state: row.state,
    rejection_reason: row.rejection_reason,
    unavailability_reason: row.unavailability_reason,
    filename: row.filename,
    mime_type: row.mime_type,
    width: row.width,
    height: row.height,
    exif: row.exif,
    received_at: row.received_at,
    expires_at: row.expires_at,
    processing_deadline_at: row.processing_deadline_at,
    attempt_count: row.attempt_count,
    updated_at: row.updated_at,
  };
}

/** Repository for the durable Image ledger. */
export class ImageRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly findByMessageStmt: Database.Statement;
  private readonly findThreadAllStmt: Database.Statement;
  private readonly findThreadStatesStmt = new Map<number, Database.Statement>();
  private readonly findThreadPageStmt = new Map<number, Database.Statement>();
  private readonly findThreadProcessingStmt: Database.Statement;
  private readonly findExpirableStmt: Database.Statement;
  private readonly incrementAttemptsStmt: Database.Statement;
  private readonly markAvailableStmt: Database.Statement;
  private readonly rejectStmt: Database.Statement;
  private readonly markUnavailableStmt: Database.Statement;
  private readonly messageOwnerStmt: Database.Statement;
  private readonly sourceRefStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO images
        (id, message_id, ordinal, thread_id, source_ref, state, rejection_reason,
         unavailability_reason, filename, mime_type, width, height, exif,
         received_at, expires_at, processing_deadline_at, attempt_count, updated_at)
      VALUES
        (@id, @message_id, @ordinal, @thread_id, @source_ref, @state, @rejection_reason,
         NULL, @filename, @mime_type, @width, @height, @exif,
         @received_at, @expires_at, @processing_deadline_at, 0, @updated_at)
    `);

    this.findByIdStmt = db.prepare(`SELECT * FROM images WHERE id = ?`);

    this.findByMessageStmt = db.prepare(`
      SELECT * FROM images WHERE message_id = ? ORDER BY ordinal ASC
    `);

    // Descriptor inventory and terminal-Image queries: newest receipt first, then id
    // ascending, which is the ordering every projection and lookup sorts by.
    this.findThreadAllStmt = db.prepare(`
      SELECT * FROM images
      WHERE thread_id = ?
      ORDER BY received_at DESC, id ASC
      LIMIT ?
    `);

    // Recovery reads in the order work was admitted: oldest receipt first.
    this.findThreadProcessingStmt = db.prepare(`
      SELECT * FROM images
      WHERE thread_id = @thread_id
        AND state = 'processing'
      ORDER BY received_at ASC, message_id ASC, ordinal ASC
      LIMIT @limit
    `);

    // Expiry takes precedence over any other unavailability, so candidates are every
    // Image whose content has not already gone terminal.
    this.findExpirableStmt = db.prepare(`
      SELECT * FROM images
      WHERE state IN ('processing', 'available')
        AND expires_at <= @now
      ORDER BY expires_at ASC, id ASC
      LIMIT @limit
    `);

    this.incrementAttemptsStmt = db.prepare(`
      UPDATE images
      SET attempt_count = attempt_count + 1, updated_at = @updated_at
      WHERE id = @id
        AND state = 'processing'
    `);

    // Availability carries the normalization result. The original receipt, expiry,
    // deadline, and attempt count are preserved.
    this.markAvailableStmt = db.prepare(`
      UPDATE images
      SET state = 'available',
          mime_type = COALESCE(@mime_type, mime_type),
          width = COALESCE(@width, width),
          height = COALESCE(@height, height),
          exif = COALESCE(@exif, exif),
          updated_at = @updated_at
      WHERE id = @id
        AND state = 'processing'
    `);

    this.rejectStmt = db.prepare(`
      UPDATE images
      SET state = 'rejected', rejection_reason = @rejection_reason, updated_at = @updated_at
      WHERE id = @id
        AND state = 'processing'
    `);

    this.markUnavailableStmt = db.prepare(`
      UPDATE images
      SET state = 'unavailable',
          unavailability_reason = @unavailability_reason,
          updated_at = @updated_at
      WHERE id = @id
        AND state IN ('processing', 'available')
    `);

    this.messageOwnerStmt = db.prepare(`
      SELECT thread_id, direction FROM messages WHERE id = ?
    `);

    this.sourceRefStmt = db.prepare(`SELECT id FROM image_source_messages WHERE id = ?`);
  }

  /**
   * Inserts one Image.
   *
   * Ownership is validated before the write: the Message must exist, be inbound, and
   * belong to the supplied thread, and the source reference must exist. The receipt
   * is stamped from the repository clock and cannot be supplied.
   */
  insert(input: InsertImageInput): Result<ImageRow, DbError> {
    const pairing = validateReasonPairing(
      input.state ?? 'processing',
      input.rejectionReason,
      input.id,
    );
    if (pairing.isErr()) {
      return err(pairing.error);
    }

    const owner = this.resolveOwnership(input.messageId, input.threadId);
    if (owner.isErr()) {
      return err(owner.error);
    }

    const knownSource = this.sourceExists(input.sourceRef);
    if (knownSource.isErr()) {
      return err(knownSource.error);
    }
    if (!knownSource.value) {
      return err(
        new DbError(`Failed to insert image ${input.id}: unknown source_ref "${input.sourceRef}"`),
      );
    }

    const ts = this.now();
    const row: ImageRow = {
      id: input.id,
      message_id: input.messageId,
      ordinal: input.ordinal,
      thread_id: input.threadId,
      source_ref: input.sourceRef,
      state: input.state ?? 'processing',
      rejection_reason: input.rejectionReason ?? null,
      unavailability_reason: null,
      filename: input.filename ?? null,
      mime_type: input.mimeType ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      exif: input.exif ?? null,
      received_at: ts,
      expires_at: input.expiresAt,
      processing_deadline_at: input.processingDeadlineAt,
      attempt_count: 0,
      updated_at: ts,
    };

    try {
      this.insertStmt.run(row);
      return ok(row);
    } catch (cause) {
      return err(this.fail('insert image', cause));
    }
  }

  /**
   * Inserts the ordered Images of one Message as a single SQLite transaction.
   *
   * A partial set must never be observable: either every Image of a message is
   * durable or none is, so Admission can key recovery off message identity.
   */
  insertMany(inputs: readonly InsertImageInput[]): Result<ImageRow[], DbError> {
    return runLedgerTransaction(this, () => {
      const rows: ImageRow[] = [];
      for (const input of inputs) {
        const result = this.insert(input);
        if (result.isErr()) {
          return err(result.error);
        }
        rows.push(result.value);
      }
      return ok(rows);
    });
  }

  /** Returns one Image by its globally unique id. */
  findById(id: string): Result<ImageRow | null, DbError> {
    try {
      const row = this.findByIdStmt.get(id) as ImageRow | undefined;
      return ok(row ? mapImageRow(row) : null);
    } catch (cause) {
      return err(this.fail('find image by id', cause));
    }
  }

  /** Returns every Image of a Message in source order, any state. */
  findByMessage(messageId: string): Result<ImageRow[], DbError> {
    try {
      const rows = this.findByMessageStmt.all(messageId) as ImageRow[];
      return ok(rows.map(mapImageRow));
    } catch (cause) {
      return err(this.fail('find images by message', cause));
    }
  }

  /**
   * Returns a thread's Images newest-receipt-first — the descriptor inventory and
   * terminal-Image query.
   *
   * Terminal Images are included unless `states` narrows the result, and nothing is
   * filtered by Message history, so an expired or Rejected Image stays reachable.
   */
  findByThread(threadId: string, options: FindImagesOptions = {}): Result<ImageRow[], DbError> {
    const states = options.states ?? [];
    const limit = options.limit ?? DEFAULT_IMAGE_LIMIT;
    try {
      const stmt = states.length === 0 ? this.findThreadAllStmt : this.statesStmt(states);
      const rows = (states.length === 0
        ? stmt.all(threadId, limit)
        : stmt.all(threadId, ...states, limit)) as ImageRow[];
      return ok(rows.map(mapImageRow));
    } catch (cause) {
      return err(this.fail('find images by thread', cause));
    }
  }

  /**
   * Returns one keyset page of a thread's Images, newest receipt first.
   *
   * The keyset condition keeps rows strictly after `(before.receivedAt, before.id)`
   * in `(received_at DESC, id ASC)` order, so pages never repeat or skip an Image
   * no matter how many share a receipt millisecond. One extra row is fetched to
   * decide exhaustion, which is why `nextAnchor` is null exactly when the result
   * is exhausted rather than when a page happens to be short.
   *
   * Like every other thread read, this never joins `messages`, so a history
   * cutoff or retention purge cannot hide an Image from a page.
   */
  findThreadPage(options: FindImageThreadPageOptions): Result<ImageThreadPage, DbError> {
    const states = options.states ?? [];
    const limit = options.limit ?? DEFAULT_IMAGE_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0) {
      return err(
        new DbError(
          `findThreadPage requires a positive integer limit, got ${String(options.limit)}`,
        ),
      );
    }

    try {
      const stmt = this.threadPageStmt(states);
      const bindings: Record<string, unknown> = {
        thread_id: options.threadId,
        before_received: options.before?.receivedAt ?? null,
        before_id: options.before?.imageId ?? null,
        // Exhaustion probe: one row beyond the requested page.
        limit: limit + 1,
      };
      states.forEach((state, index) => {
        bindings[`st${index}`] = state;
      });

      const rows = stmt.all(bindings) as ImageRow[];
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const last = pageRows[pageRows.length - 1];
      return ok({
        images: pageRows.map(mapImageRow),
        nextAnchor:
          hasMore && last !== undefined ? { receivedAt: last.received_at, imageId: last.id } : null,
      });
    } catch (cause) {
      return err(this.fail('find image thread page', cause));
    }
  }

  /**
   * Prepared statement for a keyset page, cached per state-filter arity.
   * Only placeholder names are generated, never values.
   */
  private threadPageStmt(states: readonly ImageState[]): Database.Statement {
    const cached = this.findThreadPageStmt.get(states.length);
    if (cached) {
      return cached;
    }
    const stateFilter =
      states.length === 0
        ? ''
        : `AND state IN (${states.map((_state, index) => `$st${index}`).join(', ')})`;
    const stmt = this.db.prepare(`
      SELECT * FROM images
      WHERE thread_id = @thread_id
        ${stateFilter}
        AND (
          @before_received IS NULL
          OR received_at < @before_received
          OR (received_at = @before_received AND id > @before_id)
        )
      ORDER BY received_at DESC, id ASC
      LIMIT @limit
    `);
    this.findThreadPageStmt.set(states.length, stmt);
    return stmt;
  }

  /**
   * Returns a thread's Processing Images in admission order — the recovery set for
   * restart, redelivery, and the periodic sweep.
   */
  findProcessingByThread(threadId: string, options: { limit?: number } = {}): Result<ImageRow[], DbError> {
    try {
      const rows = this.findThreadProcessingStmt.all({
        thread_id: threadId,
        limit: options.limit ?? DEFAULT_SWEEP_LIMIT,
      }) as ImageRow[];
      return ok(rows.map(mapImageRow));
    } catch (cause) {
      return err(this.fail('find processing images by thread', cause));
    }
  }

  /**
   * Returns Images whose expiry has elapsed but whose state is not yet terminal.
   *
   * Expiry is inclusive: an Image whose `expires_at` equals `now` is already past
   * retention. Callers resolve each one with `markUnavailable(id, 'expired')`.
   */
  findExpirable(
    options: { now?: number; limit?: number } = {},
  ): Result<ImageRow[], DbError> {
    try {
      const rows = this.findExpirableStmt.all({
        now: options.now ?? this.now(),
        limit: options.limit ?? DEFAULT_SWEEP_LIMIT,
      }) as ImageRow[];
      return ok(rows.map(mapImageRow));
    } catch (cause) {
      return err(this.fail('find expirable images', cause));
    }
  }

  /**
   * Records one started normalization attempt and returns the new count.
   *
   * Only real attempts count: redelivery, channel retry, and restart never call this,
   * so neither resets nor duplicates the persisted budget, and the count stays
   * independent of the queue item's own attempt counter. Errs when the Image is
   * unknown or already terminal, because a terminal Image is never re-attempted.
   */
  incrementAttempts(imageId: string): Result<number, DbError> {
    const existing = this.findById(imageId);
    if (existing.isErr()) {
      return err(existing.error);
    }
    if (existing.value === null) {
      return err(new DbError(`Failed to increment attempts: unknown image ${imageId}`));
    }
    if (existing.value.state !== 'processing') {
      return err(
        new DbError(
          `Failed to increment attempts: image ${imageId} is ${existing.value.state}`,
        ),
      );
    }

    try {
      const info = this.incrementAttemptsStmt.run({ id: imageId, updated_at: this.now() });
      if (info.changes === 0) {
        return err(
          new DbError(`Failed to increment attempts: image ${imageId} is no longer processing`),
        );
      }
      const updated = this.findById(imageId);
      if (updated.isErr()) {
        return err(updated.error);
      }
      if (updated.value === null) {
        return err(new DbError(`Failed to increment attempts: image ${imageId} vanished`));
      }
      return ok(updated.value.attempt_count);
    } catch (cause) {
      return err(this.fail('increment image attempts', cause));
    }
  }

  /**
   * Moves a Processing Image to Available with the normalization result.
   *
   * Absent metadata stays unknown rather than invented. A terminal Image is final, so
   * a late normalization result cannot revive it.
   */
  markAvailable(
    imageId: string,
    metadata: ImageAvailabilityMetadata = {},
  ): Result<ImageRow, DbError> {
    return this.transition(
      imageId,
      'processing',
      (ts) =>
        this.markAvailableStmt.run({
          id: imageId,
          mime_type: metadata.mimeType ?? null,
          width: metadata.width ?? null,
          height: metadata.height ?? null,
          exif: metadata.exif ?? null,
          updated_at: ts,
        }),
      'mark image available',
    );
  }

  /**
   * Rejects a Processing Image with exactly one reason from the closed vocabulary.
   *
   * Rejection is terminal: processing_interrupted, processing_failed, and every
   * selection-time reason all land here and cannot be overwritten afterwards.
   */
  reject(imageId: string, reason: ImageRejectionReason): Result<ImageRow, DbError> {
    return this.transition(
      imageId,
      'processing',
      (ts) => this.rejectStmt.run({ id: imageId, rejection_reason: reason, updated_at: ts }),
      'reject image',
    );
  }

  /**
   * Makes an Image's visual content unavailable with exactly one reason.
   *
   * Allowed from `processing` and `available` only. An already terminal Image keeps
   * the reason it recorded first, so expiry cannot replace a recorded
   * `file_missing`, and a late result cannot restore availability.
   */
  markUnavailable(imageId: string, reason: ImageUnavailabilityReason): Result<ImageRow, DbError> {
    const existing = this.findById(imageId);
    if (existing.isErr()) {
      return err(existing.error);
    }
    if (existing.value === null) {
      return err(new DbError(`Failed to mark image unavailable: unknown image ${imageId}`));
    }
    if (existing.value.state === 'unavailable' || existing.value.state === 'rejected') {
      return err(
        new DbError(
          `Failed to mark image unavailable: image ${imageId} already records ` +
            `${existing.value.unavailability_reason ?? existing.value.rejection_reason} ` +
            `(${existing.value.state})`,
        ),
      );
    }

    try {
      const info = this.markUnavailableStmt.run({
        id: imageId,
        unavailability_reason: reason,
        updated_at: this.now(),
      });
      if (info.changes === 0) {
        return err(
          new DbError(`Failed to mark image unavailable: image ${imageId} is no longer mutable`),
        );
      }
      return this.readAfter(imageId, 'mark image unavailable');
    } catch (cause) {
      return err(this.fail('mark image unavailable', cause));
    }
  }

  /**
   * Applies a guarded transition from `processing`, then re-reads the row.
   * The state guard is repeated inside the UPDATE so a concurrent expiry between the
   * read and the write cannot be overwritten.
   */
  private transition(
    imageId: string,
    expected: ImageState,
    run: (ts: number) => Database.RunResult,
    context: string,
  ): Result<ImageRow, DbError> {
    const existing = this.findById(imageId);
    if (existing.isErr()) {
      return err(existing.error);
    }
    if (existing.value === null) {
      return err(new DbError(`Failed to ${context}: unknown image ${imageId}`));
    }
    if (existing.value.state !== expected) {
      return err(
        new DbError(
          `Failed to ${context}: image ${imageId} is ${existing.value.state}, not ${expected}`,
        ),
      );
    }

    try {
      const info = run(this.now());
      if (info.changes === 0) {
        return err(new DbError(`Failed to ${context}: image ${imageId} is no longer ${expected}`));
      }
      return this.readAfter(imageId, context);
    } catch (cause) {
      return err(this.fail(context, cause));
    }
  }

  private readAfter(imageId: string, context: string): Result<ImageRow, DbError> {
    const row = this.findById(imageId);
    if (row.isErr()) {
      return err(row.error);
    }
    if (row.value === null) {
      return err(new DbError(`Failed to ${context}: image ${imageId} vanished`));
    }
    return ok(row.value);
  }

  /**
   * Validates that a caller-supplied thread matches the owning Message.
   * Images always have an owning Message, so a disagreement is always a bug.
   */
  private resolveOwnership(messageId: string, threadId: string): Result<true, DbError> {
    try {
      const owner = this.messageOwnerStmt.get(messageId) as MessageOwnerRow | undefined;
      if (!owner) {
        return err(new DbError(`Failed to insert image: unknown message ${messageId}`));
      }
      if (owner.direction !== 'inbound') {
        return err(
          new DbError(
            `Failed to insert image: message ${messageId} is ${owner.direction}, not inbound`,
          ),
        );
      }
      if (owner.thread_id !== threadId) {
        return err(
          new DbError(
            `Failed to insert image: message ${messageId} belongs to thread ${owner.thread_id}, ` +
              `not ${threadId}`,
          ),
        );
      }
      return ok(true);
    } catch (cause) {
      return err(this.fail('resolve image ownership', cause));
    }
  }

  /**
   * Prepared statement for a state filter, cached per filter arity.
   * Only placeholders are interpolated, never values.
   */
  private statesStmt(states: readonly ImageState[]): Database.Statement {
    const cached = this.findThreadStatesStmt.get(states.length);
    if (cached) {
      return cached;
    }
    const placeholders = states.map(() => '?').join(', ');
    const stmt = this.db.prepare(`
      SELECT * FROM images
      WHERE thread_id = ?
        AND state IN (${placeholders})
      ORDER BY received_at DESC, id ASC
      LIMIT ?
    `);
    this.findThreadStatesStmt.set(states.length, stmt);
    return stmt;
  }

  private sourceExists(sourceRef: string): Result<boolean, DbError> {
    try {
      const row = this.sourceRefStmt.get(sourceRef) as { id: string } | undefined;
      return ok(row !== undefined);
    } catch (cause) {
      return err(this.fail('check source reference', cause));
    }
  }

  private fail(context: string, cause: unknown): DbError {
    return new DbError(`Failed to ${context}: ${String(cause)}`, cause instanceof Error ? cause : undefined);
  }
}

/** Enforces "one reason in a terminal state, none otherwise" before SQL reaches CHECK. */
function validateReasonPairing(
  state: InsertableImageState,
  rejectionReason: ImageRejectionReason | undefined,
  imageId: string,
): Result<true, DbError> {
  if (state === 'rejected' && rejectionReason === undefined) {
    return err(
      new DbError(`Failed to insert image ${imageId}: a rejected image requires one reason`),
    );
  }
  if (state !== 'rejected' && rejectionReason !== undefined) {
    return err(
      new DbError(
        `Failed to insert image ${imageId}: a ${state} image must not carry a rejection reason`,
      ),
    );
  }
  return ok(true);
}
