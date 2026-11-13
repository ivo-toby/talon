import { AsyncLocalStorage } from 'node:async_hooks';
import type pino from 'pino';
import type {
  ObservationHandle,
  ObservationInput,
  ObservationUpdate,
  ObservabilityService,
  StartedObservationHandle,
} from './observability-types.js';

/** Maximum size of an opaque identifier exported by a voice observation. */
export const VOICE_OBSERVATION_MAX_ID_LENGTH = 256;

/** Maximum UTF-8 size of the serialized allowlisted observation metadata. */
export const VOICE_OBSERVATION_MAX_METADATA_BYTES = 4096;

/** Content marker used in place of all voice input and output values. */
export const VOICE_REDACTED_CONTENT = '[voice content redacted]';

/** Fixed categories used for voice observation failures. */
export const VOICE_OBSERVATION_ERROR_CATEGORIES = [
  'callback',
  'policy',
  'provider',
  'timeout',
  'tool',
  'unknown',
] as const;

export type VoiceObservationErrorCategory = (typeof VOICE_OBSERVATION_ERROR_CATEGORIES)[number];

/** Trusted persisted privacy classification used by descendant diagnostics. */
export type VoicePrivacyClassification = 'voice' | 'nonvoice' | 'unknown';

const VOICE_DISPATCH_LOG_METHODS = new Set([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
]);

const KNOWN_NONVOICE_CHANNEL_TYPES = new Set([
  'telegram',
  'whatsapp',
  'whatsappBusiness',
  'whatsappBaileys',
  'slack',
  'email',
  'discord',
  'terminal',
]);

/** Classify only persisted channel types that the server explicitly knows. */
export function classifyVoiceChannelType(type: unknown): VoicePrivacyClassification {
  if (type === 'voice') return 'voice';
  if (typeof type === 'string' && KNOWN_NONVOICE_CHANNEL_TYPES.has(type)) return 'nonvoice';
  return 'unknown';
}

/**
 * Server-owned correlation and privacy context for one voice backend run.
 *
 * The `redacted` marker is intentionally literal and the object is frozen by
 * `createVoiceObservationContext`. Callers receiving this type must never
 * construct it from bridge request data.
 */
export interface VoiceObservationContext {
  readonly kind: 'voice';
  readonly redacted: true;
  readonly callId?: string;
  readonly delegationId?: string;
  readonly queueItemId?: string;
  readonly runId?: string;
  readonly threadId?: string;
  readonly personaId?: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface VoiceObservationContextInput {
  readonly callId?: unknown;
  readonly delegationId?: unknown;
  readonly queueItemId?: unknown;
  readonly runId?: unknown;
  readonly threadId?: unknown;
  readonly personaId?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
}

const VOICE_METADATA_KEYS = new Set([
  'voice',
  'redacted',
  'callId',
  'delegationId',
  'queueItemId',
  'runId',
  'threadId',
  'personaId',
  'provider',
  'model',
  'toolName',
  'messageType',
  'subtype',
  'serverName',
  'resultSessionId',
  'resumeSessionId',
  'outputId',
  'errorCategory',
  'status',
  'success',
  'durationMs',
  'count',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'costUsd',
]);

const VOICE_PROTECTED_METADATA_KEYS = new Set([
  'voice',
  'redacted',
  'callId',
  'delegationId',
  'queueItemId',
  'runId',
  'threadId',
  'personaId',
  'provider',
  'model',
]);

const VOICE_CATEGORY_METADATA_KEYS = new Set(['messageType', 'subtype', 'status', 'errorCategory']);

const VOICE_CATEGORY_VALUES: Record<string, ReadonlySet<string>> = {
  messageType: new Set([
    'tool_use',
    'server_tool_use',
    'mcp_tool_use',
    'tool_result',
    'mcp_tool_result',
  ]),
  subtype: new Set([
    'success',
    'error',
    'function_call',
    'function_call_output',
    'custom_tool_call',
    'custom_tool_call_output',
    'mcp_call',
    'mcp_call_output',
    'tool_use',
    'tool_result',
  ]),
  status: new Set(['success', 'error', 'completed', 'failed', 'timed_out', 'cancelled', 'unknown']),
  errorCategory: new Set(VOICE_OBSERVATION_ERROR_CATEGORIES),
};

const VOICE_FIXED_METADATA_VALUES: Record<string, string> = {
  toolName: 'voice-tool',
  serverName: 'voice-server',
};

const trustedVoiceContexts = new WeakSet<object>();

const VOICE_NUMERIC_KEYS = new Set([
  'durationMs',
  'latencyMs',
  'count',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'costUsd',
  'totalCostUsd',
]);

const VOICE_MODEL_PARAMETER_KEYS = new Set([
  'temperature',
  'topP',
  'top_p',
  'maxTokens',
  'max_tokens',
  'reasoningEffort',
]);

const NOOP_OBSERVATION: ObservationHandle = {
  update: () => {},
  getTraceparent: () => null,
};

const NOOP_STARTED_OBSERVATION: StartedObservationHandle = {
  ...NOOP_OBSERVATION,
  end: () => {},
};

function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.length > VOICE_OBSERVATION_MAX_ID_LENGTH) return undefined;
  return value;
}

function isSafeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSafePrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'boolean' || isSafeNumber(value) || boundedString(value) !== undefined;
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Create immutable server-owned voice context, dropping invalid identifiers. */
export function createVoiceObservationContext(
  input: VoiceObservationContextInput = {},
): VoiceObservationContext {
  const context: VoiceObservationContext = {
    kind: 'voice',
    redacted: true,
    ...(boundedString(input.callId) ? { callId: boundedString(input.callId) } : {}),
    ...(boundedString(input.delegationId)
      ? { delegationId: boundedString(input.delegationId) }
      : {}),
    ...(boundedString(input.queueItemId) ? { queueItemId: boundedString(input.queueItemId) } : {}),
    ...(boundedString(input.runId) ? { runId: boundedString(input.runId) } : {}),
    ...(boundedString(input.threadId) ? { threadId: boundedString(input.threadId) } : {}),
    ...(boundedString(input.personaId) ? { personaId: boundedString(input.personaId) } : {}),
    ...(boundedString(input.provider) ? { provider: boundedString(input.provider) } : {}),
    ...(boundedString(input.model) ? { model: boundedString(input.model) } : {}),
  };
  const frozenContext = Object.freeze(context);
  trustedVoiceContexts.add(frozenContext);
  return frozenContext;
}

export function isVoiceObservationContext(value: unknown): value is VoiceObservationContext {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<VoiceObservationContext>;
  return (
    candidate.kind === 'voice' &&
    candidate.redacted === true &&
    Object.isFrozen(value) &&
    trustedVoiceContexts.has(value)
  );
}

function baseMetadata(context: VoiceObservationContext): Record<string, string | boolean> {
  return {
    voice: true,
    redacted: true,
    ...(context.callId ? { callId: context.callId } : {}),
    ...(context.delegationId ? { delegationId: context.delegationId } : {}),
    ...(context.queueItemId ? { queueItemId: context.queueItemId } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.threadId ? { threadId: context.threadId } : {}),
    ...(context.personaId ? { personaId: context.personaId } : {}),
    ...(context.provider ? { provider: context.provider } : {}),
    ...(context.model ? { model: context.model } : {}),
  };
}

/** Keep only fixed metadata keys and primitive bounded values. */
export function sanitizeVoiceObservationMetadata(
  context: VoiceObservationContext,
  metadata?: Record<string, unknown>,
): Record<string, string | number | boolean> | null {
  if (!isVoiceObservationContext(context)) return null;

  const sanitized: Record<string, string | number | boolean> = baseMetadata(context);
  for (const [key, value] of Object.entries(metadata ?? {})) {
    const fixedValue = VOICE_FIXED_METADATA_VALUES[key];
    if (fixedValue !== undefined) {
      sanitized[key] = fixedValue;
      continue;
    }
    if (
      !VOICE_METADATA_KEYS.has(key) ||
      VOICE_PROTECTED_METADATA_KEYS.has(key) ||
      !isSafePrimitive(value)
    ) {
      continue;
    }
    if (
      VOICE_CATEGORY_METADATA_KEYS.has(key) &&
      (typeof value !== 'string' ||
        !/^[a-z0-9_.:-]{1,64}$/i.test(value) ||
        !VOICE_CATEGORY_VALUES[key]?.has(value))
    ) {
      continue;
    }
    sanitized[key] = value;
  }

  return serializedBytes(sanitized) <= VOICE_OBSERVATION_MAX_METADATA_BYTES ? sanitized : null;
}

