/**
 * Unit tests for AgentRunner.
 *
 * The Agent SDK is dynamically imported, so we mock it via vi.mock().
 * A mock DaemonContext provides all required repositories and subsystems.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err } from 'neverthrow';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const mockQuery = vi.fn();
const mockCreateSdkMcpServer = vi.fn((options: { name: string; tools?: unknown[] }) => ({
  type: 'sdk',
  name: options.name,
  instance: {
    connect: vi.fn(),
    tools: options.tools ?? [],
  },
}));
const mockSdkTool = vi.fn(
  (
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: (args: Record<string, string>) => Promise<unknown>,
  ) => ({
    name,
    description,
    inputSchema,
    handler,
  }),
);

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  createSdkMcpServer: (...args: unknown[]) => mockCreateSdkMcpServer(...args),
  tool: (...args: unknown[]) => mockSdkTool(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { AgentRunner } from '../../../src/daemon/agent-runner.js';
import type { DaemonContext } from '../../../src/daemon/daemon-context.js';
import { type QueueItem, QueueItemStatus } from '../../../src/queue/queue-types.js';
import { ProviderRegistry } from '../../../src/providers/provider-registry.js';
import { ClaudeCodeProvider } from '../../../src/providers/claude-code-provider.js';
import type {
  ObservationHandle,
  StartedObservationHandle,
} from '../../../src/observability/langfuse/observability-types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeQueueItem(overrides: Record<string, unknown> = {}): QueueItem {
  return {
    id: 'qi-001',
    threadId: 'thread-001',
    type: 'message',
    status: QueueItemStatus.Claimed,
    attempts: 0,
    maxAttempts: 3,
    payload: { personaId: 'persona-001', content: 'Hello agent' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as QueueItem;
}

const GENERATION_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

function makeObservationHandle(traceparent: string | null): ObservationHandle {
  return {
    update: vi.fn(),
    getTraceparent: vi.fn().mockReturnValue(traceparent),
  };
}

function makeStartedObservationHandle(traceparent: string | null): StartedObservationHandle {
  return {
    update: vi.fn(),
    getTraceparent: vi.fn().mockReturnValue(traceparent),
    end: vi.fn(),
  };
}

function makeContextManagement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    triggerMetric: 'cache_read_input_tokens',
    thresholdRatio: 0.4,
    recentMessageCount: 10,
    summarizer: 'session-summarizer',
    ...overrides,
  };
}

function makeAgentRunnerProviderConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    command: 'claude',
    contextWindowTokens: 200000,
    contextManagement: makeContextManagement(),
    ...overrides,
  };
}

function makeMockContext(): DaemonContext {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };

  return {
    db: {} as any,
    config: {
      agentRunner: {
        defaultProvider: 'claude-code',
        providers: {
          'claude-code': makeAgentRunnerProviderConfig(),
        },
      },
    } as any,
    configPath: '',
    dataDir: '/tmp/test-data',
    repos: {
      queue: {} as any,
      thread: {
        findById: vi.fn().mockReturnValue(ok({
          id: 'thread-001',
          channel_id: 'chan-001',
          external_id: 'ext-001',
        })),
      } as any,
      channel: {
        findById: vi.fn().mockReturnValue(ok({
          id: 'chan-001',
          name: 'test-channel',
        })),
      } as any,
      persona: {
        findById: vi.fn().mockReturnValue(ok({
          id: 'persona-001',
          name: 'TestBot',
        })),
      } as any,
      schedule: {} as any,
      audit: {} as any,
      message: {
        insert: vi.fn().mockReturnValue(ok({})),
      } as any,
      run: {
        insert: vi.fn().mockReturnValue(ok({})),
        updateStatus: vi.fn().mockReturnValue(ok({})),
        updateSessionId: vi.fn().mockReturnValue(ok({})),
        updateTokens: vi.fn().mockReturnValue(ok({})),
        getLatestSessionId: vi.fn().mockReturnValue(ok(null)),
        getLatestProviderName: vi.fn().mockReturnValue(ok(null)),
      } as any,
      binding: {} as any,
      memory: {} as any,
    },
    channelRegistry: {
      get: vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue(ok(undefined)),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      }),
      listAll: vi.fn().mockReturnValue([
        { name: 'test-channel' },
        { name: 'other-channel' },
      ]),
    } as any,
    queueManager: {} as any,
    scheduler: {} as any,
    personaLoader: {
      getByName: vi.fn().mockReturnValue(ok({
        config: {
          model: 'claude-sonnet-4-20250514',
          skills: [],
          capabilities: { allow: [] },
        },
        systemPromptContent: 'You are a test bot.',
        resolvedCapabilities: {
          allow: ['channel.send:*', 'memory.access', 'schedule.manage'],
          requireApproval: [],
        },
      })),
    } as any,
    sessionTracker: {
      getSessionId: vi.fn().mockReturnValue(undefined),
      setSessionId: vi.fn(),
      wasRotated: vi.fn().mockReturnValue(false),
      rotateSession: vi.fn(),
    } as any,
    contextRoller: null,
    contextAssembler: {
      assemble: vi.fn().mockReturnValue({
        text: '',
        summaryFound: false,
        recentMessageCount: 0,
        charCount: 0,
      }),
    } as any,
    threadWorkspace: {
      ensureDirectories: vi.fn().mockReturnValue(ok('/tmp/test-data/workspaces/thread-001')),
    } as any,
    auditLogger: {} as any,
    skillResolver: {
      mergePromptFragments: vi.fn().mockReturnValue(''),
    } as any,
    loadedSkills: [],
    messagePipeline: {} as any,
    observability: {
      observe: vi.fn(async (input, fn) => {
        const traceparent = input.type === 'generation' ? GENERATION_TRACEPARENT : null;
        return await fn(makeObservationHandle(traceparent));
      }),
      start: vi.fn(() => makeStartedObservationHandle(null)),
      startWithTraceparent: vi.fn(() => makeStartedObservationHandle(null)),
      observeWithTraceparent: vi.fn(async (_traceparent, _input, fn) =>
        await fn(makeObservationHandle(null))),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as any,
    hostToolsBridge: {
      path: '/tmp/test-data/host-tools.sock',
    } as any,
    providerRegistry: new ProviderRegistry(
      {
        'claude-code': makeAgentRunnerProviderConfig(),
      },
      {
        'claude-code': (config) => new ClaudeCodeProvider(config),
      },
    ),
    backgroundAgentManager: null,
    logger: mockLogger as any,
  };
}

/**
 * Creates an async generator that mimics the Agent SDK query() output.
 * Yields an assistant message with text, then a result message with metadata.
 */
