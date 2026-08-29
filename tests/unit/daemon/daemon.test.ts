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
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

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
import {
  BaseRepository,
  BehaviorSignalRepository,
  LifecycleDeliveryRepository,
  LifecycleEventRepository,
  type LifecycleDeliveryFanoutInput,
} from '../../../src/core/database/repositories/index.js';
import {
  DaemonCommandSchema,
  type DaemonCommand,
  type DaemonResponse,
} from '../../../src/ipc/daemon-ipc.js';
import type { LifecycleEventEnvelope } from '../../../src/lifecycle/contracts/index.js';
import { createTestDb } from '../core/database/repositories/helpers.js';

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

function setDaemonContext(target: TalondDaemon, ctx: DaemonContext): void {
  (target as unknown as { ctx: DaemonContext }).ctx = ctx;
}

async function handleDaemonCommand(
  target: TalondDaemon,
  command: DaemonCommand,
): Promise<DaemonResponse> {
  return (
    target as unknown as {
      handleIpcCommand(command: DaemonCommand): Promise<DaemonResponse>;
    }
  ).handleIpcCommand(command);
}

function lifecycleCommand(
  command: DaemonCommand['command'],
  payload?: Record<string, unknown>,
): DaemonCommand {
  return DaemonCommandSchema.parse({
    id: randomUUID(),
    command,
    ...(payload !== undefined ? { payload } : {}),
  });
}

function lifecycleEvent(overrides: Partial<LifecycleEventEnvelope> = {}): LifecycleEventEnvelope {
  return {
    version: 'v1',
    eventId: randomUUID(),
    type: 'run.completed.v1',
    occurredAt: '2026-07-16T10:00:00.000Z',
    context: {
      aggregate: { type: 'thread', id: `thread-${randomUUID()}` },
      correlationId: randomUUID(),
      recursion: { depth: 0, maxDepth: 4 },
      provenance: { source: 'daemon' },
    },
    payload: {
      references: [{ type: 'run', id: randomUUID() }],
      metadata: { outcome: 'completed' },
    },
    ...overrides,
  };
}

