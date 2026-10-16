/**
 * Image Ingestion coordinator — atomic admission, inline Processing, and
 * durable completion for image-bearing inbound messages.
 *
 * Consumed by MessagePipeline through the {@link ImageIngestionService} port;
 * TASK-010 additionally drives {@link ImageIngestionCoordinator.recoverPending}
 * from startup and periodic recovery passes.
 *
 * Core semantics (spec part (a), ordered recovery table):
 *
 * - **Atomic admission.** For an image-bearing message the authoritative
 *   message (channel-scoped idempotency identity), its ordered Images, and its
 *   pending Ingestion (or its terminal admission record when unrouted) commit
 *   in ONE synchronous SQLite transaction; the message row is inserted before
 *   the Image rows. Repository Errs are translated to rollback only inside the
 *   transaction adapter ({@link runLedgerTransaction}) and caught at the public
 *   boundary as typed {@link PipelineError}s. Nothing is awaited inside a
 *   transaction: source staging happens before it, processing after it. A
 *   rolled-back admission therefore can never strand an owning message without
 *   its recovery record.
 * - **One owner per message.** Duplicate delivery joins the committed owner:
 *   committed IDs, deadlines, and outcomes are reused; a usable redelivered
 *   source is adopted only for still-Processing work; newly downloaded
 *   duplicate staging is removed. Completed or intentionally unrouted
 *   duplicates never enqueue, including after the queue item was purged.
 *   Every Processing entrypoint — fresh admission, redelivery adoption, and
 *   recovery — claims the same exclusive in-process ownership synchronously
 *   before doing any work and releases it when it finishes.
 * - **Bounded Processing.** Attempts increment before each conversion, capped
 *   at {@link MAX_ATTEMPTS_PER_IMAGE} per Image and
 *   {@link IMAGE_PROCESSING_DEADLINE_MS} total from admission, with the
 *   admission clock (expiry + deadline) started at the synchronous admission
 *   boundary AFTER staging, so downloads never consume processing budget.
 *   Ordered guards — expiry first, then exhausted deadline/attempts — are
 *   reapplied before every attempt and after every awaited phase, so a
 *   result that crosses a boundary resolves expired/processing_failed,
 *   never Available. Resolved states are never normalized again.
 * - **Fenced publication.** A Normalized file becomes the thread's durable
 *   file only inside a guarded synchronous rename + DB transaction that
 *   re-checks Processing state, attempt ownership, the message deadline, and
 *   the Image expiry BEFORE the rename and again AFTER it (filesystem
 *   operations can straddle the deadline); a DB failure reverts the rename
 *   and late output is discarded. Rename/commit crash remnants are accepted
 *   only for still-admissible work and carry the attempt metadata persisted
 *   before the rename.
 * - **Commit-together completion.** After all outcomes resolve, availability
 *   is refreshed and the conditional enqueue plus Ingestion completion commit
 *   atomically via {@link QueueManager.enqueueWithCommit}; the success log
 *   fires only after the outer transaction commits. Completion payloads are
 *   rebuilt from committed rows only: the stored Message and the route
 *   persisted with the Ingestion — never a redelivery's request view or a
 *   re-resolved current binding.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type pino from 'pino';
import { ok, err, type Result } from '../core/types/result.js';
import { DbError, PipelineError } from '../core/errors/index.js';
import type {
  Attachment,
  InboundAttachment,
  InboundAttachmentRejection,
} from '../channels/channel-types.js';
import type { ImagesConfig } from '../core/config/config-types.js';
import type { ChannelRepository } from '../core/database/repositories/channel-repository.js';
import type { ThreadRepository } from '../core/database/repositories/thread-repository.js';
import type { MessageRepository } from '../core/database/repositories/message-repository.js';
import type {
  ImageRow,
  ImageAvailabilityMetadata,
  InsertImageInput,
} from '../core/database/repositories/image-repository.js';
import { runLedgerTransaction } from '../core/database/repositories/image-repository.js';
import type {
  ImageIngestionRepository,
  ImageIngestionRow,
} from '../core/database/repositories/image-ingestion-repository.js';
import type { QueueManager } from '../queue/queue-manager.js';
import type { ImageStore } from './image-store.js';
import { normalizeImage } from './image-normalizer.js';
import type { ImageRejectionReason } from './image-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed normalization deadline for an entire message, from admission. */
export const IMAGE_PROCESSING_DEADLINE_MS = 60_000;

/** Fixed normalization attempts per Image, from admission. */
export const MAX_ATTEMPTS_PER_IMAGE = 3;

/**
 * Durable publication record written into the Image's staging directory
 * BEFORE the normalized file is renamed into place. A crash between rename
 * and commit leaves it behind so recovery commits the remnant with its real
 * dimensions/EXIF instead of blanks.
 */
const PUBLISH_META_FILENAME = 'publish-meta.json';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Outcome of one image-bearing inbound message through the pipeline. */
export type ImageIngestionOutcome = 'enqueued' | 'duplicate' | 'no_persona';

/**
 * One image-bearing inbound message handed to the coordinator by the pipeline.
 * All identities are trusted pipeline context (resolved channel row, canonical
 * thread), never extracted from message content.
 */
export interface ImageIngestionRequest {
  /** Channel row id — scopes the message idempotency key. */
  channelId: string;
  /** Connector instance name — provenance of the recovery source reference. */
  channelName: string;
  /** Channel-stable message identity (the InboundEvent idempotency key). */
  externalMessageId: string;
  /** External chat id (the InboundEvent external thread id). */
  externalChatId: string;
  /** Canonical thread the message is admitted into. */
  threadId: string;
  /** Canonical message to persist; authoritative on first admission. */
  message: {
    id: string;
    content: string;
    senderId: string;
    idempotencyKey: string;
  };
  /** Attachments in source order: payload or closed metadata-only rejection. */
  attachments: readonly InboundAttachment[];
  /**
   * Resolved persona, or null when the message is intentionally unrouted.
   * Persisted with the Ingestion as the admitted route; completion payloads
   * are rebuilt from committed rows, never carried on this request.
   */
  personaId: string | null;
}

/** Port consumed by MessagePipeline; implemented by the coordinator. */
export interface ImageIngestionService {
  ingestMessage(request: ImageIngestionRequest): Promise<Result<ImageIngestionOutcome, PipelineError>>;
}

