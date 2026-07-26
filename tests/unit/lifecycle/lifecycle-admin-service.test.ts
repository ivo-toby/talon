import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  BaseRepository,
  LifecycleDeliveryRepository,
  LifecycleEventRepository,
  type LifecycleDeliveryFanoutInput,
} from '../../../src/core/database/repositories/index.js';
import type { LifecycleEventEnvelope } from '../../../src/lifecycle/contracts/index.js';
import { LifecycleAdminService } from '../../../src/lifecycle/lifecycle-admin-service.js';
import { LifecycleRetentionService } from '../../../src/lifecycle/retention-service.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

describe('LifecycleAdminService', () => {
  let db: Database.Database;
  let events: LifecycleEventRepository;
  let deliveries: LifecycleDeliveryRepository;
  let leaseNow: number;
  let auditLogger: {
    logLifecycleReplay: ReturnType<typeof vi.fn>;
    logLifecycleDisablement: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    events = new LifecycleEventRepository(db);
    leaseNow = 1_800_000_000_000;
    auditLogger = {
      logLifecycleReplay: vi.fn(),
      logLifecycleDisablement: vi.fn(),
    };
    deliveries = new LifecycleDeliveryRepository(db, {
      leaseClock: () => leaseNow,
      auditLogger,
    });
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
        metadata: {},
      },
      ...overrides,
    };
  }

  function delivery(handlerId: string): LifecycleDeliveryFanoutInput {
    return {
      handlerId,
      persona: 'support',
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
      maxAttempts: 3,
    };
  }

  function subject(): LifecycleAdminService {
    return new LifecycleAdminService({ deliveries, auditLogger });
  }

  function retentionSubject(): LifecycleRetentionService {
    return new LifecycleRetentionService({
      events,
      deliveries,
      clock: () => Number.MAX_SAFE_INTEGER,
    });
  }

  it('replays exactly one terminal handler delivery without duplicating fan-out identity', () => {
    const input = event();
    events
      .insertWithDeliveries(input, [delivery('first-handler'), delivery('second-handler')])
      ._unsafeUnwrap();
    for (let index = 0; index < 2; index += 1) {
      const claim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
      deliveries
        .complete(input.eventId, claim.delivery.handler_id, claim.delivery.claim_token!)
        ._unsafeUnwrap();
    }

    const replayed = subject().replayDelivery(input.eventId, 'first-handler');

    expect(replayed._unsafeUnwrap()).toMatchObject({
      event_id: input.eventId,
      handler_id: 'first-handler',
      status: 'pending',
      attempts: 0,
    });
    expect(deliveries.findByEventId(input.eventId)._unsafeUnwrap()).toHaveLength(2);
    expect(deliveries.findByKey(input.eventId, 'second-handler')._unsafeUnwrap()).toMatchObject({
      status: 'completed',
    });
    expect(auditLogger.logLifecycleReplay).toHaveBeenCalledWith({
      action: 'lifecycle.replay',
      details: expect.objectContaining({
        operation: 'delivery_reopen',
        eventId: input.eventId,
        handlerId: 'first-handler',
      }),
    });
  });

  it('replays ordinary dead-letter failures without duplicating fan-out identity', () => {
    const input = event();
    events.insertWithDeliveries(input, [delivery('failing-handler')])._unsafeUnwrap();
    const claim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    deliveries
      .fail(
        input.eventId,
        'failing-handler',
        claim.delivery.claim_token!,
        { code: 'ordinary-terminal-failure' },
        leaseNow + 500,
        false,
      )
      ._unsafeUnwrap();

    const replayed = subject().replayDelivery(input.eventId, 'failing-handler');

    expect(replayed._unsafeUnwrap()).toMatchObject({
      event_id: input.eventId,
      handler_id: 'failing-handler',
      status: 'pending',
      attempts: 0,
      last_error: null,
    });
    expect(deliveries.findByEventId(input.eventId)._unsafeUnwrap()).toHaveLength(1);
  });

  it('rejects replay for non-terminal or missing handler deliveries', () => {
    const input = event();
    events.insertWithDeliveries(input, [delivery('pending-handler')])._unsafeUnwrap();

    expect(subject().replayDelivery(input.eventId, 'pending-handler').isErr()).toBe(true);
    expect(subject().replayDelivery(input.eventId, 'missing-handler').isErr()).toBe(true);
    expect(deliveries.findByEventId(input.eventId)._unsafeUnwrap()).toHaveLength(1);
  });

  it('rejects replay of retention, privacy, and disablement tombstones', () => {
    const compacted = event();
    events.insertWithDeliveries(compacted, [delivery('compacted-handler')])._unsafeUnwrap();
    const compactedClaim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    deliveries
      .complete(compacted.eventId, 'compacted-handler', compactedClaim.delivery.claim_token!)
      ._unsafeUnwrap();
    retentionSubject().compactCompleted(0)._unsafeUnwrap();

    expect(subject().replayDelivery(compacted.eventId, 'compacted-handler').isErr()).toBe(true);
    expect(
      deliveries.findByKey(compacted.eventId, 'compacted-handler')._unsafeUnwrap(),
    ).toMatchObject({
      status: 'completed',
      attempts: 0,
    });

    const threadId = `thread-${uuid()}`;
    const privacyDeleted = event({
      context: {
        ...event().context,
        aggregate: { type: 'thread', id: threadId },
        correlationId: uuid(),
      },
    });
    events.insertWithDeliveries(privacyDeleted, [delivery('privacy-handler')])._unsafeUnwrap();
    retentionSubject().tombstoneThread(threadId)._unsafeUnwrap();

    expect(subject().replayDelivery(privacyDeleted.eventId, 'privacy-handler').isErr()).toBe(true);
    expect(
      deliveries.findByKey(privacyDeleted.eventId, 'privacy-handler')._unsafeUnwrap(),
    ).toMatchObject({
      status: 'dead_letter',
      last_error: '{"code":"privacy-deleted"}',
    });

    const disabled = event();
    events.insertWithDeliveries(disabled, [delivery('disabled-replay-handler')])._unsafeUnwrap();
    subject().disableHandler('disabled-replay-handler')._unsafeUnwrap();

    expect(subject().replayDelivery(disabled.eventId, 'disabled-replay-handler').isErr()).toBe(
      true,
    );
    expect(
      deliveries.findByKey(disabled.eventId, 'disabled-replay-handler')._unsafeUnwrap(),
    ).toMatchObject({
      status: 'dead_letter',
      last_error: '{"code":"handler-disabled"}',
    });
  });

  it('disables outstanding deliveries for one handler while preserving completed history', () => {
    const pendingEvent = event();
    events.insertWithDeliveries(pendingEvent, [delivery('disabled-handler')])._unsafeUnwrap();
    const completedEvent = event();
    events.insertWithDeliveries(completedEvent, [delivery('disabled-handler')])._unsafeUnwrap();

    const firstClaim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    deliveries
      .complete(pendingEvent.eventId, 'disabled-handler', firstClaim.delivery.claim_token!)
      ._unsafeUnwrap();

    const result = subject().disableHandler('disabled-handler');

    expect(result._unsafeUnwrap()).toEqual({
      handlerId: 'disabled-handler',
      disabledDeliveries: 1,
    });
    expect(
      deliveries.findByKey(completedEvent.eventId, 'disabled-handler')._unsafeUnwrap(),
    ).toMatchObject({
      status: 'dead_letter',
      attempts: 1,
      last_error: '{"code":"handler-disabled"}',
    });
    expect(
      deliveries.findByKey(pendingEvent.eventId, 'disabled-handler')._unsafeUnwrap(),
    ).toMatchObject({
      status: 'completed',
    });
    expect(auditLogger.logLifecycleDisablement).toHaveBeenCalledWith({
      action: 'lifecycle.disablement',
      details: expect.objectContaining({
        operation: 'handler_disable',
        handlerId: 'disabled-handler',
        disabledDeliveries: 1,
      }),
    });
  });

  it('invalidates an active claim so stale completion cannot win after disablement', () => {
    const input = event();
    events.insertWithDeliveries(input, [delivery('claimed-handler')])._unsafeUnwrap();
    const claim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;

    expect(subject().disableHandler('claimed-handler')._unsafeUnwrap()).toMatchObject({
      disabledDeliveries: 1,
    });

    expect(
      deliveries.complete(input.eventId, 'claimed-handler', claim.delivery.claim_token!).isErr(),
    ).toBe(true);
    expect(deliveries.findByKey(input.eventId, 'claimed-handler')._unsafeUnwrap()).toMatchObject({
      status: 'dead_letter',
      claim_token: null,
      last_error: '{"code":"handler-disabled"}',
    });
  });
});
