import { describe, it, expect, vi } from 'vitest';
import { ok, err } from 'neverthrow';
import {
  DEFAULT_LIFECYCLE_SUBAGENT_TIMEOUT_MS,
  MAX_LIFECYCLE_SUBAGENT_MODEL_ATTEMPTS,
  SubAgentRunner,
  type SubAgentInvokeContext,
} from '../../../src/subagents/subagent-runner.js';
import type {
  LoadedLifecycleSubAgentCapability,
  LoadedSubAgent,
  LifecycleSubAgentRunFn,
  SubAgentServices,
} from '../../../src/subagents/subagent-types.js';
import type { ModelResolver } from '../../../src/subagents/model-resolver.js';
import { SubAgentError } from '../../../src/core/errors/index.js';
import type pino from 'pino';
import type { ObservabilityService } from '../../../src/observability/langfuse/observability-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<LoadedSubAgent> = {}): LoadedSubAgent {
  return {
    manifest: {
      name: 'test-agent',
      version: '0.1.0',
      description: 'A test sub-agent',
      model: { provider: 'anthropic', name: 'claude-haiku-4-5-20251001', maxTokens: 2048 },
      requiredCapabilities: ['memory.access'],
      rootPaths: [],
      timeoutMs: 30_000,
    },
    promptContents: ['You are a test agent.', 'Be helpful.'],
    run: vi.fn().mockResolvedValue(ok({ summary: 'Done', data: {} })),
    rootDir: '/tmp/subagents/test-agent',
    ...overrides,
  };
}

function makeContext(overrides: Partial<SubAgentInvokeContext> = {}): SubAgentInvokeContext {
  return {
    threadId: 'thread-1',
    personaId: 'assistant',
    personaSubagents: ['test-agent'],
    personaCapabilities: {
      allow: ['memory.access'],
      requireApproval: [],
    },
    ...overrides,
  };
}

function makeLifecycleContext(
  overrides: Partial<SubAgentInvokeContext> = {},
): SubAgentInvokeContext {
  return makeContext({
    serviceScope: 'none',
    lifecycle: {
      expectedIdentity: {
        version: 'v1',
        handlerId: 'test-handler',
        runtimeKind: 'subagent',
        implementationRef: 'test-agent',
        implementationVersion: '0.1.0',
        mode: 'event',
        inputContract: 'talon.lifecycle.event.envelope.v1',
        outputContract: 'talon.lifecycle.signal.envelopes.v1',
      },
    },
    ...overrides,
  });
}

function makeLifecycleContextForCapability(
  capability: LoadedLifecycleSubAgentCapability,
): SubAgentInvokeContext {
  const expectedIdentity = makeLifecycleContext().lifecycle!.expectedIdentity;
  return makeLifecycleContext({
    lifecycle: {
      expectedIdentity: {
        ...expectedIdentity,
        mode: capability.mode,
        inputContract: capability.inputContract,
        outputContract: capability.outputContract,
        ...(capability.interceptorSafety
          ? { interceptorSafety: capability.interceptorSafety }
          : {}),
      },
    },
  });
}

function lifecycleCapableAgent(overrides: Partial<LoadedSubAgent> = {}): LoadedSubAgent {
  const agent = makeAgent(overrides);
  return {
    ...agent,
    lifecycleCapabilities: [
      {
        mode: 'event',
        inputContract: 'talon.lifecycle.event.envelope.v1',
        outputContract: 'talon.lifecycle.signal.envelopes.v1',
      },
    ],
    ...overrides,
    lifecycleRun: (overrides.lifecycleRun ?? overrides.run ?? agent.run) as LifecycleSubAgentRunFn,
  };
}

const mockResolver = {
  resolve: vi.fn().mockResolvedValue(ok({} as any)),
} as unknown as ModelResolver;

