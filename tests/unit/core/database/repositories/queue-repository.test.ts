import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok } from 'neverthrow';
import {
  SignalAccountStateRepository,
  SignalStateError,
} from '../../../../../src/core/database/repositories/signal-account-state-repository.js';
import { SignalDestinationLeaseRepository } from '../../../../../src/core/database/repositories/signal-destination-lease-repository.js';
import {
  DeliveryCancelled,
  SignalDeliveryError,
  SIGNAL_DELIVERY_REASONS,
} from '../../../../../src/core/errors/error-types.js';
import { runResultTransaction } from '../../../../../src/core/database/transaction.js';
import {
  QueueRepository,
  type QueueStatus,
} from '../../../../../src/core/database/repositories/queue-repository.js';
import { BaseRepository } from '../../../../../src/core/database/repositories/base-repository.js';
import { ThreadRepository } from '../../../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { createTestDb, uuid } from './helpers.js';
import * as signalDeliveryState from '../../../../../src/queue/signal-delivery-state.js';
import {
  SIGNAL_DELIVERY_CHECKPOINT_KEY,
  SIGNAL_DELIVERY_STARTED_KEY,
  SIGNAL_CHECKPOINT_LIFETIME_MS,
  SIGNAL_CHECKPOINT_MAX_BYTES,
  SignalCheckpointError,
  parseSignalDeliveryCheckpoint,
  type SignalDeliveryCheckpoint,
} from '../../../../../src/queue/signal-delivery-checkpoint.js';

