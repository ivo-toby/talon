/**
 * Repository for the `queue_items` table.
 *
 * Implements a durable FIFO queue with per-thread ordering, exponential
 * retry with configurable max attempts, and a dead-letter state for items
 * that exhaust all retries.
 */

import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';
import { runResultTransaction } from '../transaction.js';
import {
  DeliveryCancelled,
  SignalDeliveryError,
  SIGNAL_DELIVERY_REASONS,
  type SignalDeliveryReason,
} from '../../errors/error-types.js';
import {
  SignalAccountStateRepository,
  SignalStateError,
  type SignalAccountState,
  type SignalPause,
  type SignalSendReservation,
} from './signal-account-state-repository.js';
import { SignalDestinationLeaseRepository } from './signal-destination-lease-repository.js';
import {
  SIGNAL_DELIVERY_CHECKPOINT_KEY,
  SIGNAL_DELIVERY_STARTED_KEY,
  SIGNAL_CHECKPOINT_MAX_BYTES,
  SignalCheckpointError,
  parseSignalDeliveryCheckpoint,
  parseSignalDeliveryStartedMarker,
  type SignalDeliveryCheckpoint,
  type SignalDeliveryStartedMarker,
} from '../../../queue/signal-delivery-checkpoint.js';
import {
  inspectSignalDeliveryState,
  hasSignalPayloadEvidence,
  parseSignalQueuePayload,
  type SignalChunkOwnership,
  type SignalChunkSettlement,
  type SignalDeliveryState,
  type SignalQueueFailure,
  type SignalQueueRecovery,
} from '../../../queue/signal-delivery-state.js';

const longestSignalDeliveryReason = SIGNAL_DELIVERY_REASONS.reduce((longest, reason) =>
  reason.length > longest.length ? reason : longest,
);

// A malformed reserved value still blocks overtaking until classified fail-closed.
const hasSignalCheckpoint = (alias: string): string =>
  `CASE WHEN json_valid(${alias}.payload) THEN json_type(${alias}.payload, '$.${SIGNAL_DELIVERY_CHECKPOINT_KEY}') IS NOT NULL ELSE 0 END`;
// Saved Signal deadlines use wall time, not the ordering clock which can run ahead after a rewind.
// Generic retry eligibility deliberately retains its existing logical-clock policy.
const retryEligible = (alias: string): string => `(${alias}.next_retry_at IS NULL OR
  ${alias}.next_retry_at <= CASE WHEN ${hasSignalCheckpoint(alias)} THEN @wall_now ELSE @now END)`;
const signalHeadOfLine = (
  alias: string,
): string => `(${alias}.type = 'collaboration' OR NOT EXISTS (
  SELECT 1 FROM queue_items older
  WHERE older.thread_id = ${alias}.thread_id AND older.type != 'collaboration'
    AND older.status IN ('pending', 'failed', 'claimed', 'processing')
    AND (older.created_at < ${alias}.created_at OR (older.created_at = ${alias}.created_at AND older.id < ${alias}.id))
    AND ${hasSignalCheckpoint('older')}
))`;

/** Valid queue item status values. */
export type QueueStatus =
  | 'pending'
  | 'claimed'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'dead_letter';

/** Valid queue item type values. */
export type QueueType = 'message' | 'schedule' | 'collaboration';

/** Row shape matching the `queue_items` table exactly. */
export interface QueueItemRow {
  id: string;
  thread_id: string;
  message_id: string | null;
  type: QueueType;
  status: QueueStatus;
  attempts: number;
  max_attempts: number;
  next_retry_at: number | null;
  error: string | null;
  payload: string;
  claimed_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Fields accepted when enqueueing a new item. */
export type EnqueueInput = Pick<
  QueueItemRow,
  'id' | 'thread_id' | 'message_id' | 'type' | 'payload' | 'max_attempts'
>;

/** Safe current saved-work counts, not eligibility, send authority or a lifetime delivery total. */
export interface SavedSignalDeliverySummary {
  readonly pending: number;
  readonly terminal: number;
  readonly reasons: Array<{ readonly reason: SignalDeliveryReason; readonly count: number }>;
}

interface SignalQueueSnapshot {
  readonly row: QueueItemRow;
  readonly payload: Record<string, unknown>;
  readonly state: SignalDeliveryState;
}

/** Repository for durable queue operations. */
export class QueueRepository extends BaseRepository {
  private readonly enqueueStmt: Database.Statement;
  private readonly claimNextStmt: Database.Statement;
  private readonly completeStmt: Database.Statement;
  private readonly markDeadLetterStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly findPendingStmt: Database.Statement;
  private readonly findDeadLetterStmt: Database.Statement;
  private readonly countByStatusStmt: Database.Statement;
  private readonly hasInflightItemStmt: Database.Statement;
  private readonly claimNextCollaborationStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.enqueueStmt = db.prepare(`
      INSERT INTO queue_items
        (id, thread_id, message_id, type, status, attempts, max_attempts,
         next_retry_at, error, payload, claimed_at, created_at, updated_at)
      VALUES
        (@id, @thread_id, @message_id, @type, 'pending', 0, @max_attempts,
         NULL, NULL, @payload, NULL, @created_at, @updated_at)
    `);

    // Atomically claim the oldest pending/retryable item for a given thread.
    // Uses a sub-select to find the target row and UPDATE to claim it in one
    // statement, preventing races in SQLite's serialized write model.
    this.claimNextStmt = db.prepare(`
      UPDATE queue_items
      SET status = 'claimed', claimed_at = @now, updated_at = @now
      WHERE id = (
        SELECT q.id FROM queue_items q
        WHERE q.thread_id = @thread_id
          AND q.status IN ('pending', 'failed')
          AND ${retryEligible('q')}
          AND ${signalHeadOfLine('q')}
        ORDER BY q.created_at ASC, q.id ASC
        LIMIT 1
      )
      RETURNING *
    `);

    // Atomically claim the oldest pending/retryable collaboration item for a
    // given thread. Used to bypass the per-thread single-inflight invariant
    // when a collaboration item is pending behind a regular item.
    this.claimNextCollaborationStmt = db.prepare(`
      UPDATE queue_items
      SET status = 'claimed', claimed_at = @now, updated_at = @now
      WHERE id = (
        SELECT q.id FROM queue_items q
        WHERE q.thread_id = @thread_id
          AND q.type = 'collaboration'
          AND q.status IN ('pending', 'failed')
          AND ${retryEligible('q')}
        ORDER BY q.created_at ASC
        LIMIT 1
      )
      RETURNING *
    `);

    this.completeStmt = db.prepare(`
      UPDATE queue_items
      SET status = 'completed', updated_at = @now
      WHERE id = @id
    `);

