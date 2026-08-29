import { z } from 'zod';
import { types } from 'node:util';

import {
  LifecycleContractVersionSchema,
  LifecycleDisplayNameSchema,
  LifecycleFilterOwnerNameSchema,
  LifecycleIdentifierSchema,
  LifecycleRuntimeIdSchema,
  LifecycleRuntimeNameSchema,
} from './common.js';
import {
  LifecycleExecutionContextSchema,
  LifecycleMetadataKeySchema,
  MAX_LIFECYCLE_CONTENT_LENGTH,
} from './event-contract.js';
import { LifecycleSignalEnvelopeSchema } from './signal-contract.js';

export const LifecycleInterceptorHookSchema = z.enum([
  'message.before_persist',
  'run.before_execute',
  'tool.before_execute',
  'message.before_send',
]);

export const LifecycleInterceptorContractSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    hook: LifecycleInterceptorHookSchema,
  })
  .strict();

const LifecycleContentSchema = z.string().max(MAX_LIFECYCLE_CONTENT_LENGTH);

const MAX_LIFECYCLE_INTERCEPTOR_JSON_DEPTH = 6;
const MAX_LIFECYCLE_INTERCEPTOR_JSON_COLLECTION_SIZE = 32;
const MAX_LIFECYCLE_INTERCEPTOR_JSON_NODES = 256;
const MAX_LIFECYCLE_INTERCEPTOR_JSON_STRING_LENGTH = 4_096;
const MAX_LIFECYCLE_INTERCEPTOR_JSON_BYTES = 32_768;

type LifecycleBoundedJson =
  | string
  | number
  | boolean
  | null
  | LifecycleBoundedJson[]
  | { [key: string]: LifecycleBoundedJson };

type LifecycleBoundedJsonObject = { [key: string]: LifecycleBoundedJson };

function isPlainJsonObject(value: object): boolean {
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Materialize hostile tool/context values before schema composition. The input
 * is never read through ordinary property access: descriptors are inspected
 * iteratively, then copied into a detached null-prototype JSON snapshot.
 */
function materializeBoundedInterceptorJsonObject(
  value: unknown,
): LifecycleBoundedJsonObject | undefined {
  try {
    // `types.isProxy` is intentionally the first operation on every object
    // container. Array/prototype/descriptor reflection can execute Proxy
    // traps, while this native predicate does not.
    if (
      !value ||
      typeof value !== 'object' ||
      types.isProxy(value) ||
      Array.isArray(value) ||
      !isPlainJsonObject(value)
    ) {
      return undefined;
    }

    const seen = new WeakSet<object>();
    const stack: Array<{
      value: unknown;
      depth: number;
      assign: (materialized: LifecycleBoundedJson) => void;
    }> = [{ value, depth: 0, assign: () => undefined }];
    let root: LifecycleBoundedJsonObject | undefined;
    let nodes = 0;
    const consumeText = (text: string): boolean => {
      if (text.length > MAX_LIFECYCLE_INTERCEPTOR_JSON_STRING_LENGTH) {
        return false;
      }
      return true;
    };

    while (stack.length > 0) {
      const current = stack.pop()!;
      nodes += 1;
      if (
        nodes > MAX_LIFECYCLE_INTERCEPTOR_JSON_NODES ||
        current.depth > MAX_LIFECYCLE_INTERCEPTOR_JSON_DEPTH
      ) {
        return undefined;
      }

      if (current.value === null || typeof current.value === 'boolean') {
        current.assign(current.value);
        continue;
      }
      if (typeof current.value === 'string') {
        if (!consumeText(current.value)) {
          return undefined;
        }
        current.assign(current.value);
        continue;
      }
      if (typeof current.value === 'number') {
        if (!Number.isFinite(current.value)) {
          return undefined;
        }
        current.assign(current.value);
        continue;
      }
      if (!current.value || typeof current.value !== 'object') {
        return undefined;
      }
      if (types.isProxy(current.value)) {
        return undefined;
      }
      if (seen.has(current.value)) {
        return undefined;
      }
      seen.add(current.value);

      if (Array.isArray(current.value)) {
        if (Reflect.getPrototypeOf(current.value) !== Array.prototype) {
          return undefined;
        }
        const keys = Reflect.ownKeys(current.value);
        if (keys.some((key) => typeof key === 'symbol')) {
          return undefined;
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(current.value, 'length');
        const arrayLength: unknown = lengthDescriptor?.value;
        if (
          !lengthDescriptor ||
          !('value' in lengthDescriptor) ||
          lengthDescriptor.enumerable ||
          typeof arrayLength !== 'number' ||
          !Number.isSafeInteger(arrayLength) ||
          arrayLength < 0 ||
          arrayLength > MAX_LIFECYCLE_INTERCEPTOR_JSON_COLLECTION_SIZE ||
          keys.length !== arrayLength + 1
        ) {
          return undefined;
        }
        for (let index = 0; index < arrayLength; index += 1) {
          const key = String(index);
          const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
          if (
            !keys.includes(key) ||
            !descriptor ||
            !('value' in descriptor) ||
            !descriptor.enumerable
          ) {
            return undefined;
          }
        }
        const target = new Array<LifecycleBoundedJson>(arrayLength);
        current.assign(target);
        for (let index = arrayLength - 1; index >= 0; index -= 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current.value, String(index))!;
          stack.push({
            value: descriptor.value,
            depth: current.depth + 1,
            assign: (materialized) => {
              target[index] = materialized;
            },
          });
        }
        continue;
      }
      if (!isPlainJsonObject(current.value)) {
        return undefined;
      }

      if (Object.getOwnPropertySymbols(current.value).length > 0) {
        return undefined;
      }
      const keys = Object.keys(current.value);
      if (keys.length > MAX_LIFECYCLE_INTERCEPTOR_JSON_COLLECTION_SIZE) return undefined;

      const target = Object.create(null) as LifecycleBoundedJsonObject;
      current.assign(target);
      if (current.depth === 0) {
        root = target;
      }
      const normalizedKeys = new Set<string>();
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        const valueDescriptor = Object.getOwnPropertyDescriptor(current.value, key);
        if (
          !valueDescriptor ||
          !('value' in valueDescriptor) ||
          !valueDescriptor.enumerable ||
          !LifecycleMetadataKeySchema.safeParse(key).success ||
          normalizedKeys.has(key.normalize('NFKC')) ||
          !consumeText(key)
        ) {
          return undefined;
        }
        normalizedKeys.add(key.normalize('NFKC'));
        Object.defineProperty(target, key, {
          configurable: true,
          enumerable: true,
          value: undefined,
          writable: true,
        });
        stack.push({
          value: valueDescriptor.value,
          depth: current.depth + 1,
          assign: (materialized) => {
            Object.defineProperty(target, key, {
              configurable: true,
              enumerable: true,
              value: materialized,
              writable: true,
            });
          },
        });
      }
    }

    return root &&
      new TextEncoder().encode(JSON.stringify(root)).byteLength <=
        MAX_LIFECYCLE_INTERCEPTOR_JSON_BYTES
      ? root
      : undefined;
  } catch {
    return undefined;
  }
}

