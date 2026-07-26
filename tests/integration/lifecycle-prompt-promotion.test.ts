import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok } from 'neverthrow';

import {
  BaseRepository,
  BehaviorSignalRepository,
} from '../../src/core/database/repositories/index.js';
import {
  PROMPT_PROMOTION_AUTO_SCOPE,
  PROMPT_PATCH_CONTRACT,
  PromptImprovementProjector,
  type PromptImprovementProjectorOptions,
} from '../../src/lifecycle/behavior/index.js';
import { LifecycleError } from '../../src/core/errors/index.js';
import { createTestDb, uuid } from '../unit/core/database/repositories/helpers.js';

describe('lifecycle prompt promotion integration', () => {
  let db: Database.Database | undefined;
  let repository: BehaviorSignalRepository;
  let tmpDir: string | undefined;
  let promptFile: string;

  beforeEach(async () => {
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    repository = new BehaviorSignalRepository(db);
    tmpDir = await mkdtemp(join(tmpdir(), 'talon-lifecycle-prompt-promotion-'));
    await mkdir(join(tmpDir, 'personas', 'support'), { recursive: true });
    promptFile = join(tmpDir, 'personas', 'support', 'system.md');
    await writeFile(promptFile, '# Support\n\nBe helpful.\n', 'utf8');
  });

  afterEach(async () => {
    db?.close();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('restores the original prompt and rejects the promotion when reload verification fails', async () => {
    const promotionId = createPromotion('Reload Guard', 'This should not remain active.');
    const projector = createProjector(async () => err(new LifecycleError('reload failed')));

    const result = await projector.apply({
      persona: 'support',
      promotionId,
      approvedBy: 'operator-ivo',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain(
      'failed to activate behavior prompt promotion',
    );
    expect(await readFile(promptFile, 'utf8')).toBe('# Support\n\nBe helpful.\n');
    expect(repository.findPromotionsByPersona('support')._unsafeUnwrap()[0]!.status).toBe(
      'rejected',
    );
    expect(db!.prepare(`SELECT activation_id FROM behavior_promotion_activations`).all()).toEqual(
      [],
    );
  });

  it('rolls back an active prompt promotion using the saved pre-activation version', async () => {
    const promotionId = createPromotion('Tone', 'Be concise.');
    const projector = createProjector(async () => ok('reload-ok'));
    const applied = await projector.apply({
      persona: 'support',
      promotionId,
      approvedBy: 'operator-ivo',
    });
    expect(applied.isOk()).toBe(true);
    expect(await readFile(promptFile, 'utf8')).toContain('## Tone\n\nBe concise.');

    const activationId =
      applied._unsafeUnwrap().status === 'active' ? applied._unsafeUnwrap().activationId : '';
    const rolledBack = await projector.rollback({
      persona: 'support',
      activationId,
      reason: 'operator-rejected',
    });

    expect(rolledBack.isOk()).toBe(true);
    expect(await readFile(promptFile, 'utf8')).toBe('# Support\n\nBe helpful.\n');
    expect(repository.findPromotionsByPersona('support')._unsafeUnwrap()[0]!.status).toBe(
      'rolled_back',
    );
    expect(db!.prepare(`SELECT approved_by FROM behavior_promotion_activations`).get()).toEqual({
      approved_by: 'operator-ivo',
    });
    expect(
      db!.prepare(`SELECT rollback_id, reason FROM behavior_promotion_rollbacks`).all(),
    ).toEqual([
      { rollback_id: rolledBack._unsafeUnwrap().rollbackId, reason: 'operator-rejected' },
    ]);
  });

  it('rejects rollback of an older activation without erasing later active prompt changes', async () => {
    const firstPromotionId = createPromotion('Tone', 'Be concise.');
    const secondPromotionId = createPromotion('Format', 'Use bullets.');
    const projector = createProjector(async () => ok('reload-ok'));
    const firstApplied = await projector.apply({
      persona: 'support',
      promotionId: firstPromotionId,
      approvedBy: 'operator-ivo',
    });
    expect(firstApplied.isOk()).toBe(true);
    const secondApplied = await projector.apply({
      persona: 'support',
      promotionId: secondPromotionId,
      approvedBy: 'operator-ivo',
    });
    expect(secondApplied.isOk()).toBe(true);
    const activePrompt = await readFile(promptFile, 'utf8');

    const rolledBack = await projector.rollback({
      persona: 'support',
      activationId:
        firstApplied._unsafeUnwrap().status === 'active'
          ? firstApplied._unsafeUnwrap().activationId
          : '',
      reason: 'operator-rejected',
    });

    expect(rolledBack.isErr()).toBe(true);
    expect(rolledBack._unsafeUnwrapErr().message).toBe(
      'behavior prompt rollback requires latest active activation',
    );
    expect(await readFile(promptFile, 'utf8')).toBe(activePrompt);
    expect(repository.findPromotionsByPersona('support')._unsafeUnwrap()).toMatchObject([
      { promotion_id: firstPromotionId, status: 'active' },
      { promotion_id: secondPromotionId, status: 'active' },
    ]);
    expect(db!.prepare(`SELECT rollback_id FROM behavior_promotion_rollbacks`).all()).toEqual([]);
  });

  it('rejects malformed rollback reasons before mutating the active prompt', async () => {
    const promotionId = createPromotion('Tone', 'Be concise.');
    const projector = createProjector(async () => ok('reload-ok'));
    const applied = await projector.apply({
      persona: 'support',
      promotionId,
      approvedBy: 'operator-ivo',
    });
    expect(applied.isOk()).toBe(true);
    const activePrompt = await readFile(promptFile, 'utf8');

    const rolledBack = await projector.rollback({
      persona: 'support',
      activationId:
        applied._unsafeUnwrap().status === 'active' ? applied._unsafeUnwrap().activationId : '',
      reason: 'operator rejected',
    });

    expect(rolledBack.isErr()).toBe(true);
    expect(rolledBack._unsafeUnwrapErr().message).toBe('invalid behavior prompt rollback reason');
    expect(await readFile(promptFile, 'utf8')).toBe(activePrompt);
    expect(repository.findPromotionsByPersona('support')._unsafeUnwrap()[0]!.status).toBe('active');
    expect(db!.prepare(`SELECT rollback_id FROM behavior_promotion_rollbacks`).all()).toEqual([]);
  });

  it('rejects rollback before file mutation when the activation is no longer active', async () => {
    const promotionId = createPromotion('Tone', 'Be concise.');
    const projector = createProjector(async () => ok('reload-ok'));
    const applied = await projector.apply({
      persona: 'support',
      promotionId,
      approvedBy: 'operator-ivo',
    });
    expect(applied.isOk()).toBe(true);
    const activePrompt = await readFile(promptFile, 'utf8');
    db!.prepare(`DROP TRIGGER behavior_promotions_guard_transitions`).run();
    db!
      .prepare(
        `UPDATE behavior_promotions
       SET status = 'reopened', updated_at = updated_at + 1
       WHERE promotion_id = ?`,
      )
      .run(promotionId);

    const rolledBack = await projector.rollback({
      persona: 'support',
      activationId:
        applied._unsafeUnwrap().status === 'active' ? applied._unsafeUnwrap().activationId : '',
      reason: 'operator-rejected',
    });

    expect(rolledBack.isErr()).toBe(true);
    expect(rolledBack._unsafeUnwrapErr().message).toBe(
      'behavior prompt rollback requires active activation',
    );
    expect(await readFile(promptFile, 'utf8')).toBe(activePrompt);
    expect(repository.findPromotionsByPersona('support')._unsafeUnwrap()[0]!.status).toBe(
      'reopened',
    );
    expect(db!.prepare(`SELECT rollback_id FROM behavior_promotion_rollbacks`).all()).toEqual([]);
  });

  it('serializes concurrent prompt promotions for the same persona across projector instances', async () => {
    const firstPromotionId = createPromotion('Tone', 'Be concise.');
    const secondPromotionId = createPromotion('Format', 'Use bullets.');
    let activePromptReads = 0;
    let maxActivePromptReads = 0;
    const projectorOptions: Partial<PromptImprovementProjectorOptions> = {
      fileSystem: {
        async readFile(path): Promise<string> {
          if (path === promptFile) {
            activePromptReads += 1;
            maxActivePromptReads = Math.max(maxActivePromptReads, activePromptReads);
            try {
              await delay(20);
              return await readFile(path, 'utf8');
            } finally {
              activePromptReads -= 1;
            }
          }
          return await readFile(path, 'utf8');
        },
        async copyFile(from, to): Promise<void> {
          await writeFile(to, await readFile(from, 'utf8'), { encoding: 'utf8', flag: 'wx' });
        },
        async writeAtomic(path, content): Promise<void> {
          await writeFile(path, content, 'utf8');
        },
      },
    };
    const firstProjector = createProjector(async () => ok('reload-ok'), projectorOptions);
    const secondProjector = createProjector(async () => ok('reload-ok'), projectorOptions);

    const [firstApplied, secondApplied] = await Promise.all([
      firstProjector.apply({
        persona: 'support',
        promotionId: firstPromotionId,
        approvedBy: 'operator-ivo',
      }),
      secondProjector.apply({
        persona: 'support',
        promotionId: secondPromotionId,
        approvedBy: 'operator-ivo',
      }),
    ]);

    expect(firstApplied.isOk()).toBe(true);
    expect(secondApplied.isOk()).toBe(true);
    expect(maxActivePromptReads).toBe(1);
    const prompt = await readFile(promptFile, 'utf8');
    expect(prompt).toContain('## Tone\n\nBe concise.');
    expect(prompt).toContain('## Format\n\nUse bullets.');
    expect(
      db!.prepare(`SELECT activation_id FROM behavior_promotion_activations`).all(),
    ).toHaveLength(2);
  });

  function createProjector(
    reload: () => Promise<ReturnType<typeof ok> | ReturnType<typeof err>>,
    overrides: Partial<PromptImprovementProjectorOptions> = {},
  ) {
    return new PromptImprovementProjector(repository, {
      promptBaseDirectory: tmpDir,
      config: {
        personas: [{ name: 'support', systemPromptFile: 'personas/support/system.md' }],
      },
      reload: reload as () => Promise<any>,
      ...overrides,
    });
  }

  async function delay(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function createPromotion(heading: string, content: string): string {
    const firstEvidence = repository
      .recordEvidence({
        evidenceId: uuid(),
        persona: 'support',
        sourceKind: 'message',
        sourceId: uuid(),
        sourceOccurredAt: '2026-07-26T10:00:00.000Z',
        fingerprint: `fingerprint-${uuid()}`,
        sentiment: 'positive',
        confidence: 0.88,
        summary: 'User asked for prompt behavior.',
      })
      ._unsafeUnwrap();
    const secondEvidence = repository
      .recordEvidence({
        evidenceId: uuid(),
        persona: 'support',
        sourceKind: 'message',
        sourceId: uuid(),
        sourceOccurredAt: '2026-07-26T11:00:00.000Z',
        fingerprint: `fingerprint-${uuid()}`,
        sentiment: 'positive',
        confidence: 0.9,
        summary: 'User repeated prompt behavior.',
      })
      ._unsafeUnwrap();
    const candidate = repository
      .createCandidate({
        candidateId: uuid(),
        persona: 'support',
        kind: 'style',
        status: 'ready',
        summary: 'Prompt update.',
        proposedBehavior: content,
        confidence: 0.86,
        createdFromEvidenceIds: [firstEvidence.evidence_id, secondEvidence.evidence_id],
      })
      ._unsafeUnwrap();
    const promotionId = uuid();
    repository
      .createPromotion({
        promotionId,
        persona: 'support',
        candidateId: candidate.candidate_id,
        policy: {
          promptPatchJson: JSON.stringify({
            contract: PROMPT_PATCH_CONTRACT,
            target: { kind: 'persona-system-prompt', persona: 'support' },
            operations: [{ op: 'append_section', heading, content }],
          }),
          autoPromote: true,
          autoScope: PROMPT_PROMOTION_AUTO_SCOPE,
        },
        evaluation: { createdBy: 'integration-test' },
      })
      ._unsafeUnwrap();
    return promotionId;
  }
});
