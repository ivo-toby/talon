import { z } from 'zod';

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
import { LifecycleEventEnvelopeSchema } from './event-contract.js';
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
    acceptsOutput: Object.freeze(
      (output: unknown) => safelyParseSchema(definition.output, output).success,
    ),
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

  const parsed = safelyParseHandlerResult(result);
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
    !contract.acceptsOutput(parsed.data)
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