const LifecycleBoundedJsonObjectSchema = z.unknown().transform((value, context) => {
  const materialized = materializeBoundedInterceptorJsonObject(value);
  if (materialized === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'lifecycle interceptor JSON must be bounded JSON data',
    });
    return z.NEVER;
  }

  return materialized;
});

const LifecycleInterceptorBaseSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    interceptionId: LifecycleRuntimeIdSchema,
    context: LifecycleExecutionContextSchema,
  })
  .strict();

const LifecycleMessageInputSchema = z
  .object({
    messageId: LifecycleRuntimeIdSchema,
    content: LifecycleContentSchema,
    source: z.enum(['inbound', 'outbound', 'direct']),
    channel: LifecycleFilterOwnerNameSchema.optional(),
    persona: LifecycleFilterOwnerNameSchema.optional(),
  })
  .strict();

export const LifecycleMessageBeforePersistInputSchema = LifecycleInterceptorBaseSchema.extend({
  hook: z.literal('message.before_persist'),
  input: LifecycleMessageInputSchema,
}).strict();

export const LifecycleRunBeforeExecuteInputSchema = LifecycleInterceptorBaseSchema.extend({
  hook: z.literal('run.before_execute'),
  input: z
    .object({
      runId: LifecycleRuntimeIdSchema,
      provider: LifecycleRuntimeNameSchema,
      model: LifecycleDisplayNameSchema,
      persona: LifecycleFilterOwnerNameSchema,
      contextAdditions: LifecycleBoundedJsonObjectSchema.optional(),
    })
    .strict(),
}).strict();

export const LifecycleToolBeforeExecuteInputSchema = LifecycleInterceptorBaseSchema.extend({
  hook: z.literal('tool.before_execute'),
  input: z
    .object({
      toolCallId: LifecycleRuntimeIdSchema,
      toolName: LifecycleRuntimeNameSchema,
      arguments: LifecycleBoundedJsonObjectSchema,
    })
    .strict(),
}).strict();