const mockLogger = {
  child: vi.fn().mockReturnThis(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
} as unknown as pino.Logger;

const mockServices = {
  memory: {},
  schedules: {},
  personas: {},
  channels: {},
  threads: {},
  messages: {},
  runs: {},
  queue: {},
  logger: mockLogger,
} as unknown as SubAgentServices;

function makeRunner(
  agents: Map<string, LoadedSubAgent> = new Map(),
  resolver: ModelResolver = mockResolver,
  observability: ObservabilityService | undefined = undefined,
  subagentOverrides: Record<
    string,
    {
      model: Array<{
        provider: string;
        name: string;
        maxTokens?: number;
        timeoutMs?: number;
        providerOptions?: Record<string, unknown>;
      }>;
    }
  > = {},
): SubAgentRunner {
  return new SubAgentRunner(
    agents,
    resolver,
    mockServices,
    mockLogger,
    observability,
    subagentOverrides,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubAgentRunner', () => {
  it('fails closed when a captured lifecycle identity is replaced before model resolution', async () => {
    const replaced = lifecycleCapableAgent({
      manifest: { ...makeAgent().manifest, version: '2.0.0' },
    });
    const resolver = { resolve: vi.fn() } as unknown as ModelResolver;
    const runner = makeRunner(new Map([['test-agent', replaced]]), resolver);

    const result = await runner.execute('test-agent', {}, makeLifecycleContext());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe('Lifecycle sub-agent execution failed');
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('fails closed when the loaded lifecycle contract tuple changes', async () => {
    const replaced = lifecycleCapableAgent({
      lifecycleCapabilities: [
        {
          mode: 'event',
          inputContract: 'talon.lifecycle.signal.envelope.v1',
          outputContract: 'talon.lifecycle.signal.envelopes.v1',
        },
      ],
    });
    const resolver = { resolve: vi.fn() } as unknown as ModelResolver;
    const runner = makeRunner(new Map([['test-agent', replaced]]), resolver);

    const result = await runner.execute('test-agent', {}, makeLifecycleContext());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe('Lifecycle sub-agent execution failed');
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'event',
      capability: {
        mode: 'event',
        inputContract: 'talon.lifecycle.event.envelope.v1',
        outputContract: 'talon.lifecycle.signal.envelopes.v1',
      },
    },
    {
      name: 'signal',
      capability: {
        mode: 'signal',
        inputContract: 'talon.lifecycle.signal.envelope.v1',
        outputContract: 'talon.lifecycle.signal.envelopes.v1',
      },
    },
    {
      name: 'advisory interceptor',
      capability: {
        mode: 'interceptor',
        inputContract: 'talon.lifecycle.interceptor.input.v1',
        outputContract: 'talon.lifecycle.advisory.interceptor.output.v1',
        interceptorSafety: 'advisory',
      },
    },
  ] satisfies readonly { name: string; capability: LoadedLifecycleSubAgentCapability }[])(
    'accepts an exact canonical $name lifecycle identity',
    async ({ capability }) => {
      const agent = lifecycleCapableAgent({ lifecycleCapabilities: [capability] });
      const resolver = { resolve: vi.fn().mockResolvedValue(ok({} as any)) } as ModelResolver;
      const runner = makeRunner(new Map([['test-agent', agent]]), resolver);

      const result = await runner.execute(
        'test-agent',
        {},
        makeLifecycleContextForCapability(capability),
      );

      expect(result.isOk()).toBe(true);
      expect(resolver.resolve).toHaveBeenCalledOnce();
      expect(agent.run).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      name: 'event',
      capability: {
        mode: 'event',
        inputContract: 'talon.lifecycle.event.envelope.v1',
        outputContract: 'talon.lifecycle.signal.envelopes.v1',
      },
    },
    {
      name: 'signal',
      capability: {
        mode: 'signal',
        inputContract: 'talon.lifecycle.signal.envelope.v1',
        outputContract: 'talon.lifecycle.signal.envelopes.v1',
      },
    },
  ] satisfies readonly { name: string; capability: LoadedLifecycleSubAgentCapability }[])(
    'rejects an extraneous interceptor safety on a $name lifecycle identity',
    async ({ capability }) => {
      const agent = lifecycleCapableAgent({ lifecycleCapabilities: [capability] });
      const resolver = { resolve: vi.fn() } as unknown as ModelResolver;
      const runner = makeRunner(new Map([['test-agent', agent]]), resolver);
      const context = makeLifecycleContextForCapability(capability);
      context.lifecycle!.expectedIdentity = {
        ...context.lifecycle!.expectedIdentity,
        interceptorSafety: 'advisory',
      };

      const result = await runner.execute('test-agent', {}, context);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe('Lifecycle sub-agent execution failed');
      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(agent.run).not.toHaveBeenCalled();
    },
  );

  it('binds the callable captured before model resolution rather than a replacement', async () => {
    const originalRun = vi.fn().mockResolvedValue(ok({ summary: 'captured' }));
    const replacementRun = vi.fn().mockResolvedValue(ok({ summary: 'replacement' }));
    const agent = lifecycleCapableAgent({ run: originalRun });
    const resolver = {
      resolve: vi.fn().mockImplementation(async () => {
        agent.lifecycleRun = replacementRun;
        return ok({} as any);
      }),
    } as unknown as ModelResolver;
    const runner = makeRunner(new Map([['test-agent', agent]]), resolver);

    const result = await runner.execute('test-agent', {}, makeLifecycleContext());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().summary).toBe('captured');
    expect(originalRun).toHaveBeenCalledOnce();
    expect(replacementRun).not.toHaveBeenCalled();
  });

  it('rejects accessor-backed lifecycle authority without invoking it', async () => {
    const capability = Object.create(null, {
      mode: {
        enumerable: true,
        get: () => {
          throw new Error('trap');
        },
      },
      inputContract: { enumerable: true, value: 'talon.lifecycle.event.envelope.v1' },
      outputContract: { enumerable: true, value: 'talon.lifecycle.signal.envelopes.v1' },
    });
    const agent = lifecycleCapableAgent({ lifecycleCapabilities: [capability] as any });
    const resolver = { resolve: vi.fn() } as unknown as ModelResolver;
    const runner = makeRunner(new Map([['test-agent', agent]]), resolver);

    const result = await runner.execute('test-agent', {}, makeLifecycleContext());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe('Lifecycle sub-agent execution failed');
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it.each(['maxOutputTokens', 'timeoutMs'] as const)(
    'rejects accessor-backed lifecycle executionLimits.%s without invoking it',
    async (key) => {
      const getter = vi.fn(() => {
        throw new Error('execution limit getter must not run');
      });
      const executionLimits = Object.create(null, {
        [key]: { enumerable: true, get: getter },
      });
      const agent = lifecycleCapableAgent();
      const resolver = { resolve: vi.fn() } as unknown as ModelResolver;
      const runner = makeRunner(new Map([['test-agent', agent]]), resolver);

      const result = await runner.execute(
        'test-agent',
        {},
        makeLifecycleContext({ executionLimits: executionLimits as never }),
      );

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe('Lifecycle sub-agent execution failed');
      expect(getter).not.toHaveBeenCalled();
      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(agent.run).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid lifecycle execution limit values (%s)',
    async (value) => {
      const agent = lifecycleCapableAgent();
      const resolver = { resolve: vi.fn() } as unknown as ModelResolver;
      const runner = makeRunner(new Map([['test-agent', agent]]), resolver);

      for (const executionLimits of [{ maxOutputTokens: value }, { timeoutMs: value }] as const) {
        const result = await runner.execute(
          'test-agent',
          {},
          makeLifecycleContext({ executionLimits: executionLimits as never }),
        );

        expect(result.isErr()).toBe(true);
        expect(result._unsafeUnwrapErr().message).toBe('Lifecycle sub-agent execution failed');
      }

      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(agent.run).not.toHaveBeenCalled();
    },
  );

  it('fails closed for a proxied lifecycle context without executing proxy traps or ordinary authority', async () => {
    const traps = { get: 0, descriptor: 0 };
    const context = new Proxy(makeLifecycleContext(), {
      get: () => {
        traps.get += 1;
        throw new Error('get trap must not execute');
      },
      getOwnPropertyDescriptor: () => {
        traps.descriptor += 1;
        throw new Error('descriptor trap must not execute');
      },
    });
    const agent = lifecycleCapableAgent();
    const resolver = { resolve: vi.fn() } as unknown as ModelResolver;
    const runner = makeRunner(new Map([['test-agent', agent]]), resolver);

    const result = await runner.execute('test-agent', {}, context);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe('Lifecycle sub-agent execution failed');
    expect(traps).toEqual({ get: 0, descriptor: 0 });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(agent.run).not.toHaveBeenCalled();
  });

  it('fails closed when an explicitly supplied lifecycle property is undefined', async () => {
    const observe = vi.fn();
    const observability = {
      observe,
      observeWithTraceparent: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as ObservabilityService;
    const agent = lifecycleCapableAgent();
    const resolver = { resolve: vi.fn() } as unknown as ModelResolver;
    const runner = makeRunner(new Map([['test-agent', agent]]), resolver, observability);
    const context = makeContext({ serviceScope: 'full', lifecycle: undefined });

    const result = await runner.execute('test-agent', {}, context);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe('Lifecycle sub-agent execution failed');
    expect(observe).not.toHaveBeenCalled();
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(agent.run).not.toHaveBeenCalled();
  });

  it.each(['personaSubagents', 'allow', 'requireApproval', 'approvedCapabilities'])(
    'contains a revoked proxy in lifecycle %s arrays without traps or downstream work',
    async (field) => {
      const traps = { get: 0, descriptor: 0 };
      const { proxy, revoke } = Proxy.revocable([] as string[], {
        get: () => {
          traps.get += 1;
          throw new Error('get trap must not execute');
        },
        getOwnPropertyDescriptor: () => {
          traps.descriptor += 1;
          throw new Error('descriptor trap must not execute');
        },
      });
      revoke();
      const context = makeLifecycleContext();
      if (field === 'personaSubagents') context.personaSubagents = proxy as unknown as string[];
      if (field === 'allow') context.personaCapabilities.allow = proxy as unknown as string[];
      if (field === 'requireApproval') {
        context.personaCapabilities.requireApproval = proxy as unknown as string[];
      }
      if (field === 'approvedCapabilities') {
        context.lifecycle!.approvedCapabilities = proxy as unknown as string[];
      }
      const observe = vi.fn();
      const observability = {
        observe,
        observeWithTraceparent: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
      } as unknown as ObservabilityService;
      const agent = lifecycleCapableAgent();
      const resolver = { resolve: vi.fn() } as unknown as ModelResolver;
      const runner = makeRunner(new Map([['test-agent', agent]]), resolver, observability);

      const result = await runner.execute('test-agent', {}, context);

      expect(result.isErr()).toBe(true);
      expect(traps).toEqual({ get: 0, descriptor: 0 });
      expect(observe).not.toHaveBeenCalled();
      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(agent.run).not.toHaveBeenCalled();
    },
  );

  it.each(['expectedIdentity', 'executionLimits'])(
    'contains a revoked proxy in lifecycle %s objects without traps or downstream work',
    async (field) => {
      const traps = { get: 0, descriptor: 0 };
      const { proxy, revoke } = Proxy.revocable(
        {},
        {
          get: () => {
            traps.get += 1;
            throw new Error('get trap must not execute');
          },
          getOwnPropertyDescriptor: () => {
            traps.descriptor += 1;
            throw new Error('descriptor trap must not execute');
          },
        },
      );
      revoke();
      const context = makeLifecycleContext();
      if (field === 'expectedIdentity') context.lifecycle!.expectedIdentity = proxy as never;
      if (field === 'executionLimits') context.executionLimits = proxy as never;
      const observe = vi.fn();
      const observability = {
        observe,
        observeWithTraceparent: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
      } as unknown as ObservabilityService;
      const agent = lifecycleCapableAgent();
      const resolver = { resolve: vi.fn() } as unknown as ModelResolver;
      const runner = makeRunner(new Map([['test-agent', agent]]), resolver, observability);

      const result = await runner.execute('test-agent', {}, context);

      expect(result.isErr()).toBe(true);
      expect(traps).toEqual({ get: 0, descriptor: 0 });
      expect(observe).not.toHaveBeenCalled();
      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(agent.run).not.toHaveBeenCalled();
    },
  );

  it('uses its lifecycle snapshot for error paths after the caller mutates context fields', async () => {
    let release: ((value: ReturnType<typeof err>) => void) | undefined;
    const resolver = {
      resolve: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
    } as unknown as ModelResolver;
    const runner = makeRunner(new Map([['test-agent', lifecycleCapableAgent()]]), resolver);
    const context = makeLifecycleContext();
    const pending = runner.execute('test-agent', {}, context);

    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    context.personaId = 'mutated-persona';
    context.personaSubagents = [];
    context.personaCapabilities = { allow: ['queue.write:*'], requireApproval: [] };
    context.traceparent = 'mutated-traceparent';
    release!(err(new SubAgentError('provider token=secret')));

    const result = await pending;

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe('Lifecycle sub-agent execution failed');
    expect(JSON.stringify((mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      'mutated-persona',
    );
  });

  it('times out deferred lifecycle observability and refuses a late callback', async () => {
    vi.useFakeTimers();
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);
    try {
      let callback: ((observation: any) => Promise<unknown>) | undefined;
      const observe = vi.fn(
        (_input, fn) =>
          new Promise(() => {
            callback = fn;
          }),
      );
      const observability = {
        observe,
        observeWithTraceparent: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
      } as unknown as ObservabilityService;
      const agent = lifecycleCapableAgent();
      const resolver = { resolve: vi.fn() } as unknown as ModelResolver;
      const runner = makeRunner(new Map([['test-agent', agent]]), resolver, observability);
      const pending = runner.execute(
        'test-agent',
        {},
        makeLifecycleContext({ executionLimits: { timeoutMs: 25 } }),
      );

      await vi.advanceTimersByTimeAsync(25);
      const result = await pending;
      await expect(
        callback!({ update: vi.fn(), getTraceparent: vi.fn().mockReturnValue(null) }),
      ).rejects.toThrow('timed out');
      await Promise.resolve();

      expect(result.isErr()).toBe(true);
      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(agent.run).not.toHaveBeenCalled();
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
      vi.useRealTimers();
    }
  });

  it('rejects an observer callback invoked at the exact lifecycle deadline', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(0));
      const observe = vi.fn((_input, fn) => {
        vi.setSystemTime(new Date(25));
        return fn({ update: vi.fn(), getTraceparent: vi.fn().mockReturnValue(null) });
      });
      const observability = {
        observe,
        observeWithTraceparent: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
      } as unknown as ObservabilityService;
      const agent = lifecycleCapableAgent();
      const resolver = { resolve: vi.fn() } as unknown as ModelResolver;
      const runner = makeRunner(new Map([['test-agent', agent]]), resolver, observability);

      const result = await runner.execute(
        'test-agent',
        {},
        makeLifecycleContext({ executionLimits: { timeoutMs: 25 } }),
      );

      expect(result.isErr()).toBe(true);
      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(agent.run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects observer settlement at the exact lifecycle deadline', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(0));
      const observation = { update: vi.fn(), getTraceparent: vi.fn().mockReturnValue(null) };
      const observe = vi.fn(async (_input, fn) => {
        const callbackResult = await fn(observation);
        vi.setSystemTime(new Date(25));
        return callbackResult;
      });
      const observability = {
        observe,
        observeWithTraceparent: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
      } as unknown as ObservabilityService;
      const agent = lifecycleCapableAgent();
      const runner = makeRunner(new Map([['test-agent', agent]]), mockResolver, observability);

      const result = await runner.execute(
        'test-agent',
        {},
        makeLifecycleContext({ executionLimits: { timeoutMs: 25 } }),
      );

      expect(result.isErr()).toBe(true);
      expect(agent.run).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('contains a late observer settlement rejection after a lifecycle timeout', async () => {
    vi.useFakeTimers();
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);
    try {
      let rejectSettlement: ((reason?: unknown) => void) | undefined;
      const observation = { update: vi.fn(), getTraceparent: vi.fn().mockReturnValue(null) };
      const observe = vi.fn(async (_input, fn) => {
        await fn(observation);
        return await new Promise<never>((_resolve, reject) => {
          rejectSettlement = reject;
        });
      });
      const observability = {
        observe,
        observeWithTraceparent: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
      } as unknown as ObservabilityService;
      const agent = lifecycleCapableAgent();
      const runner = makeRunner(new Map([['test-agent', agent]]), mockResolver, observability);
      const pending = runner.execute(
        'test-agent',
        {},
        makeLifecycleContext({ executionLimits: { timeoutMs: 25 } }),
      );

      await vi.advanceTimersByTimeAsync(25);
      const result = await pending;
      rejectSettlement!(new Error('late observer rejection'));
      await Promise.resolve();

      expect(result.isErr()).toBe(true);
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
      vi.useRealTimers();
    }
  });

  it('times out lifecycle observer settlement after its callback completes', async () => {
    vi.useFakeTimers();
    try {
      const observation = { update: vi.fn(), getTraceparent: vi.fn().mockReturnValue(null) };
      const observe = vi.fn(async (_input, fn) => {
        await fn(observation);
        return await new Promise(() => undefined);
      });
      const observability = {
        observe,
        observeWithTraceparent: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
      } as unknown as ObservabilityService;
      const agent = lifecycleCapableAgent();
      const runner = makeRunner(new Map([['test-agent', agent]]), mockResolver, observability);
      const pending = runner.execute(
        'test-agent',
        {},
        makeLifecycleContext({ executionLimits: { timeoutMs: 25 } }),
      );

      await vi.advanceTimersByTimeAsync(25);
      const result = await pending;

      expect(result.isErr()).toBe(true);
      expect(agent.run).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses lifecycle allow grants with exact scope or explicit wildcard, never implicit approval', async () => {
    const agent = lifecycleCapableAgent({
      manifest: {
        ...makeAgent().manifest,
        requiredCapabilities: ['memory.access:thread'],
      },
    });
    const runner = makeRunner(new Map([['test-agent', agent]]));

    const approvalOnly = await runner.execute(
      'test-agent',
      {},
      makeLifecycleContext({
        personaCapabilities: { allow: [], requireApproval: ['memory.access:thread'] },
      }),
    );
    const exact = await runner.execute(
      'test-agent',
      {},
      makeLifecycleContext({
        personaCapabilities: { allow: ['memory.access:thread'], requireApproval: [] },
      }),
    );
    const wildcard = await runner.execute(
      'test-agent',
      {},
      makeLifecycleContext({
        personaCapabilities: { allow: ['memory.access:*'], requireApproval: [] },
      }),
    );

    expect(approvalOnly.isErr()).toBe(true);
    expect(approvalOnly._unsafeUnwrapErr().message).not.toContain('memory.access');
    expect(exact.isOk()).toBe(true);
    expect(wildcard.isOk()).toBe(true);
  });

  it('accepts a requireApproval grant only with an authoritative lifecycle approval', async () => {
    const agent = lifecycleCapableAgent({
      manifest: {
        ...makeAgent().manifest,
        requiredCapabilities: ['memory.access:thread'],
      },
    });
    const runner = makeRunner(new Map([['test-agent', agent]]));

    const result = await runner.execute(
      'test-agent',
      {},
      makeLifecycleContext({
        personaCapabilities: { allow: [], requireApproval: ['memory.access:thread'] },
        lifecycle: {
          ...makeLifecycleContext().lifecycle!,
          approvedCapabilities: ['memory.access:thread'],
        },
      }),
    );

    expect(result.isOk()).toBe(true);
  });

  it('rejects an approval that is not an exact configured requireApproval policy entry', async () => {
    const agent = lifecycleCapableAgent({
      manifest: {
        ...makeAgent().manifest,
        requiredCapabilities: ['memory.access:thread'],
      },
    });
    const runner = makeRunner(new Map([['test-agent', agent]]));

    const result = await runner.execute(
      'test-agent',
      {},
      makeLifecycleContext({
        personaCapabilities: { allow: [], requireApproval: ['memory.access:thread'] },
        lifecycle: {
          ...makeLifecycleContext().lifecycle!,
          approvedCapabilities: ['memory.access:other'],
        },
      }),
    );

    expect(result.isErr()).toBe(true);
  });

  it('uses a finite default lifecycle deadline when model resolution never settles', async () => {
    vi.useFakeTimers();
    try {
      const resolver = {
        resolve: vi.fn().mockImplementation(() => new Promise(() => undefined)),
      } as unknown as ModelResolver;
      const runner = makeRunner(new Map([['test-agent', lifecycleCapableAgent()]]), resolver);
      const pending = runner.execute('test-agent', {}, makeLifecycleContext());

      await vi.advanceTimersByTimeAsync(DEFAULT_LIFECYCLE_SUBAGENT_TIMEOUT_MS);
      const result = await pending;

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe('Lifecycle sub-agent execution failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not overlap lifecycle failover after a provider ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const ignoredAbort = vi.fn(() => new Promise(() => undefined));
      const warningStart = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls.length;
      const resolver = {
        resolve: vi.fn().mockResolvedValue(ok({} as any)),
      } as unknown as ModelResolver;
      const runner = makeRunner(
        new Map([['test-agent', lifecycleCapableAgent({ run: ignoredAbort as any })]]),
        resolver,
        undefined,
        {
          'test-agent': {
            model: [
              { provider: 'openai', name: 'first' },
              { provider: 'openai', name: 'must-not-overlap' },
            ],
          },
        },
      );
      const pending = runner.execute(
        'test-agent',
        {},
        makeLifecycleContext({ executionLimits: { timeoutMs: 25 } }),
      );

      await vi.advanceTimersByTimeAsync(25);
      const result = await pending;

      expect(result.isErr()).toBe(true);
      expect(ignoredAbort).toHaveBeenCalledOnce();
      expect(resolver.resolve).toHaveBeenCalledOnce();
      expect(
        (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls.slice(warningStart),
      ).toContainEqual([
        { subagent: 'test-agent', lifecycle: true },
        'Sub-agent timed out; lifecycle execution will not overlap a failover attempt',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs ordinary timeouts as failing over to the next model', async () => {
    vi.useFakeTimers();
    try {
      const timedOutRun = vi.fn(() => new Promise(() => undefined));
      const agent = makeAgent({
        manifest: { ...makeAgent().manifest, timeoutMs: 25 },
        run: vi
          .fn()
          .mockImplementationOnce(timedOutRun)
          .mockResolvedValueOnce(ok({ summary: 'fallback succeeded' })),
      });
      const runner = makeRunner(new Map([['test-agent', agent]]), mockResolver, undefined, {
        'test-agent': {
          model: [
            { provider: 'openai', name: 'first', timeoutMs: 25 },
            { provider: 'openai', name: 'fallback', timeoutMs: 25 },
          ],
        },
      });
      const warningStart = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls.length;
      const pending = runner.execute('test-agent', {}, makeContext());

      await vi.advanceTimersByTimeAsync(25);
      const result = await pending;

      expect(result.isOk()).toBe(true);
      expect(timedOutRun).toHaveBeenCalledOnce();
      expect(
        (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls.slice(warningStart),
      ).toContainEqual([
        { subagent: 'test-agent', model: 'openai/first', timeoutMs: 25 },
        'Sub-agent timed out, failing over to next model',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aggregates an intermediate resolver timeout with earlier failures at the configured ceiling', async () => {
    vi.useFakeTimers();
    try {
      const resolver = {
        resolve: vi
          .fn()
          .mockResolvedValueOnce(err(new SubAgentError('first resolution failed')))
          .mockImplementationOnce(() => new Promise(() => undefined)),
      } as unknown as ModelResolver;
      const agent = makeAgent();
      const runner = makeRunner(new Map([['test-agent', agent]]), resolver, undefined, {
        'test-agent': {
          model: [
            { provider: 'openai', name: 'first' },
            { provider: 'openai', name: 'second' },
          ],
        },
      });
      const warningStart = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls.length;
      const pending = runner.execute(
        'test-agent',
        {},
        makeContext({ executionLimits: { timeoutMs: 25 } }),
      );

      await vi.advanceTimersByTimeAsync(25);
      const result = await pending;

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe(
        'All models failed for sub-agent "test-agent":\n' +
          '  1. openai/first (override): first resolution failed\n' +
          '  2. openai/second (override): Sub-agent "test-agent" timed out after 25ms',
      );
      expect(
        (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls.slice(warningStart),
      ).toContainEqual([
        { subagent: 'test-agent', model: 'openai/second', timeoutMs: 25 },
        'Model resolution timed out, failing over to next model',
      ]);
      expect(agent.run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aggregates a final resolver timeout with earlier failures without a failover log', async () => {
    vi.useFakeTimers();
    try {
      const resolver = {
        resolve: vi
          .fn()
          .mockResolvedValueOnce(err(new SubAgentError('first resolution failed')))
          .mockImplementationOnce(() => new Promise(() => undefined)),
      } as unknown as ModelResolver;
      const agent = makeAgent();
      const runner = makeRunner(new Map([['test-agent', agent]]), resolver, undefined, {
        'test-agent': { model: [{ provider: 'openai', name: 'first' }] },
      });
      const warningStart = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls.length;
      const pending = runner.execute(
        'test-agent',
        {},
        makeContext({ executionLimits: { timeoutMs: 25 } }),
      );

      await vi.advanceTimersByTimeAsync(25);
      const result = await pending;

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe(
        'All models failed for sub-agent "test-agent":\n' +
          '  1. openai/first (override): first resolution failed\n' +
          '  2. anthropic/claude-haiku-4-5-20251001 (manifest): Sub-agent "test-agent" timed out after 25ms',
      );
      const warningMessages = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls
        .slice(warningStart)
        .map(([, message]) => message);
      expect(warningMessages).not.toContain(
        'Model resolution timed out, failing over to next model',
      );
      expect(agent.run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aggregates a final ordinary timeout without logging a nonexistent failover', async () => {
    vi.useFakeTimers();
    try {
      let secondAttemptStarted: (() => void) | undefined;
      const secondAttemptReady = new Promise<void>((resolve) => {
        secondAttemptStarted = resolve;
      });
      const timedOutRun = vi.fn(() => {
        secondAttemptStarted!();
        return new Promise(() => undefined);
      });
      const agent = makeAgent({
        manifest: { ...makeAgent().manifest, timeoutMs: 25 },
        run: vi
          .fn()
          .mockResolvedValueOnce(err(new SubAgentError('first model failed')))
          .mockImplementationOnce(timedOutRun),
      });
      const runner = makeRunner(new Map([['test-agent', agent]]), mockResolver, undefined, {
        'test-agent': {
          model: [{ provider: 'openai', name: 'first', timeoutMs: 25 }],
        },
      });
      const warningStart = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls.length;
      const pending = runner.execute('test-agent', {}, makeContext());

      // The first rejected attempt must finish before the fallback timeout is
      // installed; advancing earlier leaves the fallback pending forever.
      await secondAttemptReady;
      await vi.advanceTimersByTimeAsync(25);
      const result = await pending;

      expect(result.isErr()).toBe(true);
      const message = result._unsafeUnwrapErr().message;
      expect(message).toContain('All models failed for sub-agent "test-agent"');
      expect(message).toContain('first model failed');
      expect(message).toContain('timed out after 25ms');
      expect(timedOutRun).toHaveBeenCalledOnce();
      const warningMessages = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls
        .slice(warningStart)
        .map(([, message]) => message);
      expect(warningMessages).not.toContain('Sub-agent timed out, failing over to next model');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds lifecycle failover attempts even when the override chain is longer', async () => {
    const resolver = {
      resolve: vi.fn().mockResolvedValue(err(new SubAgentError('provider token=secret'))),
    } as unknown as ModelResolver;
    const runner = makeRunner(
      new Map([['test-agent', lifecycleCapableAgent()]]),
      resolver,
      undefined,
      {
        'test-agent': {
          model: Array.from({ length: MAX_LIFECYCLE_SUBAGENT_MODEL_ATTEMPTS + 2 }, (_, index) => ({
            provider: 'openai',
            name: `attempt-${index}`,
          })),
        },
      },
    );

    const result = await runner.execute('test-agent', {}, makeLifecycleContext());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe('Lifecycle sub-agent execution failed');
    expect(resolver.resolve).toHaveBeenCalledTimes(MAX_LIFECYCLE_SUBAGENT_MODEL_ATTEMPTS);
  });

  it('keeps lifecycle payloads, results, and error details out of telemetry', async () => {
    const observation = { update: vi.fn(), getTraceparent: vi.fn().mockReturnValue(null) };
    const observe = vi.fn(async (_input, fn) => await fn(observation));
    const observability = {
      observe,
      observeWithTraceparent: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as ObservabilityService;
    const agent = lifecycleCapableAgent({
      run: vi
        .fn()
        .mockResolvedValue(ok({ summary: 'private summary', data: { secret: 'token=secret' } })),
    });
    const runner = makeRunner(new Map([['test-agent', agent]]), mockResolver, observability);

    const result = await runner.execute(
      'test-agent',
      { lifecycle: { untrustedInput: 'token=secret' } },
      makeLifecycleContext(),
    );

    expect(result.isOk()).toBe(true);
    expect(JSON.stringify(observe.mock.calls)).not.toContain('token=secret');
    expect(JSON.stringify(observation.update.mock.calls)).not.toContain('private summary');
    expect(JSON.stringify(observation.update.mock.calls)).not.toContain('token=secret');
    expect((agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0].telemetry).toEqual({
      isEnabled: false,
    });
  });

  it('keeps a lifecycle invocation logger-only when its context mutates during model resolution', async () => {
    let resolveModel: ((value: ReturnType<typeof ok>) => void) | undefined;
    const resolver = {
      resolve: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveModel = resolve;
          }),
      ),
    } as unknown as ModelResolver;
    const observation = { update: vi.fn(), getTraceparent: vi.fn().mockReturnValue(null) };
    const observe = vi.fn(async (observationInput, fn) => {
      expect(JSON.stringify(observationInput)).not.toContain('token=secret');
      return await fn(observation);
    });
    const observability = {
      observe,
      observeWithTraceparent: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as ObservabilityService;
    const agent = lifecycleCapableAgent({
      run: vi.fn().mockResolvedValue(ok({ summary: 'private token=secret', data: {} })),
    });
    const runner = makeRunner(new Map([['test-agent', agent]]), resolver, observability);
    const context = makeLifecycleContext({ serviceScope: 'none' });

    const pending = runner.execute('test-agent', { token: 'token=secret' }, context);
    await vi.waitFor(() => expect(resolveModel).toBeTypeOf('function'));
    context.lifecycle = undefined;
    context.serviceScope = 'full';
    resolveModel!(ok({} as any));

    const result = await pending;

    expect(result.isOk()).toBe(true);
    const runContext = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(runContext.services).toEqual({ logger: expect.anything() });
    expect(runContext.services).not.toHaveProperty('memory');
    expect(runContext.telemetry).toEqual({ isEnabled: false });
    expect(JSON.stringify(observation.update.mock.calls)).not.toContain('private token=secret');
  });

  it('retains lifecycle failover and sanitized errors when ctx.lifecycle is removed mid-resolution', async () => {
    let releaseFirst: ((value: ReturnType<typeof err>) => void) | undefined;
    const resolver = {
      resolve: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseFirst = resolve;
            }),
        )
        .mockResolvedValue(err(new SubAgentError('provider token=secret'))),
    } as unknown as ModelResolver;
    const runner = makeRunner(
      new Map([['test-agent', lifecycleCapableAgent()]]),
      resolver,
      undefined,
      {
        'test-agent': {
          model: Array.from({ length: MAX_LIFECYCLE_SUBAGENT_MODEL_ATTEMPTS + 2 }, (_, index) => ({
            provider: 'openai',
            name: `attempt-${index}`,
          })),
        },
      },
    );
    const context = makeLifecycleContext({ serviceScope: 'none' });
    const pending = runner.execute('test-agent', {}, context);

    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    context.lifecycle = undefined;
    context.serviceScope = 'full';
    releaseFirst!(err(new SubAgentError('provider token=secret')));

    const result = await pending;

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe('Lifecycle sub-agent execution failed');
    expect(resolver.resolve).toHaveBeenCalledTimes(MAX_LIFECYCLE_SUBAGENT_MODEL_ATTEMPTS);
    expect(JSON.stringify((mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      'token=secret',
    );
  });

  it.each([undefined, 'full'] as const)(
    'ignores lifecycle serviceScope=%s and keeps services unavailable',
    async (serviceScope) => {
      const agent = lifecycleCapableAgent();
      const runner = makeRunner(new Map([['test-agent', agent]]));

      const result = await runner.execute('test-agent', {}, makeLifecycleContext({ serviceScope }));

      expect(result.isOk()).toBe(true);
      const runContext = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(runContext.services).toEqual({ logger: expect.anything() });
      expect(runContext.services).not.toHaveProperty('memory');
      expect(runContext.rootPaths).toEqual([]);
      expect(runContext.telemetry).toEqual({ isEnabled: false });
    },
  );

  it('lets lifecycle callers reduce token and timeout budgets without exposing repositories', async () => {
    const agent = lifecycleCapableAgent({
      manifest: {
        ...makeAgent().manifest,
        model: { ...makeAgent().manifest.model, maxTokens: 2048 },
      },
    });
    const runner = makeRunner(new Map([['test-agent', agent]]));

    const result = await runner.execute(
      'test-agent',
      {},
      makeLifecycleContext({
        executionLimits: { maxOutputTokens: 128, timeoutMs: 500 },
      }),
    );

    expect(result.isOk()).toBe(true);
    const context = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(context.maxOutputTokens).toBe(128);
    expect(context.rootPaths).toEqual([]);
    expect(context.services).toEqual({ logger: expect.anything() });
    expect(context.services).not.toHaveProperty('memory');
  });

  it('applies a lifecycle timeout across sub-agent failover attempts', async () => {
    const slowRun = vi
      .fn()
      .mockResolvedValueOnce(err(new SubAgentError('first model failed')))
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(ok({ summary: 'late' })), 10_000)),
      );
    const agent = lifecycleCapableAgent({
      manifest: { ...makeAgent().manifest, timeoutMs: 1_000 },
      run: slowRun,
    });
    const runner = makeRunner(new Map([['test-agent', agent]]), mockResolver, undefined, {
      'test-agent': {
        model: [{ provider: 'openai', name: 'first-attempt', timeoutMs: 1_000 }],
      },
    });

    const result = await runner.execute(
      'test-agent',
      {},
      makeLifecycleContext({
        executionLimits: { timeoutMs: 25 },
      }),
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe('Lifecycle sub-agent execution failed');
    expect(slowRun).toHaveBeenCalledTimes(2);
  });

  it('bounds model resolution by the lifecycle timeout', async () => {
    const resolver = {
      resolve: vi.fn().mockImplementation(() => new Promise(() => undefined)),
    } as unknown as ModelResolver;
    const agent = lifecycleCapableAgent();
    const runner = makeRunner(new Map([['test-agent', agent]]), resolver);

    const result = await runner.execute(
      'test-agent',
      {},
      makeLifecycleContext({ executionLimits: { timeoutMs: 25 } }),
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe('Lifecycle sub-agent execution failed');
    expect(agent.run).not.toHaveBeenCalled();
  });

  it('wraps sub-agent execution in an agent observation', async () => {
    const agent = makeAgent();
    const observe = vi.fn(
      async (_input, fn) =>
        await fn({
          update: vi.fn(),
          getTraceparent: vi.fn().mockReturnValue(null),
        }),
    );
    const observability = {
      observe,
      observeWithTraceparent: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as ObservabilityService;
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents, mockResolver, observability);

    const result = await runner.execute('test-agent', { key: 'value' }, makeContext());

    expect(result.isOk()).toBe(true);
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent',
        name: 'subagent:test-agent',
        metadata: expect.objectContaining({
          threadId: 'thread-1',
          personaId: 'assistant',
        }),
      }),
      expect.any(Function),
    );
  });

  it('nests sub-agent observations under the incoming traceparent', async () => {
    const agent = makeAgent();
    const observeWithTraceparent = vi.fn(
      async (_traceparent, _input, fn) =>
        await fn({
          update: vi.fn(),
          getTraceparent: vi.fn().mockReturnValue(null),
        }),
    );
    const observability = {
      observe: vi.fn(),
      observeWithTraceparent,
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as ObservabilityService;
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents, mockResolver, observability);
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

    const result = await runner.execute(
      'test-agent',
      { key: 'value' },
      makeContext({ traceparent }),
    );

    expect(result.isOk()).toBe(true);
    expect(observeWithTraceparent).toHaveBeenCalledWith(
      traceparent,
      expect.objectContaining({
        type: 'agent',
        name: 'subagent:test-agent',
      }),
      expect.any(Function),
    );
  });

  it('executes a sub-agent and returns its result (happy path)', async () => {
    const agent = makeAgent();
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents);

    const result = await runner.execute('test-agent', { key: 'value' }, makeContext());

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.summary).toBe('Done');
    expect(value.data).toEqual({});
    expect(agent.run).toHaveBeenCalledOnce();

    // Verify the context passed to run has the assembled system prompt and maxOutputTokens
    const callArgs = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0].systemPrompt).toBe('You are a test agent.\n\nBe helpful.');
    expect(callArgs[0].maxOutputTokens).toBe(2048);
    expect(callArgs[1]).toEqual({ key: 'value' });
  });

  it('rejects unknown sub-agent name', async () => {
    const runner = makeRunner(new Map());

    const result = await runner.execute('nonexistent', {}, makeContext());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Unknown sub-agent "nonexistent"');
  });

  it('rejects sub-agent not in persona assignment list', async () => {
    const agent = makeAgent();
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents);

    const ctx = makeContext({ personaSubagents: ['other-agent'] });
    const result = await runner.execute('test-agent', {}, ctx);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('not assigned to persona');
  });

  it('rejects sub-agent with unsatisfied capabilities', async () => {
    const agent = makeAgent({
      manifest: {
        ...makeAgent().manifest,
        requiredCapabilities: ['memory.access', 'net.http'],
      },
    });
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents);

    // Persona only has memory.access, not net.http
    const ctx = makeContext({
      personaCapabilities: { allow: ['memory.access'], requireApproval: [] },
    });
    const result = await runner.execute('test-agent', {}, ctx);

    expect(result.isErr()).toBe(true);
    const errorMsg = result._unsafeUnwrapErr().message;
    expect(errorMsg).toContain('lacks capabilities');
    expect(errorMsg).toContain('net.http');
  });

  it('accepts capabilities from requireApproval list', async () => {
    const agent = makeAgent();
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents);

    // Capability is in requireApproval, not allow
    const ctx = makeContext({
      personaCapabilities: { allow: [], requireApproval: ['memory.access'] },
    });
    const result = await runner.execute('test-agent', {}, ctx);

    expect(result.isOk()).toBe(true);
  });

  it('respects timeout on slow sub-agents', async () => {
    const slowRun = vi
      .fn()
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(ok({ summary: 'late' })), 10_000)),
      );
    const agent = makeAgent({
      manifest: { ...makeAgent().manifest, timeoutMs: 100 },
      run: slowRun,
    });
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents);

    const result = await runner.execute('test-agent', {}, makeContext());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('timed out after 100ms');
  });

  it('wraps sub-agent run errors in ToolError', async () => {
    const failingRun = vi.fn().mockResolvedValue(err(new SubAgentError('Something went wrong')));
    const agent = makeAgent({ run: failingRun });
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents);

    const result = await runner.execute('test-agent', {}, makeContext());

    expect(result.isErr()).toBe(true);
    const toolErr = result._unsafeUnwrapErr();
    expect(toolErr.code).toBe('TOOL_ERROR');
    expect(toolErr.message).toContain('Something went wrong');
  });

  it('includes the original sub-agent error message in the failure summary', async () => {
    const subAgentError = new SubAgentError('Something went wrong');
    const failingRun = vi.fn().mockResolvedValue(err(subAgentError));
    const agent = makeAgent({ run: failingRun });
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents);

    const result = await runner.execute('test-agent', {}, makeContext());

    expect(result.isErr()).toBe(true);
    const toolErr = result._unsafeUnwrapErr();
    expect(toolErr.code).toBe('TOOL_ERROR');
    expect(toolErr.message).toContain('Something went wrong');
    expect(toolErr.message).toContain('All models failed');
  });

  it('returns error when model resolution fails', async () => {
    const { ConfigError } = await import('../../../src/core/errors/index.js');
    const failingResolver = {
      resolve: vi.fn().mockResolvedValue(err(new ConfigError('No credentials'))),
    } as unknown as ModelResolver;

    const agent = makeAgent();
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents, failingResolver);

    const result = await runner.execute('test-agent', {}, makeContext());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('All models failed');
    expect(result._unsafeUnwrapErr().message).toContain('No credentials');
  });

  it('passes telemetry.isEnabled=false when no observability service is provided (Noop)', async () => {
    const agent = makeAgent();
    const agents = new Map([['test-agent', agent]]);
    // No observability → defaults to NoopObservabilityService inside the runner
    const runner = makeRunner(agents, mockResolver, undefined);

    const result = await runner.execute('test-agent', {}, makeContext());

    expect(result.isOk()).toBe(true);
    const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ctx.telemetry).toEqual({ isEnabled: false });
  });

  it('passes telemetry.isEnabled=true when a real observability service is provided', async () => {
    const agent = makeAgent();
    const agents = new Map([['test-agent', agent]]);
    const observe = vi.fn(async (_input, fn) =>
      fn({ update: vi.fn(), getTraceparent: vi.fn().mockReturnValue(null) }),
    );
    const realObservability = {
      observe,
      observeWithTraceparent: vi.fn(),
      startWithTraceparent: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as ObservabilityService;
    const runner = makeRunner(agents, mockResolver, realObservability);

    const result = await runner.execute('test-agent', {}, makeContext());

    expect(result.isOk()).toBe(true);
    const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ctx.telemetry).toEqual({ isEnabled: true });
  });

  describe('failover', () => {
    it('uses override model when config override exists', async () => {
      const agent = makeAgent();
      const agents = new Map([['test-agent', agent]]);

      const overrideModel = {} as any;
      const manifestModel = {} as any;
      const resolver = {
        resolve: vi.fn().mockImplementation(async (config: any) => {
          if (config.provider === 'openai') return ok(overrideModel);
          return ok(manifestModel);
        }),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [{ provider: 'openai', name: 'gpt-5.4-spark' }],
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isOk()).toBe(true);

      const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.model).toBe(overrideModel);
    });

    it('falls back to next model in chain when first fails resolution', async () => {
      const { ConfigError } = await import('../../../src/core/errors/index.js');
      const agent = makeAgent();
      const agents = new Map([['test-agent', agent]]);

      const fallbackModel = {} as any;
      const resolver = {
        resolve: vi
          .fn()
          .mockResolvedValueOnce(err(new ConfigError('No credentials for ollama')))
          .mockResolvedValueOnce(ok(fallbackModel)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [
            { provider: 'ollama', name: 'qwen3-30b' },
            { provider: 'anthropic', name: 'claude-haiku-4-5-20251001' },
          ],
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isOk()).toBe(true);

      const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.model).toBe(fallbackModel);
    });

    it('falls back to manifest model when all overrides fail', async () => {
      const { ConfigError } = await import('../../../src/core/errors/index.js');
      const agent = makeAgent();
      const agents = new Map([['test-agent', agent]]);

      const manifestModel = {} as any;
      const resolver = {
        resolve: vi
          .fn()
          .mockResolvedValueOnce(err(new ConfigError('No credentials for ollama')))
          .mockResolvedValueOnce(ok(manifestModel)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [{ provider: 'ollama', name: 'qwen3-30b' }],
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isOk()).toBe(true);

      // Second resolve call should be the manifest model
      expect(resolver.resolve).toHaveBeenCalledTimes(2);
      const secondCall = (resolver.resolve as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(secondCall.provider).toBe('anthropic');
      expect(secondCall.name).toBe('claude-haiku-4-5-20251001');
    });

    it('retries with next model when run() throws a runtime error', async () => {
      const agent = makeAgent({
        run: vi
          .fn()
          .mockRejectedValueOnce(new Error('ECONNREFUSED'))
          .mockResolvedValueOnce(ok({ summary: 'Done via fallback' })),
      });
      const agents = new Map([['test-agent', agent]]);

      const model1 = {} as any;
      const model2 = {} as any;
      const resolver = {
        resolve: vi.fn().mockResolvedValueOnce(ok(model1)).mockResolvedValueOnce(ok(model2)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [
            { provider: 'ollama', name: 'qwen3-30b' },
            { provider: 'anthropic', name: 'claude-haiku-4-5-20251001' },
          ],
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().summary).toBe('Done via fallback');
    });

    it('returns error listing all failures when entire chain exhausted', async () => {
      const { ConfigError } = await import('../../../src/core/errors/index.js');
      const agent = makeAgent();
      const agents = new Map([['test-agent', agent]]);

      const resolver = {
        resolve: vi
          .fn()
          .mockResolvedValueOnce(err(new ConfigError('No creds for ollama')))
          .mockResolvedValueOnce(err(new ConfigError('No creds for anthropic'))),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [{ provider: 'ollama', name: 'qwen3-30b' }],
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isErr()).toBe(true);
      const msg = result._unsafeUnwrapErr().message;
      expect(msg).toContain('All models failed');
      expect(msg).toContain('ollama');
      expect(msg).toContain('anthropic');
    });

    it('uses maxTokens from override when specified', async () => {
      const agent = makeAgent();
      const agents = new Map([['test-agent', agent]]);
      const overrideModel = {} as any;
      const resolver = {
        resolve: vi.fn().mockResolvedValue(ok(overrideModel)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [{ provider: 'openai', name: 'gpt-5.4-spark', maxTokens: 8192 }],
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isOk()).toBe(true);
      const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.maxOutputTokens).toBe(8192);
    });

    it('uses manifest maxTokens when override does not specify it', async () => {
      const agent = makeAgent();
      const agents = new Map([['test-agent', agent]]);
      const overrideModel = {} as any;
      const resolver = {
        resolve: vi.fn().mockResolvedValue(ok(overrideModel)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [{ provider: 'openai', name: 'gpt-5.4-spark' }],
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isOk()).toBe(true);
      const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.maxOutputTokens).toBe(2048); // from manifest default
    });

    it('behaves unchanged when no overrides configured', async () => {
      const agent = makeAgent();
      const agents = new Map([['test-agent', agent]]);
      const runner = makeRunner(agents);

      const result = await runner.execute('test-agent', { key: 'value' }, makeContext());
      expect(result.isOk()).toBe(true);
      expect(agent.run).toHaveBeenCalledOnce();
    });

    it('uses per-model timeoutMs from override config', async () => {
      const agent = makeAgent({
        manifest: { ...makeAgent().manifest, timeoutMs: 30_000 },
        run: vi.fn().mockResolvedValue(ok({ summary: 'Done' })),
      });
      const agents = new Map([['test-agent', agent]]);
      const resolver = {
        resolve: vi.fn().mockResolvedValue(ok({} as any)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [{ provider: 'ollama', name: 'qwen3-30b', timeoutMs: 120_000 }],
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isOk()).toBe(true);
      const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.abortSignal).toBeInstanceOf(AbortSignal);
    });

    it('falls back to manifest timeoutMs when override has no timeoutMs', async () => {
      const agent = makeAgent({
        run: vi.fn().mockResolvedValue(ok({ summary: 'Done' })),
      });
      const agents = new Map([['test-agent', agent]]);
      const resolver = {
        resolve: vi.fn().mockResolvedValue(ok({} as any)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [{ provider: 'ollama', name: 'qwen3-30b' }],
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isOk()).toBe(true);
      const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.abortSignal).toBeInstanceOf(AbortSignal);
    });

    it('fails over to next model on timeout instead of terminating', async () => {
      const agent = makeAgent({
        manifest: { ...makeAgent().manifest, timeoutMs: 50 },
        run: vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => setTimeout(() => resolve(ok({ summary: 'late' })), 10_000)),
          )
          .mockResolvedValueOnce(ok({ summary: 'Done via fallback' })),
      });
      const agents = new Map([['test-agent', agent]]);

      const model1 = {} as any;
      const model2 = {} as any;
      const resolver = {
        resolve: vi.fn().mockResolvedValueOnce(ok(model1)).mockResolvedValueOnce(ok(model2)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [
            { provider: 'ollama', name: 'qwen3-30b', timeoutMs: 50 },
            { provider: 'anthropic', name: 'claude-haiku-4-5-20251001', timeoutMs: 5000 },
          ],
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().summary).toBe('Done via fallback');
      expect(agent.run).toHaveBeenCalledTimes(2);
    });

    it('aborts the signal when a model times out', async () => {
      let capturedSignal: AbortSignal | undefined;
      const agent = makeAgent({
        manifest: { ...makeAgent().manifest, timeoutMs: 50 },
        run: vi
          .fn()
          .mockImplementationOnce((ctx: any) => {
            capturedSignal = ctx.abortSignal;
            return new Promise((resolve) =>
              setTimeout(() => resolve(ok({ summary: 'late' })), 10_000),
            );
          })
          .mockResolvedValueOnce(ok({ summary: 'Done' })),
      });
      const agents = new Map([['test-agent', agent]]);
      const resolver = {
        resolve: vi.fn().mockResolvedValue(ok({} as any)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [
            { provider: 'ollama', name: 'qwen3-30b', timeoutMs: 50 },
            { provider: 'anthropic', name: 'claude-haiku-4-5-20251001' },
          ],
        },
      });

      await runner.execute('test-agent', {}, makeContext());
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal!.aborted).toBe(true);
    });

    it('wraps providerOptions under the active model entry provider name', async () => {
      const agent = makeAgent({
        run: vi.fn().mockResolvedValue(ok({ summary: 'Done' })),
      });
      const agents = new Map([['test-agent', agent]]);
      const resolver = {
        resolve: vi.fn().mockResolvedValue(ok({} as any)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [
            {
              provider: 'ollama',
              name: 'qwen',
              providerOptions: {
                chat_template_kwargs: { enable_thinking: false },
              },
            },
          ],
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isOk()).toBe(true);

      const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.providerOptions).toEqual({
        ollama: { chat_template_kwargs: { enable_thinking: false } },
      });
    });

    it('leaves providerOptions undefined when override has none', async () => {
      const agent = makeAgent({
        run: vi.fn().mockResolvedValue(ok({ summary: 'Done' })),
      });
      const agents = new Map([['test-agent', agent]]);
      const resolver = {
        resolve: vi.fn().mockResolvedValue(ok({} as any)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [{ provider: 'ollama', name: 'qwen' }],
        },
      });

      await runner.execute('test-agent', {}, makeContext());
      const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.providerOptions).toBeUndefined();
    });

    it('does not leak providerOptions across chain entries on failover', async () => {
      const agent = makeAgent({
        run: vi
          .fn()
          .mockRejectedValueOnce(new Error('first model blew up'))
          .mockResolvedValueOnce(ok({ summary: 'Done via fallback' })),
      });
      const agents = new Map([['test-agent', agent]]);
      const resolver = {
        resolve: vi
          .fn()
          .mockResolvedValueOnce(ok({} as any))
          .mockResolvedValueOnce(ok({} as any)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [
            {
              provider: 'ollama',
              name: 'qwen',
              providerOptions: { chat_template_kwargs: { enable_thinking: false } },
            },
            { provider: 'anthropic', name: 'claude-haiku-4-5-20251001' },
          ],
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isOk()).toBe(true);

      const calls = (agent.run as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][0].providerOptions).toEqual({
        ollama: { chat_template_kwargs: { enable_thinking: false } },
      });
      expect(calls[1][0].providerOptions).toBeUndefined();
    });

    it('drops providerOptions on non-ollama providers (gate against config injection)', async () => {
      const agent = makeAgent({
        run: vi.fn().mockResolvedValue(ok({ summary: 'Done' })),
      });
      const agents = new Map([['test-agent', agent]]);
      const resolver = {
        resolve: vi.fn().mockResolvedValue(ok({} as any)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [
            {
              provider: 'anthropic',
              name: 'claude-haiku-4-5-20251001',
              // providerOptions on a typed provider is either silently dropped
              // by the AI SDK or a config-injection vector (temperature /
              // max_tokens override). Runner must drop it and log a warning.
              providerOptions: { temperature: 0.99, max_tokens: 999999 },
            },
          ],
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isOk()).toBe(true);

      const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.providerOptions).toBeUndefined();
    });
  });
});