/** Report of one recovery pass over pending Ingestion. */
export interface RecoveryReport {
  /** Pending Ingestion rows inspected. */
  inspected: number;
  /** Ingestions whose completion (enqueue + mark complete) committed. */
  enqueued: number;
  /** Skipped: active owner, or no persisted route to rebuild completion from. */
  skipped: number;
  /** Failed: operational errors; the Ingestion stays pending for the next pass. */
  failed: number;
}

/** Scope and bound for {@link ImageIngestionCoordinator.recoverPending}. */
export interface RecoverPendingOptions {
  threadId?: string;
  messageId?: string;
  limit?: number;
}

/** Dependencies of the coordinator. All DB writes share one connection. */
export interface ImageIngestionDeps {
  messageRepo: MessageRepository;
  imageRepo: import('../core/database/repositories/image-repository.js').ImageRepository;
  ingestionRepo: ImageIngestionRepository;
  queueManager: QueueManager;
  store: ImageStore;
  threadRepo: ThreadRepository;
  channelRepo: ChannelRepository;
  imagesConfig: ImagesConfig;
  logger: pino.Logger;
  /** Injectable clock for deterministic deadline/expiry tests. */
  now?: () => number;
  /** Injectable normalizer for deterministic tests (defaults to Sharp). */
  normalize?: typeof normalizeImage;
}

/** Pre-admission plan for one delivered Attachment, in source order. */
interface AttachmentPlan {
  ordinal: number;
  /** Talon-generated Image id; the staging directory key for payload plans. */
  imageId: string;
  rejectionReason: ImageRejectionReason | null;
  filename: string | null;
  mimeType: string | null;
}

/** Outcome of the synchronous admission transaction. */
type AdmissionOutcome =
  | { kind: 'admitted'; messageId: string; images: ImageRow[] }
  | { kind: 'unrouted'; messageId: string }
  | { kind: 'duplicate'; messageId: string; ingestion: ImageIngestionRow | null; images: ImageRow[] };

/** Outcome of one guarded publication attempt. */
type PublishOutcome = { kind: 'committed' } | { kind: 'fenced' } | { kind: 'late' };

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/**
 * Durable Ingestion coordinator.
 *
 * Holds no per-message state beyond the in-process active-owner set, which
 * prevents an overlapping connector callback (or a recovery pass) from
 * competing with the one active owner of a message. The set is in-memory on
 * purpose: a crash must release ownership so the next delivery or restart
 * can resume from the committed ledger.
 */
export class ImageIngestionCoordinator implements ImageIngestionService {
  private readonly activeOwners = new Set<string>();
  private readonly normalize: typeof normalizeImage;

  constructor(private readonly deps: ImageIngestionDeps) {
    this.normalize = deps.normalize ?? normalizeImage;
  }

  /**
   * Runs image-bearing message Ingestion end to end: staging, atomic
   * admission, inline Processing to terminal outcomes, and the commit-together
   * enqueue + completion. Never throws; all failures are typed Results.
   */
  async ingestMessage(
    request: ImageIngestionRequest,
  ): Promise<Result<ImageIngestionOutcome, PipelineError>> {
    try {
      return await this.ingestInternal(request);
    } catch (cause) {
      return err(this.unexpectedError('image ingestion failed', cause));
    }
  }

  /**
   * Recovers pending Ingestion (startup, redelivery, periodic sweep) without
   * competing with an active in-process owner. Resolves remaining Processing
   * Images from the ledger and retained staging only, then completes the
   * commit-together enqueue + completion exactly once.
   */
  async recoverPending(
    options: RecoverPendingOptions = {},
  ): Promise<Result<RecoveryReport, PipelineError>> {
    try {
      const pending = this.deps.ingestionRepo.findPending(options);
      if (pending.isErr()) {
        return err(this.dbErrorToPipeline(pending.error, 'find pending ingestion'));
      }
      const report: RecoveryReport = { inspected: 0, enqueued: 0, skipped: 0, failed: 0 };
      for (const row of pending.value) {
        report.inspected++;
        // Recovery claims the same exclusive per-message ownership as the
        // delivery paths before touching any work.
        if (!this.tryAcquireOwnership(row.message_id)) {
          report.skipped++;
          continue;
        }
        try {
          const context = this.buildCompletionContext(row.message_id);
          if (context.isErr()) {
            this.deps.logger.warn(
              { messageId: row.message_id, reason: context.error.message },
              'image ingestion: cannot rebuild completion context; leaving pending',
            );
            report.skipped++;
            continue;
          }
          const processing = await this.processPendingImages(row.message_id);
          if (processing.isErr()) {
            report.failed++;
            continue;
          }
          const finish = this.finishIngestion(
            row.message_id,
            context.value.threadId,
            context.value.payload,
          );
          if (finish.isErr()) {
            report.failed++;
            continue;
          }
          report.enqueued++;
        } finally {
          this.activeOwners.delete(row.message_id);
        }
      }
      return ok(report);
    } catch (cause) {
      return err(this.unexpectedError('image ingestion recovery failed', cause));
    }
  }

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  private async ingestInternal(
    request: ImageIngestionRequest,
  ): Promise<Result<ImageIngestionOutcome, PipelineError>> {
    // Staging happens BEFORE the admission transaction: nothing is awaited
    // inside SQLite transactions, and rolled-back admission or duplicate
    // delivery must clean these newly downloaded bytes.
    const plans = await this.planAndStageAttachments(request.attachments);
    const cleanupNewStaging = (): void => {
      for (const plan of plans) {
        if (plan.rejectionReason === null) {
          this.deps.store.removeStagingDir(plan.imageId);
        }
      }
    };

    // The common admission clock starts AFTER staging, at the synchronous
    // admission boundary: expiry and the processing deadline are fixed
    // together here, so slow downloads never consume post-admission budget
    // and a slow staging pass cannot turn fresh work into an
    // already-exhausted admission.
    const now = this.clock();
    const expiresAt = now + this.retentionMs();
    const deadlineAt = now + IMAGE_PROCESSING_DEADLINE_MS;

    const admission = runLedgerTransaction(this.deps.ingestionRepo, () =>
      this.admit(request, deadlineAt, expiresAt, plans),
    );
    if (admission.isErr()) {
      // Atomic admission rollback: no message, no Images, no Ingestion —
      // nothing to strand. Staged bytes are orphans now; remove them.
      cleanupNewStaging();
      return err(this.dbErrorToPipeline(admission.error, 'image admission failed'));
    }

    const outcome = admission.value;
    if (outcome.kind === 'unrouted') {
      cleanupNewStaging();
      return ok('no_persona');
    }

    if (outcome.kind === 'duplicate') {
      // Completed or intentionally unrouted duplicates never queue,
      // including after the queue item was purged.
      const unrouted =
        outcome.ingestion === null &&
        this.admissionRecordExists(outcome.messageId);
      if (
        (outcome.ingestion !== null && outcome.ingestion.status === 'completed') ||
        unrouted
      ) {
        cleanupNewStaging();
        return ok('duplicate');
      }
      // Resumed work claims the SAME exclusive per-message ownership as
      // fresh admission; an overlapping delivery joins the active owner
      // instead of adopting, processing, or cleaning up alongside it. The
      // joiner's new bytes live in staging keyed by its own freshly
      // generated ids, so dropping them cannot disturb the owner's files.
      if (!this.tryAcquireOwnership(outcome.messageId)) {
        cleanupNewStaging();
        return ok('duplicate');
      }
      try {
        // Resume with committed IDs/deadlines/attempts; adopt a usable
        // redelivered source only for still-Processing Images.
        this.adoptRedeliveredSource(outcome.images, plans);
        return await this.processAndFinish(outcome.messageId, 'duplicate');
      } finally {
        this.activeOwners.delete(outcome.messageId);
      }
    }

    // First durable admission: this delivery owns the Processing work.
    if (!this.tryAcquireOwnership(outcome.messageId)) {
      // Unreachable in practice (the ledger row was created moments ago);
      // joining is the safe reading if an owner somehow exists.
      cleanupNewStaging();
      return ok('duplicate');
    }
    try {
      return await this.processAndFinish(outcome.messageId, 'enqueued');
    } finally {
      this.activeOwners.delete(outcome.messageId);
    }
  }