async function* makeAgentStream(overrides: Record<string, unknown> = {}) {
  yield {
    type: 'assistant',
    message: {
      content: [{ text: 'Hello from the agent!' }],
    },
  };
  yield {
    type: 'result',
    subtype: 'success',
    result: 'Hello from the agent!',
    session_id: 'session-abc-123',
    total_cost_usd: 0.005,
    usage: { input_tokens: 100, output_tokens: 50 },
    is_error: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentRunner', () => {
  let ctx: DaemonContext;
  let runner: AgentRunner;

  beforeEach(() => {
    ctx = makeMockContext();
    runner = new AgentRunner(ctx);
    vi.clearAllMocks();

    // Re-apply default mocks cleared by vi.clearAllMocks()
    ctx = makeMockContext();
    runner = new AgentRunner(ctx);
    mockQuery.mockReset();
    mockQuery.mockReturnValue(makeAgentStream());
    mockCreateSdkMcpServer.mockClear();
    mockSdkTool.mockClear();
  });

  // -------------------------------------------------------------------------
  // Validation errors (early returns before agent query)
  // -------------------------------------------------------------------------

  describe('validation errors', () => {
    it('returns error when payload.personaId is missing', async () => {
      const item = makeQueueItem({ payload: { content: 'hello' } });

      const result = await runner.run(item);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('missing payload.personaId');
    });

    it('returns error when persona not found in DB', async () => {
      vi.mocked(ctx.repos.persona.findById).mockReturnValue(ok(null));
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('persona not found');
    });

    it('returns error when loaded persona not found via personaLoader', async () => {
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(ok(undefined as any));
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('loaded persona not found');
    });

    it('returns error when run insert fails', async () => {
      vi.mocked(ctx.repos.run.insert).mockReturnValue(
        err(new Error('DB write failed') as any),
      );
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('failed to create run record');
    });

    it('returns error when workspace setup fails and marks run as failed', async () => {
      vi.mocked(ctx.threadWorkspace.ensureDirectories).mockReturnValue(
        err(new Error('cannot create workspace directory') as any),
      );
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('cannot create workspace directory');
      expect(ctx.repos.run.updateStatus).toHaveBeenCalledWith(
        expect.any(String),
        'failed',
        expect.objectContaining({ error: 'cannot create workspace directory' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Successful end-to-end query
  // -------------------------------------------------------------------------

  describe('successful run', () => {
    it('runs agent query end-to-end and returns Ok', async () => {
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isOk()).toBe(true);
      expect(mockQuery).toHaveBeenCalledOnce();
    });

    it('stores session ID when result includes one', async () => {
      const item = makeQueueItem();

      await runner.run(item);

      expect(ctx.sessionTracker.setSessionId).toHaveBeenCalledWith(
        'thread-001',
        'session-abc-123',
      );
      expect(ctx.repos.run.updateSessionId).toHaveBeenCalledWith(
        expect.any(String),
        'session-abc-123',
      );
    });

    it('sends typing indicators when connector supports it', async () => {
      const item = makeQueueItem();
      const connector = ctx.channelRegistry.get('test-channel')!;

      await runner.run(item);

      expect(connector.sendTyping).toHaveBeenCalledWith('ext-001');
    });

    it('records outbound message after successful query', async () => {
      const item = makeQueueItem();

      await runner.run(item);

      expect(ctx.repos.message.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          thread_id: 'thread-001',
          direction: 'outbound',
          content: JSON.stringify({ body: 'Hello from the agent!' }),
        }),
      );
    });

    it('updates run to completed on success', async () => {
      const item = makeQueueItem();

      await runner.run(item);

      expect(ctx.repos.run.updateStatus).toHaveBeenCalledWith(
        expect.any(String),
        'completed',
        expect.objectContaining({ ended_at: expect.any(Number) }),
      );
    });

    it('creates root, retriever, and generation observations for a fresh session', async () => {
      await runner.run(makeQueueItem());

      expect(ctx.observability.observe).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agent',
          name: 'foreground-run',
          trace: expect.objectContaining({
            sessionId: 'thread-001',
            metadata: expect.objectContaining({
              threadId: 'thread-001',
              provider: 'claude-code',
            }),
          }),
        }),
        expect.any(Function),
      );
      expect(ctx.observability.observe).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'retriever',
          name: 'previous-context',
        }),
        expect.any(Function),
      );
      expect(ctx.observability.observe).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'generation',
          name: 'provider-attempt',
          model: 'claude-sonnet-4-20250514',
        }),
        expect.any(Function),
      );
    });

    it('uses the selected provider recentMessageCount when assembling fresh-session context', async () => {
      await runner.run(makeQueueItem());

      expect(ctx.contextAssembler.assemble).toHaveBeenCalledWith('thread-001', 10);
    });

    it('passes the configured cache-read trigger metric into the roller', async () => {
      ctx.contextRoller = {
        checkAndRotate: vi.fn().mockResolvedValue(undefined),
      } as any;
      mockQuery.mockReturnValue(
        makeAgentStream({
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 80_000,
            cache_creation_input_tokens: 2_000,
          },
        }),
      );

      await runner.run(makeQueueItem());

      expect(ctx.contextRoller.checkAndRotate).toHaveBeenCalledWith(
        'thread-001',
        'persona-001',
        {
          ratio: 0.4,
          inputTokens: 100,
          rawMetric: 80_000,
          rawMetricName: 'cache_read_input_tokens',
        },
        0.4,
        'session-summarizer',
      );
    });

    it('passes the configured cache-total trigger metric into the roller', async () => {
      ctx.contextRoller = {
        checkAndRotate: vi.fn().mockResolvedValue(undefined),
      } as any;
      mockQuery.mockReturnValue(
        makeAgentStream({
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 9_240,
            cache_creation_input_tokens: 109_113,
          },
        }),
      );
      ctx.providerRegistry = new ProviderRegistry(
        {
          'claude-code': makeAgentRunnerProviderConfig({
            contextWindowTokens: 300_000,
            contextManagement: makeContextManagement({
              triggerMetric: 'cache_total_input_tokens',
              thresholdRatio: 0.39,
            }),
          }) as any,
        },
        {
          'claude-code': (config) => new ClaudeCodeProvider(config),
        },
      ) as any;
      runner = new AgentRunner(ctx);

      await runner.run(makeQueueItem());

      expect(ctx.contextRoller.checkAndRotate).toHaveBeenCalledWith(
        'thread-001',
        'persona-001',
        {
          ratio: 118_353 / 300_000,
          inputTokens: 100,
          rawMetric: 118_353,
          rawMetricName: 'cache_total_input_tokens',
        },
        0.39,
        'session-summarizer',
      );
    });

    it('runs Gemini through the existing CLI branch, persists provider_name, and sends a waiting message', async () => {
      const cliRun = vi.fn().mockResolvedValue({
        output: 'Gemini result',
        sessionId: undefined,
        usage: {
          inputTokens: 500_000,
          outputTokens: 120,
        },
        isError: false,
      });
      const connector = ctx.channelRegistry.get('test-channel')!;
      ctx.contextRoller = {
        checkAndRotate: vi.fn().mockResolvedValue(undefined),
      } as any;
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(ok({
        config: {
          model: 'gemini-2.5-pro',
          provider: 'gemini-cli',
          skills: [],
          capabilities: { allow: [] },
        },
        systemPromptContent: 'You are a Gemini test bot.',
        resolvedCapabilities: {
          allow: ['channel.send:*', 'memory.access', 'schedule.manage'],
          requireApproval: [],
        },
      } as any));
      ctx.config.agentRunner.defaultProvider = 'gemini-cli';
      ctx.providerRegistry = {
        get: vi.fn().mockImplementation((name: string) => (
          name === 'gemini-cli'
            ? {
                provider: {
                  name: 'gemini-cli',
                  createExecutionStrategy: () => ({
                    type: 'cli' as const,
                    supportsSessionResumption: false as const,
                    run: cliRun,
                  }),
                  prepareBackgroundInvocation: vi.fn(),
                  parseBackgroundResult: vi.fn(),
                  estimateContextUsage: vi.fn().mockReturnValue({
                    inputTokens: 500_000,
                    metrics: {
                      input_tokens: 500_000,
                    },
                  }),
                },
                config: makeAgentRunnerProviderConfig({
                  command: 'gemini',
                  contextWindowTokens: 1_000_000,
                  contextManagement: makeContextManagement({
                    triggerMetric: 'input_tokens',
                    thresholdRatio: 0.8,
                  }),
                }),
              }
            : undefined
        )),
        getDefault: vi.fn().mockImplementation(() => ({
          provider: {
            name: 'gemini-cli',
            createExecutionStrategy: () => ({
              type: 'cli' as const,
              supportsSessionResumption: false as const,
              run: cliRun,
            }),
            prepareBackgroundInvocation: vi.fn(),
            parseBackgroundResult: vi.fn(),
            estimateContextUsage: vi.fn().mockReturnValue({
              inputTokens: 500_000,
              metrics: {
                input_tokens: 500_000,
              },
            }),
          },
          config: makeAgentRunnerProviderConfig({
            command: 'gemini',
            contextWindowTokens: 1_000_000,
            contextManagement: makeContextManagement({
              triggerMetric: 'input_tokens',
              thresholdRatio: 0.8,
            }),
          }),
        })),
      } as any;

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(cliRun).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-2.5-pro',
        }),
      );
      expect(ctx.repos.run.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          provider_name: 'gemini-cli',
          session_id: null,
        }),
      );
      expect(ctx.sessionTracker.setSessionId).not.toHaveBeenCalled();
      expect(ctx.repos.run.updateSessionId).not.toHaveBeenCalled();
      expect(connector.send).toHaveBeenNthCalledWith(1, 'ext-001', {
        body: 'Thinking...',
      });
      expect(connector.send).toHaveBeenNthCalledWith(2, 'ext-001', {
        body: 'Gemini result',
      });
      expect(ctx.repos.message.insert).toHaveBeenCalledTimes(1);
      expect(ctx.contextRoller.checkAndRotate).toHaveBeenCalledWith(
        'thread-001',
        'persona-001',
        {
          ratio: 0.5,
          inputTokens: 500_000,
          rawMetric: 500_000,
          rawMetricName: 'input_tokens',
        },
        0.8,
        'session-summarizer',
      );
    });

    it('skips context rotation when provider context management is disabled', async () => {
      ctx.contextRoller = {
        checkAndRotate: vi.fn().mockResolvedValue(undefined),
      } as any;
      ctx.providerRegistry = new ProviderRegistry(
        {
          'claude-code': makeAgentRunnerProviderConfig({
            contextManagement: {
              enabled: false,
            },
          }) as any,
        },
        {
          'claude-code': (config) => new ClaudeCodeProvider(config),
        },
      ) as any;
      runner = new AgentRunner(ctx);

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(ctx.contextRoller.checkAndRotate).not.toHaveBeenCalled();
    });

    it('logs and skips rotation when the configured trigger metric is unavailable', async () => {
      ctx.contextRoller = {
        checkAndRotate: vi.fn().mockResolvedValue(undefined),
      } as any;
      const connector = ctx.channelRegistry.get('test-channel')!;
      ctx.providerRegistry = {
        getDefault: vi.fn().mockReturnValue({
          provider: {
            name: 'gemini-cli',
            createExecutionStrategy: () => ({
              type: 'cli' as const,
              supportsSessionResumption: false as const,
              run: vi.fn().mockResolvedValue({
                output: 'Gemini result',
                sessionId: undefined,
                usage: {
                  inputTokens: 500_000,
                  outputTokens: 120,
                },
                isError: false,
              }),
            }),
            prepareBackgroundInvocation: vi.fn(),
            parseBackgroundResult: vi.fn(),
            estimateContextUsage: vi.fn().mockReturnValue({
              inputTokens: 500_000,
              metrics: {
                input_tokens: 500_000,
              },
            }),
          },
          config: makeAgentRunnerProviderConfig({
            command: 'gemini',
            contextWindowTokens: 1_000_000,
            contextManagement: makeContextManagement({
              triggerMetric: 'cache_read_input_tokens',
            }),
          }),
        }),
      } as any;

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(connector.send).toHaveBeenNthCalledWith(1, 'ext-001', {
        body: 'Thinking...',
      });
      expect(connector.send).toHaveBeenNthCalledWith(2, 'ext-001', {
        body: 'Gemini result',
      });
      expect(ctx.contextRoller.checkAndRotate).not.toHaveBeenCalled();
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-001',
          metric: 'cache_read_input_tokens',
          provider: 'gemini-cli',
        }),
        expect.stringContaining('configured trigger metric not available'),
      );
    });
  });

  describe('background task notifications', () => {
    it('delivers host-generated background task notifications without invoking Claude', async () => {
      const item = makeQueueItem({
        type: 'collaboration',
        payload: {
          personaId: 'persona-001',
          kind: 'background_task_notification',
          taskId: 'task-123',
          status: 'completed',
          content: '[Background Task Complete] Task task-123: "Refactor auth"',
        },
      });
      const connector = ctx.channelRegistry.get('test-channel')!;

      const result = await runner.run(item);

      expect(result.isOk()).toBe(true);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(connector.send).toHaveBeenCalledWith('ext-001', {
        body: '[Background Task Complete] Task task-123: "Refactor auth"',
      });
      expect(ctx.repos.message.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          thread_id: 'thread-001',
          direction: 'outbound',
          content: JSON.stringify({
            body: '[Background Task Complete] Task task-123: "Refactor auth"',
          }),
          idempotency_key: 'background-task:task-123:completed',
          run_id: null,
        }),
      );
      expect(ctx.repos.run.insert).not.toHaveBeenCalled();
      expect(ctx.repos.run.updateStatus).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Session restore from DB (BUG-008)
  // -------------------------------------------------------------------------

  describe('session restore from DB on restart', () => {
    it('falls back to DB session when in-memory tracker has none', async () => {
      vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue(undefined);
      vi.mocked(ctx.repos.run.getLatestSessionId).mockReturnValue(ok('session-from-db'));
      const item = makeQueueItem();

      await runner.run(item);

      // Should have passed the DB session to the agent SDK
      const queryCall = mockQuery.mock.calls[0]![0] as { options: { resume?: string } };
      expect(queryCall.options.resume).toBe('session-from-db');
      expect(ctx.observability.observe).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'retriever', name: 'previous-context' }),
        expect.any(Function),
      );
    });

    it('does not eagerly seed tracker from DB (waits for successful run)', async () => {
      vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue(undefined);
      vi.mocked(ctx.repos.run.getLatestSessionId).mockReturnValue(ok('session-from-db'));
      const item = makeQueueItem();

      await runner.run(item);

      // The tracker should be seeded with the *result* session_id (session-abc-123),
      // not the DB-restored one (session-from-db), because the SDK returns a new
      // session_id after a successful resumed run.
      expect(ctx.sessionTracker.setSessionId).toHaveBeenCalledWith(
        'thread-001',
        'session-abc-123',
      );
    });

    it('does not query DB when in-memory session exists', async () => {
      vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue('session-in-memory');
      const item = makeQueueItem();

      await runner.run(item);

      expect(ctx.repos.run.getLatestSessionId).not.toHaveBeenCalled();
    });

    it('records DB session_id in run insert', async () => {
      vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue(undefined);
      vi.mocked(ctx.repos.run.getLatestSessionId).mockReturnValue(ok('session-from-db'));
      const item = makeQueueItem();

      await runner.run(item);

      expect(ctx.repos.run.insert).toHaveBeenCalledWith(
        expect.objectContaining({ session_id: 'session-from-db' }),
      );
    });

    it('starts fresh when neither in-memory nor DB session exists', async () => {
      vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue(undefined);
      vi.mocked(ctx.repos.run.getLatestSessionId).mockReturnValue(ok(null));
      const item = makeQueueItem();

      await runner.run(item);

      const queryCall = mockQuery.mock.calls[0]![0] as { options: { resume?: string } };
      expect(queryCall.options.resume).toBeUndefined();
    });

    it('starts fresh when DB lookup fails (does not crash)', async () => {
      vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue(undefined);
      vi.mocked(ctx.repos.run.getLatestSessionId).mockReturnValue(
        err(new Error('DB read error') as any),
      );
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isOk()).toBe(true);
      const queryCall = mockQuery.mock.calls[0]![0] as { options: { resume?: string } };
      expect(queryCall.options.resume).toBeUndefined();
    });

    it('prefers latest persisted provider affinity and skips SDK session lookup for CLI providers', async () => {
      const cliRun = vi.fn().mockResolvedValue({
        output: 'Gemini affinity result',
        sessionId: undefined,
        usage: {
          inputTokens: 250_000,
          outputTokens: 90,
        },
        isError: false,
      });
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(ok({
        config: {
          model: 'gemini-2.5-pro',
          provider: 'claude-code',
          skills: [],
          capabilities: { allow: [] },
        },
        systemPromptContent: 'You are a test bot.',
        resolvedCapabilities: {
          allow: ['channel.send:*', 'memory.access', 'schedule.manage'],
          requireApproval: [],
        },
      } as any));
      vi.mocked(ctx.repos.run.getLatestProviderName).mockReturnValue(ok('gemini-cli'));
      const getProvider = vi.fn().mockImplementation((name: string) => {
          if (name === 'gemini-cli') {
            return {
              provider: {
                name: 'gemini-cli',
                createExecutionStrategy: () => ({
                  type: 'cli' as const,
                  supportsSessionResumption: false as const,
                  run: cliRun,
                }),
                prepareBackgroundInvocation: vi.fn(),
                parseBackgroundResult: vi.fn(),
                estimateContextUsage: vi.fn().mockReturnValue({
                  inputTokens: 250_000,
                  metrics: {
                    input_tokens: 250_000,
                  },
                }),
              },
              config: makeAgentRunnerProviderConfig({
                command: 'gemini',
                contextWindowTokens: 1_000_000,
                contextManagement: makeContextManagement({
                  triggerMetric: 'input_tokens',
                  thresholdRatio: 0.8,
                }),
              }),
            };
          }
          return {
            provider: {
              name: 'claude-code',
              createExecutionStrategy: () => ({
                type: 'sdk' as const,
                supportsSessionResumption: true as const,
                run: () => makeAgentStream(),
              }),
              prepareBackgroundInvocation: vi.fn(),
              parseBackgroundResult: vi.fn(),
              estimateContextUsage: vi.fn().mockReturnValue({
                inputTokens: 0,
                metrics: {
                  cache_read_input_tokens: 0,
                },
              }),
            },
            config: makeAgentRunnerProviderConfig(),
          };
        });
      ctx.providerRegistry = {
        get: getProvider,
        getDefault: vi.fn().mockImplementation((preferred: string[]) => {
          for (const name of preferred) {
            const entry = getProvider(name);
            if (entry) return entry;
          }
          return undefined;
        }),
      } as any;

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(cliRun).toHaveBeenCalledTimes(1);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(ctx.repos.run.getLatestSessionId).not.toHaveBeenCalled();
      expect(ctx.repos.run.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          provider_name: 'gemini-cli',
        }),
      );
    });

    it('passes only configured provider preferences into registry fallback resolution', async () => {
      const cliRun = vi.fn().mockResolvedValue({
        output: 'Gemini default result',
        sessionId: undefined,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
        },
        isError: false,
      });
      const getDefault = vi.fn().mockReturnValue({
        provider: {
          name: 'gemini-cli',
          createExecutionStrategy: () => ({
            type: 'cli' as const,
            supportsSessionResumption: false as const,
            run: cliRun,
          }),
          prepareBackgroundInvocation: vi.fn(),
          parseBackgroundResult: vi.fn(),
          estimateContextUsage: vi.fn().mockReturnValue({
            inputTokens: 10,
            metrics: {
              input_tokens: 10,
            },
          }),
        },
        config: makeAgentRunnerProviderConfig({
          command: 'gemini',
          contextWindowTokens: 1_000_000,
          contextManagement: makeContextManagement({
            triggerMetric: 'input_tokens',
            thresholdRatio: 0.8,
          }),
        }),
      });

      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(ok({
        config: {
          model: 'gemini-2.5-pro',
          skills: [],
          capabilities: { allow: [] },
        },
        systemPromptContent: 'You are a Gemini test bot.',
        resolvedCapabilities: {
          allow: ['channel.send:*', 'memory.access', 'schedule.manage'],
          requireApproval: [],
        },
      } as any));
      ctx.config.agentRunner.defaultProvider = 'gemini-cli';
      ctx.providerRegistry = {
        get: vi.fn().mockReturnValue(undefined),
        getDefault,
      } as any;

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(getDefault).toHaveBeenCalledWith(['gemini-cli']);
    });
  });

  // -------------------------------------------------------------------------
  // Agent error handling
  // -------------------------------------------------------------------------

  describe('agent error handling', () => {
    it('marks the run failed when root observation setup throws before invoking the callback', async () => {
      const observabilityError = new Error('observability failed before callback');
      vi.mocked(ctx.observability.observe).mockImplementationOnce(async () => {
        throw observabilityError;
      });

      const result = await runner.run(makeQueueItem());

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBe(observabilityError);
      expect(ctx.repos.run.updateStatus).toHaveBeenCalledWith(
        expect.any(String),
        'failed',
        expect.objectContaining({ error: 'observability failed before callback' }),
      );
    });

    it('retries once without resume when a resumed session fails before any events', async () => {
      vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue('stale-session');
      mockQuery
        .mockImplementationOnce(() => {
          throw new Error('Session not found');
        })
        .mockReturnValueOnce(makeAgentStream());
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isOk()).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const firstCall = mockQuery.mock.calls[0]![0] as { options: { resume?: string } };
      const secondCall = mockQuery.mock.calls[1]![0] as { options: { resume?: string } };
      expect(firstCall.options.resume).toBe('stale-session');
      expect(secondCall.options.resume).toBeUndefined();
      expect(ctx.sessionTracker.rotateSession).toHaveBeenCalledWith('thread-001');
      expect(ctx.sessionTracker.setSessionId).toHaveBeenCalledWith(
        'thread-001',
        'session-abc-123',
      );
      expect(
        vi.mocked(ctx.observability.observe).mock.calls.filter(
          ([input]) => input.type === 'generation',
        ),
      ).toHaveLength(2);
    });

    it('updates run to failed on agent error and clears typing interval', async () => {
      mockQuery.mockImplementation(() => {
        throw new Error('Agent SDK crash');
      });
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().name).toBe('AgentQueryAttemptError');
      expect(result._unsafeUnwrapErr().message).toContain('Agent SDK crash');
      expect(ctx.repos.run.updateStatus).toHaveBeenCalledWith(
        expect.any(String),
        'failed',
        expect.objectContaining({ error: 'Agent SDK crash' }),
      );
    });

    it('returns error when channel send fails', async () => {
      const connector = ctx.channelRegistry.get('test-channel')!;
      vi.mocked(connector.send).mockResolvedValue(
        err(new Error('Telegram API 429: rate limited') as any),
      );
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('channel send failed');
      expect(ctx.repos.run.updateStatus).toHaveBeenCalledWith(
        expect.any(String),
        'failed',
        expect.objectContaining({ error: expect.stringContaining('channel send failed') }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Timeout behavior
  // -------------------------------------------------------------------------

  describe('query timeout', () => {
    it('rejects with timeout error when agent query hangs', async () => {
      // Use a very short timeout (200ms) to test the timeout mechanism.
      const shortRunner = new AgentRunner(ctx, { queryTimeoutMs: 200 });

      async function* hangingStream() {
        yield {
          type: 'assistant',
          message: { content: [{ text: 'partial' }] },
        };
        // Never yields a result — simulates indefinite hang
        await new Promise(() => {});
      }

      mockQuery.mockReturnValue(hangingStream());
      const item = makeQueueItem();

      const result = await shortRunner.run(item);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('timed out after');
      expect(ctx.repos.run.updateStatus).toHaveBeenCalledWith(
        expect.any(String),
        'failed',
        expect.objectContaining({ error: expect.stringContaining('timed out') }),
      );
    }, 10_000);

    it('aborts the active iterator instance when an sdk query times out', async () => {
      const shortRunner = new AgentRunner(ctx, { queryTimeoutMs: 50 });
      const activeReturn = vi.fn().mockResolvedValue({ done: true, value: undefined });
      const strayReturn = vi.fn().mockResolvedValue({ done: true, value: undefined });
      let iteratorCount = 0;

      const hangingIterable: AsyncIterable<{ type: 'text'; content: string }> = {
        [Symbol.asyncIterator]() {
          iteratorCount += 1;
          const returnSpy = iteratorCount === 1 ? activeReturn : strayReturn;

          return {
            next: () => new Promise<IteratorResult<{ type: 'text'; content: string }>>(() => {}),
            return: returnSpy,
            [Symbol.asyncIterator]() {
              return this;
            },
          };
        },
      };

      ctx.config.agentRunner.defaultProvider = 'test-sdk';
      ctx.providerRegistry = {
        getDefault: vi.fn().mockReturnValue({
          provider: {
            name: 'test-sdk',
            createExecutionStrategy: () => ({
              type: 'sdk' as const,
              supportsSessionResumption: true as const,
              run: () => hangingIterable,
            }),
            prepareBackgroundInvocation: vi.fn(),
            parseBackgroundResult: vi.fn(),
            estimateContextUsage: vi.fn().mockReturnValue({
              inputTokens: 0,
              metrics: {
                input_tokens: 0,
              },
            }),
          },
          config: makeAgentRunnerProviderConfig({
            command: 'test-sdk',
            contextWindowTokens: 1000,
            contextManagement: makeContextManagement({
              triggerMetric: 'input_tokens',
            }),
          }),
        }),
      } as any;

      const result = await shortRunner.run(makeQueueItem());

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('timed out after');
      expect(activeReturn).toHaveBeenCalledTimes(1);
      expect(strayReturn).not.toHaveBeenCalled();
    }, 10_000);

    it('does not reject when query completes within the timeout', async () => {
      mockQuery.mockReturnValue(makeAgentStream());
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isOk()).toBe(true);
    });

    it('calls return() on the active iterator when timeout fires on a slow-resolving stream', async () => {
      // Use a very short timeout so the test is fast.
      const shortRunner = new AgentRunner(ctx, { queryTimeoutMs: 50 });

      const returnSpy = vi.fn().mockResolvedValue({ done: true, value: undefined });

      // Iterator that emits one event immediately then stalls on the second next() call.
      let callCount = 0;
      const slowIterable: AsyncIterable<{ type: 'text'; content: string }> = {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<{ type: 'text'; content: string }>> {
              callCount += 1;
              if (callCount === 1) {
                // Emit one event so the iterator is "active"
                return Promise.resolve({ done: false, value: { type: 'text', content: 'partial' } });
              }
              // Stall indefinitely — simulates a slow provider
              return new Promise(() => {});
            },
            return: returnSpy,
          };
        },
      };

      ctx.config.agentRunner.defaultProvider = 'slow-sdk';
      ctx.providerRegistry = {
        getDefault: vi.fn().mockReturnValue({
          provider: {
            name: 'slow-sdk',
            createExecutionStrategy: () => ({
              type: 'sdk' as const,
              supportsSessionResumption: true as const,
              run: () => slowIterable,
            }),
            prepareBackgroundInvocation: vi.fn(),
            parseBackgroundResult: vi.fn(),
            estimateContextUsage: vi.fn().mockReturnValue({
              inputTokens: 0,
              metrics: {
                input_tokens: 0,
              },
            }),
          },
          config: makeAgentRunnerProviderConfig({
            command: 'slow-sdk',
            contextWindowTokens: 1000,
            contextManagement: makeContextManagement({
              triggerMetric: 'input_tokens',
            }),
          }),
        }),
      } as any;

      const result = await shortRunner.run(makeQueueItem());

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('timed out after');
      // The P1 fix: return() must be called exactly once on the active iterator
      expect(returnSpy).toHaveBeenCalledTimes(1);
    }, 10_000);
  });

  // -------------------------------------------------------------------------
  // Provider-related error paths
  // -------------------------------------------------------------------------

  describe('provider error paths', () => {
    it('returns error gracefully when no default provider is configured', async () => {
      ctx.providerRegistry = {
        get: vi.fn().mockReturnValue(undefined),
        getDefault: vi.fn().mockReturnValue(undefined),
      } as any;
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('No enabled agent runner provider is configured');
      expect(ctx.repos.run.insert).not.toHaveBeenCalled();
      expect(ctx.repos.run.updateStatus).not.toHaveBeenCalled();
    });

    it('wraps mid-stream error as AgentQueryAttemptError with sawEvents=true and does not retry', async () => {
      // Stream that emits one text event then throws — sawEvents will be true.
      // Because sawEvents=true, shouldRetryFreshSession returns false and the error
      // propagates all the way out (run() returns err).
      async function* streamThatThrowsMidway() {
        yield {
          type: 'assistant',
          message: { content: [{ text: 'partial output' }] },
        };
        // Throw after emitting at least one event
        throw new Error('upstream connection reset mid-stream');
      }

      mockQuery.mockReturnValue(streamThatThrowsMidway());
      const item = makeQueueItem();

      const result = await runner.run(item);

      // Should fail — mid-stream errors with sawEvents=true are not retried
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('upstream connection reset mid-stream');
      // Must NOT have retried (query called exactly once)
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(ctx.repos.run.updateStatus).toHaveBeenCalledWith(
        expect.any(String),
        'failed',
        expect.objectContaining({ error: expect.stringContaining('upstream connection reset mid-stream') }),
      );
    });

    it('completes without error when provider returns all-zero usage tokens', async () => {
      // Attach a context roller to verify it is correctly skipped when rawMetric is 0.
      ctx.contextRoller = {
        checkAndRotate: vi.fn().mockResolvedValue(undefined),
      } as any;

      async function* zeroUsageStream() {
        yield {
          type: 'assistant',
          message: { content: [{ text: 'response' }] },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'response',
          session_id: 'session-zero',
          total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          is_error: false,
        };
      }

      mockQuery.mockReturnValue(zeroUsageStream());
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isOk()).toBe(true);
      // Token persistence should still be called with zeros
      expect(ctx.repos.run.updateTokens).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ input_tokens: 0, output_tokens: 0, cost_usd: 0 }),
      );
      // Context roller must NOT be invoked when rawMetric is 0
      expect(ctx.contextRoller!.checkAndRotate).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Channel context injection into system prompt
  // -------------------------------------------------------------------------

  describe('channel context in system prompt', () => {
    it('includes available channels and current channel in system prompt', async () => {
      const item = makeQueueItem();

      await runner.run(item);

      const queryCall = mockQuery.mock.calls[0]![0] as { options: { systemPrompt: string } };
      const systemPrompt = queryCall.options.systemPrompt;

      expect(systemPrompt).toContain('Available channels for channel_send tool:');
      expect(systemPrompt).toContain('test-channel (current thread)');
      expect(systemPrompt).toContain('other-channel');
      expect(systemPrompt).toContain('When sending messages, use channelId: "test-channel".');
    });

    it('lists channels without current marker when thread has no channel', async () => {
      vi.mocked(ctx.repos.thread.findById).mockReturnValue(ok(null));
      const item = makeQueueItem();

      await runner.run(item);

      const queryCall = mockQuery.mock.calls[0]![0] as { options: { systemPrompt: string } };
      const systemPrompt = queryCall.options.systemPrompt;

      expect(systemPrompt).toContain('Available channels for channel_send tool:');
      expect(systemPrompt).toContain('  - test-channel');
      expect(systemPrompt).not.toContain('(current thread)');
      expect(systemPrompt).not.toContain('When sending messages');
    });

    it('still includes persona system prompt alongside channel context', async () => {
      const item = makeQueueItem();

      await runner.run(item);

      const queryCall = mockQuery.mock.calls[0]![0] as { options: { systemPrompt: string } };
      const systemPrompt = queryCall.options.systemPrompt;

      expect(systemPrompt).toContain('You are a test bot.');
      expect(systemPrompt).toContain('Available channels');
    });

    it('includes personalityContent between system prompt and channel context', async () => {
      // Override personaLoader to return a persona with personalityContent.
      (runner as any).ctx.personaLoader.getByName.mockReturnValue(ok({
        config: {
          model: 'claude-sonnet-4-20250514',
          skills: [],
          capabilities: { allow: [] },
        },
        systemPromptContent: 'You are a test bot.',
        personalityContent: 'Be witty and concise.',
        resolvedCapabilities: {
          allow: ['channel.send:*', 'memory.access', 'schedule.manage'],
          requireApproval: [],
        },
      }));

      const item = makeQueueItem();
      await runner.run(item);

      const queryCall = mockQuery.mock.calls[0]![0] as { options: { systemPrompt: string } };
      const systemPrompt = queryCall.options.systemPrompt;

      expect(systemPrompt).toContain('Be witty and concise.');
      // Verify ordering: system prompt → personality → channel context
      const sysIdx = systemPrompt.indexOf('You are a test bot.');
      const persIdx = systemPrompt.indexOf('Be witty and concise.');
      const chanIdx = systemPrompt.indexOf('Available channels');
      expect(sysIdx).toBeLessThan(persIdx);
      expect(persIdx).toBeLessThan(chanIdx);
    });
  });

  // -------------------------------------------------------------------------
  // Host-tools exposure when background agents are disabled
  // -------------------------------------------------------------------------

  describe('background-agent tool exposure', () => {
    it('does not list background_agent in TALOND_ALLOWED_TOOLS when the manager is unavailable', async () => {
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(ok({
        config: {
          model: 'claude-sonnet-4-20250514',
          skills: [],
          capabilities: { allow: [] },
        },
        systemPromptContent: 'You are a test bot.',
        resolvedCapabilities: {
          allow: ['channel.send:*', 'subagent.background'],
          requireApproval: [],
        },
      } as any));

      const item = makeQueueItem();
      await runner.run(item);

      const queryCall = mockQuery.mock.calls[0]![0] as {
        options: { mcpServers: Record<string, any> };
      };
      const allowedTools = queryCall.options.mcpServers.__talond_host_tools.env.TALOND_ALLOWED_TOOLS
        .split(',')
        .filter(Boolean);

      expect(allowedTools).toContain('channel_send');
      expect(allowedTools).not.toContain('background_agent');
    });

    it('injects the active generation traceparent into the host-tools MCP env', async () => {
      await runner.run(makeQueueItem());

      const queryCall = mockQuery.mock.calls[0]![0] as {
        options: { mcpServers: Record<string, any> };
      };
      expect(queryCall.options.mcpServers.__talond_host_tools.env.TALOND_TRACEPARENT).toBe(
        GENERATION_TRACEPARENT,
      );
    });

    it('injects an in-process skill_load MCP server for SDK providers', async () => {
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(ok({
        config: {
          model: 'claude-sonnet-4-20250514',
          skills: ['brainstorming', 'empty'],
          capabilities: { allow: [] },
        },
        systemPromptContent: 'You are a test bot.',
        resolvedCapabilities: {
          allow: ['channel.send:*'],
          requireApproval: [],
        },
      } as any));

      (ctx as any).loadedSkills = [
        {
          manifest: { name: 'brainstorming' },
          format: 'yaml',
          promptContents: ['Line 1', 'Line 2'],
          resolvedToolManifests: [],
          resolvedMcpServers: [],
          migrationPaths: [],
        },
        {
          manifest: { name: 'empty' },
          format: 'yaml',
          promptContents: [''],
          resolvedToolManifests: [],
          resolvedMcpServers: [],
          migrationPaths: [],
        },
      ];

      await runner.run(makeQueueItem());

      const queryCall = mockQuery.mock.calls[0]![0] as {
        options: { mcpServers: Record<string, any> };
      };
      expect(mockSdkTool).toHaveBeenCalledWith(
        'skill_load',
        expect.stringContaining('Load the full instructions for a skill'),
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockCreateSdkMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '__talond_skill_loader',
          tools: expect.any(Array),
        }),
      );
      expect(queryCall.options.mcpServers.__talond_skill_loader).toBe(
        mockCreateSdkMcpServer.mock.results[0]?.value,
      );

      const toolDefinition = mockSdkTool.mock.results[0]?.value as {
        handler: (args: { name: string }) => Promise<{
          content: Array<{ type: 'text'; text: string }>;
          isError?: boolean;
        }>;
      };
      expect(toolDefinition).toBeDefined();
      await expect(toolDefinition.handler({ name: 'brainstorming' })).resolves.toEqual({
        content: [{ type: 'text', text: 'Line 1\nLine 2' }],
      });
      await expect(toolDefinition.handler({ name: 'missing' })).resolves.toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: skill "missing" not found. Available: brainstorming, empty',
          },
        ],
        isError: true,
      });
    });

    it('injects the skill_load stdio MCP server for CLI providers when skills are available', async () => {
      const cliRun = vi.fn().mockResolvedValue({
        output: 'Gemini result',
        sessionId: undefined,
        usage: {
          inputTokens: 500_000,
          outputTokens: 120,
        },
        isError: false,
      });

      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(ok({
        config: {
          model: 'gemini-2.5-pro',
          provider: 'gemini-cli',
          skills: ['brainstorming'],
          capabilities: { allow: [] },
        },
        systemPromptContent: 'You are a Gemini test bot.',
        resolvedCapabilities: {
          allow: ['channel.send:*'],
          requireApproval: [],
        },
      } as any));
      ctx.config.agentRunner.defaultProvider = 'gemini-cli';
      ctx.providerRegistry = {
        getDefault: vi.fn().mockReturnValue({
          provider: {
            name: 'gemini-cli',
            createExecutionStrategy: () => ({
              type: 'cli' as const,
              supportsSessionResumption: false as const,
              run: cliRun,
            }),
            prepareBackgroundInvocation: vi.fn(),
            parseBackgroundResult: vi.fn(),
            estimateContextUsage: vi.fn().mockReturnValue({
              inputTokens: 500_000,
              metrics: {
                input_tokens: 500_000,
              },
            }),
          },
          config: makeAgentRunnerProviderConfig({
            command: 'gemini',
            contextWindowTokens: 1_000_000,
            contextManagement: makeContextManagement({
              triggerMetric: 'input_tokens',
              thresholdRatio: 0.8,
            }),
          }),
        }),
      } as any;
      (ctx as any).loadedSkills = [
        {
          manifest: { name: 'brainstorming' },
          format: 'yaml',
          promptContents: ['Line 1', 'Line 2'],
          resolvedToolManifests: [],
          resolvedMcpServers: [],
          migrationPaths: [],
        },
      ];

      await runner.run(makeQueueItem());

      const queryInput = cliRun.mock.calls[0]?.[0] as {
        mcpServers: Record<string, any>;
      };

      expect(queryInput.mcpServers.__talond_skill_loader).toEqual({
        transport: 'stdio',
        command: 'node',
        args: [expect.stringContaining('dist/tools/skill-loader-mcp-server.js')],
        env: expect.objectContaining({
          TALOND_SOCKET: '/tmp/test-data/host-tools.sock',
          TALOND_RUN_ID: expect.any(String),
          TALOND_THREAD_ID: 'thread-001',
          TALOND_PERSONA_ID: 'persona-001',
          TALOND_TRACEPARENT: GENERATION_TRACEPARENT,
        }),
      });
    });
  });

  // -------------------------------------------------------------------------
  // MCP headers env var resolution
  // -------------------------------------------------------------------------

  describe('MCP headers env var resolution', () => {
    it('resolves ${ENV_VAR} placeholders in MCP server headers', async () => {
      const prevToken = process.env.TEST_MCP_TOKEN;
      process.env.TEST_MCP_TOKEN = 'secret-token-123';
      try {
        // Set up a skill with an MCP server that has headers.
        const personaWithSkill = {
          config: {
            model: 'claude-sonnet-4-20250514',
            skills: ['github'],
            capabilities: { allow: [] },
          },
          systemPromptContent: 'You are a test bot.',
          resolvedCapabilities: {
            allow: ['channel.send:*'],
            requireApproval: [],
          },
        };
        vi.mocked(ctx.personaLoader.getByName).mockReturnValue(ok(personaWithSkill as any));

        (ctx as any).loadedSkills = [
          {
            manifest: { name: 'github' },
            format: 'yaml',
            promptContents: [],
            resolvedToolManifests: [],
            resolvedMcpServers: [
              {
                name: 'github',
                config: {
                  name: 'github',
                  transport: 'http' as const,
                  url: 'https://api.githubcopilot.com/mcp',
                  headers: {
                    Authorization: 'Bearer ${TEST_MCP_TOKEN}',
                    'X-Exact': '${TEST_MCP_TOKEN}',
                    'X-Static': 'plain-value',
                  },
                },
              },
            ],
            migrationPaths: [],
          },
        ];

        const item = makeQueueItem();
        await runner.run(item);

        const queryCall = mockQuery.mock.calls[0]![0] as {
          options: { mcpServers: Record<string, any> };
        };
        const github = queryCall.options.mcpServers['github'];
        expect(github.headers).toEqual({
          Authorization: 'Bearer secret-token-123',
          'X-Exact': 'secret-token-123',
          'X-Static': 'plain-value',
        });
        expect(github.url).toBe('https://api.githubcopilot.com/mcp');
      } finally {
        if (prevToken !== undefined) process.env.TEST_MCP_TOKEN = prevToken;
        else delete process.env.TEST_MCP_TOKEN;
      }
    });

    it('warns and resolves to empty string when env var is missing', async () => {
      const prevMissing = process.env.MISSING_VAR;
      delete process.env.MISSING_VAR;

      const personaWithSkill = {
        config: {
          model: 'claude-sonnet-4-20250514',
          skills: ['github'],
          capabilities: { allow: [] },
        },
        systemPromptContent: 'You are a test bot.',
        resolvedCapabilities: {
          allow: ['channel.send:*'],
          requireApproval: [],
        },
      };
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(ok(personaWithSkill as any));

      (ctx as any).loadedSkills = [
        {
          manifest: { name: 'github' },
          format: 'yaml',
          promptContents: [],
          resolvedToolManifests: [],
          resolvedMcpServers: [
            {
              name: 'github',
              config: {
                name: 'github',
                transport: 'http' as const,
                url: 'https://example.com/mcp',
                headers: { Authorization: 'Bearer ${MISSING_VAR}' },
              },
            },
          ],
          migrationPaths: [],
        },
      ];

      const item = makeQueueItem();
      await runner.run(item);

      const queryCall = mockQuery.mock.calls[0]![0] as {
        options: { mcpServers: Record<string, any> };
      };
      const github = queryCall.options.mcpServers['github'];
      expect(github.headers).toEqual({ Authorization: 'Bearer ' });
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ mcpServer: 'github', header: 'Authorization', variable: 'MISSING_VAR' }),
        expect.stringContaining('unresolved env var'),
      );

      if (prevMissing !== undefined) process.env.MISSING_VAR = prevMissing;
    });

    it('ignores headers for stdio transport MCP servers', async () => {
      const personaWithSkill = {
        config: {
          model: 'claude-sonnet-4-20250514',
          skills: ['local'],
          capabilities: { allow: [] },
        },
        systemPromptContent: 'You are a test bot.',
        resolvedCapabilities: {
          allow: ['channel.send:*'],
          requireApproval: [],
        },
      };
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(ok(personaWithSkill as any));

      (ctx as any).loadedSkills = [
        {
          manifest: { name: 'local' },
          format: 'yaml',
          promptContents: [],
          resolvedToolManifests: [],
          resolvedMcpServers: [
            {
              name: 'local-mcp',
              config: {
                name: 'local-mcp',
                transport: 'stdio' as const,
                command: 'node',
                args: ['server.js'],
                headers: { Authorization: 'should-be-ignored' },
              },
            },
          ],
          migrationPaths: [],
        },
      ];

      const item = makeQueueItem();
      await runner.run(item);

      const queryCall = mockQuery.mock.calls[0]![0] as {
        options: { mcpServers: Record<string, any> };
      };
      const local = queryCall.options.mcpServers['local-mcp'];
      expect(local.headers).toBeUndefined();
    });

    it('omits headers from HTTP MCP server entry when none are configured', async () => {
      const personaWithSkill = {
        config: {
          model: 'claude-sonnet-4-20250514',
          skills: ['remote'],
          capabilities: { allow: [] },
        },
        systemPromptContent: 'You are a test bot.',
        resolvedCapabilities: {
          allow: ['channel.send:*'],
          requireApproval: [],
        },
      };
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(ok(personaWithSkill as any));

      (ctx as any).loadedSkills = [
        {
          manifest: { name: 'remote' },
          format: 'yaml',
          promptContents: [],
          resolvedToolManifests: [],
          resolvedMcpServers: [
            {
              name: 'remote-mcp',
              config: {
                name: 'remote-mcp',
                transport: 'http' as const,
                url: 'https://example.com/mcp',
              },
            },
          ],
          migrationPaths: [],
        },
      ];

      const item = makeQueueItem();
      await runner.run(item);

      const queryCall = mockQuery.mock.calls[0]![0] as {
        options: { mcpServers: Record<string, any> };
      };
      const remote = queryCall.options.mcpServers['remote-mcp'];
      expect(remote.headers).toBeUndefined();
      expect(remote.url).toBe('https://example.com/mcp');
    });
  });

  // -------------------------------------------------------------------------
  // Debug logging for non-text streaming events
  // -------------------------------------------------------------------------

  describe('debug logging for streaming events', () => {
    it('pairs provider tool_use and tool_result blocks into a single observation with input and output', async () => {
      const toolObservation = makeStartedObservationHandle(null);
      ctx.observability.startWithTraceparent = vi.fn(() => toolObservation);

      async function* streamWithPairedToolResult() {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_001',
                name: 'Read',
                input: { file_path: 'README.md' },
              },
            ],
          },
        };
        yield {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_001',
                content: 'README contents',
                is_error: false,
              },
            ],
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Done reading.',
          session_id: 'session-xyz',
          total_cost_usd: 0.01,
          usage: { input_tokens: 200, output_tokens: 100 },
          is_error: false,
        };
      }

      mockQuery.mockReturnValue(streamWithPairedToolResult());

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(ctx.observability.startWithTraceparent).toHaveBeenCalledWith(
        GENERATION_TRACEPARENT,
        expect.objectContaining({
          type: 'tool',
          name: 'Read',
          input: { file_path: 'README.md' },
          metadata: expect.objectContaining({
            runId: expect.any(String),
            threadId: 'thread-001',
            provider: 'claude-code',
            messageType: 'tool_use',
            toolUseId: 'toolu_001',
          }),
        }),
      );
      expect(toolObservation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          output: 'README contents',
        }),
      );
      expect(toolObservation.end).toHaveBeenCalledOnce();
      expect(ctx.observability.observeWithTraceparent).not.toHaveBeenCalled();
    });

    it('skips duplicate provider tool observations for internal host-tools MCP calls', async () => {
      ctx.observability.startWithTraceparent = vi.fn(() => makeStartedObservationHandle(null));

      async function* streamWithHostToolsMcpCall() {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'mcp_tool_use',
                id: 'mcpu_001',
                name: 'memory_access',
                server_name: '__talond_host_tools',
                input: { operation: 'read', key: 'profile' },
              },
            ],
          },
        };
        yield {
          type: 'user',
          message: {
            content: [
              {
                type: 'mcp_tool_result',
                tool_use_id: 'mcpu_001',
                content: 'profile data',
                is_error: false,
              },
            ],
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Done reading memory.',
          session_id: 'session-xyz',
          total_cost_usd: 0.01,
          usage: { input_tokens: 200, output_tokens: 100 },
          is_error: false,
        };
      }

      mockQuery.mockReturnValue(streamWithHostToolsMcpCall());

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(ctx.observability.startWithTraceparent).not.toHaveBeenCalled();
      expect(ctx.observability.observeWithTraceparent).not.toHaveBeenCalled();
    });

    it('skips duplicate provider tool observations for internal skill_load MCP calls', async () => {
      ctx.observability.startWithTraceparent = vi.fn(() => makeStartedObservationHandle(null));

      async function* streamWithSkillLoaderMcpCall() {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'mcp_tool_use',
                id: 'mcpu_001',
                name: 'skill_load',
                server_name: '__talond_skill_loader',
                input: { name: 'brainstorming' },
              },
            ],
          },
        };
        yield {
          type: 'user',
          message: {
            content: [
              {
                type: 'mcp_tool_result',
                tool_use_id: 'mcpu_001',
                content: 'skill contents',
                is_error: false,
              },
            ],
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Loaded skill.',
          session_id: 'session-xyz',
          total_cost_usd: 0.01,
          usage: { input_tokens: 200, output_tokens: 100 },
          is_error: false,
        };
      }

      mockQuery.mockReturnValue(streamWithSkillLoaderMcpCall());

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(ctx.observability.startWithTraceparent).not.toHaveBeenCalled();
      expect(ctx.observability.observeWithTraceparent).not.toHaveBeenCalled();
    });

    it('records tool_use streaming events as tool observations', async () => {
      async function* streamWithToolUse() {
        yield { type: 'tool_use', tool: 'Read', subtype: undefined };
        yield { type: 'tool_result', tool: 'Read', subtype: 'success' };
        yield {
          type: 'assistant',
          message: { content: [{ text: 'Done reading.' }] },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Done reading.',
          session_id: 'session-xyz',
          total_cost_usd: 0.01,
          usage: { input_tokens: 200, output_tokens: 100 },
          is_error: false,
        };
      }

      mockQuery.mockReturnValue(streamWithToolUse());

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(ctx.observability.observeWithTraceparent).toHaveBeenCalledWith(
        GENERATION_TRACEPARENT,
        expect.objectContaining({
          type: 'tool',
          name: 'Read',
          metadata: expect.objectContaining({
            runId: expect.any(String),
            threadId: 'thread-001',
            provider: 'claude-code',
            messageType: 'tool_use',
          }),
        }),
        expect.any(Function),
      );
    });

    it('does not create duplicate provider observations for internal host-tools mcp_tool_use assistant blocks', async () => {
      async function* streamWithMcpToolUse() {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'mcp_tool_use',
                id: 'mcpu_001',
                name: 'memory_access',
                server_name: '__talond_host_tools',
                input: { operation: 'read', key: 'profile' },
              },
            ],
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Done reading memory.',
          session_id: 'session-xyz',
          total_cost_usd: 0.01,
          usage: { input_tokens: 200, output_tokens: 100 },
          is_error: false,
        };
      }

      mockQuery.mockReturnValue(streamWithMcpToolUse());

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(ctx.observability.observeWithTraceparent).not.toHaveBeenCalled();
      expect(ctx.observability.startWithTraceparent).not.toHaveBeenCalled();
    });

    it('logs tool_use events with type, tool name, and subtype', async () => {
      async function* streamWithToolUse() {
        yield { type: 'tool_use', tool: 'Read', subtype: undefined };
        yield { type: 'tool_result', tool: 'Read', subtype: 'success' };
        yield {
          type: 'assistant',
          message: { content: [{ text: 'Done reading.' }] },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Done reading.',
          session_id: 'session-xyz',
          total_cost_usd: 0.01,
          usage: { input_tokens: 200, output_tokens: 100 },
          is_error: false,
        };
      }

      mockQuery.mockReturnValue(streamWithToolUse());
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isOk()).toBe(true);
      expect(ctx.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ messageType: 'tool_use', tool: 'Read' }),
        'agent-sdk: streaming event',
      );
      expect(ctx.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ messageType: 'tool_result', tool: 'Read', subtype: 'success' }),
        'agent-sdk: streaming event',
      );
    });

    it('does not debug-log assistant or result message types as streaming events', async () => {
      mockQuery.mockReturnValue(makeAgentStream());
      const item = makeQueueItem();

      await runner.run(item);

      const streamingEventCalls = vi.mocked(ctx.logger.debug).mock.calls.filter(
        (call) => call[1] === 'agent-sdk: streaming event',
      );
      expect(streamingEventCalls).toHaveLength(0);
    });
  });
});
