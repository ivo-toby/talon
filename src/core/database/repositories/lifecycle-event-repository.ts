/** Durable storage for validated lifecycle event envelopes and handler fan-out. */

import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import {
  LifecycleEventEnvelopeSchema,
  LifecycleFailurePolicyContractSchema,
  LifecycleFilterOwnerNameSchema,
  LifecycleHandlerIdentityContractSchema,
  LifecycleIdentifierSchema,
  LifecycleRuntimeIdSchema,
  type LifecycleEventEnvelope,
} from '../../../lifecycle/contracts/index.js';
import { DbError } from '../../errors/index.js';
import {
  validFailurePolicy,
  validIdentity,
  validPayload,
  validProvenance,
  withLifecycleRetentionMutationAuthorization,
} from '../lifecycle-sql-functions.js';
import { BaseRepository } from './base-repository.js';
import {
  hasCompatibleLifecycleFailurePolicy,
  hasDurableHandlerIdentityAuthority,
  isBoundedWellFormedUtf8,
  isBoundedUnicodeScalarsUtf8,
  snapshotLifecycleDeliveries,
  snapshotLifecycleEvent,
} from './lifecycle-persistence-validation.js';
import type {
  LifecycleDeliveryFanoutInput,
  LifecycleDeliveryRow,
} from './lifecycle-delivery-repository.js';

/** Database row for one immutable lifecycle event. */
export interface LifecycleEventRow {
  event_sequence: number;
  event_id: string;
  version: 'v1';
  type: string;
  aggregate_type: string;
  aggregate_id: string;
  correlation_id: string;
  causation_id: string | null;
  recursion_depth: number;
  recursion_max_depth: number;
  provenance: string;
  payload: string;
  retention_tombstone_reason: 'retention-compacted' | 'privacy-deleted' | null;
  occurred_at: string;
  created_at: number;
}

/** Result of atomically writing an event and every resolved handler delivery. */
export interface LifecycleEventFanoutResult {
  event: LifecycleEventRow;
  deliveries: LifecycleDeliveryRow[];
}

/** Counts for lifecycle event payload/provenance tombstoning operations. */
export interface LifecycleEventRetentionResult {
  compactedEvents: number;
}

function toDbError(operation: string, cause: unknown): DbError {
  // A public repository Result must not retain caller-controlled Error causes:
  // those errors can carry credentials or hostile inspection behavior.
  void cause;
  return new DbError(`Failed to ${operation}`);
}

const MAX_LIFECYCLE_DELIVERY_PERSONA_LENGTH = 256;
const MAX_LIFECYCLE_DELIVERY_PERSONA_UTF8_BYTES = 1_024;

