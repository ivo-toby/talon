/**
 * Unit tests for daemon lifecycle utilities.
 *
 * Tests cover:
 * - recoverFromCrash: checkpoint-aware recovery and full-dispatch caller boundary
 * - writePidFile / removePidFile: PID file management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import pino from 'pino';

import { err, ok } from 'neverthrow';
import { BaseRepository } from '../../../src/core/database/repositories/base-repository.js';
import {
  SignalAccountStateRepository,
  SignalStateError,
} from '../../../src/core/database/repositories/signal-account-state-repository.js';
import { SignalDestinationLeaseRepository } from '../../../src/core/database/repositories/signal-destination-lease-repository.js';
import { DeliveryCancelled } from '../../../src/core/errors/error-types.js';
import {
  QueueProcessor,
  QueueManager,
  DeadLetterHandler,
  type QueueHandler,
  type SavedSignalDeliveryHandler,
} from '../../../src/queue/index.js';
import {
  SIGNAL_CHECKPOINT_LIFETIME_MS,
  SIGNAL_DELIVERY_CHECKPOINT_KEY,
  SignalCheckpointError,
  type SignalDeliveryCheckpoint,
} from '../../../src/queue/signal-delivery-checkpoint.js';

import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { recoverFromCrash, writePidFile, removePidFile } from '../../../src/daemon/lifecycle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function migrationsDir(): string {
  return join(import.meta.dirname, '../../../src/core/database/migrations');
}

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const result = runMigrations(db, migrationsDir());
  if (result.isErr()) {
    throw new Error(`Test DB migration failed: ${result.error.message}`);
  }
  return db;
}

function createSilentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function uuid(): string {
  return uuidv4();
}

/** Seeds a channel and thread, returns threadId. */
function seedThread(db: Database.Database): string {
  const channels = new ChannelRepository(db);
  const threads = new ThreadRepository(db);

  const channelId = uuid();
  channels.insert({
    id: channelId,
    type: 'telegram',
    name: `ch-${uuid()}`,
    config: '{}',
    credentials_ref: null,
    enabled: 1,
  });

  const threadId = uuid();
  threads.insert({
    id: threadId,
    channel_id: channelId,
    external_id: `ext-${uuid()}`,
    metadata: '{}',
  });

  return threadId;
}

/** Enqueues an item and returns its id. */
function enqueueItem(
  repo: QueueRepository,
  threadId: string,
  status?: string,
): string {
  const id = uuid();
  repo.enqueue({
    id,
    thread_id: threadId,
    message_id: null,
    type: 'message',
    payload: '{}',
    max_attempts: 3,
  });

  // If a non-pending status is needed, force it via direct SQL
  if (status && status !== 'pending') {
    const db = (repo as unknown as { db: Database.Database }).db;
    db.prepare(`UPDATE queue_items SET status = ? WHERE id = ?`).run(status, id);
  }
  return id;
}

/** Enqueues a collaboration item with a caller-supplied payload and status. */
function enqueueCollaborationItem(
  repo: QueueRepository,
  threadId: string,
  payload: string,
  status: 'claimed' | 'processing',
): string {
  const id = uuid();
  repo.enqueue({
    id,
    thread_id: threadId,
    message_id: null,
    type: 'collaboration',
    payload,
    max_attempts: 1,
  });

  const db = (repo as unknown as { db: Database.Database }).db;
  db.prepare(`UPDATE queue_items SET status = ? WHERE id = ?`).run(status, id);
  return id;
}

// ---------------------------------------------------------------------------
// recoverFromCrash tests
// ---------------------------------------------------------------------------

