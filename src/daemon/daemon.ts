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

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ok, err, type Result } from 'neverthrow';
import type pino from 'pino';

import { loadConfig } from '../core/config/config-loader.js';
import { DaemonError, LifecycleError } from '../core/errors/error-types.js';
import { SkillLoader } from '../skills/skill-loader.js';
import { McpRegistry } from '../mcp/mcp-registry.js';

import { bootstrap } from './daemon-bootstrap.js';
import { AgentRunner } from './agent-runner.js';
import { writePidFile, removePidFile } from './lifecycle.js';
import { WatchdogNotifier } from './watchdog.js';
import { registerChannels, injectSiblingBotIds } from '../channels/channel-setup.js';

import type { DaemonContext } from './daemon-context.js';
import type { DaemonState, DaemonHealth } from './daemon-types.js';
import { DaemonIpcServer } from '../ipc/daemon-ipc-server.js';
import type { DaemonCommand, DaemonResponse } from '../ipc/daemon-ipc.js';
import type { TalondConfig } from '../core/config/config-types.js';
import { ensureOwnerOnlyDir } from '../core/fs/private-paths.js';
import { LifecycleAdminService } from '../lifecycle/lifecycle-admin-service.js';
import { PromptImprovementProjector } from '../lifecycle/behavior/prompt-improvement-projector.js';

type LifecycleHandlersCommand = Extract<DaemonCommand, { command: 'lifecycle-handlers' }>;
type LifecycleInspectCommand = Extract<DaemonCommand, { command: 'lifecycle-inspect' }>;
type LifecycleReplayCommand = Extract<DaemonCommand, { command: 'lifecycle-replay' }>;
type LifecycleDisableCommand = Extract<DaemonCommand, { command: 'lifecycle-disable' }>;
type LifecycleCandidatesCommand = Extract<DaemonCommand, { command: 'lifecycle-candidates' }>;
type LifecyclePromoteCommand = Extract<DaemonCommand, { command: 'lifecycle-promote' }>;
type LifecycleRollbackPromotionCommand = Extract<
  DaemonCommand,
  { command: 'lifecycle-rollback-promotion' }
>;
type LifecycleBacklog = ReturnType<typeof emptyLifecycleBacklog>;
type LifecycleBacklogTiming = ReturnType<typeof emptyLifecycleBacklogTiming>;

interface LifecycleHandlerBacklogData {
  readonly backlog: LifecycleBacklog;
  readonly timing: LifecycleBacklogTiming;
  readonly statusTiming: Partial<Record<keyof LifecycleBacklog, LifecycleBacklogTiming>>;
}
import { waitForCodexSandboxRunner } from '../subagents/codex-sandbox-runner-readiness.js';

// ---------------------------------------------------------------------------
// TalondDaemon
// ---------------------------------------------------------------------------

export interface TalondDaemonDeps {
  waitForCodexSandboxRunner?: typeof waitForCodexSandboxRunner;
}

export class TalondDaemon {
  private _state: DaemonState = 'stopped';
  private startedAt: number | null = null;

  private ctx: DaemonContext | null = null;
  private agentRunner: AgentRunner | null = null;
  private ipcServer: DaemonIpcServer | null = null;
  private watchdog: WatchdogNotifier | null = null;
  private mcpRegistry: McpRegistry | null = null;
  private deferredTeardown: Promise<void> | null = null;

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

