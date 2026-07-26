import { z } from 'zod';
import { err, ok, type Result } from 'neverthrow';

import { LifecycleError } from '../../core/errors/index.js';
import { isBoundedWellFormedUtf8 } from '../contracts/common.js';
import {
  BehaviorCandidateKindSchema,
  isBehaviorPersona,
  isBehaviorRuntimeId,
  type BehaviorCandidateKind,
} from './types.js';

export const PROMPT_PATCH_CONTRACT = 'talon.behavior.prompt_patch.v1';
export const PROMPT_PROMOTION_AUTO_SCOPE = 'persona-system-prompt-append-only';

const MAX_PROMPT_PATCH_OPERATIONS = 4;
const MAX_PROMPT_TEXT_CHARS = 2_048;
const MAX_PROMPT_TEXT_BYTES = 8_192;
const MAX_HEADING_CHARS = 96;

function boundedPromptText(value: string): boolean {
  return (
    value.indexOf('\0') === -1 &&
    value.trim() === value &&
    isBoundedWellFormedUtf8(value, MAX_PROMPT_TEXT_CHARS, MAX_PROMPT_TEXT_BYTES)
  );
}

function boundedHeading(value: string): boolean {
  return (
    value.indexOf('\0') === -1 &&
    value.trim() === value &&
    !value.includes('\n') &&
    isBoundedWellFormedUtf8(value, MAX_HEADING_CHARS, MAX_HEADING_CHARS * 4)
  );
}

const PromptPatchTextSchema = z
  .string()
  .min(1)
  .max(MAX_PROMPT_TEXT_CHARS)
  .refine(boundedPromptText);

const PromptPatchHeadingSchema = z.string().min(1).max(MAX_HEADING_CHARS).refine(boundedHeading);

export const PromptPatchOperationSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('append_section'),
      heading: PromptPatchHeadingSchema,
      content: PromptPatchTextSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal('replace_section'),
      heading: PromptPatchHeadingSchema,
      expectedCurrentContent: PromptPatchTextSchema,
      content: PromptPatchTextSchema,
    })
    .strict(),
]);

export const PromptPatchSchema = z
  .object({
    contract: z.literal(PROMPT_PATCH_CONTRACT),
    target: z
      .object({
        kind: z.literal('persona-system-prompt'),
        persona: z.string().refine(isBehaviorPersona),
      })
      .strict(),
    operations: z.array(PromptPatchOperationSchema).min(1).max(MAX_PROMPT_PATCH_OPERATIONS),
  })
  .strict();

export type PromptPatch = z.infer<typeof PromptPatchSchema>;
export type PromptPatchOperation = z.infer<typeof PromptPatchOperationSchema>;

export type PromptPromotionDecision =
  | {
      readonly outcome: 'allowed';
      readonly mode: 'operator_approved' | 'auto_policy';
      readonly reasons: readonly string[];
    }
  | {
      readonly outcome: 'approval_required';
      readonly reasons: readonly string[];
    }
  | {
      readonly outcome: 'rejected';
      readonly reasons: readonly string[];
    };

export interface PromptPromotionPolicyInput {
  readonly persona: string;
  readonly promotionId: string;
  readonly candidateKind: BehaviorCandidateKind;
  readonly proposedBehavior: string;
  readonly policy: Record<string, string | number | boolean | null>;
  readonly patch: PromptPatch;
  readonly approvedBy?: string;
}

const AUTHORITY_INCREASE_PATTERN =
  /\b(capabilit(?:y|ies)|permission|approval|requireApproval|allow list|integration|notification|notify|send message|webhook|mcp|tool access|credential|secret|token|email|e-mail|mail|slack|discord|telegram|whatsapp|teams|sms|post(?:ing)?|publish|dm|direct message|alert|web hook)\b/i;

export function parsePromptPatchJson(
  persona: string,
  raw: unknown,
): Result<PromptPatch, LifecycleError> {
  if (typeof raw !== 'string' || raw.length > 16_384 || raw.indexOf('\0') !== -1) {
    return err(new LifecycleError('behavior promotion prompt patch must be bounded JSON text'));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err(new LifecycleError('behavior promotion prompt patch is not valid JSON'));
  }
  const patch = PromptPatchSchema.safeParse(parsed);
  if (!patch.success || patch.data.target.persona !== persona) {
    return err(new LifecycleError('behavior promotion prompt patch does not match persona target'));
  }
  return ok({ ...patch.data, operations: [...patch.data.operations] });
}

export function decidePromptPromotion(
  input: PromptPromotionPolicyInput,
): Result<PromptPromotionDecision, LifecycleError> {
  if (
    !isBehaviorPersona(input.persona) ||
    !isBehaviorRuntimeId(input.promotionId) ||
    !BehaviorCandidateKindSchema.safeParse(input.candidateKind).success
  ) {
    return err(new LifecycleError('invalid prompt promotion policy request'));
  }

  const authorityReasons = authorityIncreaseReasons(input);
  if (authorityReasons.length > 0 && !input.approvedBy) {
    return ok({ outcome: 'approval_required', reasons: authorityReasons });
  }

  if (input.approvedBy) {
    if (!isBehaviorRuntimeId(input.approvedBy)) {
      return err(new LifecycleError('invalid prompt promotion approver identity'));
    }
    return ok({
      outcome: 'allowed',
      mode: 'operator_approved',
      reasons: authorityReasons.length > 0 ? authorityReasons : ['operator-approved'],
    });
  }

  if (isExplicitNarrowAutoPolicy(input)) {
    return ok({
      outcome: 'allowed',
      mode: 'auto_policy',
      reasons: ['explicit-narrow-auto-policy'],
    });
  }

  return ok({
    outcome: 'approval_required',
    reasons: ['operator-approval-required-by-default'],
  });
}

function isExplicitNarrowAutoPolicy(input: PromptPromotionPolicyInput): boolean {
  return (
    input.policy.autoPromote === true &&
    input.policy.autoScope === PROMPT_PROMOTION_AUTO_SCOPE &&
    (input.candidateKind === 'style' ||
      input.candidateKind === 'preference' ||
      input.candidateKind === 'context') &&
    input.patch.operations.length === 1 &&
    input.patch.operations.every((operation) => operation.op === 'append_section') &&
    authorityIncreaseReasons(input).length === 0
  );
}

function authorityIncreaseReasons(input: PromptPromotionPolicyInput): string[] {
  const reasons: string[] = [];
  if (input.candidateKind === 'safety' || input.candidateKind === 'tooling') {
    reasons.push(`${input.candidateKind}-change-requires-approval`);
  }
  const searchable = [
    input.proposedBehavior,
    ...input.patch.operations.flatMap((operation) => [operation.heading, operation.content]),
  ].join('\n');
  if (AUTHORITY_INCREASE_PATTERN.test(searchable)) {
    reasons.push('security-capability-integration-or-notification-increase-requires-approval');
  }
  return [...new Set(reasons)];
}
