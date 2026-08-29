import { z } from 'zod';
import { types } from 'node:util';

import {
  LifecycleContractVersionSchema,
  LifecycleDisplayNameSchema,
  LifecycleHandlerModeSchema,
  LifecycleIdentifierSchema,
  LifecycleRuntimeNameSchema,
  LifecycleRuntimeKindSchema,
  LifecycleVersionedTypeNameSchema,
} from './common.js';
import { LifecycleBudgetContractSchema } from './budget-contract.js';
import { LifecycleEventEnvelopeSchema, LifecycleMetadataKeySchema } from './event-contract.js';
import { LifecycleFailurePolicyContractSchema } from './failure-policy-contract.js';
import {
  LifecycleAdvisoryInterceptorResultSchema,
  LifecycleEnforcingInterceptorResultSchema,
  LifecycleInterceptorEnvelopeSchema,
} from './interceptor-contract.js';
import { LifecycleSignalEnvelopeSchema, type LifecycleSignalEnvelope } from './signal-contract.js';

export const LIFECYCLE_EVENT_INPUT_CONTRACT = 'talon.lifecycle.event.envelope.v1';
export const LIFECYCLE_SIGNAL_INPUT_CONTRACT = 'talon.lifecycle.signal.envelope.v1';
export const LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT = 'talon.lifecycle.signal.envelopes.v1';
export const LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT = 'talon.lifecycle.interceptor.input.v1';
export const LIFECYCLE_ADVISORY_INTERCEPTOR_OUTPUT_CONTRACT =
  'talon.lifecycle.advisory.interceptor.output.v1';
export const LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT =
  'talon.lifecycle.enforcing.interceptor.output.v1';

export const LifecycleHandlerIdentityContractSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    handlerId: LifecycleIdentifierSchema,
    runtimeKind: LifecycleRuntimeKindSchema,
    implementationRef: LifecycleRuntimeNameSchema,
    implementationVersion: LifecycleDisplayNameSchema,
    mode: LifecycleHandlerModeSchema,
    inputContract: LifecycleVersionedTypeNameSchema,
    outputContract: LifecycleVersionedTypeNameSchema,
    interceptorSafety: z.enum(['advisory', 'enforcing']).optional(),
  })
  .strict();

export const LifecycleHandlerContractSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    id: LifecycleIdentifierSchema,
    displayName: LifecycleDisplayNameSchema.optional(),
    mode: LifecycleHandlerModeSchema,
    inputContract: LifecycleVersionedTypeNameSchema,
    outputContract: LifecycleVersionedTypeNameSchema,
    runtime: z
      .object({
        kind: LifecycleRuntimeKindSchema,
        ref: LifecycleRuntimeNameSchema,
        implementationVersion: LifecycleDisplayNameSchema,
      })
      .strict(),
    budget: LifecycleBudgetContractSchema.optional(),
    failurePolicy: LifecycleFailurePolicyContractSchema.optional(),
    /** Required only to opt a native interceptor into execution enforcement. */
    interceptorSafety: z.enum(['advisory', 'enforcing']).optional(),
  })
  .strict()
  .superRefine((handler, context) => {
    if (handler.mode !== 'interceptor' && handler.interceptorSafety !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['interceptorSafety'],
        message: 'interceptorSafety is only valid for interceptor handlers',
      });
    }

    if (
      handler.mode === 'interceptor' &&
      handler.interceptorSafety === 'enforcing' &&
      handler.runtime.kind !== 'native'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['interceptorSafety'],
        message: 'enforcing interceptors must use a native implementation',
      });
    }
  });

const LifecycleSignalEnvelopesSchema = z.array(LifecycleSignalEnvelopeSchema).max(32);

const MAX_LIFECYCLE_HANDLER_SIGNALS = 32;
const MAX_LIFECYCLE_HANDLER_METADATA_ENTRIES = 32;

type SafeDataObject = Record<string, unknown>;

function isSafePlainObject(value: unknown): value is object {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeDataDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor && descriptor.enumerable ? descriptor : undefined;
}

/**
 * Materialize a fixed-shape ordinary v1 record without evaluating any of its
 * properties. Strict contract schemas must see every own field: dropping an
 * unknown field here would turn a hostile output into a valid one before Zod
 * has a chance to reject it.
 */
