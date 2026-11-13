/**
 * Integration tests for image ingestion + lifecycle under crash/restart
 * (TASK-010, spec part (c)).
 *
 * A file-backed SQLite database (WAL) plus a real ImageStore under a temp
 * data directory simulate daemon processes: "crash" means closing the
 * database handle without completing work, "restart" means re-opening every
 * component against the same files and running the lifecycle manager's
 * startup pass. The normalizer (native Sharp) and the clock are the only
 * injected seams. Pins the runtime guarantees:
 *
 * - Persisted admissions are recovered exactly once WITHOUT redelivering
 *   the message; repeated passes never re-enqueue.
 * - At restart, expiry and the processing deadline are counted from the
 *   ORIGINAL durable admission clock — a queue backlog (wall-clock delay
 *   before the pass runs) never re-derives them from the restart time.
 * - A duplicate redelivery after a crash stays idempotent (one Image, one
 *   queue item, staging consumed and cleaned).
 * - A missing source file resolves to a terminal outcome exactly once and
 *   the message still completes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import pino from 'pino';
import { ok, err, type Result } from 'neverthrow';
import { v4 as uuidv4 } from 'uuid';
import { runMigrations } from '../../src/core/database/migrations/runner.js';
import { ChannelRepository } from '../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../src/core/database/repositories/thread-repository.js';
import { MessageRepository } from '../../src/core/database/repositories/message-repository.js';
import { ImageRepository, type ImageRow } from '../../src/core/database/repositories/image-repository.js';
import {
  ImageIngestionRepository,
  type ImageIngestionRow,
} from '../../src/core/database/repositories/image-ingestion-repository.js';
import { QueueRepository } from '../../src/core/database/repositories/queue-repository.js';
import type { AuditEntry, AuditStore } from '../../src/core/logging/audit-logger.js';
import { QueueManager } from '../../src/queue/queue-manager.js';
import type { InboundAttachment } from '../../src/channels/channel-types.js';
import type { ImagesConfig } from '../../src/core/config/config-types.js';
import { ImageStore } from '../../src/images/image-store.js';
import type {
  ImageNormalizationOptions,
  ImageNormalizationResult,
  ImageNormalizationError,
} from '../../src/images/image-normalizer.js';
import {
  ImageIngestionCoordinator,
  IMAGE_PROCESSING_DEADLINE_MS,
  type ImageIngestionRequest,
} from '../../src/images/image-ingestion.js';
import { ImageLifecycleManager } from '../../src/images/image-lifecycle.js';
import {
  extractTextAndMediaCandidates,
  fetchSelectedImageAttachments,
  resolveBaileysImageSettings,
} from '../../src/channels/connectors/whatsapp-baileys/whatsapp-baileys-images.js';
import { selectImages } from '../../src/images/image-selection.js';

// ---------------------------------------------------------------------------
// Runtime scaffolding (fake daemon processes over a shared data directory)
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const RETENTION_MS = 24 * 3_600_000;

const IMAGES_CONFIG: ImagesConfig = {
  maxInputBytes: 1_000,
  maxPerMessage: 2,
  maxPerInspection: 5,
  maxEdge: 512,
  jpegQuality: 85,
  retentionHours: 24,
};

const QUEUE_CONFIG = {
  maxAttempts: 3,
  backoffBaseMs: 100,
  backoffMaxMs: 1_000,
  concurrencyLimit: 1,
};

function migrationsDir(): string {
  return path.join(import.meta.dirname, '../../src/core/database/migrations');
}

/** One "daemon process": every component built over the same DB + store. */
interface ProcessHandle {
  db: Database.Database;
  store: ImageStore;
  imageRepo: ImageRepository;
  ingestionRepo: ImageIngestionRepository;
  messageRepo: MessageRepository;
  queueRepo: QueueRepository;
  coordinator: ImageIngestionCoordinator;
  lifecycle: ImageLifecycleManager;
  auditEntries: AuditEntry[];
  normalizeCalls: string[];
  close(): void;
}

interface World {
  dataDir: string;
  channelId: string;
  threadId: string;
  now: number;
  /** Optional gate awaited inside the fake normalizer (shutdown-drain tests). */
  open(normalizeGate?: () => Promise<void>): ProcessHandle;
}

