import { describe, expect, it, vi } from 'vitest';

import { AuditLogger, type AuditEntry } from '../../../src/core/logging/audit-logger.js';
import {
  LifecycleInterceptorEngine,
  type LifecycleInterceptorClock,
  type LifecycleInterceptorHandler,
  type LifecycleInterceptorInvocation,
} from '../../../src/lifecycle/interceptors/interceptor-engine.js';
import {
  createNativeToolNameDenyInterceptor,
  nativeAllowInterceptor,
} from '../../../src/lifecycle/interceptors/native-example-handlers.js';
import type { ResolvedLifecycleHandler } from '../../../src/lifecycle/handler-registry.js';
import {
  LifecycleInterceptorEnvelopeSchema,
  LifecycleInterceptorTransformSchema,
  type LifecycleSignalEnvelope,
} from '../../../src/lifecycle/contracts/index.js';

const hook = 'tool.before_execute' as const;

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    version: 'v1',
    interceptionId: 'interception-1',
    hook,
    context: {
      aggregate: { type: 'thread', id: 'thread-1' },
      correlationId: 'correlation-1',
      recursion: { depth: 0, maxDepth: 4 },
      provenance: { source: 'test-source' },
    },
    input: {
      toolCallId: 'tool-call-1',
      toolName: 'web_search',
      arguments: { query: 'original' },
    },
    ...overrides,
  };
}

function makeHandler(
  id: string,
  priority: number,
  overrides: {
    safety?: 'advisory' | 'enforcing';
    timeoutMs?: number;
    failurePolicy?: 'fail_open' | 'fail_closed';
    implementationRef?: string;
  } = {},
): ResolvedLifecycleHandler {
  const safety = overrides.safety ?? 'enforcing';
  const implementationRef = overrides.implementationRef ?? id;
  return {
    persona: 'assistant',
    priority,
    handler: {
      version: 'v1',
      id,
      mode: 'interceptor',
      inputContract: 'talon.lifecycle.interceptor.input.v1',
      outputContract:
        safety === 'enforcing'
          ? 'talon.lifecycle.enforcing.interceptor.output.v1'
          : 'talon.lifecycle.advisory.interceptor.output.v1',
      runtime: {
        kind: 'native',
        ref: implementationRef,
        implementationVersion: '1.0.0',
      },
      interceptorSafety: safety,
    },
    identity: {
      version: 'v1',
      handlerId: id,
      runtimeKind: 'native',
      implementationRef,
      implementationVersion: '1.0.0',
      mode: 'interceptor',
      inputContract: 'talon.lifecycle.interceptor.input.v1',
      outputContract:
        safety === 'enforcing'
          ? 'talon.lifecycle.enforcing.interceptor.output.v1'
          : 'talon.lifecycle.advisory.interceptor.output.v1',
      interceptorSafety: safety,
    },
    subscription: { kind: 'interceptor', interceptors: [{ version: 'v1', hook }] },
    ...(overrides.timeoutMs ? { budget: { version: 'v1', timeoutMs: overrides.timeoutMs } } : {}),
    failurePolicy: {
      version: 'v1',
      mode: overrides.failurePolicy ?? (safety === 'advisory' ? 'fail_open' : 'fail_closed'),
    },
  };
}

function enforcingResult(result: Record<string, unknown>) {
  return {
    outcome: 'success' as const,
    outputContract: 'talon.lifecycle.enforcing.interceptor.output.v1' as const,
    result: { signals: [], ...result },
  };
}

function advisoryResult() {
  return {
    outcome: 'success' as const,
    outputContract: 'talon.lifecycle.advisory.interceptor.output.v1' as const,
    result: { outcome: 'advisory' as const, signals: [] },
  };
}

function handlerMetadata(entries: Array<readonly [string, string | number | boolean | null]>) {
  return Object.fromEntries(entries);
}

function causallyDerivedSignal(
  input: { interceptionId: string; context: Record<string, unknown> },
  signalId: string,
  metadata = handlerMetadata([]),
) {
  const context = input.context as {
    aggregate: { type: string; id: string };
    correlationId: string;
    recursion: { depth: number; maxDepth: number };
    provenance: { source: string; sourceEventIds?: string[]; sourceReferences?: unknown[] };
  };
  return {
    version: 'v1' as const,
    type: 'context.rotate.requested.v1' as const,
    signalId,
    occurredAt: '2026-07-15T19:00:01.000Z',
    context: {
      aggregate: { ...context.aggregate },
      correlationId: context.correlationId,
      causationId: input.interceptionId,
      recursion: { depth: context.recursion.depth + 1, maxDepth: context.recursion.maxDepth },
      provenance: {
        source: context.provenance.source,
        sourceEventIds: [...(context.provenance.sourceEventIds ?? [])],
        sourceReferences: [...(context.provenance.sourceReferences ?? [])],
      },
    },
    payload: { references: [], metadata },
  };
}

function makeClock(): LifecycleInterceptorClock & { advance: (milliseconds: number) => void } {
  let now = 0;
  return {
    now: () => now,
    advance: (milliseconds) => {
      now += milliseconds;
    },
  };
}

function makeEngine(
  handlers: readonly ResolvedLifecycleHandler[],
  implementations: Record<string, LifecycleInterceptorHandler>,
  options: Partial<ConstructorParameters<typeof LifecycleInterceptorEngine>[0]> = {},
) {
  return new LifecycleInterceptorEngine({
    resolveHandlers: () => handlers,
    implementations,
    totalTimeoutMs: 50,
    ...options,
  });
}

function invoke(engine: LifecycleInterceptorEngine, input = makeInput()) {
  return engine.intercept({ persona: 'assistant', hook }, input);
}

