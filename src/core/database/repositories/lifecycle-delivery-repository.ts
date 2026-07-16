/** Durable claims, retries, terminal state, and replay primitives for lifecycle deliveries. */

import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import { types } from 'node:util';
import { z } from 'zod';
import {
  LifecycleEventEnvelopeSchema,
  LifecycleFailurePolicyContractSchema,
  LifecycleFilterOwnerNameSchema,
  LifecycleHandlerIdentityContractSchema,
  LifecycleIdentifierSchema,
  LifecycleRuntimeIdSchema,
} from '../../../lifecycle/contracts/index.js';
import type {
  LifecycleFailurePolicyContract,
  LifecycleHandlerIdentityContract,
} from '../../../lifecycle/contracts/index.js';
import { DbError } from '../../errors/index.js';
import {
  validDiagnostic,
  validFailurePolicy,
  validIdentity,
  validPayload,
  validProvenance,
} from '../lifecycle-sql-functions.js';
import { BaseRepository } from './base-repository.js';
import {
  hasDurableHandlerIdentityAuthority,
  hasCompatibleLifecycleFailurePolicy,
  isBoundedWellFormedUtf8,
  isBoundedUnicodeScalarsUtf8,
  snapshotBoundedPlainDataRecord,
  snapshotLifecycleDeliveries,
  snapshotLifecycleEvent,
  snapshotLifecycleFailureDiagnostic,
} from './lifecycle-persistence-validation.js';
import type { LifecycleEventRow } from './lifecycle-event-repository.js';

export type LifecycleDeliveryStatus =
  | 'pending'
  | 'claimed'
  | 'failed'
  | 'completed'
  | 'dead_letter';

/** Immutable handler snapshot used when fanning out one persisted event. */
export interface LifecycleDeliveryFanoutInput {
  handlerId: string;
  persona: string;
  priority: number;
  identity: LifecycleHandlerIdentityContract;
  failurePolicy: LifecycleFailurePolicyContract;
  maxAttempts?: number;
}

/** Database row for a single stable (event_id, handler_id) delivery identity. */
export interface LifecycleDeliveryRow {
  event_id: string;
  handler_id: string;
  persona: string;
  priority: number;
  handler_identity: string;
  failure_policy: string;
  status: LifecycleDeliveryStatus;
  attempts: number;
  max_attempts: number;
  next_retry_at: number | null;
  claim_token: string | null;
  claim_expires_at: number | null;
  last_error: string | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

/** A successful claim carries the immutable event envelope row for execution. */
export interface ClaimedLifecycleDelivery {
  delivery: LifecycleDeliveryRow;
  event: LifecycleEventRow;
}

export interface ClaimLifecycleDeliveryOptions {
  leaseMs: number;
  /** Handler IDs temporarily unavailable to this dispatcher instance. */
  excludedHandlerIds?: readonly string[];
}

/** Trusted clock supplied by repository composition; production defaults to Date.now. */
export type LifecycleDeliveryClock = () => number;

/** Persisted failure diagnostics intentionally carry only a stable, non-secret code. */
export interface LifecycleFailureDiagnostic {
  code: string;
}

const LifecycleFailureDiagnosticSchema = z.object({ code: LifecycleIdentifierSchema }).strict();

const LifecycleDeliveryStatusSchema = z.enum([
  'pending',
  'claimed',
  'failed',
  'completed',
  'dead_letter',
]);

const MAX_LIFECYCLE_DELIVERY_PERSONA_LENGTH = 256;
const MAX_LIFECYCLE_DELIVERY_PERSONA_UTF8_BYTES = 1_024;

function toDbError(operation: string, cause: unknown): DbError {
  // Public boundaries must not retain caller-controlled Error instances: they
  // can contain credentials and can expose hostile values through a later
  // inspection of Error.cause.
  void cause;
  return new DbError(`Failed to ${operation}`);
}

/** Repository for independently retryable lifecycle handler deliveries. */
export class LifecycleDeliveryRepository extends BaseRepository {
  private readonly claimNextStmt: Database.Statement;
  private readonly findByKeyStmt: Database.Statement;
  private readonly findByEventIdStmt: Database.Statement;
  private readonly completeStmt: Database.Statement;
  private readonly failStmt: Database.Statement;
  private readonly expireClaimsStmt: Database.Statement;
  private readonly canReopenStmt: Database.Statement;
  private readonly reopenStmt: Database.Statement;
  private readonly findEventStmt: Database.Statement;

