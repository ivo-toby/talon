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
import { QueueRepository } from '../../../../../src/core/database/repositories/queue-repository.js';
import { BaseRepository } from '../../../../../src/core/database/repositories/base-repository.js';
import { ThreadRepository } from '../../../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { createTestDb, uuid } from './helpers.js';
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
});