describe('LifecycleInterceptorEngine', () => {
  it('orders handlers by descending priority then handler id and composes transforms', () => {
    const calls: string[] = [];
    const engine = makeEngine(
      [makeHandler('z-last', 0), makeHandler('a-first', 10), makeHandler('middle', 5)],
      {
        'a-first': (input) => {
          calls.push('a-first');
          expect(input.input.arguments).toEqual({ query: 'original' });
          return enforcingResult({
            outcome: 'transform',
            transform: { hook, argumentsPatch: { page: 1 } },
          });
        },
        middle: (input) => {
          calls.push('middle');
          expect(input.input.arguments).toEqual({ query: 'original', page: 1 });
          return enforcingResult({
            outcome: 'transform',
            transform: { hook, argumentsPatch: { limit: 10 } },
          });
        },
        'z-last': (input) => {
          calls.push('z-last');
          expect(input.input.arguments).toEqual({ query: 'original', page: 1, limit: 10 });
          return enforcingResult({ outcome: 'allow' });
        },
      },
    );

    const result = invoke(engine);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      outcome: 'allow',
      input: { input: { arguments: { query: 'original', page: 1, limit: 10 } } },
    });
    expect(calls).toEqual(['a-first', 'middle', 'z-last']);
  });

  it('breaks equal-priority ties by handler id regardless of resolver input order', () => {
    const calls: string[] = [];
    const engine = makeEngine([makeHandler('z-last', 1), makeHandler('a-first', 1)], {
      'a-first': () => {
        calls.push('a-first');
        return enforcingResult({ outcome: 'allow' });
      },
      'z-last': () => {
        calls.push('z-last');
        return enforcingResult({ outcome: 'allow' });
      },
    });

    expect(invoke(engine)._unsafeUnwrap().outcome).toBe('allow');
    expect(calls).toEqual(['a-first', 'z-last']);
  });

  it('dispatches by the resolved implementation reference, not the configured handler id', () => {
    const implementation = vi.fn(() => enforcingResult({ outcome: 'allow' }));
    const engine = makeEngine(
      [makeHandler('configured-handler-id', 1, { implementationRef: 'native-implementation-ref' })],
      { 'native-implementation-ref': implementation },
    );

    expect(invoke(engine)._unsafeUnwrap().outcome).toBe('allow');
    expect(implementation).toHaveBeenCalledOnce();
  });

  it('never dispatches a colliding implementation reference for a non-native identity', () => {
    const implementation = vi.fn(() => enforcingResult({ outcome: 'allow' }));
    const handler = makeHandler('subagent-collision', 1, { implementationRef: 'shared-ref' });
    const collision = {
      ...handler,
      identity: { ...handler.identity, runtimeKind: 'subagent' },
    } as unknown as ResolvedLifecycleHandler;
    const engine = makeEngine([collision], { 'shared-ref': implementation });

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_error',
      handlerId: 'subagent-collision',
    });
    expect(implementation).not.toHaveBeenCalled();
  });

  it('does not dispatch inherited implementations', () => {
    const inheritedImplementation = vi.fn(() => enforcingResult({ outcome: 'allow' }));
    const implementations = Object.create({
      'native-implementation-ref': inheritedImplementation,
    }) as Record<string, LifecycleInterceptorHandler>;
    const engine = makeEngine(
      [makeHandler('configured-handler-id', 1, { implementationRef: 'native-implementation-ref' })],
      implementations,
    );

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_error',
      handlerId: 'configured-handler-id',
    });
    expect(inheritedImplementation).not.toHaveBeenCalled();
  });

  it('short-circuits a deny and preserves its transformed input snapshot', () => {
    const after = vi.fn();
    const engine = makeEngine(
      [makeHandler('transform', 2), makeHandler('deny', 1), makeHandler('after', 0)],
      {
        transform: () =>
          enforcingResult({
            outcome: 'transform',
            transform: { hook, argumentsPatch: { safe: true } },
          }),
        deny: () => enforcingResult({ outcome: 'deny', reason: 'not allowed' }),
        after,
      },
    );

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'not allowed',
      input: { input: { arguments: { query: 'original', safe: true } } },
    });
    expect(after).not.toHaveBeenCalled();
  });

  it('short-circuits a required approval', () => {
    const engine = makeEngine([makeHandler('approval', 1)], {
      approval: () =>
        enforcingResult({
          outcome: 'require_approval',
          reason: 'approval required',
          approvalKey: 'approval-1',
        }),
    });

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'require_approval',
      reason: 'approval required',
      approvalKey: 'approval-1',
    });
  });

  it('applies message and run transforms without exposing unbounded values', () => {
    const messageInput = {
      ...makeInput(),
      hook: 'message.before_send',
      input: {
        messageId: 'message-1',
        recipientId: 'recipient-1',
        content: 'original',
        source: 'outbound',
      },
    };
    const messageEngine = makeEngine([makeHandler('message-transform', 1)], {
      'message-transform': () =>
        enforcingResult({
          outcome: 'transform',
          transform: { hook: 'message.before_send', content: 'updated' },
        }),
    });

    expect(
      messageEngine
        .intercept({ persona: 'assistant', hook: 'message.before_send' }, messageInput)
        ._unsafeUnwrap(),
    ).toMatchObject({ outcome: 'allow', input: { input: { content: 'updated' } } });

    const runInput = {
      ...makeInput(),
      hook: 'run.before_execute',
      input: {
        runId: 'run-1',
        provider: 'provider-a',
        model: 'model-a',
        persona: 'assistant',
        contextAdditions: { retained: true },
      },
    };
    const runEngine = makeEngine([makeHandler('run-transform', 1)], {
      'run-transform': () =>
        enforcingResult({
          outcome: 'transform',
          transform: {
            hook: 'run.before_execute',
            provider: 'provider-b',
            contextAdditions: { added: true },
          },
        }),
    });

    expect(
      runEngine
        .intercept({ persona: 'assistant', hook: 'run.before_execute' }, runInput)
        ._unsafeUnwrap(),
    ).toMatchObject({
      outcome: 'allow',
      input: {
        input: {
          provider: 'provider-b',
          contextAdditions: { retained: true, added: true },
        },
      },
    });
  });

  it('fails closed on thrown errors and ignores advisory handler failures', () => {
    const next = vi.fn(() => enforcingResult({ outcome: 'allow' }));
    const engine = makeEngine(
      [
        makeHandler('open', 2, { safety: 'advisory' }),
        makeHandler('closed', 1),
        makeHandler('next', 0),
      ],
      {
        open: () => {
          throw new Error('advisory failure');
        },
        closed: () => {
          throw new Error('enforcing failure');
        },
        next,
      },
    );

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_error',
      handlerId: 'closed',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('enforces per-handler and aggregate deadlines deterministically', () => {
    const clock = makeClock();
    const skipped = vi.fn();
    const engine = makeEngine(
      [makeHandler('slow', 2, { timeoutMs: 5 }), makeHandler('skipped', 1)],
      {
        slow: () => {
          clock.advance(6);
          return enforcingResult({ outcome: 'allow' });
        },
        skipped,
      },
      { clock, totalTimeoutMs: 5 },
    );

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_timeout',
    });
    expect(skipped).not.toHaveBeenCalled();
  });

  it('continues after a fail-open handler timeout while ignoring its result', () => {
    const clock = makeClock();
    const next = vi.fn(() => enforcingResult({ outcome: 'allow' }));
    const engine = makeEngine(
      [
        makeHandler('slow-advisory', 2, { safety: 'advisory', timeoutMs: 5 }),
        makeHandler('next', 1),
      ],
      {
        'slow-advisory': () => {
          clock.advance(6);
          return advisoryResult();
        },
        next,
      },
      { clock, totalTimeoutMs: 50 },
    );

    expect(invoke(engine)._unsafeUnwrap().outcome).toBe('allow');
    expect(next).toHaveBeenCalledOnce();
  });

  it('executes a later enforcing deny after a fail-open pre-invocation timeout', () => {
    let clockReads = 0;
    const clock: LifecycleInterceptorClock = {
      now: () => {
        clockReads += 1;
        return clockReads < 3 ? 0 : 6;
      },
    };
    const timedOutAdvisory = vi.fn(() => advisoryResult());
    const enforcingDeny = vi.fn(() =>
      enforcingResult({ outcome: 'deny', reason: 'enforced after pre-invocation timeout' }),
    );
    const engine = makeEngine(
      [
        makeHandler('timed-out-advisory', 2, { safety: 'advisory', timeoutMs: 5 }),
        makeHandler('enforcing-deny', 1),
      ],
      { 'timed-out-advisory': timedOutAdvisory, 'enforcing-deny': enforcingDeny },
      { clock, totalTimeoutMs: 50 },
    );

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'enforced after pre-invocation timeout',
      handlerId: 'enforcing-deny',
    });
    expect(timedOutAdvisory).not.toHaveBeenCalled();
    expect(enforcingDeny).toHaveBeenCalledOnce();
  });

  it('continues after an advisory failure audit exhausts only that handler deadline and executes a later deny', () => {
    const clock = makeClock();
    const auditLogger = {
      logLifecycleInterceptor: vi.fn(() => clock.advance(6)),
    } as unknown as AuditLogger;
    const deny = vi.fn(() => enforcingResult({ outcome: 'deny', reason: 'enforced after audit' }));
    const engine = makeEngine(
      [
        makeHandler('advisory-failure', 2, { safety: 'advisory', timeoutMs: 5 }),
        makeHandler('enforcing-deny', 1),
      ],
      {
        'advisory-failure': () => {
          throw new Error('advisory failure');
        },
        'enforcing-deny': deny,
      },
      { clock, totalTimeoutMs: 50, auditLogger },
    );

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'enforced after audit',
      handlerId: 'enforcing-deny',
    });
    expect(deny).toHaveBeenCalledOnce();
  });

  it('fails closed at the aggregate deadline when an enforcing handler remains after advisory work', () => {
    let reads = 0;
    const clock: LifecycleInterceptorClock = {
      now: () => {
        reads += 1;
        return reads >= 9 ? 5 : 0;
      },
    };
    const enforcing = vi.fn(() => enforcingResult({ outcome: 'allow' }));
    const engine = makeEngine(
      [makeHandler('advisory', 2, { safety: 'advisory' }), makeHandler('enforcing', 1)],
      { advisory: advisoryResult, enforcing },
      { clock, totalTimeoutMs: 5 },
    );

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_total_timeout',
    });
    expect(enforcing).not.toHaveBeenCalled();
  });

  it('rejects a late parsed result before its deny decision can take effect', () => {
    let reads = 0;
    const clock: LifecycleInterceptorClock = {
      now: () => {
        reads += 1;
        return reads >= 6 ? 6 : 0;
      },
    };
    const engine = makeEngine(
      [makeHandler('late-parser', 1, { timeoutMs: 5 })],
      { 'late-parser': () => enforcingResult({ outcome: 'deny', reason: 'late deny' }) },
      { clock },
    );

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_timeout',
      handlerId: 'late-parser',
    });
  });

  it('rejects a late transform before it can commit its input or signals', () => {
    let reads = 0;
    const clock: LifecycleInterceptorClock = {
      now: () => {
        reads += 1;
        return reads >= 7 ? 6 : 0;
      },
    };
    const engine = makeEngine(
      [makeHandler('late-transform', 1, { timeoutMs: 5 })],
      {
        'late-transform': () =>
          enforcingResult({
            outcome: 'transform',
            transform: { hook, argumentsPatch: { late: true } },
          }),
      },
      { clock },
    );

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_timeout',
      input: { input: { arguments: { query: 'original' } } },
      signals: [],
    });
  });

  it('does not invoke handlers after an aggregate deadline is exhausted', () => {
    const clock = makeClock();
    const second = vi.fn();
    const engine = makeEngine(
      [makeHandler('first', 2), makeHandler('second', 1)],
      {
        first: () => {
          clock.advance(5);
          return enforcingResult({ outcome: 'allow' });
        },
        second,
      },
      { clock, totalTimeoutMs: 5 },
    );

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_total_timeout',
    });
    expect(second).not.toHaveBeenCalled();
  });

  it('gives later handlers and callers detached immutable snapshots', () => {
    const engine = makeEngine([makeHandler('transform', 2), makeHandler('assert-frozen', 1)], {
      transform: () =>
        enforcingResult({
          outcome: 'transform',
          transform: { hook, argumentsPatch: { safe: true } },
        }),
      'assert-frozen': (input) => {
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(input.input)).toBe(true);
        expect(Object.isFrozen(input.input.arguments)).toBe(true);
        expect(() => {
          (input.input.arguments as Record<string, unknown>).query = 'mutated';
        }).toThrow(TypeError);
        return enforcingResult({ outcome: 'allow' });
      },
    });

    const result = invoke(engine)._unsafeUnwrap();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.input)).toBe(true);
    expect(Object.isFrozen(result.input.input.arguments)).toBe(true);
    expect(Object.isFrozen(result.signals)).toBe(true);
    expect(() => {
      (result.input.input.arguments as Record<string, unknown>).query = 'mutated';
    }).toThrow(TypeError);
    expect(() =>
      (result.signals as LifecycleSignalEnvelope[]).push({} as LifecycleSignalEnvelope),
    ).toThrow(TypeError);
  });

  it('preserves arbitrary bounded handler metadata keys, including fixed-shape collisions', () => {
    const engine = makeEngine([makeHandler('metadata', 1)], {
      metadata: (input) =>
        enforcingResult({
          outcome: 'allow',
          signals: [
            causallyDerivedSignal(
              input,
              'metadata-signal',
              handlerMetadata([
                ['customer.custom', 'retained'],
                ['outcome', true],
                ['entries', 7],
                ['metadata', null],
              ]),
            ),
          ],
        }),
    });

    expect(invoke(engine)._unsafeUnwrap().signals[0]?.payload.metadata).toEqual({
      'customer.custom': 'retained',
      outcome: true,
      entries: 7,
      metadata: null,
    });
  });

  it('allows enforcing signals that omit metadata and defaults it', () => {
    const engine = makeEngine([makeHandler('omitted-metadata', 1)], {
      'omitted-metadata': (input) => {
        const signal = causallyDerivedSignal(input, 'omitted-metadata-signal');
        delete (signal.payload as { metadata?: unknown }).metadata;
        return enforcingResult({ outcome: 'allow', signals: [signal] });
      },
    });

    const result = invoke(engine)._unsafeUnwrap();

    expect(result).toMatchObject({ outcome: 'allow' });
    expect(result.signals[0]?.payload.metadata).toEqual({});
  });

  it('rejects malformed handler metadata without invoking accessors or proxy traps', () => {
    const execute = (metadata: unknown) => {
      const engine = makeEngine([makeHandler('metadata-boundary', 1)], {
        'metadata-boundary': (input) =>
          enforcingResult({
            outcome: 'allow',
            signals: [
              causallyDerivedSignal(
                input,
                'metadata-boundary-signal',
                metadata as ReturnType<typeof handlerMetadata>,
              ),
            ],
          }),
      });
      return invoke(engine)._unsafeUnwrap();
    };

    expect(execute({ same: 1, Ａ: 2, A: 3 })).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_error',
    });
    expect(execute({ A: 1, Ａ: 2 })).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_error',
    });

    let accessorCalls = 0;
    const accessorEntry = {};
    Object.defineProperty(accessorEntry, 'never-read', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return 'never-read';
      },
    });
    expect(execute(accessorEntry)).toMatchObject({ outcome: 'deny' });
    expect(accessorCalls).toBe(0);

    let proxyTraps = 0;
    const proxy = new Proxy(
      {},
      {
        get() {
          proxyTraps += 1;
          throw new Error('proxy trap');
        },
      },
    );
    expect(execute(proxy)).toMatchObject({ outcome: 'deny' });
    expect(proxyTraps).toBe(0);

    let unknownGetterCalls = 0;
    const boundedMetadata: Record<string, unknown> = {};
    for (let index = 0; index < 4_096; index += 1) {
      Object.defineProperty(boundedMetadata, `unknown-${index}`, {
        enumerable: true,
        get() {
          unknownGetterCalls += 1;
          throw new Error('unknown metadata must not be read');
        },
      });
    }
    expect(execute(boundedMetadata)).toMatchObject({ outcome: 'deny' });
    expect(unknownGetterCalls).toBe(0);
  });

  it('applies the responsible handler failure policy before committing over-capacity signals', () => {
    const handlers = Array.from({ length: 33 }, (_, index) =>
      makeHandler(`signal-${index}`, 33 - index, { failurePolicy: 'fail_closed' }),
    );
    const implementations = Object.fromEntries(
      handlers.map((handler) => [
        handler.identity.implementationRef,
        (input: Parameters<LifecycleInterceptorHandler>[0]) =>
          enforcingResult({
            outcome: 'allow',
            signals: Array.from({ length: 32 }, (_, index) =>
              causallyDerivedSignal(input, `${handler.handler.id}-${index}`),
            ),
          }),
      ]),
    ) as Record<string, LifecycleInterceptorHandler>;
    const result = invoke(
      makeEngine(handlers, implementations, { totalTimeoutMs: 10_000 }),
    )._unsafeUnwrap();

    expect(result).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_error',
      handlerId: 'signal-32',
    });
    expect(result.signals).toHaveLength(1_024);
  });

  it.each([
    [9, 288],
    [32, 1_024],
  ])(
    'preserves every accepted signal at the %i by 32 aggregate boundary',
    (handlerCount, expected) => {
      const handlers = Array.from({ length: handlerCount }, (_, index) =>
        makeHandler(`bulk-${index}`, handlerCount - index),
      );
      const implementations = Object.fromEntries(
        handlers.map((handler) => [
          handler.identity.implementationRef,
          (input: Parameters<LifecycleInterceptorHandler>[0]) =>
            enforcingResult({
              outcome: 'allow',
              signals: Array.from({ length: 32 }, (_, index) =>
                causallyDerivedSignal(input, `${handler.handler.id}-${index}`),
              ),
            }),
        ]),
      ) as Record<string, LifecycleInterceptorHandler>;

      const result = invoke(
        makeEngine(handlers, implementations, { totalTimeoutMs: 10_000 }),
      )._unsafeUnwrap();
      expect(result.outcome).toBe('allow');
      expect(result.signals).toHaveLength(expected);
    },
  );

  it('drains a rejected genuine native Promise through the captured intrinsic reaction', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    const throwingCatchAccessor = vi.fn(() => {
      throw new Error('handler-controlled catch accessor');
    });
    const rejectedCatchOverride = vi.fn(() => Promise.reject(new Error('secondary rejection')));
    const throwingAccessorPromise = Promise.reject(new Error('accessor rejection'));
    const rejectedOverridePromise = Promise.reject(new Error('override rejection'));
    Object.defineProperty(throwingAccessorPromise, 'catch', {
      configurable: true,
      get: throwingCatchAccessor,
    });
    Object.defineProperty(rejectedOverridePromise, 'catch', {
      configurable: true,
      value: rejectedCatchOverride,
    });
    let proxyTrapCount = 0;
    const proxyResult = new Proxy(
      {},
      {
        get() {
          proxyTrapCount += 1;
          throw new Error('proxy trap');
        },
      },
    );
    const engine = makeEngine(
      [
        makeHandler('throwing-accessor', 4, { safety: 'advisory' }),
        makeHandler('rejected-override', 5, { safety: 'advisory' }),
        makeHandler('proxy', 1),
      ],
      {
        'throwing-accessor': () => throwingAccessorPromise,
        'rejected-override': () => rejectedOverridePromise,
        proxy: () => proxyResult,
      },
    );

    try {
      expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
        outcome: 'deny',
        reason: 'lifecycle_interceptor_error',
        handlerId: 'proxy',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(throwingCatchAccessor).not.toHaveBeenCalled();
      expect(rejectedCatchOverride).not.toHaveBeenCalled();
      expect(unhandledRejections).toEqual([]);
      expect(proxyTrapCount).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('does not add, remove, reorder, or invoke process-level fatal listeners while draining engine promises', async () => {
    const unhandled = vi.fn();
    const uncaught = vi.fn();
    process.on('unhandledRejection', unhandled);
    process.on('uncaughtException', uncaught);
    const beforeUnhandled = process.listeners('unhandledRejection');
    const beforeUncaught = process.listeners('uncaughtException');
    const rejected = Promise.reject(new Error('engine-owned rejection'));
    const engine = makeEngine([makeHandler('regular-promise', 1, { safety: 'advisory' })], {
      'regular-promise': () => rejected,
    });

    try {
      expect(invoke(engine)._unsafeUnwrap().outcome).toBe('allow');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(uncaught).not.toHaveBeenCalled();
      expect(process.listeners('unhandledRejection')).toEqual(beforeUnhandled);
      expect(process.listeners('uncaughtException')).toEqual(beforeUncaught);
      expect(process.listenerCount('unhandledRejection')).toBe(beforeUnhandled.length);
      expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught.length);
    } finally {
      process.off('unhandledRejection', unhandled);
      process.off('uncaughtException', uncaught);
    }
  });

  it('drains a rejected intrinsic Promise subclass', async () => {
    class NativePromiseSubclass<T> extends Promise<T> {}
    const rejected = NativePromiseSubclass.reject(new Error('expected rejection'));
    const engine = makeEngine([makeHandler('subclass', 1, { safety: 'advisory' })], {
      subclass: () => rejected,
    });

    expect(invoke(engine)._unsafeUnwrap().outcome).toBe('allow');
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it.each(['throwing Symbol.species', 'throwing constructor accessor'])(
    'rejects a %s Promise under the trusted synchronous-handler contract without global listeners',
    (caseName) => {
      class NativePromiseSubclass<T> extends Promise<T> {
        static get [Symbol.species](): PromiseConstructor {
          if (caseName === 'throwing Symbol.species') throw new Error('hostile species');
          return Promise;
        }
      }
      const pending = new NativePromiseSubclass<never>(() => undefined);
      if (caseName === 'throwing constructor accessor') {
        Object.defineProperty(pending, 'constructor', {
          get() {
            throw new Error('hostile constructor');
          },
        });
      }
      const beforeUnhandled = process.listeners('unhandledRejection');
      const beforeUncaught = process.listeners('uncaughtException');
      const engine = makeEngine([makeHandler('strict-promise', 1)], {
        'strict-promise': () => pending,
      });

      expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
        outcome: 'deny',
        reason: 'lifecycle_interceptor_error',
        handlerId: 'strict-promise',
      });
      expect(process.listeners('unhandledRejection')).toEqual(beforeUnhandled);
      expect(process.listeners('uncaughtException')).toEqual(beforeUncaught);
    },
  );

  it('rejects sparse arrays with hostile prototypes before parsing reads inherited indices', () => {
    let inheritedIndexReads = 0;
    const signals = new Array<unknown>(1);
    Object.setPrototypeOf(
      signals,
      Object.create(Array.prototype, {
        0: {
          configurable: true,
          enumerable: true,
          get() {
            inheritedIndexReads += 1;
            throw new Error('inherited array index trap');
          },
        },
      }),
    );
    const engine = makeEngine([makeHandler('sparse-array', 1)], {
      'sparse-array': () => enforcingResult({ outcome: 'allow', signals }),
    });

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_error',
      handlerId: 'sparse-array',
    });
    expect(inheritedIndexReads).toBe(0);
  });

  it('rejects accessor-backed output before parsing invokes the accessor', () => {
    let getterCalls = 0;
    const accessorResult = {};
    Object.defineProperty(accessorResult, 'outcome', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'success';
      },
    });
    const engine = makeEngine([makeHandler('accessor', 1)], { accessor: () => accessorResult });

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_error',
    });
    expect(getterCalls).toBe(0);
  });

  it('rejects bounded hostile unknown top-level output fields without executing their accessors', () => {
    const output = enforcingResult({ outcome: 'allow' });
    let getterCalls = 0;
    for (let index = 0; index < 4_096; index += 1) {
      Object.defineProperty(output, `ignored-${index}`, {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error('unknown output field must not be read');
        },
      });
    }
    const engine = makeEngine([makeHandler('known-fields-only', 1)], {
      'known-fields-only': () => output,
    });

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_error',
      handlerId: 'known-fields-only',
    });
    expect(getterCalls).toBe(0);
  });

  it('rejects nested unknown output fields without executing their accessors', () => {
    let getterCalls = 0;
    const output = enforcingResult({ outcome: 'allow' });
    Object.defineProperty(output.result, 'unexpected', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('nested unknown output field must not be read');
      },
    });
    const engine = makeEngine([makeHandler('nested-unknown', 1)], {
      'nested-unknown': () => output,
    });

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_error',
      handlerId: 'nested-unknown',
    });
    expect(getterCalls).toBe(0);
  });

  it('checks the deadline after hostile-output inspection before choosing a failure policy', () => {
    let reads = 0;
    const clock: LifecycleInterceptorClock = {
      now: () => {
        reads += 1;
        return reads >= 5 ? 6 : 0;
      },
    };
    const accessorResult = {};
    Object.defineProperty(accessorResult, 'outcome', {
      enumerable: true,
      get: () => 'success',
    });
    const engine = makeEngine(
      [makeHandler('late-inspection', 1, { timeoutMs: 5 })],
      { 'late-inspection': () => accessorResult },
      { clock },
    );

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_timeout',
      handlerId: 'late-inspection',
    });
  });

  it('does not execute handlers when the recursion limit has been reached', () => {
    const handler = vi.fn(() => enforcingResult({ outcome: 'allow' }));
    const engine = makeEngine([makeHandler('guarded', 1)], { guarded: handler });
    const input = makeInput({
      context: {
        aggregate: { type: 'thread', id: 'thread-1' },
        correlationId: 'correlation-1',
        recursion: { depth: 4, maxDepth: 4 },
        provenance: { source: 'test-source' },
      },
    });

    expect(invoke(engine, input)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_recursion_limit',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('audits identity, decision, duration, and redacted transform metadata', () => {
    const entries: AuditEntry[] = [];
    const auditLogger = {
      logLifecycleInterceptor: vi.fn((entry: AuditEntry) => entries.push(entry)),
    } as unknown as AuditLogger;
    const engine = makeEngine(
      [makeHandler('redactor', 1)],
      {
        redactor: () =>
          enforcingResult({
            outcome: 'transform',
            transform: {
              hook,
              argumentsPatch: { authorization: 'Bearer top-secret', query: 'safe' },
            },
          }),
      },
      { auditLogger },
    );

    expect(invoke(engine)._unsafeUnwrap().outcome).toBe('allow');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'lifecycle.interceptor',
      details: {
        handlerId: 'redactor',
        decision: 'transform',
        reason: 'handler_transform',
        transform: { kind: 'tool_arguments_patch', fieldCount: 2 },
      },
    });
    expect(JSON.stringify(entries[0])).not.toContain('top-secret');
    expect(JSON.stringify(entries[0])).not.toContain('Bearer');
  });

  it('commits an allow before its durable audit can exhaust that handler deadline', () => {
    const clock = makeClock();
    const entries: AuditEntry[] = [];
    const auditLogger = {
      logLifecycleInterceptor: vi.fn((entry: AuditEntry) => {
        entries.push(entry);
        clock.advance(6);
      }),
    } as unknown as AuditLogger;
    const engine = makeEngine(
      [makeHandler('audit-late', 1, { timeoutMs: 5 })],
      { 'audit-late': () => enforcingResult({ outcome: 'allow' }) },
      { clock, auditLogger },
    );

    expect(invoke(engine)._unsafeUnwrap().outcome).toBe('allow');
    expect(auditLogger.logLifecycleInterceptor).toHaveBeenCalledOnce();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      details: { decision: 'allow', reason: 'handler_allow' },
    });
  });

  it('audits the committed post-audit decisions exactly, including transform, fail-open failure, and total timeout', () => {
    const clock = makeClock();
    const entries: AuditEntry[] = [];
    const auditLogger = {
      logLifecycleInterceptor: vi.fn((entry: AuditEntry) => {
        entries.push(entry);
        clock.advance(6);
      }),
    } as unknown as AuditLogger;

    const transform = makeEngine(
      [makeHandler('transform-after-audit', 1, { timeoutMs: 5 })],
      {
        'transform-after-audit': () =>
          enforcingResult({
            outcome: 'transform',
            transform: { hook, argumentsPatch: { audited: true } },
          }),
      },
      { clock, totalTimeoutMs: 50, auditLogger },
    );
    expect(invoke(transform)._unsafeUnwrap()).toMatchObject({
      outcome: 'allow',
      input: { input: { arguments: { query: 'original', audited: true } } },
    });
    expect(entries.at(-1)).toMatchObject({
      details: { decision: 'transform', reason: 'handler_transform' },
    });

    const failOpen = makeEngine(
      [makeHandler('fail-open-after-audit', 1, { safety: 'advisory', timeoutMs: 5 })],
      {
        'fail-open-after-audit': () => {
          throw new Error('expected advisory failure');
        },
      },
      { clock, totalTimeoutMs: 50, auditLogger },
    );
    expect(invoke(failOpen)._unsafeUnwrap().outcome).toBe('allow');
    expect(entries.at(-1)).toMatchObject({
      details: { decision: 'error', reason: 'lifecycle_interceptor_error' },
    });

    const failClosed = makeEngine(
      [makeHandler('fail-closed-after-audit', 1, { timeoutMs: 5 })],
      {
        'fail-closed-after-audit': () => {
          throw new Error('expected enforcing failure');
        },
      },
      { clock, totalTimeoutMs: 50, auditLogger },
    );
    expect(invoke(failClosed)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_error',
      handlerId: 'fail-closed-after-audit',
    });
    expect(entries.at(-1)).toMatchObject({
      details: { decision: 'error', reason: 'lifecycle_interceptor_error' },
    });

    const enforcing = vi.fn(() => enforcingResult({ outcome: 'allow' }));
    const totalTimeout = makeEngine(
      [
        makeHandler('advisory-before-total', 2, { safety: 'advisory', timeoutMs: 50 }),
        makeHandler('enforcing-after-total', 1),
      ],
      { 'advisory-before-total': advisoryResult, 'enforcing-after-total': enforcing },
      { clock, totalTimeoutMs: 5, auditLogger },
    );
    expect(invoke(totalTimeout)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_total_timeout',
    });
    expect(enforcing).not.toHaveBeenCalled();
    expect(entries.at(-1)).toMatchObject({
      details: {
        handlerId: 'lifecycle-engine',
        decision: 'deny',
        reason: 'lifecycle_interceptor_total_timeout',
      },
    });
  });

  it('preserves a terminal deny when completion crosses the aggregate deadline', () => {
    let reads = 0;
    const clock: LifecycleInterceptorClock = {
      now: () => {
        reads += 1;
        return reads >= 10 ? 6 : 0;
      },
    };
    const entries: AuditEntry[] = [];
    const auditLogger = {
      logLifecycleInterceptor: vi.fn((entry: AuditEntry) => entries.push(entry)),
    } as unknown as AuditLogger;
    const next = vi.fn(() => enforcingResult({ outcome: 'allow' }));
    const engine = makeEngine(
      [makeHandler('terminal-deny', 2), makeHandler('unresolved-enforcing', 1)],
      {
        'terminal-deny': () => enforcingResult({ outcome: 'deny', reason: 'would deny' }),
        'unresolved-enforcing': next,
      },
      { auditLogger, clock, totalTimeoutMs: 5 },
    );

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'would deny',
    });
    expect(next).not.toHaveBeenCalled();
    expect(entries.at(-1)).toMatchObject({ details: { reason: 'handler_deny' } });
  });

  it('never weakens approval, fail-closed, or recursion denials at an exact deadline', () => {
    const approvalReads = { value: 0 };
    const approvalClock: LifecycleInterceptorClock = {
      now: () => (approvalReads.value++ >= 9 ? 5 : 0),
    };
    const approval = makeEngine(
      [makeHandler('approval', 1)],
      {
        approval: () =>
          enforcingResult({
            outcome: 'require_approval',
            reason: 'approval required',
            approvalKey: 'approval-1',
          }),
      },
      { clock: approvalClock, totalTimeoutMs: 5 },
    )
      .intercept({ persona: 'assistant', hook }, makeInput())
      ._unsafeUnwrap();
    expect(approval).toMatchObject({ outcome: 'require_approval', approvalKey: 'approval-1' });

    const clock = makeClock();
    const auditLogger = {
      logLifecycleInterceptor: vi.fn(() => clock.advance(5)),
    } as unknown as AuditLogger;
    const failClosed = makeEngine(
      [makeHandler('failure', 1)],
      {
        failure: () => {
          throw new Error('failure');
        },
      },
      { clock, totalTimeoutMs: 5, auditLogger },
    );
    expect(invoke(failClosed)._unsafeUnwrap().outcome).toBe('deny');

    const recursionClock = makeClock();
    const recursionAudit = {
      logLifecycleInterceptor: vi.fn(() => recursionClock.advance(5)),
    } as unknown as AuditLogger;
    const recursion = makeEngine(
      [makeHandler('unreachable', 1)],
      { unreachable: () => enforcingResult({ outcome: 'allow' }) },
      { clock: recursionClock, totalTimeoutMs: 5, auditLogger: recursionAudit },
    );
    expect(
      invoke(
        recursion,
        makeInput({
          context: {
            aggregate: { type: 'thread', id: 'thread-1' },
            correlationId: 'correlation-1',
            recursion: { depth: 4, maxDepth: 4 },
            provenance: { source: 'test-source' },
          },
        }),
      )._unsafeUnwrap(),
    ).toMatchObject({ outcome: 'deny', reason: 'lifecycle_recursion_limit' });
  });

  it.each([
    ['exactly before terminal materialization', 9],
    ['exactly during terminal materialization', 10],
  ])(
    'preserves an ordinary deny %s without re-entering a throwing audit sink',
    (_position, deadlineRead) => {
      let reads = 0;
      const clock: LifecycleInterceptorClock = {
        now: () => {
          reads += 1;
          return reads >= deadlineRead ? 5 : 0;
        },
      };
      const auditLogger = {
        logLifecycleInterceptor: vi.fn(() => {
          throw new Error('audit sink unavailable');
        }),
      } as unknown as AuditLogger;
      const advisory = vi.fn();
      const enforcing = vi.fn();
      const engine = makeEngine(
        [
          makeHandler('ordinary-deny', 3),
          makeHandler('unresolved-advisory', 2, { safety: 'advisory' }),
          makeHandler('unresolved-enforcing', 1),
        ],
        {
          'ordinary-deny': () => enforcingResult({ outcome: 'deny', reason: 'ordinary decision' }),
          'unresolved-advisory': advisory,
          'unresolved-enforcing': enforcing,
        },
        { clock, totalTimeoutMs: 5, auditLogger },
      );

      expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
        outcome: 'deny',
        reason: 'ordinary decision',
      });
      expect(advisory).not.toHaveBeenCalled();
      expect(enforcing).not.toHaveBeenCalled();
      expect(auditLogger.logLifecycleInterceptor).toHaveBeenCalledOnce();
    },
  );

  it('keeps an already-materialized aggregate timeout without re-auditing it', () => {
    let reads = 0;
    const clock: LifecycleInterceptorClock = {
      now: () => {
        reads += 1;
        return reads >= 3 ? 5 : 0;
      },
    };
    const auditLogger = {
      logLifecycleInterceptor: vi.fn(() => {
        throw new Error('audit sink unavailable');
      }),
    } as unknown as AuditLogger;
    const advisory = vi.fn();
    const enforcing = vi.fn();
    const engine = makeEngine(
      [
        makeHandler('unresolved-advisory', 2, { safety: 'advisory' }),
        makeHandler('unresolved-enforcing', 1),
      ],
      { 'unresolved-advisory': advisory, 'unresolved-enforcing': enforcing },
      { clock, totalTimeoutMs: 5, auditLogger },
    );

    expect(invoke(engine)._unsafeUnwrap()).toMatchObject({
      outcome: 'deny',
      reason: 'lifecycle_interceptor_total_timeout',
    });
    expect(advisory).not.toHaveBeenCalled();
    expect(enforcing).not.toHaveBeenCalled();
    expect(auditLogger.logLifecycleInterceptor).toHaveBeenCalledOnce();
  });
});

