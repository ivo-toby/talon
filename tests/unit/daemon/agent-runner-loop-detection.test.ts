import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from 'neverthrow';
import { GovernanceError } from '../../../src/governance/governance-service.js';

import { AgentRunner } from '../../../src/daemon/agent-runner.js';
import type { DaemonContext } from '../../../src/daemon/daemon-context.js';
import { QueueItemStatus, type QueueItem } from '../../../src/queue/queue-types.js';

function makeQueueItem(): QueueItem {
  return {
    id: 'qi-loop-001',
    threadId: 'thread-001',
    type: 'message',
    status: QueueItemStatus.Claimed,
    attempts: 0,
    maxAttempts: 3,
    payload: { personaId: 'persona-001', content: 'Keep working' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeObservationHandle(traceparent: string | null = null) {
  return {
    update: vi.fn(),
    getTraceparent: vi.fn().mockReturnValue(traceparent),
  };
}

function makeStartedObservationHandle(traceparent: string | null = null) {
  return {
    update: vi.fn(),
    getTraceparent: vi.fn().mockReturnValue(traceparent),
    end: vi.fn(),
  };
}

function makeMockContext(): DaemonContext {
  const logger = {
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
        defaultProvider: 'test-sdk',
      },
      langfuse: {},
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
      backgroundTask: {} as any,
      executionEnv: {} as any,
      executionEnvCheckpoint: {} as any,
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
      a2aTask: {} as any,
    },
    channelRegistry: {
      get: vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue(ok(undefined)),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      }),
      listAll: vi.fn().mockReturnValue([{ name: 'test-channel' }]),
    } as any,
    queueManager: {} as any,
    scheduler: {} as any,
    personaLoader: {
      getByName: vi.fn().mockReturnValue(ok({
        config: {
          model: 'claude-sonnet-4-20250514',
          provider: 'test-sdk',
          skills: [],
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
      clearAll: vi.fn(),
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
        const traceparent = input.type === 'generation' ? 'traceparent' : null;
        return await fn(makeObservationHandle(traceparent));
      }),
      start: vi.fn(() => makeStartedObservationHandle()),
      startWithTraceparent: vi.fn(() => makeStartedObservationHandle()),
      observeWithTraceparent: vi.fn(async (_traceparent, _input, fn) => await fn(makeObservationHandle())),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as any,
    hostToolsBridge: {
      path: '/tmp/test-data/host-tools.sock',
    } as any,
    providerRegistry: {} as any,
    subAgentRunner: null,
    backgroundAgentManager: null,
    executionEnvManager: null,
    contextRoller: null,
    contextAssembler: {
      assemble: vi.fn().mockReturnValue({
        text: '',
        summaryFound: false,
        recentMessageCount: 0,
        charCount: 0,
      }),
    } as any,
    logger: logger as any,
    a2aServer: null,
    a2aTaskMapper: null,
  };
}

describe('AgentRunner loop detection', () => {
  let ctx: DaemonContext;

  beforeEach(() => {
    ctx = makeMockContext();
  });

  it('cancels the run when governance blocks the third turn', async () => {
    let fourthTurnResultReached = false;
    const runStrategy = vi.fn(() => (async function* () {
      yield {
        type: 'tool_event' as const,
        messageType: 'tool_use',
        tool: 'Read',
        toolUseId: 'tool-1',
        input: { file: 'README.md' },
      };
      yield {
        type: 'tool_event' as const,
        messageType: 'tool_result',
        toolUseId: 'tool-1',
        output: 'ok-1',
        isError: false,
      };
      yield {
        type: 'tool_event' as const,
        messageType: 'tool_use',
        tool: 'Read',
        toolUseId: 'tool-2',
        input: { file: 'README.md' },
      };
      yield {
        type: 'tool_event' as const,
        messageType: 'tool_result',
        toolUseId: 'tool-2',
        output: 'ok-2',
        isError: false,
      };
      yield {
        type: 'tool_event' as const,
        messageType: 'tool_use',
        tool: 'Read',
        toolUseId: 'tool-3',
        input: { file: 'README.md' },
      };
      yield {
        type: 'tool_event' as const,
        messageType: 'tool_result',
        toolUseId: 'tool-3',
        output: 'ok-3',
        isError: false,
      };
      yield {
        type: 'tool_event' as const,
        messageType: 'tool_use',
        tool: 'Read',
        toolUseId: 'tool-4',
        input: { file: 'README.md' },
      };
      fourthTurnResultReached = true;
      yield {
        type: 'tool_event' as const,
        messageType: 'tool_result',
        toolUseId: 'tool-4',
        output: 'ok-4',
        isError: false,
      };
      yield {
        type: 'result' as const,
        result: {
          output: 'Finished',
          sessionId: 'session-abc',
          usage: { inputTokens: 10, outputTokens: 5 },
          isError: false,
        },
      };
    })());

    ctx.providerRegistry = {
      getDefault: vi.fn().mockReturnValue({
        provider: {
          name: 'test-sdk',
          createExecutionStrategy: () => ({
            type: 'sdk' as const,
            supportsSessionResumption: true as const,
            run: runStrategy,
          }),
          prepareBackgroundInvocation: vi.fn(),
          parseBackgroundResult: vi.fn(),
          estimateContextUsage: vi.fn().mockReturnValue({ inputTokens: 0, metrics: {} }),
        },
        config: {
          contextManagement: {
            enabled: false,
          },
        },
      }),
    } as any;

    const checkLoopConditions = vi.fn((runId: string, turnCount: number, recentCalls: Array<Record<string, unknown>>) => {
      expect(runId).toEqual(expect.any(String));
      expect(recentCalls).toHaveLength(turnCount);
      return turnCount === 3
        ? err(new GovernanceError('loop_detected', 'loop_detection'))
        : ok(undefined);
    });

    const runner = new AgentRunner(ctx, {
      governanceService: {
        checkLoopConditions,
        checkSpendingBudget: vi.fn().mockReturnValue(ok({ withinBudget: true, percentUsed: 0, warningTriggered: false, tokensUsed: 0, cap: 100000 })),
      } as any,
    });

    const result = await runner.run(makeQueueItem());

    expect(result.isOk()).toBe(true);
    expect(checkLoopConditions.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(checkLoopConditions).toHaveBeenNthCalledWith(1, expect.any(String), 1, [
      { tool: 'Read', args: { file: 'README.md' } },
    ]);
    expect(checkLoopConditions).toHaveBeenNthCalledWith(2, expect.any(String), 2, [
      { tool: 'Read', args: { file: 'README.md' } },
      { tool: 'Read', args: { file: 'README.md' } },
    ]);
    expect(checkLoopConditions).toHaveBeenNthCalledWith(3, expect.any(String), 3, [
      { tool: 'Read', args: { file: 'README.md' } },
      { tool: 'Read', args: { file: 'README.md' } },
      { tool: 'Read', args: { file: 'README.md' } },
    ]);
    expect(fourthTurnResultReached).toBe(false);
    expect(ctx.repos.run.updateStatus).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/cancelled|failed/),
      expect.objectContaining({
        ended_at: expect.any(Number),
        error: 'loop_detected',
      }),
    );
    expect(ctx.repos.run.updateStatus).not.toHaveBeenCalledWith(
      expect.any(String),
      'completed',
      expect.anything(),
    );
  });
});
