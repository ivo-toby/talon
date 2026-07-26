import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ok } from 'neverthrow';
import {
  BaseRepository,
  LifecycleDeliveryRepository,
  LifecycleEventRepository,
  type LifecycleDeliveryFanoutInput,
} from '../../../src/core/database/repositories/index.js';
import type { LifecycleEventEnvelope } from '../../../src/lifecycle/contracts/index.js';
import { LifecycleRetentionService } from '../../../src/lifecycle/retention-service.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

describe('LifecycleRetentionService', () => {
  let db: Database.Database;
  let events: LifecycleEventRepository;
  let deliveries: LifecycleDeliveryRepository;
  let leaseNow: number;

  beforeEach(() => {
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    events = new LifecycleEventRepository(db);
    leaseNow = 1_800_000_000_000;
    deliveries = new LifecycleDeliveryRepository(db, () => leaseNow);
  });

  afterEach(() => {
    db.close();
  });

  function event(overrides: Partial<LifecycleEventEnvelope> = {}): LifecycleEventEnvelope {
    return {
      version: 'v1',
      eventId: uuid(),
      type: 'run.completed.v1',
      occurredAt: '2026-07-16T10:00:00.000Z',
      context: {
        aggregate: { type: 'thread', id: `thread-${uuid()}` },
        correlationId: uuid(),
        recursion: { depth: 0, maxDepth: 4 },
        provenance: { source: 'daemon' },
      },
      payload: {
        references: [{ type: 'run', id: uuid() }],
        metadata: { retained: 'content-detail' },
      },
      ...overrides,
    };
  }

  function delivery(
    handlerId = 'retention-projector',
    persona = 'support',
  ): LifecycleDeliveryFanoutInput {
    return {
      handlerId,
      persona,
      priority: 0,
      identity: {
        version: 'v1',
        handlerId,
        runtimeKind: 'native',
        implementationRef: handlerId,
        implementationVersion: '1.0.0',
        mode: 'event',
        inputContract: 'talon.lifecycle.event.envelope.v1',
        outputContract: 'talon.lifecycle.signal.envelopes.v1',
      },
      failurePolicy: { version: 'v1', mode: 'dead_letter' },
      maxAttempts: 2,
    };
  }

  function subject(clock = () => Number.MAX_SAFE_INTEGER): LifecycleRetentionService {
    return new LifecycleRetentionService({
      events,
      deliveries,
      auditLogger: { logLifecycleDecision: vi.fn() },
      clock,
    });
  }

  function storedPayload(eventId: string): Record<string, unknown> {
    const row = events.findById(eventId)._unsafeUnwrap();
    expect(row).not.toBeNull();
    return JSON.parse(row!.payload) as Record<string, unknown>;
  }

  function storedRetentionReason(eventId: string): string | null {
    const row = db
      .prepare(`SELECT retention_tombstone_reason FROM lifecycle_events WHERE event_id = ?`)
      .get(eventId) as { retention_tombstone_reason: string | null };
    return row.retention_tombstone_reason;
  }

  it('compacts only completed or subscriber-free event detail after the audit window', () => {
    const completed = event();
    events.insertWithDeliveries(completed, [delivery()])._unsafeUnwrap();
    const completedClaim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    deliveries
      .complete(completed.eventId, 'retention-projector', completedClaim.delivery.claim_token!)
      ._unsafeUnwrap();

    const deadLettered = event();
    events.insertWithDeliveries(deadLettered, [delivery('dead-projector')])._unsafeUnwrap();
    const deadClaim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    deliveries
      .fail(
        deadLettered.eventId,
        'dead-projector',
        deadClaim.delivery.claim_token!,
        { code: 'permanent-failure' },
        leaseNow + 500,
        false,
      )
      ._unsafeUnwrap();

    const pending = event();
    events.insertWithDeliveries(pending, [delivery('pending-projector')])._unsafeUnwrap();

    const noSubscribers = event();
    events.insert(noSubscribers)._unsafeUnwrap();

    const result = subject().compactCompleted(0);

    expect(result._unsafeUnwrap()).toEqual({ compactedEvents: 2, disabledDeliveries: 0 });
    expect(storedPayload(completed.eventId)).toEqual({
      references: [],
      metadata: { lifecycleRetention: 'retention-compacted' },
    });
    expect(storedPayload(noSubscribers.eventId)).toEqual({
      references: [],
      metadata: { lifecycleRetention: 'retention-compacted' },
    });
    expect(storedPayload(pending.eventId)).toMatchObject({
      metadata: { retained: 'content-detail' },
    });
    expect(storedPayload(deadLettered.eventId)).toMatchObject({
      metadata: { retained: 'content-detail' },
    });
  });

  it('compacts eligible events even when caller metadata uses the retention key', () => {
    const completed = event({
      payload: {
        references: [],
        metadata: { lifecycleRetention: 'retention-compacted' },
      },
    });
    events.insertWithDeliveries(completed, [delivery()])._unsafeUnwrap();
    const claim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    deliveries
      .complete(completed.eventId, 'retention-projector', claim.delivery.claim_token!)
      ._unsafeUnwrap();

    const result = subject().compactCompleted(0);

    expect(result._unsafeUnwrap()).toEqual({ compactedEvents: 1, disabledDeliveries: 0 });
    expect(storedPayload(completed.eventId)).toEqual({
      references: [],
      metadata: { lifecycleRetention: 'retention-compacted' },
    });
    expect(storedRetentionReason(completed.eventId)).toBe('retention-compacted');
  });

  it('tombstones thread payload detail and dead-letters outstanding work atomically', () => {
    const threadId = `thread-${uuid()}`;
    const target = event({
      context: {
        ...event().context,
        aggregate: { type: 'thread', id: threadId },
        correlationId: uuid(),
      },
    });
    events.insertWithDeliveries(target, [delivery()])._unsafeUnwrap();
    const aggregateIdImposter = event({
      context: {
        ...event().context,
        aggregate: { type: 'run', id: threadId },
        correlationId: uuid(),
      },
    });
    events
      .insertWithDeliveries(aggregateIdImposter, [delivery('aggregate-id-imposter')])
      ._unsafeUnwrap();
    const unrelated = event();
    events.insertWithDeliveries(unrelated, [delivery('other-projector')])._unsafeUnwrap();

    const result = subject().tombstoneThread(threadId);

    expect(result._unsafeUnwrap()).toEqual({ compactedEvents: 1, disabledDeliveries: 1 });
    expect(storedPayload(target.eventId)).toEqual({
      references: [],
      metadata: { lifecycleRetention: 'privacy-deleted' },
    });
    expect(storedPayload(unrelated.eventId)).toMatchObject({
      metadata: { retained: 'content-detail' },
    });
    expect(storedPayload(aggregateIdImposter.eventId)).toMatchObject({
      metadata: { retained: 'content-detail' },
    });
    expect(
      deliveries.findByKey(target.eventId, 'retention-projector')._unsafeUnwrap(),
    ).toMatchObject({
      status: 'dead_letter',
      attempts: 1,
      last_error: '{"code":"privacy-deleted"}',
      claim_token: null,
    });
    expect(
      deliveries.findByKey(aggregateIdImposter.eventId, 'aggregate-id-imposter')._unsafeUnwrap(),
    ).toMatchObject({
      status: 'pending',
    });
  });

  it('tombstones persona payload detail without touching other personas', () => {
    const supportEvent = event();
    events
      .insertWithDeliveries(supportEvent, [delivery('support-projector', 'support')])
      ._unsafeUnwrap();
    const opsEvent = event();
    events.insertWithDeliveries(opsEvent, [delivery('ops-projector', 'ops')])._unsafeUnwrap();

    const result = subject().tombstonePersona('support');

    expect(result._unsafeUnwrap()).toEqual({ compactedEvents: 1, disabledDeliveries: 1 });
    expect(storedPayload(supportEvent.eventId)).toEqual({
      references: [],
      metadata: { lifecycleRetention: 'privacy-deleted' },
    });
    expect(storedPayload(opsEvent.eventId)).toMatchObject({
      metadata: { retained: 'content-detail' },
    });
    expect(
      deliveries.findByKey(supportEvent.eventId, 'support-projector')._unsafeUnwrap(),
    ).toMatchObject({
      status: 'dead_letter',
      last_error: '{"code":"privacy-deleted"}',
    });
    expect(deliveries.findByKey(opsEvent.eventId, 'ops-projector')._unsafeUnwrap()).toMatchObject({
      status: 'pending',
    });
  });

  it('does not downgrade privacy tombstones during later compaction', () => {
    const threadId = `thread-${uuid()}`;
    const target = event({
      context: {
        ...event().context,
        aggregate: { type: 'thread', id: threadId },
        correlationId: uuid(),
      },
    });
    events.insertWithDeliveries(target, [delivery()])._unsafeUnwrap();
    const claim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    deliveries
      .complete(target.eventId, 'retention-projector', claim.delivery.claim_token!)
      ._unsafeUnwrap();

    subject().tombstoneThread(threadId)._unsafeUnwrap();
    subject().compactCompleted(0)._unsafeUnwrap();

    expect(storedPayload(target.eventId)).toEqual({
      references: [],
      metadata: { lifecycleRetention: 'privacy-deleted' },
    });
  });

  it('rolls back event tombstoning when delivery privacy mutation fails', () => {
    const threadId = `thread-${uuid()}`;
    const target = event({
      context: {
        ...event().context,
        aggregate: { type: 'thread', id: threadId },
        correlationId: uuid(),
      },
    });
    events.insertWithDeliveries(target, [delivery()])._unsafeUnwrap();
    const failingDeliveries = {
      tombstoneThread: vi.fn(() => {
        throw new Error('simulated delivery failure');
      }),
      tombstonePersona: vi.fn(() => ok({ disabledDeliveries: 0 })),
    };
    const failingSubject = new LifecycleRetentionService({
      events,
      deliveries: failingDeliveries as unknown as LifecycleDeliveryRepository,
      clock: () => Number.MAX_SAFE_INTEGER,
    });

    const result = failingSubject.tombstoneThread(threadId);

    expect(result.isErr()).toBe(true);
    expect(storedPayload(target.eventId)).toMatchObject({
      metadata: { retained: 'content-detail' },
    });
  });
});