    try {
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
          return this.failStartup(runnerReady.error);
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
      this.agentRunner = new AgentRunner(this.ctx);
      this.ctx.hostToolsBridge.start();

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

      // 5. Start queue processing.
      this.ctx.queueManager.startProcessing((item) => this.agentRunner!.run(item));

      // Lifecycle delivery is deliberately independent from the user queue: a
      // slow or failing handler may retry in its own durable workload but never
      // consumes queue capacity or changes an originating queue item result.
      this.ctx.lifecycleRuntime?.start();

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
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error({ cause }, 'daemon: startup failed after bootstrap');
      const cleaned = await this.cleanupFailedStart();
      if (!cleaned) {
        this.beginDeferredTeardown();
        return err(
          new DaemonError(`Failed to start daemon: ${message}; workloads are still draining`),
        );
      }
      this._state = 'stopped';
      return err(
        new DaemonError(
          `Failed to start daemon: ${message}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /** Best-effort reverse-order cleanup for a startup that never reached running. */
  private async cleanupFailedStart(): Promise<boolean> {
    this.watchdog?.stop();
    this.watchdog = null;
    this.ipcServer?.stop();
    this.ipcServer = null;
    const ctx = this.ctx;
    if (!ctx) return true;
    try {
      removePidFile(ctx.dataDir);
    } catch (cause) {
      this.logStartupCleanupFailure('remove PID file', cause);
    }
    let schedulerDrained = false;
    try {
      schedulerDrained = (await ctx.scheduler.stop())?.status !== 'timed_out';
    } catch (cause) {
      this.logStartupCleanupFailure('stop scheduler', cause);
    }
    let lifecycleDrained = false;
    try {
      lifecycleDrained = (await ctx.lifecycleRuntime?.stop()) ?? true;
    } catch (cause) {
      this.logStartupCleanupFailure('stop lifecycle dispatcher', cause);
    }
    let queueDrained = false;
    try {
      queueDrained = (await ctx.queueManager.stopProcessing())?.status !== 'timed_out';
    } catch (cause) {
      this.logStartupCleanupFailure('stop queue processing', cause);
    }
    if (!schedulerDrained || !lifecycleDrained || !queueDrained) return false;
    try {
      await ctx.channelRegistry.stopAll();
    } catch (cause) {
      this.logStartupCleanupFailure('stop channel connectors', cause);
    }
    try {
      ctx.hostToolsBridge.stop();
    } catch (cause) {
      this.logStartupCleanupFailure('stop host tools bridge', cause);
    }
    try {
      await this.mcpRegistry?.stopAll();
    } catch (cause) {
      this.logStartupCleanupFailure('stop MCP registry', cause);
    }
    this.mcpRegistry = null;
    try {
      await ctx.backgroundAgentManager?.shutdown();
    } catch (cause) {
      this.logStartupCleanupFailure('shutdown background agents', cause);
    }
    try {
      await ctx.observability.shutdown();
    } catch (cause) {
      this.logStartupCleanupFailure('shutdown observability', cause);
    }
    try {
      ctx.db.close();
    } catch (cause) {
      this.logStartupCleanupFailure('close database', cause);
    }
    this.ctx = null;
    this.agentRunner = null;
    this.startedAt = null;
    return true;
  }

  private beginDeferredTeardown(): void {
    if (this.deferredTeardown || !this.ctx) return;
    const ctx = this.ctx;
    this.deferredTeardown = Promise.all([
      ctx.scheduler.waitForDrain(),
      ctx.queueManager.waitForDrain(),
      ctx.lifecycleRuntime?.waitForDrain() ?? Promise.resolve(),
    ])
      .then(() => this.cleanupFailedStart())
      .then((cleaned) => {
        if (cleaned) this._state = 'stopped';
      })
      .catch((cause) => {
        this.logStartupCleanupFailure('deferred workload drain', cause);
      })
      .finally(() => {
        this.deferredTeardown = null;
      });
  }

  private logStartupCleanupFailure(step: string, cause: unknown): void {
    this.logger.debug({ cause, step }, 'daemon: startup cleanup step failed');
  }

  // ---------------------------------------------------------------------------
  // Stop
  // ---------------------------------------------------------------------------

  async stop(): Promise<void> {
    if (this._state === 'stopped') {
      return;
    }
    if (this._state === 'stopping') {
      // A previous bounded drain reported an unknown outcome. A later stop
      // call is the explicit recovery path: it retries only deferred joining,
      // never tears down dependencies beneath unconfirmed work.
      this.beginDeferredTeardown();
      return;
    }

    this._state = 'stopping';
    this.logger.info('daemon: stopping');

    if (this.watchdog !== null) {
      this.watchdog.notifyStopping();
      this.watchdog.stop();
      this.watchdog = null;
    }

    if (this.ctx !== null) {
      let schedulerDrained = false;
      let lifecycleDrained = false;
      let queueDrained = false;
      try {
        schedulerDrained = (await this.ctx.scheduler.stop())?.status !== 'timed_out';
      } catch (cause) {
        this.logStartupCleanupFailure('stop scheduler', cause);
      }
      try {
        lifecycleDrained = (await this.ctx.lifecycleRuntime?.stop()) ?? true;
      } catch (cause) {
        this.logStartupCleanupFailure('stop lifecycle dispatcher', cause);
      }

      // Join user work while its MCP and host-tool dependencies are still
      // available; closing either first can strand a claimed queue item.
      this.ctx.sessionTracker.clearAll();
      try {
        queueDrained = (await this.ctx.queueManager.stopProcessing())?.status !== 'timed_out';
      } catch (cause) {
        this.logStartupCleanupFailure('stop queue processing', cause);
      }
      if (!schedulerDrained || !lifecycleDrained || !queueDrained) {
        this.beginDeferredTeardown();
        throw new DaemonError('Daemon workloads are still draining; resource teardown is deferred');
      }

      try {
        await this.ctx.channelRegistry.stopAll();
      } catch (cause) {
        this.logger.error({ cause }, 'daemon: error stopping channel connectors');
      }

      if (this.mcpRegistry !== null) {
        await this.mcpRegistry.stopAll();
        this.mcpRegistry = null;
      }

      this.ctx.hostToolsBridge.stop();
      await this.ctx.backgroundAgentManager?.shutdown();
      try {
        await this.ctx.observability.shutdown();
      } catch (cause) {
        this.logger.warn({ cause }, 'daemon: failed to shut down observability');
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

  private async failStartup(cause: Error): Promise<Result<void, DaemonError>> {
    const context = this.ctx;
    this.ctx = null;
    this.agentRunner = null;
    this._state = 'error';

    if (context !== null) {
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

    return err(
      new DaemonError(`Failed to start Codex sandbox runner dependency: ${cause.message}`, cause),
    );
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

  async reload(configPath?: string): Promise<Result<void, DaemonError>> {
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

    const newConfig = configResult.value;
    const oldConfig = this.ctx.config;

    if (lifecycleConfigurationChanged(oldConfig, newConfig)) {
      return err(
        new DaemonError(
          'Cannot hot-reload lifecycle configuration or lifecycle-attached persona subscriptions/authority; restart required to apply these changes',
        ),
      );
    }

    this.logger.info({ configPath: effectivePath }, 'daemon: applying hot-reload');

    // Log level — apply immediately.
    if (newConfig.logLevel !== oldConfig.logLevel) {
      this.logger.info(
        { from: oldConfig.logLevel, to: newConfig.logLevel },
        'daemon: log level changed — applying immediately',
      );
      this.logger.level = newConfig.logLevel;
    }

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

    // Reload personas.
    const personaReload = await this.ctx.personaLoader.loadFromConfig(newConfig.personas);
    if (personaReload.isErr()) {
      return err(new DaemonError(`Failed to reload personas: ${personaReload.error.message}`));
    }

    // Reload skills.
    const skillLoader = new SkillLoader(this.logger);
    const loadedSkillsResult = await skillLoader.loadFromPersonaConfig(
      newConfig.personas,
      this.ctx.dataDir,
    );
    if (loadedSkillsResult.isErr()) {
      return err(new DaemonError(`Failed to reload skills: ${loadedSkillsResult.error.message}`));
    }
    // Update loadedSkills in-place on the context (mutable field for reload).
    (this.ctx as unknown as { loadedSkills: DaemonContext['loadedSkills'] }).loadedSkills =
      loadedSkillsResult.value;

    // Rebuild MCP registrations.
    if (this.mcpRegistry !== null) {
      await this.mcpRegistry.stopAll();
    }
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

    // Reconfigure channels: stop all → unregister → re-register → start.
    await this.ctx.channelRegistry.stopAll();
    for (const connector of this.ctx.channelRegistry.listAll()) {
      this.ctx.channelRegistry.unregister(connector.name);
    }
    registerChannels(newConfig, this.ctx.channelRegistry, {
      channelRepo: this.ctx.repos.channel,
      bindingRepo: this.ctx.repos.binding,
      personaRepo: this.ctx.repos.persona,
      messagePipeline: this.ctx.messagePipeline,
      logger: this.logger,
    });
    try {
      await this.ctx.channelRegistry.startAll();
      this.logger.info('daemon: all channel connectors started');
    } catch (cause) {
      this.logger.error(
        { cause },
        'daemon: one or more channel connectors failed to start — continuing without them',
      );
    }
    injectSiblingBotIds(this.ctx.channelRegistry, this.logger);

    // Rebuild AgentRunner so it picks up the new loadedSkills.
    this.agentRunner = new AgentRunner(this.ctx);

    // Update config snapshot.
    (this.ctx as { config: TalondConfig }).config = newConfig;

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
          },
        };
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
          void this.stop().catch((cause) => {
            // A bounded drain deliberately rejects to preserve dependent
            // resources for deferred teardown. IPC shutdown is fire-and-forget,
            // so contain that expected Result boundary rather than leaking an
            // unhandled rejection into the process.
            this.logger.error({ cause }, 'daemon: IPC shutdown deferred after drain failure');
          });
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
        const validStatuses: readonly QS[] = [
          'pending',
          'claimed',
          'processing',
          'completed',
          'failed',
          'dead_letter',
        ];
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

      case 'lifecycle-handlers':
        return this.handleLifecycleHandlersCommand(command, responseId);

      case 'lifecycle-inspect':
        return this.handleLifecycleInspectCommand(command, responseId);

      case 'lifecycle-replay':
        return this.handleLifecycleReplayCommand(command, responseId);

      case 'lifecycle-disable':
        return this.handleLifecycleDisableCommand(command, responseId);

      case 'lifecycle-candidates':
        return this.handleLifecycleCandidatesCommand(command, responseId);

      case 'lifecycle-promote':
        return await this.handleLifecyclePromoteCommand(command, responseId);

      case 'lifecycle-rollback-promotion':
        return await this.handleLifecycleRollbackPromotionCommand(command, responseId);
    }
  }

  private handleLifecycleHandlersCommand(
    command: LifecycleHandlersCommand,
    responseId: string,
  ): DaemonResponse {
    if (!this.ctx) return this.ipcError(responseId, command.id, 'Daemon not running');
    const limit = this.payloadLimit(command.payload?.limit);
    const statusCounts = this.ctx.repos.lifecycleDelivery.countByStatus();
    if (statusCounts.isErr())
      return this.ipcError(responseId, command.id, statusCounts.error.message);

    const backlog = emptyLifecycleBacklog();
    for (const row of statusCounts.value) backlog[row.status] = row.count;
    const dispatcher = this.ctx.lifecycleRuntime?.dispatcher.snapshot();
    const dispatcherHandlers = new Map(
      (dispatcher?.handlers ?? []).map((handler) => [handler.handlerId, handler]),
    );

    const subscriptionsByHandler = new Map<string, { personas: Set<string>; count: number }>();
    for (const persona of this.ctx.config.personas) {
      for (const subscription of persona.lifecycle?.subscriptions ?? []) {
        const current = subscriptionsByHandler.get(subscription.handler) ?? {
          personas: new Set<string>(),
          count: 0,
        };
        current.personas.add(persona.name);
        current.count += 1;
        subscriptionsByHandler.set(subscription.handler, current);
      }
    }

    const configuredHandlers = this.ctx.config.lifecycle?.handlers ?? [];
    const displayedHandlers = configuredHandlers.slice(0, limit);
    const handlerBacklog = this.ctx.repos.lifecycleDelivery.summarizeHandlersByIds(
      displayedHandlers.map((handler) => handler.id),
    );
    if (handlerBacklog.isErr()) {
      return this.ipcError(responseId, command.id, handlerBacklog.error.message);
    }
    const handlerRows = new Map<string, LifecycleHandlerBacklogData>();
    const readAt = Date.now();
    for (const row of handlerBacklog.value) {
      const summary = handlerRows.get(row.handler_id) ?? emptyLifecycleHandlerBacklogData();
      summary.backlog[row.status] += row.count;
      const statusTiming = rowTiming(row.oldest_created_at, row.next_retry_at, readAt);
      summary.statusTiming[row.status] = statusTiming;
      if (isActiveLifecycleBacklogStatus(row.status)) {
        mergeLifecycleBacklogTiming(summary.timing, statusTiming);
      }
      handlerRows.set(row.handler_id, summary);
    }

    const handlers = displayedHandlers.map((handler) => {
      const subscriptions = subscriptionsByHandler.get(handler.id);
      const circuit = dispatcherHandlers.get(handler.id)?.circuit ?? 'closed';
      const handlerBacklogData = handlerRows.get(handler.id) ?? emptyLifecycleHandlerBacklogData();
      return {
        handlerId: handler.id,
        ...(handler.displayName ? { displayName: handler.displayName } : {}),
        mode: handler.mode,
        runtimeKind: handler.runtime.kind,
        personas: [...(subscriptions?.personas ?? new Set<string>())].sort(),
        subscriptions: subscriptions?.count ?? 0,
        backlog: handlerBacklogData.backlog,
        timing: handlerBacklogData.timing,
        statusTiming: handlerBacklogData.statusTiming,
        circuit,
      };
    });

    return {
      id: responseId,
      commandId: command.id,
      success: true,
      data: {
        lifecycleEnabled: this.ctx.config.lifecycle?.enabled ?? false,
        dispatcher: dispatcher
          ? {
              running: dispatcher.running,
              stopping: dispatcher.stopping,
              inFlight: dispatcher.inFlight,
              handlers: dispatcher.handlers,
            }
          : null,
        backlog,
        handlers,
      },
    };
  }

  private handleLifecycleInspectCommand(
    command: LifecycleInspectCommand,
    responseId: string,
  ): DaemonResponse {
    if (!this.ctx) return this.ipcError(responseId, command.id, 'Daemon not running');
    const eventId = command.payload.eventId;
    const handlerId = command.payload.handlerId;
    const event = this.ctx.repos.lifecycleEvent.findById(eventId);
    if (event.isErr()) return this.ipcError(responseId, command.id, event.error.message);
    const deliveries = this.ctx.repos.lifecycleDelivery.findByEventId(eventId);
    if (deliveries.isErr()) return this.ipcError(responseId, command.id, deliveries.error.message);
    return {
      id: responseId,
      commandId: command.id,
      success: true,
      data: {
        event: event.value
          ? {
              eventId: event.value.event_id,
              type: event.value.type,
              aggregateType: event.value.aggregate_type,
              aggregateId: event.value.aggregate_id,
              retentionTombstoneReason: event.value.retention_tombstone_reason,
              createdAt: event.value.created_at,
            }
          : null,
        deliveries: deliveries.value
          .filter((delivery) => handlerId === undefined || delivery.handler_id === handlerId)
          .map((delivery) => this.lifecycleDeliveryData(delivery)),
      },
    };
  }

  private handleLifecycleReplayCommand(
    command: LifecycleReplayCommand,
    responseId: string,
  ): DaemonResponse {
    if (!this.ctx) return this.ipcError(responseId, command.id, 'Daemon not running');
    const eventId = command.payload.eventId;
    const handlerId = command.payload.handlerId;
    const service = new LifecycleAdminService({
      deliveries: this.ctx.repos.lifecycleDelivery,
      auditLogger: this.ctx.auditLogger,
    });
    const replay = service.replayDelivery(eventId, handlerId);
    if (replay.isErr()) return this.ipcError(responseId, command.id, replay.error.message);
    return {
      id: responseId,
      commandId: command.id,
      success: true,
      data: this.lifecycleDeliveryData(replay.value),
    };
  }

  private handleLifecycleDisableCommand(
    command: LifecycleDisableCommand,
    responseId: string,
  ): DaemonResponse {
    if (!this.ctx) return this.ipcError(responseId, command.id, 'Daemon not running');
    const handlerId = command.payload.handlerId;
    const service = new LifecycleAdminService({
      deliveries: this.ctx.repos.lifecycleDelivery,
      auditLogger: this.ctx.auditLogger,
    });
    const disabled = service.disableHandler(handlerId);
    if (disabled.isErr()) return this.ipcError(responseId, command.id, disabled.error.message);
    return {
      id: responseId,
      commandId: command.id,
      success: true,
      data: {
        handlerId: disabled.value.handlerId,
        disabledDeliveries: disabled.value.disabledDeliveries,
      },
    };
  }

  private handleLifecycleCandidatesCommand(
    command: LifecycleCandidatesCommand,
    responseId: string,
  ): DaemonResponse {
    if (!this.ctx) return this.ipcError(responseId, command.id, 'Daemon not running');
    const persona = command.payload.persona;
    const limit = this.payloadLimit(command.payload?.limit);
    const candidates = this.ctx.repos.behaviorSignal.findCandidateSummariesByPersona(
      persona,
      limit,
    );
    if (candidates.isErr()) return this.ipcError(responseId, command.id, candidates.error.message);
    const data = [];
    for (const candidate of candidates.value) {
      data.push({
        candidateId: candidate.candidate_id,
        persona: candidate.persona,
        kind: candidate.kind,
        status: candidate.status,
        summary: candidate.summary,
        proposedBehavior: candidate.proposed_behavior,
        confidence: candidate.confidence,
        evidenceSources: candidate.evidence_sources,
        createdAt: candidate.created_at,
        updatedAt: candidate.updated_at,
      });
    }
    return {
      id: responseId,
      commandId: command.id,
      success: true,
      data: { persona, candidates: data },
    };
  }

  private async handleLifecyclePromoteCommand(
    command: LifecyclePromoteCommand,
    responseId: string,
  ): Promise<DaemonResponse> {
    if (!this.ctx) return this.ipcError(responseId, command.id, 'Daemon not running');
    const service = this.promptImprovementProjector();
    const applied = await service.apply({
      persona: command.payload.persona,
      promotionId: command.payload.promotionId,
      approvedBy: command.payload.approvedBy,
    });
    if (applied.isErr()) return this.ipcError(responseId, command.id, applied.error.message);
    return {
      id: responseId,
      commandId: command.id,
      success: true,
      data: { ...applied.value },
    };
  }

  private async handleLifecycleRollbackPromotionCommand(
    command: LifecycleRollbackPromotionCommand,
    responseId: string,
  ): Promise<DaemonResponse> {
    if (!this.ctx) return this.ipcError(responseId, command.id, 'Daemon not running');
    const service = this.promptImprovementProjector();
    const rolledBack = await service.rollback({
      persona: command.payload.persona,
      activationId: command.payload.activationId,
      reason: command.payload.reason,
    });
    if (rolledBack.isErr()) return this.ipcError(responseId, command.id, rolledBack.error.message);
    return {
      id: responseId,
      commandId: command.id,
      success: true,
      data: { ...rolledBack.value },
    };
  }

  private promptImprovementProjector(): PromptImprovementProjector {
    if (!this.ctx) throw new LifecycleError('Daemon not running');
    return new PromptImprovementProjector(this.ctx.repos.behaviorSignal, {
      config: this.ctx.config,
      auditLogger: this.ctx.auditLogger,
      reload: async (): Promise<Result<string, LifecycleError>> => {
        const reloaded = await this.reload(this.ctx?.configPath);
        if (reloaded.isErr()) {
          return err(new LifecycleError(reloaded.error.message, reloaded.error));
        }
        return ok(`prompt-reload-${randomUUID()}`);
      },
    });
  }

  private lifecycleDeliveryData(delivery: {
    event_id: string;
    handler_id: string;
    persona: string;
    status: string;
    attempts: number;
    max_attempts: number;
    next_retry_at: number | null;
    last_error: string | null;
    terminal_tombstone_reason: string | null;
    completed_at: number | null;
    created_at: number;
    updated_at: number;
  }): Record<string, unknown> {
    return {
      eventId: delivery.event_id,
      handlerId: delivery.handler_id,
      persona: delivery.persona,
      status: delivery.status,
      attempts: delivery.attempts,
      maxAttempts: delivery.max_attempts,
      nextRetryAt: delivery.next_retry_at,
      lastErrorCode: parseLifecycleErrorCode(delivery.last_error),
      tombstoneReason: delivery.terminal_tombstone_reason,
      completedAt: delivery.completed_at,
      createdAt: delivery.created_at,
      updatedAt: delivery.updated_at,
    };
  }

  private payloadLimit(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.min(Math.max(Math.trunc(value), 1), 100)
      : 50;
  }

  private ipcError(responseId: string, commandId: string, error: string): DaemonResponse {
    return { id: responseId, commandId, success: false, error };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

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

function lifecycleConfigurationChanged(oldConfig: TalondConfig, newConfig: TalondConfig): boolean {
  if (JSON.stringify(oldConfig.lifecycle ?? null) !== JSON.stringify(newConfig.lifecycle ?? null)) {
    return true;
  }

  const personaLifecycleConfiguration = (config: TalondConfig): string =>
    JSON.stringify(
      config.personas
        .filter((persona) => persona.lifecycle !== undefined)
        .map((persona) => ({
          name: persona.name,
          lifecycle: persona.lifecycle,
          subagents: persona.subagents,
          capabilities: persona.capabilities,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    );

  return personaLifecycleConfiguration(oldConfig) !== personaLifecycleConfiguration(newConfig);
}

function emptyLifecycleBacklog(): {
  pending: number;
  claimed: number;
  failed: number;
  completed: number;
  dead_letter: number;
} {
  return {
    pending: 0,
    claimed: 0,
    failed: 0,
    completed: 0,
    dead_letter: 0,
  };
}

function emptyLifecycleBacklogTiming(): {
  oldestCreatedAt: number | null;
  oldestAgeMs: number | null;
  nextRetryAt: number | null;
} {
  return {
    oldestCreatedAt: null,
    oldestAgeMs: null,
    nextRetryAt: null,
  };
}

function emptyLifecycleHandlerBacklogData(): LifecycleHandlerBacklogData {
  return {
    backlog: emptyLifecycleBacklog(),
    timing: emptyLifecycleBacklogTiming(),
    statusTiming: {},
  };
}

function rowTiming(
  oldestCreatedAt: number | null,
  nextRetryAt: number | null,
  readAt: number,
): LifecycleBacklogTiming {
  return {
    oldestCreatedAt,
    oldestAgeMs: oldestCreatedAt === null ? null : Math.max(0, readAt - oldestCreatedAt),
    nextRetryAt,
  };
}

function mergeLifecycleBacklogTiming(
  target: LifecycleBacklogTiming,
  source: LifecycleBacklogTiming,
): void {
  if (
    source.oldestCreatedAt !== null &&
    (target.oldestCreatedAt === null || source.oldestCreatedAt < target.oldestCreatedAt)
  ) {
    target.oldestCreatedAt = source.oldestCreatedAt;
    target.oldestAgeMs = source.oldestAgeMs;
  }
  if (
    source.nextRetryAt !== null &&
    (target.nextRetryAt === null || source.nextRetryAt < target.nextRetryAt)
  ) {
    target.nextRetryAt = source.nextRetryAt;
  }
}

function isActiveLifecycleBacklogStatus(status: keyof LifecycleBacklog): boolean {
  return status === 'pending' || status === 'claimed' || status === 'failed';
}

function parseLifecycleErrorCode(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed &&
      typeof parsed === 'object' &&
      'code' in parsed &&
      typeof parsed.code === 'string'
      ? parsed.code
      : null;
  } catch {
    return null;
  }
}
