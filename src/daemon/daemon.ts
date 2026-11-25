/**
 * TalondDaemon — thin lifecycle orchestrator for the talond daemon.
 *
 * Delegates setup to bootstrap(), queue processing to AgentRunner, and
 * channel wiring to registerChannels(). This file handles only:
 *   - State machine (stopped → starting → running → stopping → stopped)
 *   - Starting/stopping services in dependency order
 *   - Health snapshots
 *   - Hot-reload (config diff + re-registration)
 *   - IPC command dispatch
 */

import { join } from 'node:path';
import { ok, err, type Result } from 'neverthrow';
import type pino from 'pino';

import { loadConfig } from '../core/config/config-loader.js';
import { DaemonError } from '../core/errors/error-types.js';
import { SkillLoader } from '../skills/skill-loader.js';
import { McpRegistry } from '../mcp/mcp-registry.js';

import { bootstrap } from './daemon-bootstrap.js';
import { AgentRunner } from './agent-runner.js';
import { writePidFile, removePidFile } from './lifecycle.js';
import { WatchdogNotifier } from './watchdog.js';
import {
  registerChannels,
  injectSiblingBotIds,
  signalRepositoriesFor,
  registerVoiceConnector,
  BROWSER_VOICE_CHANNEL_NAME,
} from '../channels/channel-setup.js';
import { SignalConnector } from '../channels/connectors/signal/signal-connector.js';

import type { DaemonContext } from './daemon-context.js';
import type { ChannelConnector } from '../channels/channel-types.js';
import type { DaemonState, DaemonHealth } from './daemon-types.js';
import {
  DaemonIpcServer,
  handleSignalResumeCommand,
  projectSignalStatus,
} from '../ipc/daemon-ipc-server.js';
import type { DaemonCommand, DaemonResponse } from '../ipc/daemon-ipc.js';
import type { TalondConfig } from '../core/config/config-types.js';
import { buildAgentCardRegistry } from '../a2a/persona-agent-card.js';
import { ensureOwnerOnlyDir } from '../core/fs/private-paths.js';
import { waitForCodexSandboxRunner } from '../subagents/codex-sandbox-runner-readiness.js';

// ---------------------------------------------------------------------------
// TalondDaemon
// ---------------------------------------------------------------------------

export interface TalondDaemonDeps {
  waitForCodexSandboxRunner?: typeof waitForCodexSandboxRunner;
}

/** Bounded in-line repair attempts (retry state writes, then stop again) for one Signal connector per reload. */
export const RELOAD_SIGNAL_STOP_ATTEMPTS = 3;

/** Delay before a pending reload (a Signal connector that could not be stopped cleanly) retries itself. */
export const RELOAD_RETRY_MS = 30_000;

/** How often the A2A reaper runs while the daemon is up. */
const A2A_REAPER_INTERVAL_MS = 60_000;

export class TalondDaemon {
  private _state: DaemonState = 'stopped';
  private startedAt: number | null = null;
  /** Monotonic Signal registry generation; bumped by every successful channel replacement. */
  private signalGeneration = 1;
  /** Tail of the serialized reload chain: SIGHUP and IPC reloads never interleave. */
  private reloadChain: Promise<unknown> = Promise.resolve();
  /** Automatic retry of a reload left pending by an unclean Signal stop. */
  private reloadRetryTimer: ReturnType<typeof setTimeout> | null = null;

  private ctx: DaemonContext | null = null;
  private agentRunner: AgentRunner | null = null;
  private ipcServer: DaemonIpcServer | null = null;
  private watchdog: WatchdogNotifier | null = null;
  private mcpRegistry: McpRegistry | null = null;
  private a2aReaperTimer: ReturnType<typeof setInterval> | null = null;
  /** Abort registry shared across AgentRunner rebuilds (hot reload). */
  private readonly a2aAborts = new Map<string, () => void>();

  private readonly waitForCodexSandboxRunner: typeof waitForCodexSandboxRunner;

  constructor(
    private readonly logger: pino.Logger,
    deps: TalondDaemonDeps = {},
  ) {
    this.waitForCodexSandboxRunner = deps.waitForCodexSandboxRunner ?? waitForCodexSandboxRunner;
  }