function makeWorld(): World {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talon-image-runtime-'));
  const world: World = {
    dataDir,
    channelId: uuidv4(),
    threadId: uuidv4(),
    now: T0,
    open(normalizeGate?: () => Promise<void>): ProcessHandle {
      const db = new Database(path.join(dataDir, 'talon.sqlite'));
      db.pragma('foreign_keys = ON');
      db.pragma('journal_mode = WAL');
      const migrated = runMigrations(db, migrationsDir());
      if (migrated.isErr()) {
        throw new Error(`migration failed: ${migrated.error.message}`);
      }

      const channelRepo = new ChannelRepository(db);
      const threadRepo = new ThreadRepository(db);
      const messageRepo = new MessageRepository(db);
      const imageRepo = new ImageRepository(db);
      const ingestionRepo = new ImageIngestionRepository(db);
      const queueRepo = new QueueRepository(db);
      const store = new ImageStore(dataDir);

      const normalizeCalls: string[] = [];
      const coordinator = new ImageIngestionCoordinator({
        messageRepo,
        imageRepo,
        ingestionRepo,
        queueManager: new QueueManager(queueRepo, threadRepo, QUEUE_CONFIG, pino({ level: 'silent' })),
        store,
        threadRepo,
        channelRepo,
        imagesConfig: IMAGES_CONFIG,
        logger: pino({ level: 'silent' }),
        now: () => world.now,
        normalize: async (
          source: Buffer,
          options: ImageNormalizationOptions,
        ): Promise<Result<ImageNormalizationResult, ImageNormalizationError>> => {
          normalizeCalls.push(source.toString('utf8'));
          if (normalizeGate) {
            await normalizeGate();
          }
          try {
            fs.writeFileSync(options.tempFilePath, Buffer.from('JPEG-OUT'));
          } catch {
            return err({ code: 'io', retryable: true, message: 'temp write failed' });
          }
          return ok({
            filePath: options.tempFilePath,
            dimensions: { width: 10, height: 20 },
            sourceDimensions: { width: 10, height: 20 },
          });
        },
      });

      const auditEntries: AuditEntry[] = [];
      const auditStore: AuditStore = { append: (entry: AuditEntry) => auditEntries.push(entry) };
      const lifecycle = new ImageLifecycleManager({
        coordinator,
        imageRepo,
        store,
        dataDir,
        auditStore,
        logger: pino({ level: 'silent' }),
        now: () => world.now,
      });

      return {
        db,
        store,
        imageRepo,
        ingestionRepo,
        messageRepo,
        queueRepo,
        coordinator,
        lifecycle,
        auditEntries,
        normalizeCalls,
        close(): void {
          db.close();
        },
      };
    },
  };

  // Bootstrap the channel + thread once (first open owns the seed).
  const boot = world.open();
  new ChannelRepository(boot.db)
    .insert({
      id: world.channelId,
      type: 'telegram',
      name: 'test-bot',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    })
    ._unsafeUnwrap();
  new ThreadRepository(boot.db)
    .insert({
      id: world.threadId,
      channel_id: world.channelId,
      external_id: 'ext-chat-1',
      metadata: '{}',
    })
    ._unsafeUnwrap();
  boot.close();

  return world;
}

/**
 * Seeds a crashed admission directly in the ledger: authoritative message +
 * Processing Image (+ attempts) + pending Ingestion, optionally with
 * retained staging bytes under the committed Image id. This is exactly the
 * state a process kill leaves behind after the admission transaction
 * committed but before Processing completed.
 */
function seedCrashedAdmission(
  p: ProcessHandle,
  world: World,
  options: {
    externalId: string;
    expiresAt?: number;
    deadlineAt?: number;
    retainSource?: boolean;
    content?: string;
  },
): { messageId: string; imageId: string } {
  const messageId = uuidv4();
  const imageId = uuidv4();
  p.messageRepo
    .insert({
      id: messageId,
      thread_id: world.threadId,
      direction: 'inbound',
      content: options.content ?? 'crashed',
      idempotency_key: `${world.channelId}:${options.externalId}`,
      provider_id: 'user-1',
      run_id: null,
    })
    ._unsafeUnwrap();
  const source = p.ingestionRepo
    .resolveSourceMessage({
      channel: 'test-bot',
      externalMessageId: options.externalId,
      externalChatId: 'ext-chat-1',
    })
    ._unsafeUnwrap();
  p.imageRepo
    .insert({
      id: imageId,
      messageId,
      ordinal: 0,
      threadId: world.threadId,
      sourceRef: source.id,
      state: 'processing',
      expiresAt: options.expiresAt ?? T0 + RETENTION_MS,
      processingDeadlineAt: options.deadlineAt ?? T0 + IMAGE_PROCESSING_DEADLINE_MS,
    })
    ._unsafeUnwrap();
  if (options.retainSource) {
    p.store.ensureStagingDir(imageId)._unsafeUnwrap();
    fs.writeFileSync(p.store.stagingSourcePath(imageId)._unsafeUnwrap(), 'RETAINED-BYTES');
  }
  p.ingestionRepo
    .createPending({ messageId, threadId: world.threadId, personaId: 'persona-1' })
    ._unsafeUnwrap();
  return { messageId, imageId };
}

