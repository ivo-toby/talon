import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ok, err } from 'neverthrow';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { DeadLetterHandler } from '../../../src/queue/dead-letter.js';
import { QueueProcessor } from '../../../src/queue/queue-processor.js';
import { calculateBackoff } from '../../../src/queue/retry-strategy.js';
import { QueueItemStatus, type QueueItem } from '../../../src/queue/queue-types.js';
import { createTestDb, createTestLogger, seedThread, enqueueItem, uuid } from './helpers.js';
import {
  DeliveryCancelled,
  DeliveryDeferredError,
  NonRetryableRunError,
  SignalDeliveryError,
} from '../../../src/core/errors/error-types.js';
import {
  SIGNAL_CHECKPOINT_LIFETIME_MS,
  SIGNAL_DELIVERY_CHECKPOINT_KEY,
  SIGNAL_DELIVERY_STARTED_KEY,
  SignalCheckpointError,
  type SignalDeliveryCheckpoint,
} from '../../../src/queue/signal-delivery-checkpoint.js';
import {
  SignalStateError,
  SignalAccountStateRepository,
} from '../../../src/core/database/repositories/signal-account-state-repository.js';
import { SignalDestinationLeaseRepository } from '../../../src/core/database/repositories/signal-destination-lease-repository.js';
import { BaseRepository } from '../../../src/core/database/repositories/base-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';

