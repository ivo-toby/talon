/**
 * Repository for the canonical Finding ledger (`findings` + `finding_images`).
 *
 * A Finding is the recorded answer of a successful Inspection. It is written
 * exactly once, atomically (row plus every source association, or nothing), and
 * it then survives everything the conversation layer forgets:
 *
 *   * a main run that failed, was cancelled, or is still pending — run status
 *     is never consulted on the read side;
 *   * Image expiry, rejection, and Normalized-file cleanup — availability is an
 *     Image property and never gates Finding retrieval;
 *   * message history cutoffs and context rotation — every query reads
 *     `findings`/`finding_images` only, never `messages` or `queue_items`;
 *   * queue-item purging — queue existence is never consulted here either.
 *
 * A Finding never creates a synthetic message, and `tool_results` is not
 * canonical storage: this repository writes no other table.
 *
 * Write boundary (trusted provenance):
 *   * `runId` must exist and `threadId` must equal the run's own `thread_id` —
 *     the same validate-then-refuse rule the Image ledger applies to its owning
 *     Message; a disagreement is rejected instead of trusted;
 *   * every source `imageId` must exist and belong to `threadId`;
 *   * the question, answer, winning model, and id are nonempty; `extractedText`
 *     and `uncertainty` are verbatim or absent, never empty strings;
 *   * reported usage fields are non-negative integers or absent.
 *
 * The canonical DTO (camelCase, verbatim text) lives in src/images/finding-types.ts;
 * this repository returns the row shape plus the association order.
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';
import { runLedgerTransaction } from './image-repository.js';

/** Default bound for one thread-scoped Finding page. */
export const DEFAULT_FINDING_LIMIT = 20;

/** Row shape matching the `findings` table exactly. */
export interface FindingRow {
  id: string;
  run_id: string;
  thread_id: string;
  question: string;
  answer: string;
  extracted_text: string | null;
  uncertainty: string | null;
  model_name: string;
  usage_input_tokens: number | null;
  usage_output_tokens: number | null;
  usage_cache_read_tokens: number | null;
  usage_cache_write_tokens: number | null;
  created_at: number;
}

