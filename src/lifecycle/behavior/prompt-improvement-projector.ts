import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { err, ok, type Result } from 'neverthrow';

import { LifecycleError } from '../../core/errors/index.js';
import type {
  BehaviorPromotionActivationRow,
  BehaviorCandidateRow,
  BehaviorPromotionRow,
} from '../../core/database/repositories/index.js';
import type { AuditLogger } from '../../core/logging/audit-logger.js';
import type { TalondConfig } from '../../core/config/config-types.js';
import {
  BoundedPromptEvaluator,
  type PromptEvaluator,
  type PromptEvaluationResult,
} from './prompt-evaluator.js';
import {
  decidePromptPromotion,
  parsePromptPatchJson,
  type PromptPatch,
  type PromptPatchOperation,
} from './promotion-policy.js';
import { BehaviorLineageReasonSchema, isBehaviorIdentifier } from './types.js';

export interface PromptPromotionApplyInput {
  readonly persona: string;
  readonly promotionId: string;
  readonly approvedBy?: string;
}

export interface PromptPromotionRollbackInput {
  readonly persona: string;
  readonly activationId: string;
  readonly reason: string;
}

export type PromptPromotionApplyResult =
  | {
      readonly status: 'approval_required';
      readonly promotionId: string;
      readonly reasons: readonly string[];
    }
  | {
      readonly status: 'active';
      readonly promotionId: string;
      readonly activationId: string;
      readonly promptArtifactId: string;
      readonly reloadId: string;
      readonly evaluation: PromptEvaluationResult;
      readonly policyMode: 'operator_approved' | 'auto_policy';
    };

export interface PromptPromotionRollbackResult {
  readonly status: 'rolled_back';
  readonly activationId: string;
  readonly rollbackId: string;
  readonly reloadId: string;
}

interface PromptPromotionRepository {
  findPromotionsByPersona(persona: string): Result<BehaviorPromotionRow[], Error>;
  findCandidatesByPersona(persona: string): Result<BehaviorCandidateRow[], Error>;
  findActiveActivationsByPersona(persona: string): Result<BehaviorPromotionActivationRow[], Error>;
  transitionPromotion(
    persona: string,
    promotionId: string,
    status: 'evaluating' | 'approved' | 'activating' | 'rejected',
  ): Result<BehaviorPromotionRow, Error>;
  activatePromotion(input: {
    readonly persona: string;
    readonly promotionId: string;
    readonly activationId: string;
    readonly promptArtifactId: string;
    readonly reloadId: string;
    readonly approvedBy?: string | null;
  }): Result<BehaviorPromotionRow, Error>;
  rollbackActivation(input: {
    readonly persona: string;
    readonly activationId: string;
    readonly rollbackId: string;
    readonly reason: string;
  }): Result<BehaviorPromotionRow, Error>;
}

interface PromptPromotionFileSystem {
  readFile(path: string): Promise<string>;
  writeAtomic(path: string, content: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
}

export interface PromptImprovementProjectorOptions {
  readonly config: TalondConfig | Pick<TalondConfig, 'personas'>;
  readonly promptBaseDirectory?: string;
  readonly evaluator?: PromptEvaluator;
  readonly reload?: () => Promise<Result<string, LifecycleError>>;
  readonly fileSystem?: PromptPromotionFileSystem;
  readonly auditLogger?: Pick<AuditLogger, 'logLifecyclePromotion'>;
}

interface LoadedPromotion {
  readonly promotion: BehaviorPromotionRow;
  readonly candidate: BehaviorCandidateRow;
  readonly policy: Record<string, string | number | boolean | null>;
  readonly patch: PromptPatch;
}

const DEFAULT_RELOAD_ID = 'reload-not-configured';

export class PromptImprovementProjector {
  private static readonly promptMutationLocks = new Map<string, Promise<void>>();

  private readonly evaluator: PromptEvaluator;
  private readonly fileSystem: PromptPromotionFileSystem;

  constructor(
    private readonly repository: PromptPromotionRepository,
    private readonly options: PromptImprovementProjectorOptions,
  ) {
    this.evaluator = options.evaluator ?? new BoundedPromptEvaluator();
    this.fileSystem = options.fileSystem ?? nodeFileSystem();
  }

