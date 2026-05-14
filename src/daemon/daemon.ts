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
import { registerChannels, injectSiblingBotIds } from '../channels/channel-setup.js';
import { cleanupOrphanedMcpChildren } from './mcp-orphan-cleanup.js';

import type { DaemonContext } from './daemon-context.js';
import type { DaemonState, DaemonHealth } from './daemon-types.js';
import { DaemonIpcServer } from '../ipc/daemon-ipc-server.js';
import type { DaemonCommand, DaemonResponse } from '../ipc/daemon-ipc.js';
import type { TalondConfig } from '../core/config/config-types.js';

// ---------------------------------------------------------------------------
// TalondDaemon
// ---------------------------------------------------------------------------

export class TalondDaemon {
  private _state: DaemonState = 'stopped';
  private startedAt: number | null = null;

  private ctx: DaemonContext | null = null;
  private agentRunner: AgentRunner | null = null;
  private ipcServer: DaemonIpcServer | null = null;
  private watchdog: WatchdogNotifier | null = null;
  private mcpRegistry: McpRegistry | null = null;

  constructor(private readonly logger: pino.Logger) {}

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

    // 0. Sweep orphaned MCP subprocesses left behind by previous runs. The
    // openai-compatible wrapper's per-run cleanup is the primary fix for
    // issue #210; this catches the case where the wrapper itself died
    // before its `finally` block could run (e.g. SIGKILL on timeout) and
    // a marked grandchild is still holding a port (e.g. mcp-remote's
    // OAuth callback). No-op on non-Linux.
    cleanupOrphanedMcpChildren(this.logger);

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

  async stop(): Promise<void> {
    if (this._state === 'stopped' || this._state === 'stopping') {
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
      try {
        await this.ctx.channelRegistry.stopAll();
      } catch (cause) {
        this.logger.error({ cause }, 'daemon: error stopping channel connectors');
      }

      this.ctx.scheduler.stop();

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
      return err(
        new DaemonError(`Failed to reload skills: ${loadedSkillsResult.error.message}`),
      );
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
