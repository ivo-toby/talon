/**
 * Unit tests for AgentRunner.
 *
 * The Agent SDK is dynamically imported, so we mock it via vi.mock().
 * A mock DaemonContext provides all required repositories and subsystems.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err, type Result } from 'neverthrow';

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

import fs from 'node:fs';
import { setTimeout as waitForRealTime } from 'node:timers/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import pino from 'pino';
import { createTestDb } from '../core/database/repositories/helpers.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { RunRepository } from '../../../src/core/database/repositories/run-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { AuditRepository } from '../../../src/core/database/repositories/audit-repository.js';
import { BindingRepository } from '../../../src/core/database/repositories/binding-repository.js';
import { SignalAccountStateRepository } from '../../../src/core/database/repositories/signal-account-state-repository.js';
import { SignalDestinationLeaseRepository } from '../../../src/core/database/repositories/signal-destination-lease-repository.js';
import { SignalConnector } from '../../../src/channels/connectors/signal/signal-connector.js';
import { SignalDeviceRegistry } from '../../../src/channels/connectors/signal/signal-device-registry.js';
import { SignalConfigSchema } from '../../../src/channels/connectors/signal/signal-config.js';
import { ChannelRegistry } from '../../../src/channels/channel-registry.js';
import { PersonaLoader } from '../../../src/personas/persona-loader.js';
import {
  AgentRunnerProviderConfigSchema,
  PersonaConfigSchema,
  ChannelConfigSchema,
} from '../../../src/core/config/config-schema.js';
import { SignalInvocationGuard } from '../../../src/daemon/signal-invocation-guard.js';
import { SignalReplyDelivery } from '../../../src/daemon/signal-reply-delivery.js';
import { SignalToolExecutionRegistry } from '../../../src/tools/host-tools/signal-tool-execution.js';
import { SessionTracker } from '../../../src/sandbox/session-tracker.js';
import type { SubAgentResult } from '../../../src/subagents/subagent-types.js';
import { ContextRoller } from '../../../src/daemon/context-roller.js';
import { MemoryRepository } from '../../../src/core/database/repositories/memory-repository.js';
import { SubAgentError } from '../../../src/core/errors/error-types.js';
import { BackgroundAgentProcess } from '../../../src/subagents/background/background-agent-process.js';
import { BackgroundAgentManager } from '../../../src/subagents/background/background-agent-manager.js';
import { BackgroundTaskRepository } from '../../../src/core/database/repositories/background-task-repository.js';
import { QueueProcessor } from '../../../src/queue/queue-processor.js';
import { DeadLetterHandler } from '../../../src/queue/dead-letter.js';
import { calculateBackoff } from '../../../src/queue/retry-strategy.js';
import { QueueManager } from '../../../src/queue/queue-manager.js';
import type { ChannelConnector } from '../../../src/channels/channel-types.js';
import type { AgentProvider, SDKExecutionStrategy } from '../../../src/providers/provider.js';
import { SignalCheckpointError } from '../../../src/queue/signal-delivery-checkpoint.js';
import { rowToQueueItem } from '../../../src/queue/queue-mapper.js';
import {
  DbError,
  DeliveryCancelled,
  DeliveryDeferredError,
  NonRetryableRunError,
  SignalDeliveryError,
} from '../../../src/core/errors/error-types.js';
import type { SignalDeliveryCheckpoint } from '../../../src/queue/signal-delivery-checkpoint.js';
import type { SignalRpcRequest } from '../../../src/channels/connectors/signal/signal-wire.js';

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

function makeAgentRunnerProviderConfig(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
        findById: vi.fn().mockReturnValue(
          ok({
            id: 'thread-001',
            channel_id: 'chan-001',
            external_id: 'ext-001',
          }),
        ),
      } as any,
      channel: {
        findById: vi.fn().mockReturnValue(
          ok({
            id: 'chan-001',
            name: 'test-channel',
          }),
        ),
      } as any,
      persona: {
        findById: vi.fn().mockReturnValue(
          ok({
            id: 'persona-001',
            name: 'TestBot',
          }),
        ),
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
      listAll: vi.fn().mockReturnValue([{ name: 'test-channel' }, { name: 'other-channel' }]),
    } as any,
    queueManager: {} as any,
    scheduler: {} as any,
    personaLoader: {
      getByName: vi.fn().mockReturnValue(
        ok({
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
        }),
      ),
    } as any,
    sessionTracker: {
      getSessionId: vi.fn().mockReturnValue(undefined),
      setSessionId: vi.fn(),
      clearSession: vi.fn(),
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
    toolInstructions: new Map(),
    messagePipeline: {} as any,
    observability: {
      observe: vi.fn(async (input, fn) => {
        const traceparent = input.type === 'generation' ? GENERATION_TRACEPARENT : null;
        return await fn(makeObservationHandle(traceparent));
      }),
      start: vi.fn(() => makeStartedObservationHandle(null)),
      startWithTraceparent: vi.fn(() => makeStartedObservationHandle(null)),
      observeWithTraceparent: vi.fn(
        async (_traceparent, _input, fn) => await fn(makeObservationHandle(null)),
      ),
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

async function* makeProviderStream(overrides: Record<string, unknown> = {}) {
  yield {
    type: 'text' as const,
    content: 'Hello from the agent!',
  };
  yield {
    type: 'result' as const,
    result: {
      output: 'Hello from the agent!',
      sessionId: 'session-abc-123',
      usage: { inputTokens: 100, outputTokens: 50 },
      isError: false,
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentRunner', () => {
  let ctx: DaemonContext;
  let runner: AgentRunner;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
      vi.mocked(ctx.repos.run.insert).mockReturnValue(err(new Error('DB write failed') as any));
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
        'claude-code',
        'claude-sonnet-4-20250514',
      );
      expect(ctx.repos.run.updateSessionId).toHaveBeenCalledWith(
        expect.any(String),
        'session-abc-123',
      );
    });

    it('uses persona reasoningEffort in provider input, run metadata, and session keys', async () => {
      const sdkRun = vi.fn().mockReturnValue(makeProviderStream());
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(
        ok({
          config: {
            model: 'gpt-5.4',
            provider: 'codex-cli',
            reasoningEffort: 'high',
            skills: [],
            capabilities: { allow: [] },
          },
          systemPromptContent: 'You are a Codex test bot.',
          resolvedCapabilities: {
            allow: ['channel.send:*', 'memory.access', 'schedule.manage'],
            requireApproval: [],
          },
        } as any),
      );
      ctx.config.agentRunner.defaultProvider = 'codex-cli';
      ctx.providerRegistry = {
        get: vi.fn().mockImplementation((name: string) =>
          name === 'codex-cli'
            ? {
                type: 'codex-cli',
                provider: {
                  name: 'codex-cli',
                  skillLoaderTransport: 'stdio',
                  createExecutionStrategy: () => ({
                    type: 'sdk' as const,
                    supportsSessionResumption: true as const,
                    run: sdkRun,
                  }),
                  prepareBackgroundInvocation: vi.fn(),
                  parseBackgroundResult: vi.fn(),
                  estimateContextUsage: vi.fn().mockReturnValue({
                    inputTokens: 100,
                    metrics: { input_tokens: 100 },
                  }),
                },
                config: makeAgentRunnerProviderConfig({
                  command: 'codex',
                  contextWindowTokens: 400_000,
                }),
              }
            : undefined,
        ),
        getDefault: vi.fn().mockImplementation(() => ({
          type: 'codex-cli',
          provider: {
            name: 'codex-cli',
            skillLoaderTransport: 'stdio',
            createExecutionStrategy: () => ({
              type: 'sdk' as const,
              supportsSessionResumption: true as const,
              run: sdkRun,
            }),
            prepareBackgroundInvocation: vi.fn(),
            parseBackgroundResult: vi.fn(),
            estimateContextUsage: vi.fn().mockReturnValue({
              inputTokens: 100,
              metrics: { input_tokens: 100 },
            }),
          },
          config: makeAgentRunnerProviderConfig({
            command: 'codex',
            contextWindowTokens: 400_000,
          }),
        })),
      } as any;

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(sdkRun).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5.4',
          reasoningEffort: 'high',
        }),
      );
      expect(ctx.repos.run.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          provider_name: 'codex-cli',
          model_name: 'gpt-5.4',
          reasoning_effort: 'high',
        }),
      );
      expect(ctx.sessionTracker.getSessionId).toHaveBeenCalledWith(
        'thread-001',
        'codex-cli',
        'gpt-5.4',
        'high',
      );
      expect(ctx.repos.run.getLatestSessionId).toHaveBeenCalledWith(
        'thread-001',
        'codex-cli',
        expect.objectContaining({
          modelName: 'gpt-5.4',
          reasoningEffort: 'high',
        }),
      );
      expect(ctx.sessionTracker.setSessionId).toHaveBeenCalledWith(
        'thread-001',
        'session-abc-123',
        'codex-cli',
        'gpt-5.4',
        'high',
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

    it('includes tags with persona, itemType, and provider in the root trace', async () => {
      await runner.run(makeQueueItem({ type: 'schedule' }));

      expect(ctx.observability.observe).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agent',
          name: 'foreground-run',
          trace: expect.objectContaining({
            tags: expect.arrayContaining([
              'persona:TestBot',
              'itemType:schedule',
              'provider:claude-code',
            ]),
          }),
        }),
        expect.any(Function),
      );
    });

    it('includes trace.input at the root observation level', async () => {
      const item = makeQueueItem({ payload: { personaId: 'persona-001', content: 'Hello world' } });

      await runner.run(item);

      expect(ctx.observability.observe).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agent',
          name: 'foreground-run',
          trace: expect.objectContaining({
            input: expect.objectContaining({ content: 'Hello world' }),
          }),
        }),
        expect.any(Function),
      );
    });

    it('includes userId from langfuse config owner in the root trace', async () => {
      ctx.config = {
        ...ctx.config,
        langfuse: { owner: 'ivo' } as any,
      } as any;
      runner = new AgentRunner(ctx);

      await runner.run(makeQueueItem());

      expect(ctx.observability.observe).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agent',
          name: 'foreground-run',
          trace: expect.objectContaining({
            userId: 'ivo',
          }),
        }),
        expect.any(Function),
      );
    });

    it('reports usageDetails with snake_case keys for LangFuse pricing lookup', async () => {
      mockQuery.mockReturnValue(
        makeAgentStream({
          usage: {
            input_tokens: 200,
            output_tokens: 75,
            cache_read_input_tokens: 1_000,
            cache_creation_input_tokens: 500,
          },
        }),
      );

      let generationHandle: ReturnType<typeof makeObservationHandle> | undefined;
      ctx.observability.observe = vi.fn(
        async (
          input: { type: string },
          fn: (h: ReturnType<typeof makeObservationHandle>) => Promise<unknown>,
        ) => {
          const traceparent = input.type === 'generation' ? GENERATION_TRACEPARENT : null;
          const handle = makeObservationHandle(traceparent);
          if (input.type === 'generation') generationHandle = handle;
          return await fn(handle);
        },
      );
      runner = new AgentRunner(ctx);

      await runner.run(makeQueueItem());

      expect(generationHandle?.update).toHaveBeenCalledWith(
        expect.objectContaining({
          usageDetails: expect.objectContaining({
            input_tokens: 200,
            output_tokens: 75,
            cache_read_input_tokens: 1_000,
            cache_creation_input_tokens: 500,
          }),
        }),
      );
    });

    it('uses the selected provider recentMessageCount when assembling fresh-session context', async () => {
      await runner.run(makeQueueItem());

      expect(ctx.contextAssembler.assemble).toHaveBeenCalledWith(
        'thread-001',
        10,
        expect.any(Object),
      );
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

    it('gates codex-cli rotation on cumulative usage when resuming a session (not lastStepUsage)', async () => {
      // Reproduces the production bloat: a resumed codex session has a
      // large cumulative total_token_usage (the session log size on the
      // provider's side) but a small last_token_usage (just this turn,
      // the rest were cache hits). The roller must gate on the cumulative
      // value or it will never fire and the session grows unbounded.
      const sdkRun = vi.fn().mockReturnValue(
        makeProviderStream({
          usage: { inputTokens: 600_000, outputTokens: 90 },
          lastStepUsage: { inputTokens: 50_000, outputTokens: 20 },
        }),
      );
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(
        ok({
          config: {
            model: 'gpt-5.4',
            provider: 'codex-cli',
            skills: [],
            capabilities: { allow: [] },
          },
          systemPromptContent: 'You are a Codex test bot.',
          resolvedCapabilities: {
            allow: ['channel.send:*', 'memory.access', 'schedule.manage'],
            requireApproval: [],
          },
        } as any),
      );
      vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue('resumed-codex-session');
      ctx.config.agentRunner.defaultProvider = 'codex-cli';
      ctx.contextRoller = {
        checkAndRotate: vi.fn().mockResolvedValue(undefined),
      } as any;
      ctx.providerRegistry = {
        get: vi.fn().mockImplementation((name: string) =>
          name === 'codex-cli'
            ? {
                type: 'codex-cli',
                provider: {
                  name: 'codex-cli',
                  skillLoaderTransport: 'stdio',
                  createExecutionStrategy: () => ({
                    type: 'sdk' as const,
                    supportsSessionResumption: true as const,
                    run: sdkRun,
                  }),
                  prepareBackgroundInvocation: vi.fn(),
                  parseBackgroundResult: vi.fn(),
                  // Mirror the real CodexCliProvider.estimateContextUsage:
                  // pass inputTokens through as the input_tokens metric.
                  estimateContextUsage: (u: { inputTokens?: number }) => ({
                    inputTokens: u.inputTokens ?? 0,
                    metrics: { input_tokens: u.inputTokens ?? 0 },
                  }),
                },
                config: makeAgentRunnerProviderConfig({
                  command: 'codex',
                  contextWindowTokens: 1_000_000,
                  contextManagement: makeContextManagement({
                    triggerMetric: 'input_tokens',
                    thresholdRatio: 0.5,
                  }),
                }),
              }
            : undefined,
        ),
        getDefault: vi.fn().mockImplementation(() => ({
          type: 'codex-cli',
          provider: {
            name: 'codex-cli',
            skillLoaderTransport: 'stdio',
            createExecutionStrategy: () => ({
              type: 'sdk' as const,
              supportsSessionResumption: true as const,
              run: sdkRun,
            }),
            prepareBackgroundInvocation: vi.fn(),
            parseBackgroundResult: vi.fn(),
            estimateContextUsage: (u: { inputTokens?: number }) => ({
              inputTokens: u.inputTokens ?? 0,
              metrics: { input_tokens: u.inputTokens ?? 0 },
            }),
          },
          config: makeAgentRunnerProviderConfig({
            command: 'codex',
            contextWindowTokens: 1_000_000,
            contextManagement: makeContextManagement({
              triggerMetric: 'input_tokens',
              thresholdRatio: 0.5,
            }),
          }),
        })),
      } as any;
      runner = new AgentRunner(ctx);

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(ctx.contextRoller.checkAndRotate).toHaveBeenCalledWith(
        'thread-001',
        'persona-001',
        {
          ratio: 600_000 / 1_000_000,
          inputTokens: 600_000,
          rawMetric: 600_000,
          rawMetricName: 'input_tokens',
        },
        0.5,
        'session-summarizer',
      );
    });

    it('gates codex-cli rotation on lastStepUsage when starting a fresh session (no resume)', async () => {
      // The non-resume path must preserve the original lastStepUsage ?? usage
      // behavior: a fresh codex run's cumulative usage across a multi-tool
      // loop can exceed the per-call context window without the session log
      // being that large, which would spuriously trigger rotation. Only
      // resumed sessions should gate on cumulative.
      const sdkRun = vi.fn().mockReturnValue(
        makeProviderStream({
          usage: { inputTokens: 600_000, outputTokens: 90 },
          lastStepUsage: { inputTokens: 50_000, outputTokens: 20 },
        }),
      );
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(
        ok({
          config: {
            model: 'gpt-5.4',
            provider: 'codex-cli',
            skills: [],
            capabilities: { allow: [] },
          },
          systemPromptContent: 'You are a Codex test bot.',
          resolvedCapabilities: {
            allow: ['channel.send:*', 'memory.access', 'schedule.manage'],
            requireApproval: [],
          },
        } as any),
      );
      vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue(undefined);
      ctx.config.agentRunner.defaultProvider = 'codex-cli';
      ctx.contextRoller = {
        checkAndRotate: vi.fn().mockResolvedValue(undefined),
      } as any;
      ctx.providerRegistry = {
        get: vi.fn().mockImplementation((name: string) =>
          name === 'codex-cli'
            ? {
                type: 'codex-cli',
                provider: {
                  name: 'codex-cli',
                  skillLoaderTransport: 'stdio',
                  createExecutionStrategy: () => ({
                    type: 'sdk' as const,
                    supportsSessionResumption: true as const,
                    run: sdkRun,
                  }),
                  prepareBackgroundInvocation: vi.fn(),
                  parseBackgroundResult: vi.fn(),
                  estimateContextUsage: (u: { inputTokens?: number }) => ({
                    inputTokens: u.inputTokens ?? 0,
                    metrics: { input_tokens: u.inputTokens ?? 0 },
                  }),
                },
                config: makeAgentRunnerProviderConfig({
                  command: 'codex',
                  contextWindowTokens: 1_000_000,
                  contextManagement: makeContextManagement({
                    triggerMetric: 'input_tokens',
                    thresholdRatio: 0.5,
                  }),
                }),
              }
            : undefined,
        ),
        getDefault: vi.fn().mockImplementation(() => ({
          type: 'codex-cli',
          provider: {
            name: 'codex-cli',
            skillLoaderTransport: 'stdio',
            createExecutionStrategy: () => ({
              type: 'sdk' as const,
              supportsSessionResumption: true as const,
              run: sdkRun,
            }),
            prepareBackgroundInvocation: vi.fn(),
            parseBackgroundResult: vi.fn(),
            estimateContextUsage: (u: { inputTokens?: number }) => ({
              inputTokens: u.inputTokens ?? 0,
              metrics: { input_tokens: u.inputTokens ?? 0 },
            }),
          },
          config: makeAgentRunnerProviderConfig({
            command: 'codex',
            contextWindowTokens: 1_000_000,
            contextManagement: makeContextManagement({
              triggerMetric: 'input_tokens',
              thresholdRatio: 0.5,
            }),
          }),
        })),
      } as any;
      runner = new AgentRunner(ctx);

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      // Fresh session: lastStepUsage wins, NOT cumulative usage.
      expect(ctx.contextRoller.checkAndRotate).toHaveBeenCalledWith(
        'thread-001',
        'persona-001',
        {
          ratio: 50_000 / 1_000_000,
          inputTokens: 50_000,
          rawMetric: 50_000,
          rawMetricName: 'input_tokens',
        },
        0.5,
        'session-summarizer',
      );
    });

    it('gates openai-compatible (previous_response_id) rotation on lastStepUsage even when resuming', async () => {
      // openai-compatible with sessionMode=previous_response_id uses OpenAI's
      // Responses API which retrieves prior context SERVER-SIDE via
      // previous_response_id. The wrapper reports:
      //   - usage = cumulative across this run's agent loop (billing total)
      //   - lastStepUsage = final turn's per-step tokens (reflects the full
      //     conversation context because the API re-sends it on each call)
      // So lastStepUsage is the right rotation metric for openai-compatible
      // even when resuming — opposite of codex-cli where cumulative usage
      // is the session log size. This test guards against accidentally
      // widening the codex-cli fix to openai-compatible.
      const sdkRun = vi.fn().mockReturnValue(
        makeProviderStream({
          usage: { inputTokens: 600_000, outputTokens: 90 },
          lastStepUsage: { inputTokens: 50_000, outputTokens: 20 },
        }),
      );
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(
        ok({
          config: {
            model: 'qwen3-coder:30b',
            provider: 'openai-compatible',
            skills: [],
            capabilities: { allow: [] },
          },
          systemPromptContent: 'You are an OpenAI-compatible test bot.',
          resolvedCapabilities: {
            allow: ['channel.send:*', 'memory.access', 'schedule.manage'],
            requireApproval: [],
          },
        } as any),
      );
      // Resumed session — sessionTracker returns a previous_response_id.
      vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue('resp-abc-123');
      ctx.config.agentRunner.defaultProvider = 'openai-compatible';
      ctx.contextRoller = {
        checkAndRotate: vi.fn().mockResolvedValue(undefined),
      } as any;
      ctx.providerRegistry = {
        get: vi.fn().mockImplementation((name: string) =>
          name === 'openai-compatible'
            ? {
                type: 'openai-compatible',
                provider: {
                  name: 'openai-compatible',
                  skillLoaderTransport: 'stdio',
                  createExecutionStrategy: () => ({
                    type: 'sdk' as const,
                    supportsSessionResumption: true as const,
                    requiresContinuationAfterContextRotation: true as const,
                    run: sdkRun,
                  }),
                  prepareBackgroundInvocation: vi.fn(),
                  parseBackgroundResult: vi.fn(),
                  estimateContextUsage: (u: { inputTokens?: number }) => ({
                    inputTokens: u.inputTokens ?? 0,
                    metrics: { input_tokens: u.inputTokens ?? 0 },
                  }),
                },
                config: makeAgentRunnerProviderConfig({
                  command: 'node',
                  contextWindowTokens: 256_000,
                  contextManagement: makeContextManagement({
                    triggerMetric: 'input_tokens',
                    thresholdRatio: 0.75,
                  }),
                }),
              }
            : undefined,
        ),
        getDefault: vi.fn().mockImplementation(() => ({
          type: 'openai-compatible',
          provider: {
            name: 'openai-compatible',
            skillLoaderTransport: 'stdio',
            createExecutionStrategy: () => ({
              type: 'sdk' as const,
              supportsSessionResumption: true as const,
              requiresContinuationAfterContextRotation: true as const,
              run: sdkRun,
            }),
            prepareBackgroundInvocation: vi.fn(),
            parseBackgroundResult: vi.fn(),
            estimateContextUsage: (u: { inputTokens?: number }) => ({
              inputTokens: u.inputTokens ?? 0,
              metrics: { input_tokens: u.inputTokens ?? 0 },
            }),
          },
          config: makeAgentRunnerProviderConfig({
            command: 'node',
            contextWindowTokens: 256_000,
            contextManagement: makeContextManagement({
              triggerMetric: 'input_tokens',
              thresholdRatio: 0.75,
            }),
          }),
        })),
      } as any;
      runner = new AgentRunner(ctx);

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      // openai-compatible: lastStepUsage wins even when resuming, because
      // the Responses API's per-step input_tokens already includes the
      // full conversation context (server-side retrieval). Cumulative
      // usage would inflate the metric by summing across tool calls.
      expect(ctx.contextRoller.checkAndRotate).toHaveBeenCalledWith(
        'thread-001',
        'persona-001',
        {
          ratio: 50_000 / 256_000,
          inputTokens: 50_000,
          rawMetric: 50_000,
          rawMetricName: 'input_tokens',
        },
        0.75,
        'session-summarizer',
      );
    });

    it('runs Gemini through the existing CLI branch without sending a waiting message', async () => {
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
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(
        ok({
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
        } as any),
      );
      ctx.config.agentRunner.defaultProvider = 'gemini-cli';
      ctx.providerRegistry = {
        get: vi.fn().mockImplementation((name: string) =>
          name === 'gemini-cli'
            ? {
                type: 'gemini-cli',
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
            : undefined,
        ),
        getDefault: vi.fn().mockImplementation(() => ({
          type: 'gemini-cli',
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

    it('runs openai-compatible through the existing CLI branch without session resumption', async () => {
      const cliRun = vi.fn().mockResolvedValue({
        output: 'OpenAI-compatible result',
        sessionId: undefined,
        usage: {
          inputTokens: 210_000,
          outputTokens: 90,
        },
        isError: false,
      });
      const connector = ctx.channelRegistry.get('test-channel')!;
      ctx.contextRoller = {
        checkAndRotate: vi.fn().mockResolvedValue(undefined),
      } as any;
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(
        ok({
          config: {
            model: 'qwen3-coder:30b',
            provider: 'openai-compatible',
            skills: [],
            capabilities: { allow: [] },
          },
          systemPromptContent: 'You are an OpenAI-compatible test bot.',
          resolvedCapabilities: {
            allow: ['channel.send:*', 'memory.access', 'schedule.manage'],
            requireApproval: [],
          },
        } as any),
      );
      ctx.config.agentRunner.defaultProvider = 'openai-compatible';
      ctx.providerRegistry = {
        get: vi.fn().mockImplementation((name: string) =>
          name === 'openai-compatible'
            ? {
                type: 'openai-compatible',
                provider: {
                  name: 'openai-compatible',
                  createExecutionStrategy: () => ({
                    type: 'cli' as const,
                    supportsSessionResumption: false as const,
                    run: cliRun,
                  }),
                  prepareBackgroundInvocation: vi.fn(),
                  parseBackgroundResult: vi.fn(),
                  estimateContextUsage: vi.fn().mockReturnValue({
                    inputTokens: 210_000,
                    metrics: {
                      input_tokens: 210_000,
                    },
                  }),
                },
                config: makeAgentRunnerProviderConfig({
                  command: 'node',
                  contextWindowTokens: 256_000,
                  contextManagement: makeContextManagement({
                    triggerMetric: 'input_tokens',
                    thresholdRatio: 0.75,
                  }),
                }),
              }
            : undefined,
        ),
        getDefault: vi.fn().mockImplementation(() => ({
          type: 'openai-compatible',
          provider: {
            name: 'openai-compatible',
            createExecutionStrategy: () => ({
              type: 'cli' as const,
              supportsSessionResumption: false as const,
              run: cliRun,
            }),
            prepareBackgroundInvocation: vi.fn(),
            parseBackgroundResult: vi.fn(),
            estimateContextUsage: vi.fn().mockReturnValue({
              inputTokens: 210_000,
              metrics: {
                input_tokens: 210_000,
              },
            }),
          },
          config: makeAgentRunnerProviderConfig({
            command: 'node',
            contextWindowTokens: 256_000,
            contextManagement: makeContextManagement({
              triggerMetric: 'input_tokens',
              thresholdRatio: 0.75,
            }),
          }),
        })),
      } as any;

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(ctx.sessionTracker.getSessionId).not.toHaveBeenCalled();
      expect(cliRun).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'qwen3-coder:30b',
        }),
      );
      const sendCalls = vi.mocked(connector.send).mock.calls;
      const thinkingCalls = sendCalls.filter(
        ([, body]) => (body as { body: string }).body === 'Thinking...',
      );
      expect(thinkingCalls).toHaveLength(0);
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]).toEqual(['ext-001', { body: 'OpenAI-compatible result' }]);
      expect(ctx.contextRoller.checkAndRotate).toHaveBeenCalledWith(
        'thread-001',
        'persona-001',
        {
          ratio: 210_000 / 256_000,
          inputTokens: 210_000,
          rawMetric: 210_000,
          rawMetricName: 'input_tokens',
        },
        0.75,
        'session-summarizer',
      );
    });

    it('auto-enqueues continuation after rotation for resumable providers that opt in', async () => {
      const sdkRun = vi.fn().mockReturnValue(
        makeProviderStream({
          usage: { inputTokens: 210_000, outputTokens: 90 },
        }),
      );
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(
        ok({
          config: {
            model: 'qwen3.5-9b-optiq-4bit',
            provider: 'openai-compatible',
            skills: [],
            capabilities: { allow: [] },
          },
          systemPromptContent: 'You are an OpenAI-compatible test bot.',
          resolvedCapabilities: {
            allow: ['channel.send:*', 'memory.access', 'schedule.manage'],
            requireApproval: [],
          },
        } as any),
      );
      ctx.queueManager = {
        enqueue: vi.fn().mockReturnValue(ok({})),
      } as any;
      ctx.contextRoller = {
        checkAndRotate: vi.fn().mockResolvedValue({
          rotated: true,
          hasOpenThreads: true,
        }),
      } as any;
      ctx.providerRegistry = {
        getDefault: vi.fn().mockReturnValue({
          provider: {
            name: 'openai-compatible',
            createExecutionStrategy: () => ({
              type: 'sdk' as const,
              supportsSessionResumption: true as const,
              requiresContinuationAfterContextRotation: true as const,
              run: sdkRun,
            }),
            prepareBackgroundInvocation: vi.fn(),
            parseBackgroundResult: vi.fn(),
            estimateContextUsage: vi.fn().mockReturnValue({
              inputTokens: 210_000,
              metrics: {
                input_tokens: 210_000,
              },
            }),
          },
          config: makeAgentRunnerProviderConfig({
            command: 'node',
            contextWindowTokens: 256_000,
            contextManagement: makeContextManagement({
              triggerMetric: 'input_tokens',
              thresholdRatio: 0.75,
            }),
          }),
        }),
      } as any;

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(ctx.queueManager.enqueue).toHaveBeenCalledWith(
        'thread-001',
        'message',
        { personaId: 'persona-001', content: 'continue' },
        expect.any(String),
      );
    });

    it('logs and skips rotation when the configured trigger metric is unavailable', async () => {
      ctx.contextRoller = {
        checkAndRotate: vi.fn().mockResolvedValue(undefined),
      } as any;
      const connector = ctx.channelRegistry.get('test-channel')!;
      ctx.providerRegistry = {
        getDefault: vi.fn().mockReturnValue({
          type: 'gemini-cli',
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

    describe('response delivery ordering (issue #164)', () => {
      // These tests verify that connector.send() and message.insert() both happen
      // BEFORE contextRoller.checkAndRotate() runs. This ensures users receive
      // responses immediately instead of waiting for the potentially slow
      // summarizer LLM call during context rotation.

      it('sends response to channel before running context rotation for SDK providers', async () => {
        const callOrder: string[] = [];

        const connector = ctx.channelRegistry.get('test-channel')!;
        vi.mocked(connector.send).mockImplementation(async () => {
          callOrder.push('send');
          return ok(undefined);
        });

        ctx.contextRoller = {
          checkAndRotate: vi.fn().mockImplementation(async () => {
            callOrder.push('rotate');
          }),
        } as any;

        // Provide cache tokens so selectedMetricValue > 0 and checkAndRotate is invoked.
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

        const result = await runner.run(makeQueueItem());

        expect(result.isOk()).toBe(true);
        expect(callOrder).toContain('rotate'); // sanity: rotation was triggered
        expect(callOrder.indexOf('send')).toBeLessThan(callOrder.indexOf('rotate'));
      });

      it('persists outbound message before running context rotation for SDK providers', async () => {
        const callOrder: string[] = [];

        vi.mocked(ctx.repos.message.insert).mockImplementation(() => {
          callOrder.push('message.insert');
          return ok({} as any);
        });

        ctx.contextRoller = {
          checkAndRotate: vi.fn().mockImplementation(async () => {
            callOrder.push('rotate');
          }),
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

        const result = await runner.run(makeQueueItem());

        expect(result.isOk()).toBe(true);
        expect(callOrder).toContain('rotate'); // sanity: rotation was triggered
        expect(callOrder.indexOf('message.insert')).toBeLessThan(callOrder.indexOf('rotate'));
      });

      it('sends response to channel before context rotation for CLI providers', async () => {
        const callOrder: string[] = [];

        const cliRun = vi.fn().mockResolvedValue({
          output: 'CLI result',
          sessionId: undefined,
          usage: { inputTokens: 500_000, outputTokens: 120 },
          isError: false,
        });

        const connector = ctx.channelRegistry.get('test-channel')!;
        vi.mocked(connector.send).mockImplementation(async () => {
          callOrder.push('send');
          return ok(undefined);
        });

        ctx.contextRoller = {
          checkAndRotate: vi.fn().mockImplementation(async () => {
            callOrder.push('rotate');
          }),
        } as any;

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
                metrics: { input_tokens: 500_000 },
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

        const result = await runner.run(makeQueueItem());

        expect(result.isOk()).toBe(true);
        expect(callOrder).toContain('rotate');
        expect(callOrder.indexOf('send')).toBeLessThan(callOrder.indexOf('rotate'));
      });
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
  // Scheduled-run delivery contract (issue #205)
  //
  // Scheduled prompts must invoke channel.send explicitly to deliver.
  // The agent's final assistant text on a scheduled run is treated as
  // a self-narration / wrap-up (e.g. "Silent — lunch window, items
  // pending. Log written.") and must NOT be auto-delivered to the
  // originating chat. The actual #205 silent-failure was caused by
  // corrupted thread metadata (originExternalId pointing at a synthetic
  // id) that made channel.send fail with 400 chat-not-found. That is
  // fixed at the migration layer plus operator rebinds onto healthy
  // dedicated threads, not by relaxing the schedule-skip here.
  // -------------------------------------------------------------------------

  describe('scheduled run final-response delivery (issue #205)', () => {
    beforeEach(() => {
      // Dedicated schedule thread: external_id is the synthetic schedule
      // marker, metadata.originExternalId is the real chat recipient.
      // Retained for symmetry with the live-run tests that this thread
      // shape exercises.
      ctx.repos.thread.findById = vi.fn().mockReturnValue(
        ok({
          id: 'thread-001',
          channel_id: 'chan-001',
          external_id: 'schedule:work-context-manager:Telegram-workContext:74575531',
          metadata: JSON.stringify({
            kind: 'schedule',
            originExternalId: '74575531',
            personaName: 'work-context-manager',
            channelName: 'Telegram-workContext',
          }),
        }),
      ) as any;
    });

    it('does not implicit-deliver the final assistant message for schedule items — agent must use channel.send', async () => {
      // Production behaviour observed at lunch heartbeat 2026-05-07:
      // agent stays "silent" per its prompt, produces a wrap-up text
      // ("Silent — lunch window..."), does NOT invoke channel.send.
      // Auto-delivering that wrap-up would re-introduce the noise the
      // pre-existing schedule-skip was added to prevent.
      mockQuery.mockReturnValue(
        makeAgentStream({
          result: 'Silent — lunch window, items from 11:05 still pending. Log written.',
          usage: {
            input_tokens: 500_000,
            output_tokens: 50,
            cache_read_input_tokens: 450_000,
          },
        }),
      );
      vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue('stale-schedule-session');
      vi.mocked(ctx.repos.run.getLatestSessionId).mockReturnValue(ok('db-schedule-session'));
      vi.mocked(ctx.repos.run.getLatestProviderName).mockReturnValue(ok('stale-schedule-provider'));
      ctx.contextRoller = {
        checkAndRotate: vi.fn(),
        checkAndRotateOM: vi.fn(),
      } as any;

      const connector = ctx.channelRegistry.get('test-channel')!;
      const item = makeQueueItem({ type: 'schedule' });

      const result = await runner.run(item);

      expect(result.isOk()).toBe(true);
      // No implicit channel send for schedule items — only sendTyping
      // is permitted, which is a separate method.
      expect(connector.send).not.toHaveBeenCalled();
      expect(ctx.repos.message.insert).not.toHaveBeenCalled();
      expect(ctx.repos.run.getLatestProviderName).not.toHaveBeenCalled();
      expect(ctx.sessionTracker.getSessionId).not.toHaveBeenCalled();
      expect(ctx.repos.run.getLatestSessionId).not.toHaveBeenCalled();
      expect(ctx.sessionTracker.setSessionId).not.toHaveBeenCalled();
      expect(ctx.repos.run.updateSessionId).not.toHaveBeenCalled();
      expect(ctx.contextAssembler.assemble).not.toHaveBeenCalled();
      expect(ctx.contextRoller?.checkAndRotate).not.toHaveBeenCalled();
      expect(ctx.contextRoller?.checkAndRotateOM).not.toHaveBeenCalled();
      expect(ctx.observability.observe).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'retriever', name: 'previous-context' }),
        expect.any(Function),
      );
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
      expect(ctx.repos.run.getLatestSessionId).toHaveBeenCalledWith('thread-001', 'claude-code', {
        excludeCollaboration: true,
        modelName: 'claude-sonnet-4-20250514',
        reasoningEffort: null,
      });
      expect(ctx.observability.observe).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'retriever', name: 'previous-context' }),
        expect.any(Function),
      );
    });

    it('does not restore an explicit-effort DB session when persona omits reasoningEffort', async () => {
      vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue(undefined);
      vi.mocked(ctx.repos.run.getLatestSessionId).mockImplementation(
        (_threadId: string, _providerName?: string, options?: { reasoningEffort?: unknown }) => {
          const hasNoEffortFilter =
            options !== undefined &&
            Object.prototype.hasOwnProperty.call(options, 'reasoningEffort') &&
            options.reasoningEffort === null;
          return ok(hasNoEffortFilter ? null : 'explicit-effort-session');
        },
      );
      const item = makeQueueItem();

      await runner.run(item);

      const queryCall = mockQuery.mock.calls[0]![0] as { options: { resume?: string } };
      expect(queryCall.options.resume).toBeUndefined();
      expect(ctx.repos.run.getLatestSessionId).toHaveBeenCalledWith('thread-001', 'claude-code', {
        excludeCollaboration: true,
        modelName: 'claude-sonnet-4-20250514',
        reasoningEffort: null,
      });
      expect(ctx.repos.run.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          session_id: null,
          reasoning_effort: null,
        }),
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
        'claude-code',
        'claude-sonnet-4-20250514',
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
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(
        ok({
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
        } as any),
      );
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

    it('ignores pre-reset affinity and stale in-memory sessions', async () => {
      vi.mocked(ctx.repos.thread.findById).mockReturnValue(
        ok({
          id: 'thread-001',
          channel_id: 'chan-001',
          external_id: 'ext-001',
          metadata: '{"providerAffinityResetAt":500}',
        }) as any,
      );
      vi.mocked(ctx.repos.run.getLatestProviderName).mockReturnValue(ok(null));
      vi.mocked(ctx.repos.run.getLatestSessionId).mockReturnValue(ok(null));
      vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue('stale-session');

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(ctx.repos.run.getLatestProviderName).toHaveBeenCalledWith('thread-001', {
        sinceCreatedAt: 500,
        excludeCollaboration: true,
      });
      expect(ctx.sessionTracker.clearSession).toHaveBeenCalledWith('thread-001', 'claude-code');
      expect(ctx.sessionTracker.getSessionId).not.toHaveBeenCalled();
      const queryCall = mockQuery.mock.calls[0]![0] as { options: { resume?: string } };
      expect(queryCall.options.resume).toBeUndefined();
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

      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(
        ok({
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
        } as any),
      );
      ctx.config.agentRunner.defaultProvider = 'gemini-cli';
      ctx.providerRegistry = {
        get: vi.fn().mockReturnValue(undefined),
        getDefault,
      } as any;

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(getDefault).toHaveBeenCalledWith(['gemini-cli']);
    });

    it('restores sessions scoped to the selected provider', async () => {
      const cliRun = vi.fn().mockResolvedValue({
        output: 'Codex fresh result',
        sessionId: 'codex-thread-001',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
        },
        isError: false,
      });

      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(
        ok({
          config: {
            model: 'gpt-5.4',
            provider: 'codex-cli',
            skills: [],
            capabilities: { allow: [] },
          },
          systemPromptContent: 'You are a Codex test bot.',
          resolvedCapabilities: {
            allow: ['channel.send:*', 'memory.access', 'schedule.manage'],
            requireApproval: [],
          },
        } as any),
      );
      vi.mocked(ctx.sessionTracker.getSessionId).mockImplementation(
        (_threadId: string, providerName?: string) =>
          providerName === 'claude-code' ? 'claude-session-uuid' : undefined,
      );
      vi.mocked(ctx.repos.run.getLatestSessionId).mockReturnValue(ok(null));
      ctx.providerRegistry = {
        get: vi.fn().mockReturnValue(undefined),
        getDefault: vi.fn().mockReturnValue({
          type: 'codex-cli',
          provider: {
            name: 'codex-cli',
            createExecutionStrategy: () => ({
              type: 'cli' as const,
              supportsSessionResumption: true as const,
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
            command: 'codex',
            contextWindowTokens: 400_000,
            contextManagement: makeContextManagement({
              triggerMetric: 'input_tokens',
              thresholdRatio: 0.8,
            }),
          }),
        }),
      } as any;

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(ctx.sessionTracker.getSessionId).toHaveBeenCalledWith(
        'thread-001',
        'codex-cli',
        'gpt-5.4',
      );
      expect(ctx.repos.run.getLatestSessionId).toHaveBeenCalledWith('thread-001', 'codex-cli', {
        excludeCollaboration: true,
        modelName: 'gpt-5.4',
        reasoningEffort: null,
      });
      expect(cliRun).toHaveBeenCalledWith(
        expect.not.objectContaining({
          sessionId: expect.anything(),
        }),
      );
      const connector = ctx.channelRegistry.get('test-channel')!;
      expect(vi.mocked(connector.send).mock.calls).toEqual([
        ['ext-001', { body: 'Codex fresh result' }],
      ]);
    });

    it('restores sessions for resumable CLI providers and skips previous-context stuffing on resumed turns', async () => {
      const cliRun = vi.fn().mockResolvedValue({
        output: 'Resumed CLI output',
        sessionId: 'resumable-cli-session-new',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
        },
        isError: false,
      });

      vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue(undefined);
      vi.mocked(ctx.repos.run.getLatestSessionId).mockReturnValue(ok('resumable-cli-session-old'));
      ctx.providerRegistry = {
        getDefault: vi.fn().mockReturnValue({
          provider: {
            name: 'resumable-cli',
            createExecutionStrategy: () => ({
              type: 'cli' as const,
              supportsSessionResumption: true as const,
              run: cliRun,
            }),
            prepareBackgroundInvocation: vi.fn(),
            parseBackgroundResult: vi.fn(),
            estimateContextUsage: vi.fn().mockReturnValue({
              inputTokens: 100,
              metrics: {
                input_tokens: 100,
              },
            }),
          },
          config: makeAgentRunnerProviderConfig({
            command: 'resumable-cli',
            contextWindowTokens: 1_000_000,
            contextManagement: makeContextManagement({
              triggerMetric: 'input_tokens',
              thresholdRatio: 0.8,
            }),
          }),
        }),
      } as any;

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(ctx.sessionTracker.getSessionId).toHaveBeenCalledWith(
        'thread-001',
        'resumable-cli',
        'claude-sonnet-4-20250514',
      );
      expect(ctx.repos.run.getLatestSessionId).toHaveBeenCalledWith('thread-001', 'resumable-cli', {
        excludeCollaboration: true,
        modelName: 'claude-sonnet-4-20250514',
        reasoningEffort: null,
      });
      expect(cliRun).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-001',
          sessionId: 'resumable-cli-session-old',
        }),
      );
      expect(ctx.repos.run.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          session_id: 'resumable-cli-session-old',
        }),
      );
      expect(ctx.contextAssembler.assemble).not.toHaveBeenCalled();
      expect(ctx.observability.observe).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'retriever', name: 'previous-context' }),
        expect.any(Function),
      );
    });

    it('persists returned session ids from resumable CLI providers', async () => {
      const cliRun = vi.fn().mockResolvedValue({
        output: 'CLI output',
        sessionId: 'resumable-cli-session-123',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
        },
        isError: false,
      });

      ctx.providerRegistry = {
        getDefault: vi.fn().mockReturnValue({
          provider: {
            name: 'resumable-cli',
            createExecutionStrategy: () => ({
              type: 'cli' as const,
              supportsSessionResumption: true as const,
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
            command: 'resumable-cli',
            contextWindowTokens: 1_000_000,
            contextManagement: makeContextManagement({
              triggerMetric: 'input_tokens',
              thresholdRatio: 0.8,
            }),
          }),
        }),
      } as any;

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(ctx.sessionTracker.setSessionId).toHaveBeenCalledWith(
        'thread-001',
        'resumable-cli-session-123',
        'resumable-cli',
        'claude-sonnet-4-20250514',
      );
      expect(ctx.repos.run.updateSessionId).toHaveBeenCalledWith(
        expect.any(String),
        'resumable-cli-session-123',
      );
    });

    it('does not persist resumable CLI session ids for A2A tasks', async () => {
      const cliRun = vi.fn().mockResolvedValue({
        output: 'A2A worker output',
        sessionId: 'resumable-cli-a2a-session',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
        },
        isError: false,
      });
      (ctx.repos as any).a2aTask = {
        markWorking: vi.fn().mockReturnValue(ok(undefined)),
        markCompleted: vi.fn().mockReturnValue(ok(undefined)),
        markFailed: vi.fn().mockReturnValue(ok(undefined)),
      };
      vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue('source-thread-session');
      vi.mocked(ctx.repos.run.getLatestSessionId).mockReturnValue(ok('db-source-thread-session'));
      ctx.providerRegistry = {
        getDefault: vi.fn().mockReturnValue({
          provider: {
            name: 'resumable-cli',
            createExecutionStrategy: () => ({
              type: 'cli' as const,
              supportsSessionResumption: true as const,
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
            command: 'resumable-cli',
            contextWindowTokens: 1_000_000,
            contextManagement: makeContextManagement({
              triggerMetric: 'input_tokens',
              thresholdRatio: 0.8,
            }),
          }),
        }),
      } as any;

      const item = makeQueueItem({
        type: 'collaboration',
        payload: {
          personaId: 'persona-001',
          kind: 'a2a_task',
          taskId: 'a2a-task-1',
          content: 'Run delegated work',
        },
      });

      const result = await runner.run(item);

      expect(result.isOk()).toBe(true);
      expect(cliRun).toHaveBeenCalledWith(
        expect.not.objectContaining({
          sessionId: expect.anything(),
        }),
      );
      expect(ctx.repos.run.getLatestSessionId).not.toHaveBeenCalled();
      expect(ctx.sessionTracker.setSessionId).not.toHaveBeenCalled();
      expect(ctx.repos.run.updateSessionId).not.toHaveBeenCalled();
      expect((ctx.repos as any).a2aTask.markCompleted).toHaveBeenCalledWith(
        'a2a-task-1',
        'A2A worker output',
      );
    });

    it('ignores source-thread provider affinity for A2A tasks and uses the delegated persona provider', async () => {
      const cliRun = vi.fn().mockResolvedValue({
        output: 'Wrong provider output',
        sessionId: undefined,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
        },
        isError: false,
      });
      (ctx.repos as any).a2aTask = {
        markWorking: vi.fn().mockReturnValue(ok(undefined)),
        markCompleted: vi.fn().mockReturnValue(ok(undefined)),
        markFailed: vi.fn().mockReturnValue(ok(undefined)),
      };
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(
        ok({
          config: {
            model: 'claude-sonnet-4-6',
            provider: 'claude-code',
            skills: [],
            capabilities: { allow: [] },
          },
          systemPromptContent: 'You are a delegated Claude worker.',
          resolvedCapabilities: {
            allow: ['channel.send:*', 'memory.access', 'schedule.manage'],
            requireApproval: [],
          },
        } as any),
      );
      vi.mocked(ctx.repos.run.getLatestProviderName).mockReturnValue(ok('codex-cli'));
      const getProvider = vi.fn().mockImplementation((name: string) => {
        if (name === 'codex-cli') {
          return {
            provider: {
              name: 'codex-cli',
              createExecutionStrategy: () => ({
                type: 'cli' as const,
                supportsSessionResumption: true as const,
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
              command: 'codex',
              contextWindowTokens: 400_000,
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
              run: () => makeProviderStream(),
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

      const item = makeQueueItem({
        type: 'collaboration',
        payload: {
          personaId: 'persona-001',
          kind: 'a2a_task',
          taskId: 'a2a-task-2',
          content: 'Fetch Jira and Confluence context',
        },
      });

      const result = await runner.run(item);

      expect(result.isOk()).toBe(true);
      expect(cliRun).not.toHaveBeenCalled();
      expect(ctx.repos.run.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          provider_name: 'claude-code',
        }),
      );
      expect((ctx.repos as any).a2aTask.markCompleted).toHaveBeenCalledWith(
        'a2a-task-2',
        'Hello from the agent!',
      );
    });

    it('ignores collaboration runs when selecting provider affinity for normal messages', async () => {
      vi.mocked(ctx.repos.run.getLatestProviderName).mockImplementation(
        (_threadId: string, options?: { excludeCollaboration?: boolean }) =>
          ok(options?.excludeCollaboration ? null : 'codex-cli'),
      );
      const getDefault = vi.fn().mockReturnValue({
        provider: {
          name: 'claude-code',
          createExecutionStrategy: () => ({
            type: 'sdk' as const,
            supportsSessionResumption: true as const,
            run: () => makeProviderStream(),
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
      });
      ctx.providerRegistry = {
        get: vi.fn().mockReturnValue(undefined),
        getDefault,
      } as any;

      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(ctx.repos.run.getLatestProviderName).toHaveBeenCalledWith('thread-001', {
        excludeCollaboration: true,
      });
      expect(getDefault).toHaveBeenCalledWith(['claude-code']);
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
        'claude-code',
        'claude-sonnet-4-20250514',
      );
      expect(
        vi
          .mocked(ctx.observability.observe)
          .mock.calls.filter(([input]) => input.type === 'generation'),
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

    it('does not use sdk stale-session retry path for resumable CLI failures', async () => {
      const cliRun = vi.fn().mockRejectedValue(new Error('Session not found'));
      vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue('resumable-cli-session-old');
      ctx.providerRegistry = {
        getDefault: vi.fn().mockReturnValue({
          provider: {
            name: 'resumable-cli',
            createExecutionStrategy: () => ({
              type: 'cli' as const,
              supportsSessionResumption: true as const,
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
            command: 'resumable-cli',
            contextWindowTokens: 1_000_000,
            contextManagement: makeContextManagement({
              triggerMetric: 'input_tokens',
              thresholdRatio: 0.8,
            }),
          }),
        }),
      } as any;

      const result = await runner.run(makeQueueItem());

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Session not found');
      expect(cliRun).toHaveBeenCalledTimes(1);
      expect(ctx.sessionTracker.rotateSession).not.toHaveBeenCalled();
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

    it('uses the 10 minute default timeout for queries', async () => {
      const runSpy = vi.fn(() => makeProviderStream());
      ctx.config.agentRunner.defaultProvider = 'timeout-sdk';
      ctx.providerRegistry = {
        getDefault: vi.fn().mockReturnValue({
          provider: {
            name: 'timeout-sdk',
            createExecutionStrategy: () => ({
              type: 'sdk' as const,
              supportsSessionResumption: true as const,
              run: runSpy,
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
            command: 'timeout-sdk',
            contextWindowTokens: 1000,
            contextManagement: makeContextManagement({
              triggerMetric: 'input_tokens',
            }),
          }),
        }),
      } as any;

      await runner.run(makeQueueItem());

      const queryCall = runSpy.mock.calls[0]![0] as { timeoutMs: number };

      expect(queryCall.timeoutMs).toBe(10 * 60 * 1000);
    });

    it('uses the persona queryTimeoutMinutes override when provided', async () => {
      const runSpy = vi.fn(() => makeProviderStream());
      ctx.config.agentRunner.defaultProvider = 'timeout-sdk';
      ctx.providerRegistry = {
        getDefault: vi.fn().mockReturnValue({
          provider: {
            name: 'timeout-sdk',
            createExecutionStrategy: () => ({
              type: 'sdk' as const,
              supportsSessionResumption: true as const,
              run: runSpy,
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
            command: 'timeout-sdk',
            contextWindowTokens: 1000,
            contextManagement: makeContextManagement({
              triggerMetric: 'input_tokens',
            }),
          }),
        }),
      } as any;
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(
        ok({
          config: {
            model: 'claude-sonnet-4-20250514',
            skills: [],
            capabilities: { allow: [] },
            queryTimeoutMinutes: 45,
          },
          systemPromptContent: 'You are a test bot.',
          resolvedCapabilities: {
            allow: ['channel.send:*', 'memory.access', 'schedule.manage'],
            requireApproval: [],
          },
        }),
      );

      await runner.run(makeQueueItem());

      const queryCall = runSpy.mock.calls[0]![0] as { timeoutMs: number };

      expect(queryCall.timeoutMs).toBe(45 * 60 * 1000);
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
                return Promise.resolve({
                  done: false,
                  value: { type: 'text', content: 'partial' },
                });
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
      expect(result._unsafeUnwrapErr().message).toContain(
        'No enabled agent runner provider is configured',
      );
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
        expect.objectContaining({
          error: expect.stringContaining('upstream connection reset mid-stream'),
        }),
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
      (runner as any).ctx.personaLoader.getByName.mockReturnValue(
        ok({
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
        }),
      );

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
    it('restricts native tools for OAuth MCP while preserving Talon and MCP tools', async () => {
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(
        ok({
          config: {
            model: 'claude-sonnet-4-20250514',
            skills: ['oauth-search'],
            capabilities: { allow: ['channel.send:*'] },
          },
          systemPromptContent: 'You are a test bot.',
          resolvedCapabilities: {
            allow: ['channel.send:*'],
            requireApproval: [],
          },
        } as any),
      );
      (ctx as any).loadedSkills = [{
        manifest: { name: 'oauth-search' },
        format: 'yaml',
        promptContents: ['Search the connected source.'],
        resolvedToolManifests: [],
        resolvedMcpServers: [{
          name: 'privateSearch',
          config: {
            transport: 'http',
            url: 'https://mcp.example.test',
            auth: { kind: 'oauth2', tokenStore: 'oauth-search/privateSearch' },
          },
        }],
        migrationPaths: [],
      }];
      (ctx as any).oauthTokenStore = {
        materializeBearer: vi.fn().mockResolvedValue('oauth-access-token'),
      };

      await runner.run(makeQueueItem());

      const queryCall = mockQuery.mock.calls[0]![0] as {
        options: { mcpServers: Record<string, any>; tools: string[] };
      };
      expect(queryCall.options.tools).toEqual(['WebSearch', 'WebFetch']);
      expect(queryCall.options.mcpServers.privateSearch).toEqual({
        type: 'http',
        url: 'https://mcp.example.test',
        headers: { Authorization: 'Bearer oauth-access-token' },
      });
      expect(queryCall.options.mcpServers.__talond_host_tools).toBeDefined();
      expect(queryCall.options.mcpServers.__talond_host_tools.env).not.toHaveProperty('HOME');
    });

    it('does not list background_agent in TALOND_ALLOWED_TOOLS when the manager is unavailable', async () => {
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(
        ok({
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
        } as any),
      );

      const item = makeQueueItem();
      await runner.run(item);

      const queryCall = mockQuery.mock.calls[0]![0] as {
        options: { mcpServers: Record<string, any> };
      };
      const allowedTools =
        queryCall.options.mcpServers.__talond_host_tools.env.TALOND_ALLOWED_TOOLS.split(',').filter(
          Boolean,
        );

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
      expect(queryCall.options.mcpServers.__talond_host_tools.command).toBe(process.execPath);
      expect(queryCall.options.mcpServers.__talond_host_tools.env).not.toHaveProperty('HOME');
    });

    it('injects the workspace root into the host-tools MCP env', async () => {
      await runner.run(makeQueueItem());

      const queryCall = mockQuery.mock.calls[0]![0] as {
        options: { mcpServers: Record<string, any> };
      };
      expect(queryCall.options.mcpServers.__talond_host_tools.env.TALOND_ALLOWED_HOST_ROOTS).toBe(
        '["/tmp/test-data/workspaces/thread-001"]',
      );
    });

    it('injects an in-process skill_load MCP server for SDK providers', async () => {
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(
        ok({
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
        } as any),
      );

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
        expect.stringContaining('Load the full instructions for a Talon persona skill'),
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
            text: 'Error: Talon persona skill "missing" not found. Available Talon persona skills: brainstorming, empty',
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

      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(
        ok({
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
        } as any),
      );
      ctx.config.agentRunner.defaultProvider = 'gemini-cli';
      ctx.providerRegistry = {
        getDefault: vi.fn().mockReturnValue({
          provider: {
            name: 'gemini-cli',
            skillLoaderTransport: 'stdio' as const,
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
        command: process.execPath,
        args: [expect.stringContaining('dist/tools/skill-loader-mcp-server.js')],
        env: expect.objectContaining({
          TALOND_BRIDGE_SECRET: expect.any(String),
          TALOND_SOCKET: '/tmp/test-data/host-tools.sock',
          TALOND_RUN_ID: expect.any(String),
          TALOND_THREAD_ID: 'thread-001',
          TALOND_PERSONA_ID: 'persona-001',
          TALOND_TRACEPARENT: GENERATION_TRACEPARENT,
        }),
      });
    });

    it('injects a per-run bridge secret into the host-tools MCP env', async () => {
      await runner.run(makeQueueItem());

      const queryCall = mockQuery.mock.calls[0]![0] as {
        options: { mcpServers: Record<string, any> };
      };
      expect(queryCall.options.mcpServers.__talond_host_tools.env.TALOND_BRIDGE_SECRET).toEqual(
        expect.any(String),
      );
    });
  });

  // -------------------------------------------------------------------------
  // MCP headers are materialized by SkillLoader before reaching AgentRunner.
  // -------------------------------------------------------------------------

  describe('MCP headers at runtime', () => {
    it('passes materialized MCP headers through unchanged', async () => {
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
                  Authorization: 'Bearer secret-token-123',
                  'X-Exact': 'secret-token-123',
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
    });

    it('rejects provider-expandable placeholders before starting the provider', async () => {
      vi.stubEnv('MISSING_VAR', 'replacement-secret');

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

      const result = await runner.run(makeQueueItem());

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toMatch(
        /header "Authorization" contains provider-expandable environment-variable syntax/i,
      );
      expect(mockQuery).not.toHaveBeenCalled();
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

    it('records tool_use streaming events as tool observations using startWithTraceparent', async () => {
      const toolObservation = makeStartedObservationHandle(null);
      ctx.observability.startWithTraceparent = vi.fn((tp, input) => {
        // Generation observation returns GENERATION_TRACEPARENT; tool observations get null.
        if (input.type === 'generation')
          return makeStartedObservationHandle(GENERATION_TRACEPARENT);
        return toolObservation;
      });

      async function* streamWithToolUse() {
        yield { type: 'tool_use', tool: 'Read', subtype: undefined };
        yield { type: 'tool_result', tool: 'Read', subtype: 'success', content: 'file contents' };
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
      // Tool observation must be started (not immediately completed)
      expect(ctx.observability.startWithTraceparent).toHaveBeenCalledWith(
        GENERATION_TRACEPARENT,
        expect.objectContaining({
          type: 'tool',
          name: 'Read',
          input: {},
          metadata: expect.objectContaining({
            runId: expect.any(String),
            threadId: 'thread-001',
            provider: 'claude-code',
            messageType: 'tool_use',
          }),
        }),
      );
      // Result must be written and span ended only after tool_result arrives (not immediately)
      expect(toolObservation.update).toHaveBeenCalledWith(
        expect.objectContaining({ output: 'file contents' }),
      );
      expect(toolObservation.end).toHaveBeenCalledOnce();
      // observeWithTraceparent must NOT be used for the no-toolUseId path (it causes zero-latency spans)
      expect(ctx.observability.observeWithTraceparent).not.toHaveBeenCalled();
    });

    it('ends no-toolUseId tool observation with ERROR when tool_result is an error', async () => {
      const toolObservation = makeStartedObservationHandle(null);
      ctx.observability.startWithTraceparent = vi.fn((tp, input) => {
        if (input.type === 'generation')
          return makeStartedObservationHandle(GENERATION_TRACEPARENT);
        return toolObservation;
      });

      async function* streamWithErrorResult() {
        yield { type: 'tool_use', tool: 'Bash', subtype: undefined };
        yield {
          type: 'tool_result',
          tool: 'Bash',
          subtype: 'error',
          is_error: true,
          content: 'command failed',
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Handled error.',
          session_id: 'session-xyz',
          total_cost_usd: 0.005,
          usage: { input_tokens: 100, output_tokens: 50 },
          is_error: false,
        };
      }

      mockQuery.mockReturnValue(streamWithErrorResult());
      const result = await runner.run(makeQueueItem());

      expect(result.isOk()).toBe(true);
      expect(toolObservation.update).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'ERROR', output: 'command failed' }),
      );
      expect(toolObservation.end).toHaveBeenCalledOnce();
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

      const streamingEventCalls = vi
        .mocked(ctx.logger.debug)
        .mock.calls.filter((call) => call[1] === 'agent-sdk: streaming event');
      expect(streamingEventCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Text block flushing — one message per text block (issue #102)
  // -------------------------------------------------------------------------

  describe('text block flushing', () => {
    it('sends a single message when the stream contains only one text block', async () => {
      // Default makeAgentStream already has one text block — verify baseline
      mockQuery.mockReturnValue(makeAgentStream());
      const connector = ctx.channelRegistry.get('test-channel')!;
      const item = makeQueueItem();

      await runner.run(item);

      const sendCalls = vi
        .mocked(connector.send)
        .mock.calls.filter(([, body]) => (body as { body: string }).body !== 'Thinking...');
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]![1]).toEqual({ body: 'Hello from the agent!' });
    });

    it('sends two separate messages when text precedes and follows a tool_use', async () => {
      async function* textToolTextStream() {
        // Turn 1: assistant emits text then invokes a tool
        yield {
          type: 'assistant',
          message: {
            content: [
              { text: 'Before tool.' },
              { type: 'tool_use', id: 'tu-001', name: 'memory_access', input: {} },
            ],
          },
        };
        // Turn 1: tool result
        yield {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tu-001', content: 'ok' }],
          },
        };
        // Turn 2: assistant emits text after the tool
        yield {
          type: 'assistant',
          message: { content: [{ text: 'After tool.' }] },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: '',
          session_id: 'session-abc-123',
          total_cost_usd: 0.001,
          usage: { input_tokens: 100, output_tokens: 50 },
          is_error: false,
        };
      }

      mockQuery.mockReturnValue(textToolTextStream());
      const connector = ctx.channelRegistry.get('test-channel')!;
      const item = makeQueueItem();

      await runner.run(item);

      const sendCalls = vi
        .mocked(connector.send)
        .mock.calls.filter(([, body]) => (body as { body: string }).body !== 'Thinking...');
      expect(sendCalls).toHaveLength(2);
      expect(sendCalls[0]![1]).toEqual({ body: 'Before tool.' });
      expect(sendCalls[1]![1]).toEqual({ body: 'After tool.' });

      // Verify DB persistence stores the full transcript with block separators
      expect(ctx.repos.message.insert).toHaveBeenCalledTimes(1);
      const insertCall = vi.mocked(ctx.repos.message.insert).mock.calls[0]![0] as {
        content: string;
      };
      const persisted = JSON.parse(insertCall.content);
      expect(persisted.body).toBe('Before tool.\n\nAfter tool.');
    });

    it('sends three separate messages for text → tool → text → tool → text', async () => {
      async function* threeBlockStream() {
        yield {
          type: 'assistant',
          message: {
            content: [
              { text: 'Block 1.' },
              { type: 'tool_use', id: 'tu-001', name: 'memory_access', input: {} },
            ],
          },
        };
        yield {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tu-001', content: 'result1' }],
          },
        };
        yield {
          type: 'assistant',
          message: {
            content: [
              { text: 'Block 2.' },
              { type: 'tool_use', id: 'tu-002', name: 'memory_access', input: {} },
            ],
          },
        };
        yield {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tu-002', content: 'result2' }],
          },
        };
        yield {
          type: 'assistant',
          message: { content: [{ text: 'Block 3.' }] },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: '',
          session_id: 'session-abc-123',
          total_cost_usd: 0.001,
          usage: { input_tokens: 100, output_tokens: 50 },
          is_error: false,
        };
      }

      mockQuery.mockReturnValue(threeBlockStream());
      const connector = ctx.channelRegistry.get('test-channel')!;
      const item = makeQueueItem();

      await runner.run(item);

      const sendCalls = vi
        .mocked(connector.send)
        .mock.calls.filter(([, body]) => (body as { body: string }).body !== 'Thinking...');
      expect(sendCalls).toHaveLength(3);
      expect(sendCalls[0]![1]).toEqual({ body: 'Block 1.' });
      expect(sendCalls[1]![1]).toEqual({ body: 'Block 2.' });
      expect(sendCalls[2]![1]).toEqual({ body: 'Block 3.' });

      // Verify DB persistence stores the full transcript with block separators
      expect(ctx.repos.message.insert).toHaveBeenCalledTimes(1);
      const insertCall = vi.mocked(ctx.repos.message.insert).mock.calls[0]![0] as {
        content: string;
      };
      const persisted = JSON.parse(insertCall.content);
      expect(persisted.body).toBe('Block 1.\n\nBlock 2.\n\nBlock 3.');
    });

    it('concatenates consecutive text events with no tool between them into a single message', async () => {
      // Multiple text blocks in the same assistant turn (no tool in between)
      // should be combined into one message.
      async function* consecutiveTextStream() {
        yield {
          type: 'assistant',
          message: {
            content: [{ text: 'Part A. ' }, { text: 'Part B.' }],
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: '',
          session_id: 'session-abc-123',
          total_cost_usd: 0.001,
          usage: { input_tokens: 100, output_tokens: 50 },
          is_error: false,
        };
      }

      mockQuery.mockReturnValue(consecutiveTextStream());
      const connector = ctx.channelRegistry.get('test-channel')!;
      const item = makeQueueItem();

      await runner.run(item);

      const sendCalls = vi
        .mocked(connector.send)
        .mock.calls.filter(([, body]) => (body as { body: string }).body !== 'Thinking...');
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]![1]).toEqual({ body: 'Part A. Part B.' });
    });
  });

  // -------------------------------------------------------------------------
  // Tool call messages — showToolCalls per channel (issue #108)
  // -------------------------------------------------------------------------

  describe('showToolCalls', () => {
    /** Reusable stream: text → native tool_use → text */
    async function* textToolTextStream() {
      yield {
        type: 'assistant',
        message: {
          content: [
            { text: 'Before tool.' },
            { type: 'tool_use', id: 'tu-001', name: 'memory_access', input: {} },
          ],
        },
      };
      yield {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-001', content: 'ok' }],
        },
      };
      yield {
        type: 'assistant',
        message: { content: [{ text: 'After tool.' }] },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: '',
        session_id: 'session-abc-123',
        total_cost_usd: 0.001,
        usage: { input_tokens: 100, output_tokens: 50 },
        is_error: false,
      };
    }

    it('sends tool call description between preceding text and post-tool text when showToolCalls is true', async () => {
      ctx.config = {
        ...ctx.config,
        channels: [{ name: 'test-channel', showToolCalls: true }],
      } as any;
      runner = new AgentRunner(ctx);
      mockQuery.mockReturnValue(textToolTextStream());
      const connector = ctx.channelRegistry.get('test-channel')!;

      await runner.run(makeQueueItem());

      const sendBodies = vi
        .mocked(connector.send)
        .mock.calls.map(([, body]) => (body as { body: string }).body);
      // preceding text → tool description → post-tool text
      expect(sendBodies).toContain('💾 Using Memory Access');
      const toolCallIndex = sendBodies.indexOf('💾 Using Memory Access');
      const beforeToolIndex = sendBodies.indexOf('Before tool.');
      const afterToolIndex = sendBodies.indexOf('After tool.');
      // preceding text flushed first, then tool description, then post-tool text
      expect(beforeToolIndex).toBeLessThan(toolCallIndex);
      expect(toolCallIndex).toBeLessThan(afterToolIndex);
    });

    it('does not send tool call description when showToolCalls is false', async () => {
      ctx.config = {
        ...ctx.config,
        channels: [{ name: 'test-channel', showToolCalls: false }],
      } as any;
      runner = new AgentRunner(ctx);
      mockQuery.mockReturnValue(textToolTextStream());
      const connector = ctx.channelRegistry.get('test-channel')!;

      await runner.run(makeQueueItem());

      const sendBodies = vi
        .mocked(connector.send)
        .mock.calls.map(([, body]) => (body as { body: string }).body);
      expect(sendBodies).not.toContain('💾 Using Memory Access');
    });

    it('does not send tool call description when showToolCalls is absent (default off)', async () => {
      // ctx.config has no channels entry — default behaviour
      mockQuery.mockReturnValue(textToolTextStream());
      const connector = ctx.channelRegistry.get('test-channel')!;

      await runner.run(makeQueueItem());

      const sendBodies = vi
        .mocked(connector.send)
        .mock.calls.map(([, body]) => (body as { body: string }).body);
      expect(sendBodies).not.toContain('💾 Using Memory Access');
    });

    it('formats MCP tool names correctly with showToolCalls true', async () => {
      ctx.config = {
        ...ctx.config,
        channels: [{ name: 'test-channel', showToolCalls: true }],
      } as any;
      runner = new AgentRunner(ctx);

      async function* mcpToolStream() {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'mcp_tool_use',
                id: 'tu-002',
                name: 'brave_web_search',
                server_name: 'brave-search',
                input: { query: 'test' },
              },
            ],
          },
        };
        yield {
          type: 'user',
          message: {
            content: [{ type: 'mcp_tool_result', tool_use_id: 'tu-002', content: 'results' }],
          },
        };
        yield {
          type: 'assistant',
          message: { content: [{ text: 'Found it.' }] },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: '',
          session_id: 'session-abc-123',
          total_cost_usd: 0.001,
          usage: { input_tokens: 100, output_tokens: 50 },
          is_error: false,
        };
      }

      mockQuery.mockReturnValue(mcpToolStream());
      const connector = ctx.channelRegistry.get('test-channel')!;

      await runner.run(makeQueueItem());

      const sendBodies = vi
        .mocked(connector.send)
        .mock.calls.map(([, body]) => (body as { body: string }).body);
      expect(sendBodies).toContain('🌐 Using Brave Search: web search');
    });

    it('skips tool description for internal __talond_ servers even with showToolCalls true', async () => {
      ctx.config = {
        ...ctx.config,
        channels: [{ name: 'test-channel', showToolCalls: true }],
      } as any;
      runner = new AgentRunner(ctx);

      async function* internalToolStream() {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'mcp_tool_use',
                id: 'tu-003',
                name: 'memory_access',
                server_name: '__talond_host_tools',
                input: {},
              },
            ],
          },
        };
        yield {
          type: 'user',
          message: {
            content: [{ type: 'mcp_tool_result', tool_use_id: 'tu-003', content: 'ok' }],
          },
        };
        yield {
          type: 'assistant',
          message: { content: [{ text: 'Done.' }] },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: '',
          session_id: 'session-abc-123',
          total_cost_usd: 0.001,
          usage: { input_tokens: 100, output_tokens: 50 },
          is_error: false,
        };
      }

      mockQuery.mockReturnValue(internalToolStream());
      const connector = ctx.channelRegistry.get('test-channel')!;

      await runner.run(makeQueueItem());

      const sendBodies = vi
        .mocked(connector.send)
        .mock.calls.map(([, body]) => (body as { body: string }).body);
      // Internal tools should NOT produce a tool call description
      const toolDescriptions = sendBodies.filter((b) => b.startsWith('💾') || b.startsWith('🔧'));
      expect(toolDescriptions).toHaveLength(0);
    });
  });
});