  async apply(
    input: PromptPromotionApplyInput,
  ): Promise<Result<PromptPromotionApplyResult, LifecycleError>> {
    return await this.withPromptMutationLock(input.persona, () => this.applyLocked(input));
  }

  private async applyLocked(
    input: PromptPromotionApplyInput,
  ): Promise<Result<PromptPromotionApplyResult, LifecycleError>> {
    const loaded = this.loadPromotion(input.persona, input.promotionId);
    if (loaded.isErr()) return err(loaded.error);

    const decision = decidePromptPromotion({
      persona: input.persona,
      promotionId: input.promotionId,
      candidateKind: loaded.value.candidate.kind,
      proposedBehavior: loaded.value.candidate.proposed_behavior,
      policy: loaded.value.policy,
      patch: loaded.value.patch,
      approvedBy: input.approvedBy,
    });
    if (decision.isErr()) return err(decision.error);
    if (decision.value.outcome === 'approval_required') {
      this.audit(input.persona, input.promotionId, 'approval_required', {
        reasons: decision.value.reasons.join(','),
      });
      return ok({
        status: 'approval_required',
        promotionId: input.promotionId,
        reasons: decision.value.reasons,
      });
    }
    if (decision.value.outcome === 'rejected') {
      this.reject(input.persona, input.promotionId, decision.value.reasons.join(','));
      return err(
        new LifecycleError(
          `behavior prompt promotion rejected: ${decision.value.reasons.join(', ')}`,
        ),
      );
    }

    const promptPath = this.resolvePromptPath(input.persona);
    if (promptPath.isErr()) return err(promptPath.error);

    const evaluating = this.repository.transitionPromotion(
      input.persona,
      input.promotionId,
      'evaluating',
    );
    if (evaluating.isErr()) {
      return err(
        toLifecycleError('failed to mark behavior prompt promotion evaluating', evaluating.error),
      );
    }

    let currentPrompt: string;
    let nextPrompt: string;
    try {
      currentPrompt = await this.fileSystem.readFile(promptPath.value);
      nextPrompt = applyPromptPatch(currentPrompt, loaded.value.patch);
    } catch (cause) {
      this.reject(input.persona, input.promotionId, 'prompt-patch-failed');
      return err(toLifecycleError('failed to apply behavior prompt patch', cause));
    }

    const evaluation = await this.evaluator.evaluate({
      persona: input.persona,
      promotionId: input.promotionId,
      candidate: loaded.value.candidate,
      patch: loaded.value.patch,
      currentPrompt,
      nextPrompt,
    });
    if (evaluation.isErr() || !evaluation.value.passed) {
      this.reject(input.persona, input.promotionId, 'prompt-evaluation-failed');
      return err(
        evaluation.isErr()
          ? evaluation.error
          : new LifecycleError('behavior prompt evaluation failed'),
      );
    }
    this.audit(input.persona, input.promotionId, 'evaluation_passed', {
      evaluator: evaluation.value.evaluator,
      score: evaluation.value.score,
      promptSha256: evaluation.value.promptSha256,
    });

    const approved = this.repository.transitionPromotion(
      input.persona,
      input.promotionId,
      'approved',
    );
    if (approved.isErr()) {
      this.reject(input.persona, input.promotionId, 'approval-transition-failed');
      return err(toLifecycleError('failed to approve behavior prompt promotion', approved.error));
    }
    const activating = this.repository.transitionPromotion(
      input.persona,
      input.promotionId,
      'activating',
    );
    if (activating.isErr()) {
      this.reject(input.persona, input.promotionId, 'activation-transition-failed');
      return err(
        toLifecycleError('failed to mark behavior prompt promotion activating', activating.error),
      );
    }

    const activationId = promptPromotionId(
      'activation',
      input.persona,
      input.promotionId,
      nextPrompt,
    );
    const promptArtifactId = promptPromotionId(
      'prompt-artifact',
      input.persona,
      input.promotionId,
      evaluation.value.promptSha256,
    );
    const backupPath = promotionBackupPath(promptPath.value, activationId);
    let wrotePrompt = false;
    try {
      await this.fileSystem.copyFile(promptPath.value, backupPath);
      await this.fileSystem.writeAtomic(promptPath.value, nextPrompt);
      wrotePrompt = true;
      const reloadId = await this.reloadAndVerify(input.persona);
      const activated = this.repository.activatePromotion({
        persona: input.persona,
        promotionId: input.promotionId,
        activationId,
        promptArtifactId,
        reloadId,
        approvedBy: input.approvedBy ?? null,
      });
      if (activated.isErr()) {
        throw activated.error;
      }
      this.audit(input.persona, input.promotionId, 'activated', {
        activationId,
        promptArtifactId,
        reloadId,
        policyMode: decision.value.mode,
        approvedBy: input.approvedBy ?? null,
      });
      return ok({
        status: 'active',
        promotionId: input.promotionId,
        activationId,
        promptArtifactId,
        reloadId,
        evaluation: evaluation.value,
        policyMode: decision.value.mode,
      });
    } catch (cause) {
      if (wrotePrompt) {
        await this.restorePrompt(input.persona, input.promotionId, promptPath.value, backupPath);
      }
      this.reject(input.persona, input.promotionId, 'activation-failed');
      return err(toLifecycleError('failed to activate behavior prompt promotion', cause));
    }
  }