/** Token usage exactly as the producing model reported it; absent = unknown. */
export interface FindingUsageInput {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Fields accepted when persisting one canonical Finding. */
export interface CreateFindingInput {
  /** Globally unique Finding id. */
  id: string;
  /** Trusted run provenance (from the Inspection's tool context). */
  runId: string;
  /** Trusted thread provenance; must equal the run's own thread. */
  threadId: string;
  /** Source Image IDs in the Inspection's own order. Nonempty and distinct. */
  imageIds: readonly string[];
  /** The Inspection question, verbatim. Nonempty. */
  question: string;
  /** The winning model's answer, verbatim. Nonempty. */
  answer: string;
  /** Verbatim extracted text, or null/absent when the model reported none. */
  extractedText?: string | null;
  /** Verbatim uncertainty statement, or null/absent when the model reported none. */
  uncertainty?: string | null;
  /** The vision model that actually produced this answer. Nonempty. */
  modelName: string;
  /** Reported token usage; absent fields are unknown, never estimated. */
  usage?: FindingUsageInput | null;
}

/** One canonical Finding read back: the row plus its source association order. */
export interface FindingRecord {
  finding: FindingRow;
  /** Source Image IDs in the order the Inspection listed them. */
  imageIds: string[];
}

/** Keyset position in the chronological page (creation descending, id ascending). */
export interface FindingPageAnchor {
  createdAt: number;
  id: string;
}

/** Options for a thread-scoped Finding page. */
export interface FindFindingsOptions {
  threadId: string;
  /** Restrict to Findings that reference this Image. */
  imageId?: string;
  /**
   * Keyset cursor: return only the rows strictly after this position in
   * `(created_at DESC, id ASC)` order. Absent = first page.
   */
  before?: FindingPageAnchor;
  /** Maximum rows. Defaults to `DEFAULT_FINDING_LIMIT`. */
  limit?: number;
}

/** One chronological page of Findings. */
export interface FindingPage {
  findings: FindingRecord[];
  /** Anchor for the next page, or null when the page exhausted the result. */
  nextAnchor: FindingPageAnchor | null;
}

interface RunOwnerRow {
  thread_id: string;
}

interface ImageOwnerRow {
  thread_id: string;
}

/** Maps a raw `findings` row without mutation so sibling ledgers stay consistent. */
export function mapFindingRow(row: FindingRow): FindingRow {
  return {
    id: row.id,
    run_id: row.run_id,
    thread_id: row.thread_id,
    question: row.question,
    answer: row.answer,
    extracted_text: row.extracted_text,
    uncertainty: row.uncertainty,
    model_name: row.model_name,
    usage_input_tokens: row.usage_input_tokens,
    usage_output_tokens: row.usage_output_tokens,
    usage_cache_read_tokens: row.usage_cache_read_tokens,
    usage_cache_write_tokens: row.usage_cache_write_tokens,
    created_at: row.created_at,
  };
}

/** Repository for the canonical Finding ledger. */
export class FindingRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly insertAssociationStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly findImageIdsStmt: Database.Statement;
  private readonly findPageStmt: Database.Statement;
  private readonly runOwnerStmt: Database.Statement;
  private readonly imageOwnerStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO findings
        (id, run_id, thread_id, question, answer, extracted_text, uncertainty,
         model_name, usage_input_tokens, usage_output_tokens,
         usage_cache_read_tokens, usage_cache_write_tokens, created_at)
      VALUES
        (@id, @run_id, @thread_id, @question, @answer, @extracted_text, @uncertainty,
         @model_name, @usage_input_tokens, @usage_output_tokens,
         @usage_cache_read_tokens, @usage_cache_write_tokens, @created_at)
    `);

    this.insertAssociationStmt = db.prepare(`
      INSERT INTO finding_images (finding_id, image_id, position)
      VALUES (@finding_id, @image_id, @position)
    `);

    this.findByIdStmt = db.prepare(`SELECT * FROM findings WHERE id = ?`);

    this.findImageIdsStmt = db.prepare(`
      SELECT image_id FROM finding_images WHERE finding_id = ? ORDER BY position ASC
    `);

    // Thread-scoped chronological keyset page. The keyset condition keeps rows
    // strictly after `(before.createdAt, before.id)` in (created_at DESC, id ASC)
    // order, so pages never repeat or skip a Finding no matter how many share a
    // timestamp. Nothing here touches `messages` or `queue_items`: history
    // cutoffs, purged queue items, and failed runs cannot hide a Finding.
    this.findPageStmt = db.prepare(`
      SELECT f.* FROM findings f
      WHERE f.thread_id = @thread_id
        AND (@image_id IS NULL OR EXISTS (
          SELECT 1 FROM finding_images fi
          WHERE fi.finding_id = f.id AND fi.image_id = @image_id
        ))
        AND (@before_created IS NULL
          OR f.created_at < @before_created
          OR (f.created_at = @before_created AND f.id > @before_id))
      ORDER BY f.created_at DESC, f.id ASC
      LIMIT @limit
    `);

    this.runOwnerStmt = db.prepare(`SELECT thread_id FROM runs WHERE id = ?`);
    this.imageOwnerStmt = db.prepare(`SELECT thread_id FROM images WHERE id = ?`);
  }

  /**
   * Persists one canonical Finding and its source associations atomically.
   *
   * Either the Finding row and every association are durable or none of it is:
   * the transaction rolls back on any validation or storage failure, so a
   * partially associated Finding can never be observed. All provenance checks
   * (run/thread ownership, per-Image same-thread ownership) run inside the
   * transaction and a failure returns a typed Result without throwing.
   *
   * The creation time is stamped from the repository clock and cannot be
   * supplied. Nested use is safe: a coordinator wrapping this in its own
   * transaction keeps authority over the outer commit.
   */
  create(input: CreateFindingInput): Result<FindingRecord, DbError> {
    return runLedgerTransaction(this, () => {
      const invalid = this.validateInput(input);
      if (invalid !== null) {
        return err(invalid);
      }

      const runOwner = this.readRunOwner(input.runId);
      if (runOwner.isErr()) {
        return err(runOwner.error);
      }
      if (runOwner.value === null) {
        return err(
          new DbError(`Failed to create finding ${input.id}: unknown run ${input.runId}`),
        );
      }
      if (runOwner.value.thread_id !== input.threadId) {
        return err(
          new DbError(
            `Failed to create finding ${input.id}: run ${input.runId} belongs to thread ` +
              `${runOwner.value.thread_id}, not ${input.threadId}`,
          ),
        );
      }

      for (const imageId of input.imageIds) {
        const imageOwner = this.readImageOwner(imageId);
        if (imageOwner.isErr()) {
          return err(imageOwner.error);
        }
        if (imageOwner.value === null) {
          return err(
            new DbError(`Failed to create finding ${input.id}: unknown image ${imageId}`),
          );
        }
        if (imageOwner.value.thread_id !== input.threadId) {
          return err(
            new DbError(
              `Failed to create finding ${input.id}: image ${imageId} belongs to thread ` +
                `${imageOwner.value.thread_id}, not ${input.threadId}`,
            ),
          );
        }
      }

      const ts = this.now();
      const usage = input.usage ?? null;
      const row: FindingRow = {
        id: input.id,
        run_id: input.runId,
        thread_id: input.threadId,
        question: input.question,
        answer: input.answer,
        extracted_text: input.extractedText ?? null,
        uncertainty: input.uncertainty ?? null,
        model_name: input.modelName,
        usage_input_tokens: usage?.inputTokens ?? null,
        usage_output_tokens: usage?.outputTokens ?? null,
        usage_cache_read_tokens: usage?.cacheReadTokens ?? null,
        usage_cache_write_tokens: usage?.cacheWriteTokens ?? null,
        created_at: ts,
      };

      try {
        this.insertStmt.run(row);
        for (const [position, imageId] of input.imageIds.entries()) {
          this.insertAssociationStmt.run({
            finding_id: input.id,
            image_id: imageId,
            position,
          });
        }
        return ok({ finding: mapFindingRow(row), imageIds: [...input.imageIds] });
      } catch (cause) {
        return err(this.fail('create finding', cause));
      }
    });
  }

  /**
   * Returns the exact canonical Finding by its globally unique id, with its
   * source Image IDs in Inspection order. Returns null when unknown.
   */
  findById(findingId: string): Result<FindingRecord | null, DbError> {
    const row = this.readFindingRow(findingId);
    if (row.isErr()) {
      return err(row.error);
    }
    if (row.value === null) {
      return ok(null);
    }
    return this.toRecord(row.value);
  }

  /**
   * Returns the exact canonical Finding only when it belongs to `threadId`.
   *
   * A Finding in another thread resolves to null — the same not-found answer as
   * an unknown id — so callers cannot probe Findings they do not own.
   */
  findByIdInThread(findingId: string, threadId: string): Result<FindingRecord | null, DbError> {
    const row = this.readFindingRow(findingId);
    if (row.isErr()) {
      return err(row.error);
    }
    if (row.value === null || row.value.thread_id !== threadId) {
      return ok(null);
    }
    return this.toRecord(row.value);
  }

  /**
   * Returns one chronological page of a thread's Findings, newest first.
   *
   * Keyset pagination: `before` positions the page strictly after the last row
   * the caller already received, in (created_at DESC, id ASC) order, so pages
   * are exact regardless of shared timestamps. An optional `imageId` restricts
   * the page to Findings that reference that Image.
   *
   * The query reads the Finding ledger only — no message, queue, or Image
   * availability join — so cutoffs, purged queue items, expired or Rejected
   * Images, and failed runs never change the result. `nextAnchor` is the anchor
   * to pass as `before` for the next page, or null when exhausted.
   */
  findPage(options: FindFindingsOptions): Result<FindingPage, DbError> {
    const limit = options.limit ?? DEFAULT_FINDING_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0) {
      return err(
        new DbError(
          `findPage requires a positive integer limit, got ${String(options.limit)}`,
        ),
      );
    }
    try {
      // Fetch one extra row to decide exhaustion without a second count query.
      const rows = this.findPageStmt.all({
        thread_id: options.threadId,
        image_id: options.imageId ?? null,
        before_created: options.before?.createdAt ?? null,
        before_id: options.before?.id ?? null,
        limit: limit + 1,
      }) as FindingRow[];

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const records: FindingRecord[] = [];
      for (const row of pageRows) {
        const record = this.toRecord(row);
        if (record.isErr()) {
          return err(record.error);
        }
        records.push(record.value);
      }

      return ok({
        findings: records,
        nextAnchor:
          hasMore && records.length > 0
            ? {
                createdAt: pageRows[pageRows.length - 1].created_at,
                id: pageRows[pageRows.length - 1].id,
              }
            : null,
      });
    } catch (cause) {
      return err(this.fail('find finding page', cause));
    }
  }

  private toRecord(row: FindingRow): Result<FindingRecord, DbError> {
    try {
      const imageIds = (
        this.findImageIdsStmt.all(row.id) as Array<{ image_id: string }>
      ).map((r) => r.image_id);
      return ok({ finding: mapFindingRow(row), imageIds });
    } catch (cause) {
      return err(this.fail('read finding associations', cause));
    }
  }

  private readFindingRow(findingId: string): Result<FindingRow | null, DbError> {
    try {
      const row = this.findByIdStmt.get(findingId) as FindingRow | undefined;
      return ok(row ? mapFindingRow(row) : null);
    } catch (cause) {
      return err(this.fail('find finding by id', cause));
    }
  }

  private readRunOwner(runId: string): Result<RunOwnerRow | null, DbError> {
    try {
      const row = this.runOwnerStmt.get(runId) as RunOwnerRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(this.fail('read run provenance', cause));
    }
  }

  private readImageOwner(imageId: string): Result<ImageOwnerRow | null, DbError> {
    try {
      const row = this.imageOwnerStmt.get(imageId) as ImageOwnerRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(this.fail('read image provenance', cause));
    }
  }

  /** Validates the input before any storage interaction; null when acceptable. */
  private validateInput(input: CreateFindingInput): DbError | null {
    const id = input.id;
    if (typeof id !== 'string' || id === '') {
      return new DbError('Failed to create finding: a nonempty finding id is required');
    }
    if (typeof input.runId !== 'string' || input.runId === '') {
      return new DbError('Failed to create finding: a trusted run id is required');
    }
    if (typeof input.threadId !== 'string' || input.threadId === '') {
      return new DbError('Failed to create finding: a trusted thread id is required');
    }
    if (
      !Number.isInteger(input.imageIds.length) ||
      input.imageIds.length === 0
    ) {
      return new DbError(`Failed to create finding ${id}: at least one source image is required`);
    }
    if (new Set(input.imageIds).size !== input.imageIds.length) {
      return new DbError(
        `Failed to create finding ${id}: source images must be distinct`,
      );
    }
    if (input.imageIds.some((imageId) => typeof imageId !== 'string' || imageId === '')) {
      return new DbError(`Failed to create finding ${id}: source image ids must be nonempty`);
    }
    if (typeof input.question !== 'string' || input.question === '') {
      return new DbError(`Failed to create finding ${id}: a nonempty question is required`);
    }
    if (typeof input.answer !== 'string' || input.answer === '') {
      return new DbError(`Failed to create finding ${id}: a nonempty answer is required`);
    }
    const optional = this.checkOptionalText(input.extractedText, 'extracted text', id);
    if (optional !== null) {
      return optional;
    }
    const uncertainty = this.checkOptionalText(input.uncertainty, 'uncertainty', id);
    if (uncertainty !== null) {
      return uncertainty;
    }
    if (typeof input.modelName !== 'string' || input.modelName === '') {
      return new DbError(`Failed to create finding ${id}: a nonempty producing model is required`);
    }
    const usage = input.usage ?? null;
    if (usage !== null) {
      for (const [field, value] of Object.entries(usage)) {
        if (value === undefined) {
          continue;
        }
        if (!Number.isInteger(value) || value < 0) {
          return new DbError(
            `Failed to create finding ${id}: reported usage field ${field} must be a ` +
              `non-negative integer, got ${String(value)}`,
          );
        }
      }
    }
    return null;
  }

  private checkOptionalText(
    value: string | null | undefined,
    field: string,
    findingId: string,
  ): DbError | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== 'string' || value === '') {
      return new DbError(
        `Failed to create finding ${findingId}: ${field} must be verbatim text or absent`,
      );
    }
    return null;
  }

  private fail(context: string, cause: unknown): DbError {
    return new DbError(`Failed to ${context}: ${String(cause)}`, cause instanceof Error ? cause : undefined);
  }
}