// Missing composition is not permission to use the generic Signal send path.
describe('AgentRunner Signal runtime admission', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockReturnValue(makeAgentStream());
  });

  it('refuses a known Signal origin before provider or session restoration without runtime dependencies', async () => {
    const base = makeMockContext();
    vi.mocked(base.repos.channel.findById).mockReturnValue(
      ok({
        id: 'chan-001',
        name: 'signal-origin',
        type: 'signal',
        config: '{}',
        credentials_ref: null,
        enabled: 1,
        created_at: 0,
        updated_at: 0,
      }),
    );
    const result = await new AgentRunner(base).run(makeQueueItem());
    expect(result.isErr()).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(base.sessionTracker.getSessionId).not.toHaveBeenCalled();
    expect(base.repos.run.insert).not.toHaveBeenCalled();
  });

  it.each(['__talond_signal_delivery_v1', '__talond_signal_delivery_started_v1'])(
    'refuses reserved %s presence on an ordinary origin without composition',
    async (key) => {
      const base = makeMockContext();
      const result = await new AgentRunner(base).run(
        makeQueueItem({
          payload: { personaId: 'persona-001', content: 'command', [key]: null },
        }),
      );
      expect(result.isErr()).toBe(true);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(base.repos.run.insert).not.toHaveBeenCalled();
    },
  );

  it('refuses a Signal background notification before the generic send without composition', async () => {
    const base = makeMockContext();
    const connector = base.channelRegistry.get('test-channel')!;
    vi.mocked(base.repos.channel.findById).mockReturnValue(
      ok({
        id: 'chan-001',
        name: 'signal-origin',
        type: 'signal',
        config: '{}',
        credentials_ref: null,
        enabled: 1,
        created_at: 0,
        updated_at: 0,
      }),
    );
    const result = await new AgentRunner(base).run(
      makeQueueItem({
        type: 'collaboration',
        payload: {
          personaId: 'persona-001',
          kind: 'background_task_notification',
          taskId: 'original-task',
          status: 'completed',
          content: 'exact notification',
        },
      }),
    );
    expect(result.isErr()).toBe(true);
    expect(connector.send).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('AgentRunner absent Signal composition reserved input boundaries', () => {
  it.each([
    '{"\\u005f_talond_signal_delivery_v1":',
    '[{"__talond_signal_delivery_started_v1":null}]',
    '{"__talond_sig',
  ])(
    'fails closed on malformed/non-object reserved evidence %s without repairing a payload',
    async (payload) => {
      mockQuery.mockReset();
      mockQuery.mockReturnValue(makeAgentStream());
      const result = await new AgentRunner(makeMockContext()).run(makeQueueItem({ payload }));
      expect(result.isErr()).toBe(true);
      expect(mockQuery).not.toHaveBeenCalled();
    },
  );

  it('does not mistake nested/incidental reserved text for root authority on an ordinary origin', async () => {
    mockQuery.mockReset();
    mockQuery.mockReturnValue(makeAgentStream());
    const result = await new AgentRunner(makeMockContext()).run(
      makeQueueItem({
        payload: {
          personaId: 'persona-001',
          content: 'mention __talond_signal_delivery_v1',
          nested: { __talond_signal_delivery_v1: null },
        },
      }),
    );
    expect(result.isOk()).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

// Actual accepted producer composition; only provider IO and the private Unix peer are synthetic.
// Pinned0.14.9/3997429779095ff3a2d64c877126e84fce9852aa:
// VersionCommand60-66; ListAccountsCommand12-47; ListDevicesCommand40-67;
// SignalJsonRpcDispatcherHandler255-280; JsonContact9-29;
// JsonSendMessageResult10-48; JsonRecipientAddress9-15; SendMessageResultUtils43-68.
describe('AgentRunner saved Signal lifecycle', () => {
  const account = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const target = `signal:v1:${account}:self`;
  const logger = pino({ level: 'silent' });
  type Request = SignalRpcRequest & { readonly id: string };
  let ctx: DaemonContext;
  let db: ReturnType<typeof createTestDb>;
  let queue: QueueRepository;
  let runs: RunRepository;
  let messages: MessageRepository;
  let connector: SignalConnector;
  let executions: SignalToolExecutionRegistry;
  let directory: string;
  let server: Server;
  let sockets: Socket[];
  let sentBodies: string[];
  let sendStates: SignalDeliveryCheckpoint[];
  let answerSend: (request: Extract<Request, { method: 'send' }>, socket: Socket) => void;

  function reply(socket: Socket, request: Request, result: unknown): void {
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  }
  async function finish<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    void promise.finally(() => {
      done = true;
    });
    for (let i = 0; i < 200 && !done; i++) {
      for (let j = 0; j < 10; j++) await new Promise<void>((resolve) => setImmediate(resolve));
      if (!done) await vi.advanceTimersByTimeAsync(1000);
    }
    expect(done).toBe(true);
    return promise;
  }
  async function untilSignal(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 2000 && !predicate(); i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(predicate()).toBe(true);
  }
  function enqueue(
    id = 'queue',
    payload: Record<string, unknown> = { personaId: 'persona', content: 'command' },
    type: 'message' | 'collaboration' | 'schedule' = 'message',
  ): QueueItem {
    return rowToQueueItem(
      queue
        .enqueue({
          id,
          thread_id: 'thread',
          message_id: null,
          type,
          payload: JSON.stringify(payload),
          max_attempts: 3,
        })
        ._unsafeUnwrap(),
    );
  }
  function saved(id = 'queue'): SignalDeliveryCheckpoint {
    const state = queue.inspectSignalDelivery(id, Date.now())._unsafeUnwrap();
    if (state.kind !== 'checkpoint') throw new Error('Expected actual saved reply');
    return state.checkpoint;
  }
  async function prepareBackground(item: QueueItem): Promise<SignalDeliveryCheckpoint> {
    const entry = SignalInvocationGuard.enter(queue, item.id)._unsafeUnwrap();
    if (entry.kind !== 'execution') throw new Error('Expected issued guard');
    const actor = new SignalReplyDelivery({
      queue,
      audit: ctx.repos.audit,
      resolve: () => ok(connector),
      persist: () => ok(undefined),
    });
    const checkpoint = (
      await actor.prepare(
        {
          queueItemId: item.id,
          deliveryId: `delivery-${item.id}`,
          threadId: item.threadId,
          personaId: 'persona',
          channelName: 'signal-test',
          accountUuid: account,
          destination: target,
          kind: 'background',
          body: 'ORIGINAL **body** 😀',
        },
        entry.guard,
      )
    )._unsafeUnwrap();
    entry.guard.close();
    return checkpoint;
  }
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    vi.setSystemTime(1_000_000);
    mockQuery.mockReset();
    mockQuery.mockReturnValue(makeAgentStream());
    db = createTestDb();
    queue = new QueueRepository(db);
    runs = new RunRepository(db);
    messages = new MessageRepository(db);
    const threads = new ThreadRepository(db);
    const channels = new ChannelRepository(db);
    const personas = new PersonaRepository(db);
    const loader = new PersonaLoader(personas, logger);
    personas
      .insert({
        id: 'persona',
        name: 'fixture',
        model: 'fixture',
        system_prompt_file: null,
        skills: '[]',
        capabilities: '{}',
        mounts: '[]',
        max_concurrent: null,
      })
      ._unsafeUnwrap();
    (
      await loader.loadFromConfig([
        PersonaConfigSchema.parse({
          name: 'fixture',
          model: 'fixture',
          capabilities: { allow: ['channel.send:*'] },
        }),
      ])
    )._unsafeUnwrap();
    directory = fs.mkdtempSync(join(homedir(), '.signal-runner-'));
    fs.chmodSync(directory, 0o700);
    const config = SignalConfigSchema.parse({
      accountMode: 'personal',
      socketPath: join(directory, 'rpc.sock'),
      account,
      accountUuid: account,
      deviceId: 3,
      deviceCreatedTimestamp: 200,
      allowedGroups: ['QQ=='],
    });
    channels
      .insert({
        id: 'channel',
        name: 'signal-test',
        type: 'signal',
        config: JSON.stringify(config),
        enabled: 1,
        credentials_ref: null,
      })
      ._unsafeUnwrap();
    threads
      .insert({ id: 'thread', channel_id: 'channel', external_id: target, metadata: '{}' })
      ._unsafeUnwrap();
    sockets = [];
    sentBodies = [];
    sendStates = [];
    answerSend = (request, socket) =>
      reply(socket, request, {
        timestamp: 900,
        results: [
          { type: 'SUCCESS', recipientAddress: { uuid: account, number: null, username: null } },
        ],
      });
    server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString('utf8');
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const request: Request = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (request.method === 'version') reply(socket, request, { version: '0.14.9' });
          else if (request.method === 'listAccounts')
            reply(socket, request, [{ number: null, aci: account }]);
          else if (request.method === 'listDevices')
            reply(socket, request, [
              { id: 1, name: null, createdTimestamp: 100, lastSeenTimestamp: 500 },
              { id: 3, name: null, createdTimestamp: 200, lastSeenTimestamp: 500 },
            ]);
          else if (request.method === 'subscribeReceive') reply(socket, request, 7);
          else if (request.method === 'listContacts')
            reply(socket, request, [
              {
                uuid: request.params.recipient[0],
                isBlocked: false,
                unregistered: false,
                messageExpirationTime: 0,
              },
            ]);
          else if (request.method === 'send') {
            sentBodies.push(request.params.message);
            const state = queue.inspectSignalDelivery('queue', Date.now());
            if (state.isOk() && state.value.kind === 'checkpoint')
              sendStates.push(state.value.checkpoint);
            answerSend(request, socket);
          } else reply(socket, request, {});
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.socketPath, resolve);
    });
    fs.chmodSync(config.socketPath, 0o600);
    connector = new SignalConnector(config, 'signal-test', logger, {
      queue,
      accounts: new SignalAccountStateRepository(db),
      leases: new SignalDestinationLeaseRepository(db),
      registry: SignalDeviceRegistry.create(1, [config])._unsafeUnwrap(),
      random: () => 0.5,
      monotonicNow: () => performance.now(),
    });
    connector.onMessageWithReceipt(() => ok('accepted'));
    const registry = new ChannelRegistry(logger);
    registry.register(connector);
    const base = makeMockContext();
    executions = new SignalToolExecutionRegistry({ queue, runs, personas: loader });
    ctx = {
      ...base,
      db,
      logger,
      channelRegistry: registry,
      personaLoader: loader,
      repos: {
        ...base.repos,
        queue,
        run: runs,
        message: messages,
        thread: threads,
        channel: channels,
        persona: personas,
        audit: new AuditRepository(db),
        binding: new BindingRepository(db),
      },
      config: {
        ...base.config,
        channels: [ChannelConfigSchema.parse({ name: 'signal-test', type: 'signal', config })],
      },
      // Supplied lifecycle boundary, NOT proof of the actual012 HostToolsBridge drain.
      signalRuntime: { executions, sealAndDrain: async () => ok(undefined) },
    };
    await finish(connector.start());
    expect(connector.status().state).toBe('ready');
  });
  afterEach(async () => {
    db.pragma('query_only = OFF');
    await finish(connector.stopWithResult());
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('buffers pre-tool text and commits original usage/session/history before completing the original run', async () => {
    async function* stream() {
      yield {
        type: 'assistant',
        message: {
          content: [
            { text: '**Before** 😀' },
            { type: 'tool_use', id: 'tool', name: 'Read', input: {} },
          ],
        },
      };
      yield { type: 'assistant', message: { content: [{ text: 'After' }] } };
      yield {
        type: 'result',
        subtype: 'success',
        result: '',
        session_id: 'original-session',
        usage: { input_tokens: 123, output_tokens: 45 },
        total_cost_usd: 0.006,
        is_error: false,
      };
    }
    mockQuery.mockReturnValue(stream());
    const result = await finish(new AgentRunner(ctx).run(enqueue()));
    expect(result.isOk()).toBe(true);
    expect(sentBodies).toEqual(['Before 😀\n\nAfter']);
    expect(sendStates).toHaveLength(1);
    expect(sendStates[0]).toMatchObject({ body: '**Before** 😀\n\nAfter', phase: 'in_flight' });
    const run = runs.findByThread('thread')._unsafeUnwrap();
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({
      status: 'completed',
      input_tokens: 123,
      output_tokens: 45,
      session_id: 'original-session',
      cost_usd: 0.006,
      queue_item_id: 'queue',
    });
    expect(messages.findByThread('thread', 100, 0)._unsafeUnwrap()).toMatchObject([
      {
        content: JSON.stringify({ body: '**Before** 😀\n\nAfter' }),
        idempotency_key: `outbound:${run[0].id}`,
        run_id: run[0].id,
      },
    ]);
    expect(queue.findById('queue')._unsafeUnwrap()?.status).toBe('completed');
    expect(
      executions.resolve({ runId: run[0].id, threadId: 'thread', personaId: 'persona' }).isErr(),
    ).toBe(true);
  });

  it('completes a Signal-origin run whose final text is empty without a Signal final send', async () => {
    async function* stream() {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }] },
      };
      yield { type: 'assistant', message: { content: [{ text: '   \n' }] } };
      yield {
        type: 'result',
        subtype: 'success',
        result: '',
        session_id: 'silent-session',
        usage: { input_tokens: 7, output_tokens: 1 },
        total_cost_usd: 0.001,
        is_error: false,
      };
    }
    mockQuery.mockReturnValue(stream());
    const result = await finish(new AgentRunner(ctx).run(enqueue()));
    expect(result.isOk()).toBe(true);
    expect(sentBodies).toEqual([]);
    expect(sendStates).toHaveLength(0);
    const run = runs.findByThread('thread')._unsafeUnwrap();
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({
      status: 'completed',
      input_tokens: 7,
      session_id: 'silent-session',
      queue_item_id: 'queue',
    });
    // The queue processor completes ordinary items after run() resolves; the runner must not send.
  });

  it.each([
    ['resolves Err', () => Promise.resolve(err(new Error('bridge unavailable'))), 8],
    ['never settles', () => new Promise<never>(() => {}), 1],
  ] as const)(
    'bounds a generation drain that %s and returns a typed Err instead of hanging',
    async (_label, drain, expectedCalls) => {
      let drainCalls = 0;
      const context = {
        ...ctx,
        signalRuntime: {
          executions,
          sealAndDrain: () => {
            drainCalls++;
            return drain();
          },
        },
      };
      async function* stream() {
        yield { type: 'assistant', message: { content: [{ text: 'Final reply' }] } };
        yield {
          type: 'result',
          subtype: 'success',
          result: '',
          session_id: 'drain-session',
          usage: { input_tokens: 2, output_tokens: 1 },
          total_cost_usd: 0,
          is_error: false,
        };
      }
      mockQuery.mockReturnValue(stream());
      const result = await finish(new AgentRunner(context).run(enqueue()));
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toMatchObject({ reason: 'DRAIN_EXHAUSTED' });
      expect(drainCalls).toBe(expectedCalls);
      expect(sentBodies).toEqual([]);
      expect(queue.findById('queue')._unsafeUnwrap()?.status).not.toBe('completed');
    },
    120_000,
  );

  async function settleWithin(promise: Promise<unknown>, fakeMs: number): Promise<void> {
    let settled = false;
    const mark = (): void => {
      settled = true;
    };
    void promise.then(mark, mark);
    for (let elapsed = 0; elapsed < fakeMs && !settled; elapsed += 100) {
      for (let j = 0; j < 10; j++) await new Promise<void>((resolve) => setImmediate(resolve));
      if (!settled) await vi.advanceTimersByTimeAsync(100);
    }
    expect(settled).toBe(true);
  }

  function useShortQueryTimeout(): void {
    // The persona's queryTimeoutMinutes (schema default 10) overrides the constructor option, so
    // clear it here to arm the 200 ms test timeout.
    const loaded = ctx.personaLoader.getByName('fixture')._unsafeUnwrap();
    if (loaded === undefined) throw new Error('fixture persona not loaded');
    (loaded.config as { queryTimeoutMinutes?: number }).queryTimeoutMinutes = undefined;
  }

  it.each([
    [
      'next() never resolves and return() never resolves',
      () => new Promise<never>(() => {}),
      () => new Promise<never>(() => {}),
    ],
    [
      'return() resolves but next() stays pending',
      () => new Promise<never>(() => {}),
      () => Promise.resolve({ done: true, value: undefined }),
    ],
  ] as const)(
    'settles a guarded query timeout within bounded fake time when %s',
    async (_label, next, ret) => {
      useShortQueryTimeout();
      let drainCalls = 0;
      const context = {
        ...ctx,
        signalRuntime: {
          executions,
          sealAndDrain: () => {
            drainCalls++;
            return Promise.resolve(ok(undefined));
          },
        },
      };
      const iterator = {
        next: vi.fn(next),
        return: vi.fn(ret),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      mockQuery.mockReturnValue({ [Symbol.asyncIterator]: () => iterator } as never);

      const run = new AgentRunner(context, { queryTimeoutMs: 200 }).run(enqueue());
      await settleWithin(run, 10_000);
      const result = await run;

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('timed out after');
      expect(drainCalls).toBe(1);
      expect(sentBodies).toEqual([]);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(runs.findByThread('thread')._unsafeUnwrap()[0]).toMatchObject({ status: 'failed' });
    },
    30_000,
  );

  it('keeps a guarded timeout non-terminal until an admitted Signal continuation settles, then fails without replay', async () => {
    useShortQueryTimeout();
    let drainCalls = 0;
    let releaseAdmission!: () => void;
    const admitted = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const context = {
      ...ctx,
      signalRuntime: {
        executions,
        sealAndDrain: () => {
          drainCalls++;
          return admitted.then(() => ok(undefined));
        },
      },
    };
    async function* stream() {
      // The admitted Signal continuation is modelled by the pending drain port below.
      yield { type: 'assistant', message: { content: [{ text: 'partial' }] } };
      await new Promise(() => {});
    }
    mockQuery.mockReturnValue(stream());

    const run = new AgentRunner(context, { queryTimeoutMs: 200 }).run(enqueue());
    let settled = false;
    void run.then(() => {
      settled = true;
    });
    // Advance until the query timeout has fired and the runner has entered the drain.
    for (let i = 0; i < 200 && drainCalls === 0; i++) {
      for (let j = 0; j < 10; j++) await new Promise<void>((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(drainCalls).toBe(1);
    // Well past the 200 ms timeout, the run must still wait for the admitted continuation.
    await vi.advanceTimersByTimeAsync(5_000);
    for (let j = 0; j < 10; j++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseAdmission();
    const result = await finish(run);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('timed out after');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(sentBodies).toEqual([]);
    expect(runs.findByThread('thread')._unsafeUnwrap()[0]).toMatchObject({ status: 'failed' });
  });

  it('bounds Signal state-read retries and returns the last typed database error', async () => {
    const reads = vi.spyOn(queue, 'findById').mockReturnValue(err(new DbError('database is locked')));
    const result = await finish(new AgentRunner(ctx).run(enqueue()));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(DbError);
    expect(reads.mock.calls.length).toBeGreaterThan(1);
    expect(reads.mock.calls.length).toBeLessThanOrEqual(8);
    reads.mockRestore();
  });

  it('dispatches a saved background checkpoint before notification parsing, provider selection and session restore', async () => {
    const item = enqueue(
      'queue',
      {
        personaId: 'persona',
        kind: 'background_task_notification',
        taskId: 'task-original',
        status: 'completed',
        content: 'ORIGINAL **body** 😀',
      },
      'collaboration',
    );
    await prepareBackground(item);
    const result = await finish(
      new AgentRunner(ctx).run({ ...item, payload: { content: 'STALE' } }),
    );
    expect(result.isOk()).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(ctx.sessionTracker.getSessionId).not.toHaveBeenCalled();
    expect(runs.findByThread('thread')._unsafeUnwrap()).toEqual([]);
    expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toMatchObject([
      {
        idempotency_key: 'background-task:task-original:completed',
        run_id: null,
        content: JSON.stringify({ body: 'ORIGINAL **body** 😀' }),
      },
    ]);
    expect(sentBodies).toEqual(['ORIGINAL body 😀']);
    expect((await finish(new AgentRunner(ctx).run(item))).isOk()).toBe(true);
    expect(sentBodies).toHaveLength(1);
  });
  it('retains the handler and issued guard while the supplied generation drain owns a submitted tool', async () => {
    let settleSend: (() => void) | undefined;
    let toolWork: Promise<unknown> | undefined;
    let originalGuard: SignalInvocationGuard | undefined;
    answerSend = (request, socket) => {
      settleSend = () =>
        reply(socket, request, {
          timestamp: 900,
          results: [
            { type: 'SUCCESS', recipientAddress: { uuid: account, number: null, username: null } },
          ],
        });
    };
    let drainEntered = false;
    const runtime = {
      executions,
      sealAndDrain: async () => {
        drainEntered = true;
        await toolWork;
        return ok(undefined);
      },
    };
    const context = { ...ctx, signalRuntime: runtime };
    async function* stream() {
      const run = runs.findByThread('thread')._unsafeUnwrap()[0];
      const identity = { runId: run.id, threadId: 'thread', personaId: 'persona' };
      originalGuard = executions.resolve(identity)._unsafeUnwrap();
      toolWork = executions.invoke(identity, connector, target, { body: 'explicit original' });
      for (let i = 0; i < 2000 && settleSend === undefined; i++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      yield {
        type: 'result',
        subtype: 'success',
        result: 'final original',
        session_id: 'session',
        usage: { input_tokens: 1, output_tokens: 1 },
        is_error: false,
      };
    }
    mockQuery.mockReturnValue(stream());
    let completed = false;
    const running = new AgentRunner(context).run(enqueue()).then((result) => {
      completed = true;
      return result;
    });
    await untilSignal(() => drainEntered);
    expect(drainEntered).toBe(true);
    expect(completed).toBe(false);
    expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap().kind).toBe('invoked');
    expect(runs.findByThread('thread')._unsafeUnwrap()[0].status).toBe('running');
    expect(originalGuard?.context('still-live', 'explicit').isOk()).toBe(true);
    settleSend?.();
    // Subsequent final send can use the same synthetic peer, without replaying the tool.
    answerSend = (request, socket) =>
      reply(socket, request, {
        timestamp: 900,
        results: [
          { type: 'SUCCESS', recipientAddress: { uuid: account, number: null, username: null } },
        ],
      });
    expect((await finish(running)).isOk()).toBe(true);
    expect(sentBodies).toEqual(['explicit original', 'final original']);
    expect(originalGuard?.context('closed', 'explicit').isErr()).toBe(true);
  });

  it('keeps the original run running over repeated delivery-only deferrals without provider reentry', async () => {
    const stopped = await finish(connector.stopWithResult());
    expect(stopped.isOk()).toBe(true);
    const item = enqueue();
    const first = await finish(new AgentRunner(ctx).run(item));
    expect(first._unsafeUnwrapErr()).toBeInstanceOf(DeliveryDeferredError);
    const initialRun = runs.findByThread('thread')._unsafeUnwrap()[0];
    expect(initialRun).toMatchObject({
      status: 'running',
      input_tokens: 100,
      output_tokens: 50,
      session_id: 'session-abc-123',
    });
    const checkpoint = saved();
    expect(checkpoint).toMatchObject({ phase: 'ready', nextChunk: 0, runId: initialRun.id });
    for (let i = 0; i < 4; i++)
      expect((await finish(new AgentRunner(ctx).run(item))).isErr()).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(runs.findByThread('thread')._unsafeUnwrap()).toEqual([initialRun]);
    expect(saved()).toEqual(checkpoint);
    expect(ctx.sessionTracker.setSessionId).toHaveBeenCalledTimes(1);
    expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toEqual([]);
  });

  it('retains generated body and one provider result across initial checkpoint DB-only repair', async () => {
    async function* stream() {
      yield { type: 'assistant', message: { content: [{ text: '**retained** 😀' }] } };
      db.pragma('query_only = ON');
      yield {
        type: 'result',
        subtype: 'success',
        result: '',
        session_id: 'retained-session',
        usage: { input_tokens: 31, output_tokens: 7 },
        is_error: false,
      };
    }
    mockQuery.mockReturnValue(stream());
    let completed = false;
    const running = new AgentRunner(ctx).run(enqueue()).then((result) => {
      completed = true;
      return result;
    });
    await untilSignal(() => db.pragma('query_only', { simple: true }) === 1);
    expect(completed).toBe(false);
    expect(sentBodies).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(runs.findByThread('thread')._unsafeUnwrap()[0]).toMatchObject({
      status: 'running',
      input_tokens: 0,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(completed).toBe(false);
    db.pragma('query_only = OFF');
    expect((await finish(running)).isOk()).toBe(true);
    expect(sentBodies).toEqual(['retained 😀']);
    expect(saved().body).toBe('**retained** 😀');
    expect(runs.findByThread('thread')._unsafeUnwrap()[0]).toMatchObject({
      input_tokens: 31,
      output_tokens: 7,
      session_id: 'retained-session',
      status: 'completed',
    });
    expect(ctx.sessionTracker.setSessionId).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('leaves unknown-owner in_flight untouched and never restores sessions or queries a provider', async () => {
    const item = enqueue(
      'queue',
      {
        personaId: 'persona',
        kind: 'background_task_notification',
        taskId: 'original',
        status: 'completed',
        content: 'ORIGINAL **body** 😀',
      },
      'collaboration',
    );
    const checkpoint = await prepareBackground(item);
    const accounts = new SignalAccountStateRepository(db);
    const state = accounts.getOrCreate(account, Date.now())._unsafeUnwrap();
    queue.beginSignalChunk(checkpoint, state.revision, Date.now())._unsafeUnwrap();
    const before = queue.findById(item.id)._unsafeUnwrap();
    const ownership = accounts.findByAccount(account)._unsafeUnwrap();
    const result = await finish(new AgentRunner(ctx).run(item));
    expect(result.isErr()).toBe(true);
    expect(queue.findById(item.id)._unsafeUnwrap()).toEqual(before);
    expect(accounts.findByAccount(account)._unsafeUnwrap()).toEqual(ownership);
    expect(sentBodies).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(ctx.sessionTracker.getSessionId).not.toHaveBeenCalled();
  });

  it('finalizes a delivered cold checkpoint using original task/status/body without connector resolution', async () => {
    const item = enqueue(
      'queue',
      {
        personaId: 'persona',
        kind: 'background_task_notification',
        taskId: 'cold-original',
        status: 'failed',
        content: 'ORIGINAL **body** 😀',
      },
      'collaboration',
    );
    const checkpoint = await prepareBackground(item);
    const accounts = new SignalAccountStateRepository(db);
    const state = accounts.getOrCreate(account, Date.now())._unsafeUnwrap();
    const ownership = queue
      .beginSignalChunk(checkpoint, state.revision, Date.now())
      ._unsafeUnwrap();
    queue
      .settleSignalChunk(ownership, { kind: 'accepted', successCount: 1 }, Date.now())
      ._unsafeUnwrap();
    ctx.channelRegistry.unregister('signal-test');
    expect((await finish(new AgentRunner(ctx).run(item))).isOk()).toBe(true);
    expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toMatchObject([
      {
        idempotency_key: 'background-task:cold-original:failed',
        run_id: null,
        content: JSON.stringify({ body: 'ORIGINAL **body** 😀' }),
      },
    ]);
    expect((await finish(new AgentRunner(ctx).run(item))).isOk()).toBe(true);
    expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toHaveLength(1);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(sentBodies).toEqual([]);
  });

  it.each(['NETWORK_FAILURE', 'IDENTITY_FAILURE'])(
    'terminalizes actual %s background delivery without a run or provider replay',
    async (type) => {
      answerSend = (request, socket) =>
        reply(socket, request, {
          timestamp: 900,
          results: [{ type, recipientAddress: { uuid: account, number: null, username: null } }],
        });
      const item = enqueue(
        'queue',
        {
          personaId: 'persona',
          kind: 'background_task_notification',
          taskId: 'failed-original',
          status: 'timed_out',
          content: 'original notification',
        },
        'collaboration',
      );
      const result = await finish(new AgentRunner(ctx).run(item));
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(NonRetryableRunError);
      expect(saved().phase).toBe('terminal');
      expect(saved().runId).toBeUndefined();
      expect((await finish(new AgentRunner(ctx).run(item))).isErr()).toBe(true);
      expect(sentBodies).toHaveLength(1);
      expect(runs.findByThread('thread')._unsafeUnwrap()).toEqual([]);
      expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toEqual([]);
      expect(ctx.repos.audit.findByThread('thread')._unsafeUnwrap()).toHaveLength(1);
      expect(mockQuery).not.toHaveBeenCalled();
    },
  );

  it.each(['account replacement', 'unselected target', 'changed thread'])(
    'refuses saved ready work after %s instead of provider fallback',
    async (change) => {
      const item = enqueue(
        'queue',
        {
          personaId: 'persona',
          kind: 'background_task_notification',
          taskId: 'original',
          status: 'completed',
          content: 'ORIGINAL **body** 😀',
        },
        'collaboration',
      );
      await prepareBackground(item);
      const channel = ctx.repos.channel.findById('channel')._unsafeUnwrap();
      if (channel === null) throw new Error('Expected channel');
      const config = SignalConfigSchema.parse(JSON.parse(channel.config));
      if (change === 'account replacement')
        ctx.repos.channel
          .update('channel', {
            config: JSON.stringify({
              ...config,
              account: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
              accountUuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            }),
          })
          ._unsafeUnwrap();
      else if (change === 'unselected target')
        ctx.repos.channel
          .update('channel', { config: JSON.stringify({ ...config, accountMode: 'dedicated' }) })
          ._unsafeUnwrap();
      else ctx.repos.channel.update('channel', { name: 'replacement-name' })._unsafeUnwrap();
      expect((await finish(new AgentRunner(ctx).run(item))).isErr()).toBe(true);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(sentBodies).toEqual([]);
      if (change === 'account replacement') expect(saved().phase).toBe('terminal');
    },
  );

  it('preserves the exact typed query cause instead of stale-session provider retry', async () => {
    const failure = new DeliveryDeferredError(
      new SignalDeliveryError({
        reason: 'TIMEOUT',
        outcome: 'NOT_SENT',
        acceptedChunks: 0,
        currentChunkAcceptance: 'unwritten',
        successCount: 0,
        failureCount: 0,
        retryScope: 'delivery_only',
      }),
      Date.now() + 1000,
    );
    vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue('resumed');
    mockQuery.mockImplementation(() => {
      throw failure;
    });
    const result = await finish(new AgentRunner(ctx).run(enqueue()));
    expect(result._unsafeUnwrapErr()).toBe(failure);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(ctx.sessionTracker.rotateSession).not.toHaveBeenCalled();
  });

  it('renews authenticated generation only after a settled stale-session attempt, retaining the original guard/run', async () => {
    const registered: Array<{ runId: string; bridgeSecret: string }> = [];
    const drained: Array<{ runId: string; bridgeSecret: string }> = [];
    const guards: SignalInvocationGuard[] = [];
    const context = {
      ...ctx,
      hostToolsBridge: {
        ...ctx.hostToolsBridge,
        registerRunAuthentication: (input: {
          runId: string;
          threadId: string;
          personaId: string;
          bridgeSecret: string;
        }) => {
          registered.push(input);
        },
      },
      signalRuntime: {
        executions,
        sealAndDrain: async (generation: { runId: string; bridgeSecret: string }) => {
          drained.push(generation);
          return ok(undefined);
        },
      },
    };
    // Keep the actual bridge instance type in the legacy fixture; replace only its public method.
    ctx.hostToolsBridge.registerRunAuthentication =
      context.hostToolsBridge.registerRunAuthentication;
    vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue('stale-session');
    mockQuery
      .mockImplementationOnce(() => {
        const run = runs.findByThread('thread')._unsafeUnwrap()[0];
        guards.push(
          executions
            .resolve({ runId: run.id, threadId: 'thread', personaId: 'persona' })
            ._unsafeUnwrap(),
        );
        throw new Error('Session not found');
      })
      .mockImplementationOnce(() => {
        const run = runs.findByThread('thread')._unsafeUnwrap()[0];
        guards.push(
          executions
            .resolve({ runId: run.id, threadId: 'thread', personaId: 'persona' })
            ._unsafeUnwrap(),
        );
        return makeAgentStream();
      });
    const result = await finish(
      new AgentRunner({ ...ctx, signalRuntime: context.signalRuntime }).run(enqueue()),
    );
    expect(result.isOk()).toBe(true);
    expect(registered).toHaveLength(2);
    expect(drained).toEqual(registered);
    expect(registered[0].runId).toBe(registered[1].runId);
    expect(registered[0].bridgeSecret).not.toBe(registered[1].bridgeSecret);
    expect(guards[0]).toBe(guards[1]);
    const first = mockQuery.mock.calls[0][0].options.mcpServers.__talond_host_tools.env;
    const second = mockQuery.mock.calls[1][0].options.mcpServers.__talond_host_tools.env;
    expect(first.TALOND_BRIDGE_SECRET).toBe(registered[0].bridgeSecret);
    expect(second.TALOND_BRIDGE_SECRET).toBe(registered[1].bridgeSecret);
    expect(runs.findByThread('thread')._unsafeUnwrap()).toHaveLength(1);
  });

  it('seals the supplied generation before retaining a timed-out provider and real pending tool', async () => {
    let settleSend: (() => void) | undefined;
    let releaseProvider: (() => void) | undefined;
    let toolWork: Promise<unknown> | undefined;
    let drainEntered = false;
    let issued: SignalInvocationGuard | undefined;
    answerSend = (request, socket) => {
      settleSend = () =>
        reply(socket, request, {
          timestamp: 900,
          results: [
            { type: 'SUCCESS', recipientAddress: { uuid: account, number: null, username: null } },
          ],
        });
    };
    const context = {
      ...ctx,
      signalRuntime: {
        executions,
        sealAndDrain: async () => {
          drainEntered = true;
          await toolWork;
          return ok(undefined);
        },
      },
    };
    async function* stream() {
      const run = runs.findByThread('thread')._unsafeUnwrap()[0];
      const identity = { runId: run.id, threadId: 'thread', personaId: 'persona' };
      issued = executions.resolve(identity)._unsafeUnwrap();
      toolWork = executions.invoke(identity, connector, target, { body: 'timeout tool' });
      await new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      yield {
        type: 'result',
        subtype: 'success',
        result: 'LATE text must not send',
        usage: { input_tokens: 1, output_tokens: 1 },
        is_error: false,
      };
    }
    mockQuery.mockReturnValue(stream());
    let completed = false;
    // Persona's normal query deadline is overridden using the actual loaded config.
    const loaded = ctx.personaLoader.getById('persona')._unsafeUnwrap();
    if (loaded === undefined) throw new Error('Expected loaded persona');
    vi.spyOn(ctx.personaLoader, 'getByName').mockReturnValue(
      ok({ ...loaded, config: { ...loaded.config, queryTimeoutMinutes: 1 / 60 } }),
    );
    const running = new AgentRunner(context).run(enqueue()).then((result) => {
      completed = true;
      return result;
    });
    await untilSignal(() => settleSend !== undefined);
    expect(settleSend).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(1000);
    expect(drainEntered).toBe(true);
    expect(completed).toBe(false);
    expect(queue.findById('queue')._unsafeUnwrap()?.status).toBe('pending');
    expect(issued?.context('alive', 'explicit').isOk()).toBe(true);
    settleSend?.();
    releaseProvider?.();
    const result = await finish(running);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(NonRetryableRunError);
    expect(sentBodies).toEqual(['timeout tool']);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(issued?.context('closed', 'explicit').isErr()).toBe(true);
  });

  it('cold-delivers the actual manager notification for a worker differing from the origin binding', async () => {
    ctx.repos.persona
      .insert({
        id: 'bound-persona',
        name: 'origin-owner',
        model: 'fixture',
        system_prompt_file: null,
        skills: '[]',
        capabilities: '{}',
        mounts: '[]',
        max_concurrent: null,
      })
      ._unsafeUnwrap();
    ctx.repos.binding
      .insert({
        id: 'origin-binding',
        channel_id: 'channel',
        thread_id: 'thread',
        persona_id: 'bound-persona',
        is_default: 0,
      })
      ._unsafeUnwrap();
    const tasks = new BackgroundTaskRepository(db);
    const managerQueue = new QueueManager(
      queue,
      ctx.repos.thread,
      { maxAttempts: 3, backoffBaseMs: 1000, backoffMaxMs: 60_000, concurrencyLimit: 5 },
      logger,
    );
    const fake: AgentProvider = {
      name: 'fixture-process',
      skillLoaderTransport: 'stdio',
      createExecutionStrategy: () => ({
        type: 'cli',
        supportsSessionResumption: false,
        run: async () => ({
          output: 'unused',
          usage: { inputTokens: 0, outputTokens: 0 },
          isError: false,
        }),
      }),
      prepareBackgroundInvocation: () =>
        ok({
          command: process.execPath,
          args: ['-e', 'process.stdout.write("Original worker output 😀")'],
          stdin: '',
          cwd: directory,
          timeoutMs: 60_000,
          cleanupPaths: [],
        }),
      parseBackgroundResult: (raw) => ({
        output: raw.stdout,
        stderr: raw.stderr,
        exitCode: raw.exitCode,
        timedOut: raw.timedOut,
      }),
      estimateContextUsage: () => ({ inputTokens: 0, metrics: {} }),
    };
    const providers = new ProviderRegistry(
      {
        'fixture-process': { enabled: true, command: process.execPath, contextWindowTokens: 1024 },
      },
      { 'fixture-process': () => fake },
    );
    let processCompletion: Promise<unknown> | undefined;
    const manager = new BackgroundAgentManager({
      repository: tasks,
      queueManager: managerQueue,
      maxConcurrent: 1,
      defaultTimeoutMinutes: 30,
      defaultProvider: 'fixture-process',
      providerRegistry: providers,
      logger,
      processFactory: (options) => {
        const child = new BackgroundAgentProcess(options);
        const start = child.start.bind(child);
        vi.spyOn(child, 'start').mockImplementation(() => {
          const result = start();
          if (result.isOk()) processCompletion = result.value.completion;
          return result;
        });
        return child;
      },
    });
    try {
      const taskId = (
        await manager.spawn({
          prompt: 'Original prompt',
          personaPrompt: 'fixture',
          personaId: 'bound-persona',
          workerPersonaId: 'persona',
          threadId: 'thread',
          channelId: 'channel',
          channelName: 'signal-test',
          mcpServers: {},
          allowedMcpTools: [],
        })
      )._unsafeUnwrap();
      if (processCompletion === undefined) throw new Error('Expected actual child completion');
      await processCompletion;
      let notifications: QueueItem[] = [];
      for (let i = 0; i < 2000 && notifications.length === 0; i++) {
        notifications = queue
          .findPending()
          ._unsafeUnwrap()
          .map(rowToQueueItem)
          .filter((item) => item.payload.kind === 'background_task_notification');
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(notifications).toHaveLength(1);
      const notification = notifications[0];
      expect(notification.payload).toMatchObject({
        taskId,
        status: 'completed',
        personaId: 'persona',
        providerName: 'fixture-process',
      });
      const body = notification.payload.content;
      if (typeof body !== 'string') throw new Error('Expected actual notification content');
      expect(body).toContain('Original worker output 😀');
      const entry = SignalInvocationGuard.enter(queue, notification.id)._unsafeUnwrap();
      if (entry.kind !== 'execution') throw new Error('Expected issued notification guard');
      const actor = new SignalReplyDelivery({
        queue,
        audit: ctx.repos.audit,
        resolve: () => ok(connector),
        persist: () => ok(undefined),
      });
      (
        await actor.prepare(
          {
            queueItemId: notification.id,
            deliveryId: 'producer-notification',
            kind: 'background',
            threadId: 'thread',
            personaId: 'persona',
            channelName: 'signal-test',
            accountUuid: account,
            destination: target,
            body,
          },
          entry.guard,
        )
      )._unsafeUnwrap();
      entry.guard.close();
      expect((await finish(new AgentRunner(ctx).run(notification))).isOk()).toBe(true);
      expect((await finish(new AgentRunner(ctx).run(notification))).isOk()).toBe(true);
      expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toMatchObject([
        {
          content: JSON.stringify({ body }),
          idempotency_key: `background-task:${taskId}:completed`,
          run_id: null,
        },
      ]);
      expect(runs.findByThread('thread')._unsafeUnwrap()).toEqual([]);
      expect(tasks.findById(taskId)._unsafeUnwrap()?.status).toBe('completed');
      expect(mockQuery).not.toHaveBeenCalled();
      // The producer's SEPARATE message enqueue remains ordinary existing provider work, not a notification replay.
      expect(
        queue
          .findPending()
          ._unsafeUnwrap()
          .filter((row) => row.type === 'message'),
      ).toHaveLength(1);
    } finally {
      await manager.shutdown();
    }
  });

  it.each(['Err', 'throw'])(
    'retains generated content/run/guard while lifecycle %s repeats without reissuing work',
    async (failureMode) => {
      let allowDrain = false;
      let drainCalls = 0;
      let originalGuard: SignalInvocationGuard | undefined;
      const context = {
        ...ctx,
        signalRuntime: {
          executions,
          sealAndDrain: async () => {
            drainCalls++;
            if (allowDrain) return ok(undefined);
            if (failureMode === 'throw') throw new Error('private lifecycle failure');
            return err(new DbError('lifecycle pending'));
          },
        },
      };
      async function* stream() {
        const run = runs.findByThread('thread')._unsafeUnwrap()[0];
        const identity = { runId: run.id, threadId: 'thread', personaId: 'persona' };
        originalGuard = executions.resolve(identity)._unsafeUnwrap();
        await executions.invoke(identity, connector, target, { body: 'one original tool' });
        yield {
          type: 'result',
          subtype: 'success',
          result: 'retained final',
          session_id: 'retained-session',
          usage: { input_tokens: 12, output_tokens: 3 },
          is_error: false,
        };
      }
      mockQuery.mockReturnValue(stream());
      let completed = false;
      const running = new AgentRunner(context).run(enqueue()).then((result) => {
        completed = true;
        return result;
      });
      await untilSignal(() => drainCalls > 0);
      expect(drainCalls).toBe(1);
      expect(completed).toBe(false);
      expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap().kind).toBe('invoked');
      await vi.advanceTimersByTimeAsync(1000);
      expect(drainCalls).toBeGreaterThan(1);
      expect(originalGuard?.context('pending', 'explicit').isOk()).toBe(true);
      expect(runs.findByThread('thread')._unsafeUnwrap()[0].status).toBe('running');
      expect(sentBodies).toEqual(['one original tool']);
      allowDrain = true;
      expect((await finish(running)).isOk()).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(sentBodies).toEqual(['one original tool', 'retained final']);
      expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toHaveLength(1);
    },
  );

  it('allows a healthy ordinary origin to explain an actual handled Signal UNKNOWN without replaying tools', async () => {
    const delivered: string[] = [];
    const ordinary: ChannelConnector = {
      name: 'telegram-origin',
      type: 'telegram',
      start: async () => undefined,
      stop: async () => undefined,
      onMessage: () => undefined,
      format: (body) => body,
      send: async (_destination, output) => {
        delivered.push(output.body);
        return ok(undefined);
      },
    };
    ctx.channelRegistry.register(ordinary);
    ctx.repos.channel
      .insert({
        id: 'telegram',
        name: ordinary.name,
        type: 'telegram',
        config: '{}',
        enabled: 1,
        credentials_ref: null,
      })
      ._unsafeUnwrap();
    ctx.repos.thread
      .insert({
        id: 'ordinary-thread',
        channel_id: 'telegram',
        external_id: 'chat-original',
        metadata: '{}',
      })
      ._unsafeUnwrap();
    const item = rowToQueueItem(
      queue
        .enqueue({
          id: 'queue',
          thread_id: 'ordinary-thread',
          message_id: null,
          type: 'message',
          max_attempts: 3,
          payload: JSON.stringify({ personaId: 'persona', content: 'command' }),
        })
        ._unsafeUnwrap(),
    );
    answerSend = (request, socket) =>
      reply(socket, request, {
        timestamp: 900,
        results: [
          {
            type: 'NETWORK_FAILURE',
            recipientAddress: { uuid: account, number: null, username: null },
          },
        ],
      });
    let handled: unknown;
    async function* stream() {
      const run = runs.findByThread('ordinary-thread')._unsafeUnwrap()[0];
      handled = await executions.invoke(
        { runId: run.id, threadId: 'ordinary-thread', personaId: 'persona' },
        connector,
        target,
        { body: 'explicit Signal' },
      );
      yield {
        type: 'result',
        subtype: 'success',
        result: 'Signal was uncertain; do not repeat.',
        usage: { input_tokens: 2, output_tokens: 3 },
        is_error: false,
      };
    }
    mockQuery.mockReturnValue(stream());
    expect((await finish(new AgentRunner(ctx).run(item))).isOk()).toBe(true);
    expect(handled).toMatchObject({ error: { outcome: 'UNKNOWN', providerRetryable: false } });
    expect(delivered).toEqual(['Signal was uncertain; do not repeat.']);
    expect(sentBodies).toEqual(['explicit Signal']);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(runs.findByThread('ordinary-thread')._unsafeUnwrap()[0].status).toBe('completed');
  });

  it('never sends final content around an affected origin exact-target latch', async () => {
    answerSend = (request, socket) =>
      reply(socket, request, {
        timestamp: 900,
        results: [
          {
            type: 'NETWORK_FAILURE',
            recipientAddress: { uuid: account, number: null, username: null },
          },
        ],
      });
    async function* stream() {
      const run = runs.findByThread('thread')._unsafeUnwrap()[0];
      await executions.invoke(
        { runId: run.id, threadId: 'thread', personaId: 'persona' },
        connector,
        target,
        { body: 'uncertain original' },
      );
      yield {
        type: 'result',
        subtype: 'success',
        result: 'Do not leak final around latch',
        usage: { input_tokens: 19, output_tokens: 5 },
        is_error: false,
      };
    }
    mockQuery.mockReturnValue(stream());
    const result = await finish(new AgentRunner(ctx).run(enqueue()));
    expect(result._unsafeUnwrapErr()).toMatchObject({
      reason: 'TARGET_LATCHED',
      outcome: 'NOT_SENT',
    });
    expect(sentBodies).toEqual(['uncertain original']);
    expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap().kind).toBe('invoked');
    expect(queue.findById('queue')._unsafeUnwrap()?.status).toBe('dead_letter');
    expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(runs.findByThread('thread')._unsafeUnwrap()[0]).toMatchObject({
      input_tokens: 19,
      output_tokens: 5,
      status: 'failed',
    });
  });

  it('waits for the actual original sender repair Result before classifying a retained tool write', async () => {
    let work: Promise<Result<void, Error>> | undefined;
    let originalGuard: SignalInvocationGuard | undefined;
    let barrierCalls = 0;
    answerSend = (request, socket) => {
      db.pragma('query_only = ON');
      reply(socket, request, {
        timestamp: 900,
        results: [
          { type: 'SUCCESS', recipientAddress: { uuid: account, number: null, username: null } },
        ],
      });
    };
    const context = {
      ...ctx,
      signalRuntime: {
        executions,
        sealAndDrain: async () => {
          barrierCalls++;
          await work;
          return connector.retryStateWrites().map(() => undefined);
        },
      },
    };
    async function* stream() {
      const run = runs.findByThread('thread')._unsafeUnwrap()[0];
      const identity = { runId: run.id, threadId: 'thread', personaId: 'persona' };
      originalGuard = executions.resolve(identity)._unsafeUnwrap();
      work = executions.invoke(identity, connector, target, {
        body: 'accepted tool retained write',
      });
      await work;
      yield {
        type: 'result',
        subtype: 'success',
        result: 'must not bypass retained/latching target',
        usage: { input_tokens: 11, output_tokens: 4 },
        is_error: false,
      };
    }
    mockQuery.mockReturnValue(stream());
    let done = false;
    const running = new AgentRunner(context).run(enqueue()).then((result) => {
      done = true;
      return result;
    });
    await untilSignal(() => sentBodies.length === 1);
    await vi.advanceTimersByTimeAsync(8000);
    expect(barrierCalls).toBeGreaterThan(0);
    expect(done).toBe(false);
    expect(originalGuard?.context('owned', 'explicit').isOk()).toBe(true);
    expect(queue.findById('queue')._unsafeUnwrap()?.status).toBe('pending');
    expect(
      new SignalAccountStateRepository(db).findByAccount(account)._unsafeUnwrap()?.reservation,
    ).not.toBeNull();
    db.pragma('query_only = OFF');
    const result = await finish(running);
    expect(result._unsafeUnwrapErr()).toMatchObject({ reason: 'TARGET_LATCHED' });
    const accountState = new SignalAccountStateRepository(db)
      .findByAccount(account)
      ._unsafeUnwrap();
    expect(accountState?.reservation).toBeNull();
    expect(accountState?.recoveryNotBefore).toBe(0);
    expect(sentBodies).toEqual(['accepted tool retained write']);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(originalGuard?.context('closed', 'explicit').isErr()).toBe(true);
  });

  it.each([
    ['personal', 'cli'],
    ['personal', 'sdk'],
    ['dedicated', 'cli'],
    ['dedicated', 'sdk'],
  ] as const)(
    'buffers final text in %s mode with %s notices governed by actual output policy',
    async (mode, strategyType) => {
      const peer = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const destination = mode === 'personal' ? target : `signal:v1:${account}:dm:${peer}`;
      if (mode === 'dedicated') {
        expect((await finish(connector.stopWithResult())).isOk()).toBe(true);
        const config = SignalConfigSchema.parse({
          accountMode: mode,
          account,
          accountUuid: account,
          deviceId: 3,
          socketPath: join(directory, 'rpc.sock'),
          allowedDmPeers: [peer],
        });
        ctx.channelRegistry.unregister('signal-test');
        connector = new SignalConnector(config, 'signal-test', logger, {
          queue,
          accounts: new SignalAccountStateRepository(db),
          leases: new SignalDestinationLeaseRepository(db),
          registry: SignalDeviceRegistry.create(2, [config])._unsafeUnwrap(),
          random: () => 0.5,
          monotonicNow: () => performance.now(),
        });
        connector.onMessageWithReceipt(() => ok('accepted'));
        ctx.channelRegistry.register(connector);
        ctx.repos.channel.update('channel', { config: JSON.stringify(config) })._unsafeUnwrap();
        ctx = {
          ...ctx,
          config: {
            ...ctx.config,
            channels: [
              ChannelConfigSchema.parse({
                name: 'signal-test',
                type: 'signal',
                config,
                showToolCalls: true,
              }),
            ],
          },
        };
        await finish(connector.start());
        await finish(
          (async () => {
            while (connector.status().state !== 'ready')
              await new Promise<void>((resolve) => setTimeout(resolve, 250));
          })(),
        );
      }
      if (mode === 'dedicated')
        ctx.repos.thread
          .insert({
            id: 'policy-thread',
            channel_id: 'channel',
            external_id: destination,
            metadata: '{}',
          })
          ._unsafeUnwrap();
      const threadId = mode === 'personal' ? 'thread' : 'policy-thread';
      const item = rowToQueueItem(
        queue
          .enqueue({
            id: 'queue',
            thread_id: threadId,
            message_id: null,
            type: 'message',
            max_attempts: 3,
            payload: JSON.stringify({ personaId: 'persona', content: 'command' }),
          })
          ._unsafeUnwrap(),
      );
      const providerResult = {
        output: '**Before**After',
        usage: { inputTokens: 3, outputTokens: 2 },
        isError: false,
      };
      const fake: AgentProvider = {
        name: 'policy-provider',
        skillLoaderTransport: 'stdio',
        createExecutionStrategy: () =>
          strategyType === 'cli'
            ? { type: 'cli', supportsSessionResumption: false, run: async () => providerResult }
            : {
                type: 'sdk',
                supportsSessionResumption: false,
                run: async function* () {
                  yield { type: 'text', content: '**Before**' };
                  yield { type: 'tool_event', messageType: 'tool_use', tool: 'Read' };
                  yield { type: 'text', content: 'After' };
                  yield { type: 'result', result: providerResult };
                },
              },
        prepareBackgroundInvocation: () => {
          throw new Error('Not a background provider test');
        },
        parseBackgroundResult: (raw) => ({
          output: raw.stdout,
          stderr: raw.stderr,
          exitCode: raw.exitCode,
          timedOut: raw.timedOut,
        }),
        estimateContextUsage: () => ({ inputTokens: 3, metrics: { input_tokens: 3 } }),
      };
      const config = AgentRunnerProviderConfigSchema.parse({
        enabled: true,
        command: 'unused',
        contextWindowTokens: 1024,
        contextManagement: { enabled: false },
      });
      const context = {
        ...ctx,
        providerRegistry: new ProviderRegistry(
          { 'policy-provider': config },
          { 'policy-provider': () => fake },
        ),
      };
      expect((await finish(new AgentRunner(context).run(item))).isOk()).toBe(true);
      const joined = strategyType === 'cli' ? 'BeforeAfter' : 'Before\n\nAfter';
      expect(sentBodies).toEqual(
        mode === 'dedicated'
          ? strategyType === 'cli'
            ? ['Thinking...', joined]
            : ['🔧 Using Read', joined]
          : [joined],
      );
      expect(saved().body).toBe(strategyType === 'cli' ? '**Before**After' : '**Before**\n\nAfter');
      expect(sendStates).toHaveLength(1);
      expect(messages.findByThread(threadId, 10, 0)._unsafeUnwrap()).toHaveLength(1);
    },
  );

  it('rejects a background checkpoint whose persona differs from the actual original queue payload before bytes', async () => {
    const item = enqueue(
      'queue',
      {
        personaId: 'persona',
        kind: 'background_task_notification',
        taskId: 'original',
        status: 'completed',
        content: 'original body',
      },
      'collaboration',
    );
    const entry = SignalInvocationGuard.enter(queue, item.id)._unsafeUnwrap();
    if (entry.kind !== 'execution') throw new Error('Expected issued guard');
    const actor = new SignalReplyDelivery({
      queue,
      audit: ctx.repos.audit,
      resolve: () => ok(connector),
      persist: () => ok(undefined),
    });
    (
      await actor.prepare(
        {
          queueItemId: item.id,
          threadId: item.threadId,
          deliveryId: 'mismatched-persona',
          personaId: 'foreign-persona',
          kind: 'background',
          channelName: 'signal-test',
          accountUuid: account,
          destination: target,
          body: 'original body',
        },
        entry.guard,
      )
    )._unsafeUnwrap();
    entry.guard.close();
    expect((await finish(new AgentRunner(ctx).run(item))).isErr()).toBe(true);
    expect(sentBodies).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('retries delivered local SQL finalization from the original run only, retaining the exact typed error', async () => {
    let summaries = 0;
    const roller = new ContextRoller({
      messageRepo: messages,
      memoryRepo: new MemoryRepository(db),
      sessionTracker: ctx.sessionTracker,
      logger,
      summarizerRun: async () => {
        summaries++;
        return err(new SubAgentError('Synthetic summarizer boundary'));
      },
    });
    const context = { ...ctx, contextRoller: roller };
    mockQuery.mockReturnValue(
      makeAgentStream({
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80_000 },
      }),
    );
    const failedDb = createTestDb();
    const failedMessages = new MessageRepository(failedDb);
    failedDb.close();
    const actualFailure = failedMessages.findById('unused')._unsafeUnwrapErr();
    vi.spyOn(messages, 'insert').mockReturnValueOnce(err(actualFailure));
    const item = enqueue();
    const first = await finish(new AgentRunner(context).run(item));
    expect(first._unsafeUnwrapErr()).toBe(actualFailure);
    const checkpoint = saved();
    expect(checkpoint.phase).toBe('delivered');
    const observations = vi.mocked(ctx.observability.observe).mock.calls.length;
    expect(runs.findByThread('thread')._unsafeUnwrap()[0]).toMatchObject({
      id: checkpoint.runId,
      status: 'running',
      input_tokens: 100,
      output_tokens: 50,
      session_id: 'session-abc-123',
    });
    expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toEqual([]);
    expect((await finish(new AgentRunner(context).run(item))).isOk()).toBe(true);
    expect(sentBodies).toHaveLength(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(ctx.sessionTracker.setSessionId).toHaveBeenCalledTimes(1);
    expect(runs.findByThread('thread')._unsafeUnwrap()).toHaveLength(1);
    expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toMatchObject([
      {
        idempotency_key: `outbound:${checkpoint.runId}`,
        content: JSON.stringify({ body: 'Hello from the agent!' }),
        run_id: checkpoint.runId,
      },
    ]);
    expect((await finish(new AgentRunner(context).run(item))).isOk()).toBe(true);
    expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toHaveLength(1);
    expect(summaries).toBe(0); // Missing durable per-step/resume facts must not be invented on cold reentry.
    expect(vi.mocked(ctx.observability.observe).mock.calls).toHaveLength(observations);
  });

  it('keeps injected scheduled runs one-shot with no implicit Signal final/history/session restore', async () => {
    ctx.repos.thread
      .insert({
        id: 'schedule-thread',
        channel_id: 'channel',
        external_id: 'schedule:fixture:signal-test',
        metadata: JSON.stringify({ kind: 'schedule', originExternalId: target }),
      })
      ._unsafeUnwrap();
    const item = rowToQueueItem(
      queue
        .enqueue({
          id: 'queue',
          thread_id: 'schedule-thread',
          type: 'schedule',
          message_id: null,
          max_attempts: 3,
          payload: JSON.stringify({ personaId: 'persona', content: 'scheduled command' }),
        })
        ._unsafeUnwrap(),
    );
    expect((await finish(new AgentRunner(ctx).run(item))).isOk()).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(sentBodies).toEqual([]);
    expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toEqual([]);
    expect(ctx.sessionTracker.getSessionId).not.toHaveBeenCalled();
    expect(ctx.sessionTracker.setSessionId).not.toHaveBeenCalled();
    expect(ctx.contextAssembler.assemble).not.toHaveBeenCalled();
    expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap().kind).toBe('ordinary');
    expect(runs.findByThread('schedule-thread')._unsafeUnwrap()[0]).toMatchObject({
      status: 'completed',
      session_id: null,
    });
  });

  it('prefers a newly saved original-run checkpoint over a stale resumed-query catch', async () => {
    vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue('stale-session');
    async function* stream() {
      const run = runs.findByThread('thread')._unsafeUnwrap()[0];
      const guard = executions
        .resolve({ runId: run.id, threadId: 'thread', personaId: 'persona' })
        ._unsafeUnwrap();
      const actor = new SignalReplyDelivery({
        queue,
        audit: ctx.repos.audit,
        resolve: () => ok(connector),
        persist: () => ok(undefined),
      });
      (
        await actor.prepare(
          {
            queueItemId: 'queue',
            threadId: 'thread',
            personaId: 'persona',
            deliveryId: 'already-generated',
            kind: 'reply',
            channelName: 'signal-test',
            accountUuid: account,
            destination: target,
            body: '**Saved** original 😀',
          },
          guard,
        )
      )._unsafeUnwrap();
      throw new Error('Session not found after a current durable handoff');
      yield { type: 'result', subtype: 'success', result: 'unreachable' };
    }
    mockQuery.mockReturnValue(stream());
    expect((await finish(new AgentRunner(ctx).run(enqueue()))).isOk()).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(ctx.sessionTracker.rotateSession).not.toHaveBeenCalled();
    expect(sentBodies).toEqual(['Saved original 😀']);
    expect(runs.findByThread('thread')._unsafeUnwrap()).toHaveLength(1);
    expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toMatchObject([
      { content: JSON.stringify({ body: '**Saved** original 😀' }) },
    ]);
  });
  it.each(['malformed config', 'account replaced', 'target refused'])(
    'never reenters a completed provider after successful precheck then %s before checkpoint save',
    async (change) => {
      const stored = ctx.repos.channel.findById('channel')._unsafeUnwrap();
      if (stored === null) throw new Error('Expected actual channel');
      const originalConfig = SignalConfigSchema.parse(JSON.parse(stored.config));
      async function* stream() {
        yield { type: 'assistant', message: { content: [{ text: 'generated once' }] } };
        ctx.repos.channel
          .update('channel', {
            config:
              change === 'malformed config'
                ? '{broken'
                : JSON.stringify(
                    change === 'account replaced'
                      ? {
                          ...originalConfig,
                          account: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                          accountUuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                        }
                      : { ...originalConfig, accountMode: 'dedicated' },
                  ),
          })
          ._unsafeUnwrap();
        yield {
          type: 'result',
          subtype: 'success',
          result: '',
          session_id: 'generated-session',
          usage: { input_tokens: 27, output_tokens: 9 },
          is_error: false,
        };
      }
      mockQuery.mockReturnValue(stream());
      enqueue();
      const processor = new QueueProcessor(
        queue,
        calculateBackoff,
        new DeadLetterHandler(queue, logger),
        logger,
      );
      const runner = new AgentRunner(ctx);
      expect(await finish(processor.processNext((item) => runner.run(item)))).not.toBeNull();
      expect(queue.findById('queue')._unsafeUnwrap()).toMatchObject({
        status: 'dead_letter',
        attempts: 0,
        max_attempts: 3,
      });
      expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap().kind).toBe(
        'ordinary',
      );
      for (let i = 0; i < 4; i++)
        expect(await finish(processor.processNext((item) => runner.run(item)))).toBeNull();
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(sentBodies).toEqual([]);
      expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toEqual([]);
      expect(runs.findByThread('thread')._unsafeUnwrap()[0]).toMatchObject({
        status: 'failed',
        session_id: 'generated-session',
        input_tokens: 27,
        output_tokens: 9,
      });
    },
  );

  it.each(['repair', 'purge', 'cancel', 'completed', 'failed', 'run absent'] as const)(
    'retains only unsaved Signal failed-status ownership until %s settles',
    async (settlement) => {
      db.exec(`CREATE TEMP TRIGGER reject_failed_status BEFORE UPDATE OF status ON runs
        WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'synthetic status fault'); END`);
      const writes = vi.spyOn(runs, 'updateStatus');
      const tokens = vi.spyOn(runs, 'updateTokens');
      const sessions = vi.spyOn(runs, 'updateSessionId');
      const classified = vi.spyOn(SignalInvocationGuard.prototype, 'classifyFailure');
      let issued: SignalInvocationGuard | undefined;
      let releasedStatus: string | undefined;
      const unregister = vi.fn(() => {
        releasedStatus = runs.findByThread('thread')._unsafeUnwrap()[0]?.status;
      });
      ctx.hostToolsBridge.unregisterRunAuthentication = unregister;
      async function* stream() {
        const run = runs.findByThread('thread')._unsafeUnwrap()[0];
        issued = executions
          .resolve({ runId: run.id, threadId: 'thread', personaId: 'persona' })
          ._unsafeUnwrap();
        ctx.repos.channel.update('channel', { config: '{broken' })._unsafeUnwrap();
        yield {
          type: 'result',
          subtype: 'success',
          result: 'original final',
          session_id: 'original-session',
          total_cost_usd: 0.006,
          usage: { input_tokens: 123, output_tokens: 45 },
          is_error: false,
        };
      }
      mockQuery.mockReturnValue(stream());
      enqueue();
      let result: Result<void, Error> | undefined;
      let done = false;
      const processor = new QueueProcessor(
        queue,
        calculateBackoff,
        new DeadLetterHandler(queue, logger),
        logger,
      );
      const running = processor
        .processNext(async (item) => {
          result = await new AgentRunner(ctx).run(item);
          return result;
        })
        .then((item) => {
          done = true;
          return item;
        });
      try {
        await untilSignal(() => writes.mock.calls.length > 0);
        for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
        const original = runs.findByThread('thread')._unsafeUnwrap()[0];
        expect(original).toMatchObject({
          status: 'running',
          input_tokens: 123,
          output_tokens: 45,
          session_id: 'original-session',
          cost_usd: 0.006,
        });
        expect(writes.mock.results[0]?.value).toMatchObject({ error: expect.any(DbError) });
        // Public dead-letter can succeed independently; it cannot repair the running run.
        if (settlement === 'repair') {
          processor.fail('queue', classified.mock.calls[0][0])._unsafeUnwrap();
          expect(queue.findById('queue')._unsafeUnwrap()?.status).toBe('dead_letter');
        }
        expect(done).toBe(false);
        expect(unregister).not.toHaveBeenCalled();
        expect(issued?.context('pending-status', 'explicit').isOk()).toBe(true);
        await vi.advanceTimersByTimeAsync(750);
        expect(done).toBe(false);
        expect(writes.mock.calls.length).toBeGreaterThan(1);
        expect(tokens).toHaveBeenCalledTimes(1);
        expect(sessions).toHaveBeenCalledTimes(1);
        expect(sentBodies).toEqual([]);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        db.exec('DROP TRIGGER reject_failed_status');
        if (settlement === 'purge') expect(queue.purge(['claimed'])._unsafeUnwrap()).toBe(1);
        else if (settlement === 'cancel')
          runs
            .updateStatus(original.id, 'cancelled', {
              ended_at: Date.now(),
              error: 'operator cancellation',
            })
            ._unsafeUnwrap();
        else if (settlement === 'completed' || settlement === 'failed')
          runs
            .updateStatus(original.id, settlement, {
              ended_at: Date.now(),
              error: 'existing decision',
            })
            ._unsafeUnwrap();
        else if (settlement === 'run absent')
          db.prepare('DELETE FROM runs WHERE id = ?').run(original.id);
        const writesBeforeRetry = writes.mock.calls.length;
        await finish(running);
        const cancelled = ['purge', 'cancel', 'run absent'].includes(settlement);
        if (cancelled) expect(result?._unsafeUnwrapErr()).toBeInstanceOf(DeliveryCancelled);
        else expect(result?._unsafeUnwrapErr()).toBe(classified.mock.calls[0][0]);
        expect(writes.mock.calls.length).toBe(
          writesBeforeRetry + (settlement === 'repair' ? 1 : 0),
        );
        expect(releasedStatus).toBe(
          settlement === 'purge'
            ? 'running'
            : settlement === 'run absent'
              ? undefined
              : settlement === 'cancel'
                ? 'cancelled'
                : settlement === 'completed'
                  ? 'completed'
                  : 'failed',
        );
        expect(unregister).toHaveBeenCalledTimes(1);
        expect(issued?.context('released', 'explicit').isErr()).toBe(true);
        expect(tokens).toHaveBeenCalledTimes(1);
        expect(sessions).toHaveBeenCalledTimes(1);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(sentBodies).toEqual([]);
        expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toEqual([]);
        if (settlement === 'purge') {
          expect(queue.findById('queue')._unsafeUnwrap()).toBeNull();
          // Existing unsaved purge detaches, but does NOT cancel ordinary runs.
          expect(runs.findById(original.id)._unsafeUnwrap()).toMatchObject({
            status: 'running',
            queue_item_id: null,
          });
        }
      } finally {
        db.exec('DROP TRIGGER IF EXISTS reject_failed_status');
        await finish(running);
        classified.mockRestore();
      }
    },
  );

  it.each([
    'queue read',
    'run read',
    'postwrite read',
    'transaction throw',
    'ignored write',
  ] as const)(
    'does not mistake an unsaved Signal %s fault for failed-status settlement',
    async (fault) => {
      db.exec(`CREATE TEMP TRIGGER reject_failed_status BEFORE UPDATE OF status ON runs
        WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'synthetic status fault'); END`);
      const writes = vi.spyOn(runs, 'updateStatus');
      const tokens = vi.spyOn(runs, 'updateTokens');
      const sessions = vi.spyOn(runs, 'updateSessionId');
      const classified = vi.spyOn(SignalInvocationGuard.prototype, 'classifyFailure');
      const closed = createTestDb();
      const unavailableRuns = new RunRepository(closed);
      const unavailableQueue = new QueueRepository(closed);
      closed.close();
      const runFailure = unavailableRuns.findById('absent');
      const queueFailure = unavailableQueue.findById('absent');
      async function* stream() {
        ctx.repos.channel.update('channel', { config: '{broken' })._unsafeUnwrap();
        yield {
          type: 'result',
          subtype: 'success',
          result: 'original final',
          session_id: 'original-session',
          usage: { input_tokens: 123, output_tokens: 45 },
          is_error: false,
        };
      }
      mockQuery.mockReturnValue(stream());
      let done = false;
      const running = new AgentRunner(ctx).run(enqueue()).then((value) => {
        done = true;
        return value;
      });
      try {
        await untilSignal(() => writes.mock.calls.length === 1);
        db.exec('DROP TRIGGER reject_failed_status');
        const run = runs.findByThread('thread')._unsafeUnwrap()[0];
        if (fault === 'queue read') vi.spyOn(queue, 'findById').mockReturnValueOnce(queueFailure);
        else if (fault === 'run read') vi.spyOn(runs, 'findById').mockReturnValueOnce(runFailure);
        else if (fault === 'postwrite read') {
          const write = RunRepository.prototype.updateStatus.bind(runs);
          writes.mockImplementationOnce((...args) => {
            vi.spyOn(runs, 'findById').mockReturnValueOnce(runFailure);
            return write(...args);
          });
        } else if (fault === 'transaction throw') {
          const transaction = runs.transaction.bind(runs);
          vi.spyOn(runs, 'transaction').mockImplementationOnce((callback) =>
            transaction(() => {
              callback();
              throw new Error('synthetic transaction failure after callback');
            }),
          );
        } else
          db.exec(`CREATE TEMP TRIGGER ignore_failed_status BEFORE UPDATE OF status ON runs
          WHEN NEW.status = 'failed' BEGIN SELECT RAISE(IGNORE); END`);
        await vi.advanceTimersByTimeAsync(250);
        expect(done).toBe(false);
        expect(runs.findById(run.id)._unsafeUnwrap()?.status).toBe('running');
        expect(tokens).toHaveBeenCalledTimes(1);
        expect(sessions).toHaveBeenCalledTimes(1);
        expect(sentBodies).toEqual([]);
        db.exec('DROP TRIGGER IF EXISTS ignore_failed_status');
        const result = await finish(running);
        expect(result._unsafeUnwrapErr()).toBe(classified.mock.calls[0][0]);
        expect(runs.findById(run.id)._unsafeUnwrap()?.status).toBe('failed');
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(tokens).toHaveBeenCalledTimes(1);
        expect(sessions).toHaveBeenCalledTimes(1);
      } finally {
        db.exec(
          'DROP TRIGGER IF EXISTS reject_failed_status; DROP TRIGGER IF EXISTS ignore_failed_status',
        );
        await finish(running);
        classified.mockRestore();
      }
    },
  );

  it.each([
    ['sdk', 'exact'],
    ['cli', 'exact'],
    ['sdk', 'oversize'],
    ['cli', 'oversize'],
    ['sdk', 'ordinary'],
    ['cli', 'ordinary'],
  ] as const)(
    'preserves %s provider original bytes at the %s final-body boundary',
    async (strategyType, boundary) => {
      const body = boundary === 'oversize' ? 'a'.repeat(1_048_575) + '\n\n' : '**original** 😀\n\n';
      const providerResult = {
        output: body,
        sessionId: 'original-session',
        usage: { inputTokens: 123, outputTokens: 45 },
        isError: false,
      };
      let calls = 0;
      const provider: AgentProvider = {
        name: 'exact-body',
        skillLoaderTransport: 'stdio',
        createExecutionStrategy: () =>
          strategyType === 'cli'
            ? {
                type: 'cli',
                supportsSessionResumption: false,
                run: async () => {
                  calls++;
                  return providerResult;
                },
              }
            : {
                type: 'sdk',
                supportsSessionResumption: false,
                run: async function* () {
                  calls++;
                  yield { type: 'text', content: body };
                  yield { type: 'result', result: providerResult };
                },
              },
        prepareBackgroundInvocation: () => {
          throw new Error('Not a background test');
        },
        parseBackgroundResult: (raw) => ({
          output: raw.stdout,
          stderr: raw.stderr,
          exitCode: raw.exitCode,
          timedOut: raw.timedOut,
        }),
        estimateContextUsage: () => ({ inputTokens: 123, metrics: {} }),
      };
      const ordinaryBodies: string[] = [];
      if (boundary === 'ordinary') {
        ctx.channelRegistry.register({
          name: 'ordinary',
          type: 'telegram',
          start: async () => undefined,
          stop: async () => undefined,
          onMessage: () => undefined,
          format: (text) => text,
          send: async (_destination, output) => {
            ordinaryBodies.push(output.body);
            return ok(undefined);
          },
        });
        ctx.repos.channel
          .insert({
            id: 'ordinary',
            name: 'ordinary',
            type: 'telegram',
            config: '{}',
            credentials_ref: null,
            enabled: 1,
          })
          ._unsafeUnwrap();
        ctx.repos.thread
          .insert({ id: 'ordinary', channel_id: 'ordinary', external_id: 'chat', metadata: '{}' })
          ._unsafeUnwrap();
      }
      if (boundary === 'oversize')
        answerSend = (request, socket) =>
          reply(socket, request, {
            timestamp: 900,
            results: [
              {
                type: 'IDENTITY_FAILURE',
                recipientAddress: { uuid: account, number: null, username: null },
              },
            ],
          });
      const item =
        boundary === 'ordinary'
          ? rowToQueueItem(
              queue
                .enqueue({
                  id: 'queue',
                  thread_id: 'ordinary',
                  message_id: null,
                  type: 'message',
                  max_attempts: 3,
                  payload: JSON.stringify({ personaId: 'persona', content: 'command' }),
                })
                ._unsafeUnwrap(),
            )
          : enqueue();
      const context = {
        ...ctx,
        providerRegistry: new ProviderRegistry(
          {
            'exact-body': AgentRunnerProviderConfigSchema.parse({
              enabled: true,
              command: 'unused',
              contextWindowTokens: 1024,
              contextManagement: { enabled: false },
            }),
          },
          { 'exact-body': () => provider },
        ),
      };
      const chunks = vi.spyOn(connector, 'sendPreparedChunk');
      const result = await finish(new AgentRunner(context).run(item));
      expect(calls).toBe(1);
      expect(mockQuery).not.toHaveBeenCalled();
      if (boundary === 'oversize') {
        expect(chunks).not.toHaveBeenCalled();
        expect(Buffer.byteLength(body, 'utf8')).toBe(1_048_577);
        expect(sentBodies).toEqual([]);
        expect(result._unsafeUnwrapErr()).toMatchObject({
          reason: 'OUTPUT_TOO_LARGE',
          outcome: 'NOT_SENT',
          currentChunkAcceptance: 'unwritten',
          acceptedChunks: 0,
        });
        expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap().kind).toBe(
          'ordinary',
        );
        expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toEqual([]);
        expect(runs.findByThread('thread')._unsafeUnwrap()[0]).toMatchObject({
          status: 'failed',
          session_id: 'original-session',
          input_tokens: 123,
          output_tokens: 45,
        });
      } else if (boundary === 'exact') {
        expect(result.isOk()).toBe(true);
        expect(saved().body).toBe('**original** 😀\n\n');
        expect(sendStates[0]?.body).toBe('**original** 😀\n\n');
        expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toMatchObject([
          { content: JSON.stringify({ body: '**original** 😀\n\n' }) },
        ]);
        // The accepted formatter still strips Markdown/outer whitespace for network chunks.
        expect(sentBodies).toEqual(['original 😀']);
      } else {
        expect(result.isOk()).toBe(true);
        expect(ordinaryBodies).toContain('**original** 😀\n\n');
        expect(messages.findByThread('ordinary', 10, 0)._unsafeUnwrap()).toMatchObject([
          { content: JSON.stringify({ body: '**original** 😀' }) },
        ]);
        expect(sentBodies).toEqual([]);
      }
    },
  );

  function reviewfixSdkContext(run: SDKExecutionStrategy['run']): DaemonContext {
    const provider: AgentProvider = {
      name: 'sync-startup',
      skillLoaderTransport: 'stdio',
      createExecutionStrategy: () => ({ type: 'sdk', supportsSessionResumption: true, run }),
      prepareBackgroundInvocation: () => {
        throw new Error('Not a background test');
      },
      parseBackgroundResult: (raw) => ({
        output: raw.stdout,
        stderr: raw.stderr,
        exitCode: raw.exitCode,
        timedOut: raw.timedOut,
      }),
      estimateContextUsage: () => ({ inputTokens: 0, metrics: {} }),
    };
    return {
      ...ctx,
      providerRegistry: new ProviderRegistry(
        {
          'sync-startup': AgentRunnerProviderConfigSchema.parse({
            enabled: true,
            command: 'unused',
            contextWindowTokens: 1024,
            contextManagement: { enabled: false },
          }),
        },
        { 'sync-startup': () => provider },
      ),
    };
  }

  function enqueueReviewfixOrdinary(): QueueItem {
    ctx.channelRegistry.register({
      name: 'ordinary',
      type: 'telegram',
      start: async () => undefined,
      stop: async () => undefined,
      onMessage: () => undefined,
      format: (text) => text,
      send: async () => ok(undefined),
    });
    ctx.repos.channel
      .insert({
        id: 'ordinary',
        name: 'ordinary',
        type: 'telegram',
        config: '{}',
        credentials_ref: null,
        enabled: 1,
      })
      ._unsafeUnwrap();
    ctx.repos.thread
      .insert({ id: 'ordinary', channel_id: 'ordinary', external_id: 'chat', metadata: '{}' })
      ._unsafeUnwrap();
    return rowToQueueItem(
      queue
        .enqueue({
          id: 'queue',
          thread_id: 'ordinary',
          type: 'message',
          message_id: null,
          max_attempts: 3,
          payload: JSON.stringify({ personaId: 'persona', content: 'command' }),
        })
        ._unsafeUnwrap(),
    );
  }

  it.each(['nonretryable', 'deferred', 'delivery', 'cancelled', 'checkpoint', 'database'] as const)(
    'preserves the original %s Error from synchronous public SDK strategy startup',
    async (kind) => {
      const delivery = new SignalDeliveryError({
        reason: 'TIMEOUT',
        outcome: 'NOT_SENT',
        acceptedChunks: 0,
        currentChunkAcceptance: 'unwritten',
        successCount: 0,
        failureCount: 0,
        retryScope: 'delivery_only',
      });
      const failure =
        kind === 'nonretryable'
          ? new NonRetryableRunError(delivery)
          : kind === 'deferred'
            ? new DeliveryDeferredError(delivery, Date.now() + 60_000)
            : kind === 'delivery'
              ? delivery
              : kind === 'cancelled'
                ? new DeliveryCancelled()
                : kind === 'checkpoint'
                  ? new SignalCheckpointError('INVALID')
                  : new DbError('local failure');
      const item = enqueueReviewfixOrdinary();
      let calls = 0;
      const context = reviewfixSdkContext(() => {
        calls++;
        throw failure;
      });
      vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue('original-resume');
      const classified = vi.spyOn(SignalInvocationGuard.prototype, 'classifyFailure');
      let result: Result<void, Error> | undefined;
      const processor = new QueueProcessor(
        queue,
        calculateBackoff,
        new DeadLetterHandler(queue, logger),
        logger,
      );
      try {
        await finish(
          processor.processNext(async (claimed) => {
            expect(claimed.id).toBe(item.id);
            result = await new AgentRunner(context).run(claimed);
            return result;
          }),
        );
        expect(result?._unsafeUnwrapErr()).toBe(failure);
        expect(classified.mock.calls[0][0]).toBe(failure);
        expect(calls).toBe(1);
        expect(mockQuery).not.toHaveBeenCalled();
        expect(ctx.sessionTracker.rotateSession).not.toHaveBeenCalled();
        expect(sentBodies).toEqual([]);
        expect(messages.findByThread('ordinary', 10, 0)._unsafeUnwrap()).toEqual([]);
        expect(queue.findById('queue')._unsafeUnwrap()).toMatchObject({
          status:
            kind === 'database'
              ? 'failed'
              : kind === 'cancelled' || kind === 'checkpoint'
                ? 'claimed'
                : 'dead_letter',
          attempts: kind === 'database' ? 1 : 0,
        });
        // A bare DB failure on an ordinary row retains the existing ordinary retry policy.
        expect(runs.findByThread('ordinary')._unsafeUnwrap()).toHaveLength(1);
      } finally {
        classified.mockRestore();
      }
    },
  );

  it.each(['resumed startup', 'fresh startup', 'after event', 'external cause'] as const)(
    'retains ordinary SDK attempt metadata and retry policy for %s',
    async (boundary) => {
      const item = enqueueReviewfixOrdinary();
      const resumed = boundary !== 'fresh startup' && boundary !== 'external cause';
      if (resumed) vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue('stale-session');
      const inputs: Array<string | undefined> = [];
      const typed = new NonRetryableRunError();
      const failure =
        boundary === 'external cause'
          ? new Error('ordinary wrapper', { cause: typed })
          : new Error('Session not found');
      const context = reviewfixSdkContext((input) => {
        inputs.push(input.sessionId);
        if (boundary === 'after event')
          return (async function* () {
            yield { type: 'text' as const, content: 'partial ordinary' };
            throw failure;
          })();
        if (inputs.length === 1) throw failure;
        return (async function* () {
          yield {
            type: 'result' as const,
            result: {
              output: 'fresh original',
              usage: { inputTokens: 1, outputTokens: 1 },
              isError: false,
            },
          };
        })();
      });
      const result = await finish(new AgentRunner(context).run(item));
      if (boundary === 'resumed startup') {
        expect(result.isOk()).toBe(true);
        expect(inputs).toEqual(['stale-session', undefined]);
        expect(ctx.sessionTracker.rotateSession).toHaveBeenCalledTimes(1);
      } else {
        expect(result._unsafeUnwrapErr().name).toBe('AgentQueryAttemptError');
        expect(inputs).toEqual([resumed ? 'stale-session' : undefined]);
        expect(ctx.sessionTracker.rotateSession).not.toHaveBeenCalled();
        if (boundary === 'external cause') expect(result._unsafeUnwrapErr().cause).toBe(failure);
      }
      expect(runs.findByThread('ordinary')._unsafeUnwrap()).toHaveLength(1);
      expect(sentBodies).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['deleted', false],
    ['cancelled', false],
    ['deleted', true],
    ['cancelled', true],
  ] as const)(
    'releases postwrite %s only after its actual Result transaction commits (commit fault %s)',
    async (decision, failCommit) => {
      db.exec(`CREATE TEMP TRIGGER settle_failed_run AFTER UPDATE OF status ON runs
        WHEN NEW.status = 'failed' BEGIN ${
          decision === 'deleted'
            ? 'DELETE FROM runs WHERE id = NEW.id;'
            : "UPDATE runs SET status = 'cancelled', error = 'committed cancellation' WHERE id = NEW.id;"
        }
        END`);
      const writes = vi.spyOn(runs, 'updateStatus');
      const tokens = vi.spyOn(runs, 'updateTokens');
      const sessions = vi.spyOn(runs, 'updateSessionId');
      let released = false;
      ctx.hostToolsBridge.unregisterRunAuthentication = () => {
        released = true;
      };
      if (failCommit) {
        const transaction = runs.transaction.bind(runs);
        vi.spyOn(runs, 'transaction').mockImplementationOnce((callback) =>
          transaction(() => {
            callback();
            throw new Error('synthetic transaction failure after domain decision');
          }),
        );
      }
      async function* stream() {
        ctx.repos.channel.update('channel', { config: '{broken' })._unsafeUnwrap();
        yield {
          type: 'result',
          subtype: 'success',
          result: 'original final',
          session_id: 'original-session',
          usage: { input_tokens: 123, output_tokens: 45 },
          is_error: false,
        };
      }
      mockQuery.mockReturnValue(stream());
      const running = new AgentRunner(ctx).run(enqueue());
      try {
        await untilSignal(() => writes.mock.calls.length > 0);
        const first = writes.mock.results[0]?.value;
        expect(first?.isOk()).toBe(true);
        if (decision === 'deleted') expect(first?._unsafeUnwrap()).toBeNull();
        else expect(first?._unsafeUnwrap()).toMatchObject({ status: 'cancelled' });
        if (failCommit) {
          expect(released).toBe(false);
          expect(runs.findByThread('thread')._unsafeUnwrap()[0]?.status).toBe('running');
        }
        const result = await finish(running);
        expect(result._unsafeUnwrapErr()).toBeInstanceOf(DeliveryCancelled);
        expect(released).toBe(true);
        expect(queue.findById('queue')._unsafeUnwrap()).not.toBeNull();
        if (decision === 'deleted') expect(runs.findByThread('thread')._unsafeUnwrap()).toEqual([]);
        else
          expect(runs.findByThread('thread')._unsafeUnwrap()[0]).toMatchObject({
            status: 'cancelled',
            error: 'committed cancellation',
            input_tokens: 123,
            output_tokens: 45,
            session_id: 'original-session',
          });
        expect(writes).toHaveBeenCalledTimes(failCommit ? 2 : 1);
        expect(tokens).toHaveBeenCalledTimes(1);
        expect(sessions).toHaveBeenCalledTimes(1);
        expect(sentBodies).toEqual([]);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toEqual([]);
      } finally {
        db.exec('DROP TRIGGER settle_failed_run');
        await finish(running);
      }
    },
  );

  it('retains actual repository read failures before granting an injected provider turn', async () => {
    const closedDb = createTestDb();
    const closedThreads = new ThreadRepository(closedDb);
    closedDb.close();
    const failure = closedThreads.findById('thread');
    expect(failure.isErr()).toBe(true);
    ctx.repos.channel
      .insert({
        id: 'ordinary-read',
        name: 'ordinary-read',
        type: 'telegram',
        config: '{}',
        credentials_ref: null,
        enabled: 1,
      })
      ._unsafeUnwrap();
    ctx.repos.thread
      .insert({
        id: 'ordinary-read',
        channel_id: 'ordinary-read',
        external_id: 'chat',
        metadata: '{}',
      })
      ._unsafeUnwrap();
    ctx.channelRegistry.register({
      name: 'ordinary-read',
      type: 'telegram',
      start: async () => undefined,
      stop: async () => undefined,
      onMessage: () => undefined,
      format: (body) => body,
      send: async () => ok(undefined),
    });
    const item = rowToQueueItem(
      queue
        .enqueue({
          id: 'queue',
          thread_id: 'ordinary-read',
          type: 'message',
          message_id: null,
          max_attempts: 3,
          payload: JSON.stringify({ personaId: 'persona', content: 'command' }),
        })
        ._unsafeUnwrap(),
    );
    vi.spyOn(ctx.repos.thread, 'findById').mockReturnValueOnce(failure);
    const running = new AgentRunner(ctx).run(item);
    for (let i = 0; i < 100; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockQuery).not.toHaveBeenCalled();
    expect(sentBodies).toEqual([]);
    expect((await finish(running)).isOk()).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
  it('releases a Signal-origin read retry to the actual socket only after repository repair', async () => {
    const closedDb = createTestDb();
    const closedThreads = new ThreadRepository(closedDb);
    closedDb.close();
    const actualFailure = closedThreads.findById('thread');
    vi.spyOn(ctx.repos.thread, 'findById').mockReturnValueOnce(actualFailure);
    const running = new AgentRunner(ctx).run(enqueue());
    for (let i = 0; i < 100; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockQuery).not.toHaveBeenCalled();
    expect(sentBodies).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    await untilSignal(() => mockQuery.mock.calls.length === 1);
    await untilSignal(() => sentBodies.length === 1);
    expect((await finish(running)).isOk()).toBe(true);
    expect(sentBodies).toEqual(['Hello from the agent!']);
  });

  it('terminalizes fixed background content with malformed local Signal configuration without any provider turn', async () => {
    enqueue(
      'queue',
      {
        personaId: 'persona',
        kind: 'background_task_notification',
        taskId: 'task-original',
        status: 'completed',
        content: 'fixed original notification',
      },
      'collaboration',
    );
    ctx.repos.channel.update('channel', { config: '{broken' })._unsafeUnwrap();
    const processor = new QueueProcessor(
      queue,
      calculateBackoff,
      new DeadLetterHandler(queue, logger),
      logger,
    );
    const runner = new AgentRunner(ctx);
    await finish(processor.processNext((item) => runner.run(item)));
    expect(queue.findById('queue')._unsafeUnwrap()).toMatchObject({
      status: 'dead_letter',
      attempts: 0,
    });
    expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap().kind).toBe('ordinary');
    for (let i = 0; i < 4; i++)
      expect(await finish(processor.processNext((item) => runner.run(item)))).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(sentBodies).toEqual([]);
    expect(runs.findByThread('thread')._unsafeUnwrap()).toEqual([]);
    expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toEqual([]);
  });

  it('runs the existing live rotation decision only after the real Signal history/run/queue commit', async () => {
    const observed: Array<{
      history: number;
      status: string | undefined;
      queue: string | undefined;
    }> = [];
    const roller = new ContextRoller({
      messageRepo: messages,
      memoryRepo: new MemoryRepository(db),
      sessionTracker: ctx.sessionTracker,
      logger,
      summarizerRun: async () => {
        observed.push({
          history: messages.findByThread('thread', 10, 0)._unsafeUnwrap().length,
          status: runs.findByThread('thread')._unsafeUnwrap()[0]?.status,
          queue: queue.findById('queue')._unsafeUnwrap()?.status,
        });
        return err(new SubAgentError('Synthetic summarizer boundary'));
      },
    });
    mockQuery.mockReturnValue(
      makeAgentStream({
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80_000 },
      }),
    );
    const context = { ...ctx, contextRoller: roller };
    const item = enqueue();
    expect((await finish(new AgentRunner(context).run(item))).isOk()).toBe(true);
    expect(observed).toEqual([{ history: 1, status: 'completed', queue: 'completed' }]);
    expect((await finish(new AgentRunner(context).run(item))).isOk()).toBe(true);
    expect(observed).toHaveLength(1);
    expect(sentBodies).toHaveLength(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
  it('resumes a deferred original foreground reply on the current replacement connector without reconstructed rotation', async () => {
    let summaries = 0;
    const roller = new ContextRoller({
      messageRepo: messages,
      memoryRepo: new MemoryRepository(db),
      sessionTracker: ctx.sessionTracker,
      logger,
      summarizerRun: async () => {
        summaries++;
        return err(new SubAgentError('Synthetic summarizer boundary'));
      },
    });
    const context = { ...ctx, contextRoller: roller };
    expect((await finish(connector.stopWithResult())).isOk()).toBe(true);
    mockQuery.mockReturnValue(
      makeAgentStream({
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80_000 },
      }),
    );
    const item = enqueue();
    expect((await finish(new AgentRunner(context).run(item)))._unsafeUnwrapErr()).toBeInstanceOf(
      DeliveryDeferredError,
    );
    const original = runs.findByThread('thread')._unsafeUnwrap()[0];
    const checkpoint = saved();
    expect(checkpoint.phase).toBe('ready');
    const observations = vi.mocked(ctx.observability.observe).mock.calls.length;
    const sessionReads = vi.mocked(ctx.sessionTracker.getSessionId).mock.calls.length;
    const stored = ctx.repos.channel.findById('channel')._unsafeUnwrap();
    if (stored === null) throw new Error('Expected actual channel');
    const config = SignalConfigSchema.parse(JSON.parse(stored.config));
    // Old actual stop Result is Ok above; this fixture has no other actor/tool owner.
    ctx.channelRegistry.unregister('signal-test');
    connector = new SignalConnector(config, 'signal-test', logger, {
      queue,
      accounts: new SignalAccountStateRepository(db),
      leases: new SignalDestinationLeaseRepository(db),
      registry: SignalDeviceRegistry.create(2, [config])._unsafeUnwrap(),
      random: () => 0.5,
      monotonicNow: () => performance.now(),
    });
    connector.onMessageWithReceipt(() => ok('accepted'));
    ctx.channelRegistry.register(connector);
    await finish(connector.start());
    await finish(
      (async () => {
        while (connector.status().state !== 'ready')
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
      })(),
    );
    expect((await finish(new AgentRunner(context).run(item))).isOk()).toBe(true);
    expect(runs.findByThread('thread')._unsafeUnwrap()).toHaveLength(1);
    expect(runs.findById(original.id)._unsafeUnwrap()).toMatchObject({
      status: 'completed',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 80_000,
      session_id: 'session-abc-123',
    });
    expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toMatchObject([
      {
        idempotency_key: `outbound:${original.id}`,
        content: JSON.stringify({ body: checkpoint.body }),
      },
    ]);
    expect(sentBodies).toEqual(['Hello from the agent!']);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(ctx.sessionTracker.setSessionId).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ctx.sessionTracker.getSessionId).mock.calls).toHaveLength(sessionReads);
    expect(vi.mocked(ctx.observability.observe).mock.calls).toHaveLength(observations);
    expect(summaries).toBe(0);
  });
  it('keeps the next same-thread provider behind an unfinished live Signal rotation', async () => {
    const sessionTracker = new SessionTracker();
    let completeSummary: ((value: Result<SubAgentResult, SubAgentError>) => void) | undefined;
    const roller = new ContextRoller({ messageRepo: messages, memoryRepo: new MemoryRepository(db),
      sessionTracker, logger, summarizerRun: () => new Promise((resolve) => { completeSummary = resolve; }) });
    const manager = new QueueManager(queue, ctx.repos.thread, { maxAttempts: 3,
      backoffBaseMs: 1000, backoffMaxMs: 60_000, concurrencyLimit: 2 }, logger);
    const context = { ...ctx, sessionTracker, contextRoller: roller, queueManager: manager };
    const runner = new AgentRunner(context);
    mockQuery.mockReturnValueOnce(makeAgentStream({ session_id: 'first-session', usage: {
      input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80_000,
    } })).mockReturnValueOnce(makeAgentStream({ session_id: 'second-session', usage: {
      input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0,
    } }));
    enqueue('queue', { personaId: 'persona', content: 'first command' });
    enqueue('queue-second', { personaId: 'persona', content: 'second command' });
    manager.startProcessing((item) => runner.run(item), (item) => runner.run(item));
    try {
      // QueueManager's actual500ms interval is deliberately NOT faked by this existing socket fixture.
      await waitForRealTime(550);
      await untilSignal(() => completeSummary !== undefined);
      // First actor has committed its saved delivery; the real live roller still owns an unfinished snapshot.
      const firstStatusWhilePending = queue.findById('queue')._unsafeUnwrap()?.status;
      await waitForRealTime(550);
      await vi.advanceTimersByTimeAsync(1500);
      for (let i = 0; i < 2000 && queue.findById('queue-second')._unsafeUnwrap()?.status !== 'completed'; i++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      const providerTurnsWhilePending = mockQuery.mock.calls.length;
      const secondStatusWhilePending = queue.findById('queue-second')._unsafeUnwrap()?.status;
      const sessionBeforeOldRotation = sessionTracker.getSessionId('thread', 'claude-code', 'fixture');
      const drain = manager.quiesceAndDrainClaims();
      completeSummary?.(ok({ summary: 'Summary based on the first reply snapshot only' }));
      await finish(drain);
      const sessionAfterOldRotation = sessionTracker.getSessionId('thread', 'claude-code', 'fixture');
      expect({ firstStatusWhilePending, providerTurnsWhilePending, secondStatusWhilePending,
        newerSessionClobbered: sessionBeforeOldRotation === 'second-session' && sessionAfterOldRotation === undefined,
      }).toEqual({ firstStatusWhilePending: 'completed', providerTurnsWhilePending: 1,
        secondStatusWhilePending: 'pending', newerSessionClobbered: false });
    } finally {
      manager.stopProcessing();
      completeSummary?.(ok({ summary: 'Complete only this disposable pending fixture callback' }));
      await finish(manager.quiesceAndDrainClaims());
    }
  });

  // R2-B: these cases catch completed-result replay at the pre-format resolver boundary.
  it.each([
    ['thread', 'recover'],
    ['channel', 'recover'],
    ['thread', 'purge'],
    ['channel', 'purge'],
    ['thread', 'cancel'],
    ['channel', 'cancel'],
  ] as const)(
    'retains a completed result across repeated actual %s resolver errors until %s without provider or tool replay',
    async (repository, settlement) => {
      const closed = createTestDb();
      const unavailableThreads = new ThreadRepository(closed);
      const unavailableChannels = new ChannelRepository(closed);
      closed.close();
      const threadFailure = unavailableThreads.findById('thread');
      const channelFailure = unavailableChannels.findById('channel');
      expect(threadFailure.isErr() && channelFailure.isErr()).toBe(true);
      let armed = false;
      let repaired = false;
      let failedReads = 0;
      let providerCalls = 0;
      let toolCalls = 0;
      let issued: SignalInvocationGuard | undefined;
      const preparationContexts: Array<Parameters<SignalInvocationGuard['context']>> = [];
      const threadRead = ctx.repos.thread.findById.bind(ctx.repos.thread);
      const channelRead = ctx.repos.channel.findById.bind(ctx.repos.channel);
      const readThreads = vi.spyOn(ctx.repos.thread, 'findById').mockImplementation((id) => {
        if (armed && !repaired && repository === 'thread') {
          failedReads++;
          return threadFailure;
        }
        return threadRead(id);
      });
      const readChannels = vi.spyOn(ctx.repos.channel, 'findById').mockImplementation((id) => {
        if (armed && !repaired && repository === 'channel') {
          failedReads++;
          return channelFailure;
        }
        return channelRead(id);
      });
      const prepare = vi.spyOn(connector, 'prepare');
      const save = vi.spyOn(queue, 'saveSignalCheckpoint');
      const tokens = vi.spyOn(runs, 'updateTokens');
      const sessions = vi.spyOn(runs, 'updateSessionId');
      const unregister = vi.fn();
      ctx.hostToolsBridge.unregisterRunAuthentication = unregister;
      const body = '**one retained result** 😀\n\n';
      const context = reviewfixSdkContext(() =>
        (async function* () {
          providerCalls++;
          const run = runs.findByThread('thread')._unsafeUnwrap()[0];
          issued = executions
            .resolve({ runId: run.id, threadId: 'thread', personaId: 'persona' })
            ._unsafeUnwrap();
          const issueContext = issued.context.bind(issued);
          vi.spyOn(issued, 'context').mockImplementation((...args) => {
            if (args[1] === 'reply') preparationContexts.push(args);
            return issueContext(...args);
          });
          // A synthetic provider tool performs a real durable side effect, which must never repeat.
          toolCalls++;
          ctx.repos.audit
            .insert({
              id: 'original-tool',
              run_id: run.id,
              thread_id: 'thread',
              persona_id: 'persona',
              action: 'fixture.non_signal_tool',
              tool: null,
              request_id: null,
              details: '{}',
            })
            ._unsafeUnwrap();
          armed = true;
          yield {
            type: 'result' as const,
            result: {
              output: body,
              sessionId: 'retained-original-session',
              usage: { inputTokens: 123, outputTokens: 45 },
              isError: false,
            },
          };
        })(),
      );
      enqueue();
      const processor = new QueueProcessor(
        queue,
        calculateBackoff,
        new DeadLetterHandler(queue, logger),
        logger,
      );
      let done = false;
      let result: Result<void, Error> | undefined;
      const running = processor
        .processNext(async (item) => {
          result = await new AgentRunner(context).run(item);
          return result;
        })
        .then((value) => {
          done = true;
          return value;
        });
      try {
        await untilSignal(() => failedReads > 0);
        expect(done).toBe(false);
        expect(prepare).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
        expect(tokens).not.toHaveBeenCalled();
        expect(sessions).not.toHaveBeenCalled();
        expect(sentBodies).toEqual([]);
        expect(unregister).not.toHaveBeenCalled();
        expect(issued?.context('retained', 'explicit').isOk()).toBe(true);
        const original = runs.findByThread('thread')._unsafeUnwrap()[0];
        expect(original).toMatchObject({ status: 'running', input_tokens: 0, session_id: null });
        expect(queue.findById('queue')._unsafeUnwrap()).toMatchObject({
          status: 'claimed',
          attempts: 0,
        });
        await vi.advanceTimersByTimeAsync(750);
        expect(failedReads).toBeGreaterThan(1);
        expect(preparationContexts.length).toBeGreaterThan(1);
        expect(new Set(preparationContexts.map(([id]) => id)).size).toBe(1);
        expect(done).toBe(false);
        expect(prepare).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
        expect(providerCalls).toBe(1);
        expect(toolCalls).toBe(1);
        if (settlement === 'purge') expect(queue.purge(['claimed'])._unsafeUnwrap()).toBe(1);
        if (settlement === 'cancel')
          runs
            .updateStatus(original.id, 'cancelled', {
              ended_at: Date.now(),
              error: 'operator cancellation during resolver repair',
            })
            ._unsafeUnwrap();
        const repairedAt = Date.now();
        repaired = true;
        await finish(running);
        expect(providerCalls).toBe(1);
        expect(toolCalls).toBe(1);
        expect(mockQuery).not.toHaveBeenCalled();
        expect(ctx.repos.audit.findByThread('thread')._unsafeUnwrap()).toHaveLength(1);
        expect(ctx.sessionTracker.setSessionId).toHaveBeenCalledTimes(1);
        expect(unregister).toHaveBeenCalledTimes(1);
        expect(issued?.context('released', 'explicit').isErr()).toBe(true);
        expect(runs.findByThread('thread')._unsafeUnwrap()).toHaveLength(1);
        if (settlement === 'recover') {
          expect(result?.isOk()).toBe(true);
          expect(prepare).toHaveBeenCalledTimes(1);
          expect(save).toHaveBeenCalledTimes(1);
          expect(tokens).toHaveBeenCalledTimes(1);
          expect(sessions).toHaveBeenCalledTimes(1);
          expect(saved()).toMatchObject({ body, runId: original.id, phase: 'delivered' });
          expect(saved().createdAt).toBeGreaterThanOrEqual(repairedAt);
          expect(saved().expiresAt - saved().createdAt).toBe(86_400_000);
          expect(saved().deliveryId).toBe(preparationContexts[0][0]);
          expect(sendStates[0]?.deliveryId).toBe(saved().deliveryId);
          expect(sendStates[0]?.body).toBe(body);
          expect(sentBodies).toEqual(['one retained result 😀']);
          expect(runs.findById(original.id)._unsafeUnwrap()).toMatchObject({
            status: 'completed',
            input_tokens: 123,
            output_tokens: 45,
            session_id: 'retained-original-session',
          });
          expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toMatchObject([
            {
              content: JSON.stringify({ body }),
              run_id: original.id,
              idempotency_key: `outbound:${original.id}`,
            },
          ]);
          expect(queue.findById('queue')._unsafeUnwrap()).toMatchObject({
            status: 'completed',
            attempts: 0,
          });
          expect(
            await finish(processor.processNext((item) => new AgentRunner(context).run(item))),
          ).toBeNull();
        } else {
          expect(result?._unsafeUnwrapErr()).toBeInstanceOf(DeliveryCancelled);
          expect(sentBodies).toEqual([]);
          expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toEqual([]);
          if (settlement === 'purge') {
            expect(queue.findById('queue')._unsafeUnwrap()).toBeNull();
            // Existing unsaved purge detaches an ordinary run; it is not a broad cancellation repair.
            expect(runs.findById(original.id)._unsafeUnwrap()).toMatchObject({
              status: 'running',
              queue_item_id: null,
            });
          } else expect(runs.findById(original.id)._unsafeUnwrap()?.status).toBe('cancelled');
        }
      } finally {
        repaired = true;
        await finish(running);
        readThreads.mockRestore();
        readChannels.mockRestore();
      }
    },
  );

  it.each(['thread', 'channel'] as const)(
    'returns the original initial %s repository Err without runtime before session/run/provider even if reads recover',
    async (repository) => {
      const closed = createTestDb();
      const unavailableThreads = new ThreadRepository(closed);
      const unavailableChannels = new ChannelRepository(closed);
      closed.close();
      const threadFailure = unavailableThreads.findById('thread');
      const channelFailure = unavailableChannels.findById('channel');
      const failure = repository === 'thread' ? threadFailure : channelFailure;
      expect(failure.isErr()).toBe(true);
      if (repository === 'thread')
        vi.spyOn(ctx.repos.thread, 'findById').mockReturnValueOnce(threadFailure);
      else vi.spyOn(ctx.repos.channel, 'findById').mockReturnValueOnce(channelFailure);
      const { signalRuntime: _signalRuntime, ...legacy } = ctx;
      const result = await finish(new AgentRunner(legacy).run(enqueue()));
      expect(result._unsafeUnwrapErr()).toBe(failure._unsafeUnwrapErr());
      expect(ctx.repos.thread.findById('thread')._unsafeUnwrap()).not.toBeNull();
      expect(ctx.repos.channel.findById('channel')._unsafeUnwrap()?.type).toBe('signal');
      expect(mockQuery).not.toHaveBeenCalled();
      expect(ctx.sessionTracker.getSessionId).not.toHaveBeenCalled();
      expect(runs.findByThread('thread')._unsafeUnwrap()).toEqual([]);
      expect(sentBodies).toEqual([]);
    },
  );

  it('preserves a healthy actual ordinary origin without optional Signal composition', async () => {
    const item = enqueueReviewfixOrdinary();
    const { signalRuntime: _signalRuntime, ...legacy } = ctx;
    const result = await finish(new AgentRunner(legacy).run(item));
    expect(result.isOk()).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(ctx.sessionTracker.getSessionId).toHaveBeenCalledTimes(1);
    expect(runs.findByThread('ordinary')._unsafeUnwrap()).toMatchObject([{ status: 'completed' }]);
    expect(messages.findByThread('ordinary', 10, 0)._unsafeUnwrap()).toHaveLength(1);
    expect(sentBodies).toEqual([]);
  });

  it('rejects actual persisted thread-destination mutation independently of the existing channel-rename control', async () => {
    expect((await finish(connector.stopWithResult())).isOk()).toBe(true);
    const item = enqueue();
    expect((await finish(new AgentRunner(ctx).run(item)))._unsafeUnwrapErr()).toBeInstanceOf(
      DeliveryDeferredError,
    );
    const original = saved();
    const before = ctx.repos.thread.findById('thread')._unsafeUnwrap();
    const destination = `signal:v1:${account}:group:QQ`;
    // Explicitly approved adversarial fixture SQL; ThreadRepository supports metadata updates ONLY.
    expect(
      db.prepare('UPDATE threads SET external_id = ? WHERE id = ?').run(destination, 'thread')
        .changes,
    ).toBe(1);
    expect(ctx.repos.thread.findById('thread')._unsafeUnwrap()).toEqual({
      ...before,
      external_id: destination,
    });
    const sends = vi.spyOn(connector, 'sendPreparedChunk');
    const prepare = vi.spyOn(connector, 'prepare');
    const result = await finish(new AgentRunner(ctx).run(item));
    expect(result.isErr()).toBe(true);
    expect(sends).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(sentBodies).toEqual([]);
    expect(saved()).toEqual(original);
    expect(queue.findById('queue')._unsafeUnwrap()?.thread_id).toBe('thread');
    expect(runs.findById(original.runId ?? '')._unsafeUnwrap()).toMatchObject({
      thread_id: 'thread',
      queue_item_id: 'queue',
      status: 'running',
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toEqual([]);
  });

  it('retains the original fixed background notification through resolver-only repair with no run or provider', async () => {
    const closed = createTestDb();
    const unavailable = new ChannelRepository(closed);
    closed.close();
    const failure = unavailable.findById('channel');
    let armed = false;
    let repaired = false;
    let failedReads = 0;
    const ids: string[] = [];
    const read = ctx.repos.channel.findById.bind(ctx.repos.channel);
    vi.spyOn(ctx.repos.channel, 'findById').mockImplementation((id) => {
      if (armed && !repaired) {
        failedReads++;
        return failure;
      }
      return read(id);
    });
    const issue = SignalInvocationGuard.prototype.context;
    const contexts = vi
      .spyOn(SignalInvocationGuard.prototype, 'context')
      .mockImplementation(function (this: SignalInvocationGuard, id, purpose) {
        const result = issue.call(this, id, purpose);
        if (purpose === 'background') {
          ids.push(id);
          armed = true;
        }
        return result;
      });
    const prepare = vi.spyOn(connector, 'prepare');
    const save = vi.spyOn(queue, 'saveSignalCheckpoint');
    const item = enqueue(
      'queue',
      {
        personaId: 'persona',
        kind: 'background_task_notification',
        taskId: 'fixed-original-task',
        status: 'timed_out',
        content: '**fixed original** 😀',
      },
      'collaboration',
    );
    let done = false;
    const running = new AgentRunner(ctx).run(item).then((result) => {
      done = true;
      return result;
    });
    try {
      await untilSignal(() => failedReads > 0);
      await vi.advanceTimersByTimeAsync(750);
      expect(failedReads).toBeGreaterThan(1);
      expect(done).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(sentBodies).toEqual([]);
      repaired = true;
      expect((await finish(running)).isOk()).toBe(true);
      expect(new Set(ids).size).toBe(1);
      expect(saved()).toMatchObject({
        body: '**fixed original** 😀',
        kind: 'background',
        deliveryId: ids[0],
      });
      expect(saved().runId).toBeUndefined();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledTimes(1);
      expect(sentBodies).toEqual(['fixed original 😀']);
      expect(messages.findByThread('thread', 10, 0)._unsafeUnwrap()).toMatchObject([
        {
          idempotency_key: 'background-task:fixed-original-task:timed_out',
          run_id: null,
          content: JSON.stringify({ body: '**fixed original** 😀' }),
        },
      ]);
      expect(runs.findByThread('thread')._unsafeUnwrap()).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(ctx.sessionTracker.getSessionId).not.toHaveBeenCalled();
      expect(ctx.sessionTracker.setSessionId).not.toHaveBeenCalled();
    } finally {
      repaired = true;
      await finish(running);
      contexts.mockRestore();
    }
  });

});