function copyKnownObject(value: unknown, fields: readonly string[]): SafeDataObject | undefined {
  if (!isSafePlainObject(value)) {
    return undefined;
  }
  const allowedFields = new Set(fields);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string' || !allowedFields.has(key))) {
    return undefined;
  }
  const copy = Object.create(null) as SafeDataObject;
  for (const field of ownKeys) {
    // `ownKeys` above established this as a string. Reading descriptors is
    // safe after the proxy and prototype checks, and never invokes accessors.
    const descriptor = safeDataDescriptor(value, field as string);
    if (!descriptor) {
      return undefined;
    }
    Object.defineProperty(copy, field as string, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  return copy;
}

/** Handler-produced metadata remains the ordinary v1 record representation. */
function materializeHandlerMetadata(value: unknown): SafeDataObject | undefined {
  if (!isSafePlainObject(value)) {
    return undefined;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
  const keys = Object.keys(value);
  if (keys.length > MAX_LIFECYCLE_HANDLER_METADATA_ENTRIES) return undefined;
  const metadata = Object.create(null) as SafeDataObject;
  const normalizedKeys = new Set<string>();
  for (const key of keys) {
    const valueDescriptor = safeDataDescriptor(value, key);
    const metadataValue: unknown = valueDescriptor?.value as unknown;
    if (
      !LifecycleMetadataKeySchema.safeParse(key).success ||
      normalizedKeys.has(key.normalize('NFKC')) ||
      !(
        metadataValue === null ||
        typeof metadataValue === 'boolean' ||
        typeof metadataValue === 'number' ||
        typeof metadataValue === 'string'
      )
    ) {
      return undefined;
    }
    normalizedKeys.add(key.normalize('NFKC'));
    Object.defineProperty(metadata, key, {
      configurable: true,
      enumerable: true,
      value: metadataValue,
      writable: true,
    });
  }
  return metadata;
}

function materializeHandlerArray(
  value: unknown,
  maxLength: number,
  materializeItem?: (item: unknown) => unknown,
): unknown[] | undefined {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype
  ) {
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) return undefined;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length: unknown =
    lengthDescriptor && 'value' in lengthDescriptor
      ? (lengthDescriptor.value as unknown)
      : undefined;
  if (
    !lengthDescriptor ||
    !('value' in lengthDescriptor) ||
    lengthDescriptor.enumerable ||
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maxLength ||
    keys.length !== length + 1
  ) {
    return undefined;
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !keys.includes(String(index)) ||
      !descriptor ||
      !('value' in descriptor) ||
      !descriptor.enumerable
    ) {
      return undefined;
    }
    const item: unknown = descriptor.value;
    const materialized = materializeItem ? materializeItem(item) : item;
    if (materialized === undefined) return undefined;
    result.push(materialized);
  }
  return result;
}

function materializeHandlerReference(value: unknown): SafeDataObject | undefined {
  return copyKnownObject(value, ['type', 'id']);
}

function materializeOptionalArray(
  target: SafeDataObject,
  field: string,
  materializeItem?: (item: unknown) => unknown,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(target, field)) return true;
  const materialized = materializeHandlerArray(
    target[field],
    MAX_LIFECYCLE_HANDLER_SIGNALS,
    materializeItem,
  );
  if (!materialized) return false;
  target[field] = materialized;
  return true;
}

function materializeHandlerSignal(value: unknown): SafeDataObject | undefined {
  const signal = copyKnownObject(value, [
    'version',
    'type',
    'signalId',
    'occurredAt',
    'context',
    'payload',
  ]);
  if (!signal) return undefined;
  const context = copyKnownObject(signal.context, [
    'aggregate',
    'correlationId',
    'causationId',
    'recursion',
    'provenance',
  ]);
  const payload = copyKnownObject(signal.payload, ['references', 'metadata']);
  if (!context || !payload) return undefined;
  const aggregate = copyKnownObject(context.aggregate, ['type', 'id']);
  const recursion = copyKnownObject(context.recursion, ['depth', 'maxDepth']);
  const provenance = copyKnownObject(context.provenance, [
    'source',
    'sourceEventIds',
    'sourceReferences',
  ]);
  const hasMetadata = Object.prototype.hasOwnProperty.call(payload, 'metadata');
  const metadata = hasMetadata ? materializeHandlerMetadata(payload.metadata) : undefined;
  if (!aggregate || !recursion || !provenance || (hasMetadata && !metadata)) return undefined;
  if (
    !materializeOptionalArray(payload, 'references', materializeHandlerReference) ||
    !materializeOptionalArray(provenance, 'sourceEventIds') ||
    !materializeOptionalArray(provenance, 'sourceReferences', materializeHandlerReference)
  ) {
    return undefined;
  }
  signal.context = Object.assign(context, { aggregate, recursion, provenance });
  signal.payload = metadata ? Object.assign(payload, { metadata }) : payload;
  return signal;
}

