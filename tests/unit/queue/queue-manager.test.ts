import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ok, err } from 'neverthrow';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { QueueManager, type QueueConfig } from '../../../src/queue/queue-manager.js';
import {
  QueueItemStatus,
  type QueueItem,
  type QueueHandler,
  type SavedSignalDeliveryHandler,
} from '../../../src/queue/queue-types.js';
import { createTestDb, createTestLogger, seedThread, uuid } from './helpers.js';
import {
  DeliveryCancelled,
  DeliveryDeferredError,
  SignalDeliveryError,
} from '../../../src/core/errors/error-types.js';
import {
  SIGNAL_CHECKPOINT_LIFETIME_MS,
  type SignalDeliveryCheckpoint,
} from '../../../src/queue/signal-delivery-checkpoint.js';
import {
  SignalStateError,
  SignalAccountStateRepository,
} from '../../../src/core/database/repositories/signal-account-state-repository.js';
import { BaseRepository } from '../../../src/core/database/repositories/base-repository.js';

const DEFAULT_CONFIG: QueueConfig = {
  maxAttempts: 3,
  backoffBaseMs: 100,
  backoffMaxMs: 5000,
  concurrencyLimit: 2,
};

describe('QueueManager', () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let threadRepo: ThreadRepository;
  let manager: QueueManager;
  let threadId: string;

  beforeEach(() => {
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    queueRepo = new QueueRepository(db);
    threadRepo = new ThreadRepository(db);
    manager = new QueueManager(queueRepo, threadRepo, DEFAULT_CONFIG, createTestLogger());
    threadId = seedThread(db);
  });

  afterEach(() => {
    manager.stopProcessing();
    db.close();
  });

  // -------------------------------------------------------------------------
  // enqueue
  // -------------------------------------------------------------------------

  describe('enqueue', () => {
    it('returns a QueueItem with status=pending', () => {
      const result = manager.enqueue(threadId, 'message', { text: 'hello' });
      expect(result.isOk()).toBe(true);

      const item = result._unsafeUnwrap();
      expect(item.status).toBe(QueueItemStatus.Pending);
      expect(item.threadId).toBe(threadId);
      expect(item.type).toBe('message');
      expect(item.maxAttempts).toBe(DEFAULT_CONFIG.maxAttempts);
    });

    it('stores the payload as a parsed object', () => {
      const payload = { key: 'value', num: 42 };
      const item = manager.enqueue(threadId, 'message', payload)._unsafeUnwrap();
      expect(item.payload).toEqual(payload);
    });

    it('stores items without a messageId (messageId is optional)', () => {
      // messageId references messages(id) FK — omitting is valid.
      const item = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
      expect(item.messageId).toBeUndefined();
    });

    it('returns QueueError for a non-existent thread', () => {
      const result = manager.enqueue(uuid(), 'message', {});
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('QUEUE_ERROR');
    });

    it('supports all item types', () => {
      for (const type of ['message', 'schedule', 'collaboration'] as const) {
        const result = manager.enqueue(threadId, type, {});
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().type).toBe(type);
      }
    });

    it('generates a unique id for each item', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const item = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
        ids.add(item.id);
      }
      expect(ids.size).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // stats
  // -------------------------------------------------------------------------

  describe('stats', () => {
    it('returns zero counts for an empty queue', () => {
      const stats = manager.stats();
      expect(stats).toEqual({ pending: 0, claimed: 0, processing: 0, deadLetter: 0 });
    });

    it('reflects enqueued items as pending', () => {
      manager.enqueue(threadId, 'message', {});
      manager.enqueue(threadId, 'message', {});
      const stats = manager.stats();
      expect(stats.pending).toBe(2);
    });

    it('reflects dead-letter items', () => {
      manager.enqueue(threadId, 'message', {});
      // Claim and immediately dead-letter via direct repo call
      const row = queueRepo.claimNext(threadId)._unsafeUnwrap();
      if (row) {
        queueRepo.markDeadLetter(row.id, 'manual');
      }
      const stats = manager.stats();
      expect(stats.deadLetter).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // processing loop
  // -------------------------------------------------------------------------

  describe('startProcessing / stopProcessing', () => {
    it('processes an enqueued item within the poll interval', async () => {
      manager.enqueue(threadId, 'message', { task: 'do-work' });
      const processed: QueueItem[] = [];

      manager.startProcessing(async (item) => {
        processed.push(item);
        return ok(undefined);
      });

      // Wait for at least 2 poll intervals
      await new Promise((r) => setTimeout(r, 1200));
      manager.stopProcessing();

      expect(processed.length).toBeGreaterThanOrEqual(1);
      expect(processed[0]?.type).toBe('message');
    });

    it('marks the item as completed after successful handler', async () => {
      const item = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();

      manager.startProcessing(async () => ok(undefined));
      await new Promise((r) => setTimeout(r, 1200));
      manager.stopProcessing();

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(item.id) as {
        status: string;
      };
      expect(row.status).toBe('completed');
    });

    it('marks the item as failed after handler error', async () => {
      const item = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();

      manager.startProcessing(async () => err(new Error('test failure')));
      await new Promise((r) => setTimeout(r, 1200));
      manager.stopProcessing();

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(item.id) as {
        status: string;
      };
      expect(row.status).toBe('failed');
    });

    it('stops processing after stopProcessing is called', async () => {
      let callCount = 0;

      manager.startProcessing(async () => {
        callCount++;
        return ok(undefined);
      });

      // No items enqueued — let the loop tick a few times with nothing to do.
      await new Promise((r) => setTimeout(r, 600));
      manager.stopProcessing();

      const countAfterStop = callCount;
      await new Promise((r) => setTimeout(r, 600));

      // callCount should not have increased after stopProcessing.
      expect(callCount).toBe(countAfterStop);
    });

    it('warns and returns early if startProcessing called twice', () => {
      // No items, just verify it doesn't throw.
      manager.startProcessing(async () => ok(undefined));
      manager.startProcessing(async () => ok(undefined)); // should be a no-op warning
      manager.stopProcessing();
    });
  });

  // -------------------------------------------------------------------------
  // concurrency limit
  // -------------------------------------------------------------------------

  describe('concurrency limit', () => {
    it('does not exceed concurrencyLimit active handlers', async () => {
      // Enqueue more items than the concurrency limit across different threads.
      const thread2 = seedThread(db);
      const thread3 = seedThread(db);

      manager.enqueue(threadId, 'message', {});
      manager.enqueue(thread2, 'message', {});
      manager.enqueue(thread3, 'message', {});

      let maxConcurrent = 0;
      let currentConcurrent = 0;

      manager.startProcessing(async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((r) => setTimeout(r, 50));
        currentConcurrent--;
        return ok(undefined);
      });

      await new Promise((r) => setTimeout(r, 800));
      manager.stopProcessing();

      // Should never exceed the configured concurrency limit of 2.
      expect(maxConcurrent).toBeLessThanOrEqual(DEFAULT_CONFIG.concurrencyLimit);
    });
  });

  describe('claim quiescence and saved delivery slots', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      manager.stopProcessing();
      vi.useRealTimers();
    });

    function saveBackground(item: QueueItem): SignalDeliveryCheckpoint {
      const now = Date.now();
      const account = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      return queueRepo
        .saveSignalCheckpoint(
          {
            version: 1,
            queueItemId: item.id,
            deliveryId: `d-${item.id}`,
            kind: 'background',
            personaId: 'p',
            threadId: item.threadId,
            channelName: 'signal-test',
            accountUuid: account,
            destination: `signal:v1:${account}:self`,
            body: 'text',
            chunks: ['text'],
            nextChunk: 0,
            phase: 'ready',
            currentChunkAcceptance: 'unwritten',
            acceptedChunks: 0,
            successCount: 0,
            failureCount: 0,
            createdAt: now,
            expiresAt: now + SIGNAL_CHECKPOINT_LIFETIME_MS,
          },
          now,
        )
        ._unsafeUnwrap();
    }

    it('quiesces claims without stopping active handlers and resumes the same loop/callback', async () => {
      const first = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
      let release: (() => void) | undefined;
      const handled: string[] = [];
      manager.startProcessing(async (item) => {
        handled.push(item.id);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return ok(undefined);
      });
      await vi.advanceTimersByTimeAsync(500);
      manager.quiesceClaims();
      const second = manager.enqueue(seedThread(db), 'message', {})._unsafeUnwrap();
      await vi.advanceTimersByTimeAsync(1500);
      expect(handled).toEqual([first.id]);
      release?.();
      await vi.advanceTimersByTimeAsync(500);
      expect(queueRepo.findById(first.id)._unsafeUnwrap()?.status).toBe('completed');
      expect(queueRepo.findById(second.id)._unsafeUnwrap()?.status).toBe('pending');
      manager.resumeClaims();
      await vi.advanceTimersByTimeAsync(500);
      expect(handled).toEqual([first.id, second.id]);
      release?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    it('releases five slots across repeated saved deferrals beyond maxAttempts=3, while other threads progress', async () => {
      manager = new QueueManager(
        queueRepo,
        threadRepo,
        { ...DEFAULT_CONFIG, concurrencyLimit: 5 },
        createTestLogger(),
      );
      const savedCheckpoints: SignalDeliveryCheckpoint[] = [];
      for (let index = 0; index < 5; index++) {
        const item = manager.enqueue(seedThread(db), 'message', {})._unsafeUnwrap();
        savedCheckpoints.push(saveBackground(item));
      }
      const savedIds = savedCheckpoints.map((checkpoint) => checkpoint.queueItemId);
      const ordinary = vi.fn(async () => ok(undefined));
      let active = 0;
      let peak = 0;
      const actor = vi.fn(async (_item: QueueItem, checkpoint: SignalDeliveryCheckpoint) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        active--;
        return err(
          new DeliveryDeferredError(
            new SignalDeliveryError({
              reason: 'ACCOUNT_BUSY',
              outcome: 'NOT_SENT',
              acceptedChunks: 0,
              currentChunkAcceptance: 'unwritten',
              successCount: 0,
              failureCount: 0,
              retryScope: 'delivery_only',
            }),
            checkpoint.expiresAt,
          ),
        );
      });
      manager.startProcessing(ordinary, actor);
      await vi.advanceTimersByTimeAsync(601);
      expect(peak).toBe(5);
      for (let attempt = 0; attempt < 5; attempt++) {
        for (const id of savedIds)
          db.prepare('UPDATE queue_items SET next_retry_at = 0 WHERE id = ?').run(id);
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(actor).toHaveBeenCalledTimes(30);
      for (const [item, checkpoint] of actor.mock.calls) {
        expect(checkpoint).toEqual(savedCheckpoints.find((saved) => saved.queueItemId === item.id));
      }
      for (const result of actor.mock.results) {
        const outcome = await result.value;
        expect(outcome.isErr()).toBe(true);
        expect(outcome._unsafeUnwrapErr()).toBeInstanceOf(DeliveryDeferredError);
      }
      expect(active).toBe(0);
      expect(ordinary).not.toHaveBeenCalled();
      for (const id of savedIds)
        expect(queueRepo.findById(id)._unsafeUnwrap()).toMatchObject({
          status: 'failed',
          attempts: 0,
          max_attempts: 3,
          claimed_at: null,
        });
      manager.quiesceClaims();
      const other = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
      await vi.advanceTimersByTimeAsync(500);
      expect(ordinary).not.toHaveBeenCalled();
      manager.resumeClaims();
      await vi.advanceTimersByTimeAsync(500);
      expect(ordinary).toHaveBeenCalledTimes(1);
      expect(queueRepo.findById(other.id)._unsafeUnwrap()?.status).toBe('completed');
      // Purging deferred work does not retain slots or recreate a delivery on later polls.
      expect(queueRepo.purge(['failed'])._unsafeUnwrap()).toBe(5);
      const callsAfterPurge = actor.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3000);
      expect(actor).toHaveBeenCalledTimes(callsAfterPurge);
      for (const id of savedIds) expect(queueRepo.findById(id)._unsafeUnwrap()).toBeNull();
    });

    it('releases all five active slots after purge and late callbacks without resurrecting queue work', async () => {
      manager = new QueueManager(
        queueRepo,
        threadRepo,
        { ...DEFAULT_CONFIG, concurrencyLimit: 5 },
        createTestLogger(),
      );
      const item = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
      const checkpoint = saveBackground(item);
      const accounts = new SignalAccountStateRepository(db);
      const blockedItems = Array.from({ length: 4 }, () =>
        manager.enqueue(seedThread(db), 'message', {})._unsafeUnwrap(),
      );
      const releases: (() => void)[] = [];
      const ordinary = vi.fn(async (next: QueueItem) => {
        if (blockedItems.some((blocked) => blocked.id === next.id)) {
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
        }
        return ok(undefined);
      });
      const actor = vi.fn(async (_next: QueueItem, latest: SignalDeliveryCheckpoint) => {
        const state = accounts.getOrCreate(latest.accountUuid, Date.now())._unsafeUnwrap();
        const ownership = queueRepo
          .beginSignalChunk(latest, state.revision, Date.now())
          ._unsafeUnwrap();
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return queueRepo
          .settleSignalChunk(ownership, { kind: 'accepted', successCount: 1 }, Date.now())
          .map(() => undefined);
      });
      manager.startProcessing(ordinary, actor);
      await vi.advanceTimersByTimeAsync(500);
      expect(actor).toHaveBeenCalledOnce();
      expect(actor.mock.calls[0]?.[1]).toEqual(checkpoint);
      expect(ordinary).toHaveBeenCalledTimes(4);
      expect(releases).toHaveLength(5);
      expect(
        accounts.findByAccount(checkpoint.accountUuid)._unsafeUnwrap()?.reservation?.queueItemId,
      ).toBe(item.id);
      expect(
        queueRepo
          .purge(['pending', 'claimed', 'processing', 'completed', 'failed', 'dead_letter'])
          ._unsafeUnwrap(),
      ).toBe(5);
      const replacements = Array.from({ length: 5 }, () =>
        manager.enqueue(seedThread(db), 'message', {})._unsafeUnwrap(),
      );
      await vi.advanceTimersByTimeAsync(500);
      expect(ordinary).toHaveBeenCalledTimes(4);
      for (const release of releases) release();
      await vi.advanceTimersByTimeAsync(0);
      const lateResult = await actor.mock.results[0]?.value;
      expect(lateResult?.isErr()).toBe(true);
      expect(lateResult?._unsafeUnwrapErr()).toBeInstanceOf(DeliveryCancelled);
      await vi.advanceTimersByTimeAsync(500);
      expect(ordinary).toHaveBeenCalledTimes(9);
      for (const replacement of replacements)
        expect(queueRepo.findById(replacement.id)._unsafeUnwrap()?.status).toBe('completed');
      for (const purged of [item, ...blockedItems])
        expect(queueRepo.findById(purged.id)._unsafeUnwrap()).toBeNull();
      expect(
        accounts.findByAccount(checkpoint.accountUuid)._unsafeUnwrap()?.reservation,
      ).toBeNull();
      expect(manager.stats()).toMatchObject({ pending: 0, claimed: 0, processing: 0 });
      await vi.advanceTimersByTimeAsync(3000);
      expect(actor).toHaveBeenCalledOnce();
      expect(ordinary).toHaveBeenCalledTimes(9);
    });

    describe('quiesceAndDrainClaims — entire dispatch barrier', () => {
      function gate(): { promise: Promise<void>; release: () => void } {
        let release: (() => void) | undefined;
        const promise = new Promise<void>((resolve) => {
          release = resolve;
        });
        return { promise, release: () => release?.() };
      }

      function deliveryDeferred(checkpoint: SignalDeliveryCheckpoint): DeliveryDeferredError {
        return new DeliveryDeferredError(
          new SignalDeliveryError({
            reason: 'ACCOUNT_BUSY',
            outcome: 'NOT_SENT',
            acceptedChunks: 0,
            currentChunkAcceptance: 'unwritten',
            successCount: 0,
            failureCount: 0,
            retryScope: 'delivery_only',
            notBefore: Date.now() + 60_000,
          }),
          checkpoint.expiresAt,
        );
      }

      it('shares one barrier, waits for all five active dispatches, ignores early resume and retains both callbacks', async () => {
        manager = new QueueManager(
          queueRepo,
          threadRepo,
          { ...DEFAULT_CONFIG, concurrencyLimit: 5 },
          createTestLogger(),
        );
        const firstSaved = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
        const firstCheckpoint = saveBackground(firstSaved);
        const firstOrdinary = Array.from({ length: 4 }, () =>
          manager.enqueue(seedThread(db), 'message', {})._unsafeUnwrap(),
        );
        const gates = new Map([firstSaved, ...firstOrdinary].map((item) => [item.id, gate()]));
        const ordinary = vi.fn<QueueHandler>(async (item) => {
          const pending = gates.get(item.id);
          if (pending !== undefined) await pending.promise;
          return ok(undefined);
        });
        const saved = vi.fn<SavedSignalDeliveryHandler>(async (item, checkpoint) => {
          const pending = gates.get(item.id);
          if (pending !== undefined) await pending.promise;
          return err(deliveryDeferred(checkpoint));
        });
        try {
          manager.startProcessing(ordinary, saved);
          await vi.advanceTimersByTimeAsync(500);
          expect(ordinary).toHaveBeenCalledTimes(4);
          expect(saved).toHaveBeenCalledOnce();
          expect(saved.mock.calls[0]?.[1]).toEqual(firstCheckpoint);
          const timerCount = vi.getTimerCount();
          const draining = manager.quiesceAndDrainClaims();
          let drained = false;
          const observed = draining.then(() => {
            drained = true;
          });
          for (let caller = 0; caller < 32; caller++) {
            expect(manager.quiesceAndDrainClaims()).toBe(draining);
          }
          expect(vi.getTimerCount()).toBe(timerCount);
          const nextOrdinary = manager.enqueue(seedThread(db), 'message', {})._unsafeUnwrap();
          const nextSaved = manager.enqueue(seedThread(db), 'message', {})._unsafeUnwrap();
          const nextCheckpoint = saveBackground(nextSaved);
          manager.resumeClaims();
          await vi.advanceTimersByTimeAsync(1000);
          expect(drained).toBe(false);
          expect(ordinary).toHaveBeenCalledTimes(4);
          expect(saved).toHaveBeenCalledOnce();
          for (const item of [firstSaved, ...firstOrdinary.slice(0, 3)])
            gates.get(item.id)?.release();
          await vi.advanceTimersByTimeAsync(1000);
          expect(drained).toBe(false);
          expect(ordinary).toHaveBeenCalledTimes(4);
          expect(saved).toHaveBeenCalledOnce();
          const last = firstOrdinary[3];
          expect(last).toBeDefined();
          if (last !== undefined) gates.get(last.id)?.release();
          await vi.advanceTimersByTimeAsync(0);
          expect(drained).toBe(true);
          await observed;
          for (const item of firstOrdinary)
            expect(queueRepo.findById(item.id)._unsafeUnwrap()?.status).toBe('completed');
          expect(queueRepo.findById(firstSaved.id)._unsafeUnwrap()).toMatchObject({
            status: 'failed',
            attempts: 0,
            claimed_at: null,
          });
          await vi.advanceTimersByTimeAsync(500);
          for (const item of [nextOrdinary, nextSaved])
            expect(queueRepo.findById(item.id)._unsafeUnwrap()?.status).toBe('pending');
          expect(ordinary).toHaveBeenCalledTimes(4);
          expect(saved).toHaveBeenCalledOnce();
          manager.resumeClaims();
          await vi.advanceTimersByTimeAsync(500);
          expect(ordinary).toHaveBeenCalledTimes(5);
          expect(ordinary.mock.calls[4]?.[0].id).toBe(nextOrdinary.id);
          expect(saved).toHaveBeenCalledTimes(2);
          expect(saved.mock.calls[1]?.[1]).toEqual(nextCheckpoint);
          expect((await saved.mock.results[1]?.value)?.isErr()).toBe(true);
          expect(queueRepo.findById(nextOrdinary.id)._unsafeUnwrap()?.status).toBe('completed');
          expect(queueRepo.findById(nextSaved.id)._unsafeUnwrap()).toMatchObject({
            status: 'failed',
            attempts: 0,
          });
        } finally {
          manager.stopProcessing();
          for (const pending of gates.values()) pending.release();
          await vi.advanceTimersByTimeAsync(60_000);
        }
      });

      it('waits through actual post-handler deferred-write retries even after polling is stopped', async () => {
        const item = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
        const checkpoint = saveBackground(item);
        const ordinary = vi.fn<QueueHandler>(async () => ok(undefined));
        const saved = vi.fn<SavedSignalDeliveryHandler>(async () =>
          err(deliveryDeferred(checkpoint)),
        );
        db.exec(
          "CREATE TRIGGER drain_defer_failure BEFORE UPDATE ON queue_items WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'synthetic state-write failure'); END",
        );
        try {
          manager.startProcessing(ordinary, saved);
          await vi.advanceTimersByTimeAsync(500);
          expect(saved).toHaveBeenCalledOnce();
          expect((await saved.mock.results[0]?.value)?.isErr()).toBe(true);
          expect(queueRepo.findById(item.id)._unsafeUnwrap()?.status).toBe('claimed');
          const draining = manager.quiesceAndDrainClaims();
          let drained = false;
          const observed = draining.then(() => {
            drained = true;
          });
          const next = manager.enqueue(seedThread(db), 'message', {})._unsafeUnwrap();
          manager.stopProcessing();
          manager.resumeClaims();
          await vi.advanceTimersByTimeAsync(31_000);
          expect(drained).toBe(false);
          expect(saved).toHaveBeenCalledOnce();
          expect(ordinary).not.toHaveBeenCalled();
          expect(queueRepo.findById(item.id)._unsafeUnwrap()?.status).toBe('claimed');
          expect(queueRepo.findById(next.id)._unsafeUnwrap()?.status).toBe('pending');
          db.exec('DROP TRIGGER drain_defer_failure');
          await vi.advanceTimersByTimeAsync(60_000);
          expect(drained).toBe(true);
          await observed;
          expect(queueRepo.findById(item.id)._unsafeUnwrap()).toMatchObject({
            status: 'failed',
            attempts: 0,
            claimed_at: null,
          });
          expect(saved).toHaveBeenCalledOnce();
          manager.resumeClaims();
          await vi.advanceTimersByTimeAsync(1000);
          expect(queueRepo.findById(next.id)._unsafeUnwrap()?.status).toBe('pending');
          expect(ordinary).not.toHaveBeenCalled();
        } finally {
          manager.stopProcessing();
          db.exec('DROP TRIGGER IF EXISTS drain_defer_failure');
          await vi.advanceTimersByTimeAsync(60_000);
        }
      });

      it('counts a pending pre-handler inspection retry as active dispatch work', async () => {
        const item = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
        const inspect = vi.spyOn(queueRepo, 'inspectSignalDelivery');
        inspect.mockReturnValueOnce(err(new SignalStateError('DATABASE')));
        const ordinary = vi.fn<QueueHandler>(async () => ok(undefined));
        const saved = vi.fn<SavedSignalDeliveryHandler>(async () => ok(undefined));
        try {
          manager.startProcessing(ordinary, saved);
          await vi.advanceTimersByTimeAsync(500);
          expect(inspect).toHaveBeenCalledOnce();
          expect(ordinary).not.toHaveBeenCalled();
          expect(saved).not.toHaveBeenCalled();
          expect(queueRepo.findById(item.id)._unsafeUnwrap()?.status).toBe('claimed');
          const draining = manager.quiesceAndDrainClaims();
          let drained = false;
          const observed = draining.then(() => {
            drained = true;
          });
          const next = manager.enqueue(seedThread(db), 'message', {})._unsafeUnwrap();
          manager.resumeClaims();
          await vi.advanceTimersByTimeAsync(999);
          expect(drained).toBe(false);
          expect(ordinary).not.toHaveBeenCalled();
          expect(queueRepo.findById(next.id)._unsafeUnwrap()?.status).toBe('pending');
          await vi.advanceTimersByTimeAsync(1000);
          expect(drained).toBe(true);
          await observed;
          expect(ordinary).toHaveBeenCalledOnce();
          expect(ordinary.mock.calls[0]?.[0].id).toBe(item.id);
          expect((await ordinary.mock.results[0]?.value)?.isOk()).toBe(true);
          expect(saved).not.toHaveBeenCalled();
          expect(queueRepo.findById(item.id)._unsafeUnwrap()?.status).toBe('completed');
          await vi.advanceTimersByTimeAsync(1000);
          expect(queueRepo.findById(next.id)._unsafeUnwrap()?.status).toBe('pending');
        } finally {
          manager.stopProcessing();
          inspect.mockRestore();
          await vi.advanceTimersByTimeAsync(60_000);
        }
      });

      it.each(['empty', 'persisted orphan'] as const)(
        'drains stopped in-memory idle work with %s without consulting claimed-row counts',
        async (kind) => {
          const orphan =
            kind === 'persisted orphan'
              ? manager.enqueue(threadId, 'message', {})._unsafeUnwrap()
              : undefined;
          if (orphan !== undefined) queueRepo.claimNext(threadId)._unsafeUnwrap();
          const ordinary = vi.fn<QueueHandler>(async () => ok(undefined));
          const saved = vi.fn<SavedSignalDeliveryHandler>(async () => ok(undefined));
          try {
            let drained = false;
            const observed = manager.quiesceAndDrainClaims().then(() => {
              drained = true;
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(drained).toBe(true);
            await observed;
            const next = manager.enqueue(seedThread(db), 'message', {})._unsafeUnwrap();
            manager.startProcessing(ordinary, saved);
            await vi.advanceTimersByTimeAsync(1000);
            expect(ordinary).not.toHaveBeenCalled();
            expect(saved).not.toHaveBeenCalled();
            expect(queueRepo.findById(next.id)._unsafeUnwrap()?.status).toBe('pending');
            if (orphan !== undefined)
              expect(queueRepo.findById(orphan.id)._unsafeUnwrap()?.status).toBe('claimed');
            manager.stopProcessing();
            manager.resumeClaims();
            await vi.advanceTimersByTimeAsync(1000);
            expect(ordinary).not.toHaveBeenCalled();
            expect(saved).not.toHaveBeenCalled();
          } finally {
            manager.stopProcessing();
            await vi.advanceTimersByTimeAsync(60_000);
          }
        },
      );
    });

    it('does not start a stopped loop when resuming claims', async () => {
      const handler = vi.fn(async () => ok(undefined));
      manager.startProcessing(handler);
      manager.quiesceClaims();
      manager.stopProcessing();
      manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
      manager.resumeClaims();
      await vi.advanceTimersByTimeAsync(2000);
      expect(handler).not.toHaveBeenCalled();
    });
  });
});

describe('QueueManager — full ordinary dispatch ownership', () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let manager: QueueManager;
  let threadId: string;
  let releaseTail: () => void;
  let tail: Promise<void>;

  beforeEach(() => {
    vi.useFakeTimers();
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    repo = new QueueRepository(db);
    manager = new QueueManager(repo, new ThreadRepository(db), DEFAULT_CONFIG, createTestLogger());
    threadId = seedThread(db);
    tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
  });

  afterEach(async () => {
    manager.stopProcessing();
    releaseTail();
    await vi.advanceTimersByTimeAsync(0);
    await manager.quiesceAndDrainClaims();
    vi.useRealTimers();
    db.close();
  });

  it.each([2, 5])(
    'holds an early-completed ordinary tail across actual polls and both collaboration bypasses (concurrency %s)',
    async (concurrencyLimit) => {
      manager = new QueueManager(
        repo,
        new ThreadRepository(db),
        { ...DEFAULT_CONFIG, concurrencyLimit },
        createTestLogger(),
      );
      const first = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
      const handled: string[] = [];
      manager.startProcessing(async (item) => {
        handled.push(item.id);
        if (item.id === first.id) {
          repo.complete(item.id)._unsafeUnwrap();
          await tail;
        }
        return ok(undefined);
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(repo.findById(first.id)._unsafeUnwrap()?.status).toBe('completed');
      expect(repo.hasInflightItem(threadId)._unsafeUnwrap()).toBe(false);

      const headCollaboration = manager.enqueue(threadId, 'collaboration', {})._unsafeUnwrap();
      await vi.advanceTimersByTimeAsync(500);
      expect(handled).toEqual([first.id, headCollaboration.id]);
      const second = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
      const third = manager.enqueue(threadId, 'schedule', {})._unsafeUnwrap();
      const behindCollaboration = manager.enqueue(threadId, 'collaboration', {})._unsafeUnwrap();
      await vi.advanceTimersByTimeAsync(500);
      expect(handled).toEqual([first.id, headCollaboration.id, behindCollaboration.id]);
      expect(repo.findById(behindCollaboration.id)._unsafeUnwrap()?.status).toBe('completed');

      // A completed collaboration must not release the still-live ordinary owner.
      // Real progress on another seeded channel proves a subsequent poll had capacity.
      const other = manager.enqueue(seedThread(db), 'message', {})._unsafeUnwrap();
      await vi.advanceTimersByTimeAsync(500);
      expect(handled).toEqual([first.id, headCollaboration.id, behindCollaboration.id, other.id]);
      expect(repo.findById(other.id)._unsafeUnwrap()?.status).toBe('completed');
      for (const item of [second, third])
        expect(repo.findById(item.id)._unsafeUnwrap()).toMatchObject({
          status: 'pending',
          attempts: 0,
          max_attempts: 3,
          claimed_at: null,
        });

      releaseTail();
      await vi.advanceTimersByTimeAsync(1000);
      expect(handled).toEqual([
        first.id,
        headCollaboration.id,
        behindCollaboration.id,
        other.id,
        second.id,
        third.id,
      ]);
      for (const item of [first, second, third])
        expect(repo.findById(item.id)._unsafeUnwrap()).toMatchObject({
          status: 'completed',
          attempts: 0,
        });
    },
  );

  it.each([
    'purge-ok',
    'purge-cancel-return',
    'purge-cancel-throw',
    'completed-err',
    'completed-throw',
  ] as const)(
    'excludes later ordinary work until the original %s handler actually settles',
    async (outcome) => {
      const first = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
      const failure = outcome.startsWith('purge-cancel')
        ? new DeliveryCancelled()
        : new Error('held handler failure');
      const handled: string[] = [];
      manager.startProcessing(async (item) => {
        handled.push(item.id);
        if (item.id !== first.id) return ok(undefined);
        if (outcome.startsWith('purge')) repo.purge(['claimed'])._unsafeUnwrap();
        else repo.complete(item.id)._unsafeUnwrap();
        await tail;
        if (outcome.endsWith('throw')) throw failure;
        return outcome.endsWith('return') || outcome.endsWith('err') ? err(failure) : ok(undefined);
      });
      await vi.advanceTimersByTimeAsync(500);
      const second = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
      const other = manager.enqueue(seedThread(db), 'message', {})._unsafeUnwrap();
      await vi.advanceTimersByTimeAsync(500);
      expect(handled).toEqual([first.id, other.id]);
      expect(repo.findById(other.id)._unsafeUnwrap()?.status).toBe('completed');
      expect(repo.findById(second.id)._unsafeUnwrap()).toMatchObject({
        status: 'pending',
        attempts: 0,
        claimed_at: null,
      });
      releaseTail();
      await vi.advanceTimersByTimeAsync(500);
      expect(handled).toEqual([first.id, other.id, second.id]);
      expect(repo.findById(second.id)._unsafeUnwrap()?.status).toBe('completed');
      if (outcome.startsWith('purge')) expect(repo.findById(first.id)._unsafeUnwrap()).toBeNull();
      else
        expect(repo.findById(first.id)._unsafeUnwrap()).toMatchObject({
          status: 'completed',
          attempts: 0,
        });
    },
  );

  it.each(['complete', 'purge'] as const)(
    'retains ordinary ownership and full drain during local completion-write retry after public %s',
    async (disposition) => {
      const first = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
      db.exec(
        "CREATE TRIGGER lifetime_complete_failure BEFORE UPDATE ON queue_items WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'synthetic local write failure'); END",
      );
      const handled: string[] = [];
      manager.startProcessing(async (item) => {
        handled.push(item.id);
        return ok(undefined);
      });
      try {
        await vi.advanceTimersByTimeAsync(500);
        expect(handled).toEqual([first.id]);
        expect(repo.findById(first.id)._unsafeUnwrap()?.status).toBe('claimed');
        db.exec('DROP TRIGGER lifetime_complete_failure');
        if (disposition === 'complete') repo.complete(first.id)._unsafeUnwrap();
        else repo.purge(['claimed'])._unsafeUnwrap();
        const second = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
        const other = manager.enqueue(seedThread(db), 'message', {})._unsafeUnwrap();
        await vi.advanceTimersByTimeAsync(500);
        expect(handled).toEqual([first.id, other.id]);
        expect(repo.findById(other.id)._unsafeUnwrap()?.status).toBe('completed');
        expect(repo.findById(second.id)._unsafeUnwrap()?.status).toBe('pending');
        const drain = manager.quiesceAndDrainClaims();
        expect(manager.quiesceAndDrainClaims()).toBe(drain);
        let drained = false;
        const observed = drain.then(() => {
          drained = true;
        });
        manager.stopProcessing();
        manager.resumeClaims();
        await vi.advanceTimersByTimeAsync(499);
        expect(drained).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await observed;
        expect(drained).toBe(true);
        expect(handled).toEqual([first.id, other.id]);
        manager.startProcessing(async (item) => {
          handled.push(item.id);
          return ok(undefined);
        });
        await vi.advanceTimersByTimeAsync(500);
        expect(repo.findById(second.id)._unsafeUnwrap()?.status).toBe('pending');
        manager.resumeClaims();
        await vi.advanceTimersByTimeAsync(500);
        expect(repo.findById(second.id)._unsafeUnwrap()?.status).toBe('completed');
        expect(handled).toEqual([first.id, other.id, second.id]);
      } finally {
        db.exec('DROP TRIGGER IF EXISTS lifetime_complete_failure');
        await vi.advanceTimersByTimeAsync(1000);
      }
    },
  );

  it.each([2, 5])(
    'counts early-completed handler tails against all %s configured slots',
    async (concurrencyLimit) => {
      manager = new QueueManager(
        repo,
        new ThreadRepository(db),
        { ...DEFAULT_CONFIG, concurrencyLimit },
        createTestLogger(),
      );
      const active = Array.from({ length: concurrencyLimit }, () =>
        manager.enqueue(seedThread(db), 'message', {})._unsafeUnwrap(),
      );
      const handled: string[] = [];
      manager.startProcessing(async (item) => {
        handled.push(item.id);
        repo.complete(item.id)._unsafeUnwrap();
        if (active.some((held) => held.id === item.id)) await tail;
        return ok(undefined);
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(handled).toEqual(active.map((item) => item.id));
      const next = manager.enqueue(seedThread(db), 'message', {})._unsafeUnwrap();
      await vi.advanceTimersByTimeAsync(500);
      expect(handled).toHaveLength(concurrencyLimit);
      expect(repo.findById(next.id)._unsafeUnwrap()?.status).toBe('pending');
      const drain = manager.quiesceAndDrainClaims();
      let drained = false;
      const observed = drain.then(() => {
        drained = true;
      });
      manager.resumeClaims();
      await vi.advanceTimersByTimeAsync(500);
      expect(drained).toBe(false);
      releaseTail();
      await vi.advanceTimersByTimeAsync(0);
      await observed;
      expect(drained).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(repo.findById(next.id)._unsafeUnwrap()?.status).toBe('pending');
      manager.resumeClaims();
      await vi.advanceTimersByTimeAsync(500);
      expect(repo.findById(next.id)._unsafeUnwrap()?.status).toBe('completed');
    },
  );
});