function sanitizeNumericMap(
  values: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!values) return undefined;
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (VOICE_NUMERIC_KEYS.has(key) && isSafeNumber(value) && value >= 0) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeModelParameters(
  values: Record<string, string | number> | undefined,
): Record<string, string | number> | undefined {
  if (!values) return undefined;
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (
      VOICE_MODEL_PARAMETER_KEYS.has(key) &&
      (isSafeNumber(value) ||
        (key === 'reasoningEffort' &&
          typeof value === 'string' &&
          /^[a-z0-9_.:-]{1,64}$/i.test(value)))
    ) {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeObservationName(_name: string, type: ObservationInput['type']): string {
  // Voice names are a fixed role vocabulary. A regex check alone would still
  // export caller-controlled subagent, provider, profile, or tool names.
  return `voice-${type}`;
}

function redactedInput(type: ObservationInput['type']): string {
  return type === 'tool' ? '[voice tool input redacted]' : '[voice context redacted]';
}

function redactedOutput(type: ObservationInput['type']): string {
  return type === 'tool' ? '[voice tool output redacted]' : '[voice output redacted]';
}

/**
 * Sanitize an observation before it reaches the Langfuse/OTEL SDK.
 * Returning null means this observation is dropped because its bounded
 * allowlisted metadata could not be represented safely.
 */
export function sanitizeVoiceObservationInput(
  input: ObservationInput,
  context: VoiceObservationContext,
): ObservationInput | null {
  const metadata = sanitizeVoiceObservationMetadata(context, input.metadata);
  if (metadata === null) return null;

  const traceMetadata = Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => typeof value === 'string'),
  ) as Record<string, string>;

  const sanitized: ObservationInput = {
    type: input.type,
    name: safeObservationName(input.name, input.type),
    input: redactedInput(input.type),
    output: input.output === undefined ? undefined : redactedOutput(input.type),
    metadata,
    level: input.level,
    statusMessage: input.level === 'ERROR' ? 'VOICE_OBSERVATION_ERROR' : undefined,
    model: boundedString(input.model) ?? context.model,
    modelParameters: sanitizeModelParameters(input.modelParameters),
    usageDetails: sanitizeNumericMap(input.usageDetails),
    costDetails: sanitizeNumericMap(input.costDetails),
    trace: {
      sessionId: context.threadId ?? context.callId,
      metadata: traceMetadata,
      input: redactedInput(input.type),
      output: input.output === undefined ? undefined : redactedOutput(input.type),
    },
  };
  return serializedBytes(sanitized) <= VOICE_OBSERVATION_MAX_METADATA_BYTES ? sanitized : null;
}

/** Sanitize updates, including content passed through nested trace I/O. */
export function sanitizeVoiceObservationUpdate(
  update: ObservationUpdate,
  context: VoiceObservationContext,
  type: ObservationInput['type'] = 'agent',
): ObservationUpdate | null {
  const metadata = sanitizeVoiceObservationMetadata(context, update.metadata);
  if (metadata === null) return null;

  const sanitized: ObservationUpdate = {
    input: update.input === undefined ? undefined : redactedInput(type),
    output: update.output === undefined ? undefined : redactedOutput(type),
    metadata,
    level: update.level,
    statusMessage: update.level === 'ERROR' ? 'VOICE_OBSERVATION_ERROR' : undefined,
    model: boundedString(update.model) ?? context.model,
    modelParameters: sanitizeModelParameters(update.modelParameters),
    usageDetails: sanitizeNumericMap(update.usageDetails),
    costDetails: sanitizeNumericMap(update.costDetails),
    trace:
      update.trace === undefined
        ? undefined
        : {
            input: update.trace.input === undefined ? undefined : redactedInput(type),
            output: update.trace.output === undefined ? undefined : redactedOutput(type),
          },
  };
  return serializedBytes(sanitized) <= VOICE_OBSERVATION_MAX_METADATA_BYTES ? sanitized : null;
}

