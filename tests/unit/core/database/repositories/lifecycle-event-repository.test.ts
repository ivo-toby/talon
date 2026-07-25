import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BaseRepository,
  LifecycleDeliveryRepository,
  LifecycleEventRepository,
  type ClaimLifecycleDeliveryOptions,
  type LifecycleFailureDiagnostic,
  type LifecycleDeliveryFanoutInput,
} from '../../../../../src/core/database/repositories/index.js';
import type { LifecycleEventEnvelope } from '../../../../../src/lifecycle/contracts/index.js';
import { runMigrations } from '../../../../../src/core/database/migrations/runner.js';
import { createTestDb, uuid } from './helpers.js';

describe('lifecycle event persistence', () => {
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
        metadata: { outcome: 'completed' },
      },
      ...overrides,
    };
  }

  function delivery(handlerId = 'run-projector'): LifecycleDeliveryFanoutInput {
    return {
      handlerId,
      persona: 'support',
      priority: 0,
      identity: {
        version: 'v1',
        handlerId,
        runtimeKind: 'native',
        implementationRef: 'run-projector',
        implementationVersion: '1.0.0',
        mode: 'event',
        inputContract: 'talon.lifecycle.event.envelope.v1',
        outputContract: 'talon.lifecycle.signal.envelopes.v1',
      },
      failurePolicy: { version: 'v1', mode: 'dead_letter' },
      maxAttempts: 2,
    };
  }

  function openFileDb(path: string): Database.Database {
    const fileDb = new Database(path);
    fileDb.pragma('foreign_keys = ON');
    const result = runMigrations(
      fileDb,
      join(import.meta.dirname, '../../../../../src/core/database/migrations'),
    );
    if (result.isErr()) {
      throw result.error;
    }
    return fileDb;
  }

  function committedV14Migrations(): string {
    const currentMigrations = join(
      import.meta.dirname,
      '../../../../../src/core/database/migrations',
    );
    const legacyMigrations = mkdtempSync(join(tmpdir(), 'talon-lifecycle-v14-'));
    for (const file of readdirSync(currentMigrations)) {
      const version = Number.parseInt(file.slice(0, 3), 10);
      if (Number.isSafeInteger(version) && version <= 13) {
        copyFileSync(join(currentMigrations, file), join(legacyMigrations, file));
      }
    }
    const baseMigration = execFileSync(
      'git',
      ['show', 'fbe4f08:src/core/database/migrations/014-lifecycle-events.sql'],
      {
        cwd: join(import.meta.dirname, '../../../../../'),
        encoding: 'utf8',
      },
    );
    writeFileSync(join(legacyMigrations, '014-lifecycle-events.sql'), baseMigration);
    return legacyMigrations;
  }

  function withIgnoredCheckConstraints(operation: () => void): void {
    // These fixtures model pre-existing corruption from an older build or a
    // damaged SQLite file. Production migrations intentionally reject these
    // updates; removing the guards in this isolated test database lets reload
    // validation remain tested as a separate defense in depth.
    db.exec('DROP TRIGGER IF EXISTS lifecycle_events_reject_updates');
    db.exec('DROP TRIGGER IF EXISTS lifecycle_event_deliveries_guard_transitions');
    db.pragma('ignore_check_constraints = ON');
    try {
      operation();
    } finally {
      db.pragma('ignore_check_constraints = OFF');
    }
  }

  it('stores only a validated bounded event envelope', () => {
    const input = event();
    const inserted = events.insert(input);

    expect(inserted.isOk()).toBe(true);
    const stored = inserted._unsafeUnwrap();
    expect(stored.event_id).toBe(input.eventId);
    expect(JSON.parse(stored.payload)).toEqual(input.payload);
    expect(JSON.parse(stored.provenance)).toEqual({
      source: input.context.provenance.source,
      sourceEventIds: [],
      sourceReferences: [],
    });
    expect(stored.event_sequence).toBeGreaterThan(0);

    const tooLarge = event({
      payload: { references: [], metadata: { body: 'x'.repeat(1_025) } },
    });
    expect(events.insert(tooLarge).isErr()).toBe(true);
    expect(events.findById(tooLarge.eventId)._unsafeUnwrap()).toBeNull();

    const invalidRecursion = event({
      context: {
        ...event().context,
        recursion: { depth: 0, maxDepth: 0 },
      },
    });
    expect(events.insert(invalidRecursion).isErr()).toBe(true);
    expect(events.findById(invalidRecursion.eventId)._unsafeUnwrap()).toBeNull();
  });

  it('rolls back a standalone insert when its SQLite sequence is not safely readable', () => {
    const initial = events.insert(event())._unsafeUnwrap();
    db.prepare(`DELETE FROM lifecycle_events WHERE event_id = ?`).run(initial.event_id);
    db.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'lifecycle_events'`).run(
      Number.MAX_SAFE_INTEGER,
    );

    const input = event();
    expect(events.insert(input).isErr()).toBe(true);
    expect(events.findById(input.eventId)._unsafeUnwrap()).toBeNull();
    expect(events.count()._unsafeUnwrap()).toBe(0);
  });

  it('atomically inserts an event and its unique handler fan-out', () => {
    const input = event();
    const result = events.insertWithDeliveries(input, [
      delivery('first-handler'),
      delivery('second-handler'),
    ]);

    expect(result.isOk()).toBe(true);
    expect(deliveries.findByEventId(input.eventId)._unsafeUnwrap()).toHaveLength(2);
    expect(events.insertWithDeliveries(input, [delivery('first-handler')]).isErr()).toBe(true);
    expect(deliveries.findByEventId(input.eventId)._unsafeUnwrap()).toHaveLength(2);

    db.exec(`
      CREATE TRIGGER reject_lifecycle_delivery
      BEFORE INSERT ON lifecycle_event_deliveries
      WHEN NEW.handler_id = 'reject-handler'
      BEGIN
        SELECT RAISE(ABORT, 'simulated delivery insert failure');
      END;
    `);
    const rejectedEvent = event();
    expect(
      events
        .insertWithDeliveries(rejectedEvent, [
          delivery('first-handler'),
          delivery('reject-handler'),
        ])
        .isErr(),
    ).toBe(true);
    expect(events.findById(rejectedEvent.eventId)._unsafeUnwrap()).toBeNull();
    expect(events.count()._unsafeUnwrap()).toBe(1);
  });

  it('fans out the same handler identity once for each new event', () => {
    const first = event();
    const second = event();
    events.insertWithDeliveries(first, [delivery('shared-handler')])._unsafeUnwrap();
    events.insertWithDeliveries(second, [delivery('shared-handler')])._unsafeUnwrap();

    expect(deliveries.findByEventId(first.eventId)._unsafeUnwrap()).toHaveLength(1);
    expect(deliveries.findByEventId(second.eventId)._unsafeUnwrap()).toHaveLength(1);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM lifecycle_event_deliveries WHERE handler_id = 'shared-handler'`,
        )
        .get(),
    ).toEqual({ count: 2 });
  });

  it('bounds persisted persona names at the public and reload boundaries', () => {
    const atLimit = 'p'.repeat(256);
    const maxUtf8Persona = '😀'.repeat(256);
    const withinLimit = event();
    expect(
      events.insertWithDeliveries(withinLimit, [{ ...delivery(), persona: atLimit }]).isOk(),
    ).toBe(true);

    const utf8Boundary = event();
    expect(Array.from(maxUtf8Persona)).toHaveLength(256);
    expect(Buffer.byteLength(maxUtf8Persona, 'utf8')).toBe(1_024);
    expect(
      events
        .insertWithDeliveries(utf8Boundary, [{ ...delivery(), persona: maxUtf8Persona }])
        .isOk(),
    ).toBe(true);

    const overflow = event();
    expect(
      events.insertWithDeliveries(overflow, [{ ...delivery(), persona: `${atLimit}p` }]).isErr(),
    ).toBe(true);
    expect(events.findById(overflow.eventId)._unsafeUnwrap()).toBeNull();

    const utf8Overflow = event();
    expect(
      events
        .insertWithDeliveries(utf8Overflow, [{ ...delivery(), persona: `${maxUtf8Persona}😀` }])
        .isErr(),
    ).toBe(true);
    expect(events.findById(utf8Overflow.eventId)._unsafeUnwrap()).toBeNull();

    const embeddedNul = event();
    expect(
      events
        .insertWithDeliveries(embeddedNul, [{ ...delivery(), persona: 'support\0poison' }])
        .isErr(),
    ).toBe(true);
    expect(events.findById(embeddedNul.eventId)._unsafeUnwrap()).toBeNull();

    withIgnoredCheckConstraints(() => {
      db.prepare(`UPDATE lifecycle_event_deliveries SET persona = ? WHERE event_id = ?`).run(
        `${atLimit}p`,
        withinLimit.eventId,
      );
    });
    expect(deliveries.findByEventId(withinLimit.eventId).isErr()).toBe(true);

    // Reload validation remains defensive against corruption introduced by an
    // older SQLite build or a damaged database, even though the SQL CHECK now
    // rejects embedded NUL on normal writes.
    withIgnoredCheckConstraints(() => {
      db.prepare(`UPDATE lifecycle_event_deliveries SET persona = ? WHERE event_id = ?`).run(
        'support\0poison',
        utf8Boundary.eventId,
      );
    });
    expect(deliveries.findByEventId(utf8Boundary.eventId).isErr()).toBe(true);
  });

  it('enforces the frozen identity and failure-policy matrix before fan-out persistence', () => {
    const eventHandler = delivery('event-policy-handler');
    expect(
      events.insertWithDeliveries(event(), [
        { ...eventHandler, failurePolicy: { version: 'v1', mode: 'fail_open' } },
      ]),
    ).toMatchObject({ error: expect.anything() });
    expect(
      events
        .insertWithDeliveries(event(), [
          { ...eventHandler, failurePolicy: { version: 'v1', mode: 'preserve_session' } },
        ])
        .isOk(),
    ).toBe(true);

    const advisory = delivery('advisory-policy-handler');
    advisory.identity = {
      ...advisory.identity,
      mode: 'interceptor',
      inputContract: 'talon.lifecycle.interceptor.input.v1',
      outputContract: 'talon.lifecycle.advisory.interceptor.output.v1',
      interceptorSafety: 'advisory',
    };
    expect(
      events
        .insertWithDeliveries(event(), [
          { ...advisory, failurePolicy: { version: 'v1', mode: 'dead_letter' } },
        ])
        .isErr(),
    ).toBe(true);
    expect(
      events
        .insertWithDeliveries(event(), [
          { ...advisory, failurePolicy: { version: 'v1', mode: 'fail_open' } },
        ])
        .isOk(),
    ).toBe(true);

    const enforcing = delivery('enforcing-policy-handler');
    enforcing.identity = {
      ...enforcing.identity,
      mode: 'interceptor',
      inputContract: 'talon.lifecycle.interceptor.input.v1',
      outputContract: 'talon.lifecycle.enforcing.interceptor.output.v1',
      interceptorSafety: 'enforcing',
    };
    expect(
      events
        .insertWithDeliveries(event(), [
          { ...enforcing, failurePolicy: { version: 'v1', mode: 'fail_open' } },
        ])
        .isErr(),
    ).toBe(true);
    expect(
      events
        .insertWithDeliveries(event(), [
          { ...enforcing, failurePolicy: { version: 'v1', mode: 'fail_closed' } },
        ])
        .isOk(),
    ).toBe(true);
  });

  it('round-trips a valid metadata __proto__ key without changing object prototypes', () => {
    const metadata = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(metadata, '__proto__', {
      value: 'preserved',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(Object.getPrototypeOf(metadata)).toBeNull();
    const input = event({ payload: { references: [], metadata } });

    const stored = events.insert(input)._unsafeUnwrap();
    const storedMetadata = (
      JSON.parse(stored.payload) as {
        metadata: Record<string, unknown>;
      }
    ).metadata;
    expect(Object.hasOwn(storedMetadata, '__proto__')).toBe(true);
    expect(storedMetadata.__proto__).toBe('preserved');
    expect(events.findById(input.eventId)._unsafeUnwrap()?.payload).toBe(stored.payload);

    expect(() =>
      db
        .prepare(`UPDATE lifecycle_events SET payload = ? WHERE event_id = ?`)
        .run('{"references":[],"metadata":{"__proto__":"forged"}}', input.eventId),
    ).toThrow();
  });

  it('claims ready deliveries in aggregate order and reclaims an expired lease after restart', () => {
    const now = 1_800_000_000_000;
    leaseNow = now;
    const aggregate = { type: 'thread', id: `thread-${uuid()}` };
    const first = event({ context: { ...event().context, aggregate } });
    const second = event({ context: { ...event().context, aggregate } });
    events.insertWithDeliveries(first, [delivery()])._unsafeUnwrap();
    events.insertWithDeliveries(second, [delivery()])._unsafeUnwrap();

    const callerSuppliedToken = uuid();
    const firstClaim = deliveries
      .claimNext({
        leaseMs: 100,
        claimToken: callerSuppliedToken,
      } as unknown as ClaimLifecycleDeliveryOptions)
      ._unsafeUnwrap();
    expect(firstClaim?.delivery.event_id).toBe(first.eventId);
    expect(firstClaim?.delivery.claim_token).not.toBe(callerSuppliedToken);
    leaseNow = now + 50;
    expect(deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()).toBeNull();

    leaseNow = now + 101;
    const reclaimed = deliveries
      .claimNext({
        leaseMs: 100,
        claimToken: callerSuppliedToken,
      } as unknown as ClaimLifecycleDeliveryOptions)
      ._unsafeUnwrap();
    expect(reclaimed?.delivery.event_id).toBe(first.eventId);
    expect(reclaimed?.delivery.claim_token).not.toBe(firstClaim?.delivery.claim_token);
    expect(
      deliveries
        .complete(first.eventId, 'run-projector', firstClaim!.delivery.claim_token!)
        .isErr(),
    ).toBe(true);

    deliveries
      .complete(first.eventId, 'run-projector', reclaimed!.delivery.claim_token!)
      ._unsafeUnwrap();
    leaseNow = now + 102;
    const secondClaim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap();
    expect(secondClaim?.delivery.event_id).toBe(second.eventId);
  });

  it('skips dispatcher-excluded handlers without consuming an attempt', () => {
    const first = event();
    const second = event();
    events.insertWithDeliveries(first, [delivery('busy-handler')])._unsafeUnwrap();
    events.insertWithDeliveries(second, [delivery('available-handler')])._unsafeUnwrap();

    const claim = deliveries
      .claimNext({ leaseMs: 100, excludedHandlerIds: ['busy-handler'] })
      ._unsafeUnwrap();

    expect(claim?.delivery.handler_id).toBe('available-handler');
    expect(deliveries.findByKey(first.eventId, 'busy-handler')._unsafeUnwrap()).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
  });

  it('accepts bounded exclusions beyond 256 so a healthy delivery is not stalled', () => {
    const blocked = event();
    const healthy = event();
    events.insertWithDeliveries(blocked, [delivery('busy-handler')])._unsafeUnwrap();
    events.insertWithDeliveries(healthy, [delivery('available-handler')])._unsafeUnwrap();
    const excluded = [
      'busy-handler',
      ...Array.from({ length: 257 }, (_, index) => `other-handler-${index}`),
    ];

    const claim = deliveries
      .claimNext({ leaseMs: 100, excludedHandlerIds: excluded })
      ._unsafeUnwrap();

    expect(claim?.delivery.handler_id).toBe('available-handler');
    expect(deliveries.findByKey(blocked.eventId, 'busy-handler')._unsafeUnwrap()).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
  });

  it('does not let a public claim timestamp expire another active lease', () => {
    const now = 1_800_000_000_000;
    leaseNow = now;
    const input = event();
    events.insertWithDeliveries(input, [delivery()])._unsafeUnwrap();

    const activeClaim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    const before = db
      .prepare(`SELECT * FROM lifecycle_event_deliveries WHERE event_id = ?`)
      .get(input.eventId);

    const forcedClaim = deliveries.claimNext({
      leaseMs: 100,
      now: now + 86_400_000,
    } as unknown as ClaimLifecycleDeliveryOptions);

    expect(forcedClaim._unsafeUnwrap()).toBeNull();
    expect(
      db.prepare(`SELECT * FROM lifecycle_event_deliveries WHERE event_id = ?`).get(input.eventId),
    ).toEqual(before);
    expect(deliveries.findByKey(input.eventId, 'run-projector')._unsafeUnwrap()).toMatchObject({
      status: 'claimed',
      attempts: 0,
      claim_token: activeClaim.delivery.claim_token,
      claim_expires_at: now + 100,
    });
  });

  it('rejects terminal mutations at the lease boundary and recovers with a new claim', () => {
    const now = 1_800_000_000_000;
    leaseNow = now;
    const input = event();
    events.insertWithDeliveries(input, [delivery()])._unsafeUnwrap();
    const staleClaim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;

    leaseNow = now + 100;
    expect(
      deliveries.complete(input.eventId, 'run-projector', staleClaim.delivery.claim_token!).isErr(),
    ).toBe(true);
    expect(
      deliveries
        .fail(
          input.eventId,
          'run-projector',
          staleClaim.delivery.claim_token!,
          { code: 'lease-expired' },
          now + 200,
        )
        .isErr(),
    ).toBe(true);
    expect(deliveries.findByKey(input.eventId, 'run-projector')._unsafeUnwrap()).toMatchObject({
      status: 'claimed',
      claim_token: staleClaim.delivery.claim_token,
    });

    leaseNow = now + 101;
    const recoveredClaim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    expect(recoveredClaim.delivery.attempts).toBe(1);
    expect(recoveredClaim.delivery.claim_token).not.toBe(staleClaim.delivery.claim_token);
    expect(
      deliveries
        .complete(input.eventId, 'run-projector', recoveredClaim.delivery.claim_token!)
        .isOk(),
    ).toBe(true);
  });

  it('uses wall lease time rather than the monotonic write-order clock', () => {
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      leaseNow = now;
      const input = event();
      events.insertWithDeliveries(input, [delivery()])._unsafeUnwrap();
      const claim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;

      // These writes deliberately advance BaseRepository's strict write clock
      // beyond the lease duration while the wall lease clock remains frozen.
      for (let index = 0; index < 101; index += 1) {
        events.insert(event())._unsafeUnwrap();
      }

      expect(
        deliveries.complete(input.eventId, 'run-projector', claim.delivery.claim_token!),
      ).toMatchObject({ value: { status: 'completed' } });
    } finally {
      clock.mockRestore();
    }
  });

  it('charges abandoned leases against max attempts before advancing an aggregate', () => {
    const now = 1_800_000_000_000;
    leaseNow = now;
    const aggregate = { type: 'thread', id: `thread-${uuid()}` };
    const first = event({ context: { ...event().context, aggregate } });
    const second = event({ context: { ...event().context, aggregate } });
    events.insertWithDeliveries(first, [delivery()])._unsafeUnwrap();
    events.insertWithDeliveries(second, [delivery()])._unsafeUnwrap();

    const firstAttempt = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    leaseNow = now + 101;
    const secondAttempt = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    expect(secondAttempt.delivery.event_id).toBe(first.eventId);
    expect(secondAttempt.delivery.attempts).toBe(1);

    leaseNow = now + 202;
    const later = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    expect(later.delivery.event_id).toBe(second.eventId);
    expect(deliveries.findByKey(first.eventId, 'run-projector')._unsafeUnwrap()).toMatchObject({
      status: 'dead_letter',
      attempts: 2,
      last_error: '{"code":"lease-expired"}',
    });
    expect(
      deliveries.complete(first.eventId, 'run-projector', firstAttempt.delivery.claim_token!),
    ).toMatchObject({ error: expect.anything() });
    expect(
      deliveries.complete(first.eventId, 'run-projector', secondAttempt.delivery.claim_token!),
    ).toMatchObject({ error: expect.anything() });
  });

  it('rejects malformed UTF-16 before SQLite can normalize it into a collision', () => {
    const replacementId = '\ufffd';
    expect(events.insert(event({ eventId: replacementId })).isOk()).toBe(true);
    expect(events.insert(event({ eventId: '\ud800' })).isErr()).toBe(true);
    expect(events.insert(event({ eventId: '\udc00' })).isErr()).toBe(true);
    expect(events.findById(replacementId)._unsafeUnwrap()).not.toBeNull();
    expect(events.count()._unsafeUnwrap()).toBe(1);

    const malformedEvents: Array<[string, LifecycleEventEnvelope]> = [
      ['occurredAt', event({ occurredAt: '\udc00' })],
      [
        'aggregate id',
        event({ context: { ...event().context, aggregate: { type: 'thread', id: '\ud800' } } }),
      ],
      ['correlation id', event({ context: { ...event().context, correlationId: '\udc00' } })],
      ['causation id', event({ context: { ...event().context, causationId: '\ud800' } })],
      [
        'provenance source',
        event({ context: { ...event().context, provenance: { source: '\ud800' } } }),
      ],
      [
        'reference id',
        event({ payload: { references: [{ type: 'run', id: '\udc00' }], metadata: {} } }),
      ],
      ['metadata key', event({ payload: { references: [], metadata: { '\ud800': 'value' } } })],
      ['metadata value', event({ payload: { references: [], metadata: { value: '\udc00' } } })],
    ];
    for (const [field, malformed] of malformedEvents) {
      expect(events.insert(malformed).isErr(), field).toBe(true);
    }

    const emoji = event({
      context: { ...event().context, aggregate: { type: 'thread', id: 'thread-😀' } },
      payload: {
        references: [],
        metadata: { café: '😀', escaped: 'line\nbreak\tand \u0001', literal: '\\u1234' },
      },
    });
    expect(events.insert(emoji).isOk()).toBe(true);
    expect(events.findById(emoji.eventId)._unsafeUnwrap()?.payload).toContain('"café":"😀"');
    expect(
      events
        .insert(event({ payload: { references: [], metadata: { A: true, Ａ: false } } }))
        .isErr(),
    ).toBe(true);
    expect(
      events.insertWithDeliveries(event(), [{ ...delivery(), persona: 'support\ud800' }]).isErr(),
    ).toBe(true);
    expect(
      events
        .insertWithDeliveries(event(), [
          {
            ...delivery(),
            identity: { ...delivery().identity, implementationRef: 'native\udc00' },
          },
        ])
        .isErr(),
    ).toBe(true);
  });

  it('rejects malformed runtime IDs on every lookup and mutation path without aliasing rows', () => {
    const now = 1_800_000_000_000;
    leaseNow = now;
    const replacementId = '\ufffd';
    const input = event({ eventId: replacementId });
    events.insertWithDeliveries(input, [delivery()])._unsafeUnwrap();
    const emojiInput = event({ eventId: '😀' });
    events.insertWithDeliveries(emojiInput, [delivery('emoji-handler')])._unsafeUnwrap();
    const claim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;

    for (const malformed of ['\ud800', '\udc00']) {
      expect(events.findById(malformed).isErr(), `event find ${JSON.stringify(malformed)}`).toBe(
        true,
      );
      expect(deliveries.findByEventId(malformed).isErr()).toBe(true);
      expect(deliveries.findByKey(malformed, 'run-projector').isErr()).toBe(true);
      expect(
        deliveries.complete(malformed, 'run-projector', claim.delivery.claim_token!).isErr(),
      ).toBe(true);
      expect(
        deliveries
          .fail(
            malformed,
            'run-projector',
            claim.delivery.claim_token!,
            { code: 'transient-failure' },
            now + 200,
          )
          .isErr(),
      ).toBe(true);
      expect(deliveries.reopen(malformed, 'run-projector').isErr()).toBe(true);
      expect(deliveries.complete(replacementId, 'run-projector', malformed).isErr()).toBe(true);
    }
    expect(events.findById(replacementId)._unsafeUnwrap()).not.toBeNull();
    expect(events.findById(emojiInput.eventId)._unsafeUnwrap()).not.toBeNull();
    expect(deliveries.findByEventId(emojiInput.eventId)._unsafeUnwrap()).toHaveLength(1);
    expect(deliveries.findByKey(replacementId, 'run-projector')._unsafeUnwrap()).toMatchObject({
      status: 'claimed',
      claim_token: claim.delivery.claim_token,
    });
    expect(
      deliveries.complete(replacementId, 'run-projector', claim.delivery.claim_token!).isOk(),
    ).toBe(true);
    leaseNow = now + 1;
    const emojiClaim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    expect(emojiClaim.delivery.event_id).toBe(emojiInput.eventId);
    expect(
      deliveries
        .complete(emojiInput.eventId, 'emoji-handler', emojiClaim.delivery.claim_token!)
        .isOk(),
    ).toBe(true);
    expect(events.findByAggregate('thread', 'thread-😀').isOk()).toBe(true);
  });

  it('bounds hostile lifecycle transport shapes before schema parsing without throwing', () => {
    const sparse: unknown[] = [];
    sparse.length = 0xffffffff;
    const accessor = [delivery()] as unknown[];
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get() {
        throw new Error('array accessor must not run');
      },
    });
    const iterable = [delivery()] as unknown[];
    Object.defineProperty(iterable, Symbol.iterator, {
      value() {
        throw new Error('iterator must not run');
      },
    });
    const proxied = new Proxy(event(), {});
    const revoked = Proxy.revocable(event(), {});
    revoked.revoke();
    const proxiedArray = new Proxy([delivery()], {});
    const nonNativeArray = [delivery()];
    Object.setPrototypeOf(nonNativeArray, {});
    const hugeEventId = event({ eventId: 'x'.repeat(1_000_000) });
    const hugeMetadataKey = event({
      payload: { references: [], metadata: { ['x'.repeat(1_000_000)]: 'value' } },
    });
    const excessiveMetadata = event({
      payload: {
        references: [],
        metadata: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`k${index}`, index]),
        ),
      },
    });
    const cyclic = event();
    (cyclic.payload.metadata as Record<string, unknown>).cycle = cyclic;
    let deep: unknown = 'leaf';
    for (let index = 0; index < 128; index += 1) {
      deep = { nested: deep };
    }
    const excessiveDepth = event({ payload: { references: [], metadata: { deep } } });
    const oversized = event({ payload: { references: [], metadata: { body: 'x'.repeat(1_025) } } });
    const oversizedNamedEvent = event() as unknown as Record<string, unknown>;
    for (let index = 0; index < 33; index += 1) oversizedNamedEvent[`extra${index}`] = index;
    const oversizedSymbolEvent = event() as unknown as Record<PropertyKey, unknown>;
    for (let index = 0; index < 33; index += 1)
      oversizedSymbolEvent[Symbol(`extra${index}`)] = index;
    const oversizedNamedDeliveries = [delivery()] as unknown as Record<string, unknown>;
    const oversizedSymbolDeliveries = [delivery()] as unknown as Record<PropertyKey, unknown>;
    for (let index = 0; index < 33; index += 1) {
      oversizedNamedDeliveries[`extra${index}`] = index;
      oversizedSymbolDeliveries[Symbol(`extra${index}`)] = index;
    }

    for (const candidate of [
      proxied,
      revoked.proxy,
      excessiveMetadata,
      cyclic,
      excessiveDepth,
      oversized,
      hugeEventId,
      hugeMetadataKey,
      oversizedNamedEvent,
      oversizedSymbolEvent,
    ]) {
      expect(() => events.insert(candidate as LifecycleEventEnvelope)).not.toThrow();
      expect(events.insert(candidate as LifecycleEventEnvelope).isErr()).toBe(true);
    }
    for (const candidate of [
      sparse,
      accessor,
      iterable,
      proxiedArray,
      nonNativeArray,
      oversizedNamedDeliveries,
      oversizedSymbolDeliveries,
    ]) {
      expect(() =>
        events.insertWithDeliveries(event(), candidate as LifecycleDeliveryFanoutInput[]),
      ).not.toThrow();
      expect(
        events.insertWithDeliveries(event(), candidate as LifecycleDeliveryFanoutInput[]).isErr(),
      ).toBe(true);
    }

    const boundary = event({
      payload: {
        references: Array.from({ length: 32 }, (_, index) => ({ type: 'run', id: `run-${index}` })),
        metadata: Object.fromEntries(
          Array.from({ length: 32 }, (_, index) => [`key-${index}`, 'x'.repeat(1_024)]),
        ),
      },
    });
    expect(events.insert(boundary).isOk()).toBe(true);
  });

  it('retries, dead-letters, and reopens a delivery without duplicating its identity', () => {
    const now = 1_800_000_000_000;
    leaseNow = now;
    const input = event();
    events.insertWithDeliveries(input, [delivery()])._unsafeUnwrap();

    const firstClaim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    const retry = deliveries.fail(
      input.eventId,
      'run-projector',
      firstClaim.delivery.claim_token!,
      { code: 'transient-failure' },
      now + 500,
    );
    expect(retry._unsafeUnwrap().status).toBe('failed');
    leaseNow = now + 499;
    expect(deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()).toBeNull();

    leaseNow = now + 500;
    const secondClaim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    const deadLetter = deliveries.fail(
      input.eventId,
      'run-projector',
      secondClaim.delivery.claim_token!,
      { code: 'permanent-failure' },
      now + 1_000,
    );
    expect(deadLetter._unsafeUnwrap().status).toBe('dead_letter');

    const reopened = deliveries.reopen(input.eventId, 'run-projector')._unsafeUnwrap();
    expect(reopened.status).toBe('pending');
    expect(reopened.attempts).toBe(0);
    expect(deliveries.findByEventId(input.eventId)._unsafeUnwrap()).toHaveLength(1);
  });

  it('moves a non-retryable failure directly to dead letter under its current lease', () => {
    const now = 1_800_000_000_000;
    leaseNow = now;
    const input = event();
    events.insertWithDeliveries(input, [{ ...delivery(), maxAttempts: 3 }])._unsafeUnwrap();
    const claim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;

    const terminalResult = deliveries.fail(
      input.eventId,
      'run-projector',
      claim.delivery.claim_token!,
      { code: 'permanent-failure' },
      now + 500,
      false,
    );
    expect(terminalResult.isOk()).toBe(true);
    const terminal = terminalResult._unsafeUnwrap();

    expect(terminal).toMatchObject({
      status: 'dead_letter',
      attempts: 1,
      max_attempts: 3,
      next_retry_at: null,
      claim_token: null,
      last_error: '{"code":"permanent-failure"}',
    });
  });

  it('upgrades a committed v14 database before terminally dead-lettering a non-retryable lease', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'talon-lifecycle-v14-db-')), 'talon.sqlite');
    const legacyDb = new Database(dbPath);
    legacyDb.pragma('foreign_keys = ON');
    let upgradeLeaseNow = 1_800_000_000_000;
    try {
      expect(runMigrations(legacyDb, committedV14Migrations())._unsafeUnwrap()).toBe(15);
      expect(legacyDb.pragma('user_version', { simple: true })).toBe(14);
      const legacyEvents = new LifecycleEventRepository(legacyDb);
      const legacyDeliveries = new LifecycleDeliveryRepository(legacyDb, () => upgradeLeaseNow);
      const input = event();
      legacyEvents.insertWithDeliveries(input, [{ ...delivery(), maxAttempts: 3 }])._unsafeUnwrap();
      const lease = legacyDeliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;

      const currentMigrations = join(
        import.meta.dirname,
        '../../../../../src/core/database/migrations',
      );
      expect(runMigrations(legacyDb, currentMigrations)._unsafeUnwrap()).toBe(4);
      expect(legacyDb.pragma('user_version', { simple: true })).toBe(18);
      const upgradedDeliveries = new LifecycleDeliveryRepository(legacyDb, () => upgradeLeaseNow);
      const terminal = upgradedDeliveries
        .fail(
          input.eventId,
          'run-projector',
          lease.delivery.claim_token!,
          { code: 'permanent-failure' },
          upgradeLeaseNow + 500,
          false,
        )
        ._unsafeUnwrap();

      expect(terminal).toMatchObject({
        status: 'dead_letter',
        attempts: 1,
        max_attempts: 3,
        claim_token: null,
        claim_expires_at: null,
        next_retry_at: null,
      });
      expect(
        upgradedDeliveries.reopen(input.eventId, 'run-projector')._unsafeUnwrap(),
      ).toMatchObject({
        status: 'pending',
        attempts: 0,
      });
    } finally {
      legacyDb.close();
    }
  });

  it('returns Result errors for invalid and hostile public inputs without throwing', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile getter');
        },
      },
    );
    const input = event();
    events.insertWithDeliveries(input, [delivery()])._unsafeUnwrap();
    leaseNow = 1_000;
    const claim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;

    expect(() =>
      deliveries.claimNext(null as unknown as ClaimLifecycleDeliveryOptions),
    ).not.toThrow();
    expect(deliveries.claimNext(null as unknown as ClaimLifecycleDeliveryOptions).isErr()).toBe(
      true,
    );
    expect(deliveries.claimNext(hostile as ClaimLifecycleDeliveryOptions).isErr()).toBe(true);
    expect(
      deliveries
        .claimNext({
          leaseMs: 1,
          now: Number.MAX_SAFE_INTEGER,
        } as unknown as ClaimLifecycleDeliveryOptions)
        .isOk(),
    ).toBe(true);
    expect(
      deliveries
        .fail(
          input.eventId,
          'run-projector',
          claim.delivery.claim_token!,
          42 as unknown as LifecycleFailureDiagnostic,
          2_000,
        )
        .isErr(),
    ).toBe(true);
    expect(events.insert(hostile as LifecycleEventEnvelope).isErr()).toBe(true);
    expect(
      events.insertWithDeliveries(event(), [hostile as LifecycleDeliveryFanoutInput]).isErr(),
    ).toBe(true);

    const secretCause = new Error('Authorization: Bearer caller-controlled-secret');
    const throwingOptions = Object.defineProperty({}, 'leaseMs', {
      get() {
        throw secretCause;
      },
    }) as ClaimLifecycleDeliveryOptions;
    const rejected = deliveries.claimNext(throwingOptions);
    expect(rejected.isErr()).toBe(true);
    expect(rejected._unsafeUnwrapErr().cause).toBeUndefined();
    expect(rejected._unsafeUnwrapErr().message).not.toContain('caller-controlled-secret');

    const optionAccessor = Object.defineProperty({ leaseMs: 100 }, 'now', {
      enumerable: true,
      get() {
        throw new Error('claim option accessor must not run');
      },
    }) as ClaimLifecycleDeliveryOptions;
    const diagnosticAccessor = Object.defineProperty({}, 'code', {
      enumerable: true,
      get() {
        throw new Error('diagnostic accessor must not run');
      },
    }) as LifecycleFailureDiagnostic;
    const oversizedNamedOptions = { leaseMs: 100 } as Record<string, unknown>;
    const oversizedSymbolOptions = { leaseMs: 100 } as Record<PropertyKey, unknown>;
    for (let index = 0; index < 9; index += 1) {
      oversizedNamedOptions[`extra${index}`] = index;
      oversizedSymbolOptions[Symbol(`extra${index}`)] = index;
    }
    const diagnosticProxy = new Proxy(
      { code: 'transient-failure' },
      {
        get() {
          throw new Error('diagnostic proxy must not run');
        },
      },
    ) as LifecycleFailureDiagnostic;
    expect(() => deliveries.claimNext(optionAccessor)).not.toThrow();
    expect(deliveries.claimNext(optionAccessor).isErr()).toBe(true);
    expect(() =>
      deliveries.claimNext(oversizedNamedOptions as ClaimLifecycleDeliveryOptions),
    ).not.toThrow();
    expect(
      deliveries.claimNext(oversizedNamedOptions as ClaimLifecycleDeliveryOptions).isErr(),
    ).toBe(true);
    expect(
      deliveries.claimNext(oversizedSymbolOptions as ClaimLifecycleDeliveryOptions).isErr(),
    ).toBe(true);
    expect(() =>
      deliveries.fail(
        input.eventId,
        'run-projector',
        claim.delivery.claim_token!,
        diagnosticAccessor,
        2_000,
      ),
    ).not.toThrow();
    expect(
      deliveries
        .fail(
          input.eventId,
          'run-projector',
          claim.delivery.claim_token!,
          diagnosticAccessor,
          2_000,
        )
        .isErr(),
    ).toBe(true);
    expect(
      deliveries
        .fail(input.eventId, 'run-projector', claim.delivery.claim_token!, diagnosticProxy, 2_000)
        .isErr(),
    ).toBe(true);
  });

  it('serializes parsed handler contracts and rejects corrupted delivery rows on reads', () => {
    const input = event();
    const hostileIdentity = new Proxy(delivery().identity, {
      get(target, property, receiver) {
        if (property === 'toJSON') {
          throw new Error('toJSON must never be called');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const hostileDelivery = {
      ...delivery(),
      identity: hostileIdentity,
    } as LifecycleDeliveryFanoutInput;
    // Proxies are rejected before reflection, so neither toJSON nor a getter
    // can be invoked while making the durable snapshot.
    expect(events.insertWithDeliveries(input, [hostileDelivery]).isErr()).toBe(true);

    const stored = event();
    events.insertWithDeliveries(stored, [delivery()])._unsafeUnwrap();
    withIgnoredCheckConstraints(() => {
      db.prepare(
        `UPDATE lifecycle_event_deliveries SET handler_identity = ? WHERE event_id = ?`,
      ).run('{"version":"v1"}', stored.eventId);
    });
    expect(deliveries.findByEventId(stored.eventId).isErr()).toBe(true);
  });

  it('rejects corrupt embedded data and every invalid delivery state on reload', () => {
    const mismatchedIdentity = {
      ...delivery().identity,
      handlerId: 'other-handler',
    };
    const identityInput = event();
    events.insertWithDeliveries(identityInput, [delivery()])._unsafeUnwrap();
    withIgnoredCheckConstraints(() => {
      db.prepare(
        `UPDATE lifecycle_event_deliveries SET handler_identity = ? WHERE event_id = ?`,
      ).run(JSON.stringify(mismatchedIdentity), identityInput.eventId);
    });
    expect(deliveries.findByEventId(identityInput.eventId).isErr()).toBe(true);

    const scenarios = [
      {
        status: 'pending',
        attempts: 1,
        nextRetryAt: null,
        claimToken: null,
        claimExpiresAt: null,
        lastError: null,
        completedAt: null,
      },
      {
        status: 'claimed',
        attempts: 0,
        nextRetryAt: null,
        claimToken: null,
        claimExpiresAt: 2_000,
        lastError: null,
        completedAt: null,
      },
      {
        status: 'claimed',
        attempts: 0,
        nextRetryAt: null,
        claimToken: ' not-a-valid-claim-token ',
        claimExpiresAt: 2_000,
        lastError: null,
        completedAt: null,
      },
      {
        status: 'failed',
        attempts: 1,
        nextRetryAt: null,
        claimToken: null,
        claimExpiresAt: null,
        lastError: '{"code":"transient-failure"}',
        completedAt: null,
      },
      {
        status: 'failed',
        attempts: 1,
        nextRetryAt: 1.5,
        claimToken: null,
        claimExpiresAt: null,
        lastError: '{"code":"transient-failure"}',
        completedAt: null,
      },
      {
        status: 'completed',
        attempts: 0,
        nextRetryAt: null,
        claimToken: null,
        claimExpiresAt: null,
        lastError: null,
        completedAt: null,
      },
      {
        status: 'dead_letter',
        attempts: 0,
        nextRetryAt: null,
        claimToken: null,
        claimExpiresAt: null,
        lastError: '{"code":"permanent-failure"}',
        completedAt: null,
      },
    ];
    for (const scenario of scenarios) {
      const input = event();
      events.insertWithDeliveries(input, [delivery()])._unsafeUnwrap();
      withIgnoredCheckConstraints(() => {
        db.prepare(
          `UPDATE lifecycle_event_deliveries
           SET status = ?, attempts = ?, next_retry_at = ?, claim_token = ?,
               claim_expires_at = ?, last_error = ?, completed_at = ?
           WHERE event_id = ?`,
        ).run(
          scenario.status,
          scenario.attempts,
          scenario.nextRetryAt,
          scenario.claimToken,
          scenario.claimExpiresAt,
          scenario.lastError,
          scenario.completedAt,
          input.eventId,
        );
      });
      expect(deliveries.findByEventId(input.eventId).isErr()).toBe(true);
    }

    const emptyPersona = event();
    events.insertWithDeliveries(emptyPersona, [delivery()])._unsafeUnwrap();
    withIgnoredCheckConstraints(() => {
      db.prepare(`UPDATE lifecycle_event_deliveries SET persona = '' WHERE event_id = ?`).run(
        emptyPersona.eventId,
      );
    });
    expect(deliveries.findByEventId(emptyPersona.eventId).isErr()).toBe(true);

    const malformedPolicy = event();
    events.insertWithDeliveries(malformedPolicy, [delivery()])._unsafeUnwrap();
    withIgnoredCheckConstraints(() => {
      db.prepare(
        `UPDATE lifecycle_event_deliveries SET failure_policy = '{}' WHERE event_id = ?`,
      ).run(malformedPolicy.eventId);
    });
    expect(deliveries.findByEventId(malformedPolicy.eventId).isErr()).toBe(true);

    const emptyCausation = event();
    events.insert(emptyCausation)._unsafeUnwrap();
    withIgnoredCheckConstraints(() => {
      db.prepare(`UPDATE lifecycle_events SET causation_id = '' WHERE event_id = ?`).run(
        emptyCausation.eventId,
      );
    });
    expect(events.findById(emptyCausation.eventId).isErr()).toBe(true);

    const malformedTimestamp = event();
    events.insert(malformedTimestamp)._unsafeUnwrap();
    withIgnoredCheckConstraints(() => {
      db.prepare(`UPDATE lifecycle_events SET created_at = 1.5 WHERE event_id = ?`).run(
        malformedTimestamp.eventId,
      );
    });
    expect(events.findById(malformedTimestamp.eventId).isErr()).toBe(true);
  });

  it('rolls back state transitions when a returned row or related event is invalid', () => {
    const now = 1_800_000_000_000;
    leaseNow = now;
    const claimInput = event();
    events.insertWithDeliveries(claimInput, [delivery()])._unsafeUnwrap();
    withIgnoredCheckConstraints(() => {
      db.prepare(`UPDATE lifecycle_events SET causation_id = '' WHERE event_id = ?`).run(
        claimInput.eventId,
      );
    });
    expect(deliveries.claimNext({ leaseMs: 100 }).isErr()).toBe(true);
    expect(deliveries.findByKey(claimInput.eventId, 'run-projector')._unsafeUnwrap()?.status).toBe(
      'pending',
    );
    db.prepare(`UPDATE lifecycle_events SET causation_id = NULL WHERE event_id = ?`).run(
      claimInput.eventId,
    );
    db.prepare(
      `UPDATE lifecycle_event_deliveries
       SET status = 'completed', completed_at = 1_000, updated_at = 1_000
       WHERE event_id = ?`,
    ).run(claimInput.eventId);

    const completeInput = event();
    events.insertWithDeliveries(completeInput, [delivery()])._unsafeUnwrap();
    leaseNow = now + 1;
    const completeClaim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    withIgnoredCheckConstraints(() => {
      db.prepare(`UPDATE lifecycle_event_deliveries SET persona = '' WHERE event_id = ?`).run(
        completeInput.eventId,
      );
    });
    expect(
      deliveries
        .complete(completeInput.eventId, 'run-projector', completeClaim.delivery.claim_token!)
        .isErr(),
    ).toBe(true);
    expect(
      db
        .prepare(`SELECT status, claim_token FROM lifecycle_event_deliveries WHERE event_id = ?`)
        .get(completeInput.eventId),
    ).toEqual({ status: 'claimed', claim_token: completeClaim.delivery.claim_token });
    db.prepare(`UPDATE lifecycle_event_deliveries SET persona = 'support' WHERE event_id = ?`).run(
      completeInput.eventId,
    );
    deliveries
      .complete(completeInput.eventId, 'run-projector', completeClaim.delivery.claim_token!)
      ._unsafeUnwrap();

    const failInput = event();
    events.insertWithDeliveries(failInput, [delivery()])._unsafeUnwrap();
    leaseNow = now + 2;
    const failClaim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    withIgnoredCheckConstraints(() => {
      db.prepare(`UPDATE lifecycle_event_deliveries SET persona = '' WHERE event_id = ?`).run(
        failInput.eventId,
      );
    });
    expect(
      deliveries
        .fail(
          failInput.eventId,
          'run-projector',
          failClaim.delivery.claim_token!,
          { code: 'transient-failure' },
          now + 1_000,
        )
        .isErr(),
    ).toBe(true);
    expect(
      db
        .prepare(`SELECT status, claim_token FROM lifecycle_event_deliveries WHERE event_id = ?`)
        .get(failInput.eventId),
    ).toEqual({ status: 'claimed', claim_token: failClaim.delivery.claim_token });
    db.prepare(`UPDATE lifecycle_event_deliveries SET persona = 'support' WHERE event_id = ?`).run(
      failInput.eventId,
    );
    deliveries
      .fail(
        failInput.eventId,
        'run-projector',
        failClaim.delivery.claim_token!,
        { code: 'transient-failure' },
        now + 1_000,
      )
      ._unsafeUnwrap();

    const reopenInput = event();
    events.insertWithDeliveries(reopenInput, [{ ...delivery(), maxAttempts: 1 }])._unsafeUnwrap();
    leaseNow = now + 3;
    const reopenClaim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    deliveries
      .fail(
        reopenInput.eventId,
        'run-projector',
        reopenClaim.delivery.claim_token!,
        { code: 'permanent-failure' },
        now + 1_000,
      )
      ._unsafeUnwrap();
    withIgnoredCheckConstraints(() => {
      db.prepare(`UPDATE lifecycle_event_deliveries SET persona = '' WHERE event_id = ?`).run(
        reopenInput.eventId,
      );
    });
    expect(deliveries.reopen(reopenInput.eventId, 'run-projector').isErr()).toBe(true);
    expect(
      db
        .prepare(`SELECT status FROM lifecycle_event_deliveries WHERE event_id = ?`)
        .get(reopenInput.eventId),
    ).toEqual({ status: 'dead_letter' });
  });

  it('persists only a safe structured failure code, never raw handler error text', () => {
    const now = 1_800_000_000_000;
    leaseNow = now;
    const input = event();
    events.insertWithDeliveries(input, [delivery()])._unsafeUnwrap();
    const claim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    const secret = 'Authorization: Bearer super-secret-token';

    expect(
      deliveries
        .fail(
          input.eventId,
          'run-projector',
          claim.delivery.claim_token!,
          { code: 'provider-timeout', message: secret } as unknown as LifecycleFailureDiagnostic,
          now + 1_000,
        )
        .isErr(),
    ).toBe(true);

    deliveries
      .fail(
        input.eventId,
        'run-projector',
        claim.delivery.claim_token!,
        { code: 'provider-timeout' },
        now + 1_000,
      )
      ._unsafeUnwrap();

    const stored = db
      .prepare(`SELECT last_error FROM lifecycle_event_deliveries WHERE event_id = ?`)
      .get(input.eventId) as { last_error: string };
    expect(stored.last_error).toBe('{"code":"provider-timeout"}');
    expect(stored.last_error).not.toContain(secret);
  });

  it('recovers an expired lease after a real close and reopen', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'talon-lifecycle-reopen-')), 'talon.sqlite');
    const firstDb = openFileDb(dbPath);
    const firstEvents = new LifecycleEventRepository(firstDb);
    const firstLeaseNow = 1_000;
    const firstDeliveries = new LifecycleDeliveryRepository(firstDb, () => firstLeaseNow);
    const input = event();
    firstEvents.insertWithDeliveries(input, [delivery()])._unsafeUnwrap();
    const firstClaim = firstDeliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    firstDb.close();

    const secondDb = openFileDb(dbPath);
    try {
      const secondDeliveries = new LifecycleDeliveryRepository(secondDb, () => 1_101);
      const reclaimed = secondDeliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap();
      expect(reclaimed?.delivery.event_id).toBe(input.eventId);
      expect(reclaimed?.delivery.claim_token).not.toBe(firstClaim.delivery.claim_token);
    } finally {
      secondDb.close();
    }
  });

  it('allows only one claim across two competing database connections', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'talon-lifecycle-claim-')), 'talon.sqlite');
    const firstDb = openFileDb(dbPath);
    const secondDb = openFileDb(dbPath);
    try {
      const firstEvents = new LifecycleEventRepository(firstDb);
      const firstDeliveries = new LifecycleDeliveryRepository(firstDb, () => 1_000);
      const secondDeliveries = new LifecycleDeliveryRepository(secondDb, () => 1_000);
      const input = event();
      firstEvents.insertWithDeliveries(input, [delivery()])._unsafeUnwrap();

      const firstClaim = firstDeliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap();
      const competingClaim = secondDeliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap();
      expect(firstClaim?.delivery.event_id).toBe(input.eventId);
      expect(competingClaim).toBeNull();
    } finally {
      secondDb.close();
      firstDb.close();
    }
  });

  it('does not reopen an earlier aggregate delivery while a later delivery has a valid lease', () => {
    const dbPath = join(
      mkdtempSync(join(tmpdir(), 'talon-lifecycle-replay-order-')),
      'talon.sqlite',
    );
    const firstDb = openFileDb(dbPath);
    const secondDb = openFileDb(dbPath);
    const now = 1_800_000_000_000;
    let replayLeaseNow = now;
    try {
      const firstEvents = new LifecycleEventRepository(firstDb);
      const firstDeliveries = new LifecycleDeliveryRepository(firstDb, () => replayLeaseNow);
      const secondDeliveries = new LifecycleDeliveryRepository(secondDb, () => replayLeaseNow);
      const aggregate = { type: 'thread', id: `thread-${uuid()}` };
      const first = event({ context: { ...event().context, aggregate } });
      const second = event({ context: { ...event().context, aggregate } });
      firstEvents.insertWithDeliveries(first, [delivery()])._unsafeUnwrap();
      firstEvents.insertWithDeliveries(second, [delivery()])._unsafeUnwrap();

      const firstClaim = firstDeliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
      firstDeliveries
        .complete(first.eventId, 'run-projector', firstClaim.delivery.claim_token!)
        ._unsafeUnwrap();
      replayLeaseNow = now + 1;
      const laterClaim = secondDeliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
      expect(laterClaim.delivery.event_id).toBe(second.eventId);

      expect(firstDeliveries.reopen(first.eventId, 'run-projector').isErr()).toBe(true);
      expect(
        secondDeliveries.findByKey(second.eventId, 'run-projector')._unsafeUnwrap()?.claim_token,
      ).toBe(laterClaim.delivery.claim_token);
      replayLeaseNow = now + 2;
      expect(firstDeliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()).toBeNull();
      expect(secondDeliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()).toBeNull();

      // Once the later lease expires, reopening the first event is safe and
      // aggregate ordering claims it before the expired later delivery. The
      // stale later token is explicitly invalidated before replay is opened.
      replayLeaseNow = now + 102;
      expect(firstDeliveries.reopen(first.eventId, 'run-projector').isOk()).toBe(true);
      expect(
        secondDeliveries.findByKey(second.eventId, 'run-projector')._unsafeUnwrap()?.claim_token,
      ).not.toBe(laterClaim.delivery.claim_token);
      expect(
        secondDeliveries
          .complete(second.eventId, 'run-projector', laterClaim.delivery.claim_token!)
          .isErr(),
      ).toBe(true);
      expect(
        secondDeliveries
          .fail(
            second.eventId,
            'run-projector',
            laterClaim.delivery.claim_token!,
            { code: 'stale-worker' },
            now + 200,
          )
          .isErr(),
      ).toBe(true);
      const replayClaim = firstDeliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap();
      expect(replayClaim?.delivery.event_id).toBe(first.eventId);
      expect(secondDeliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()).toBeNull();

      firstDeliveries
        .complete(first.eventId, 'run-projector', replayClaim!.delivery.claim_token!)
        ._unsafeUnwrap();
      replayLeaseNow = now + 106;
      const recoveredLaterClaim = secondDeliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap();
      expect(recoveredLaterClaim?.delivery.event_id).toBe(second.eventId);
      expect(recoveredLaterClaim?.delivery.claim_token).not.toBe(laterClaim.delivery.claim_token);
      secondDeliveries
        .complete(second.eventId, 'run-projector', recoveredLaterClaim!.delivery.claim_token!)
        ._unsafeUnwrap();
    } finally {
      secondDb.close();
      firstDb.close();
    }
  });

  it('leaves unrelated stale claims unchanged when replay is not eligible', () => {
    const now = 1_800_000_000_000;
    leaseNow = now;
    const replayTarget = event();
    const unrelated = event();
    events.insertWithDeliveries(replayTarget, [delivery('replay-handler')])._unsafeUnwrap();
    events
      .insertWithDeliveries(unrelated, [{ ...delivery('unrelated-handler'), priority: 1 }])
      ._unsafeUnwrap();

    const unrelatedClaim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
    expect(unrelatedClaim.delivery.event_id).toBe(unrelated.eventId);
    const before = db
      .prepare(`SELECT * FROM lifecycle_event_deliveries WHERE event_id = ?`)
      .get(unrelated.eventId);

    leaseNow = now + 101;
    expect(deliveries.reopen(replayTarget.eventId, 'replay-handler').isErr()).toBe(true);
    expect(
      db
        .prepare(`SELECT * FROM lifecycle_event_deliveries WHERE event_id = ?`)
        .get(unrelated.eventId),
    ).toEqual(before);
    expect(
      deliveries.findByKey(unrelated.eventId, 'unrelated-handler')._unsafeUnwrap(),
    ).toMatchObject({
      status: 'claimed',
      attempts: 0,
      claim_token: unrelatedClaim.delivery.claim_token,
      claim_expires_at: now + 100,
    });
  });

  it('seeds lifecycle timestamps across a clock rewind before writing again', () => {
    const future = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(future);
    try {
      const firstInput = event();
      const first = events.insertWithDeliveries(firstInput, [delivery()])._unsafeUnwrap();
      clock.mockReturnValue(future + 10_000);
      leaseNow = future + 10_000;
      const claim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
      const completed = deliveries
        .complete(firstInput.eventId, 'run-projector', claim.delivery.claim_token!)
        ._unsafeUnwrap();
      BaseRepository.__resetMonotonicClockForTests();
      clock.mockReturnValue(future - 60_000);
      BaseRepository.seedMonotonicClockFromDb(db);

      const second = events.insert(event())._unsafeUnwrap();
      expect(first.event.created_at).toBe(future);
      expect(second.created_at).toBeGreaterThan(completed.updated_at);
    } finally {
      clock.mockRestore();
    }
  });
});