  constructor(
    db: Database.Database,
    private readonly leaseClock: LifecycleDeliveryClock = Date.now,
  ) {
    super(db);
    this.claimNextStmt = db.prepare(`
      WITH candidate AS (
        SELECT d.event_id, d.handler_id
        FROM lifecycle_event_deliveries d
        JOIN lifecycle_events e ON e.event_id = d.event_id
        WHERE d.status IN ('pending', 'failed')
          AND (d.next_retry_at IS NULL OR d.next_retry_at <= @lease_now)
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(@excluded_handler_ids) excluded_handler
            WHERE excluded_handler.value = d.handler_id
          )
          AND NOT EXISTS (
          SELECT 1
          FROM lifecycle_event_deliveries previous_delivery
          JOIN lifecycle_events previous_event ON previous_event.event_id = previous_delivery.event_id
          WHERE previous_delivery.handler_id = d.handler_id
            AND previous_event.aggregate_type = e.aggregate_type
            AND previous_event.aggregate_id = e.aggregate_id
            AND previous_event.event_sequence < e.event_sequence
            AND previous_delivery.status NOT IN ('completed', 'dead_letter')
        )
        ORDER BY d.priority DESC, e.event_sequence ASC, d.created_at ASC
        LIMIT 1
      )
      UPDATE lifecycle_event_deliveries
      SET status = 'claimed',
          claim_token = @claim_token,
          claim_expires_at = @claim_expires_at,
          next_retry_at = NULL,
          last_error = NULL,
          updated_at = @write_now
      WHERE (event_id, handler_id) IN (SELECT event_id, handler_id FROM candidate)
      RETURNING *
    `);
    this.findByKeyStmt = db.prepare(`
      SELECT * FROM lifecycle_event_deliveries WHERE event_id = ? AND handler_id = ?
    `);
    this.findByEventIdStmt = db.prepare(`
      SELECT * FROM lifecycle_event_deliveries WHERE event_id = ? ORDER BY priority DESC, created_at ASC
    `);
    this.completeStmt = db.prepare(`
      UPDATE lifecycle_event_deliveries
      SET status = 'completed', claim_token = NULL, claim_expires_at = NULL,
          next_retry_at = NULL, last_error = NULL, completed_at = @write_now, updated_at = @write_now
      WHERE event_id = @event_id AND handler_id = @handler_id
        AND status = 'claimed' AND claim_token = @claim_token
        AND claim_expires_at > @lease_now
      RETURNING *
    `);
    this.failStmt = db.prepare(`
      UPDATE lifecycle_event_deliveries
      SET status = CASE WHEN @retryable = 0 OR attempts + 1 >= max_attempts THEN 'dead_letter' ELSE 'failed' END,
          -- Every claimed execution consumes exactly one attempt. Non-retryable
          -- outcomes terminally dead-letter that attempted lease immediately.
          attempts = attempts + 1,
          next_retry_at = CASE WHEN @retryable = 0 OR attempts + 1 >= max_attempts THEN NULL ELSE @next_retry_at END,
          claim_token = NULL, claim_expires_at = NULL, last_error = @last_error,
          updated_at = @write_now
      WHERE event_id = @event_id AND handler_id = @handler_id
        AND status = 'claimed' AND claim_token = @claim_token
        AND claim_expires_at > @lease_now
      RETURNING *
    `);
    this.expireClaimsStmt = db.prepare(`
      UPDATE lifecycle_event_deliveries
      SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'dead_letter' ELSE 'failed' END,
          attempts = attempts + 1,
          next_retry_at = CASE WHEN attempts + 1 >= max_attempts THEN NULL ELSE @lease_now END,
          claim_token = NULL,
          claim_expires_at = NULL,
          last_error = '{"code":"lease-expired"}',
          updated_at = @write_now
      WHERE status = 'claimed' AND claim_expires_at <= @lease_now
    `);
    this.canReopenStmt = db.prepare(`
      SELECT 1
      FROM lifecycle_event_deliveries target_delivery
      WHERE target_delivery.event_id = @event_id AND target_delivery.handler_id = @handler_id
        AND target_delivery.status IN ('completed', 'dead_letter')
        AND NOT EXISTS (
          SELECT 1
          FROM lifecycle_event_deliveries later_delivery
          JOIN lifecycle_events target_event ON target_event.event_id = target_delivery.event_id
          JOIN lifecycle_events later_event ON later_event.event_id = later_delivery.event_id
          WHERE later_delivery.handler_id = target_delivery.handler_id
            AND later_event.aggregate_type = target_event.aggregate_type
            AND later_event.aggregate_id = target_event.aggregate_id
            AND later_event.event_sequence > target_event.event_sequence
            AND later_delivery.status = 'claimed'
            AND later_delivery.claim_expires_at > @lease_now
        )
    `);
    this.reopenStmt = db.prepare(`
      UPDATE lifecycle_event_deliveries
      SET status = 'pending', attempts = 0, next_retry_at = NULL,
          claim_token = NULL, claim_expires_at = NULL, last_error = NULL,
          completed_at = NULL, updated_at = @write_now
      WHERE event_id = @event_id AND handler_id = @handler_id
        AND status IN ('completed', 'dead_letter')
        AND NOT EXISTS (
          SELECT 1
          FROM lifecycle_event_deliveries later_delivery
          JOIN lifecycle_events target_event ON target_event.event_id = lifecycle_event_deliveries.event_id
          JOIN lifecycle_events later_event ON later_event.event_id = later_delivery.event_id
          WHERE later_delivery.handler_id = lifecycle_event_deliveries.handler_id
            AND later_event.aggregate_type = target_event.aggregate_type
            AND later_event.aggregate_id = target_event.aggregate_id
            AND later_event.event_sequence > target_event.event_sequence
            AND later_delivery.status = 'claimed'
            AND later_delivery.claim_expires_at > @lease_now
        )
      RETURNING *
    `);
    this.findEventStmt = db.prepare(`SELECT * FROM lifecycle_events WHERE event_id = ?`);
  }