    this.markDeadLetterStmt = db.prepare(`
      UPDATE queue_items
      SET status = 'dead_letter', error = @error, updated_at = @now
      WHERE id = @id
    `);

    this.findByIdStmt = db.prepare(`SELECT * FROM queue_items WHERE id = ?`);

    this.findPendingStmt = db.prepare(`
      SELECT q.* FROM queue_items q
      WHERE q.status IN ('pending', 'failed')
        AND ${retryEligible('q')}
        AND ${signalHeadOfLine('q')}
      ORDER BY q.created_at ASC, q.id ASC
    `);

    this.findDeadLetterStmt = db.prepare(`
      SELECT * FROM queue_items
      WHERE status = 'dead_letter'
      ORDER BY updated_at DESC
    `);

    this.countByStatusStmt = db.prepare(`
      SELECT status, COUNT(*) as count FROM queue_items GROUP BY status
    `);

    this.hasInflightItemStmt = db.prepare(`
      SELECT 1 FROM queue_items
      WHERE thread_id = ?
        AND status IN ('claimed', 'processing')
      LIMIT 1
    `);
  }

  /** Read before dispatch: a checkpoint wins over the invocation guard; invalid state never means ordinary. */
  inspectSignalDelivery(id: string, now: number): Result<SignalDeliveryState, SignalQueueFailure> {
    return this.signalAtomic(() => this.signalSnapshot(id, now, true).map(({ state }) => state));
  }

  /**
   * Current retained saved work, including deferred/active/blocked/local-finalization rows.
   * One read transaction on this connection; never recover, expire, claim or advance a clock.
   * Stream IDs and validate one payload at a time: retained memory does not grow with history.
   * Any invalid reserved state makes the entire summary unavailable, not partial/healthy zeros.
   */
  summarizeSavedSignalDeliveries(
    now = Date.now(),
  ): Result<SavedSignalDeliverySummary, SignalQueueFailure> {
    return this.signalAtomic(() => {
      if (!Number.isSafeInteger(now) || now < 0) return err(new SignalStateError('INVALID_INPUT'));
      let pending = 0;
      let terminal = 0;
      const counts = new Map<SignalDeliveryReason, number>();
      const rows = this.db.prepare<[], { id: string }>('SELECT id FROM queue_items').iterate();
      for (const { id } of rows) {
        // Reuse dispatch validation, including legacy ordinary compatibility and independent ownership.
        const snapshot = this.signalSnapshot(id, now, true);
        if (snapshot.isErr()) return err(snapshot.error);
        const { row, state } = snapshot.value;
        if (state.kind !== 'checkpoint') continue;
        if (!this.signalActive(row) && row.status !== 'completed' && row.status !== 'dead_letter')
          return err(new SignalCheckpointError('INVALID'));
        const checkpoint = state.checkpoint;
        if (checkpoint.phase === 'terminal') {
          const reason = checkpoint.terminalReason;
          if (reason === undefined) return err(new SignalCheckpointError('INVALID'));
          terminal++;
          counts.set(reason, (counts.get(reason) ?? 0) + 1);
        } else if (checkpoint.phase === 'delivered' && row.status === 'completed') {
          continue;
        } else if (this.signalActive(row)) {
          pending++;
        } else {
          // Generic complete/dead-letter calls can leave a codec-valid but inconsistent checkpoint.
          return err(new SignalCheckpointError('INVALID'));
        }
      }
      return ok({
        pending,
        terminal,
        reasons: SIGNAL_DELIVERY_REASONS.flatMap((reason) => {
          const count = counts.get(reason);
          return count === undefined ? [] : [{ reason, count }];
        }),
      });
    });
  }

  /** First preparation only. Idempotent for identical saved text, never replaces an existing checkpoint. */
  saveSignalCheckpoint(
    checkpoint: SignalDeliveryCheckpoint,
    now: number,
  ): Result<SignalDeliveryCheckpoint, SignalQueueFailure> {
    return this.signalAtomic(() =>
      this.signalSnapshot(checkpoint.queueItemId, now, true, true).andThen((snapshot) => {
        if (!this.signalActive(snapshot.row)) return err(new SignalStateError('CONFLICT'));
        if (snapshot.state.kind === 'checkpoint') {
          return isDeepStrictEqual(snapshot.state.checkpoint, checkpoint)
            ? ok(snapshot.state.checkpoint)
            : err(new SignalStateError('CONFLICT'));
        }
        const parsed = parseSignalDeliveryCheckpoint(checkpoint, {
          queueItemId: snapshot.row.id,
          now,
        });
        if (parsed.isErr()) return err(parsed.error);
        if (
          checkpoint.phase !== 'ready' ||
          checkpoint.nextChunk !== 0 ||
          checkpoint.successCount !== 0 ||
          checkpoint.failureCount !== 0 ||
          checkpoint.threadId !== snapshot.row.thread_id
        )
          return err(new SignalCheckpointError('INVALID'));
        const budget = this.validateSignalLifecycleBudget(parsed.value);
        if (budget.isErr()) return err(budget.error);
        const run = this.validateSignalRun(snapshot.row, checkpoint.runId, checkpoint.personaId);
        if (run.isErr()) return err(run.error);
        return this.writeSignalCheckpoint(snapshot, parsed.value, now);
      }),
    );
  }

  /** CAS the standalone no-provider-replay marker, merging only this reserved key into the latest row. */
  markSignalDeliveryStarted(
    marker: SignalDeliveryStartedMarker,
    expected: SignalDeliveryStartedMarker | null,
    now: number,
  ): Result<SignalDeliveryStartedMarker, SignalQueueFailure> {
    return this.signalAtomic(() =>
      this.signalSnapshot(marker.queueItemId, now, true, true).andThen((snapshot) => {
        if (!this.signalActive(snapshot.row) || snapshot.state.kind === 'checkpoint')
          return err(new SignalStateError('CONFLICT'));
        const current = snapshot.state.kind === 'invoked' ? snapshot.state.marker : null;
        if (!isDeepStrictEqual(current, expected)) return err(new SignalStateError('CONFLICT'));
        const parsed = parseSignalDeliveryStartedMarker(marker, snapshot.row.id);
        if (parsed.isErr()) return err(parsed.error);
        if (marker.startedAt > now) return err(new SignalCheckpointError('INVALID'));
        const run = this.validateSignalRun(snapshot.row, marker.runId);
        if (run.isErr()) return err(run.error);
        const { runId, ...required } = parsed.value;
        const persisted = Object.freeze(runId === undefined ? required : parsed.value);
        this.writeSignalPayload(snapshot, { [SIGNAL_DELIVERY_STARTED_KEY]: persisted }, now);
        return ok(persisted);
      }),
    );
  }