  async rollback(
    input: PromptPromotionRollbackInput,
  ): Promise<Result<PromptPromotionRollbackResult, LifecycleError>> {
    return await this.withPromptMutationLock(input.persona, () => this.rollbackLocked(input));
  }

  private async rollbackLocked(
    input: PromptPromotionRollbackInput,
  ): Promise<Result<PromptPromotionRollbackResult, LifecycleError>> {
    if (
      !BehaviorLineageReasonSchema.safeParse(input.reason).success ||
      !isBehaviorIdentifier(input.reason)
    ) {
      return err(new LifecycleError('invalid behavior prompt rollback reason'));
    }
    const promptPath = this.resolvePromptPath(input.persona);
    if (promptPath.isErr()) return err(promptPath.error);
    const latestActivation = this.latestActiveActivation(input.persona);
    if (latestActivation.isErr()) return err(latestActivation.error);
    if (latestActivation.value.activation_id !== input.activationId) {
      return err(new LifecycleError('behavior prompt rollback requires latest active activation'));
    }
    const backupPath = promotionBackupPath(promptPath.value, input.activationId);
    const rollbackId = promptPromotionId(
      'rollback',
      input.persona,
      input.activationId,
      input.reason,
    );
    let activePrompt: string | null = null;
    let wroteRollbackPrompt = false;
    try {
      const previousPrompt = await this.fileSystem.readFile(backupPath);
      activePrompt = await this.fileSystem.readFile(promptPath.value);
      await this.fileSystem.writeAtomic(promptPath.value, previousPrompt);
      wroteRollbackPrompt = true;
      const reloadId = await this.reloadAndVerify(input.persona);
      const rolledBack = this.repository.rollbackActivation({
        persona: input.persona,
        activationId: input.activationId,
        rollbackId,
        reason: input.reason,
      });
      if (rolledBack.isErr()) {
        throw rolledBack.error;
      }
      this.audit(input.persona, rolledBack.value.promotion_id, 'rolled_back', {
        activationId: input.activationId,
        rollbackId,
        reloadId,
        reason: input.reason,
      });
      return ok({ status: 'rolled_back', activationId: input.activationId, rollbackId, reloadId });
    } catch (cause) {
      if (wroteRollbackPrompt && activePrompt !== null) {
        await this.restorePromptContent(
          input.persona,
          input.activationId,
          promptPath.value,
          activePrompt,
          'rollback_restored_after_failure',
        );
      }
      return err(toLifecycleError('failed to rollback behavior prompt promotion', cause));
    }
  }

  private async withPromptMutationLock<T>(
    persona: string,
    operation: () => Promise<Result<T, LifecycleError>>,
  ): Promise<Result<T, LifecycleError>> {
    // Daemon IPC handlers construct a projector per operator command, so this
    // lock is intentionally process-wide rather than instance-local.
    const previous =
      PromptImprovementProjector.promptMutationLocks.get(persona) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolveCurrent) => {
      releaseCurrent = resolveCurrent;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    PromptImprovementProjector.promptMutationLocks.set(persona, queued);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (PromptImprovementProjector.promptMutationLocks.get(persona) === queued) {
        PromptImprovementProjector.promptMutationLocks.delete(persona);
      }
    }
  }

