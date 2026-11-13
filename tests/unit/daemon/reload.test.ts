/**
 * Unit tests for TalondDaemon hot-reload behaviour.
 *
 * Bootstrap is mocked to produce a DaemonContext. The reload path
 * calls loadConfig directly (not bootstrap), so we mock that too.
 * Focus is on config-diff detection and correct log output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err } from 'neverthrow';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../../src/daemon/daemon-bootstrap.js', () => ({
  bootstrap: vi.fn(),
}));

vi.mock('../../../src/core/config/config-loader.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../../src/daemon/lifecycle.js', () => ({
  recoverFromCrash: vi.fn().mockReturnValue(ok({ ordinaryReset: 0, interruptedInvocations: [] })),
  writePidFile: vi.fn(),
  removePidFile: vi.fn(),
}));

vi.mock('../../../src/channels/channel-setup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/channels/channel-setup.js')>()),
  registerChannels: vi.fn(),
  injectSiblingBotIds: vi.fn(),
  signalRepositoriesFor: vi.fn(() => ({ accounts: {}, leases: {} })),
}));

vi.mock('../../../src/skills/skill-loader.js', () => ({
  SkillLoader: vi.fn().mockImplementation(() => ({
    loadFromPersonaConfig: vi.fn().mockResolvedValue(ok([])),
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { TalondDaemon, RELOAD_RETRY_MS } from '../../../src/daemon/daemon.js';
import { bootstrap } from '../../../src/daemon/daemon-bootstrap.js';
import { loadConfig } from '../../../src/core/config/config-loader.js';
import { registerChannels } from '../../../src/channels/channel-setup.js';
import { ConfigError } from '../../../src/core/errors/index.js';
import type { DaemonContext } from '../../../src/daemon/daemon-context.js';
import { createDiscardLogger } from './helpers.js';
import { ChannelRegistry } from '../../../src/channels/channel-registry.js';
import { SignalConnector } from '../../../src/channels/connectors/signal/signal-connector.js';
import { SignalConfigSchema } from '../../../src/channels/connectors/signal/signal-config.js';
import { SignalDeviceRegistry } from '../../../src/channels/connectors/signal/signal-device-registry.js';
import { SignalVerificationError } from '../../../src/channels/connectors/signal/signal-account-verifier.js';
import { registerChannels, signalRepositoriesFor } from '../../../src/channels/channel-setup.js';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import pino from 'pino';
import { createTestDb } from '../core/database/repositories/helpers.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { RunRepository } from '../../../src/core/database/repositories/run-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { AuditRepository } from '../../../src/core/database/repositories/audit-repository.js';
import { BindingRepository } from '../../../src/core/database/repositories/binding-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { QueueManager } from '../../../src/queue/queue-manager.js';
import { AgentRunner } from '../../../src/daemon/agent-runner.js';
import { SignalInvocationGuard } from '../../../src/daemon/signal-invocation-guard.js';
import { SignalReplyDelivery } from '../../../src/daemon/signal-reply-delivery.js';
import { SignalToolExecutionRegistry } from '../../../src/tools/host-tools/signal-tool-execution.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): pino.Logger {
  return createDiscardLogger('silent');
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
    images: { maxInputBytes: 20_000_000, maxPerMessage: 5 },
    ...overrides,
  };
}

function makeMockContext(configOverrides: Record<string, unknown> = {}): DaemonContext {
  const config = makeConfig(configOverrides);
  return {
    db: { close: vi.fn() } as any,
    config: config as any,
    configPath: '/config.yaml',
    dataDir: '/tmp/test-data',
    repos: {
      queue: {} as any,
      thread: {} as any,
      channel: {} as any,
      persona: {} as any,
      backgroundTask: {} as any,
      schedule: {} as any,
      audit: {} as any,
      message: {} as any,
      run: { aggregateByPeriod: vi.fn().mockReturnValue(ok({ total_input_tokens: 0, total_output_tokens: 0, total_cost_usd: 0 })) } as any,
      binding: {} as any,
      memory: {} as any,
    },
    channelRegistry: {
      startAll: vi.fn().mockResolvedValue(undefined),
      stopAll: vi.fn().mockResolvedValue(undefined),
      listAll: vi.fn().mockReturnValue([]),
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn(),
    } as any,
    queueManager: {
      startProcessing: vi.fn(),
      stopProcessing: vi.fn(),
      stats: vi.fn().mockReturnValue({ pending: 0, claimed: 0, processing: 0, deadLetter: 0 }),
      quiesceClaims: vi.fn(),
      quiesceAndDrainClaims: vi.fn().mockResolvedValue(undefined),
      resumeClaims: vi.fn(),
    } as any,
    scheduler: { start: vi.fn(), stop: vi.fn() } as any,
    personaLoader: {
      loadFromConfig: vi.fn().mockResolvedValue(ok(undefined)),
    } as any,
    sessionTracker: { clearAll: vi.fn(), getSessionId: vi.fn(), setSessionId: vi.fn() } as any,
    threadWorkspace: {} as any,
    auditLogger: {} as any,
    skillResolver: {} as any,
    loadedSkills: [],
    messagePipeline: {} as any,
    backgroundAgentManager: { shutdown: vi.fn() } as any,
    contextAssembler: {} as any,
    hostToolsBridge: { path: '/tmp/host-tools.sock', start: vi.fn(), stop: vi.fn() } as any,
    imageStore: {} as any,
    imageIngestionCoordinator: {
      fenceAdmissions: vi.fn(),
      drainActiveIngestion: vi.fn().mockResolvedValue({ drained: 0, abandoned: 0 }),
      abandonActiveIngestion: vi.fn().mockResolvedValue({ retired: 0, stagingCleaned: 0, stagingFailed: 0 }),
    } as any,
    imageAccess: {} as any,
    imageLifecycle: {
      start: vi.fn().mockResolvedValue({ completed: true, timedOut: false, report: null }),
      stop: vi.fn().mockResolvedValue({ drained: true }),
    } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() } as any,
    // Partial mock: only the fields exercised by reload/start/stop paths are
    // populated; the assertion keeps the historical mock shape compiling.
  } as unknown as DaemonContext;
}

function setupSuccessfulStart(configOverrides: Record<string, unknown> = {}) {
  const ctx = makeMockContext(configOverrides);
  vi.mocked(bootstrap).mockResolvedValue(ok(ctx));
  return ctx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TalondDaemon.reload()', () => {
  let daemon: TalondDaemon;

  beforeEach(() => {
    daemon = new TalondDaemon(createSilentLogger());
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (daemon.state !== 'stopped') {
      await daemon.stop();
    }
  });

  // -------------------------------------------------------------------------
  // Guard conditions
  // -------------------------------------------------------------------------

  describe('guard conditions', () => {
    it('returns Err(DaemonError) when daemon is not running', async () => {
      const result = await daemon.reload('/config.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DAEMON_ERROR');
    });

    it('error message mentions current state', async () => {
      const result = await daemon.reload('/config.yaml');

      expect(result._unsafeUnwrapErr().message).toContain('stopped');
    });
  });

  // -------------------------------------------------------------------------
  // Config path resolution
  // -------------------------------------------------------------------------

  describe('config path resolution', () => {
    it('uses the provided configPath when given', async () => {
      setupSuccessfulStart();
      await daemon.start('/original.yaml');

      const newConfig = makeConfig();
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      await daemon.reload('/updated.yaml');

      expect(loadConfig).toHaveBeenCalledWith('/updated.yaml');
    });

    it('falls back to the startup configPath when no argument given', async () => {
      const ctx = setupSuccessfulStart();
      await daemon.start('/startup.yaml');

      const newConfig = makeConfig();
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      await daemon.reload();

      // configPath comes from the DaemonContext, which was set to '/config.yaml'
      expect(loadConfig).toHaveBeenCalledWith('/config.yaml');
    });

    it('returns Ok when configPath is omitted and startup path is known', async () => {
      setupSuccessfulStart();
      await daemon.start('/config.yaml');

      const newConfig = makeConfig();
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      const result = await daemon.reload();

      expect(result.isOk()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Config load failure
  // -------------------------------------------------------------------------

  describe('config load failure', () => {
    it('returns Err(DaemonError) when config re-read fails', async () => {
      setupSuccessfulStart();
      await daemon.start('/config.yaml');

      vi.mocked(loadConfig).mockReturnValue(err(new ConfigError('file not found')));

      const result = await daemon.reload('/bad.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DAEMON_ERROR');
    });

    it('error wraps the underlying ConfigError message', async () => {
      setupSuccessfulStart();
      await daemon.start('/config.yaml');

      vi.mocked(loadConfig).mockReturnValue(err(new ConfigError('YAML syntax error')));

      const result = await daemon.reload('/bad.yaml');

      expect(result._unsafeUnwrapErr().message).toContain('YAML syntax error');
    });

    it('does not change daemon state on config load failure', async () => {
      setupSuccessfulStart();
      await daemon.start('/config.yaml');

      vi.mocked(loadConfig).mockReturnValue(err(new ConfigError('fail')));
      await daemon.reload('/bad.yaml');

      expect(daemon.state).toBe('running');
    });
  });

  // -------------------------------------------------------------------------
  // Log level changes
  // -------------------------------------------------------------------------

  describe('images config', () => {
    const startupImages = {
      maxInputBytes: 10_485_760,
      maxPerMessage: 5,
      maxPerInspection: 5,
      maxEdge: 4096,
      jpegQuality: 85,
      retentionHours: 72,
    };

    it('keeps the running image limits for rebuilt connectors and warns', async () => {
      const ctx = setupSuccessfulStart({ images: startupImages });
      const logger = createDiscardLogger('silent');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');
      const warn = vi.spyOn(logger, 'warn');
      vi.mocked(registerChannels).mockClear();

      const changed = { ...startupImages, maxInputBytes: 20_971_520, maxPerMessage: 10 };
      vi.mocked(loadConfig).mockReturnValue(ok(makeConfig({ images: changed }) as any));

      const result = await localDaemon.reload('/config.yaml');
      expect(result.isOk()).toBe(true);

      const passed = vi.mocked(registerChannels).mock.calls[0]?.[0] as { images: unknown };
      expect(passed.images).toEqual(startupImages);
      expect((ctx.config as unknown as { images: unknown }).images).toEqual(startupImages);
      expect(
        warn.mock.calls.some(
          (args) => typeof args[0] === 'string' && args[0].includes('images config changed'),
        ),
      ).toBe(true);
      warn.mockRestore();

      await localDaemon.stop();
    });

    it('does not warn when images config is unchanged', async () => {
      setupSuccessfulStart({ images: startupImages });
      const logger = createDiscardLogger('silent');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');
      const warn = vi.spyOn(logger, 'warn');

      vi.mocked(loadConfig).mockReturnValue(
        ok(makeConfig({ images: { ...startupImages } }) as any),
      );
      await localDaemon.reload('/config.yaml');

      expect(
        warn.mock.calls.some(
          (args) => typeof args[0] === 'string' && args[0].includes('images config changed'),
        ),
      ).toBe(false);
      warn.mockRestore();
      await localDaemon.stop();
    });
  });

  describe('log level changes', () => {
    it('updates logger level when logLevel changes', async () => {
      setupSuccessfulStart({ logLevel: 'info' });
      const logger = createDiscardLogger('silent');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');

      const newConfig = makeConfig({ logLevel: 'debug' });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      await localDaemon.reload('/config.yaml');

      expect(logger.level).toBe('debug');

      await localDaemon.stop();
    });

    it('does not change logger level when logLevel is unchanged', async () => {
      setupSuccessfulStart({ logLevel: 'info' });
      const logger = createDiscardLogger('silent');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');

      const levelBeforeReload = logger.level;

      const newConfig = makeConfig({ logLevel: 'info' });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      await localDaemon.reload('/config.yaml');

      expect(logger.level).toBe(levelBeforeReload);

      await localDaemon.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Channel diff logging
  // -------------------------------------------------------------------------

  describe('channel diff logging', () => {
    it('logs added channels', async () => {
      setupSuccessfulStart({ channels: [] });
      const logger = createDiscardLogger('silent');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');
      const logSpy = vi.spyOn(logger, 'info');

      const newConfig = makeConfig({
        channels: [{ type: 'telegram', name: 'my-telegram', config: {}, enabled: true }],
      });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      await localDaemon.reload('/config.yaml');

      const calls = logSpy.mock.calls;
      const addedLog = calls.find(
        (args) =>
          typeof args[0] === 'object' &&
          args[0] !== null &&
          'added' in (args[0] as Record<string, unknown>) &&
          Array.isArray((args[0] as Record<string, unknown>).added) &&
          ((args[0] as Record<string, unknown>).added as string[]).includes('my-telegram'),
      );
      expect(addedLog).toBeDefined();

      logSpy.mockRestore();
      await localDaemon.stop();
    });

    it('logs removed channels', async () => {
      setupSuccessfulStart({
        channels: [{ type: 'telegram', name: 'old-channel', config: {}, enabled: true }],
      });
      const logger = createDiscardLogger('silent');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');
      const logSpy = vi.spyOn(logger, 'info');

      const newConfig = makeConfig({ channels: [] });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      await localDaemon.reload('/config.yaml');

      const calls = logSpy.mock.calls;
      const removedLog = calls.find(
        (args) =>
          typeof args[0] === 'object' &&
          args[0] !== null &&
          'removed' in (args[0] as Record<string, unknown>) &&
          Array.isArray((args[0] as Record<string, unknown>).removed) &&
          ((args[0] as Record<string, unknown>).removed as string[]).includes('old-channel'),
      );
      expect(removedLog).toBeDefined();

      logSpy.mockRestore();
      await localDaemon.stop();
    });

    it('does not log channel changes when channels are identical', async () => {
      const channels = [{ type: 'telegram', name: 'stable', config: {}, enabled: true }];
      setupSuccessfulStart({ channels });
      const logger = createDiscardLogger('silent');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');
      const logSpy = vi.spyOn(logger, 'info');

      const newConfig = makeConfig({ channels });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      await localDaemon.reload('/config.yaml');

      const calls = logSpy.mock.calls;
      const channelDiffLog = calls.find(
        (args) =>
          typeof args[0] === 'object' &&
          args[0] !== null &&
          ('added' in (args[0] as Record<string, unknown>) ||
            'removed' in (args[0] as Record<string, unknown>)),
      );
      expect(channelDiffLog).toBeUndefined();

      logSpy.mockRestore();
      await localDaemon.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Persona diff logging
  // -------------------------------------------------------------------------

  describe('persona diff logging', () => {
    it('logs added personas', async () => {
      setupSuccessfulStart({ personas: [] });
      const logger = createDiscardLogger('silent');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');
      const logSpy = vi.spyOn(logger, 'info');

      const newConfig = makeConfig({
        personas: [{ name: 'new-bot', model: 'claude-sonnet-4-6', skills: [], capabilities: { allow: [], requireApproval: [] }, mounts: [] }],
      });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      await localDaemon.reload('/config.yaml');

      const calls = logSpy.mock.calls;
      const addedLog = calls.find(
        (args) =>
          typeof args[0] === 'object' &&
          args[0] !== null &&
          'added' in (args[0] as Record<string, unknown>) &&
          Array.isArray((args[0] as Record<string, unknown>).added) &&
          ((args[0] as Record<string, unknown>).added as string[]).includes('new-bot'),
      );
      expect(addedLog).toBeDefined();

      logSpy.mockRestore();
      await localDaemon.stop();
    });

    it('logs removed personas', async () => {
      setupSuccessfulStart({
        personas: [{ name: 'old-bot', model: 'claude-sonnet-4-6', skills: [], capabilities: { allow: [], requireApproval: [] }, mounts: [] }],
      });
      const logger = createDiscardLogger('silent');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');
      const logSpy = vi.spyOn(logger, 'info');

      const newConfig = makeConfig({ personas: [] });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      await localDaemon.reload('/config.yaml');

      const calls = logSpy.mock.calls;
      const removedLog = calls.find(
        (args) =>
          typeof args[0] === 'object' &&
          args[0] !== null &&
          'removed' in (args[0] as Record<string, unknown>) &&
          Array.isArray((args[0] as Record<string, unknown>).removed) &&
          ((args[0] as Record<string, unknown>).removed as string[]).includes('old-bot'),
      );
      expect(removedLog).toBeDefined();

      logSpy.mockRestore();
      await localDaemon.stop();
    });

    it('logs changed personas', async () => {
      const persona = { name: 'agent', model: 'claude-sonnet-4-6', skills: [], capabilities: { allow: [], requireApproval: [] }, mounts: [] };
      setupSuccessfulStart({ personas: [persona] });
      const logger = createDiscardLogger('silent');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');
      const logSpy = vi.spyOn(logger, 'info');

      const newConfig = makeConfig({
        personas: [{ ...persona, model: 'claude-opus-4-6' }],
      });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      await localDaemon.reload('/config.yaml');

      const calls = logSpy.mock.calls;
      const changedLog = calls.find(
        (args) =>
          typeof args[0] === 'object' &&
          args[0] !== null &&
          'changed' in (args[0] as Record<string, unknown>) &&
          Array.isArray((args[0] as Record<string, unknown>).changed) &&
          ((args[0] as Record<string, unknown>).changed as string[]).includes('agent'),
      );
      expect(changedLog).toBeDefined();

      logSpy.mockRestore();
      await localDaemon.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Queue / scheduler config changes
  // -------------------------------------------------------------------------

  describe('queue / scheduler config changes', () => {
    it('logs a warning when queue config changes', async () => {
      setupSuccessfulStart({ queue: { maxAttempts: 3, backoffBaseMs: 1000, backoffMaxMs: 60000, concurrencyLimit: 2 } });
      const logger = createDiscardLogger('silent');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');
      const warnSpy = vi.spyOn(logger, 'warn');

      const newConfig = makeConfig({ queue: { maxAttempts: 5, backoffBaseMs: 1000, backoffMaxMs: 60000, concurrencyLimit: 2 } });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      await localDaemon.reload('/config.yaml');

      const warnCalls = warnSpy.mock.calls;
      const queueWarn = warnCalls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('queue config'),
      );
      expect(queueWarn).toBeDefined();

      warnSpy.mockRestore();
      await localDaemon.stop();
    });

    it('logs a warning when scheduler config changes', async () => {
      setupSuccessfulStart({ scheduler: { tickIntervalMs: 5000 } });
      const logger = createDiscardLogger('silent');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');
      const warnSpy = vi.spyOn(logger, 'warn');

      const newConfig = makeConfig({ scheduler: { tickIntervalMs: 10000 } });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      await localDaemon.reload('/config.yaml');

      const warnCalls = warnSpy.mock.calls;
      const schedulerWarn = warnCalls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('scheduler config'),
      );
      expect(schedulerWarn).toBeDefined();

      warnSpy.mockRestore();
      await localDaemon.stop();
    });

    it('logs a warning when subscription sub-agent configuration changes', async () => {
      setupSuccessfulStart();
      const logger = createDiscardLogger('silent');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');
      const warnSpy = vi.spyOn(logger, 'warn');

      vi.mocked(loadConfig).mockReturnValue(
        ok(
          makeConfig({
            subagentSandbox: {
              codex: {
                enabled: true,
                endpoint: 'http://codex-runner:9700',
                token: 't'.repeat(32),
                startupTimeoutMs: 30_000,
              },
            },
          }) as any,
        ),
      );

      await localDaemon.reload('/config.yaml');

      expect(
        warnSpy.mock.calls.some(
          (args) => typeof args[0] === 'string' && args[0].includes('subscription sub-agent'),
        ),
      ).toBe(true);

      warnSpy.mockRestore();
      await localDaemon.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Container image changes
  // -------------------------------------------------------------------------

  describe('container image changes', () => {
    it('logs a warning when the sandbox image changes', async () => {
      setupSuccessfulStart({
        sandbox: {
          runtime: 'docker',
          image: 'talon-sandbox:v1',
          maxConcurrent: 3,
          networkDefault: 'off',
          idleTimeoutMs: 1800000,
          hardTimeoutMs: 3600000,
          resourceLimits: { memoryMb: 1024, cpus: 1, pidsLimit: 256 },
        },
      });
      const logger = createDiscardLogger('silent');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');
      const warnSpy = vi.spyOn(logger, 'warn');

      const newConfig = makeConfig({
        sandbox: {
          runtime: 'docker',
          image: 'talon-sandbox:v2',
          maxConcurrent: 3,
          networkDefault: 'off',
          idleTimeoutMs: 1800000,
          hardTimeoutMs: 3600000,
          resourceLimits: { memoryMb: 1024, cpus: 1, pidsLimit: 256 },
        },
      });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      await localDaemon.reload('/config.yaml');

      const warnCalls = warnSpy.mock.calls;
      const imageWarn = warnCalls.find((args) => {
        if (typeof args[0] === 'object' && args[0] !== null) {
          const obj = args[0] as Record<string, unknown>;
          return 'from' in obj && 'to' in obj;
        }
        if (typeof args[1] === 'string') {
          return args[1].includes('container image');
        }
        return false;
      });
      expect(imageWarn).toBeDefined();

      warnSpy.mockRestore();
      await localDaemon.stop();
    });
  });

  // -------------------------------------------------------------------------
  // State invariants
  // -------------------------------------------------------------------------

  describe('state invariants', () => {
    it('daemon remains in running state after successful reload', async () => {
      setupSuccessfulStart();
      await daemon.start('/config.yaml');

      const newConfig = makeConfig();
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      await daemon.reload('/config.yaml');

      expect(daemon.state).toBe('running');
    });

    it('successive reloads are all successful', async () => {
      setupSuccessfulStart();
      await daemon.start('/config.yaml');

      for (let i = 0; i < 3; i++) {
        const newConfig = makeConfig({ logLevel: i % 2 === 0 ? 'info' : 'debug' });
        vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

        const result = await daemon.reload('/config.yaml');
        expect(result.isOk()).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // A2A agent-card registry
  // -------------------------------------------------------------------------

  describe('A2A agent-card registry', () => {
    const persona = (name: string) =>
      ({
        config: {
          name,
          model: 'm',
          skills: [],
          capabilities: { allow: [], requireApproval: [] },
        },
      }) as any;

    it('rebuilds the shared registry in place from the reloaded personas', async () => {
      const ctx = setupSuccessfulStart();
      const registry = new Map<string, any>([['old-persona', { id: 'old-persona' }]]);
      (ctx as any).a2aCardRegistry = registry;
      await daemon.start('/config.yaml');

      vi.mocked(ctx.personaLoader.loadFromConfig).mockResolvedValue(
        ok([persona('alpha'), persona('beta')]) as any,
      );
      vi.mocked(loadConfig).mockReturnValue(ok(makeConfig() as any));

      const result = await daemon.reload('/config.yaml');

      expect(result.isOk()).toBe(true);
      // Same Map instance, repopulated.
      expect((ctx as any).a2aCardRegistry).toBe(registry);
      expect([...registry.keys()].sort()).toEqual(['alpha', 'beta']);
      expect(registry.get('alpha').url).toBe('/a2a/agents/alpha');
    });

    it('runs the A2A reaper at startup and clears its timer on stop', async () => {
      const ctx = setupSuccessfulStart();
      const reapStaleTasks = vi.fn().mockReturnValue(ok([]));
      (ctx as any).a2aTaskMapper = { reapStaleTasks, setAbortHook: vi.fn() };
      await daemon.start('/config.yaml');
      expect(reapStaleTasks).toHaveBeenCalledTimes(1);
      await daemon.stop();
    });
  });
});

// ---------------------------------------------------------------------------
// Channel generation replacement through the real reload() entrypoint (mocked connectors)
// ---------------------------------------------------------------------------

describe('TalondDaemon.reload() channel generation replacement', () => {
  const accountUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
  const signalConfig = {
    name: 'signal-main',
    type: 'signal',
    enabled: true,
    config: {
      accountMode: 'dedicated',
      socketPath: '/run/talon-signal/bridge.sock',
      account: '+12025550123',
      accountUuid,
      deviceId: 1,
    },
  };

  let daemon: TalondDaemon;
  let events: string[];
  let registry: ChannelRegistry;
  let claimsOpen: boolean;
  let generations: number[];
  let ctx: DaemonContext;

  function signalConnector(): SignalConnector {
    const config = SignalConfigSchema.parse(signalConfig.config);
    const deviceRegistry = SignalDeviceRegistry.create(1, [config])._unsafeUnwrap();
    return new SignalConnector(config, 'signal-main', createSilentLogger(), {
      accounts: {} as never,
      leases: {} as never,
      queue: {} as never,
      registry: deviceRegistry,
    });
  }

  function currentSignal(): SignalConnector {
    const connector = registry.get('signal-main');
    if (!(connector instanceof SignalConnector)) throw new Error('no Signal connector');
    return connector;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    daemon = new TalondDaemon(createSilentLogger());
    events = [];
    claimsOpen = true;
    generations = [];
    registry = new ChannelRegistry(createSilentLogger());
    ctx = makeMockContext({ channels: [signalConfig] });
    (ctx as unknown as { channelRegistry: ChannelRegistry }).channelRegistry = registry;
    (ctx as unknown as { queueManager: unknown }).queueManager = {
      startProcessing: vi.fn(),
      stopProcessing: vi.fn(),
      stats: vi.fn().mockReturnValue({ pending: 0, claimed: 0, processing: 0, deadLetter: 0 }),
      quiesceClaims: vi.fn(() => { claimsOpen = false; events.push('quiesce'); }),
      quiesceAndDrainClaims: vi.fn(() => {
        events.push('drain-requested');
        return Promise.resolve();
      }),
      resumeClaims: vi.fn(() => { claimsOpen = true; events.push('resume'); }),
    };
    vi.mocked(bootstrap).mockResolvedValue(ok(ctx));
    vi.mocked(registerChannels).mockImplementation((config, channelRegistry, deps) => {
      generations.push(deps.signal?.generation ?? -1);
      events.push(`register:${deps.signal?.generation}`);
      for (const channel of config.channels) {
        if (channel.type === 'signal') channelRegistry.register(signalConnector());
      }
    });
    vi.mocked(loadConfig).mockReturnValue(ok(makeConfig({ channels: [signalConfig] }) as any));
    registry.register(signalConnector());
    await daemon.start('/config.yaml');
    events = [];
    generations = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (daemon.state !== 'stopped') await daemon.stop();
  });

  function stubStop(connector: SignalConnector, result: () => Promise<unknown>): void {
    vi.spyOn(connector, 'stopWithResult').mockImplementation(async () => {
      events.push('stop');
      return (await result()) as never;
    });
  }

  it('quiesces claims, stops old Signal connectors without waiting for dispatch, then registers and resumes', async () => {
    const old = currentSignal();
    stubStop(old, async () => ok(undefined));

    expect((await daemon.reload('/config.yaml')).isOk()).toBe(true);

    expect(events).toEqual(['quiesce', 'stop', 'register:2', 'resume']);
    expect(ctx.queueManager.quiesceAndDrainClaims).not.toHaveBeenCalled();
    expect(generations).toEqual([2]);
    expect(currentSignal()).not.toBe(old);
  });

  it('applies personas, skills and MCP only after the old Signal connectors stopped', async () => {
    const old = currentSignal();
    stubStop(old, async () => ok(undefined));
    vi.mocked(ctx.personaLoader.loadFromConfig).mockImplementation(async () => {
      events.push('personas');
      return ok(undefined) as never;
    });

    await daemon.reload('/config.yaml');

    expect(events.indexOf('stop')).toBeLessThan(events.indexOf('personas'));
    expect(events.indexOf('personas')).toBeLessThan(events.indexOf('register:2'));
  });

  it('repairs state writes and stops a Signal connector again before replacing it', async () => {
    const old = currentSignal();
    const stop = vi
      .spyOn(old, 'stopWithResult')
      .mockResolvedValueOnce(err(new SignalVerificationError('STOPPED')) as never)
      .mockResolvedValue(ok(undefined) as never);
    const repair = vi.spyOn(old, 'retryStateWrites').mockImplementation(() => {
      events.push('repair');
      return ok({ state: 'verified' }) as never;
    });

    const result = await daemon.reload('/config.yaml');

    expect(result.isOk()).toBe(true);
    expect(repair).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(events).toContain('register:2');
    expect(currentSignal()).not.toBe(old);
  });

  describe('a Signal connector that cannot stop cleanly', () => {
    it('reports the reload as pending, applies nothing global, keeps other connectors running and retries automatically', async () => {
      vi.useFakeTimers();
      const other = { name: 'telegram-main', type: 'telegram', start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };
      registry.register(other as never);
      const old = currentSignal();
      let healthy = false;
      const stop = vi.spyOn(old, 'stopWithResult').mockImplementation(async () =>
        healthy ? (ok(undefined) as never) : (err(new SignalVerificationError('STOPPED')) as never),
      );
      vi.spyOn(old, 'retryStateWrites').mockReturnValue(err(new SignalVerificationError('STOPPED')) as never);
      const configBefore = ctx.config;
      const skillsBefore = ctx.loadedSkills;

      const first = await daemon.reload('/config.yaml');

      expect(first.isErr()).toBe(true);
      expect(first._unsafeUnwrapErr().message).toContain('pending');
      expect(stop.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(other.stop).not.toHaveBeenCalled();
      expect(ctx.personaLoader.loadFromConfig).not.toHaveBeenCalled();
      expect(ctx.config).toBe(configBefore);
      expect(ctx.loadedSkills).toBe(skillsBefore);
      expect(registerChannels).not.toHaveBeenCalled();
      expect(claimsOpen).toBe(false);
      expect(currentSignal()).toBe(old);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      healthy = true;
      await vi.advanceTimersByTimeAsync(RELOAD_RETRY_MS);

      expect(registerChannels).toHaveBeenCalledOnce();
      expect(ctx.personaLoader.loadFromConfig).toHaveBeenCalledOnce();
      expect(claimsOpen).toBe(true);
      expect(currentSignal()).not.toBe(old);
      await daemon.stop();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels the automatic retry when the daemon stops', async () => {
      vi.useFakeTimers();
      const old = currentSignal();
      vi.spyOn(old, 'stopWithResult').mockResolvedValue(err(new SignalVerificationError('STOPPED')) as never);
      vi.spyOn(old, 'retryStateWrites').mockReturnValue(err(new SignalVerificationError('STOPPED')) as never);

      await daemon.reload('/config.yaml');
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await daemon.stop();

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('restores a working generation from the old config when personas fail after the Signal stop', async () => {
    const old = currentSignal();
    stubStop(old, async () => ok(undefined));
    vi.mocked(ctx.personaLoader.loadFromConfig).mockResolvedValue(err(new ConfigError('bad persona')) as never);
    const configBefore = ctx.config;

    const result = await daemon.reload('/config.yaml');

    expect(result.isErr()).toBe(true);
    expect(ctx.config).toBe(configBefore);
    expect(generations).toEqual([2]);
    expect(currentSignal()).not.toBe(old);
    expect(claimsOpen).toBe(true);
  });

  it('serializes concurrent reloads: generations never interleave and the later one replaces the earlier one cleanly', async () => {
    const first = currentSignal();
    let releaseFirstStop!: () => void;
    stubStop(first, () => new Promise((resolve) => { releaseFirstStop = () => resolve(ok(undefined)); }));
    const stopOfSecond = (): void => {
      const created = currentSignal();
      if (created !== first) stubStop(created, async () => ok(undefined));
    };
    vi.mocked(registerChannels).mockImplementation((config, channelRegistry, deps) => {
      events.push(`register:${deps.signal?.generation}`);
      for (const channel of config.channels) {
        if (channel.type === 'signal') channelRegistry.register(signalConnector());
      }
      stopOfSecond();
    });

    const one = daemon.reload('/config.yaml');
    const two = daemon.reload('/config.yaml');
    await vi.waitFor(() => expect(events).toContain('stop'));
    // The second reload has not started: no second quiesce/stop while the first is mid-drain.
    expect(events.filter((entry) => entry === 'stop')).toHaveLength(1);
    expect(events.filter((entry) => entry === 'quiesce')).toHaveLength(1);

    releaseFirstStop();
    expect((await one).isOk()).toBe(true);
    expect((await two).isOk()).toBe(true);

    const registered = events.filter((entry) => entry.startsWith('register:'));
    expect(registered).toEqual(['register:2', 'register:3']);
    expect(registry.listAll().filter((connector) => connector.name === 'signal-main')).toHaveLength(1);
    // The gen-2 connector (created by the first reload) was stopped by the second reload.
    expect(events.filter((entry) => entry === 'stop')).toHaveLength(2);
    expect(claimsOpen).toBe(true);
  });

  it('leaves no timers pending after a completed generation replacement', async () => {
    vi.useFakeTimers();
    const old = currentSignal();
    stubStop(old, async () => ok(undefined));

    expect((await daemon.reload('/config.yaml')).isOk()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Real QueueManager + real SignalConnector over a fake bridge socket, through the real reload()
// ---------------------------------------------------------------------------

describe('TalondDaemon with a real QueueManager and a fake-socket SignalConnector', () => {
  // Source-derived fake bridge replies (signal-cli v0.14.9): same contract fixtures as
  // tests/unit/channels/connectors/signal/signal-connector.test.ts and agent-runner.test.ts.
  const account = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const target = `signal:v1:${account}:self`;
  const logger = pino({ level: 'silent' });
  interface BridgeRequest {
    readonly id: string;
    readonly method: string;
    readonly params?: Record<string, unknown>;
  }

  let directory: string;
  let server: Server;
  let sockets: Socket[];
  let requests: BridgeRequest[];
  let holdSend: boolean;
  let heldSends: { request: BridgeRequest; socket: Socket }[];
  let db: ReturnType<typeof createTestDb>;
  let queue: QueueRepository;
  let queueManager: QueueManager;
  let registry: ChannelRegistry;
  let ctx: DaemonContext;
  let daemon: TalondDaemon;
  let signalChannel: { name: string; type: string; enabled: boolean; config: Record<string, unknown> };
  let dispatched: string[];
  let sequence: number;
  let runSpy: { mockRestore: () => void };

  function reply(socket: Socket, request: BridgeRequest, result: unknown): void {
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  }
  const success = {
    timestamp: 900,
    results: [{ type: 'SUCCESS', recipientAddress: { uuid: account, number: null, username: null } }],
  };
  async function finish<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    void promise.then(
      () => { done = true; },
      () => { done = true; },
    );
    for (let i = 0; i < 400 && !done; i++) {
      for (let j = 0; j < 10; j++) await new Promise<void>((resolve) => setImmediate(resolve));
      if (!done) await vi.advanceTimersByTimeAsync(1000);
    }
    expect(done).toBe(true);
    return promise;
  }
  async function untilTrue(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 2000 && !predicate(); i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(predicate()).toBe(true);
  }
  function currentSignal(): SignalConnector {
    const connector = registry.get('signal-test');
    if (!(connector instanceof SignalConnector)) throw new Error('no Signal connector');
    return connector;
  }
  function sends(): BridgeRequest[] {
    return requests.filter((request) => request.method === 'send');
  }
  function bodies(): string[] {
    return sends().map((request) => String(request.params?.message));
  }
  function deliveryContext(): { queueItemId: string; deliveryId: string; purpose: 'explicit' } {
    const id = ++sequence;
    const channelId = ctx.repos.channel.findByName('signal-test')._unsafeUnwrap()!.id;
    ctx.repos.thread
      .insert({ id: `thread-${id}`, channel_id: channelId, external_id: `fixture-${id}`, metadata: '{}' })
      ._unsafeUnwrap();
    queue
      .enqueue({ id: `delivery-queue-${id}`, thread_id: `thread-${id}`, message_id: null, type: 'message', payload: '{}', max_attempts: 3 })
      ._unsafeUnwrap();
    // Park the item so the real queue loop never claims it.
    db.prepare("UPDATE queue_items SET status = 'processing' WHERE id = ?").run(`delivery-queue-${id}`);
    return { queueItemId: `delivery-queue-${id}`, deliveryId: `delivery-${id}`, purpose: 'explicit' };
  }
  function enqueueOrdinary(id: string): void {
    const channelId = ctx.repos.channel.findByName('signal-test')._unsafeUnwrap()!.id;
    ctx.repos.thread
      .insert({ id: `thread-${id}`, channel_id: channelId, external_id: `ordinary-${id}`, metadata: '{}' })
      ._unsafeUnwrap();
    queue
      .enqueue({ id, thread_id: `thread-${id}`, message_id: null, type: 'message', payload: JSON.stringify({ personaId: 'persona', content: 'hi' }), max_attempts: 3 })
      ._unsafeUnwrap();
  }

  beforeEach(async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    });
    vi.setSystemTime(1_000_000);
    vi.clearAllMocks();
    const actual = await vi.importActual<typeof import('../../../src/channels/channel-setup.js')>(
      '../../../src/channels/channel-setup.js',
    );
    vi.mocked(registerChannels).mockImplementation(actual.registerChannels);
    vi.mocked(signalRepositoriesFor).mockImplementation(actual.signalRepositoriesFor);

    sequence = 0;
    sockets = [];
    requests = [];
    heldSends = [];
    holdSend = false;
    dispatched = [];
    directory = fs.mkdtempSync(join(homedir(), '.signal-reload-'));
    fs.chmodSync(directory, 0o700);
    const socketPath = join(directory, 'rpc.sock');
    server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString('utf8');
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const request = JSON.parse(buffer.slice(0, end)) as BridgeRequest;
          buffer = buffer.slice(end + 1);
          requests.push(request);
          if (request.method === 'version') reply(socket, request, { version: '0.14.9' });
          else if (request.method === 'listAccounts') reply(socket, request, [{ number: null, aci: account }]);
          else if (request.method === 'listDevices')
            reply(socket, request, [
              { id: 1, name: null, createdTimestamp: 100, lastSeenTimestamp: 500 },
              { id: 3, name: null, createdTimestamp: 200, lastSeenTimestamp: 500 },
            ]);
          else if (request.method === 'subscribeReceive') reply(socket, request, 7);
          else if (request.method === 'listContacts')
            reply(socket, request, [
              {
                uuid: (request.params?.recipient as string[])[0],
                isBlocked: false,
                unregistered: false,
                messageExpirationTime: 0,
              },
            ]);
          else if (request.method === 'send') {
            if (holdSend) heldSends.push({ request, socket });
            else reply(socket, request, success);
          } else reply(socket, request, {});
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    fs.chmodSync(socketPath, 0o600);

    db = createTestDb();
    queue = new QueueRepository(db);
    const threads = new ThreadRepository(db);
    const channels = new ChannelRepository(db);
    const runs = new RunRepository(db);
    signalChannel = {
      name: 'signal-test',
      type: 'signal',
      enabled: true,
      config: {
        accountMode: 'personal',
        socketPath,
        account,
        accountUuid: account,
        deviceId: 3,
        deviceCreatedTimestamp: 200,
        requestTimeoutMs: 120_000,
        allowedGroups: ['QQ=='],
      },
    };
    queueManager = new QueueManager(
      queue,
      threads,
      { maxAttempts: 3, backoffBaseMs: 1000, backoffMaxMs: 60_000, concurrencyLimit: 2 },
      logger,
    );
    registry = new ChannelRegistry(logger);
    const base = makeMockContext({ channels: [signalChannel] });
    const personas = new PersonaRepository(db);
    ctx = {
      ...base,
      personaLoader: {
        loadFromConfig: vi.fn().mockResolvedValue(ok(undefined)),
        getByName: vi.fn(),
      } as never,
      db,
      logger,
      channelRegistry: registry,
      queueManager,
      repos: {
        ...base.repos,
        queue,
        thread: threads,
        channel: channels,
        run: runs,
        message: new MessageRepository(db),
        audit: new AuditRepository(db),
        binding: new BindingRepository(db),
        persona: personas,
      },
      messagePipeline: {
        handleInboundEvent: vi.fn(),
        handleInboundEventWithReceipt: vi.fn(() => ok('accepted')),
      } as never,
      signalRuntime: {
        executions: new SignalToolExecutionRegistry({
          queue,
          runs,
          personas: { getByName: vi.fn() } as never,
        }),
        sealAndDrain: async () => ok(undefined),
      },
    };
    vi.mocked(bootstrap).mockResolvedValue(ok(ctx));
    vi.mocked(loadConfig).mockReturnValue(ok(ctx.config as never));
    // Ordinary work only records dispatch; no provider is ever reached by these tests.
    const realRun = AgentRunner.prototype.run;
    runSpy = vi.spyOn(AgentRunner.prototype, 'run').mockImplementation(async function (this: AgentRunner, item) {
      // Saved checkpoints take the real runner path (delivery-only); everything else is only recorded.
      if (item.id.startsWith('saved-')) return realRun.call(this, item);
      dispatched.push(item.id);
      return ok(undefined);
    });

    // Bootstrap's own registration of generation 1 through the real registerChannels.
    registerChannels(ctx.config, registry, {
      channelRepo: channels,
      bindingRepo: ctx.repos.binding,
      personaRepo: personas,
      messagePipeline: ctx.messagePipeline,
      logger,
      signal: { ...signalRepositoriesFor(db), queue, generation: 1 },
    });
    daemon = new TalondDaemon(logger);
    const started = daemon.start('/config.yaml');
    await finish(started);
    expect((await started).isOk()).toBe(true);
    await finish(
      (async () => {
        while (currentSignal().status().state !== 'ready')
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
      })(),
    );
  });

  afterEach(async () => {
    holdSend = false;
    for (const held of heldSends) held.socket.destroy();
    if (daemon.state !== 'stopped') await finish(daemon.stop());
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(vi.getTimerCount()).toBe(0);
    runSpy.mockRestore();
    vi.useRealTimers();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('delivers a deferred ready checkpoint through the real queue loop without invoking the provider', async () => {
    const channelId = ctx.repos.channel.findByName('signal-test')._unsafeUnwrap()!.id;
    ctx.repos.thread
      .insert({ id: 'saved-thread', channel_id: channelId, external_id: target, metadata: '{}' })
      ._unsafeUnwrap();
    queue
      .enqueue({
        id: 'saved-item',
        thread_id: 'saved-thread',
        message_id: null,
        type: 'collaboration',
        payload: JSON.stringify({
          personaId: 'persona',
          kind: 'background_task_notification',
          taskId: 'task-1',
          status: 'completed',
          content: 'saved reply text',
        }),
        max_attempts: 3,
      })
      ._unsafeUnwrap();
    const entry = SignalInvocationGuard.enter(queue, 'saved-item')._unsafeUnwrap();
    if (entry.kind !== 'execution') throw new Error('Expected issued guard');
    const checkpoint = await new SignalReplyDelivery({
      queue,
      audit: ctx.repos.audit,
      resolve: () => ok(currentSignal()),
      persist: () => ok(undefined),
    }).prepare(
      {
        queueItemId: 'saved-item',
        deliveryId: 'saved-delivery',
        threadId: 'saved-thread',
        personaId: 'persona',
        channelName: 'signal-test',
        accountUuid: account,
        destination: target,
        kind: 'background',
        body: 'saved reply text',
      },
      entry.guard,
    );
    entry.guard.close();
    expect(checkpoint._unsafeUnwrap().phase).toBe('ready');
    const execution = vi.spyOn(AgentRunner.prototype as never, 'runExecution');

    await finish(
      (async () => {
        while (queue.findById('saved-item')._unsafeUnwrap()?.status !== 'completed')
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
      })(),
    );

    expect(bodies()).toEqual(['saved reply text']);
    expect(execution).not.toHaveBeenCalled();
    expect(ctx.personaLoader.getByName).not.toHaveBeenCalled();
  });

  describe('reload while a Signal send RPC is active', () => {
    async function startActiveSend(): Promise<{ sent: ReturnType<SignalConnector['send']>; old: SignalConnector }> {
      holdSend = true;
      const old = currentSignal();
      const sent = old.send(target, { body: 'active text', trustedDelivery: deliveryContext() });
      await untilTrue(() => heldSends.length === 1);
      holdSend = false;
      return { sent, old };
    }

    it('drains a responding RPC before replacing the connector, leaves new work unwritten, then resumes without replay', async () => {
      const { sent, old } = await startActiveSend();
      enqueueOrdinary('new-work');

      let reloaded = false;
      const reloading = daemon.reload('/config.yaml').then((result) => {
        reloaded = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(old.status()).toMatchObject({ state: 'stopped', draining: true });
      expect(reloaded).toBe(false);
      // Claims are quiesced: the real loop dispatches nothing while the RPC drains.
      expect(dispatched).toEqual([]);
      expect(queue.findById('new-work')._unsafeUnwrap()?.status).toBe('pending');

      reply(heldSends[0]!.socket, heldSends[0]!.request, success);
      expect((await finish(reloading)).isOk()).toBe(true);
      expect((await sent).isOk()).toBe(true);

      const replacement = currentSignal();
      expect(replacement).not.toBe(old);
      await finish(
        (async () => {
          while (replacement.status().state !== 'ready')
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
        })(),
      );
      await finish(
        (async () => {
          while (!dispatched.includes('new-work'))
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
        })(),
      );
      const distinct = await finish(
        replacement.send(target, { body: 'distinct text', trustedDelivery: deliveryContext() }),
      );
      expect(distinct.isOk()).toBe(true);
      expect(bodies()).toEqual(['active text', 'distinct text']);
    });

    it('does not wait for active provider dispatch: only the send RPC is drained', async () => {
      const { sent } = await startActiveSend();
      let releaseProvider!: () => void;
      const runSpy = vi.mocked(AgentRunner.prototype.run);
      runSpy.mockImplementation(async (item) => {
        dispatched.push(item.id);
        await new Promise<void>((resolve) => { releaseProvider = resolve; });
        return ok(undefined);
      });
      enqueueOrdinary('slow-run');
      await finish(
        (async () => {
          while (!dispatched.includes('slow-run'))
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
        })(),
      );

      const reloading = daemon.reload('/config.yaml');
      reply(heldSends[0]!.socket, heldSends[0]!.request, success);
      const result = await finish(reloading);

      // The provider run is still active, and the reload finished anyway.
      expect(result.isOk()).toBe(true);
      expect((await sent).isOk()).toBe(true);
      releaseProvider();
    });

    it('forces UNKNOWN at the drain limit, fences the account automatically, then sends a distinct message with zero replay', async () => {
      const { sent, old } = await startActiveSend();

      const reloading = daemon.reload('/config.yaml');
      // The producer's drain forces UNKNOWN at its 30 s cap and returns Ok: reload proceeds.
      const result = await finish(reloading);
      expect(result.isOk()).toBe(true);
      const unknown = await sent;
      expect(unknown.isErr()).toBe(true);
      expect(unknown._unsafeUnwrapErr()).toMatchObject({ outcome: 'UNKNOWN' });
      expect(old.status().state).toBe('stopped');

      const replacement = currentSignal();
      expect(replacement).not.toBe(old);
      await finish(
        (async () => {
          while (replacement.status().state !== 'ready')
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
        })(),
      );
      // The automatic 60 s fence (no signal-resume) has elapsed by the time the replacement is Ready
      // or the distinct send waits it out; the distinct delivery succeeds.
      const distinct = await finish(
        replacement.send(target, { body: 'distinct text', trustedDelivery: deliveryContext() }),
      );
      expect(distinct.isOk()).toBe(true);
      expect(bodies()).toEqual(['active text', 'distinct text']);
      expect(bodies().filter((body) => body === 'active text')).toHaveLength(1);
    });
  });
});