  /** Commit before any bytes may be submitted. A failed lease, account CAS, pause or budget rolls back EVERYTHING. */
  beginSignalChunk(
    expected: SignalDeliveryCheckpoint,
    expectedAccountRevision: number,
    now: number,
  ): Result<SignalChunkOwnership, SignalQueueFailure> {
    return this.signalAtomic(() =>
      this.expectedSignalCheckpoint(expected, now).andThen((snapshot) => {
        if (expected.phase !== 'ready') return err(new SignalStateError('CONFLICT'));
        // Legacy/directly persisted ready states did not necessarily pass lifetime admission.
        const budget = this.validateSignalLifecycleBudget(expected);
        if (budget.isErr()) return err(budget.error);
        const context = {
          queueItemId: expected.queueItemId,
          deliveryId: expected.deliveryId,
          runId: expected.runId,
          purpose: expected.kind,
        };
        const leases = new SignalDestinationLeaseRepository(this.db);
        return leases
          .acquire(expected.accountUuid, expected.destination, context, now)
          .andThen((lease) =>
            new SignalAccountStateRepository(this.db)
              .reserveSend(expected.accountUuid, expectedAccountRevision, context, now)
              .andThen((account) => {
                const reservation = account.reservation;
                if (reservation === null) return err(new SignalStateError('CONFLICT'));
                const checkpoint: SignalDeliveryCheckpoint = {
                  ...expected,
                  phase: 'in_flight',
                  currentChunkAcceptance: 'unknown',
                };
                return this.writeSignalCheckpoint(snapshot, checkpoint, now, {
                  [SIGNAL_DELIVERY_STARTED_KEY]: { version: 1, ...context, startedAt: now },
                }).map((persisted) => ({ checkpoint: persisted, account, reservation, lease }));
              }),
          );
      }),
    );
  }

  /**
   * The only in_flight completion path. Acceptance advances exactly one cursor; known-unsent keeps the lease.
   * After purge, classify/clear ONLY the owned reservation, commit that classification, then return DeliveryCancelled.
   */
  settleSignalChunk(
    ownership: SignalChunkOwnership,
    settlement: SignalChunkSettlement,
    now: number,
  ): Result<SignalDeliveryCheckpoint, SignalQueueFailure> {
    const result = this.signalAtomic<SignalDeliveryCheckpoint | null, SignalQueueFailure>(() => {
      const expected = ownership.checkpoint;
      const owner = ownership.reservation;
      if (
        expected.phase !== 'in_flight' ||
        ownership.account.accountUuid !== expected.accountUuid ||
        owner.queueItemId !== expected.queueItemId ||
        owner.deliveryId !== expected.deliveryId ||
        owner.purpose !== expected.kind ||
        ownership.lease.accountUuid !== expected.accountUuid ||
        ownership.lease.externalThreadId !== expected.destination ||
        ownership.lease.queueItemId !== expected.queueItemId ||
        ownership.lease.deliveryId !== expected.deliveryId ||
        ownership.lease.kind !== expected.kind
      )
        return err(new SignalStateError('CONFLICT'));
      const next = this.settledSignalCheckpoint(expected, settlement, now);
      if (next.isErr()) return err(next.error);
      const row = this.findByIdStmt.get(expected.queueItemId) as QueueItemRow | undefined;
      const snapshot =
        row === undefined ? ok(null) : this.expectedSignalCheckpoint(expected, now, true);
      if (snapshot.isErr()) return err(snapshot.error);
      const leases = new SignalDestinationLeaseRepository(this.db);
      if (snapshot.value !== null) {
        const valid = leases.validateOwner(ownership.lease);
        if (valid.isErr()) return err(valid.error);
      }
      const pause = settlement.kind === 'accepted' ? undefined : settlement.pause;
      const unknown = next.value.terminalOutcome === 'UNKNOWN';
      // Device checks or a newly observed account pause may advance revision while the RPC is active.
      // Reread under this transaction, but never classify a different reservation generation.
      const current = new SignalAccountStateRepository(this.db).findByAccount(expected.accountUuid);
      if (current.isErr()) return err(current.error);
      if (current.value === null || !isDeepStrictEqual(current.value.reservation, owner))
        return err(new SignalStateError('CONFLICT'));
      const classified = this.classifySignalReservation(current.value, owner, pause, unknown, now);
      if (classified.isErr()) return err(classified.error);
      if (snapshot.value === null) return ok(null);
      const persisted = this.writeSignalCheckpoint(snapshot.value, next.value, now);
      if (persisted.isErr()) return err(persisted.error);
      if (next.value.phase === 'terminal')
        this.deadLetterSignal(
          snapshot.value.row,
          next.value.terminalReason ?? 'CHECKPOINT_INVALID',
          now,
        );
      if (next.value.phase === 'terminal' || next.value.phase === 'delivered') {
        const released = leases.release(ownership.lease);
        if (released.isErr()) return err(released.error);
      }
      return ok(next.value);
    });
    return result.andThen((checkpoint) =>
      checkpoint === null ? err(new DeliveryCancelled()) : ok(checkpoint),
    );
  }

  /** Ready-only permanent refusal/expiry. In-flight work MUST settle its reservation instead. */
  terminateSignalDelivery(
    expected: SignalDeliveryCheckpoint,
    failure: SignalDeliveryError,
    now: number,
  ): Result<SignalDeliveryCheckpoint, SignalQueueFailure> {
    return this.signalAtomic(() =>
      this.expectedSignalCheckpoint(expected, now, true).andThen((snapshot) => {
        if (
          expected.phase !== 'ready' ||
          failure.retryScope !== 'none' ||
          failure.successCount !== expected.successCount ||
          !['unwritten', 'refused'].includes(failure.currentChunkAcceptance)
        )
          return err(new SignalStateError('CONFLICT'));
        const checkpoint = this.failureSignalCheckpoint(expected, failure, 'terminal', now);
        if (checkpoint.isErr()) return err(checkpoint.error);
        const persisted = this.writeSignalCheckpoint(snapshot, checkpoint.value, now);
        if (persisted.isErr()) return err(persisted.error);
        this.deadLetterSignal(snapshot.row, failure.reason, now);
        const released = this.releaseSavedSignalLease(expected);
        return released.isErr() ? err(released.error) : ok(checkpoint.value);
      }),
    );
  }

