import { err, ok, type Result } from 'neverthrow';
import { types } from 'node:util';

import { LifecycleError } from '../../core/errors/error-types.js';
import type { AuditLogger } from '../../core/logging/audit-logger.js';
import {
  LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT,
  parseLifecycleHandlerResult,
  resolveLifecycleHandlerContract,
  type LifecycleInterceptorEnvelope,
  type LifecycleInterceptorTransform,
  type LifecycleSignalEnvelope,
} from '../contracts/index.js';
import type {
  LifecycleInterceptorResolutionQuery,
  ResolvedLifecycleHandler,
} from '../handler-registry.js';
import { noopLifecycleTelemetry, type LifecycleTelemetry } from '../telemetry/index.js';

export const DEFAULT_LIFECYCLE_INTERCEPTOR_HANDLER_TIMEOUT_MS = 100;
export const DEFAULT_LIFECYCLE_INTERCEPTOR_TOTAL_TIMEOUT_MS = 500;

const IntrinsicPromiseThen = Object.getOwnPropertyDescriptor(Promise.prototype, 'then')?.value as (
  this: Promise<unknown>,
  onFulfilled: undefined,
  onRejected: () => undefined,
) => unknown;
const IntrinsicReflectApply = Reflect.apply;

/**
 * A synchronous, bootstrap-owned native interceptor implementation.
 *
 * This in-process boundary deliberately accepts only native runtime identities.
 * Such implementations are trusted daemon code and therefore can already
 * terminate or mutate the process directly. They must return data, not a
 * Promise. Every real, non-proxy Promise is rejected at this synchronous
 * boundary. Ordinary native Promises (including regular subclasses) are
 * locally drained through the captured intrinsic reaction. A handler whose
 * Promise has a hostile `constructor` or `Symbol.species` violates this
 * bootstrap-owned synchronous contract: JavaScript cannot attach a rejection
 * handler locally in that case, and the engine deliberately never changes
 * process-global fatal-error handling to hide it.
 */
export type LifecycleInterceptorHandler = (input: LifecycleInterceptorEnvelope) => unknown;

/** Injected monotonic clock makes deadline checks deterministic in tests. */
export interface LifecycleInterceptorClock {
  now(): number;
}

export type LifecycleInterceptorInvocation = LifecycleInterceptorResolutionQuery;

export interface LifecycleInterceptorEngineOptions {
  readonly resolveHandlers: (
    query: LifecycleInterceptorInvocation,
  ) => readonly ResolvedLifecycleHandler[];
  readonly implementations: Readonly<Record<string, LifecycleInterceptorHandler>>;
  readonly auditLogger?: AuditLogger;
  readonly clock?: LifecycleInterceptorClock;
  readonly totalTimeoutMs?: number;
  readonly defaultHandlerTimeoutMs?: number;
  readonly telemetry?: LifecycleTelemetry;
}

interface LifecycleInterceptorExecutionBase {
  readonly input: LifecycleInterceptorEnvelope;
  readonly signals: readonly LifecycleSignalEnvelope[];
}

export type LifecycleInterceptorExecution =
  | (LifecycleInterceptorExecutionBase & Readonly<{ outcome: 'allow' }>)
  | (LifecycleInterceptorExecutionBase &
      Readonly<{
        outcome: 'deny';
        reason: string;
        handlerId?: string;
      }>)
  | (LifecycleInterceptorExecutionBase &
      Readonly<{
        outcome: 'require_approval';
        reason: string;
        approvalKey: string;
        handlerId: string;
      }>);

type InterceptorFailureReason =
  | 'lifecycle_interceptor_error'
  | 'lifecycle_interceptor_timeout'
  | 'lifecycle_interceptor_total_timeout';

interface DeadlineExceeded {
  readonly kind: 'handler' | 'total';
  readonly durationMs: number;
}

/** At most 32 resolved handlers may each emit the contract maximum of 32 signals. */
const MAX_INTERCEPTOR_TERMINAL_SIGNALS = 1_024;

function compareHandlers(left: ResolvedLifecycleHandler, right: ResolvedLifecycleHandler): number {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }
  return left.handler.id < right.handler.id ? -1 : left.handler.id > right.handler.id ? 1 : 0;
}