describe('native interceptor examples', () => {
  it('provides deterministic native allow and tool-deny handlers', () => {
    const input = LifecycleInterceptorEnvelopeSchema.parse(makeInput());

    expect(nativeAllowInterceptor(input)).toMatchObject({ result: { outcome: 'allow' } });
    expect(createNativeToolNameDenyInterceptor(['web_search'])(input)).toMatchObject({
      result: { outcome: 'deny', reason: 'tool_denied_by_native_policy' },
    });
  });
});

describe('bounded interceptor JSON proxy rejection', () => {
  it.each(['root object', 'root array', 'nested object', 'nested array'])(
    'rejects a %s before proxy traps run',
    (kind) => {
      let trapCount = 0;
      const proxy = (value: object) =>
        new Proxy(value, {
          get(target, key, receiver) {
            trapCount += 1;
            return Reflect.get(target, key, receiver);
          },
          getPrototypeOf(target) {
            trapCount += 1;
            return Reflect.getPrototypeOf(target);
          },
          ownKeys(target) {
            trapCount += 1;
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor(target, key) {
            trapCount += 1;
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        });
      const argumentsValue =
        kind === 'root object'
          ? proxy({})
          : kind === 'root array'
            ? proxy(['value'])
            : kind === 'nested object'
              ? { nested: proxy({}) }
              : { nested: proxy(['value']) };

      const parsed = LifecycleInterceptorEnvelopeSchema.safeParse({
        version: 'v1',
        interceptionId: 'interception-1',
        hook,
        context: {
          aggregate: { type: 'thread', id: 'thread-1' },
          correlationId: 'correlation-1',
          recursion: { depth: 0, maxDepth: 4 },
          provenance: { source: 'test-source' },
        },
        input: { toolCallId: 'tool-call-1', toolName: 'web_search', arguments: argumentsValue },
      });

      expect(parsed.success).toBe(false);
      expect(trapCount).toBe(0);
    },
  );

  it('accepts ordinary records and rejects array extras without reading them', () => {
    let getterCalls = 0;
    const values = ['safe'];
    for (let index = 0; index < 4_096; index += 1) {
      Object.defineProperty(values, `ignored-${index}`, {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error('array extra must not be read');
        },
      });
    }
    const envelope = {
      ...makeInput(),
      input: {
        toolCallId: 'tool-call-1',
        toolName: 'web_search',
        arguments: { values },
      },
    };

    expect(LifecycleInterceptorEnvelopeSchema.safeParse(envelope).success).toBe(false);
    expect(getterCalls).toBe(0);
    expect(
      LifecycleInterceptorEnvelopeSchema.safeParse({
        ...envelope,
        input: {
          ...envelope.input,
          arguments: { nested: { unbounded: true } },
        },
      }).success,
    ).toBe(true);
  });

  it('charges serialized numeric primitives while accepting numeric boundary values', () => {
    const parsed = LifecycleInterceptorEnvelopeSchema.safeParse({
      ...makeInput(),
      input: {
        toolCallId: 'tool-call-1',
        toolName: 'web_search',
        arguments: {
          largest: Number.MAX_VALUE,
          smallest: Number.MIN_VALUE,
          negative: -Number.MAX_VALUE,
          zero: -0,
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(
        Buffer.byteLength(JSON.stringify(parsed.data.input.arguments), 'utf8'),
      ).toBeLessThanOrEqual(32_768);
      expect(parsed.data.input.arguments).toMatchObject({
        largest: Number.MAX_VALUE,
        smallest: Number.MIN_VALUE,
        negative: -Number.MAX_VALUE,
        zero: -0,
      });
    }
  });

  it('enforces the JSON byte limit exactly after ordinary-record detachment', () => {
    const keys = Array.from({ length: 8 }, (_, index) => `value${index}`);
    const empty = Object.fromEntries(keys.map((key) => [key, '']));
    const overhead = Buffer.byteLength(JSON.stringify(empty), 'utf8');
    const remaining = 32_768 - overhead;
    const atLimit = Object.fromEntries(
      keys.map((key, index) => [key, 'x'.repeat(index < 7 ? 4_096 : remaining - 7 * 4_096)]),
    );
    const overLimit = { ...atLimit, value7: `${atLimit.value7}x` };

    expect(Buffer.byteLength(JSON.stringify(atLimit), 'utf8')).toBe(32_768);
    expect(
      LifecycleInterceptorEnvelopeSchema.safeParse({
        ...makeInput(),
        input: { toolCallId: 'tool-call-1', toolName: 'web_search', arguments: atLimit },
      }).success,
    ).toBe(true);
    expect(
      LifecycleInterceptorEnvelopeSchema.safeParse({
        ...makeInput(),
        input: { toolCallId: 'tool-call-1', toolName: 'web_search', arguments: overLimit },
      }).success,
    ).toBe(false);
  });

  it('rejects NFKC-colliding keys at every nested dynamic-record level', () => {
    expect(
      LifecycleInterceptorEnvelopeSchema.safeParse({
        ...makeInput(),
        input: {
          toolCallId: 'tool-call-1',
          toolName: 'web_search',
          arguments: { nested: { A: 1, Ａ: 2 } },
        },
      }).success,
    ).toBe(false);
    expect(
      LifecycleInterceptorTransformSchema.safeParse({
        hook,
        argumentsPatch: { A: 1, Ａ: 2 },
      }).success,
    ).toBe(false);
  });

  it('rejects accessor-backed ordinary records without invoking the getter', () => {
    let getterCalls = 0;
    const argumentsValue = {};
    Object.defineProperty(argumentsValue, 'entries', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('entries getter must not run');
      },
    });

    expect(
      LifecycleInterceptorEnvelopeSchema.safeParse({
        ...makeInput(),
        input: { toolCallId: 'tool-call-1', toolName: 'web_search', arguments: argumentsValue },
      }).success,
    ).toBe(false);
    expect(getterCalls).toBe(0);
  });
});