/** Classify an error without exporting its message or other free text. */
export function classifyVoiceObservationError(error: unknown): VoiceObservationErrorCategory {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || /timed out|timeout/i.test(error.message)) {
      return 'timeout';
    }
    if (/policy|permission|approval|unauthor/i.test(error.message)) return 'policy';
    if (/provider|model|api|connection|network/i.test(error.message)) return 'provider';
    if (/tool|bridge/i.test(error.message)) return 'tool';
  }
  return 'unknown';
}

function safeHandle(
  observation: ObservationHandle,
  context: VoiceObservationContext,
  type: ObservationInput['type'],
): ObservationHandle {
  return {
    update: (update: ObservationUpdate): void => {
      const sanitized = sanitizeVoiceObservationUpdate(update, context, type);
      if (sanitized === null) return;
      try {
        observation.update(sanitized);
      } catch {
        // Telemetry is best effort and must never affect execution.
      }
    },
    getTraceparent: (): string | null => {
      try {
        return observation.getTraceparent();
      } catch {
        return null;
      }
    },
  };
}

/**
 * Create a per-invocation logger that cannot forward voice content or free
 * error text. The returned wrapper does not mutate the shared logger.
 */
export function createVoiceSafeLogger(logger: import('pino').Logger): import('pino').Logger {
  const safeLogger = Object.create(logger) as import('pino').Logger;
  const emit = (
    level: 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'trace',
  ): ((..._args: unknown[]) => void) => {
    return (..._args: unknown[]): void => {
      try {
        logger[level]({ voice: true, errorCategory: 'unknown' }, 'voice descendant event');
      } catch {
        // Diagnostics are best effort and must not replay or alter execution.
      }
    };
  };
  Object.assign(safeLogger, {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    fatal: emit('fatal'),
    trace: emit('trace'),
    child: (): import('pino').Logger => safeLogger,
  });
  return safeLogger;
}

export interface VoiceDispatchLogger {
  readonly logger: pino.Logger;
  run<T>(classification: VoicePrivacyClassification, callback: () => T): T;
}

/**
 * Create one request-scoped logger for all host-tool handlers.
 *
 * The logger is immutable from the caller's perspective. AsyncLocalStorage
 * selects the policy at each log call, so concurrent voice and nonvoice
 * dispatches cannot change one another's logger. A child created in a
 * protected scope drops its bindings; a child created in a confirmed
 * nonvoice scope retains normal pino behavior while remaining policy-aware
 * if it escapes that scope.
 */
export function createVoiceDispatchLogger(logger: pino.Logger): VoiceDispatchLogger {
  const storage = new AsyncLocalStorage<VoicePrivacyClassification>();

  const createProxy = (target: pino.Logger): pino.Logger => {
    const safeLogger = createVoiceSafeLogger(logger);
    return new Proxy(target, {
      get(current, property, receiver): unknown {
        if (property === 'child') {
          return (...args: unknown[]): pino.Logger => {
            const classification = storage.getStore() ?? 'unknown';
            if (classification !== 'nonvoice') {
              return createProxy(current);
            }
            const child = Reflect.apply(
              Reflect.get(current, property, current) as unknown as (
                ...childArgs: unknown[]
              ) => pino.Logger,
              current,
              args,
            ) as unknown as pino.Logger;
            return createProxy(child);
          };
        }

        if (property === 'bindings') {
          return (): Record<string, unknown> => {
            if ((storage.getStore() ?? 'unknown') !== 'nonvoice') return {};
            const bindings = Reflect.get(current, property, current) as unknown;
            return typeof bindings === 'function'
              ? (Reflect.apply(bindings, current, []) as unknown as Record<string, unknown>)
              : {};
          };
        }

        const value = Reflect.get(current, property, receiver) as unknown;
        if (
          typeof property === 'string' &&
          VOICE_DISPATCH_LOG_METHODS.has(property) &&
          typeof value === 'function'
        ) {
          return (...args: unknown[]): unknown => {
            const classification = storage.getStore() ?? 'unknown';
            if (classification === 'nonvoice') {
              return Reflect.apply(value as (...logArgs: unknown[]) => unknown, current, args);
            }
            const safeMethod = Reflect.get(safeLogger, property, safeLogger) as unknown;
            if (typeof safeMethod !== 'function') return undefined;
            return Reflect.apply(
              safeMethod as (...logArgs: unknown[]) => unknown,
              safeLogger,
              args,
            );
          };
        }
        return value;
      },
    });
  };

  return {
    logger: createProxy(logger),
    run: <T>(classification: VoicePrivacyClassification, callback: () => T): T =>
      storage.run(classification, callback),
  };
}

