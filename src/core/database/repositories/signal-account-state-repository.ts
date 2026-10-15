import { err, ok, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';
import { runResultTransaction } from '../transaction.js';
import { normalizeSignalUuid } from '../../../channels/connectors/signal/signal-identities.js';
import type {
  SignalDeliveryPurpose,
  TrustedDeliveryContext,
} from '../../../channels/channel-types.js';

export type SignalStateFailureReason =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BUSY'
  | 'PAUSED'
  | 'BUDGET'
  | 'DATABASE';

/** Fixed diagnostics only: SQLite errors can contain private identifiers or payloads. */
export class SignalStateError extends DbError {
  constructor(
    readonly reason: SignalStateFailureReason,
    readonly nextAttemptAt?: number,
  ) {
    super(`Signal state operation failed: ${reason}`);
  }
}

export interface SignalSendReservation {
  readonly queueItemId: string;
  readonly deliveryId: string;
  readonly purpose: SignalDeliveryPurpose;
  readonly startedAt: number;
}

export type SignalPauseKind = 'none' | 'rate_limit' | 'challenge' | 'recovery';
export type SignalPause =
  | { readonly kind: 'rate_limit'; readonly notBefore: number }
  | { readonly kind: 'challenge' }
  | { readonly kind: 'recovery' };

export interface SignalAccountState {
  readonly accountUuid: string;
  readonly revision: number;
  readonly lastSendStart: number | null;
  readonly lastDeviceCheckStart: number | null;
  readonly reservation: SignalSendReservation | null;
  /** Committed cause; expiry is tested using notBefore, not by resetting this enum. */
  readonly pauseKind: SignalPauseKind;
  readonly notBefore: number;
  readonly rateLimitNotBefore: number;
  readonly recoveryNotBefore: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface AccountRow {
  readonly account_uuid: string;
  readonly revision: number;
  readonly last_send_start: number | null;
  readonly last_device_check_start: number | null;
  readonly reservation_queue_item_id: string | null;
  readonly reservation_delivery_id: string | null;
  readonly reservation_purpose: SignalDeliveryPurpose | null;
  readonly reservation_started_at: number | null;
  readonly pause_kind: SignalPauseKind;
  readonly not_before: number;
  readonly rate_limit_not_before: number;
  readonly recovery_not_before: number;
  readonly created_at: number;
  readonly updated_at: number;
}

function stateFromRow(row: AccountRow): SignalAccountState {
  const reservation =
    row.reservation_queue_item_id !== null &&
    row.reservation_delivery_id !== null &&
    row.reservation_purpose !== null &&
    row.reservation_started_at !== null
      ? Object.freeze({
          queueItemId: row.reservation_queue_item_id,
          deliveryId: row.reservation_delivery_id,
          purpose: row.reservation_purpose,
          startedAt: row.reservation_started_at,
        })
      : null;
  return Object.freeze({
    accountUuid: row.account_uuid,
    revision: row.revision,
    lastSendStart: row.last_send_start,
    lastDeviceCheckStart: row.last_device_check_start,
    reservation,
    pauseKind: row.pause_kind,
    notBefore: row.not_before,
    rateLimitNotBefore: row.rate_limit_not_before,
    recoveryNotBefore: row.recovery_not_before,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function isTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validContext(context: TrustedDeliveryContext): boolean {
  return (
    typeof context.queueItemId === 'string' &&
    context.queueItemId.length > 0 &&
    typeof context.deliveryId === 'string' &&
    context.deliveryId.length > 0 &&
    ['reply', 'background', 'explicit', 'progress'].includes(context.purpose)
  );
}

/**
 * Synchronous, connection-local Result operations. Compose with checkpoint/lease writes
 * via runResultTransaction(fn => repo.transaction(fn), operation) on the same DB.
 * No callback here performs network work; device-check in-flight ownership is the scheduler's.
 */
export class SignalAccountStateRepository extends BaseRepository {
  findByAccount(accountUuid: string): Result<SignalAccountState | null, SignalStateError> {
    const account = normalizeSignalUuid(accountUuid);
    if (account.isErr()) return err(new SignalStateError('INVALID_INPUT'));
    try {
      const row = this.db
        .prepare('SELECT * FROM signal_account_state WHERE account_uuid = ?')
        .get(account.value) as AccountRow | undefined;
      return ok(row === undefined ? null : stateFromRow(row));
    } catch {
      return err(new SignalStateError('DATABASE'));
    }
  }

  getOrCreate(accountUuid: string, now: number): Result<SignalAccountState, SignalStateError> {
    const account = normalizeSignalUuid(accountUuid);
    if (account.isErr() || !isTime(now)) return err(new SignalStateError('INVALID_INPUT'));
    try {
      return runResultTransaction(
        (fn) => this.transaction(fn),
        () => {
          this.db
            .prepare(
              `INSERT INTO signal_account_state (account_uuid, created_at, updated_at)
          VALUES (?, ?, ?) ON CONFLICT(account_uuid) DO NOTHING`,
            )
            .run(account.value, now, now);
          return this.requireState(account.value);
        },
      );
    } catch {
      return err(new SignalStateError('DATABASE'));
    }
  }

  findReserved(): Result<readonly SignalAccountState[], SignalStateError> {
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM signal_account_state
        WHERE reservation_delivery_id IS NOT NULL ORDER BY account_uuid`,
        )
        .all() as AccountRow[];
      return ok(Object.freeze(rows.map(stateFromRow)));
    } catch {
      return err(new SignalStateError('DATABASE'));
    }
  }

  /** Commit before listDevices; a backwards clock never opens another 60-second slot. */
  startDeviceCheck(
    accountUuid: string,
    expectedRevision: number,
    now: number,
  ): Result<SignalAccountState, SignalStateError> {
    if (!isTime(now + 60_000)) return err(new SignalStateError('INVALID_INPUT'));
    return this.change(accountUuid, expectedRevision, now, (state) => {
      const blocked = this.checkPause(state, now);
      if (blocked.isErr()) return blocked;
      return this.writeDeviceCheckStart(state, now);
    });
  }

  /**
   * Privileged resume plumbing only: caller authenticates operator intent and external
   * challenge resolution. Ignores only the challenge bit, never rate/recovery/budget.
   * After successful pinned-account/device verification, clearChallenge must use THIS
   * returned revision; an intervening challenge/state change invalidates that proof.
   */
  startChallengeResumeDeviceCheck(
    accountUuid: string,
    expectedRevision: number,
    now: number,
  ): Result<SignalAccountState, SignalStateError> {
    if (!isTime(now + 60_000)) return err(new SignalStateError('INVALID_INPUT'));
    return this.change(accountUuid, expectedRevision, now, (state) => {
      if (state.pauseKind !== 'challenge') return err(new SignalStateError('CONFLICT'));
      if (now < state.notBefore) return err(new SignalStateError('PAUSED', state.notBefore));
      return this.writeDeviceCheckStart(state, now);
    });
  }

  /** The queue row must still exist; the reservation intentionally survives later purge. */
  reserveSend(
    accountUuid: string,
    expectedRevision: number,
    context: TrustedDeliveryContext,
    now: number,
  ): Result<SignalAccountState, SignalStateError> {
    if (!validContext(context) || !isTime(now + 1_000))
      return err(new SignalStateError('INVALID_INPUT'));
    return this.change(accountUuid, expectedRevision, now, (state) => {
      if (state.reservation !== null) return err(new SignalStateError('BUSY'));
      const blocked = this.checkPause(state, now);
      if (blocked.isErr()) return blocked;
      if (state.lastSendStart !== null && now - state.lastSendStart < 1_000)
        return err(new SignalStateError('BUDGET', state.lastSendStart + 1_000));
      if (
        this.db.prepare('SELECT 1 FROM queue_items WHERE id = ?').get(context.queueItemId) ===
        undefined
      )
        return err(new SignalStateError('NOT_FOUND'));
      this.db
        .prepare(
          `UPDATE signal_account_state SET last_send_start = ?,
        reservation_queue_item_id = ?, reservation_delivery_id = ?, reservation_purpose = ?,
        reservation_started_at = ? WHERE account_uuid = ?`,
        )
        .run(now, context.queueItemId, context.deliveryId, context.purpose, now, state.accountUuid);
      return ok(undefined);
    });
  }

  /** Clear only the classified owner. Compose with cursor/pause writes in an outer Result transaction. */
  clearReservation(
    accountUuid: string,
    expectedRevision: number,
    owner: SignalSendReservation,
    now: number,
  ): Result<SignalAccountState, SignalStateError> {
    return this.change(accountUuid, expectedRevision, now, (state) => {
      const current = state.reservation;
      if (
        current === null ||
        current.queueItemId !== owner.queueItemId ||
        current.deliveryId !== owner.deliveryId ||
        current.purpose !== owner.purpose ||
        current.startedAt !== owner.startedAt
      )
        return err(new SignalStateError('CONFLICT'));
      this.db
        .prepare(
          `UPDATE signal_account_state SET reservation_queue_item_id = NULL,
        reservation_delivery_id = NULL, reservation_purpose = NULL, reservation_started_at = NULL
        WHERE account_uuid = ?`,
        )
        .run(state.accountUuid);
      return ok(undefined);
    });
  }

  /** Classified rate deadlines are absolute safe milliseconds, not raw RPC delay fields. */
  recordPause(
    accountUuid: string,
    expectedRevision: number,
    pause: SignalPause,
    now: number,
  ): Result<SignalAccountState, SignalStateError> {
    if (
      !['rate_limit', 'challenge', 'recovery'].includes(pause.kind) ||
      (pause.kind === 'rate_limit' && !isTime(pause.notBefore))
    )
      return err(new SignalStateError('INVALID_INPUT'));
    return this.change(accountUuid, expectedRevision, now, (state) => {
      // Do not let a clock rewind shorten a newly detected restriction.
      const detectedAt = Math.max(now, state.updatedAt);
      if (pause.kind === 'challenge') {
        this.db
          .prepare('UPDATE signal_account_state SET challenge = 1 WHERE account_uuid = ?')
          .run(state.accountUuid);
      } else {
        const minimum = detectedAt + (pause.kind === 'rate_limit' ? 900_000 : 60_000);
        if (!isTime(minimum)) return err(new SignalStateError('INVALID_INPUT'));
        const deadline = pause.kind === 'rate_limit' ? Math.max(minimum, pause.notBefore) : minimum;
        const column =
          pause.kind === 'rate_limit' ? 'rate_limit_not_before' : 'recovery_not_before';
        this.db
          .prepare(
            `UPDATE signal_account_state SET ${column} = MAX(${column}, ?) WHERE account_uuid = ?`,
          )
          .run(deadline, state.accountUuid);
      }
      return ok(undefined);
    });
  }

  /**
   * Privileged caller verifies external resolution and the pinned account/device first,
   * then uses the check-start revision unchanged. Never reread/retry a stale verification
   * against a newer revision. This clears neither rate nor recovery deadlines.
   */
  clearChallenge(
    accountUuid: string,
    expectedRevision: number,
    now: number,
  ): Result<SignalAccountState, SignalStateError> {
    return this.change(accountUuid, expectedRevision, now, (state) => {
      if (state.pauseKind !== 'challenge') return err(new SignalStateError('CONFLICT'));
      this.db
        .prepare('UPDATE signal_account_state SET challenge = 0 WHERE account_uuid = ?')
        .run(state.accountUuid);
      return ok(undefined);
    });
  }

  private writeDeviceCheckStart(
    state: SignalAccountState,
    now: number,
  ): Result<void, SignalStateError> {
    if (state.lastDeviceCheckStart !== null && now - state.lastDeviceCheckStart < 60_000)
      return err(new SignalStateError('BUDGET', state.lastDeviceCheckStart + 60_000));
    this.db
      .prepare('UPDATE signal_account_state SET last_device_check_start = ? WHERE account_uuid = ?')
      .run(now, state.accountUuid);
    return ok(undefined);
  }

  private requireState(accountUuid: string): Result<SignalAccountState, SignalStateError> {
    return this.findByAccount(accountUuid).andThen((state) =>
      state === null ? err(new SignalStateError('NOT_FOUND')) : ok(state),
    );
  }

  private checkPause(state: SignalAccountState, now: number): Result<void, SignalStateError> {
    return state.pauseKind === 'challenge' || now < state.notBefore
      ? err(
          new SignalStateError(
            'PAUSED',
            state.pauseKind === 'challenge' ? undefined : state.notBefore,
          ),
        )
      : ok(undefined);
  }

  private change(
    accountUuid: string,
    expectedRevision: number,
    now: number,
    operation: (state: SignalAccountState) => Result<void, SignalStateError>,
  ): Result<SignalAccountState, SignalStateError> {
    const account = normalizeSignalUuid(accountUuid);
    if (
      account.isErr() ||
      !isTime(now) ||
      !isTime(expectedRevision) ||
      expectedRevision === Number.MAX_SAFE_INTEGER
    )
      return err(new SignalStateError('INVALID_INPUT'));
    try {
      return runResultTransaction(
        (fn) => this.transaction(fn),
        () =>
          this.requireState(account.value).andThen((state) => {
            if (state.revision !== expectedRevision) return err(new SignalStateError('CONFLICT'));
            return operation(state).andThen(() => {
              this.db
                .prepare(
                  `UPDATE signal_account_state SET revision = revision + 1,
              updated_at = MAX(updated_at, ?) WHERE account_uuid = ?`,
                )
                .run(now, account.value);
              return this.requireState(account.value);
            });
          }),
      );
    } catch {
      return err(new SignalStateError('DATABASE'));
    }
  }
}