  /**
   * Atomically claims the highest-priority eligible delivery. Earlier
   * unfinished work for the same aggregate and handler blocks later events.
   * Expired leases are eligible again, making a process restart recoverable.
   */
  claimNext(
    options: ClaimLifecycleDeliveryOptions,
  ): Result<ClaimedLifecycleDelivery | null, DbError> {
    try {
      const normalizedOptions = this.normalizeClaimOptions(options);
      if (!normalizedOptions) {
        return err(
          new DbError(
            'Failed to claim lifecycle delivery: leaseMs must be an integer between 1 and 86400000',
          ),
        );
      }
      const leaseNow = this.leaseNow();
      const claimExpiresAt = leaseNow + normalizedOptions.leaseMs;
      if (!Number.isSafeInteger(leaseNow) || !Number.isSafeInteger(claimExpiresAt)) {
        return err(new DbError('Failed to claim lifecycle delivery: lease timestamp overflow'));
      }
      // A lease token is always repository-owned. A caller must never be able
      // to resurrect a stale worker's token during expiry reclamation.
      const claimToken = uuidv4();
      const claim = this.db.transaction((): ClaimedLifecycleDelivery | null => {
        const writeNow = this.now();
        // A vanished worker consumed an execution attempt. Reclaim every
        // expired lease before selecting work so an exhausted earlier event
        // dead-letters and can no longer block its aggregate.
        this.expireClaimsStmt.run({ lease_now: leaseNow, write_now: writeNow });
        const row = this.claimNextStmt.get({
          lease_now: leaseNow,
          write_now: writeNow,
          claim_token: claimToken,
          claim_expires_at: claimExpiresAt,
          excluded_handler_ids: JSON.stringify(normalizedOptions.excludedHandlerIds),
        }) as LifecycleDeliveryRow | undefined;
        if (!row) {
          return null;
        }
        const delivery = this.validateDeliveryRow(row);
        const storedEvent = this.findEventStmt.get(delivery.event_id) as
          | LifecycleEventRow
          | undefined;
        if (!storedEvent) {
          throw new Error('claimed lifecycle delivery has no event');
        }
        return { delivery, event: this.validateEventRow(storedEvent) };
      });
      return ok(claim());
    } catch (cause) {
      return err(toDbError('claim lifecycle delivery', cause));
    }
  }