  /**
   * Synchronous admission body (runs inside one SQLite transaction via
   * {@link runLedgerTransaction}): persist/load the authoritative message
   * under its channel-scoped idempotency key, insert it BEFORE the Image
   * rows, then write either the unrouted admission record or the ordered
   * Images plus pending Ingestion. Every Err rolls the whole transaction.
   */
  private admit(
    request: ImageIngestionRequest,
    deadlineAt: number,
    expiresAt: number,
    plans: readonly AttachmentPlan[],
  ): Result<AdmissionOutcome, DbError> {
    const { messageRepo, ingestionRepo, imageRepo } = this.deps;

    const insert = messageRepo.insert({
      id: request.message.id,
      thread_id: request.threadId,
      direction: 'inbound',
      content: request.message.content,
      idempotency_key: `${request.channelId}:${request.message.idempotencyKey}`,
      provider_id: request.message.senderId,
      run_id: null,
    });
    if (insert.isErr()) {
      return err(insert.error);
    }
    const authoritative = insert.value;

    // INSERT OR IGNORE deduplication: a different authoritative id means this
    // is a redelivery of the same channel-scoped message.
    if (authoritative.id !== request.message.id) {
      const ingestion = ingestionRepo.findByMessage(authoritative.id);
      if (ingestion.isErr()) {
        return err(ingestion.error);
      }
      const images = imageRepo.findByMessage(authoritative.id);
      if (images.isErr()) {
        return err(images.error);
      }
      return ok({
        kind: 'duplicate',
        messageId: authoritative.id,
        ingestion: ingestion.value,
        images: images.value,
      });
    }

    if (request.personaId === null) {
      const record = ingestionRepo.insertTerminalAdmission({
        messageId: authoritative.id,
        threadId: request.threadId,
        channel: request.channelName,
        reason: 'no_binding',
      });
      if (record.isErr()) {
        return err(record.error);
      }
      return ok({ kind: 'unrouted', messageId: authoritative.id });
    }

    const source = ingestionRepo.resolveSourceMessage({
      channel: request.channelName,
      externalMessageId: request.externalMessageId,
      externalChatId: request.externalChatId,
    });
    if (source.isErr()) {
      return err(source.error);
    }

    const inserts: InsertImageInput[] = plans.map((plan) => {
      const input: InsertImageInput = {
        id: plan.imageId,
        messageId: authoritative.id,
        ordinal: plan.ordinal,
        threadId: request.threadId,
        sourceRef: source.value.id,
        state: plan.rejectionReason === null ? 'processing' : 'rejected',
        filename: plan.filename,
        mimeType: plan.mimeType,
        expiresAt,
        processingDeadlineAt: deadlineAt,
      };
      if (plan.rejectionReason !== null) {
        input.rejectionReason = plan.rejectionReason;
      }
      return input;
    });

    const images = imageRepo.insertMany(inserts);
    if (images.isErr()) {
      return err(images.error);
    }
    // The routed Admission's persona is committed WITH the pending
    // Ingestion: completion (this delivery, a redelivery, or recovery)
    // enqueues under this route, never under a later binding state.
    const pending = ingestionRepo.createPending({
      messageId: authoritative.id,
      threadId: request.threadId,
      personaId: request.personaId,
    });
    if (pending.isErr()) {
      return err(pending.error);
    }
    return ok({ kind: 'admitted', messageId: authoritative.id, images: images.value });
  }

  /**
   * Processing + completion; maps completion onto the delivery outcome.
   *
   * The completion payload is rebuilt from COMMITTED state — the stored
   * Message row and the route persisted with the Ingestion — never from the
   * delivery's own request view: resumed and redelivered completions must
   * enqueue the exact durable message identity and content under the route
   * Admission committed.
   */
  private async processAndFinish(
    messageId: string,
    outcome: ImageIngestionOutcome,
  ): Promise<Result<ImageIngestionOutcome, PipelineError>> {
    const processing = await this.processPendingImages(messageId);
    if (processing.isErr()) {
      // Operational DB failure: the committed message keeps its pending
      // Ingestion, so recovery re-runs this when writes resume.
      return err(processing.error);
    }
    const context = this.buildCompletionContext(messageId);
    if (context.isErr()) {
      return err(context.error);
    }
    const finish = this.finishIngestion(messageId, context.value.threadId, context.value.payload);
    if (finish.isErr()) {
      return err(finish.error);
    }
    return ok(outcome);
  }

