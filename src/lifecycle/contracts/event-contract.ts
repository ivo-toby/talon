import { z } from 'zod';

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

const LifecycleBoundedMetadataSchema = z
  .record(LifecycleMetadataKeySchema, LifecycleBoundedScalarSchema)
  .refine((metadata) => Object.keys(metadata).length <= MAX_LIFECYCLE_METADATA_ENTRIES, {
    message: `lifecycle metadata may contain at most ${MAX_LIFECYCLE_METADATA_ENTRIES} entries`,
  })
  .refine(
    (metadata) => {
      const normalizedKeys = Object.keys(metadata).map((key) => key.normalize('NFKC'));
      return new Set(normalizedKeys).size === normalizedKeys.length;
    },
    {
      message: 'lifecycle metadata keys must not collide after Unicode normalization',
    },
  );

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
