/** Independent, durable scheduler for lifecycle handler deliveries. */

import { err, ok, type Result } from 'neverthrow';
import { types } from 'node:util';
import { LifecycleError } from '../core/errors/index.js';
import type {
  ClaimedLifecycleDelivery,
  LifecycleDeliveryRepository,
  LifecycleDeliveryRow,
} from '../core/database/repositories/lifecycle-delivery-repository.js';
import {
  LifecycleFailurePolicyContractSchema,
  type LifecycleHandlerResult,
} from './contracts/index.js';
import {
  createLifecycleDispatcherPolicy,
  lifecycleRetryDelay,
  type LifecycleDispatcherPolicy,
  type LifecycleDispatcherPolicyInput,
} from './dispatcher-policy.js';
import {
  materializeLifecycleHandlerExecution,
  type LifecycleHandlerExecutor,
} from './handler-executor.js';

export interface LifecycleDispatcherClock {
  now(): number;
}

export interface LifecycleSignalHandoff {
  readonly eventId: string;
  readonly handlerId: string;
  /** Persisted delivery ownership; signals must never escape this persona scope. */
  readonly persona: string;
  /** Stable key lets the durable projection boundary de-duplicate crash recovery. */
  readonly idempotencyKey: string;
  readonly signals: readonly unknown[];
}

/** Trusted durable boundary. It must acknowledge idempotently before completion may occur. */
export interface LifecycleSignalRouter {
  handoff(handoff: LifecycleSignalHandoff): Promise<Result<void, LifecycleError>>;
}

export interface LifecycleDispatcherSnapshot {
  readonly running: boolean;
  readonly stopping: boolean;
  readonly inFlight: number;
  readonly handlers: readonly LifecycleDispatcherHandlerSnapshot[];
}

export interface LifecycleDispatcherHandlerSnapshot {
  readonly handlerId: string;
  readonly inFlight: number;
  readonly circuit: 'closed' | 'open';
  readonly openUntil?: number;
}

export interface LifecycleDispatcherOptions {
  readonly deliveries: Pick<LifecycleDeliveryRepository, 'claimNext' | 'complete' | 'fail'>;
  readonly executor: LifecycleHandlerExecutor;
  readonly signalRouter: LifecycleSignalRouter;
  readonly policy?: LifecycleDispatcherPolicyInput;
  readonly clock?: LifecycleDispatcherClock;
}

interface LifecycleDispatcherAuthority {
  readonly claimNext: LifecycleDeliveryRepository['claimNext'];
  readonly complete: LifecycleDeliveryRepository['complete'];
  readonly fail: LifecycleDeliveryRepository['fail'];
  readonly execute: LifecycleHandlerExecutor['execute'];
  readonly handoff: LifecycleSignalRouter['handoff'];
  readonly now: LifecycleDispatcherClock['now'];
}

interface HandlerState {
  inFlight: number;
  consecutiveFailures: number;
  openUntil: number;
}

interface Lease {
  readonly eventId: string;
  readonly handlerId: string;
  readonly claimToken: string;
}

class InFlightSlot {
  private pending = 1;
  private resolveSettled!: () => void;
  readonly settled = new Promise<void>((resolve) => {
    this.resolveSettled = resolve;
  });

  holdExecution(): void {
    this.pending += 1;
  }

  release(): void {
    this.pending -= 1;
    if (this.pending === 0) this.resolveSettled();
  }
}

const FAILURE_EXECUTION = 'handler-execution-failed';
const FAILURE_INVALID = 'invalid-persisted-execution';
const FAILURE_RESULT = 'handler-reported-error';
const FAILURE_TIMEOUT = 'handler-timeout';
const FAILURE_SIGNAL_HANDOFF = 'signal-handoff-failed';
const MAX_EXCLUDED_HANDLERS = 4_096;

function resultSignals(result: LifecycleHandlerResult): readonly unknown[] {
  if (result.outcome === 'error') return [];
  return result.outputContract === 'talon.lifecycle.signal.envelopes.v1'
    ? result.signals
    : result.result.signals;
}

