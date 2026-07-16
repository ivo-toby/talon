/** Bounded, deterministic scheduling policy for durable lifecycle delivery. */

import { err, ok, type Result } from 'neverthrow';
import { types } from 'node:util';
import { LifecycleError } from '../core/errors/index.js';

export interface LifecycleDispatcherPolicy {
  readonly leaseMs: number;
  readonly pollIntervalMs: number;
  readonly maxConcurrency: number;
  readonly maxConcurrencyPerHandler: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly circuitFailureThreshold: number;
  readonly circuitCooldownMs: number;
  readonly maxSnapshotHandlers: number;
  /** A handler must be cancelled before its lease can expire. */
  readonly handlerTimeoutMs: number;
  /** Shutdown only waits for the cancellation window, never an unbounded handler. */
  readonly shutdownTimeoutMs: number;
}

export type LifecycleDispatcherPolicyInput = Partial<LifecycleDispatcherPolicy>;

export const DEFAULT_LIFECYCLE_DISPATCHER_POLICY: Readonly<LifecycleDispatcherPolicy> =
  Object.freeze({
    leaseMs: 30_000,
    pollIntervalMs: 1_000,
    maxConcurrency: 8,
    maxConcurrencyPerHandler: 2,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 60_000,
    circuitFailureThreshold: 5,
    circuitCooldownMs: 30_000,
    maxSnapshotHandlers: 64,
    handlerTimeoutMs: 20_000,
    shutdownTimeoutMs: 25_000,
  });

const POSITIVE_LIMITS: Readonly<
  Record<keyof LifecycleDispatcherPolicy, readonly [number, number]>
> = Object.freeze({
  leaseMs: [1, 86_400_000],
  pollIntervalMs: [1, 86_400_000],
  maxConcurrency: [1, 256],
  maxConcurrencyPerHandler: [1, 256],
  retryBaseDelayMs: [1, 86_400_000],
  retryMaxDelayMs: [1, 86_400_000],
  circuitFailureThreshold: [1, 100],
  circuitCooldownMs: [1, 86_400_000],
  maxSnapshotHandlers: [1, 256],
  handlerTimeoutMs: [1, 86_399_999],
  shutdownTimeoutMs: [1, 86_399_999],
});

function ownDataInput(input: unknown): Record<string, unknown> | undefined {
  try {
    if (
      input === undefined ||
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      types.isProxy(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      return input === undefined ? {} : undefined;
    }
    // Own-key enumeration is bounded before collecting descriptors so a hostile
    // but non-proxy record cannot force unbounded descriptor materialization.
    const keys = Reflect.ownKeys(input);
    if (
      keys.length > Object.keys(POSITIVE_LIMITS).length ||
      keys.some((key) => typeof key !== 'string' || !Object.hasOwn(POSITIVE_LIMITS, key))
    ) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key as string];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
      snapshot[key as string] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

/** Result-returning, descriptor-safe policy factory for public composition boundaries. */
export function createLifecycleDispatcherPolicy(
  input: LifecycleDispatcherPolicyInput | undefined,
): Result<LifecycleDispatcherPolicy, LifecycleError> {
  const supplied = ownDataInput(input);
  if (!supplied) return err(new LifecycleError('invalid lifecycle dispatcher policy'));
  const candidate = {
    ...DEFAULT_LIFECYCLE_DISPATCHER_POLICY,
    ...supplied,
  } as Record<keyof LifecycleDispatcherPolicy, number>;
  for (const [key, [minimum, maximum]] of Object.entries(POSITIVE_LIMITS) as Array<
    [keyof LifecycleDispatcherPolicy, readonly [number, number]]
  >) {
    const value = candidate[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      return err(new LifecycleError('invalid lifecycle dispatcher policy'));
    }
  }
  if (
    candidate.retryBaseDelayMs > candidate.retryMaxDelayMs ||
    candidate.handlerTimeoutMs >= candidate.leaseMs ||
    candidate.shutdownTimeoutMs >= candidate.leaseMs
  ) {
    return err(new LifecycleError('invalid lifecycle dispatcher policy'));
  }
  return ok(Object.freeze(candidate as LifecycleDispatcherPolicy));
}

export function lifecycleRetryDelay(attempts: number, policy: LifecycleDispatcherPolicy): number {
  const exponent = Math.min(Math.max(attempts, 0), 16);
  return Math.min(policy.retryBaseDelayMs * 2 ** exponent, policy.retryMaxDelayMs);
}