describe('recoverFromCrash', () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let threadId: string;
  const logger = createSilentLogger();

  beforeEach(() => {
    db = createTestDb();
    queueRepo = new QueueRepository(db);
    threadId = seedThread(db);
  });

  afterEach(() => {
    db.close();
  });

  it('resets claimed items back to pending', () => {
    const id = enqueueItem(queueRepo, threadId, 'claimed');

    recoverFromCrash(queueRepo, logger);

    const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('pending');
  });

  it('resets processing items back to pending', () => {
    const id = enqueueItem(queueRepo, threadId, 'processing');

    recoverFromCrash(queueRepo, logger);

    const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('pending');
  });

  it('leaves voice backend work for voice reconciliation instead of replaying it', () => {
    const id = enqueueCollaborationItem(
      queueRepo,
      threadId,
      JSON.stringify({ kind: 'voice_backend', sessionId: 'session-1', delegationId: 'delegation-1' }),
      'claimed',
    );

    recoverFromCrash(queueRepo, logger);

    const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('claimed');
  });

  it('leaves processing voice backend work for voice reconciliation', () => {
    const id = enqueueCollaborationItem(
      queueRepo,
      threadId,
      JSON.stringify({ kind: 'voice_backend', sessionId: 'session-2', delegationId: 'delegation-2' }),
      'processing',
    );

    recoverFromCrash(queueRepo, logger);

    const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('processing');
  });

  it('recovers normal collaboration work when kind is missing or null', () => {
    const missingKindId = enqueueCollaborationItem(
      queueRepo,
      threadId,
      JSON.stringify({ sessionId: 'normal-missing-kind' }),
      'claimed',
    );
    const nullKindId = enqueueCollaborationItem(
      queueRepo,
      threadId,
      JSON.stringify({ kind: null, sessionId: 'normal-null-kind' }),
      'processing',
    );

    recoverFromCrash(queueRepo, logger);

    for (const id of [missingKindId, nullKindId]) {
      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
        status: string;
      };
      expect(row.status).toBe('pending');
    }
  });

  it('recovers malformed collaboration payloads without throwing', () => {
    const id = enqueueCollaborationItem(queueRepo, threadId, '{"kind":', 'processing');

    expect(() => recoverFromCrash(queueRepo, logger)).not.toThrow();

    const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('pending');
  });

  it('resets multiple in-flight items in a single call', () => {
    const id1 = enqueueItem(queueRepo, threadId, 'claimed');
    const id2 = enqueueItem(queueRepo, threadId, 'processing');
    const id3 = enqueueItem(queueRepo, threadId, 'claimed');

    recoverFromCrash(queueRepo, logger);

    for (const id of [id1, id2, id3]) {
      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
        status: string;
      };
      expect(row.status).toBe('pending');
    }
  });

  it('does not modify already-pending items', () => {
    const id = enqueueItem(queueRepo, threadId, 'pending');

    recoverFromCrash(queueRepo, logger);

    const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('pending');
  });

  it('does not modify completed items', () => {
    const id = enqueueItem(queueRepo, threadId, 'completed');

    recoverFromCrash(queueRepo, logger);

    const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('completed');
  });

  it('does not modify dead_letter items', () => {
    const id = enqueueItem(queueRepo, threadId, 'dead_letter');

    recoverFromCrash(queueRepo, logger);

    const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('dead_letter');
  });

  it('is safe to call when no in-flight items exist', () => {
    // Should not throw
    expect(() => recoverFromCrash(queueRepo, logger)).not.toThrow();
  });
});

