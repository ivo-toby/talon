import { describe, expect, it, vi } from 'vitest';
import { err, ok, type Result } from 'neverthrow';
import { LifecycleError } from '../../../src/core/errors/index.js';
import type {
  ClaimedLifecycleDelivery,
  LifecycleDeliveryRow,
} from '../../../src/core/database/repositories/lifecycle-delivery-repository.js';
import {
  CapturedLifecycleHandlerExecutor,
  lifecycleSignalHandoffKey,
  type LifecycleHandlerExecutor,
} from '../../../src/lifecycle/handler-executor.js';
import { LifecycleDispatcher } from '../../../src/lifecycle/lifecycle-dispatcher.js';
import { createLifecycleDispatcherPolicy } from '../../../src/lifecycle/dispatcher-policy.js';
import { LifecycleTelemetry } from '../../../src/lifecycle/telemetry/index.js';
import type {
  ObservationHandle,
  ObservationInput,
  ObservationUpdate,
  ObservabilityService,
  StartedObservationHandle,
} from '../../../src/observability/langfuse/observability-types.js';

const CHILD_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01';

function claim(
  handlerId = 'projector',
  eventId = `event-${handlerId}`,
  overrides: Partial<LifecycleDeliveryRow> = {},
): ClaimedLifecycleDelivery {
  return {
    delivery: {
      event_id: eventId,
      handler_id: handlerId,
      persona: 'assistant',
      priority: 0,
      handler_identity: JSON.stringify({
        version: 'v1',
        handlerId,
        runtimeKind: 'native',
        implementationRef: handlerId,
        implementationVersion: '1.0.0',
        mode: 'event',
        inputContract: 'talon.lifecycle.event.envelope.v1',
        outputContract: 'talon.lifecycle.signal.envelopes.v1',
      }),
      failure_policy: JSON.stringify({ version: 'v1', mode: 'dead_letter' }),
      status: 'claimed',
      attempts: 0,
      max_attempts: 3,
      next_retry_at: null,
      claim_token: `claim-${eventId}`,
      claim_expires_at: 100_000,
      last_error: null,
      completed_at: null,
      created_at: 1,
      updated_at: 1,
      ...overrides,
    },
    event: {
      event_sequence: 1,
      event_id: eventId,
      version: 'v1',
      type: 'message.persisted.v1',
      aggregate_type: 'thread',
      aggregate_id: 'thread-1',
      correlation_id: 'correlation-1',
      causation_id: null,
      recursion_depth: 0,
      recursion_max_depth: 4,
      provenance: JSON.stringify({ source: 'test' }),
      payload: JSON.stringify({ references: [], metadata: {} }),
      occurred_at: '2026-07-16T12:00:00.000Z',
      created_at: 1,
    },
  };
}

