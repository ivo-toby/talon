/**
 * Unit tests for daemon-bootstrap bootstrap().
 *
 * Nearly every dependency is mocked at the module level since bootstrap()
 * wires together the entire daemon subsystem graph. Tests verify that
 * failures at each stage are handled correctly and that a successful
 * bootstrap produces a fully populated DaemonContext.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from 'neverthrow';
import type pino from 'pino';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../../src/core/config/config-loader.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../../src/core/database/connection.js', () => ({
  createDatabase: vi.fn(),
}));

vi.mock('../../../src/core/database/migrations/runner.js', () => ({
  runMigrations: vi.fn(),
}));

vi.mock('../../../src/core/database/repositories/index.js', () => ({
  QueueRepository: vi.fn().mockImplementation(() => ({})),
  ThreadRepository: vi.fn().mockImplementation(() => ({})),
  ChannelRepository: vi.fn().mockImplementation(() => ({})),
  PersonaRepository: vi.fn().mockImplementation(() => ({})),
  BackgroundTaskRepository: vi.fn().mockImplementation(() => ({})),
  ExecutionEnvRepository: vi.fn().mockImplementation(() => ({})),
  ExecutionEnvCheckpointRepository: vi.fn().mockImplementation(() => ({})),
  ScheduleRepository: vi.fn().mockImplementation(() => ({})),
  AuditRepository: vi.fn().mockImplementation(() => ({})),
  MessageRepository: vi.fn().mockImplementation(() => ({})),
  RunRepository: vi.fn().mockImplementation(() => ({})),
  BindingRepository: vi.fn().mockImplementation(() => ({})),
  MemoryRepository: vi.fn().mockImplementation(() => ({})),
  A2ATaskRepository: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/core/database/repositories/audit-repository.js', () => ({
  RepositoryAuditStore: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/core/logging/audit-logger.js', () => ({
  AuditLogger: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/observability/langfuse/index.js', () => ({
  createObservabilityService: vi.fn(),
}));

vi.mock('../../../src/personas/persona-loader.js', () => ({
  PersonaLoader: vi.fn().mockImplementation(() => ({
    loadFromConfig: vi.fn().mockResolvedValue(ok(undefined)),
    getByName: vi.fn().mockReturnValue(ok({})),
  })),
}));

vi.mock('../../../src/skills/skill-loader.js', () => ({
  SkillLoader: vi.fn().mockImplementation(() => ({
    loadFromPersonaConfig: vi.fn().mockResolvedValue(ok([])),
  })),
}));

vi.mock('../../../src/skills/skill-resolver.js', () => ({
  SkillResolver: vi.fn().mockImplementation(() => ({
    mergePromptFragments: vi.fn().mockReturnValue(''),
  })),
}));

vi.mock('../../../src/channels/channel-registry.js', () => ({
  ChannelRegistry: vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../../../src/channels/channel-router.js', () => ({
  ChannelRouter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/channels/channel-setup.js', () => ({
  registerChannels: vi.fn(),
}));

vi.mock('../../../src/pipeline/message-pipeline.js', () => ({
  MessagePipeline: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/queue/queue-manager.js', () => ({
  QueueManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/scheduler/scheduler.js', () => ({
  Scheduler: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/memory/thread-workspace.js', () => ({
  ThreadWorkspace: vi.fn().mockImplementation(() => ({
    ensureDirectories: vi.fn().mockReturnValue(ok('/tmp/workspace')),
  })),
}));

vi.mock('../../../src/sandbox/session-tracker.js', () => ({
  SessionTracker: vi.fn().mockImplementation(() => ({
    getSessionId: vi.fn(),
    setSessionId: vi.fn(),
  })),
}));

vi.mock('../../../src/tools/host-tools-bridge.js', () => ({
  HostToolsBridge: vi.fn().mockImplementation(() => ({
    path: '/tmp/host-tools.sock',
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('../../../src/subagents/background/background-agent-manager.js', () => ({
  BackgroundAgentManager: vi.fn().mockImplementation(() => ({
    recoverOrphanedTasks: vi.fn(),
    shutdown: vi.fn(),
  })),
}));

vi.mock('../../../src/execution-env/execution-env-manager.js', () => ({
  ExecutionEnvManager: vi.fn().mockImplementation(() => ({
    recoverOrphanedEnvironments: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../src/execution-env/sprites-client.js', () => ({
  SpritesClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/daemon/lifecycle.js', () => ({
  recoverFromCrash: vi.fn(),
}));

vi.mock('../../../src/a2a/index.js', () => ({
  buildAgentCardRegistry: vi.fn().mockReturnValue(new Map()),
  A2ATaskMapper: vi.fn().mockImplementation(() => ({})),
  A2AServer: vi.fn().mockImplementation(() => ({ fetch: vi.fn() })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { bootstrap } from '../../../src/daemon/daemon-bootstrap.js';
import { loadConfig } from '../../../src/core/config/config-loader.js';
import { createDatabase } from '../../../src/core/database/connection.js';
import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { PersonaLoader } from '../../../src/personas/persona-loader.js';
import { SkillLoader } from '../../../src/skills/skill-loader.js';
import { HostToolsBridge } from '../../../src/tools/host-tools-bridge.js';
import { recoverFromCrash } from '../../../src/daemon/lifecycle.js';
import { registerChannels } from '../../../src/channels/channel-setup.js';
import { BackgroundTaskRepository } from '../../../src/core/database/repositories/index.js';
import { BackgroundAgentManager } from '../../../src/subagents/background/background-agent-manager.js';
import { ExecutionEnvManager } from '../../../src/execution-env/execution-env-manager.js';
import { createDiscardLogger } from './helpers.js';
import { createObservabilityService } from '../../../src/observability/langfuse/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): pino.Logger {
  return createDiscardLogger('silent');
}

function makeContextManagementConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    contextManagement: makeContextManagementConfig(),
    ...overrides,
  };
}

function makeBackgroundProviderConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    command: 'claude',
    contextWindowTokens: 200000,
    ...overrides,
  };
}

/** Minimal valid TalondConfig fixture. */
function makeConfig(overrides: Record<string, unknown> = {}): unknown {
  return {
    storage: { type: 'sqlite', path: ':memory:' },
    dataDir: '/tmp/test-data',
    logLevel: 'info',
    channels: [],
    personas: [],
    schedules: [],
    ipc: { pollIntervalMs: 500, daemonSocketDir: 'data/ipc/daemon' },
    queue: { maxAttempts: 3, backoffBaseMs: 1000, backoffMaxMs: 60000, concurrencyLimit: 2 },
    scheduler: { tickIntervalMs: 5000 },
    sandbox: {
      runtime: 'docker',
      image: 'talon-sandbox:latest',
      maxConcurrent: 3,
      networkDefault: 'off',
      idleTimeoutMs: 1800000,
      hardTimeoutMs: 3600000,
      resourceLimits: { memoryMb: 1024, cpus: 1, pidsLimit: 256 },
    },
    auth: { mode: 'subscription' },
    agentRunner: {
      defaultProvider: 'claude-code',
      providers: {
        'claude-code': makeAgentRunnerProviderConfig(),
      },
    },
    backgroundAgent: {
      enabled: true,
      maxConcurrent: 3,
      defaultTimeoutMinutes: 30,
      defaultProvider: 'claude-code',
      providers: {
        'claude-code': makeBackgroundProviderConfig(),
      },
    },
    sprites: {
      enabled: false,
      token: '',
      apiBaseUrl: 'https://api.sprites.dev',
      workingDirectory: '/workspace',
      createTimeoutMs: 60000,
      execTimeoutMs: 1200000,
      autoDestroyOnCompletion: true,
      resourceLimits: { cpus: 2, memoryMb: 4096, diskGb: 20 },
    },
    langfuse: {
      enabled: false,
      publicKey: '',
      secretKey: '',
      baseUrl: 'https://cloud.langfuse.com',
      environment: 'production',
      exportMode: 'batched',
      flushAt: 20,
      flushIntervalSeconds: 5,
    },
    ...overrides,
  };
}