  // -------------------------------------------------------------------------
  // Processing (recovery precedence)
  // -------------------------------------------------------------------------

  /**
   * Resolves every still-Processing Image of the message, in source order,
   * under the committed deadline. Resolved states are skipped untouched:
   * resolved Images are never normalized again.
   */
  private async processPendingImages(messageId: string): Promise<Result<void, PipelineError>> {
    const imagesResult = this.deps.imageRepo.findByMessage(messageId);
    if (imagesResult.isErr()) {
      return err(this.dbErrorToPipeline(imagesResult.error, 'read pending images'));
    }
    const images = imagesResult.value;
    if (images.length === 0) {
      return ok(undefined);
    }
    const threadId = images[0].thread_id;
    const deadlineAt = Math.max(...images.map((image) => image.processing_deadline_at));
    const timer = this.armDeadlineAbort(deadlineAt);
    try {
      for (const image of images) {
        if (image.state !== 'processing') {
          continue;
        }
        const result = await this.resolveImageOutcome(image, threadId, timer.signal);
        if (result.isErr()) {
          return err(result.error);
        }
      }
      return ok(undefined);
    } finally {
      timer.dispose();
    }
  }

  /**
   * Resolves one Processing Image following the ordered recovery table:
   * expiry → exhausted deadline/attempts → remnant reconcile → retained
   * source → interrupted. The ordered guards run before every attempt and
   * are reapplied after every awaited phase, before any outcome resolves,
   * so work that crosses expiry or the deadline mid-flight can never land
   * as Available, as a conversion-specific rejection, or as a retry.
   */
  private async resolveImageOutcome(
    image: ImageRow,
    threadId: string,
    signal: AbortSignal,
  ): Promise<Result<void, PipelineError>> {
    for (;;) {
      // Ordered guards before ANY work or remnant acceptance: expiry first,
      // then post-admission exhaustion (deadline or attempt budget). Each
      // verdict persists its terminal transition and discards the image's
      // files, so a remnant of inadmissible work is deleted here, never
      // reconciled back to Available.
      const entry = this.applyAdmissibilityGuards(image.id, threadId, true);
      if (entry.isErr()) {
        return err(entry.error);
      }
      if (entry.value !== 'proceed') {
        return ok(undefined);
      }

      // Reconcile a rename/commit crash remnant (file published, commit
      // lost) only for work that is STILL admissible AFTER the filesystem
      // and metadata reads, with the conditional commit running inside one
      // synchronous ledger transaction.
      if (this.deps.store.normalizedExists(threadId, image.id)) {
        return this.reconcileRemnant(image.id, threadId);
      }

      // No usable source before the deadline → interrupted.
      const sourcePath = this.deps.store.stagingSourcePath(image.id);
      if (sourcePath.isErr() || !this.pathExists(sourcePath.value)) {
        const rejected = this.deps.imageRepo.reject(image.id, 'processing_interrupted');
        if (rejected.isErr()) {
          return err(this.dbErrorToPipeline(rejected.error, 'reject processing_interrupted'));
        }
        this.cleanupImageFiles(image.id, threadId);
        return ok(undefined);
      }

      // Attempts increment BEFORE the conversion attempt, so a crash also
      // consumes the attempt it started (attempt_count persisted).
      const increment = this.deps.imageRepo.incrementAttempts(image.id);
      if (increment.isErr()) {
        return err(this.dbErrorToPipeline(increment.error, 'record normalization attempt'));
      }
      const attemptCount = increment.value;

      const bytes = await this.deps.store.readBounded(
        sourcePath.value,
        this.deps.imagesConfig.maxInputBytes,
      );

      // Reapply the ordered guards immediately after the awaited read,
      // BEFORE inspecting its Result on either path: a read that crossed
      // expiry or the processing deadline resolves expired/processing_failed
      // — never processing_interrupted for a not_found that landed late, and
      // never a normalization started from a successful late read.
      const postRead = this.applyAdmissibilityGuards(image.id, threadId, false);
      if (postRead.isErr()) {
        return err(postRead.error);
      }
      if (postRead.value !== 'proceed') {
        return ok(undefined);
      }

      if (bytes.isErr()) {
        if (bytes.error.code === 'not_found') {
          const rejected = this.deps.imageRepo.reject(image.id, 'processing_interrupted');
          if (rejected.isErr()) {
            return err(this.dbErrorToPipeline(rejected.error, 'reject processing_interrupted'));
          }
          this.cleanupImageFiles(image.id, threadId);
          return ok(undefined);
        }
        return err(
          new PipelineError(
            `Failed to read retained source for image ${image.id}: ${bytes.error.message}`,
          ),
        );
      }

      const tempPath = this.attemptTempPath(image.id, attemptCount);
      if (tempPath === null) {
        return err(new PipelineError(`Invalid image id for attempt temp file: ${image.id}`));
      }

      const remainingMs = image.processing_deadline_at - this.clock();
      const normalized = await this.normalize(bytes.value, {
        maxEdge: this.deps.imagesConfig.maxEdge,
        jpegQuality: this.deps.imagesConfig.jpegQuality,
        tempFilePath: tempPath,
        timeoutSeconds: Math.max(1, Math.ceil(Math.max(remainingMs, 1) / 1000)),
        signal,
      });

      // Reapply the ordered guards AFTER the awaited conversion, before ANY
      // outcome resolves: a result that crossed expiry or the deadline
      // resolves expired/processing_failed — never a conversion-specific
      // reason, never Available, never another retry under an expired
      // message.
      const post = this.applyAdmissibilityGuards(image.id, threadId, false);
      if (post.isErr()) {
        return err(post.error);
      }
      if (post.value !== 'proceed') {
        return ok(undefined);
      }

      if (normalized.isErr()) {
        const failure = normalized.error;
        if (!failure.retryable) {
          const rejected = this.deps.imageRepo.reject(
            image.id,
            this.immediateRejectionReason(failure.code),
          );
          if (rejected.isErr()) {
            return err(this.dbErrorToPipeline(rejected.error, 'reject image'));
          }
          this.cleanupImageFiles(image.id, threadId);
          return ok(undefined);
        }
        // Operational (io/timeout/cancelled): discard this attempt's temp
        // output; the loop's ordered guards re-decide before any retry.
        this.deps.store.removeFile(tempPath);
        continue;
      }

      // Persist this attempt's publication metadata BEFORE the rename so a
      // crash between rename and commit leaves real dimensions/EXIF behind.
      const meta: ImageAvailabilityMetadata = {
        mimeType: 'image/jpeg',
        width: normalized.value.dimensions.width,
        height: normalized.value.dimensions.height,
        exif: normalized.value.exif !== undefined ? JSON.stringify(normalized.value.exif) : null,
      };
      const metaWritten = this.writePublishMetadata(image.id, meta);
      if (metaWritten.isErr()) {
        return err(metaWritten.error);
      }

      const published = this.publishNormalized(image.id, threadId, tempPath, meta, attemptCount);
      if (published.isErr()) {
        return err(published.error);
      }
      if (published.value.kind === 'committed') {
        // Source is no longer needed for recovery once the file is published.
        this.deps.store.removeStagingDir(image.id);
        return ok(undefined);
      }
      // Fenced (expired/state) or late (deadline/ownership): discard the work.
      this.cleanupImageFiles(image.id, threadId);
      if (published.value.kind === 'late') {
        const rejected = this.deps.imageRepo.reject(image.id, 'processing_failed');
        if (rejected.isErr()) {
          return err(this.dbErrorToPipeline(rejected.error, 'reject processing_failed'));
        }
      }
      return ok(undefined);
    }
  }