function lifecycleDelivery(handlerId: string, persona: string): LifecycleDeliveryFanoutInput {
  return {
    handlerId,
    persona,
    priority: 0,
    identity: {
      version: 'v1',
      handlerId,
      runtimeKind: 'native',
      implementationRef: handlerId,
      implementationVersion: '1.0.0',
      mode: 'event',
      inputContract: 'talon.lifecycle.event.envelope.v1',
      outputContract: 'talon.lifecycle.signal.envelopes.v1',
    },
    failurePolicy: { version: 'v1', mode: 'dead_letter' },
    maxAttempts: 2,
  };
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

  describe('lifecycle IPC operator commands', () => {
    let db: Database.Database | null = null;

    afterEach(() => {
      db?.close();
      db = null;
    });

    function installRealLifecycleRepos(): {
      ctx: DaemonContext;
      events: LifecycleEventRepository;
      deliveries: LifecycleDeliveryRepository;
      behavior: BehaviorSignalRepository;
    } {
      BaseRepository.__resetMonotonicClockForTests();
      db = createTestDb();
      const events = new LifecycleEventRepository(db);
      const deliveries = new LifecycleDeliveryRepository(db, () => 1_800_000_000_000);
      const behavior = new BehaviorSignalRepository(db);
      const ctx = makeMockContext();
      ctx.repos = {
        ...ctx.repos,
        lifecycleEvent: events,
        lifecycleDelivery: deliveries,
        behaviorSignal: behavior,
      } as any;
      setDaemonContext(daemon, ctx);
      return { ctx, events, deliveries, behavior };
    }

    it('summarizes displayed handler backlog without truncating grouped persona rows', async () => {
      const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      const { ctx, events, deliveries } = installRealLifecycleRepos();
      const personas = Array.from({ length: 60 }, (_, index) => `persona-${index}`);
      ctx.config.lifecycle = {
        enabled: true,
        handlers: [
          { id: 'handler-a', mode: 'event', runtime: { kind: 'native' } },
          { id: 'handler-b', mode: 'event', runtime: { kind: 'native' } },
          { id: 'handler-c', mode: 'event', runtime: { kind: 'native' } },
        ],
      } as any;
      ctx.config.personas = personas.map((name) => ({
        name,
        lifecycle: {
          subscriptions: [{ handler: 'handler-a' }, { handler: 'handler-b' }],
        },
      })) as any;
      ctx.lifecycleRuntime = {
        dispatcher: {
          snapshot: vi.fn().mockReturnValue({
            running: true,
            stopping: false,
            inFlight: 0,
            handlers: [{ handlerId: 'handler-b', circuit: 'open' }],
          }),
        },
      } as any;

      const failedEvent = lifecycleEvent();
      events
        .insertWithDeliveries(failedEvent, [lifecycleDelivery('handler-b', 'persona-failed')])
        ._unsafeUnwrap();
      const failedClaim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
      deliveries
        .fail(
          failedEvent.eventId,
          'handler-b',
          failedClaim.delivery.claim_token!,
          { code: 'transient-failure' },
          1_800_000_060_000,
        )
        ._unsafeUnwrap();
      const failedRow = deliveries.findByKey(failedEvent.eventId, 'handler-b')._unsafeUnwrap()!;
      dateNow.mockReturnValue(1_800_000_120_000);

      for (const persona of personas.slice(0, 5)) {
        const input = lifecycleEvent();
        events
          .insertWithDeliveries(input, [lifecycleDelivery('handler-b', persona)])
          ._unsafeUnwrap();
        const claim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
        deliveries
          .complete(input.eventId, 'handler-b', claim.delivery.claim_token!)
          ._unsafeUnwrap();
      }
      for (const persona of personas) {
        events
          .insertWithDeliveries(lifecycleEvent(), [lifecycleDelivery('handler-a', persona)])
          ._unsafeUnwrap();
      }
      for (const persona of personas.slice(5)) {
        events
          .insertWithDeliveries(lifecycleEvent(), [lifecycleDelivery('handler-b', persona)])
          ._unsafeUnwrap();
      }
      events
        .insertWithDeliveries(lifecycleEvent(), [lifecycleDelivery('handler-c', 'persona-extra')])
        ._unsafeUnwrap();

      const response = await handleDaemonCommand(
        daemon,
        lifecycleCommand('lifecycle-handlers', { limit: 2 }),
      );

      expect(response.success).toBe(true);
      expect(response.data).toMatchObject({
        backlog: { pending: 116, failed: 1, completed: 5 },
        handlers: [
          { handlerId: 'handler-a', backlog: { pending: 60 } },
          {
            handlerId: 'handler-b',
            backlog: { pending: 55, failed: 1, completed: 5 },
            timing: {
              oldestCreatedAt: failedRow.created_at,
              oldestAgeMs: 1_800_000_120_000 - failedRow.created_at,
              nextRetryAt: failedRow.next_retry_at,
            },
            statusTiming: {
              failed: {
                oldestCreatedAt: failedRow.created_at,
                oldestAgeMs: 1_800_000_120_000 - failedRow.created_at,
                nextRetryAt: failedRow.next_retry_at,
              },
            },
            circuit: 'open',
          },
        ],
      });
      dateNow.mockRestore();
    });

    it('inspects, replays, disables, and audits lifecycle delivery mutations', async () => {
      const { ctx, events, deliveries } = installRealLifecycleRepos();
      const auditLogger = {
        logLifecycleDisablement: vi.fn(),
      };
      ctx.auditLogger = auditLogger as any;
      const replayEvent = lifecycleEvent();
      events
        .insertWithDeliveries(replayEvent, [lifecycleDelivery('replay-handler', 'support')])
        ._unsafeUnwrap();
      const replayClaim = deliveries.claimNext({ leaseMs: 100 })._unsafeUnwrap()!;
      deliveries
        .complete(replayEvent.eventId, 'replay-handler', replayClaim.delivery.claim_token!)
        ._unsafeUnwrap();
      const disabledEvent = lifecycleEvent();
      events
        .insertWithDeliveries(disabledEvent, [lifecycleDelivery('disabled-handler', 'support')])
        ._unsafeUnwrap();

      const inspect = await handleDaemonCommand(
        daemon,
        lifecycleCommand('lifecycle-inspect', {
          eventId: replayEvent.eventId,
          handlerId: 'replay-handler',
        }),
      );
      const replay = await handleDaemonCommand(
        daemon,
        lifecycleCommand('lifecycle-replay', {
          eventId: replayEvent.eventId,
          handlerId: 'replay-handler',
        }),
      );
      const disabled = await handleDaemonCommand(
        daemon,
        lifecycleCommand('lifecycle-disable', { handlerId: 'disabled-handler' }),
      );

      expect(inspect.success).toBe(true);
      expect(inspect.data).toMatchObject({
        event: { eventId: replayEvent.eventId },
        deliveries: [{ handlerId: 'replay-handler', status: 'completed' }],
      });
      expect(replay.success).toBe(true);
      expect(replay.data).toMatchObject({
        eventId: replayEvent.eventId,
        handlerId: 'replay-handler',
        status: 'pending',
        attempts: 0,
      });
      expect(disabled.success).toBe(true);
      expect(disabled.data).toEqual({
        handlerId: 'disabled-handler',
        disabledDeliveries: 1,
      });
      expect(auditLogger.logLifecycleDisablement).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'lifecycle.disablement',
          details: expect.objectContaining({
            handlerId: 'disabled-handler',
            disabledDeliveries: 1,
          }),
        }),
      );
    });

    it('returns repository errors from lifecycle handler reads', async () => {
      const ctx = makeMockContext({
        repos: {
          ...makeMockContext().repos,
          lifecycleDelivery: {
            countByStatus: vi.fn().mockReturnValue(err(new Error('count failed'))),
          },
        } as any,
      });
      setDaemonContext(daemon, ctx);

      const response = await handleDaemonCommand(
        daemon,
        lifecycleCommand('lifecycle-handlers', { limit: 10 }),
      );

      expect(response).toMatchObject({
        success: false,
        error: 'count failed',
      });
    });

    it('lists behavior candidates through the storage-bounded summary query', async () => {
      const { behavior } = installRealLifecycleRepos();
      const firstEvidenceId = randomUUID();
      const secondEvidenceId = randomUUID();
      expect(
        behavior
          .recordEvidence({
            evidenceId: firstEvidenceId,
            persona: 'support',
            sourceKind: 'message',
            sourceId: randomUUID(),
            sourceOccurredAt: '2026-07-25T12:00:00.000Z',
            fingerprint: randomUUID(),
            sentiment: 'positive',
            confidence: 0.8,
            summary: 'The user prefers concise responses.',
          })
          .isOk(),
      ).toBe(true);
      expect(
        behavior
          .recordEvidence({
            evidenceId: secondEvidenceId,
            persona: 'support',
            sourceKind: 'tool_call',
            sourceId: randomUUID(),
            sourceOccurredAt: '2026-07-25T12:01:00.000Z',
            fingerprint: randomUUID(),
            sentiment: 'positive',
            confidence: 0.7,
            summary: 'A tool call confirmed the concise preference.',
          })
          .isOk(),
      ).toBe(true);
      for (const [index, candidateId] of ['candidate-a', 'candidate-b', 'candidate-c'].entries()) {
        expect(
          behavior
            .createCandidate({
              candidateId,
              persona: 'support',
              kind: 'style',
              status: index === 0 ? 'ready' : 'collecting',
              summary: `Candidate ${index}`,
              proposedBehavior: `Apply candidate ${index}`,
              confidence: 0.5,
              createdFromEvidenceIds: index === 0 ? [firstEvidenceId, secondEvidenceId] : [],
            })
            .isOk(),
        ).toBe(true);
      }

      const response = await handleDaemonCommand(
        daemon,
        lifecycleCommand('lifecycle-candidates', { persona: 'support', limit: 2 }),
      );

      expect(response.success).toBe(true);
      expect(response.data).toMatchObject({
        persona: 'support',
        candidates: [
          { candidateId: 'candidate-a', evidenceSources: 2 },
          { candidateId: 'candidate-b', evidenceSources: 0 },
        ],
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
      const stdoutWriteSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true as any);
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
      vi.mocked(bootstrap).mockResolvedValue(err(new DaemonError('bootstrap failure')));

      await daemon.start('/bad.yaml');

      expect(daemon.state).toBe('error');
    });

    it('cleans up a post-lifecycle startup failure and permits a successful restart', async () => {
      const lifecycleRuntime = { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };
      const failed = makeMockContext({
        lifecycleRuntime: lifecycleRuntime as any,
        scheduler: {
          start: vi.fn(() => {
            throw new Error('scheduler start failed');
          }),
          stop: vi.fn(),
        } as any,
      });
      const recovered = makeMockContext();
      vi.mocked(bootstrap).mockResolvedValueOnce(ok(failed)).mockResolvedValueOnce(ok(recovered));

      const result = await daemon.start('/config.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DAEMON_ERROR');
      expect(daemon.state).toBe('stopped');
      expect(lifecycleRuntime.start).toHaveBeenCalledOnce();
      expect(lifecycleRuntime.stop).toHaveBeenCalledOnce();
      expect(failed.queueManager.stopProcessing).toHaveBeenCalledOnce();
      expect(failed.hostToolsBridge.stop).toHaveBeenCalledOnce();
      expect(failed.db.close).toHaveBeenCalledOnce();

      expect((await daemon.start('/config.yaml')).isOk()).toBe(true);
      expect(daemon.state).toBe('running');
    });

    it('joins started queue work before closing SQLite after startup failure', async () => {
      let releaseQueue!: () => void;
      const queueDrain = new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
      const failed = makeMockContext({
        scheduler: {
          start: vi.fn(() => {
            throw new Error('scheduler start failed');
          }),
          stop: vi.fn().mockResolvedValue(undefined),
        } as any,
        queueManager: {
          startProcessing: vi.fn(),
          stopProcessing: vi.fn().mockReturnValue(queueDrain),
          stats: vi.fn().mockReturnValue({ pending: 0, claimed: 0, processing: 0, deadLetter: 0 }),
        } as any,
      });
      vi.mocked(bootstrap).mockResolvedValue(ok(failed));

      const starting = daemon.start('/config.yaml');
      await vi.waitFor(() => expect(failed.queueManager.stopProcessing).toHaveBeenCalledOnce());
      expect(failed.db.close).not.toHaveBeenCalled();

      releaseQueue();
      expect((await starting).isErr()).toBe(true);
      expect(failed.db.close).toHaveBeenCalledOnce();
      expect(failed.queueManager.stopProcessing.mock.invocationCallOrder[0]).toBeLessThan(
        failed.db.close.mock.invocationCallOrder[0],
      );
    });

    it('gates restart and defers SQLite teardown when a bounded scheduler drain times out', async () => {
      let releaseDrain!: () => void;
      const deferred = new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
      const failed = makeMockContext({
        scheduler: {
          start: vi.fn(() => {
            throw new Error('scheduler start failed');
          }),
          stop: vi
            .fn()
            .mockResolvedValueOnce({ status: 'timed_out' })
            .mockResolvedValue({ status: 'drained' }),
          waitForDrain: vi.fn().mockReturnValue(deferred),
        } as any,
        queueManager: {
          startProcessing: vi.fn(),
          stopProcessing: vi.fn().mockResolvedValue({ status: 'drained' }),
          waitForDrain: vi.fn().mockResolvedValue(undefined),
          stats: vi.fn(),
        } as any,
      });
      vi.mocked(bootstrap).mockResolvedValue(ok(failed));

      const result = await daemon.start('/config.yaml');
      expect(result.isErr()).toBe(true);
      expect(failed.db.close).not.toHaveBeenCalled();
      expect((await daemon.start('/config.yaml')).isErr()).toBe(true);

      releaseDrain();
      await vi.waitFor(() => expect(failed.db.close).toHaveBeenCalledOnce());
      expect(daemon.state).toBe('stopped');
    });

    it('fails closed on a startup drain exception until deferred cleanup confirms all work drained', async () => {
      let releaseDrain!: () => void;
      const deferred = new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
      const failed = makeMockContext({
        scheduler: {
          start: vi.fn(() => {
            throw new Error('scheduler start failed');
          }),
          stop: vi
            .fn()
            .mockRejectedValueOnce(new Error('scheduler drain failed'))
            .mockResolvedValue({ status: 'drained' }),
          waitForDrain: vi.fn().mockReturnValue(deferred),
        } as any,
        queueManager: {
          startProcessing: vi.fn(),
          stopProcessing: vi.fn().mockResolvedValue({ status: 'drained' }),
          waitForDrain: vi.fn().mockResolvedValue(undefined),
          stats: vi.fn(),
        } as any,
      });
      vi.mocked(bootstrap).mockResolvedValue(ok(failed));

      const result = await daemon.start('/config.yaml');
      expect(result.isErr()).toBe(true);
      expect(failed.db.close).not.toHaveBeenCalled();
      expect((await daemon.start('/config.yaml')).isErr()).toBe(true);

      releaseDrain();
      await vi.waitFor(() => expect(failed.db.close).toHaveBeenCalledOnce());
      expect(daemon.state).toBe('stopped');
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
    it('contains a rejected drain from an IPC shutdown callback', async () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any;
      const ipcDaemon = new TalondDaemon(logger);
      const stop = vi
        .spyOn(ipcDaemon, 'stop')
        .mockRejectedValue(new DaemonError('Daemon workloads are still draining'));
      const unhandledRejection = vi.fn();
      process.once('unhandledRejection', unhandledRejection);

      const response = await (ipcDaemon as any).handleIpcCommand({
        id: '00000000-0000-4000-8000-000000000007',
        command: 'shutdown',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.resolve();
      process.off('unhandledRejection', unhandledRejection);

      expect(response).toMatchObject({
        success: true,
        commandId: '00000000-0000-4000-8000-000000000007',
      });
      expect(stop).toHaveBeenCalledOnce();
      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ cause: expect.any(DaemonError) }),
        'daemon: IPC shutdown deferred after drain failure',
      );
    });

    it('defers teardown and remains restart-gated when a normal shutdown drain rejects', async () => {
      let releaseDrain!: () => void;
      const deferred = new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
      const ctx = setupSuccessfulBootstrap({
        scheduler: {
          start: vi.fn(),
          stop: vi
            .fn()
            .mockRejectedValueOnce(new Error('scheduler drain failed'))
            .mockResolvedValue({ status: 'drained' }),
          waitForDrain: vi.fn().mockReturnValue(deferred),
        } as any,
        queueManager: {
          startProcessing: vi.fn(),
          stopProcessing: vi.fn().mockResolvedValue({ status: 'drained' }),
          waitForDrain: vi.fn().mockResolvedValue(undefined),
          stats: vi.fn(),
        } as any,
      });
      await daemon.start('/config.yaml');

      await expect(daemon.stop()).rejects.toMatchObject({ code: 'DAEMON_ERROR' });
      expect(ctx.db.close).not.toHaveBeenCalled();
      expect((await daemon.start('/config.yaml')).isErr()).toBe(true);

      releaseDrain();
      await vi.waitFor(() => expect(ctx.db.close).toHaveBeenCalledOnce());
      expect(daemon.state).toBe('stopped');
    });

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
