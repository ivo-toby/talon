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
import { BaseRepository } from '../core/database/repositories/base-repository.js';

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
  LifecycleEventRepository,
  LifecycleDeliveryRepository,
  LifecycleSignalRepository,
  BehaviorSignalRepository,
} from '../core/database/repositories/index.js';
import { buildAgentCardRegistry, A2ATaskMapper, A2AServer } from '../a2a/index.js';

import { ChannelRegistry } from '../channels/channel-registry.js';
import { ChannelRouter } from '../channels/channel-router.js';
import { registerChannels } from '../channels/channel-setup.js';
import { MessagePipeline } from '../pipeline/message-pipeline.js';
import { QueueManager } from '../queue/queue-manager.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { migrateLegacySchedules } from '../scheduler/legacy-schedule-migration.js';
import { DaemonError, LifecycleError } from '../core/errors/error-types.js';
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
import {
  buildSubAgentModelChain,
  runSubAgentModelChain,
} from '../subagents/subagent-model-chain.js';
import { ClaudeCodeProvider } from '../providers/claude-code-provider.js';
import { GeminiCliProvider } from '../providers/gemini-cli-provider.js';
import { CodexCliProvider } from '../providers/codex-cli-provider.js';
import { OpenAiCompatibleProvider } from '../providers/openai-compatible-provider.js';
import { ProviderRegistry, type ProviderFactoryMap } from '../providers/provider-registry.js';
import { recoverFromCrash } from './lifecycle.js';
import { ContextRoller, type SummarizerRunFn } from './context-roller.js';
import { ContextAssembler } from './context-assembler.js';
import type { DaemonContext } from './daemon-context.js';
import { loadToolInstructions } from '../tools/tool-instructions.js';
import { createObservabilityService } from '../observability/langfuse/index.js';
import { NoopObservabilityService } from '../observability/langfuse/noop-observability.js';
import type { ObservabilityService } from '../observability/langfuse/observability-types.js';
import { OAuthTokenStore } from '../auth/oauth-token-store.js';
import { LifecycleEventBus } from '../lifecycle/lifecycle-event-bus.js';
import { LifecycleDispatcher } from '../lifecycle/lifecycle-dispatcher.js';
import { CapturedLifecycleHandlerExecutor } from '../lifecycle/handler-executor.js';
import type {
  LifecycleRuntimeCapability,
  LifecycleRuntimeHandler,
} from '../lifecycle/handler-executor.js';
import { LifecycleInterceptorEngine } from '../lifecycle/interceptors/interceptor-engine.js';
import { nativeAllowInterceptor } from '../lifecycle/interceptors/native-example-handlers.js';
import { SubAgentLifecycleAdapter } from '../lifecycle/adapters/subagent-lifecycle-adapter.js';
import { createLifecycleHandlerRegistry } from '../lifecycle/handler-registry.js';
import { LifecycleRuntime } from '../lifecycle/lifecycle-runtime.js';
import {
  BehaviorSignalProjector,
  BehaviorReviewService,
  NATIVE_BEHAVIOR_SIGNAL_PROJECTOR_REF,
  NATIVE_BEHAVIOR_SIGNAL_PROJECTOR_VERSION,
  createBehaviorSignalRouter,
} from '../lifecycle/behavior/index.js';
import {
  LifecycleTelemetry,
  LoggerLifecycleMetricsRecorder,
} from '../lifecycle/telemetry/index.js';
import {
  LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT,
  LIFECYCLE_EVENT_INPUT_CONTRACT,
  LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT,
  LIFECYCLE_SIGNAL_INPUT_CONTRACT,
  LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
  type LifecycleHandlerResult,
} from '../lifecycle/contracts/index.js';

/** Lifecycle attachment requires both a loaded capability and persona opt-in. */
export function hasExplicitLifecycleSubagentAuthority(
  subagents: readonly string[] | undefined,
  implementationRef: string,
): boolean {
  return subagents?.includes(implementationRef) ?? false;
}

export function supportsLifecycleBootstrapHandler(
  runtimeKind: 'native' | 'subagent',
  mode: 'event' | 'signal' | 'interceptor',
): boolean {
  return runtimeKind === 'native' || mode !== 'interceptor';
}

