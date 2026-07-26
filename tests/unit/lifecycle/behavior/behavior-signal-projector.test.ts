import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import {
  BaseRepository,
  BehaviorSignalRepository,
} from '../../../../src/core/database/repositories/index.js';
import type { AuditEntry } from '../../../../src/core/logging/audit-logger.js';
import {
  BehaviorDetectorOutputSchema,
  toBehaviorFeedbackDetectedSignalEnvelope,
  type BehaviorDetectorSignal,
} from '../../../../src/lifecycle/behavior/contracts.js';
import {
  BehaviorSignalProjector,
  behaviorEvidenceFingerprint,
} from '../../../../src/lifecycle/behavior/index.js';
import type {
  LifecycleEventEnvelope,
  LifecycleSignalEnvelope,
} from '../../../../src/lifecycle/contracts/index.js';
import { createTestDb } from '../../core/database/repositories/helpers.js';

describe('BehaviorSignalProjector', () => {
  let db: Database.Database;
  let repository: BehaviorSignalRepository;
  let auditEntries: AuditEntry[];
  let projector: BehaviorSignalProjector;

  beforeEach(() => {
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    repository = new BehaviorSignalRepository(db);
    auditEntries = [];
    projector = new BehaviorSignalProjector(repository, {
      auditLogger: {
        logLifecycleProjection: vi.fn((entry: AuditEntry) => auditEntries.push(entry)),
      },
    });
  });

  afterEach(() => db.close());

  function event(overrides: Partial<LifecycleEventEnvelope> = {}): LifecycleEventEnvelope {
    return {
      version: 'v1',
      type: 'message.persisted.v1',
      eventId: 'event-1',
      occurredAt: '2026-07-25T12:00:00.000Z',
      context: {
        aggregate: { type: 'thread', id: 'thread-1' },
        correlationId: 'correlation-1',
        recursion: { depth: 0, maxDepth: 4 },
        provenance: { source: 'pipeline' },
      },
      payload: {
        references: [{ type: 'message', id: 'message-1' }],
        metadata: { direction: 'inbound', source: 'channel' },
      },
      ...overrides,
    };
  }

  function finding(overrides: Partial<BehaviorDetectorSignal> = {}): BehaviorDetectorSignal {
    return {
      category: 'explicit_correction',
      source: {
        kind: 'message',
        id: 'message-1',
        occurredAt: '2026-07-25T12:00:00.000Z',
        excerpt: 'Please stop being so verbose.',
      },
      supportingSources: [],
      sentiment: 'negative',
      candidateKind: 'style',
      confidence: 0.91,
      summary: 'User corrected the assistant for overly verbose responses.',
      proposedBehavior: 'Keep responses concise unless the user asks for detail.',
      ...overrides,
    };
  }

  function signal(
    detectorSignal: BehaviorDetectorSignal = finding(),
    sourceEvent: LifecycleEventEnvelope = event(),
  ): LifecycleSignalEnvelope {
    const output = BehaviorDetectorOutputSchema.parse({
      contract: 'talon.behavior.signal.v1',
      signals: [detectorSignal],
    });
    return toBehaviorFeedbackDetectedSignalEnvelope(
      sourceEvent,
      output.signals[0],
      0,
      'behavior-feedback-detector',
    );
  }

  it('records explicit correction evidence and a notes-only candidate with bounded audit', () => {
    const projected = projector.project({
      persona: 'support',
      handlerId: 'behavior-signal-projector',
      signal: signal(),
    });

    expect(projected.isOk()).toBe(true);
    expect(projected._unsafeUnwrap()).toMatchObject({
      outcome: 'candidate_created',
      signalCount: 0,
      distinctSourceCount: 1,
    });
    expect(repository.findEvidenceByPersona('support')._unsafeUnwrap()).toMatchObject([
      {
        persona: 'support',
        source_kind: 'message',
        source_id: 'message-1',
        sentiment: 'negative',
      },
    ]);
    expect(repository.findCandidatesByPersona('support')._unsafeUnwrap()).toMatchObject([
      {
        persona: 'support',
        kind: 'style',
        status: 'collecting',
        proposed_behavior: 'Keep responses concise unless the user asks for detail.',
      },
    ]);
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        action: 'lifecycle.behavior_projection',
        personaId: 'support',
        details: expect.objectContaining({
          outcome: 'candidate_created',
          category: 'explicit_correction',
          signalCount: 0,
        }),
      }),
    );
  });

  it('deduplicates schedule copies against direct message evidence fingerprints', () => {
    const directSignal = signal();
    const scheduleCopySignal = signal(
      finding({
        source: {
          kind: 'schedule',
          id: 'schedule-1',
          occurredAt: '2026-07-25T12:01:00.000Z',
          excerpt: 'Please stop being so verbose.',
        },
        supportingSources: [{ kind: 'message', id: 'message-1' }],
      }),
      event({
        eventId: 'event-2',
        type: 'schedule.fired.v1',
        payload: {
          references: [
            { type: 'schedule', id: 'schedule-1' },
            { type: 'message', id: 'message-1' },
          ],
          metadata: { scheduleType: 'cron' },
        },
      }),
    );

    expect(
      projector
        .project({ persona: 'support', handlerId: 'projector', signal: directSignal })
        .isOk(),
    ).toBe(true);
    const copy = projector.project({
      persona: 'support',
      handlerId: 'projector',
      signal: scheduleCopySignal,
    });

    expect(copy.isOk()).toBe(true);
    expect(copy._unsafeUnwrap()).toMatchObject({ outcome: 'suppressed_duplicate_evidence' });
    expect(repository.findEvidenceByPersona('support')._unsafeUnwrap()).toHaveLength(1);
    expect(behaviorEvidenceFingerprint(directSignal, { type: 'message', id: 'message-1' })).toBe(
      behaviorEvidenceFingerprint(scheduleCopySignal, { type: 'schedule', id: 'schedule-1' }),
    );
  });

  it('accumulates inferred evidence across handoffs before readying a candidate', () => {
    const twoSourceSignal = signal(
      finding({
        category: 'inferred_pattern',
        sentiment: 'neutral',
        source: { kind: 'message', id: 'message-1' },
        supportingSources: [{ kind: 'message', id: 'message-2' }],
        summary: 'The user repeatedly asks for concise answers.',
        proposedBehavior: 'Default to concise answers for this persona.',
      }),
      event({
        payload: {
          references: [
            { type: 'message', id: 'message-1' },
            { type: 'message', id: 'message-2' },
          ],
          metadata: {},
        },
      }),
    );
    const threeSourceSignal = signal(
      finding({
        category: 'inferred_pattern',
        sentiment: 'neutral',
        source: { kind: 'message', id: 'message-1' },
        supportingSources: [
          { kind: 'message', id: 'message-2' },
          { kind: 'message', id: 'message-3' },
        ],
        summary: 'The user repeatedly asks for concise answers.',
        proposedBehavior: 'Default to concise answers for this persona.',
      }),
      event({
        eventId: 'event-3',
        payload: {
          references: [
            { type: 'message', id: 'message-1' },
            { type: 'message', id: 'message-2' },
            { type: 'message', id: 'message-3' },
          ],
          metadata: {},
        },
      }),
    );

    expect(
      projector
        .project({ persona: 'support', handlerId: 'projector', signal: twoSourceSignal })
        ._unsafeUnwrap(),
    ).toMatchObject({ outcome: 'suppressed_candidate_threshold', distinctSourceCount: 2 });
    expect(repository.findCandidatesByPersona('support')._unsafeUnwrap()).toMatchObject([
      { status: 'collecting', proposed_behavior: 'Default to concise answers for this persona.' },
    ]);

    const projected = projector.project({
      persona: 'support',
      handlerId: 'projector',
      signal: threeSourceSignal,
    });

    expect(projected.isOk()).toBe(true);
    expect(projected._unsafeUnwrap()).toMatchObject({
      outcome: 'evidence_recorded',
      distinctSourceCount: 3,
    });
    expect(repository.findCandidatesByPersona('support')._unsafeUnwrap()).toMatchObject([
      { status: 'ready', proposed_behavior: 'Default to concise answers for this persona.' },
    ]);
    expect(
      repository
        .countDistinctEvidenceSources(
          repository.findCandidatesByPersona('support')._unsafeUnwrap()[0]!.candidate_id,
        )
        ._unsafeUnwrap(),
    ).toBe(3);
  });

  it('suppresses invalid persona scope and unsupported signal payloads without ledger writes', () => {
    const valid = signal();
    const forged = {
      ...valid,
      payload: {
        ...valid.payload,
        references: [],
      },
    };

    expect(
      projector.project({ persona: 'bad\0persona', handlerId: 'projector', signal: valid }).isErr(),
    ).toBe(true);
    expect(
      projector
        .project({ persona: 'support', handlerId: 'projector', signal: forged })
        ._unsafeUnwrap(),
    ).toMatchObject({ outcome: 'suppressed_invalid_signal' });
    expect(repository.findEvidenceByPersona('support')._unsafeUnwrap()).toEqual([]);
  });
});
