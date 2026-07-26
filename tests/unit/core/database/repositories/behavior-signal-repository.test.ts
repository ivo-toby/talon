import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import {
  BaseRepository,
  BehaviorSignalRepository,
  type BehaviorCandidateInput,
  type BehaviorEvidenceInput,
  type BehaviorPromotionInput,
} from '../../../../../src/core/database/repositories/index.js';
import { createTestDb, uuid } from './helpers.js';

describe('BehaviorSignalRepository', () => {
  let db: Database.Database;
  let repository: BehaviorSignalRepository;

  beforeEach(() => {
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    repository = new BehaviorSignalRepository(db);
  });

  afterEach(() => db.close());

  function evidence(overrides: Partial<BehaviorEvidenceInput> = {}): BehaviorEvidenceInput {
    return {
      evidenceId: uuid(),
      persona: 'support',
      sourceKind: 'message',
      sourceId: uuid(),
      sourceOccurredAt: '2026-07-25T12:00:00.000Z',
      fingerprint: `fingerprint-${uuid()}`,
      sentiment: 'positive',
      confidence: 0.87,
      summary: 'User explicitly asked the assistant to keep responses concise.',
      metadata: { detector: 'test' },
      ...overrides,
    };
  }

  function candidate(overrides: Partial<BehaviorCandidateInput> = {}): BehaviorCandidateInput {
    return {
      candidateId: uuid(),
      persona: 'support',
      kind: 'style',
      status: 'collecting',
      summary: 'Prefer concise responses.',
      proposedBehavior: 'Keep answers concise unless detail is explicitly requested.',
      confidence: 0.72,
      createdFromEvidenceIds: [],
      ...overrides,
    };
  }

  function promotion(
    candidateId: string,
    overrides: Partial<BehaviorPromotionInput> = {},
  ): BehaviorPromotionInput {
    return {
      promotionId: uuid(),
      persona: 'support',
      candidateId,
      status: 'proposed',
      policy: { approval: 'operator' },
      evaluation: { dryRun: 'passed' },
      ...overrides,
    };
  }

  function recordDistinctEvidence(): [BehaviorEvidenceInput, BehaviorEvidenceInput] {
    const first = evidence({ evidenceId: uuid(), sourceId: uuid() });
    const second = evidence({ evidenceId: uuid(), sourceId: uuid() });
    expect(repository.recordEvidence(first).isOk()).toBe(true);
    expect(repository.recordEvidence(second).isOk()).toBe(true);
    return [first, second];
  }

  function createActivePromotion(
    ids: {
      candidateId: string;
      promotionId: string;
      activationId: string;
      promptArtifactId: string;
      reloadId: string;
    } = {
      candidateId: uuid(),
      promotionId: uuid(),
      activationId: uuid(),
      promptArtifactId: uuid(),
      reloadId: uuid(),
    },
  ): void {
    const [firstEvidence, secondEvidence] = recordDistinctEvidence();
    expect(
      repository
        .createCandidate(
          candidate({
            candidateId: ids.candidateId,
            status: 'ready',
            createdFromEvidenceIds: [firstEvidence.evidenceId, secondEvidence.evidenceId],
          }),
        )
        .isOk(),
    ).toBe(true);
    expect(
      repository
        .createPromotion(promotion(ids.candidateId, { promotionId: ids.promotionId }))
        .isOk(),
    ).toBe(true);
    for (const status of ['evaluating', 'approved', 'activating'] as const) {
      expect(repository.transitionPromotion('support', ids.promotionId, status).isOk()).toBe(
        true,
      );
    }
    expect(
      repository
        .activatePromotion({
          persona: 'support',
          promotionId: ids.promotionId,
          activationId: ids.activationId,
          promptArtifactId: ids.promptArtifactId,
          reloadId: ids.reloadId,
        })
        .isOk(),
    ).toBe(true);
  }

  it('suppresses schedule/direct copies by persona-scoped evidence fingerprint', () => {
    const direct = evidence({ sourceKind: 'message', fingerprint: 'copy-fingerprint' });
    const scheduleCopy = evidence({
      sourceKind: 'schedule',
      sourceId: uuid(),
      fingerprint: direct.fingerprint,
    });

    const inserted = repository.recordEvidence(direct);
    expect(inserted.isOk()).toBe(true);
    expect(repository.recordEvidence(scheduleCopy).isOk()).toBe(true);
    expect(repository.findEvidenceByPersona('support')._unsafeUnwrap()).toHaveLength(1);

    const otherPersonaCopy = repository.recordEvidence({
      ...scheduleCopy,
      evidenceId: uuid(),
      persona: 'coach',
    });
    expect(otherPersonaCopy.isOk()).toBe(true);
    expect(repository.findEvidenceByPersona('coach')._unsafeUnwrap()).toHaveLength(1);
  });

  it('requires distinct persona-local evidence sources before inferred promotion readiness', () => {
    const first = evidence({ evidenceId: 'evidence-a', sourceId: 'message-a' });
    const duplicateSource = evidence({
      evidenceId: 'evidence-b',
      sourceId: first.sourceId,
      fingerprint: 'different-fingerprint',
    });
    const second = evidence({ evidenceId: 'evidence-c', sourceId: 'message-c' });
    expect(repository.recordEvidence(first).isOk()).toBe(true);
    expect(repository.recordEvidence(duplicateSource).isOk()).toBe(true);
    expect(repository.recordEvidence(second).isOk()).toBe(true);

    const candidateId = uuid();
    expect(
      repository
        .createCandidate(
          candidate({
            candidateId,
            createdFromEvidenceIds: [first.evidenceId, duplicateSource.evidenceId],
          }),
        )
        .isErr(),
    ).toBe(true);
    expect(
      repository
        .createCandidate(
          candidate({
            candidateId,
            createdFromEvidenceIds: [first.evidenceId, second.evidenceId],
          }),
        )
        .isOk(),
    ).toBe(true);
    expect(repository.countDistinctEvidenceSources(candidateId)._unsafeUnwrap()).toBe(2);
  });

  it('rejects ready candidates without created evidence provenance', () => {
    expect(
      repository.createCandidate(
        candidate({
          status: 'ready',
          createdFromEvidenceIds: [],
        }),
      ).isErr(),
    ).toBe(true);
  });

  it('rejects direct SQL ready candidates without linked evidence provenance', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO behavior_candidates (
            candidate_id, persona, kind, status, summary, proposed_behavior, confidence,
            created_at, updated_at
          ) VALUES (
            'direct-ready-no-evidence', 'support', 'style', 'ready',
            'Direct SQL should not bypass evidence.',
            'Keep answers concise unless detail is explicitly requested.',
            0.7, 1, 1
          )`,
        )
        .run(),
    ).toThrow();
    expect(
      db
        .prepare(`SELECT candidate_id FROM behavior_candidates WHERE candidate_id = ?`)
        .get('direct-ready-no-evidence'),
    ).toBeUndefined();
  });

  it('rejects readiness transitions without persisted evidence provenance', () => {
    const candidateId = 'unproven-candidate';
    expect(repository.createCandidate(candidate({ candidateId })).isOk()).toBe(true);

    expect(repository.transitionCandidate('support', candidateId, 'ready').isErr()).toBe(true);
  });

  it('rejects promotions for collecting candidates without persisted readiness evidence', () => {
    const candidateId = 'collecting-no-evidence-candidate';
    expect(repository.createCandidate(candidate({ candidateId })).isOk()).toBe(true);

    expect(repository.createPromotion(promotion(candidateId)).isErr()).toBe(true);
    expect(repository.findPromotionsByPersona('support')._unsafeUnwrap()).toEqual([]);
  });

  it('constrains behavior candidate evidence links to the candidate persona', () => {
    const supportCandidate = candidate({ candidateId: 'support-candidate' });
    const coachEvidence = evidence({ persona: 'coach', evidenceId: 'coach-evidence' });
    expect(repository.createCandidate(supportCandidate).isOk()).toBe(true);
    expect(repository.recordEvidence(coachEvidence).isOk()).toBe(true);

    expect(() =>
      db
        .prepare(
          `INSERT INTO behavior_candidate_evidence (
            candidate_id, persona, evidence_id, created_at
          ) VALUES ('support-candidate', 'coach', 'coach-evidence', 1)`,
        )
        .run(),
    ).toThrow();
  });

  it('rejects direct SQL changes to accepted candidate evidence lineage', () => {
    createActivePromotion({
      candidateId: 'lineage-candidate',
      promotionId: 'lineage-promotion',
      activationId: 'lineage-activation',
      promptArtifactId: 'lineage-prompt',
      reloadId: 'lineage-reload',
    });
    const evidenceLinksBefore = db
      .prepare(
        `SELECT candidate_id, persona, evidence_id, created_at
         FROM behavior_candidate_evidence
         WHERE candidate_id = 'lineage-candidate'
         ORDER BY evidence_id ASC`,
      )
      .all();

    expect(() =>
      db
        .prepare(
          `UPDATE behavior_candidate_evidence
           SET created_at = created_at + 1
           WHERE candidate_id = 'lineage-candidate'`,
        )
        .run(),
    ).toThrow(/immutable/);
    expect(() =>
      db
        .prepare(
          `DELETE FROM behavior_candidate_evidence
           WHERE candidate_id = 'lineage-candidate'`,
        )
        .run(),
    ).toThrow(/append-only/);

    expect(
      db
        .prepare(
          `SELECT candidate_id, persona, evidence_id, created_at
           FROM behavior_candidate_evidence
           WHERE candidate_id = 'lineage-candidate'
           ORDER BY evidence_id ASC`,
        )
        .all(),
    ).toEqual(evidenceLinksBefore);
    expect(
      db
        .prepare(
          `SELECT c.status AS candidate_status, p.status AS promotion_status, COUNT(ce.evidence_id) AS evidence_count
           FROM behavior_candidates c
           JOIN behavior_promotions p
             ON p.persona = c.persona
            AND p.candidate_id = c.candidate_id
           JOIN behavior_candidate_evidence ce
             ON ce.persona = c.persona
            AND ce.candidate_id = c.candidate_id
           WHERE c.candidate_id = 'lineage-candidate'
           GROUP BY c.status, p.status`,
        )
        .get(),
    ).toEqual({ candidate_status: 'ready', promotion_status: 'active', evidence_count: 2 });
  });

  it('keeps candidates and transitions isolated by persona and legal status flow', () => {
    const [supportEvidenceA, supportEvidenceB] = recordDistinctEvidence();
    const supportCandidate = candidate({
      candidateId: 'support-candidate',
      createdFromEvidenceIds: [supportEvidenceA.evidenceId, supportEvidenceB.evidenceId],
    });
    const coachCandidate = candidate({
      candidateId: 'coach-candidate',
      persona: 'coach',
      summary: 'Prefer structured check-ins.',
    });
    expect(repository.createCandidate(supportCandidate).isOk()).toBe(true);
    expect(repository.createCandidate(coachCandidate).isOk()).toBe(true);

    expect(
      repository.transitionCandidate('support', supportCandidate.candidateId, 'ready').isOk(),
    ).toBe(true);
    expect(
      repository.transitionCandidate('support', supportCandidate.candidateId, 'active').isErr(),
    ).toBe(true);
    expect(
      repository.transitionCandidate('coach', supportCandidate.candidateId, 'ready').isErr(),
    ).toBe(true);

    expect(repository.findCandidatesByPersona('support')._unsafeUnwrap()).toMatchObject([
      { candidate_id: supportCandidate.candidateId, status: 'ready' },
    ]);
    expect(repository.findCandidatesByPersona('coach')._unsafeUnwrap()).toMatchObject([
      { candidate_id: coachCandidate.candidateId, status: 'collecting' },
    ]);
  });

  it('persists evaluation, activation, rollback lineage, expiry, and reopen transitions', () => {
    const [firstEvidence, secondEvidence] = recordDistinctEvidence();
    const candidateId = uuid();
    expect(
      repository
        .createCandidate(
          candidate({
            candidateId,
            status: 'ready',
            createdFromEvidenceIds: [firstEvidence.evidenceId, secondEvidence.evidenceId],
          }),
        )
        .isOk(),
    ).toBe(true);

    const createdPromotion = repository.createPromotion(promotion(candidateId));
    expect(createdPromotion.isOk()).toBe(true);
    const promotionId = createdPromotion._unsafeUnwrap().promotion_id;
    expect(repository.transitionPromotion('support', promotionId, 'evaluating').isOk()).toBe(true);
    expect(repository.transitionPromotion('support', promotionId, 'active').isErr()).toBe(true);
    expect(repository.transitionPromotion('support', promotionId, 'approved').isOk()).toBe(true);
    expect(repository.transitionPromotion('support', promotionId, 'activating').isOk()).toBe(true);
    expect(repository.transitionPromotion('support', promotionId, 'active').isErr()).toBe(true);
    expect(db.prepare(`SELECT activation_id FROM behavior_promotion_activations`).all()).toEqual(
      [],
    );
    expect(
      db.prepare(`SELECT status FROM behavior_promotions WHERE promotion_id = ?`).get(promotionId),
    ).toEqual({ status: 'activating' });
    expect(
      repository
        .activatePromotion({
          persona: 'support',
          promotionId,
          activationId: 'activation-1',
          promptArtifactId: 'prompt-artifact-1',
          reloadId: 'reload-1',
        })
        .isOk(),
    ).toBe(true);
    expect(
      db
        .prepare(
          `SELECT activation_id, activated_at FROM behavior_promotion_activations
           WHERE promotion_id = ?`,
        )
        .get(promotionId),
    ).toEqual({
      activation_id: 'activation-1',
      activated_at: db
        .prepare(`SELECT updated_at FROM behavior_promotions WHERE promotion_id = ?`)
        .get(promotionId)
        ?.updated_at,
    });
    expect(repository.transitionPromotion('support', promotionId, 'rolled_back').isErr()).toBe(
      true,
    );
    expect(db.prepare(`SELECT rollback_id FROM behavior_promotion_rollbacks`).all()).toEqual([]);
    expect(
      repository
        .rollbackActivation({
          persona: 'support',
          activationId: 'activation-1',
          rollbackId: 'rollback-1',
          reason: 'operator-rejected',
        })
        .isOk(),
    ).toBe(true);
    expect(repository.transitionPromotion('support', promotionId, 'reopened').isOk()).toBe(true);
    expect(repository.transitionPromotion('support', promotionId, 'approved').isErr()).toBe(true);
    expect(repository.expireCandidate('support', candidateId).isOk()).toBe(true);

    expect(repository.findPromotionsByPersona('support')._unsafeUnwrap()).toMatchObject([
      { promotion_id: promotionId, status: 'reopened' },
    ]);
    expect(
      db.prepare(`SELECT status FROM behavior_candidates WHERE candidate_id = ?`).get(candidateId),
    ).toEqual({
      status: 'expired',
    });
    expect(
      db.prepare(`SELECT rollback_id, reason FROM behavior_promotion_rollbacks`).all(),
    ).toEqual([{ rollback_id: 'rollback-1', reason: 'operator-rejected' }]);
  });

  it('emits bounded audit and metric evidence for behavior promotion mutations', () => {
    const auditLogger = { logLifecyclePromotion: vi.fn() };
    const metrics = { increment: vi.fn() };
    repository = new BehaviorSignalRepository(db, { auditLogger, metrics });
    const [firstEvidence, secondEvidence] = recordDistinctEvidence();
    const candidateId = uuid();
    expect(
      repository
        .createCandidate(
          candidate({
            candidateId,
            status: 'ready',
            createdFromEvidenceIds: [firstEvidence.evidenceId, secondEvidence.evidenceId],
          }),
        )
        .isOk(),
    ).toBe(true);

    const promotionId = uuid();
    expect(
      repository
        .createPromotion(
          promotion(candidateId, {
            promotionId,
            policy: { approval: 'operator' },
            evaluation: { dryRun: 'passed' },
          }),
        )
        .isOk(),
    ).toBe(true);
    expect(repository.transitionPromotion('support', promotionId, 'evaluating').isOk()).toBe(true);
    expect(repository.transitionPromotion('support', promotionId, 'approved').isOk()).toBe(true);
    expect(repository.transitionPromotion('support', promotionId, 'activating').isOk()).toBe(true);
    expect(
      repository
        .activatePromotion({
          persona: 'support',
          promotionId,
          activationId: 'activation-audit',
          promptArtifactId: 'prompt-artifact-audit',
          reloadId: 'reload-audit',
        })
        .isOk(),
    ).toBe(true);
    expect(
      repository
        .rollbackActivation({
          persona: 'support',
          activationId: 'activation-audit',
          rollbackId: 'rollback-audit',
          reason: 'operator-rejected',
        })
        .isOk(),
    ).toBe(true);

    const metricOperations = metrics.increment.mock.calls.map(([, labels]) => labels?.operation);
    expect(metricOperations).toEqual(
      expect.arrayContaining(['create', 'transition', 'activate', 'rollback']),
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'lifecycle.behavior.promotion.count',
      expect.objectContaining({
        operation: 'rollback',
        outcome: 'success',
        status: 'rolled_back',
        persona: 'support',
      }),
    );

    const auditDetails = auditLogger.logLifecyclePromotion.mock.calls.map(([entry]) => entry.details);
    expect(auditDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'create', promotionId, candidateId }),
        expect.objectContaining({
          operation: 'activate',
          promotionId,
          activationId: 'activation-audit',
          promptArtifactId: 'prompt-artifact-audit',
          reloadId: 'reload-audit',
        }),
        expect.objectContaining({
          operation: 'rollback',
          promotionId,
          rollbackId: 'rollback-audit',
          reason: 'operator-rejected',
        }),
      ]),
    );
    expect(JSON.stringify(auditDetails)).not.toContain('dryRun');
    expect(JSON.stringify(auditDetails)).not.toContain('approval');
  });

  it('rejects direct SQL changes to activation and rollback provenance rows', () => {
    createActivePromotion({
      candidateId: 'immutable-candidate',
      promotionId: 'immutable-promotion',
      activationId: 'immutable-activation',
      promptArtifactId: 'immutable-prompt',
      reloadId: 'immutable-reload',
    });
    const activationBefore = db
      .prepare(
        `SELECT activation_id, persona, promotion_id, prompt_artifact_id, reload_id, activated_at
         FROM behavior_promotion_activations
         WHERE activation_id = 'immutable-activation'`,
      )
      .get() as Record<string, unknown>;

    expect(() =>
      db
        .prepare(
          `UPDATE behavior_promotion_activations
           SET reload_id = 'immutable-reload-mutated', activated_at = activated_at + 1
           WHERE activation_id = 'immutable-activation'`,
        )
        .run(),
    ).toThrow(/immutable/);
    expect(
      db
        .prepare(
          `SELECT activation_id, persona, promotion_id, prompt_artifact_id, reload_id, activated_at
           FROM behavior_promotion_activations
           WHERE activation_id = 'immutable-activation'`,
        )
        .get(),
    ).toEqual(activationBefore);
    expect(() =>
      db
        .prepare(
          `DELETE FROM behavior_promotion_activations
           WHERE activation_id = 'immutable-activation'`,
        )
        .run(),
    ).toThrow(/append-only/);
    expect(
      db
        .prepare(
          `SELECT p.status AS promotion_status, a.activation_id, a.persona, a.promotion_id,
                  a.prompt_artifact_id, a.reload_id, a.activated_at
           FROM behavior_promotions p
           JOIN behavior_promotion_activations a
             ON a.persona = p.persona
            AND a.promotion_id = p.promotion_id
           WHERE a.activation_id = 'immutable-activation'`,
        )
        .get(),
    ).toEqual({ promotion_status: 'active', ...activationBefore });

    expect(
      repository
        .rollbackActivation({
          persona: 'support',
          activationId: 'immutable-activation',
          rollbackId: 'immutable-rollback',
          reason: 'operator-rejected',
        })
        .isOk(),
    ).toBe(true);
    const rollbackBefore = db
      .prepare(
        `SELECT rollback_id, persona, activation_id, promotion_id, reason, rolled_back_at
         FROM behavior_promotion_rollbacks
         WHERE rollback_id = 'immutable-rollback'`,
      )
      .get() as Record<string, unknown>;

    expect(() =>
      db
        .prepare(
          `UPDATE behavior_promotion_rollbacks
           SET reason = 'operator-corrected', rolled_back_at = rolled_back_at + 1
           WHERE rollback_id = 'immutable-rollback'`,
        )
        .run(),
    ).toThrow(/immutable/);
    expect(
      db
        .prepare(
          `SELECT rollback_id, persona, activation_id, promotion_id, reason, rolled_back_at
           FROM behavior_promotion_rollbacks
           WHERE rollback_id = 'immutable-rollback'`,
        )
        .get(),
    ).toEqual(rollbackBefore);
    expect(() =>
      db
        .prepare(
          `DELETE FROM behavior_promotion_rollbacks
           WHERE rollback_id = 'immutable-rollback'`,
        )
        .run(),
    ).toThrow(/append-only/);
    expect(
      db
        .prepare(
          `SELECT p.status AS promotion_status, r.rollback_id, r.persona, r.activation_id,
                  r.promotion_id, r.reason, r.rolled_back_at
           FROM behavior_promotions p
           JOIN behavior_promotion_rollbacks r
             ON r.persona = p.persona
            AND r.promotion_id = p.promotion_id
           WHERE r.rollback_id = 'immutable-rollback'`,
        )
        .get(),
    ).toEqual({ promotion_status: 'rolled_back', ...rollbackBefore });
  });

  it('rolls back rollback provenance when promotion update does not affect an active row', () => {
    createActivePromotion({
      candidateId: 'rollback-atomic-candidate',
      promotionId: 'rollback-atomic-promotion',
      activationId: 'rollback-atomic-activation',
      promptArtifactId: 'rollback-atomic-prompt',
      reloadId: 'rollback-atomic-reload',
    });
    db.prepare(`DROP TRIGGER behavior_promotions_guard_transitions`).run();
    db.prepare(
      `UPDATE behavior_promotions
       SET status = 'reopened', updated_at = updated_at + 1
       WHERE promotion_id = 'rollback-atomic-promotion'`,
    ).run();
    db.prepare(`DROP TRIGGER behavior_promotion_rollbacks_guard_active_lineage`).run();

    const result = repository.rollbackActivation({
      persona: 'support',
      activationId: 'rollback-atomic-activation',
      rollbackId: 'rollback-atomic-second',
      reason: 'operator-rejected',
    });

    expect(result.isErr()).toBe(true);
    expect(
      db
        .prepare(
          `SELECT rollback_id FROM behavior_promotion_rollbacks
           WHERE rollback_id = 'rollback-atomic-second'`,
        )
        .get(),
    ).toBeUndefined();
  });

  it('rejects rollback rows unless the referenced activation promotion is active', () => {
    const [firstEvidence, secondEvidence] = recordDistinctEvidence();
    const candidateId = 'rollback-active-candidate';
    expect(
      repository
        .createCandidate(
          candidate({
            candidateId,
            status: 'ready',
            createdFromEvidenceIds: [firstEvidence.evidenceId, secondEvidence.evidenceId],
          }),
        )
        .isOk(),
    ).toBe(true);
    expect(
      repository
        .createPromotion(promotion(candidateId, { promotionId: 'rollback-active-promotion' }))
        .isOk(),
    ).toBe(true);
    for (const status of ['evaluating', 'approved', 'activating'] as const) {
      expect(repository.transitionPromotion('support', 'rollback-active-promotion', status).isOk())
        .toBe(true);
    }
    db.prepare(
      `INSERT INTO behavior_promotion_activations (
        activation_id, persona, promotion_id, prompt_artifact_id, reload_id, activated_at
      ) VALUES (
        'rollback-active-activation', 'support', 'rollback-active-promotion',
        'rollback-active-prompt', 'rollback-active-reload', 1
      )`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO behavior_promotion_rollbacks (
            rollback_id, persona, activation_id, promotion_id, reason, rolled_back_at
          ) VALUES (
            'rollback-inactive-direct', 'support', 'rollback-active-activation',
            'rollback-active-promotion', 'operator-rejected', 2
          )`,
        )
        .run(),
    ).toThrow();
    expect(
      db
        .prepare(
          `SELECT rollback_id FROM behavior_promotion_rollbacks
           WHERE rollback_id = 'rollback-inactive-direct'`,
        )
        .get(),
    ).toBeUndefined();

    expect(
      repository
        .activatePromotion({
          persona: 'support',
          promotionId: 'rollback-active-promotion',
          activationId: 'rollback-active-second-activation',
          promptArtifactId: 'rollback-active-second-prompt',
          reloadId: 'rollback-active-second-reload',
        })
        .isOk(),
    ).toBe(true);
    const activePromotion = db
      .prepare(
        `SELECT updated_at FROM behavior_promotions
         WHERE promotion_id = 'rollback-active-promotion'`,
      )
      .get() as { updated_at: number };
    const rollbackAt = activePromotion.updated_at + 1;

    expect(() =>
      db
        .prepare(
          `INSERT INTO behavior_promotion_rollbacks (
            rollback_id, persona, activation_id, promotion_id, reason, rolled_back_at
          ) VALUES (
            'rollback-active-direct', 'support', 'rollback-active-activation',
            'rollback-active-promotion', 'operator-rejected', ?
          )`,
        )
        .run(rollbackAt),
    ).not.toThrow();
    expect(
      db
        .prepare(
          `SELECT rollback_id FROM behavior_promotion_rollbacks
           WHERE rollback_id = 'rollback-active-direct'`,
        )
        .get(),
    ).toEqual({ rollback_id: 'rollback-active-direct' });
  });

  it('rejects rollback rows after the referenced activation promotion is rolled back', () => {
    const [firstEvidence, secondEvidence] = recordDistinctEvidence();
    const candidateId = 'rollback-after-candidate';
    expect(
      repository
        .createCandidate(
          candidate({
            candidateId,
            status: 'ready',
            createdFromEvidenceIds: [firstEvidence.evidenceId, secondEvidence.evidenceId],
          }),
        )
        .isOk(),
    ).toBe(true);
    expect(
      repository
        .createPromotion(promotion(candidateId, { promotionId: 'rollback-after-promotion' }))
        .isOk(),
    ).toBe(true);
    for (const status of ['evaluating', 'approved', 'activating'] as const) {
      expect(repository.transitionPromotion('support', 'rollback-after-promotion', status).isOk())
        .toBe(true);
    }
    const activatingPromotion = db
      .prepare(
        `SELECT updated_at FROM behavior_promotions
         WHERE promotion_id = 'rollback-after-promotion'`,
      )
      .get() as { updated_at: number };
    const activeAt = activatingPromotion.updated_at + 1;
    db.prepare(
      `INSERT INTO behavior_promotion_activations (
        activation_id, persona, promotion_id, prompt_artifact_id, reload_id, activated_at
      ) VALUES (
        'rollback-after-activation-a', 'support', 'rollback-after-promotion',
        'rollback-after-prompt-a', 'rollback-after-reload-a', ?
      )`,
    ).run(activeAt);
    db.prepare(
      `INSERT INTO behavior_promotion_activations (
        activation_id, persona, promotion_id, prompt_artifact_id, reload_id, activated_at
      ) VALUES (
        'rollback-after-activation-b', 'support', 'rollback-after-promotion',
        'rollback-after-prompt-b', 'rollback-after-reload-b', ?
      )`,
    ).run(activeAt);
    db.prepare(
      `UPDATE behavior_promotions
       SET status = 'active', updated_at = ?
       WHERE promotion_id = 'rollback-after-promotion'`,
    ).run(activeAt);
    const activePromotion = db
      .prepare(
        `SELECT updated_at FROM behavior_promotions
         WHERE promotion_id = 'rollback-after-promotion'`,
      )
      .get() as { updated_at: number };
    const rollbackAt = activePromotion.updated_at + 1;

    expect(() =>
      db
        .prepare(
          `INSERT INTO behavior_promotion_rollbacks (
            rollback_id, persona, activation_id, promotion_id, reason, rolled_back_at
          ) VALUES (
            'rollback-after-direct', 'support', 'rollback-after-activation-a',
            'rollback-after-promotion', 'operator-rejected', ?
          )`,
        )
        .run(rollbackAt),
    ).not.toThrow();
    expect(
      db
        .prepare(
          `SELECT rollback_id FROM behavior_promotion_rollbacks
           WHERE rollback_id = 'rollback-after-direct'`,
        )
        .get(),
    ).toEqual({ rollback_id: 'rollback-after-direct' });
    expect(
      db
        .prepare(
          `UPDATE behavior_promotions
           SET status = 'rolled_back', updated_at = ?
           WHERE promotion_id = 'rollback-after-promotion'`,
        )
        .run(rollbackAt).changes,
    ).toBe(1);

    expect(() =>
      db
        .prepare(
          `INSERT INTO behavior_promotion_rollbacks (
            rollback_id, persona, activation_id, promotion_id, reason, rolled_back_at
          ) VALUES (
            'rollback-inactive-direct', 'support', 'rollback-after-activation-b',
            'rollback-after-promotion', 'operator-rejected', 2
          )`,
        )
        .run(),
    ).toThrow();
    expect(
      db
        .prepare(
          `SELECT rollback_id FROM behavior_promotion_rollbacks
           WHERE rollback_id = 'rollback-inactive-direct'`,
        )
        .get(),
    ).toBeUndefined();
  });

  it('rejects rollback rows that cross-link an activation to a different promotion', () => {
    const [firstEvidenceA, firstEvidenceB] = recordDistinctEvidence();
    const firstCandidateId = 'rollback-lineage-candidate-a';
    expect(
      repository
        .createCandidate(
          candidate({
            candidateId: firstCandidateId,
            status: 'ready',
            createdFromEvidenceIds: [firstEvidenceA.evidenceId, firstEvidenceB.evidenceId],
          }),
        )
        .isOk(),
    ).toBe(true);
    const firstPromotionId = repository
      .createPromotion(promotion(firstCandidateId, { promotionId: 'rollback-lineage-promotion-a' }))
      ._unsafeUnwrap().promotion_id;
    expect(repository.transitionPromotion('support', firstPromotionId, 'evaluating').isOk()).toBe(
      true,
    );
    expect(repository.transitionPromotion('support', firstPromotionId, 'approved').isOk()).toBe(
      true,
    );
    expect(repository.transitionPromotion('support', firstPromotionId, 'activating').isOk()).toBe(
      true,
    );
    expect(
      repository
        .activatePromotion({
          persona: 'support',
          promotionId: firstPromotionId,
          activationId: 'rollback-lineage-activation-a',
          promptArtifactId: 'rollback-lineage-prompt-a',
          reloadId: 'rollback-lineage-reload-a',
        })
        .isOk(),
    ).toBe(true);

    const [secondEvidenceA, secondEvidenceB] = recordDistinctEvidence();
    const secondCandidateId = 'rollback-lineage-candidate-b';
    expect(
      repository
        .createCandidate(
          candidate({
            candidateId: secondCandidateId,
            status: 'ready',
            createdFromEvidenceIds: [secondEvidenceA.evidenceId, secondEvidenceB.evidenceId],
          }),
        )
        .isOk(),
    ).toBe(true);
    const secondPromotionId = repository
      .createPromotion(
        promotion(secondCandidateId, { promotionId: 'rollback-lineage-promotion-b' }),
      )
      ._unsafeUnwrap().promotion_id;

    expect(() =>
      db
        .prepare(
          `INSERT INTO behavior_promotion_rollbacks (
            rollback_id, persona, activation_id, promotion_id, reason, rolled_back_at
          ) VALUES (
            'rollback-lineage-mismatch', 'support', 'rollback-lineage-activation-a',
            ?, 'operator-rejected', 1
          )`,
        )
        .run(secondPromotionId),
    ).toThrow();
    expect(
      db
        .prepare(
          `SELECT rollback_id FROM behavior_promotion_rollbacks
           WHERE rollback_id = 'rollback-lineage-mismatch'`,
        )
        .get(),
    ).toBeUndefined();
  });

  it('seeds the monotonic write clock from persisted behavior ledger timestamps', () => {
    const futureTs = Date.now() + 60_000;
    db.prepare(
      `INSERT INTO behavior_candidates (
        candidate_id, persona, kind, status, summary, proposed_behavior, confidence,
        created_at, updated_at
      ) VALUES (
        'future-candidate', 'support', 'style', 'collecting',
        'Future timestamp fixture.', 'Prefer concise responses.', 0.5, ?, ?
      )`,
    ).run(futureTs, futureTs);

    BaseRepository.__resetMonotonicClockForTests();
    BaseRepository.seedMonotonicClockFromDb(db);
    const afterRestart = new BehaviorSignalRepository(db);

    const transitioned = afterRestart.transitionCandidate('support', 'future-candidate', 'rejected');
    expect(transitioned.isOk()).toBe(true);
    expect(transitioned._unsafeUnwrap().updated_at).toBeGreaterThan(futureTs);
  });
});