// --- Query helpers -----------------------------------------------------------

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function imageOf(p: ProcessHandle, messageId: string): ImageRow {
  const rows = p.imageRepo.findByMessage(messageId)._unsafeUnwrap();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function ingestionOf(p: ProcessHandle, messageId: string): ImageIngestionRow | null {
  return p.ingestionRepo.findByMessage(messageId)._unsafeUnwrap();
}

interface QueueRow {
  id: string;
  message_id: string | null;
  type: string;
  payload: string;
}

function queueRows(p: ProcessHandle, world: World): QueueRow[] {
  return p.db
    .prepare('SELECT id, message_id, type, payload FROM queue_items WHERE thread_id = ? ORDER BY created_at, id')
    .all(world.threadId) as QueueRow[];
}

/** Poll a condition with real timers (integration file uses no fake clocks). */
async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function payloadAttachment(bytes: string): InboundAttachment {
  return { filename: 'photo.png', mimeType: 'image/png', data: Buffer.from(bytes), size: bytes.length };
}

function redeliveryRequest(
  world: World,
  externalId: string,
  bytes: string,
): ImageIngestionRequest {
  return {
    channelId: world.channelId,
    channelName: 'test-bot',
    externalMessageId: externalId,
    externalChatId: 'ext-chat-1',
    threadId: world.threadId,
    message: {
      id: uuidv4(),
      content: 'crashed',
      senderId: 'user-1',
      idempotencyKey: externalId,
    },
    attachments: [payloadAttachment(bytes)],
    personaId: 'persona-1',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('image ingestion runtime — crash/restart durability', () => {
  let world: World;

  beforeEach(() => {
    world = makeWorld();
  });

  afterEach(() => {
    fs.rmSync(world.dataDir, { recursive: true, force: true });
  });

  it('runs a REAL startup round: start() awaits recovery, stop() drains cleanly', async () => {
    // --- Process 1: crash after a committed admission with retained bytes.
    const p1 = world.open();
    const { messageId, imageId } = seedCrashedAdmission(p1, world, {
      externalId: 'ext-startstop-1',
      retainSource: true,
    });
    p1.close();

    // --- Process 2: the daemon-style startup AWAITED by the orchestrator.
    world.now = T0 + 5_000;
    const p2 = world.open();
    const startup = await p2.lifecycle.start();

    expect(startup.completed).toBe(true);
    expect(startup.timedOut).toBe(false);
    expect(startup.report?.recoveryError).toBeNull();
    expect(startup.report?.recovered).toEqual({ inspected: 1, enqueued: 1, skipped: 0, failed: 0 });

    // Because the caller awaited start(), the crash leftovers are ALREADY
    // resolved before anything else in this process could admit events.
    expect(imageOf(p2, messageId).state).toBe('available');
    expect(p2.normalizeCalls).toEqual(['RETAINED-BYTES']);
    expect(queueRows(p2, world)).toHaveLength(1);
    expect(ingestionOf(p2, messageId)?.status).toBe('completed');
    expect(p2.store.normalizedExists(world.threadId, imageId)).toBe(true);

    // Shutdown: the fence + drain completes without hanging or throwing.
    await p2.lifecycle.stop();
    expect(p2.lifecycle.isStarted).toBe(false);

    // Nothing resurrected after the fence.
    expect(queueRows(p2, world)).toHaveLength(1);
    p2.close();
  });

  it('shutdown fence blocks admissions; retirement leaves durable rows for next-boot recovery', async () => {
    // F3: the recovery table is authoritative. Shutdown must NOT resolve
    // viable work — a retired continuation changes nothing durably, and
    // next-boot recovery completes the message exactly once from the
    // retained source under canonical precedence.
    let releaseNormalize: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseNormalize = resolve;
    });
    const p = world.open(async () => {
      await gate;
    });

    const inflight = p.coordinator.ingestMessage(redeliveryRequest(world, 'ext-live-1', 'LIVE-BYTES'));
    await waitFor(() => p.normalizeCalls.includes('LIVE-BYTES'));

    // --- Fence: a NEW admission is rejected before touching any ledger.
    p.coordinator.fenceAdmissions();
    expect(p.coordinator.isFenced).toBe(true);
    const fenced = await p.coordinator.ingestMessage(
      redeliveryRequest(world, 'ext-fenced', 'FENCED-BYTES'),
    );
    expect(fenced.isErr()).toBe(true);
    expect(p.normalizeCalls).not.toContain('FENCED-BYTES');
    expect(count(p.db, 'messages')).toBe(1); // only the in-flight delivery

    // --- Drain with the work still wedged: bounded, reports abandoned.
    const timedOut = await p.coordinator.drainActiveIngestion(25);
    expect(timedOut.drained).toBe(0);
    expect(timedOut.abandoned).toBe(1);

    // --- Retirement (F3, R2): IN-MEMORY only. No row is terminally marked:
    // the source is retained and the deadline has budget, so the recovery
    // table says next-boot recovery must resolve this work, not shutdown.
    // The admitted work's RETAINED SOURCE must not be reclaimed either —
    // only pre-admission staging is retirement's to clean.
    const retired = await p.coordinator.abandonActiveIngestion();
    expect(retired).toEqual({ retired: 1, stagingCleaned: 0, stagingFailed: 0 });
    const durableImage = p.db
      .prepare('SELECT state, rejection_reason FROM images')
      .get() as { state: string; rejection_reason: string | null };
    expect(durableImage.state).toBe('processing');
    expect(durableImage.rejection_reason).toBeNull();
    expect(p.db.prepare('SELECT status FROM image_ingestions').get()).toEqual({ status: 'pending' });
    expect(count(p.db, 'queue_items')).toBe(0);

    // Daemon ordering contract (F3): the database closes BEFORE the wedged
    // continuation is released. The continuation must short-circuit at its
    // guard re-check with ZERO ledger access — no throw from the closed DB.
    p.close();
    releaseNormalize!();
    const settled = await inflight;
    expect(settled.isErr()).toBe(true); // retired; nothing published

    // --- Next boot: recovery resolves the pending admission exactly once.
    world.now = T0 + 5_000;
    const p2 = world.open();
    const startup = await p2.lifecycle.start();
    expect(startup.completed).toBe(true);
    expect(startup.timedOut).toBe(false);
    expect(startup.report?.recovered).toEqual({ inspected: 1, enqueued: 1, skipped: 0, failed: 0 });
    expect(p2.normalizeCalls).toEqual(['LIVE-BYTES']); // staged source reused
    expect(count(p2.db, 'messages')).toBe(1);
    expect(count(p2.db, 'images')).toBe(1);
    expect(p2.db.prepare('SELECT state FROM images').get()).toEqual({ state: 'available' });
    expect(p2.db.prepare('SELECT status FROM image_ingestions').get()).toEqual({ status: 'completed' });
    expect(count(p2.db, 'queue_items')).toBe(1); // exactly-once completion

    await p2.lifecycle.stop();
    p2.close();
  });

  it('fence raced mid-staging admits nothing and leaves no staging residue (F2)', async () => {
    // The fence lands while a staging write is SUSPENDED (before the
    // admission transaction). The delivery must still produce zero
    // durable rows and zero staging directories, and after the fence no
    // further staging write may even be attempted.
    let releaseStage: (() => void) | null = null;
    const stageGate = new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    const p = world.open();
    const originalWrite = p.store.writeStagingSource.bind(p.store);
    let stagingEntered = false;
    let writesAfterFence = 0;
    let fenced = false;
    p.store.writeStagingSource = async (imageId: string, bytes: Buffer) => {
      if (!stagingEntered) {
        stagingEntered = true;
        await stageGate; // the fence lands while this write is suspended
      }
      if (fenced) writesAfterFence++;
      return originalWrite(imageId, bytes);
    };

    const base = redeliveryRequest(world, 'ext-stage-1', 'STAGE-A');
    const request: ImageIngestionRequest = {
      ...base,
      attachments: [payloadAttachment('STAGE-A'), payloadAttachment('STAGE-B')],
    };
    const inflight = p.coordinator.ingestMessage(request);
    await waitFor(() => stagingEntered);

    p.coordinator.fenceAdmissions();
    fenced = true;

    // A NEW delivery after the fence never reaches staging at all.
    const fencedDelivery = await p.coordinator.ingestMessage(
      redeliveryRequest(world, 'ext-fenced-2', 'FENCED2-BYTES'),
    );
    expect(fencedDelivery.isErr()).toBe(true);
    expect(p.store.listStagingDeliveries()).toEqual([]);

    // Drain bound elapses while the staged write is suspended.
    const timedOut = await p.coordinator.drainActiveIngestion(25);
    expect(timedOut.abandoned).toBe(1);

    // Release the suspended write while the process is fenced but NOT
    // yet retired: the delivery must unwind at the NEXT per-attachment
    // pre-write boundary — that check is the deciding guard, so no
    // second staging write may even be attempted.
    releaseStage!();
    const settled = await inflight;
    expect(settled.isErr()).toBe(true);

    // The suspended first write is the ONE await-granular exception
    // (disclosed at the fence site); the pre-write boundary check stops
    // the delivery before any further staging attempt, and the abort
    // cleanup removes what the fence-raced write did stage.
    expect(writesAfterFence).toBe(1);

    // Retirement after the delivery already unwound claims nothing new.
    expect(await p.coordinator.abandonActiveIngestion(25)).toEqual({
      retired: 0,
      stagingCleaned: 0,
      stagingFailed: 0,
    });

    // Zero durable admission, zero staging residue.
    expect(count(p.db, 'messages')).toBe(0);
    expect(count(p.db, 'images')).toBe(0);
    expect(count(p.db, 'image_ingestions')).toBe(0);
    expect(count(p.db, 'queue_items')).toBe(0);
    expect(p.store.listStagingDeliveries()).toEqual([]);
    p.close();
  });

  it('a fence landing after the FINAL staging write still blocks the admission commit (F2)', async () => {
    // The per-attachment staging boundary checks only see a fenced state
    // when another write follows; the LAST staged delivery relies on the
    // admission-boundary re-check, which shares no await point with the
    // ledger transaction. Fence in the staging-completed window: the
    // delivery must still produce ZERO durable rows and remove staged bytes.
    let releaseStage: (() => void) | null = null;
    const stageDone = new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    const p = world.open();
    const originalWrite = p.store.writeStagingSource.bind(p.store);
    p.store.writeStagingSource = async (imageId: string, bytes: Buffer) => {
      const res = await originalWrite(imageId, bytes);
      // Defer the signal by one microtask so it lands AFTER this
      // delivery's post-write check but BEFORE its admission-boundary
      // check (queue order: [signal, post-write, test-fence,
      // admission-resume]) — isolating the boundary re-check as the
      // deciding guard for the final staged delivery.
      queueMicrotask(() => releaseStage!());
      return res;
    };

    const inflight = p.coordinator.ingestMessage(
      redeliveryRequest(world, 'ext-stage-admit', 'ADMIT-BYTES'),
    );
    await stageDone;
    p.coordinator.fenceAdmissions();

    const settled = await inflight;
    expect(settled.isErr()).toBe(true);
    expect(count(p.db, 'messages')).toBe(0);
    expect(count(p.db, 'images')).toBe(0);
    expect(count(p.db, 'image_ingestions')).toBe(0);
    expect(count(p.db, 'queue_items')).toBe(0);
    expect(p.store.listStagingDeliveries()).toEqual([]);
    p.close();
  });

  it('retirement cleans a SUSPENDED staging write before the database closes (R2)', async () => {
    // Real teardown ordering: the staging write has already MATERIALIZED
    // its directory and is suspended inside the store call. Retirement
    // must await it bounded and remove the tracked directory BEFORE
    // returning — i.e. before the daemon closes SQLite — and a write
    // only released after closure must still leave zero residue and zero
    // rows through the delivery's own post-write retirement check.
    let releaseWrite: (() => void) | null = null;
    const writeSuspended = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const p = world.open();
    const originalWrite = p.store.writeStagingSource.bind(p.store);
    p.store.writeStagingSource = async (imageId: string, bytes: Buffer) => {
      const res = await originalWrite(imageId, bytes); // directory exists
      await writeSuspended; // op suspended AFTER its filesystem effect
      return res;
    };

    const inflight = p.coordinator.ingestMessage(
      redeliveryRequest(world, 'ext-retire-stage', 'RETIRE-STAGE-BYTES'),
    );
    await waitFor(() => p.store.listStagingDeliveries().length === 1);

    p.coordinator.fenceAdmissions();
    expect(await p.coordinator.drainActiveIngestion(25)).toEqual({
      drained: 0,
      abandoned: 1,
    });

    // Retirement completes tracked staging cleanup before it resolves.
    expect(await p.coordinator.abandonActiveIngestion(25)).toEqual({
      retired: 1,
      stagingCleaned: 1,
      stagingFailed: 0,
    });
    expect(p.store.listStagingDeliveries()).toEqual([]); // cleaned PRE-closure

    // The database now closes while the delivery is still suspended.
    p.close();

    // Only then is the write released; the post-write retirement check
    // unwinds the delivery filesystem-only, with zero rows ever created.
    releaseWrite!();
    const settled = await inflight;
    expect(settled.isErr()).toBe(true);
    expect(p.store.listStagingDeliveries()).toEqual([]);

    const p3 = world.open();
    expect(count(p3.db, 'messages')).toBe(0);
    expect(count(p3.db, 'images')).toBe(0);
    expect(count(p3.db, 'image_ingestions')).toBe(0);
    expect(count(p3.db, 'queue_items')).toBe(0);
    p3.close();
  });

  it('a fence landing while the LAST staging write is suspended admits nothing and cleans everything (F2)', async () => {
    // Deterministic variant of the admission-boundary race: the final
    // staging write is held INSIDE the store call while the fence lands,
    // then released. The delivery must unwind through a fenced pre-
    // admission exit: zero durable rows, zero staging residue — the
    // write completing after the fence must never commit.
    let stagingEntered = false;
    let releaseWrite: (() => void) | null = null;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const p = world.open();
    const originalWrite = p.store.writeStagingSource.bind(p.store);
    p.store.writeStagingSource = async (imageId: string, bytes: Buffer) => {
      stagingEntered = true;
      await writeGate; // the fence lands while this write is suspended
      return originalWrite(imageId, bytes);
    };

    const inflight = p.coordinator.ingestMessage(
      redeliveryRequest(world, 'ext-last-write', 'LAST-WRITE-BYTES'),
    );
    await waitFor(() => stagingEntered);

    p.coordinator.fenceAdmissions();
    expect(await p.coordinator.drainActiveIngestion(25)).toEqual({
      drained: 0,
      abandoned: 1,
    });
    expect(await p.coordinator.abandonActiveIngestion(25)).toEqual({
      retired: 1,
      stagingCleaned: 1,
      stagingFailed: 0,
    });

    // Real teardown ordering: close the database first...
    p.close();

    // ...only THEN the suspended write is released; the post-write
    // retirement check unwinds filesystem-only.
    releaseWrite!();
    const settled = await inflight;
    expect(settled.isErr()).toBe(true);
    expect(p.store.listStagingDeliveries()).toEqual([]);

    const p3 = world.open();
    expect(count(p3.db, 'messages')).toBe(0);
    expect(count(p3.db, 'images')).toBe(0);
    expect(count(p3.db, 'image_ingestions')).toBe(0);
    expect(count(p3.db, 'queue_items')).toBe(0);
    p3.close();
  });

  it('a FAILED staging write that left a partial directory is cleaned on the fenced exit (R3)', async () => {
    // The final staging write MATERIALIZES its directory, then fails,
    // and the fence lands while the delivery is still inside staging.
    // Whichever fenced unwind handles it (post-write check or admission
    // boundary), the attempted id must be removed and nothing may
    // commit. Deterministic plan-based-unwind coverage lives in the unit
    // suite with the ledger-failure variant.
    let stagedFailed = false;
    let releaseStageSignal: (() => void) | null = null;
    const failedAndSignalled = new Promise<void>((resolve) => {
      releaseStageSignal = resolve;
    });
    const p = world.open();
    const originalWrite = p.store.writeStagingSource.bind(p.store);
    p.store.writeStagingSource = async (imageId: string, _bytes: Buffer) => {
      await originalWrite(imageId, Buffer.from('PARTIAL'));
      // Resolve the test's continuation INSIDE the still-running wrapper:
      // FIFO microtask order puts the test's fence ahead of this
      // delivery's continuation to the synchronous admission check.
      releaseStageSignal!();
      stagedFailed = true;
      return err({ code: 'io', retryable: false, message: 'simulated partial staging write' });
    };

    const inflight = p.coordinator.ingestMessage(
      redeliveryRequest(world, 'ext-failed-stage', 'FAILED-STAGE-BYTES'),
    );
    await failedAndSignalled;
    expect(stagedFailed).toBe(true);

    p.coordinator.fenceAdmissions();

    const settled = await inflight;
    expect(settled.isErr()).toBe(true);
    expect(p.store.listStagingDeliveries()).toEqual([]); // failed attempt removed
    expect(count(p.db, 'messages')).toBe(0);
    expect(count(p.db, 'images')).toBe(0);
    expect(count(p.db, 'image_ingestions')).toBe(0);
    expect(count(p.db, 'queue_items')).toBe(0);
    p.close();
  });

  it('a wedged startup recovery with ZERO deliveries retires before closure and recovers exactly once next boot (R1)', async () => {
    // R1: lifecycle-owned recovery is NOT tracked in activeDeliveries —
    // a delivery-drain result must never gate retirement. The recovery
    // continuation is released AFTER the database closed; every guard
    // unwinds without ledger access, the aggregate audit is fenced, and
    // next-boot recovery resolves the retained work exactly once.
    const p1 = world.open();
    const { imageId } = seedCrashedAdmission(p1, world, {
      externalId: 'ext-r1-recovery',
      retainSource: true,
    });
    p1.close();

    // --- Process 2: startup pass wedges inside recovery, zero deliveries.
    let releaseNormalize: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseNormalize = resolve;
    });
    const p2 = world.open(async () => {
      await gate;
    });
    const startup = p2.lifecycle.start();
    await waitFor(() => p2.normalizeCalls.length === 1);

    const swept = await p2.lifecycle.stop(25);
    expect(swept.drained).toBe(false); // recovery wedged past the bound

    // Unconditional retirement (drain would report abandoned: 0 — the
    // R1 bug was skipping retire exactly in that case).
    expect(await p2.coordinator.abandonActiveIngestion(25)).toEqual({
      retired: 0,
      stagingCleaned: 0,
      stagingFailed: 0,
    });

    p2.close(); // closure while the recovery continuation is parked

    releaseNormalize!();
    // The parked continuation unwinds at its guard re-check: no throw
    // from the closed database, nothing published.
    await startup;
    expect(p2.store.normalizedExists(world.threadId, imageId)).toBe(false);

    // The aggregate recovery audit must NOT be appended once stopped —
    // the daemon may already have closed the ledger it writes through.
    expect(p2.auditEntries.map((e) => e.action)).not.toContain('image.recovery.pass');

    // --- Next boot: exactly-once recovery from the retained source.
    const p3 = world.open();
    const report = await p3.lifecycle.start();
    expect(report.completed).toBe(true);
    expect(report.report?.recovered).toEqual({ inspected: 1, enqueued: 1, skipped: 0, failed: 0 });
    expect(p3.normalizeCalls).toEqual(['RETAINED-BYTES']); // retained source reused
    expect(p3.db.prepare('SELECT state FROM images').get()).toEqual({ state: 'available' });
    expect(p3.db.prepare('SELECT status FROM image_ingestions').get()).toEqual({
      status: 'completed',
    });
    expect(count(p3.db, 'queue_items')).toBe(1);
    await p3.lifecycle.stop();
    p3.close();
  });

  it('recovers a persisted admission exactly once WITHOUT redelivering the message', async () => {
    // --- Process 1: admission committed, crash before Processing finished.
    const p1 = world.open();
    const { messageId, imageId } = seedCrashedAdmission(p1, world, {
      externalId: 'ext-crash-1',
      retainSource: true,
    });
    p1.close(); // crash: nothing completed, nothing cleaned

    // --- Process 2: restart shortly after; startup lifecycle pass recovers.
    world.now = T0 + 5_000;
    const p2 = world.open();
    const first = await p2.lifecycle.runPass();

    expect(first.recoveryError).toBeNull();
    expect(first.recovered).toEqual({ inspected: 1, enqueued: 1, skipped: 0, failed: 0 });

    // The committed Image completed from the RETAINED staging source.
    const image = imageOf(p2, messageId);
    expect(image.id).toBe(imageId);
    expect(image.state).toBe('available');
    expect(p2.normalizeCalls).toEqual(['RETAINED-BYTES']);

    // No redelivery: still exactly one message, one Image, one Ingestion.
    expect(count(p2.db, 'messages')).toBe(1);
    expect(count(p2.db, 'images')).toBe(1);
    expect(count(p2.db, 'image_ingestions')).toBe(1);
    expect(ingestionOf(p2, messageId)?.status).toBe('completed');

    // Exactly one queue item carrying the persisted message.
    const rows = queueRows(p2, world);
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload) as Record<string, unknown>;
    expect(payload.messageId ?? payload.message_id).toBe(messageId);

    // Staging consumed; normalized file published durably.
    expect(p2.store.listStagingDeliveries()).toEqual([]);
    expect(p2.store.normalizedExists(world.threadId, imageId)).toBe(true);

    // Lifecycle audit evidence: aggregate recovery line, IDs/reasons only.
    const durable = JSON.stringify(p2.auditEntries);
    expect(p2.auditEntries.some((e) => e.action === 'image.recovery.pass')).toBe(true);
    expect(durable).not.toContain(world.dataDir);
    expect(durable).not.toContain('RETAINED-BYTES');
    expect(durable).not.toContain('source.bin');

    // A periodic sweep afterwards must not re-process or re-enqueue.
    const second = await p2.lifecycle.runPass();
    expect(second.recovered).toEqual({ inspected: 0, enqueued: 0, skipped: 0, failed: 0 });
    expect(p2.normalizeCalls).toEqual(['RETAINED-BYTES']);
    expect(queueRows(p2, world)).toHaveLength(1);

    p2.close();
  });

  it('counts expiry and the processing deadline from the ORIGINAL admission even with a queue backlog', async () => {
    // --- Process 1: two crashed admissions plus a queue backlog.
    const p1 = world.open();
    const deadlineCase = seedCrashedAdmission(p1, world, {
      externalId: 'ext-deadline-1',
      deadlineAt: T0 + 60_000,
      expiresAt: T0 + RETENTION_MS,
      retainSource: true,
      content: 'deadline backlog item',
    });
    const expiryCase = seedCrashedAdmission(p1, world, {
      externalId: 'ext-expiry-1',
      deadlineAt: T0 + 60_000,
      expiresAt: T0 + 1_000, // original receipt-based expiry, long past on restart
      retainSource: true,
      content: 'expiry backlog item',
    });
    // Backlog: the thread's queue is congested, so processing only happens
    // long after the crash.
    p1.queueRepo
      .enqueue({
        id: uuidv4(),
        thread_id: world.threadId,
        message_id: null,
        type: 'message',
        payload: '{"backlog":true}',
        max_attempts: 3,
      })
      ._unsafeUnwrap();
    p1.close();

    // --- Restart MINUTES later: the deadline and expiry elapsed in the queue.
    world.now = T0 + 120_000;
    const p2 = world.open();
    const report = await p2.lifecycle.runPass();

    // Neither item is re-derived from the restart time: recovery sees the
    // ORIGINAL clock and resolves both terminal WITHOUT another conversion.
    expect(report.recovered).toEqual({ inspected: 2, enqueued: 2, skipped: 0, failed: 0 });
    expect(p2.normalizeCalls).toEqual([]);

    // Deadline exhaustion -> Rejected(processing_failed), never re-admitted.
    const deadlineImage = imageOf(p2, deadlineCase.messageId);
    expect(deadlineImage.state).toBe('rejected');
    expect(deadlineImage.rejection_reason).toBe('processing_failed');

    // Expiry (counted from the original admission receipt) wins over the
    // deadline/attempts guards and is recorded before file_missing.
    const expiryImage = imageOf(p2, expiryCase.messageId);
    expect(expiryImage.state).toBe('unavailable');
    expect(expiryImage.unavailability_reason).toBe('expired');

    // Both messages complete exactly once, from their persisted rows, next
    // to the pre-existing backlog item.
    const rows = queueRows(p2, world);
    expect(rows).toHaveLength(3);
    const payloads = rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
    const enqueuedFor = payloads.map((p) => p.messageId ?? p.message_id);
    expect(enqueuedFor).toContain(deadlineCase.messageId);
    expect(enqueuedFor).toContain(expiryCase.messageId);
    expect(ingestionOf(p2, deadlineCase.messageId)?.status).toBe('completed');
    expect(ingestionOf(p2, expiryCase.messageId)?.status).toBe('completed');

    // Terminal work is never re-inspected on later sweeps.
    const second = await p2.lifecycle.runPass();
    expect(second.recovered).toEqual({ inspected: 0, enqueued: 0, skipped: 0, failed: 0 });
    expect(queueRows(p2, world)).toHaveLength(3);

    p2.close();
  });

  it('a duplicate redelivery after a crash stays idempotent (one Image, one queue item, staging cleaned)', async () => {
    // --- Process 1: crash after admission with no retained staging.
    const p1 = world.open();
    const { messageId } = seedCrashedAdmission(p1, world, { externalId: 'ext-dupe-1' });
    p1.close();

    // --- Process 2: the channel redelivers the SAME delivery first.
    const p2 = world.open();
    const duplicate = await p2.coordinator.ingestMessage(
      redeliveryRequest(world, 'ext-dupe-1', 'REDELIVERED-BYTES'),
    );
    expect(duplicate._unsafeUnwrap()).toBe('duplicate');

    // The redelivery joined the committed admission: one message, one Image.
    expect(count(p2.db, 'messages')).toBe(1);
    expect(count(p2.db, 'images')).toBe(1);
    const image = imageOf(p2, messageId);
    expect(image.state).toBe('available');
    expect(p2.normalizeCalls).toEqual(['REDELIVERED-BYTES']);

    // Exactly one queue item; staging fully consumed and cleaned.
    const rows = queueRows(p2, world);
    expect(rows).toHaveLength(1);
    expect(p2.store.listStagingDeliveries()).toEqual([]);

    // A SECOND redelivery after completion: still idempotent, nothing new.
    const again = await p2.coordinator.ingestMessage(
      redeliveryRequest(world, 'ext-dupe-1', 'REDELIVERED-AGAIN'),
    );
    expect(again._unsafeUnwrap()).toBe('duplicate');
    expect(p2.normalizeCalls).toEqual(['REDELIVERED-BYTES']);
    expect(queueRows(p2, world)).toHaveLength(1);

    // The lifecycle startup pass finds nothing left to recover.
    const report = await p2.lifecycle.runPass();
    expect(report.recovered).toEqual({ inspected: 0, enqueued: 0, skipped: 0, failed: 0 });
    expect(ingestionOf(p2, messageId)?.status).toBe('completed');

    p2.close();
  });

  it('a missing source file resolves terminal exactly once and the message still completes', async () => {
    // --- Process 1: crash after admission BEFORE the source was retained.
    const p1 = world.open();
    const { messageId, imageId } = seedCrashedAdmission(p1, world, {
      externalId: 'ext-lost-1',
    });
    p1.close();

    // --- Process 2: restart well within the deadline; the source is gone.
    world.now = T0 + 5_000;
    const p2 = world.open();
    const report = await p2.lifecycle.runPass();

    expect(report.recovered).toEqual({ inspected: 1, enqueued: 1, skipped: 0, failed: 0 });
    const image = imageOf(p2, messageId);
    expect(image.state).toBe('rejected');
    expect(image.rejection_reason).toBe('processing_interrupted');
    expect(p2.normalizeCalls).toEqual([]);

    // The message still completes exactly once with its persisted content.
    expect(ingestionOf(p2, messageId)?.status).toBe('completed');
    const rows = queueRows(p2, world);
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload) as Record<string, unknown>;
    expect(payload.messageId ?? payload.message_id).toBe(messageId);

    // Later sweeps never resurrect or re-inspect the terminal Image.
    const second = await p2.lifecycle.runPass();
    expect(second.recovered).toEqual({ inspected: 0, enqueued: 0, skipped: 0, failed: 0 });
    expect(queueRows(p2, world)).toHaveLength(1);
    expect(imageOf(p2, messageId).state).toBe('rejected');
    expect(p2.store.normalizedExists(world.threadId, imageId)).toBe(false);

    p2.close();
  });
});