  private loadPromotion(
    persona: string,
    promotionId: string,
  ): Result<LoadedPromotion, LifecycleError> {
    const promotions = this.repository.findPromotionsByPersona(persona);
    if (promotions.isErr()) {
      return err(toLifecycleError('failed to find behavior prompt promotions', promotions.error));
    }
    const promotion = promotions.value.find((row) => row.promotion_id === promotionId);
    if (!promotion || promotion.status !== 'proposed') {
      return err(new LifecycleError('behavior prompt promotion is not proposed'));
    }
    const candidates = this.repository.findCandidatesByPersona(persona);
    if (candidates.isErr()) {
      return err(toLifecycleError('failed to find behavior prompt candidates', candidates.error));
    }
    const candidate = candidates.value.find((row) => row.candidate_id === promotion.candidate_id);
    if (!candidate) return err(new LifecycleError('behavior prompt promotion candidate missing'));
    const policy = parsePolicyMetadata(promotion.policy);
    if (policy.isErr()) return err(policy.error);
    if (typeof policy.value.promptPatchJson !== 'string') {
      return err(
        new LifecycleError(
          'behavior prompt promotion has no prompt patch; only prompt-patch-backed promotions can be applied',
        ),
      );
    }
    const patch = parsePromptPatchJson(persona, policy.value.promptPatchJson);
    if (patch.isErr()) return err(patch.error);
    return ok({ promotion, candidate, policy: policy.value, patch: patch.value });
  }

  private resolvePromptPath(personaName: string): Result<string, LifecycleError> {
    const persona = this.options.config.personas.find((item) => item.name === personaName);
    if (!persona?.systemPromptFile) {
      return err(
        new LifecycleError('behavior prompt promotion requires persona systemPromptFile ownership'),
      );
    }
    return ok(resolve(this.options.promptBaseDirectory ?? process.cwd(), persona.systemPromptFile));
  }

  private latestActiveActivation(
    persona: string,
  ): Result<BehaviorPromotionActivationRow, LifecycleError> {
    const activations = this.repository.findActiveActivationsByPersona(persona);
    if (activations.isErr()) {
      return err(
        toLifecycleError('failed to find active behavior prompt activations', activations.error),
      );
    }
    const [latest] = activations.value;
    if (!latest)
      return err(new LifecycleError('behavior prompt rollback requires active activation'));
    return ok(latest);
  }

  private async reloadAndVerify(persona: string): Promise<string> {
    const reload = await (this.options.reload?.() ?? Promise.resolve(ok(DEFAULT_RELOAD_ID)));
    if (reload.isErr()) throw reload.error;
    const loaded = this.options.config.personas.find((item) => item.name === persona);
    if (!loaded) throw new LifecycleError('behavior prompt reload lost persona ownership');
    return reload.value;
  }

  private async restorePrompt(
    persona: string,
    promotionId: string,
    promptPath: string,
    backupPath: string,
  ): Promise<void> {
    try {
      const original = await this.fileSystem.readFile(backupPath);
      await this.restorePromptContent(
        persona,
        promotionId,
        promptPath,
        original,
        'restored_after_failure',
      );
    } catch {
      this.audit(persona, promotionId, 'restore_failed', {});
    }
  }

  private async restorePromptContent(
    persona: string,
    promotionId: string,
    promptPath: string,
    content: string,
    outcome: string,
  ): Promise<void> {
    try {
      await this.fileSystem.writeAtomic(promptPath, content);
      const reload = await (this.options.reload?.() ?? Promise.resolve(ok(DEFAULT_RELOAD_ID)));
      if (reload.isErr()) throw reload.error;
      this.audit(persona, promotionId, outcome, {});
    } catch {
      this.audit(persona, promotionId, 'restore_failed', {});
    }
  }

  private reject(persona: string, promotionId: string, reason: string): void {
    const rejected = this.repository.transitionPromotion(persona, promotionId, 'rejected');
    this.audit(persona, promotionId, 'rejected', {
      reason,
      transitionRecorded: rejected.isOk(),
    });
  }

