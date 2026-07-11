import { describe, expect, it, vi } from 'vitest';
import { ok } from 'neverthrow';
import { BackgroundAgentHandler } from '../../../src/tools/host-tools/background-agent.js';
import type {
  BackgroundTask,
  BackgroundTaskResult,
} from '../../../src/subagents/background/background-agent-types.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

function makeTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: 'task-1',
    personaId: 'persona-1',
    providerName: 'claude-code',
    threadId: 'thread-1',
    channelId: 'channel-1',
    prompt: 'Refactor the auth module',
    workingDirectory: '/workspace/repo',
    status: 'running',
    output: null,
    error: null,
    pid: 4242,
    createdAt: 1_000,
    startedAt: 1_000,
    completedAt: null,
    timeoutMinutes: 30,
    parentTraceparent: null,
    sandboxEnabled: false,
    primaryExecutionEnvId: null,
    ...overrides,
  };
}

function makeResult(overrides: Partial<BackgroundTaskResult> = {}): BackgroundTaskResult {
  return {
    taskId: 'task-1',
    providerName: 'claude-code',
    status: 'completed',
    output: 'Done!',
    error: null,
    durationSeconds: 12,
    ...overrides,
  };
}

function createHandler(overrides: Record<string, unknown> = {}) {
  const backgroundAgentManager = {
    spawn: vi.fn().mockResolvedValue(ok('task-1')),
    listTasksForThread: vi.fn().mockReturnValue(ok([makeTask()])),
    getTask: vi.fn().mockReturnValue(ok(makeTask())),
    cancel: vi.fn().mockResolvedValue(ok(true)),
    getResult: vi.fn().mockReturnValue(ok(makeResult())),
  };

  // Default: hasProvider returns true for any name — preserves existing tests'
  // assumptions that persona.provider is always forwarded.
  const backgroundProviderRegistry = overrides.backgroundProviderRegistry ?? {
    hasProvider: vi.fn().mockReturnValue(true),
  };

  const deps = {
    backgroundAgentManager: backgroundAgentManager as any,
    backgroundProviderRegistry: backgroundProviderRegistry as any,
    personaRepository: {
      findById: vi.fn().mockReturnValue(ok({ id: 'persona-1', name: 'TestBot' })),
      findByName: vi.fn().mockImplementation((name: string) => ok({ id: `persona-${name}`, name })),
    } as any,
    personaLoader: {
      getByName: vi.fn().mockReturnValue(
        ok({
          config: { skills: ['search-skill'] },
          systemPromptContent: 'Base system prompt.',
          personalityContent: 'Friendly personality.',
          resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
        }),
      ),
      listNames: vi.fn().mockReturnValue(['TestBot']),
      listProfiles: vi.fn().mockReturnValue([
        { name: 'TestBot', description: 'A test bot' },
        { name: 'researcher', description: 'Deep web research' },
      ]),
    } as any,
    threadRepository: {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'thread-1',
          channel_id: 'channel-1',
          external_id: 'telegram-thread-1',
        }),
      ),
    } as any,
    channelRepository: {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'channel-1',
          name: 'telegram-main',
        }),
      ),
      findEnabled: vi.fn().mockReturnValue(ok([{ id: 'channel-1', name: 'telegram-main' }])),
    } as any,
    skillResolver: {
      mergePromptFragments: vi.fn().mockReturnValue('Skill instructions.'),
      collectMcpServers: vi.fn().mockReturnValue([
        {
          name: 'some-skill-server',
          config: {
            transport: 'stdio',
            command: 'node',
            args: ['some-skill-server.js'],
          },
        },
        {
          name: 'perplexity',
          config: {
            transport: 'stdio',
            command: 'npx',
            args: ['perplexity-mcp'],
            env: {
              API_KEY: '${PERPLEXITY_API_KEY}',
            },
          },
        },
      ]),
    } as any,
    contextAssembler: {
      assemble: vi.fn().mockReturnValue({
        text: 'Previous thread summary.',
        summaryFound: true,
        recentMessageCount: 0,
        charCount: 24,
      }),
    } as any,
    loadedSkills: [
      {
        manifest: { name: 'search-skill' },
        resolvedMcpServers: [],
      },
    ] as any,
    toolInstructions: new Map(),
    logger: makeLogger(),
    ...overrides,
  };

  const handler = new BackgroundAgentHandler(deps as any);

  return { handler, backgroundAgentManager, deps };
}