  /** Completes only the current lease holder; stale workers cannot complete reclaimed work. */
  complete(
    eventId: string,
    handlerId: string,
    claimToken: string,
  ): Result<LifecycleDeliveryRow, DbError> {
    try {
      if (
        !this.isRuntimeId(eventId) ||
        !this.isIdentifier(handlerId) ||
        !this.isRuntimeId(claimToken)
      ) {
        return err(new DbError('Failed to complete lifecycle delivery: invalid delivery identity'));
      }
      const complete = this.db.transaction((): LifecycleDeliveryRow | null => {
        const leaseNow = this.leaseNow();
        const row = this.completeStmt.get({
          event_id: eventId,
          handler_id: handlerId,
          claim_token: claimToken,
          lease_now: leaseNow,
          write_now: this.now(),
        }) as LifecycleDeliveryRow | undefined;
        return row ? this.validateDeliveryRow(row) : null;
      });
      const row = complete();
      return row
        ? ok(row)
        : err(new DbError('Failed to complete lifecycle delivery: no active matching lease'));
    } catch (cause) {
      return err(toDbError('complete lifecycle delivery', cause));
    }
  }

  /**
   * Records a retryable failure or atomically moves the delivery to its
   * terminal dead-letter state once its bounded attempt budget is exhausted.
   */
  fail(
    eventId: string,
    handlerId: string,
    claimToken: string,
    failureDiagnostic: LifecycleFailureDiagnostic,
    nextRetryAt: number,
    retryable = true,
  ): Result<LifecycleDeliveryRow, DbError> {
    try {
      const diagnosticSnapshot = snapshotLifecycleFailureDiagnostic(failureDiagnostic);
      const diagnostic = diagnosticSnapshot
        ? this.parse(LifecycleFailureDiagnosticSchema, diagnosticSnapshot)
        : null;
      if (
        !diagnostic ||
        !this.isRuntimeId(eventId) ||
        !this.isIdentifier(handlerId) ||
        !this.isRuntimeId(claimToken) ||
        !Number.isSafeInteger(nextRetryAt) ||
        typeof retryable !== 'boolean'
      ) {
        return err(
          new DbError(
            'Failed to fail lifecycle delivery: invalid failure diagnostic or retry timestamp',
          ),
        );
      }
      const fail = this.db.transaction((): LifecycleDeliveryRow | null => {
        const leaseNow = this.leaseNow();
        const row = this.failStmt.get({
          event_id: eventId,
          handler_id: handlerId,
          claim_token: claimToken,
          next_retry_at: nextRetryAt,
          retryable: retryable ? 1 : 0,
          // Never persist arbitrary handler error text; it may contain prompts,
          // tokens, headers, or other secrets. A parsed contract-owned code is
          // sufficient for retry policy and operator aggregation.
          last_error: JSON.stringify(diagnostic),
          lease_now: leaseNow,
          write_now: this.now(),
        }) as LifecycleDeliveryRow | undefined;
        return row ? this.validateDeliveryRow(row) : null;
      });
      const row = fail();
      return row ? ok(row) : err(new DbError('Failed to fail lifecycle delivery: lease was lost'));
    } catch (cause) {
      return err(toDbError('fail lifecycle delivery', cause));
    }
  }

