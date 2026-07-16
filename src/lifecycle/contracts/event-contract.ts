import { z } from 'zod';
import { types } from 'node:util';

import {
  LifecycleContractVersionSchema,
  LifecycleEventTypeSchema,
  LifecycleIdentifierSchema,
  LifecycleRuntimeIdSchema,
} from './common.js';

const MAX_LIFECYCLE_REFERENCES = 32;
const MAX_LIFECYCLE_METADATA_ENTRIES = 32;
const MAX_LIFECYCLE_METADATA_VALUE_LENGTH = 1_024;
export const MAX_LIFECYCLE_CONTENT_LENGTH = 16_384;

export const LifecycleReferenceSchema = z
  .object({
    type: LifecycleIdentifierSchema,
    id: LifecycleRuntimeIdSchema,
  })
  .strict();

const LifecycleBoundedScalarSchema = z.union([
  z.string().max(MAX_LIFECYCLE_METADATA_VALUE_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const LifecycleMetadataKeySchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim(), {
    message: 'lifecycle metadata keys must not have leading or trailing whitespace',
  });

function materializeLifecycleMetadata(
  value: unknown,
): Record<string, string | number | boolean | null> | undefined {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      return undefined;
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_LIFECYCLE_METADATA_ENTRIES) return undefined;
    const metadata = Object.create(null) as Record<string, string | number | boolean | null>;
    const normalized = new Set<string>();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !('value' in descriptor) ||
        !descriptor.enumerable ||
        normalized.has(key.normalize('NFKC'))
      ) {
        return undefined;
      }
      const parsed = LifecycleBoundedScalarSchema.safeParse(descriptor.value);
      if (!parsed.success || !LifecycleMetadataKeySchema.safeParse(key).success) return undefined;
      normalized.add(key.normalize('NFKC'));
      Object.defineProperty(metadata, key, {
        configurable: true,
        enumerable: true,
        value: parsed.data,
        writable: true,
      });
    }
    return metadata;
  } catch {
    return undefined;
  }
}

const LifecycleBoundedMetadataSchema = z.unknown().transform((value, context) => {
  const metadata = materializeLifecycleMetadata(value);
  if (metadata === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'lifecycle metadata must be bounded scalar data',
    });
    return z.NEVER;
  }
  return metadata;
});

/** Durable payloads intentionally contain references and scalar metadata only. */
export const LifecycleBoundedPayloadSchema = z
  .object({
    references: z.array(LifecycleReferenceSchema).max(MAX_LIFECYCLE_REFERENCES).default([]),
    metadata: LifecycleBoundedMetadataSchema.default({}),
  })
  .strict();

export const LifecycleProvenanceSchema = z
  .object({
    source: LifecycleIdentifierSchema,
    sourceEventIds: z.array(LifecycleRuntimeIdSchema).max(MAX_LIFECYCLE_REFERENCES).default([]),
    sourceReferences: z.array(LifecycleReferenceSchema).max(MAX_LIFECYCLE_REFERENCES).default([]),
  })
  .strict();

export const LifecycleAggregateIdentitySchema = z
  .object({
    type: LifecycleIdentifierSchema,
    id: LifecycleRuntimeIdSchema,
  })
  .strict();

export const LifecycleRecursionMetadataSchema = z
  .object({
    depth: z.number().int().min(0).max(16),
    maxDepth: z.number().int().min(1).max(16),
  })
  .strict()
  .refine((value) => value.depth <= value.maxDepth, {
    message: 'lifecycle recursion depth must not exceed maxDepth',
  });

export const LifecycleExecutionContextSchema = z
  .object({
    aggregate: LifecycleAggregateIdentitySchema,
    correlationId: LifecycleRuntimeIdSchema,
    causationId: LifecycleRuntimeIdSchema.optional(),
    recursion: LifecycleRecursionMetadataSchema,
    provenance: LifecycleProvenanceSchema,
  })
  .strict();

export const LifecycleEventContractSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    type: LifecycleEventTypeSchema,
  })
  .strict();

/** Versioned runtime event ready for persistence by TASK-002. */
export const LifecycleEventEnvelopeSchema = LifecycleEventContractSchema.extend({
  eventId: LifecycleRuntimeIdSchema,
  occurredAt: z.string().max(64).datetime({ offset: true }),
  context: LifecycleExecutionContextSchema,
  payload: LifecycleBoundedPayloadSchema,
}).strict();

export type LifecycleEventContract = z.infer<typeof LifecycleEventContractSchema>;
export type LifecycleReference = z.infer<typeof LifecycleReferenceSchema>;
export type LifecycleBoundedPayload = z.infer<typeof LifecycleBoundedPayloadSchema>;
export type LifecycleProvenance = z.infer<typeof LifecycleProvenanceSchema>;
export type LifecycleAggregateIdentity = z.infer<typeof LifecycleAggregateIdentitySchema>;
export type LifecycleRecursionMetadata = z.infer<typeof LifecycleRecursionMetadataSchema>;
export type LifecycleExecutionContext = z.infer<typeof LifecycleExecutionContextSchema>;
export type LifecycleEventEnvelope = z.infer<typeof LifecycleEventEnvelopeSchema>;