function makeMockDb() {
  const mockStatement = {
    run: vi.fn().mockReturnValue({ changes: 0, lastInsertRowid: 0 }),
    get: vi.fn().mockReturnValue(undefined),
    all: vi.fn().mockReturnValue([]),
  };

  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
    pragma: vi.fn().mockReturnValue(0),
    exec: vi.fn(),
    close: vi.fn(),
  };
}

/**
 * Sets up mocks for a fully successful bootstrap.
 * Returns the mock DB for assertions.
 */
function setupSuccessfulMocks() {
  const config = makeConfig();
  const db = makeMockDb();
  const observability = {
    observe: vi.fn(),
    observeWithTraceparent: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };

  vi.mocked(loadConfig).mockReturnValue(ok(config as any));
  vi.mocked(createDatabase).mockReturnValue(ok(db as any));
  vi.mocked(runMigrations).mockReturnValue(ok(1));
  vi.mocked(createObservabilityService).mockResolvedValue(observability as any);

  // Restore constructor mocks in case previous tests overrode them.
  vi.mocked(PersonaLoader).mockImplementation(() => ({
    loadFromConfig: vi.fn().mockResolvedValue(ok(undefined)),
    getByName: vi.fn().mockReturnValue(ok({})),
  }) as any);
  vi.mocked(SkillLoader).mockImplementation(() => ({
    loadFromPersonaConfig: vi.fn().mockResolvedValue(ok([])),
  }) as any);

  return { config, db, observability };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bootstrap', () => {
  let logger: pino.Logger;

  beforeEach(() => {
    logger = createSilentLogger();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Failure scenarios
  // -------------------------------------------------------------------------

  describe('failure scenarios', () => {
    it('returns error when config loading fails', async () => {
      vi.mocked(loadConfig).mockReturnValue(
        err(new Error('config file not found') as any),
      );

      const result = await bootstrap('/missing.yaml', logger);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Failed to load config');
    });

    it('returns error when database creation fails', async () => {
      const config = makeConfig();
      vi.mocked(loadConfig).mockReturnValue(ok(config as any));
      vi.mocked(createDatabase).mockReturnValue(
        err(new Error('cannot open database') as any),
      );

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Failed to open database');
    });

    it('returns error when migrations fail and closes db', async () => {
      const config = makeConfig();
      const db = makeMockDb();
      vi.mocked(loadConfig).mockReturnValue(ok(config as any));
      vi.mocked(createDatabase).mockReturnValue(ok(db as any));
      vi.mocked(runMigrations).mockReturnValue(
        err(new Error('migration 003 failed') as any),
      );

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Failed to run migrations');
      expect(db.close).toHaveBeenCalledOnce();
    });

    it('returns error when persona loading fails and closes db', async () => {
      const config = makeConfig();
      const db = makeMockDb();
      const observability = {
        observe: vi.fn(),
        observeWithTraceparent: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(loadConfig).mockReturnValue(ok(config as any));
      vi.mocked(createDatabase).mockReturnValue(ok(db as any));
      vi.mocked(runMigrations).mockReturnValue(ok(0));
      vi.mocked(createObservabilityService).mockResolvedValue(observability as any);

      // Override the PersonaLoader mock to make loadFromConfig fail.
      vi.mocked(PersonaLoader).mockImplementation(() => ({
        loadFromConfig: vi.fn().mockResolvedValue(err(new Error('persona parse error'))),
        getByName: vi.fn(),
      }) as any);

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Failed to load personas');
      expect(db.close).toHaveBeenCalledOnce();
      expect(observability.shutdown).toHaveBeenCalledOnce();
    });

    it('returns error when skill loading fails and closes db', async () => {
      const config = makeConfig();
      const db = makeMockDb();
      const observability = {
        observe: vi.fn(),
        observeWithTraceparent: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(loadConfig).mockReturnValue(ok(config as any));
      vi.mocked(createDatabase).mockReturnValue(ok(db as any));
      vi.mocked(runMigrations).mockReturnValue(ok(0));
      vi.mocked(createObservabilityService).mockResolvedValue(observability as any);

      // Restore PersonaLoader to success (may have been overridden by previous test).
      vi.mocked(PersonaLoader).mockImplementation(() => ({
        loadFromConfig: vi.fn().mockResolvedValue(ok(undefined)),
        getByName: vi.fn().mockReturnValue(ok({})),
      }) as any);

      // Override the SkillLoader mock to make loadFromPersonaConfig fail.
      vi.mocked(SkillLoader).mockImplementation(() => ({
        loadFromPersonaConfig: vi.fn().mockResolvedValue(err(new Error('skill manifest invalid'))),
      }) as any);

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Failed to load skills');
      expect(db.close).toHaveBeenCalledOnce();
      expect(observability.shutdown).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Successful bootstrap
  // -------------------------------------------------------------------------

  describe('successful bootstrap', () => {
    it('returns Ok(DaemonContext) with all fields populated', async () => {
      setupSuccessfulMocks();

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isOk()).toBe(true);
      const ctx = result._unsafeUnwrap();

      expect(ctx.db).toBeDefined();
      expect(ctx.config).toBeDefined();
      expect(ctx.configPath).toBe('/config.yaml');
      expect(ctx.dataDir).toBe('/tmp/test-data');
      expect(ctx.repos).toBeDefined();
      expect(ctx.repos.queue).toBeDefined();
      expect(ctx.repos.thread).toBeDefined();
      expect(ctx.repos.channel).toBeDefined();
      expect(ctx.repos.persona).toBeDefined();
      expect(ctx.repos.backgroundTask).toBeDefined();
      expect(ctx.repos.executionEnv).toBeDefined();
      expect(ctx.repos.executionEnvCheckpoint).toBeDefined();
      expect(ctx.repos.schedule).toBeDefined();
      expect(ctx.repos.audit).toBeDefined();
      expect(ctx.repos.message).toBeDefined();
      expect(ctx.repos.run).toBeDefined();
      expect(ctx.repos.binding).toBeDefined();
      expect(ctx.repos.memory).toBeDefined();
      expect(ctx.channelRegistry).toBeDefined();
      expect(ctx.queueManager).toBeDefined();
      expect(ctx.scheduler).toBeDefined();
      expect(ctx.personaLoader).toBeDefined();
      expect(ctx.sessionTracker).toBeDefined();
      expect(ctx.threadWorkspace).toBeDefined();
      expect(ctx.auditLogger).toBeDefined();
      expect(ctx.skillResolver).toBeDefined();
      expect(ctx.loadedSkills).toBeDefined();
      expect(ctx.hostToolsBridge).toBeDefined();
      expect(ctx.backgroundAgentManager).toBeDefined();
      expect(ctx.providerRegistry).toBeDefined();
      expect(ctx.observability).toBeDefined();
      expect(ctx.logger).toBeDefined();
    });

    it('normalizes dataDir to an absolute path before wiring runtime dependencies', async () => {
      setupSuccessfulMocks();
      vi.mocked(loadConfig).mockReturnValue(
        ok(
          makeConfig({
            dataDir: 'data',
            agentRunner: {
              defaultProvider: 'codex-cli',
              providers: {
                'codex-cli': {
                  ...makeAgentRunnerProviderConfig({
                    command: 'codex',
                    contextWindowTokens: 400000,
                    contextManagement: makeContextManagementConfig({
                      triggerMetric: 'input_tokens',
                      thresholdRatio: 0.8,
                    }),
                  }),
                  options: {
                    defaultModel: 'gpt-5.4',
                  },
                },
              },
            },
            backgroundAgent: {
              enabled: true,
              maxConcurrent: 3,
              defaultTimeoutMinutes: 30,
              defaultProvider: 'codex-cli',
              providers: {
                'codex-cli': {
                  ...makeBackgroundProviderConfig({
                    command: 'codex',
                    contextWindowTokens: 400000,
                  }),
                  options: {
                    defaultModel: 'gpt-5.4',
                  },
                },
              },
            },
          }) as any,
        ),
      );

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isOk()).toBe(true);
      const ctx = result._unsafeUnwrap();
      expect(ctx.dataDir.startsWith('/')).toBe(true);
      expect(ctx.dataDir.endsWith('/data')).toBe(true);
      expect(ctx.threadWorkspace.ensureDirectories('thread-abs')._unsafeUnwrap().startsWith('/')).toBe(true);
    });

    it('applies the configured log level during bootstrap', async () => {
      setupSuccessfulMocks();
      const configuredLogger = createDiscardLogger('info');
      vi.mocked(loadConfig).mockReturnValue(ok(makeConfig({ logLevel: 'debug' }) as any));

      const result = await bootstrap('/config.yaml', configuredLogger);

      expect(result.isOk()).toBe(true);
      expect(configuredLogger.level).toBe('debug');
    });

    it('creates the observability service from config and attaches it to the context', async () => {
      const { config, observability } = setupSuccessfulMocks();

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isOk()).toBe(true);
      // Bootstrap may augment langfuse config with auto-resolved release version (F9).
      // Use objectContaining to verify the base config is passed through unchanged.
      expect(createObservabilityService).toHaveBeenCalledWith(
        expect.objectContaining(config.langfuse as Record<string, unknown>),
        logger,
      );
      expect(result._unsafeUnwrap().observability).toBe(observability);
    });
    it('calls recoverFromCrash during bootstrap', async () => {
      setupSuccessfulMocks();

      await bootstrap('/config.yaml', logger);

      expect(recoverFromCrash).toHaveBeenCalledOnce();
    });

    it('creates HostToolsBridge and attaches it to context', async () => {
      setupSuccessfulMocks();

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isOk()).toBe(true);
      expect(HostToolsBridge).toHaveBeenCalledOnce();
      // Verify bridge was constructed with the context object.
      expect(HostToolsBridge).toHaveBeenCalledWith(
        expect.objectContaining({ dataDir: '/tmp/test-data' }),
      );
      const ctx = result._unsafeUnwrap();
      expect(ctx.hostToolsBridge).toBeDefined();
    });

    it('constructs background task persistence and background agent manager', async () => {
      setupSuccessfulMocks();

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isOk()).toBe(true);
      expect(BackgroundTaskRepository).toHaveBeenCalledOnce();
      expect(BackgroundAgentManager).toHaveBeenCalledWith(
        expect.objectContaining({
          repository: expect.anything(),
          queueManager: expect.anything(),
          maxConcurrent: 3,
          defaultTimeoutMinutes: 30,
          defaultProvider: 'claude-code',
          providerRegistry: expect.anything(),
        }),
      );
      expect(
        (vi.mocked(BackgroundAgentManager).mock.results[0]?.value as any).recoverOrphanedTasks,
      ).toHaveBeenCalledOnce();
    });

    it('wires ExecutionEnvManager when sprites are enabled', async () => {
      setupSuccessfulMocks();
      vi.mocked(loadConfig).mockReturnValue(
        ok(makeConfig({
          sprites: {
            enabled: true,
            token: 'sprites-token',
            apiBaseUrl: 'https://api.sprites.dev',
            workingDirectory: '/workspace',
            createTimeoutMs: 60000,
            execTimeoutMs: 1200000,
            autoDestroyOnCompletion: true,
            resourceLimits: { cpus: 2, memoryMb: 4096, diskGb: 20 },
          },
        }) as any),
      );

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().executionEnvManager).toBeDefined();
      expect(ExecutionEnvManager).toHaveBeenCalledWith(
        expect.objectContaining({
          repository: expect.anything(),
          checkpointRepository: expect.anything(),
          defaultWorkingDirectory: '/workspace',
          defaultExecTimeoutMs: 1200000,
        }),
      );
    });

    it('registers gemini-cli when enabled in provider config', async () => {
      setupSuccessfulMocks();
      vi.mocked(loadConfig).mockReturnValue(
        ok(
          makeConfig({
            agentRunner: {
              defaultProvider: 'gemini-cli',
              providers: {
                'claude-code': {
                  ...makeAgentRunnerProviderConfig(),
                },
                'gemini-cli': {
                  ...makeAgentRunnerProviderConfig({
                    command: 'gemini',
                    contextWindowTokens: 1000000,
                    contextManagement: makeContextManagementConfig({
                      triggerMetric: 'input_tokens',
                      thresholdRatio: 0.8,
                    }),
                  }),
                  options: {
                    defaultModel: 'gemini-2.5-pro',
                  },
                },
              },
            },
            backgroundAgent: {
              enabled: true,
              maxConcurrent: 3,
              defaultTimeoutMinutes: 30,
              defaultProvider: 'gemini-cli',
              providers: {
                'claude-code': {
                  ...makeBackgroundProviderConfig(),
                },
                'gemini-cli': {
                  ...makeBackgroundProviderConfig({
                    command: 'gemini',
                    contextWindowTokens: 1000000,
                  }),
                  options: {
                    defaultModel: 'gemini-2.5-pro',
                  },
                },
              },
            },
          }) as any,
        ),
      );

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isOk()).toBe(true);
      const ctx = result._unsafeUnwrap();
      expect(ctx.providerRegistry.get('gemini-cli')?.provider.name).toBe('gemini-cli');
      expect(ctx.providerRegistry.getDefault(['gemini-cli'])?.provider.name).toBe('gemini-cli');
      expect(BackgroundAgentManager).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: 'gemini-cli',
        }),
      );
    });

    it('registers codex-cli when enabled as the default provider in both registries', async () => {
      setupSuccessfulMocks();
      vi.mocked(loadConfig).mockReturnValue(
        ok(
          makeConfig({
            agentRunner: {
              defaultProvider: 'codex-cli',
              providers: {
                'claude-code': {
                  ...makeAgentRunnerProviderConfig(),
                },
                'codex-cli': {
                  ...makeAgentRunnerProviderConfig({
                    command: 'codex',
                    contextWindowTokens: 200000,
                    contextManagement: makeContextManagementConfig({
                      triggerMetric: 'input_tokens',
                      thresholdRatio: 0.6,
                    }),
                  }),
                  options: {
                    defaultModel: 'gpt-5-codex',
                  },
                },
              },
            },
            backgroundAgent: {
              enabled: true,
              maxConcurrent: 3,
              defaultTimeoutMinutes: 30,
              defaultProvider: 'codex-cli',
              providers: {
                'claude-code': {
                  ...makeBackgroundProviderConfig(),
                },
                'codex-cli': {
                  ...makeBackgroundProviderConfig({
                    command: 'codex',
                    contextWindowTokens: 200000,
                  }),
                  options: {
                    defaultModel: 'gpt-5-codex',
                  },
                },
              },
            },
          }) as any,
        ),
      );

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isOk()).toBe(true);
      const ctx = result._unsafeUnwrap();
      expect(ctx.providerRegistry.get('codex-cli')?.provider.name).toBe('codex-cli');
      expect(ctx.providerRegistry.getDefault(['codex-cli'])?.provider.name).toBe('codex-cli');

      const backgroundProviderRegistry = vi.mocked(BackgroundAgentManager).mock.calls[0]?.[0]
        .providerRegistry;
      expect(backgroundProviderRegistry.get('codex-cli')?.provider.name).toBe('codex-cli');
      expect(backgroundProviderRegistry.getDefault(['codex-cli'])?.provider.name).toBe('codex-cli');
      expect(BackgroundAgentManager).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: 'codex-cli',
        }),
      );
    });

    it('registers openai-compatible when enabled as the default provider in both registries', async () => {
      setupSuccessfulMocks();
      vi.mocked(loadConfig).mockReturnValue(
        ok(
          makeConfig({
            agentRunner: {
              defaultProvider: 'openai-compatible',
              providers: {
                'claude-code': {
                  ...makeAgentRunnerProviderConfig(),
                },
                'openai-compatible': {
                  ...makeAgentRunnerProviderConfig({
                    command: 'node',
                    contextWindowTokens: 256000,
                    contextManagement: makeContextManagementConfig({
                      triggerMetric: 'input_tokens',
                      thresholdRatio: 0.75,
                    }),
                  }),
                  options: {
                    defaultModel: 'qwen3-coder:30b',
                    baseUrl: 'http://127.0.0.1:11434/v1',
                  },
                },
              },
            },
            backgroundAgent: {
              enabled: true,
              maxConcurrent: 3,
              defaultTimeoutMinutes: 30,
              defaultProvider: 'openai-compatible',
              providers: {
                'claude-code': {
                  ...makeBackgroundProviderConfig(),
                },
                'openai-compatible': {
                  ...makeBackgroundProviderConfig({
                    command: 'node',
                    contextWindowTokens: 256000,
                  }),
                  options: {
                    defaultModel: 'qwen3-coder:30b',
                    baseUrl: 'http://127.0.0.1:11434/v1',
                  },
                },
              },
            },
          }) as any,
        ),
      );

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isOk()).toBe(true);
      const ctx = result._unsafeUnwrap();
      expect(ctx.providerRegistry.get('openai-compatible')?.provider.name).toBe(
        'openai-compatible',
      );
      expect(ctx.providerRegistry.getDefault(['openai-compatible'])?.provider.name).toBe(
        'openai-compatible',
      );

      const backgroundProviderRegistry = vi.mocked(BackgroundAgentManager).mock.calls[0]?.[0]
        .providerRegistry;
      expect(backgroundProviderRegistry.get('openai-compatible')?.provider.name).toBe(
        'openai-compatible',
      );
      expect(backgroundProviderRegistry.getDefault(['openai-compatible'])?.provider.name).toBe(
        'openai-compatible',
      );
      expect(BackgroundAgentManager).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: 'openai-compatible',
        }),
      );
    });

    it('passes auth.providers["openai-compatible"] credentials to the provider as runtime fallback', async () => {
      setupSuccessfulMocks();
      vi.mocked(loadConfig).mockReturnValue(
        ok(
          makeConfig({
            auth: {
              mode: 'subscription',
              providers: {
                'openai-compatible': {
                  apiKey: 'ollama-cloud-key',
                  baseURL: 'https://ollama.com/v1',
                },
              },
            },
            agentRunner: {
              defaultProvider: 'openai-compatible',
              providers: {
                'claude-code': {
                  ...makeAgentRunnerProviderConfig(),
                },
                // Intentionally omit options.baseUrl so the provider must
                // fall back to auth.providers['openai-compatible'].baseURL.
                'openai-compatible': {
                  ...makeAgentRunnerProviderConfig({
                    command: 'node',
                    contextWindowTokens: 256000,
                  }),
                  options: {
                    defaultModel: 'qwen3.5:cloud',
                    providerId: 'ollama',
                  },
                },
              },
            },
            backgroundAgent: {
              enabled: true,
              maxConcurrent: 3,
              defaultTimeoutMinutes: 30,
              defaultProvider: 'claude-code',
              providers: {
                'claude-code': {
                  ...makeBackgroundProviderConfig(),
                },
              },
            },
          }) as any,
        ),
      );

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isOk()).toBe(true);
      const ctx = result._unsafeUnwrap();
      const entry = ctx.providerRegistry.get('openai-compatible');
      expect(entry).toBeDefined();

      const prepared = entry!.provider.prepareBackgroundInvocation!({
        prompt: 'hello',
        systemPrompt: 'system',
        mcpServers: {},
        cwd: '/tmp',
        timeoutMs: 60_000,
        model: undefined,
      });

      expect(prepared.isOk()).toBe(true);
      const payload = JSON.parse(prepared._unsafeUnwrap().stdin!) as {
        baseUrl: string;
        apiKey: string;
      };
      expect(payload.baseUrl).toBe('https://ollama.com/v1');
      expect(payload.apiKey).toBe('ollama-cloud-key');
    });

    it('calls registerChannels during bootstrap', async () => {
      setupSuccessfulMocks();

      await bootstrap('/config.yaml', logger);

      expect(registerChannels).toHaveBeenCalledOnce();
    });

    it('binds the session summarizer with the manifest maxTokens budget', async () => {
      const summarizerRun = vi.fn().mockResolvedValue(ok({
        summary: 'Summarized.',
      }));

      vi.doMock('../../../src/subagents/subagent-loader.js', () => ({
        SubAgentLoader: vi.fn().mockImplementation(() => ({
          loadAll: vi.fn().mockImplementation(async (dir: string) => {
            if (dir.includes('subagents/default')) {
              return ok([
                {
                  manifest: {
                    name: 'session-summarizer',
                    version: '0.1.0',
                    description: 'Test summarizer',
                    model: {
                      provider: 'anthropic',
                      name: 'claude-sonnet-4-6',
                      maxTokens: 12345,
                    },
                    requiredCapabilities: [],
                    rootPaths: [],
                    timeoutMs: 30000,
                  },
                  promptContents: ['Summarize the transcript.'],
                  run: summarizerRun,
                  rootDir: '/tmp/session-summarizer',
                },
              ]);
            }
            return ok([]);
          }),
        })),
      }));
      vi.doMock('../../../src/subagents/model-resolver.js', () => ({
        ModelResolver: vi.fn().mockImplementation(() => ({
          resolve: vi.fn().mockReturnValue(ok({ provider: 'anthropic', model: 'resolved-model' })),
        })),
      }));
      vi.resetModules();

      try {
        const { loadConfig: isolatedLoadConfig } = await import('../../../src/core/config/config-loader.js');
        const { createDatabase: isolatedCreateDatabase } = await import('../../../src/core/database/connection.js');
        const { runMigrations: isolatedRunMigrations } = await import('../../../src/core/database/migrations/runner.js');
        const { createObservabilityService: isolatedCreateObservabilityService } = await import('../../../src/observability/langfuse/index.js');
        const { bootstrap: isolatedBootstrap } = await import('../../../src/daemon/daemon-bootstrap.js');

        const config = makeConfig();
        const db = makeMockDb();
        const observability = {
          observe: vi.fn(),
          observeWithTraceparent: vi.fn(),
          shutdown: vi.fn().mockResolvedValue(undefined),
        };

        vi.mocked(isolatedLoadConfig).mockReturnValue(ok(config as any));
        vi.mocked(isolatedCreateDatabase).mockReturnValue(ok(db as any));
        vi.mocked(isolatedRunMigrations).mockReturnValue(ok(1));
        vi.mocked(isolatedCreateObservabilityService).mockResolvedValue(observability as any);

        const result = await isolatedBootstrap('/config.yaml', logger);

        expect(result.isOk()).toBe(true);
        const ctx = result._unsafeUnwrap();
        expect(ctx.contextRoller).toBeTruthy();

        const boundSummarizer = (ctx.contextRoller as any).deps.summarizerRun as (
          threadId: string,
          personaId: string,
          input: { transcript: string },
        ) => Promise<unknown>;

        await boundSummarizer('thread-1', 'persona-1', { transcript: 'hello' });

        expect(summarizerRun).toHaveBeenCalledWith(
          expect.objectContaining({
            threadId: 'thread-1',
            personaId: 'persona-1',
            maxOutputTokens: 12345,
          }),
          { transcript: 'hello' },
        );
      } finally {
        vi.doUnmock('../../../src/subagents/subagent-loader.js');
        vi.doUnmock('../../../src/subagents/model-resolver.js');
        vi.resetModules();
      }
    });
  });
});