  /** Reopens one terminal delivery for an explicit replay without creating a second identity. */
  reopen(eventId: string, handlerId: string): Result<LifecycleDeliveryRow, DbError> {
    try {
      if (!this.isRuntimeId(eventId) || !this.isIdentifier(handlerId)) {
        return err(new DbError('Failed to reopen lifecycle delivery: invalid delivery identity'));
      }
      const reopen = this.db.transaction((): LifecycleDeliveryRow | null => {
        const leaseNow = this.leaseNow();
        // Prove this specific replay is eligible before recovering any stale
        // leases. A rejected replay must be observationally read-only for
        // unrelated deliveries in the same transaction.
        if (
          !this.canReopenStmt.get({ event_id: eventId, handler_id: handlerId, lease_now: leaseNow })
        ) {
          return null;
        }
        const writeNow = this.now();
        // Expiry is handled before replay, rather than merely changing an
        // opaque token: the stale worker is invalidated and its lost execution
        // consumes exactly one attempt in the same transaction.
        this.expireClaimsStmt.run({
          lease_now: leaseNow,
          write_now: writeNow,
        });
        const row = this.reopenStmt.get({
          event_id: eventId,
          handler_id: handlerId,
          lease_now: leaseNow,
          write_now: writeNow,
        }) as LifecycleDeliveryRow | undefined;
        if (!row) {
          // The eligibility check and state transition share one SQLite
          // transaction. If they diverge, roll back expiry recovery too.
          throw new Error('lifecycle delivery replay eligibility changed inside transaction');
        }
        return this.validateDeliveryRow(row);
      });
      const row = reopen();
      return row
        ? ok(row)
        : err(new DbError('Failed to reopen lifecycle delivery: delivery is not terminal'));
    } catch (cause) {
      return err(toDbError('reopen lifecycle delivery', cause));
    }
  }

  findByEventId(eventId: string): Result<LifecycleDeliveryRow[], DbError> {
    try {
      if (!this.isRuntimeId(eventId)) {
        return err(
          new DbError('Failed to find lifecycle deliveries by event id: invalid event id'),
        );
      }
      return ok(
        (this.findByEventIdStmt.all(eventId) as LifecycleDeliveryRow[]).map((row) =>
          this.validateDeliveryRow(row),
        ),
      );
    } catch (cause) {
      return err(toDbError('find lifecycle deliveries by event id', cause));
    }
  }

  findByKey(eventId: string, handlerId: string): Result<LifecycleDeliveryRow | null, DbError> {
    try {
      if (!this.isRuntimeId(eventId) || !this.isIdentifier(handlerId)) {
        return err(
          new DbError('Failed to find lifecycle delivery by key: invalid delivery identity'),
        );
      }
      const row = this.findByKeyStmt.get(eventId, handlerId) as LifecycleDeliveryRow | undefined;
      return ok(row ? this.validateDeliveryRow(row) : null);
    } catch (cause) {
      return err(toDbError('find lifecycle delivery by key', cause));
    }
  }

  private normalizeClaimOptions(options: unknown): ClaimLifecycleDeliveryOptions | null {
    // Unknown data fields remain backward-compatible, but their inspection is
    // capped before any descriptor values are materialized.
    const snapshot = snapshotBoundedPlainDataRecord(options, 8);
    if (!snapshot || !Object.hasOwn(snapshot, 'leaseMs')) return null;
    const leaseMs: unknown = snapshot.leaseMs;
    if (
      typeof leaseMs !== 'number' ||
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 1 ||
      leaseMs > 86_400_000
    ) {
      return null;
    }
    const excludedHandlerIds = this.normalizeExcludedHandlerIds(snapshot.excludedHandlerIds);
    if (!excludedHandlerIds) return null;
    return { leaseMs, excludedHandlerIds };
  }

  private normalizeExcludedHandlerIds(value: unknown): string[] | null {
    if (value === undefined) return [];
    try {
      if (
        !Array.isArray(value) ||
        types.isProxy(value) ||
        Reflect.getPrototypeOf(value) !== Array.prototype ||
        value.length > 4_096
      ) {
        return null;
      }
      const ids: string[] = [];
      const seen = new Set<string>();
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
        const handlerId: unknown = descriptor.value;
        if (typeof handlerId !== 'string' || !this.isIdentifier(handlerId) || seen.has(handlerId)) {
          return null;
        }
        seen.add(handlerId);
        ids.push(handlerId);
      }
      return ids;
    } catch {
      return null;
    }
  }