function materializeHandlerSignals(value: unknown): unknown[] | undefined {
  return materializeHandlerArray(value, MAX_LIFECYCLE_HANDLER_SIGNALS, materializeHandlerSignal);
}

function materializeLifecycleHandlerResult(value: unknown): SafeDataObject | undefined {
  try {
    const result = copyKnownObject(value, [
      'outcome',
      'outputContract',
      'signals',
      'result',
      'code',
      'message',
      'retryable',
    ]);
    if (!result) return undefined;
    if (Object.prototype.hasOwnProperty.call(result, 'signals')) {
      const signals = materializeHandlerSignals(result.signals);
      if (!signals) return undefined;
      result.signals = signals;
    }
    if (Object.prototype.hasOwnProperty.call(result, 'result')) {
      const interceptorResult = copyKnownObject(result.result, [
        'outcome',
        'signals',
        'reason',
        'approvalKey',
        'transform',
        'code',
        'message',
        'retryable',
      ]);
      if (!interceptorResult) return undefined;
      if (Object.prototype.hasOwnProperty.call(interceptorResult, 'signals')) {
        const signals = materializeHandlerSignals(interceptorResult.signals);
        if (!signals) return undefined;
        interceptorResult.signals = signals;
      }
      if (Object.prototype.hasOwnProperty.call(interceptorResult, 'transform')) {
        const transform = copyKnownObject(interceptorResult.transform, [
          'hook',
          'content',
          'provider',
          'model',
          'contextAdditions',
          'arguments',
          'argumentsPatch',
        ]);
        if (!transform) return undefined;
        interceptorResult.transform = transform;
      }
      result.result = interceptorResult;
    }
    return result;
  } catch {
    return undefined;
  }
}

export const LifecycleHandlerSuccessResultSchema = z
  .object({
    outcome: z.literal('success'),
    outputContract: z.literal(LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT),
    signals: LifecycleSignalEnvelopesSchema,
  })
  .strict();

export const LifecycleAdvisoryInterceptorHandlerResultSchema = z
  .object({
    outcome: z.literal('success'),
    outputContract: z.literal(LIFECYCLE_ADVISORY_INTERCEPTOR_OUTPUT_CONTRACT),
    result: LifecycleAdvisoryInterceptorResultSchema,
  })
  .strict();

export const LifecycleEnforcingInterceptorHandlerResultSchema = z
  .object({
    outcome: z.literal('success'),
    outputContract: z.literal(LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT),
    result: LifecycleEnforcingInterceptorResultSchema,
  })
  .strict();

export const LifecycleHandlerErrorResultSchema = z
  .object({
    outcome: z.literal('error'),
    code: LifecycleIdentifierSchema,
    message: z.string().min(1).max(512),
    retryable: z.boolean(),
  })
  .strict();

export const LifecycleHandlerResultSchema = z.union([
  LifecycleHandlerSuccessResultSchema,
  LifecycleAdvisoryInterceptorHandlerResultSchema,
  LifecycleEnforcingInterceptorHandlerResultSchema,
  LifecycleHandlerErrorResultSchema,
]);

/**
 * Opaque parsing capabilities for a supported contract pair. Zod schemas stay
 * module-private so callers cannot mutate a shared schema and affect later
 * contract resolutions.
 */
export interface LifecycleHandlerContractDefinition {
  readonly mode: z.infer<typeof LifecycleHandlerModeSchema>;
  readonly requiredSafety?: 'advisory' | 'enforcing';
  /**
   * Parses an input into a contract-owned normalized snapshot. The schema
   * itself remains private, so callers cannot mutate global validation state.
   */
  readonly parseInput: (input: unknown) => LifecycleHandlerInputParseResult;
  readonly acceptsOutput: (output: unknown) => boolean;
}

export type LifecycleHandlerInputParseResult =
  | Readonly<{ success: true; data: unknown }>
  | Readonly<{ success: false }>;

interface LifecycleHandlerContractDefinitionInternal {
  readonly mode: z.infer<typeof LifecycleHandlerModeSchema>;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly requiredSafety?: 'advisory' | 'enforcing';
}

function safelyParseSchema(schema: z.ZodType, input: unknown): ReturnType<z.ZodType['safeParse']> {
  try {
    return schema.safeParse(input);
  } catch {
    // Public parsing boundaries must not surface hostile Proxy traps as
    // exceptions. Undefined is invalid for every lifecycle transport schema.
    return schema.safeParse(undefined);
  }
}