  /**
   * Delivery/local-finalization retry, never a provider attempt. Backoff is clamped to 1..60s.
   * Ready work is capped by its original expiry; delivered work can retry local writes after expiry.
   */
  deferSignalDelivery(
    expected: SignalDeliveryCheckpoint,
    delayMs: number,
    now: number,
    notBefore?: number,
  ): Result<number, SignalQueueFailure> {
    return this.signalAtomic(() =>
      this.expectedSignalCheckpoint(expected, now).andThen((snapshot) => {
        if (
          !['ready', 'delivered'].includes(expected.phase) ||
          !Number.isSafeInteger(delayMs) ||
          delayMs < 0 ||
          (notBefore !== undefined && (!Number.isSafeInteger(notBefore) || notBefore < 0))
        )
          return err(new SignalStateError('INVALID_INPUT'));
        const bounded = now + Math.max(1_000, Math.min(60_000, delayMs));
        if (!Number.isSafeInteger(bounded)) return err(new SignalStateError('INVALID_INPUT'));
        const hinted = Math.max(bounded, notBefore ?? 0);
        const next = expected.phase === 'delivered' ? hinted : Math.min(expected.expiresAt, hinted);
        this.db
          .prepare(
            `UPDATE queue_items SET status = 'failed', next_retry_at = ?, claimed_at = NULL,
        error = 'SIGNAL_DELIVERY_DEFERRED', updated_at = MAX(updated_at, ?) WHERE id = ?`,
          )
          .run(next, now, snapshot.row.id);
        return ok(next);
      }),
    );
  }

  /**
   * Synchronous SAME-CONNECTION local writes only (history/run/task); no RPC/provider work.
   * The callback and queue completion roll back on Err. Already completed work skips the callback.
   */
  finalizeSignalDelivery<E>(
    expected: SignalDeliveryCheckpoint,
    finalize: (checkpoint: SignalDeliveryCheckpoint) => Result<void, E>,
    now: number,
  ): Result<void, SignalQueueFailure | E> {
    return this.signalAtomic<void, SignalQueueFailure | E>(() =>
      this.expectedSignalCheckpoint(expected, now, true, true).andThen((snapshot) => {
        if (expected.phase !== 'delivered') return err(new SignalStateError('CONFLICT'));
        if (snapshot.row.status === 'completed') return ok(undefined);
        return runResultTransaction(
          (fn) => this.transaction(fn),
          () => finalize(expected),
        ).andThen(() => {
          this.db
            .prepare(
              "UPDATE queue_items SET status = 'completed', claimed_at = NULL, next_retry_at = NULL, error = NULL, updated_at = MAX(updated_at, ?) WHERE id = ?",
            )
            .run(now, expected.queueItemId);
          return ok(undefined);
        });
      }),
    );
  }

  /**
   * Dispatch failure boundary for an invalid payload/guard or an invocation with no saved reply.
   * Re-inspects the latest row: a newly committed valid checkpoint cannot be overwritten by a stale catch.
   * Classifies only this execution's outstanding reservations UNKNOWN, then releases only its leases.
   */
  rejectSignalReplay(id: string, now: number): Result<void, SignalQueueFailure> {
    return this.signalAtomic(() => {
      if (!Number.isSafeInteger(now) || now < 0) return err(new SignalStateError('INVALID_INPUT'));
      const row = this.findByIdStmt.get(id) as QueueItemRow | undefined;
      if (row === undefined) return err(new DeliveryCancelled());
      if (!this.signalActive(row) && row.status !== 'dead_letter')
        return err(new SignalStateError('CONFLICT'));
      const snapshot = this.signalSnapshot(id, now, true);
      if (snapshot.isErr() && !(snapshot.error instanceof SignalCheckpointError))
        return err(snapshot.error);
      if (snapshot.isOk() && snapshot.value.state.kind !== 'invoked')
        return err(new SignalStateError('CONFLICT'));
      const reason = snapshot.isErr() ? 'CHECKPOINT_INVALID' : 'UNKNOWN_ACCEPTANCE';
      const accounts = new SignalAccountStateRepository(this.db);
      const reserved = accounts.findReserved();
      if (reserved.isErr()) return err(reserved.error);
      for (const account of reserved.value) {
        if (account.reservation?.queueItemId === id) {
          const classified = this.classifySignalReservation(
            account,
            account.reservation,
            undefined,
            true,
            now,
          );
          if (classified.isErr()) return err(classified.error);
        }
      }
      this.deadLetterSignal(row, reason, now);
      const leases = new SignalDestinationLeaseRepository(this.db);
      const keys = this.db
        .prepare(
          'SELECT account_uuid, external_thread_id FROM signal_destination_leases WHERE queue_item_id = ?',
        )
        .all(id) as Array<{ account_uuid: string; external_thread_id: string }>;
      for (const key of keys) {
        const lease = leases.find(key.account_uuid, key.external_thread_id);
        if (lease.isErr()) return err(lease.error);
        if (lease.value === null) return err(new SignalStateError('CONFLICT'));
        const released = leases.release(lease.value);
        if (released.isErr()) return err(released.error);
      }
      return ok(undefined);
    });
  }