  /**
   * Ordered admissibility guards: expiry FIRST, then post-admission
   * exhaustion (processing deadline or attempt budget). Every verdict other
   * than 'proceed' persists its terminal transition and discards the
   * image's staging and target files, so inadmissible work — including a
   * published remnant — leaves nothing recoverable behind.
   *
   * `capAttempts` applies the attempt budget: true at entry (before an
   * attempt starts), false after an awaited phase — an attempt that was
   * admissible when it started is judged on expiry and the deadline only.
   */
  private applyAdmissibilityGuards(
    imageId: string,
    threadId: string,
    capAttempts: boolean,
  ): Result<'proceed' | 'expired' | 'exhausted' | 'resolved', PipelineError> {
    const found = this.deps.imageRepo.findById(imageId);
    if (found.isErr()) {
      return err(this.dbErrorToPipeline(found.error, 're-read image under guard'));
    }
    const row = found.value;
    if (row === null) {
      this.deps.store.removeStagingDir(imageId);
      return ok('resolved');
    }
    if (row.state !== 'processing') {
      // Resolved elsewhere; that transition owns the Normalized file, so
      // only this message's staging copy is dropped.
      this.deps.store.removeStagingDir(imageId);
      return ok('resolved');
    }
    const now = this.clock();
    if (now >= row.expires_at) {
      const marked = this.deps.imageRepo.markUnavailable(imageId, 'expired');
      if (marked.isErr()) {
        return err(this.dbErrorToPipeline(marked.error, 'mark image expired'));
      }
      this.cleanupImageFiles(imageId, threadId);
      return ok('expired');
    }
    const attemptsSpent = capAttempts && row.attempt_count >= MAX_ATTEMPTS_PER_IMAGE;
    if (now >= row.processing_deadline_at || attemptsSpent) {
      const rejected = this.deps.imageRepo.reject(imageId, 'processing_failed');
      if (rejected.isErr()) {
        return err(this.dbErrorToPipeline(rejected.error, 'reject exhausted image'));
      }
      this.cleanupImageFiles(imageId, threadId);
      return ok('exhausted');
    }
    return ok('proceed');
  }

  /**
   * Commit a rename/commit crash remnant for work the ordered guards still
   * find admissible. Dimensions/EXIF come from the record persisted before
   * the rename, so a remnant never silently loses its metadata; a remnant
   * without a readable record commits as JPEG with unknown dimensions and
   * logs a warning rather than inventing values.
   */
  private reconcileRemnant(imageId: string, threadId: string): Result<void, PipelineError> {
    // Filesystem/metadata reads FIRST: they are synchronous but not
    // instantaneous, so admissibility is rechecked after them — inside the
    // same synchronous ledger transaction that conditionally records
    // Available — and a remnant whose reconcile crossed expiry or the
    // processing deadline is never committed.
    const meta = this.readPublishMetadata(imageId);
    const outcome = runLedgerTransaction<'committed' | 'settled'>(this.deps.imageRepo, () => {
      // Recheck expiry → exhaustion immediately before the conditional
      // Available mark: terminal verdicts persist here, atomically with
      // this transaction, and take precedence over reconciliation.
      const guard = this.applyAdmissibilityGuards(imageId, threadId, true);
      if (guard.isErr()) {
        return err(new DbError(guard.error.message, guard.error));
      }
      if (guard.value !== 'proceed') {
        return ok<'committed' | 'settled', DbError>('settled');
      }
      const marked = this.deps.imageRepo.markAvailable(imageId, meta ?? { mimeType: 'image/jpeg' });
      if (marked.isErr()) {
        return err(marked.error);
      }
      return ok<'committed' | 'settled', DbError>('committed');
    });
    if (outcome.isErr()) {
      return err(this.dbErrorToPipeline(outcome.error, 'reconcile published image remnant'));
    }
    if (outcome.value === 'settled') {
      // A terminal transition won the transaction: every terminal rule
      // discards its output, so the remnant file and staging are removed.
      this.cleanupImageFiles(imageId, threadId);
      return ok(undefined);
    }
    // Staging (with the metadata record) is cleaned only AFTER the commit.
    this.deps.store.removeStagingDir(imageId);
    if (meta === null) {
      this.deps.logger.warn(
        { imageId },
        'image ingestion: published remnant without persisted metadata; recording without dimensions',
      );
    }
    return ok(undefined);
  }

