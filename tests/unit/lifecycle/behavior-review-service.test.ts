import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import {
  BaseRepository,
  BehaviorSignalRepository,
} from '../../../src/core/database/repositories/index.js';
import {
  BehaviorReviewService,
  behaviorReviewPromotionId,
} from '../../../src/lifecycle/behavior/behavior-review-service.js';
import type {
  BehaviorCandidateKind,
  BehaviorEvidenceSentiment,
  BehaviorEvidenceSourceKind,
} from '../../../src/lifecycle/behavior/index.js';
import { createTestDb } from '../core/database/repositories/helpers.js';

describe('BehaviorReviewService', () => {
  let db: Database.Database;
  let repository: BehaviorSignalRepository;
  let auditEntries: unknown[];
  let service: BehaviorReviewService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T12:00:00.000Z'));
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    repository = new BehaviorSignalRepository(db);
    auditEntries = [];
    service = new BehaviorReviewService(repository, {
      maxCandidates: 4,
      maxEvidencePerCandidate: 4,
      traceEvidenceProvider: async () => ({
        status: 'available',
        traceIds: ['trace-1'],
      }),
      auditLogger: {
        logLifecycleProjection: vi.fn((entry) => auditEntries.push(entry)),
      },
    });
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  function evidence(
    suffix: string,
    overrides: Partial<{
      sourceKind: BehaviorEvidenceSourceKind;
      sourceId: string;
      sourceOccurredAt: string;
      sentiment: BehaviorEvidenceSentiment;
      confidence: number;
      summary: string;
      metadata: Record<string, string | number | boolean | null>;
    }> = {},
  ): string {
    const evidenceId = `behavior-evidence-${suffix}`;
    const recorded = repository.recordEvidence({
      evidenceId,
      persona: 'support',
      sourceKind: overrides.sourceKind ?? 'message',
      sourceId: overrides.sourceId ?? `message-${suffix}`,
      sourceOccurredAt: overrides.sourceOccurredAt ?? '2026-07-26T10:00:00.000Z',
      fingerprint: `bef.v1.${suffix}`,
      sentiment: overrides.sentiment ?? 'negative',
      confidence: overrides.confidence ?? 0.82,
      summary: overrides.summary ?? `Evidence ${suffix}`,
      metadata: {
        category: 'explicit_correction',
        candidateKind: 'style',
        provenanceDetector: 'behavior-feedback-detector',
        provenanceInputEventId: `event-${suffix}`,
        provenanceInputEventType: 'message.persisted.v1',
        ...overrides.metadata,
      },
    });
    expect(recorded.isOk()).toBe(true);
    return recorded._unsafeUnwrap().evidence_id;
  }

  function candidate(
    suffix: string,
    evidenceIds: readonly string[],
    overrides: Partial<{
      kind: BehaviorCandidateKind;
      status: 'collecting' | 'ready';
      proposedBehavior: string;
      confidence: number;
    }> = {},
  ): string {
    const candidateId = `behavior-candidate-${suffix}`;
    const created = repository.createCandidate({
      candidateId,
      persona: 'support',
      kind: overrides.kind ?? 'style',
      status: overrides.status ?? 'ready',
      summary: `Candidate ${suffix}`,
      proposedBehavior: overrides.proposedBehavior ?? 'Keep answers concise by default.',
      confidence: overrides.confidence ?? 0.87,
      createdFromEvidenceIds: evidenceIds,
    });
    expect(created.isOk()).toBe(true);
    return created._unsafeUnwrap().candidate_id;
  }

  it('creates a bounded prompt-patch-backed daily review promotion with schedule provenance and trace metadata', async () => {
    const candidateId = candidate('concise', [evidence('1'), evidence('2')]);

    const reviewed = await service.review({
      persona: 'support',
      cadence: 'daily',
      now: '2026-07-26T12:00:00.000Z',
      trigger: {
        kind: 'schedule',
        scheduleId: 'schedule-daily',
        firedAt: '2026-07-26T12:00:00.000Z',
      },
    });

    expect(reviewed.isOk()).toBe(true);
    expect(reviewed._unsafeUnwrap()).toMatchObject({
      outcome: 'proposal_created',
      cadence: 'daily',
      reviewedCandidateCount: 1,
      createdPromotionIds: [behaviorReviewPromotionId('support', 'daily', candidateId)],
      traceEvidenceStatus: 'available',
    });
    const promotions = repository.findPromotionsByPersona('support')._unsafeUnwrap();
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({
      status: 'proposed',
      candidate_id: candidateId,
    });
    expect(JSON.parse(promotions[0]!.policy)).toMatchObject({
      contract: 'talon.behavior.review.proposal.v1',
      cadence: 'daily',
      scheduleId: 'schedule-daily',
      notesOnly: false,
      autoPromote: true,
      autoScope: 'persona-system-prompt-append-only',
      evidenceCount: 2,
    });
    const policy = JSON.parse(promotions[0]!.policy) as { promptPatchJson: string };
    expect(JSON.parse(policy.promptPatchJson)).toMatchObject({
      contract: 'talon.behavior.prompt_patch.v1',
      target: { kind: 'persona-system-prompt', persona: 'support' },
      operations: [
        {
          op: 'append_section',
          heading: 'Behavior style',
          content: 'Keep answers concise by default.',
        },
      ],
    });
    expect(JSON.parse(promotions[0]!.evaluation)).toMatchObject({
      reviewer: 'native-behavior-review-service',
      traceEvidenceStatus: 'available',
      traceEvidenceCount: 1,
      sourceThreshold: 2,
    });
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        action: 'lifecycle.behavior_review',
        personaId: 'support',
        details: expect.objectContaining({
          outcome: 'proposal_created',
          cadence: 'daily',
          scheduleId: 'schedule-daily',
          signalCount: 0,
        }),
      }),
    );
  });

  it('transitions qualifying collecting candidates to ready before promotion', async () => {
    service = new BehaviorReviewService(repository, {
      maxCandidates: 4,
      maxEvidencePerCandidate: 2,
    });
    const candidateId = candidate(
      'collecting-distinct',
      [evidence('1'), evidence('2'), evidence('3')],
      { status: 'collecting' },
    );

    const reviewed = await service.review({
      persona: 'support',
      cadence: 'weekly',
      now: '2026-07-26T12:00:00.000Z',
      trigger: { kind: 'manual' },
    });

    expect(reviewed.isOk()).toBe(true);
    expect(reviewed._unsafeUnwrap()).toMatchObject({
      outcome: 'proposal_created',
      reviewedCandidateCount: 1,
      createdPromotionIds: [behaviorReviewPromotionId('support', 'weekly', candidateId)],
    });
    expect(repository.findCandidatesByPersona('support')._unsafeUnwrap()).toContainEqual(
      expect.objectContaining({ candidate_id: candidateId, status: 'ready' }),
    );
    const promotion = repository.findPromotionsByPersona('support')._unsafeUnwrap()[0]!;
    expect(promotion.candidate_id).toBe(candidateId);
    expect(JSON.parse(promotion.policy)).toMatchObject({
      evidenceCount: 2,
      distinctSourceCount: 3,
    });
  });

  it('keeps oversized proposed behavior as notes-only instead of producing an invalid patch', async () => {
    candidate('oversized', [evidence('1'), evidence('2')], {
      proposedBehavior: 'x'.repeat(600),
    });

    const reviewed = await service.review({
      persona: 'support',
      cadence: 'daily',
      now: '2026-07-26T12:00:00.000Z',
      trigger: { kind: 'manual' },
    });

    expect(reviewed.isOk()).toBe(true);
    const [promotion] = repository.findPromotionsByPersona('support')._unsafeUnwrap();
    expect(JSON.parse(promotion!.policy)).toMatchObject({
      notesOnly: true,
      promptPatchUnavailableReason: 'unbounded-or-invalid-proposed-behavior',
    });
    expect(JSON.parse(promotion!.policy)).not.toHaveProperty('promptPatchJson');
  });

  it('suppresses duplicate promotions and conflicting candidates in the same review window', async () => {
    const first = candidate('concise', [evidence('1'), evidence('2')]);
    candidate('verbose', [evidence('3'), evidence('4')], {
      proposedBehavior: 'Prefer detailed answers by default.',
    });

    const firstRun = await service.review({
      persona: 'support',
      cadence: 'daily',
      now: '2026-07-26T12:00:00.000Z',
      trigger: { kind: 'manual' },
    });
    expect(firstRun._unsafeUnwrap()).toMatchObject({
      outcome: 'suppressed_conflict',
      skippedCandidateIds: ['behavior-candidate-verbose'],
    });
    expect(repository.findPromotionsByPersona('support')._unsafeUnwrap()).toHaveLength(1);

    const secondRun = await service.review({
      persona: 'support',
      cadence: 'daily',
      now: '2026-07-26T12:00:00.000Z',
      trigger: { kind: 'manual' },
    });

    expect(secondRun._unsafeUnwrap()).toMatchObject({
      outcome: 'suppressed_duplicate',
      createdPromotionIds: [],
      skippedCandidateIds: [first, 'behavior-candidate-verbose'],
    });
    expect(repository.findPromotionsByPersona('support')._unsafeUnwrap()).toHaveLength(1);
  });

  it('enforces weekly source thresholds and expires stale candidates without trace evidence', async () => {
    service = new BehaviorReviewService(repository, {
      maxCandidates: 4,
      maxEvidencePerCandidate: 4,
      traceEvidenceProvider: async () => ({ status: 'unavailable', reason: 'trace-disabled' }),
    });
    candidate('weekly-low', [evidence('1'), evidence('2')]);
    const stale = candidate(
      'stale',
      [
        evidence('old-1', { sourceOccurredAt: '2026-07-10T10:00:00.000Z' }),
        evidence('old-2', { sourceOccurredAt: '2026-07-10T11:00:00.000Z' }),
      ],
      { status: 'collecting', proposedBehavior: 'Remember this stale behavior.' },
    );

    const reviewed = await service.review({
      persona: 'support',
      cadence: 'weekly',
      now: '2026-07-26T12:00:00.000Z',
      trigger: {
        kind: 'schedule',
        scheduleId: 'schedule-weekly',
        firedAt: '2026-07-26T12:00:00.000Z',
      },
    });

    expect(reviewed.isOk()).toBe(true);
    expect(reviewed._unsafeUnwrap()).toMatchObject({
      outcome: 'suppressed_threshold',
      createdPromotionIds: [],
      expiredCandidateIds: [stale],
      traceEvidenceStatus: 'unavailable',
    });
    expect(repository.findCandidatesByPersona('support')._unsafeUnwrap()).toContainEqual(
      expect.objectContaining({ candidate_id: stale, status: 'expired' }),
    );
  });
});
