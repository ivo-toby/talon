import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from 'neverthrow';
import { BaseRepository } from './base-repository.js';
import { runResultTransaction } from '../transaction.js';
import {
  SignalAccountStateRepository,
  SignalStateError,
} from './signal-account-state-repository.js';
import {
  normalizeSignalUuid,
  parseSignalExternalId,
} from '../../../channels/connectors/signal/signal-identities.js';
import type {
  SignalDeliveryPurpose,
  TrustedDeliveryContext,
} from '../../../channels/channel-types.js';

export interface SignalDestinationLease {
  readonly accountUuid: string;
  readonly externalThreadId: string;
  readonly leaseId: string;
  readonly queueItemId: string;
  readonly deliveryId: string;
  readonly kind: SignalDeliveryPurpose;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface LeaseRow {
  readonly account_uuid: string;
  readonly external_thread_id: string;
  readonly lease_id: string;
  readonly queue_item_id: string;
  readonly delivery_id: string;
  readonly kind: SignalDeliveryPurpose;
  readonly created_at: number;
  readonly updated_at: number;
}

function leaseFromRow(row: LeaseRow): SignalDestinationLease {
  return Object.freeze({
    accountUuid: row.account_uuid,
    externalThreadId: row.external_thread_id,
    leaseId: row.lease_id,
    queueItemId: row.queue_item_id,
    deliveryId: row.delivery_id,
    kind: row.kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function canonicalAccount(
  accountUuid: string,
  externalThreadId: string,
): Result<string, SignalStateError> {
  const account = normalizeSignalUuid(accountUuid);
  return account.isOk() && parseSignalExternalId(externalThreadId, account.value).isOk()
    ? ok(account.value)
    : err(new SignalStateError('INVALID_INPUT'));
}

/**
 * One logical message owns a destination across its chunks. Saved reply/background
 * callers retain the returned lease across deferral; explicit/progress callers must
 * release it on every return. Terminal/expiry/cancellation policy belongs to the caller.
 * All methods compose with the shared synchronous Result transaction on the same DB.
 */
export class SignalDestinationLeaseRepository extends BaseRepository {
  find(
    accountUuid: string,
    externalThreadId: string,
  ): Result<SignalDestinationLease | null, SignalStateError> {
    const account = canonicalAccount(accountUuid, externalThreadId);
    if (account.isErr()) return err(account.error);
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM signal_destination_leases
        WHERE account_uuid = ? AND external_thread_id = ?`,
        )
        .get(account.value, externalThreadId) as LeaseRow | undefined;
      return ok(row === undefined ? null : leaseFromRow(row));
    } catch {
      return err(new SignalStateError('DATABASE'));
    }
  }

  /** Idempotent for the same complete owner; never renews the lease on deferral. */
  acquire(
    accountUuid: string,
    externalThreadId: string,
    context: TrustedDeliveryContext,
    now: number,
  ): Result<SignalDestinationLease, SignalStateError> {
    const account = canonicalAccount(accountUuid, externalThreadId);
    if (
      account.isErr() ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      typeof context.queueItemId !== 'string' ||
      context.queueItemId.length === 0 ||
      typeof context.deliveryId !== 'string' ||
      context.deliveryId.length === 0 ||
      !['reply', 'background', 'explicit', 'progress'].includes(context.purpose)
    )
      return err(new SignalStateError('INVALID_INPUT'));
    return this.atomic(() =>
      this.find(account.value, externalThreadId).andThen((current) => {
        if (current !== null) {
          return current.queueItemId === context.queueItemId &&
            current.deliveryId === context.deliveryId &&
            current.kind === context.purpose
            ? ok(current)
            : err(new SignalStateError('BUSY'));
        }
        if (
          this.db.prepare('SELECT 1 FROM queue_items WHERE id = ?').get(context.queueItemId) ===
          undefined
        )
          return err(new SignalStateError('NOT_FOUND'));
        this.db
          .prepare(
            `INSERT INTO signal_destination_leases
        (account_uuid, external_thread_id, lease_id, queue_item_id, delivery_id, kind, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            account.value,
            externalThreadId,
            randomUUID(),
            context.queueItemId,
            context.deliveryId,
            context.purpose,
            now,
            now,
          );
        return this.find(account.value, externalThreadId).andThen((lease) =>
          lease === null ? err(new SignalStateError('NOT_FOUND')) : ok(lease),
        );
      }),
    );
  }

  validateOwner(
    expected: SignalDestinationLease,
  ): Result<SignalDestinationLease, SignalStateError> {
    return this.find(expected.accountUuid, expected.externalThreadId).andThen((current) => {
      if (
        current === null ||
        current.leaseId !== expected.leaseId ||
        current.queueItemId !== expected.queueItemId ||
        current.deliveryId !== expected.deliveryId ||
        current.kind !== expected.kind
      )
        return err(new SignalStateError('CONFLICT'));
      return ok(current);
    });
  }

  release(expected: SignalDestinationLease): Result<void, SignalStateError> {
    return this.atomic(() =>
      this.validateOwner(expected).map((lease) => {
        this.db
          .prepare(
            `DELETE FROM signal_destination_leases
        WHERE account_uuid = ? AND external_thread_id = ? AND lease_id = ?`,
          )
          .run(lease.accountUuid, lease.externalThreadId, lease.leaseId);
      }),
    );
  }

  /**
   * Startup/reload recovery only, with dispatch quiesced. Classify/clear the account
   * reservation first. The revision CAS prevents cleanup against a stale classification.
   * Also removes a crashed invocation's lease acquired BEFORE it created a reservation.
   * Saved reply/background owners require checkpoint classification and are never removed here.
   */
  releaseOrphanInvocations(
    accountUuid: string,
    expectedAccountRevision: number,
  ): Result<number, SignalStateError> {
    if (!Number.isSafeInteger(expectedAccountRevision) || expectedAccountRevision < 0)
      return err(new SignalStateError('INVALID_INPUT'));
    return this.atomic(() =>
      new SignalAccountStateRepository(this.db).findByAccount(accountUuid).andThen((state) => {
        if (state === null) return err(new SignalStateError('NOT_FOUND'));
        if (state.revision !== expectedAccountRevision)
          return err(new SignalStateError('CONFLICT'));
        if (state.reservation !== null) return err(new SignalStateError('BUSY'));
        const result = this.db
          .prepare(
            `DELETE FROM signal_destination_leases
        WHERE account_uuid = ? AND kind IN ('explicit', 'progress')`,
          )
          .run(state.accountUuid);
        return ok(result.changes);
      }),
    );
  }

  private atomic<T>(operation: () => Result<T, SignalStateError>): Result<T, SignalStateError> {
    try {
      return runResultTransaction((fn) => this.transaction(fn), operation);
    } catch {
      return err(new SignalStateError('DATABASE'));
    }
  }
}