  /**
   * Guarded synchronous publication: rename + DB commit in one transaction.
   * The transaction re-checks Processing state, attempt ownership, the
   * message deadline, and the Image expiry BEFORE renaming AND again AFTER
   * the rename but BEFORE recording Available: mkdir/rename are synchronous
   * yet not instantaneous, so the deadline can pass between the two, and
   * output that crossed expiry, the deadline, or attempt ownership is
   * reverted from disk and never recorded. A DB failure (including one
   * landing after the rename) rolls the DB back AND reverts the rename, so
   * a crash can only ever leave a remnant file alongside its persisted
   * publish metadata, never a published file without its commit.
   */
  private publishNormalized(
    imageId: string,
    threadId: string,
    tempPath: string,
    meta: ImageAvailabilityMetadata,
    attemptCount: number,
  ): Result<PublishOutcome, PipelineError> {
    const targetPath = this.deps.store.normalizedPath(threadId, imageId);
    if (targetPath.isErr()) {
      return err(new PipelineError(`Failed to resolve normalized path: ${targetPath.error.message}`));
    }
    const target = targetPath.value;

    const outcome = runLedgerTransaction<PublishOutcome>(this.deps.imageRepo, () => {
      const row = this.deps.imageRepo.findById(imageId);
      if (row.isErr()) {
        return err(row.error);
      }
      const image = row.value;
      if (image === null || image.state !== 'processing') {
        // Fenced by state: the row already resolved; this work is late.
        return ok({ kind: 'fenced' } satisfies PublishOutcome);
      }
      const now = this.clock();
      if (now >= image.expires_at) {
        const marked = this.deps.imageRepo.markUnavailable(imageId, 'expired');
        if (marked.isErr()) {
          return err(marked.error);
        }
        return ok({ kind: 'fenced' } satisfies PublishOutcome);
      }
      if (now >= image.processing_deadline_at || image.attempt_count !== attemptCount) {
        // Deadline elapsed or attempt ownership lost: late work, discarded.
        return ok({ kind: 'late' } satisfies PublishOutcome);
      }
      // The thread's Normalized-file subtree may not exist yet; create it
      // before the rename (rename itself cannot create directories).
      const ensuredDir = this.deps.store.ensureThreadImagesDir(threadId);
      if (ensuredDir.isErr()) {
        return err(
          new DbError(
            `Failed to ensure thread image directory for image ${imageId}: ${ensuredDir.error.message}`,
          ),
        );
      }
      const renamed = this.deps.store.rename(tempPath, target);
      if (renamed.isErr()) {
        return err(
          new DbError(
            `Failed to publish normalized file for image ${imageId}: ${renamed.error.message}`,
          ),
        );
      }

      // Post-publish admissibility recheck BEFORE recording Available: the
      // filesystem operations above may have crossed the expiry or the
      // processing deadline. Anything no longer admissible has its output
      // reverted from disk and resolves fenced/late, never Available.
      const afterRename = this.deps.imageRepo.findById(imageId);
      if (afterRename.isErr()) {
        this.deps.store.removeFile(target);
        return err(afterRename.error);
      }
      const afterRow = afterRename.value;
      const nowAfter = this.clock();
      if (afterRow === null || afterRow.state !== 'processing') {
        this.deps.store.removeFile(target);
        return ok({ kind: 'fenced' } satisfies PublishOutcome);
      }
      if (nowAfter >= afterRow.expires_at) {
        const markedExpired = this.deps.imageRepo.markUnavailable(imageId, 'expired');
        if (markedExpired.isErr()) {
          this.deps.store.removeFile(target);
          return err(markedExpired.error);
        }
        this.deps.store.removeFile(target);
        return ok({ kind: 'fenced' } satisfies PublishOutcome);
      }
      if (
        nowAfter >= afterRow.processing_deadline_at ||
        afterRow.attempt_count !== attemptCount
      ) {
        this.deps.store.removeFile(target);
        return ok({ kind: 'late' } satisfies PublishOutcome);
      }

      const marked = this.deps.imageRepo.markAvailable(imageId, meta);
      if (marked.isErr()) {
        // No Available recorded: remove the landed file so a crash remnant
        // cannot later commit output this transaction refused.
        this.deps.store.removeFile(target);
        return err(marked.error);
      }
      return ok({ kind: 'committed' } satisfies PublishOutcome);
    });

    if (outcome.isErr()) {
      // DB commit failed — possibly after the rename: revert the published
      // remnant and discard the temp output.
      this.deps.store.removeFile(target);
      this.deps.store.removeFile(tempPath);
      return err(this.dbErrorToPipeline(outcome.error, 'publish normalized image'));
    }
    const kind = outcome.value.kind;
    if (kind !== 'committed') {
      // Fenced/late: the temp output was never admissible; discard it.
      this.deps.store.removeFile(tempPath);
    }
    return ok(outcome.value);
  }

  // -------------------------------------------------------------------------
  // Completion (commit-together)
  // -------------------------------------------------------------------------

  /**
   * Refreshes availability, then conditionally enqueues and marks the
   * Ingestion complete — enqueue and completion commit atomically via
   * {@link QueueManager.enqueueWithCommit} (one transaction, success log only
   * after commit). An already-completed Ingestion never enqueues again, even
   * after its queue item was purged.
   */
  private finishIngestion(
    messageId: string,
    threadId: string,
    completionPayload: Record<string, unknown>,
  ): Result<{ enqueued: boolean }, PipelineError> {
    const images = this.deps.imageRepo.findByMessage(messageId);
    if (images.isErr()) {
      return err(this.dbErrorToPipeline(images.error, 'refresh image availability'));
    }
    for (const image of images.value) {
      if (image.state !== 'available') {
        continue;
      }
      const now = this.clock();
      // Expiry takes precedence when first establishing unavailability.
      if (now >= image.expires_at) {
        const marked = this.deps.imageRepo.markUnavailable(image.id, 'expired');
        if (marked.isErr()) {
          return err(this.dbErrorToPipeline(marked.error, 'mark image expired'));
        }
        const targetPath = this.deps.store.normalizedPath(threadId, image.id);
        if (targetPath.isOk()) {
          this.deps.store.removeFile(targetPath.value);
        }
        continue;
      }
      if (!this.deps.store.normalizedExists(threadId, image.id)) {
        const marked = this.deps.imageRepo.markUnavailable(image.id, 'file_missing');
        if (marked.isErr()) {
          return err(this.dbErrorToPipeline(marked.error, 'mark image file missing'));
        }
      }
    }

    const complete = this.deps.ingestionRepo.isComplete(messageId);
    if (complete.isErr()) {
      return err(this.dbErrorToPipeline(complete.error, 'check ingestion completion'));
    }
    if (complete.value) {
      return ok({ enqueued: false });
    }

    const enqueued = this.deps.queueManager.enqueueWithCommit(
      threadId,
      'message',
      completionPayload,
      messageId,
      (item) => this.deps.ingestionRepo.markComplete({ messageId, queueItemId: item.id }),
    );
    if (enqueued.isErr()) {
      // Rolled back: no queue item, no completion, no success log. The
      // pending Ingestion stays recoverable.
      return err(new PipelineError(enqueued.error.message, enqueued.error));
    }
    return ok({ enqueued: true });
  }