describe('BackgroundAgentHandler', () => {
  it('has the correct manifest', () => {
    expect(BackgroundAgentHandler.manifest.name).toBe('subagent.background');
    expect(BackgroundAgentHandler.manifest.capabilities).toContain('subagent.background');
    expect(BackgroundAgentHandler.manifest.executionLocation).toBe('host');
  });

  it('spawns a background task using current persona and thread context', async () => {
    process.env.PERPLEXITY_API_KEY = 'secret';
    const { handler, backgroundAgentManager, deps } = createHandler();

    const result = await handler.execute(
      {
        action: 'spawn',
        prompt: 'Refactor the auth module',
        workingDirectory: '/workspace/repo',
        timeoutMinutes: 45,
      },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('success');
    expect(result.result).toEqual({ taskId: 'task-1' });
    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Refactor the auth module',
        personaId: 'persona-1',
        threadId: 'thread-1',
        channelId: 'channel-1',
        channelName: 'telegram-main',
        workingDirectory: '/workspace/repo',
        timeoutMinutes: 45,
        threadContext: 'Previous thread summary.',
        mcpServers: {
          'some-skill-server': {
            transport: 'stdio',
            command: 'node',
            args: ['some-skill-server.js'],
          },
          perplexity: {
            transport: 'stdio',
            command: 'npx',
            args: ['perplexity-mcp'],
            env: { API_KEY: 'secret' },
          },
        },
        personaPrompt: expect.stringContaining('Base system prompt.'),
        workerPersonaId: 'persona-1',
        sandbox: false,
      }),
    );
    expect(deps.contextAssembler.assemble).toHaveBeenCalledWith('thread-1', 10);
    expect(backgroundAgentManager.spawn.mock.calls[0][0].personaPrompt).toContain(
      'Friendly personality.',
    );
    // Lazy mode: skill index (name only) is in prompt, not full eager content
    expect(backgroundAgentManager.spawn.mock.calls[0][0].personaPrompt).toContain('search-skill');
    expect(backgroundAgentManager.spawn.mock.calls[0][0].personaPrompt).not.toContain(
      'Skill instructions.',
    );
  });

  it('uses lazy skill loading — system prompt contains skill index not full skill content', async () => {
    const { handler, backgroundAgentManager } = createHandler();

    await handler.execute(
      { action: 'spawn', prompt: 'Refactor the auth module' },
      { runId: 'run-1', threadId: 'thread-1', personaId: 'persona-1', requestId: 'req-1' },
    );

    const personaPrompt = backgroundAgentManager.spawn.mock.calls[0][0].personaPrompt as string;
    // Lazy mode: skill index (name listed) is present
    expect(personaPrompt).toContain('search-skill');
    // Lazy mode: full eager skill content is NOT embedded
    expect(personaPrompt).not.toContain('Skill instructions.');
  });

  it('passes hasSkills: true to spawn when persona has skills', async () => {
    const { handler, backgroundAgentManager } = createHandler();

    await handler.execute(
      { action: 'spawn', prompt: 'Do something' },
      { runId: 'run-1', threadId: 'thread-1', personaId: 'persona-1', requestId: 'req-1' },
    );

    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ hasSkills: true }),
    );
  });

  it('passes hasSkills: false to spawn when persona has no skills', async () => {
    const { handler, backgroundAgentManager } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: { skills: [] },
            systemPromptContent: 'Base system prompt.',
            personalityContent: '',
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
        listNames: vi.fn().mockReturnValue(['TestBot']),
        listProfiles: vi.fn().mockReturnValue([]),
      },
      loadedSkills: [],
    });

    await handler.execute(
      { action: 'spawn', prompt: 'Do something' },
      { runId: 'run-1', threadId: 'thread-1', personaId: 'persona-1', requestId: 'req-1' },
    );

    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ hasSkills: false }),
    );
  });

  it('continues without thread context when context assembly throws', async () => {
    const { backgroundAgentManager, deps } = createHandler();
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
      contextAssembler: {
        assemble: vi.fn().mockImplementation(() => {
          throw new Error('db exploded');
        }),
      } as any,
    } as any);

    const result = await handler.execute(
      {
        action: 'spawn',
        prompt: 'Refactor the auth module',
      },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('success');
    expect(backgroundAgentManager.spawn.mock.calls[0][0].threadContext).toBeUndefined();
  });

  it('passes an explicit provider override through to the background agent manager', async () => {
    const { handler, backgroundAgentManager } = createHandler();

    const result = await handler.execute(
      {
        action: 'spawn',
        prompt: 'Refactor the auth module',
        provider: 'gemini-cli',
      },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('success');
    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gemini-cli',
      }),
    );
  });

  it('falls back to the persona provider when no explicit provider is supplied', async () => {
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: {
              skills: ['search-skill'],
              provider: 'gemini-cli',
            },
            systemPromptContent: 'Base system prompt.',
            personalityContent: 'Friendly personality.',
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    const result = await handler.execute(
      {
        action: 'spawn',
        prompt: 'Refactor the auth module',
      },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('success');
    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gemini-cli',
      }),
    );
  });

  it('returns current-thread history when status is called without taskId', async () => {
    const { handler, backgroundAgentManager } = createHandler();

    const result = await handler.execute(
      { action: 'status' },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('success');
    expect(result.result).toEqual({ tasks: [makeTask()] });
    expect(backgroundAgentManager.listTasksForThread).toHaveBeenCalledWith('thread-1');
  });

  it('rejects status for a task owned by another thread', async () => {
    const { handler, backgroundAgentManager } = createHandler();
    backgroundAgentManager.getTask.mockReturnValueOnce(ok(makeTask({ threadId: 'thread-2' })));

    const result = await handler.execute(
      { action: 'status', taskId: 'task-1' },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('does not belong to the current thread');
  });

  it('returns not found when the task does not exist', async () => {
    const { handler, backgroundAgentManager } = createHandler();
    backgroundAgentManager.getTask.mockReturnValueOnce(ok(null));

    const result = await handler.execute(
      { action: 'status', taskId: 'missing-task' },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('not found');
  });

  it('rejects cancel for a task owned by another thread', async () => {
    const { handler, backgroundAgentManager } = createHandler();
    backgroundAgentManager.getTask.mockReturnValueOnce(ok(makeTask({ threadId: 'thread-2' })));

    const result = await handler.execute(
      { action: 'cancel', taskId: 'task-1' },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('does not belong to the current thread');
    expect(backgroundAgentManager.cancel).not.toHaveBeenCalled();
  });

  it('rejects result for a task owned by another thread', async () => {
    const { handler, backgroundAgentManager } = createHandler();
    backgroundAgentManager.getTask.mockReturnValueOnce(ok(makeTask({ threadId: 'thread-2' })));

    const result = await handler.execute(
      { action: 'result', taskId: 'task-1' },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('does not belong to the current thread');
    expect(backgroundAgentManager.getResult).not.toHaveBeenCalled();
  });

  describe('profile parameter', () => {
    it('spawns with profile persona when a valid profile name is given', async () => {
      const profilePersona = {
        config: {
          name: 'code-reviewer',
          skills: [],
          provider: 'gemini-cli',
          model: 'gemini-2.5-pro',
        },
        systemPromptContent: 'You are a code reviewer.',
        personalityContent: 'Terse and critical.',
        resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
      };

      const personaLoader = {
        getByName: vi.fn().mockImplementation((name: string) => {
          if (name === 'code-reviewer') return ok(profilePersona);
          if (name === 'TestBot') {
            return ok({
              config: { skills: ['search-skill'], provider: undefined },
              systemPromptContent: 'Base system prompt.',
              personalityContent: 'Friendly personality.',
              resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
            });
          }
          return ok(undefined);
        }),
        listNames: vi.fn().mockReturnValue(['TestBot', 'code-reviewer']),
      };

      const { handler, backgroundAgentManager } = createHandler({ personaLoader });

      const result = await handler.execute(
        {
          action: 'spawn',
          prompt: 'Review this PR',
          profile: 'code-reviewer',
        },
        {
          runId: 'run-1',
          threadId: 'thread-1',
          personaId: 'persona-1',
          requestId: 'req-1',
        },
      );

      expect(result.status).toBe('success');
      expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          personaPrompt: expect.stringContaining('You are a code reviewer.'),
          provider: 'gemini-cli',
          model: 'gemini-2.5-pro',
          profileName: 'code-reviewer',
          personaId: 'persona-1', // task tracking still uses original persona
          workerPersonaId: 'persona-code-reviewer',
        }),
      );
      // Should NOT contain the spawning thread's persona prompt
      expect(backgroundAgentManager.spawn.mock.calls[0][0].personaPrompt).not.toContain(
        'Base system prompt.',
      );
    });

    it('returns error with available profiles when profile name is unknown', async () => {
      const personaLoader = {
        getByName: vi.fn().mockReturnValue(ok(undefined)),
        listNames: vi.fn().mockReturnValue(['TestBot', 'code-reviewer']),
      };

      const { handler, backgroundAgentManager } = createHandler({ personaLoader });

      const result = await handler.execute(
        {
          action: 'spawn',
          prompt: 'Review this PR',
          profile: 'nonexistent',
        },
        {
          runId: 'run-1',
          threadId: 'thread-1',
          personaId: 'persona-1',
          requestId: 'req-1',
        },
      );

      expect(result.status).toBe('error');
      expect(result.error).toContain('nonexistent');
      expect(result.error).toContain('TestBot');
      expect(result.error).toContain('code-reviewer');
      expect(backgroundAgentManager.spawn).not.toHaveBeenCalled();
    });

    it('does not pass model when provider is explicitly overridden', async () => {
      const profilePersona = {
        config: {
          name: 'code-reviewer',
          skills: [],
          provider: 'gemini-cli',
          model: 'gemini-2.5-pro',
        },
        systemPromptContent: 'You are a code reviewer.',
        personalityContent: null,
        resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
      };

      const personaLoader = {
        getByName: vi.fn().mockImplementation((name: string) => {
          if (name === 'code-reviewer') return ok(profilePersona);
          if (name === 'TestBot') {
            return ok({
              config: { skills: ['search-skill'], provider: undefined },
              systemPromptContent: 'Base system prompt.',
              personalityContent: 'Friendly personality.',
              resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
            });
          }
          return ok(undefined);
        }),
        listNames: vi.fn().mockReturnValue(['TestBot', 'code-reviewer']),
      };

      const { handler, backgroundAgentManager } = createHandler({ personaLoader });

      const result = await handler.execute(
        {
          action: 'spawn',
          prompt: 'Review this PR',
          profile: 'code-reviewer',
          provider: 'claude-code',
        },
        {
          runId: 'run-1',
          threadId: 'thread-1',
          personaId: 'persona-1',
          requestId: 'req-1',
        },
      );

      expect(result.status).toBe('success');
      expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'claude-code',
        }),
      );
      // Model should NOT be passed when provider is explicitly overridden
      expect(backgroundAgentManager.spawn.mock.calls[0][0].model).toBeUndefined();
    });

    it('does not pass model when persona has model but no explicit provider', async () => {
      // Scenario: persona has model: "gpt-5.4" (for codex-cli via agentRunner.defaultProvider)
      // but no explicit provider field. The backgroundAgent.defaultProvider (e.g. claude-code)
      // would receive the codex model, causing a cross-provider mismatch.
      const { handler, backgroundAgentManager, deps } = createHandler();

      // Override personaLoader to return a persona with model but NO provider
      deps.personaLoader.getByName = vi.fn().mockReturnValue(
        ok({
          config: { name: 'assistant', skills: [], model: 'gpt-5.4' },
          systemPromptContent: 'You are an assistant.',
          personalityContent: null,
          resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
        }),
      );

      await handler.execute(
        { action: 'spawn', prompt: 'Do something' },
        { runId: 'run-1', threadId: 'thread-1', personaId: 'persona-1', requestId: 'req-1' },
      );

      expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'Do something' }),
      );
      // Model must NOT be forwarded — the background default provider may differ
      expect(backgroundAgentManager.spawn.mock.calls[0][0].model).toBeUndefined();
    });

    it('passes model when persona.provider is registered in the background registry', async () => {
      const { handler, backgroundAgentManager, deps } = createHandler();

      deps.personaLoader.getByName = vi.fn().mockReturnValue(
        ok({
          config: {
            name: 'software-engineer',
            skills: [],
            provider: 'codex-cli',
            model: 'gpt-5.4',
          },
          systemPromptContent: 'You are an engineer.',
          personalityContent: null,
          resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
        }),
      );

      await handler.execute(
        { action: 'spawn', prompt: 'Build a feature' },
        { runId: 'run-1', threadId: 'thread-1', personaId: 'persona-1', requestId: 'req-1' },
      );

      expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'codex-cli',
          model: 'gpt-5.4',
        }),
      );
    });

    it('uses spawning persona when no profile is given (existing behavior)', async () => {
      const { handler, backgroundAgentManager } = createHandler();

      const result = await handler.execute(
        {
          action: 'spawn',
          prompt: 'Refactor the auth module',
        },
        {
          runId: 'run-1',
          threadId: 'thread-1',
          personaId: 'persona-1',
          requestId: 'req-1',
        },
      );

      expect(result.status).toBe('success');
      expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          personaPrompt: expect.stringContaining('Base system prompt.'),
        }),
      );
    });
  });

  it('returns validation errors for missing required fields', async () => {
    const { handler } = createHandler();

    const spawnResult = await handler.execute(
      { action: 'spawn' },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );
    expect(spawnResult.status).toBe('error');
    expect(spawnResult.error).toContain('prompt');

    const cancelResult = await handler.execute(
      { action: 'cancel' },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );
    expect(cancelResult.status).toBe('error');
    expect(cancelResult.error).toContain('taskId');
  });

  // -------------------------------------------------------------------------
  // profiles action
  // -------------------------------------------------------------------------

  it('profiles action returns available profiles with descriptions', async () => {
    const { handler } = createHandler();
    const result = await handler.execute(
      { action: 'profiles' },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-profiles',
      },
    );
    expect(result.status).toBe('success');
    expect(result.result).toEqual({
      profiles: [
        { name: 'TestBot', description: 'A test bot' },
        { name: 'researcher', description: 'Deep web research' },
      ],
    });
  });

  it('profiles action does not require prompt or taskId', async () => {
    const { handler } = createHandler();
    const result = await handler.execute(
      { action: 'profiles' },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-profiles-2',
      },
    );
    expect(result.status).toBe('success');
  });

  it('passes sandbox=true and filters out background_agent from worker host tools', async () => {
    const { handler, backgroundAgentManager } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: {
              skills: ['search-skill'],
              executionEnv: { sandboxDefault: false },
            },
            systemPromptContent: 'Base system prompt.',
            personalityContent: 'Friendly personality.',
            resolvedCapabilities: {
              allow: ['subagent.background', 'execution.env', 'channel.send:*'],
              requireApproval: [],
            },
          }),
        ),
        listNames: vi.fn().mockReturnValue(['TestBot']),
        listProfiles: vi.fn().mockReturnValue([]),
      } as any,
    });

    const result = await handler.execute(
      {
        action: 'spawn',
        prompt: 'Run sandboxed',
        sandbox: true as any,
      } as any,
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('success');
    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        sandbox: true,
        allowedMcpTools: expect.arrayContaining(['execution_env', 'channel_send']),
      }),
    );
    expect(backgroundAgentManager.spawn.mock.calls[0][0].allowedMcpTools).not.toContain(
      'background_agent',
    );
  });

  it('uses the profile sandbox default when sandbox is omitted', async () => {
    const { handler, backgroundAgentManager } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: {
              skills: ['search-skill'],
              executionEnv: { sandboxDefault: true },
            },
            systemPromptContent: 'Base system prompt.',
            personalityContent: 'Friendly personality.',
            resolvedCapabilities: {
              allow: ['subagent.background', 'execution.env'],
              requireApproval: [],
            },
          }),
        ),
        listNames: vi.fn().mockReturnValue(['TestBot']),
        listProfiles: vi.fn().mockReturnValue([]),
      } as any,
    });

    const result = await handler.execute(
      {
        action: 'spawn',
        prompt: 'Use default sandbox',
      },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('success');
    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        sandbox: true,
      }),
    );
  });

  it('rejects sandboxed spawn when the selected profile lacks execution.env capability', async () => {
    const { handler, backgroundAgentManager } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: {
              skills: ['search-skill'],
            },
            systemPromptContent: 'Base system prompt.',
            personalityContent: 'Friendly personality.',
            resolvedCapabilities: {
              allow: ['subagent.background'],
              requireApproval: [],
            },
          }),
        ),
        listNames: vi.fn().mockReturnValue(['TestBot']),
        listProfiles: vi.fn().mockReturnValue([]),
      } as any,
    });

    const result = await handler.execute(
      {
        action: 'spawn',
        prompt: 'Run sandboxed',
        sandbox: true as any,
      } as any,
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('execution.env');
    expect(backgroundAgentManager.spawn).not.toHaveBeenCalled();
  });
});