  /**
   * Startup/replacement ONLY, with dispatch quiesced. One Result transaction classifies reservations first,
   * saved work/guards second, then orphan leases; no provider/network or local history finalization.
   * Also resets ordinary claimed/processing items, so lifecycle needs no private DB access.
   */
  recoverSignalQueue(now: number): Result<SignalQueueRecovery, SignalQueueFailure> {
    return this.signalAtomic(() => {
      const accounts = new SignalAccountStateRepository(this.db);
      const leases = new SignalDestinationLeaseRepository(this.db);
      const interruptedInvocations: SignalDeliveryStartedMarker[] = [];
      let reservationsClassified = 0;
      let orphanLeasesReleased = 0;
      let ordinaryReset = 0;
      let ready = 0;
      let delivered = 0;
      let terminal = 0;
      let invalid = 0;
      if (!Number.isSafeInteger(now) || now < 0) return err(new SignalStateError('INVALID_INPUT'));
      // No Signal-specific constructor statements: ordinary legacy fixtures remain usable.
      const hasAccounts =
        this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'signal_account_state'",
          )
          .get() !== undefined;
      const hasLeases =
        this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'signal_destination_leases'",
          )
          .get() !== undefined;
      if (hasAccounts) {
        const reserved = accounts.findReserved();
        if (reserved.isErr()) return err(reserved.error);
        for (const account of reserved.value) {
          const owner = account.reservation;
          if (owner === null) return err(new SignalStateError('CONFLICT'));
          // Explicit/progress reservations never rewrite a delivered origin checkpoint or completed queue row.
          if (owner.purpose === 'explicit' || owner.purpose === 'progress') {
            const marker: SignalDeliveryStartedMarker = { version: 1, ...owner };
            interruptedInvocations.push(marker);
            const guarded = this.recoverInvocationGuard(marker, now);
            if (guarded.isErr()) return err(guarded.error);
            invalid += guarded.value;
          } else {
            // A reservation without its saved checkpoint is also a no-replay boundary.
            const guarded = this.recoverInvocationGuard({ version: 1, ...owner }, now);
            if (guarded.isErr()) return err(guarded.error);
            invalid += guarded.value;
            const snapshot = this.signalSnapshot(owner.queueItemId, now, true);
            if (
              snapshot.isErr() &&
              !(snapshot.error instanceof DeliveryCancelled) &&
              !(snapshot.error instanceof SignalCheckpointError)
            )
              return err(snapshot.error);
            if (
              snapshot.isOk() &&
              this.signalActive(snapshot.value.row) &&
              snapshot.value.state.kind === 'checkpoint'
            ) {
              const checkpoint = snapshot.value.state.checkpoint;
              if (
                checkpoint.deliveryId === owner.deliveryId &&
                checkpoint.accountUuid === account.accountUuid &&
                checkpoint.kind === owner.purpose &&
                (checkpoint.phase === 'in_flight' || checkpoint.phase === 'ready')
              ) {
                const persisted = this.writeSignalCheckpoint(
                  snapshot.value,
                  this.unknownSignalCheckpoint(checkpoint),
                  now,
                );
                if (persisted.isErr()) return err(persisted.error);
              }
            }
          }
          const classified = this.classifySignalReservation(account, owner, undefined, true, now);
          if (classified.isErr()) return err(classified.error);
          reservationsClassified++;
        }
      }
      if (hasLeases) {
        const invocationKeys = this.db
          .prepare(
            "SELECT account_uuid, external_thread_id FROM signal_destination_leases WHERE kind IN ('explicit', 'progress')",
          )
          .all() as Array<{ account_uuid: string; external_thread_id: string }>;
        for (const key of invocationKeys) {
          const lease = leases.find(key.account_uuid, key.external_thread_id);
          if (lease.isErr()) return err(lease.error);
          if (lease.value === null) return err(new SignalStateError('CONFLICT'));
          const owner = lease.value;
          const guarded = this.recoverInvocationGuard(
            {
              version: 1,
              queueItemId: owner.queueItemId,
              deliveryId: owner.deliveryId,
              purpose: owner.kind,
              startedAt: owner.createdAt,
            },
            now,
          );
          if (guarded.isErr()) return err(guarded.error);
          invalid += guarded.value;
        }
      }
      const rows = this.db
        .prepare(
          "SELECT * FROM queue_items WHERE status IN ('pending', 'failed', 'claimed', 'processing') ORDER BY created_at, id",
        )
        .all() as QueueItemRow[];
      for (const row of rows) {
        const snapshot = this.signalSnapshot(row.id, now, true);
        if (snapshot.isErr()) {
          if (!(snapshot.error instanceof SignalCheckpointError)) return err(snapshot.error);
          this.deadLetterSignal(row, 'CHECKPOINT_INVALID', now);
          invalid++;
          continue;
        }
        const state = snapshot.value.state;
        if (state.kind === 'ordinary') {
          if (row.status === 'claimed' || row.status === 'processing') {
            this.resetSignalQueueClaim(row, now);
            ordinaryReset++;
          }
        } else if (state.kind === 'invoked') {
          this.deadLetterSignal(row, 'UNKNOWN_ACCEPTANCE', now);
          terminal++;
          interruptedInvocations.push(state.marker);
        } else {
          const checkpoint = state.checkpoint;
          let classified = checkpoint;
          if (checkpoint.phase === 'in_flight') {
            const account = accounts.getOrCreate(checkpoint.accountUuid, now);
            if (account.isErr()) return err(account.error);
            const fenced = accounts.recordPause(
              checkpoint.accountUuid,
              account.value.revision,
              { kind: 'recovery' },
              now,
            );
            if (fenced.isErr()) return err(fenced.error);
            classified = this.unknownSignalCheckpoint(checkpoint);
          } else if (checkpoint.phase === 'ready' && checkpoint.expiresAt <= now) {
            classified = {
              ...checkpoint,
              phase: 'terminal',
              terminalReason: 'CHECKPOINT_EXPIRED',
              terminalOutcome: checkpoint.acceptedChunks > 0 ? 'PARTIAL' : 'NOT_SENT',
            };
          }
          if (classified !== checkpoint) {
            const persisted = this.writeSignalCheckpoint(snapshot.value, classified, now);
            if (persisted.isErr()) return err(persisted.error);
          }
          if (classified.phase === 'terminal') {
            this.deadLetterSignal(row, classified.terminalReason ?? 'CHECKPOINT_INVALID', now);
            terminal++;
          } else {
            if (row.status === 'claimed' || row.status === 'processing')
              this.resetSignalQueueClaim(row, now);
            if (classified.phase === 'ready') ready++;
            else delivered++;
          }
        }
      }
      if (hasLeases) {
        const keys = this.db
          .prepare(
            'SELECT account_uuid, external_thread_id FROM signal_destination_leases ORDER BY account_uuid, external_thread_id',
          )
          .all() as Array<{ account_uuid: string; external_thread_id: string }>;
        // Includes a lease acquired before getOrCreate/reserveSend; persist an account row before TASK005 cleanup.
        for (const accountUuid of new Set(keys.map((key) => key.account_uuid))) {
          const account = accounts.getOrCreate(accountUuid, now);
          if (account.isErr()) return err(account.error);
          const released = leases.releaseOrphanInvocations(accountUuid, account.value.revision);
          if (released.isErr()) return err(released.error);
          orphanLeasesReleased += released.value;
        }
        for (const key of keys) {
          const lease = leases.find(key.account_uuid, key.external_thread_id);
          if (lease.isErr()) return err(lease.error);
          if (lease.value === null) continue;
          const owner = lease.value;
          const snapshot = this.signalSnapshot(owner.queueItemId, now, true);
          const checkpoint =
            snapshot.isOk() && snapshot.value.state.kind === 'checkpoint'
              ? snapshot.value.state.checkpoint
              : null;
          const retained =
            snapshot.isOk() &&
            this.signalActive(snapshot.value.row) &&
            checkpoint !== null &&
            checkpoint.phase === 'ready' &&
            checkpoint.deliveryId === owner.deliveryId &&
            checkpoint.kind === owner.kind &&
            checkpoint.accountUuid === owner.accountUuid &&
            checkpoint.destination === owner.externalThreadId;
          if (!retained) {
            if (
              snapshot.isErr() &&
              !(snapshot.error instanceof SignalCheckpointError) &&
              !(snapshot.error instanceof DeliveryCancelled)
            )
              return err(snapshot.error);
            const released = leases.release(owner);
            if (released.isErr()) return err(released.error);
            orphanLeasesReleased++;
          }
        }
      }
      const uniqueInvocations = interruptedInvocations.filter(
        (marker, index) =>
          interruptedInvocations.findIndex(
            (other) =>
              other.queueItemId === marker.queueItemId &&
              other.deliveryId === marker.deliveryId &&
              other.purpose === marker.purpose,
          ) === index,
      );
      return ok({
        ordinaryReset,
        ready,
        delivered,
        terminal,
        invalid,
        reservationsClassified,
        orphanLeasesReleased,
        interruptedInvocations: Object.freeze(uniqueInvocations),
      });
    });
  }

  private signalAtomic<T, E = SignalQueueFailure>(
    operation: () => Result<T, E>,
  ): Result<T, E | SignalStateError> {
    try {
      return runResultTransaction((fn) => this.transaction(fn), operation);
    } catch {
      return err(new SignalStateError('DATABASE'));
    }
  }

  private signalActive(row: QueueItemRow): boolean {
    return ['pending', 'failed', 'claimed', 'processing'].includes(row.status);
  }

  private signalSnapshot(
    id: string,
    now: number,
    allowExpired = false,
    strictPayload = false,
  ): Result<SignalQueueSnapshot, SignalQueueFailure> {
    if (!Number.isSafeInteger(now) || now < 0) return err(new SignalStateError('INVALID_INPUT'));
    const row = this.findByIdStmt.get(id) as QueueItemRow | undefined;
    if (row === undefined) return err(new DeliveryCancelled());
    const payloadResult = parseSignalQueuePayload(row.payload);
    if (
      payloadResult.isErr() &&
      !strictPayload &&
      !hasSignalPayloadEvidence(row.payload) &&
      !this.hasSignalOwnership(id)
    ) {
      // Match the legacy mapper at READ boundaries only; never write this placeholder payload back.
      return ok({ row, payload: {}, state: { kind: 'ordinary' } });
    }
    return payloadResult.andThen((payload) =>
      inspectSignalDeliveryState(payload, id, now, allowExpired).andThen((state) => {
        if (state.kind === 'ordinary' && this.hasSignalOwnership(id))
          return err(new SignalCheckpointError('INVALID'));
        if (state.kind === 'checkpoint') {
          const checkpoint = state.checkpoint;
          if (checkpoint.threadId !== row.thread_id)
            return err(new SignalCheckpointError('IDENTITY_MISMATCH'));
          const run = this.validateSignalRun(
            row,
            checkpoint.runId,
            checkpoint.personaId,
            checkpoint.phase === 'ready' || checkpoint.phase === 'in_flight',
          );
          if (run.isErr()) return err(run.error);
        } else if (state.kind === 'invoked') {
          const run = this.validateSignalRun(row, state.marker.runId, undefined, false);
          if (run.isErr()) return err(run.error);
        }
        return ok({ row, payload, state });
      }),
    );
  }

  private expectedSignalCheckpoint(
    expected: SignalDeliveryCheckpoint,
    now: number,
    allowExpired = false,
    allowCompleted = false,
  ): Result<SignalQueueSnapshot, SignalQueueFailure> {
    return this.signalSnapshot(expected.queueItemId, now, allowExpired, true).andThen(
      (snapshot) => {
        if (
          (!this.signalActive(snapshot.row) &&
            !(allowCompleted && snapshot.row.status === 'completed')) ||
          snapshot.state.kind !== 'checkpoint' ||
          !isDeepStrictEqual(snapshot.state.checkpoint, expected)
        )
          return err(new SignalStateError('CONFLICT'));
        return ok(snapshot);
      },
    );
  }

  private validateSignalRun(
    row: QueueItemRow,
    runId?: string,
    personaId?: string,
    activeOnly = true,
  ): Result<void, SignalQueueFailure> {
    if (runId === undefined) return ok(undefined);
    const run = this.db
      .prepare('SELECT queue_item_id, thread_id, persona_id, status FROM runs WHERE id = ?')
      .get(runId) as
      | { queue_item_id: string | null; thread_id: string; persona_id: string; status: string }
      | undefined;
    return run !== undefined &&
      run.queue_item_id === row.id &&
      run.thread_id === row.thread_id &&
      (personaId === undefined || run.persona_id === personaId) &&
      (!activeOnly || ['pending', 'running'].includes(run.status))
      ? ok(undefined)
      : err(new SignalCheckpointError('IDENTITY_MISMATCH'));
  }

  private validateSignalLifecycleBudget(
    checkpoint: SignalDeliveryCheckpoint,
  ): Result<void, SignalCheckpointError> {
    // Immutable identity/text/TTL bytes are retained exactly. Cursor/chunk counts cannot
    // exceed chunks.length; recipient totals can reach MAX_SAFE_INTEGER. The longest
    // v1 phase/acceptance/outcome plus longest approved reason conservatively bound ALL
    // lifecycle metadata, even though this upper-envelope combination is not a real phase.
    const envelope = {
      ...checkpoint,
      nextChunk: checkpoint.chunks.length,
      acceptedChunks: checkpoint.chunks.length,
      successCount: Number.MAX_SAFE_INTEGER,
      failureCount: Number.MAX_SAFE_INTEGER,
      phase: 'in_flight',
      currentChunkAcceptance: 'unwritten',
      terminalReason: longestSignalDeliveryReason,
      terminalOutcome: 'NOT_SENT',
    };
    return Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= SIGNAL_CHECKPOINT_MAX_BYTES
      ? ok(undefined)
      : err(new SignalCheckpointError('TOO_LARGE'));
  }

  /** Every constructed checkpoint, including recovery, passes the unchanged absolute codec cap before persistence. */
  private writeSignalCheckpoint(
    snapshot: SignalQueueSnapshot,
    checkpoint: SignalDeliveryCheckpoint,
    now: number,
    additions: Readonly<Record<string, unknown>> = {},
  ): Result<SignalDeliveryCheckpoint, SignalCheckpointError> {
    return parseSignalDeliveryCheckpoint(checkpoint, {
      queueItemId: snapshot.row.id,
      now,
      allowExpired: true,
    }).map((parsed) => {
      this.writeSignalPayload(
        snapshot,
        { ...additions, [SIGNAL_DELIVERY_CHECKPOINT_KEY]: parsed },
        now,
      );
      return parsed;
    });
  }

  private writeSignalPayload(
    snapshot: SignalQueueSnapshot,
    additions: Readonly<Record<string, unknown>>,
    now: number,
  ): void {
    this.db
      .prepare('UPDATE queue_items SET payload = ?, updated_at = MAX(updated_at, ?) WHERE id = ?')
      .run(JSON.stringify({ ...snapshot.payload, ...additions }), now, snapshot.row.id);
  }

  private settledSignalCheckpoint(
    expected: SignalDeliveryCheckpoint,
    settlement: SignalChunkSettlement,
    now: number,
  ): Result<SignalDeliveryCheckpoint, SignalQueueFailure> {
    if (settlement.kind !== 'accepted')
      return this.failureSignalCheckpoint(
        expected,
        settlement.failure,
        settlement.kind === 'deferred' ? 'ready' : 'terminal',
        now,
      );
    if (!Number.isSafeInteger(settlement.successCount) || settlement.successCount <= 0)
      return err(new SignalStateError('INVALID_INPUT'));
    const cursor = expected.nextChunk + 1;
    return parseSignalDeliveryCheckpoint(
      {
        ...expected,
        nextChunk: cursor,
        acceptedChunks: cursor,
        successCount: expected.successCount + settlement.successCount,
        phase: cursor === expected.chunks.length ? 'delivered' : 'ready',
        currentChunkAcceptance: cursor === expected.chunks.length ? 'complete' : 'unwritten',
      },
      { queueItemId: expected.queueItemId, now, allowExpired: true },
    );
  }

  private failureSignalCheckpoint(
    expected: SignalDeliveryCheckpoint,
    failure: SignalDeliveryError,
    phase: 'ready' | 'terminal',
    now: number,
  ): Result<SignalDeliveryCheckpoint, SignalQueueFailure> {
    if (
      failure.acceptedChunks !== expected.acceptedChunks ||
      failure.successCount < expected.successCount ||
      failure.failureCount < expected.failureCount ||
      (phase === 'ready' &&
        (failure.retryScope !== 'delivery_only' ||
          failure.successCount !== expected.successCount)) ||
      (phase === 'terminal' && failure.retryScope !== 'none')
    )
      return err(new SignalStateError('INVALID_INPUT'));
    return parseSignalDeliveryCheckpoint(
      {
        ...expected,
        phase,
        currentChunkAcceptance: failure.currentChunkAcceptance,
        successCount: failure.successCount,
        failureCount: failure.failureCount,
        ...(phase === 'terminal'
          ? { terminalReason: failure.reason, terminalOutcome: failure.outcome }
          : {}),
      },
      { queueItemId: expected.queueItemId, now, allowExpired: true },
    );
  }

  private classifySignalReservation(
    account: SignalAccountState,
    owner: SignalSendReservation,
    pause: SignalPause | undefined,
    unknown: boolean,
    now: number,
  ): Result<SignalAccountState, SignalQueueFailure> {
    const accounts = new SignalAccountStateRepository(this.db);
    let current = account;
    if (pause !== undefined) {
      const paused = accounts.recordPause(current.accountUuid, current.revision, pause, now);
      if (paused.isErr()) return err(paused.error);
      current = paused.value;
    }
    if (unknown) {
      const fenced = accounts.recordPause(
        current.accountUuid,
        current.revision,
        { kind: 'recovery' },
        now,
      );
      if (fenced.isErr()) return err(fenced.error);
      current = fenced.value;
    }
    return accounts.clearReservation(current.accountUuid, current.revision, owner, now);
  }

  private recoverInvocationGuard(
    marker: SignalDeliveryStartedMarker,
    now: number,
  ): Result<number, SignalQueueFailure> {
    const snapshot = this.signalSnapshot(marker.queueItemId, now, true);
    if (snapshot.isErr()) {
      if (snapshot.error instanceof DeliveryCancelled) return ok(0);
      if (!(snapshot.error instanceof SignalCheckpointError)) return err(snapshot.error);
      // Persist a terminal decision BEFORE clearing the last independent ownership evidence.
      const row = this.findByIdStmt.get(marker.queueItemId) as QueueItemRow | undefined;
      if (row !== undefined && this.signalActive(row)) {
        const payload = parseSignalQueuePayload(row.payload);
        const state = payload.andThen((value) =>
          inspectSignalDeliveryState(value, row.id, now, true),
        );
        if (payload.isOk() && state.isOk() && state.value.kind === 'ordinary') {
          this.writeSignalPayload(
            { row, payload: payload.value, state: state.value },
            { [SIGNAL_DELIVERY_STARTED_KEY]: marker },
            now,
          );
          return ok(0);
        }
        this.deadLetterSignal(row, 'CHECKPOINT_INVALID', now);
        return ok(1);
      }
      return ok(0);
    }
    if (this.signalActive(snapshot.value.row) && snapshot.value.state.kind === 'ordinary') {
      this.writeSignalPayload(snapshot.value, { [SIGNAL_DELIVERY_STARTED_KEY]: marker }, now);
    }
    return ok(0);
  }

  private hasSignalOwnership(id: string): boolean {
    const accountTable = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'signal_account_state'")
      .get();
    if (
      accountTable !== undefined &&
      this.db
        .prepare('SELECT 1 FROM signal_account_state WHERE reservation_queue_item_id = ?')
        .get(id) !== undefined
    )
      return true;
    const leaseTable = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'signal_destination_leases'",
      )
      .get();
    return (
      leaseTable !== undefined &&
      this.db.prepare('SELECT 1 FROM signal_destination_leases WHERE queue_item_id = ?').get(id) !==
        undefined
    );
  }

  private releaseSavedSignalLease(
    checkpoint: SignalDeliveryCheckpoint,
  ): Result<void, SignalQueueFailure> {
    const leases = new SignalDestinationLeaseRepository(this.db);
    return leases.find(checkpoint.accountUuid, checkpoint.destination).andThen((lease) => {
      if (lease === null) return ok(undefined);
      // A ready waiter may terminate without ever owning this destination's lease.
      return lease.queueItemId === checkpoint.queueItemId &&
        lease.deliveryId === checkpoint.deliveryId &&
        lease.kind === checkpoint.kind
        ? leases.release(lease)
        : ok(undefined);
    });
  }

  private unknownSignalCheckpoint(checkpoint: SignalDeliveryCheckpoint): SignalDeliveryCheckpoint {
    return {
      ...checkpoint,
      phase: 'terminal',
      currentChunkAcceptance: 'unknown',
      terminalReason: 'UNKNOWN_ACCEPTANCE',
      terminalOutcome: 'UNKNOWN',
    };
  }

  private deadLetterSignal(row: QueueItemRow, reason: string, now: number): void {
    this.db
      .prepare(
        "UPDATE queue_items SET status = 'dead_letter', error = ?, claimed_at = NULL, next_retry_at = NULL, updated_at = MAX(updated_at, ?) WHERE id = ?",
      )
      .run(reason, now, row.id);
    this.db
      .prepare(
        `UPDATE runs SET status = 'failed', ended_at = MAX(0, ?, COALESCE(started_at, created_at), COALESCE(ended_at, 0)), error = ?
      WHERE queue_item_id = ? AND status IN ('pending', 'running')`,
      )
      .run(now, reason, row.id);
  }

  private resetSignalQueueClaim(row: QueueItemRow, now: number): void {
    this.db
      .prepare(
        "UPDATE queue_items SET status = 'pending', claimed_at = NULL, updated_at = MAX(updated_at, ?) WHERE id = ?",
      )
      .run(now, row.id);
  }

  /** Adds a new item to the queue with status 'pending'. */
  enqueue(input: EnqueueInput): Result<QueueItemRow, DbError> {
    try {
      const ts = this.now();
      this.enqueueStmt.run({ ...input, created_at: ts, updated_at: ts });
      const row = this.findByIdStmt.get(input.id) as QueueItemRow;
      return ok(row);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to enqueue item: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Atomically claims the next available queue item for the given thread.
   *
   * Returns null if no eligible item exists (pending or failed with an
   * elapsed retry delay).
   */
  claimNext(threadId: string): Result<QueueItemRow | null, DbError> {
    try {
      const now = this.now();
      const row = this.claimNextStmt.get({ thread_id: threadId, now, wall_now: Date.now() }) as
        | QueueItemRow
        | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to claim queue item: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Atomically claims the oldest pending/retryable collaboration item for the given thread.
   *
   * Used to bypass the per-thread single-inflight invariant when a collaboration
   * item is blocked behind a regular pending item. Returns null if no eligible
   * collaboration item exists.
   */
  claimNextCollaboration(threadId: string): Result<QueueItemRow | null, DbError> {
    try {
      const now = this.now();
      const row = this.claimNextCollaborationStmt.get({
        thread_id: threadId,
        now,
        wall_now: Date.now(),
      }) as QueueItemRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to claim collaboration queue item: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /** Marks a claimed item as completed. */
  complete(id: string): Result<void, DbError> {
    try {
      this.completeStmt.run({ id, now: this.now() });
      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to complete queue item: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Records a failure on a queue item and schedules the next retry.
   *
   * If the item has reached its max_attempts it is moved to dead_letter instead.
   *
   * @param id           - Queue item primary key.
   * @param errorMessage - Human-readable failure description.
   * @param nextRetryAt  - Absolute Unix ms timestamp for the next attempt.
   */
  fail(id: string, errorMessage: string, nextRetryAt: number): Result<void, DbError> {
    try {
      const now = this.now();
      const row = this.findByIdStmt.get(id) as QueueItemRow | undefined;
      if (!row) {
        return err(new DbError(`Queue item not found: ${id}`));
      }

      const newAttempts = row.attempts + 1;

      if (newAttempts >= row.max_attempts) {
        // Exhausted retries — send to dead letter.
        this.markDeadLetterStmt.run({ id, error: errorMessage, now });
      } else {
        const stmt = this.db.prepare(`
          UPDATE queue_items
          SET status = 'failed', attempts = @attempts, next_retry_at = @next_retry_at,
              error = @error, updated_at = @now
          WHERE id = @id
        `);
        stmt.run({
          id,
          attempts: newAttempts,
          next_retry_at: nextRetryAt,
          error: errorMessage,
          now,
        });
      }

      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to record queue item failure: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /** Moves a queue item directly to dead_letter state. */
  markDeadLetter(id: string, errorMessage: string): Result<void, DbError> {
    try {
      this.markDeadLetterStmt.run({ id, error: errorMessage, now: this.now() });
      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to mark dead letter: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /** Returns a single queue item by its primary key, or null if not found. */
  findById(id: string): Result<QueueItemRow | null, DbError> {
    try {
      const row = this.findByIdStmt.get(id) as QueueItemRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find queue item by id: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Returns pending/failed work whose retry has elapsed: wall time for saved Signal work,
   * the existing logical clock otherwise. An explicit time overrides both eligibility clocks.
   */
  findPending(now?: number): Result<QueueItemRow[], DbError> {
    try {
      const rows = this.findPendingStmt.all({
        now: now ?? this.now(),
        wall_now: now ?? Date.now(),
      }) as QueueItemRow[];
      return ok(rows);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find pending queue items: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /** Returns all dead-letter items. */
  findDeadLetter(): Result<QueueItemRow[], DbError> {
    try {
      const rows = this.findDeadLetterStmt.all() as QueueItemRow[];
      return ok(rows);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find dead-letter queue items: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /** Returns a map of status -> count for all queue items. */
  countByStatus(): Result<Record<string, number>, DbError> {
    try {
      const rows = this.countByStatusStmt.all() as Array<{ status: string; count: number }>;
      const result: Record<string, number> = {};
      for (const r of rows) {
        result[r.status] = r.count;
      }
      return ok(result);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to count queue items by status: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Returns true if the given thread has any item in claimed or processing state.
   *
   * Used by the queue processor to enforce the "no interleaved runs" invariant:
   * a new item must not be claimed for a thread that already has one in flight.
   */
  hasInflightItem(threadId: string): Result<boolean, DbError> {
    try {
      const row = this.hasInflightItemStmt.get(threadId);
      return ok(row !== undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to check inflight item for thread: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Deletes queue items matching the given statuses.
   *
   * @param statuses - Array of statuses to purge (e.g. ['pending', 'failed', 'dead_letter']).
   * @returns Ok(number) with the count of deleted rows, or DbError.
   */
  purge(statuses: QueueStatus[]): Result<number, DbError> {
    if (statuses.length === 0) {
      return ok(0);
    }
    try {
      const placeholders = statuses.map(() => '?').join(', ');
      const purgeTransaction = this.db.transaction(() => {
        // Only prepare Signal/run-specific writes when selected work actually has a checkpoint.
        // Legacy queue fixtures need neither Signal tables nor the full run schema.
        const selectedSignal = this.db
          .prepare(
            `SELECT 1 FROM queue_items q WHERE status IN (${placeholders}) AND ${hasSignalCheckpoint('q')} LIMIT 1`,
          )
          .get(...statuses);
        if (selectedSignal !== undefined) {
          this.db
            .prepare(
              `UPDATE runs SET status = 'cancelled',
            ended_at = MAX(0, ?, COALESCE(started_at, created_at), COALESCE(ended_at, 0)),
            error = 'SIGNAL_DELIVERY_OPERATOR_PURGE'
            WHERE status IN ('pending', 'running') AND queue_item_id IN (
              SELECT q.id FROM queue_items q WHERE q.status IN (${placeholders}) AND ${hasSignalCheckpoint('q')}
            )`,
            )
            .run(this.now(), ...statuses);
        }
        // Detach referencing rows before deleting (FK constraints without ON DELETE CASCADE).
        this.db
          .prepare(
            `UPDATE runs SET queue_item_id = NULL WHERE queue_item_id IN (SELECT id FROM queue_items WHERE status IN (${placeholders}))`,
          )
          .run(...statuses);
        this.db
          .prepare(
            `UPDATE a2a_tasks SET queue_item_id = NULL WHERE queue_item_id IN (SELECT id FROM queue_items WHERE status IN (${placeholders}))`,
          )
          .run(...statuses);
        const result = this.db
          .prepare(`DELETE FROM queue_items WHERE status IN (${placeholders})`)
          .run(...statuses);
        return result.changes;
      });
      return ok(purgeTransaction());
    } catch {
      return err(new DbError('Failed to purge queue items'));
    }
  }
}