  // -------------------------------------------------------------------------
  // Attachment planning and staging
  // -------------------------------------------------------------------------

  /**
   * Plans the message's Attachments in source order and stages the payload
   * bytes durably BEFORE admission (staging is awaited here, never inside a
   * transaction). Payload bytes are keyed by the Talon-generated Image id so
   * recovery re-derives the retained source from the Image row alone.
   */
  private async planAndStageAttachments(
    attachments: readonly InboundAttachment[],
  ): Promise<AttachmentPlan[]> {
    const plans: AttachmentPlan[] = [];
    for (let ordinal = 0; ordinal < attachments.length; ordinal++) {
      const attachment = attachments[ordinal];
      if (ordinal >= this.deps.imagesConfig.maxPerMessage) {
        plans.push(this.planRejected(ordinal, 'count_limit', attachment));
        continue;
      }
      if (isRejection(attachment)) {
        plans.push({
          ordinal,
          imageId: randomUUID(),
          rejectionReason: attachment.rejectionReason,
          filename: attachment.filename ?? null,
          mimeType: attachment.mimeType ?? null,
        });
        continue;
      }

      const bytes = await this.readAttachmentBytes(attachment);
      if (bytes.isErr()) {
        plans.push(this.planRejected(ordinal, bytes.error, attachment));
        continue;
      }
      const imageId = randomUUID();
      const staged = await this.deps.store.writeStagingSource(imageId, bytes.value);
      if (staged.isErr()) {
        this.deps.logger.warn(
          { ordinal, imageId, code: staged.error.code },
          'image ingestion: staging write failed; recording download_failed',
        );
        plans.push(this.planRejected(ordinal, 'download_failed', attachment));
        continue;
      }
      plans.push({
        ordinal,
        imageId,
        rejectionReason: null,
        filename: attachment.filename ?? null,
        mimeType: attachment.mimeType ?? null,
      });
    }
    return plans;
  }

  /**
   * Reads one payload Attachment's actual bytes, bounded. Declared sizes are
   * insufficient — the real bytes are checked here and again before
   * conversion.
   */
  private async readAttachmentBytes(
    attachment: Attachment,
  ): Promise<Result<Buffer, ImageRejectionReason>> {
    if (Buffer.isBuffer(attachment.data)) {
      if (attachment.data.length > this.deps.imagesConfig.maxInputBytes) {
        return err('size_limit');
      }
      return ok(attachment.data);
    }
    const loaded = await this.deps.store.readBounded(
      attachment.data,
      this.deps.imagesConfig.maxInputBytes,
    );
    if (loaded.isErr()) {
      if (loaded.error.code === 'too_large') {
        return err('size_limit');
      }
      return err('download_failed');
    }
    return ok(loaded.value);
  }

  /**
   * Adopts a usable redelivered source for still-Processing committed Images:
   * when the committed Image lost its retained source but the redelivery
   * carried bytes for the same source position, the new bytes move into the
   * committed Image's staging directory. Everything else newly downloaded is
   * removed.
   */
  private adoptRedeliveredSource(
    committedImages: readonly ImageRow[],
    plans: readonly AttachmentPlan[],
  ): void {
    const redelivered = new Map<number, string>();
    for (const plan of plans) {
      if (plan.rejectionReason === null) {
        redelivered.set(plan.ordinal, plan.imageId);
      }
    }
    for (const image of committedImages) {
      if (image.state !== 'processing') {
        continue;
      }
      const retained = this.deps.store.stagingSourcePath(image.id);
      if (retained.isOk() && this.pathExists(retained.value)) {
        continue; // The retained source wins; never overwrite it.
      }
      const candidateId = redelivered.get(image.ordinal);
      if (candidateId === undefined) {
        continue;
      }
      const candidateSource = this.deps.store.stagingSourcePath(candidateId);
      const target = this.deps.store.stagingSourcePath(image.id);
      if (candidateSource.isErr() || target.isErr()) {
        continue;
      }
      const ensured = this.deps.store.ensureStagingDir(image.id);
      if (ensured.isErr()) {
        continue;
      }
      const moved = this.deps.store.rename(candidateSource.value, target.value);
      if (moved.isOk()) {
        this.deps.logger.info(
          { imageId: image.id },
          'image ingestion: adopted redelivered source for processing work',
        );
      }
    }
    // Clean the newly downloaded duplicate staging, adopted or not.
    for (const candidateId of redelivered.values()) {
      this.deps.store.removeStagingDir(candidateId);
    }
  }

  // -------------------------------------------------------------------------
  // Completion payload rebuild (committed rows only)
  // -------------------------------------------------------------------------