describe('background-agent provider resolution chain', () => {
  it('uses persona.backgroundProvider when set, ignoring persona.provider', async () => {
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: {
              skills: ['search-skill'],
              provider: 'openai-compatible',
              backgroundProvider: 'claude-code',
            },
            systemPromptContent: 'Base system prompt.',
            personalityContent: 'Friendly personality.',
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    const result = await handler.execute(
      { action: 'spawn', prompt: 'do work' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    expect(result.status).toBe('success');
    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude-code' }),
    );
  });

  it('falls back to persona.provider only when it is available in the background registry', async () => {
    const backgroundProviderRegistry = {
      hasProvider: vi.fn().mockImplementation((name: string) => name === 'gemini-cli'),
    };
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: { skills: [], provider: 'gemini-cli' },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
      backgroundProviderRegistry: backgroundProviderRegistry as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    const result = await handler.execute(
      { action: 'spawn', prompt: 'do work' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    expect(result.status).toBe('success');
    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gemini-cli' }),
    );
  });

  it('drops persona.provider when it is NOT in the background registry (defaults to daemon)', async () => {
    const backgroundProviderRegistry = {
      hasProvider: vi.fn().mockImplementation((name: string) => name === 'claude-code'),
    };
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: { skills: [], provider: 'openai-compatible' },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
      backgroundProviderRegistry: backgroundProviderRegistry as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    const result = await handler.execute(
      { action: 'spawn', prompt: 'do work' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    expect(result.status).toBe('success');
    const spawnArgs = backgroundAgentManager.spawn.mock.calls[0][0];
    expect(spawnArgs.provider).toBeUndefined();
  });

  it('honors explicit args.provider strictly (still forwarded even when persona has backgroundProvider)', async () => {
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: {
              skills: [],
              provider: 'openai-compatible',
              backgroundProvider: 'claude-code',
            },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    const result = await handler.execute(
      { action: 'spawn', prompt: 'do work', provider: 'codex-cli' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    expect(result.status).toBe('success');
    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex-cli' }),
    );
    expect((deps.backgroundProviderRegistry as any).hasProvider).not.toHaveBeenCalled();
  });
});

describe('background-agent model resolution chain', () => {
  it('forwards backgroundModel when backgroundProvider resolves', async () => {
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: {
              skills: [],
              provider: 'openai-compatible',
              model: 'gpt-oss',
              backgroundProvider: 'claude-code',
              backgroundModel: 'claude-sonnet-4-6',
            },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    await handler.execute(
      { action: 'spawn', prompt: 'work' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude-code', model: 'claude-sonnet-4-6' }),
    );
  });

  it('forwards persona.model when persona.provider resolves (registry has it)', async () => {
    const backgroundProviderRegistry = {
      hasProvider: vi.fn().mockImplementation((name: string) => name === 'codex-cli'),
    };
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: { skills: [], provider: 'codex-cli', model: 'gpt-5.4' },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
      backgroundProviderRegistry: backgroundProviderRegistry as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    await handler.execute(
      { action: 'spawn', prompt: 'work' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex-cli', model: 'gpt-5.4' }),
    );
  });

  it('forwards persona reasoningEffort when persona.provider and persona.model resolve', async () => {
    const backgroundProviderRegistry = {
      hasProvider: vi.fn().mockImplementation((name: string) => name === 'codex-cli'),
    };
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: {
              skills: [],
              provider: 'codex-cli',
              model: 'gpt-5.4',
              reasoningEffort: 'xhigh',
            },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
      backgroundProviderRegistry: backgroundProviderRegistry as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    await handler.execute(
      { action: 'spawn', prompt: 'work' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'codex-cli',
        model: 'gpt-5.4',
        reasoningEffort: 'xhigh',
      }),
    );
  });

  it('forwards persona reasoningEffort when the provider supplies the default model', async () => {
    const backgroundProviderRegistry = {
      hasProvider: vi.fn().mockImplementation((name: string) => name === 'codex-cli'),
    };
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: {
              skills: [],
              provider: 'codex-cli',
              reasoningEffort: 'high',
            },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
      backgroundProviderRegistry: backgroundProviderRegistry as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    await handler.execute(
      { action: 'spawn', prompt: 'work' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'codex-cli',
        reasoningEffort: 'high',
      }),
    );
    expect(backgroundAgentManager.spawn.mock.calls[0][0].model).toBeUndefined();
  });

  it('does NOT forward any model when persona.provider is dropped (not in background registry)', async () => {
    const backgroundProviderRegistry = {
      hasProvider: vi.fn().mockImplementation((name: string) => name === 'claude-code'),
    };
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: {
              skills: [],
              provider: 'openai-compatible',
              model: 'gpt-oss',
              reasoningEffort: 'high',
            },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
      backgroundProviderRegistry: backgroundProviderRegistry as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    await handler.execute(
      { action: 'spawn', prompt: 'work' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    const spawnArgs = backgroundAgentManager.spawn.mock.calls[0][0];
    expect(spawnArgs.provider).toBeUndefined();
    expect(spawnArgs.model).toBeUndefined();
    expect(spawnArgs.reasoningEffort).toBeUndefined();
  });

  it('does NOT forward model when args.provider is explicitly given', async () => {
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: {
              skills: [],
              provider: 'codex-cli',
              model: 'gpt-5.4',
              backgroundProvider: 'claude-code',
              backgroundModel: 'claude-sonnet-4-6',
            },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    await handler.execute(
      { action: 'spawn', prompt: 'work', provider: 'gemini-cli' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    const spawnArgs = backgroundAgentManager.spawn.mock.calls[0][0];
    expect(spawnArgs.provider).toBe('gemini-cli');
    expect(spawnArgs.model).toBeUndefined();
    expect(spawnArgs.reasoningEffort).toBeUndefined();
  });

  it('does NOT forward a model when backgroundProvider is set but backgroundModel is absent', async () => {
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: {
              skills: [],
              provider: 'openai-compatible',
              model: 'gpt-oss',
              backgroundProvider: 'claude-code',
              // intentionally no backgroundModel
            },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    await handler.execute(
      { action: 'spawn', prompt: 'work' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    const spawnArgs = backgroundAgentManager.spawn.mock.calls[0][0];
    expect(spawnArgs.provider).toBe('claude-code');
    expect(spawnArgs.model).toBeUndefined();
  });
});

describe('regression: openai-compatible persona spawning background agents', () => {
  it('does not forward openai-compatible to the background manager (trace 91a662301c97b16bb345de7cec973286)', async () => {
    // Reproduces the original report: persona has `provider: openai-compatible`
    // (foreground), backgroundAgent.providers only enables claude-code + codex-cli.
    // Before the fix, openai-compatible was forwarded as an "explicit" provider
    // and tripped the manager's strict registry check.
    const backgroundProviderRegistry = {
      hasProvider: vi
        .fn()
        .mockImplementation((name: string) => name === 'claude-code' || name === 'codex-cli'),
    };
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: {
              skills: [],
              provider: 'openai-compatible',
              model: 'kimi-k2.6:cloud',
            },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
      backgroundProviderRegistry: backgroundProviderRegistry as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    const result = await handler.execute(
      { action: 'spawn', prompt: 'do background work' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    expect(result.status).toBe('success');
    const spawnArgs = backgroundAgentManager.spawn.mock.calls[0][0];
    expect(spawnArgs.provider).toBeUndefined(); // manager picks defaultProvider
    expect(spawnArgs.model).toBeUndefined(); // no cross-provider model leak
  });
});