// ---------------------------------------------------------------------------
// Connector → ledger metadata path
// ---------------------------------------------------------------------------
//
// The Baileys photo path is exercised END TO END: real candidate extraction,
// real selection, the real bounded-fetch attachment builder, then a real
// ingestion Coordinator on a real migrated SQLite database. An ordinary
// `imageMessage` declares NO filename, so the ledger must receive NULL — an
// empty string here violates the nonempty `filename`/`mime_type` CHECK
// constraints and rolls back the whole admission transaction — the defect
// these tests pin (review comment 4307138453).

describe('image ingestion runtime — declared metadata from the Baileys connector', () => {
  let world: World;

  beforeEach(() => {
    world = makeWorld();
  });

  afterEach(() => {
    fs.rmSync(world.dataDir, { recursive: true, force: true });
  });

  /** Build Attachments exactly the way the Baileys connector does. */
  async function connectorAttachments(content: Record<string, unknown>): Promise<InboundAttachment[]> {
    const { candidates } = extractTextAndMediaCandidates(content);
    const selection = selectImages(candidates, {
      maxInputBytes: IMAGES_CONFIG.maxInputBytes,
      maxPerMessage: IMAGES_CONFIG.maxPerMessage,
    });
    const opener = async (): Promise<Readable> => Readable.from([Buffer.from('PHOTO-BYTES')]);
    return fetchSelectedImageAttachments(
      { key: { id: 'wam-1' } },
      selection.images,
      resolveBaileysImageSettings({ openMedia: opener }, opener),
    );
  }

  function requestFor(externalId: string, attachments: readonly InboundAttachment[]): ImageIngestionRequest {
    return {
      channelId: world.channelId,
      channelName: 'test-bot',
      externalMessageId: externalId,
      externalChatId: 'ext-chat-1',
      threadId: world.threadId,
      message: {
        id: uuidv4(),
        content: '',
        senderId: 'user-1',
        idempotencyKey: externalId,
      },
      attachments,
      personaId: 'persona-1',
    };
  }

  it('admits a downloaded photo that declared NO filename and NO MIME (NULL columns, message enqueued)', async () => {
    const p = world.open();
    const attachments = await connectorAttachments({
      imageMessage: {
        url: 'https://mmg.example/encrypted-media',
        mediaKey: 'SUPER-SECRET-MEDIA-KEY',
        fileLength: 11,
      },
    });

    expect(attachments).toHaveLength(1);
    // Absent, never ''.
    expect('filename' in attachments[0]!).toBe(false);
    expect('mimeType' in attachments[0]!).toBe(false);

    const request = requestFor('ext-meta-absent', attachments);
    const outcome = await p.coordinator.ingestMessage(request);
    expect(outcome._unsafeUnwrap()).toBe('enqueued');

    const image = imageOf(p, request.message.id);
    expect(image.state).toBe('available');
    expect(image.filename).toBeNull();
    // Nothing was declared, so the only MIME the ledger can know is the
    // normalized output format recorded at publication.
    expect(image.mime_type).toBe('image/jpeg');
    expect(p.normalizeCalls).toEqual(['PHOTO-BYTES']);
    expect(ingestionOf(p, request.message.id)?.status).toBe('completed');

    // The message reached the queue — the defect dropped it with the rollback.
    const rows = queueRows(p, world);
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload) as Record<string, unknown>;
    expect(payload.messageId ?? payload.message_id).toBe(request.message.id);
    expect(p.store.normalizedExists(world.threadId, image.id)).toBe(true);

    p.close();
  });

  it('preserves a declared filename and MIME on the admitted ledger row (control)', async () => {
    const p = world.open();
    const attachments = await connectorAttachments({
      documentMessage: {
        mimetype: 'image/png',
        fileName: 'diagram.png',
        fileLength: 11,
      },
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.filename).toBe('diagram.png');
    expect(attachments[0]!.mimeType).toBe('image/png');

    const request = requestFor('ext-meta-declared', attachments);
    const outcome = await p.coordinator.ingestMessage(request);
    expect(outcome._unsafeUnwrap()).toBe('enqueued');

    const image = imageOf(p, request.message.id);
    expect(image.state).toBe('available');
    // A declared nonempty filename survives to the ledger unchanged.
    expect(image.filename).toBe('diagram.png');
    expect(image.mime_type).toBe('image/jpeg'); // normalized output format
    expect(queueRows(p, world)).toHaveLength(1);

    p.close();
  });
});