describe('QueueProcessor', () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let processor: QueueProcessor;
  let threadId: string;

  beforeEach(() => {
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    repo = new QueueRepository(db);
    const logger = createTestLogger();
    const dlHandler = new DeadLetterHandler(repo, logger);
    processor = new QueueProcessor(repo, calculateBackoff, dlHandler, logger);
    threadId = seedThread(db);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // processNext — FIFO ordering
  // -------------------------------------------------------------------------

  describe('processNext — FIFO ordering', () => {
    it('processes the oldest pending item first (FIFO)', async () => {
      const id1 = enqueueItem(repo, threadId);
      // Ensure a slightly different created_at by forcing a small gap.
      await new Promise((r) => setTimeout(r, 5));
      const id2 = enqueueItem(repo, threadId);

      const processedIds: string[] = [];
      const successHandler = async (item: QueueItem) => {
        processedIds.push(item.id);
        return ok<void, Error>(undefined);
      };

      // First call should process id1.
      const first = await processor.processNext(successHandler);
      expect(first?.id).toBe(id1);
      expect(processedIds[0]).toBe(id1);
    });

    it('returns null when no pending items exist', async () => {
      const result = await processor.processNext(async () => ok(undefined));
      expect(result).toBeNull();
    });

    it('returns the claimed item on success', async () => {
      const itemId = enqueueItem(repo, threadId);
      const result = await processor.processNext(async () => ok(undefined));
      expect(result).not.toBeNull();
      expect(result?.id).toBe(itemId);
    });
  });

  // -------------------------------------------------------------------------
  // processNext — no interleaved runs per thread
  // -------------------------------------------------------------------------

  describe('processNext — no interleaved runs per thread', () => {
    it('does not claim a second item for a thread that has an in-flight item', async () => {
      const id1 = enqueueItem(repo, threadId);
      const _id2 = enqueueItem(repo, threadId);

      // Process id1 but keep it in "claimed" state by not completing it.
      // We do this by manually claiming via the repo.
      repo.claimNext(threadId);

      // Now processNext should skip this thread because it has an inflight item.
      const result = await processor.processNext(async () => ok(undefined));
      expect(result).toBeNull();

      void id1;
    });

    it('allows a second thread to be claimed while the first is in flight', async () => {
      const thread2 = seedThread(db);
      enqueueItem(repo, threadId);
      enqueueItem(repo, thread2);

      // Claim the item for threadId manually (simulating in-flight).
      repo.claimNext(threadId);

      // processNext should be able to pick up thread2's item.
      const result = await processor.processNext(async () => ok(undefined));
      expect(result).not.toBeNull();
      expect(result?.threadId).toBe(thread2);
    });
  });

  describe('processNext — collaboration items bypass inflight check', () => {
    it('claims and processes a collaboration item on a thread with an inflight non-collaboration item', async () => {
      const inflightItemId = enqueueItem(repo, threadId);
      const collaborationItemId = enqueueItem(repo, threadId, { type: 'collaboration' });

      // Keep the first non-collaboration item in-flight.
      repo.claimNext(threadId);

      const handledIds: string[] = [];
      const result = await processor.processNext(async (item) => {
        handledIds.push(item.id);
        return ok(undefined);
      });

      expect(result).not.toBeNull();
      expect(result?.id).toBe(collaborationItemId);
      expect(result?.type).toBe('collaboration');
      expect(handledIds).toEqual([collaborationItemId]);

      const inflightRow = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(
        inflightItemId,
      ) as { status: string };
      expect(inflightRow.status).toBe('claimed');

      const collaborationRow = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(
        collaborationItemId,
      ) as { status: string };
      expect(collaborationRow.status).toBe('completed');
    });

    it('claims collaboration item even when a regular item is pending ahead of it (deadlock scenario)', async () => {
      // Simulate the deadlock: an item is in-flight, then a regular item is
      // enqueued, then a collaboration item is enqueued. Without the fix,
      // the oldest-pending check sees a regular type and skips the whole thread.
      const inflightItemId = enqueueItem(repo, threadId);
      // Manually put inflightItem into claimed state (simulates an in-flight run).
      db.prepare("UPDATE queue_items SET status = 'claimed' WHERE id = ?").run(inflightItemId);

      // Enqueue a regular item followed by a collaboration item.
      await new Promise((r) => setTimeout(r, 5));
      const regularPendingId = enqueueItem(repo, threadId);
      await new Promise((r) => setTimeout(r, 5));
      const collaborationItemId = enqueueItem(repo, threadId, { type: 'collaboration' });

      const handledIds: string[] = [];
      const result = await processor.processNext(async (item) => {
        handledIds.push(item.id);
        return ok(undefined);
      });

      // The collaboration item must be claimed and processed despite the regular
      // item sitting ahead of it in the queue.
      expect(result).not.toBeNull();
      expect(result?.id).toBe(collaborationItemId);
      expect(result?.type).toBe('collaboration');
      expect(handledIds).toEqual([collaborationItemId]);

      // Inflight and regular items must remain untouched.
      const inflightRow = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(
        inflightItemId,
      ) as { status: string };
      expect(inflightRow.status).toBe('claimed');

      const regularRow = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(
        regularPendingId,
      ) as { status: string };
      expect(regularRow.status).toBe('pending');

      const collaborationRow = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(
        collaborationItemId,
      ) as { status: string };
      expect(collaborationRow.status).toBe('completed');
    });

    it('still claims regular item first (FIFO) when thread is idle even if collaboration item is also pending', async () => {
      // Idle thread — no inflight item. Regular item is older and must come first.
      await new Promise((r) => setTimeout(r, 5));
      const regularId = enqueueItem(repo, threadId);
      await new Promise((r) => setTimeout(r, 5));
      const collaborationId = enqueueItem(repo, threadId, { type: 'collaboration' });

      const result = await processor.processNext(async () => ok(undefined));

      // FIFO must be preserved — regular item is claimed first.
      expect(result?.id).toBe(regularId);

      const regularRow = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(regularId) as { status: string };
      expect(regularRow.status).toBe('completed');

      const collabRow = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(collaborationId) as { status: string };
      expect(collabRow.status).toBe('pending');
    });
  });

  // -------------------------------------------------------------------------
  // complete
  // -------------------------------------------------------------------------

  describe('complete', () => {
    it('sets item status to completed', () => {
      const itemId = enqueueItem(repo, threadId);
      repo.claimNext(threadId);

      const result = processor.complete(itemId);
      expect(result.isOk()).toBe(true);

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(itemId) as {
        status: string;
      };
      expect(row.status).toBe('completed');
    });

    it('returns a QueueError for a non-existent item', () => {
      // complete on unknown id should succeed silently (SQLite UPDATE with no match).
      const result = processor.complete(uuid());
      // No error thrown — the repository does a silent UPDATE 0 rows.
      expect(result.isOk()).toBe(true);
    });

    it('completes an item that was processed via processNext', async () => {
      const itemId = enqueueItem(repo, threadId);
      await processor.processNext(async () => ok(undefined));

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(itemId) as {
        status: string;
      };
      expect(row.status).toBe('completed');
    });
  });

  // -------------------------------------------------------------------------
  // fail — retry
  // -------------------------------------------------------------------------

  describe('fail — with retry', () => {
    it('increments attempts and sets status to failed', () => {
      const itemId = enqueueItem(repo, threadId, { max_attempts: 3 });
      repo.claimNext(threadId);

      const result = processor.fail(itemId, 'transient error');
      expect(result.isOk()).toBe(true);

      const row = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(itemId) as {
        status: string;
        attempts: number;
        next_retry_at: number;
        error: string;
      };
      expect(row.status).toBe('failed');
      expect(row.attempts).toBe(1);
      expect(row.next_retry_at).toBeGreaterThan(Date.now());
      expect(row.error).toBe('transient error');
    });

    it('applies exponential backoff strategy for retry time', () => {
      const mockBackoff = vi.fn().mockReturnValue(5000);
      const logger = createTestLogger();
      const dlHandler = new DeadLetterHandler(repo, logger);
      const proc = new QueueProcessor(repo, mockBackoff, dlHandler, logger);

      const itemId = enqueueItem(repo, threadId, { max_attempts: 5 });
      repo.claimNext(threadId);

      const before = Date.now();
      proc.fail(itemId, 'err');
      const after = Date.now();

      expect(mockBackoff).toHaveBeenCalledOnce();
      // The retry should be approximately before + 5000
      const row = db.prepare('SELECT next_retry_at FROM queue_items WHERE id = ?').get(itemId) as {
        next_retry_at: number;
      };
      expect(row.next_retry_at).toBeGreaterThanOrEqual(before + 5000);
      expect(row.next_retry_at).toBeLessThanOrEqual(after + 5000);
    });

    it('returns QueueError for unknown item id', () => {
      const result = processor.fail(uuid(), 'err');
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('QUEUE_ERROR');
    });
  });

  // -------------------------------------------------------------------------
  // fail — dead-letter after max attempts
  // -------------------------------------------------------------------------

  describe('fail — dead-letter after max attempts', () => {
    it('moves item to dead_letter when attempts reach max_attempts', () => {
      const itemId = enqueueItem(repo, threadId, { max_attempts: 1 });
      repo.claimNext(threadId);

      const result = processor.fail(itemId, 'fatal error');
      expect(result.isOk()).toBe(true);

      const row = db.prepare('SELECT status, error FROM queue_items WHERE id = ?').get(
        itemId,
      ) as {
        status: string;
        error: string;
      };
      expect(row.status).toBe('dead_letter');
      expect(row.error).toBe('fatal error');
    });

    it('dead-letters after exactly max_attempts failures via processNext', async () => {
      const itemId = enqueueItem(repo, threadId, { max_attempts: 2 });
      let callCount = 0;

      const failHandler = async (_item: QueueItem) => {
        callCount++;
        return err<void, Error>(new Error('always fails'));
      };

      // First attempt: fails → retry scheduled
      await processor.processNext(failHandler);

      // Force next_retry_at to the past so it's eligible again
      db.prepare('UPDATE queue_items SET next_retry_at = 0 WHERE id = ?').run(itemId);

      // Second attempt: fails → dead-lettered (2 attempts = max)
      await processor.processNext(failHandler);

      expect(callCount).toBe(2);

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(itemId) as {
        status: string;
      };
      expect(row.status).toBe('dead_letter');
    });
  });

  // -------------------------------------------------------------------------
  // handler errors are propagated to fail()
  // -------------------------------------------------------------------------

  describe('handler errors are propagated', () => {
    it('calls fail() when handler returns Err', async () => {
      const itemId = enqueueItem(repo, threadId, { max_attempts: 3 });
      await processor.processNext(async () => err(new Error('handler error')));

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(itemId) as {
        status: string;
      };
      expect(row.status).toBe('failed');
    });

    it('calls fail() when handler throws', async () => {
      const itemId = enqueueItem(repo, threadId, { max_attempts: 3 });
      await processor.processNext(async () => {
        throw new Error('unexpected throw');
      });

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(itemId) as {
        status: string;
      };
      expect(row.status).toBe('failed');
    });
  });

  describe('saved Signal dispatch boundary', () => {
    const account = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    function saved(
      id = enqueueItem(repo, threadId),
      createdAt = Date.now(),
    ): SignalDeliveryCheckpoint {
      return repo
        .saveSignalCheckpoint(
          {
            version: 1,
            queueItemId: id,
            deliveryId: `delivery-${id}`,
            kind: 'reply',
            personaId: 'persona',
            threadId,
            channelName: 'signal-test',
            accountUuid: account,
            destination: `signal:v1:${account}:self`,
            body: 'first second',
            chunks: ['first', 'second'],
            nextChunk: 0,
            phase: 'ready',
            currentChunkAcceptance: 'unwritten',
            acceptedChunks: 0,
            successCount: 0,
            failureCount: 0,
            createdAt,
            expiresAt: createdAt + SIGNAL_CHECKPOINT_LIFETIME_MS,
          },
          Date.now(),
        )
        ._unsafeUnwrap();
    }

    function deferred(
      checkpoint: SignalDeliveryCheckpoint,
      notBefore?: number,
    ): DeliveryDeferredError {
      return new DeliveryDeferredError(
        new SignalDeliveryError({
          reason: 'ACCOUNT_BUSY',
          outcome: 'NOT_SENT',
          acceptedChunks: 0,
          currentChunkAcceptance: 'unwritten',
          successCount: 0,
          failureCount: 0,
          retryScope: 'delivery_only',
          notBefore,
        }),
        checkpoint.expiresAt,
      );
    }

    function delivered(checkpoint: SignalDeliveryCheckpoint): SignalDeliveryCheckpoint {
      const accounts = new SignalAccountStateRepository(db);
      let current = checkpoint;
      for (let index = 0; index < checkpoint.chunks.length; index++) {
        const now = Date.now() - (checkpoint.chunks.length - index) * 1000;
        const accountState = accounts.getOrCreate(account, now)._unsafeUnwrap();
        const ownership = repo
          .beginSignalChunk(current, accountState.revision, now)
          ._unsafeUnwrap();
        current = repo
          .settleSignalChunk(ownership, { kind: 'accepted', successCount: 1 }, now)
          ._unsafeUnwrap();
      }
      return current;
    }

    it('does not reclaim a wall-future saved deferral after the repository ordering clock advances then rewinds', async () => {
      vi.useFakeTimers();
      try {
        const now = Date.now();
        const checkpoint = saved();
        vi.setSystemTime(now + 120_000);
        repo.findPending()._unsafeUnwrap();
        vi.setSystemTime(now);
        const ordinary = vi.fn(async () => ok(undefined));
        await processor.processNext(ordinary);
        expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toMatchObject({
          status: 'failed',
          attempts: 0,
        });
        expect(
          repo.findById(checkpoint.queueItemId)._unsafeUnwrap()?.next_retry_at,
        ).toBeGreaterThan(now);
        expect(await processor.processNext(ordinary)).toBeNull();
        expect(ordinary).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([false, true])(
      'keeps wall-future saved work out of atomic selection with collaboration bypass=%s',
      async (bypass) => {
        vi.useFakeTimers();
        try {
          const now = Date.now();
          const inflight = bypass ? enqueueItem(repo, threadId) : undefined;
          if (inflight !== undefined) repo.claimNext(threadId)._unsafeUnwrap();
          const futureId = enqueueItem(repo, threadId, { type: 'collaboration' });
          const checkpoint = saved(futureId);
          const regular = enqueueItem(repo, threadId);
          const collaboration = bypass
            ? enqueueItem(repo, threadId, { type: 'collaboration' })
            : undefined;
          for (const [index, id] of [inflight, futureId, regular, collaboration].entries()) {
            if (id !== undefined)
              db.prepare('UPDATE queue_items SET created_at = ? WHERE id = ?').run(now + index, id);
          }
          const deadline = repo.deferSignalDelivery(checkpoint, 60_000, now)._unsafeUnwrap();
          vi.setSystemTime(now + 120_000);
          repo.findPending()._unsafeUnwrap();
          vi.setSystemTime(now);
          const atomic = vi.spyOn(repo, bypass ? 'claimNextCollaboration' : 'claimNext');
          const ordinary = vi.fn(async (_item: QueueItem) => ok(undefined));
          const actor = vi.fn(async () => ok(undefined));
          const selected = await processor.processNext(ordinary, actor);
          const expectedId = collaboration ?? regular;
          expect(selected?.id).toBe(expectedId);
          expect(atomic).toHaveBeenCalledOnce();
          expect(atomic.mock.results[0]?.value._unsafeUnwrap()?.id).toBe(expectedId);
          expect(ordinary).toHaveBeenCalledOnce();
          expect(ordinary.mock.calls[0]?.[0].id).toBe(expectedId);
          expect(actor).not.toHaveBeenCalled();
          expect(repo.findById(futureId)._unsafeUnwrap()).toMatchObject({
            status: 'failed',
            next_retry_at: deadline,
            attempts: 0,
          });
          if (inflight !== undefined)
            expect(repo.findById(inflight)._unsafeUnwrap()?.status).toBe('claimed');
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it('passes the canonical latest checkpoint rather than the claim payload snapshot', async () => {
      const checkpoint = saved();
      const accounts = new SignalAccountStateRepository(db);
      const claim = repo.claimNext.bind(repo);
      const transitions: ReturnType<QueueRepository['settleSignalChunk']>[] = [];
      const intercept = vi.spyOn(repo, 'claimNext').mockImplementation((id) => {
        const claimed = claim(id);
        if (claimed.isOk() && claimed.value?.id === checkpoint.queueItemId) {
          const state = accounts.getOrCreate(account, Date.now())._unsafeUnwrap();
          const ownership = repo
            .beginSignalChunk(checkpoint, state.revision, Date.now())
            ._unsafeUnwrap();
          transitions.push(
            repo.settleSignalChunk(ownership, { kind: 'accepted', successCount: 1 }, Date.now()),
          );
        }
        return claimed;
      });
      const ordinary = vi.fn(async () => ok(undefined));
      const actor = vi.fn(async (_item: QueueItem, latest: SignalDeliveryCheckpoint) =>
        err(
          new DeliveryDeferredError(
            new SignalDeliveryError({
              reason: 'ACCOUNT_BUSY',
              outcome: 'PARTIAL',
              acceptedChunks: latest.acceptedChunks,
              currentChunkAcceptance: 'unwritten',
              successCount: latest.successCount,
              failureCount: 0,
              retryScope: 'delivery_only',
            }),
            latest.expiresAt,
          ),
        ),
      );
      await processor.processNext(ordinary, actor);
      intercept.mockRestore();
      expect(transitions).toHaveLength(1);
      const latest = transitions[0]?._unsafeUnwrap();
      expect(latest).toMatchObject({
        phase: 'ready',
        nextChunk: 1,
        acceptedChunks: 1,
        successCount: 1,
      });
      expect(actor).toHaveBeenCalledOnce();
      expect(actor.mock.calls[0]?.[0].payload[SIGNAL_DELIVERY_CHECKPOINT_KEY]).toEqual(checkpoint);
      expect(actor.mock.calls[0]?.[1]).toEqual(latest);
      const outcome = await actor.mock.results[0]?.value;
      expect(outcome?.isErr()).toBe(true);
      expect(outcome?._unsafeUnwrapErr()).toBeInstanceOf(DeliveryDeferredError);
      expect(
        repo.inspectSignalDelivery(checkpoint.queueItemId, Date.now())._unsafeUnwrap(),
      ).toEqual({ kind: 'checkpoint', checkpoint: latest });
      expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toMatchObject({
        status: 'failed',
        attempts: 0,
      });
      expect(ordinary).not.toHaveBeenCalled();
    });

    it('refuses direct completion of saved state and preserves terminal queue decisions', () => {
      const checkpoint = saved();
      expect(processor.complete(checkpoint.queueItemId).isErr()).toBe(true);
      expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()?.status).toBe('pending');
      repo.markDeadLetter(checkpoint.queueItemId, 'operator decision')._unsafeUnwrap();
      expect(processor.complete(checkpoint.queueItemId).isOk()).toBe(true);
      expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toMatchObject({
        status: 'dead_letter',
        error: 'operator decision',
      });
    });

    it('refuses direct completion of a pre-existing invocation guard outside a successful live execution', () => {
      const id = enqueueItem(repo, threadId);
      repo
        .markSignalDeliveryStarted(
          {
            version: 1,
            queueItemId: id,
            deliveryId: 'explicit-operation',
            purpose: 'explicit',
            startedAt: Date.now(),
          },
          null,
          Date.now(),
        )
        ._unsafeUnwrap();
      expect(processor.complete(id).isErr()).toBe(true);
      expect(repo.findById(id)._unsafeUnwrap()).toMatchObject({ status: 'pending', attempts: 0 });
    });

    it('resumes delivered work only for local finalization after expiry, including absent callback and local Err', async () => {
      const checkpoint = delivered(
        saved(undefined, Date.now() - SIGNAL_CHECKPOINT_LIFETIME_MS + 5000),
      );
      const clock = vi.spyOn(Date, 'now').mockReturnValue(checkpoint.expiresAt + 1000);
      const ordinary = vi.fn(async () => ok(undefined));
      const messages = new MessageRepository(db);
      try {
        await processor.processNext(ordinary);
        expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toMatchObject({
          status: 'failed',
          attempts: 0,
        });
        db.prepare('UPDATE queue_items SET next_retry_at = 0 WHERE id = ?').run(
          checkpoint.queueItemId,
        );
        const localFailure = new Error('history temporarily unavailable');
        const failedFinalization = vi.fn(
          async (_item: QueueItem, latest: SignalDeliveryCheckpoint) =>
            repo.finalizeSignalDelivery(latest, () => err(localFailure), Date.now()),
        );
        await processor.processNext(ordinary, failedFinalization);
        expect(failedFinalization).toHaveBeenCalledOnce();
        expect(failedFinalization.mock.calls[0]?.[1]).toEqual(checkpoint);
        const failed = await failedFinalization.mock.results[0]?.value;
        expect(failed?.isErr()).toBe(true);
        expect(failed?._unsafeUnwrapErr()).toBe(localFailure);
        expect(messages.findByThread(threadId, 10, 0)._unsafeUnwrap()).toEqual([]);
        expect(
          repo.findById(checkpoint.queueItemId)._unsafeUnwrap()?.next_retry_at,
        ).toBeGreaterThan(Date.now());
        db.prepare('UPDATE queue_items SET next_retry_at = 0 WHERE id = ?').run(
          checkpoint.queueItemId,
        );
        const finalize = vi.fn((latest: SignalDeliveryCheckpoint) =>
          messages
            .insert({
              id: uuid(),
              thread_id: latest.threadId,
              direction: 'outbound',
              content: latest.body,
              idempotency_key: `queue-test:${latest.deliveryId}`,
              provider_id: null,
              run_id: null,
            })
            .map(() => undefined),
        );
        const actor = vi.fn(async (_item: QueueItem, latest: SignalDeliveryCheckpoint) =>
          repo.finalizeSignalDelivery(latest, finalize, Date.now()),
        );
        await processor.processNext(ordinary, actor);
        expect(actor).toHaveBeenCalledOnce();
        expect(actor.mock.calls[0]?.[1]).toEqual(checkpoint);
        const finalized = await actor.mock.results[0]?.value;
        expect(finalized?.isOk()).toBe(true);
        expect(finalize).toHaveBeenCalledOnce();
        expect(finalize).toHaveBeenCalledWith(checkpoint);
        expect(finalize.mock.results[0]?.value.isOk()).toBe(true);
        expect(messages.findByThread(threadId, 10, 0)._unsafeUnwrap()).toEqual([
          expect.objectContaining({
            direction: 'outbound',
            content: checkpoint.body,
            run_id: null,
          }),
        ]);
        expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toMatchObject({
          status: 'completed',
          attempts: 0,
        });
        expect(await processor.processNext(ordinary, actor)).toBeNull();
        expect(actor).toHaveBeenCalledOnce();
        expect(ordinary).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    });

    it('never dispatches or hot-reclaims interrupted in_flight or terminal checkpoints; other threads progress', async () => {
      const checkpoint = saved();
      const accounts = new SignalAccountStateRepository(db);
      const initial = accounts.getOrCreate(account, Date.now())._unsafeUnwrap();
      repo.beginSignalChunk(checkpoint, initial.revision, Date.now())._unsafeUnwrap();
      const ordinary = vi.fn(async () => ok(undefined));
      const delivery = vi.fn(async () => ok(undefined));
      await processor.processNext(ordinary, delivery);
      expect(await processor.processNext(ordinary, delivery)).toBeNull();
      expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toMatchObject({
        status: 'claimed',
        attempts: 0,
      });
      expect(delivery).not.toHaveBeenCalled();
      expect(ordinary).not.toHaveBeenCalled();
      const other = enqueueItem(repo, seedThread(db));
      expect((await processor.processNext(ordinary, delivery))?.id).toBe(other);
      repo.recoverSignalQueue(Date.now())._unsafeUnwrap();
      expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()?.status).toBe('dead_letter');
      // Even a stale external claim reset cannot authorize a terminal checkpoint callback.
      db.prepare("UPDATE queue_items SET status = 'pending' WHERE id = ?").run(
        checkpoint.queueItemId,
      );
      await processor.processNext(ordinary, delivery);
      expect(await processor.processNext(ordinary, delivery)).toBeNull();
      expect(delivery).not.toHaveBeenCalled();
    });

    it('re-inspects after ordinary handler saves a checkpoint and throws a generic wrapper instead of replaying provider', async () => {
      const id = enqueueItem(repo, threadId);
      const ordinary = vi.fn(async (item: QueueItem) => {
        saved(item.id);
        throw new Error('later wrapper lost its delivery error');
      });
      await processor.processNext(ordinary);
      expect(repo.findById(id)._unsafeUnwrap()).toMatchObject({ status: 'failed', attempts: 0 });
      db.prepare('UPDATE queue_items SET next_retry_at = 0 WHERE id = ?').run(id);
      await processor.processNext(ordinary);
      expect(ordinary).toHaveBeenCalledOnce();
    });

    it.each([
      new SignalStateError('DATABASE'),
      new SignalStateError('CONFLICT'),
      new SignalCheckpointError('INVALID'),
    ])(
      'blocks leaked Signal state error %s without provider retries or hot polling (pre-checkpoint crash boundary remains)',
      async (failure) => {
        const id = enqueueItem(repo, threadId);
        const ordinary = vi.fn(async () => err(failure));
        await processor.processNext(ordinary);
        expect(repo.findById(id)._unsafeUnwrap()).toMatchObject({ status: 'claimed', attempts: 0 });
        expect(await processor.processNext(ordinary)).toBeNull();
        expect(ordinary).toHaveBeenCalledOnce();
      },
    );

    it('retries a real failed defer transaction with capped backoff without repeating the callback', async () => {
      vi.useFakeTimers();
      try {
        const checkpoint = saved();
        db.exec(
          "CREATE TRIGGER fail_defer BEFORE UPDATE ON queue_items WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'private sqlite diagnostic'); END",
        );
        const ordinary = vi.fn(async () => ok(undefined));
        const actor = vi.fn(async () => err(deferred(checkpoint)));
        const logger = createTestLogger();
        const proc = new QueueProcessor(
          repo,
          () => 900_000,
          new DeadLetterHandler(repo, logger),
          logger,
        );
        let finished = false;
        const pending = proc.processNext(ordinary, actor).then(() => {
          finished = true;
        });
        await vi.advanceTimersByTimeAsync(59_999);
        expect(finished).toBe(false);
        expect(actor).toHaveBeenCalledOnce();
        db.exec('DROP TRIGGER fail_defer');
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toMatchObject({
          status: 'failed',
          attempts: 0,
        });
        expect(actor).toHaveBeenCalledOnce();
        expect(ordinary).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('retries a failed dead-letter state write through queue wrappers without rerunning the handler', async () => {
      vi.useFakeTimers();
      try {
        const id = enqueueItem(repo, threadId, { max_attempts: 1 });
        db.exec(
          "CREATE TRIGGER fail_dead_letter BEFORE UPDATE ON queue_items WHEN NEW.status = 'dead_letter' BEGIN SELECT RAISE(ABORT, 'private sqlite diagnostic'); END",
        );
        const handler = vi.fn(async () => err(new Error('ordinary failure')));
        let finished = false;
        const processing = processor.processNext(handler).then(() => {
          finished = true;
        });
        await vi.advanceTimersByTimeAsync(999);
        expect(finished).toBe(false);
        expect(handler).toHaveBeenCalledOnce();
        expect(repo.findById(id)._unsafeUnwrap()?.status).toBe('claimed');
        db.exec('DROP TRIGGER fail_dead_letter');
        await vi.advanceTimersByTimeAsync(1000);
        await processing;
        expect(repo.findById(id)._unsafeUnwrap()).toMatchObject({
          status: 'dead_letter',
          error: 'ordinary failure',
        });
        expect(handler).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not turn an unsafe wrapped delivery failure into another ready attempt', async () => {
      const checkpoint = saved();
      const failure = new DeliveryDeferredError(
        new SignalDeliveryError({
          reason: 'UNKNOWN_ACCEPTANCE',
          outcome: 'UNKNOWN',
          acceptedChunks: 0,
          currentChunkAcceptance: 'unknown',
          successCount: 0,
          failureCount: 0,
          retryScope: 'none',
        }),
        checkpoint.expiresAt,
      );
      const actor = vi.fn(async () => err(failure));
      const ordinary = vi.fn(async () => ok(undefined));
      await processor.processNext(ordinary, actor);
      expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toMatchObject({
        status: 'claimed',
        attempts: 0,
        next_retry_at: null,
      });
      expect(await processor.processNext(ordinary, actor)).toBeNull();
      expect(actor).toHaveBeenCalledOnce();
      expect(ordinary).not.toHaveBeenCalled();
    });

    it('terminalizes a proven-unwritten permanent saved failure without generic attempts or callback replay', async () => {
      const checkpoint = saved();
      const failure = new NonRetryableRunError(
        new SignalDeliveryError({
          reason: 'TARGET_REFUSED',
          outcome: 'NOT_SENT',
          acceptedChunks: 0,
          currentChunkAcceptance: 'unwritten',
          successCount: 0,
          failureCount: 0,
          retryScope: 'none',
        }),
      );
      const actor = vi.fn(async () => {
        throw failure;
      });
      await processor.processNext(async () => ok(undefined), actor);
      expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toMatchObject({
        status: 'dead_letter',
        error: 'TARGET_REFUSED',
        attempts: 0,
      });
      expect(actor).toHaveBeenCalledOnce();
    });

    it.each(['reply', 'background'] as const)(
      'rejects a %s guard without checkpoint even when ordinary handler returns Ok',
      async (purpose) => {
        const id = enqueueItem(repo, threadId);
        const mark = vi.spyOn(repo, 'markSignalDeliveryStarted');
        const handler = vi.fn(async () => {
          repo
            .markSignalDeliveryStarted(
              {
                version: 1,
                queueItemId: id,
                deliveryId: 'd',
                purpose,
                startedAt: Date.now(),
              },
              null,
              Date.now(),
            )
            ._unsafeUnwrap();
          return ok(undefined);
        });
        await processor.processNext(handler);
        expect(handler).toHaveBeenCalledOnce();
        expect((await handler.mock.results[0]?.value)?.isOk()).toBe(true);
        expect(mark).toHaveBeenCalledOnce();
        expect(mark.mock.results[0]?.value.isOk()).toBe(true);
        expect(repo.findById(id)._unsafeUnwrap()).toMatchObject({
          status: 'dead_letter',
          attempts: 0,
        });
      },
    );

    it('retains returned DeliveryCancelled identity and stops before a generic retry', async () => {
      const checkpoint = saved();
      const failure = new DeliveryCancelled();
      const fail = vi.spyOn(processor, 'fail');
      await processor.processNext(
        async () => ok(undefined),
        async () => {
          repo.purge(['claimed'])._unsafeUnwrap();
          return err(failure);
        },
      );
      expect(fail).toHaveBeenCalledWith(checkpoint.queueItemId, failure, true);
      expect(fail.mock.results[0]?.value._unsafeUnwrapErr()).toBe(failure);
      expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toBeNull();
    });
    it('defers a saved checkpoint without an installed actor and never invokes the ordinary handler', async () => {
      const checkpoint = saved();
      const ordinary = vi.fn(async () => ok(undefined));
      await processor.processNext(ordinary);
      expect(ordinary).not.toHaveBeenCalled();
      expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toMatchObject({
        status: 'failed',
        attempts: 0,
        max_attempts: 3,
        claimed_at: null,
      });
    });

    it('routes more than three thrown/returned deferrals only to saved delivery and retains typed identity', async () => {
      const checkpoint = saved();
      const ordinary = vi.fn(async () => ok(undefined));
      const failure = deferred(checkpoint);
      const fail = vi.spyOn(processor, 'fail');
      for (let attempt = 0; attempt < 6; attempt++) {
        db.prepare('UPDATE queue_items SET next_retry_at = 0 WHERE id = ?').run(
          checkpoint.queueItemId,
        );
        const actor = vi.fn(async (_item: QueueItem, _latest: SignalDeliveryCheckpoint) => {
          if (attempt % 2 === 0) throw failure;
          return err(failure);
        });
        await processor.processNext(ordinary, actor);
        expect(actor).toHaveBeenCalledOnce();
        expect(actor.mock.calls[0]?.[0].id).toBe(checkpoint.queueItemId);
        expect(actor.mock.calls[0]?.[1]).toEqual(checkpoint);
        if (attempt % 2 === 0) {
          await expect(actor.mock.results[0]?.value).rejects.toBe(failure);
        } else {
          const outcome = await actor.mock.results[0]?.value;
          expect(outcome?.isErr()).toBe(true);
          expect(outcome?._unsafeUnwrapErr()).toBe(failure);
        }
        expect(fail.mock.calls[attempt]).toEqual([checkpoint.queueItemId, failure, true]);
        expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toMatchObject({
          status: 'failed',
          attempts: 0,
          max_attempts: 3,
          claimed_at: null,
        });
      }
      expect(ordinary).not.toHaveBeenCalled();
      expect(fail).toHaveBeenCalledTimes(6);
    });

    it('does not complete ready work on actor Ok or replay the provider on an untyped actor failure', async () => {
      const checkpoint = saved();
      const ordinary = vi.fn(async () => ok(undefined));
      const successfulActor = vi.fn(async () => ok(undefined));
      await processor.processNext(ordinary, successfulActor);
      expect(successfulActor).toHaveBeenCalledOnce();
      expect((await successfulActor.mock.results[0]?.value)?.isOk()).toBe(true);
      expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()?.status).toBe('failed');
      db.prepare('UPDATE queue_items SET next_retry_at = 0 WHERE id = ?').run(
        checkpoint.queueItemId,
      );
      const failure = new Error('local write failure');
      const failedActor = vi.fn(async () => {
        throw failure;
      });
      await processor.processNext(ordinary, failedActor);
      expect(failedActor).toHaveBeenCalledOnce();
      await expect(failedActor.mock.results[0]?.value).rejects.toBe(failure);
      expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toMatchObject({
        status: 'failed',
        attempts: 0,
      });
      expect(ordinary).not.toHaveBeenCalled();
    });

    it('caps ready retry at the fixed expiry even for a later account hint, then expires without callback', async () => {
      const checkpoint = saved(undefined, Date.now() - SIGNAL_CHECKPOINT_LIFETIME_MS + 500);
      const ordinary = vi.fn(async () => ok(undefined));
      await processor.processNext(ordinary, async () =>
        err(deferred(checkpoint, Date.now() + 900_000)),
      );
      expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()?.next_retry_at).toBe(
        checkpoint.expiresAt,
      );
      const clock = vi.spyOn(Date, 'now').mockReturnValue(checkpoint.expiresAt);
      try {
        const delivery = vi.fn(async () => ok(undefined));
        await processor.processNext(ordinary, delivery);
        expect(delivery).not.toHaveBeenCalled();
        expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toMatchObject({
          status: 'dead_letter',
          error: 'CHECKPOINT_EXPIRED',
          attempts: 0,
        });
      } finally {
        clock.mockRestore();
      }
      expect(ordinary).not.toHaveBeenCalled();
    });

    it.each([
      [0, 1000],
      [900_000, 60_000],
    ])(
      'keeps the later account hint and clamps independent delivery backoff %s to %s',
      async (requested, bounded) => {
        const checkpoint = saved();
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        try {
          const logger = createTestLogger();
          const proc = new QueueProcessor(
            repo,
            () => requested,
            new DeadLetterHandler(repo, logger),
            logger,
          );
          await proc.processNext(
            async () => ok(undefined),
            async () => err(deferred(checkpoint)),
          );
          expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()?.next_retry_at).toBe(
            now + bounded,
          );
          db.prepare('UPDATE queue_items SET next_retry_at = 0 WHERE id = ?').run(
            checkpoint.queueItemId,
          );
          await proc.processNext(
            async () => ok(undefined),
            async () => err(deferred(checkpoint, now + 900_000)),
          );
          expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()?.next_retry_at).toBe(
            now + 900_000,
          );
        } finally {
          clock.mockRestore();
        }
      },
    );

    it.each([
      [SIGNAL_DELIVERY_CHECKPOINT_KEY, null],
      [SIGNAL_DELIVERY_STARTED_KEY, null],
      [
        SIGNAL_DELIVERY_STARTED_KEY,
        { version: 1, queueItemId: 'foreign', deliveryId: 'd', purpose: 'explicit', startedAt: 1 },
      ],
    ])('rejects invalid root reserved state %s before either callback', async (key, value) => {
      const id = enqueueItem(repo, threadId, { payload: JSON.stringify({ [key]: value }) });
      const ordinary = vi.fn(async () => ok(undefined));
      const delivery = vi.fn(async () => ok(undefined));
      await processor.processNext(ordinary, delivery);
      expect(ordinary).not.toHaveBeenCalled();
      expect(delivery).not.toHaveBeenCalled();
      expect(repo.findById(id)._unsafeUnwrap()).toMatchObject({
        status: 'dead_letter',
        error: 'CHECKPOINT_INVALID',
        attempts: 0,
      });
    });

    it('rejects malformed reserved bytes before the mapper can hide them', async () => {
      const id = enqueueItem(repo, threadId, { payload: '{"__talond_signal_delivery_v1":' });
      const ordinary = vi.fn(async () => ok(undefined));
      await processor.processNext(ordinary);
      expect(ordinary).not.toHaveBeenCalled();
      expect(repo.findById(id)._unsafeUnwrap()?.status).toBe('dead_letter');
    });

    it.each(['explicit', 'progress'] as const)(
      'rejects pre-existing %s invocation and failed execution, but permits successful live completion',
      async (purpose) => {
        const ordinary = vi.fn(async () => ok(undefined));
        const mark = (id: string) =>
          repo
            .markSignalDeliveryStarted(
              {
                version: 1,
                queueItemId: id,
                deliveryId: `op-${id}`,
                purpose,
                startedAt: Date.now(),
              },
              null,
              Date.now(),
            )
            ._unsafeUnwrap();
        const guarded = enqueueItem(repo, threadId);
        mark(guarded);
        await processor.processNext(ordinary);
        expect(ordinary).not.toHaveBeenCalled();
        expect(repo.findById(guarded)._unsafeUnwrap()).toMatchObject({
          status: 'dead_letter',
          error: 'UNKNOWN_ACCEPTANCE',
        });
        const failed = enqueueItem(repo, threadId);
        const failedMarker = vi.fn(mark);
        const failedHandler = vi.fn(async (item: QueueItem) => {
          failedMarker(item.id);
          return err(new Error('provider failed'));
        });
        await processor.processNext(failedHandler);
        expect(failedHandler).toHaveBeenCalledOnce();
        expect(failedMarker).toHaveBeenCalledWith(failed);
        expect(failedMarker.mock.results[0]?.type).toBe('return');
        expect(failedMarker.mock.results[0]?.value.queueItemId).toBe(failed);
        expect((await failedHandler.mock.results[0]?.value)?.isErr()).toBe(true);
        expect(repo.findById(failed)._unsafeUnwrap()).toMatchObject({
          status: 'dead_letter',
          attempts: 0,
        });
        const succeeded = enqueueItem(repo, threadId);
        const successfulMarker = vi.fn(mark);
        const successfulHandler = vi.fn(async (item: QueueItem) => {
          successfulMarker(item.id);
          return ok(undefined);
        });
        await processor.processNext(successfulHandler);
        expect(successfulHandler).toHaveBeenCalledOnce();
        expect(successfulMarker).toHaveBeenCalledWith(succeeded);
        expect(successfulMarker.mock.results[0]?.type).toBe('return');
        expect(successfulMarker.mock.results[0]?.value.queueItemId).toBe(succeeded);
        expect((await successfulHandler.mock.results[0]?.value)?.isOk()).toBe(true);
        expect(repo.findById(succeeded)._unsafeUnwrap()?.status).toBe('completed');
      },
    );

    it.each(['throw', 'return'] as const)(
      'immediately dead-letters NonRetryableRunError via %s without consuming provider attempts',
      async (mode) => {
        const id = enqueueItem(repo, threadId);
        const failure = new NonRetryableRunError();
        const fail = vi.spyOn(processor, 'fail');
        await processor.processNext(async () => {
          if (mode === 'throw') throw failure;
          return err(failure);
        });
        expect(fail).toHaveBeenCalledWith(id, failure);
        expect(repo.findById(id)._unsafeUnwrap()).toMatchObject({
          status: 'dead_letter',
          attempts: 0,
        });
      },
    );

    it('retains cancellation identity and never retries or recreates purged active work', async () => {
      const checkpoint = saved();
      const failure = new DeliveryCancelled();
      const fail = vi.spyOn(processor, 'fail');
      await processor.processNext(
        async () => ok(undefined),
        async () => {
          repo.purge(['claimed'])._unsafeUnwrap();
          throw failure;
        },
      );
      expect(fail).toHaveBeenCalledWith(checkpoint.queueItemId, failure, true);
      expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toBeNull();
      const delivery = vi.fn(async () => ok(undefined));
      expect(await processor.processNext(async () => ok(undefined), delivery)).toBeNull();
      expect(delivery).not.toHaveBeenCalled();
    });

    it('never revives active purged work or dispatches its saved tail after late callback Ok', async () => {
      const checkpoint = saved();
      const messages = new MessageRepository(db);
      const settlements: ReturnType<QueueRepository['settleSignalChunk']>[] = [];
      const purges: ReturnType<QueueRepository['purge']>[] = [];
      const actor = vi.fn(async (_item: QueueItem, latest: SignalDeliveryCheckpoint) => {
        const accounts = new SignalAccountStateRepository(db);
        const state = accounts.getOrCreate(account, Date.now())._unsafeUnwrap();
        const ownership = repo.beginSignalChunk(latest, state.revision, Date.now())._unsafeUnwrap();
        purges.push(
          repo.purge(['pending', 'claimed', 'processing', 'completed', 'failed', 'dead_letter']),
        );
        settlements.push(
          repo.settleSignalChunk(ownership, { kind: 'accepted', successCount: 1 }, Date.now()),
        );
        return ok(undefined);
      });
      const ordinary = vi.fn(async () => ok(undefined));
      await processor.processNext(ordinary, actor);
      expect(actor).toHaveBeenCalledOnce();
      expect(actor.mock.calls[0]?.[0].id).toBe(checkpoint.queueItemId);
      expect(actor.mock.calls[0]?.[1]).toEqual(checkpoint);
      expect((await actor.mock.results[0]?.value)?.isOk()).toBe(true);
      expect(purges).toHaveLength(1);
      expect(purges[0]?._unsafeUnwrap()).toBe(1);
      expect(settlements).toHaveLength(1);
      expect(settlements[0]?._unsafeUnwrapErr()).toBeInstanceOf(DeliveryCancelled);
      expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toBeNull();
      expect(messages.findByThread(threadId, 10, 0)._unsafeUnwrap()).toEqual([]);
      expect(
        new SignalAccountStateRepository(db).findByAccount(account)._unsafeUnwrap()?.reservation,
      ).toBeNull();
      expect(await processor.processNext(ordinary, actor)).toBeNull();
      expect(actor).toHaveBeenCalledOnce();
      expect(ordinary).not.toHaveBeenCalled();
    });

    it('refuses real delivered local finalization after purge without inserting outbound history', async () => {
      const checkpoint = delivered(saved(undefined, Date.now() - 5000));
      const messages = new MessageRepository(db);
      const local = vi.fn((latest: SignalDeliveryCheckpoint) =>
        messages
          .insert({
            id: uuid(),
            thread_id: latest.threadId,
            direction: 'outbound',
            content: latest.body,
            idempotency_key: `queue-test:${latest.deliveryId}`,
            provider_id: null,
            run_id: null,
          })
          .map(() => undefined),
      );
      const purges: ReturnType<QueueRepository['purge']>[] = [];
      const actor = vi.fn(async (_item: QueueItem, latest: SignalDeliveryCheckpoint) => {
        purges.push(repo.purge(['claimed']));
        return repo.finalizeSignalDelivery(latest, local, Date.now());
      });
      const ordinary = vi.fn(async () => ok(undefined));
      await processor.processNext(ordinary, actor);
      expect(actor).toHaveBeenCalledOnce();
      expect(actor.mock.calls[0]?.[1]).toEqual(checkpoint);
      const result = await actor.mock.results[0]?.value;
      expect(result?.isErr()).toBe(true);
      expect(result?._unsafeUnwrapErr()).toBeInstanceOf(DeliveryCancelled);
      expect(purges).toHaveLength(1);
      expect(purges[0]?._unsafeUnwrap()).toBe(1);
      expect(local).not.toHaveBeenCalled();
      expect(messages.findByThread(threadId, 10, 0)._unsafeUnwrap()).toEqual([]);
      expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toBeNull();
      expect(await processor.processNext(ordinary, actor)).toBeNull();
      expect(actor).toHaveBeenCalledOnce();
      expect(ordinary).not.toHaveBeenCalled();
    });

    it('blocks an older deferred ordinary reply but preserves collaboration bypass and its destination lease', async () => {
      const checkpoint = saved();
      const leases = new SignalDestinationLeaseRepository(db);
      const lease = leases
        .acquire(
          account,
          checkpoint.destination,
          {
            queueItemId: checkpoint.queueItemId,
            deliveryId: checkpoint.deliveryId,
            purpose: 'reply',
          },
          Date.now(),
        )
        ._unsafeUnwrap();
      const ordinary = vi.fn(async () => ok(undefined));
      await processor.processNext(ordinary);
      expect(repo.findById(checkpoint.queueItemId)._unsafeUnwrap()).toMatchObject({
        status: 'failed',
        attempts: 0,
      });
      const later = enqueueItem(repo, threadId);
      db.prepare('UPDATE queue_items SET created_at = created_at + 100 WHERE id = ?').run(later);
      const collaboration = enqueueItem(repo, threadId, { type: 'collaboration' });
      db.prepare('UPDATE queue_items SET created_at = created_at + 200 WHERE id = ?').run(
        collaboration,
      );
      expect((await processor.processNext(ordinary))?.id).toBe(collaboration);
      expect(await processor.processNext(ordinary)).toBeNull();
      expect(repo.findById(later)._unsafeUnwrap()?.status).toBe('pending');
      expect(leases.find(account, checkpoint.destination)._unsafeUnwrap()).toEqual(lease);
    });
  });
});
