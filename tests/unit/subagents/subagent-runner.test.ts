import { describe, it, expect, vi } from 'vitest';
import { ok, err } from 'neverthrow';
import {
  SubAgentRunner,
  type SubAgentInvokeContext,
} from '../../../src/subagents/subagent-runner.js';
import type { LoadedSubAgent, SubAgentServices } from '../../../src/subagents/subagent-types.js';
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
