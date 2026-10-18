/**
 * ImageLifecycleManager — startup + periodic recovery and retention
 * recovery for durable Images (TASK-010, spec part (b)).
 *
 * One pass does, in order:
 * 1. **Recovery** — the whole pass is delegated to
 *    {@link ImageIngestionCoordinator.recoverPending}. The coordinator
 *    re-resolves every pending Ingestion against the ORIGINAL durable
 *    admission clock (expiry and the 60-second processing deadline were
 *    started at admission, so a restart never redelivers the message,
 *    re-derives deadlines, or resets attempts), skips messages it already
 *    owns in this process, and resolves past-deadline work terminal without
 *    another conversion. All expiry transitions of Processing images and
 *    their file cleanup live there; duplicating them here would race the
 *    coordinator's fenced publication.
 * 2. **Retention** — Available Images past `expires_at` are durably marked
 *    `Unavailable(expired)` (a recorded terminal reason is never replaced)
 *    and their normalized file is removed. The phase keyset-pages through the
 *    WHOLE expirable set within the pass, so a backlog larger than one page
 *    does not wait for later sweeps, and a page it cannot transition is stepped
 *    past rather than blocking the rows behind it. A failed expiry transition is
 *    logged (warn), counted in `failures`, and retried by the next pass; a failed
 *    file deletion is also counted in `failures` but is AUDITED
 *    (`image.cleanup.failed`), and the cleanup phase retries the file.
 * 3. **Cleanup** — staging directories are removed when they can no longer
 *    be live work: unknown orphans older than a full processing deadline
 *    (filesystem-driven, so cleanup survives arbitrary restart counts), and
 *    staging of RESOLVED (non-Processing) Images whose source was already
 *    consumed or whose work ended terminal — crash remnants of a failed
 *    post-commit deletion never linger. Staging of Processing rows is
 *    preserved: it belongs to in-flight or recoverable ingestion.
 *
 * **Startup is awaitable and FAILS CLOSED**: `start()` runs the first pass
 * immediately and returns a promise that settles when that pass completes,
 * or after a bounded startup timeout. On timeout the lifecycle records
 * structured audit evidence and the daemon ABORTS the boot before any
 * channel connector starts — an Image is never admitted while startup
 * recovery is outstanding. The daemon retires the outstanding work safely
 * (fence, bounded stop, bounded drain); sweep state is durable, so
 * recovery resumes at the next boot. Subsequent sweeps
 * follow a DUE-TIME cadence: the next pass is due one interval after the
 * previous pass STARTED, so a long pass never stretches start-to-start
 * beyond the interval — overdue work runs immediately after completion,
 * still never overlapping.
 *
 * `stop()` fences new passes in TWO independently enforced places (the
 * arming guard and the timer-callback re-check) and drains the in-flight
 * pass BOUNDED (F4): if the pass outlives the bound, stop() reports it
 * wedged and the pass's remaining phases observe the stop fence and skip
 * their ledger writes, so nothing can commit through a closing database.
 *
 * Audit and log evidence carries identifiers and STRUCTURED failure fields
 * only (fs error code, operation label, Image ID) — error MESSAGES are
 * never persisted because fs/repository messages can embed paths or
 * credentials. The in-memory `ImagePassReport.recoveryError` is a
 * diagnostics return value only and must never be forwarded to a logger or
 * the audit store.
 */

import fs from 'node:fs';
import path from 'node:path';
import type pino from 'pino';
import type { AuditEntry, AuditStore } from '../core/logging/audit-logger.js';
import { DEFAULT_SWEEP_LIMIT } from '../core/database/repositories/image-repository.js';
import type { ImageExpirableCursor, ImageRepository } from '../core/database/repositories/image-repository.js';
import type { ImageStore } from './image-store.js';
import {
  IMAGE_PROCESSING_DEADLINE_MS,
  IMAGE_SHUTDOWN_DRAIN_TIMEOUT_MS,
  type ImageIngestionCoordinator,
  type RecoverPendingOptions,
  type RecoveryReport,
} from './image-ingestion.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Recovery/retention sweep cadence (spec: at most every 60 seconds). */
export const IMAGE_SWEEP_INTERVAL_MS = 60_000;

