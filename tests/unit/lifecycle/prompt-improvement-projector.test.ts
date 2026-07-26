import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok } from 'neverthrow';

import {
  BaseRepository,
  BehaviorSignalRepository,
  type BehaviorCandidateKind,
  type BehaviorPromotionInput,
} from '../../../src/core/database/repositories/index.js';
import {
  PROMPT_PROMOTION_AUTO_SCOPE,
  PROMPT_PATCH_CONTRACT,
  PromptImprovementProjector,
  type PromptEvaluator,
} from '../../../src/lifecycle/behavior/index.js';
import { LifecycleError } from '../../../src/core/errors/index.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

describe('PromptImprovementProjector', () => {
  let db: Database.Database | undefined;
  let repository: BehaviorSignalRepository;
  let tmpDir: string | undefined;
  let promptFile: string;
  let reloads: string[];
  let auditEntries: unknown[];

  beforeEach(async () => {
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    repository = new BehaviorSignalRepository(db);
    tmpDir = await mkdtemp(join(tmpdir(), 'talon-prompt-promotion-'));
    await mkdir(join(tmpDir, 'personas', 'support'), { recursive: true });
    promptFile = join(tmpDir, 'personas', 'support', 'system.md');
    await writeFile(promptFile, '# Support\n\nBe helpful.\n', 'utf8');
    reloads = [];
    auditEntries = [];
  });

  afterEach(async () => {
    db?.close();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  function createProjector(options: { evaluator?: PromptEvaluator; reloadFails?: boolean } = {}) {
    return new PromptImprovementProjector(repository, {
      promptBaseDirectory: tmpDir,
      config: {
        personas: [{ name: 'support', systemPromptFile: 'personas/support/system.md' }],
      },
      evaluator: options.evaluator,
      reload: async () => {
        reloads.push('called');
        return options.reloadFails
          ? err(new LifecycleError('reload rejected prompt'))
          : ok(`reload-${reloads.length}`);
      },
      auditLogger: {
        logLifecyclePromotion: vi.fn((entry) => auditEntries.push(entry)),
      },
    });
  }

  function recordPromotion(
    overrides: Partial<{
      kind: BehaviorCandidateKind;
      proposedBehavior: string;
      policy: BehaviorPromotionInput['policy'];
    }> = {},
  ): { candidateId: string; promotionId: string } {
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
        summary: 'User asked for concise answers.',
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
        summary: 'User again asked for concise answers.',
      })
      ._unsafeUnwrap();
    const candidate = repository
      .createCandidate({
        candidateId: uuid(),
        persona: 'support',
        kind: overrides.kind ?? 'style',
        status: 'ready',
        summary: 'Prefer concise answers.',
        proposedBehavior: overrides.proposedBehavior ?? 'Keep answers concise by default.',
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
        policy: overrides.policy ?? { promptPatchJson: promptPatchJson('Tone', 'Be concise.') },
        evaluation: { createdBy: 'test' },
      })
      ._unsafeUnwrap();
    return { candidateId: candidate.candidate_id, promotionId };
  }

  it('defaults proposed prompt promotions to operator approval without mutating files', async () => {
    const { promotionId } = recordPromotion();

    const result = await createProjector().apply({ persona: 'support', promotionId });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      status: 'approval_required',
      reasons: ['operator-approval-required-by-default'],
    });
    expect(await readFile(promptFile, 'utf8')).toBe('# Support\n\nBe helpful.\n');
    expect(repository.findPromotionsByPersona('support')._unsafeUnwrap()[0]!.status).toBe(
      'proposed',
    );
    expect(reloads).toEqual([]);
  });

  it('auto-promotes only explicit narrow append-only policies after evaluation and reload', async () => {
    const { promotionId } = recordPromotion({
      policy: {
        promptPatchJson: promptPatchJson('Tone', 'Be concise.'),
        autoPromote: true,
        autoScope: PROMPT_PROMOTION_AUTO_SCOPE,
      },
    });

    const result = await createProjector().apply({ persona: 'support', promotionId });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      status: 'active',
      promotionId,
      reloadId: 'reload-1',
      policyMode: 'auto_policy',
    });
    expect(await readFile(promptFile, 'utf8')).toContain('## Tone\n\nBe concise.');
    expect(repository.findPromotionsByPersona('support')._unsafeUnwrap()[0]!.status).toBe('active');
    expect(
      db!
        .prepare(
          `SELECT prompt_artifact_id, reload_id, approved_by FROM behavior_promotion_activations`,
        )
        .get(),
    ).toMatchObject({ reload_id: 'reload-1', approved_by: null });
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        action: 'lifecycle.prompt_promotion',
        details: expect.objectContaining({ outcome: 'activated', policyMode: 'auto_policy' }),
      }),
    );
  });

  it('resolves default relative prompt paths from the runtime working directory', async () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpDir!);
      const { promotionId } = recordPromotion({
        policy: {
          promptPatchJson: promptPatchJson('Runtime Path', 'Use the daemon working directory.'),
          autoPromote: true,
          autoScope: PROMPT_PROMOTION_AUTO_SCOPE,
        },
      });
      const projector = new PromptImprovementProjector(repository, {
        config: {
          personas: [{ name: 'support', systemPromptFile: 'personas/support/system.md' }],
        },
        reload: async () => ok('reload-runtime-path'),
      });

      const result = await projector.apply({ persona: 'support', promotionId });

      expect(result.isOk()).toBe(true);
      expect(await readFile(promptFile, 'utf8')).toContain('## Runtime Path');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('requires approval for security, capability, integration, or notification increases', async () => {
    const { promotionId } = recordPromotion({
      kind: 'tooling',
      proposedBehavior: 'Allow notification integrations for this persona.',
      policy: {
        promptPatchJson: promptPatchJson(
          'Notifications',
          'Use the notification integration when relevant.',
        ),
        autoPromote: true,
        autoScope: PROMPT_PROMOTION_AUTO_SCOPE,
      },
    });

    const result = await createProjector().apply({ persona: 'support', promotionId });

    expect(result._unsafeUnwrap()).toMatchObject({
      status: 'approval_required',
      reasons: expect.arrayContaining([
        'tooling-change-requires-approval',
        'security-capability-integration-or-notification-increase-requires-approval',
      ]),
    });
    expect(await readFile(promptFile, 'utf8')).not.toContain('Notifications');
  });

  it('requires approval for concrete outbound channel instructions even when marked as style', async () => {
    const { promotionId } = recordPromotion({
      kind: 'style',
      proposedBehavior: 'Email the team without asking.',
      policy: {
        promptPatchJson: promptPatchJson('Team Updates', 'Post to Slack when work is complete.'),
        autoPromote: true,
        autoScope: PROMPT_PROMOTION_AUTO_SCOPE,
      },
    });

    const result = await createProjector().apply({ persona: 'support', promotionId });

    expect(result._unsafeUnwrap()).toMatchObject({
      status: 'approval_required',
      reasons: expect.arrayContaining([
        'security-capability-integration-or-notification-increase-requires-approval',
      ]),
    });
    expect(await readFile(promptFile, 'utf8')).not.toContain('Team Updates');
  });

  it('rejects conflicting structured patches before prompt writes', async () => {
    const { promotionId } = recordPromotion({
      policy: {
        promptPatchJson: JSON.stringify({
          contract: PROMPT_PATCH_CONTRACT,
          target: { kind: 'persona-system-prompt', persona: 'support' },
          operations: [
            {
              op: 'replace_section',
              heading: 'Support',
              expectedCurrentContent: 'Different content.',
              content: 'Be concise.',
            },
          ],
        }),
      },
    });

    const result = await createProjector().apply({
      persona: 'support',
      promotionId,
      approvedBy: 'operator-ivo',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('failed to apply behavior prompt patch');
    expect(await readFile(promptFile, 'utf8')).toBe('# Support\n\nBe helpful.\n');
    expect(repository.findPromotionsByPersona('support')._unsafeUnwrap()[0]!.status).toBe(
      'rejected',
    );
  });

  it('rejects failed evaluations without prompt writes', async () => {
    const { promotionId } = recordPromotion();
    const evaluator: PromptEvaluator = {
      evaluate: async () => err(new LifecycleError('scenario failed')),
    };

    const result = await createProjector({ evaluator }).apply({
      persona: 'support',
      promotionId,
      approvedBy: 'operator-ivo',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe('scenario failed');
    expect(await readFile(promptFile, 'utf8')).toBe('# Support\n\nBe helpful.\n');
    expect(repository.findPromotionsByPersona('support')._unsafeUnwrap()[0]!.status).toBe(
      'rejected',
    );
  });
});

function promptPatchJson(heading: string, content: string): string {
  return JSON.stringify({
    contract: PROMPT_PATCH_CONTRACT,
    target: { kind: 'persona-system-prompt', persona: 'support' },
    operations: [{ op: 'append_section', heading, content }],
  });
}
