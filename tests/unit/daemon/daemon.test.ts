/**
 * Unit tests for TalondDaemon lifecycle.
 *
 * The daemon now delegates setup to bootstrap(), so tests mock that
 * module rather than individual subsystems. State transitions, health
 * reporting, and idempotency behaviours are verified.
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

vi.mock('../../../src/subagents/codex-sandbox-runner-readiness.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/subagents/codex-sandbox-runner-readiness.js')
    >();
  return { ...actual, waitForCodexSandboxRunner: vi.fn() };
});

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
import { writePidFile, removePidFile } from '../../../src/daemon/lifecycle.js';
import { injectSiblingBotIds } from '../../../src/channels/channel-setup.js';
import { DaemonError } from '../../../src/core/errors/index.js';
import {
  CodexSandboxRunnerReadinessError,
  waitForCodexSandboxRunner,
} from '../../../src/subagents/codex-sandbox-runner-readiness.js';
import type { DaemonContext } from '../../../src/daemon/daemon-context.js';
import { createDiscardLogger } from './helpers.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): pino.Logger {
  return createDiscardLogger('silent');
}

/**
 * Creates a mock DaemonContext with all required fields.
 */
function makeMockContext(overrides: Partial<DaemonContext> = {}): DaemonContext {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };

  return {
    db: { close: vi.fn() } as any,
    config: {
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
      subagentSandbox: {
        codex: {
          enabled: false,
          endpoint: 'http://codex-runner:9700',
          startupTimeoutMs: 30000,
        },
      },
    } as any,
    configPath: '/etc/talond/config.yaml',
    dataDir: '/tmp/test-data',
    repos: {
      queue: {} as any,
      thread: {} as any,
      channel: {} as any,
      persona: {} as any,
      backgroundTask: {} as any,
      executionEnv: {} as any,
      executionEnvCheckpoint: {} as any,
      schedule: {} as any,
      audit: {} as any,
      message: {} as any,
      run: { aggregateByPeriod: vi.fn().mockReturnValue(ok({ total_input_tokens: 0, total_output_tokens: 0, total_cost_usd: 0 })) } as any,
      binding: {} as any,
      memory: {} as any,
      a2aTask: {} as any,
      image: {} as any,
      imageIngestion: {} as any,
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
    scheduler: {
      start: vi.fn(),
      stop: vi.fn(),
    } as any,
    personaLoader: {
      loadFromConfig: vi.fn().mockResolvedValue(ok(undefined)),
    } as any,
    // Required by DaemonContext; the start/stop tests never resolve a provider.
    providerRegistry: {} as any,
    sessionTracker: {
      clearAll: vi.fn(),
      getSessionId: vi.fn(),
      setSessionId: vi.fn(),
    } as any,
    threadWorkspace: {} as any,
    auditLogger: {} as any,
    skillResolver: {} as any,
    loadedSkills: [],
    messagePipeline: {} as any,
    backgroundAgentManager: {
      shutdown: vi.fn(),
    } as any,
    contextAssembler: {} as any,
    observability: {
      shutdown: vi.fn().mockResolvedValue(undefined),
      observe: vi.fn(),
      observeWithTraceparent: vi.fn(),
    } as any,
    hostToolsBridge: { path: '/tmp/host-tools.sock', start: vi.fn(), stop: vi.fn() } as any,
    oauthTokenStore: {} as any,
    a2aServer: null,
    a2aTaskMapper: null,
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
    logger: mockLogger as any,
    ...overrides,
    // The overrides spread widens required properties to `| undefined` under
    // exactOptionalPropertyTypes; callers always pass well-formed overrides.
  } as unknown as DaemonContext;
}

/**
 * Sets up bootstrap mock to return a successful context.
 * Returns the mock context for assertions.
 */