/**
 * Bound on how long daemon startup waits for the initial recovery pass
 * (P1-1, F1). On timeout the boot FAILS CLOSED: the lifecycle records a
 * structured `image.startup.recovery_timeout` audit entry and the daemon
 * aborts startup BEFORE any channel connector starts — an Image is never
 * admitted with recovery outstanding. The daemon retires the outstanding
 * work safely (fence + bounded stop + bounded drain); sweep state is
 * durable, so recovery resumes at the next boot.
 */
export const IMAGE_STARTUP_RECOVERY_TIMEOUT_MS = 30_000;

/**
 * Grace window before a staging directory with no Image row is treated as an
 * orphan. Covers in-flight admissions whose staging write landed before the
 * admission transaction committed; one full processing deadline is the upper
 * bound for that window while the process is alive.
 */
export const ORPHAN_STAGING_GRACE_MS = IMAGE_PROCESSING_DEADLINE_MS;

/**
 * Rows loaded per retention query. The retention phase pages through the whole
 * expirable set inside one pass (see {@link ImageLifecycleManager}), so this
 * bounds a single query, never the amount of expired work a pass can resolve.
 */
const RETENTION_BATCH_LIMIT = DEFAULT_SWEEP_LIMIT;

/** A complete lifecycle pass, injectable for deterministic drain tests. */
export type ImagePassRunner = () => Promise<ImagePassReport>;

/** Outcome of the awaited startup pass (P1-1: startup gates on recovery). */
export interface ImageStartupOutcome {
  /** True when the initial pass completed within the bound. */
  completed: boolean;
  /** True when the bound elapsed while the initial pass was still in flight. */
  timedOut: boolean;
  /** Report of the completed initial pass; null when it did not complete. */
  report: ImagePassReport | null;
}

export interface ImageLifecycleDeps {
  coordinator: ImageIngestionCoordinator;
  imageRepo: ImageRepository;
  store: ImageStore;
  dataDir: string;
  auditStore: AuditStore;
  logger: pino.Logger;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Sweep cadence; defaults to {@link IMAGE_SWEEP_INTERVAL_MS}. */
  sweepIntervalMs?: number;
  /** Orphan-staging grace window; defaults to {@link ORPHAN_STAGING_GRACE_MS}. */
  orphanGraceMs?: number;
  /**
   * Test seam replacing the whole pass body. The manager's scheduling,
   * fence, and drain behavior stay under test while the pass body is
   * substituted.
   */
  runOnce?: ImagePassRunner;
}