function safelyParseHandler(
  handler: unknown,
): ReturnType<typeof LifecycleHandlerContractSchema.safeParse> {
  try {
    return LifecycleHandlerContractSchema.safeParse(handler);
  } catch {
    return LifecycleHandlerContractSchema.safeParse(undefined);
  }
}

function safelyParseHandlerResult(
  result: unknown,
): ReturnType<typeof LifecycleHandlerResultSchema.safeParse> {
  try {
    return LifecycleHandlerResultSchema.safeParse(result);
  } catch {
    return LifecycleHandlerResultSchema.safeParse(undefined);
  }
}

interface LifecycleInvocationCausalContext {
  readonly version: 'v1';
  readonly identity: string;
  readonly context: z.infer<typeof LifecycleInterceptorEnvelopeSchema>['context'];
}

function invocationCausalContext(input: unknown): LifecycleInvocationCausalContext | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const invocation = input as {
    version: 'v1';
    eventId?: string;
    signalId?: string;
    interceptionId?: string;
    context?: z.infer<typeof LifecycleInterceptorEnvelopeSchema>['context'];
  };
  const identity = invocation.eventId ?? invocation.signalId ?? invocation.interceptionId;
  return identity && invocation.context
    ? { version: invocation.version, identity, context: invocation.context }
    : undefined;
}

function preservesSignalCausality(
  invocation: LifecycleInvocationCausalContext,
  signal: LifecycleSignalEnvelope,
): boolean {
  const inputRecursion = invocation.context.recursion;
  const signalContext = signal.context;
  return (
    signal.version === invocation.version &&
    signalContext.aggregate.type === invocation.context.aggregate.type &&
    signalContext.aggregate.id === invocation.context.aggregate.id &&
    signalContext.correlationId === invocation.context.correlationId &&
    signalContext.causationId === invocation.identity &&
    signalContext.recursion.maxDepth === inputRecursion.maxDepth &&
    signalContext.recursion.depth === inputRecursion.depth + 1 &&
    signalContext.recursion.depth <= signalContext.recursion.maxDepth
  );
}

function resultSignals(result: LifecycleHandlerResult): readonly LifecycleSignalEnvelope[] {
  if (result.outcome === 'error') {
    return [];
  }
  return result.outputContract === LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT
    ? result.signals
    : result.result.signals;
}

function deepFrozenSnapshot(value: unknown): unknown {
  const snapshot = structuredClone(value);
  const visited = new WeakSet<object>();
  const pending: object[] = [snapshot as object];

  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (visited.has(candidate)) {
      continue;
    }
    visited.add(candidate);

    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(candidate))) {
      const nested: unknown = 'value' in descriptor ? descriptor.value : undefined;
      if (nested && typeof nested === 'object') {
        pending.push(nested);
      }
    }
    Object.freeze(candidate);
  }

  return snapshot;
}

const LifecycleContractDefinitions: ReadonlyMap<
  string,
  LifecycleHandlerContractDefinitionInternal
> = new Map([
  [
    `${LIFECYCLE_EVENT_INPUT_CONTRACT}:${LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT}`,
    {
      mode: 'event',
      input: LifecycleEventEnvelopeSchema,
      output: LifecycleHandlerSuccessResultSchema,
    },
  ],
  [
    `${LIFECYCLE_SIGNAL_INPUT_CONTRACT}:${LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT}`,
    {
      mode: 'signal',
      input: LifecycleSignalEnvelopeSchema,
      output: LifecycleHandlerSuccessResultSchema,
    },
  ],
  [
    `${LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT}:${LIFECYCLE_ADVISORY_INTERCEPTOR_OUTPUT_CONTRACT}`,
    {
      mode: 'interceptor',
      input: LifecycleInterceptorEnvelopeSchema,
      output: LifecycleAdvisoryInterceptorHandlerResultSchema,
      requiredSafety: 'advisory',
    },
  ],
  [
    `${LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT}:${LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT}`,
    {
      mode: 'interceptor',
      input: LifecycleInterceptorEnvelopeSchema,
      output: LifecycleEnforcingInterceptorHandlerResultSchema,
      requiredSafety: 'enforcing',
    },
  ],
]);