  /** Lease mutation time is repository-owned, never supplied by a claim caller. */
  protected override leaseNow(): number {
    const now = this.leaseClock();
    if (!Number.isSafeInteger(now)) {
      throw new Error('invalid lifecycle lease clock');
    }
    return now;
  }

  private validateDeliveryRow(row: LifecycleDeliveryRow): LifecycleDeliveryRow {
    if (!row || typeof row !== 'object') {
      throw new Error('invalid persisted lifecycle delivery row');
    }
    if (
      !validIdentity(row.handler_identity, row.handler_id) ||
      !validFailurePolicy(row.failure_policy) ||
      (row.last_error !== null && !validDiagnostic(row.last_error))
    )
      throw new Error('invalid persisted lifecycle delivery JSON');
    const rawIdentity = this.parseJson(row.handler_identity, 'handler identity');
    const rawFailurePolicy = this.parseJson(row.failure_policy, 'failure policy');
    const snapshot = snapshotLifecycleDeliveries([
      {
        handlerId: row.handler_id,
        persona: row.persona,
        priority: row.priority,
        identity: rawIdentity,
        failurePolicy: rawFailurePolicy,
        maxAttempts: row.max_attempts,
      },
    ]);
    if (!snapshot) {
      throw new Error('invalid persisted lifecycle delivery row');
    }
    const deliverySnapshot = snapshot[0];
    if (!deliverySnapshot) {
      throw new Error('invalid persisted lifecycle delivery row');
    }
    const identity = this.parse(LifecycleHandlerIdentityContractSchema, deliverySnapshot.identity);
    const failurePolicy = this.parse(
      LifecycleFailurePolicyContractSchema,
      deliverySnapshot.failurePolicy,
    );
    const diagnostic =
      row.last_error === null
        ? null
        : this.parse(
            LifecycleFailureDiagnosticSchema,
            this.parseJson(row.last_error, 'failure diagnostic'),
          );
    if (
      !identity ||
      !hasDurableHandlerIdentityAuthority(identity) ||
      !failurePolicy ||
      !hasCompatibleLifecycleFailurePolicy(identity, failurePolicy) ||
      (row.last_error !== null && !diagnostic) ||
      !this.isRuntimeId(row.event_id) ||
      !this.isIdentifier(row.handler_id) ||
      identity.handlerId !== row.handler_id ||
      !this.isBoundedPersona(row.persona) ||
      !this.parses(LifecycleDeliveryStatusSchema, row.status) ||
      !Number.isSafeInteger(row.priority) ||
      row.priority < -1000 ||
      row.priority > 1000 ||
      !Number.isSafeInteger(row.attempts) ||
      !Number.isSafeInteger(row.max_attempts) ||
      row.attempts < 0 ||
      row.max_attempts < 1 ||
      row.max_attempts > 100 ||
      row.attempts > row.max_attempts ||
      !this.isNullableTimestamp(row.next_retry_at) ||
      !this.isNullableTimestamp(row.claim_expires_at) ||
      !this.isNullableTimestamp(row.completed_at) ||
      !Number.isSafeInteger(row.created_at) ||
      !Number.isSafeInteger(row.updated_at) ||
      !this.hasValidStatusFields(row, diagnostic)
    ) {
      throw new Error('invalid persisted lifecycle delivery row');
    }
    return {
      ...row,
      handler_identity: JSON.stringify(identity),
      failure_policy: JSON.stringify(failurePolicy),
      last_error: diagnostic ? JSON.stringify(diagnostic) : null,
    };
  }

