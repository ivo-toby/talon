import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ok, err } from 'neverthrow';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { QueueManager } from '../../../../src/queue/queue-manager.js';
import { BackgroundTaskRepository } from '../../../../src/core/database/repositories/background-task-repository.js';
import { BackgroundAgentManager } from '../../../../src/subagents/background/background-agent-manager.js';
import { BackgroundAgentError } from '../../../../src/core/errors/error-types.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE background_tasks (
      id              TEXT PRIMARY KEY,
      persona_id      TEXT NOT NULL,
      provider_name   TEXT NOT NULL,
      thread_id       TEXT NOT NULL,
      channel_id      TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      working_dir     TEXT,
      status          TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'completed', 'failed', 'timed_out', 'cancelled')),
      output          TEXT,
      error           TEXT,
      pid             INTEGER,
      created_at      INTEGER NOT NULL,
      started_at      INTEGER NOT NULL,
      completed_at        INTEGER,
      timeout_minutes     INTEGER NOT NULL DEFAULT 30,
      parent_traceparent  TEXT,
      sandbox_enabled     INTEGER NOT NULL DEFAULT 0,
      primary_execution_env_id TEXT
    );
    CREATE INDEX idx_background_tasks_status ON background_tasks(status);
    CREATE INDEX idx_background_tasks_thread_created ON background_tasks(thread_id, created_at DESC);
  `);
  return db;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

describe('BackgroundAgentManager', () => {
  let db: Database.Database;
  let repository: BackgroundTaskRepository;
  let queueManager: QueueManager;
  let prepareBackgroundInvocation: ReturnType<typeof vi.fn>;
  let parseBackgroundResult: ReturnType<typeof vi.fn>;
  let processStart: ReturnType<typeof vi.fn>;
  let processKill: ReturnType<typeof vi.fn>;
  let processFactory: ReturnType<typeof vi.fn>;
  let completionResolve: ((value: unknown) => void) | null;

  afterEach(() => {
    rmSync('/tmp/talon-bg-test', { recursive: true, force: true });
    rmSync('/tmp/talon-bg-control', { recursive: true, force: true });
  });

  beforeEach(() => {
    db = createTestDb();
    repository = new BackgroundTaskRepository(db);
    queueManager = {
      enqueue: vi.fn().mockReturnValue(ok({ id: 'queue-1' })),
    } as unknown as QueueManager;

    mkdirSync('/tmp/talon-bg-test', { recursive: true });

    prepareBackgroundInvocation = vi.fn().mockReturnValue(ok({
      command: 'claude',
      args: ['--print', '--output-format', 'json'],
      stdin: 'Refactor the auth module',
      cwd: '/workspace/repo',
      timeoutMs: 30 * 60 * 1000,
      cleanupPaths: ['/tmp/talon-bg-test'],
    }));
    parseBackgroundResult = vi.fn().mockImplementation((raw) => ({
      output: raw.stdout,
      stderr: raw.stderr,
      exitCode: raw.exitCode,
      timedOut: raw.timedOut,
    }));
    completionResolve = null;
    processKill = vi.fn();
    processStart = vi.fn().mockImplementation(() =>
      ok({
        pid: 4242,
        completion: new Promise((resolve) => {
          completionResolve = resolve;
        }),
      }),
    );
    processFactory = vi.fn().mockImplementation(() => ({
      start: processStart,
      kill: processKill,
    }));
  });

  function createManager(overrides: Record<string, unknown> = {}) {
    const claudeProvider = {
      name: 'claude-code',
      createExecutionStrategy: vi.fn(),
      prepareBackgroundInvocation,
      parseBackgroundResult,
      estimateContextUsage: vi.fn(),
    };
    const geminiProvider = {
      name: 'gemini-cli',
      createExecutionStrategy: vi.fn(),
      prepareBackgroundInvocation,
      parseBackgroundResult,
      estimateContextUsage: vi.fn(),
    };

    const providerEntry = {
      provider: claudeProvider,
      config: {
        enabled: true,
        command: 'claude',
        contextWindowTokens: 200000,
      },
    };
    const geminiProviderEntry = {
      provider: geminiProvider,
      config: {
        enabled: true,
        command: 'gemini',
        contextWindowTokens: 1000000,
      },
    };

    return new BackgroundAgentManager({
      repository,
      queueManager,
      maxConcurrent: 2,
      defaultTimeoutMinutes: 30,
      defaultProvider: 'claude-code',
      providerRegistry: {
        getDefault: vi.fn().mockReturnValue(providerEntry),
        listEnabled: vi.fn().mockReturnValue(['claude-code', 'gemini-cli']),
        get: vi.fn((name: string) => {
          if (name === 'gemini-cli') return geminiProviderEntry;
          if (name === 'claude-code') return providerEntry;
          return undefined;
        }),
      } as any,
      logger: makeLogger(),
      processFactory,
      isPidAlive: vi.fn().mockReturnValue(false),
      readProcessCommandLine: vi.fn().mockReturnValue('claude --print'),
      hostToolsSocketPath: '/tmp/test-host-tools.sock',
      ...overrides,
    });
  }

  const spawnInput = {
    prompt: 'Refactor the auth module',
    personaPrompt: 'You are helpful.',
    threadContext: 'Previous thread summary.',
    mcpServers: {},
    personaId: 'persona-1',
    threadId: 'thread-1',
    channelId: 'channel-1',
    channelName: 'telegram-main',
    provider: undefined,
    workingDirectory: '/workspace/repo',
    timeoutMinutes: 30,
    workerPersonaId: 'persona-1',
    allowedMcpTools: [],
  };

  it('creates a running task and returns its id', async () => {
    const manager = createManager();
    const result = await manager.spawn(spawnInput);
    expect(result.isOk()).toBe(true);

    const taskId = result._unsafeUnwrap();
    const task = repository.findById(taskId)._unsafeUnwrap();
    expect(task?.status).toBe('running');
    expect(task?.pid).toBe(4242);
  });

  it('builds the append-system-prompt from persona and task context', async () => {
    const manager = createManager();

    await manager.spawn(spawnInput);

    expect(prepareBackgroundInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Refactor the auth module',
        cwd: '/workspace/repo',
        timeoutMs: 30 * 60 * 1000,
      }),
    );

    const systemPrompt = prepareBackgroundInvocation.mock.calls[0]?.[0]?.systemPrompt as string;
    expect(systemPrompt).toContain('You are helpful.');
    expect(systemPrompt).toContain('Task ID:');
    expect(systemPrompt).toContain('Thread ID: thread-1');
    expect(systemPrompt).toContain('Channel: telegram-main');
    expect(systemPrompt).toContain('Previous thread summary.');
    expect(systemPrompt.toLowerCase()).toContain('autonomous');

    const options = processFactory.mock.calls[0]?.[0];
    expect(options.command).toBe('claude');
    expect(options.args).toEqual(['--print', '--output-format', 'json']);
    expect(options.stdin).toBe('Refactor the auth module');
  });

  it('includes channelContext in the system prompt when provided', async () => {
    const manager = createManager();

    await manager.spawn({
      ...spawnInput,
      channelContext: 'Available channels for channel_send tool:\n  - telegram-main (current thread)\n  - slack-general\nWhen sending messages, use channelId: "telegram-main".',
    });

    const systemPrompt = prepareBackgroundInvocation.mock.calls[0]?.[0]?.systemPrompt as string;
    expect(systemPrompt).toContain('Available channels for channel_send tool:');
    expect(systemPrompt).toContain('telegram-main (current thread)');
    expect(systemPrompt).toContain('slack-general');
  });

  it('includes timeContext in the system prompt when provided', async () => {
    const manager = createManager();

    await manager.spawn({
      ...spawnInput,
      timeContext: 'Current time: 2026-03-30T15:04:13+02:00 (CEST, Monday)',
    });

    const systemPrompt = prepareBackgroundInvocation.mock.calls[0]?.[0]?.systemPrompt as string;
    expect(systemPrompt).toContain('Current time: 2026-03-30T15:04:13+02:00 (CEST, Monday)');
  });

  it('omits channelContext and timeContext sections when not provided', async () => {
    const manager = createManager();

    await manager.spawn(spawnInput);

    const systemPrompt = prepareBackgroundInvocation.mock.calls[0]?.[0]?.systemPrompt as string;
    expect(systemPrompt).not.toContain('Available channels for channel_send tool:');
    expect(systemPrompt).not.toContain('Current time:');
  });

  it('provisions a sandbox env, injects host tools, and uses the control directory as cwd', async () => {
    const executionEnvManager = {
      create: vi.fn().mockResolvedValue(ok({
        id: 'env-1',
        provider: 'sprites',
        spriteId: 'sprite-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        ownerTaskId: null,
        status: 'ready',
        workingDirectory: '/workspace',
        baseSnapshot: 'node-22-bookworm',
        autoDestroy: true,
        resourceLimits: { cpus: 2, memoryMb: 4096, diskGb: 20 },
        createdAt: 1,
        updatedAt: 1,
        destroyedAt: null,
      })),
      upload: vi.fn().mockResolvedValue(ok({
        direction: 'upload',
        envId: 'env-1',
        sourcePath: '/workspace/repo',
        destinationPath: '/workspace',
        bytes: 123,
      })),
      destroyOwnedByTask: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(ok(undefined)),
    };
    const manager = createManager({ executionEnvManager });

    const result = await manager.spawn({
      ...spawnInput,
      sandbox: true as any,
      allowedMcpTools: ['execution_env', 'channel_send'],
      controlDirectory: '/tmp/talon-bg-control',
    } as any);

    expect(result.isOk()).toBe(true);
    const taskId = result._unsafeUnwrap();
    expect(executionEnvManager.create).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        personaId: 'persona-1',
        ownerTaskId: taskId,
      }),
    );
    expect(executionEnvManager.upload).toHaveBeenCalledWith({
      envId: 'env-1',
      sourcePath: '/workspace/repo',
      destinationPath: '/workspace',
      recursive: true,
      allowedHostRoots: ['/workspace/repo'],
    });
    expect(prepareBackgroundInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/talon-bg-control',
        mcpServers: expect.objectContaining({
          __talond_host_tools: expect.objectContaining({
            transport: 'stdio',
            env: expect.objectContaining({
              TALOND_SOCKET: '/tmp/test-host-tools.sock',
              TALOND_BACKGROUND_TASK_ID: taskId,
              TALOND_PRIMARY_EXECUTION_ENV_ID: 'env-1',
              TALOND_ALLOWED_TOOLS: 'execution_env,channel_send',
              TALOND_ALLOWED_HOST_ROOTS: '["/workspace/repo","/tmp/talon-bg-control"]',
            }),
          }),
        }),
      }),
    );
    expect(processFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          TALON_BACKGROUND_TASK_ID: taskId,
          TALON_PRIMARY_EXECUTION_ENV_ID: 'env-1',
          TALON_PRIMARY_EXECUTION_ENV_CWD: '/workspace',
        }),
      }),
    );
    const task = repository.findById(taskId)._unsafeUnwrap();
    expect(task?.sandboxEnabled).toBe(true);
    expect(task?.primaryExecutionEnvId).toBe('env-1');
  });

  it('exposes the workspace root to host tools for non-sandboxed tasks', async () => {
    const manager = createManager();

    const result = await manager.spawn({
      ...spawnInput,
      allowedMcpTools: ['execution_env'],
    } as any);

    expect(result.isOk()).toBe(true);
    expect(prepareBackgroundInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: expect.objectContaining({
          __talond_host_tools: expect.objectContaining({
            env: expect.objectContaining({
              TALOND_ALLOWED_HOST_ROOTS: '["/workspace/repo"]',
            }),
          }),
        }),
      }),
    );
  });

  it('destroys owned execution env when a sandboxed task is cancelled', async () => {
    const executionEnvManager = {
      create: vi.fn().mockResolvedValue(ok({
        id: 'env-1',
        provider: 'sprites',
        spriteId: 'sprite-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        ownerTaskId: null,
        status: 'ready',
        workingDirectory: '/workspace',
        baseSnapshot: null,
        autoDestroy: true,
        resourceLimits: { cpus: 2, memoryMb: 4096, diskGb: 20 },
        createdAt: 1,
        updatedAt: 1,
        destroyedAt: null,
      })),
      upload: vi.fn().mockResolvedValue(ok({
        direction: 'upload',
        envId: 'env-1',
        sourcePath: '/workspace/repo',
        destinationPath: '/workspace',
        bytes: 123,
      })),
      destroyOwnedByTask: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(ok(undefined)),
    };
    const manager = createManager({ executionEnvManager });
    const taskId = (await manager.spawn({
      ...spawnInput,
      sandbox: true as any,
      allowedMcpTools: ['execution_env'],
      controlDirectory: '/tmp/talon-bg-control',
    } as any))._unsafeUnwrap();

    const result = await manager.cancel(taskId);

    expect(result.isOk()).toBe(true);
    expect(executionEnvManager.destroyOwnedByTask).toHaveBeenCalledWith(taskId);
  });

  it('rejects spawn when concurrency limit is reached', async () => {
    repository.create({
      id: 'existing-1',
      personaId: 'persona-1',
      providerName: 'claude-code',
      threadId: 'thread-1',
      channelId: 'channel-1',
      prompt: 'one',
      workingDirectory: null,
      status: 'running',
      output: null,
      error: null,
      pid: 1111,
      timeoutMinutes: 30,
      sandboxEnabled: false,
      primaryExecutionEnvId: null,
    });
    repository.create({
      id: 'existing-2',
      personaId: 'persona-1',
      providerName: 'claude-code',
      threadId: 'thread-1',
      channelId: 'channel-1',
      prompt: 'two',
      workingDirectory: null,
      status: 'running',
      output: null,
      error: null,
      pid: 2222,
      timeoutMinutes: 30,
      sandboxEnabled: false,
      primaryExecutionEnvId: null,
    });

    const manager = createManager();
    const result = await manager.spawn(spawnInput);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('concurrency');
  });

  it('marks the task failed when process start fails', async () => {
    processStart.mockReturnValueOnce(err(new BackgroundAgentError('spawn failed')));
    const manager = createManager();

    const result = await manager.spawn(spawnInput);
    expect(result.isErr()).toBe(true);

    const tasks = repository.findByThread('thread-1')._unsafeUnwrap();
    expect(tasks[0]?.status).toBe('failed');
    expect(tasks[0]?.error).toContain('spawn failed');
    expect(existsSync('/tmp/talon-bg-test')).toBe(false);
  });

  it('marks the task completed and enqueues both direct and agent notifications when the process resolves', async () => {
    const manager = createManager();
    const taskId = (await manager.spawn(spawnInput))._unsafeUnwrap();

    completionResolve?.(
      ok({
        stdout: 'Done!',
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const task = repository.findById(taskId)._unsafeUnwrap();
    expect(parseBackgroundResult).toHaveBeenCalledWith({
      stdout: 'Done!',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }, undefined);
    expect(task?.status).toBe('completed');
    expect(task?.output).toBe('Done!');
    expect((queueManager.enqueue as any)).toHaveBeenNthCalledWith(
      1,
      'thread-1',
      'collaboration',
      expect.objectContaining({
        personaId: 'persona-1',
        kind: 'background_task_notification',
        taskId,
        status: 'completed',
        content: expect.stringContaining('Background Task Complete'),
      }),
    );
    expect((queueManager.enqueue as any)).toHaveBeenNthCalledWith(
      2,
      'thread-1',
      'message',
      expect.objectContaining({
        personaId: 'persona-1',
        content: expect.stringContaining('Background Task Complete'),
      }),
    );
  });

  it('passes resultFiles metadata into parseBackgroundResult before cleanup', async () => {
    const lastMessagePath = '/tmp/talon-bg-test/last-message.json';
    prepareBackgroundInvocation.mockReturnValueOnce(ok({
      command: 'claude',
      args: ['--print', '--output-format', 'json'],
      stdin: 'Refactor the auth module',
      cwd: '/workspace/repo',
      timeoutMs: 30 * 60 * 1000,
      cleanupPaths: ['/tmp/talon-bg-test'],
      resultFiles: { lastMessagePath },
    }));
    parseBackgroundResult.mockImplementationOnce((_raw, resultFiles) => {
      expect(resultFiles).toEqual({ lastMessagePath });
      expect(existsSync(lastMessagePath)).toBe(true);
      return {
        output: 'Parsed output',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    const manager = createManager();
    const taskId = (await manager.spawn(spawnInput))._unsafeUnwrap();
    writeFileSync(lastMessagePath, '{"message":"done"}', 'utf8');

    completionResolve?.(
      ok({
        stdout: 'Done!',
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(parseBackgroundResult).toHaveBeenCalledWith(
      {
        stdout: 'Done!',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
      { lastMessagePath },
    );
    expect(repository.findById(taskId)._unsafeUnwrap()?.status).toBe('completed');
    expect(existsSync('/tmp/talon-bg-test')).toBe(false);
  });

  it('marks task failed and cleans up when parseBackgroundResult throws after receiving resultFiles', async () => {
    const lastMessagePath = '/tmp/talon-bg-test/last-message.json';
    prepareBackgroundInvocation.mockReturnValueOnce(ok({
      command: 'claude',
      args: ['--print', '--output-format', 'json'],
      stdin: 'Refactor the auth module',
      cwd: '/workspace/repo',
      timeoutMs: 30 * 60 * 1000,
      cleanupPaths: ['/tmp/talon-bg-test'],
      resultFiles: { lastMessagePath },
    }));
    parseBackgroundResult.mockImplementationOnce((_raw, resultFiles) => {
      expect(resultFiles).toEqual({ lastMessagePath });
      expect(existsSync(lastMessagePath)).toBe(true);
      throw new Error('failed to parse provider result file');
    });

    const manager = createManager();
    const taskId = (await manager.spawn(spawnInput))._unsafeUnwrap();
    writeFileSync(lastMessagePath, '{"message":"done"}', 'utf8');

    completionResolve?.(
      ok({
        stdout: 'Done!',
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const task = repository.findById(taskId)._unsafeUnwrap();
    expect(task?.status).toBe('failed');
    expect(task?.output).toContain('Done!');
    expect(task?.error).toContain('failed to parse provider result file');
    expect(queueManager.enqueue as any).toHaveBeenCalledWith(
      'thread-1',
      'collaboration',
      expect.objectContaining({
        status: 'failed',
      }),
    );
    expect(existsSync('/tmp/talon-bg-test')).toBe(false);
  });

  it('cancels a running task and kills the in-memory process', async () => {
    const manager = createManager();
    const taskId = (await manager.spawn(spawnInput))._unsafeUnwrap();

    const result = await manager.cancel(taskId);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(true);
    expect(processKill).toHaveBeenCalled();
    expect(repository.findById(taskId)._unsafeUnwrap()?.status).toBe('cancelled');
  });

  it('cleans up cancelled tasks immediately so shutdown does not clean them twice', async () => {
    const manager = createManager();
    const taskId = (await manager.spawn(spawnInput))._unsafeUnwrap();

    await manager.cancel(taskId);
    await manager.shutdown();

    expect(existsSync('/tmp/talon-bg-test')).toBe(false);
  });

  it('marks orphaned running tasks as failed when their pid is dead', async () => {
    repository.create({
      id: 'orphan-1',
      personaId: 'persona-1',
      providerName: 'claude-code',
      threadId: 'thread-1',
      channelId: 'channel-1',
      prompt: 'orphan',
      workingDirectory: null,
      status: 'running',
      output: null,
      error: null,
      pid: 999999,
      timeoutMinutes: 30,
      sandboxEnabled: false,
      primaryExecutionEnvId: null,
    });

    const manager = createManager();
    await manager.recoverOrphanedTasks();

    expect(repository.findById('orphan-1')._unsafeUnwrap()?.status).toBe('failed');
  });

  it('kills active processes during shutdown', async () => {
    const manager = createManager();
    const taskId = (await manager.spawn(spawnInput))._unsafeUnwrap();

    await manager.shutdown();

    expect(processKill).toHaveBeenCalled();
    expect(repository.findById(taskId)._unsafeUnwrap()?.status).toBe('cancelled');
    expect(existsSync('/tmp/talon-bg-test')).toBe(false);
  });

  it('returns error when providerRegistry.getDefault returns undefined', async () => {
    const manager = new BackgroundAgentManager({
      repository,
      queueManager,
      maxConcurrent: 2,
      defaultTimeoutMinutes: 30,
      defaultProvider: 'claude-code',
      providerRegistry: {
        getDefault: vi.fn().mockReturnValue(undefined),
        listEnabled: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue(undefined),
      } as any,
      logger: makeLogger(),
      processFactory,
      isPidAlive: vi.fn().mockReturnValue(false),
      readProcessCommandLine: vi.fn().mockReturnValue(null),
    });

    const result = await manager.spawn(spawnInput);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BackgroundAgentError);
    expect(result._unsafeUnwrapErr().message).toContain('No enabled background agent provider found');
    // No task should have been created
    expect(repository.findByThread('thread-1')._unsafeUnwrap()).toHaveLength(0);
  });

  it('returns error when prepareBackgroundInvocation returns err', async () => {
    prepareBackgroundInvocation.mockReturnValueOnce(
      err(new BackgroundAgentError('invocation prep failed')),
    );
    const manager = createManager();

    const result = await manager.spawn(spawnInput);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BackgroundAgentError);
    expect(result._unsafeUnwrapErr().message).toBe('invocation prep failed');
    // No task should have been persisted
    expect(repository.findByThread('thread-1')._unsafeUnwrap()).toHaveLength(0);
  });

  it('marks task timed_out and enqueues notification when process times out', async () => {
    const manager = createManager();
    const taskId = (await manager.spawn(spawnInput))._unsafeUnwrap();

    completionResolve?.(
      ok({
        stdout: 'partial output',
        stderr: '',
        exitCode: null,
        signal: null,
        timedOut: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const task = repository.findById(taskId)._unsafeUnwrap();
    expect(task?.status).toBe('timed_out');
    expect(task?.output).toBe('partial output');
    expect(task?.error).toBe('Process timed out');
    expect(queueManager.enqueue as any).toHaveBeenCalledWith(
      'thread-1',
      'collaboration',
      expect.objectContaining({
        status: 'timed_out',
        content: expect.stringContaining('Timed Out'),
      }),
    );
  });

  it('marks task failed and enqueues notification when process exits with non-zero code', async () => {
    const manager = createManager();
    const taskId = (await manager.spawn(spawnInput))._unsafeUnwrap();

    completionResolve?.(
      ok({
        stdout: '',
        stderr: 'something went wrong',
        exitCode: 1,
        signal: null,
        timedOut: false,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const task = repository.findById(taskId)._unsafeUnwrap();
    expect(task?.status).toBe('failed');
    expect(task?.error).toBe('something went wrong');
    expect(queueManager.enqueue as any).toHaveBeenCalledWith(
      'thread-1',
      'collaboration',
      expect.objectContaining({
        status: 'failed',
        content: expect.stringContaining('Failed'),
      }),
    );
  });

  it('rejects spawn when maxConcurrent limit is exactly reached', async () => {
    // Fill up to exactly the maxConcurrent limit (2)
    for (let i = 1; i <= 2; i++) {
      repository.create({
        id: `slot-${i}`,
        personaId: 'persona-1',
        providerName: 'claude-code',
        threadId: 'thread-1',
        channelId: 'channel-1',
        prompt: `task ${i}`,
        workingDirectory: null,
        status: 'running',
        output: null,
        error: null,
        pid: 1000 + i,
        timeoutMinutes: 30,
        sandboxEnabled: false,
        primaryExecutionEnvId: null,
      });
    }

    const manager = createManager();
    const result = await manager.spawn(spawnInput);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BackgroundAgentError);
    expect(result._unsafeUnwrapErr().message).toContain('concurrency limit reached');
    expect(result._unsafeUnwrapErr().message).toContain('2');
    // process.start must never have been called
    expect(processStart).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Observability / LangFuse trace linking (F4)
  // ---------------------------------------------------------------------------

  function makeObservability() {
    const observation = {
      end: vi.fn(),
      update: vi.fn(),
      getTraceparent: vi.fn().mockReturnValue('00-child-trace-child-span-01'),
    };
    const observability = {
      startWithTraceparent: vi.fn().mockReturnValue(observation),
      start: vi.fn().mockReturnValue(observation),
      observe: vi.fn(),
      observeWithTraceparent: vi.fn(),
      shutdown: vi.fn(),
    };
    return { observability, observation };
  }

  function createManagerWithObservability() {
    const { observability, observation } = makeObservability();
    const claudeProvider = {
      name: 'claude-code',
      createExecutionStrategy: vi.fn(),
      prepareBackgroundInvocation,
      parseBackgroundResult,
      estimateContextUsage: vi.fn(),
    };
    const providerEntry = {
      provider: claudeProvider,
      config: {
        enabled: true,
        command: 'claude',
        contextWindowTokens: 200000,
      },
    };

    const manager = new BackgroundAgentManager({
      repository,
      queueManager,
      maxConcurrent: 2,
      defaultTimeoutMinutes: 30,
      defaultProvider: 'claude-code',
      providerRegistry: {
        getDefault: vi.fn().mockReturnValue(providerEntry),
        listEnabled: vi.fn().mockReturnValue(['claude-code']),
        get: vi.fn((name: string) => (name === 'claude-code' ? providerEntry : undefined)),
      } as any,
      logger: makeLogger(),
      processFactory,
      isPidAlive: vi.fn().mockReturnValue(false),
      readProcessCommandLine: vi.fn().mockReturnValue('claude --print'),
      observability,
    });

    return { manager, observability, observation };
  }

  it('starts a background agent observation span on spawn', async () => {
    const { manager, observability } = createManagerWithObservability();

    await manager.spawn({ ...spawnInput, traceparent: '00-aaa-bbb-01' });

    expect(observability.startWithTraceparent).toHaveBeenCalledWith(
      '00-aaa-bbb-01',
      expect.objectContaining({
        type: 'agent',
        name: 'background-agent',
        input: expect.objectContaining({
          prompt: spawnInput.prompt,
          threadId: spawnInput.threadId,
        }),
        trace: expect.objectContaining({
          tags: expect.arrayContaining(['background-agent', 'provider:claude-code']),
        }),
      }),
    );
  });

  it('passes traceparent from parent observation to prepareBackgroundInvocation', async () => {
    const { manager } = createManagerWithObservability();

    // The mock observation returns 'child-traceparent-value' from getTraceparent
    const { observation } = makeObservability();
    observation.getTraceparent.mockReturnValue('child-traceparent-value');

    // Override the observability mock in manager to return our custom observation
    const { observability: obs } = makeObservability();
    obs.startWithTraceparent.mockReturnValue(observation);

    // Use a fresh manager with the specific mock
    const claudeProvider = {
      name: 'claude-code',
      createExecutionStrategy: vi.fn(),
      prepareBackgroundInvocation,
      parseBackgroundResult,
      estimateContextUsage: vi.fn(),
    };
    const providerEntry = {
      provider: claudeProvider,
      config: { enabled: true, command: 'claude', contextWindowTokens: 200000 },
    };
    const freshManager = new BackgroundAgentManager({
      repository,
      queueManager,
      maxConcurrent: 2,
      defaultTimeoutMinutes: 30,
      defaultProvider: 'claude-code',
      providerRegistry: {
        getDefault: vi.fn().mockReturnValue(providerEntry),
        listEnabled: vi.fn().mockReturnValue(['claude-code']),
        get: vi.fn((name: string) => (name === 'claude-code' ? providerEntry : undefined)),
      } as any,
      logger: makeLogger(),
      processFactory,
      isPidAlive: vi.fn().mockReturnValue(false),
      readProcessCommandLine: vi.fn().mockReturnValue('claude --print'),
      observability: obs,
    });

    await freshManager.spawn({ ...spawnInput, traceparent: '00-aaa-bbb-01' });

    expect(prepareBackgroundInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        traceparent: 'child-traceparent-value',
      }),
    );
  });

  it('ends the observation span on task completion', async () => {
    const { manager, observation } = createManagerWithObservability();
    await manager.spawn({ ...spawnInput, traceparent: '00-aaa-bbb-01' });

    completionResolve?.(
      ok({
        stdout: 'Done!',
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observation.end).toHaveBeenCalled();
  });

  it('works without observability service (backwards compatible)', async () => {
    // createManager() does not pass observability — it should spawn fine
    const manager = createManager();

    const result = await manager.spawn(spawnInput);

    expect(result.isOk()).toBe(true);
    expect(prepareBackgroundInvocation).toHaveBeenCalled();
  });

  it('uses an explicit provider override, persists provider_name, and forwards env overrides', async () => {
    prepareBackgroundInvocation.mockReturnValueOnce(ok({
      command: 'gemini',
      args: ['--approval-mode', 'yolo', '--output-format', 'json', 'Refactor the auth module'],
      stdin: '',
      env: {
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/tmp/talon-bg-test/settings.json',
      },
      cwd: '/workspace/repo',
      timeoutMs: 30 * 60 * 1000,
      cleanupPaths: ['/tmp/talon-bg-test'],
    }));
    const manager = createManager();

    const result = await manager.spawn({
      ...spawnInput,
      provider: 'gemini-cli',
    });

    expect(result.isOk()).toBe(true);
    const task = repository.findById(result._unsafeUnwrap())._unsafeUnwrap();
    expect(task?.providerName).toBe('gemini-cli');
    expect(processFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'gemini',
        env: expect.objectContaining({
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/tmp/talon-bg-test/settings.json',
          TALON_BACKGROUND_TASK_ID: expect.any(String),
        }),
      }),
    );
  });
});