  /**
   * Rebuilds the completion context — owning thread plus the queue message
   * payload shape — from COMMITTED state only: the stored Message row
   * (identity, content, sender, timestamp) and the route persisted with the
   * Ingestion at Admission. Current bindings are never consulted: a binding
   * change must not reroute pending work, and a binding removal must not
   * strand it. Fails when no route was ever persisted (pre-migration row);
   * the Ingestion stays pending rather than guessing.
   */
  private buildCompletionContext(
    messageId: string,
  ): Result<{ threadId: string; payload: Record<string, unknown> }, PipelineError> {
    const ingestion = this.deps.ingestionRepo.findByMessage(messageId);
    if (ingestion.isErr()) {
      return err(this.dbErrorToPipeline(ingestion.error, 'load ingestion for completion'));
    }
    const row = ingestion.value;
    if (row === null) {
      return err(new PipelineError(`no ledger row for message ${messageId}`));
    }
    if (row.persona_id === null) {
      return err(new PipelineError(`no persisted route for message ${messageId}`));
    }
    const thread = this.deps.threadRepo.findById(row.thread_id);
    if (thread.isErr() || thread.value === null) {
      return err(new PipelineError(`unknown thread ${row.thread_id}`));
    }
    const channel = this.deps.channelRepo.findById(thread.value.channel_id);
    if (channel.isErr() || channel.value === null) {
      return err(new PipelineError(`unknown channel ${thread.value.channel_id}`));
    }
    const message = this.deps.messageRepo.findById(messageId);
    if (message.isErr() || message.value === null) {
      return err(new PipelineError(`unknown message ${messageId}`));
    }
    return ok({
      threadId: row.thread_id,
      payload: {
        messageId: message.value.id,
        channelId: channel.value.id,
        channelName: channel.value.name,
        senderId: message.value.provider_id ?? '',
        content: message.value.content,
        timestamp: message.value.created_at,
        personaId: row.persona_id,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private clock(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private retentionMs(): number {
    return Math.round(this.deps.imagesConfig.retentionHours * 3_600_000);
  }

  /**
   * Claims exclusive in-process processing for a message. The check-and-set
   * is synchronous (no await point), so every entrypoint — fresh admission,
   * redelivery adoption, and recovery — sees exactly one owner. The owner
   * releases in a finally block; a crashed process releases by dying, and
   * the next delivery or restart resumes from the committed ledger.
   */
  private tryAcquireOwnership(messageId: string): boolean {
    if (this.activeOwners.has(messageId)) {
      return false;
    }
    this.activeOwners.add(messageId);
    return true;
  }

  private planRejected(
    ordinal: number,
    reason: ImageRejectionReason,
    attachment: InboundAttachment,
  ): AttachmentPlan {
    return {
      ordinal,
      imageId: randomUUID(),
      rejectionReason: reason,
      filename: 'filename' in attachment ? (attachment.filename ?? null) : null,
      mimeType: 'mimeType' in attachment ? (attachment.mimeType ?? null) : null,
    };
  }

  /** Attempt-owned temp file for one normalization attempt, inside staging. */
  private attemptTempPath(imageId: string, attemptCount: number): string | null {
    const dir = this.deps.store.stagingDir(imageId);
    if (dir.isErr()) {
      return null;
    }
    return `${dir.value}/attempt-${attemptCount}.bin`;
  }

  /**
   * Writes the durable publication record into the Image's staging
   * directory. Synchronous by design: it must complete inside the guarded
   * publication window, before the rename.
   */
  private writePublishMetadata(
    imageId: string,
    meta: ImageAvailabilityMetadata,
  ): Result<void, PipelineError> {
    const dir = this.deps.store.stagingDir(imageId);
    if (dir.isErr()) {
      return err(new PipelineError(`Invalid image id for publish metadata: ${imageId}`));
    }
    try {
      fs.writeFileSync(
        path.join(dir.value, PUBLISH_META_FILENAME),
        JSON.stringify(meta),
        'utf8',
      );
      return ok(undefined);
    } catch (cause) {
      return err(
        new PipelineError(
          `Failed to persist publish metadata for image ${imageId}: ` +
            (cause instanceof Error ? cause.message : String(cause)),
        ),
      );
    }
  }

  /**
   * Reads the durable publication record for remnant reconciliation.
   * Returns null when absent or structurally unusable (missing/invalid
   * dimensions), so a remnant commits with unknown dimensions rather than
   * invented ones.
   */
  private readPublishMetadata(imageId: string): ImageAvailabilityMetadata | null {
    const dir = this.deps.store.stagingDir(imageId);
    if (dir.isErr()) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir.value, PUBLISH_META_FILENAME), 'utf8'));
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    const width = candidate.width;
    const height = candidate.height;
    if (
      typeof width !== 'number' ||
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      typeof height !== 'number' ||
      !Number.isSafeInteger(height) ||
      height <= 0
    ) {
      return null;
    }
    const meta: ImageAvailabilityMetadata = { width, height };
    if (typeof candidate.mimeType === 'string') {
      meta.mimeType = candidate.mimeType;
    }
    if (typeof candidate.exif === 'string') {
      meta.exif = candidate.exif;
    }
    return meta;
  }

  private immediateRejectionReason(
    code: 'unsupported_mime' | 'animated' | 'conversion_failed' | 'invalid_options',
  ): ImageRejectionReason {
    if (code === 'unsupported_mime' || code === 'animated') {
      return code;
    }
    return 'conversion_failed';
  }

  private cleanupImageFiles(imageId: string, threadId: string): void {
    this.deps.store.removeStagingDir(imageId);
    const targetPath = this.deps.store.normalizedPath(threadId, imageId);
    if (targetPath.isOk()) {
      this.deps.store.removeFile(targetPath.value);
    }
  }

  private admissionRecordExists(messageId: string): boolean {
    const record = this.deps.ingestionRepo.findAdmissionByMessage(messageId);
    return record.isOk() && record.value !== null;
  }

  private pathExists(filePath: string): boolean {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  /** AbortSignal armed at the committed deadline; disposed in the caller. */
  private armDeadlineAbort(deadlineAt: number): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const remaining = deadlineAt - this.clock();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (remaining <= 0) {
      controller.abort();
    } else {
      timer = setTimeout(() => controller.abort(), remaining);
    }
    return {
      signal: controller.signal,
      dispose: (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      },
    };
  }

  private dbErrorToPipeline(error: DbError, context: string): PipelineError {
    return new PipelineError(`${context}: ${error.message}`, error);
  }

  private unexpectedError(context: string, cause: unknown): PipelineError {
    const message = cause instanceof Error ? cause.message : String(cause);
    return new PipelineError(`Unexpected ${context}: ${message}`, cause instanceof Error ? cause : undefined);
  }
}

/** True for the metadata-only rejection arm of an inbound Attachment. */
function isRejection(attachment: InboundAttachment): attachment is InboundAttachmentRejection {
  return 'kind' in attachment && attachment.kind === 'rejected';
}