export function resolveLifecycleHandlerContract(
  inputContract: string,
  outputContract: string,
): LifecycleHandlerContractDefinition | undefined {
  const definition = LifecycleContractDefinitions.get(`${inputContract}:${outputContract}`);
  if (!definition) {
    return undefined;
  }

  const parseInput = Object.freeze((input: unknown): LifecycleHandlerInputParseResult => {
    const parsed = safelyParseSchema(definition.input, input);
    if (!parsed.success) {
      return Object.freeze({ success: false as const });
    }

    try {
      return Object.freeze({ success: true as const, data: deepFrozenSnapshot(parsed.data) });
    } catch {
      return Object.freeze({ success: false as const });
    }
  });

  return Object.freeze({
    mode: definition.mode,
    ...(definition.requiredSafety ? { requiredSafety: definition.requiredSafety } : {}),
    parseInput,
    acceptsOutput: Object.freeze((output: unknown) => {
      const materialized = materializeLifecycleHandlerResult(output);
      return (
        materialized !== undefined && safelyParseSchema(definition.output, materialized).success
      );
    }),
  });
}

export function getEffectiveInterceptorSafety(
  handler: z.infer<typeof LifecycleHandlerContractSchema>,
): 'advisory' | 'enforcing' | undefined {
  if (handler.mode !== 'interceptor') {
    return undefined;
  }

  return handler.runtime.kind === 'native' && handler.interceptorSafety === 'enforcing'
    ? 'enforcing'
    : 'advisory';
}

export function parseLifecycleHandlerResult(
  handler: z.infer<typeof LifecycleHandlerContractSchema>,
  input: unknown,
  result: unknown,
): ReturnType<typeof LifecycleHandlerResultSchema.safeParse> {
  const parsedHandler = safelyParseHandler(handler);
  if (!parsedHandler.success) {
    return safelyParseHandlerResult({});
  }

  const normalizedHandler = parsedHandler.data;
  const contract = resolveLifecycleHandlerContract(
    normalizedHandler.inputContract,
    normalizedHandler.outputContract,
  );
  const parsedInput = contract?.parseInput(input);
  if (
    !contract ||
    contract.mode !== normalizedHandler.mode ||
    contract.requiredSafety !== getEffectiveInterceptorSafety(normalizedHandler) ||
    !parsedInput?.success
  ) {
    return safelyParseHandlerResult({});
  }

  // This is the hostile handler-output boundary. Signal metadata is
  // materialized as a bounded ordinary v1 record before Zod sees it, so
  // z.record never has to enumerate an unbounded user-controlled key set.
  // Keep validating the original transport below through acceptsOutput.
  const materializedResult = materializeLifecycleHandlerResult(result);
  const parsed = safelyParseHandlerResult(materializedResult);
  if (!parsed.success || parsed.data.outcome === 'error') {
    return parsed;
  }

  const invocation = invocationCausalContext(parsedInput.data);
  if (
    !invocation ||
    !resultSignals(parsed.data).every((signal) => preservesSignalCausality(invocation, signal))
  ) {
    return safelyParseHandlerResult({});
  }

  if (
    parsed.data.outputContract !== normalizedHandler.outputContract ||
    !contract.acceptsOutput(result)
  ) {
    // Reparse an intentionally incomplete result through the public result
    // schema so callers receive the same typed Zod failure shape as any other
    // malformed handler result.
    return safelyParseHandlerResult({
      outcome: 'success',
      outputContract: normalizedHandler.outputContract,
    });
  }

  if (
    normalizedHandler.mode === 'interceptor' &&
    parsed.data.outputContract === LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT &&
    parsed.data.result.outcome === 'transform' &&
    parsed.data.result.transform.hook !==
      (parsedInput.data as z.infer<typeof LifecycleInterceptorEnvelopeSchema>).hook
  ) {
    return safelyParseHandlerResult({});
  }

  return parsed;
}

export type LifecycleHandlerIdentityContract = z.infer<
  typeof LifecycleHandlerIdentityContractSchema
>;
export type LifecycleHandlerContract = z.infer<typeof LifecycleHandlerContractSchema>;
export type LifecycleHandlerSuccessResult = z.infer<typeof LifecycleHandlerSuccessResultSchema>;
export type LifecycleAdvisoryInterceptorHandlerResult = z.infer<
  typeof LifecycleAdvisoryInterceptorHandlerResultSchema
>;
export type LifecycleEnforcingInterceptorHandlerResult = z.infer<
  typeof LifecycleEnforcingInterceptorHandlerResultSchema
>;
export type LifecycleHandlerErrorResult = z.infer<typeof LifecycleHandlerErrorResultSchema>;
export type LifecycleHandlerResult = z.infer<typeof LifecycleHandlerResultSchema>;