function failureMode(delivery: LifecycleDeliveryRow): 'dead_letter' | 'preserve_session' {
  try {
    const parsed = LifecycleFailurePolicyContractSchema.safeParse(
      JSON.parse(delivery.failure_policy),
    );
    return parsed.success && parsed.data.mode === 'preserve_session'
      ? 'preserve_session'
      : 'dead_letter';
  } catch {
    return 'dead_letter';
  }
}

const MAX_DISPATCHER_OPTION_KEYS = 5;
const MAX_AUTHORITY_PROTOTYPE_DEPTH = 16;

function boundMethod<T extends (...args: never[]) => unknown>(
  source: unknown,
  key: PropertyKey,
): T | undefined {
  try {
    if (!source || typeof source !== 'object' || types.isProxy(source)) return undefined;
    let current: object | null = source;
    for (let depth = 0; current && depth <= MAX_AUTHORITY_PROTOTYPE_DEPTH; depth += 1) {
      if (types.isProxy(current)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        const candidate: unknown = 'value' in descriptor ? descriptor.value : undefined;
        if (
          !('value' in descriptor) ||
          typeof candidate !== 'function' ||
          types.isProxy(candidate)
        ) {
          return undefined;
        }
        const callable = candidate as (...args: never[]) => unknown;
        return Function.prototype.bind.call(callable, source) as T;
      }
      const prototype: unknown = Object.getPrototypeOf(current);
      if (prototype !== null && typeof prototype !== 'object') return undefined;
      current = prototype;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function materializeDispatcherOptions(
  input: unknown,
): Readonly<{ authority: LifecycleDispatcherAuthority; policy: unknown }> | undefined {
  try {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      types.isProxy(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      return undefined;
    }
    // Bound keys before descriptors: this is the public hostile-input fence.
    const keys = Reflect.ownKeys(input);
    const allowed = new Set(['deliveries', 'executor', 'signalRouter', 'policy', 'clock']);
    if (
      keys.length > MAX_DISPATCHER_OPTION_KEYS ||
      keys.some((key) => typeof key !== 'string' || !allowed.has(key))
    ) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const deliveries = descriptors.deliveries;
    const executor = descriptors.executor;
    const signalRouter = descriptors.signalRouter;
    const policy = descriptors.policy;
    const clock = descriptors.clock;
    if (
      !deliveries ||
      !('value' in deliveries) ||
      !deliveries.enumerable ||
      !executor ||
      !('value' in executor) ||
      !executor.enumerable ||
      !signalRouter ||
      !('value' in signalRouter) ||
      !signalRouter.enumerable ||
      (policy && (!('value' in policy) || !policy.enumerable)) ||
      (clock && (!('value' in clock) || !clock.enumerable))
    ) {
      return undefined;
    }
    const deliveriesValue: unknown = deliveries.value;
    const executorValue: unknown = executor.value;
    const signalRouterValue: unknown = signalRouter.value;
    const policyValue: unknown = policy && 'value' in policy ? policy.value : undefined;
    const clockValue: unknown = clock && 'value' in clock ? clock.value : undefined;
    const claimNext = boundMethod<LifecycleDeliveryRepository['claimNext']>(
      deliveriesValue,
      'claimNext',
    );
    const complete = boundMethod<LifecycleDeliveryRepository['complete']>(
      deliveriesValue,
      'complete',
    );
    const fail = boundMethod<LifecycleDeliveryRepository['fail']>(deliveriesValue, 'fail');
    const execute = boundMethod<LifecycleHandlerExecutor['execute']>(executorValue, 'execute');
    const handoff = boundMethod<LifecycleSignalRouter['handoff']>(signalRouterValue, 'handoff');
    const now = clock ? boundMethod<LifecycleDispatcherClock['now']>(clockValue, 'now') : Date.now;
    if (!claimNext || !complete || !fail || !execute || !handoff || !now) return undefined;
    return Object.freeze({
      authority: Object.freeze({ claimNext, complete, fail, execute, handoff, now }),
      policy: policyValue,
    });
  } catch {
    return undefined;
  }
}

function safeClaimValue(value: unknown): ClaimedLifecycleDelivery | null | undefined {
  try {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || keys.some((key) => key !== 'delivery' && key !== 'event')) {
      return undefined;
    }
    const delivery = Object.getOwnPropertyDescriptor(value, 'delivery');
    const event = Object.getOwnPropertyDescriptor(value, 'event');
    if (
      !delivery ||
      !('value' in delivery) ||
      !delivery.enumerable ||
      !event ||
      !('value' in event) ||
      !event.enumerable ||
      !delivery.value ||
      typeof delivery.value !== 'object' ||
      types.isProxy(delivery.value) ||
      !event.value ||
      typeof event.value !== 'object' ||
      types.isProxy(event.value)
    ) {
      return undefined;
    }
    return value as ClaimedLifecycleDelivery;
  } catch {
    return undefined;
  }
}

function inspectClaimResult(
  value: unknown,
): Result<ClaimedLifecycleDelivery | null, LifecycleError> {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value)) {
      return err(new LifecycleError('failed to claim lifecycle delivery'));
    }
    const isErr = boundMethod<() => unknown>(value, 'isErr');
    const isOk = boundMethod<() => unknown>(value, 'isOk');
    if (!isErr || !isOk || isErr() !== false || isOk() !== true) {
      return err(new LifecycleError('failed to claim lifecycle delivery'));
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, 'value');
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      return err(new LifecycleError('failed to claim lifecycle delivery'));
    }
    const claim = safeClaimValue(descriptor.value);
    return claim === undefined
      ? err(new LifecycleError('failed to claim lifecycle delivery'))
      : ok(claim);
  } catch {
    return err(new LifecycleError('failed to claim lifecycle delivery'));
  }
}