/** Outcome of one full lifecycle pass (for tests and diagnostics). */
export interface ImagePassReport {
  /** Recovery work resolved by the coordinator pass (null when disabled). */
  recovered: RecoveryReport | null;
  /**
   * Diagnostics-only error message of a failed recovery pass; retried next
   * sweep. NEVER persisted to audit or logs — persisted evidence uses the
   * structured `op`/`code` fields only.
   */
  recoveryError: string | null;
  /** Available Images transitioned to Unavailable(expired) in this pass. */
  expired: number;
  /** Owned files/directories removed by the cleanup phase. */
  cleaned: number;
  /** Transitions or deletions that failed and will be retried next pass. */
  failures: number;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class ImageLifecycleManager {
  private readonly deps: ImageLifecycleDeps;
  private readonly clock: () => number;
  private readonly sweepIntervalMs: number;
  private readonly orphanGraceMs: number;
  private readonly passRunner: ImagePassRunner;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<ImagePassReport> | null = null;
  /** Start-to-start due time of the next sweep (P2-4 due-time cadence). */
  private dueAt: number | null = null;
  private started = false;
  private stopped = false;
  private startupPromise: Promise<ImageStartupOutcome> | null = null;

  constructor(deps: ImageLifecycleDeps) {
    this.deps = deps;
    this.clock = deps.now ?? ((): number => Date.now());
    this.sweepIntervalMs = deps.sweepIntervalMs ?? IMAGE_SWEEP_INTERVAL_MS;
    this.orphanGraceMs = deps.orphanGraceMs ?? ORPHAN_STAGING_GRACE_MS;
    this.passRunner = deps.runOnce ?? ((): Promise<ImagePassReport> => this.runPass());
  }

  get isStarted(): boolean {
    return this.started && !this.stopped;
  }

  /**
   * Runs the first pass IMMEDIATELY and returns a promise the daemon awaits
   * before starting channels (P1-1). The awaited outcome settles when the
   * initial pass completes, or after `timeoutMs` if the pass has wedged —
   * a timed-out outcome aborts the boot fail-closed (F1): channels are
   * never started while recovery is outstanding. The initial pass doubles
   * as the first sweep of the due-time cadence.
   * Idempotent: repeat calls return the same startup outcome.
   */
  start(timeoutMs: number = IMAGE_STARTUP_RECOVERY_TIMEOUT_MS): Promise<ImageStartupOutcome> {
    if (this.stopped) {
      return Promise.resolve({ completed: false, timedOut: false, report: null });
    }
    if (this.startupPromise !== null) {
      return this.startupPromise;
    }
    this.started = true;
    this.dueAt = this.clock() + this.sweepIntervalMs;
    const initial = this.runGuarded().finally(() => {
      this.inFlight = null;
      this.armNextSweep();
    });
    this.inFlight = initial;
    this.startupPromise = this.awaitStartup(initial, timeoutMs);
    return this.startupPromise;
  }

  private async awaitStartup(
    initial: Promise<ImagePassReport>,
    timeoutMs: number,
  ): Promise<ImageStartupOutcome> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<'timed-out'>((resolve) => {
      timer = setTimeout(() => resolve('timed-out'), timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    const raced = await Promise.race([
      initial.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
      timeout,
    ]);
    if (timer !== null) clearTimeout(timer);
    if (raced === 'settled') {
      const report = await initial.catch(() => null);
      return { completed: true, timedOut: false, report: report ?? null };
    }
    if (this.stopped) {
      // P2-1: stop() already fenced this manager (shutdown or boot-abort
      // teardown) and its bound elapsed, so the daemon proceeded toward
      // closing the database this audit writes through. The late timeout
      // outcome must NOT append — the stop path logged its own bounded
      // evidence (PASS_WEDGED_AFTER_BOUND), and the next boot re-derives
      // the recovery state from the durable table anyway. The caller
      // still observes the timeout via the returned outcome.
      this.deps.logger.info(
        {
          op: 'image_startup_timeout_audit_skip',
          reason: 'stopped',
          timeoutMs,
        },
        'image lifecycle: startup timeout observed after stop(); recovery_timeout audit skipped — closure may have begun',
      );
      return { completed: false, timedOut: true, report: null };
    }
    // Durable audit evidence (F1): the timeout must be provable after the
    // aborted boot, not just visible in the structured log line. Only
    // reached while NOT stopped — a stopped manager never writes past the
    // closure fence.
    this.audit('image.startup.recovery_timeout', {
      code: 'STARTUP_RECOVERY_TIMEOUT',
      timeoutMs,
    });
    this.deps.logger.warn(
      { op: 'image_startup_recovery', code: 'STARTUP_RECOVERY_TIMEOUT' },
      'image startup recovery did not settle within the bound; the boot fails closed — channels are not started while recovery is outstanding',
    );
    return { completed: false, timedOut: true, report: null };
  }

  /**
   * Fences new passes, clears the timer, and waits for the in-flight pass
   * — BOUNDED (F4). The daemon runs this BEFORE the bounded delivery drain,
   * so an unbounded wait here would hang shutdown before the drain's bound
   * could ever apply. If the pass outlives `timeoutMs`, stop() reports
   * `{ drained: false }`: the wedged continuation observes the stop fence
   * in {@link runPass} and skips its remaining ledger phases, and the
   * coordinator's retirement guard stops its durable writes — nothing may
   * commit through a closed database. Durable state stays consistent for
   * next-boot recovery either way.
   */
  async stop(
    timeoutMs: number = IMAGE_SHUTDOWN_DRAIN_TIMEOUT_MS,
  ): Promise<{ drained: boolean }> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    let inFlight = this.inFlight;
    while (inFlight !== null) {
      const settled = await Promise.race([
        inFlight.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) => {
          const bound = setTimeout(() => resolve(false), timeoutMs);
          (bound as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
      if (!settled) {
        this.deps.logger.warn(
          { op: 'image_lifecycle_stop', code: 'PASS_WEDGED_AFTER_BOUND', timeoutMs },
          'image lifecycle: in-flight pass outlived the shutdown bound; remaining phases are fenced from ledger writes and the coordinator retires its continuations',
        );
        return { drained: false };
      }
      // The pass may finish and its completion callback may still be queued
      // as a microtask; yield so the drain state settles before we report
      // completion (and so no reschedule can slip past the fence).
      await Promise.resolve();
      inFlight = this.inFlight;
    }
    return { drained: true };
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  /**
   * Arm the next sweep. Guard A of the shutdown fence: once stopped, no new
   * timer may be armed at all (guard B — the callback re-check below — is
   * enforced independently so a stale armed callback is also inert).
   * The delay derives from the retained due time (P2-4), so a pass that
   * overran its interval is followed immediately instead of waiting out a
   * fresh interval.
   *
   * Note (accepted redundancy): armNextSweep() and schedule() each re-check
   * `stopped`/`inFlight` and the delay is computed once per path. The
   * duplication is deliberate — guard A must also protect the finally-arm
   * path — and harmless: both checks read the same flags.
   */
  private armNextSweep(): void {
    if (this.stopped || this.inFlight !== null || this.dueAt === null) return;
    this.schedule(Math.max(0, this.dueAt - this.clock()));
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.inFlight !== null) return;
    const timer = setTimeout(() => {
      this.timer = null;
      // Guard B of the shutdown fence, independent of guard A: a callback
      // armed before stop() but firing after it must never start a pass.
      if (this.stopped) return;
      // Anchor the NEXT due time to this pass's start, giving a fixed
      // start-to-start cadence regardless of how long this pass runs.
      this.dueAt = this.clock() + this.sweepIntervalMs;
      const run = this.runGuarded().finally(() => {
        this.inFlight = null;
        this.armNextSweep();
      });
      this.inFlight = run;
    }, delayMs);
    // Never keep the event loop alive by ourselves.
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  /** Pass wrapper that swallows every error: a sweep must never crash the daemon. */
  private async runGuarded(): Promise<ImagePassReport> {
    try {
      return await this.passRunner();
    } catch (cause) {
      // Structured evidence only: the message may embed paths or credentials
      // and stays out of logs and audit (P2-5).
      this.deps.logger.error(
        { op: 'image_lifecycle_pass', code: errorCode(cause) },
        'image lifecycle pass failed',
      );
      return {
        recovered: null,
        recoveryError: diagnosticMessage(cause),
        expired: 0,
        cleaned: 0,
        failures: 1,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Pass phases
  // -------------------------------------------------------------------------

  /** One full recovery + retention + cleanup pass. */
  async runPass(): Promise<ImagePassReport> {
    const report: ImagePassReport = {
      recovered: null,
      recoveryError: null,
      expired: 0,
      cleaned: 0,
      failures: 0,
    };

    // 1) Recovery: every pending admission is re-resolved against its
    //    original admission clock, and in-process owners are skipped by the
    //    coordinator itself. Expiry of Processing work and its file cleanup
    //    happen inside the coordinator's fenced guards, never here.
    await this.recoverPass(report);

    // Stop fence (F4): once stop() has been called — especially once it
    // timed out and the daemon proceeded toward closing the database —
    // the remaining phases must not commit through a closing DB. Skipped
    // work is durable-deferred: the next boot's sweep picks it up.
    if (this.stopped) {
      this.deps.logger.info(
        { op: 'image_sweep_phase_skip', reason: 'stopped' },
        'image lifecycle: sweep stopped mid-pass; remaining phases deferred',
      );
      return report;
    }

    // 2) Retention: expire Available content past its receipt-based expiry.
    this.retentionPass(report);

    if (this.stopped) {
      return report;
    }

    // 3) Cleanup: orphaned staging from crashed deliveries.
    this.cleanupPass(report);

    return report;
  }

  private async recoverPass(report: ImagePassReport): Promise<void> {
    try {
      const options: RecoverPendingOptions = {};
      const result = await this.deps.coordinator.recoverPending(options);
      if (result.isErr()) {
        // Diagnostics stay in the in-memory report; the persisted log line
        // carries only the structured error code (P2-5).
        report.recoveryError = result.error.message;
        report.failures++;
        this.deps.logger.error(
          { op: 'image_recovery', code: result.error.code },
          'image recovery pass failed; will retry next sweep',
        );
        return;
      }
      const recovered = result.value;
      report.recovered = recovered;
      if (recovered.inspected > 0) {
        // Stop fence (R1): stop() may land WHILE this recovery is in
        // flight — the daemon then proceeds toward closing the database.
        // The aggregate audit append must never happen past that point;
        // the next boot's pass re-derives the aggregate from durable
        // state anyway, so skipping loses no information.
        if (this.stopped) {
          this.deps.logger.info(
            {
              op: 'image_recovery_audit_skip',
              reason: 'stopped',
              inspected: recovered.inspected,
            },
            'image lifecycle: recovery aggregate audit skipped — stopped mid-pass, closure may have begun',
          );
          return;
        }
        // IDs are not recorded here: the coordinator owns the per-message
        // outcome logs; this is the aggregate lifecycle audit line.
        this.audit('image.recovery.pass', {
          inspected: recovered.inspected,
          enqueued: recovered.enqueued,
          skipped: recovered.skipped,
          failed: recovered.failed,
        });
      }
    } catch (cause) {
      report.recoveryError = diagnosticMessage(cause);
      report.failures++;
      this.deps.logger.error(
        { op: 'image_recovery', code: errorCode(cause) },
        'image recovery pass threw; will retry next sweep',
      );
    }
  }

  /**
   * Transitions Available Images past their original receipt-based expiry to
   * Unavailable(expired) and removes their normalized file. The repository's
   * expirable set covers processing rows too; those belong to the recovery
   * pass above (its guards are fenced against publication), so this sweep
   * only handles rows still recorded as available. Expiry always wins over
   * file_missing because this is the only transition that records a reason.
   *
   * The phase walks the WHOLE expirable set inside ONE pass by keyset-paging
   * `findExpirable` {@link RETENTION_BATCH_LIMIT} rows at a time, so a backlog
   * larger than one page is fully expired by a single run (startup and every
   * scheduled sweep share this behavior). The cursor advances to the last row of
   * EVERY page, whichever way those rows resolved — skipped (Processing rows
   * owned by the recovery pass), transitioned, or FAILED to transition — because
   * paging past examined rows is what keeps a blocked page (a full page of
   * Processing rows, or of rows whose expiry transition keeps failing) from
   * starving everything behind it. A row whose transition failed stays expirable
   * and is retried by the NEXT pass; this pass never retries it.
   *
   * Termination: an empty page ends the drain. The keyset condition is strictly
   * past the anchor and `expires_at` is immutable (expiry is stamped at
   * Admission and never extended by access, retry, or restart), so the anchor
   * moves forward on every page and no row is ever visited twice.
   */
  private retentionPass(report: ImagePassReport): void {
    const now = this.clock();
    let after: ImageExpirableCursor | null = null;

    for (;;) {
      let rows;
      try {
        const found = this.deps.imageRepo.findExpirable({
          now,
          limit: RETENTION_BATCH_LIMIT,
          ...(after !== null ? { after } : {}),
        });
        if (found.isErr()) {
          report.failures++;
          this.deps.logger.error(
            { op: 'image_retention_find', code: found.error.code },
            'image retention sweep could not load expirable Images',
          );
          return;
        }
        rows = found.value;
      } catch (cause) {
        report.failures++;
        this.deps.logger.error(
          { op: 'image_retention_find', code: errorCode(cause) },
          'image retention sweep failed',
        );
        return;
      }

      // An empty page ends the drain. The anchor is taken from the last row of
      // the page BEFORE its rows are handled, so it advances no matter how each
      // row resolved and the next query can never return this page again.
      const last = rows[rows.length - 1];
      if (last === undefined) {
        return;
      }
      after = { expiresAt: last.expires_at, id: last.id };

      for (const row of rows) {
        if (row.state !== 'available') {
          // Processing rows go through the recovery pass; terminal rows
          // cannot appear in the expirable set. The cursor already moved past
          // them, so they cannot block the rows behind them.
          continue;
        }
        const marked = this.deps.imageRepo.markUnavailable(row.id, 'expired');
        if (marked.isErr()) {
          report.failures++;
          this.deps.logger.warn(
            { imageId: row.id, op: 'image_retention_expire', code: marked.error.code },
            'image retention sweep: expiry transition failed; will retry next sweep',
          );
          continue;
        }
        report.expired++;
        this.audit('image.retention.expired', { imageId: row.id });
        const removed = this.deleteNormalizedFile(row.thread_id, row.id);
        if (!removed) report.failures++;
      }
    }
  }

  /**
   * Removes owned files that are no longer recoverable:
   * - staging directories whose Image row was never committed. The grace
   *   window prevents deleting staging of admissions that are in flight
   *   right now; the filesystem scan makes cleanup survive arbitrary
   *   restart counts, unlike a ledger-only sweep.
   * - staging of RESOLVED Images (available/rejected/unavailable). Their
   *   source is consumed or dead: any remaining staging directory is a
   *   crash remnant of the post-commit deletion, so its removal is retried
   *   immediately instead of being retained forever (P1-3). Only staging
   *   of PROCESSING rows is preserved — that is live or recoverable work.
   * - normalized outputs of terminal Images (deletion retry) and outputs
   *   whose row no longer exists. Processing remnants are the recovery
   *   pass's job: the coordinator reconciles them against the deadline.
   */
  private cleanupPass(report: ImagePassReport): void {
    const now = this.clock();

    // -- Staging ------------------------------------------------------------
    const deliveries = this.deps.store.listStagingDeliveries();
    for (const deliveryUuid of deliveries) {
      const found = this.deps.imageRepo.findById(deliveryUuid);
      if (found.isErr()) {
        report.failures++;
        this.deps.logger.warn(
          { imageId: deliveryUuid, op: 'image_cleanup_staging_lookup', code: found.error.code },
          'image cleanup: staging row lookup failed; will retry next sweep',
        );
        continue;
      }
      if (found.value !== null) {
        const state = found.value.state;
        if (state === 'processing') {
          // Live or recoverable ingestion owns this staging directory.
          continue;
        }
        // Resolved Image: the source was consumed at publication or the work
        // ended terminal. A staging directory left behind is deletion
        // garbage — retry its removal now (P1-3).
        const removedResolved = this.deps.store.removeStagingDir(deliveryUuid);
        if (removedResolved.isErr()) {
          report.failures++;
          this.audit('image.cleanup.failed', {
            imageId: deliveryUuid,
            kind: `resolved_staging:${state}`,
            code: removedResolved.error.code,
          });
          continue;
        }
        report.cleaned++;
        this.audit('image.cleanup', {
          imageId: deliveryUuid,
          kind: `resolved_staging:${state}`,
          deleted: true,
        });
        continue;
      }

      const mtime = this.stagingMtimeMs(deliveryUuid);
      // An unreadable directory (vanishing under us) is treated as already
      // gone; the next pass confirms.
      if (mtime === null) continue;
      if (now - mtime <= this.orphanGraceMs) continue;

      const removed = this.deps.store.removeStagingDir(deliveryUuid);
      if (removed.isErr()) {
        report.failures++;
        this.audit('image.cleanup.failed', {
          imageId: deliveryUuid,
          kind: 'orphan_staging',
          code: removed.error.code,
        });
        continue;
      }
      report.cleaned++;
      this.audit('image.cleanup', { imageId: deliveryUuid, kind: 'orphan_staging', deleted: true });
    }

    // -- Normalized outputs ---------------------------------------------------
    const threadDirs = this.listThreadDirs();
    for (const threadId of threadDirs) {
      const imagesDir = this.deps.store.threadImagesDir(threadId);
      if (imagesDir.isErr()) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(imagesDir.value, { withFileTypes: true });
      } catch {
        // Directory absent or unreadable: nothing to clean this pass.
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jpg')) continue;
        const imageId = entry.name.slice(0, -'.jpg'.length);
        const found = this.deps.imageRepo.findById(imageId);
        if (found.isErr()) {
          report.failures++;
          this.deps.logger.warn(
            { imageId, op: 'image_cleanup_output_lookup', code: found.error.code },
            'image cleanup: output row lookup failed; will retry next sweep',
          );
          continue;
        }
        const row = found.value;
        if (row !== null && row.thread_id !== threadId) continue; // defensive: never cross-delete

        let kind: string | null = null;
        if (row === null) {
          kind = 'orphan_output';
        } else if (row.state === 'rejected' || row.state === 'unavailable') {
          kind = `terminal_output:${row.state}`;
        } else {
          continue; // available/processing are retained here
        }

        const removed = this.deleteFileAt(imagesDir.value, entry.name, imageId);
        if (!removed) {
          report.failures++;
          continue;
        }
        report.cleaned++;
        this.audit('image.cleanup', {
          imageId,
          threadId: row !== null ? row.thread_id : threadId,
          kind,
          deleted: true,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // File helpers
  // -------------------------------------------------------------------------

  private deleteNormalizedFile(threadId: string, imageId: string): boolean {
    const pathResult = this.deps.store.normalizedPath(threadId, imageId);
    if (pathResult.isErr()) {
      this.audit('image.cleanup.failed', {
        imageId,
        kind: 'expired_output',
        code: pathResult.error.code,
      });
      return false;
    }
    const removed = this.deps.store.removeFile(pathResult.value);
    if (removed.isErr()) {
      this.audit('image.cleanup.failed', {
        imageId,
        kind: 'expired_output',
        code: removed.error.code,
      });
    }
    return removed.isOk();
  }

  private stagingMtimeMs(deliveryUuid: string): number | null {
    const dir = this.deps.store.stagingDir(deliveryUuid);
    if (dir.isErr()) return null;
    try {
      return fs.statSync(dir.value).mtimeMs;
    } catch {
      return null;
    }
  }

  private deleteFileAt(dir: string, fileName: string, imageId: string): boolean {
    try {
      const target = path.join(dir, fileName);
      fs.rmSync(target, { force: true });
      return true;
    } catch (cause) {
      // fs error MESSAGES embed the absolute path; persist only the
      // structured code plus the Image ID (P2-5).
      this.audit('image.cleanup.failed', {
        imageId,
        kind: 'output',
        code: errorCode(cause),
      });
      return false;
    }
  }

  private listThreadDirs(): string[] {
    const root = path.join(this.deps.dataDir, 'threads');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  private audit(action: string, details: Record<string, unknown>): void {
    const entry: AuditEntry = { action, details };
    this.deps.auditStore.append(entry);
    this.deps.logger.info({ details, audit: true }, action);
  }
}

/**
 * Reduces an unknown thrown value to a structured, persistence-safe error
 * code. Messages are NEVER used in logs or audit: they routinely embed
 * absolute paths and could carry credentials. Only short machine tokens
 * (fs `code`, Error `name`) pass through, and only when they match a
 * conservative safe-token shape.
 */
function errorCode(cause: unknown): string {
  // Guard BOTH null and undefined: property access on either throws, and
  // `undefined !== null` alone would let undefined through the old gate (F6).
  if (cause === null || cause === undefined) {
    return 'unknown';
  }
  const code = (cause as { code?: unknown }).code;
  if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) {
    return code;
  }
  if (cause instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(cause.name)) {
    return cause.name;
  }
  return 'unknown';
}

/**
 * In-memory diagnostics message for {@link ImagePassReport} ONLY. Must never
 * be forwarded to a logger, the audit store, or any persisted surface.
 */
function diagnosticMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message.slice(0, 500);
  }
  return 'unknown error';
}
