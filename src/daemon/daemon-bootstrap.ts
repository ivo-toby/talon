/**
 * DaemonBootstrap — builds a fully-initialized DaemonContext.
 *
 * Handles the pure setup phase: config loading, database, migrations,
 * repositories, persona/skill loading, and subsystem wiring.
 *
 * Does NOT start any services (channels, queue, scheduler, IPC).
 * The daemon orchestrator calls start methods after receiving the context.
 */

import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { ok, err, type Result } from 'neverthrow';
import type pino from 'pino';

import { loadConfig } from '../core/config/config-loader.js';
import { createDatabase } from '../core/database/connection.js';
import { runMigrations } from '../core/database/migrations/runner.js';

import {
  QueueRepository,
  ThreadRepository,
  ChannelRepository,
  PersonaRepository,
  BackgroundTaskRepository,
  ExecutionEnvRepository,
  ExecutionEnvCheckpointRepository,
  ScheduleRepository,
  AuditRepository,
  MessageRepository,
  RunRepository,
  BindingRepository,
  MemoryRepository,
  A2ATaskRepository,
} from '../core/database/repositories/index.js';
import { buildAgentCardRegistry, A2ATaskMapper, A2AServer } from '../a2a/index.js';

import { ChannelRegistry } from '../channels/channel-registry.js';
import { ChannelRouter } from '../channels/channel-router.js';
import { registerChannels } from '../channels/channel-setup.js';
import { MessagePipeline } from '../pipeline/message-pipeline.js';
import { QueueManager } from '../queue/queue-manager.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { DaemonError } from '../core/errors/error-types.js';
import { AuditLogger } from '../core/logging/audit-logger.js';
import { RepositoryAuditStore } from '../core/database/repositories/audit-repository.js';
import { PersonaLoader } from '../personas/persona-loader.js';
import { SkillLoader } from '../skills/skill-loader.js';
import { SkillResolver } from '../skills/skill-resolver.js';
import { ThreadWorkspace } from '../memory/thread-workspace.js';
import { SessionTracker } from '../sandbox/session-tracker.js';

import { HostToolsBridge } from '../tools/host-tools-bridge.js';
import { BackgroundAgentManager } from '../subagents/background/background-agent-manager.js';
import { ExecutionEnvManager } from '../execution-env/execution-env-manager.js';
import { SpritesClient } from '../execution-env/sprites-client.js';
import { SubAgentLoader } from '../subagents/subagent-loader.js';
import { SubAgentRunner } from '../subagents/subagent-runner.js';
import { ModelResolver } from '../subagents/model-resolver.js';
import { ClaudeCodeProvider } from '../providers/claude-code-provider.js';
import { GeminiCliProvider } from '../providers/gemini-cli-provider.js';
import { CodexCliProvider } from '../providers/codex-cli-provider.js';
import { ProviderRegistry, type ProviderFactoryMap } from '../providers/provider-registry.js';
import { recoverFromCrash } from './lifecycle.js';
import { ContextRoller } from './context-roller.js';
import { ContextAssembler } from './context-assembler.js';
import type { DaemonContext } from './daemon-context.js';
import { loadToolInstructions } from '../tools/tool-instructions.js';
import { createObservabilityService } from '../observability/langfuse/index.js';
import { NoopObservabilityService } from '../observability/langfuse/noop-observability.js';
import type { ObservabilityService } from '../observability/langfuse/observability-types.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Builds a fully-initialized DaemonContext from a config file path.
 *
 * On success, all subsystems are constructed and wired but NOT started.
 * On failure, any partially-opened resources (DB) are cleaned up.
 *
 * @param configPath - Path to the talond.yaml config file.
 * @param logger     - Root pino logger instance.
 * @returns Ok(DaemonContext) or Err(DaemonError).
 */