function safeClaimHandlerId(claim: ClaimedLifecycleDelivery): string | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(claim.delivery, 'handler_id');
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Poll/wake dispatcher. Lease tokens remain private to this class; handlers
 * receive only frozen detached event data and an AbortSignal.
 */
export class LifecycleDispatcher {
  private readonly clock: LifecycleDispatcherClock;
  private readonly handlers = new Map<string, HandlerState>();
  private readonly active = new Set<InFlightSlot>();
  private readonly controllers = new Set<AbortController>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopping = false;
  private draining = false;
  private wakeRequested = false;

  private constructor(
    private readonly authority: LifecycleDispatcherAuthority,
    private readonly policy: LifecycleDispatcherPolicy,
  ) {
    this.clock = Object.freeze({ now: authority.now });
  }

  static create(options: LifecycleDispatcherOptions): Result<LifecycleDispatcher, LifecycleError> {
    try {
      const materialized = materializeDispatcherOptions(options);
      if (!materialized) return err(new LifecycleError('invalid lifecycle dispatcher options'));
      const policy = createLifecycleDispatcherPolicy(
        materialized.policy as LifecycleDispatcherPolicyInput,
      );
      if (policy.isErr()) return err(policy.error);
      return ok(new LifecycleDispatcher(materialized.authority, policy.value));
    } catch {
      return err(new LifecycleError('invalid lifecycle dispatcher options'));
    }
  }

  start(): void {
    if (this.running || this.stopping) return;
    this.running = true;
    this.wake();
  }

