import { createHash } from 'node:crypto';
import { err, ok, type Result } from 'neverthrow';

import { LifecycleError } from '../../core/errors/index.js';
import { isBoundedWellFormedUtf8 } from '../contracts/common.js';
import type { BehaviorCandidateRow } from '../../core/database/repositories/index.js';
import type { PromptPatch } from './promotion-policy.js';

export interface PromptEvaluationInput {
  readonly persona: string;
  readonly promotionId: string;
  readonly candidate: BehaviorCandidateRow;
  readonly patch: PromptPatch;
  readonly currentPrompt: string;
  readonly nextPrompt: string;
}

export interface PromptEvaluationResult {
  readonly passed: boolean;
  readonly evaluator: string;
  readonly score: number;
  readonly checks: readonly string[];
  readonly promptSha256: string;
}

export interface PromptEvaluator {
  evaluate(input: PromptEvaluationInput): Promise<Result<PromptEvaluationResult, LifecycleError>>;
}

export class BoundedPromptEvaluator implements PromptEvaluator {
  evaluate(input: PromptEvaluationInput): Promise<Result<PromptEvaluationResult, LifecycleError>> {
    if (
      input.nextPrompt === input.currentPrompt ||
      input.nextPrompt.indexOf('\0') !== -1 ||
      !isBoundedWellFormedUtf8(input.nextPrompt, 65_536, 262_144)
    ) {
      return Promise.resolve(
        err(new LifecycleError('behavior prompt evaluation failed bounded prompt checks')),
      );
    }
    const checks = [
      'prompt-changed',
      'bounded-utf8',
      'structured-patch',
      `operations-${input.patch.operations.length}`,
    ];
    return Promise.resolve(
      ok({
        passed: true,
        evaluator: 'native-bounded-prompt-evaluator',
        score: Math.min(1, Math.max(0.5, input.candidate.confidence)),
        checks,
        promptSha256: createHash('sha256').update(input.nextPrompt, 'utf8').digest('hex'),
      }),
    );
  }
}
