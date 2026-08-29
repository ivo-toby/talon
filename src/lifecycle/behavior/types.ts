import { z } from 'zod';
import {
  isBoundedUnicodeScalarsUtf8,
  isBoundedWellFormedUtf8,
  LifecycleDurablePersonaOwnerNameSchema,
  LifecycleIdentifierSchema,
  LifecycleRuntimeIdSchema,
} from '../contracts/common.js';

export const BehaviorEvidenceSourceKindSchema = z.enum([
  'message',
  'schedule',
  'run',
  'tool',
  'tool_call',
  'manual',
]);

export const BehaviorEvidenceSentimentSchema = z.enum(['positive', 'negative', 'neutral']);

export const BehaviorCandidateKindSchema = z.enum([
  'style',
  'preference',
  'safety',
  'tooling',
  'context',
]);

export const BehaviorCandidateStatusSchema = z.enum([
  'collecting',
  'ready',
  'proposed',
  'rejected',
  'expired',
]);

export const BehaviorPromotionStatusSchema = z.enum([
  'proposed',
  'evaluating',
  'approved',
  'activating',
  'active',
  'rolled_back',
  'reopened',
  'rejected',
  'expired',
]);

export const BehaviorTimestampSchema = z.string().refine((value) => {
  if (
    !isBoundedWellFormedUtf8(value, 64, 256) ||
    value.indexOf('\0') !== -1 ||
    value.trim() !== value
  ) {
    return false;
  }
  return new Date(value).toISOString() === value;
});

export const BehaviorSummarySchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.indexOf('\0') === -1 && isBoundedWellFormedUtf8(value, 4096, 16384));

export const BehaviorLineageReasonSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.indexOf('\0') === -1 && isBoundedWellFormedUtf8(value, 512, 2048));

export const BehaviorConfidenceSchema = z.number().min(0).max(1).finite();

export type BehaviorEvidenceSourceKind = z.infer<typeof BehaviorEvidenceSourceKindSchema>;
export type BehaviorEvidenceSentiment = z.infer<typeof BehaviorEvidenceSentimentSchema>;
export type BehaviorCandidateKind = z.infer<typeof BehaviorCandidateKindSchema>;
export type BehaviorCandidateStatus = z.infer<typeof BehaviorCandidateStatusSchema>;
export type BehaviorPromotionStatus = z.infer<typeof BehaviorPromotionStatusSchema>;

export function isBehaviorRuntimeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isBoundedWellFormedUtf8(value, 256, 1024) &&
    value.indexOf('\0') === -1 &&
    LifecycleRuntimeIdSchema.safeParse(value).success
  );
}

export function isBehaviorIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isBoundedWellFormedUtf8(value, 128, 512) &&
    value.indexOf('\0') === -1 &&
    LifecycleIdentifierSchema.safeParse(value).success
  );
}

export function isBehaviorPersona(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.indexOf('\0') === -1 &&
    isBoundedUnicodeScalarsUtf8(value, 256, 1024) &&
    LifecycleDurablePersonaOwnerNameSchema.safeParse(value).success
  );
}