/** Parsed handler results originate from the contract materializer, so freezing
 * them must not reinterpret bounded dynamic records through an output shape. */
function freezeTrustedSnapshot<T>(value: T): T | undefined {
  try {
    const pending: object[] = [];
    if (value && typeof value === 'object') pending.push(value as object);
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
        const nested: unknown = 'value' in descriptor ? descriptor.value : undefined;
        if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) {
          pending.push(nested);
        }
      }
      Object.freeze(current);
    }
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Inputs and signal entries have already crossed a bounded materialization
 * boundary. Terminal completion therefore only needs a fixed-shape outer
 * snapshot and a bounded signal-list copy; it must never rediscover dynamic
 * record keys after the execution deadline has elapsed.
 */
function terminalSnapshot(
  execution: LifecycleInterceptorExecution,
): LifecycleInterceptorExecution | undefined {
  if (execution.signals.length > MAX_INTERCEPTOR_TERMINAL_SIGNALS) {
    return undefined;
  }
  const signals: LifecycleSignalEnvelope[] = [];
  for (let index = 0; index < execution.signals.length; index += 1) {
    signals.push(execution.signals[index]);
  }
  Object.freeze(signals);
  switch (execution.outcome) {
    case 'allow':
      return Object.freeze({ outcome: 'allow' as const, input: execution.input, signals });
    case 'deny':
      return Object.freeze({
        outcome: 'deny' as const,
        reason: execution.reason,
        ...(execution.handlerId ? { handlerId: execution.handlerId } : {}),
        input: execution.input,
        signals,
      });
    case 'require_approval':
      return Object.freeze({
        outcome: 'require_approval' as const,
        reason: execution.reason,
        approvalKey: execution.approvalKey,
        handlerId: execution.handlerId,
        input: execution.input,
        signals,
      });
  }
}

function isNativePromise(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    !types.isProxy(value) &&
    types.isPromise(value)
  );
}

/**
 * Look up a native implementation by the immutable runtime reference captured
 * in the resolved identity. Descriptors avoid inherited implementations and
 * accessor execution at this authority boundary.
 */