  private validateEventRow(row: LifecycleEventRow): LifecycleEventRow {
    if (!validProvenance(row.provenance) || !validPayload(row.payload))
      throw new Error('invalid persisted lifecycle event JSON');
    const provenance = this.parseJson(row.provenance, 'event provenance');
    const payload = this.parseJson(row.payload, 'event payload');
    const snapshot = snapshotLifecycleEvent({
      version: row.version,
      eventId: row.event_id,
      type: row.type,
      occurredAt: row.occurred_at,
      context: {
        aggregate: { type: row.aggregate_type, id: row.aggregate_id },
        correlationId: row.correlation_id,
        ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
        recursion: { depth: row.recursion_depth, maxDepth: row.recursion_max_depth },
        provenance,
      },
      payload,
    });
    const event = snapshot ? this.parse(LifecycleEventEnvelopeSchema, snapshot) : null;
    if (
      !event ||
      !snapshot ||
      !Number.isSafeInteger(row.event_sequence) ||
      row.event_sequence < 1 ||
      !Number.isSafeInteger(row.created_at)
    ) {
      throw new Error('invalid persisted lifecycle event row');
    }
    return {
      ...row,
      version: event.version,
      provenance: JSON.stringify((snapshot.context as { provenance: unknown }).provenance),
      payload: JSON.stringify(snapshot.payload),
    };
  }

  private parseJson(value: unknown, field: string): unknown {
    if (typeof value !== 'string') {
      throw new Error(`invalid persisted lifecycle ${field}`);
    }
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error(`invalid persisted lifecycle ${field}`);
    }
  }

  private parse<T>(
    schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
    input: unknown,
  ): T | null {
    try {
      const parsed = schema.safeParse(input);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private parses(
    schema: { safeParse(input: unknown): { success: boolean } },
    input: unknown,
  ): boolean {
    try {
      return schema.safeParse(input).success;
    } catch {
      return false;
    }
  }

  private isRuntimeId(value: unknown): boolean {
    return (
      typeof value === 'string' &&
      isBoundedWellFormedUtf8(value, 256, 1024) &&
      value.indexOf('\0') === -1 &&
      this.parses(LifecycleRuntimeIdSchema, value)
    );
  }

  private isIdentifier(value: unknown): boolean {
    return (
      typeof value === 'string' &&
      isBoundedWellFormedUtf8(value, 128, 512) &&
      value.indexOf('\0') === -1 &&
      this.parses(LifecycleIdentifierSchema, value)
    );
  }

  private isBoundedPersona(value: unknown): boolean {
    return (
      typeof value === 'string' &&
      value.indexOf('\0') === -1 &&
      isBoundedUnicodeScalarsUtf8(
        value,
        MAX_LIFECYCLE_DELIVERY_PERSONA_LENGTH,
        MAX_LIFECYCLE_DELIVERY_PERSONA_UTF8_BYTES,
      ) &&
      this.parses(LifecycleFilterOwnerNameSchema, value)
    );
  }

  private isNullableTimestamp(value: unknown): boolean {
    return value === null || Number.isSafeInteger(value);
  }

  private hasValidStatusFields(
    row: LifecycleDeliveryRow,
    diagnostic: LifecycleFailureDiagnostic | null,
  ): boolean {
    switch (row.status) {
      case 'pending':
        return (
          row.attempts === 0 &&
          row.next_retry_at === null &&
          row.claim_token === null &&
          row.claim_expires_at === null &&
          diagnostic === null &&
          row.completed_at === null
        );
      case 'claimed':
        return (
          row.attempts < row.max_attempts &&
          row.next_retry_at === null &&
          this.isRuntimeId(row.claim_token) &&
          Number.isSafeInteger(row.claim_expires_at) &&
          diagnostic === null &&
          row.completed_at === null
        );
      case 'failed':
        return (
          row.attempts >= 1 &&
          row.attempts < row.max_attempts &&
          Number.isSafeInteger(row.next_retry_at) &&
          row.claim_token === null &&
          row.claim_expires_at === null &&
          diagnostic !== null &&
          row.completed_at === null
        );
      case 'completed':
        return (
          row.attempts < row.max_attempts &&
          row.next_retry_at === null &&
          row.claim_token === null &&
          row.claim_expires_at === null &&
          diagnostic === null &&
          Number.isSafeInteger(row.completed_at)
        );
      case 'dead_letter':
        return (
          row.attempts >= 1 &&
          row.attempts <= row.max_attempts &&
          row.next_retry_at === null &&
          row.claim_token === null &&
          row.claim_expires_at === null &&
          diagnostic !== null &&
          row.completed_at === null
        );
    }
  }
}