  get state(): DaemonState {
    return this._state;
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  async start(configPath: string): Promise<Result<void, DaemonError>> {
    if (this._state !== 'stopped') {
      return err(
        new DaemonError(`Cannot start daemon in state '${this._state}' (expected 'stopped')`),
      );
    }

    this._state = 'starting';
    this.logger.info({ configPath }, 'daemon: starting');

    // 1. Bootstrap — builds the full DaemonContext or fails.
    const ctxResult = await bootstrap(configPath, this.logger);
    if (ctxResult.isErr()) {
      this._state = 'error';
      return err(ctxResult.error);
    }
    this.ctx = ctxResult.value;

    if (this.logger.level !== this.ctx.config.logLevel) {
      this.logger.level = this.ctx.config.logLevel;
    }

    const codexRunner = this.ctx.config.subagentSandbox?.codex;
    if (codexRunner?.enabled) {
      const runnerReady = await this.waitForCodexSandboxRunner({
        endpoint: codexRunner.endpoint,
        token: codexRunner.token!,
        startupTimeoutMs: codexRunner.startupTimeoutMs,
      });
      if (runnerReady.isErr()) {
        return this.failStartup('Failed to start Codex sandbox runner dependency', runnerReady.error);
      }
      this.logger.info(
        { endpoint: new URL(codexRunner.endpoint).origin },
        'daemon: Codex runner ready',
      );
    }

    // 2. Register and start MCP servers from loaded skills.
    this.mcpRegistry = new McpRegistry(this.logger);
    for (const skill of this.ctx.loadedSkills) {
      for (const server of skill.resolvedMcpServers) {
        try {
          this.mcpRegistry.register(server.name, server.config);
        } catch (cause) {
          this.logger.warn(
            { mcpServer: server.name, cause: String(cause) },
            'daemon: failed to register MCP server definition',
          );
        }
      }
    }
    await this.mcpRegistry.startAll();

    // 3. Create the agent runner and start the host-tools bridge.
    // ADR-0002: the runner needs the refreshed Image/Finding source so live
    // descriptors, fresh-session replay, and rotation projections are real.
    this.agentRunner = new AgentRunner(this.ctx, {
      imageContextSource: this.ctx.imageContextSource,
      a2aAborts: this.a2aAborts,
      voiceOutputSink: this.ctx.voiceOutputSink ?? undefined,
      voiceExecutionGate: this.ctx.voiceBackendBridge?.beforeProvider.bind(this.ctx.voiceBackendBridge),
    });
    this.ctx.a2aTaskMapper?.setAbortHook((taskId) => {
      this.a2aAborts.get(taskId)?.();
    });
    this.ctx.hostToolsBridge.start();

    // 3a. Run the durable-image startup recovery + retention pass and AWAIT
    // it BEFORE any channel can admit new image-bearing events: pending
    // admissions are re-resolved against their original admission clock (no
    // redelivery, no deadline reset), expired Available content is retired,
    // and owned orphan files are cleaned. The wait is bounded, and the
    // bound FAILS THE BOOT CLOSED (F1): if recovery is still outstanding
    // when it elapses, channels are NEVER started — an Image must not be
    // admitted before crash leftovers are resolved. The outstanding work
    // is retired safely (fence admissions, bounded sweep stop, bounded
    // delivery drain with continuation retirement); sweep state is durable,
    // so recovery resumes at the next boot.
    const imageStartup = await this.ctx.imageLifecycle.start();
    if (imageStartup.timedOut) {
      this.logger.error(
        { op: 'image_startup_recovery', code: 'BOOT_ABORTED_RECOVERY_TIMEOUT' },
        'daemon: image startup recovery did not settle within the bound; aborting boot before any channel starts (fail closed)',
      );
      try {
        this.ctx.imageIngestionCoordinator.fenceAdmissions();
      } catch (cause) {
        this.logger.error({ cause }, 'daemon: error fencing image admissions during boot abort');
      }
      try {
        await this.ctx.imageLifecycle.stop();
      } catch (cause) {
        this.logger.error({ cause }, 'daemon: error stopping image lifecycle during boot abort');
      }
      try {
        const drained = await this.ctx.imageIngestionCoordinator.drainActiveIngestion();
        // R1: retire continuations UNCONDITIONALLY before closure — the
        // startup-recovery continuation is not tracked in
        // activeDeliveries, so gating on the drain result would let a
        // wedged recovery with zero deliveries resume against a closed
        // database. No-op when nothing is live; also completes tracked
        // staging cleanup before the database closes (R2).
        const retired = await this.ctx.imageIngestionCoordinator.abandonActiveIngestion();
        if (drained.abandoned > 0 || retired.retired > 0) {
          this.logger.warn(
            {
              op: 'image_boot_abort_drain',
              abandoned: drained.abandoned,
              retired: retired.retired,
              stagingCleaned: retired.stagingCleaned,
              stagingFailed: retired.stagingFailed,
            },
            'daemon: image work outlived the boot-abort bounds; continuations retired before closure',
          );
        }
      } catch (cause) {
        this.logger.error({ cause }, 'daemon: error draining image ingestion during boot abort');
      }
      // Release the resources already acquired above this point, then
      // abort. Channels, queue processing, IPC, and the watchdog have not
      // started yet, so nothing else needs unwinding.
      try {
        await this.mcpRegistry.stopAll();
      } catch (cause) {
        this.logger.warn({ cause }, 'daemon: failed to stop MCP servers after startup abort');
      }
      try {
        this.ctx.hostToolsBridge.stop();
      } catch (cause) {
        this.logger.warn({ cause }, 'daemon: failed to stop host-tools bridge after startup abort');
      }
      return this.failStartup(
        'Image startup recovery did not complete within the bound',
        new DaemonError('boot aborted: image startup recovery outstanding (fail closed; channels not started)'),
      );
    } else if (imageStartup.report?.recoveryError) {
      // Diagnostics string stays in this log-free return value; the log
      // line below carries only that a retry is scheduled (P2-5: no
      // persisted error messages from the image subsystem).
      this.logger.warn(
        { op: 'image_startup_recovery', code: 'RETRY_SCHEDULED' },
        'daemon: image startup recovery pass failed; periodic sweeps will retry',
      );
    }

    // 4. Start channel connectors (non-fatal).
    try {
      await this.ctx.channelRegistry.startAll();
      this.logger.info('daemon: all channel connectors started');
    } catch (cause) {
      this.logger.error(
        { cause },
        'daemon: one or more channel connectors failed to start — continuing without them',
      );
    }

    // Inject sibling bot IDs for multi-connector self-filtering.
    injectSiblingBotIds(this.ctx.channelRegistry, this.logger);

    if (this.ctx.voiceServer && this.ctx.config.voice?.enabled) {
      try {
        await this.ctx.voiceServer.start(this.ctx.config.voice.host, this.ctx.config.voice.port);
      } catch (cause) {
        return this.failStartup(
          'Failed to start browser voice server',
          cause instanceof Error ? cause : new Error(String(cause)),
        );
      }
    }

    // 4a. Reap stale A2A tasks (orphaned by purge/crash, or past TTL) before
    // dispatch starts, then keep reaping periodically.
    this.reapA2ATasks();
    this.a2aReaperTimer = setInterval(() => this.reapA2ATasks(), A2A_REAPER_INTERVAL_MS);
    this.a2aReaperTimer.unref();

    // 5. Start queue processing.
    // Saved Signal checkpoints go to a delivery-only handler. AgentRunner.run enters the invocation
    // guard first, which routes a checkpoint to SignalReplyDelivery.deliver and never to the provider;
    // without this handler every deferred checkpoint would only be re-deferred until it expires.
    // The runner is read lazily: reload replaces it and the loop keeps these closures.
    this.ctx.queueManager.startProcessing(
      (item) => this.agentRunner!.run(item),
      (item) => this.agentRunner!.run(item),
    );

    // 6. Start scheduler.
    this.ctx.scheduler.start();

    // 7. Write PID file (non-fatal).
    try {
      writePidFile(this.ctx.dataDir);
    } catch (cause) {
      this.logger.warn({ cause }, 'daemon: failed to write PID file');
    }

    // 8. Start IPC server.
    const ipcBase = join(this.ctx.dataDir, 'ipc/daemon');
    await Promise.all([
      ensureOwnerOnlyDir(join(ipcBase, 'input')),
      ensureOwnerOnlyDir(join(ipcBase, 'output')),
      ensureOwnerOnlyDir(join(ipcBase, 'errors')),
    ]);
    this.ipcServer = new DaemonIpcServer({
      inputDir: join(ipcBase, 'input'),
      outputDir: join(ipcBase, 'output'),
      errorsDir: join(ipcBase, 'errors'),
      logger: this.logger,
      commandHandler: (cmd: DaemonCommand): Promise<DaemonResponse> => this.handleIpcCommand(cmd),
    });
    this.ipcServer.start();
    this.logger.info('daemon: IPC server started');

    // 9. Mark running + start watchdog.
    this._state = 'running';
    this.startedAt = Date.now();
    this.logger.info('daemon: running');

    this.watchdog = new WatchdogNotifier({
      intervalMs: 10_000,
      logger: this.logger,
      dataDir: this.ctx.dataDir,
    });
    this.watchdog.start();
    this.watchdog.notifyReady();

    return ok(undefined);
  }

  // ---------------------------------------------------------------------------
  // Stop
  // ---------------------------------------------------------------------------

  /** Runs one A2A reaper pass; never throws. */
  private reapA2ATasks(): void {
    try {
      const result = this.ctx?.a2aTaskMapper?.reapStaleTasks();
      if (result === undefined) return;
      if (result.isErr()) {
        this.logger.warn({ err: result.error.message }, 'daemon: A2A reaper failed');
      } else if (result.value.length > 0) {
        this.logger.info({ count: result.value.length }, 'daemon: A2A reaper cleaned stale tasks');
      }
    } catch (cause) {
      this.logger.warn({ cause: String(cause) }, 'daemon: A2A reaper threw');
    }
  }

  async stop(): Promise<void> {
    if (this._state === 'stopped' || this._state === 'stopping') {
      return;
    }

    this._state = 'stopping';
    this.logger.info('daemon: stopping');
    this.clearReloadRetry();

    if (this.a2aReaperTimer !== null) {
      clearInterval(this.a2aReaperTimer);
      this.a2aReaperTimer = null;
    }

    if (this.watchdog !== null) {
      this.watchdog.notifyStopping();
      this.watchdog.stop();
      this.watchdog = null;
    }

    if (this.ctx !== null) {
      try {
        await this.ctx.channelRegistry.stopAll();
      } catch (cause) {
        this.logger.error({ cause }, 'daemon: error stopping channel connectors');
      }

      this.ctx.scheduler.stop();

      await this.ctx.voiceSessionService?.shutdown();
      try {
        await this.ctx.voiceServer?.stop();
      } catch (cause) {
        this.logger.warn({ cause }, 'daemon: failed to stop browser voice server');
      }

      if (this.mcpRegistry !== null) {
        await this.mcpRegistry.stopAll();
        this.mcpRegistry = null;
      }

      this.ctx.sessionTracker.clearAll();
      this.ctx.queueManager.stopProcessing();
      this.ctx.hostToolsBridge.stop();
      await this.ctx.backgroundAgentManager?.shutdown();
      try {
        await this.ctx.observability.shutdown();
      } catch (cause) {
        this.logger.warn({ cause }, 'daemon: failed to shut down observability');
      }

      // Fence and drain ALL image work BEFORE the database closes (P1-2,
      // F3, F4):
      // 1) fence new ingestion admissions (no durable admission exists for
      //    a fenced delivery — the source must resend after restart),
      // 2) fence sweeps and drain the in-flight lifecycle pass BOUNDED; a
      //    wedged pass is fenced internally from further ledger writes,
      // 3) drain delivery-owned ingestion (admission → publication →
      //    commit-together enqueue) so no write hits a closed DB.
      // Anything still live at the drain bound is RETIRED in memory — the
      // recovery table is authoritative, so NO row is terminally marked:
      // pending Ingestion rows and retained sources stay exactly as they
      // are and next-boot recovery resolves them with canonical
      // precedence, exactly once.
      try {
        this.ctx.imageIngestionCoordinator.fenceAdmissions();
      } catch (cause) {
        this.logger.error({ cause }, 'daemon: error fencing image admissions');
      }
      try {
        const swept = await this.ctx.imageLifecycle.stop();
        if (!swept.drained) {
          this.logger.warn(
            { op: 'image_shutdown', code: 'LIFECYCLE_PASS_WEDGED_AFTER_BOUND' },
            'daemon: image lifecycle pass outlived the shutdown bound; its remaining phases are fenced from ledger writes',
          );
        }
      } catch (cause) {
        this.logger.error({ cause }, 'daemon: error draining image lifecycle');
      }
      try {
        const drained = await this.ctx.imageIngestionCoordinator.drainActiveIngestion();
        // R1: retire continuations UNCONDITIONALLY before closure (no-op
        // when empty). Lifecycle-owned recovery is not tracked in
        // activeDeliveries; the previous `abandoned > 0` guard let a
        // wedged recovery skip retirement and resume against a closed
        // database. Retirement also completes tracked staging cleanup
        // before SQLite closes (R2).
        const retired = await this.ctx.imageIngestionCoordinator.abandonActiveIngestion();
        if (drained.abandoned > 0 || retired.retired > 0) {
          this.logger.warn(
            {
              op: 'image_shutdown_drain',
              code: 'CONTINUATIONS_RETIRED_AFTER_BOUND',
              abandoned: drained.abandoned,
              retired: retired.retired,
              stagingCleaned: retired.stagingCleaned,
              stagingFailed: retired.stagingFailed,
            },
            'daemon: image ingestion outlived the shutdown drain; continuations retired without durable changes — the recovery table stays authoritative for next boot',
          );
        }
      } catch (cause) {
        this.logger.error({ cause }, 'daemon: error draining image ingestion');
      }
    }

    if (this.ipcServer !== null) {
      this.ipcServer.stop();
      this.ipcServer = null;
    }

    if (this.ctx !== null) {
      try {
        this.ctx.db.close();
      } catch (cause) {
        this.logger.error({ cause }, 'daemon: error closing database');
      }

      try {
        removePidFile(this.ctx.dataDir);
      } catch (cause) {
        this.logger.warn({ cause }, 'daemon: failed to remove PID file');
      }
    }

    this._state = 'stopped';
    this.startedAt = null;
    this.ctx = null;
    this.agentRunner = null;
    this.logger.info('daemon: stopped');
  }

  private async failStartup(message: string, cause: Error): Promise<Result<void, DaemonError>> {
    const context = this.ctx;
    this.ctx = null;
    this.agentRunner = null;
    this._state = 'error';

    if (context !== null) {
      try {
        await context.channelRegistry.stopAll();
      } catch (cleanupCause) {
        this.logger.warn(
          { cleanupCause },
          'daemon: failed to stop channel connectors after startup failure',
        );
      }
      context.scheduler.stop();
      try {
        await context.voiceSessionService?.shutdown();
        await context.voiceServer?.stop();
      } catch (cleanupCause) {
        this.logger.warn(
          { cleanupCause },
          'daemon: failed to stop browser voice runtime after startup failure',
        );
      }
      if (this.mcpRegistry !== null) {
        await this.mcpRegistry.stopAll();
        this.mcpRegistry = null;
      }
      context.queueManager.stopProcessing();
      context.hostToolsBridge.stop();
      try {
        await context.backgroundAgentManager?.shutdown();
      } catch (cleanupCause) {
        this.logger.warn(
          { cleanupCause },
          'daemon: failed to stop background agents after startup failure',
        );
      }
      try {
        await context.observability.shutdown();
      } catch (cleanupCause) {
        this.logger.warn(
          { cleanupCause },
          'daemon: failed to stop observability after startup failure',
        );
      }
      try {
        context.db.close();
      } catch (cleanupCause) {
        this.logger.warn(
          { cleanupCause },
          'daemon: failed to close database after startup failure',
        );
      }
    }

    return err(new DaemonError(`${message}: ${cause.message}`, cause));
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  health(): DaemonHealth {
    if (this.ctx === null) {
      return {
        state: this._state,
        uptime: 0,
        queueStats: { pending: 0, claimed: 0, processing: 0, deadLetter: 0 },
        activeChannels: [],
        schedulerRunning: false,
      };
    }

    return {
      state: this._state,
      uptime: this.startedAt !== null ? Date.now() - this.startedAt : 0,
      queueStats: this.ctx.queueManager.stats(),
      activeChannels: this.ctx.channelRegistry.listAll().map((c) => c.name),
      schedulerRunning: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Reload
  // ---------------------------------------------------------------------------

  /**
   * Hot-reloads configuration. Reloads (SIGHUP, IPC, automatic pending retry) are serialized on one
   * chain: a later request starts only after the earlier one settled, so two channel generations
   * can never be replaced concurrently.
   */
  reload(configPath?: string): Promise<Result<void, DaemonError>> {
    const run = this.reloadChain.then(() => this.performReload(configPath));
    this.reloadChain = run.catch(() => undefined);
    return run;
  }

  private async performReload(configPath?: string): Promise<Result<void, DaemonError>> {
    if (this._state !== 'running' || this.ctx === null) {
      return err(
        new DaemonError(`Cannot reload daemon in state '${this._state}' (expected 'running')`),
      );
    }

    const effectivePath = configPath ?? this.ctx.configPath;
    if (effectivePath === null) {
      this.logger.info('daemon: reload requested but no configPath is known — skipping');
      return ok(undefined);
    }

    const configResult = loadConfig(effectivePath);
    if (configResult.isErr()) {
      return err(
        new DaemonError(
          `Failed to reload config: ${configResult.error.message}`,
          configResult.error,
        ),
      );
    }

    const oldConfig = this.ctx.config;
    // Image settings are fixed for the life of the process: the ingestion
    // coordinator, normalizer, retention timer and vision limits captured them
    // at bootstrap. Keep the running values so rebuilt connectors cannot select
    // or fetch under limits the coordinator would then reject.
    const newConfig: TalondConfig = { ...configResult.value, images: oldConfig.images };
    if (JSON.stringify(oldConfig.images) !== JSON.stringify(configResult.value.images)) {
      this.logger.warn(
        'daemon: reload — images config changed; restart required to apply (running limits kept)',
      );
    }

    const voiceReload = this.ctx.voiceSessionService;
    const voiceConfigChanged = JSON.stringify(oldConfig.voice) !== JSON.stringify(newConfig.voice);

    this.logger.info({ configPath: effectivePath }, 'daemon: applying hot-reload');

    // Channel diff.
    this.logChannelDiff(oldConfig, newConfig);

    // Persona diff.
    this.logPersonaDiff(oldConfig, newConfig);

    // Queue/scheduler config — require restart.
    if (JSON.stringify(oldConfig.queue) !== JSON.stringify(newConfig.queue)) {
      this.logger.warn('daemon: reload — queue config changed; restart required to apply');
    }
    if (JSON.stringify(oldConfig.scheduler) !== JSON.stringify(newConfig.scheduler)) {
      this.logger.warn('daemon: reload — scheduler config changed; restart required to apply');
    }
    if (
      JSON.stringify(oldConfig.subagentCli) !== JSON.stringify(newConfig.subagentCli) ||
      JSON.stringify(oldConfig.subagentSandbox) !== JSON.stringify(newConfig.subagentSandbox) ||
      JSON.stringify(oldConfig.subagents) !== JSON.stringify(newConfig.subagents)
    ) {
      this.logger.warn(
        'daemon: reload — subscription sub-agent configuration changed; restart required to rebuild runners and verify the Codex dependency',
      );
    }

    // Container image change — warn.
    if (oldConfig.sandbox.image !== newConfig.sandbox.image) {
      this.logger.warn(
        { from: oldConfig.sandbox.image, to: newConfig.sandbox.image },
        'daemon: reload — container image changed — manual rolling restart required',
      );
    }

    // Skills load is pure (nothing is applied yet): a failure here leaves everything untouched.
    const skillLoader = new SkillLoader(this.logger);
    const loadedSkillsResult = await skillLoader.loadFromPersonaConfig(
      newConfig.personas,
      this.ctx.dataDir,
    );
    if (loadedSkillsResult.isErr()) {
      if (voiceReload && !voiceConfigChanged) voiceReload.openAdmission();
      return err(
        new DaemonError(`Failed to reload skills: ${loadedSkillsResult.error.message}`),
      );
    }

    // Everything global (personas, skills, MCP, runner, config, log level) is applied only after the
    // old Signal connectors stopped cleanly, and is followed by the channel replacement. A Signal stop
    // that cannot complete leaves ALL of it unapplied and reports the reload as pending with an
    // automatic retry.
    const quiesced = this.ctx.queueManager;
    quiesced.quiesceClaims();

    const connectors = this.ctx.channelRegistry.listAll();
    const stopped = await this.stopSignalConnectors(connectors);
    if (stopped.isErr()) {
      if (voiceReload && !voiceConfigChanged) voiceReload.openAdmission();
      this.scheduleReloadRetry(effectivePath);
      return err(stopped.error);
    }
    if (this._state !== 'running' || this.ctx === null) {
      if (voiceReload && !voiceConfigChanged) voiceReload.openAdmission();
      return err(new DaemonError('Reload abandoned: daemon is no longer running'));
    }

    await this.stopOtherConnectors(connectors);

    // Freeze voice admission and invalidate browser auth before personas,
    // skills, or MCP definitions become mutable. This preserves the policy
    // generation captured by every existing delegation. It runs only after the Signal connectors
    // stopped cleanly, so a pending Signal stop (retried every RELOAD_RETRY_MS) never revokes
    // voice logins or ends live calls repeatedly.
    if (voiceReload) {
      voiceReload.closeAdmission();
      voiceReload.bumpGeneration();
      if (this.ctx.voiceGeneration) this.ctx.voiceGeneration.value += 1;
    }
    const invalidated = this.ctx.voiceAuth?.invalidateRuntime();
    if (invalidated?.isErr()) {
      await this.replaceRegistry(oldConfig, connectors);
      quiesced.resumeClaims();
      return err(new DaemonError('Failed to revoke browser voice authentication', invalidated.error));
    }
    if (voiceReload) {
      await voiceReload.shutdown();
      if (voiceConfigChanged) {
        try {
          await this.ctx.voiceServer?.stop();
        } catch (cause) {
          this.logger.warn({ cause }, 'daemon: reload — failed to stop old browser voice server');
        }
      }
    }

    if (this.ctx.voiceAuth && !newConfig.voice?.enabled) this.ctx.voiceAuth.disable();

    if (this.ctx.voiceAuth && newConfig.voice?.enabled) {
      const voiceAccessToken = resolveVoiceAccessToken(newConfig);
      const voicePersonaName = newConfig.voice.persona ?? newConfig.personas[0]?.name;
      if (!voiceAccessToken || !voicePersonaName) {
        this.ctx.voiceAuth.disable();
        await this.replaceRegistry(oldConfig, connectors);
        quiesced.resumeClaims();
        return err(new DaemonError('Failed to reload browser voice authentication'));
      }
      const rebound = this.ctx.voiceAuth.rebind(
        voiceAccessToken,
        `voice:${voicePersonaName}`,
      );
      if (rebound.isErr()) {
        this.ctx.voiceAuth.disable();
        await this.replaceRegistry(oldConfig, connectors);
        quiesced.resumeClaims();
        return err(new DaemonError('Failed to reload browser voice authentication', rebound.error));
      }
    }

    const applied = await this.applyGlobalReload(newConfig, loadedSkillsResult.value);
    if (applied.isErr()) {
      // Nothing global changed past the failure point; restore a working generation from the old config.
      await this.replaceRegistry(oldConfig, connectors);
      quiesced.resumeClaims();
      if (voiceReload && !voiceConfigChanged) voiceReload.openAdmission();
      return err(applied.error);
    }

    await this.replaceRegistry(newConfig, connectors);

    // Rebuild AgentRunner so it picks up the new loadedSkills.
    this.agentRunner = new AgentRunner(this.ctx, {
      imageContextSource: this.ctx.imageContextSource,
      a2aAborts: this.a2aAborts,
      voiceOutputSink: this.ctx.voiceOutputSink ?? undefined,
      voiceExecutionGate: this.ctx.voiceBackendBridge?.beforeProvider.bind(this.ctx.voiceBackendBridge),
    });

    // Update config snapshot and log level.
    (this.ctx as { config: TalondConfig }).config = newConfig;
    if (newConfig.logLevel !== oldConfig.logLevel) {
      this.logger.info(
        { from: oldConfig.logLevel, to: newConfig.logLevel },
        'daemon: log level changed — applying',
      );
      this.logger.level = newConfig.logLevel;
    }
    this.clearReloadRetry();
    quiesced.resumeClaims();
    if (this.ctx.voiceRuntimeConfig) this.ctx.voiceRuntimeConfig.current = newConfig;
    if (voiceReload && !voiceConfigChanged && newConfig.voice?.enabled) {
      voiceReload.openAdmission();
    } else if (voiceReload && voiceConfigChanged) {
      this.logger.warn('daemon: reload — browser voice configuration changed; restart required to rebuild its provider and auth runtime');
    } else if (!voiceReload && newConfig.voice?.enabled) {
      this.logger.warn('daemon: reload — browser voice was enabled; restart required to initialize its provider and auth runtime');
    }

    this.logger.info('daemon: hot-reload complete');
    return ok(undefined);
  }

  // ---------------------------------------------------------------------------
  // IPC command handler
  // ---------------------------------------------------------------------------

  private async handleIpcCommand(command: DaemonCommand): Promise<DaemonResponse> {
    const { randomUUID } = await import('crypto');
    const responseId = randomUUID();

    switch (command.command) {
      case 'status': {
        const healthData = this.health();
        const runRepo = this.ctx?.repos.run ?? null;
        const signalStatus =
          this.ctx === null
            ? undefined
            : projectSignalStatus(
                this.ctx.channelRegistry,
                this.ctx.repos.queue,
                this.ctx.config.channels.some(
                  (channel) => channel.enabled && channel.type === 'signal',
                ),
              );
        const tokenUsage24h =
          runRepo === null
            ? undefined
            : runRepo.aggregateByPeriod(Date.now() - 24 * 60 * 60 * 1000).match(
                (aggregate) => ({
                  inputTokens: aggregate.total_input_tokens,
                  outputTokens: aggregate.total_output_tokens,
                  cacheReadTokens: aggregate.total_cache_read_tokens,
                  cacheWriteTokens: aggregate.total_cache_write_tokens,
                  costUsd: aggregate.total_cost_usd,
                }),
                () => undefined,
              );

        return {
          id: responseId,
          commandId: command.id,
          success: true,
          data: {
            uptimeMs: healthData.uptime,
            activeContainers: 0,
            queueDepth:
              healthData.queueStats.pending +
              healthData.queueStats.claimed +
              healthData.queueStats.processing,
            personaCount: this.ctx?.config.personas.length ?? 0,
            channelCount:
              this.ctx?.config.channels.filter((channel) => channel.enabled).length ?? 0,
            deadLetterCount: healthData.queueStats.deadLetter,
            ...(tokenUsage24h !== undefined ? { tokenUsage24h } : {}),
            ...(signalStatus !== undefined ? { signal: signalStatus } : {}),
          },
        };
      }

      case 'signal-resume': {
        if (!this.ctx) {
          return { id: responseId, commandId: command.id, success: false, error: 'Daemon not running' };
        }
        return handleSignalResumeCommand(this.ctx.channelRegistry, command);
      }

      case 'reload': {
        const reloadConfigPath =
          typeof command.payload?.configPath === 'string' ? command.payload.configPath : undefined;
        const reloadResult = await this.reload(reloadConfigPath);
        if (reloadResult.isErr()) {
          return {
            id: responseId,
            commandId: command.id,
            success: false,
            error: reloadResult.error.message,
          };
        }
        return {
          id: responseId,
          commandId: command.id,
          success: true,
          data: {
            configReloaded: true,
            personasReloaded: true,
            channelsReloaded: true,
          },
        };
      }

      case 'shutdown': {
        setImmediate(() => {
          void this.stop();
        });
        return {
          id: responseId,
          commandId: command.id,
          success: true,
          data: { message: 'Shutdown initiated' },
        };
      }

      case 'queue-purge': {
        if (!this.ctx) {
          return {
            id: responseId,
            commandId: command.id,
            success: false,
            error: 'Daemon not running',
          };
        }

        // Default: purge pending, failed, and completed. Accept override via payload.
        type QS = 'pending' | 'claimed' | 'processing' | 'completed' | 'failed' | 'dead_letter';
        const validStatuses: readonly QS[] = ['pending', 'claimed', 'processing', 'completed', 'failed', 'dead_letter'];
        const requestedStatuses: QS[] = Array.isArray(command.payload?.statuses)
          ? (command.payload.statuses as string[]).filter((s): s is QS =>
              (validStatuses as readonly string[]).includes(s),
            )
          : ['pending', 'failed', 'completed'];

        const purgeResult = this.ctx.repos.queue.purge(requestedStatuses);
        if (purgeResult.isErr()) {
          return {
            id: responseId,
            commandId: command.id,
            success: false,
            error: purgeResult.error.message,
          };
        }

        this.logger.info(
          { purged: purgeResult.value, statuses: requestedStatuses },
          'daemon: queue purged',
        );

        return {
          id: responseId,
          commandId: command.id,
          success: true,
          data: { purged: purgeResult.value, statuses: requestedStatuses },
        };
      }

      case 'a2a-cancel': {
        // Runs inside the daemon so cancelTask's abort hook can stop an
        // in-flight run (a CLI-side DB cancel cannot).
        const mapper = this.ctx?.a2aTaskMapper ?? null;
        if (!mapper) {
          return {
            id: responseId,
            commandId: command.id,
            success: false,
            error: 'A2A is not available in this daemon',
          };
        }
        const taskId = typeof command.payload?.taskId === 'string' ? command.payload.taskId.trim() : '';
        if (taskId === '') {
          return {
            id: responseId,
            commandId: command.id,
            success: false,
            error: 'a2a-cancel requires payload.taskId',
          };
        }
        const reason =
          typeof command.payload?.reason === 'string' && command.payload.reason.trim() !== ''
            ? command.payload.reason.trim()
            : 'canceled via talonctl';

        const before = mapper.getTaskStatus(taskId);
        if (before.isErr()) {
          return { id: responseId, commandId: command.id, success: false, error: before.error.message };
        }
        if (before.value === null) {
          return {
            id: responseId,
            commandId: command.id,
            success: true,
            data: { taskId, found: false, canceled: false },
          };
        }
        const cancelResult = mapper.cancelTask(taskId, reason);
        if (cancelResult.isErr()) {
          return { id: responseId, commandId: command.id, success: false, error: cancelResult.error.message };
        }
        const after = mapper.getTaskStatus(taskId);
        const state = after.isOk() && after.value ? after.value.state : before.value.state;
        return {
          id: responseId,
          commandId: command.id,
          success: true,
          data: { taskId, found: true, canceled: cancelResult.value, state },
        };
      }

      default: {
        const unknownCommand = command.command;
        return {
          id: responseId,
          commandId: command.id,
          success: false,
          error: `Unknown command: ${String(unknownCommand)}`,
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Stops every Signal connector with `stopWithResult` (which drains only the active send RPC, capped at
   * 30 s, and forces UNKNOWN at the limit). A connector whose stop Result is Err keeps its ownership:
   * repair its state writes (DB only) and stop it again, a bounded number of times. Queue dispatch is
   * NOT waited for: active providers may finish and save while claims are quiesced.
   * Err means replacement is withheld and nothing was applied.
   */
  private async stopSignalConnectors(
    connectors: readonly ChannelConnector[],
  ): Promise<Result<void, DaemonError>> {
    let remaining = connectors.filter(
      (connector): connector is SignalConnector => connector instanceof SignalConnector,
    );
    for (let attempt = 0; attempt < RELOAD_SIGNAL_STOP_ATTEMPTS && remaining.length > 0; attempt++) {
      const results = await Promise.all(
        remaining.map(async (connector) => {
          const first = await connector.stopWithResult();
          if (first.isOk()) return { connector, ok: true };
          try {
            connector.retryStateWrites();
          } catch {
            // The producer still owns the write; a thrown repair is not a settled stop.
          }
          return { connector, ok: (await connector.stopWithResult()).isOk() };
        }),
      );
      remaining = results.filter((entry) => !entry.ok).map((entry) => entry.connector);
    }
    if (remaining.length > 0) {
      this.logger.error(
        { count: remaining.length },
        'daemon: reload pending — a Signal connector did not stop cleanly; claims stay quiesced, retrying',
      );
      return err(
        new DaemonError(
          'Reload pending: a Signal connector did not stop cleanly; automatic retry scheduled',
        ),
      );
    }
    return ok(undefined);
  }

  private async stopOtherConnectors(connectors: readonly ChannelConnector[]): Promise<void> {
    for (const connector of connectors) {
      if (connector instanceof SignalConnector) continue;
      try {
        await connector.stop();
      } catch (cause) {
        this.logger.error({ cause, channelName: connector.name }, 'daemon: error stopping channel connector');
      }
    }
  }

  /** Personas, skills and MCP are swapped together; the runner and config snapshot follow the channels. */
  private async applyGlobalReload(
    newConfig: TalondConfig,
    loadedSkills: DaemonContext['loadedSkills'],
  ): Promise<Result<void, DaemonError>> {
    const ctx = this.ctx!;
    const personaReload = await ctx.personaLoader.loadFromConfig(newConfig.personas);
    if (personaReload.isErr()) {
      return err(new DaemonError(`Failed to reload personas: ${personaReload.error.message}`));
    }

    // Rebuild the A2A agent-card registry in place (shared Map instance held by
    // A2ATaskMapper and A2AServer) so newly added personas are routable. Applied together with
    // the persona reload, i.e. only after the old Signal connectors stopped cleanly.
    if (ctx.a2aCardRegistry) {
      const rebuilt = buildAgentCardRegistry(personaReload.value);
      ctx.a2aCardRegistry.clear();
      for (const [name, card] of rebuilt) ctx.a2aCardRegistry.set(name, card);
    }

    // Update loadedSkills in-place on the context (mutable field for reload).
    (ctx as unknown as { loadedSkills: DaemonContext['loadedSkills'] }).loadedSkills = loadedSkills;

    // Rebuild MCP registrations.
    if (this.mcpRegistry !== null) {
      await this.mcpRegistry.stopAll();
    }
    this.mcpRegistry = new McpRegistry(this.logger);
    for (const skill of ctx.loadedSkills) {
      for (const server of skill.resolvedMcpServers) {
        try {
          this.mcpRegistry.register(server.name, server.config);
        } catch (cause) {
          this.logger.warn(
            { mcpServer: server.name, cause: String(cause) },
            'daemon: failed to register MCP server definition',
          );
        }
      }
    }
    await this.mcpRegistry.startAll();
    return ok(undefined);
  }

  /** Unregisters the stopped generation, registers and starts the next one, and bumps the generation. */
  private async replaceRegistry(
    config: TalondConfig,
    stopped: readonly ChannelConnector[],
  ): Promise<void> {
    const ctx = this.ctx!;
    const generation = this.signalGeneration + 1;
    for (const connector of stopped) {
      ctx.channelRegistry.unregister(connector.name);
    }
    registerChannels(config, ctx.channelRegistry, {
      channelRepo: ctx.repos.channel,
      bindingRepo: ctx.repos.binding,
      personaRepo: ctx.repos.persona,
      messagePipeline: ctx.messagePipeline,
      logger: this.logger,
      signal: {
        ...signalRepositoriesFor(ctx.db),
        queue: ctx.repos.queue,
        generation,
      },
    });
    if (config.voice?.enabled && ctx.voiceSessionService) {
      const voiceConnector = registerVoiceConnector(
        {
          channelRegistry: ctx.channelRegistry,
          channelRepo: ctx.repos.channel,
          threadRepository: ctx.repos.thread,
          sessionService: ctx.voiceSessionService,
          logger: this.logger,
        },
        BROWSER_VOICE_CHANNEL_NAME,
      );
      if (voiceConnector.isErr()) {
        this.logger.error(
          { cause: voiceConnector.error },
          'daemon: reload — failed to register browser voice connector',
        );
      }
    }
    try {
      await ctx.channelRegistry.startAll();
      this.logger.info('daemon: all channel connectors started');
    } catch (cause) {
      this.logger.error(
        { cause },
        'daemon: one or more channel connectors failed to start — continuing without them',
      );
    }
    injectSiblingBotIds(ctx.channelRegistry, this.logger);
    this.signalGeneration = generation;
  }

  private scheduleReloadRetry(configPath: string): void {
    if (this.reloadRetryTimer !== null) return;
    const timer = setTimeout(() => {
      this.reloadRetryTimer = null;
      if (this._state === 'running') void this.reload(configPath);
    }, RELOAD_RETRY_MS);
    timer.unref();
    this.reloadRetryTimer = timer;
  }

  private clearReloadRetry(): void {
    if (this.reloadRetryTimer === null) return;
    clearTimeout(this.reloadRetryTimer);
    this.reloadRetryTimer = null;
  }

  private logChannelDiff(oldConfig: TalondConfig, newConfig: TalondConfig): void {
    const oldNames = new Set(oldConfig.channels.map((c) => c.name));
    const newNames = new Set(newConfig.channels.map((c) => c.name));

    const added = newConfig.channels.filter((c) => !oldNames.has(c.name)).map((c) => c.name);
    const removed = oldConfig.channels.filter((c) => !newNames.has(c.name)).map((c) => c.name);

    if (added.length > 0) this.logger.info({ added }, 'daemon: reload — new channels detected');
    if (removed.length > 0) this.logger.info({ removed }, 'daemon: reload — channels removed');
  }

  private logPersonaDiff(oldConfig: TalondConfig, newConfig: TalondConfig): void {
    const oldNames = new Set(oldConfig.personas.map((p) => p.name));
    const newNames = new Set(newConfig.personas.map((p) => p.name));

    const added = newConfig.personas.filter((p) => !oldNames.has(p.name)).map((p) => p.name);
    const removed = oldConfig.personas.filter((p) => !newNames.has(p.name)).map((p) => p.name);
    const changed = newConfig.personas
      .filter((p) => {
        if (!oldNames.has(p.name)) return false;
        const old = oldConfig.personas.find((op) => op.name === p.name);
        return JSON.stringify(old) !== JSON.stringify(p);
      })
      .map((p) => p.name);

    if (added.length > 0) this.logger.info({ added: added }, 'daemon: reload — personas added');
    if (removed.length > 0)
      this.logger.info({ removed: removed }, 'daemon: reload — personas removed');
    if (changed.length > 0)
      this.logger.info({ changed: changed }, 'daemon: reload — personas changed');
  }
}

function resolveVoiceAccessToken(config: TalondConfig): string | undefined {
  const voice = config.voice;
  if (!voice?.enabled) return undefined;
  return (
    voice.accessToken ??
    config.auth.providers[voice.accessTokenRef]?.apiKey ??
    config.auth.apiKey
  );
}