function findNativeImplementation(
  implementations: Readonly<Record<string, LifecycleInterceptorHandler>>,
  implementationRef: string,
): LifecycleInterceptorHandler | undefined {
  try {
    if (types.isProxy(implementations)) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(implementations, implementationRef);
    return descriptor &&
      'value' in descriptor &&
      typeof descriptor.value === 'function' &&
      !types.isProxy(descriptor.value)
      ? (descriptor.value as LifecycleInterceptorHandler)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The engine's implementation map is bootstrap authority. Never let an
 * implementationRef collision turn a subagent (or a forged resolved handler)
 * into a native interceptor: both identity fields must be canonical own data.
 */
function captureNativeImplementationRef(handler: unknown): string | undefined {
  try {
    if (!handler || typeof handler !== 'object' || types.isProxy(handler)) {
      return undefined;
    }
    const identityDescriptor = Object.getOwnPropertyDescriptor(handler, 'identity');
    if (!identityDescriptor || !('value' in identityDescriptor)) {
      return undefined;
    }
    const identity: unknown = identityDescriptor.value;
    if (!identity || typeof identity !== 'object' || types.isProxy(identity)) {
      return undefined;
    }
    const kindDescriptor = Object.getOwnPropertyDescriptor(identity, 'runtimeKind');
    const refDescriptor = Object.getOwnPropertyDescriptor(identity, 'implementationRef');
    return kindDescriptor &&
      'value' in kindDescriptor &&
      kindDescriptor.value === 'native' &&
      refDescriptor &&
      'value' in refDescriptor &&
      typeof refDescriptor.value === 'string'
      ? refDescriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `types.isPromise` rejects thenables and is checked before reflection. The
 * captured intrinsic method bypasses instance `then`/`catch` overrides; a
 * proxy is never passed to it because proxy reflection is trap-capable.
 */
function isDrainableIntrinsicPromise(promise: Promise<unknown>): boolean {
  try {
    return !types.isProxy(promise) && types.isPromise(promise);
  } catch {
    return false;
  }
}

/** Returns whether the original rejection is known to have a safe reaction. */
function drainNativePromiseRejection(promise: Promise<unknown>): boolean {
  if (!isDrainableIntrinsicPromise(promise)) {
    return false;
  }
  try {
    // Both operations were captured before any handler runs. The intrinsic
    // Promise path creates an intrinsic reaction Promise and the rejection
    // callback resolves it, so no secondary rejection is introduced.
    void IntrinsicReflectApply(IntrinsicPromiseThen, promise, [
      undefined,
      (): undefined => undefined,
    ]);
    return true;
  } catch {
    // Species construction can make intrinsic `then` unavailable before a
    // rejection reaction is attached. This is a violation of the trusted
    // synchronous native-handler contract; global rejection ownership would
    // alter daemon-wide fatal-error semantics, so it is intentionally refused.
    return false;
  }
}

function transformMetadata(transform: LifecycleInterceptorTransform): Record<string, unknown> {
  switch (transform.hook) {
    case 'message.before_persist':
    case 'message.before_send':
      return {
        kind: 'message_content',
        fieldCount: 1,
        contentLength: transform.content?.length ?? 0,
      };
    case 'run.before_execute':
      return {
        kind: 'run',
        fieldCount:
          Number(transform.provider !== undefined) +
          Number(transform.model !== undefined) +
          Number(transform.contextAdditions !== undefined),
        contextAdditionCount: Object.keys(transform.contextAdditions ?? {}).length,
      };
    case 'tool.before_execute':
      return transform.arguments !== undefined
        ? { kind: 'tool_arguments_replace', fieldCount: Object.keys(transform.arguments).length }
        : {
            kind: 'tool_arguments_patch',
            fieldCount: Object.keys(transform.argumentsPatch ?? {}).length,
          };
  }
}

function normalizeInput(input: unknown): LifecycleInterceptorEnvelope | undefined {
  const contract = resolveLifecycleHandlerContract(
    LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT,
    'talon.lifecycle.enforcing.interceptor.output.v1',
  );
  const parsed = contract?.parseInput(input);
  return parsed?.success ? (parsed.data as LifecycleInterceptorEnvelope) : undefined;
}

function encodeTrustedInputForContract(input: LifecycleInterceptorEnvelope): unknown {
  return input;
}

function applyTransform(
  input: LifecycleInterceptorEnvelope,
  transform: LifecycleInterceptorTransform,
): LifecycleInterceptorEnvelope | undefined {
  if (input.hook !== transform.hook) {
    return undefined;
  }

  let candidate: unknown;
  switch (transform.hook) {
    case 'message.before_persist':
    case 'message.before_send':
      candidate = { ...input, input: { ...input.input, content: transform.content } };
      break;
    case 'run.before_execute': {
      const runInput = input as Extract<
        LifecycleInterceptorEnvelope,
        { hook: 'run.before_execute' }
      >;
      candidate = {
        ...input,
        input: {
          ...runInput.input,
          ...(transform.provider !== undefined ? { provider: transform.provider } : {}),
          ...(transform.model !== undefined ? { model: transform.model } : {}),
          ...(transform.contextAdditions !== undefined
            ? {
                contextAdditions: {
                  ...(runInput.input.contextAdditions ?? {}),
                  ...transform.contextAdditions,
                },
              }
            : {}),
        },
      };
      break;
    }
    case 'tool.before_execute': {
      const toolInput = input as Extract<
        LifecycleInterceptorEnvelope,
        { hook: 'tool.before_execute' }
      >;
      candidate = {
        ...input,
        input: {
          ...toolInput.input,
          arguments: transform.arguments ?? {
            ...toolInput.input.arguments,
            ...transform.argumentsPatch,
          },
        },
      };
      break;
    }
  }

  // Contract parsing materializes a new detached, deep-frozen snapshot.
  return normalizeInput(encodeTrustedInputForContract(candidate as LifecycleInterceptorEnvelope));
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/**
 * Executes registry-resolved native interceptors synchronously. JavaScript
 * cannot preempt a blocked call, so every subsequent non-preemptible stage is
 * deadline-checked before it can commit signals, transforms, or a decision.
 */
export class LifecycleInterceptorEngine {
  private readonly clock: LifecycleInterceptorClock;
  private readonly totalTimeoutMs: number;
  private readonly defaultHandlerTimeoutMs: number;

  constructor(private readonly options: LifecycleInterceptorEngineOptions) {
    this.clock = options.clock ?? { now: (): number => performance.now() };
    this.totalTimeoutMs = boundedTimeout(
      options.totalTimeoutMs,
      DEFAULT_LIFECYCLE_INTERCEPTOR_TOTAL_TIMEOUT_MS,
    );
    this.defaultHandlerTimeoutMs = boundedTimeout(
      options.defaultHandlerTimeoutMs,
      DEFAULT_LIFECYCLE_INTERCEPTOR_HANDLER_TIMEOUT_MS,
    );
  }

  intercept(
    invocation: LifecycleInterceptorInvocation,
    rawInput: unknown,
  ): Result<LifecycleInterceptorExecution, LifecycleError> {
    const input = normalizeInput(rawInput);
    if (!input) {
      return err(new LifecycleError('invalid lifecycle interceptor input'));
    }
    if (input.hook !== invocation.hook) {
      return err(new LifecycleError('interceptor invocation hook does not match input hook'));
    }

    const startedAt = this.clock.now();

    if (input.context.recursion.depth >= input.context.recursion.maxDepth) {
      this.auditSystem(input, 'deny', 'lifecycle_recursion_limit', 0);
      return this.complete(
        { outcome: 'deny', reason: 'lifecycle_recursion_limit', input, signals: [] },
        startedAt,
        [],
      );
    }

    let handlers: readonly ResolvedLifecycleHandler[];
    try {
      handlers = [...this.options.resolveHandlers(invocation)].sort(compareHandlers);
    } catch {
      return err(new LifecycleError('failed to resolve lifecycle interceptor handlers'));
    }

    let current = input;
    const signals: LifecycleSignalEnvelope[] = [];
    const finish = (
      execution: LifecycleInterceptorExecution,
      unresolved: readonly ResolvedLifecycleHandler[],
    ): Result<LifecycleInterceptorExecution, LifecycleError> =>
      this.complete(execution, startedAt, unresolved);

    for (let index = 0; index < handlers.length; index += 1) {
      const handler = handlers[index];
      const unresolved = handlers.slice(index);
      const handlerStartedAt = this.clock.now();
      const beforeInvocation = this.deadline(handler, startedAt, handlerStartedAt);
      if (beforeInvocation) {
        const result = this.timeoutResult(handler, current, signals, unresolved, beforeInvocation);
        if (beforeInvocation.kind === 'total' || result.outcome !== 'allow') {
          return finish(result, unresolved);
        }
        continue;
      }

      const implementationRef = captureNativeImplementationRef(handler);
      const implementation = implementationRef
        ? findNativeImplementation(this.options.implementations, implementationRef)
        : undefined;
      let rawResult: unknown;
      let failed = false;
      try {
        rawResult = implementation?.(current);
        if (!implementation) {
          failed = true;
        } else if (isNativePromise(rawResult)) {
          // Reject async handlers at this synchronous boundary, while draining
          // every genuine non-proxy Promise through the captured intrinsic
          // reaction so rejected subclasses cannot escape as unhandled.
          void drainNativePromiseRejection(rawResult);
          failed = true;
        }
      } catch {
        failed = true;
      }

      let deadline = this.deadline(handler, startedAt, handlerStartedAt);
      if (deadline) {
        const result = this.timeoutResult(handler, current, signals, unresolved, deadline);
        if (deadline.kind === 'total' || result.outcome !== 'allow') {
          return finish(result, unresolved);
        }
        continue;
      }
      const parsed = !failed
        ? parseLifecycleHandlerResult(
            handler.handler,
            encodeTrustedInputForContract(current),
            rawResult,
          )
        : undefined;
      deadline = this.deadline(handler, startedAt, handlerStartedAt);
      if (deadline) {
        const result = this.timeoutResult(handler, current, signals, unresolved, deadline);
        if (deadline.kind === 'total' || result.outcome !== 'allow') {
          return finish(result, unresolved);
        }
        continue;
      }
      if (!parsed || !parsed.success || parsed.data.outcome === 'error') {
        const result = this.handleFailure(
          handler,
          current,
          signals,
          'lifecycle_interceptor_error',
          'error',
          this.elapsed(handlerStartedAt),
          false,
        );
        deadline = this.deadline(handler, startedAt, handlerStartedAt);
        if (deadline) {
          const timeoutResult = this.timeoutResult(handler, current, signals, unresolved, deadline);
          if (deadline.kind === 'total' || timeoutResult.outcome !== 'allow') {
            return finish(timeoutResult, unresolved);
          }
          continue;
        }
        this.audit(
          handler,
          current,
          'error',
          'lifecycle_interceptor_error',
          this.elapsed(handlerStartedAt),
        );
        if (result.outcome !== 'allow') {
          return finish(result, unresolved);
        }
        continue;
      }

      const outputSignals = freezeTrustedSnapshot(
        parsed.data.outputContract === 'talon.lifecycle.signal.envelopes.v1'
          ? parsed.data.signals
          : parsed.data.result.signals,
      ) as readonly LifecycleSignalEnvelope[] | undefined;
      deadline = this.deadline(handler, startedAt, handlerStartedAt);
      if (deadline) {
        const result = this.timeoutResult(handler, current, signals, unresolved, deadline);
        if (deadline.kind === 'total' || result.outcome !== 'allow') {
          return finish(result, unresolved);
        }
        continue;
      }
      if (!outputSignals) {
        const result = this.handleFailure(
          handler,
          current,
          signals,
          'lifecycle_interceptor_error',
          'error',
          this.elapsed(handlerStartedAt),
          false,
        );
        deadline = this.deadline(handler, startedAt, handlerStartedAt);
        if (deadline) {
          const timeoutResult = this.timeoutResult(handler, current, signals, unresolved, deadline);
          if (deadline.kind === 'total' || timeoutResult.outcome !== 'allow') {
            return finish(timeoutResult, unresolved);
          }
          continue;
        }
        this.audit(
          handler,
          current,
          'error',
          'lifecycle_interceptor_error',
          this.elapsed(handlerStartedAt),
        );
        if (result.outcome !== 'allow') {
          return finish(result, unresolved);
        }
        continue;
      }

      if (parsed.data.outputContract === 'talon.lifecycle.advisory.interceptor.output.v1') {
        const capacityFailure = this.signalCapacityFailure(
          handler,
          current,
          signals,
          outputSignals,
        );
        if (capacityFailure) {
          if (capacityFailure.outcome !== 'allow') return finish(capacityFailure, unresolved);
          continue;
        }
        this.audit(
          handler,
          current,
          'advisory',
          'handler_advisory',
          this.elapsed(handlerStartedAt),
        );
        signals.push(...outputSignals);
        continue;
      }
      if (parsed.data.outputContract !== 'talon.lifecycle.enforcing.interceptor.output.v1') {
        const result = this.handleFailure(
          handler,
          current,
          signals,
          'lifecycle_interceptor_error',
          'error',
          this.elapsed(handlerStartedAt),
          false,
        );
        deadline = this.deadline(handler, startedAt, handlerStartedAt);
        if (deadline) {
          const timeoutResult = this.timeoutResult(handler, current, signals, unresolved, deadline);
          if (deadline.kind === 'total' || timeoutResult.outcome !== 'allow') {
            return finish(timeoutResult, unresolved);
          }
          continue;
        }
        this.audit(
          handler,
          current,
          'error',
          'lifecycle_interceptor_error',
          this.elapsed(handlerStartedAt),
        );
        if (result.outcome !== 'allow') {
          return finish(result, unresolved);
        }
        continue;
      }

      const result = parsed.data.result;
      if (result.outcome === 'transform') {
        const transformed = applyTransform(current, result.transform);
        deadline = this.deadline(handler, startedAt, handlerStartedAt);
        if (deadline) {
          const timeoutResult = this.timeoutResult(handler, current, signals, unresolved, deadline);
          if (deadline.kind === 'total' || timeoutResult.outcome !== 'allow') {
            return finish(timeoutResult, unresolved);
          }
          continue;
        }
        if (!transformed) {
          const failure = this.handleFailure(
            handler,
            current,
            signals,
            'lifecycle_interceptor_error',
            'error',
            this.elapsed(handlerStartedAt),
            false,
          );
          deadline = this.deadline(handler, startedAt, handlerStartedAt);
          if (deadline) {
            const timeoutResult = this.timeoutResult(
              handler,
              current,
              signals,
              unresolved,
              deadline,
            );
            if (deadline.kind === 'total' || timeoutResult.outcome !== 'allow') {
              return finish(timeoutResult, unresolved);
            }
            continue;
          }
          this.audit(
            handler,
            current,
            'error',
            'lifecycle_interceptor_error',
            this.elapsed(handlerStartedAt),
          );
          if (failure.outcome !== 'allow') {
            return finish(failure, unresolved);
          }
          continue;
        }
        const capacityFailure = this.signalCapacityFailure(
          handler,
          current,
          signals,
          outputSignals,
        );
        if (capacityFailure) {
          if (capacityFailure.outcome !== 'allow') return finish(capacityFailure, unresolved);
          continue;
        }
        this.audit(
          handler,
          transformed,
          'transform',
          'handler_transform',
          this.elapsed(handlerStartedAt),
          result.transform,
        );
        signals.push(...outputSignals);
        current = transformed;
        continue;
      }

      if (result.outcome === 'allow') {
        const capacityFailure = this.signalCapacityFailure(
          handler,
          current,
          signals,
          outputSignals,
        );
        if (capacityFailure) {
          if (capacityFailure.outcome !== 'allow') return finish(capacityFailure, unresolved);
          continue;
        }
        this.audit(handler, current, 'allow', 'handler_allow', this.elapsed(handlerStartedAt));
        signals.push(...outputSignals);
        continue;
      }
      if (result.outcome === 'deny') {
        const capacityFailure = this.signalCapacityFailure(
          handler,
          current,
          signals,
          outputSignals,
        );
        if (capacityFailure) {
          if (capacityFailure.outcome !== 'allow') return finish(capacityFailure, unresolved);
          continue;
        }
        this.audit(handler, current, 'deny', 'handler_deny', this.elapsed(handlerStartedAt));
        signals.push(...outputSignals);
        return finish(
          {
            outcome: 'deny',
            reason: result.reason,
            handlerId: handler.identity.handlerId,
            input: current,
            signals,
          },
          handlers.slice(index + 1),
        );
      }
      if (result.outcome === 'require_approval') {
        const capacityFailure = this.signalCapacityFailure(
          handler,
          current,
          signals,
          outputSignals,
        );
        if (capacityFailure) {
          if (capacityFailure.outcome !== 'allow') return finish(capacityFailure, unresolved);
          continue;
        }
        this.audit(
          handler,
          current,
          'require_approval',
          'handler_require_approval',
          this.elapsed(handlerStartedAt),
        );
        signals.push(...outputSignals);
        return finish(
          {
            outcome: 'require_approval',
            reason: result.reason,
            approvalKey: result.approvalKey,
            handlerId: handler.identity.handlerId,
            input: current,
            signals,
          },
          handlers.slice(index + 1),
        );
      }

      const failure = this.handleFailure(
        handler,
        current,
        signals,
        'lifecycle_interceptor_error',
        'error',
        this.elapsed(handlerStartedAt),
        false,
      );
      deadline = this.deadline(handler, startedAt, handlerStartedAt);
      if (deadline) {
        const timeoutResult = this.timeoutResult(handler, current, signals, unresolved, deadline);
        if (deadline.kind === 'total' || timeoutResult.outcome !== 'allow') {
          return finish(timeoutResult, unresolved);
        }
        continue;
      }
      this.audit(
        handler,
        current,
        'error',
        'lifecycle_interceptor_error',
        this.elapsed(handlerStartedAt),
      );
      if (failure.outcome !== 'allow') {
        return finish(failure, unresolved);
      }
    }

    return finish({ outcome: 'allow', input: current, signals }, []);
  }

  private deadline(
    handler: ResolvedLifecycleHandler,
    startedAt: number,
    handlerStartedAt: number,
  ): DeadlineExceeded | undefined {
    const now = this.clock.now();
    const durationMs = Math.max(0, now - handlerStartedAt);
    if (durationMs >= boundedTimeout(handler.budget?.timeoutMs, this.defaultHandlerTimeoutMs)) {
      return { kind: 'handler', durationMs };
    }
    const totalDurationMs = Math.max(0, now - startedAt);
    if (totalDurationMs >= this.totalTimeoutMs) {
      return { kind: 'total', durationMs: totalDurationMs };
    }
    return undefined;
  }

  private elapsed(startedAt: number): number {
    return Math.max(0, this.clock.now() - startedAt);
  }

  private timeoutResult(
    handler: ResolvedLifecycleHandler,
    input: LifecycleInterceptorEnvelope,
    signals: readonly LifecycleSignalEnvelope[],
    unresolved: readonly ResolvedLifecycleHandler[],
    deadline: DeadlineExceeded,
    audit = true,
  ): LifecycleInterceptorExecution {
    if (deadline.kind === 'total') {
      return this.handleAggregateTimeout(input, signals, unresolved, deadline.durationMs, audit);
    }
    return this.handleFailure(
      handler,
      input,
      signals,
      'lifecycle_interceptor_timeout',
      'timeout',
      deadline.durationMs,
      audit,
    );
  }

  private handleAggregateTimeout(
    input: LifecycleInterceptorEnvelope,
    signals: readonly LifecycleSignalEnvelope[],
    unresolved: readonly ResolvedLifecycleHandler[],
    durationMs: number,
    audit = true,
  ): LifecycleInterceptorExecution {
    const enforcingRemaining = unresolved.filter(
      (handler) => handler.identity.interceptorSafety === 'enforcing',
    );
    const outcome = enforcingRemaining.length > 0 ? 'deny' : 'allow';
    if (audit) {
      this.auditSystem(input, outcome, 'lifecycle_interceptor_total_timeout', durationMs, {
        unresolvedEnforcingHandlers: enforcingRemaining.length,
      });
    }
    return outcome === 'deny'
      ? { outcome, reason: 'lifecycle_interceptor_total_timeout', input, signals }
      : { outcome, input, signals };
  }

  private handleFailure(
    handler: ResolvedLifecycleHandler,
    input: LifecycleInterceptorEnvelope,
    signals: readonly LifecycleSignalEnvelope[],
    reason: InterceptorFailureReason,
    decision: 'error' | 'timeout',
    durationMs: number,
    audit = true,
  ): LifecycleInterceptorExecution {
    if (audit) this.audit(handler, input, decision, reason, durationMs);
    return handler.failurePolicy.mode === 'fail_open'
      ? { outcome: 'allow', input, signals }
      : { outcome: 'deny', reason, handlerId: handler.identity.handlerId, input, signals };
  }

  private signalCapacityFailure(
    handler: ResolvedLifecycleHandler,
    input: LifecycleInterceptorEnvelope,
    signals: readonly LifecycleSignalEnvelope[],
    outputSignals: readonly LifecycleSignalEnvelope[],
  ): LifecycleInterceptorExecution | undefined {
    return signals.length + outputSignals.length > MAX_INTERCEPTOR_TERMINAL_SIGNALS
      ? this.handleFailure(handler, input, signals, 'lifecycle_interceptor_error', 'error', 0)
      : undefined;
  }

  private isAggregateTimeout(execution: LifecycleInterceptorExecution): boolean {
    return (
      execution.outcome === 'deny' &&
      execution.reason === 'lifecycle_interceptor_total_timeout' &&
      execution.handlerId === undefined
    );
  }

  private complete(
    execution: LifecycleInterceptorExecution,
    startedAt: number,
    unresolved: readonly ResolvedLifecycleHandler[],
  ): Result<LifecycleInterceptorExecution, LifecycleError> {
    const beforeMaterializationMs = Math.max(0, this.clock.now() - startedAt);
    // An aggregate timeout was already selected and audited at a checked
    // execution boundary. Do not replace it merely because snapshotting is
    // later than the deadline.
    const alreadyAggregateTimeout = this.isAggregateTimeout(execution);
    // A current handler has already made a restrictive terminal decision.
    // Deadline accounting can prevent further work, but must never weaken
    // deny/approval/fail-closed/recursion outcomes into an aggregate allow.
    if (execution.outcome !== 'allow') {
      const snapshot = terminalSnapshot(execution);
      return snapshot
        ? ok(snapshot)
        : err(new LifecycleError('failed to materialize lifecycle interceptor execution'));
    }
    if (beforeMaterializationMs >= this.totalTimeoutMs && !alreadyAggregateTimeout) {
      // Completion is deliberately non-recursive and audit-free: this is the
      // post-deadline fallback and a synchronous audit sink could block again.
      const timeout = this.handleAggregateTimeout(
        execution.input,
        execution.signals,
        unresolved,
        beforeMaterializationMs,
        false,
      );
      const timeoutSnapshot = terminalSnapshot(timeout);
      return timeoutSnapshot
        ? ok(timeoutSnapshot)
        : err(new LifecycleError('failed to materialize lifecycle interceptor timeout execution'));
    }
    const snapshot = terminalSnapshot(execution);
    if (!snapshot) {
      return err(new LifecycleError('failed to materialize lifecycle interceptor execution'));
    }

    const durationMs = Math.max(0, this.clock.now() - startedAt);
    if (alreadyAggregateTimeout || durationMs < this.totalTimeoutMs) {
      return ok(snapshot);
    }

    // Do not recurse through `complete`: the timeout terminal result uses the
    // same already-trusted input and bounded signal references, and one fixed
    // shape snapshot is sufficient after the deadline is exhausted.
    const timeout = this.handleAggregateTimeout(
      snapshot.input,
      snapshot.signals,
      unresolved,
      durationMs,
      false,
    );
    const timeoutSnapshot = terminalSnapshot(timeout);
    return timeoutSnapshot
      ? ok(timeoutSnapshot)
      : err(new LifecycleError('failed to materialize lifecycle interceptor timeout execution'));
  }

  private audit(
    handler: ResolvedLifecycleHandler,
    input: LifecycleInterceptorEnvelope,
    decision: string,
    reason: string,
    durationMs: number,
    transform?: LifecycleInterceptorTransform,
  ): void {
    try {
      this.options.auditLogger?.logLifecycleInterceptor({
        action: 'lifecycle.interceptor',
        details: {
          handlerId: handler.identity.handlerId,
          implementationRef: handler.identity.implementationRef,
          implementationVersion: handler.identity.implementationVersion,
          hook: input.hook,
          decision,
          reason,
          durationMs: Math.floor(durationMs),
          ...(transform ? { transform: transformMetadata(transform) } : {}),
        },
      });
    } catch {
      // Audit storage outages must not make a synchronous policy decision nondeterministic.
    }
    try {
      (this.options.telemetry ?? noopLifecycleTelemetry).recordInterceptorDecision({
        handler,
        envelope: input,
        decision,
        reason,
        durationMs,
        ...(transform ? { transform } : {}),
      });
    } catch {
      // Telemetry outages must not make a synchronous policy decision nondeterministic.
    }
  }

  private auditSystem(
    input: LifecycleInterceptorEnvelope,
    decision: string,
    reason: string,
    durationMs: number,
    details: Record<string, unknown> = {},
  ): void {
    try {
      this.options.auditLogger?.logLifecycleInterceptor({
        action: 'lifecycle.interceptor',
        details: {
          handlerId: 'lifecycle-engine',
          hook: input.hook,
          decision,
          reason,
          durationMs: Math.floor(durationMs),
          ...details,
        },
      });
    } catch {
      // See `audit`: audit failures do not change enforcement semantics.
    }
    try {
      (this.options.telemetry ?? noopLifecycleTelemetry).recordInterceptorDecision({
        envelope: input,
        decision,
        reason,
        durationMs,
      });
    } catch {
      // See `audit`.
    }
  }
}