function success() {
  return ok({
    outcome: 'success' as const,
    outputContract: 'talon.lifecycle.signal.envelopes.v1' as const,
    signals: [],
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeDeliveries {
  readonly complete = vi.fn(() => ok({} as LifecycleDeliveryRow));
  readonly fail = vi.fn(() => ok({} as LifecycleDeliveryRow));
  readonly claimNext = vi.fn();
}

class FakeSignals {
  readonly handoff = vi.fn(async () => ok(undefined));
}

class FakeObservability implements ObservabilityService {
  readonly starts: ObservationInput[] = [];

  start(input: ObservationInput): StartedObservationHandle {
    return this.startWithTraceparent(null, input);
  }

  startWithTraceparent(
    _traceparent: string | null | undefined,
    input: ObservationInput,
  ): StartedObservationHandle {
    this.starts.push(input);
    return {
      update: (_update: ObservationUpdate) => undefined,
      getTraceparent: () => CHILD_TRACEPARENT,
      end: () => undefined,
    };
  }

  async observe<T>(
    input: ObservationInput,
    fn: (observation: ObservationHandle) => Promise<T> | T,
  ): Promise<T> {
    return await this.observeWithTraceparent(null, input, fn);
  }

  async observeWithTraceparent<T>(
    traceparent: string | null | undefined,
    input: ObservationInput,
    fn: (observation: ObservationHandle) => Promise<T> | T,
  ): Promise<T> {
    const handle = this.startWithTraceparent(traceparent, input);
    return await fn(handle);
  }

  async shutdown(): Promise<void> {}
}

function dispatcher(
  deliveries: FakeDeliveries,
  executor: LifecycleHandlerExecutor,
  overrides: ConstructorParameters<typeof LifecycleDispatcher>[0]['policy'] = {},
  signals = new FakeSignals(),
) {
  return LifecycleDispatcher.create({
    deliveries,
    executor,
    signalRouter: signals,
    clock: { now: () => 1_000 },
    policy: { pollIntervalMs: 86_400_000, ...overrides },
  })._unsafeUnwrap();
}

function fakeTelemetry(): LifecycleTelemetry {
  return {
    startDelivery: vi.fn(() => ({ startedAt: 1_000 })),
    recordDeliverySuccess: vi.fn(),
    recordDeliveryFailure: vi.fn(),
    recordCircuitOpened: vi.fn(),
    recordSignalHandoff: vi.fn(),
  } as unknown as LifecycleTelemetry;
}

describe('LifecycleDispatcher', () => {
  it('executes the immutable delivery identity and completes its matching lease once', async () => {
    const deliveries = new FakeDeliveries();
    const signals = new FakeSignals();
    deliveries.claimNext.mockReturnValueOnce(ok(claim()));
    const executor: LifecycleHandlerExecutor = {
      execute: vi.fn(async (execution) => {
        expect(execution.idempotencyKey).toBe(
          lifecycleSignalHandoffKey('event-projector', 'projector'),
        );
        expect(execution.identity.implementationVersion).toBe('1.0.0');
        expect('claim' in execution).toBe(false);
        expect(Object.isFrozen(execution.event)).toBe(true);
        return success();
      }),
    };
    const subject = dispatcher(deliveries, executor, {}, signals);

    await expect(subject.dispatchOnce()).resolves.toMatchObject({ value: true });
    await subject.stop();

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(deliveries.complete).toHaveBeenCalledWith(
      'event-projector',
      'projector',
      'claim-event-projector',
    );
    expect(deliveries.complete.mock.invocationCallOrder[0]).toBeGreaterThan(
      signals.handoff.mock.invocationCallOrder[0]!,
    );
    expect(deliveries.fail).not.toHaveBeenCalled();
    expect(signals.handoff).toHaveBeenCalledWith(
      expect.objectContaining({ persona: 'assistant', eventId: 'event-projector' }),
    );
  });

  it('passes the correlated lifecycle handler traceparent to execution', async () => {
    const deliveries = new FakeDeliveries();
    const observability = new FakeObservability();
    deliveries.claimNext.mockReturnValueOnce(ok(claim()));
    const executor: LifecycleHandlerExecutor = {
      execute: vi.fn(async (execution) => {
        expect(execution.traceparent).toBe(CHILD_TRACEPARENT);
        return success();
      }),
    };
    const subject = LifecycleDispatcher.create({
      deliveries,
      executor,
      signalRouter: new FakeSignals(),
      clock: { now: () => 1_000 },
      policy: { pollIntervalMs: 86_400_000 },
      telemetry: new LifecycleTelemetry({ observability, clock: { now: () => 1_000 } }),
    })._unsafeUnwrap();

    await expect(subject.dispatchOnce()).resolves.toMatchObject({ value: true });
    await subject.stop();

    expect(executor.execute).toHaveBeenCalledOnce();
    expect(observability.starts[0]?.name).toBe('lifecycle.handler');
  });

  it('enforces global and per-handler backpressure before claiming another delivery', async () => {
    const first = deferred<Result<ReturnType<typeof success>['value'], LifecycleError>>();
    const deliveries = new FakeDeliveries();
    deliveries.claimNext.mockImplementation(
      ({ excludedHandlerIds }: { excludedHandlerIds?: string[] }) => {
        if (!excludedHandlerIds?.includes('projector')) return ok(claim('projector', 'event-one'));
        return ok(claim('other-projector', 'event-two'));
      },
    );
    const executor: LifecycleHandlerExecutor = {
      execute: vi.fn(async (execution) => {
        if (execution.identity.handlerId === 'projector') return first.promise;
        return success();
      }),
    };
    const subject = dispatcher(deliveries, executor, {
      maxConcurrency: 2,
      maxConcurrencyPerHandler: 1,
    });

    await subject.dispatchOnce();
    await subject.dispatchOnce();
    expect(deliveries.claimNext.mock.calls[1]?.[0]).toMatchObject({
      excludedHandlerIds: ['projector'],
    });
    expect(subject.snapshot().inFlight).toBe(2);

    first.resolve(success());
    await Promise.resolve();
    await Promise.resolve();
    await subject.stop();
    expect(deliveries.complete).toHaveBeenCalledTimes(2);
  });

  it('records bounded retry diagnostics and opens a circuit after consecutive failures', async () => {
    const deliveries = new FakeDeliveries();
    deliveries.claimNext.mockReturnValueOnce(ok(claim())).mockReturnValueOnce(ok(claim('other')));
    const executor: LifecycleHandlerExecutor = {
      execute: vi.fn(async () => err(new LifecycleError('handler failed'))),
    };
    const subject = dispatcher(deliveries, executor, { circuitFailureThreshold: 1 });

    await subject.dispatchOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await subject.stop();

    expect(deliveries.fail).toHaveBeenCalledWith(
      'event-projector',
      'projector',
      'claim-event-projector',
      { code: 'handler-execution-failed' },
      2_000,
      true,
    );
    expect(subject.snapshot().handlers).toEqual([
      expect.objectContaining({ handlerId: 'projector', circuit: 'open' }),
    ]);
  });

  it('does not overwrite a delivery when its lease completion was lost', async () => {
    const deliveries = new FakeDeliveries();
    const telemetry = fakeTelemetry();
    deliveries.claimNext.mockReturnValueOnce(ok(claim()));
    deliveries.complete.mockReturnValueOnce(err(new LifecycleError('lease lost')));
    const subject = LifecycleDispatcher.create({
      deliveries,
      executor: { execute: async () => success() },
      signalRouter: new FakeSignals(),
      clock: { now: () => 1_000 },
      policy: { pollIntervalMs: 86_400_000 },
      telemetry,
    })._unsafeUnwrap();

    await subject.dispatchOnce();
    await subject.stop();

    expect(deliveries.complete).toHaveBeenCalledTimes(1);
    expect(deliveries.fail).not.toHaveBeenCalled();
    expect(telemetry.recordSignalHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', signalCount: 0 }),
    );
    expect(telemetry.recordDeliveryFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'signal-handoff-completion-lost',
        retryable: true,
        status: 'lost',
      }),
    );
  });

  it('records bounded signal handoff failure before retrying delivery', async () => {
    const deliveries = new FakeDeliveries();
    const signals = new FakeSignals();
    const telemetry = fakeTelemetry();
    deliveries.claimNext.mockReturnValueOnce(ok(claim()));
    signals.handoff.mockResolvedValueOnce(err(new LifecycleError('signal store unavailable')));
    const subject = LifecycleDispatcher.create({
      deliveries,
      executor: { execute: async () => success() },
      signalRouter: signals,
      clock: { now: () => 1_000 },
      policy: { pollIntervalMs: 86_400_000 },
      telemetry,
    })._unsafeUnwrap();

    await subject.dispatchOnce();
    await subject.stop();

    expect(telemetry.recordSignalHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failure',
        code: 'signal-handoff-failed',
        signalCount: 0,
      }),
    );
    expect(telemetry.recordDeliveryFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'signal-handoff-failed', status: 'failed' }),
    );
  });

  it('keeps one captured repository authority from claim through completion', async () => {
    const repositoryA = new FakeDeliveries();
    const repositoryB = new FakeDeliveries();
    const signalsA = new FakeSignals();
    const signalsB = new FakeSignals();
    const running = deferred<Result<ReturnType<typeof success>['value'], LifecycleError>>();
    repositoryA.claimNext.mockReturnValueOnce(ok(claim()));
    const options = {
      deliveries: repositoryA,
      executor: { execute: async () => running.promise },
      signalRouter: signalsA,
      clock: { now: () => 1_000 },
      policy: { pollIntervalMs: 86_400_000 },
    };
    const subject = LifecycleDispatcher.create(options)._unsafeUnwrap();

    await subject.dispatchOnce();
    options.deliveries = repositoryB;
    options.executor = { execute: async () => success() };
    options.signalRouter = signalsB;
    running.resolve(success());
    await new Promise<void>((resolve) => setImmediate(resolve));
    await subject.stop();

    expect(repositoryA.complete).toHaveBeenCalledWith(
      'event-projector',
      'projector',
      'claim-event-projector',
    );
    expect(repositoryA.fail).not.toHaveBeenCalled();
    expect(repositoryB.complete).not.toHaveBeenCalled();
    expect(repositoryB.fail).not.toHaveBeenCalled();
    expect(signalsA.handoff).toHaveBeenCalledTimes(1);
    expect(signalsB.handoff).not.toHaveBeenCalled();
  });

  it('hands a reclaimed success to the durable signal boundary with the same idempotency key before each completion attempt', async () => {
    const deliveries = new FakeDeliveries();
    const signals = new FakeSignals();
    deliveries.claimNext
      .mockReturnValueOnce(ok(claim()))
      .mockReturnValueOnce(
        ok(claim('projector', 'event-projector', { claim_token: 'replacement-lease' })),
      );
    deliveries.complete.mockReturnValueOnce(err(new LifecycleError('crash after handoff')));
    const subject = dispatcher(deliveries, { execute: async () => success() }, {}, signals);

    await subject.dispatchOnce();
    await subject.stop();
    await subject.dispatchOnce();
    await subject.stop();

    expect(signals.handoff).toHaveBeenCalledTimes(2);
    expect(signals.handoff.mock.calls.map(([value]) => value.idempotencyKey)).toEqual([
      lifecycleSignalHandoffKey('event-projector', 'projector'),
      lifecycleSignalHandoffKey('event-projector', 'projector'),
    ]);
    expect(deliveries.complete).toHaveBeenCalledTimes(2);
  });

  it('honors non-retryable errors and preserve-session terminal completion', async () => {
    const deliveries = new FakeDeliveries();
    deliveries.claimNext.mockReturnValueOnce(
      ok(
        claim('projector', 'event-projector', {
          failure_policy: JSON.stringify({ version: 'v1', mode: 'preserve_session' }),
        }),
      ),
    );
    const subject = dispatcher(deliveries, {
      execute: async () =>
        ok({ outcome: 'error', code: 'invalid-input', message: 'invalid', retryable: false }),
    });

    await subject.dispatchOnce();
    await subject.stop();

    expect(deliveries.complete).toHaveBeenCalledWith(
      'event-projector',
      'projector',
      'claim-event-projector',
    );
    expect(deliveries.fail).not.toHaveBeenCalled();
  });

  it('dead-letters a non-retryable error through the lease-guarded repository transition', async () => {
    const deliveries = new FakeDeliveries();
    deliveries.claimNext.mockReturnValueOnce(ok(claim()));
    const subject = dispatcher(deliveries, {
      execute: async () =>
        ok({ outcome: 'error', code: 'invalid-input', message: 'invalid', retryable: false }),
    });

    await subject.dispatchOnce();
    await subject.stop();

    expect(deliveries.fail).toHaveBeenCalledWith(
      'event-projector',
      'projector',
      'claim-event-projector',
      { code: 'handler-reported-error' },
      2_000,
      false,
    );
  });

  it('enforces global concurrency on direct public dispatch calls', async () => {
    const running = deferred<Result<ReturnType<typeof success>['value'], LifecycleError>>();
    const deliveries = new FakeDeliveries();
    deliveries.claimNext.mockReturnValue(ok(claim()));
    const subject = dispatcher(
      deliveries,
      { execute: async () => running.promise },
      { maxConcurrency: 1 },
    );

    await subject.dispatchOnce();
    await expect(subject.dispatchOnce()).resolves.toMatchObject({ value: false });
    expect(deliveries.claimNext).toHaveBeenCalledTimes(1);
    running.resolve(success());
    await subject.stop();
  });

  it('cancels a hung handler before lease expiry and bounds shutdown', async () => {
    vi.useFakeTimers();
    const deliveries = new FakeDeliveries();
    deliveries.claimNext.mockReturnValueOnce(ok(claim()));
    const observed = vi.fn();
    const subject = dispatcher(
      deliveries,
      {
        execute: async (execution) =>
          new Promise((resolve) => {
            execution.signal.addEventListener('abort', () => {
              observed(execution.signal.aborted);
              resolve(err(new LifecycleError('cancelled')));
            });
          }),
      },
      { leaseMs: 100, handlerTimeoutMs: 50, shutdownTimeoutMs: 75 },
    );

    await subject.dispatchOnce();
    await vi.advanceTimersByTimeAsync(50);
    await subject.stop();

    expect(observed).toHaveBeenCalledWith(true);
    expect(deliveries.fail).toHaveBeenCalledWith(
      'event-projector',
      'projector',
      'claim-event-projector',
      { code: 'handler-timeout' },
      2_000,
      true,
    );
    vi.useRealTimers();
  });

  it('retains timed-out abort-ignoring executions in global and handler capacity until they settle', async () => {
    vi.useFakeTimers();
    try {
      const late = deferred<Result<ReturnType<typeof success>['value'], LifecycleError>>();
      const retry = deferred<Result<ReturnType<typeof success>['value'], LifecycleError>>();
      const deliveries = new FakeDeliveries();
      deliveries.claimNext
        .mockReturnValueOnce(ok(claim('projector', 'event-first')))
        .mockReturnValueOnce(ok(claim('projector', 'event-retry')));
      const executor: LifecycleHandlerExecutor = {
        execute: vi
          .fn()
          .mockImplementationOnce(async () => late.promise)
          .mockImplementationOnce(async () => retry.promise),
      };
      const subject = dispatcher(deliveries, executor, {
        maxConcurrency: 1,
        maxConcurrencyPerHandler: 1,
        leaseMs: 100,
        handlerTimeoutMs: 50,
        shutdownTimeoutMs: 75,
      });

      await subject.dispatchOnce();
      await vi.advanceTimersByTimeAsync(50);
      expect(subject.snapshot()).toMatchObject({ inFlight: 1 });
      expect(subject.snapshot().handlers).toEqual([
        expect.objectContaining({ handlerId: 'projector', inFlight: 1 }),
      ]);
      expect(deliveries.fail).toHaveBeenCalledTimes(1);

      await expect(subject.dispatchOnce()).resolves.toMatchObject({ value: false });
      expect(deliveries.claimNext).toHaveBeenCalledTimes(1);

      const stopped = subject.stop();
      await vi.advanceTimersByTimeAsync(75);
      await stopped;
      expect(subject.snapshot()).toMatchObject({ running: false, inFlight: 1 });

      subject.start();
      await Promise.resolve();
      await expect(subject.dispatchOnce()).resolves.toMatchObject({ value: false });
      expect(deliveries.claimNext).toHaveBeenCalledTimes(1);

      late.resolve(success());
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(executor.execute).toHaveBeenCalledTimes(2);
      expect(deliveries.claimNext).toHaveBeenCalledTimes(2);
      expect(subject.snapshot()).toMatchObject({ inFlight: 1 });

      retry.resolve(success());
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(deliveries.complete).toHaveBeenCalledTimes(1);
      await subject.stop();
      expect(deliveries.fail).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels active work during shutdown instead of waiting past its lease fence', async () => {
    const running = deferred<Result<ReturnType<typeof success>['value'], LifecycleError>>();
    const deliveries = new FakeDeliveries();
    deliveries.claimNext.mockReturnValueOnce(ok(claim()));
    const subject = dispatcher(deliveries, { execute: async () => running.promise });

    await subject.dispatchOnce();
    const stopped = subject.stop();
    running.resolve(success());
    await stopped;

    expect(deliveries.complete).not.toHaveBeenCalled();
    expect(deliveries.fail).toHaveBeenCalledWith(
      'event-projector',
      'projector',
      'claim-event-projector',
      { code: 'handler-timeout' },
      2_000,
      true,
    );
    expect(subject.snapshot()).toMatchObject({ running: false, stopping: false, inFlight: 0 });
  });

  it('clears the losing shutdown timeout when stop settles immediately', async () => {
    vi.useFakeTimers();
    try {
      const subject = dispatcher(
        new FakeDeliveries(),
        { execute: async () => success() },
        {
          shutdownTimeoutMs: 5_000,
        },
      );

      await subject.stop();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects hostile dispatcher construction and non-callable dependencies without traps', () => {
    const traps = { get: vi.fn(), ownKeys: vi.fn(), getPrototypeOf: vi.fn() };
    const hostile = new Proxy({}, traps);
    const accessorOptions = Object.defineProperty({}, 'policy', {
      enumerable: true,
      get() {
        throw new Error('must not read options policy');
      },
    });

    expect(LifecycleDispatcher.create(hostile as never).isErr()).toBe(true);
    expect(traps.get).not.toHaveBeenCalled();
    expect(traps.ownKeys).not.toHaveBeenCalled();
    expect(traps.getPrototypeOf).not.toHaveBeenCalled();
    expect(() => LifecycleDispatcher.create(accessorOptions as never)).not.toThrow();
    expect(LifecycleDispatcher.create(accessorOptions as never).isErr()).toBe(true);
    expect(
      LifecycleDispatcher.create({
        deliveries: { claimNext: true, complete: true, fail: true },
        executor: { execute: true },
        signalRouter: { handoff: true },
      } as never).isErr(),
    ).toBe(true);
  });

  it('contains throwing and malformed claim results at the public Result boundary', async () => {
    const throwing = new FakeDeliveries();
    throwing.claimNext.mockImplementation(() => {
      throw new Error('claim failed');
    });
    const malformed = new FakeDeliveries();
    malformed.claimNext.mockReturnValue({ isErr: () => false, isOk: () => true, value: 1 });
    const throwingSubject = dispatcher(throwing, { execute: async () => success() });
    const malformedSubject = dispatcher(malformed, { execute: async () => success() });

    expect((await throwingSubject.dispatchOnce()).isErr()).toBe(true);
    expect((await malformedSubject.dispatchOnce()).isErr()).toBe(true);

    throwingSubject.start();
    malformedSubject.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await throwingSubject.stop();
    await malformedSubject.stop();
  });

  it('rejects accessor and proxy claim results without evaluating their traps', async () => {
    const accessorReads = vi.fn();
    const accessorResult = Object.defineProperties(
      {},
      {
        isErr: { enumerable: true, value: () => false },
        isOk: { enumerable: true, value: () => true },
        value: {
          enumerable: true,
          get() {
            accessorReads();
            throw new Error('must not read claim result');
          },
        },
      },
    );
    const proxyTraps = { get: vi.fn(), ownKeys: vi.fn(), getPrototypeOf: vi.fn() };
    const proxyResult = new Proxy({}, proxyTraps);
    const accessor = new FakeDeliveries();
    const proxied = new FakeDeliveries();
    accessor.claimNext.mockReturnValue(accessorResult);
    proxied.claimNext.mockReturnValue(proxyResult);

    expect(
      (await dispatcher(accessor, { execute: async () => success() }).dispatchOnce()).isErr(),
    ).toBe(true);
    expect(
      (await dispatcher(proxied, { execute: async () => success() }).dispatchOnce()).isErr(),
    ).toBe(true);
    expect(accessorReads).not.toHaveBeenCalled();
    expect(proxyTraps.get).not.toHaveBeenCalled();
    expect(proxyTraps.ownKeys).not.toHaveBeenCalled();
  });
});

