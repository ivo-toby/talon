import { z } from 'zod';

import { isBoundedWellFormedUtf8 } from '../contracts/common.js';

export const BEHAVIOR_REVIEW_OUTPUT_CONTRACT = 'talon.behavior.review.output.v1';
export const BEHAVIOR_REVIEW_PROPOSAL_CONTRACT = 'talon.behavior.review.proposal.v1';

const MAX_REVIEW_NOTES = 8;
const MAX_REVIEW_CONFLICTS = 8;
const MAX_REVIEW_TEXT_CHARS = 1_024;
const MAX_REVIEW_TEXT_BYTES = 4_096;

function boundedReviewText(value: string): boolean {
  return (
    value.indexOf('\0') === -1 &&
    value.trim() === value &&
    isBoundedWellFormedUtf8(value, MAX_REVIEW_TEXT_CHARS, MAX_REVIEW_TEXT_BYTES)
  );
}

const BehaviorReviewTextSchema = z
  .string()
  .min(1)
  .max(MAX_REVIEW_TEXT_CHARS)
  .refine(boundedReviewText, {
    message: 'behavior review text must be bounded and trimmed without NUL',
  });

export const BehaviorReviewOutputSchema = z
  .object({
    contract: z.literal(BEHAVIOR_REVIEW_OUTPUT_CONTRACT),
    decision: z.enum(['propose', 'skip', 'conflict']),
    rationale: BehaviorReviewTextSchema,
    notes: z.array(BehaviorReviewTextSchema).max(MAX_REVIEW_NOTES).default([]),
    conflicts: z.array(BehaviorReviewTextSchema).max(MAX_REVIEW_CONFLICTS).default([]),
  })
  .strict()
  .transform((value) =>
    Object.freeze({
      contract: value.contract,
      decision: value.decision,
      rationale: value.rationale,
      notes: Object.freeze([...value.notes]),
      conflicts: Object.freeze([...value.conflicts]),
    }),
  );

export type BehaviorReviewOutput = z.output<typeof BehaviorReviewOutputSchema>;