function setupSuccessfulBootstrap(overrides: Partial<DaemonContext> = {}) {
  const ctx = makeMockContext(overrides);
  vi.mocked(bootstrap).mockResolvedValue(ok(ctx));
  return ctx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TalondDaemon', () => {
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
  // Initial state
  // -------------------------------------------------------------------------

  describe('initial state', () => {
    it('starts in the stopped state', () => {
      expect(daemon.state).toBe('stopped');
    });

    it('health() returns stopped state with zero values', () => {
      const health = daemon.health();
      expect(health.state).toBe('stopped');
      expect(health.uptime).toBe(0);
      expect(health.activeChannels).toEqual([]);
      expect(health.schedulerRunning).toBe(false);
      expect(health.queueStats).toEqual({
        pending: 0,
        claimed: 0,
        processing: 0,
        deadLetter: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Successful startup
  // -------------------------------------------------------------------------

  describe('start()', () => {
    it('returns Ok(void) on successful startup', async () => {
      setupSuccessfulBootstrap();

      const result = await daemon.start('/etc/talond/config.yaml');

      expect(result.isOk()).toBe(true);
    });

    it('transitions state to running after successful start', async () => {
      setupSuccessfulBootstrap();

      await daemon.start('/etc/talond/config.yaml');

      expect(daemon.state).toBe('running');
    });

    it('calls bootstrap with the provided config path', async () => {
      setupSuccessfulBootstrap();

      await daemon.start('/custom/path.yaml');

      expect(bootstrap).toHaveBeenCalledWith('/custom/path.yaml', expect.anything());
    });

    it('starts channel connectors after bootstrap', async () => {
      const ctx = setupSuccessfulBootstrap();

      await daemon.start('/config.yaml');

      expect(ctx.channelRegistry.startAll).toHaveBeenCalledOnce();
    });

    it('starts the image lifecycle before any channel connector starts', async () => {
      const ctx = setupSuccessfulBootstrap();

      await daemon.start('/config.yaml');

      expect(ctx.imageLifecycle.start).toHaveBeenCalledOnce();
      // Recovery must see crash leftovers before new admissions arrive.
      expect(vi.mocked(ctx.imageLifecycle.start).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(ctx.channelRegistry.startAll).mock.invocationCallOrder[0],
      );
    });

    it('does not start channel connectors until image startup recovery settles', async () => {
      // P1-1: invocation order alone is not enough — the daemon must AWAIT
      // the startup pass, so channels cannot admit events while recovery is
      // still resolving crash leftovers.
      let resolveStartup: ((value: unknown) => void) | null = null;
      const imageLifecycle = {
        start: vi.fn().mockReturnValue(
          new Promise((resolve) => {
            resolveStartup = resolve;
          }),
        ),
        stop: vi.fn().mockResolvedValue({ drained: true }),
      } as any;
      const ctx = setupSuccessfulBootstrap({ imageLifecycle });

      const starting = daemon.start('/config.yaml');
      await vi.waitFor(() => expect(imageLifecycle.start).toHaveBeenCalledOnce());
      await Promise.resolve();

      // Recovery was invoked but has NOT settled: no channel may accept
      // image-bearing events yet.
      expect(resolveStartup).not.toBeNull();
      expect(ctx.channelRegistry.startAll).not.toHaveBeenCalled();

      resolveStartup!({ completed: true, timedOut: false, report: null });
      const result = await starting;

      expect(result.isOk()).toBe(true);
      expect(ctx.channelRegistry.startAll).toHaveBeenCalledOnce();
    });

    it('fails the boot closed when startup recovery times out', async () => {
      // F1: a wedged startup recovery must NEVER start channels. The
      // daemon retires the outstanding image work (fence admissions,
      // bounded sweep stop, bounded delivery drain) and aborts the boot
      // with a startup error before channelRegistry.startAll().
      const imageLifecycle = {
        start: vi
          .fn()
          .mockResolvedValue({ completed: false, timedOut: true, report: null }),
        stop: vi.fn().mockResolvedValue({ drained: false }),
      } as any;
      const ctx = setupSuccessfulBootstrap({ imageLifecycle });

      const result = await daemon.start('/config.yaml');

      expect(result.isOk()).toBe(false);
      // The boot gate is fail-closed: no channel connector starts while
      // image startup recovery is outstanding.
      expect(ctx.channelRegistry.startAll).not.toHaveBeenCalled();
      // Outstanding work was retired safely before teardown.
      expect(ctx.imageIngestionCoordinator.fenceAdmissions).toHaveBeenCalledOnce();
      expect(imageLifecycle.stop).toHaveBeenCalledOnce();
      expect(ctx.imageIngestionCoordinator.drainActiveIngestion).toHaveBeenCalledOnce();
      // R1: retirement runs UNCONDITIONALLY — the wedged startup recovery
      // is not tracked in activeDeliveries, so the drain reported
      // abandoned: 0 and the retire step may still not be skipped. It
      // must complete before the database closes.
      expect(ctx.imageIngestionCoordinator.abandonActiveIngestion).toHaveBeenCalledOnce();
      expect(
        ctx.imageIngestionCoordinator.abandonActiveIngestion.mock.invocationCallOrder[0],
      ).toBeLessThan(ctx.db.close.mock.invocationCallOrder[0]);
      // Resources taken before the gate are released and the DB closed.
      expect(ctx.hostToolsBridge.stop).toHaveBeenCalled();
      expect(ctx.db.close).toHaveBeenCalledOnce();
    });

    it('injects sibling bot IDs after starting channel connectors', async () => {
      setupSuccessfulBootstrap();

      await daemon.start('/config.yaml');

      expect(injectSiblingBotIds).toHaveBeenCalledOnce();
    });

    it('starts queue processing after bootstrap', async () => {
      const ctx = setupSuccessfulBootstrap();

      await daemon.start('/config.yaml');

      expect(ctx.queueManager.startProcessing).toHaveBeenCalledOnce();
    });

    it('starts scheduler after bootstrap', async () => {
      const ctx = setupSuccessfulBootstrap();

      await daemon.start('/config.yaml');

      expect(ctx.scheduler.start).toHaveBeenCalledOnce();
    });

    it('writes the PID file on successful start', async () => {
      setupSuccessfulBootstrap();

      await daemon.start('/config.yaml');

      expect(writePidFile).toHaveBeenCalledWith('/tmp/test-data');
    });

    it('health() shows running state and positive uptime after start', async () => {
      setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');

      const health = daemon.health();
      expect(health.state).toBe('running');
      expect(health.uptime).toBeGreaterThanOrEqual(0);
      expect(health.schedulerRunning).toBe(true);
    });
    it('applies the configured log level on initial start', async () => {
      setupSuccessfulBootstrap({
        config: {
          logLevel: 'debug',
        } as any,
      });
      const logger = createDiscardLogger('info');
      const localDaemon = new TalondDaemon(logger);

      await localDaemon.start('/config.yaml');

      expect(logger.level).toBe('debug');

      await localDaemon.stop();
    });

    it('waits for an enabled Codex runner before starting channels or queue work', async () => {
      const ctx = setupSuccessfulBootstrap({
        config: {
          ...makeMockContext().config,
          subagentSandbox: {
            codex: {
              enabled: true,
              endpoint: 'http://codex-runner:9700',
              token: 't'.repeat(32),
              startupTimeoutMs: 30000,
            },
          },
        } as any,
      });
      vi.mocked(waitForCodexSandboxRunner).mockResolvedValue(ok(undefined));

      const result = await daemon.start('/config.yaml');

      expect(result.isOk()).toBe(true);
      expect(waitForCodexSandboxRunner).toHaveBeenCalledWith({
        endpoint: 'http://codex-runner:9700',
        token: 't'.repeat(32),
        startupTimeoutMs: 30000,
      });
      expect(ctx.channelRegistry.startAll).toHaveBeenCalledOnce();
      expect(ctx.queueManager.startProcessing).toHaveBeenCalledOnce();
    });

    it('can keep the startup logger from writing to stdout when log level changes', async () => {
      setupSuccessfulBootstrap({
        config: {
          logLevel: 'debug',
        } as any,
      });
      const stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as any);
      const logger = createDiscardLogger('info');
      const localDaemon = new TalondDaemon(logger);

      await localDaemon.start('/config.yaml');

      expect(stdoutWriteSpy).not.toHaveBeenCalled();

      await localDaemon.stop();
      stdoutWriteSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Startup failure scenarios
  // -------------------------------------------------------------------------

  describe('start() failure scenarios', () => {
    it('returns Err(DaemonError) when bootstrap fails', async () => {
      vi.mocked(bootstrap).mockResolvedValue(
        err(new DaemonError('Failed to load config: config file not found')),
      );

      const result = await daemon.start('/missing.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DAEMON_ERROR');
      expect(result._unsafeUnwrapErr().message).toContain('config file not found');
    });

    it('transitions state to error when bootstrap fails', async () => {
      vi.mocked(bootstrap).mockResolvedValue(
        err(new DaemonError('bootstrap failure')),
      );

      await daemon.start('/bad.yaml');

      expect(daemon.state).toBe('error');
    });

    it('stops startup before channels or queue work when the enabled Codex runner is unavailable', async () => {
      const ctx = setupSuccessfulBootstrap({
        config: {
          ...makeMockContext().config,
          subagentSandbox: {
            codex: {
              enabled: true,
              endpoint: 'http://codex-runner:9700',
              token: 't'.repeat(32),
              startupTimeoutMs: 30000,
            },
          },
        } as any,
      });
      vi.mocked(waitForCodexSandboxRunner).mockResolvedValue(
        err(new CodexSandboxRunnerReadinessError('runner unavailable')),
      );

      const result = await daemon.start('/config.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('runner unavailable');
      expect(daemon.state).toBe('error');
      expect(ctx.channelRegistry.startAll).not.toHaveBeenCalled();
      expect(ctx.queueManager.startProcessing).not.toHaveBeenCalled();
      expect(ctx.db.close).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Double-start idempotency
  // -------------------------------------------------------------------------

  describe('double-start idempotency', () => {
    it('returns Err(DaemonError) if start() is called while already running', async () => {
      setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');

      const result = await daemon.start('/config.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DAEMON_ERROR');
    });

    it('does not change state on a rejected second start', async () => {
      setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');

      await daemon.start('/config.yaml');

      expect(daemon.state).toBe('running');
    });
  });

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  describe('stop()', () => {
    it('transitions state to stopped after shutdown', async () => {
      setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');

      await daemon.stop();

      expect(daemon.state).toBe('stopped');
    });

    it('closes the database during shutdown', async () => {
      const ctx = setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');

      await daemon.stop();

      expect(ctx.db.close).toHaveBeenCalledOnce();
    });

    it('removes the PID file during shutdown', async () => {
      setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');

      await daemon.stop();

      expect(removePidFile).toHaveBeenCalledWith('/tmp/test-data');
    });

    it('stops channel connectors during shutdown', async () => {
      const ctx = setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');

      await daemon.stop();

      expect(ctx.channelRegistry.stopAll).toHaveBeenCalledOnce();
    });

    it('stops scheduler during shutdown', async () => {
      const ctx = setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');

      await daemon.stop();

      expect(ctx.scheduler.stop).toHaveBeenCalledOnce();
    });

    it('stops queue processing during shutdown', async () => {
      const ctx = setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');

      await daemon.stop();

      expect(ctx.queueManager.stopProcessing).toHaveBeenCalledOnce();
    });

    it('shuts down the background agent manager before closing the database', async () => {
      const backgroundAgentManager = { shutdown: vi.fn() } as any;
      const db = { close: vi.fn() } as any;
      const ctx = setupSuccessfulBootstrap({ backgroundAgentManager, db });
      await daemon.start('/config.yaml');

      await daemon.stop();

      expect(backgroundAgentManager.shutdown).toHaveBeenCalledOnce();
      expect(backgroundAgentManager.shutdown.mock.invocationCallOrder[0]).toBeLessThan(
        db.close.mock.invocationCallOrder[0],
      );
    });

    it('flushes observability before closing the database', async () => {
      const observability = { shutdown: vi.fn().mockResolvedValue(undefined) } as any;
      const db = { close: vi.fn() } as any;
      setupSuccessfulBootstrap({ observability, db });
      await daemon.start('/config.yaml');

      await daemon.stop();

      expect(observability.shutdown).toHaveBeenCalledOnce();
      expect(observability.shutdown.mock.invocationCallOrder[0]).toBeLessThan(
        db.close.mock.invocationCallOrder[0],
      );
    });

    it('drains the image lifecycle before closing the database', async () => {
      const imageLifecycle = {
        start: vi.fn().mockResolvedValue({ completed: true, timedOut: false, report: null }),
        stop: vi.fn().mockResolvedValue({ drained: true }),
      } as any;
      const db = { close: vi.fn() } as any;
      const ctx = setupSuccessfulBootstrap({ imageLifecycle, db });
      await daemon.start('/config.yaml');

      await daemon.stop();

      expect(imageLifecycle.stop).toHaveBeenCalledOnce();
      // No image sweep may write through a closed database.
      expect(imageLifecycle.stop.mock.invocationCallOrder[0]).toBeLessThan(
        db.close.mock.invocationCallOrder[0],
      );
      // Channels stop first so no new admissions race the final drain.
      expect(vi.mocked(ctx.channelRegistry.stopAll).mock.invocationCallOrder[0]).toBeLessThan(
        imageLifecycle.stop.mock.invocationCallOrder[0],
      );
    });

    it('fences admissions and drains active ingestion before closing the database', async () => {
      // P1-2: shutdown must fence new image admissions and AWAIT in-flight
      // ingestion (admission → publication → commit-together enqueue) —
      // not just lifecycle sweeps — before db.close().
      const order: string[] = [];
      let releaseDrain: (() => void) | null = null;
      const drainGate = new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
      const imageIngestionCoordinator = {
        fenceAdmissions: vi.fn(() => {
          order.push('fence');
        }),
        drainActiveIngestion: vi.fn(async () => {
          order.push('drain-start');
          await drainGate;
          order.push('drain-done');
          return { drained: 1, abandoned: 0 };
        }),
        abandonActiveIngestion: vi.fn(async () => {
          order.push('abandon');
          return { retired: 0, stagingCleaned: 0, stagingFailed: 0 };
        }),
      } as any;
      const imageLifecycle = {
        start: vi.fn().mockResolvedValue({ completed: true, timedOut: false, report: null }),
        stop: vi.fn(async () => {
          order.push('sweep-stop');
          return { drained: true };
        }),
      } as any;
      const db = {
        close: vi.fn(() => {
          order.push('close');
        }),
      } as any;
      setupSuccessfulBootstrap({ imageIngestionCoordinator, imageLifecycle, db });
      await daemon.start('/config.yaml');

      const stopping = daemon.stop();
      await vi.waitFor(() =>
        expect(imageIngestionCoordinator.drainActiveIngestion).toHaveBeenCalledOnce(),
      );

      // While ingestion is still in flight the database stays open and no
      // new admission is accepted (fence already set).
      expect(imageIngestionCoordinator.fenceAdmissions).toHaveBeenCalledOnce();
      expect(db.close).not.toHaveBeenCalled();

      releaseDrain!();
      await stopping;

      // R1: retirement runs UNCONDITIONALLY before closure — lifecycle
      // recovery continuations are not tracked in activeDeliveries, so
      // even a drain that abandoned nothing may not skip the retire step.
      expect(order).toEqual([
        'fence',
        'sweep-stop',
        'drain-start',
        'drain-done',
        'abandon',
        'close',
      ]);
      expect(imageIngestionCoordinator.abandonActiveIngestion).toHaveBeenCalledOnce();
    });

    it('retires continuations of ingestion that outlive the shutdown drain, before closing', async () => {
      // F3: retirement is in-memory only — durable rows stay untouched for
      // next-boot recovery; the daemon just must not close the DB under a
      // live continuation that could still write.
      const imageIngestionCoordinator = {
        fenceAdmissions: vi.fn(),
        drainActiveIngestion: vi.fn().mockResolvedValue({ drained: 0, abandoned: 2 }),
        abandonActiveIngestion: vi.fn().mockResolvedValue({ retired: 2, stagingCleaned: 0, stagingFailed: 0 }),
      } as any;
      const db = { close: vi.fn() } as any;
      setupSuccessfulBootstrap({ imageIngestionCoordinator, db });
      await daemon.start('/config.yaml');

      await daemon.stop();

      expect(imageIngestionCoordinator.abandonActiveIngestion).toHaveBeenCalledOnce();
      expect(imageIngestionCoordinator.abandonActiveIngestion.mock.invocationCallOrder[0]).toBeLessThan(
        db.close.mock.invocationCallOrder[0],
      );
    });

    it('clears session tracker during shutdown', async () => {
      const ctx = setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');

      await daemon.stop();

      expect(ctx.sessionTracker.clearAll).toHaveBeenCalledOnce();
    });

    it('health() shows stopped state after stop()', async () => {
      setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');
      await daemon.stop();

      const health = daemon.health();
      expect(health.state).toBe('stopped');
    });

    it('health() reports uptime 0 after stop()', async () => {
      setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');
      await daemon.stop();

      expect(daemon.health().uptime).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Double-stop idempotency
  // -------------------------------------------------------------------------

  describe('double-stop idempotency', () => {
    it('is safe to call stop() twice', async () => {
      setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');

      await daemon.stop();
      await expect(daemon.stop()).resolves.not.toThrow();
    });

    it('database is closed only once on double-stop', async () => {
      const ctx = setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');

      await daemon.stop();
      await daemon.stop();

      expect(ctx.db.close).toHaveBeenCalledOnce();
    });

    it('is safe to call stop() on a daemon that was never started', async () => {
      await expect(daemon.stop()).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Health reporting
  // -------------------------------------------------------------------------

  describe('health()', () => {
    it('reports schedulerRunning=false before start', () => {
      expect(daemon.health().schedulerRunning).toBe(false);
    });

    it('reports schedulerRunning=true while running', async () => {
      setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');

      expect(daemon.health().schedulerRunning).toBe(true);
    });

    it('reports schedulerRunning=false after stop', async () => {
      setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');
      await daemon.stop();

      expect(daemon.health().schedulerRunning).toBe(false);
    });

    it('reports activeChannels as empty when no connectors are registered', async () => {
      setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');

      expect(daemon.health().activeChannels).toEqual([]);
    });

    it('reports queueStats from the queue manager', async () => {
      setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');

      const health = daemon.health();
      expect(health.queueStats.pending).toBeGreaterThanOrEqual(0);
      expect(health.queueStats.deadLetter).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // Reload
  // -------------------------------------------------------------------------

  describe('reload()', () => {
    it('returns Err(DaemonError) if called when not running', async () => {
      const result = await daemon.reload('/config.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DAEMON_ERROR');
    });

    it('does not change daemon state on reload', async () => {
      const ctx = setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');

      // Reload calls loadConfig directly (not bootstrap).
      vi.mocked(loadConfig).mockReturnValue(ok(ctx.config as any));

      const result = await daemon.reload();

      expect(result.isOk()).toBe(true);
      expect(daemon.state).toBe('running');
    });

    it('injects sibling bot IDs after restarting channel connectors on reload', async () => {
      const ctx = setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');
      vi.mocked(injectSiblingBotIds).mockClear();

      vi.mocked(loadConfig).mockReturnValue(ok(ctx.config as any));
      await daemon.reload();

      expect(injectSiblingBotIds).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // PID file failure tolerance
  // -------------------------------------------------------------------------

  describe('PID file failure tolerance', () => {
    it('continues startup even if writePidFile throws', async () => {
      setupSuccessfulBootstrap();
      vi.mocked(writePidFile).mockImplementation(() => {
        throw new Error('disk full');
      });

      const result = await daemon.start('/config.yaml');

      expect(result.isOk()).toBe(true);
      expect(daemon.state).toBe('running');
    });
  });
});