/** Start a content-free voice span without allowing SDK failures to escape. */
export function startVoiceObservationSafely(
  service: ObservabilityService,
  traceparent: string | null | undefined,
  input: ObservationInput,
  context: VoiceObservationContext,
): StartedObservationHandle {
  const sanitized = sanitizeVoiceObservationInput(input, context);
  if (sanitized === null) return NOOP_STARTED_OBSERVATION;

  let observation: StartedObservationHandle;
  try {
    observation = service.startWithTraceparent(traceparent, sanitized);
  } catch {
    return NOOP_STARTED_OBSERVATION;
  }

  const wrapped = safeHandle(observation, context, input.type);
  return {
    ...wrapped,
    end: (): void => {
      try {
        observation.end();
      } catch {
        // Telemetry cleanup is best effort and must never affect execution.
      }
    },
  };
}

async function invokeOnce<T>(
  callback: (observation: ObservationHandle) => Promise<T> | T,
  observation: ObservationHandle,
): Promise<T> {
  return await callback(observation);
}

/**
 * Execute one voice callback with best-effort observation.
 *
 * The callback is invoked exactly once. Callback failures are recorded using
 * a static category while the original error is rethrown after the observer
 * has completed, so Langfuse never receives free exception text. If span
 * creation or cleanup fails, the callback result/error is still returned.
 */
export async function observeVoiceSafely<T>(options: {
  service: ObservabilityService;
  traceparent?: string | null;
  input: ObservationInput;
  context: VoiceObservationContext;
  callback: (observation: ObservationHandle) => Promise<T> | T;
}): Promise<T> {
  const sanitized = sanitizeVoiceObservationInput(options.input, options.context);
  if (sanitized === null) {
    return await invokeOnce(options.callback, NOOP_OBSERVATION);
  }

  type Outcome = { kind: 'success'; value: T } | { kind: 'error'; error: unknown };
  let outcome: Outcome | undefined;
  let callbackInvoked = false;
  let callbackExecution: Promise<void> | undefined;

  const observedCallback = (observation: ObservationHandle): Promise<void> => {
    if (callbackInvoked) return callbackExecution ?? Promise.resolve();
    callbackInvoked = true;
    callbackExecution = (async (): Promise<void> => {
      const wrapped = safeHandle(observation, options.context, options.input.type);
      try {
        const value = await options.callback(wrapped);
        outcome = { kind: 'success', value };
      } catch (error) {
        outcome = { kind: 'error', error };
        wrapped.update({
          level: 'ERROR',
          metadata: { errorCategory: classifyVoiceObservationError(error) },
        });
      }
    })();
    return callbackExecution;
  };

  try {
    if (options.traceparent) {
      await options.service.observeWithTraceparent(
        options.traceparent,
        sanitized,
        observedCallback,
      );
    } else {
      await options.service.observe(sanitized, observedCallback);
    }
  } catch (observationError) {
    if (!callbackInvoked) {
      // Span creation failed before the callback. Execute the real work once.
      return await invokeOnce(options.callback, NOOP_OBSERVATION);
    }
    // Cleanup/export failed after the callback. Preserve its actual outcome.
    if (callbackExecution) await callbackExecution;
    if (outcome?.kind === 'error') throw outcome.error;
    if (outcome?.kind === 'success') return outcome.value;
    throw observationError;
  }

  if (callbackExecution) await callbackExecution;

  if (!outcome) {
    // A faulty observer returned without invoking its callback. Do not lose
    // the actual work, and still invoke it exactly once from this wrapper.
    return await invokeOnce(options.callback, NOOP_OBSERVATION);
  }
  if (outcome.kind === 'error') throw outcome.error;
  return outcome.value;
}
