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

vi.mock('../../../src/skills/skill-loader.js', () => ({
  SkillLoader: vi.fn().mockImplementation(() => ({
    loadFromPersonaConfig: vi.fn().mockResolvedValue(ok([])),
  })),
}));

vi.mock('../../../src/daemon/mcp-orphan-cleanup.js', () => ({
  cleanupOrphanedMcpChildren: vi.fn().mockReturnValue({
    scanned: 0,
    candidates: [],
    killed: [],
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { TalondDaemon } from '../../../src/daemon/daemon.js';
import { bootstrap } from '../../../src/daemon/daemon-bootstrap.js';
import { loadConfig } from '../../../src/core/config/config-loader.js';
import { writePidFile, removePidFile } from '../../../src/daemon/lifecycle.js';
import { injectSiblingBotIds } from '../../../src/channels/channel-setup.js';
import { cleanupOrphanedMcpChildren } from '../../../src/daemon/mcp-orphan-cleanup.js';
import { DaemonError } from '../../../src/core/errors/index.js';
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
    } as any,
    configPath: '/etc/talond/config.yaml',
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
    } as any,
    scheduler: {
      start: vi.fn(),
      stop: vi.fn(),
    } as any,
    personaLoader: {
      loadFromConfig: vi.fn().mockResolvedValue(ok(undefined)),
    } as any,
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
    logger: mockLogger as any,
    ...overrides,
  };
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
    // The production code adds a 500ms settle delay before the post-run
    // MCP sweep so the kernel can reap the just-exited CLI subprocess and
    // re-parent its MCP descendants to PID 1. Skip the delay in tests.
    process.env.TALON_MCP_SWEEP_SETTLE_MS = '0';
  });

  afterEach(async () => {
    delete process.env.TALON_MCP_SWEEP_SETTLE_MS;
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

    it('sweeps orphaned MCP subprocesses after every queue item (cross-run gap, issue #210)', async () => {
      const ctx = setupSuccessfulBootstrap();

      await daemon.start('/config.yaml');

      // Capture the handler the daemon wired into queueManager.startProcessing.
      const handler = (ctx.queueManager.startProcessing as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(typeof handler).toBe('function');

      const runnerOk = ok(undefined);
      // The wrapper calls the runner first, then runs the sweep in finally.
      vi.mocked(cleanupOrphanedMcpChildren).mockClear();

      const result = await handler!({ id: 'q1', threadId: 't1', payload: {} } as unknown);
      // The handler should return whatever the underlying runner returned. We
      // are not asserting on result.shape here — the relevant assertion is
      // that the sweep ran. AgentRunner is not stubbed in these mocks, so
      // the handler may resolve to an err; that is fine because the sweep
      // runs in finally.
      void result;

      expect(cleanupOrphanedMcpChildren).toHaveBeenCalledTimes(1);
    });

    it('settles for TALON_MCP_SWEEP_SETTLE_MS before sweeping (race fix for #210)', async () => {
      // Reproduces the cross-run race: the SDK's query() can resolve a
      // beat ahead of the underlying claude process's kernel-side exit,
      // so the post-run sweep must wait for descendants to re-parent to
      // PID 1 before walking /proc. The delay is read from
      // TALON_MCP_SWEEP_SETTLE_MS so tests can opt out.
      process.env.TALON_MCP_SWEEP_SETTLE_MS = '120';
      try {
        const ctx = setupSuccessfulBootstrap();
        await daemon.start('/config.yaml');

        const handler = (ctx.queueManager.startProcessing as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
        expect(typeof handler).toBe('function');
        vi.mocked(cleanupOrphanedMcpChildren).mockClear();

        const start = Date.now();
        await handler!({ id: 'q1', threadId: 't1', payload: {} } as unknown);
        const elapsed = Date.now() - start;

        expect(cleanupOrphanedMcpChildren).toHaveBeenCalledTimes(1);
        // Within a tolerance — the handler resolves AFTER the settle
        // delay completes, so elapsed must be at least the configured ms.
        expect(elapsed).toBeGreaterThanOrEqual(100);
      } finally {
        process.env.TALON_MCP_SWEEP_SETTLE_MS = '0';
      }
    });

    it('runs the post-run MCP orphan sweep even when the runner throws', async () => {
      const ctx = setupSuccessfulBootstrap();
      await daemon.start('/config.yaml');

      const handler = (ctx.queueManager.startProcessing as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(typeof handler).toBe('function');
      vi.mocked(cleanupOrphanedMcpChildren).mockClear();

      await handler!(null as unknown).catch(() => {});

      expect(cleanupOrphanedMcpChildren).toHaveBeenCalledTimes(1);
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