describe('QueueRepository', () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let threadId: string;
  let restartDirectory: string | undefined;

  beforeEach(() => {
    db = createTestDb();
    repo = new QueueRepository(db);

    const channels = new ChannelRepository(db);
    const channelId = uuid();
    channels.insert({
      id: channelId,
      type: 'telegram',
      name: `ch-${uuid()}`,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    const threads = new ThreadRepository(db);
    threadId = uuid();
    threads.insert({
      id: threadId,
      channel_id: channelId,
      external_id: `ext-${uuid()}`,
      metadata: '{}',
    });
  });

  afterEach(() => {
    db.close();
    if (restartDirectory !== undefined) {
      rmSync(restartDirectory, { recursive: true, force: true });
      restartDirectory = undefined;
    }
  });

  function makeItem(overrides: Partial<Parameters<QueueRepository['enqueue']>[0]> = {}) {
    return {
      id: uuid(),
      thread_id: threadId,
      message_id: null,
      type: 'message' as const,
      payload: '{}',
      max_attempts: 3,
      ...overrides,
    };
  }

  function checkpoint(
    id: string,
    overrides: Partial<SignalDeliveryCheckpoint> = {},
  ): SignalDeliveryCheckpoint {
    const now = Date.now();
    return {
      version: 1,
      queueItemId: id,
      deliveryId: `delivery-${id}`,
      kind: 'reply',
      personaId: 'persona',
      threadId,
      channelName: 'signal-test',
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
      createdAt: now,
      expiresAt: now + SIGNAL_CHECKPOINT_LIFETIME_MS,
      ...overrides,
    };
  }

  describe('Signal retry wall-clock eligibility', () => {
    beforeEach(() => {
      BaseRepository.__resetMonotonicClockForTests();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      BaseRepository.__resetMonotonicClockForTests();
    });

    function saveSingleChunk(
      type: 'message' | 'collaboration',
      phase: 'ready' | 'delivered',
    ): SignalDeliveryCheckpoint {
      const item = makeItem({ type });
      repo.enqueue(item)._unsafeUnwrap();
      const ready = repo
        .saveSignalCheckpoint(checkpoint(item.id, { chunks: ['firstsecond'] }), Date.now())
        ._unsafeUnwrap();
      if (phase === 'ready') return ready;
      const accounts = new SignalAccountStateRepository(db);
      const account = accounts.getOrCreate(ready.accountUuid, Date.now())._unsafeUnwrap();
      const ownership = repo.beginSignalChunk(ready, account.revision, Date.now())._unsafeUnwrap();
      return repo
        .settleSignalChunk(ownership, { kind: 'accepted', successCount: 1 }, Date.now())
        ._unsafeUnwrap();
    }

    function observeClaim(
      selector: () => ReturnType<QueueRepository['claimNext']>,
      expectedId: string | null,
      logicalFloor: number,
    ): void {
      const rollback = 'observation rollback';
      const result = runResultTransaction(
        (fn) => repo.transaction(fn),
        () =>
          selector().andThen((row) => {
            expect(row?.id ?? null).toBe(expectedId);
            if (row !== null) {
              expect(row.claimed_at).toBeGreaterThanOrEqual(logicalFloor);
              expect(row.updated_at).toBe(row.claimed_at);
            }
            return err(rollback);
          }),
      );
      expect(result._unsafeUnwrapErr()).toBe(rollback);
    }

    for (const phase of ['ready', 'delivered'] as const) {
      it.each(['message', 'collaboration'] as const)(
        `keeps ${phase} %s deferrals out of all selectors before the wall deadline after ordering time advances and rewinds`,
        (type) => {
          const preparedAt = Date.now();
          const clock = vi.spyOn(Date, 'now').mockReturnValue(preparedAt);
          const saved = saveSingleChunk(type, phase);
          // Delivered work retries local writes even after its original send expiry.
          const wall = phase === 'delivered' ? saved.expiresAt + 1 : preparedAt;
          clock.mockReturnValue(wall);
          const before = repo.findById(saved.queueItemId)._unsafeUnwrap()!;
          const inflated = wall + 120_000;
          clock.mockReturnValue(inflated);
          repo.findPending()._unsafeUnwrap();
          clock.mockReturnValue(wall);
          const deadline = repo.deferSignalDelivery(saved, 1_000, wall)._unsafeUnwrap();
          expect(deadline).toBe(wall + 1_000);
          for (const time of [wall, deadline - 1]) {
            clock.mockReturnValue(time);
            expect(repo.findPending()._unsafeUnwrap()).toEqual([]);
            expect(repo.claimNext(threadId)._unsafeUnwrap()).toBeNull();
            expect(repo.claimNextCollaboration(threadId)._unsafeUnwrap()).toBeNull();
          }
          // Explicit discovery time remains authoritative, independently of live wall/order clocks.
          expect(
            repo
              .findPending(deadline)
              ._unsafeUnwrap()
              .map((row) => row.id),
          ).toEqual([saved.queueItemId]);
          clock.mockReturnValue(deadline);
          expect(repo.findPending(deadline - 1)._unsafeUnwrap()).toEqual([]);
          expect(
            repo
              .findPending()
              ._unsafeUnwrap()
              .map((row) => row.id),
          ).toEqual([saved.queueItemId]);
          observeClaim(() => repo.claimNext(threadId), saved.queueItemId, inflated);
          observeClaim(
            () => repo.claimNextCollaboration(threadId),
            type === 'collaboration' ? saved.queueItemId : null,
            inflated,
          );
          expect(repo.findById(saved.queueItemId)._unsafeUnwrap()).toMatchObject({
            status: 'failed',
            attempts: 0,
            max_attempts: 3,
            next_retry_at: deadline,
            payload: before.payload,
            created_at: before.created_at,
          });
          const claimed = (
            type === 'collaboration'
              ? repo.claimNextCollaboration(threadId)
              : repo.claimNext(threadId)
          )._unsafeUnwrap()!;
          expect(claimed.id).toBe(saved.queueItemId);
          expect(claimed.claimed_at).toBeGreaterThanOrEqual(inflated);
          expect(claimed.created_at).toBe(before.created_at);
        },
      );
    }

    it.each(['message', 'collaboration'] as const)(
      'skips a future saved %s in atomic claims while collaboration and another thread progress',
      (type) => {
        const wall = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(wall);
        const saved = saveSingleChunk(type, 'ready');
        const inflated = wall + 120_000;
        clock.mockReturnValue(inflated);
        repo.findPending()._unsafeUnwrap();
        clock.mockReturnValue(wall);
        const deadline = repo.deferSignalDelivery(saved, 1_000, wall)._unsafeUnwrap();
        const later = makeItem();
        const collaboration = makeItem({ type: 'collaboration' });
        repo.enqueue(later)._unsafeUnwrap();
        repo.enqueue(collaboration)._unsafeUnwrap();
        const threads = new ThreadRepository(db);
        const otherThread = uuid();
        threads
          .insert({
            id: otherThread,
            channel_id: threads.findById(threadId)._unsafeUnwrap()!.channel_id,
            external_id: uuid(),
            metadata: '{}',
          })
          ._unsafeUnwrap();
        const other = makeItem({ thread_id: otherThread });
        repo.enqueue(other)._unsafeUnwrap();
        expect(
          repo
            .findPending()
            ._unsafeUnwrap()
            .map((row) => row.id),
        ).toEqual(
          type === 'message'
            ? [collaboration.id, other.id]
            : [later.id, collaboration.id, other.id],
        );
        observeClaim(
          () => repo.claimNext(threadId),
          type === 'message' ? collaboration.id : later.id,
          inflated,
        );
        observeClaim(() => repo.claimNextCollaboration(threadId), collaboration.id, inflated);
        observeClaim(() => repo.claimNext(otherThread), other.id, inflated);
        clock.mockReturnValue(deadline);
        observeClaim(() => repo.claimNext(threadId), saved.queueItemId, inflated);
        observeClaim(
          () => repo.claimNextCollaboration(threadId),
          type === 'collaboration' ? saved.queueItemId : collaboration.id,
          inflated,
        );
        expect(repo.findById(saved.queueItemId)._unsafeUnwrap()).toMatchObject({
          status: 'failed',
          next_retry_at: deadline,
          attempts: 0,
        });
      },
    );

    it.each(['message', 'collaboration'] as const)(
      'preserves generic %s retry eligibility against the existing logical clock',
      (type) => {
        const wall = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(wall);
        const item = makeItem({ type });
        repo.enqueue(item)._unsafeUnwrap();
        repo.fail(item.id, 'ordinary failure', wall + 1_000)._unsafeUnwrap();
        const inflated = wall + 120_000;
        clock.mockReturnValue(inflated);
        repo.findPending()._unsafeUnwrap();
        clock.mockReturnValue(wall);
        expect(repo.findPending(wall)._unsafeUnwrap()).toEqual([]);
        expect(
          repo
            .findPending()
            ._unsafeUnwrap()
            .map((row) => row.id),
        ).toEqual([item.id]);
        observeClaim(() => repo.claimNext(threadId), item.id, inflated);
        observeClaim(
          () => repo.claimNextCollaboration(threadId),
          type === 'collaboration' ? item.id : null,
          inflated,
        );
        expect(repo.findById(item.id)._unsafeUnwrap()).toMatchObject({
          attempts: 1,
          max_attempts: 3,
          status: 'failed',
        });
      },
    );
  });

  describe('Signal durable ordering and purge', () => {
    it('blocks later ordinary work behind a deferred Signal checkpoint but preserves collaboration bypass', () => {
      const first = makeItem();
      repo
        .enqueue({
          ...first,
          payload: JSON.stringify({ [SIGNAL_DELIVERY_CHECKPOINT_KEY]: checkpoint(first.id) }),
        })
        ._unsafeUnwrap();
      repo.fail(first.id, 'delivery deferred', Date.now() + 60_000)._unsafeUnwrap();
      const later = makeItem();
      const collaboration = makeItem({ type: 'collaboration' });
      repo.enqueue(later)._unsafeUnwrap();
      repo.enqueue(collaboration)._unsafeUnwrap();
      expect(
        repo
          .findPending()
          ._unsafeUnwrap()
          .map((row) => row.id),
      ).toEqual([collaboration.id]);
      expect(repo.claimNext(threadId)._unsafeUnwrap()?.id).toBe(collaboration.id);
      expect(repo.claimNext(threadId)._unsafeUnwrap()).toBeNull();
      repo.markDeadLetter(first.id, 'terminal')._unsafeUnwrap();
      expect(repo.claimNext(threadId)._unsafeUnwrap()?.id).toBe(later.id);
    });

    it('cancels only linked unfinished Signal runs before detaching selected queue rows', () => {
      db.prepare(
        "INSERT INTO personas (id, name, created_at, updated_at) VALUES ('persona', 'persona', 1, 1)",
      ).run();
      const selected = makeItem();
      const ordinary = makeItem();
      repo
        .enqueue({
          ...selected,
          payload: JSON.stringify({ [SIGNAL_DELIVERY_CHECKPOINT_KEY]: checkpoint(selected.id) }),
        })
        ._unsafeUnwrap();
      repo.enqueue(ordinary)._unsafeUnwrap();
      for (const [id, queueId, status] of [
        ['running-signal', selected.id, 'running'],
        ['pending-signal', selected.id, 'pending'],
        ['completed-signal', selected.id, 'completed'],
        ['ordinary-run', ordinary.id, 'running'],
      ]) {
        db.prepare(
          `INSERT INTO runs (id, thread_id, persona_id, provider_name, queue_item_id, status, started_at, created_at)
          VALUES (?, ?, 'persona', 'test', ?, ?, ?, ?)`,
        ).run(id, threadId, queueId, status, Date.now() + 1_000, 1);
      }
      expect(repo.purge(['pending'])._unsafeUnwrap()).toBe(2);
      const rows = db
        .prepare('SELECT id, status, queue_item_id, ended_at, error FROM runs ORDER BY id')
        .all();
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM runs WHERE status = 'cancelled' AND ended_at >= started_at",
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(rows).toEqual([
        expect.objectContaining({
          id: 'completed-signal',
          status: 'completed',
          queue_item_id: null,
          ended_at: null,
        }),
        expect.objectContaining({
          id: 'ordinary-run',
          status: 'running',
          queue_item_id: null,
          ended_at: null,
        }),
        expect.objectContaining({
          id: 'pending-signal',
          status: 'cancelled',
          queue_item_id: null,
          ended_at: expect.any(Number),
          error: 'SIGNAL_DELIVERY_OPERATOR_PURGE',
        }),
        expect.objectContaining({
          id: 'running-signal',
          status: 'cancelled',
          queue_item_id: null,
          ended_at: expect.any(Number),
          error: 'SIGNAL_DELIVERY_OPERATOR_PURGE',
        }),
      ]);
    });
  });

  describe('Signal checkpoint lifecycle serialization budget', () => {
    const maxCount = Number.MAX_SAFE_INTEGER;
    const longestReason = SIGNAL_DELIVERY_REASONS.reduce((longest, reason) =>
      reason.length > longest.length ? reason : longest,
    );

    function bytes(value: unknown): number {
      return Buffer.byteLength(JSON.stringify(value), 'utf8');
    }

    // Independent upper-envelope oracle: immutable fields stay byte-identical, while every
    // mutable string/counter reserves its longest supported representation, even if not simultaneous.
    function lifecycleBytes(saved: SignalDeliveryCheckpoint): number {
      return bytes({
        ...saved,
        nextChunk: saved.chunks.length,
        acceptedChunks: saved.chunks.length,
        successCount: maxCount,
        failureCount: maxCount,
        phase: 'in_flight',
        currentChunkAcceptance: 'unwritten',
        terminalReason: longestReason,
        terminalOutcome: 'NOT_SENT',
      });
    }

    function paddedTo(saved: SignalDeliveryCheckpoint, target: number): SignalDeliveryCheckpoint {
      const padded = { ...saved, personaId: saved.personaId + 'p'.repeat(target - bytes(saved)) };
      expect(bytes(padded)).toBe(target);
      return padded;
    }

    function atAdmissionBudget(saved: SignalDeliveryCheckpoint): SignalDeliveryCheckpoint {
      const bounded = paddedTo(
        saved,
        SIGNAL_CHECKPOINT_MAX_BYTES - (lifecycleBytes(saved) - bytes(saved)),
      );
      expect(lifecycleBytes(bounded)).toBe(SIGNAL_CHECKPOINT_MAX_BYTES);
      return bounded;
    }

    function fixture(): SignalDeliveryCheckpoint {
      const item = makeItem({ payload: '{"preserved":true}' });
      repo.enqueue(item)._unsafeUnwrap();
      return checkpoint(item.id);
    }

    function persistLegacy(saved: SignalDeliveryCheckpoint): void {
      expect(
        parseSignalDeliveryCheckpoint(saved, {
          queueItemId: saved.queueItemId,
          now: saved.createdAt,
          allowExpired: true,
        }).isOk(),
      ).toBe(true);
      db.prepare('UPDATE queue_items SET payload = ? WHERE id = ?').run(
        JSON.stringify({ [SIGNAL_DELIVERY_CHECKPOINT_KEY]: saved }),
        saved.queueItemId,
      );
    }

    function assertStored(saved: SignalDeliveryCheckpoint, now: number): void {
      expect(bytes(saved)).toBeLessThanOrEqual(SIGNAL_CHECKPOINT_MAX_BYTES);
      const inspected = repo.inspectSignalDelivery(saved.queueItemId, now)._unsafeUnwrap();
      expect(inspected.kind).toBe('checkpoint');
      if (inspected.kind === 'checkpoint') expect(inspected.checkpoint).toEqual(saved);
    }

    it.each([0, 1])(
      'rejects preparation at the absolute cap minus %i before any saved work or ownership',
      (belowCap) => {
        const saved = paddedTo(fixture(), SIGNAL_CHECKPOINT_MAX_BYTES - belowCap);
        // Decoder cap remains inclusive; repository admission is a different lifetime budget.
        expect(
          parseSignalDeliveryCheckpoint(saved, {
            queueItemId: saved.queueItemId,
            now: saved.createdAt,
          }).isOk(),
        ).toBe(true);
        const before = repo.findById(saved.queueItemId)._unsafeUnwrap();
        const rejected = repo.saveSignalCheckpoint(saved, saved.createdAt)._unsafeUnwrapErr();
        expect(rejected).toBeInstanceOf(SignalCheckpointError);
        expect(rejected).toMatchObject({ reason: 'TOO_LARGE', cause: undefined });
        expect(repo.findById(saved.queueItemId)._unsafeUnwrap()).toEqual(before);
        expect(new SignalAccountStateRepository(db).findReserved()._unsafeUnwrap()).toEqual([]);
        expect(
          new SignalDestinationLeaseRepository(db)
            .find(saved.accountUuid, saved.destination)
            ._unsafeUnwrap(),
        ).toBeNull();
      },
    );

    it.each([0, 1])(
      'refuses legacy cap-minus-%i ready state without committing payload, marker, lease, reservation or send budget',
      (belowCap) => {
        const saved = paddedTo(fixture(), SIGNAL_CHECKPOINT_MAX_BYTES - belowCap);
        persistLegacy(saved);
        const accounts = new SignalAccountStateRepository(db);
        const state = accounts.getOrCreate(saved.accountUuid, saved.createdAt)._unsafeUnwrap();
        const leases = new SignalDestinationLeaseRepository(db);
        const lease =
          belowCap === 0
            ? leases
                .acquire(
                  saved.accountUuid,
                  saved.destination,
                  {
                    queueItemId: saved.queueItemId,
                    deliveryId: saved.deliveryId,
                    purpose: saved.kind,
                  },
                  saved.createdAt,
                )
                ._unsafeUnwrap()
            : null;
        const before = repo.findById(saved.queueItemId)._unsafeUnwrap();
        expect(
          repo.beginSignalChunk(saved, state.revision, saved.createdAt)._unsafeUnwrapErr(),
        ).toMatchObject({ reason: 'TOO_LARGE' });
        expect(repo.findById(saved.queueItemId)._unsafeUnwrap()).toEqual(before);
        expect(accounts.findByAccount(saved.accountUuid)._unsafeUnwrap()).toEqual(state);
        expect(leases.find(saved.accountUuid, saved.destination)._unsafeUnwrap()).toEqual(lease);
        if (lease !== null) expect(leases.validateOwner(lease)._unsafeUnwrap()).toEqual(lease);
        assertStored(saved, saved.createdAt);
      },
    );

    it('also rejects escape-heavy valid text at the cap with ordinary IDs, without truncation', () => {
      const initial = fixture();
      function escaped(count: number): SignalDeliveryCheckpoint {
        const text = '\u0000'.repeat(count);
        const chunks: string[] = [];
        for (let cursor = 0; cursor < text.length; cursor += 2_000)
          chunks.push(text.slice(cursor, cursor + 2_000));
        return { ...initial, body: text, chunks };
      }
      let low = 1;
      let high = Math.floor(SIGNAL_CHECKPOINT_MAX_BYTES / 12);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (bytes(escaped(middle)) <= SIGNAL_CHECKPOINT_MAX_BYTES) low = middle;
        else high = middle - 1;
      }
      const text = escaped(low);
      const saved = {
        ...text,
        body: text.body + '#'.repeat(SIGNAL_CHECKPOINT_MAX_BYTES - bytes(text)),
      };
      expect(bytes(saved)).toBe(SIGNAL_CHECKPOINT_MAX_BYTES);
      expect(Buffer.byteLength(saved.body)).toBeLessThanOrEqual(1_048_576);
      expect(
        saved.chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0),
      ).toBeLessThanOrEqual(1_048_576);
      expect(
        parseSignalDeliveryCheckpoint(saved, {
          queueItemId: saved.queueItemId,
          now: saved.createdAt,
        }).isOk(),
      ).toBe(true);
      const before = repo.findById(saved.queueItemId)._unsafeUnwrap();
      expect(repo.saveSignalCheckpoint(saved, saved.createdAt)._unsafeUnwrapErr()).toMatchObject({
        reason: 'TOO_LARGE',
      });
      expect(repo.findById(saved.queueItemId)._unsafeUnwrap()).toEqual(before);
    }, 20_000);

    it('admits the exact lifecycle budget, rejects its next byte, and preserves refused/accepted/delivered maximum counts and cursor growth', () => {
      const saved = atAdmissionBudget({
        ...fixture(),
        body: 'xxxxxxxxxx',
        chunks: Array.from({ length: 10 }, () => 'x'),
      });
      repo.saveSignalCheckpoint(saved, saved.createdAt)._unsafeUnwrap();
      const other = fixture();
      const oversized = {
        ...saved,
        queueItemId: other.queueItemId,
        deliveryId: other.deliveryId,
        personaId: saved.personaId + 'p',
        createdAt: other.createdAt,
        expiresAt: other.expiresAt,
      };
      expect(lifecycleBytes(oversized)).toBe(SIGNAL_CHECKPOINT_MAX_BYTES + 1);
      expect(
        repo.saveSignalCheckpoint(oversized, oversized.createdAt)._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'TOO_LARGE' });
      const accounts = new SignalAccountStateRepository(db);
      let current = saved;
      let now = saved.createdAt;
      const account = accounts.getOrCreate(saved.accountUuid, now)._unsafeUnwrap();
      const first = repo.beginSignalChunk(current, account.revision, now)._unsafeUnwrap();
      assertStored(first.checkpoint, now);
      current = repo
        .settleSignalChunk(
          first,
          {
            kind: 'deferred',
            failure: new SignalDeliveryError({
              reason: 'RECIPIENT_REFUSED',
              outcome: 'NOT_SENT',
              acceptedChunks: 0,
              currentChunkAcceptance: 'refused',
              successCount: 0,
              failureCount: maxCount,
              retryScope: 'delivery_only',
            }),
          },
          now,
        )
        ._unsafeUnwrap();
      assertStored(current, now);
      for (let cursor = 0; cursor < saved.chunks.length; cursor++) {
        now += 1_000;
        const state = accounts.findByAccount(saved.accountUuid)._unsafeUnwrap()!;
        const active = repo.beginSignalChunk(current, state.revision, now)._unsafeUnwrap();
        assertStored(active.checkpoint, now);
        current = repo
          .settleSignalChunk(
            active,
            { kind: 'accepted', successCount: cursor === 0 ? maxCount - 9 : 1 },
            now,
          )
          ._unsafeUnwrap();
        assertStored(current, now);
      }
      expect(current).toMatchObject({
        phase: 'delivered',
        nextChunk: 10,
        acceptedChunks: 10,
        successCount: maxCount,
        failureCount: maxCount,
        body: saved.body,
        chunks: saved.chunks,
        expiresAt: saved.expiresAt,
      });
      expect(accounts.findByAccount(saved.accountUuid)._unsafeUnwrap()?.reservation).toBeNull();
      expect(
        new SignalDestinationLeaseRepository(db)
          .find(saved.accountUuid, saved.destination)
          ._unsafeUnwrap(),
      ).toBeNull();
      repo
        .finalizeSignalDelivery(current, () => ok(undefined), current.expiresAt + 1)
        ._unsafeUnwrap();
      assertStored(current, current.expiresAt + 1);
    }, 30_000);

    it.each(['refused', 'partial', 'unknown', 'recovery', 'orphan', 'expiry'] as const)(
      'keeps the highest admitted budget parseable through %s terminal metadata',
      (outcome) => {
        const saved = atAdmissionBudget(fixture());
        repo.saveSignalCheckpoint(saved, saved.createdAt)._unsafeUnwrap();
        const accounts = new SignalAccountStateRepository(db);
        let now = saved.createdAt;
        if (outcome === 'refused') {
          const failure = new SignalDeliveryError({
            reason: longestReason,
            outcome: 'NOT_SENT',
            acceptedChunks: 0,
            currentChunkAcceptance: 'unwritten',
            successCount: 0,
            failureCount: maxCount,
            retryScope: 'none',
          });
          const terminal = repo.terminateSignalDelivery(saved, failure, now)._unsafeUnwrap();
          assertStored(terminal, now);
        } else if (outcome === 'expiry') {
          now = saved.expiresAt + 1;
          expect(repo.recoverSignalQueue(now)._unsafeUnwrap()).toMatchObject({ terminal: 1 });
        } else {
          let current = saved;
          if (outcome === 'recovery' || outcome === 'orphan') {
            const initial = accounts.getOrCreate(saved.accountUuid, now)._unsafeUnwrap();
            const active = repo.beginSignalChunk(current, initial.revision, now)._unsafeUnwrap();
            current = repo
              .settleSignalChunk(
                active,
                {
                  kind: 'deferred',
                  failure: new SignalDeliveryError({
                    reason: 'RECIPIENT_REFUSED',
                    outcome: 'NOT_SENT',
                    acceptedChunks: 0,
                    currentChunkAcceptance: 'refused',
                    successCount: 0,
                    failureCount: maxCount,
                    retryScope: 'delivery_only',
                  }),
                },
                now,
              )
              ._unsafeUnwrap();
            now += 1_000;
            const retryState = accounts.findByAccount(saved.accountUuid)._unsafeUnwrap()!;
            const retry = repo.beginSignalChunk(current, retryState.revision, now)._unsafeUnwrap();
            current = repo
              .settleSignalChunk(retry, { kind: 'accepted', successCount: maxCount - 1 }, now)
              ._unsafeUnwrap();
            now += 1_000;
          }
          const state = accounts.getOrCreate(saved.accountUuid, now)._unsafeUnwrap();
          const active = repo.beginSignalChunk(current, state.revision, now)._unsafeUnwrap();
          if (outcome === 'recovery' || outcome === 'orphan') {
            if (outcome === 'orphan')
              accounts
                .clearReservation(
                  saved.accountUuid,
                  active.account.revision,
                  active.reservation,
                  now,
                )
                ._unsafeUnwrap();
            expect(repo.recoverSignalQueue(now)._unsafeUnwrap()).toMatchObject({
              terminal: 1,
              reservationsClassified: outcome === 'orphan' ? 0 : 1,
            });
            const recovered = repo.inspectSignalDelivery(saved.queueItemId, now)._unsafeUnwrap();
            expect(recovered).toMatchObject({
              kind: 'checkpoint',
              checkpoint: {
                terminalOutcome: 'UNKNOWN',
                acceptedChunks: 1,
                successCount: maxCount - 1,
                failureCount: maxCount,
              },
            });
          } else {
            const failure = new SignalDeliveryError({
              reason: longestReason,
              outcome: outcome === 'unknown' ? 'UNKNOWN' : 'PARTIAL',
              acceptedChunks: 0,
              currentChunkAcceptance: outcome,
              successCount: maxCount,
              failureCount: maxCount,
              retryScope: 'none',
            });
            const terminal = repo
              .settleSignalChunk(active, { kind: 'terminal', failure }, now)
              ._unsafeUnwrap();
            assertStored(terminal, now);
            expect(terminal).toMatchObject({
              terminalReason: longestReason,
              successCount: maxCount,
              failureCount: maxCount,
            });
          }
          expect(accounts.findByAccount(saved.accountUuid)._unsafeUnwrap()?.reservation).toBeNull();
          if (outcome !== 'partial')
            expect(
              accounts.findByAccount(saved.accountUuid)._unsafeUnwrap()?.recoveryNotBefore,
            ).toBe(now + 60_000);
        }
        const inspected = repo.inspectSignalDelivery(saved.queueItemId, now)._unsafeUnwrap();
        expect(inspected.kind).toBe('checkpoint');
        if (inspected.kind === 'checkpoint') {
          expect(inspected.checkpoint.phase).toBe('terminal');
          expect(inspected.checkpoint.body).toBe(saved.body);
          expect(inspected.checkpoint.chunks).toEqual(saved.chunks);
          expect(inspected.checkpoint.expiresAt).toBe(saved.expiresAt);
          expect(bytes(inspected.checkpoint)).toBeLessThanOrEqual(SIGNAL_CHECKPOINT_MAX_BYTES);
        }
        expect(repo.findById(saved.queueItemId)._unsafeUnwrap()?.status).toBe('dead_letter');
      },
      20_000,
    );

    it.each(['reserved', 'orphan', 'expired'] as const)(
      'refuses oversized constructed legacy %s recovery with complete transaction rollback',
      (kind) => {
        const initial = fixture();
        const saved = paddedTo(
          kind === 'orphan'
            ? { ...initial, phase: 'in_flight', currentChunkAcceptance: 'unknown' }
            : initial,
          SIGNAL_CHECKPOINT_MAX_BYTES,
        );
        persistLegacy(saved);
        const accounts = new SignalAccountStateRepository(db);
        const beforeAccount = accounts
          .getOrCreate(saved.accountUuid, saved.createdAt)
          ._unsafeUnwrap();
        if (kind === 'reserved')
          accounts
            .reserveSend(
              saved.accountUuid,
              beforeAccount.revision,
              { queueItemId: saved.queueItemId, deliveryId: saved.deliveryId, purpose: saved.kind },
              saved.createdAt,
            )
            ._unsafeUnwrap();
        const account = accounts.findByAccount(saved.accountUuid)._unsafeUnwrap();
        const before = repo.findById(saved.queueItemId)._unsafeUnwrap();
        const now = kind === 'expired' ? saved.expiresAt + 1 : saved.createdAt;
        const rejected = repo.recoverSignalQueue(now)._unsafeUnwrapErr();
        expect(rejected).toBeInstanceOf(SignalCheckpointError);
        expect(rejected).toMatchObject({ reason: 'TOO_LARGE', cause: undefined });
        expect(accounts.findByAccount(saved.accountUuid)._unsafeUnwrap()).toEqual(account);
        expect(repo.findById(saved.queueItemId)._unsafeUnwrap()).toEqual(before);
        assertStored(saved, now);
      },
      20_000,
    );
  });

  describe('Signal checkpoint transactions', () => {
    function prepare(overrides: Partial<SignalDeliveryCheckpoint> = {}) {
      const item = makeItem();
      repo.enqueue({ ...item, payload: '{"original":true}' })._unsafeUnwrap();
      const saved = checkpoint(item.id, overrides);
      repo.saveSignalCheckpoint(saved, saved.createdAt)._unsafeUnwrap();
      return saved;
    }

    function begin(saved: SignalDeliveryCheckpoint, now = saved.createdAt) {
      const accounts = new SignalAccountStateRepository(db);
      const state = accounts.getOrCreate(saved.accountUuid, now)._unsafeUnwrap();
      return repo.beginSignalChunk(saved, state.revision, now)._unsafeUnwrap();
    }

    function failure(saved: SignalDeliveryCheckpoint, unknown = false) {
      return new SignalDeliveryError({
        reason: unknown ? 'UNKNOWN_ACCEPTANCE' : 'ACCOUNT_BUSY',
        outcome: unknown ? 'UNKNOWN' : saved.acceptedChunks > 0 ? 'PARTIAL' : 'NOT_SENT',
        acceptedChunks: saved.acceptedChunks,
        currentChunkAcceptance: unknown ? 'unknown' : 'unwritten',
        successCount: saved.successCount,
        failureCount: saved.failureCount,
        retryScope: unknown ? 'none' : 'delivery_only',
      });
    }

    async function restart(): Promise<string> {
      restartDirectory = mkdtempSync(join(tmpdir(), 'talon-queue-restart-'));
      const filename = join(restartDirectory, 'queue.sqlite');
      await db.backup(filename);
      db.close();
      db = new Database(filename);
      db.pragma('foreign_keys = ON');
      repo = new QueueRepository(db);
      return filename;
    }

    it('merges the latest payload and marker, with absent-checkpoint and expected-marker CAS', () => {
      const item = makeItem();
      repo.enqueue(item)._unsafeUnwrap();
      const saved = checkpoint(item.id);
      const marker = {
        version: 1 as const,
        queueItemId: item.id,
        deliveryId: 'tool',
        purpose: 'explicit' as const,
        startedAt: saved.createdAt,
      };
      repo.markSignalDeliveryStarted(marker, null, saved.createdAt)._unsafeUnwrap();
      db.prepare(
        "UPDATE queue_items SET payload = json_set(payload, '$.later', 7) WHERE id = ?",
      ).run(item.id);
      repo.saveSignalCheckpoint(saved, saved.createdAt)._unsafeUnwrap();
      expect(JSON.parse(repo.findById(item.id)._unsafeUnwrap()!.payload)).toEqual({
        later: 7,
        [SIGNAL_DELIVERY_STARTED_KEY]: marker,
        [SIGNAL_DELIVERY_CHECKPOINT_KEY]: saved,
      });
      expect(
        repo
          .saveSignalCheckpoint({ ...saved, body: 'stale replacement' }, saved.createdAt)
          ._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'CONFLICT' });
      expect(
        repo
          .markSignalDeliveryStarted({ ...marker, deliveryId: 'late' }, null, saved.createdAt)
          ._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'CONFLICT' });
    });

    it('atomically acquires destination ownership and reserves one in_flight chunk, rejecting phase/cursor conflicts', () => {
      const saved = prepare();
      const ownership = begin(saved);
      expect(ownership.checkpoint).toMatchObject({
        phase: 'in_flight',
        nextChunk: 0,
        currentChunkAcceptance: 'unknown',
      });
      expect(ownership.reservation).toMatchObject({
        queueItemId: saved.queueItemId,
        deliveryId: saved.deliveryId,
        purpose: 'reply',
      });
      const accounts = new SignalAccountStateRepository(db);
      const before = accounts.findByAccount(saved.accountUuid)._unsafeUnwrap();
      expect(
        repo
          .beginSignalChunk(saved, ownership.account.revision, saved.createdAt + 1_000)
          ._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'CONFLICT' });
      expect(
        repo
          .beginSignalChunk(
            { ...saved, nextChunk: 1, acceptedChunks: 1, successCount: 1 },
            ownership.account.revision,
            saved.createdAt + 1_000,
          )
          .isErr(),
      ).toBe(true);
      expect(accounts.findByAccount(saved.accountUuid)._unsafeUnwrap()).toEqual(before);
      const advanced = repo
        .settleSignalChunk(ownership, { kind: 'accepted', successCount: 2 }, saved.createdAt + 1)
        ._unsafeUnwrap();
      expect(advanced).toMatchObject({
        phase: 'ready',
        nextChunk: 1,
        acceptedChunks: 1,
        successCount: 2,
      });
      expect(accounts.findByAccount(saved.accountUuid)._unsafeUnwrap()?.reservation).toBeNull();
      expect(
        repo
          .settleSignalChunk(ownership, { kind: 'accepted', successCount: 2 }, saved.createdAt + 2)
          ._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'CONFLICT' });
      expect(
        repo
          .beginSignalChunk(saved, ownership.account.revision + 1, saved.createdAt + 1_000)
          ._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'CONFLICT' });
    });

    it('CASes actual phase/cursor and reservation generations across competing SQLite connections', async () => {
      const saved = prepare();
      const filename = await restart();
      const competingDb = new Database(filename);
      competingDb.pragma('foreign_keys = ON');
      try {
        const competitor = new QueueRepository(competingDb);
        const account = new SignalAccountStateRepository(db)
          .getOrCreate(saved.accountUuid, saved.createdAt)
          ._unsafeUnwrap();
        expect(
          competitor.inspectSignalDelivery(saved.queueItemId, saved.createdAt)._unsafeUnwrap(),
        ).toEqual({ kind: 'checkpoint', checkpoint: saved });
        const first = repo
          .beginSignalChunk(saved, account.revision, saved.createdAt)
          ._unsafeUnwrap();
        expect(
          competitor.beginSignalChunk(saved, account.revision, saved.createdAt)._unsafeUnwrapErr(),
        ).toMatchObject({ reason: 'CONFLICT' });
        const tail = repo
          .settleSignalChunk(first, { kind: 'accepted', successCount: 1 }, saved.createdAt + 1)
          ._unsafeUnwrap();
        const latestAccount = new SignalAccountStateRepository(competingDb)
          .findByAccount(saved.accountUuid)
          ._unsafeUnwrap()!;
        expect(
          competitor
            .beginSignalChunk(saved, latestAccount.revision, saved.createdAt + 1_000)
            ._unsafeUnwrapErr(),
        ).toMatchObject({ reason: 'CONFLICT' });
        const next = competitor
          .beginSignalChunk(tail, latestAccount.revision, saved.createdAt + 1_000)
          ._unsafeUnwrap();
        expect(
          repo
            .settleSignalChunk(
              first,
              { kind: 'accepted', successCount: 1 },
              saved.createdAt + 1_001,
            )
            ._unsafeUnwrapErr(),
        ).toMatchObject({ reason: 'CONFLICT' });
        expect(
          new SignalAccountStateRepository(db).findByAccount(saved.accountUuid)._unsafeUnwrap(),
        ).toEqual(next.account);
      } finally {
        competingDb.close();
      }
    });

    it('holds destination ownership across chunks while allowing another target between them', () => {
      const saved = prepare();
      const first = repo
        .settleSignalChunk(begin(saved), { kind: 'accepted', successCount: 1 }, saved.createdAt + 1)
        ._unsafeUnwrap();
      const background = prepare({ kind: 'background' });
      const accounts = new SignalAccountStateRepository(db);
      const current = accounts.findByAccount(saved.accountUuid)._unsafeUnwrap()!;
      expect(
        repo
          .beginSignalChunk(background, current.revision, background.createdAt + 1_000)
          ._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'BUSY' });
      const otherTarget = prepare({ destination: `signal:v1:${saved.accountUuid}:group:Z3JvdXA` });
      const other = repo
        .beginSignalChunk(otherTarget, current.revision, otherTarget.createdAt + 2_000)
        ._unsafeUnwrap();
      const resumed = repo
        .settleSignalChunk(
          other,
          { kind: 'deferred', failure: failure(otherTarget) },
          otherTarget.createdAt + 2_001,
        )
        ._unsafeUnwrap();
      expect(resumed).toMatchObject({ phase: 'ready', nextChunk: 0 });
      expect(
        repo
          .inspectSignalDelivery(saved.queueItemId, otherTarget.createdAt + 2_002)
          ._unsafeUnwrap(),
      ).toEqual({ kind: 'checkpoint', checkpoint: first });
    });

    describe('ready terminalization lease cleanup', () => {
      function permanentFailure(saved: SignalDeliveryCheckpoint, expired = false) {
        return new SignalDeliveryError({
          reason: expired ? 'CHECKPOINT_EXPIRED' : 'TARGET_REFUSED',
          outcome: saved.acceptedChunks > 0 ? 'PARTIAL' : 'NOT_SENT',
          acceptedChunks: saved.acceptedChunks,
          currentChunkAcceptance: expired ? saved.currentChunkAcceptance : 'refused',
          successCount: saved.successCount,
          failureCount: saved.failureCount,
          retryScope: 'none',
        });
      }

      function attachRun(saved: SignalDeliveryCheckpoint): string {
        const id = `run-${saved.queueItemId}`;
        db.prepare(
          "INSERT OR IGNORE INTO personas (id, name, created_at, updated_at) VALUES ('persona', 'persona', 1, 1)",
        ).run();
        db.prepare(
          "INSERT INTO runs (id, thread_id, persona_id, provider_name, queue_item_id, status, created_at) VALUES (?, ?, 'persona', 'test', ?, 'running', 1)",
        ).run(id, saved.threadId, saved.queueItemId);
        return id;
      }

      describe.each(['TARGET_REFUSED', 'CHECKPOINT_EXPIRED'] as const)('%s', (reason) => {
        it.each(['reply', 'background', 'explicit', 'progress'] as const)(
          'terminalizes the waiter without changing a foreign %s owner or its active reservation',
          (purpose) => {
            const saved = prepare({ createdAt: 1_000_000, expiresAt: 87_400_000 });
            const expired = reason === 'CHECKPOINT_EXPIRED';
            const now = expired ? saved.expiresAt : saved.createdAt + 1_000;
            const runId = attachRun(saved);
            repo.deferSignalDelivery(saved, 1_000, saved.createdAt)._unsafeUnwrap();
            const accounts = new SignalAccountStateRepository(db);
            const leases = new SignalDestinationLeaseRepository(db);
            const ownerItem = makeItem({ payload: '{"owner":true}' });
            repo.enqueue(ownerItem)._unsafeUnwrap();
            const owner = checkpoint(ownerItem.id, {
              kind: purpose === 'background' ? 'background' : 'reply',
              createdAt: now - 1,
              expiresAt: now - 1 + SIGNAL_CHECKPOINT_LIFETIME_MS,
            });
            const ownerRunId = attachRun(owner);
            if (purpose === 'reply' || purpose === 'background') {
              repo.saveSignalCheckpoint(owner, now - 1)._unsafeUnwrap();
              begin(owner, now - 1);
            } else {
              // Invocation owners have a guard rather than a saved retry checkpoint.
              const context = {
                queueItemId: owner.queueItemId,
                deliveryId: owner.deliveryId,
                purpose,
              };
              repo
                .markSignalDeliveryStarted(
                  { version: 1, ...context, startedAt: now - 1 },
                  null,
                  now,
                )
                ._unsafeUnwrap();
              leases
                .acquire(saved.accountUuid, saved.destination, context, now - 1)
                ._unsafeUnwrap();
              const state = accounts.getOrCreate(saved.accountUuid, now - 1)._unsafeUnwrap();
              accounts
                .reserveSend(saved.accountUuid, state.revision, context, now - 1)
                ._unsafeUnwrap();
            }
            const leaseBefore = leases.find(saved.accountUuid, saved.destination)._unsafeUnwrap();
            const accountBefore = accounts.findByAccount(saved.accountUuid)._unsafeUnwrap();
            const ownerBefore = repo.findById(owner.queueItemId)._unsafeUnwrap();
            const ownerRunBefore = db.prepare('SELECT * FROM runs WHERE id = ?').get(ownerRunId);
            expect(accountBefore?.reservation?.queueItemId).toBe(owner.queueItemId);
            expect(
              repo.beginSignalChunk(saved, accountBefore!.revision, now)._unsafeUnwrapErr(),
            ).toMatchObject({ reason: expired ? 'EXPIRED' : 'BUSY' });

            const result = repo.terminateSignalDelivery(
              saved,
              permanentFailure(saved, expired),
              now,
            );
            expect(result.isErr() ? result.error : undefined).toBeUndefined();
            const terminal = result._unsafeUnwrap();
            expect(terminal).toEqual({
              ...saved,
              phase: 'terminal',
              currentChunkAcceptance: expired ? 'unwritten' : 'refused',
              terminalReason: reason,
              terminalOutcome: 'NOT_SENT',
            });
            const row = repo.findById(saved.queueItemId)._unsafeUnwrap()!;
            expect(row).toMatchObject({
              status: 'dead_letter',
              error: reason,
              attempts: 0,
              max_attempts: 3,
              claimed_at: null,
              next_retry_at: null,
            });
            expect(JSON.parse(row.payload)).toEqual({
              original: true,
              [SIGNAL_DELIVERY_CHECKPOINT_KEY]: terminal,
            });
            expect(
              db.prepare('SELECT status, error, ended_at FROM runs WHERE id = ?').get(runId),
            ).toEqual({ status: 'failed', error: reason, ended_at: now });
            expect(leases.find(saved.accountUuid, saved.destination)._unsafeUnwrap()).toEqual(
              leaseBefore,
            );
            expect(accounts.findByAccount(saved.accountUuid)._unsafeUnwrap()).toEqual(
              accountBefore,
            );
            expect(repo.findById(owner.queueItemId)._unsafeUnwrap()).toEqual(ownerBefore);
            expect(db.prepare('SELECT * FROM runs WHERE id = ?').get(ownerRunId)).toEqual(
              ownerRunBefore,
            );
            expect(repo.beginSignalChunk(saved, accountBefore!.revision, now).isErr()).toBe(true);
          },
        );

        it.each(['none', 'owned'] as const)(
          'terminalizes with %s lease and preserves accepted-tail counts',
          (kind) => {
            const saved = prepare();
            const leases = new SignalDestinationLeaseRepository(db);
            const accounts = new SignalAccountStateRepository(db);
            const ready =
              kind === 'none'
                ? saved
                : repo
                    .settleSignalChunk(
                      begin(saved),
                      { kind: 'accepted', successCount: 2 },
                      saved.createdAt + 1,
                    )
                    ._unsafeUnwrap();
            const accountBefore = accounts.findByAccount(saved.accountUuid)._unsafeUnwrap();
            expect(leases.find(saved.accountUuid, saved.destination)._unsafeUnwrap() === null).toBe(
              kind === 'none',
            );
            const expired = reason === 'CHECKPOINT_EXPIRED';
            const now = expired ? saved.expiresAt : saved.createdAt + 2;
            const terminal = repo
              .terminateSignalDelivery(ready, permanentFailure(ready, expired), now)
              ._unsafeUnwrap();
            expect(terminal).toEqual({
              ...ready,
              phase: 'terminal',
              currentChunkAcceptance: expired ? 'unwritten' : 'refused',
              terminalReason: reason,
              terminalOutcome: kind === 'none' ? 'NOT_SENT' : 'PARTIAL',
            });
            expect(leases.find(saved.accountUuid, saved.destination)._unsafeUnwrap()).toBeNull();
            expect(accounts.findByAccount(saved.accountUuid)._unsafeUnwrap()).toEqual(
              accountBefore,
            );
            expect(repo.findById(saved.queueItemId)._unsafeUnwrap()).toMatchObject({
              status: 'dead_letter',
              error: reason,
              attempts: 0,
              next_retry_at: null,
            });
          },
        );
      });

      it.each(['queueItemId', 'deliveryId', 'kind'] as const)(
        'leaves a lease with only %s different untouched',
        (field) => {
          const saved = prepare();
          const other = prepare();
          const leases = new SignalDestinationLeaseRepository(db);
          const context = {
            queueItemId: field === 'queueItemId' ? other.queueItemId : saved.queueItemId,
            deliveryId: field === 'deliveryId' ? 'different-delivery' : saved.deliveryId,
            purpose: field === 'kind' ? ('explicit' as const) : saved.kind,
          };
          const lease = leases
            .acquire(saved.accountUuid, saved.destination, context, saved.createdAt)
            ._unsafeUnwrap();
          const result = repo.terminateSignalDelivery(
            saved,
            permanentFailure(saved),
            saved.createdAt + 1,
          );
          expect(result.isErr() ? result.error : undefined).toBeUndefined();
          result._unsafeUnwrap();
          expect(leases.validateOwner(lease)._unsafeUnwrap()).toEqual(lease);
        },
      );

      it('rolls back terminal checkpoint, queue and run on a real lease lookup database failure', () => {
        const saved = prepare();
        const runId = attachRun(saved);
        const before = repo.findById(saved.queueItemId)._unsafeUnwrap();
        const runBefore = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
        db.exec('ALTER TABLE signal_destination_leases RENAME TO unavailable_leases');
        const result = repo.terminateSignalDelivery(
          saved,
          permanentFailure(saved),
          saved.createdAt + 1,
        );
        expect(result._unsafeUnwrapErr()).toBeInstanceOf(SignalStateError);
        expect(result._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE', cause: undefined });
        expect(repo.findById(saved.queueItemId)._unsafeUnwrap()).toEqual(before);
        expect(db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)).toEqual(runBefore);
      });

      it.each(['owned CAS', 'delete database', 'enclosing Result'] as const)(
        'rolls back terminal checkpoint, queue, run and owned release on %s failure',
        (fault) => {
          const saved = prepare();
          const ownership = begin(saved);
          const ready = repo
            .settleSignalChunk(
              ownership,
              { kind: 'deferred', failure: failure(saved) },
              saved.createdAt + 1,
            )
            ._unsafeUnwrap();
          const runId = attachRun(saved);
          const leases = new SignalDestinationLeaseRepository(db);
          const accounts = new SignalAccountStateRepository(db);
          const before = repo.findById(saved.queueItemId)._unsafeUnwrap();
          const runBefore = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
          const accountBefore = accounts.findByAccount(saved.accountUuid)._unsafeUnwrap();
          const sentinel = new SignalStateError('CONFLICT');
          const validation =
            fault === 'owned CAS'
              ? vi
                  .spyOn(SignalDestinationLeaseRepository.prototype, 'validateOwner')
                  .mockReturnValueOnce(err(sentinel))
              : undefined;
          if (fault === 'delete database')
            db.exec(`CREATE TRIGGER fail_owned_release BEFORE DELETE ON signal_destination_leases
            BEGIN SELECT RAISE(ABORT, 'private target and body'); END`);
          try {
            const terminate = () =>
              repo.terminateSignalDelivery(ready, permanentFailure(ready), saved.createdAt + 2);
            const result =
              fault === 'enclosing Result'
                ? runResultTransaction(
                    (fn) => repo.transaction(fn),
                    () => terminate().andThen(() => err(sentinel)),
                  )
                : terminate();
            if (fault === 'delete database') {
              expect(result._unsafeUnwrapErr()).toMatchObject({
                reason: 'DATABASE',
                cause: undefined,
              });
              expect(result._unsafeUnwrapErr().message).not.toMatch(/private|target|body/);
            } else expect(result._unsafeUnwrapErr()).toBe(sentinel);
          } finally {
            validation?.mockRestore();
          }
          expect(repo.findById(saved.queueItemId)._unsafeUnwrap()).toEqual(before);
          expect(db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)).toEqual(runBefore);
          expect(accounts.findByAccount(saved.accountUuid)._unsafeUnwrap()).toEqual(accountBefore);
          expect(leases.validateOwner(ownership.lease)._unsafeUnwrap()).toEqual(ownership.lease);
        },
      );
    });

    it('rolls back checkpoint, new lease, account budget and reservation on account CAS failure and enclosing Err', () => {
      const saved = prepare();
      const accounts = new SignalAccountStateRepository(db);
      const state = accounts.getOrCreate(saved.accountUuid, saved.createdAt)._unsafeUnwrap();
      expect(
        repo.beginSignalChunk(saved, state.revision + 1, saved.createdAt)._unsafeUnwrapErr(),
      ).toBeInstanceOf(SignalStateError);
      expect(
        repo.inspectSignalDelivery(saved.queueItemId, saved.createdAt)._unsafeUnwrap(),
      ).toEqual({ kind: 'checkpoint', checkpoint: saved });
      expect(
        new SignalDestinationLeaseRepository(db)
          .find(saved.accountUuid, saved.destination)
          ._unsafeUnwrap(),
      ).toBeNull();
      const sentinel = new SignalStateError('CONFLICT');
      expect(
        runResultTransaction(
          (fn) => repo.transaction(fn),
          () =>
            repo
              .beginSignalChunk(saved, state.revision, saved.createdAt)
              .andThen(() => err(sentinel)),
        )._unsafeUnwrapErr(),
      ).toBe(sentinel);
      expect(accounts.findByAccount(saved.accountUuid)._unsafeUnwrap()).toEqual(state);
      expect(
        new SignalDestinationLeaseRepository(db)
          .find(saved.accountUuid, saved.destination)
          ._unsafeUnwrap(),
      ).toBeNull();
    });

    it('rolls back accepted cursor and reservation clear together if the payload write fails', () => {
      const saved = prepare();
      const ownership = begin(saved);
      db.exec(`CREATE TRIGGER fail_signal_payload BEFORE UPDATE OF payload ON queue_items
        BEGIN SELECT RAISE(ABORT, 'private body and target'); END`);
      const result = repo.settleSignalChunk(
        ownership,
        { kind: 'accepted', successCount: 1 },
        saved.createdAt + 1,
      );
      expect(result._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE', cause: undefined });
      expect(result._unsafeUnwrapErr().message).not.toMatch(/private|body|target/);
      expect(
        new SignalAccountStateRepository(db).findByAccount(saved.accountUuid)._unsafeUnwrap(),
      ).toEqual(ownership.account);
      expect(
        repo.inspectSignalDelivery(saved.queueItemId, saved.createdAt)._unsafeUnwrap(),
      ).toEqual({ kind: 'checkpoint', checkpoint: ownership.checkpoint });
    });

    it('retains lease/cursor across wholly unsent deferral and never consumes provider maxAttempts=3', () => {
      const saved = prepare();
      const ownership = begin(saved);
      const ready = repo
        .settleSignalChunk(
          ownership,
          { kind: 'deferred', failure: failure(saved) },
          saved.createdAt + 1,
        )
        ._unsafeUnwrap();
      for (let attempt = 0; attempt < 6; attempt++) {
        expect(repo.deferSignalDelivery(ready, 1, saved.createdAt + 1)._unsafeUnwrap()).toBe(
          saved.createdAt + 1_001,
        );
      }
      expect(repo.findById(saved.queueItemId)._unsafeUnwrap()).toMatchObject({
        attempts: 0,
        max_attempts: 3,
        status: 'failed',
        claimed_at: null,
      });
      expect(new SignalDestinationLeaseRepository(db).validateOwner(ownership.lease).isOk()).toBe(
        true,
      );
      expect(repo.deferSignalDelivery(ready, 999_999, saved.createdAt + 1)._unsafeUnwrap()).toBe(
        saved.createdAt + 60_001,
      );
      expect(
        repo
          .deferSignalDelivery(ready, 1_000, saved.createdAt + 1, ready.expiresAt + 100)
          ._unsafeUnwrap(),
      ).toBe(ready.expiresAt);
      expect(
        repo.deferSignalDelivery(ready, 1_000, ready.expiresAt)._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'EXPIRED' });
    });

    it('settles the same reservation after an unrelated device-budget revision, without replaying the RPC', () => {
      const saved = prepare();
      const ownership = begin(saved);
      const accounts = new SignalAccountStateRepository(db);
      accounts
        .startDeviceCheck(saved.accountUuid, ownership.account.revision, saved.createdAt + 1)
        ._unsafeUnwrap();
      expect(
        repo
          .settleSignalChunk(ownership, { kind: 'accepted', successCount: 1 }, saved.createdAt + 2)
          ._unsafeUnwrap(),
      ).toMatchObject({ nextChunk: 1 });
      expect(accounts.findByAccount(saved.accountUuid)._unsafeUnwrap()).toMatchObject({
        reservation: null,
        lastDeviceCheckStart: saved.createdAt + 1,
      });
    });

    it('rejects wrong reservation/lease ownership and successful counts of zero before mutation', () => {
      const saved = prepare();
      const ownership = begin(saved);
      for (const wrong of [
        { ...ownership, reservation: { ...ownership.reservation, startedAt: 1 } },
        { ...ownership, lease: { ...ownership.lease, leaseId: 'stale' } },
      ])
        expect(
          repo
            .settleSignalChunk(wrong, { kind: 'accepted', successCount: 1 }, saved.createdAt + 1)
            .isErr(),
        ).toBe(true);
      expect(
        repo
          .settleSignalChunk(ownership, { kind: 'accepted', successCount: 0 }, saved.createdAt + 1)
          .isErr(),
      ).toBe(true);
      expect(
        new SignalAccountStateRepository(db).findByAccount(saved.accountUuid)._unsafeUnwrap(),
      ).toEqual(ownership.account);
    });

    it('continues only the saved unsent tail, delivers once, and finalizes locally with enclosing rollback', () => {
      const saved = prepare();
      const first = repo
        .settleSignalChunk(begin(saved), { kind: 'accepted', successCount: 1 }, saved.createdAt + 1)
        ._unsafeUnwrap();
      const second = begin(first, saved.createdAt + 1_000);
      const delivered = repo
        .settleSignalChunk(second, { kind: 'accepted', successCount: 1 }, saved.createdAt + 1_001)
        ._unsafeUnwrap();
      expect(delivered).toMatchObject({ phase: 'delivered', nextChunk: 2 });
      expect(
        new SignalDestinationLeaseRepository(db)
          .find(saved.accountUuid, saved.destination)
          ._unsafeUnwrap(),
      ).toBeNull();
      const sentinel = new SignalStateError('CONFLICT');
      expect(
        repo
          .finalizeSignalDelivery(
            delivered,
            () => {
              db.prepare("UPDATE queue_items SET error = 'local write' WHERE id = ?").run(
                saved.queueItemId,
              );
              return err(sentinel);
            },
            delivered.expiresAt + 1,
          )
          ._unsafeUnwrapErr(),
      ).toBe(sentinel);
      expect(repo.findById(saved.queueItemId)._unsafeUnwrap()?.error).toBeNull();
      expect(
        repo.deferSignalDelivery(delivered, 1_000, delivered.expiresAt + 1)._unsafeUnwrap(),
      ).toBe(delivered.expiresAt + 1_001);
      expect(repo.findById(saved.queueItemId)._unsafeUnwrap()).toMatchObject({
        status: 'failed',
        attempts: 0,
        max_attempts: 3,
      });
      expect(
        repo.finalizeSignalDelivery(delivered, () => ok(undefined), delivered.expiresAt + 1).isOk(),
      ).toBe(true);
      let calls = 0;
      repo
        .finalizeSignalDelivery(
          delivered,
          () => {
            calls++;
            return ok(undefined);
          },
          delivered.expiresAt + 2,
        )
        ._unsafeUnwrap();
      expect(calls).toBe(0);
    });

    it('purge during an active chunk cascades lease, rejects late history/body, yet classifies its reservation', () => {
      const saved = prepare();
      const ownership = begin(saved);
      repo.claimNext(threadId)._unsafeUnwrap();
      expect(
        repo
          .purge(['pending', 'claimed', 'processing', 'completed', 'failed', 'dead_letter'])
          ._unsafeUnwrap(),
      ).toBe(1);
      expect(
        repo
          .settleSignalChunk(
            ownership,
            { kind: 'terminal', failure: failure(saved, true) },
            saved.createdAt + 1,
          )
          ._unsafeUnwrapErr(),
      ).toBeInstanceOf(DeliveryCancelled);
      const account = new SignalAccountStateRepository(db)
        .findByAccount(saved.accountUuid)
        ._unsafeUnwrap();
      expect(account).toMatchObject({
        reservation: null,
        recoveryNotBefore: saved.createdAt + 60_001,
      });
      expect(
        repo.saveSignalCheckpoint(saved, saved.createdAt + 1)._unsafeUnwrapErr(),
      ).toBeInstanceOf(DeliveryCancelled);
      expect(
        repo.deferSignalDelivery(saved, 1_000, saved.createdAt + 1)._unsafeUnwrapErr(),
      ).toBeInstanceOf(DeliveryCancelled);
      expect(
        repo
          .finalizeSignalDelivery(
            {
              ...saved,
              phase: 'delivered',
              nextChunk: 2,
              acceptedChunks: 2,
              successCount: 2,
              currentChunkAcceptance: 'complete',
            },
            () => {
              throw new Error('must not finalize');
            },
            saved.createdAt + 1,
          )
          ._unsafeUnwrapErr(),
      ).toBeInstanceOf(DeliveryCancelled);
      expect(repo.findById(saved.queueItemId)._unsafeUnwrap()).toBeNull();
    });

    it('recovers reopened ready/delivered/in_flight checkpoints and standalone guards without replay', async () => {
      const ready = prepare();
      const inflight = prepare();
      begin(inflight);
      const delivered = prepare({ chunks: ['only'] });
      const otherAccount = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const one = {
        ...delivered,
        accountUuid: otherAccount,
        destination: `signal:v1:${otherAccount}:self`,
      };
      // Use a separate account to prove recovery isolation while the first reservation is active.
      db.prepare('UPDATE queue_items SET payload = ? WHERE id = ?').run(
        JSON.stringify({ [SIGNAL_DELIVERY_CHECKPOINT_KEY]: one }),
        one.queueItemId,
      );
      const done = repo
        .settleSignalChunk(begin(one), { kind: 'accepted', successCount: 1 }, one.createdAt + 1)
        ._unsafeUnwrap();
      const guarded = makeItem();
      repo.enqueue(guarded)._unsafeUnwrap();
      repo
        .markSignalDeliveryStarted(
          {
            version: 1,
            queueItemId: guarded.id,
            deliveryId: 'explicit',
            purpose: 'explicit',
            startedAt: ready.createdAt,
          },
          null,
          ready.createdAt,
        )
        ._unsafeUnwrap();
      const ordinary = makeItem();
      repo.enqueue(ordinary)._unsafeUnwrap();
      db.prepare("UPDATE queue_items SET status = 'processing'").run();
      await restart();
      const recovered = repo
        .recoverSignalQueue(Math.max(ready.createdAt, inflight.createdAt, one.createdAt) + 2)
        ._unsafeUnwrap();
      expect(recovered).toMatchObject({
        ordinaryReset: 1,
        ready: 1,
        delivered: 1,
        terminal: 2,
        reservationsClassified: 1,
      });
      expect(repo.findById(ready.queueItemId)._unsafeUnwrap()?.status).toBe('pending');
      expect(
        repo.inspectSignalDelivery(one.queueItemId, one.expiresAt + 1)._unsafeUnwrap(),
      ).toEqual({ kind: 'checkpoint', checkpoint: done });
      expect(repo.findById(inflight.queueItemId)._unsafeUnwrap()?.status).toBe('dead_letter');
      expect(repo.findById(guarded.id)._unsafeUnwrap()?.status).toBe('dead_letter');
      expect(
        repo.recoverSignalQueue(ready.createdAt + 3)._unsafeUnwrap().reservationsClassified,
      ).toBe(0);
    });

    it('classifies orphan explicit reservations before releasing invocation leases, including crash before reservation', async () => {
      const saved = prepare({ chunks: ['only'] });
      repo
        .settleSignalChunk(begin(saved), { kind: 'accepted', successCount: 1 }, saved.createdAt + 1)
        ._unsafeUnwrap();
      const accounts = new SignalAccountStateRepository(db);
      const leases = new SignalDestinationLeaseRepository(db);
      const state = accounts.findByAccount(saved.accountUuid)._unsafeUnwrap()!;
      const context = {
        queueItemId: saved.queueItemId,
        deliveryId: 'explicit',
        purpose: 'explicit' as const,
      };
      leases
        .acquire(saved.accountUuid, saved.destination, context, saved.createdAt)
        ._unsafeUnwrap();
      accounts
        .reserveSend(saved.accountUuid, state.revision, context, saved.createdAt + 1_000)
        ._unsafeUnwrap();
      // Even an orphan tool reservation must not rewrite an independently delivered/completed origin reply.
      repo.complete(saved.queueItemId)._unsafeUnwrap();
      const before = repo.findById(saved.queueItemId)._unsafeUnwrap();
      const second = makeItem();
      repo.enqueue(second)._unsafeUnwrap();
      const accountB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      leases
        .acquire(
          accountB,
          `signal:v1:${accountB}:self`,
          { ...context, queueItemId: second.id },
          saved.createdAt,
        )
        ._unsafeUnwrap();
      await restart();
      expect(repo.recoverSignalQueue(saved.createdAt + 1_001)._unsafeUnwrap()).toMatchObject({
        reservationsClassified: 1,
        orphanLeasesReleased: 2,
      });
      expect(repo.findById(saved.queueItemId)._unsafeUnwrap()).toEqual(before);
      expect(
        new SignalAccountStateRepository(db).findByAccount(saved.accountUuid)._unsafeUnwrap(),
      ).toMatchObject({ reservation: null, recoveryNotBefore: saved.createdAt + 61_001 });
      expect(repo.findById(second.id)._unsafeUnwrap()?.status).toBe('dead_letter');
    });

    it('preserves markerless malformed/non-object legacy payload bytes at inspection and recovery, but refuses mutation', () => {
      const payloads = [
        'not json',
        'null',
        '[]',
        '42',
        '"legacy"',
        JSON.stringify({
          text: SIGNAL_DELIVERY_STARTED_KEY,
          nested: { [SIGNAL_DELIVERY_CHECKPOINT_KEY]: null },
        }),
      ];
      const items = payloads.map((payload) => {
        const item = makeItem({ payload });
        repo.enqueue(item)._unsafeUnwrap();
        expect(repo.inspectSignalDelivery(item.id, Date.now())._unsafeUnwrap()).toEqual({
          kind: 'ordinary',
        });
        return item;
      });
      expect(
        repo.saveSignalCheckpoint(checkpoint(items[0]!.id), Date.now() + 1)._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'INVALID' });
      db.prepare("UPDATE queue_items SET status = 'processing'").run();
      expect(repo.recoverSignalQueue(Date.now() + 2)._unsafeUnwrap()).toMatchObject({
        ordinaryReset: payloads.length,
        invalid: 0,
      });
      for (const item of items)
        expect(repo.findById(item.id)._unsafeUnwrap()).toMatchObject({
          payload: item.payload,
          status: 'pending',
        });
    });

    it('fails closed for malformed, escaped and truncated reserved Signal state without interpreting partial JSON', () => {
      const payloads = [
        String.raw`{"\u005f\u005ftalond_signal_delivery_v1":null}`,
        String.raw`{"\u005f\u005ftalond_signal_delivery_started_v1":`,
        '{"__talond_sig',
        String.raw`{"\u005f\u005ftalond_signa\u006`,
        '{"__talond_signal_del',
        '{"__talond_signal_delivery_v1":',
      ];
      for (const payload of payloads) {
        const item = makeItem({ payload });
        repo.enqueue(item)._unsafeUnwrap();
        expect(repo.inspectSignalDelivery(item.id, Date.now()).isErr()).toBe(true);
      }
      expect(repo.recoverSignalQueue(Date.now() + 1)._unsafeUnwrap()).toMatchObject({
        invalid: payloads.length,
        ordinaryReset: 0,
      });
      expect(repo.findPending()._unsafeUnwrap()).toEqual([]);
    });

    it('never replays damaged markerless payloads backed by an independent reservation or invocation lease', () => {
      const saved = prepare();
      begin(saved);
      db.prepare("UPDATE queue_items SET payload = 'damaged' WHERE id = ?").run(saved.queueItemId);
      const leaseOnly = makeItem({ payload: 'null' });
      repo.enqueue(leaseOnly)._unsafeUnwrap();
      const accountB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      new SignalDestinationLeaseRepository(db)
        .acquire(
          accountB,
          `signal:v1:${accountB}:self`,
          { queueItemId: leaseOnly.id, deliveryId: 'explicit', purpose: 'explicit' },
          saved.createdAt,
        )
        ._unsafeUnwrap();
      expect(repo.inspectSignalDelivery(saved.queueItemId, saved.createdAt + 1).isErr()).toBe(true);
      expect(repo.inspectSignalDelivery(leaseOnly.id, saved.createdAt + 1).isErr()).toBe(true);
      expect(repo.recoverSignalQueue(saved.createdAt + 2)._unsafeUnwrap()).toMatchObject({
        invalid: 2,
        reservationsClassified: 1,
        orphanLeasesReleased: 2,
      });
      expect(repo.findById(saved.queueItemId)._unsafeUnwrap()).toMatchObject({
        payload: 'damaged',
        status: 'dead_letter',
      });
      expect(repo.findById(leaseOnly.id)._unsafeUnwrap()).toMatchObject({
        payload: 'null',
        status: 'dead_letter',
      });
    });

    it('validates persisted run ownership before handing checkpoint data to finalization', () => {
      db.prepare(
        "INSERT INTO personas (id, name, created_at, updated_at) VALUES ('persona', 'persona', 1, 1)",
      ).run();
      const first = makeItem();
      const other = makeItem();
      repo.enqueue(first)._unsafeUnwrap();
      repo.enqueue(other)._unsafeUnwrap();
      db.prepare(
        "INSERT INTO runs (id, thread_id, persona_id, provider_name, queue_item_id, status, created_at) VALUES ('owned-run', ?, 'persona', 'test', ?, 'running', 1)",
      ).run(threadId, first.id);
      const owned = checkpoint(first.id, { runId: 'owned-run' });
      repo.saveSignalCheckpoint(owned, owned.createdAt)._unsafeUnwrap();
      expect(
        repo
          .saveSignalCheckpoint(
            checkpoint(other.id, {
              runId: 'owned-run',
              createdAt: owned.createdAt,
              expiresAt: owned.expiresAt,
            }),
            Date.now(),
          )
          ._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'IDENTITY_MISMATCH' });
      // Simulate persisted input corruption, not a repository-generated transition.
      db.prepare('UPDATE queue_items SET payload = ? WHERE id = ?').run(
        JSON.stringify({
          [SIGNAL_DELIVERY_CHECKPOINT_KEY]: checkpoint(other.id, { runId: 'owned-run' }),
        }),
        other.id,
      );
      expect(repo.inspectSignalDelivery(other.id, Date.now() + 1)._unsafeUnwrapErr()).toMatchObject(
        { reason: 'IDENTITY_MISMATCH' },
      );
      expect(repo.recoverSignalQueue(Date.now() + 2)._unsafeUnwrap().invalid).toBe(1);
      expect(db.prepare("SELECT status FROM runs WHERE id = 'owned-run'").get()).toEqual({
        status: 'running',
      });
    });

    it('default purge cancels a deferred background delivery without changing its completed task', () => {
      const saved = prepare({ kind: 'background' });
      const ownership = begin(saved);
      const ready = repo
        .settleSignalChunk(
          ownership,
          { kind: 'deferred', failure: failure(saved) },
          saved.createdAt + 1,
        )
        ._unsafeUnwrap();
      repo.deferSignalDelivery(ready, 1_000, saved.createdAt + 1)._unsafeUnwrap();
      db.prepare(
        `INSERT INTO background_tasks (id, persona_id, thread_id, channel_id, prompt, status, output, created_at, started_at, completed_at)
        VALUES ('background', 'persona', ?, 'channel', 'fixture', 'completed', 'output', 1, 1, 2)`,
      ).run(threadId);
      const before = db.prepare("SELECT * FROM background_tasks WHERE id = 'background'").get();
      expect(repo.purge(['pending', 'failed', 'completed'])._unsafeUnwrap()).toBe(1);
      expect(db.prepare("SELECT * FROM background_tasks WHERE id = 'background'").get()).toEqual(
        before,
      );
      expect(
        new SignalDestinationLeaseRepository(db)
          .find(saved.accountUuid, saved.destination)
          ._unsafeUnwrap(),
      ).toBeNull();
      expect(
        repo.deferSignalDelivery(ready, 1_000, saved.createdAt + 1)._unsafeUnwrapErr(),
      ).toBeInstanceOf(DeliveryCancelled);
    });

    it('rolls back purge cancellation, references and lease cascade on deletion failure', () => {
      db.prepare(
        "INSERT INTO personas (id, name, created_at, updated_at) VALUES ('persona', 'persona', 1, 1)",
      ).run();
      const saved = prepare();
      const ownership = begin(saved);
      db.prepare(
        "INSERT INTO runs (id, thread_id, persona_id, provider_name, queue_item_id, status, created_at) VALUES ('run', ?, 'persona', 'test', ?, 'running', 1)",
      ).run(threadId, saved.queueItemId);
      db.exec(`CREATE TRIGGER fail_queue_delete BEFORE DELETE ON queue_items
        BEGIN SELECT RAISE(ABORT, 'private identifier and text'); END`);
      const failure = repo.purge(['pending'])._unsafeUnwrapErr();
      expect(failure.message).not.toMatch(/private|identifier|text/);
      expect(failure.cause).toBeUndefined();
      expect(
        db.prepare("SELECT status, queue_item_id, ended_at FROM runs WHERE id = 'run'").get(),
      ).toEqual({ status: 'running', queue_item_id: saved.queueItemId, ended_at: null });
      expect(new SignalDestinationLeaseRepository(db).validateOwner(ownership.lease).isOk()).toBe(
        true,
      );
      expect(repo.findById(saved.queueItemId)._unsafeUnwrap()).not.toBeNull();
    });

    it('rejects replay at dispatch for standalone or invalid guards, releasing only its leases and reservations', () => {
      const saved = prepare();
      const ownership = begin(saved);
      db.prepare('UPDATE queue_items SET payload = ? WHERE id = ?').run(
        JSON.stringify({ [SIGNAL_DELIVERY_CHECKPOINT_KEY]: null }),
        saved.queueItemId,
      );
      repo.rejectSignalReplay(saved.queueItemId, saved.createdAt + 1)._unsafeUnwrap();
      expect(repo.findById(saved.queueItemId)._unsafeUnwrap()).toMatchObject({
        status: 'dead_letter',
        error: 'CHECKPOINT_INVALID',
      });
      expect(
        new SignalDestinationLeaseRepository(db)
          .find(saved.accountUuid, saved.destination)
          ._unsafeUnwrap(),
      ).toBeNull();
      expect(
        new SignalAccountStateRepository(db).findByAccount(saved.accountUuid)._unsafeUnwrap(),
      ).toMatchObject({ reservation: null, recoveryNotBefore: saved.createdAt + 60_001 });
      expect(
        repo
          .settleSignalChunk(ownership, { kind: 'accepted', successCount: 1 }, saved.createdAt + 2)
          .isErr(),
      ).toBe(true);
      const valid = prepare();
      expect(
        repo.rejectSignalReplay(valid.queueItemId, valid.createdAt)._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'CONFLICT' });
      expect(repo.findById(valid.queueItemId)._unsafeUnwrap()?.status).toBe('pending');
    });

    it.each(['rate_limit', 'challenge'] as const)(
      'unknown settlement preserves an existing %s restriction and never resumes that delivery',
      (kind) => {
        const saved = prepare();
        const ownership = begin(saved);
        const accounts = new SignalAccountStateRepository(db);
        accounts
          .recordPause(
            saved.accountUuid,
            ownership.account.revision,
            kind === 'challenge' ? { kind } : { kind, notBefore: saved.expiresAt + 1_000 },
            saved.createdAt + 1,
          )
          ._unsafeUnwrap();
        const terminal = repo
          .settleSignalChunk(
            ownership,
            { kind: 'terminal', failure: failure(saved, true) },
            saved.createdAt + 2,
          )
          ._unsafeUnwrap();
        expect(terminal).toMatchObject({ phase: 'terminal', terminalOutcome: 'UNKNOWN' });
        expect(accounts.findByAccount(saved.accountUuid)._unsafeUnwrap()).toMatchObject({
          pauseKind: kind,
          reservation: null,
          recoveryNotBefore: saved.createdAt + 60_002,
        });
        expect(repo.beginSignalChunk(terminal, 0, saved.createdAt + 99_999).isErr()).toBe(true);
      },
    );

    it('rejects partial current-chunk retries but permits a proven-unwritten tail after an accepted chunk', () => {
      const saved = prepare();
      const first = repo
        .settleSignalChunk(begin(saved), { kind: 'accepted', successCount: 2 }, saved.createdAt + 1)
        ._unsafeUnwrap();
      const tail = begin(first, saved.createdAt + 1_000);
      const deferred = repo
        .settleSignalChunk(
          tail,
          { kind: 'deferred', failure: failure(first) },
          saved.createdAt + 1_001,
        )
        ._unsafeUnwrap();
      expect(deferred).toMatchObject({ nextChunk: 1, successCount: 2, phase: 'ready' });
      const active = begin(deferred, saved.createdAt + 2_000);
      const partial = new SignalDeliveryError({
        reason: 'PARTIAL_ACCEPTANCE',
        outcome: 'PARTIAL',
        acceptedChunks: 1,
        currentChunkAcceptance: 'partial',
        successCount: 3,
        failureCount: 1,
        retryScope: 'delivery_only',
      });
      expect(
        repo
          .settleSignalChunk(
            active,
            { kind: 'deferred', failure: partial },
            saved.createdAt + 2_001,
          )
          .isErr(),
      ).toBe(true);
      expect(
        repo
          .settleSignalChunk(
            active,
            { kind: 'terminal', failure: partial },
            saved.createdAt + 2_001,
          )
          ._unsafeUnwrap(),
      ).toMatchObject({ phase: 'terminal', nextChunk: 1, successCount: 3 });
      expect(
        new SignalDestinationLeaseRepository(db)
          .find(saved.accountUuid, saved.destination)
          ._unsafeUnwrap(),
      ).toBeNull();
    });

    it('rolls back the entire recovery, including reservation fences, on a later terminal run-write failure', () => {
      const saved = prepare();
      const ownership = begin(saved);
      const guarded = makeItem({
        payload: JSON.stringify({ [SIGNAL_DELIVERY_STARTED_KEY]: null }),
      });
      repo.enqueue(guarded)._unsafeUnwrap();
      db.exec(`CREATE TRIGGER fail_terminal_status BEFORE UPDATE OF status ON queue_items WHEN NEW.status = 'dead_letter'
        BEGIN SELECT RAISE(ABORT, 'private state'); END`);
      expect(repo.recoverSignalQueue(saved.createdAt + 1)._unsafeUnwrapErr()).toMatchObject({
        reason: 'DATABASE',
      });
      expect(
        new SignalAccountStateRepository(db).findByAccount(saved.accountUuid)._unsafeUnwrap(),
      ).toEqual(ownership.account);
      expect(
        repo.inspectSignalDelivery(saved.queueItemId, saved.createdAt + 1)._unsafeUnwrap(),
      ).toEqual({ kind: 'checkpoint', checkpoint: ownership.checkpoint });
    });

    it('fails closed for malformed markers/checkpoints, expired saved text and interrupted chunks without reservations', () => {
      const invalid = makeItem({
        payload: JSON.stringify({ [SIGNAL_DELIVERY_STARTED_KEY]: null }),
      });
      repo.enqueue(invalid)._unsafeUnwrap();
      expect(repo.inspectSignalDelivery(invalid.id, Date.now()).isErr()).toBe(true);
      const expired = prepare({ createdAt: 1, expiresAt: 1 + SIGNAL_CHECKPOINT_LIFETIME_MS });
      const interrupted = prepare();
      db.prepare('UPDATE queue_items SET payload = ? WHERE id = ?').run(
        JSON.stringify({
          [SIGNAL_DELIVERY_CHECKPOINT_KEY]: {
            ...interrupted,
            phase: 'in_flight',
            currentChunkAcceptance: 'unknown',
          },
        }),
        interrupted.queueItemId,
      );
      const now = interrupted.createdAt + 1;
      const recovery = repo.recoverSignalQueue(now)._unsafeUnwrap();
      expect(recovery).toMatchObject({ terminal: 2, invalid: 1 });
      expect(repo.inspectSignalDelivery(expired.queueItemId, now)._unsafeUnwrap()).toMatchObject({
        kind: 'checkpoint',
        checkpoint: { phase: 'terminal', terminalReason: 'CHECKPOINT_EXPIRED' },
      });
      expect(
        new SignalAccountStateRepository(db).findByAccount(interrupted.accountUuid)._unsafeUnwrap(),
      ).toMatchObject({ recoveryNotBefore: now + 60_000 });
      expect(repo.findById(invalid.id)._unsafeUnwrap()).toMatchObject({
        status: 'dead_letter',
        error: 'CHECKPOINT_INVALID',
      });
    });
  });

  it('keeps ordinary queue construction, selectors, retry, purge and recovery usable without Signal tables', () => {
    const legacy = new Database(':memory:');
    try {
      legacy.exec(`CREATE TABLE queue_items (id TEXT PRIMARY KEY, thread_id TEXT, message_id TEXT, type TEXT, status TEXT,
        attempts INTEGER, max_attempts INTEGER, next_retry_at INTEGER, error TEXT, payload TEXT, claimed_at INTEGER, created_at INTEGER, updated_at INTEGER);
        CREATE TABLE runs (queue_item_id TEXT); CREATE TABLE a2a_tasks (queue_item_id TEXT);`);
      const ordinary = new QueueRepository(legacy);
      const first = makeItem();
      const second = makeItem();
      ordinary.enqueue(first)._unsafeUnwrap();
      ordinary.enqueue(second)._unsafeUnwrap();
      ordinary.fail(first.id, 'ordinary failure', Date.now() + 60_000)._unsafeUnwrap();
      expect(
        ordinary
          .findPending()
          ._unsafeUnwrap()
          .map((row) => row.id),
      ).toEqual([second.id]);
      expect(ordinary.claimNext(threadId)._unsafeUnwrap()?.id).toBe(second.id);
      expect(ordinary.recoverSignalQueue(Date.now())._unsafeUnwrap()).toMatchObject({
        ordinaryReset: 1,
        reservationsClassified: 0,
      });
      expect(ordinary.purge(['failed', 'pending'])._unsafeUnwrap()).toBe(2);
    } finally {
      legacy.close();
    }
  });

  describe('enqueue', () => {
    it('enqueues an item with status=pending', () => {
      const input = makeItem();
      const result = repo.enqueue(input);
      expect(result.isOk()).toBe(true);
      const row = result._unsafeUnwrap();
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(0);
      expect(row.claimed_at).toBeNull();
    });
  });

  describe('claimNext', () => {
    it('claims the oldest pending item for a thread', () => {
      const a = makeItem();
      const b = makeItem();
      repo.enqueue(a);
      repo.enqueue(b);

      const result = repo.claimNext(threadId);
      expect(result.isOk()).toBe(true);
      const row = result._unsafeUnwrap();
      expect(row).not.toBeNull();
      expect(row!.status).toBe('claimed');
      expect(row!.id).toBe(a.id); // oldest first
    });

    it('returns null when no pending items exist', () => {
      const result = repo.claimNext(threadId);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('does not claim an item whose next_retry_at is in the future', () => {
      const input = makeItem();
      repo.enqueue(input);
      // Fail it to set a future retry time.
      repo.claimNext(threadId);
      repo.fail(input.id, 'transient error', Date.now() + 60_000);

      const result = repo.claimNext(threadId);
      expect(result._unsafeUnwrap()).toBeNull();
    });
  });

  describe('complete', () => {
    it('sets status to completed', () => {
      const input = makeItem();
      repo.enqueue(input);
      repo.claimNext(threadId);
      repo.complete(input.id);

      const row = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(input.id) as {
        status: string;
      };
      expect(row.status).toBe('completed');
    });
  });

  describe('fail', () => {
    it('increments attempts and sets failed status with retry time', () => {
      const input = makeItem({ max_attempts: 3 });
      repo.enqueue(input);
      repo.claimNext(threadId);

      const retryAt = Date.now() + 5000;
      repo.fail(input.id, 'oops', retryAt);

      const row = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(input.id) as {
        status: string;
        attempts: number;
        next_retry_at: number;
        error: string;
      };
      expect(row.status).toBe('failed');
      expect(row.attempts).toBe(1);
      expect(row.next_retry_at).toBe(retryAt);
      expect(row.error).toBe('oops');
    });

    it('moves to dead_letter when max_attempts is reached', () => {
      const input = makeItem({ max_attempts: 1 });
      repo.enqueue(input);
      repo.claimNext(threadId);
      repo.fail(input.id, 'fatal', Date.now() + 1000);

      const row = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(input.id) as {
        status: string;
      };
      expect(row.status).toBe('dead_letter');
    });

    it('returns err for unknown id', () => {
      expect(repo.fail(uuid(), 'err', Date.now() + 1000).isErr()).toBe(true);
    });
  });

  describe('markDeadLetter', () => {
    it('sets status to dead_letter', () => {
      const input = makeItem();
      repo.enqueue(input);
      repo.markDeadLetter(input.id, 'manual DLQ');

      const row = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(input.id) as {
        status: string;
        error: string;
      };
      expect(row.status).toBe('dead_letter');
      expect(row.error).toBe('manual DLQ');
    });
  });

  describe('findPending', () => {
    it('returns items with elapsed retry times', () => {
      const a = makeItem();
      repo.enqueue(a);
      const rows = repo.findPending()._unsafeUnwrap();
      expect(rows.some((r) => r.id === a.id)).toBe(true);
    });

    it('excludes completed and dead-letter items', () => {
      const a = makeItem();
      const b = makeItem();
      repo.enqueue(a);
      repo.enqueue(b);
      repo.claimNext(threadId);
      repo.complete(a.id);
      repo.markDeadLetter(b.id, 'dead');

      const rows = repo.findPending()._unsafeUnwrap();
      expect(rows.every((r) => r.status !== 'completed' && r.status !== 'dead_letter')).toBe(true);
    });
  });

  describe('findDeadLetter', () => {
    it('returns dead-letter items', () => {
      const a = makeItem();
      repo.enqueue(a);
      repo.markDeadLetter(a.id, 'gone');
      const rows = repo.findDeadLetter()._unsafeUnwrap();
      expect(rows.some((r) => r.id === a.id)).toBe(true);
    });
  });

  describe('countByStatus', () => {
    it('returns counts grouped by status', () => {
      // Enqueue 3 items.
      const a = makeItem();
      const b = makeItem();
      repo.enqueue(a);
      repo.enqueue(b);
      repo.enqueue(makeItem());

      // Claim the oldest (a), then complete it — leaving b and the third as pending.
      repo.claimNext(threadId);
      repo.complete(a.id);

      const counts = repo.countByStatus()._unsafeUnwrap();
      // 2 items remain in pending, 1 completed.
      expect(counts['pending']).toBeGreaterThanOrEqual(2);
      expect(counts['completed']).toBeGreaterThanOrEqual(1);
    });
  });

  describe('purge', () => {
    it('returns ok(0) and deletes nothing when given an empty array', () => {
      const a = makeItem();
      repo.enqueue(a);

      const result = repo.purge([]);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe(0);

      // Item should still exist.
      const row = repo.findById(a.id)._unsafeUnwrap();
      expect(row).not.toBeNull();
    });

    it('deletes only items matching the specified statuses', () => {
      const pending1 = makeItem();
      const pending2 = makeItem();
      const completed1 = makeItem();
      repo.enqueue(pending1);
      repo.enqueue(pending2);
      repo.enqueue(completed1);

      // Move completed1 through claimed -> completed.
      repo.claimNext(threadId);
      repo.complete(pending1.id);

      // Now pending1 is completed, pending2 and completed1 are pending.
      // Purge only completed items.
      const result = repo.purge(['completed']);
      expect(result._unsafeUnwrap()).toBe(1);

      // The completed item should be gone.
      expect(repo.findById(pending1.id)._unsafeUnwrap()).toBeNull();
      // The pending items should remain.
      expect(repo.findById(pending2.id)._unsafeUnwrap()).not.toBeNull();
      expect(repo.findById(completed1.id)._unsafeUnwrap()).not.toBeNull();
    });

    it('returns the correct count of deleted items', () => {
      // Create 3 items and complete all of them.
      const items = [makeItem(), makeItem(), makeItem()];
      for (const item of items) {
        repo.enqueue(item);
      }
      for (const item of items) {
        repo.claimNext(threadId);
        repo.complete(item.id);
      }

      const result = repo.purge(['completed']);
      expect(result._unsafeUnwrap()).toBe(3);
    });

    it('purges items across multiple statuses in a single call', () => {
      const a = makeItem();
      const b = makeItem();
      const c = makeItem();
      const d = makeItem();
      repo.enqueue(a);
      repo.enqueue(b);
      repo.enqueue(c);
      repo.enqueue(d);

      // a -> completed
      repo.claimNext(threadId);
      repo.complete(a.id);

      // b -> dead_letter
      repo.markDeadLetter(b.id, 'permanent failure');

      // c, d remain pending.

      const result = repo.purge(['completed', 'dead_letter']);
      expect(result._unsafeUnwrap()).toBe(2);

      expect(repo.findById(a.id)._unsafeUnwrap()).toBeNull();
      expect(repo.findById(b.id)._unsafeUnwrap()).toBeNull();
      expect(repo.findById(c.id)._unsafeUnwrap()).not.toBeNull();
      expect(repo.findById(d.id)._unsafeUnwrap()).not.toBeNull();
    });

    it('returns ok(0) when no items match the given statuses', () => {
      const a = makeItem();
      repo.enqueue(a); // status = pending

      const result = repo.purge(['completed', 'dead_letter']);
      expect(result._unsafeUnwrap()).toBe(0);

      // The pending item should be untouched.
      expect(repo.findById(a.id)._unsafeUnwrap()).not.toBeNull();
    });

    it('leaves remaining items fully queryable after purge', () => {
      const toRemove = makeItem();
      const toKeep = makeItem();
      repo.enqueue(toRemove);
      repo.enqueue(toKeep);

      // claimNext claims oldest first (toRemove), then complete it.
      repo.claimNext(threadId);
      repo.complete(toRemove.id);

      // toRemove is now completed, toKeep is still pending.
      repo.purge(['completed']);

      // toKeep is still pending and queryable.
      const row = repo.findById(toKeep.id)._unsafeUnwrap();
      expect(row).not.toBeNull();
      expect(row!.status).toBe('pending');

      // toRemove is gone.
      expect(repo.findById(toRemove.id)._unsafeUnwrap()).toBeNull();

      // countByStatus should still work correctly.
      const counts = repo.countByStatus()._unsafeUnwrap();
      expect(counts['pending']).toBeGreaterThanOrEqual(1);
      expect(counts['completed']).toBeUndefined();
    });
  });

  describe('summarizeSavedSignalDeliveries', () => {
    const statuses: readonly QueueStatus[] = [
      'pending',
      'failed',
      'claimed',
      'processing',
      'completed',
      'dead_letter',
    ];

    function prepare(overrides: Partial<SignalDeliveryCheckpoint> = {}): SignalDeliveryCheckpoint {
      const item = makeItem();
      repo.enqueue(item)._unsafeUnwrap();
      const saved = checkpoint(item.id, overrides);
      return repo.saveSignalCheckpoint(saved, saved.createdAt)._unsafeUnwrap();
    }

    function begin(saved: SignalDeliveryCheckpoint) {
      const accounts = new SignalAccountStateRepository(db);
      const account = accounts.getOrCreate(saved.accountUuid, saved.createdAt)._unsafeUnwrap();
      return repo.beginSignalChunk(saved, account.revision, saved.createdAt)._unsafeUnwrap();
    }

    function deliver(): SignalDeliveryCheckpoint {
      const saved = prepare({ chunks: ['firstsecond'] });
      return repo
        .settleSignalChunk(begin(saved), { kind: 'accepted', successCount: 1 }, saved.createdAt)
        ._unsafeUnwrap();
    }

    function terminate(reason: (typeof SIGNAL_DELIVERY_REASONS)[number]): SignalDeliveryCheckpoint {
      const saved = prepare();
      return repo
        .terminateSignalDelivery(
          saved,
          new SignalDeliveryError({
            reason,
            outcome: 'NOT_SENT',
            acceptedChunks: 0,
            currentChunkAcceptance: 'unwritten',
            successCount: 0,
            failureCount: 0,
            retryScope: 'none',
          }),
          saved.createdAt,
        )
        ._unsafeUnwrap();
    }

    function setStatus(id: string, status: QueueStatus): void {
      db.prepare('UPDATE queue_items SET status = ? WHERE id = ?').run(status, id);
    }

    function storedState(): unknown[] {
      return [
        'queue_items',
        'runs',
        'signal_account_state',
        'signal_destination_leases',
        'messages',
        'audit_log',
        'background_tasks',
      ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    }

    it('counts real deferred, claimed and behind-head saved work when eligibility returns nothing', () => {
      const head = prepare();
      repo.deferSignalDelivery(head, 60_000, head.createdAt)._unsafeUnwrap();
      const active = prepare({ kind: 'background' });
      setStatus(active.queueItemId, 'claimed');
      prepare();
      const ordinary = makeItem();
      repo.enqueue(ordinary)._unsafeUnwrap();
      repo.fail(ordinary.id, 'ordinary failure', Date.now() + 60_000)._unsafeUnwrap();
      expect(repo.findPending(head.createdAt)._unsafeUnwrap()).toEqual([]);
      expect(repo.countByStatus()._unsafeUnwrap()).toMatchObject({
        failed: 2,
        claimed: 1,
        pending: 1,
      });
      expect(repo.summarizeSavedSignalDeliveries()._unsafeUnwrap()).toEqual({
        pending: 3,
        terminal: 0,
        reasons: [],
      });
    });

    describe.each(['ready', 'in_flight', 'delivered'] as const)('%s phase', (phase) => {
      it.each(['pending', 'failed', 'claimed', 'processing'] as const)(
        'counts unfinished %s work even after expiry without performing recovery or writes',
        (status) => {
          const initial = phase === 'delivered' ? deliver() : prepare({ kind: 'background' });
          const saved = phase === 'in_flight' ? begin(initial).checkpoint : initial;
          setStatus(saved.queueItemId, status);
          const before = storedState();
          const changes = db.prepare('SELECT total_changes() AS count').get();
          db.pragma('query_only = ON');
          try {
            expect(repo.summarizeSavedSignalDeliveries(saved.expiresAt + 1)._unsafeUnwrap()).toEqual({
              pending: 1,
              terminal: 0,
              reasons: [],
            });
            expect(storedState()).toEqual(before);
            expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
          } finally {
            db.pragma('query_only = OFF');
          }
        },
      );
    });

    it('keeps delivered local-finalization failures pending, excludes successful completion, then respects purge', () => {
      const saved = deliver();
      const localFailure = new SignalStateError('DATABASE');
      expect(
        repo
          .finalizeSignalDelivery(saved, () => err(localFailure), saved.createdAt)
          ._unsafeUnwrapErr(),
      ).toBe(localFailure);
      repo.deferSignalDelivery(saved, 60_000, saved.expiresAt + 1)._unsafeUnwrap();
      expect(repo.summarizeSavedSignalDeliveries(saved.expiresAt + 2)._unsafeUnwrap()).toEqual({
        pending: 1,
        terminal: 0,
        reasons: [],
      });
      repo.finalizeSignalDelivery(saved, () => ok(undefined), saved.expiresAt + 2)._unsafeUnwrap();
      expect(repo.summarizeSavedSignalDeliveries(saved.expiresAt + 3)._unsafeUnwrap()).toEqual({
        pending: 0,
        terminal: 0,
        reasons: [],
      });
      expect(repo.purge(['completed'])._unsafeUnwrap()).toBe(1);
      expect(repo.summarizeSavedSignalDeliveries()._unsafeUnwrap()).toEqual({
        pending: 0,
        terminal: 0,
        reasons: [],
      });
    });

    it('groups all actual fixed terminal reasons deterministically until purge, never queue error text', () => {
      for (const reason of [...SIGNAL_DELIVERY_REASONS].reverse()) terminate(reason);
      terminate('UNKNOWN_ACCEPTANCE');
      prepare();
      const ordinary = makeItem();
      repo.enqueue(ordinary)._unsafeUnwrap();
      repo.markDeadLetter(ordinary.id, 'PRIVATE_BODY_AND_SIGNAL_ID')._unsafeUnwrap();
      const summary = repo.summarizeSavedSignalDeliveries()._unsafeUnwrap();
      expect(summary).toEqual({
        pending: 1,
        terminal: SIGNAL_DELIVERY_REASONS.length + 1,
        reasons: SIGNAL_DELIVERY_REASONS.map((reason) => ({
          reason,
          count: reason === 'UNKNOWN_ACCEPTANCE' ? 2 : 1,
        })),
      });
      expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|aaaaaaaa|firstsecond|delivery-/);
      expect(repo.purge(['dead_letter'])._unsafeUnwrap()).toBe(SIGNAL_DELIVERY_REASONS.length + 2);
      expect(repo.summarizeSavedSignalDeliveries()._unsafeUnwrap()).toEqual({
        pending: 1,
        terminal: 0,
        reasons: [],
      });
      repo.purge(['pending'])._unsafeUnwrap();
      expect(repo.summarizeSavedSignalDeliveries()._unsafeUnwrap()).toEqual({
        pending: 0,
        terminal: 0,
        reasons: [],
      });
    });

    it.each(['PARTIAL', 'UNKNOWN'] as const)(
      'counts actual %s chunk settlement without changing its reservation classification',
      (outcome) => {
        const saved = prepare();
        const active = begin(saved);
        const terminal = repo
          .settleSignalChunk(
            active,
            {
              kind: 'terminal',
              failure: new SignalDeliveryError({
                reason: outcome === 'PARTIAL' ? 'PARTIAL_ACCEPTANCE' : 'UNKNOWN_ACCEPTANCE',
                outcome,
                acceptedChunks: 0,
                currentChunkAcceptance: outcome === 'PARTIAL' ? 'partial' : 'unknown',
                successCount: outcome === 'PARTIAL' ? 1 : 0,
                failureCount: 1,
                retryScope: 'none',
              }),
            },
            saved.createdAt,
          )
          ._unsafeUnwrap();
        const before = storedState();
        expect(repo.summarizeSavedSignalDeliveries()._unsafeUnwrap()).toEqual({
          pending: 0,
          terminal: 1,
          reasons: [{ reason: terminal.terminalReason, count: 1 }],
        });
        expect(storedState()).toEqual(before);
      },
    );

    it.each(statuses)('retains validated terminal work even with generic %s status', (status) => {
      const saved = terminate('TARGET_REFUSED');
      if (status === 'completed') repo.complete(saved.queueItemId)._unsafeUnwrap();
      else setStatus(saved.queueItemId, status);
      const before = storedState();
      expect(repo.summarizeSavedSignalDeliveries()._unsafeUnwrap()).toEqual({
        pending: 0,
        terminal: 1,
        reasons: [{ reason: 'TARGET_REFUSED', count: 1 }],
      });
      expect(storedState()).toEqual(before);
    });

    it.each([
      ['ready', 'completed'],
      ['in_flight', 'completed'],
      ['ready', 'dead_letter'],
      ['in_flight', 'dead_letter'],
      ['delivered', 'dead_letter'],
    ] as const)(
      'refuses generic %s + %s inconsistency without repair or false totals',
      (phase, status) => {
        const initial = phase === 'delivered' ? deliver() : prepare();
        const saved = phase === 'in_flight' ? begin(initial).checkpoint : initial;
        if (status === 'completed') repo.complete(saved.queueItemId)._unsafeUnwrap();
        else repo.markDeadLetter(saved.queueItemId, 'PRIVATE_BODY_AND_SIGNAL_ID')._unsafeUnwrap();
        const before = storedState();
        const failure = repo.summarizeSavedSignalDeliveries()._unsafeUnwrapErr();
        expect(failure).toBeInstanceOf(SignalCheckpointError);
        expect(failure).toMatchObject({ reason: 'INVALID', cause: undefined });
        expect(failure.message).not.toMatch(/PRIVATE|aaaaaaaa|firstsecond|delivery-/);
        expect(storedState()).toEqual(before);
      },
    );

    it('refuses an unknown persisted queue status without exposing it or inventing a lifecycle state', () => {
      const saved = terminate('TARGET_REFUSED');
      db.pragma('ignore_check_constraints = ON');
      db.prepare("UPDATE queue_items SET status = 'PRIVATE_BODY_AND_SIGNAL_ID' WHERE id = ?").run(
        saved.queueItemId,
      );
      db.pragma('ignore_check_constraints = OFF');
      const before = storedState();
      const failure = repo.summarizeSavedSignalDeliveries()._unsafeUnwrapErr();
      expect(failure).toBeInstanceOf(SignalCheckpointError);
      expect(failure).toMatchObject({ reason: 'INVALID', cause: undefined });
      expect(failure.message).not.toContain('PRIVATE');
      expect(storedState()).toEqual(before);
    });

    it('can summarize ordinary legacy queues without Signal tables or a full run schema', () => {
      const legacy = new Database(':memory:');
      try {
        legacy.exec(`CREATE TABLE queue_items (id TEXT PRIMARY KEY, thread_id TEXT, message_id TEXT, type TEXT, status TEXT,
            attempts INTEGER, max_attempts INTEGER, next_retry_at INTEGER, error TEXT, payload TEXT, claimed_at INTEGER, created_at INTEGER, updated_at INTEGER);`);
        const ordinary = new QueueRepository(legacy);
        ordinary.enqueue(makeItem({ payload: 'not json' }))._unsafeUnwrap();
        expect(ordinary.summarizeSavedSignalDeliveries()._unsafeUnwrap()).toEqual({
          pending: 0,
          terminal: 0,
          reasons: [],
        });
      } finally {
        legacy.close();
      }
    });

    it.each(statuses)(
      'excludes ordinary and standalone invocation markers in %s status',
      (status) => {
        const ordinary = makeItem();
        const invoked = makeItem();
        repo.enqueue(ordinary)._unsafeUnwrap();
        repo.enqueue(invoked)._unsafeUnwrap();
        repo
          .markSignalDeliveryStarted(
            {
              version: 1,
              queueItemId: invoked.id,
              deliveryId: 'explicit-operation',
              purpose: 'explicit',
              startedAt: 1,
            },
            null,
            Date.now(),
          )
          ._unsafeUnwrap();
        setStatus(ordinary.id, status);
        setStatus(invoked.id, status);
        const before = storedState();
        expect(repo.summarizeSavedSignalDeliveries()._unsafeUnwrap()).toEqual({
          pending: 0,
          terminal: 0,
          reasons: [],
        });
        expect(storedState()).toEqual(before);
      },
    );

    it.each([
      'not json',
      'null',
      '[]',
      '42',
      '"legacy"',
      JSON.stringify({
        text: SIGNAL_DELIVERY_STARTED_KEY,
        nested: { [SIGNAL_DELIVERY_CHECKPOINT_KEY]: null },
      }),
    ])('preserves legacy ordinary payload bytes: %s', (payload) => {
      repo.enqueue(makeItem({ payload }))._unsafeUnwrap();
      const before = storedState();
      expect(repo.summarizeSavedSignalDeliveries()._unsafeUnwrap()).toEqual({
        pending: 0,
        terminal: 0,
        reasons: [],
      });
      expect(storedState()).toEqual(before);
    });

    it.each([
      '{"__talond_sig',
      String.raw`{"\u005f\u005ftalond_signal_delivery_v1":`,
      JSON.stringify({ [SIGNAL_DELIVERY_CHECKPOINT_KEY]: null }),
      JSON.stringify({ [SIGNAL_DELIVERY_CHECKPOINT_KEY]: { phase: 'ready' } }),
      JSON.stringify({ [SIGNAL_DELIVERY_STARTED_KEY]: null }),
      '[] /* __talond_signal_delivery_v1 */',
    ])('returns actual safe typed error for invalid reserved payload: %s', (payload) => {
      prepare(); // A valid saved row must not turn a later corrupt row into partial/healthy totals.
      repo.enqueue(makeItem({ payload }))._unsafeUnwrap();
      const before = storedState();
      const failure = repo.summarizeSavedSignalDeliveries()._unsafeUnwrapErr();
      expect(failure).toBeInstanceOf(SignalCheckpointError);
      expect(failure).toMatchObject({ reason: 'INVALID', cause: undefined });
      expect(storedState()).toEqual(before);
    });

    it.each(['completed', 'dead_letter'] as const)(
      'does not hide corrupt reserved state in retained %s rows',
      (status) => {
        const saved = prepare();
        db.prepare('UPDATE queue_items SET status = ?, payload = ? WHERE id = ?').run(
          status,
          JSON.stringify({ [SIGNAL_DELIVERY_CHECKPOINT_KEY]: null }),
          saved.queueItemId,
        );
        const before = storedState();
        expect(repo.summarizeSavedSignalDeliveries()._unsafeUnwrapErr()).toBeInstanceOf(
          SignalCheckpointError,
        );
        expect(storedState()).toEqual(before);
      },
    );

    it('preserves the exact underlying validation error instance from real reserved bytes', () => {
      repo
        .enqueue(makeItem({ payload: JSON.stringify({ [SIGNAL_DELIVERY_CHECKPOINT_KEY]: null }) }))
        ._unsafeUnwrap();
      const inspect = vi.spyOn(signalDeliveryState, 'inspectSignalDeliveryState');
      try {
        const result = repo.summarizeSavedSignalDeliveries();
        expect(inspect).toHaveBeenCalledOnce();
        const underlying = inspect.mock.results[0]?.value;
        expect(underlying).toBeDefined();
        expect(result._unsafeUnwrapErr()).toBe(underlying?._unsafeUnwrapErr());
      } finally {
        inspect.mockRestore();
      }
    });

    it('returns the codec size error rather than accepting a raw ready phase', () => {
      const saved = prepare();
      db.prepare('UPDATE queue_items SET payload = ? WHERE id = ?').run(
        JSON.stringify({
          [SIGNAL_DELIVERY_CHECKPOINT_KEY]: {
            ...saved,
            personaId: 'p'.repeat(SIGNAL_CHECKPOINT_MAX_BYTES),
          },
        }),
        saved.queueItemId,
      );
      const before = storedState();
      const failure = repo.summarizeSavedSignalDeliveries()._unsafeUnwrapErr();
      expect(failure).toBeInstanceOf(SignalCheckpointError);
      expect(failure).toMatchObject({ reason: 'TOO_LARGE', cause: undefined });
      expect(storedState()).toEqual(before);
    });

    it.each(['queueItemId', 'threadId', 'runId', 'terminalReason'] as const)(
      'validates checkpoint %s rather than trusting raw phase labels',
      (field) => {
        const saved = terminate('TARGET_REFUSED');
        db.prepare('UPDATE queue_items SET payload = ? WHERE id = ?').run(
          JSON.stringify({
            [SIGNAL_DELIVERY_CHECKPOINT_KEY]: { ...saved, [field]: 'PRIVATE_BODY_AND_SIGNAL_ID' },
          }),
          saved.queueItemId,
        );
        const before = storedState();
        const failure = repo.summarizeSavedSignalDeliveries()._unsafeUnwrapErr();
        expect(failure).toBeInstanceOf(SignalCheckpointError);
        expect(failure).toMatchObject({
          reason: field === 'terminalReason' ? 'INVALID' : 'IDENTITY_MISMATCH',
          cause: undefined,
        });
        expect(failure.message).not.toContain('PRIVATE');
        expect(storedState()).toEqual(before);
      },
    );

    it('retains active-run identity validation, but allows genuine completed delivered history', () => {
      db.prepare(
        "INSERT INTO personas (id, name, created_at, updated_at) VALUES ('persona', 'persona', 1, 1)",
      ).run();
      const item = makeItem();
      repo.enqueue(item)._unsafeUnwrap();
      db.prepare(
        "INSERT INTO runs (id, thread_id, persona_id, provider_name, queue_item_id, status, created_at) VALUES ('owned-run', ?, 'persona', 'test', ?, 'running', 1)",
      ).run(threadId, item.id);
      const saved = checkpoint(item.id, { runId: 'owned-run', chunks: ['firstsecond'] });
      repo.saveSignalCheckpoint(saved, saved.createdAt)._unsafeUnwrap();
      db.prepare("UPDATE runs SET status = 'completed' WHERE id = 'owned-run'").run();
      const before = storedState();
      expect(repo.summarizeSavedSignalDeliveries()._unsafeUnwrapErr()).toMatchObject({
        reason: 'IDENTITY_MISMATCH',
      });
      expect(storedState()).toEqual(before);
      db.prepare("UPDATE runs SET status = 'running' WHERE id = 'owned-run'").run();
      const delivered = repo
        .settleSignalChunk(begin(saved), { kind: 'accepted', successCount: 1 }, saved.createdAt)
        ._unsafeUnwrap();
      repo
        .finalizeSignalDelivery(
          delivered,
          () => {
            db.prepare("UPDATE runs SET status = 'completed' WHERE id = 'owned-run'").run();
            return ok(undefined);
          },
          saved.createdAt,
        )
        ._unsafeUnwrap();
      expect(repo.summarizeSavedSignalDeliveries()._unsafeUnwrap()).toEqual({
        pending: 0,
        terminal: 0,
        reasons: [],
      });
    });

    it.each(['reservation', 'lease'] as const)(
      'fails closed for markerless corruption backed by %s ownership',
      (kind) => {
        const saved = prepare();
        const ownership = begin(saved);
        if (kind === 'lease')
          new SignalAccountStateRepository(db)
            .clearReservation(
              saved.accountUuid,
              ownership.account.revision,
              ownership.reservation,
              saved.createdAt,
            )
            ._unsafeUnwrap();
        db.prepare("UPDATE queue_items SET payload = 'damaged' WHERE id = ?").run(saved.queueItemId);
        const before = storedState();
        const failure = repo.summarizeSavedSignalDeliveries()._unsafeUnwrapErr();
        expect(failure).toBeInstanceOf(SignalCheckpointError);
        expect(failure).toMatchObject({ reason: 'INVALID' });
        expect(storedState()).toEqual(before);
      },
    );

    it('does not invent saved work from a post-purge orphan reservation or classify that reservation', () => {
      const saved = prepare();
      begin(saved);
      repo.purge(['pending'])._unsafeUnwrap();
      const before = storedState();
      expect(repo.summarizeSavedSignalDeliveries()._unsafeUnwrap()).toEqual({
        pending: 0,
        terminal: 0,
        reasons: [],
      });
      expect(storedState()).toEqual(before);
      expect(new SignalAccountStateRepository(db).findReserved()._unsafeUnwrap()).toHaveLength(1);
    });

    it('reads own uncommitted rows on the repository connection without committing the enclosing Result', () => {
      const sentinel = new SignalStateError('CONFLICT');
      const before = storedState();
      const result = runResultTransaction(
        (fn) => repo.transaction(fn),
        () => {
          prepare();
          expect(repo.summarizeSavedSignalDeliveries()._unsafeUnwrap()).toEqual({
            pending: 1,
            terminal: 0,
            reasons: [],
          });
          return err(sentinel);
        },
      );
      expect(result._unsafeUnwrapErr()).toBe(sentinel);
      expect(storedState()).toEqual(before);
    });

    it('shares a consistent WAL snapshot while another connection commits, then reads the new snapshot', async () => {
      const saved = deliver();
      restartDirectory = mkdtempSync(join(tmpdir(), 'talon-summary-snapshot-'));
      const filename = join(restartDirectory, 'queue.sqlite');
      await db.backup(filename);
      db.close();
      db = new Database(filename);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      repo = new QueueRepository(db);
      const otherDb = new Database(filename);
      otherDb.pragma('foreign_keys = ON');
      try {
        const other = new QueueRepository(otherDb);
        repo.transaction(() => {
          expect(repo.summarizeSavedSignalDeliveries()._unsafeUnwrap()).toEqual({
            pending: 1,
            terminal: 0,
            reasons: [],
          });
          other.finalizeSignalDelivery(saved, () => ok(undefined), saved.createdAt)._unsafeUnwrap();
          expect(other.summarizeSavedSignalDeliveries()._unsafeUnwrap()).toEqual({
            pending: 0,
            terminal: 0,
            reasons: [],
          });
          expect(repo.summarizeSavedSignalDeliveries()._unsafeUnwrap()).toEqual({
            pending: 1,
            terminal: 0,
            reasons: [],
          });
        });
        expect(repo.summarizeSavedSignalDeliveries()._unsafeUnwrap()).toEqual({
          pending: 0,
          terminal: 0,
          reasons: [],
        });
      } finally {
        otherDb.close();
      }
    });

    it('does not advance the repository ordering clock', () => {
      BaseRepository.__resetMonotonicClockForTests();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
      try {
        const first = repo.enqueue(makeItem())._unsafeUnwrap();
        repo.summarizeSavedSignalDeliveries()._unsafeUnwrap();
        const second = repo.enqueue(makeItem())._unsafeUnwrap();
        expect(second.created_at).toBe(first.created_at + 1);
      } finally {
        clock.mockRestore();
        BaseRepository.__resetMonotonicClockForTests();
      }
    });

    it.each([-1, NaN, Infinity, 1.5])(
      'returns typed INVALID_INPUT for invalid time %s even on an empty queue',
      (now) => {
        const failure = repo.summarizeSavedSignalDeliveries(now)._unsafeUnwrapErr();
        expect(failure).toBeInstanceOf(SignalStateError);
        expect(failure).toMatchObject({ reason: 'INVALID_INPUT', cause: undefined });
      },
    );

    it('returns safe typed DATABASE on genuine SQLite read failure, not a healthy empty summary', () => {
      prepare();
      db.exec('ALTER TABLE queue_items RENAME TO unavailable_queue');
      const failure = repo.summarizeSavedSignalDeliveries()._unsafeUnwrapErr();
      expect(failure).toBeInstanceOf(SignalStateError);
      expect(failure).toMatchObject({ reason: 'DATABASE', cause: undefined });
      expect(failure.message).toBe('Signal state operation failed: DATABASE');
    });
  });
});
