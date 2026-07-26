/**
 * Unit tests for TalondDaemon hot-reload behaviour.
 *
 * Bootstrap is mocked to produce a DaemonContext. The reload path
 * calls loadConfig directly (not bootstrap), so we mock that too.
 * Focus is on config-diff detection and correct log output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err } from 'neverthrow';
import type pino from 'pino';

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
  recoverFromCrash: vi.fn(),
  writePidFile: vi.fn(),
  removePidFile: vi.fn(),
}));

vi.mock('../../../src/channels/channel-setup.js', () => ({
  registerChannels: vi.fn(),
  injectSiblingBotIds: vi.fn(),
}));

vi.mock('../../../src/skills/skill-loader.js', () => ({
  SkillLoader: vi.fn().mockImplementation(() => ({
    loadFromPersonaConfig: vi.fn().mockResolvedValue(ok([])),
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { TalondDaemon } from '../../../src/daemon/daemon.js';
import { bootstrap } from '../../../src/daemon/daemon-bootstrap.js';
import { loadConfig } from '../../../src/core/config/config-loader.js';
import { ConfigError } from '../../../src/core/errors/index.js';
import type { DaemonContext } from '../../../src/daemon/daemon-context.js';
import { createDiscardLogger } from './helpers.js';

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
      run: {
        aggregateByPeriod: vi
          .fn()
          .mockReturnValue(
            ok({ total_input_tokens: 0, total_output_tokens: 0, total_cost_usd: 0 }),
          ),
      } as any,
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
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as any,
  };
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
  // Lifecycle config changes
  // -------------------------------------------------------------------------

  describe('lifecycle config changes', () => {
    it('rejects top-level lifecycle changes before applying any reload mutations', async () => {
      const ctx = setupSuccessfulStart({
        lifecycle: { enabled: true, handlers: [] },
      });
      await daemon.start('/config.yaml');

      const newConfig = makeConfig({
        logLevel: 'debug',
        lifecycle: { enabled: false, handlers: [] },
      });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      const result = await daemon.reload('/config.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('restart required');
      expect(ctx.personaLoader.loadFromConfig).not.toHaveBeenCalled();
      expect(ctx.channelRegistry.stopAll).not.toHaveBeenCalled();
      expect(ctx.config.logLevel).toBe('info');
    });

    it('rejects lifecycle handler identity/version changes before applying mutable reload work', async () => {
      const handler = {
        version: 'v1',
        id: 'retention-projector',
        displayName: 'Retention Projector',
        mode: 'event',
        inputContract: 'talon.lifecycle.event.envelope.v1',
        outputContract: 'talon.lifecycle.signal.envelopes.v1',
        runtime: {
          kind: 'native',
          ref: 'retention-projector',
          implementationVersion: '1.0.0',
        },
      };
      const ctx = setupSuccessfulStart({
        lifecycle: { enabled: true, handlers: [handler] },
      });
      await daemon.start('/config.yaml');

      const newConfig = makeConfig({
        logLevel: 'debug',
        lifecycle: {
          enabled: true,
          handlers: [
            {
              ...handler,
              displayName: 'Retention Projector v2',
              runtime: { ...handler.runtime, implementationVersion: '2.0.0' },
            },
          ],
        },
      });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      const result = await daemon.reload('/config.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('restart required');
      expect(ctx.personaLoader.loadFromConfig).not.toHaveBeenCalled();
      expect(ctx.channelRegistry.stopAll).not.toHaveBeenCalled();
      expect(ctx.config.logLevel).toBe('info');
    });

    it('rejects lifecycle retention policy changes before applying mutable reload work', async () => {
      const ctx = setupSuccessfulStart({
        lifecycle: {
          enabled: true,
          handlers: [],
          retention: { completedAuditWindowMs: 86_400_000 },
        },
      });
      await daemon.start('/config.yaml');

      const newConfig = makeConfig({
        logLevel: 'debug',
        lifecycle: {
          enabled: true,
          handlers: [],
          retention: { completedAuditWindowMs: 172_800_000 },
        },
      });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      const result = await daemon.reload('/config.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('restart required');
      expect(ctx.personaLoader.loadFromConfig).not.toHaveBeenCalled();
      expect(ctx.channelRegistry.stopAll).not.toHaveBeenCalled();
      expect(ctx.config.lifecycle).toEqual({
        enabled: true,
        handlers: [],
        retention: { completedAuditWindowMs: 86_400_000 },
      });
    });

    it('rejects persona lifecycle subscription changes before reloading personas', async () => {
      const oldSubscription = {
        handler: 'audit-handler',
        subscription: { eventTypes: ['message.received'] },
      };
      const newSubscription = {
        handler: 'audit-handler',
        subscription: { eventTypes: ['message.completed'] },
      };
      const persona = {
        name: 'observer',
        model: 'claude-sonnet-4-6',
        skills: [],
        capabilities: { allow: [], requireApproval: [] },
        mounts: [],
        lifecycle: { subscriptions: [oldSubscription] },
      };
      const ctx = setupSuccessfulStart({
        lifecycle: { enabled: true, handlers: [] },
        personas: [persona],
      });
      await daemon.start('/config.yaml');

      const newConfig = makeConfig({
        lifecycle: { enabled: true, handlers: [] },
        personas: [
          {
            ...persona,
            lifecycle: { subscriptions: [newSubscription] },
          },
        ],
      });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      const result = await daemon.reload('/config.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('lifecycle-attached persona');
      expect(ctx.personaLoader.loadFromConfig).not.toHaveBeenCalled();
      expect(ctx.config.personas).toEqual([persona]);
    });

    it.each([
      {
        description: 'sub-agent assignment',
        change: { subagents: [] },
      },
      {
        description: 'capability policy',
        change: { capabilities: { allow: [], requireApproval: ['tools.read:*'] } },
      },
    ])(
      'rejects lifecycle-attached persona $description changes before reloading personas',
      async ({ change }) => {
        const persona = {
          name: 'observer',
          model: 'claude-sonnet-4-6',
          skills: [],
          subagents: ['lifecycle-auditor'],
          capabilities: { allow: ['tools.read:*'], requireApproval: [] },
          mounts: [],
          lifecycle: {
            subscriptions: [
              {
                handler: 'audit-handler',
                subscription: { eventTypes: ['message.received'] },
              },
            ],
          },
        };
        const ctx = setupSuccessfulStart({ personas: [persona] });
        await daemon.start('/config.yaml');

        const newConfig = makeConfig({
          personas: [{ ...persona, ...change }],
        });
        vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

        const result = await daemon.reload('/config.yaml');

        expect(result.isErr()).toBe(true);
        expect(result._unsafeUnwrapErr().message).toContain('restart required');
        expect(ctx.personaLoader.loadFromConfig).not.toHaveBeenCalled();
        expect(ctx.config.personas).toEqual([persona]);
      },
    );

    it('allows ordinary persona changes when lifecycle attachments are unchanged', async () => {
      const lifecycle = { subscriptions: [] };
      const persona = {
        name: 'assistant',
        model: 'claude-sonnet-4-6',
        skills: [],
        capabilities: { allow: [], requireApproval: [] },
        mounts: [],
        lifecycle,
      };
      const ctx = setupSuccessfulStart({ personas: [persona] });
      await daemon.start('/config.yaml');

      const newConfig = makeConfig({
        personas: [{ ...persona, model: 'claude-opus-4-6' }],
      });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as any));

      const result = await daemon.reload('/config.yaml');

      expect(result.isOk()).toBe(true);
      expect(ctx.personaLoader.loadFromConfig).toHaveBeenCalledWith(newConfig.personas);
    });
  });

  // -------------------------------------------------------------------------
  // Log level changes
  // -------------------------------------------------------------------------

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
        personas: [
          {
            name: 'new-bot',
            model: 'claude-sonnet-4-6',
            skills: [],
            capabilities: { allow: [], requireApproval: [] },
            mounts: [],
          },
        ],
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
        personas: [
          {
            name: 'old-bot',
            model: 'claude-sonnet-4-6',
            skills: [],
            capabilities: { allow: [], requireApproval: [] },
            mounts: [],
          },
        ],
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
      const persona = {
        name: 'agent',
        model: 'claude-sonnet-4-6',
        skills: [],
        capabilities: { allow: [], requireApproval: [] },
        mounts: [],
      };
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
      setupSuccessfulStart({
        queue: { maxAttempts: 3, backoffBaseMs: 1000, backoffMaxMs: 60000, concurrencyLimit: 2 },
      });
      const logger = createDiscardLogger('silent');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');
      const warnSpy = vi.spyOn(logger, 'warn');

      const newConfig = makeConfig({
        queue: { maxAttempts: 5, backoffBaseMs: 1000, backoffMaxMs: 60000, concurrencyLimit: 2 },
      });
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
});