describe('CapturedLifecycleHandlerExecutor', () => {
  it('rejects a handler result that does not match the captured contract', async () => {
    const executor = CapturedLifecycleHandlerExecutor.create({
      nativeCatalog: [
        {
          identity: JSON.parse(claim().delivery.handler_identity) as never,
          handler: async () =>
            ok({ outcome: 'success', outputContract: 'wrong.v1', signals: [] } as never),
        },
      ],
    })._unsafeUnwrap();
    const invalid = await executor.execute({
      event: {
        version: 'v1',
        type: 'message.persisted.v1',
        eventId: 'event-projector',
        occurredAt: '2026-07-16T12:00:00.000Z',
        context: {
          aggregate: { type: 'thread', id: 'thread-1' },
          correlationId: 'correlation-1',
          recursion: { depth: 0, maxDepth: 4 },
          provenance: { source: 'test' },
        },
        payload: { references: [], metadata: {} },
      },
      identity: JSON.parse(claim().delivery.handler_identity) as never,
      persona: 'assistant',
      idempotencyKey: 'event-projector:projector',
      signal: new AbortController().signal,
    });

    expect(invalid.isErr()).toBe(true);
  });

  it('matches the complete immutable identity tuple, not only implementation ref', async () => {
    const handler = vi.fn(async () => success());
    const executor = CapturedLifecycleHandlerExecutor.create({
      nativeCatalog: [
        {
          identity: JSON.parse(claim().delivery.handler_identity) as never,
          handler,
        },
      ],
    })._unsafeUnwrap();
    const identity = {
      ...(JSON.parse(claim().delivery.handler_identity) as Record<string, unknown>),
      implementationVersion: '2.0.0',
    };

    const result = await executor.execute({
      event: {
        version: 'v1',
        type: 'message.persisted.v1',
        eventId: 'event-projector',
        occurredAt: '2026-07-16T12:00:00.000Z',
        context: {
          aggregate: { type: 'thread', id: 'thread-1' },
          correlationId: 'correlation-1',
          recursion: { depth: 0, maxDepth: 4 },
          provenance: { source: 'test' },
        },
        payload: { references: [], metadata: {} },
      },
      identity: identity as never,
      persona: 'assistant',
      idempotencyKey: 'event-projector:projector',
      signal: new AbortController().signal,
    });

    expect(result.isErr()).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('allows one subagent identity for distinct explicit persona attachments', async () => {
    const identity = {
      ...(JSON.parse(claim().delivery.handler_identity) as Record<string, unknown>),
      runtimeKind: 'subagent',
      implementationRef: 'triage-agent',
    } as never;
    const alice = vi.fn(async () => success());
    const bob = vi.fn(async () => success());
    const executor = CapturedLifecycleHandlerExecutor.create({
      subagentCatalog: [
        {
          identity,
          handler: alice,
          subagentScope: { persona: 'alice', capabilities: { allow: [] } },
        },
        {
          identity,
          handler: bob,
          subagentScope: { persona: 'bob', capabilities: { allow: [] } },
        },
      ],
    })._unsafeUnwrap();
    const event = {
      version: 'v1' as const,
      type: 'message.persisted.v1' as const,
      eventId: 'event-projector',
      occurredAt: '2026-07-16T12:00:00.000Z',
      context: {
        aggregate: { type: 'thread', id: 'thread-1' },
        correlationId: 'correlation-1',
        recursion: { depth: 0, maxDepth: 4 },
        provenance: { source: 'test' },
      },
      payload: { references: [], metadata: {} },
    };

    await executor.execute({
      event,
      identity,
      persona: 'alice',
      idempotencyKey: 'event-projector:projector',
      signal: new AbortController().signal,
    });
    await executor.execute({
      event,
      identity,
      persona: 'bob',
      idempotencyKey: 'event-projector:projector',
      signal: new AbortController().signal,
    });

    expect(alice).toHaveBeenCalledTimes(1);
    expect(bob).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate subagent identity/persona authority and cross-persona use', async () => {
    const identity = {
      ...(JSON.parse(claim().delivery.handler_identity) as Record<string, unknown>),
      runtimeKind: 'subagent',
      implementationRef: 'triage-agent',
    } as never;
    const handler = vi.fn(async () => success());
    const duplicate = CapturedLifecycleHandlerExecutor.create({
      subagentCatalog: [
        { identity, handler, subagentScope: { persona: 'alice', capabilities: { allow: [] } } },
        { identity, handler, subagentScope: { persona: 'alice', capabilities: { allow: [] } } },
      ],
    });
    const onlyAlice = CapturedLifecycleHandlerExecutor.create({
      subagentCatalog: [
        { identity, handler, subagentScope: { persona: 'alice', capabilities: { allow: [] } } },
      ],
    })._unsafeUnwrap();

    const crossPersona = await onlyAlice.execute({
      event: {
        version: 'v1',
        type: 'message.persisted.v1',
        eventId: 'event-projector',
        occurredAt: '2026-07-16T12:00:00.000Z',
        context: {
          aggregate: { type: 'thread', id: 'thread-1' },
          correlationId: 'correlation-1',
          recursion: { depth: 0, maxDepth: 4 },
          provenance: { source: 'test' },
        },
        payload: { references: [], metadata: {} },
      },
      identity,
      persona: 'bob',
      idempotencyKey: 'event-projector:projector',
      signal: new AbortController().signal,
    });

    expect(duplicate.isErr()).toBe(true);
    expect(crossPersona.isErr()).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects hostile accessor and proxy policy/catalog inputs without throwing', () => {
    const policy = {
      get leaseMs(): number {
        throw new Error('read');
      },
    };
    expect(() => createLifecycleDispatcherPolicy(policy)).not.toThrow();
    expect(createLifecycleDispatcherPolicy(policy).isErr()).toBe(true);
    expect(
      CapturedLifecycleHandlerExecutor.create({ nativeCatalog: new Proxy([], {}) }).isErr(),
    ).toBe(true);
  });

  it('bounds catalog options, entries, identities, and scopes before descriptor evaluation', () => {
    const identity = JSON.parse(claim().delivery.handler_identity) as Record<string, unknown>;
    const accessed = vi.fn();
    const oversized = (base: Record<string, unknown> = {}): Record<string, unknown> => {
      const value = { ...base };
      while (Reflect.ownKeys(value).length < 64) {
        value[`extra-${Reflect.ownKeys(value).length}`] = true;
      }
      Object.defineProperty(value, 'overflow', {
        enumerable: true,
        get() {
          accessed();
          throw new Error('must not evaluate oversized input');
        },
      });
      return value;
    };
    const handler = async () => success();

    expect(CapturedLifecycleHandlerExecutor.create(oversized() as never).isErr()).toBe(true);
    expect(
      CapturedLifecycleHandlerExecutor.create({
        nativeCatalog: [oversized({ identity, handler }) as never],
      }).isErr(),
    ).toBe(true);
    expect(
      CapturedLifecycleHandlerExecutor.create({
        nativeCatalog: [{ identity: oversized(identity), handler } as never],
      }).isErr(),
    ).toBe(true);
    expect(
      CapturedLifecycleHandlerExecutor.create({
        subagentCatalog: [
          {
            identity: { ...identity, runtimeKind: 'subagent' },
            handler,
            subagentScope: oversized({ persona: 'assistant', capabilities: {} }),
          } as never,
        ],
      }).isErr(),
    ).toBe(true);
    expect(accessed).not.toHaveBeenCalled();
  });
});