function nativeNoSignalSuccess(): Promise<Result<LifecycleHandlerResult, LifecycleError>> {
  return Promise.resolve(
    ok({
      outcome: 'success',
      outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
      signals: [],
    }),
  );
}

function nativeInterceptorDispatcherRejection(): Promise<
  Result<LifecycleHandlerResult, LifecycleError>
> {
  return Promise.resolve(err(new LifecycleError('Lifecycle interceptors are not dispatcher jobs')));
}

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

  if (logger.level !== config.logLevel) {
    logger.level = config.logLevel;
  }

  logger.info({ logLevel: config.logLevel }, 'bootstrap: config loaded');

  // OAuth token store for HTTP MCP servers. Created early so it can be
  // handed to both the foreground agent-runner path (via DaemonContext)
  // and the background agent manager. `talonctl auth-mcp` writes
  // bundles into <dataDir>/mcp-auth/; the daemon reads + refreshes
  // them from the same path here, so foreground and background runs
  // see identical materialized Bearer headers.
  const oauthTokenStore = new OAuthTokenStore({ dataDir });

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

  // Seed the monotonic clock counter from the DB so that timestamps issued
  // in this process are strictly greater than anything the previous process
  // persisted. Keeps the context-rotation boundary filter safe across
  // daemon restarts — see BaseRepository.seedMonotonicClockFromDb.
  BaseRepository.seedMonotonicClockFromDb(db);

  // 4. Create repositories
  const audit = new AuditRepository(db);
  const auditStore = new RepositoryAuditStore(audit);
  const auditLogger = new AuditLogger(logger, auditStore);
  const lifecycleMetrics = new LoggerLifecycleMetricsRecorder(logger);
  const repos = {
    queue: new QueueRepository(db),
    thread: new ThreadRepository(db),
    channel: new ChannelRepository(db),
    persona: new PersonaRepository(db),
    backgroundTask: new BackgroundTaskRepository(db),
    executionEnv: new ExecutionEnvRepository(db),
    executionEnvCheckpoint: new ExecutionEnvCheckpointRepository(db),
    schedule: new ScheduleRepository(db),
    audit,
    message: new MessageRepository(db),
    run: new RunRepository(db),
    binding: new BindingRepository(db),
    memory: new MemoryRepository(db),
    a2aTask: new A2ATaskRepository(db),
    lifecycleEvent: new LifecycleEventRepository(db),
    lifecycleDelivery: new LifecycleDeliveryRepository(db, {
      auditLogger,
      metrics: lifecycleMetrics,
    }),
    lifecycleSignal: new LifecycleSignalRepository(db),
    behaviorSignal: new BehaviorSignalRepository(db, {
      auditLogger,
      metrics: lifecycleMetrics,
    }),
  };

  // 5. Thread workspace
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

  const langfuseConfig =
    packageVersion && !config.langfuse.release
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
  const loadedPersonaList = personaLoadResult.value;

  // 8. Load skills
  const skillLoader = new SkillLoader(logger);
  const skillResolver = new SkillResolver(logger);
  const loadedSkills = await skillLoader.loadFromPersonaConfig(config.personas, dataDir);
  if (loadedSkills.isErr()) {
    await cleanupBootstrapFailure(db, observability, logger);
    return err(
      new DaemonError(`Failed to load skills: ${loadedSkills.error.message}`, loadedSkills.error),
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
  logger.info({ count: toolInstructions.size }, 'bootstrap: tool instructions loaded');

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

  if (!config.subagentSandbox.codex.enabled) {
    const subAgentOverrides = config.subagents ?? {};
    const codexSandboxAgents = [...mergedAgentMap.values()]
      .flatMap((agent) =>
        buildSubAgentModelChain(agent, subAgentOverrides[agent.manifest.name])
          .filter((model) => model.provider === 'codex-sandbox')
          .map((model) => `${agent.manifest.name} (${model.source}: ${model.name})`),
      );

    if (codexSandboxAgents.length > 0) {
      await cleanupBootstrapFailure(db, observability, logger);
      return err(
        new DaemonError(
          `Sub-agent models require the contained Codex runner, but subagentSandbox.codex is disabled: ` +
            `${codexSandboxAgents.join(', ')}. Enable subagentSandbox.codex before starting talond.`,
        ),
      );
    }
  }

  let modelResolver: ModelResolver | null = null;
  if (mergedAgentMap.size > 0) {
    const agentMap = mergedAgentMap;
    modelResolver = new ModelResolver(
      config.auth.providers ?? {},
      config.subagentCli,
      config.subagentSandbox,
    );
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
      config.subagents ?? {},
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
    'claude-code': (providerConfig, providerName) =>
      new ClaudeCodeProvider(providerConfig, providerName),
    'gemini-cli': (providerConfig, providerName) =>
      new GeminiCliProvider(providerConfig, providerName),
    'codex-cli': (providerConfig, providerName) =>
      new CodexCliProvider(providerConfig, { dataDir }, providerName),
    'openai-compatible': (providerConfig, providerName) => {
      // Credentials are looked up under auth.providers.<options.providerId>
      // first (e.g. `ollama`, `groq`, `together`), so users can reuse the
      // same credential slot already consumed by the matching sub-agent
      // provider. Falls back to the dedicated `openai-compatible` key for
      // endpoints without a natural provider id.
      const authProviders = config.auth?.providers ?? {};
      const providerIdOption = providerConfig.options?.providerId;
      const providerId =
        typeof providerIdOption === 'string' && providerIdOption.trim().length > 0
          ? providerIdOption
          : undefined;
      const creds =
        (providerId ? authProviders[providerId] : undefined) ?? authProviders['openai-compatible'];
      return new OpenAiCompatibleProvider(
        providerConfig,
        {
          apiKey: creds?.apiKey,
          baseUrl: creds?.baseURL,
        },
        providerName,
      );
    },
  };
  const providerRegistry = new ProviderRegistry(config.agentRunner.providers, providerFactories);
  const backgroundProviderRegistry = new ProviderRegistry(
    config.backgroundAgent.providers,
    providerFactories,
  );

  // 9a-guard. Validate that every persona's backgroundProvider is actually
  // registered in the background provider registry. The config-schema
  // superRefine already rejects names that aren't enabled in
  // backgroundAgent.providers, but the ProviderRegistry constructor
  // silently drops entries that have no matching factory (e.g. a typo in
  // the provider name key). Without this check the misconfiguration would
  // only surface at first background-agent spawn, breaking the
  // "fail loudly at daemon start" invariant.
  for (const persona of config.personas) {
    if (
      persona.backgroundProvider &&
      !backgroundProviderRegistry.hasProvider(persona.backgroundProvider)
    ) {
      const available = backgroundProviderRegistry.listEnabled().join(', ') || '(none)';
      return err(
        new DaemonError(
          `persona "${persona.name}": backgroundProvider "${persona.backgroundProvider}" ` +
            `is not available in the background agent registry. ` +
            `Available providers: ${available}.`,
        ),
      );
    }
  }

  // 9b. Context roller (needs configured summarizer sub-agents)
  let contextRoller: ContextRoller | null = null;
  const enabledContextProviders = Object.entries(config.agentRunner.providers).filter(
    ([, providerConfig]) => providerConfig.enabled && providerConfig.contextManagement.enabled,
  );
  for (const [providerName, providerConfig] of enabledContextProviders) {
    if (providerConfig.contextManagement.deprecatedLegacySummarizer) {
      logger.warn(
        { provider: providerName },
        'bootstrap: contextManagement.summarizer=session-observer is deprecated; use mode=observation with observer and reducer',
      );
    }
  }
  const requestedSummarizers = [
    ...new Set([
      ...enabledContextProviders.flatMap(([, providerConfig]) => {
        const contextManagement = providerConfig.contextManagement;
        return contextManagement.mode === 'observation'
          ? [contextManagement.observer, contextManagement.reducer]
          : [contextManagement.summarizer];
      }),
    ]),
  ].filter((name): name is string => typeof name === 'string' && name.length > 0);

  if (enabledContextProviders.length === 0) {
    logger.info('bootstrap: context rotation disabled for all agent runner providers');
  } else {
    for (const summarizerName of requestedSummarizers) {
      if (!mergedAgentMap.has(summarizerName)) {
        await cleanupBootstrapFailure(db, observability, logger);
        return err(
          new DaemonError(
            `Configured context management handler "${summarizerName}" was not found in loaded sub-agents`,
          ),
        );
      }
    }
  }

  if (enabledContextProviders.length > 0 && modelResolver) {
    const boundSummarizers = new Map<string, import('./context-roller.js').SummarizerRunFn>();

    const subagentOverrides = config.subagents ?? {};

    for (const summarizerName of requestedSummarizers) {
      const summarizerAgent = mergedAgentMap.get(summarizerName)!;

      // Verify at least one model in the chain can resolve at boot time.
      const overrideConfig = subagentOverrides[summarizerName];
      const bootModelChain = buildSubAgentModelChain(summarizerAgent, overrideConfig);

      const anyResolvable = await Promise.any(
        bootModelChain.map(async (m) => {
          const r = await modelResolver.resolve(m);
          if (!r.isOk()) throw new Error('not resolvable');
          return true;
        }),
      ).catch(() => false);

      if (!anyResolvable) {
        await cleanupBootstrapFailure(db, observability, logger);
        return err(
          new DaemonError(
            `No model in override chain could resolve for configured context management handler "${summarizerName}"`,
          ),
        );
      }

      const summarizerPrompt = summarizerAgent.promptContents.join('\n\n');

      const boundSummarizer: import('./context-roller.js').SummarizerRunFn = async (
        threadId,
        personaId,
        input,
      ) => {
        const result = await runSubAgentModelChain({
          name: summarizerName,
          agent: summarizerAgent,
          input,
          override: overrideConfig,
          modelResolver,
          logger,
          createContext: ({ model, entry, abortSignal, providerOptions }) => ({
            threadId,
            personaId,
            model,
            systemPrompt: summarizerPrompt,
            maxOutputTokens: entry.maxTokens,
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
            abortSignal,
            providerOptions,
          }),
        });

        return result.map((value) => value.result);
      };

      boundSummarizers.set(summarizerName, boundSummarizer);
    }

    const defaultSummarizer =
      boundSummarizers.get('session-summarizer') ?? [...boundSummarizers.values()][0];

    if (defaultSummarizer) {
      contextRoller = new ContextRoller({
        messageRepo: repos.message,
        threadRepo: repos.thread,
        memoryRepo: repos.memory,
        sessionTracker,
        summarizerRun: defaultSummarizer,
        resolveSummarizerRun: (name): SummarizerRunFn | null => boundSummarizers.get(name) ?? null,
        logger,
      });

      logger.info(
        { summarizers: [...boundSummarizers.keys()] },
        'bootstrap: context roller initialized',
      );
    } else {
      await cleanupBootstrapFailure(db, observability, logger);
      return err(
        new DaemonError(
          `Context management is enabled, but no configured context management handlers were bound: ${requestedSummarizers.join(', ')}`,
        ),
      );
    }
  } else if (enabledContextProviders.length > 0) {
    await cleanupBootstrapFailure(db, observability, logger);
    return err(
      new DaemonError('Context management is enabled, but no model resolver is available'),
    );
  }

  // 10. Crash recovery
  recoverFromCrash(repos.queue, logger);

  // 11. Channel registry
  const channelRegistry = new ChannelRegistry(logger);

  // 12. Queue manager
  // Lifecycle services are intentionally constructed only when enabled. This
  // keeps an omitted/disabled lifecycle configuration on the exact legacy
  // execution path, while the durable dispatcher remains an independent
  // workload when enabled.
  let lifecycleRuntime: LifecycleRuntime | null = null;
  if (config.lifecycle?.enabled) {
    const nativeImplementations: Record<string, LifecycleRuntimeHandler> = {
      'native-noop-event': nativeNoSignalSuccess,
      // Interceptors execute synchronously through LifecycleInterceptorEngine;
      // retaining this identity in the captured executor prevents a divergent
      // authority catalog from ever selecting a different implementation.
      'native-allow-interceptor': nativeInterceptorDispatcherRejection,
      [NATIVE_BEHAVIOR_SIGNAL_PROJECTOR_REF]: nativeNoSignalSuccess,
    };
    const nativeImplementationCatalog = [
      {
        ref: 'native-noop-event',
        implementationVersion: '1.0.0',
        mode: 'event' as const,
        inputContract: LIFECYCLE_EVENT_INPUT_CONTRACT,
        outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
      },
      {
        ref: 'native-allow-interceptor',
        implementationVersion: '1.0.0',
        mode: 'interceptor' as const,
        inputContract: LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT,
        outputContract: LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT,
        interceptorSafety: 'enforcing' as const,
      },
      {
        ref: NATIVE_BEHAVIOR_SIGNAL_PROJECTOR_REF,
        implementationVersion: NATIVE_BEHAVIOR_SIGNAL_PROJECTOR_VERSION,
        mode: 'signal' as const,
        inputContract: LIFECYCLE_SIGNAL_INPUT_CONTRACT,
        outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
      },
    ];
    const loadedSubagentCatalog = [...mergedAgentMap.values()].flatMap((agent) =>
      (agent.lifecycleCapabilities ?? []).map((capability) => ({
        ref: agent.manifest.name,
        implementationVersion: agent.manifest.version,
        mode: capability.mode,
        inputContract: capability.inputContract,
        outputContract: capability.outputContract,
        ...(capability.interceptorSafety
          ? { interceptorSafety: capability.interceptorSafety }
          : {}),
      })),
    );
    const registryResult = createLifecycleHandlerRegistry({
      lifecycle: config.lifecycle,
      channels: config.channels.map(({ name }) => ({ name })),
      personas: config.personas.map(({ name, lifecycle }) => ({ name, lifecycle })),
      nativeImplementationCatalog,
      loadedSubagentCatalog,
    });
    if (registryResult.isErr()) {
      await cleanupBootstrapFailure(db, observability, logger);
      return err(
        new DaemonError(`Failed to construct lifecycle registry: ${registryResult.error.message}`),
      );
    }
    const resolvedHandlers = config.personas.flatMap((persona) =>
      registryResult.value.listPersonaHandlers(persona.name),
    );
    const nativeCatalogByIdentity = new Map<string, LifecycleRuntimeCapability>();
    const subagentCatalog: LifecycleRuntimeCapability[] = [];
    const subagentAdapter = subAgentRunner ? new SubAgentLifecycleAdapter(subAgentRunner) : null;
    for (const handler of resolvedHandlers) {
      if (handler.identity.runtimeKind === 'native') {
        const implementation = nativeImplementations[handler.identity.implementationRef];
        if (implementation) {
          // Native handlers have no persona authority. Capture each immutable
          // identity once even when configuration attaches it to many personas.
          const identityKey = JSON.stringify([
            handler.identity.version,
            handler.identity.handlerId,
            handler.identity.runtimeKind,
            handler.identity.implementationRef,
            handler.identity.implementationVersion,
            handler.identity.mode,
            handler.identity.inputContract,
            handler.identity.outputContract,
            handler.identity.interceptorSafety ?? null,
          ]);
          if (!nativeCatalogByIdentity.has(identityKey)) {
            nativeCatalogByIdentity.set(identityKey, {
              identity: handler.identity,
              handler: implementation,
            });
          }
        }
        continue;
      }
      if (!supportsLifecycleBootstrapHandler(handler.identity.runtimeKind, handler.identity.mode)) {
        await cleanupBootstrapFailure(db, observability, logger);
        return err(
          new DaemonError(
            `Lifecycle sub-agent interceptors are unsupported: ${handler.identity.handlerId}`,
          ),
        );
      }
      const loadedPersona = loadedPersonaList.find(
        (persona) => persona.config.name === handler.persona,
      );
      const personaRow = repos.persona.findByName(handler.persona);
      const agent = mergedAgentMap.get(handler.identity.implementationRef);
      if (!subagentAdapter) {
        await cleanupBootstrapFailure(db, observability, logger);
        return err(
          new DaemonError(
            `Lifecycle sub-agent handler "${handler.identity.handlerId}" requires the background sub-agent adapter`,
          ),
        );
      }
      if (!loadedPersona) {
        await cleanupBootstrapFailure(db, observability, logger);
        return err(
          new DaemonError(
            `Lifecycle sub-agent handler "${handler.identity.handlerId}" references unloaded persona "${handler.persona}"`,
          ),
        );
      }
      if (personaRow.isErr()) {
        await cleanupBootstrapFailure(db, observability, logger);
        return err(
          new DaemonError(
            `Lifecycle sub-agent handler "${handler.identity.handlerId}" failed to load persona row "${handler.persona}": ${personaRow.error.message}`,
          ),
        );
      }
      if (!personaRow.value) {
        await cleanupBootstrapFailure(db, observability, logger);
        return err(
          new DaemonError(
            `Lifecycle sub-agent handler "${handler.identity.handlerId}" references missing persona row "${handler.persona}"`,
          ),
        );
      }
      if (!agent) {
        await cleanupBootstrapFailure(db, observability, logger);
        return err(
          new DaemonError(
            `Lifecycle sub-agent handler "${handler.identity.handlerId}" references unloaded sub-agent "${handler.identity.implementationRef}"`,
          ),
        );
      }
      if (!agent.lifecycleRun) {
        await cleanupBootstrapFailure(db, observability, logger);
        return err(
          new DaemonError(
            `Lifecycle sub-agent handler "${handler.identity.handlerId}" requires sub-agent "${handler.identity.implementationRef}" to declare a lifecycleRun contract`,
          ),
        );
      }
      if (
        !hasExplicitLifecycleSubagentAuthority(
          loadedPersona.config.subagents,
          handler.identity.implementationRef,
        )
      ) {
        await cleanupBootstrapFailure(db, observability, logger);
        return err(
          new DaemonError(
            `Lifecycle sub-agent handler "${handler.identity.handlerId}" for persona "${handler.persona}" requires "${handler.identity.implementationRef}" in personas[].subagents`,
          ),
        );
      }
      const capturedHandler = handler;
      const capturedPersona = loadedPersona;
      const capturedPersonaId = personaRow.value.id;
      subagentCatalog.push({
        identity: handler.identity,
        subagentScope: {
          persona: handler.persona,
          capabilities: {
            allow: [...capturedPersona.resolvedCapabilities.allow],
            requireApproval: [...capturedPersona.resolvedCapabilities.requireApproval],
          },
        },
        handler: (execution) =>
          subagentAdapter.invoke({
            handler: capturedHandler,
            scope: {
              threadId:
                execution.event.payload.references.find((reference) => reference.type === 'thread')
                  ?.id ?? execution.event.context.aggregate.id,
              aggregate: execution.event.context.aggregate,
              persona: {
                id: capturedPersonaId,
                name: capturedHandler.persona,
                subagents: capturedPersona.config.subagents,
                capabilities: capturedPersona.resolvedCapabilities,
              },
            },
            input: execution.event,
            ...(execution.traceparent === undefined ? {} : { traceparent: execution.traceparent }),
          }),
      });
    }
    const executorResult = CapturedLifecycleHandlerExecutor.create({
      nativeCatalog: [...nativeCatalogByIdentity.values()],
      subagentCatalog,
    });
    if (executorResult.isErr()) {
      await cleanupBootstrapFailure(db, observability, logger);
      return err(
        new DaemonError(`Failed to construct lifecycle executor: ${executorResult.error.message}`),
      );
    }
    const lifecycleTelemetry = new LifecycleTelemetry({
      observability,
      auditLogger,
      metrics: lifecycleMetrics,
      langfuse: config.lifecycle?.telemetry?.langfuse,
    });
    const behaviorSignalProjector = new BehaviorSignalProjector(repos.behaviorSignal, {
      auditLogger,
    });
    const interceptorEngine = new LifecycleInterceptorEngine({
      resolveHandlers: (
        query,
      ): ReturnType<typeof registryResult.value.resolveInterceptorHandlers> =>
        registryResult.value.resolveInterceptorHandlers(query),
      implementations: { 'native-allow-interceptor': nativeAllowInterceptor },
      auditLogger,
      telemetry: lifecycleTelemetry,
    });
    const dispatcherResult = LifecycleDispatcher.create({
      deliveries: repos.lifecycleDelivery,
      executor: executorResult.value,
      signalRouter: createBehaviorSignalRouter({
        signalRepository: repos.lifecycleSignal,
        projector: behaviorSignalProjector,
        registry: registryResult.value,
      }),
      telemetry: lifecycleTelemetry,
      logger,
    });
    if (dispatcherResult.isErr()) {
      await cleanupBootstrapFailure(db, observability, logger);
      return err(
        new DaemonError(
          `Failed to construct lifecycle dispatcher: ${dispatcherResult.error.message}`,
        ),
      );
    }
    const dispatcher = dispatcherResult.value;
    const eventBus = new LifecycleEventBus(
      repos.lifecycleEvent,
      registryResult.value,
      () => {
        dispatcher.wake();
      },
      lifecycleTelemetry,
    );
    lifecycleRuntime = new LifecycleRuntime(eventBus, interceptorEngine, dispatcher);
  }
  const queueManager = new QueueManager(
    repos.queue,
    repos.thread,
    config.queue,
    logger,
    lifecycleRuntime ?? undefined,
  );
  const behaviorReviewService = new BehaviorReviewService(repos.behaviorSignal, {
    auditLogger,
  });

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
      resolveLifecyclePersonaName: lifecycleRuntime
        ? (personaId: string): string | undefined =>
            personaLoader
              .getById(personaId)
              .map((persona) => persona?.config.name)
              .unwrapOr(undefined)
        : undefined,
      // Share the same token store the foreground path uses so an
      // `talonctl auth-mcp` run unlocks Glean (etc.) for both run
      // types — without this, background runs receive raw
      // `auth: { kind: 'oauth2' }` entries and the MCP server 401s.
      oauthTokenStore,
      logger,
      observability,
    });
    await backgroundAgentManager.recoverOrphanedTasks();
  }

  // 14. Scheduler
  // Heal any legacy schedules (pre-dedicated-thread-model, PR #201) before
  // the scheduler starts ticking so the first fire after upgrade delivers
  // via the canonical dedicated-thread + origin-external-id path.
  migrateLegacySchedules({
    scheduleRepo: repos.schedule,
    threadRepo: repos.thread,
    channelRepo: repos.channel,
    personaRepo: repos.persona,
    logger,
  });
  const scheduler = new Scheduler(
    repos.schedule,
    queueManager,
    personaLoader,
    config.scheduler,
    logger,
    lifecycleRuntime ?? undefined,
    behaviorReviewService,
  );

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
    lifecycleRuntime ?? undefined,
    (personaId) => personaLoader.getById(personaId).map((persona) => persona?.config.name),
  );

  registerChannels(config, channelRegistry, {
    channelRepo: repos.channel,
    bindingRepo: repos.binding,
    personaRepo: repos.persona,
    messagePipeline,
    logger,
  });

  // 16. A2A server (internal-only, no port binding in M1)
  const a2aCardRegistry = buildAgentCardRegistry(loadedPersonaList);
  const a2aTaskMapper = new A2ATaskMapper(
    repos.a2aTask,
    repos.queue,
    repos.thread,
    repos.persona,
    a2aCardRegistry,
    logger,
    config.a2a,
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
    backgroundProviderRegistry,
    backgroundAgentManager,
    executionEnvManager,
    contextRoller,
    contextAssembler,
    oauthTokenStore,
    logger,
    lifecycleRuntime,
    a2aServer,
    a2aTaskMapper,
  } as Omit<DaemonContext, 'hostToolsBridge'> & { hostToolsBridge?: HostToolsBridge };

  const hostToolsBridge = new HostToolsBridge(partialCtx as DaemonContext);
  backgroundAgentManager?.setHostToolsBridge(hostToolsBridge);
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
    logger.warn(
      { err: error },
      'bootstrap: failed to shut down observability after bootstrap error',
    );
  }

  db.close();
}