export const LifecycleMessageBeforeSendInputSchema = LifecycleInterceptorBaseSchema.extend({
  hook: z.literal('message.before_send'),
  input: LifecycleMessageInputSchema.extend({ recipientId: LifecycleRuntimeIdSchema }),
}).strict();

/** The union keeps the transport bounded while preserving each hook's shape. */
export const LifecycleInterceptorEnvelopeSchema = z.discriminatedUnion('hook', [
  LifecycleMessageBeforePersistInputSchema,
  LifecycleRunBeforeExecuteInputSchema,
  LifecycleToolBeforeExecuteInputSchema,
  LifecycleMessageBeforeSendInputSchema,
]);

const LifecycleOutcomeReasonSchema = z.string().min(1).max(512);
const LifecycleSignalEnvelopesSchema = z.array(LifecycleSignalEnvelopeSchema).max(32);

export const LifecycleAdvisoryInterceptorResultSchema = z
  .object({
    outcome: z.literal('advisory'),
    signals: LifecycleSignalEnvelopesSchema.default([]),
  })
  .strict();

const LifecycleMessageTransformSchema = z
  .object({
    hook: z.union([z.literal('message.before_persist'), z.literal('message.before_send')]),
    content: LifecycleContentSchema.optional(),
  })
  .strict()
  .refine((value) => value.content !== undefined, 'message transforms must change content');

const LifecycleRunTransformSchema = z
  .object({
    hook: z.literal('run.before_execute'),
    provider: LifecycleRuntimeNameSchema.optional(),
    model: LifecycleDisplayNameSchema.optional(),
    /** A shallow patch merged into the synchronous run execution context. */
    contextAdditions: LifecycleBoundedJsonObjectSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.provider !== undefined ||
      value.model !== undefined ||
      (value.contextAdditions !== undefined && Object.keys(value.contextAdditions).length > 0),
    'run transforms must change provider, model, or context additions',
  );

const LifecycleToolTransformSchema = z
  .object({
    hook: z.literal('tool.before_execute'),
    /** Replaces the complete tool arguments object. */
    arguments: LifecycleBoundedJsonObjectSchema.optional(),
    /** Shallow-merges fields into the existing tool arguments object. */
    argumentsPatch: LifecycleBoundedJsonObjectSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.arguments !== undefined ||
      (value.argumentsPatch !== undefined && Object.keys(value.argumentsPatch).length > 0),
    'tool transforms must replace arguments or provide an arguments patch',
  )
  .refine(
    (value) => !(value.arguments !== undefined && value.argumentsPatch !== undefined),
    'tool transforms may replace arguments or patch arguments, not both',
  );

export const LifecycleInterceptorTransformSchema = z.discriminatedUnion('hook', [
  LifecycleMessageTransformSchema,
  LifecycleRunTransformSchema,
  LifecycleToolTransformSchema,
]);

/** Only enforcing native handlers can produce an execution-affecting decision. */
export const LifecycleEnforcingInterceptorResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({ outcome: z.literal('allow'), signals: LifecycleSignalEnvelopesSchema.default([]) })
    .strict(),
  z
    .object({
      outcome: z.literal('deny'),
      reason: LifecycleOutcomeReasonSchema,
      signals: LifecycleSignalEnvelopesSchema.default([]),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('require_approval'),
      reason: LifecycleOutcomeReasonSchema,
      approvalKey: LifecycleRuntimeIdSchema,
      signals: LifecycleSignalEnvelopesSchema.default([]),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('transform'),
      transform: LifecycleInterceptorTransformSchema,
      signals: LifecycleSignalEnvelopesSchema.default([]),
      reason: LifecycleOutcomeReasonSchema.optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('error'),
      code: LifecycleIdentifierSchema,
      message: LifecycleOutcomeReasonSchema,
      retryable: z.boolean(),
      signals: LifecycleSignalEnvelopesSchema.default([]),
    })
    .strict(),
]);

/** @deprecated Use the safety-specific schemas above. */
export const LifecycleInterceptorResultSchema = LifecycleEnforcingInterceptorResultSchema;

export type LifecycleInterceptorContract = z.infer<typeof LifecycleInterceptorContractSchema>;
export type LifecycleInterceptorEnvelope = z.infer<typeof LifecycleInterceptorEnvelopeSchema>;
export type LifecycleAdvisoryInterceptorResult = z.infer<
  typeof LifecycleAdvisoryInterceptorResultSchema
>;
export type LifecycleEnforcingInterceptorResult = z.infer<
  typeof LifecycleEnforcingInterceptorResultSchema
>;
export type LifecycleInterceptorResult = z.infer<typeof LifecycleInterceptorResultSchema>;
export type LifecycleInterceptorTransform = z.infer<typeof LifecycleInterceptorTransformSchema>;