export async function bootstrap(
  configPath: string,
  logger: pino.Logger,
): Promise<Result<DaemonContext, DaemonError>> {
  logger.info({ configPath }, 'bootstrap: loading config');

  // 1. Load config
  const configResult = loadConfig(configPath);
  if (configResult.isErr()) {
    return err(
      new DaemonError(`Failed to load config: ${configResult.error.message}`, configResult.error),
    );
  }
  const config = configResult.value;
  const dataDir = resolve(config.dataDir);
  config.dataDir = dataDir;

  if (logger.level !== config.logLevel) {
    logger.level = config.logLevel;
  }

  logger.info({ logLevel: config.logLevel }, 'bootstrap: config loaded');

  // 2. Open database
  const dbResult = createDatabase(config.storage.path);
  if (dbResult.isErr()) {
    return err(
      new DaemonError(`Failed to open database: ${dbResult.error.message}`, dbResult.error),
    );
  }
  const db = dbResult.value;

  // 3. Run migrations
  const migrationsDir = join(import.meta.dirname, '../core/database/migrations');
  const migrationsResult = runMigrations(db, migrationsDir);
  if (migrationsResult.isErr()) {
    db.close();
    return err(
      new DaemonError(
        `Failed to run migrations: ${migrationsResult.error.message}`,
        migrationsResult.error,
      ),
    );
  }
  logger.info({ applied: migrationsResult.value }, 'bootstrap: migrations complete');

  // 4. Create repositories
  const repos = {
    queue: new QueueRepository(db),
    thread: new ThreadRepository(db),
    channel: new ChannelRepository(db),
    persona: new PersonaRepository(db),
    backgroundTask: new BackgroundTaskRepository(db),
    executionEnv: new ExecutionEnvRepository(db),
    executionEnvCheckpoint: new ExecutionEnvCheckpointRepository(db),
    schedule: new ScheduleRepository(db),
    audit: new AuditRepository(db),
    message: new MessageRepository(db),
    run: new RunRepository(db),
    binding: new BindingRepository(db),
    memory: new MemoryRepository(db),
    a2aTask: new A2ATaskRepository(db),
  };

  // 5. Audit logger
  const auditStore = new RepositoryAuditStore(repos.audit);
  const auditLogger = new AuditLogger(logger, auditStore);

  // 6. Thread workspace
  const threadWorkspace = new ThreadWorkspace(dataDir);

  // Resolve package version for LangFuse release tagging (F9).
  // Falls back gracefully if package.json is unreadable.
  let packageVersion: string | undefined;
  try {
    const require = createRequire(import.meta.url);
    // From dist/daemon/daemon-bootstrap.js, ../../package.json resolves to the project root.
    const pkg = require('../../package.json') as { version?: string };
    packageVersion = pkg.version;
  } catch {
    // Non-fatal — release will be unset in traces.
  }

  const langfuseConfig = packageVersion && !config.langfuse.release
    ? { ...config.langfuse, release: packageVersion }
    : config.langfuse;

  const observability = await createObservabilityService(langfuseConfig, logger);

  // 7. Load personas
  const personaLoader = new PersonaLoader(repos.persona, logger);
  const personaLoadResult = await personaLoader.loadFromConfig(config.personas);
  if (personaLoadResult.isErr()) {
    await cleanupBootstrapFailure(db, observability, logger);
    return err(
      new DaemonError(
        `Failed to load personas: ${personaLoadResult.error.message}`,
        personaLoadResult.error,
      ),
    );
  }

  // 8. Load skills
  const skillLoader = new SkillLoader(logger);
  const skillResolver = new SkillResolver(logger);
  const loadedSkills = await skillLoader.loadFromPersonaConfig(config.personas, dataDir);
  if (loadedSkills.isErr()) {
    await cleanupBootstrapFailure(db, observability, logger);
    return err(
      new DaemonError(
        `Failed to load skills: ${loadedSkills.error.message}`,
        loadedSkills.error,
      ),
    );
  }

  // 8a. Load tool instruction prompts (keyed by capability prefix).
  // Try dist path first (dist/templates/), fall back to project root (templates/)
  // so instructions load in both built and dev (tsx) mode.
  const distToolInstructionsDir = join(import.meta.dirname, '../templates/tool-instructions');
  const rootToolInstructionsDir = join(process.cwd(), 'templates/tool-instructions');
  let toolInstructions = loadToolInstructions(distToolInstructionsDir);
  if (toolInstructions.size === 0) {
    toolInstructions = loadToolInstructions(rootToolInstructionsDir);
  }
  logger.info(
    { count: toolInstructions.size },
    'bootstrap: tool instructions loaded',
  );

  // 8b. Load sub-agents (optional — if the directory does not exist, skip)
  //     Load from three sources in priority order (later overrides earlier):
  //       1. Built-in default sub-agents (compiled alongside daemon code)
  //       2. cwd()/subagents (project-level custom agents)
  //       3. dataDir/subagents (deployment-level custom agents)
  const subAgentLoader = new SubAgentLoader(logger);
  const builtinSubAgentsDir = join(import.meta.dirname, '../subagents/default');
  const cwdSubAgentsDir = join(process.cwd(), 'subagents');
  const dataDirSubAgentsDir = join(dataDir, 'subagents');

  const builtinSubAgentsResult = await subAgentLoader.loadAll(builtinSubAgentsDir);
  const cwdSubAgentsResult = await subAgentLoader.loadAll(cwdSubAgentsDir);
  const dataDirSubAgentsResult = await subAgentLoader.loadAll(dataDirSubAgentsDir);

  // Merge: built-in first, then cwd, then dataDir (later overrides earlier)
  const mergedAgentMap = new Map<string, import('../subagents/subagent-types.js').LoadedSubAgent>();
  if (builtinSubAgentsResult.isOk()) {
    for (const a of builtinSubAgentsResult.value) {
      mergedAgentMap.set(a.manifest.name, a);
    }
  }
  if (cwdSubAgentsResult.isOk()) {
    for (const a of cwdSubAgentsResult.value) {
      mergedAgentMap.set(a.manifest.name, a);
    }
  }
  if (dataDirSubAgentsResult.isOk()) {
    for (const a of dataDirSubAgentsResult.value) {
      mergedAgentMap.set(a.manifest.name, a);
    }
  }

  let subAgentRunner: SubAgentRunner | null = null;

  // Log any partial load errors regardless of whether agents were found.
  if (builtinSubAgentsResult.isErr()) {
    logger.warn(
      { error: builtinSubAgentsResult.error.message, dir: builtinSubAgentsDir },
      'bootstrap: failed to load built-in sub-agents',
    );
  }
  if (cwdSubAgentsResult.isErr()) {
    logger.warn(
      { error: cwdSubAgentsResult.error.message, dir: cwdSubAgentsDir },
      'bootstrap: failed to load sub-agents from cwd',
    );
  }
  if (dataDirSubAgentsResult.isErr()) {
    logger.warn(
      { error: dataDirSubAgentsResult.error.message, dir: dataDirSubAgentsDir },
      'bootstrap: failed to load sub-agents from dataDir',
    );
  }

  let modelResolver: ModelResolver | null = null;
  if (mergedAgentMap.size > 0) {
    const agentMap = mergedAgentMap;
    modelResolver = new ModelResolver(config.auth.providers ?? {});
    subAgentRunner = new SubAgentRunner(
      agentMap,
      modelResolver,
      {
        memory: repos.memory,
        schedules: repos.schedule,
        personas: repos.persona,
        channels: repos.channel,
        threads: repos.thread,
        messages: repos.message,
        runs: repos.run,
        queue: repos.queue,
        logger,
      },
      logger,
      observability,
    );
    logger.info({ subagents: [...agentMap.keys()] }, 'bootstrap: loaded sub-agents');
  } else {
    logger.info('bootstrap: no sub-agents found, continuing without them');
  }

  // 8c. Context assembler + roller (rolling context window)
  const contextAssembler = new ContextAssembler({
    messageRepo: repos.message,
    memoryRepo: repos.memory,
  });

  // 9. Session tracker
  const sessionTracker = new SessionTracker();

  const providerFactories: ProviderFactoryMap = {
    'claude-code': (providerConfig) => new ClaudeCodeProvider(providerConfig),
    'gemini-cli': (providerConfig) => new GeminiCliProvider(providerConfig),
    'codex-cli': (providerConfig) => new CodexCliProvider(providerConfig, { dataDir }),
  };
  const providerRegistry = new ProviderRegistry(config.agentRunner.providers, providerFactories);
  const backgroundProviderRegistry = new ProviderRegistry(
    config.backgroundAgent.providers,
    providerFactories,
  );

  // 9b. Context roller (needs configured summarizer sub-agents)
  let contextRoller: ContextRoller | null = null;
  const enabledContextProviders = Object.entries(config.agentRunner.providers)
    .filter(([, providerConfig]) => providerConfig.contextManagement.enabled);
  const requestedSummarizers = [
    ...new Set(
      enabledContextProviders
        .map(([, providerConfig]) => providerConfig.contextManagement.summarizer)
        .filter((name): name is string => typeof name === 'string' && name.length > 0),
    ),
  ];

  if (enabledContextProviders.length === 0) {
    logger.info('bootstrap: context rotation disabled for all agent runner providers');
  } else if (modelResolver) {
    const boundSummarizers = new Map<string, import('./context-roller.js').SummarizerRunFn>();

    for (const summarizerName of requestedSummarizers) {
      const summarizerAgent = mergedAgentMap.get(summarizerName);
      if (!summarizerAgent) {
        logger.warn(
          { summarizer: summarizerName },
          'bootstrap: configured summarizer sub-agent not found, skipping',
        );
        continue;
      }

      const summarizerModelResult = await modelResolver.resolve(summarizerAgent.manifest.model);
      if (summarizerModelResult.isErr()) {
        logger.warn(
          { summarizer: summarizerName, error: summarizerModelResult.error.message },
          'bootstrap: failed to resolve model for configured summarizer, skipping',
        );
        continue;
      }

      const summarizerModel = summarizerModelResult.value;
      const summarizerPrompt = summarizerAgent.promptContents.join('\n\n');
      const boundSummarizer: import('./context-roller.js').SummarizerRunFn = (
        threadId, personaId, input,
      ) =>
        summarizerAgent.run(
          {
            threadId,
            personaId,
            model: summarizerModel,
            systemPrompt: summarizerPrompt,
            maxOutputTokens: summarizerAgent.manifest.model.maxTokens,
            rootPaths: [],
            services: {
              memory: repos.memory,
              schedules: repos.schedule,
              personas: repos.persona,
              channels: repos.channel,
              threads: repos.thread,
              messages: repos.message,
              runs: repos.run,
              queue: repos.queue,
              logger,
            },
            telemetry: { isEnabled: !(observability instanceof NoopObservabilityService) },
          },
          input,
        );

      boundSummarizers.set(summarizerName, boundSummarizer);
    }

    const defaultSummarizer =
      boundSummarizers.get('session-summarizer')
      ?? [...boundSummarizers.values()][0];

    if (defaultSummarizer) {
      contextRoller = new ContextRoller({
        messageRepo: repos.message,
        memoryRepo: repos.memory,
        sessionTracker,
        summarizerRun: defaultSummarizer,
        resolveSummarizerRun: (name) => boundSummarizers.get(name) ?? null,
        logger,
      });

      logger.info(
        { summarizers: [...boundSummarizers.keys()] },
        'bootstrap: context roller initialized',
      );
    } else {
      logger.warn(
        { requestedSummarizers },
        'bootstrap: no configured summarizer sub-agents were available, session rotation disabled',
      );
    }
  }

  // 10. Crash recovery
  recoverFromCrash(repos.queue, logger);

  // 11. Channel registry
  const channelRegistry = new ChannelRegistry(logger);

  // 12. Queue manager
  const queueManager = new QueueManager(repos.queue, repos.thread, config.queue, logger);

  let executionEnvManager: ExecutionEnvManager | null = null;
  if (config.sprites.enabled) {
    executionEnvManager = new ExecutionEnvManager({
      repository: repos.executionEnv,
      checkpointRepository: repos.executionEnvCheckpoint,
      client: new SpritesClient(config.sprites),
      defaultWorkingDirectory: config.sprites.workingDirectory,
      defaultBaseSnapshot: config.sprites.defaultBaseSnapshot,
      defaultAutoDestroy: config.sprites.autoDestroyOnCompletion,
      defaultExecTimeoutMs: config.sprites.execTimeoutMs,
      defaultResourceLimits: config.sprites.resourceLimits,
      logger,
    });
    await executionEnvManager.recoverOrphanedEnvironments();
  }

  // 13. Background agent manager
  let backgroundAgentManager: BackgroundAgentManager | null = null;
  if (config.backgroundAgent.enabled) {
    backgroundAgentManager = new BackgroundAgentManager({
      repository: repos.backgroundTask,
      queueManager,
      maxConcurrent: config.backgroundAgent.maxConcurrent,
      defaultTimeoutMinutes: config.backgroundAgent.defaultTimeoutMinutes,
      defaultProvider: config.backgroundAgent.defaultProvider,
      providerRegistry: backgroundProviderRegistry,
      executionEnvManager,
      hostToolsSocketPath: resolve(join(dataDir, 'host-tools.sock')),
      logger,
      observability,
    });
    await backgroundAgentManager.recoverOrphanedTasks();
  }

  // 14. Scheduler
  const scheduler = new Scheduler(repos.schedule, queueManager, personaLoader, config.scheduler, logger);

  // 15. Message pipeline and channel registration
  const router = new ChannelRouter(repos.binding, logger);
  const messagePipeline = new MessagePipeline(
    repos.message,
    repos.thread,
    repos.channel,
    queueManager,
    router,
    auditLogger,
    logger,
  );

  registerChannels(config, channelRegistry, {
    channelRepo: repos.channel,
    bindingRepo: repos.binding,
    personaRepo: repos.persona,
    messagePipeline,
    logger,
  });

  // 16. A2A server (internal-only, no port binding in M1)
  const loadedPersonaList = personaLoadResult.value;
  const a2aCardRegistry = buildAgentCardRegistry(loadedPersonaList);
  const a2aTaskMapper = new A2ATaskMapper(
    repos.a2aTask,
    repos.queue,
    repos.thread,
    repos.persona,
    a2aCardRegistry,
    logger,
  );
  const a2aServer = new A2AServer(a2aCardRegistry, a2aTaskMapper, logger);
  logger.info({ personas: [...a2aCardRegistry.keys()] }, 'bootstrap: A2A server initialized');

  // 17. Host tools bridge (needs a partial context to construct)
  // We build the context object first, then create the bridge and attach it.
  // Two-phase init: HostToolsBridge needs ctx, but ctx needs hostToolsBridge.
  // Build a partial context first, then fill in the bridge field.
  const partialCtx = {
    db,
    config,
    configPath,
    dataDir,
    repos,
    channelRegistry,
    queueManager,
    scheduler,
    personaLoader,
    sessionTracker,
    threadWorkspace,
    auditLogger,
    skillResolver,
    loadedSkills: loadedSkills.value,
    toolInstructions,
    messagePipeline,
    observability,
    subAgentRunner,
    providerRegistry,
    backgroundAgentManager,
    executionEnvManager,
    contextRoller,
    contextAssembler,
    logger,
    a2aServer,
    a2aTaskMapper,
  } as Omit<DaemonContext, 'hostToolsBridge'> & { hostToolsBridge?: HostToolsBridge };

  const hostToolsBridge = new HostToolsBridge(partialCtx as DaemonContext);
  partialCtx.hostToolsBridge = hostToolsBridge;
  const ctx = partialCtx as DaemonContext;

  logger.info('bootstrap: context ready');

  return ok(ctx);
}

async function cleanupBootstrapFailure(
  db: import('better-sqlite3').Database,
  observability: ObservabilityService,
  logger: pino.Logger,
): Promise<void> {
  try {
    await observability.shutdown();
  } catch (error) {
    logger.warn({ err: error }, 'bootstrap: failed to shut down observability after bootstrap error');
  }

  db.close();
}