/** Repository for the immutable lifecycle outbox. */
export class LifecycleEventRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly findByAggregateStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly insertDeliveryStmt: Database.Statement;
  private readonly findDeliveriesByEventStmt: Database.Statement;
  private readonly compactCompletedStmt: Database.Statement;
  private readonly tombstoneThreadStmt: Database.Statement;
  private readonly tombstonePersonaStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    this.insertStmt = db.prepare(`
      INSERT INTO lifecycle_events (
        event_id, version, type, aggregate_type, aggregate_id, correlation_id,
        causation_id, recursion_depth, recursion_max_depth, provenance, payload,
        occurred_at, created_at
      ) VALUES (
        @event_id, @version, @type, @aggregate_type, @aggregate_id, @correlation_id,
        @causation_id, @recursion_depth, @recursion_max_depth, @provenance, @payload,
        @occurred_at, @created_at
      )
    `);
    this.findByIdStmt = db.prepare(`SELECT * FROM lifecycle_events WHERE event_id = ?`);
    this.findByAggregateStmt = db.prepare(`
      SELECT * FROM lifecycle_events
      WHERE aggregate_type = ? AND aggregate_id = ?
      ORDER BY event_sequence ASC
    `);
    this.countStmt = db.prepare(`SELECT COUNT(*) AS count FROM lifecycle_events`);
    this.insertDeliveryStmt = db.prepare(`
      INSERT INTO lifecycle_event_deliveries (
        event_id, handler_id, persona, priority, handler_identity, failure_policy,
        status, attempts, max_attempts, next_retry_at, claim_token, claim_expires_at,
        last_error, completed_at, created_at, updated_at
      ) VALUES (
        @event_id, @handler_id, @persona, @priority, @handler_identity, @failure_policy,
        'pending', 0, @max_attempts, NULL, NULL, NULL, NULL, NULL, @created_at, @updated_at
      )
    `);
    this.findDeliveriesByEventStmt = db.prepare(`
      SELECT * FROM lifecycle_event_deliveries WHERE event_id = ? ORDER BY priority DESC, created_at ASC
    `);
    this.compactCompletedStmt = db.prepare(`
      UPDATE lifecycle_events
      SET payload = @payload,
          provenance = @provenance,
          retention_tombstone_reason = @retention_tombstone_reason
      WHERE retention_tombstone_reason IS NULL
        AND (
          (
            NOT EXISTS (
              SELECT 1 FROM lifecycle_event_deliveries d
              WHERE d.event_id = lifecycle_events.event_id
            )
            AND created_at <= @cutoff
          )
          OR (
            EXISTS (
              SELECT 1 FROM lifecycle_event_deliveries d
              WHERE d.event_id = lifecycle_events.event_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM lifecycle_event_deliveries d
              WHERE d.event_id = lifecycle_events.event_id
                AND d.status <> 'completed'
            )
            AND (
              SELECT MAX(d.completed_at)
              FROM lifecycle_event_deliveries d
              WHERE d.event_id = lifecycle_events.event_id
            ) <= @cutoff
          )
        )
    `);
    this.tombstoneThreadStmt = db.prepare(`
      UPDATE lifecycle_events
      SET payload = @payload,
          provenance = @provenance,
          retention_tombstone_reason = @retention_tombstone_reason
      WHERE retention_tombstone_reason IS NOT 'privacy-deleted'
        AND (
          (aggregate_type = 'thread' AND aggregate_id = @thread_id)
          OR EXISTS (
            SELECT 1
            FROM json_each(lifecycle_events.payload, '$.references') reference
            WHERE json_extract(reference.value, '$.type') = 'thread'
              AND json_extract(reference.value, '$.id') = @thread_id
          )
          OR EXISTS (
            SELECT 1
            FROM json_each(lifecycle_events.provenance, '$.sourceReferences') reference
            WHERE json_extract(reference.value, '$.type') = 'thread'
              AND json_extract(reference.value, '$.id') = @thread_id
          )
        )
    `);
    this.tombstonePersonaStmt = db.prepare(`
      UPDATE lifecycle_events
      SET payload = @payload,
          provenance = @provenance,
          retention_tombstone_reason = @retention_tombstone_reason
      WHERE retention_tombstone_reason IS NOT 'privacy-deleted'
        AND EXISTS (
          SELECT 1
          FROM lifecycle_event_deliveries d
          WHERE d.event_id = lifecycle_events.event_id
            AND d.persona = @persona
        )
    `);
  }

  /** Inserts one validated, bounded lifecycle event. */
  insert(event: LifecycleEventEnvelope): Result<LifecycleEventRow, DbError> {
    try {
      const normalized = this.normalizeEvent(event);
      if (!normalized) {
        return err(new DbError('Failed to insert lifecycle event: invalid bounded event envelope'));
      }
      const insert = this.db.transaction(() => this.insertNormalized(normalized));
      return ok(insert());
    } catch (cause) {
      return err(toDbError('insert lifecycle event', cause));
    }
  }

  /**
   * Atomically persists an event and every resolved delivery. No partially
   * fanned-out event can survive a handler identity or database constraint
   * failure.
   */
  insertWithDeliveries(
    event: LifecycleEventEnvelope,
    deliveries: readonly LifecycleDeliveryFanoutInput[],
  ): Result<LifecycleEventFanoutResult, DbError> {
    try {
      const normalized = this.normalizeEvent(event);
      if (!normalized) {
        return err(
          new DbError('Failed to insert lifecycle event fan-out: invalid bounded event envelope'),
        );
      }
      const normalizedDeliveries = this.normalizeDeliveries(deliveries);
      if (!normalizedDeliveries) {
        return err(
          new DbError(
            'Failed to insert lifecycle event fan-out: invalid or duplicate handler deliveries',
          ),
        );
      }

      const write = this.db.transaction((): LifecycleEventFanoutResult => {
        const storedEvent = this.insertNormalized(normalized);
        const createdAt = this.now();
        for (const delivery of normalizedDeliveries) {
          this.insertDeliveryStmt.run({
            event_id: storedEvent.event_id,
            handler_id: delivery.handlerId,
            persona: delivery.persona,
            priority: delivery.priority,
            handler_identity: JSON.stringify(delivery.identity),
            failure_policy: JSON.stringify(delivery.failurePolicy),
            max_attempts: delivery.maxAttempts,
            created_at: createdAt,
            updated_at: createdAt,
          });
        }
        const storedDeliveries = this.findDeliveriesByEventStmt.all(
          storedEvent.event_id,
        ) as LifecycleDeliveryRow[];
        return {
          event: storedEvent,
          deliveries: storedDeliveries.map((delivery) => this.validateDeliveryRow(delivery)),
        };
      });

      return ok(write());
    } catch (cause) {
      return err(toDbError('insert lifecycle event fan-out', cause));
    }
  }

  /** Finds one immutable event by stable event ID. */
  findById(eventId: string): Result<LifecycleEventRow | null, DbError> {
    try {
      if (!this.isRuntimeId(eventId)) {
        return err(new DbError('Failed to find lifecycle event by id: invalid event id'));
      }
      const row = this.findByIdStmt.get(eventId) as LifecycleEventRow | undefined;
      return ok(row ? this.validateEventRow(row) : null);
    } catch (cause) {
      return err(toDbError('find lifecycle event by id', cause));
    }
  }

  /** Returns events in durable insertion order for one aggregate. */
  findByAggregate(
    aggregateType: string,
    aggregateId: string,
  ): Result<LifecycleEventRow[], DbError> {
    try {
      if (!this.isIdentifier(aggregateType) || !this.isRuntimeId(aggregateId)) {
        return err(new DbError('Failed to find lifecycle events by aggregate: invalid aggregate'));
      }
      const rows = this.findByAggregateStmt.all(aggregateType, aggregateId) as LifecycleEventRow[];
      return ok(rows.map((row) => this.validateEventRow(row)));
    } catch (cause) {
      return err(toDbError('find lifecycle events by aggregate', cause));
    }
  }

  /** Returns the current event count. Primarily useful for health and tests. */
  count(): Result<number, DbError> {
    try {
      return ok((this.countStmt.get() as { count: number }).count);
    } catch (cause) {
      return err(toDbError('count lifecycle events', cause));
    }
  }

  /**
   * Replaces completed event payload/provenance detail after the configured
   * audit window. Pending, failed, claimed, and dead-letter deliveries keep
   * their original event detail for operational recovery.
   */
  compactCompletedBefore(cutoff: number): Result<LifecycleEventRetentionResult, DbError> {
    try {
      if (!Number.isSafeInteger(cutoff)) {
        return err(new DbError('Failed to compact lifecycle events: invalid cutoff'));
      }
      const info = withLifecycleRetentionMutationAuthorization(this.db, () =>
        this.compactCompletedStmt.run({
          cutoff,
          ...this.tombstone('retention-compacted'),
        }),
      );
      return ok({ compactedEvents: info.changes });
    } catch (cause) {
      return err(toDbError('compact lifecycle events', cause));
    }
  }

  /** Tombstones lifecycle event detail associated with a privacy-deleted thread. */
  tombstoneThread(threadId: string): Result<LifecycleEventRetentionResult, DbError> {
    try {
      if (!this.isRuntimeId(threadId)) {
        return err(new DbError('Failed to tombstone lifecycle thread events: invalid thread id'));
      }
      const info = withLifecycleRetentionMutationAuthorization(this.db, () =>
        this.tombstoneThreadStmt.run({
          thread_id: threadId,
          ...this.tombstone('privacy-deleted'),
        }),
      );
      return ok({ compactedEvents: info.changes });
    } catch (cause) {
      return err(toDbError('tombstone lifecycle thread events', cause));
    }
  }

  /** Tombstones lifecycle event detail associated with a privacy-deleted persona. */
  tombstonePersona(persona: string): Result<LifecycleEventRetentionResult, DbError> {
    try {
      if (!this.isBoundedPersona(persona)) {
        return err(new DbError('Failed to tombstone lifecycle persona events: invalid persona'));
      }
      const info = withLifecycleRetentionMutationAuthorization(this.db, () =>
        this.tombstonePersonaStmt.run({
          persona,
          ...this.tombstone('privacy-deleted'),
        }),
      );
      return ok({ compactedEvents: info.changes });
    } catch (cause) {
      return err(toDbError('tombstone lifecycle persona events', cause));
    }
  }

  private normalizeEvent(event: LifecycleEventEnvelope): LifecycleEventEnvelope | null {
    try {
      const snapshot = snapshotLifecycleEvent(event);
      if (!snapshot) {
        return null;
      }
      const parsed = LifecycleEventEnvelopeSchema.safeParse(snapshot);
      if (!parsed.success) {
        return null;
      }
      // SQLite can validate this canonical ISO-8601 representation exactly.
      // Normalize accepted offset variants before persistence so the durable
      // contract has no equivalent timestamp spellings.
      const occurredAt = new Date(parsed.data.occurredAt).toISOString();
      // Keep the descriptor-safe snapshot rather than Zod's materialized
      // object so a valid metadata key named "__proto__" remains own data.
      return { ...snapshot, occurredAt } as LifecycleEventEnvelope;
    } catch {
      return null;
    }
  }

  private normalizeDeliveries(
    deliveries: readonly LifecycleDeliveryFanoutInput[],
  ): Array<Required<LifecycleDeliveryFanoutInput>> | null {
    try {
      const candidates = snapshotLifecycleDeliveries(deliveries);
      if (!candidates) {
        return null;
      }
      const seenHandlerIds = new Set<string>();
      const normalized: Array<Required<LifecycleDeliveryFanoutInput>> = [];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') {
          return null;
        }
        const delivery = candidate as Record<string, unknown>;
        const handlerId = delivery.handlerId;
        const persona = delivery.persona;
        const priority = delivery.priority;
        const maxAttempts = delivery.maxAttempts ?? 3;
        if (
          typeof handlerId !== 'string' ||
          typeof persona !== 'string' ||
          typeof priority !== 'number' ||
          typeof maxAttempts !== 'number' ||
          !Number.isInteger(priority) ||
          priority < -1000 ||
          priority > 1000 ||
          !Number.isInteger(maxAttempts) ||
          maxAttempts < 1 ||
          maxAttempts > 100 ||
          !this.isIdentifier(handlerId) ||
          !this.isBoundedPersona(persona)
        ) {
          return null;
        }
        const identity = this.parse(LifecycleHandlerIdentityContractSchema, delivery.identity);
        const failurePolicy = this.parse(
          LifecycleFailurePolicyContractSchema,
          delivery.failurePolicy,
        );
        if (
          !identity ||
          !failurePolicy ||
          !hasDurableHandlerIdentityAuthority(identity) ||
          !hasCompatibleLifecycleFailurePolicy(identity, failurePolicy)
        ) {
          return null;
        }
        if (seenHandlerIds.has(handlerId) || identity.handlerId !== handlerId) {
          return null;
        }
        seenHandlerIds.add(handlerId);
        // Persist only contract-owned parsed snapshots; never retain fields,
        // accessors, or toJSON methods supplied by the caller.
        normalized.push({
          handlerId,
          persona,
          priority,
          identity,
          failurePolicy,
          maxAttempts,
        });
      }
      return normalized;
    } catch {
      return null;
    }
  }

  private insertNormalized(event: LifecycleEventEnvelope): LifecycleEventRow {
    const createdAt = this.now();
    this.insertStmt.run({
      event_id: event.eventId,
      version: event.version,
      type: event.type,
      aggregate_type: event.context.aggregate.type,
      aggregate_id: event.context.aggregate.id,
      correlation_id: event.context.correlationId,
      causation_id: event.context.causationId ?? null,
      recursion_depth: event.context.recursion.depth,
      recursion_max_depth: event.context.recursion.maxDepth,
      provenance: JSON.stringify(event.context.provenance),
      payload: JSON.stringify(event.payload),
      occurred_at: event.occurredAt,
      created_at: createdAt,
    });
    return this.validateEventRow(this.findByIdStmt.get(event.eventId) as LifecycleEventRow);
  }

  private validateEventRow(row: LifecycleEventRow): LifecycleEventRow {
    if (!validProvenance(row.provenance) || !validPayload(row.payload)) {
      throw new Error('invalid persisted lifecycle event JSON');
    }
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
      !Number.isSafeInteger(row.created_at) ||
      !this.hasValidRetentionTombstone(row)
    ) {
      throw new Error('invalid persisted lifecycle event row');
    }
    return {
      ...row,
      version: event.version,
      // Serialize the descriptor-safe snapshot, not Zod's materialized output:
      // object assignment in a schema implementation must not erase an own
      // metadata key named "__proto__" during a database round trip.
      provenance: JSON.stringify((snapshot.context as { provenance: unknown }).provenance),
      payload: JSON.stringify(snapshot.payload),
    };
  }

  private validateDeliveryRow(row: LifecycleDeliveryRow): LifecycleDeliveryRow {
    if (
      !validIdentity(row.handler_identity, row.handler_id) ||
      !validFailurePolicy(row.failure_policy)
    ) {
      throw new Error('invalid persisted lifecycle delivery JSON');
    }
    const rawIdentity = this.parseJson(row.handler_identity, 'delivery handler identity');
    const rawFailurePolicy = this.parseJson(row.failure_policy, 'delivery failure policy');
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
      throw new Error('invalid persisted lifecycle delivery contracts');
    }
    const deliverySnapshot = snapshot[0];
    if (!deliverySnapshot) {
      throw new Error('invalid persisted lifecycle delivery contracts');
    }
    const identity = this.parse(LifecycleHandlerIdentityContractSchema, deliverySnapshot.identity);
    const failurePolicy = this.parse(
      LifecycleFailurePolicyContractSchema,
      deliverySnapshot.failurePolicy,
    );
    if (
      !identity ||
      !failurePolicy ||
      !hasDurableHandlerIdentityAuthority(identity) ||
      !hasCompatibleLifecycleFailurePolicy(identity, failurePolicy) ||
      identity.handlerId !== row.handler_id
    ) {
      throw new Error('invalid persisted lifecycle delivery contracts');
    }
    return {
      ...row,
      handler_identity: JSON.stringify(identity),
      failure_policy: JSON.stringify(failurePolicy),
    };
  }

  private parseJson(value: unknown, field: string): unknown {
    if (typeof value !== 'string') {
      throw new Error(`invalid persisted ${field}`);
    }
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error(`invalid persisted ${field}`);
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

  private hasValidRetentionTombstone(row: LifecycleEventRow): boolean {
    if (row.retention_tombstone_reason === null) return true;
    if (
      row.retention_tombstone_reason !== 'retention-compacted' &&
      row.retention_tombstone_reason !== 'privacy-deleted'
    ) {
      return false;
    }
    return (
      row.payload ===
        JSON.stringify({
          references: [],
          metadata: { lifecycleRetention: row.retention_tombstone_reason },
        }) &&
      row.provenance ===
        JSON.stringify({
          source: 'retention-service',
          sourceEventIds: [],
          sourceReferences: [],
        })
    );
  }

  private tombstone(reason: 'privacy-deleted' | 'retention-compacted'): {
    payload: string;
    provenance: string;
    retention_tombstone_reason: string;
  } {
    return {
      payload: JSON.stringify({
        references: [],
        metadata: {
          lifecycleRetention: reason,
        },
      }),
      provenance: JSON.stringify({
        source: 'retention-service',
        sourceEventIds: [],
        sourceReferences: [],
      }),
      retention_tombstone_reason: reason,
    };
  }
}