  private audit(
    persona: string,
    promotionId: string,
    outcome: string,
    details: Record<string, string | number | boolean | null>,
  ): void {
    try {
      this.options.auditLogger?.logLifecyclePromotion({
        action: 'lifecycle.prompt_promotion',
        personaId: persona,
        details: {
          promotionId,
          outcome,
          ...details,
        },
      });
    } catch {
      // Audit is advisory; repository and filesystem transitions are authoritative.
    }
  }
}

export function applyPromptPatch(currentPrompt: string, patch: PromptPatch): string {
  let next = currentPrompt.trimEnd();
  for (const operation of patch.operations) {
    next = applyPromptPatchOperation(next, operation);
  }
  return `${next.trimEnd()}\n`;
}

function applyPromptPatchOperation(currentPrompt: string, operation: PromptPatchOperation): string {
  switch (operation.op) {
    case 'append_section':
      if (findMarkdownSection(currentPrompt, operation.heading)) {
        throw new LifecycleError('prompt patch append section already exists');
      }
      return `${currentPrompt.trimEnd()}\n\n## ${operation.heading}\n\n${operation.content}\n`;
    case 'replace_section': {
      const section = findMarkdownSection(currentPrompt, operation.heading);
      if (!section) throw new LifecycleError('prompt patch replace section missing');
      const currentContent = currentPrompt.slice(section.contentStart, section.contentEnd).trim();
      if (currentContent !== operation.expectedCurrentContent) {
        throw new LifecycleError('prompt patch replace section conflict');
      }
      return `${currentPrompt.slice(0, section.contentStart).trimEnd()}\n\n${operation.content}\n${currentPrompt.slice(section.contentEnd).trimStart()}`;
    }
  }
}

function findMarkdownSection(
  prompt: string,
  heading: string,
): { contentStart: number; contentEnd: number } | null {
  const lines = prompt.split(/(\n)/);
  let offset = 0;
  let matchedHeadingEnd: number | null = null;
  let matchedLevel = 0;
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index] ?? '';
    const newline = lines[index + 1] ?? '';
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) {
      const [, hashes, title] = match;
      const level = hashes.length;
      if (matchedHeadingEnd !== null && level <= matchedLevel) {
        return { contentStart: matchedHeadingEnd, contentEnd: offset };
      }
      if (title === heading) {
        matchedHeadingEnd = offset + line.length + newline.length;
        matchedLevel = level;
      }
    }
    offset += line.length + newline.length;
  }
  return matchedHeadingEnd === null
    ? null
    : { contentStart: matchedHeadingEnd, contentEnd: prompt.length };
}

function parsePolicyMetadata(
  raw: string,
): Result<Record<string, string | number | boolean | null>, LifecycleError> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return err(new LifecycleError('behavior promotion policy metadata must be an object'));
    }
    return ok(parsed as Record<string, string | number | boolean | null>);
  } catch {
    return err(new LifecycleError('behavior promotion policy metadata is not valid JSON'));
  }
}

function nodeFileSystem(): PromptPromotionFileSystem {
  return {
    async readFile(path: string): Promise<string> {
      return await readFile(path, 'utf8');
    },
    async copyFile(from: string, to: string): Promise<void> {
      await writeFile(to, await readFile(from, 'utf8'), { encoding: 'utf8', flag: 'wx' });
    },
    async writeAtomic(path: string, content: string): Promise<void> {
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' });
      await rename(tmp, path);
    },
  };
}

function promotionBackupPath(promptPath: string, activationId: string): string {
  return `${promptPath}.talon-${activationId}.bak`;
}

function promptPromotionId(kind: string, persona: string, id: string, content: string): string {
  return `${kind}-${createHash('sha256')
    .update('talon.behavior.prompt-promotion.v1\0', 'utf8')
    .update(JSON.stringify({ kind, persona, id, content }), 'utf8')
    .digest('base64url')
    .slice(0, 32)}`;
}

function toLifecycleError(message: string, cause: unknown): LifecycleError {
  return new LifecycleError(message, cause instanceof Error ? cause : undefined);
}