  wake(): void {
    if (!this.running || this.stopping) return;
    if (this.draining) {
      this.wakeRequested = true;
      return;
    }
    this.draining = true;
    void this.drain().finally(() => {
      this.draining = false;
      if (this.running && !this.stopping) {
        if (this.wakeRequested) {
          this.wakeRequested = false;
          this.wake();
        } else {
          this.schedulePoll();
        }
      }
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    this.wakeRequested = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const controller of this.controllers) controller.abort();
    let shutdownTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.active].map((slot) => slot.settled)).then(() => undefined),
        new Promise<void>((resolve) => {
          shutdownTimer = setTimeout(resolve, this.policy.shutdownTimeoutMs);
        }),
      ]);
    } finally {
      if (shutdownTimer) clearTimeout(shutdownTimer);
      this.stopping = false;
    }
  }

  snapshot(): LifecycleDispatcherSnapshot {
    const now = this.clock.now();
    this.pruneHandlerStates(now);
    const handlers = [...this.handlers.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, this.policy.maxSnapshotHandlers)
      .map(([handlerId, state]) =>
        Object.freeze({
          handlerId,
          inFlight: state.inFlight,
          circuit: state.openUntil > now ? ('open' as const) : ('closed' as const),
          ...(state.openUntil > now ? { openUntil: state.openUntil } : {}),
        }),
      );
    return Object.freeze({
      running: this.running,
      stopping: this.stopping,
      inFlight: this.active.size,
      handlers: Object.freeze(handlers),
    });
  }

  dispatchOnce(): Promise<Result<boolean, LifecycleError>> {
    if (this.stopping || this.active.size >= this.policy.maxConcurrency) {
      return Promise.resolve(ok(false));
    }
    const excludedHandlerIds = this.excludedHandlerIds();
    let rawClaim: unknown;
    try {
      rawClaim = this.authority.claimNext({
        leaseMs: this.policy.leaseMs,
        ...(excludedHandlerIds.length > 0 ? { excludedHandlerIds } : {}),
      });
    } catch {
      return Promise.resolve(err(new LifecycleError('failed to claim lifecycle delivery')));
    }
    const claim = inspectClaimResult(rawClaim);
    if (claim.isErr())
      return Promise.resolve(err(new LifecycleError('failed to claim lifecycle delivery')));
    if (!claim.value) return Promise.resolve(ok(false));
    const handlerId = safeClaimHandlerId(claim.value);
    if (!handlerId)
      return Promise.resolve(err(new LifecycleError('failed to claim lifecycle delivery')));
    const state = this.handlerState(handlerId);
    const controller = new AbortController();
    const slot = new InFlightSlot();
    this.active.add(slot);
    this.controllers.add(controller);
    state.inFlight += 1;
    void slot.settled.then(() => {
      state.inFlight -= 1;
      this.active.delete(slot);
      this.controllers.delete(controller);
      if (this.running && !this.stopping) this.wake();
    });
    void this.executeClaim(claim.value, handlerId, controller, slot);
    return Promise.resolve(ok(true));
  }

  private async drain(): Promise<void> {
    do {
      this.wakeRequested = false;
      while (!this.stopping && this.active.size < this.policy.maxConcurrency) {
        const dispatched = await this.dispatchOnce();
        if (dispatched.isErr() || !dispatched.value) break;
      }
    } while (!this.stopping && this.wakeRequested && this.active.size < this.policy.maxConcurrency);
  }

  private async executeClaim(
    claim: ClaimedLifecycleDelivery,
    handlerId: string,
    controller: AbortController,
    slot: InFlightSlot,
  ): Promise<void> {
    let lease: Lease | undefined;
    try {
      lease = this.lease(claim.delivery);
      if (!lease) return;
      const execution = materializeLifecycleHandlerExecution(claim, controller.signal);
      if (execution.isErr()) {
        this.transitionFailure(claim.delivery, lease, FAILURE_INVALID, true);
        this.recordFailure(handlerId);
        return;
      }
      const result = await this.executeBounded(execution.value, controller, slot);
      if (result.isErr()) {
        this.transitionFailure(
          claim.delivery,
          lease,
          controller.signal.aborted ? FAILURE_TIMEOUT : FAILURE_EXECUTION,
          true,
        );
        this.recordFailure(handlerId);
        return;
      }
      if (result.value.outcome === 'error') {
        this.transitionFailure(claim.delivery, lease, FAILURE_RESULT, result.value.retryable);
        this.recordFailure(handlerId);
        return;
      }
      const handoff = await this.authority.handoff({
        eventId: lease.eventId,
        handlerId: lease.handlerId,
        persona: claim.delivery.persona,
        idempotencyKey: execution.value.idempotencyKey,
        signals: resultSignals(result.value),
      });
      if (handoff.isErr()) {
        this.transitionFailure(claim.delivery, lease, FAILURE_SIGNAL_HANDOFF, true);
        this.recordFailure(handlerId);
        return;
      }
      // Handoff precedes completion. If we crash here, the next lease retries
      // the same stable handoff key and the trusted boundary de-duplicates it.
      const completed = this.authority.complete(lease.eventId, lease.handlerId, lease.claimToken);
      if (completed.isOk()) this.recordSuccess(handlerId);
    } catch {
      if (lease) this.transitionFailure(claim.delivery, lease, FAILURE_EXECUTION, true);
      this.recordFailure(handlerId);
    } finally {
      slot.release();
    }
  }

  private async executeBounded(
    execution: Parameters<LifecycleHandlerExecutor['execute']>[0],
    controller: AbortController,
    slot: InFlightSlot,
  ): Promise<Result<LifecycleHandlerResult, LifecycleError>> {
    let timeout: NodeJS.Timeout | undefined;
    const cancelled = new Promise<Result<LifecycleHandlerResult, LifecycleError>>((resolve) => {
      controller.signal.addEventListener(
        'abort',
        () => resolve(err(new LifecycleError('lifecycle handler cancelled'))),
        { once: true },
      );
    });
    const deadline = new Promise<Result<LifecycleHandlerResult, LifecycleError>>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(err(new LifecycleError('lifecycle handler deadline exceeded')));
      }, this.policy.handlerTimeoutMs);
      timeout.unref();
    });
    let underlying: Promise<Result<LifecycleHandlerResult, LifecycleError>>;
    try {
      slot.holdExecution();
      underlying = Promise.resolve(this.authority.execute(execution));
    } catch {
      slot.release();
      return err(new LifecycleError('lifecycle handler execution failed'));
    }
    // The deadline race is deliberately not the execution lifetime. A handler
    // that ignores cancellation still occupies its capacity until its actual
    // promise settles; this handler absorbs any late resolve/reject.
    void underlying.then(
      () => slot.release(),
      () => slot.release(),
    );
    try {
      return await Promise.race([underlying, deadline, cancelled]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private transitionFailure(
    delivery: LifecycleDeliveryRow,
    lease: Lease,
    code: string,
    retryable: boolean,
  ): void {
    const preserveSession = failureMode(delivery) === 'preserve_session';
    const terminal = !retryable || delivery.attempts + 1 >= delivery.max_attempts;
    if (preserveSession && terminal) {
      this.authority.complete(lease.eventId, lease.handlerId, lease.claimToken);
      return;
    }
    const nextRetryAt = this.clock.now() + lifecycleRetryDelay(delivery.attempts, this.policy);
    this.authority.fail(
      lease.eventId,
      lease.handlerId,
      lease.claimToken,
      { code },
      nextRetryAt,
      retryable,
    );
  }

  private lease(delivery: LifecycleDeliveryRow): Lease | undefined {
    return delivery.claim_token
      ? Object.freeze({
          eventId: delivery.event_id,
          handlerId: delivery.handler_id,
          claimToken: delivery.claim_token,
        })
      : undefined;
  }

  private excludedHandlerIds(): string[] {
    const now = this.clock.now();
    this.pruneHandlerStates(now);
    const excluded: string[] = [];
    for (const [handlerId, state] of this.handlers) {
      if (state.inFlight >= this.policy.maxConcurrencyPerHandler || state.openUntil > now) {
        excluded.push(handlerId);
      }
    }
    // Busy handlers are globally bounded and cooling circuits are pruned only
    // after expiry, so this cannot silently make an excluded handler eligible.
    return excluded.slice(0, MAX_EXCLUDED_HANDLERS);
  }

  private pruneHandlerStates(now: number): void {
    for (const [handlerId, state] of this.handlers) {
      if (state.inFlight === 0 && state.openUntil <= now && state.consecutiveFailures === 0) {
        this.handlers.delete(handlerId);
      }
    }
  }

  private handlerState(handlerId: string): HandlerState {
    const existing = this.handlers.get(handlerId);
    if (existing) return existing;
    const state: HandlerState = { inFlight: 0, consecutiveFailures: 0, openUntil: 0 };
    this.handlers.set(handlerId, state);
    return state;
  }

  private recordSuccess(handlerId: string): void {
    const state = this.handlerState(handlerId);
    state.consecutiveFailures = 0;
    state.openUntil = 0;
  }

  private recordFailure(handlerId: string): void {
    const state = this.handlerState(handlerId);
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.policy.circuitFailureThreshold) {
      state.openUntil = this.clock.now() + this.policy.circuitCooldownMs;
    }
  }

  private schedulePoll(): void {
    if (this.timer || this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.wake();
    }, this.policy.pollIntervalMs);
    this.timer.unref();
  }
}
