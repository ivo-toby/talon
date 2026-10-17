/**
 * Unit tests for ImageLifecycleManager (TASK-010, spec part (b)).
 *
 * Real migrated in-memory SQLite, a real ImageRepository, and a real
 * ImageStore over a temp directory; the coordinator and audit store are
 * deterministic fakes, the clock is injectable, and the `runOnce` seam
 * isolates scheduling/fence/drain behavior from the pass body. No fake
 * timers are needed for the pass-body tests because the manager's clock is
 * injected; fake timers drive the scheduling tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { ok, err, type Result } from 'neverthrow';
import { v4 as uuidv4 } from 'uuid';
import { createTestDb } from '../queue/helpers.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { ImageRepository, type ImageRow } from '../../../src/core/database/repositories/image-repository.js';
import { ImageIngestionRepository } from '../../../src/core/database/repositories/image-ingestion-repository.js';
import type { AuditEntry, AuditStore } from '../../../src/core/logging/audit-logger.js';
import { PipelineError } from '../../../src/core/errors/index.js';
import type {
  ImageIngestionCoordinator,
  RecoverPendingOptions,
  RecoveryReport,
} from '../../../src/images/image-ingestion.js';
import { ImageStore } from '../../../src/images/image-store.js';
import {
  ImageLifecycleManager,
  IMAGE_SWEEP_INTERVAL_MS,
  ORPHAN_STAGING_GRACE_MS,
  type ImageLifecycleDeps,
  type ImagePassReport,
} from '../../../src/images/image-lifecycle.js';
import { IMAGE_SHUTDOWN_DRAIN_TIMEOUT_MS } from '../../../src/images/image-ingestion.js';
import type { ImageRejectionReason } from '../../../src/images/image-types.js';

// ---------------------------------------------------------------------------
// Fixture scaffolding
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const RETENTION_MS = 24 * 3_600_000;

function baseReport(): ImagePassReport {
  return { recovered: null, recoveryError: null, expired: 0, cleaned: 0, failures: 0 };
}

interface LifecycleFixture {
  db: Database.Database;
  tmpDir: string;
  threadId: string;
  channelId: string;
  store: ImageStore;
  imageRepo: ImageRepository;
  ingestionRepo: ImageIngestionRepository;
  messageRepo: MessageRepository;
  recoverPending: ReturnType<typeof vi.fn>;
  coordinator: ImageIngestionCoordinator;
  auditEntries: AuditEntry[];
  auditStore: AuditStore;
  now: number;
  makeManager(overrides?: Partial<ImageLifecycleDeps>): ImageLifecycleManager;
  seedImage(opts?: {
    expiresAt?: number;
    deadlineAt?: number;
    available?: boolean;
    rejectionReason?: ImageRejectionReason;
    unavailableReason?: 'expired' | 'file_missing';
    filename?: string;
    width?: number;
    height?: number;
    exif?: string | null;
  }): ImageRow;
  makeOrphanStaging(deliveryUuid: string, mtimeMs: number): void;
}

function setup(): LifecycleFixture {
  const db = createTestDb();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talon-image-lifecycle-'));
  const store = new ImageStore(tmpDir);

  const channelRepo = new ChannelRepository(db);
  const threadRepo = new ThreadRepository(db);
  const messageRepo = new MessageRepository(db);
  const imageRepo = new ImageRepository(db);
  const ingestionRepo = new ImageIngestionRepository(db);

  const channelId = uuidv4();
  channelRepo
    .insert({
      id: channelId,
      type: 'telegram',
      name: 'test-bot',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    })
    ._unsafeUnwrap();
  const threadId = uuidv4();
  threadRepo
    .insert({ id: threadId, channel_id: channelId, external_id: 'ext-chat-1', metadata: '{}' })
    ._unsafeUnwrap();

  const auditEntries: AuditEntry[] = [];
  const auditStore: AuditStore = { append: (entry: AuditEntry) => auditEntries.push(entry) };

  const recoverPending = vi.fn(
    async (_options: RecoverPendingOptions): Promise<Result<RecoveryReport, PipelineError>> =>
      ok({ inspected: 0, enqueued: 0, skipped: 0, failed: 0 }),
  );
  const coordinator = { recoverPending } as unknown as ImageIngestionCoordinator;

  const fixture: LifecycleFixture = {
    db,
    tmpDir,
    threadId,
    channelId,
    store,
    imageRepo,
    ingestionRepo,
    messageRepo,
    recoverPending,
    coordinator,
    auditEntries,
    auditStore,
    now: T0,
    makeManager(overrides: Partial<ImageLifecycleDeps> = {}) {
      return new ImageLifecycleManager({
        coordinator: fixture.coordinator,
        imageRepo: fixture.imageRepo,
        store: fixture.store,
        dataDir: fixture.tmpDir,
        auditStore: fixture.auditStore,
        logger: pino({ level: 'silent' }),
        now: () => fixture.now,
        ...overrides,
      });
    },
    seedImage(opts: {
      expiresAt?: number;
      deadlineAt?: number;
      available?: boolean;
      rejectionReason?: ImageRejectionReason;
      unavailableReason?: 'expired' | 'file_missing';
      filename?: string;
      width?: number;
      height?: number;
      exif?: string | null;
    } = {}) {
      const messageId = uuidv4();
      const imageId = uuidv4();
      fixture.messageRepo
        .insert({
          id: messageId,
          thread_id: fixture.threadId,
          direction: 'inbound',
          content: 'with image',
          idempotency_key: `${fixture.channelId}:${messageId}`,
          provider_id: 'user-1',
          run_id: null,
        })
        ._unsafeUnwrap();
      const source = fixture.ingestionRepo
        .resolveSourceMessage({
          channel: 'test-bot',
          externalMessageId: `ext-${messageId}`,
          externalChatId: 'ext-chat-1',
        })
        ._unsafeUnwrap();
      let row = fixture.imageRepo
        .insert({
          id: imageId,
          messageId,
          ordinal: 0,
          threadId: fixture.threadId,
          sourceRef: source.id,
          state: 'processing',
          expiresAt: opts.expiresAt ?? fixture.now + RETENTION_MS,
          processingDeadlineAt: opts.deadlineAt ?? fixture.now + 60_000,
          filename: opts.filename,
          mimeType: 'image/png',
          width: opts.width,
          height: opts.height,
          exif: opts.exif,
        })
        ._unsafeUnwrap();
      if (opts.rejectionReason !== undefined) {
        row = fixture.imageRepo.reject(imageId, opts.rejectionReason)._unsafeUnwrap();
      } else if (opts.available) {
        row = fixture.imageRepo.markAvailable(imageId)._unsafeUnwrap();
      }
      if (opts.unavailableReason !== undefined) {
        row = fixture.imageRepo.markUnavailable(imageId, opts.unavailableReason)._unsafeUnwrap();
      }
      return row;
    },
    makeOrphanStaging(deliveryUuid: string, mtimeMs: number): void {
      const dir = fixture.store.stagingDir(deliveryUuid)._unsafeUnwrap();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'source.bin'), 'ORPHAN-BYTES');
      fs.utimesSync(dir, mtimeMs / 1000, mtimeMs / 1000);
    },
  };
  return fixture;
}

function writeNormalized(f: LifecycleFixture, imageId: string, bytes: Buffer = Buffer.from('JPEG-BYTES')): string {
  const target = f.store.normalizedPath(f.threadId, imageId)._unsafeUnwrap();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImageLifecycleManager', () => {
  let f: LifecycleFixture;

  beforeEach(() => {
    f = setup();
  });

  afterEach(() => {
    f.db.close();
    fs.rmSync(f.tmpDir, { recursive: true, force: true });
    // Timer spies (guard A/B tests) must not leak into later tests.
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Scheduling (runOnce seam + fake timers)
  // -------------------------------------------------------------------------

  describe('scheduling', () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: T0 });
    });

    it('runs the first pass immediately at start and then at most every 60 seconds', async () => {
      expect(IMAGE_SWEEP_INTERVAL_MS).toBe(60_000);
      const runs = vi.fn(async (): Promise<ImagePassReport> => baseReport());
      const manager = f.makeManager({ runOnce: runs });

      const outcome = await manager.start();
      expect(outcome).toEqual({ completed: true, timedOut: false, report: baseReport() });
      expect(runs).toHaveBeenCalledTimes(1); // startup pass is immediate

      await vi.advanceTimersByTimeAsync(59_999);
      expect(runs).toHaveBeenCalledTimes(1); // at most every 60s — not yet

      await vi.advanceTimersByTimeAsync(1);
      expect(runs).toHaveBeenCalledTimes(2);

      await manager.stop();
    });

    it('never overlaps passes and keeps a DUE-TIME cadence: an over-long pass is followed immediately, not one interval after completion', async () => {
      // P2-4: cadence is start-to-start. A pass that overruns the interval
      // is already overdue when it finishes, so the next pass runs at once
      // (still never overlapping the running one).
      let inFlight = 0;
      let maxInFlight = 0;
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runs = vi.fn(async (): Promise<ImagePassReport> => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight--;
        return baseReport();
      });
      // The manager clock must track the FAKE timer clock so the due-time
      // arithmetic sees the 90-second overrun (the default fixture clock is
      // pinned at T0).
      const manager = f.makeManager({ runOnce: runs, now: () => Date.now() });

      const startup = manager.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(runs).toHaveBeenCalledTimes(1);

      // The interval elapses while pass 1 is STILL running: no overlap.
      await vi.advanceTimersByTimeAsync(90_000);
      expect(runs).toHaveBeenCalledTimes(1);
      expect(maxInFlight).toBe(1);

      release();
      await startup; // the awaited startup settles with the overdue pass
      await vi.advanceTimersByTimeAsync(0);
      // The pass started at T0 and ended at T0+90s: the next pass (due at
      // T0+60s) runs IMMEDIATELY after completion, not a full interval later.
      expect(runs).toHaveBeenCalledTimes(2);

      // Pass 2 (gate already open) anchors the next due time: cadence holds.
      await vi.advanceTimersByTimeAsync(59_999);
      expect(runs).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(runs).toHaveBeenCalledTimes(3);

      expect(maxInFlight).toBe(1); // two passes never overlap
      await manager.stop();
    });

    it('the awaited start settles only when a slow recovery pass settles (P1-1 gate)', async () => {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runs = vi.fn(async (): Promise<ImagePassReport> => {
        await gate;
        return baseReport();
      });
      const manager = f.makeManager({ runOnce: runs });

      const startup = manager.start();
      await vi.advanceTimersByTimeAsync(0);
      let settled = false;
      void startup.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false); // recovery still running → caller still gated

      release();
      const outcome = await startup;
      expect(outcome).toEqual({ completed: true, timedOut: false, report: baseReport() });
      await manager.stop();
    });

    it('a wedged startup pass times out the wait with structured evidence instead of blocking forever', async () => {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const logged: unknown[][] = [];
      const logger = {
        debug: () => undefined,
        info: (...args: unknown[]) => logged.push(args),
        warn: (...args: unknown[]) => logged.push(args),
        error: (...args: unknown[]) => logged.push(args),
        fatal: () => undefined,
      } as unknown as pino.Logger;
      const runs = vi.fn(async (): Promise<ImagePassReport> => {
        await gate;
        return baseReport();
      });
      const manager = f.makeManager({ runOnce: runs, logger });

      const startup = manager.start(5_000); // bounded wait
      await vi.advanceTimersByTimeAsync(5_000);
      const outcome = await startup;

      // Fail closed to the BOUND: the caller proceeds with a typed outcome.
      expect(outcome).toEqual({ completed: false, timedOut: true, report: null });
      expect(JSON.stringify(logged)).toContain('STARTUP_RECOVERY_TIMEOUT');
      // F1: the timeout leaves DURABLE audit evidence — the aborted boot is
      // provable after the fact, not just visible in the log stream.
      expect(JSON.stringify(f.auditEntries)).toContain('image.startup.recovery_timeout');

      // The wedged pass is still drainable by stop().
      release();
      await manager.stop();
      expect(manager.isStarted).toBe(false);
    });

    it('start() is idempotent and isStarted tracks the lifecycle', async () => {
      const runs = vi.fn(async (): Promise<ImagePassReport> => baseReport());
      const manager = f.makeManager({ runOnce: runs });

      expect(manager.isStarted).toBe(false);
      const first = manager.start();
      const second = manager.start();
      expect(second).toBe(first); // same awaited outcome, one pass
      await first;
      expect(runs).toHaveBeenCalledTimes(1);
      expect(manager.isStarted).toBe(true);

      await manager.stop();
      expect(manager.isStarted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // stop() fence and drain
  // -------------------------------------------------------------------------

  describe('stop()', () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: T0 });
    });

    it('fences further passes after the drain', async () => {
      const runs = vi.fn(async (): Promise<ImagePassReport> => baseReport());
      const manager = f.makeManager({ runOnce: runs });

      manager.start();
      await vi.advanceTimersByTimeAsync(0); // pass 1 completes
      expect(runs).toHaveBeenCalledTimes(1);

      await manager.stop();

      // Several full intervals after the fence: no new pass may start.
      await vi.advanceTimersByTimeAsync(4 * IMAGE_SWEEP_INTERVAL_MS);
      expect(runs).toHaveBeenCalledTimes(1);
    });

    it('drains the in-flight pass before stop() resolves', async () => {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let passDone = false;
      const runs = vi.fn(async (): Promise<ImagePassReport> => {
        await gate;
        passDone = true;
        return baseReport();
      });
      const manager = f.makeManager({ runOnce: runs });

      manager.start();
      await vi.advanceTimersByTimeAsync(0); // pass 1 in flight
      expect(passDone).toBe(false);

      let stopResolved = false;
      const stopPromise = manager.stop().then(() => {
        stopResolved = true;
      });
      await vi.advanceTimersByTimeAsync(0); // settle microtasks only
      expect(passDone).toBe(false);
      expect(stopResolved).toBe(false); // still draining the in-flight pass

      release();
      await stopPromise;
      expect(passDone).toBe(true); // the pass completed (drained)
      expect(stopResolved).toBe(true);
    });

    it('stop() reports drained=true when the pass settles within the bound (F4)', async () => {
      const manager = f.makeManager({ runOnce: async () => baseReport() });
      await manager.start();
      expect(await manager.stop()).toEqual({ drained: true });
    });

    it('stop() bounds the drain and reports a wedged pass instead of hanging (F4)', async () => {
      // The daemon awaits lifecycle.stop() BEFORE the bounded delivery
      // drain; an unbounded wait here would hang shutdown forever.
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const logged: unknown[][] = [];
      const logger = {
        debug: () => undefined,
        info: () => undefined,
        warn: (...args: unknown[]) => logged.push(args),
        error: (...args: unknown[]) => logged.push(args),
        fatal: () => undefined,
      } as unknown as pino.Logger;
      const runs = vi.fn(async (): Promise<ImagePassReport> => {
        await gate;
        return baseReport();
      });
      const manager = f.makeManager({ runOnce: runs, logger });

      const startup = manager.start();
      await vi.advanceTimersByTimeAsync(0); // pass wedged in flight

      let drained: boolean | null = null;
      const stopPromise = manager.stop(1_000).then((r) => {
        drained = r.drained;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(drained).toBe(null); // still inside the bound
      await vi.advanceTimersByTimeAsync(1);
      await stopPromise; // shutdown terminates WITHIN the bound

      expect(drained).toBe(false);
      expect(JSON.stringify(logged)).toContain('PASS_WEDGED_AFTER_BOUND');

      release();
      await startup;
    });

    it('a pass wedged at recovery skips its remaining ledger phases after the stop fence (F4)', async () => {
      // Real runPass with a wedged recovery phase: once stop() has timed
      // out and the daemon proceeds toward closing the database, the
      // retention and cleanup phases must NOT write through that DB.
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const expired = f.seedImage({ available: true, expiresAt: f.now - 1 });
      const normalized = writeNormalized(f, expired.id);

      const recoverPending = vi.fn(
        (): Promise<Result<RecoveryReport, PipelineError>> =>
          gate.then(() => ok({ inspected: 0, enqueued: 0, skipped: 0, failed: 0 })),
      );
      const manager = f.makeManager({
        coordinator: { recoverPending } as unknown as ImageIngestionCoordinator,
      });

      const startup = manager.start();
      await vi.advanceTimersByTimeAsync(0);
      const stopPromise = manager.stop(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const stop = await stopPromise;
      expect(stop.drained).toBe(false);

      release();
      await vi.advanceTimersByTimeAsync(0);
      await startup;

      // Retention and cleanup never ran: the expired Image keeps its state
      // and file — durable-deferred to the next boot's sweep.
      const row = f.imageRepo.findById(expired.id)._unsafeUnwrap()!;
      expect(row.state).toBe('available');
      expect(fs.existsSync(normalized)).toBe(true);
    });

    it('a startup timeout observed AFTER stop() does not append the recovery_timeout audit (P2-1)', async () => {
      // Supervisor-confirmed repro: start(30_000) wedges; stop(15_000)
      // times out first and the daemon retires + closes the database;
      // the ORIGINAL startup bound only fires later, against a manager
      // whose closure already began. The late timeout outcome must NOT
      // append durable audit through the closing ledger — same
      // stopped-fence as the recoverPass aggregate (positive control for
      // the un-stopped audit is the wedged-startup-timeout test above).
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const recoverPending = vi.fn(
        (): Promise<Result<RecoveryReport, PipelineError>> =>
          gate.then(() => ok({ inspected: 1, enqueued: 0, skipped: 0, failed: 0 })),
      );
      const manager = f.makeManager({
        coordinator: { recoverPending } as unknown as ImageIngestionCoordinator,
      });

      const startup = manager.start(30_000);
      await vi.advanceTimersByTimeAsync(0); // pass parked inside recovery
      const stopPromise = manager.stop(15_000);
      await vi.advanceTimersByTimeAsync(15_000);
      const stop = await stopPromise;
      expect(stop.drained).toBe(false);
      // Teardown proceeds: retire + database close would happen HERE.

      // The parked pass stays unfinished past the ORIGINAL startup bound.
      await vi.advanceTimersByTimeAsync(30_001);
      const outcome = await startup;
      expect(outcome.timedOut).toBe(true);
      expect(outcome.completed).toBe(false);
      expect(JSON.stringify(f.auditEntries)).not.toContain('image.startup.recovery_timeout');

      release();
      await vi.advanceTimersByTimeAsync(0);
      // Still nothing appended once the parked pass finally drains past
      // the stop fence.
      expect(JSON.stringify(f.auditEntries)).not.toContain('image.startup.recovery_timeout');
    });

    it('a recovery that resolves after stop() skips its aggregate audit append (R1)', async () => {
      // The aggregate recovery audit is a DURABLE append. When stop()
      // timed out, the daemon proceeds toward closing the database, so
      // the append must observe the stop fence — the next boot's pass
      // re-derives the aggregate from durable state anyway. Without the
      // fence this write would hit a closing ledger (positive control for
      // the un-stopped audit lives in the recovery-audit tests below).
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const recoverPending = vi.fn(
        (): Promise<Result<RecoveryReport, PipelineError>> =>
          gate.then(() => ok({ inspected: 2, enqueued: 1, skipped: 0, failed: 1 })),
      );
      const manager = f.makeManager({
        coordinator: { recoverPending } as unknown as ImageIngestionCoordinator,
      });

      const startup = manager.start();
      await vi.advanceTimersByTimeAsync(0);
      const stopPromise = manager.stop(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const stop = await stopPromise;
      expect(stop.drained).toBe(false);

      release();
      await vi.advanceTimersByTimeAsync(0);
      await startup;

      // Recovery DID inspect work (inspected: 2) — yet no aggregate audit
      // was appended once the stop fence was set.
      expect(recoverPending).toHaveBeenCalledOnce();
      expect(f.auditEntries.map((e) => e.action)).not.toContain('image.recovery.pass');
    });

    it('a pass finishing after stop() does not reschedule a new sweep', async () => {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runs = vi.fn(async (): Promise<ImagePassReport> => {
        await gate;
        return baseReport();
      });
      const manager = f.makeManager({ runOnce: runs });

      const startup = manager.start();
      await vi.advanceTimersByTimeAsync(0);
      const stopPromise = manager.stop(); // fences while pass 1 is in flight
      release();
      await stopPromise; // drain completes
      await vi.advanceTimersByTimeAsync(0);

      // The pass completed AFTER the fence; its completion must not arm a sweep.
      await vi.advanceTimersByTimeAsync(4 * IMAGE_SWEEP_INTERVAL_MS);
      expect(runs).toHaveBeenCalledTimes(1);
      await startup;
    });

    it('arming guard: no new sweep timer is armed once stop() has been called', async () => {
      // Targets guard A alone (the arming check). Removing only the
      // `stopped` clause in the arming path turns THIS test red even while
      // the callback guard still suppresses passes.
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runs = vi.fn(async (): Promise<ImagePassReport> => {
        await gate;
        return baseReport();
      });
      const fakeSetTimeout = globalThis.setTimeout;
      let fenced = false;
      let armedAfterFence = 0;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
          // The bounded stop() itself arms a drain-bound timer (F4); that
          // is not a sweep arm. Guard A is about SWEEP timers only.
          if (fenced && ms !== IMAGE_SHUTDOWN_DRAIN_TIMEOUT_MS) armedAfterFence++;
          return fakeSetTimeout(
            fn as (...a: unknown[]) => void,
            ms as number | undefined,
            ...(args as unknown[]),
          ) as unknown as ReturnType<typeof setTimeout>;
        }) as unknown as typeof setTimeout,
      );

      const manager = f.makeManager({ runOnce: runs });
      const startup = manager.start(); // timers created BEFORE the fence
      await vi.advanceTimersByTimeAsync(0); // pass 1 in flight

      fenced = true;
      const stopPromise = manager.stop();
      release();
      await stopPromise;
      await vi.advanceTimersByTimeAsync(0);

      expect(armedAfterFence).toBe(0); // the completion callback must not arm anything
      await startup;
    });

    it('callback guard: a stale armed callback firing after the fence starts no pass', async () => {
      // Targets guard B alone (the in-callback re-check). A timer armed
      // BEFORE stop() and fired manually AFTER it must be inert.
      const captured: Array<() => void> = [];
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        ((fn: () => void) => {
          captured.push(fn);
          return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
        }) as unknown as typeof setTimeout,
      );
      vi.spyOn(globalThis, 'clearTimeout').mockImplementation(
        (() => undefined) as unknown as typeof clearTimeout,
      );

      const runs = vi.fn(async (): Promise<ImagePassReport> => baseReport());
      const manager = f.makeManager({ runOnce: runs });

      await manager.start(); // startup pass completes; next sweep armed
      expect(runs).toHaveBeenCalledTimes(1);
      const staleSweepCallback = captured[captured.length - 1]!;

      await manager.stop();
      staleSweepCallback(); // stale timer fires after the fence
      await vi.advanceTimersByTimeAsync(0);

      expect(runs).toHaveBeenCalledTimes(1); // callback guard kept it inert
    });
  });

  // -------------------------------------------------------------------------
  // Recovery pass
  // -------------------------------------------------------------------------

  describe('recovery pass', () => {
    it('delegates the whole recovery pass to coordinator.recoverPending and records its report', async () => {
      f.recoverPending.mockResolvedValueOnce(
        ok({ inspected: 3, enqueued: 1, skipped: 1, failed: 1 } satisfies RecoveryReport),
      );
      const manager = f.makeManager();

      const report = await manager.runPass();

      expect(f.recoverPending).toHaveBeenCalledTimes(1);
      expect(f.recoverPending).toHaveBeenCalledWith({}); // unscoped startup pass
      expect(report.recovered).toEqual({ inspected: 3, enqueued: 1, skipped: 1, failed: 1 });
      expect(report.recoveryError).toBeNull();
      expect(f.auditEntries).toContainEqual({
        action: 'image.recovery.pass',
        details: { inspected: 3, enqueued: 1, skipped: 1, failed: 1 },
      });
    });

    it('records a recovery Err as a sanitized recoveryError without stopping the pass', async () => {
      const expired = f.seedImage({ available: true, expiresAt: f.now + 1000 });
      writeNormalized(f, expired.id);
      f.recoverPending.mockResolvedValueOnce(err(new PipelineError('db down (simulated)')));

      f.now += 1000; // the seeded Image is now past its original expiry
      const report = await f.makeManager().runPass();

      expect(report.recovered).toBeNull();
      expect(report.recoveryError).toBe('db down (simulated)');
      expect(report.failures).toBe(1);
      // Retention still ran in the same pass:
      expect(report.expired).toBe(1);
      expect(f.imageRepo.findById(expired.id)._unsafeUnwrap()!.state).toBe('unavailable');
    });

    it('contains a throwing coordinator and the sweep keeps running', async () => {
      vi.useFakeTimers({ now: T0 });
      f.recoverPending.mockRejectedValueOnce(new Error('coordinator exploded'));
      f.recoverPending.mockResolvedValue(ok({ inspected: 0, enqueued: 0, skipped: 0, failed: 0 }));
      const manager = f.makeManager();

      const outcome = await manager.start(); // pass 1: recovery throws, contained
      expect(outcome.completed).toBe(true);
      expect(outcome.report?.recoveryError).toBe('coordinator exploded');
      await vi.advanceTimersByTimeAsync(IMAGE_SWEEP_INTERVAL_MS); // pass 2: recovery recovers
      expect(f.recoverPending).toHaveBeenCalledTimes(2);

      await manager.stop();
    });

    it('audits a recovery pass only when work was inspected', async () => {
      f.recoverPending.mockResolvedValueOnce(ok({ inspected: 0, enqueued: 0, skipped: 0, failed: 0 }));
      await f.makeManager().runPass();
      expect(f.auditEntries).toEqual([]);

      f.auditEntries.length = 0;
      f.recoverPending.mockResolvedValueOnce(ok({ inspected: 2, enqueued: 0, skipped: 2, failed: 0 }));
      await f.makeManager().runPass();
      expect(f.auditEntries).toEqual([
        {
          action: 'image.recovery.pass',
          details: { inspected: 2, enqueued: 0, skipped: 2, failed: 0 },
        },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Retention pass
  // -------------------------------------------------------------------------

  describe('retention pass', () => {
    it('expires only Available images past their original admission expires_at', async () => {
      const expired = f.seedImage({ available: true, expiresAt: f.now + 1000 });
      const fresh = f.seedImage({ available: true, expiresAt: f.now + 3_600_000 });
      const processingExpired = f.seedImage({ expiresAt: f.now - 1000 }); // processing: recovery owns it
      const rejected = f.seedImage({ rejectionReason: 'unsupported_mime', expiresAt: f.now - 2000 });
      writeNormalized(f, expired.id);
      writeNormalized(f, fresh.id);

      f.now += 1000; // past the first expiry (counted from the original admission)
      const report = await f.makeManager().runPass();

      expect(report.expired).toBe(1);
      const r1 = f.imageRepo.findById(expired.id)._unsafeUnwrap()!;
      expect(r1.state).toBe('unavailable');
      expect(r1.unavailability_reason).toBe('expired');
      // Expiry was counted from the ORIGINAL durable admission clock:
      expect(r1.expires_at).toBe(T0 + 1000);
      expect(f.store.normalizedExists(f.threadId, expired.id)).toBe(false);
      expect(f.imageRepo.findById(fresh.id)._unsafeUnwrap()!.state).toBe('available');
      expect(f.imageRepo.findById(processingExpired.id)._unsafeUnwrap()!.state).toBe('processing');
      expect(f.imageRepo.findById(rejected.id)._unsafeUnwrap()!.state).toBe('rejected');
      expect(f.auditEntries).toContainEqual({
        action: 'image.retention.expired',
        details: { imageId: expired.id },
      });
    });

    it('records expiry BEFORE file_missing: an expired image whose file already vanished records expired', async () => {
      const img = f.seedImage({ available: true, expiresAt: f.now + 1000 });
      // No normalized file was written: both conditions hold at once.
      f.now += 1000;

      const report = await f.makeManager().runPass();

      expect(report.expired).toBe(1);
      const row = f.imageRepo.findById(img.id)._unsafeUnwrap()!;
      expect(row.state).toBe('unavailable');
      expect(row.unavailability_reason).toBe('expired'); // not file_missing
    });

    it('never overwrites a recorded terminal reason', async () => {
      const fileMissing = f.seedImage({
        available: true,
        expiresAt: f.now + 1000,
        unavailableReason: 'file_missing',
      });
      const alreadyExpired = f.seedImage({
        available: true,
        expiresAt: f.now + 1000,
        unavailableReason: 'expired',
      });
      const rejected = f.seedImage({ rejectionReason: 'size_limit', expiresAt: f.now + 1000 });

      f.now += 5000; // far past every original expiry
      const report = await f.makeManager().runPass();

      expect(report.expired).toBe(0);
      expect(f.imageRepo.findById(fileMissing.id)._unsafeUnwrap()!.unavailability_reason).toBe(
        'file_missing',
      );
      expect(f.imageRepo.findById(alreadyExpired.id)._unsafeUnwrap()!.unavailability_reason).toBe(
        'expired',
      );
      expect(f.imageRepo.findById(rejected.id)._unsafeUnwrap()!.rejection_reason).toBe('size_limit');
    });

    it('audits a failed expired-output deletion and retries the deletion on the next pass', async () => {
      const img = f.seedImage({
        available: true,
        expiresAt: f.now + 1000,
        filename: 'photo?access_token=SECRET_CANARY.jpg',
      });
      const target = writeNormalized(f, img.id);
      let failFirst = true;
      const originalRemove = f.store.removeFile.bind(f.store);
      f.store.removeFile = (p: string) => {
        if (failFirst) {
          failFirst = false;
          return err({ code: 'io', retryable: true, message: 'EACCES (simulated)' });
        }
        return originalRemove(p);
      };

      f.now += 1000;
      const first = await f.makeManager().runPass();
      expect(first.expired).toBe(1);
      expect(first.failures).toBe(1); // the failed deletion is recorded, not swallowed
      // P2-5: persisted evidence carries the structured CODE, never the message.
      expect(f.auditEntries).toContainEqual({
        action: 'image.cleanup.failed',
        details: { imageId: img.id, kind: 'expired_output', code: 'io' },
      });

      // The cleanup phase retries the deletion of the now-terminal output
      // (same pass here; a cleanup phase without the terminal-output retry
      // would leave the file behind past the first failed deletion).
      expect(first.cleaned).toBe(1);
      expect(fs.existsSync(target)).toBe(false);
      expect(f.auditEntries).toContainEqual({
        action: 'image.cleanup',
        details: { imageId: img.id, threadId: f.threadId, kind: 'terminal_output:unavailable', deleted: true },
      });

      // A subsequent pass confirms the terminal output stays gone.
      const second = await f.makeManager().runPass();
      expect(second.expired).toBe(0);
      expect(second.cleaned).toBe(0);
      expect(fs.existsSync(target)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup pass — orphan staging and terminal outputs
  // -------------------------------------------------------------------------

  describe('cleanup pass', () => {
    it('removes old orphan staging AND staging of RESOLVED Images; keeps young orphans and Processing staging (P1-3)', async () => {
      expect(ORPHAN_STAGING_GRACE_MS).toBe(60_000);
      const oldOrphan = 'orphan-old';
      const youngOrphan = 'orphan-young';
      // Processing: live or recoverable work owns its staging — even when old.
      const processingId = f.seedImage({ expiresAt: f.now + 3_600_000 }).id;
      // Resolved Images: the source was consumed at publication or the work
      // ended terminal; leftovers are deletion garbage retried NOW.
      const availableId = f.seedImage({ available: true, expiresAt: f.now + 3_600_000 }).id;
      const rejectedId = f.seedImage({ rejectionReason: 'size_limit', expiresAt: f.now + 3_600_000 }).id;

      f.makeOrphanStaging(oldOrphan, f.now - ORPHAN_STAGING_GRACE_MS - 1000);
      f.makeOrphanStaging(youngOrphan, f.now); // in-flight admission window
      f.makeOrphanStaging(processingId, f.now - ORPHAN_STAGING_GRACE_MS - 5000);
      f.makeOrphanStaging(availableId, f.now - ORPHAN_STAGING_GRACE_MS - 5000);
      f.makeOrphanStaging(rejectedId, f.now); // resolved: removed regardless of mtime

      const report = await f.makeManager().runPass();

      // 3 = old orphan + resolved available + resolved rejected; the
      // Processing-owned staging is preserved, the young orphan stays.
      expect(report.cleaned).toBe(3);
      expect(fs.existsSync(f.store.stagingDir(oldOrphan)._unsafeUnwrap())).toBe(false);
      expect(fs.existsSync(f.store.stagingDir(youngOrphan)._unsafeUnwrap())).toBe(true);
      expect(fs.existsSync(f.store.stagingDir(processingId)._unsafeUnwrap())).toBe(true);
      expect(fs.existsSync(f.store.stagingDir(availableId)._unsafeUnwrap())).toBe(false);
      expect(fs.existsSync(f.store.stagingDir(rejectedId)._unsafeUnwrap())).toBe(false);
      expect(f.auditEntries).toContainEqual({
        action: 'image.cleanup',
        details: { imageId: oldOrphan, kind: 'orphan_staging', deleted: true },
      });
      expect(f.auditEntries).toContainEqual({
        action: 'image.cleanup',
        details: { imageId: availableId, kind: 'resolved_staging:available', deleted: true },
      });
      expect(f.auditEntries).toContainEqual({
        action: 'image.cleanup',
        details: { imageId: rejectedId, kind: 'resolved_staging:rejected', deleted: true },
      });
    });

    it('keeps an orphan at exactly the grace boundary (within grace = in flight)', async () => {
      f.makeOrphanStaging('orphan-boundary', f.now - ORPHAN_STAGING_GRACE_MS);

      const report = await f.makeManager().runPass();

      expect(report.cleaned).toBe(0);
      expect(fs.existsSync(f.store.stagingDir('orphan-boundary')._unsafeUnwrap())).toBe(true);
    });

    it('deletes normalized outputs of terminal images (rejected and unavailable)', async () => {
      const rejected = f.seedImage({ rejectionReason: 'size_limit', expiresAt: f.now + 3_600_000 });
      const unavailable = f.seedImage({
        available: true,
        expiresAt: f.now + 3_600_000,
        unavailableReason: 'file_missing',
      });
      const retained = f.seedImage({ available: true, expiresAt: f.now + 3_600_000 });
      const targetRejected = writeNormalized(f, rejected.id);
      const targetUnavailable = writeNormalized(f, unavailable.id);
      const targetRetained = writeNormalized(f, retained.id);

      const report = await f.makeManager().runPass();

      expect(report.cleaned).toBe(2);
      expect(fs.existsSync(targetRejected)).toBe(false);
      expect(fs.existsSync(targetUnavailable)).toBe(false);
      expect(fs.existsSync(targetRetained)).toBe(true); // available content is retained
    });
  });

  // -------------------------------------------------------------------------
  // Audit hygiene (P2-5: structured fields only — never error messages)
  // -------------------------------------------------------------------------

  describe('audit hygiene', () => {
    it('a filesystem failure persists only the error CODE and Image ID — the canary message never reaches audit or logs', async () => {
      const img = f.seedImage({ rejectionReason: 'size_limit', expiresAt: f.now + 3_600_000 });
      const target = writeNormalized(f, img.id);
      const logged: unknown[][] = [];
      const logger = {
        debug: () => undefined,
        info: (...args: unknown[]) => logged.push(args),
        warn: (...args: unknown[]) => logged.push(args),
        error: (...args: unknown[]) => logged.push(args),
        fatal: () => undefined,
      } as unknown as pino.Logger;
      const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
        throw Object.assign(
          new Error('rm failed: /home/ivo/tmp/SECRETTOK-9999/photo.jpg?token=CREDCANARY'),
          { code: 'EACCES' },
        );
      });

      const report = await f.makeManager({ logger }).runPass();
      rmSpy.mockRestore();

      expect(report.failures).toBe(1);
      const durable = JSON.stringify(f.auditEntries);
      expect(durable).toContain('EACCES'); // structured fs code
      expect(durable).toContain(img.id); // structured Image ID
      expect(durable).not.toContain('SECRETTOK'); // no path fragments
      expect(durable).not.toContain('CREDCANARY'); // no credential-shaped tokens
      expect(JSON.stringify(logged)).not.toContain('SECRETTOK');
      expect(JSON.stringify(logged)).not.toContain('CREDCANARY');
      // The file survives and is retried on the next pass.
      expect(fs.existsSync(target)).toBe(true);
    });

    it('a failed recovery persists only op/code — the PipelineError message stays out of logs', async () => {
      f.recoverPending.mockResolvedValueOnce(
        err(new PipelineError('download failed https://cdn.example/SECRETTOK?token=CREDCANARY')),
      );
      const logged: unknown[][] = [];
      const logger = {
        debug: () => undefined,
        info: (...args: unknown[]) => logged.push(args),
        warn: (...args: unknown[]) => logged.push(args),
        error: (...args: unknown[]) => logged.push(args),
        fatal: () => undefined,
      } as unknown as pino.Logger;

      const report = await f.makeManager({ logger }).runPass();

      // Diagnostics return value keeps the message for in-memory debugging…
      expect(report.recoveryError).toContain('download failed');
      // …but the persisted log line is structured-only.
      const json = JSON.stringify(logged);
      expect(json).toContain('image_recovery');
      expect(json).not.toContain('SECRETTOK');
      expect(json).not.toContain('CREDCANARY');
    });

    it('audit evidence carries IDs/reasons only — never paths, pixels, or credentials', async () => {
      const img = f.seedImage({
        available: true,
        expiresAt: f.now + 1000,
        filename: 'photo?access_token=SECRET_CANARY.jpg',
      });
      writeNormalized(f, img.id, Buffer.from('PIXEL-PAYLOAD-CANARY'));
      f.makeOrphanStaging('orphan-delivery-1', f.now - ORPHAN_STAGING_GRACE_MS - 1000);

      f.now += 1000;
      await f.makeManager().runPass();

      expect(f.auditEntries.length).toBeGreaterThan(0);
      const durable = JSON.stringify(f.auditEntries);
      expect(durable).toContain(img.id);
      expect(durable).toContain('orphan-delivery-1');
      expect(durable).not.toContain('SECRET_CANARY'); // no credentials
      expect(durable).not.toContain('PIXEL-PAYLOAD-CANARY'); // no pixels
      expect(durable).not.toContain(f.tmpDir); // no filesystem paths
      expect(durable).not.toContain('source.bin'); // no staging references
      for (const entry of f.auditEntries) {
        expect(entry.action.length).toBeGreaterThan(0);
        expect(JSON.stringify(entry)).not.toContain(f.tmpDir);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Non-Error rejection causes (F6)
  // -------------------------------------------------------------------------

  describe('non-Error rejection causes (F6)', () => {
    const cases: Array<[string, unknown, string]> = [
      ['undefined', undefined, 'unknown'],
      ['null', null, 'unknown'],
      ['bare string', 'failed to read /secret/path/img.jpg', 'unknown'],
      ['number', 42, 'unknown'],
      ['plain object with code', { code: 'EACCES' }, 'EACCES'],
    ];

    for (const [label, cause, expectedCode] of cases) {
      it(`classifies a ${label} rejection as ${expectedCode} without crashing`, async () => {
        const logged: unknown[][] = [];
        const logger = {
          debug: () => undefined,
          info: (...args: unknown[]) => logged.push(args),
          warn: (...args: unknown[]) => logged.push(args),
          error: (...args: unknown[]) => logged.push(args),
          fatal: () => undefined,
        } as unknown as pino.Logger;
        const manager = f.makeManager({
          logger,
          runOnce: async (): Promise<ImagePassReport> => {
            throw cause;
          },
        });

        // The pass wrapper survives every rejection shape: the awaited
        // startup settles with a failed pass instead of rejecting.
        const outcome = await manager.start();
        expect(outcome.completed).toBe(true);
        expect(outcome.report?.failures).toBe(1);
        expect(JSON.stringify(logged)).toContain(expectedCode);
        expect(JSON.stringify(logged)).not.toContain('/secret/path');

        await manager.stop();
      });
    }
  });

  // -------------------------------------------------------------------------
  // Real filesystem failure canary
  // -------------------------------------------------------------------------

  describe('real filesystem failure (canary)', () => {
    const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

    it.skipIf(IS_ROOT)(
      'retention file-removal failure records structured evidence only — never the path',
      async () => {
        // Real EACCES: the normalized-file directory is made read-only, so
        // the deletion genuinely fails at the OS level. Durable evidence
        // must stay content-free (code + ids), never the absolute path.
        const image = f.seedImage({ available: true, expiresAt: f.now - 1 });
        const normalized = writeNormalized(f, image.id);
        fs.chmodSync(path.dirname(normalized), 0o500);
        try {
          const logged: unknown[][] = [];
          const logger = {
            debug: () => undefined,
            info: (...args: unknown[]) => logged.push(args),
            warn: (...args: unknown[]) => logged.push(args),
            error: (...args: unknown[]) => logged.push(args),
            fatal: () => undefined,
          } as unknown as pino.Logger;
          const manager = f.makeManager({ logger });

          const report = await manager.runPass();

          // The state transition succeeds; the file removal fails and is
          // recorded for retry.
          expect(report.expired).toBe(1);
          expect(report.failures).toBeGreaterThanOrEqual(1);
          const row = f.imageRepo.findById(image.id)._unsafeUnwrap()!;
          expect(row.state).toBe('unavailable');

          const durable = JSON.stringify(logged) + JSON.stringify(f.auditEntries);
          expect(durable).toContain('image.cleanup.failed');
          // Canary: the absolute path (tmpdir prefix) never reaches logs
          // or audit entries — only ids and codes do.
          expect(durable).not.toContain(f.tmpDir);
          // The file itself survives for the next pass to retry.
          expect(fs.existsSync(normalized)).toBe(true);
        } finally {
          fs.chmodSync(path.dirname(normalized), 0o700);
        }
      },
    );
  });
});