describe('recoverFromCrash Signal cold-start boundary', () => {
  const now = 2_000_000_100_000;
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let restartDirectory: string | undefined;
  const logger = createSilentLogger();

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    queueRepo = new QueueRepository(db);
  });

  afterEach(() => {
    db.close();
    if (restartDirectory !== undefined) {
      rmSync(restartDirectory, { recursive: true, force: true });
      restartDirectory = undefined;
    }
    vi.restoreAllMocks();
    BaseRepository.__resetMonotonicClockForTests();
  });

  function prepare(overrides: Partial<SignalDeliveryCheckpoint> = {}): SignalDeliveryCheckpoint {
    const threadId = seedThread(db);
    const id = enqueueItem(queueRepo, threadId);
    return queueRepo
      .saveSignalCheckpoint(
        {
          version: 1,
          queueItemId: id,
          deliveryId: `delivery-${id}`,
          kind: 'reply',
          personaId: 'persona',
          threadId,
          channelName: 'signal-fixture',
          accountUuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          destination: 'signal:v1:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:self',
          body: 'firstsecond',
          chunks: ['first', 'second'],
          nextChunk: 0,
          phase: 'ready',
          currentChunkAcceptance: 'unwritten',
          acceptedChunks: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: now - 10_000,
          expiresAt: now - 10_000 + SIGNAL_CHECKPOINT_LIFETIME_MS,
          ...overrides,
        },
        now - 10_000,
      )
      ._unsafeUnwrap();
  }

  function begin(saved: SignalDeliveryCheckpoint, at = now - 5_000) {
    const account = new SignalAccountStateRepository(db)
      .getOrCreate(saved.accountUuid, at)
      ._unsafeUnwrap();
    return queueRepo.beginSignalChunk(saved, account.revision, at)._unsafeUnwrap();
  }

  function claim(saved: SignalDeliveryCheckpoint): void {
    db.prepare("UPDATE queue_items SET status = 'processing', claimed_at = ? WHERE id = ?").run(
      now - 1,
      saved.queueItemId,
    );
  }

  function processor(): QueueProcessor {
    return new QueueProcessor(
      queueRepo,
      () => 1_000,
      new DeadLetterHandler(queueRepo, logger),
      logger,
    );
  }

  it('classifies a reopened interrupted chunk before ordinary reset and dispatch, fencing the account', async () => {
    const ordinary = enqueueItem(queueRepo, seedThread(db), 'processing');
    const saved = prepare();
    begin(saved);
    claim(saved);
    restartDirectory = mkdtempSync(join(tmpdir(), 'talon-lifecycle-recovery-'));
    const filename = join(restartDirectory, 'recovery.sqlite');
    await db.backup(filename);
    db.close();
    db = new Database(filename);
    db.pragma('foreign_keys = ON');
    queueRepo = new QueueRepository(db);
    const recoveryCall = vi.spyOn(queueRepo, 'recoverSignalQueue');

    const result = recoverFromCrash(queueRepo, logger);

    expect(queueRepo.findById(saved.queueItemId)._unsafeUnwrap()).toMatchObject({
      status: 'dead_letter',
      error: 'UNKNOWN_ACCEPTANCE',
      attempts: 0,
      max_attempts: 3,
    });
    expect(queueRepo.inspectSignalDelivery(saved.queueItemId, now)._unsafeUnwrap()).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { phase: 'terminal', terminalOutcome: 'UNKNOWN' },
    });
    expect(
      new SignalAccountStateRepository(db).findByAccount(saved.accountUuid)._unsafeUnwrap(),
    ).toMatchObject({ reservation: null, recoveryNotBefore: now + 60_000 });
    expect(
      new SignalDestinationLeaseRepository(db)
        .find(saved.accountUuid, saved.destination)
        ._unsafeUnwrap(),
    ).toBeNull();
    expect(queueRepo.findById(ordinary)._unsafeUnwrap()?.status).toBe('pending');
    expect(recoveryCall).toHaveBeenCalledTimes(1);
    expect(recoveryCall).toHaveBeenCalledWith(now);
    expect(result).toBe(recoveryCall.mock.results[0]?.value);
    expect(result._unsafeUnwrap()).toMatchObject({
      ordinaryReset: 1,
      terminal: 1,
      reservationsClassified: 1,
    });
    const ordinaryHandler = vi.fn<QueueHandler>(async () => ok(undefined));
    const savedHandler = vi.fn<SavedSignalDeliveryHandler>(async () => ok(undefined));
    await processor().processNext(ordinaryHandler, savedHandler);
    expect(ordinaryHandler).toHaveBeenCalledTimes(1);
    expect(ordinaryHandler.mock.calls[0]?.[0]).toMatchObject({ id: ordinary });
    expect(savedHandler).not.toHaveBeenCalled();
  });

  it('retains a ready saved cursor, lease, attempts, expiry and wall retry instead of replaying ordinary work', async () => {
    const saved = prepare();
    const ready = queueRepo
      .settleSignalChunk(begin(saved), { kind: 'accepted', successCount: 1 }, now - 4_999)
      ._unsafeUnwrap();
    queueRepo.deferSignalDelivery(ready, 1_000, now - 500)._unsafeUnwrap();
    claim(ready);
    const before = queueRepo.findById(ready.queueItemId)._unsafeUnwrap()!;
    const lease = new SignalDestinationLeaseRepository(db)
      .find(ready.accountUuid, ready.destination)
      ._unsafeUnwrap();

    const result = recoverFromCrash(queueRepo, logger);

    expect(queueRepo.findById(ready.queueItemId)._unsafeUnwrap()).toMatchObject({
      status: 'pending',
      claimed_at: null,
      payload: before.payload,
      next_retry_at: before.next_retry_at,
      attempts: before.attempts,
      max_attempts: 3,
    });
    expect(
      new SignalDestinationLeaseRepository(db)
        .find(ready.accountUuid, ready.destination)
        ._unsafeUnwrap(),
    ).toEqual(lease);
    expect(result._unsafeUnwrap()).toMatchObject({ ready: 1, terminal: 0 });
    const ordinaryHandler = vi.fn<QueueHandler>(async () => ok(undefined));
    const savedHandler = vi.fn<SavedSignalDeliveryHandler>(async () => ok(undefined));
    expect(await processor().processNext(ordinaryHandler, savedHandler)).toBeNull();
    vi.mocked(Date.now).mockReturnValue(now + 500);
    await processor().processNext(ordinaryHandler, savedHandler);
    expect(ordinaryHandler).not.toHaveBeenCalled();
    expect(savedHandler).toHaveBeenCalledTimes(1);
    expect(savedHandler.mock.calls[0]?.[1]).toEqual(ready);
    expect(queueRepo.findById(ready.queueItemId)._unsafeUnwrap()).toMatchObject({
      status: 'failed',
      attempts: 0,
      max_attempts: 3,
    });
  });

  it('recovers delivered work after expiry for guarded local finalization only', async () => {
    const saved = prepare({ body: 'done', chunks: ['done'] });
    const delivered = queueRepo
      .settleSignalChunk(begin(saved), { kind: 'accepted', successCount: 1 }, now - 4_999)
      ._unsafeUnwrap();
    claim(delivered);
    vi.mocked(Date.now).mockReturnValue(saved.expiresAt + 1);
    const result = recoverFromCrash(queueRepo, logger);
    expect(result._unsafeUnwrap()).toMatchObject({ delivered: 1, terminal: 0 });
    const localWrite = vi.fn(() => ok(undefined));
    const ordinaryHandler = vi.fn<QueueHandler>(async () => ok(undefined));
    const savedHandler = vi.fn<SavedSignalDeliveryHandler>(async (_item, checkpoint) =>
      queueRepo.finalizeSignalDelivery(checkpoint, localWrite, Date.now()),
    );
    await processor().processNext(ordinaryHandler, savedHandler);
    expect(ordinaryHandler).not.toHaveBeenCalled();
    expect(savedHandler).toHaveBeenCalledTimes(1);
    expect(savedHandler.mock.calls[0]?.[1]).toEqual(delivered);
    expect(await savedHandler.mock.results[0]?.value).toEqual(ok(undefined));
    expect(localWrite).toHaveBeenCalledTimes(1);
    expect(queueRepo.findById(saved.queueItemId)._unsafeUnwrap()?.status).toBe('completed');
    expect(
      new SignalAccountStateRepository(db).findByAccount(saved.accountUuid)._unsafeUnwrap()
        ?.reservation,
    ).toBeNull();
  });

  it('terminalizes expired ready, invocation-only, invalid and pre-reservation orphan work without dispatch', async () => {
    const expired = prepare({
      createdAt: now - SIGNAL_CHECKPOINT_LIFETIME_MS,
      expiresAt: now,
    });
    claim(expired);
    const guarded = enqueueItem(queueRepo, seedThread(db), 'processing');
    queueRepo
      .markSignalDeliveryStarted(
        {
          version: 1,
          queueItemId: guarded,
          deliveryId: 'guard',
          purpose: 'progress',
          startedAt: now - 1,
        },
        null,
        now - 1,
      )
      ._unsafeUnwrap();
    const orphan = enqueueItem(queueRepo, seedThread(db), 'claimed');
    new SignalDestinationLeaseRepository(db)
      .acquire(
        expired.accountUuid,
        expired.destination,
        {
          queueItemId: orphan,
          deliveryId: 'orphan',
          purpose: 'explicit',
        },
        now - 1,
      )
      ._unsafeUnwrap();
    const invalid = enqueueItem(queueRepo, seedThread(db), 'processing');
    db.prepare('UPDATE queue_items SET payload = ? WHERE id = ?').run(
      JSON.stringify({ [SIGNAL_DELIVERY_CHECKPOINT_KEY]: null }),
      invalid,
    );

    const result = recoverFromCrash(queueRepo, logger);

    for (const id of [expired.queueItemId, guarded, orphan, invalid]) {
      expect(queueRepo.findById(id)._unsafeUnwrap()?.status).toBe('dead_letter');
    }
    expect(queueRepo.findById(expired.queueItemId)._unsafeUnwrap()?.error).toBe(
      'CHECKPOINT_EXPIRED',
    );
    expect(result._unsafeUnwrap()).toMatchObject({
      ready: 0,
      ordinaryReset: 0,
      orphanLeasesReleased: 1,
    });
    expect(
      new SignalDestinationLeaseRepository(db)
        .find(expired.accountUuid, expired.destination)
        ._unsafeUnwrap(),
    ).toBeNull();
    const ordinaryHandler = vi.fn<QueueHandler>(async () => ok(undefined));
    const savedHandler = vi.fn<SavedSignalDeliveryHandler>(async () => ok(undefined));
    expect(await processor().processNext(ordinaryHandler, savedHandler)).toBeNull();
    expect(ordinaryHandler).not.toHaveBeenCalled();
    expect(savedHandler).not.toHaveBeenCalled();
  });

  it('classifies a purged active reservation without resurrecting cancelled work', () => {
    const saved = prepare();
    begin(saved);
    claim(saved);
    expect(
      queueRepo
        .purge(['pending', 'failed', 'completed', 'claimed', 'processing', 'dead_letter'])
        ._unsafeUnwrap(),
    ).toBe(1);

    const result = recoverFromCrash(queueRepo, logger);

    expect(queueRepo.findById(saved.queueItemId)._unsafeUnwrap()).toBeNull();
    expect(result._unsafeUnwrap()).toMatchObject({
      reservationsClassified: 1,
      ready: 0,
      delivered: 0,
    });
    expect(
      new SignalAccountStateRepository(db).findByAccount(saved.accountUuid)._unsafeUnwrap(),
    ).toMatchObject({
      reservation: null,
      recoveryNotBefore: now + 60_000,
    });
    expect(
      queueRepo.inspectSignalDelivery(saved.queueItemId, now)._unsafeUnwrapErr(),
    ).toBeInstanceOf(DeliveryCancelled);
    expect(queueRepo.saveSignalCheckpoint(saved, now)._unsafeUnwrapErr()).toBeInstanceOf(
      DeliveryCancelled,
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
    expect(queueRepo.findById(saved.queueItemId)._unsafeUnwrap()).toBeNull();
  });

  it('rolls back reservation classification, ordinary reset and leases on a later DB error, with safe diagnostics', () => {
    const ordinary = enqueueItem(queueRepo, seedThread(db), 'processing');
    const saved = prepare();
    begin(saved);
    claim(saved);
    const beforeQueue = db.prepare('SELECT * FROM queue_items ORDER BY id').all();
    const beforeAccount = db.prepare('SELECT * FROM signal_account_state').all();
    const beforeLeases = db.prepare('SELECT * FROM signal_destination_leases').all();
    db.exec(`CREATE TRIGGER fail_recovery BEFORE UPDATE ON queue_items
      WHEN NEW.status = 'pending' BEGIN SELECT RAISE(ABORT, 'PRIVATE_BODY_ACCOUNT_RPC'); END`);
    const errorLog = vi.spyOn(logger, 'error');
    const successLog = vi.spyOn(logger, 'warn');
    const recoveryCall = vi.spyOn(queueRepo, 'recoverSignalQueue');

    const result = recoverFromCrash(queueRepo, logger);

    expect(queueRepo.findById(ordinary)._unsafeUnwrap()?.status).toBe('processing');
    expect(db.prepare('SELECT * FROM queue_items ORDER BY id').all()).toEqual(beforeQueue);
    expect(db.prepare('SELECT * FROM signal_account_state').all()).toEqual(beforeAccount);
    expect(db.prepare('SELECT * FROM signal_destination_leases').all()).toEqual(beforeLeases);
    expect(result._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
    expect(result).toBe(recoveryCall.mock.results[0]?.value);
    expect(recoveryCall).toHaveBeenCalledTimes(1);
    expect(successLog).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      'daemon: queue recovery failed; claims must remain quiesced',
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('PRIVATE_BODY_ACCOUNT_RPC');
  });

  it('uses the full dispatch barrier before recovery and keeps claims quiesced through rollback until explicit post-Ok resume', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const saved = prepare();
    const manager = new QueueManager(
      queueRepo,
      new ThreadRepository(db),
      {
        maxAttempts: 3,
        backoffBaseMs: 1_000,
        backoffMaxMs: 1_000,
        concurrencyLimit: 1,
      },
      logger,
    );
    const ordinaryHandler = vi.fn<QueueHandler>(async () => ok(undefined));
    const savedHandler = vi.fn<SavedSignalDeliveryHandler>(async () => ok(undefined));
    const recoveryCall = vi.spyOn(queueRepo, 'recoverSignalQueue');
    db.exec(`CREATE TRIGGER block_saved_defer BEFORE UPDATE ON queue_items
        WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'fixture defer blocked'); END`);
    try {
      manager.startProcessing(ordinaryHandler, savedHandler);
      await vi.advanceTimersByTimeAsync(500);
      expect(savedHandler).toHaveBeenCalledTimes(1);
      expect(await savedHandler.mock.results[0]?.value).toEqual(ok(undefined));
      expect(queueRepo.findById(saved.queueItemId)._unsafeUnwrap()?.status).toBe('claimed');

      let drained = false;
      const barrier = manager.quiesceAndDrainClaims().then(() => {
        drained = true;
      });
      const waiting = enqueueItem(queueRepo, seedThread(db));
      await vi.advanceTimersByTimeAsync(1_500);
      // The callback returned, but the real failed post-handler write is still active.
      expect(drained).toBe(false);
      expect(recoveryCall).not.toHaveBeenCalled();
      expect(ordinaryHandler).not.toHaveBeenCalled();
      expect(queueRepo.findById(waiting)._unsafeUnwrap()?.status).toBe('pending');

      db.exec('DROP TRIGGER block_saved_defer');
      await vi.advanceTimersByTimeAsync(65_000);
      expect(drained).toBe(true);
      await barrier;
      expect(savedHandler).toHaveBeenCalledTimes(1);
      expect(savedHandler.mock.calls[0]?.[1]).toEqual(saved);
      const savedBeforeRecovery = queueRepo.findById(saved.queueItemId)._unsafeUnwrap();
      expect(savedBeforeRecovery).toMatchObject({ status: 'failed', attempts: 0 });

      // No independent actors/RPCs exist in this fixture. The persisted orphan is not live work.
      const orphan = enqueueItem(queueRepo, seedThread(db), 'processing');
      db.exec(`CREATE TRIGGER block_recovery BEFORE UPDATE ON queue_items
          WHEN OLD.status = 'processing' AND NEW.status = 'pending'
          BEGIN SELECT RAISE(ABORT, 'fixture recovery blocked'); END`);
      const failed = recoverFromCrash(queueRepo, logger);
      expect(failed._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
      expect(failed).toBe(recoveryCall.mock.results[0]?.value);
      expect(queueRepo.findById(orphan)._unsafeUnwrap()?.status).toBe('processing');
      expect(queueRepo.findById(saved.queueItemId)._unsafeUnwrap()).toEqual(savedBeforeRecovery);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ordinaryHandler).not.toHaveBeenCalled();
      expect(savedHandler).toHaveBeenCalledTimes(1);

      db.exec('DROP TRIGGER block_recovery');
      const recovered = recoverFromCrash(queueRepo, logger);
      expect(recovered._unsafeUnwrap()).toMatchObject({ ordinaryReset: 1, ready: 1 });
      expect(recovered).toBe(recoveryCall.mock.results[1]?.value);
      expect(recoveryCall).toHaveBeenCalledTimes(2);
      expect(queueRepo.findById(orphan)._unsafeUnwrap()?.status).toBe('pending');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ordinaryHandler).not.toHaveBeenCalled();
      expect(savedHandler).toHaveBeenCalledTimes(1);
      manager.resumeClaims();
      await vi.advanceTimersByTimeAsync(500);
      expect(ordinaryHandler).toHaveBeenCalledTimes(1);
      expect(ordinaryHandler.mock.calls[0]?.[0]).toMatchObject({ id: waiting });
      expect(queueRepo.findById(waiting)._unsafeUnwrap()?.status).toBe('completed');
      expect(savedHandler).toHaveBeenCalledTimes(1);
      expect(queueRepo.inspectSignalDelivery(saved.queueItemId, now)._unsafeUnwrap()).toEqual({
        kind: 'checkpoint',
        checkpoint: saved,
      });
    } finally {
      manager.stopProcessing();
      db.exec('DROP TRIGGER IF EXISTS block_saved_defer; DROP TRIGGER IF EXISTS block_recovery');
      await vi.advanceTimersByTimeAsync(65_000);
      vi.useRealTimers();
    }
  });

  it('logs safe recovery counts only while returning operation identities for caller audits', () => {
    const saved = prepare();
    const guarded = enqueueItem(queueRepo, seedThread(db), 'processing');
    queueRepo
      .markSignalDeliveryStarted(
        {
          version: 1,
          queueItemId: guarded,
          deliveryId: 'operation',
          purpose: 'explicit',
          startedAt: now - 1,
        },
        null,
        now - 1,
      )
      ._unsafeUnwrap();
    const warning = vi.spyOn(logger, 'warn');

    const result = recoverFromCrash(queueRepo, logger)._unsafeUnwrap();

    expect(result.interruptedInvocations).toEqual([
      {
        version: 1,
        queueItemId: guarded,
        deliveryId: 'operation',
        purpose: 'explicit',
        startedAt: now - 1,
      },
    ]);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      {
        ready: 1,
        delivered: 0,
        terminal: 1,
        invalid: 0,
        reservationsClassified: 0,
        orphanLeasesReleased: 0,
        interruptedInvocations: 1,
      },
      'daemon: recovered Signal queue state',
    );
    const logged = JSON.stringify(warning.mock.calls);
    for (const privateValue of [
      saved.body,
      saved.accountUuid,
      saved.destination,
      guarded,
      'operation',
    ]) {
      expect(logged).not.toContain(privateValue);
    }
  });

  it('preserves ordinary failed retry policy and malformed legacy bytes alongside Signal recovery', () => {
    const threadId = seedThread(db);
    const failed = enqueueItem(queueRepo, threadId);
    queueRepo.fail(failed, 'ordinary failure', now + 5_000)._unsafeUnwrap();
    const failedBefore = queueRepo.findById(failed)._unsafeUnwrap();
    const legacy = enqueueItem(queueRepo, seedThread(db), 'processing');
    db.prepare('UPDATE queue_items SET payload = ? WHERE id = ?').run('legacy non-JSON', legacy);
    const completed = enqueueItem(queueRepo, seedThread(db), 'completed');
    const dead = enqueueItem(queueRepo, seedThread(db), 'dead_letter');
    const completedBefore = queueRepo.findById(completed)._unsafeUnwrap();
    const deadBefore = queueRepo.findById(dead)._unsafeUnwrap();
    prepare();

    const result = recoverFromCrash(queueRepo, logger)._unsafeUnwrap();

    expect(result).toMatchObject({ ordinaryReset: 1, ready: 1, invalid: 0 });
    expect(queueRepo.findById(failed)._unsafeUnwrap()).toEqual(failedBefore);
    expect(queueRepo.findById(legacy)._unsafeUnwrap()).toMatchObject({
      status: 'pending',
      payload: 'legacy non-JSON',
    });
    expect(queueRepo.findById(completed)._unsafeUnwrap()).toEqual(completedBefore);
    expect(queueRepo.findById(dead)._unsafeUnwrap()).toEqual(deadBefore);
  });

  it.each([
    new SignalStateError('CONFLICT'),
    new SignalCheckpointError('INVALID'),
    new DeliveryCancelled(),
  ])('returns typed recovery failure unchanged and without raw diagnostic data (%s)', (failure) => {
    const expected = err(failure);
    const recoveryCall = vi.spyOn(queueRepo, 'recoverSignalQueue').mockReturnValue(expected);
    const result = recoverFromCrash(queueRepo, logger);
    expect(result).toBe(expected);
    expect(result._unsafeUnwrapErr()).toBe(failure);
    expect(recoveryCall).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// writePidFile / removePidFile tests
// ---------------------------------------------------------------------------

describe('writePidFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `talon-test-${uuid()}`);
  });

  afterEach(() => {
    // Best-effort cleanup
    try {
      removePidFile(tmpDir);
    } catch {
      // Ignore
    }
  });

  it('creates the PID file in the given data directory', () => {
    mkdirSync(tmpDir, { recursive: true });
    writePidFile(tmpDir);

    const pidPath = join(tmpDir, 'talond.pid');
    expect(existsSync(pidPath)).toBe(true);
  });

  it('writes the current process PID to the file', () => {
    mkdirSync(tmpDir, { recursive: true });
    writePidFile(tmpDir);

    const pidPath = join(tmpDir, 'talond.pid');
    const content = readFileSync(pidPath, 'utf-8');
    expect(content).toBe(String(process.pid));
  });

  it('creates the data directory if it does not exist', () => {
    // tmpDir does not exist yet
    writePidFile(tmpDir);

    const pidPath = join(tmpDir, 'talond.pid');
    expect(existsSync(pidPath)).toBe(true);
  });

  it('overwrites an existing PID file', () => {
    mkdirSync(tmpDir, { recursive: true });
    const pidPath = join(tmpDir, 'talond.pid');
    writeFileSync(pidPath, '99999', 'utf-8');

    writePidFile(tmpDir);

    const content = readFileSync(pidPath, 'utf-8');
    expect(content).toBe(String(process.pid));
  });
});

describe('removePidFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `talon-test-${uuid()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  it('removes an existing PID file', () => {
    writePidFile(tmpDir);
    const pidPath = join(tmpDir, 'talond.pid');
    expect(existsSync(pidPath)).toBe(true);

    removePidFile(tmpDir);

    expect(existsSync(pidPath)).toBe(false);
  });

  it('is a no-op if the PID file does not exist', () => {
    // Should not throw
    expect(() => removePidFile(tmpDir)).not.toThrow();
  });

  it('is safe to call multiple times', () => {
    writePidFile(tmpDir);
    removePidFile(tmpDir);
    // Second call: file is already gone
    expect(() => removePidFile(tmpDir)).not.toThrow();
  });
});
