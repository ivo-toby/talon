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
} from '../core/database/repositories/index.js';
import { buildAgentCardRegistry, A2ATaskMapper, A2AServer } from '../a2a/index.js';

import { ChannelRegistry } from '../channels/channel-registry.js';
import { ChannelRouter } from '../channels/channel-router.js';
import {
  registerChannels,
  registerVoiceChannel,
  registerVoiceConnector,
  BROWSER_VOICE_CHANNEL_NAME,
} from '../channels/channel-setup.js';
import { MessagePipeline } from '../pipeline/message-pipeline.js';
import {
  createQueueDiagnosticResolver,
  QueueManager,
} from '../queue/queue-manager.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { migrateLegacySchedules } from '../scheduler/legacy-schedule-migration.js';
import { DaemonError } from '../core/errors/error-types.js';
import { PolicyError } from '../core/errors/index.js';
import { AuditLogger } from '../core/logging/audit-logger.js';
import { RepositoryAuditStore } from '../core/database/repositories/audit-repository.js';
import { PersonaLoader } from '../personas/persona-loader.js';
import { buildPersonaRuntimeContext } from '../personas/persona-runtime-context.js';
import { SkillLoader } from '../skills/skill-loader.js';
import { SkillResolver } from '../skills/skill-resolver.js';
import { ThreadWorkspace } from '../memory/thread-workspace.js';
import { SessionTracker } from '../sandbox/session-tracker.js';

import { HostToolsBridge } from '../tools/host-tools-bridge.js';
import { filterVoiceMcpTools } from '../tools/tool-filter.js';
import { hasOAuthMcpAuth } from '../mcp/resolve-mcp-servers.js';
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
import {
  ContextRoller,
  normalizeContextRollerDiagnostics,
} from './context-roller.js';
import { ContextAssembler } from './context-assembler.js';
import type { DaemonContext } from './daemon-context.js';
import { loadToolInstructions } from '../tools/tool-instructions.js';
import { createObservabilityService } from '../observability/langfuse/index.js';
import { NoopObservabilityService } from '../observability/langfuse/noop-observability.js';
import type { ObservabilityService } from '../observability/langfuse/observability-types.js';
import {
  createVoiceObservationContext,
  createVoiceSafeLogger,
  observeVoiceSafely,
} from '../observability/langfuse/voice-observation.js';
import { OAuthTokenStore } from '../auth/oauth-token-store.js';
import { VoiceRepository } from '../core/database/repositories/voice-repository.js';
import { VoiceAuthRepository } from '../core/database/repositories/voice-auth-repository.js';
import { DurableVoiceStore } from '../voice/voice-store.js';
import { DurableVoiceBackendBridge, type VoiceExecutionGateInput } from '../voice/voice-backend-bridge.js';
import { VoiceOutputSink } from '../voice/voice-output-sink.js';
import { getVoiceNativeToolNames, VoicePolicy } from '../voice/voice-policy.js';
import {
  BrowserVoiceTransport,
  IndexedVoiceAuth,
  DurableVoiceSessionService,
} from '../voice/voice-session-service.js';
import { reconcileVoiceSessions } from '../voice/voice-session-reconciler.js';
import { OpenAiLiveVoiceProvider } from '../voice/providers/openai-live-provider.js';
import {
  createVoiceAdapterSelection,
  VoiceCallAdmission,
} from '../voice/voice-adapters.js';
import { createVoiceAuthorization } from '../voice/voice-authorization.js';
import { BrowserVoiceServer } from '../voice/transports/browser/browser-server.js';
import { VoiceSipRepository } from '../core/database/repositories/voice-sip-repository.js';
import { ConfiguredSipAuthorizationResolver } from '../voice/transports/sip/sip-authorization.js';
import { SipIngressService, type SipCallControlResult } from '../voice/transports/sip/sip-ingress-service.js';
import { SipTransport } from '../voice/transports/sip/sip-transport.js';
import { SipWebhookServer } from '../voice/transports/sip/sip-webhook-server.js';
import { VoiceTelemetry } from '../voice/voice-telemetry.js';
import type {
  VoiceOwnerContext,
  VoicePolicySnapshot,
  VoiceResult,
  VoiceSessionRecord,
  VoiceTransport,
} from '../voice/voice-types.js';

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
    ([, providerConfig]) => providerConfig.contextManagement.enabled,
  );
  const configuredSummarizers = enabledContextProviders
    .map(([, providerConfig]) => providerConfig.contextManagement.summarizer)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
  const usesObservationalMemory = configuredSummarizers.includes('session-observer');
  // The observer/reflector path is a pair: once the observation log crosses
  // MAX_OBSERVATION_CHARS the context-roller calls the reflector to
  // consolidate. If the reflector isn't bound alongside the observer, the
  // lookup misses at runtime and the log grows unbounded — the warning
  // "context-roller-om: reflector not available, skipping consolidation"
  // indicates this miswiring. Auto-include the reflector whenever any
  // provider opts into observational memory so a single config key keeps
  // both halves working.
  const requestedSummarizers = [
    ...new Set([
      ...configuredSummarizers,
      ...(usesObservationalMemory ? ['session-reflector'] : []),
    ]),
  ];

  if (enabledContextProviders.length === 0) {
    logger.info('bootstrap: context rotation disabled for all agent runner providers');
  } else if (modelResolver) {
    const boundSummarizers = new Map<string, import('./context-roller.js').SummarizerRunFn>();

    const subagentOverrides = config.subagents ?? {};

    for (const summarizerName of requestedSummarizers) {
      const summarizerAgent = mergedAgentMap.get(summarizerName);
      if (!summarizerAgent) {
        logger.warn(
          { summarizer: summarizerName },
          'bootstrap: configured summarizer sub-agent not found, skipping',
        );
        continue;
      }

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
        logger.warn(
          { summarizer: summarizerName },
          'bootstrap: no model in override chain could resolve for summarizer, skipping',
        );
        continue;
      }

      const summarizerPrompt = summarizerAgent.promptContents.join('\n\n');

      const boundSummarizer: import('./context-roller.js').SummarizerRunFn = async (
        threadId,
        personaId,
        input,
        diagnostics,
      ) => {
        const resolvedDiagnostics = normalizeContextRollerDiagnostics(diagnostics);
        const isVoiceOrUnknown = resolvedDiagnostics.privacy !== 'nonvoice';
        const modelChainLogger = isVoiceOrUnknown ? createVoiceSafeLogger(logger) : logger;
        const voiceObservation = isVoiceOrUnknown
          ? resolvedDiagnostics.voiceObservation ??
            createVoiceObservationContext({ threadId, personaId })
          : undefined;
        const run = async (): Promise<Result<import('../subagents/subagent-types.js').SubAgentResult, import('../core/errors/index.js').SubAgentError>> => {
          const result = await runSubAgentModelChain({
            name: summarizerName,
            agent: summarizerAgent,
            input,
            override: overrideConfig,
            modelResolver,
            logger: modelChainLogger,
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
                logger: modelChainLogger,
              },
              telemetry: {
                isEnabled:
                  !isVoiceOrUnknown && !(observability instanceof NoopObservabilityService),
              },
              abortSignal,
              providerOptions,
            }),
          });

          return result.map((value) => value.result);
        };

        if (!voiceObservation) return await run();

        return await observeVoiceSafely({
          service: observability,
          input: {
            type: 'agent',
            name: `context-roller:${summarizerName}`,
            input,
            metadata: { threadId, personaId, summarizer: summarizerName },
          },
          context: voiceObservation,
          callback: async () => await run(),
        });
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
        resolveSummarizerRun: (
          name: string,
        ): import('./context-roller.js').SummarizerRunFn | null =>
          boundSummarizers.get(name) ?? null,
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

  // 10. Voice durability and startup reconciliation must run before generic
  // queue crash recovery. Voice queue rows are excluded from the generic
  // reset, so an uncertain provider effect can never be replayed by polling.
  const voiceStore = new DurableVoiceStore(db, repos.queue, new VoiceRepository(db));
  const voiceReconciliation = reconcileVoiceSessions(voiceStore, {
    usdPerMinute: config.voice?.usdPerMinute,
  });
  if (voiceReconciliation.isErr()) {
    await cleanupBootstrapFailure(db, observability, logger);
    return err(
      new DaemonError(
        `Failed to reconcile browser voice state: ${voiceReconciliation.error.message}`,
        voiceReconciliation.error,
      ),
    );
  }
  if (
    voiceReconciliation.value.unknownDelegations.length > 0 ||
    voiceReconciliation.value.skippedDelegations.length > 0
  ) {
    logger.warn(
      {
        unknown: voiceReconciliation.value.unknownDelegations.length,
        skipped: voiceReconciliation.value.skippedDelegations.length,
      },
      'bootstrap: reconciled browser voice state without replay',
    );
  }

  let voicePolicy: VoicePolicy | null = null;
  let voiceAuth: IndexedVoiceAuth | null = null;
  let voiceBackendBridge: DurableVoiceBackendBridge | null = null;
  let voiceOutputSink: VoiceOutputSink | null = null;
  let voiceSessionService: DurableVoiceSessionService | null = null;
  let voiceProvider: OpenAiLiveVoiceProvider | null = null;
  let voiceTransport: VoiceTransport | null = null;
  let voiceSipTransport: SipTransport | null = null;
  let voiceServer: BrowserVoiceServer | null = null;
  let voiceSipIngress: SipIngressService | null = null;
  let voiceSipWebhookServer: SipWebhookServer | null = null;
  let voiceTelemetry: VoiceTelemetry | null = null;
  let voiceChannelId: string | null = null;
  const voiceRuntimeConfig = { current: config };
  const voiceGeneration = { value: 0 };
  const daemonContextRef: {
    current?: Pick<DaemonContext, 'loadedSkills'>;
  } = {};
  if (config.voice?.enabled || config.voice?.sip?.enabled) {
    const voicePersonaName = config.voice.persona ?? config.personas[0]?.name;
    if (!voicePersonaName) {
      await cleanupBootstrapFailure(db, observability, logger);
      return err(
        new DaemonError(
          'voice.persona is required when browser voice or incoming SIP is enabled',
        ),
      );
    }
    const loadedVoicePersona = personaLoader.getByName(voicePersonaName);
    if (loadedVoicePersona.isErr() || !loadedVoicePersona.value) {
      await cleanupBootstrapFailure(db, observability, logger);
      return err(
        new DaemonError(
          `Voice persona not found: ${voicePersonaName}`,
          loadedVoicePersona.isErr() ? loadedVoicePersona.error : undefined,
        ),
      );
    }
    const voicePersonaRow = repos.persona.findByName(voicePersonaName);
    if (voicePersonaRow.isErr() || !voicePersonaRow.value) {
      await cleanupBootstrapFailure(db, observability, logger);
      return err(
        new DaemonError(
          `Voice persona not found: ${voicePersonaName}`,
          voicePersonaRow.isErr() ? voicePersonaRow.error : undefined,
        ),
      );
    }
    const voicePersonaId = voicePersonaRow.value.id;

    const voiceProviderName =
      loadedVoicePersona.value.config.provider ?? config.agentRunner.defaultProvider;
    const voiceProviderEntry = providerRegistry.get(voiceProviderName);
    if (!voiceProviderEntry) {
      await cleanupBootstrapFailure(db, observability, logger);
      return err(
        new DaemonError(
          `Voice provider "${voiceProviderName}" is not enabled`,
        ),
      );
    }
    const voiceAccessToken =
      config.voice.accessToken ??
      config.auth.providers[config.voice.accessTokenRef]?.apiKey ??
      config.auth.apiKey;
    if (config.voice.enabled && !voiceAccessToken) {
      await cleanupBootstrapFailure(db, observability, logger);
      return err(new DaemonError('voice.accessToken or its configured auth provider is required'));
    }

    voiceTelemetry = new VoiceTelemetry({ observability });

    const providerTypes = new Map<string, string>();
    for (const [name, providerConfig] of Object.entries(config.agentRunner.providers)) {
      providerTypes.set(name, providerConfig.type ?? name);
    }
    const provenMcpServers = new Set<string>();
    voicePolicy = new VoicePolicy({
      providerTypes,
      provenMcpServers,
    });
    if (config.voice.enabled) {
      const voiceAuthRepository = new VoiceAuthRepository(db);
      voiceAuth = new IndexedVoiceAuth({
        accessToken: voiceAccessToken!,
        ownerId: `voice:${voicePersonaName}`,
        repository: voiceAuthRepository,
      });
      if (voiceAuth.initializationResult.isErr()) {
        await cleanupBootstrapFailure(db, observability, logger);
        return err(new DaemonError('Failed to initialize browser voice authentication'));
      }
    }
    const voiceBackendModel = loadedVoicePersona.value.config.model;
    const voiceLiveModel = config.voice.model ?? 'gpt-live-1';
    const captureVoicePolicy = (owner: VoiceOwnerContext): VoiceResult<VoicePolicySnapshot> => {
      const currentConfig = voiceRuntimeConfig.current;
      const personaName = currentConfig.voice?.persona ?? voicePersonaName;
      const currentPersona = personaLoader.getByName(personaName);
      if (currentPersona.isErr()) return err(currentPersona.error);
      if (!currentPersona.value) return err(new DaemonError(`Voice persona not found: ${personaName}`));
      const persona = currentPersona.value;
      const currentPersonaRow = repos.persona.findByName(personaName);
      if (currentPersonaRow.isErr()) return err(currentPersonaRow.error);
      if (!currentPersonaRow.value) {
        return err(new DaemonError(`Voice persona not found: ${personaName}`));
      }
      const currentProvider =
        persona.config.provider ?? currentConfig.agentRunner.defaultProvider;
      const currentModel = persona.config.model;
      const currentProviderEntry = providerRegistry.get(currentProvider);
      if (!currentProviderEntry) {
        return err(new DaemonError(`Voice provider "${currentProvider}" is not enabled`));
      }
      const personaSkills = (
        daemonContextRef.current?.loadedSkills ?? loadedSkills.value
      ).filter((skill) => persona.config.skills.includes(skill.manifest.name));
      let personaRuntimeContext;
      try {
        personaRuntimeContext = buildPersonaRuntimeContext({
          loadedPersona: persona,
          resolvedSkills: personaSkills,
          skillResolver,
          logger,
        });
      } catch (cause) {
        return err(
          new DaemonError(
            `Failed to resolve voice persona runtime context: ${String(cause)}`,
            cause instanceof Error ? cause : undefined,
          ),
        );
      }
      const allowedMcpServerNames = Object.keys(personaRuntimeContext.mcpServers);
      provenMcpServers.clear();
      for (const serverName of allowedMcpServerNames) provenMcpServers.add(serverName);
      const voiceTools = filterVoiceMcpTools(persona.resolvedCapabilities);
      const nativeToolsDisabled = hasOAuthMcpAuth(personaRuntimeContext.mcpServers);
      return voicePolicy!.capture({
        generation: voiceGeneration.value,
        ownerId: owner.ownerId,
        personaId: currentPersonaRow.value.id,
        providerName: currentProvider,
        modelName: currentModel,
        voiceName: currentConfig.voice?.voice ?? config.voice.voice,
        capabilityNames: [
          ...persona.resolvedCapabilities.allow,
          ...persona.resolvedCapabilities.requireApproval,
        ],
        allowedToolNames: voiceTools.allowedMcpTools,
        allowedMcpServerNames,
        nativeToolNames: getVoiceNativeToolNames(
          currentProviderEntry.type,
          nativeToolsDisabled,
        ),
        requireApproval: false,
        loginRevision: owner.loginRevision,
      });
    };
    const currentVoicePolicy = (
      owner: VoiceOwnerContext,
      _session: VoiceSessionRecord,
    ): VoiceResult<VoicePolicySnapshot> =>
      captureVoicePolicy(owner);
    const voiceInstructions = [
      `You are the live speech interface for the Talon persona "${voicePersonaName}".`,
      'Speech role: handle greetings and clarification locally. Delegate substantive tasks, questions, memory, and current data to the Talon backend. Wait for a verified backend result before claiming completion; an acknowledgement is not a completion. Respect backend refusals and uncertainty.',
      'Delegation contract: send admitted transcript context to the selected persona backend, preserve its result, and report only verified outcomes to the speaker.',
      config.voice.instructions,
    ].join('\n\n');
    const liveAuth = config.auth.providers[config.voice.liveApiKeyRef];
    voiceProvider = new OpenAiLiveVoiceProvider({
      apiKey: liveAuth?.apiKey,
      baseUrl: liveAuth?.baseURL,
      maxCharacters: config.voice.maxContextChars,
      telemetry: voiceTelemetry,
      logger,
    });
    const browserVoiceTransport = config.voice.enabled ? new BrowserVoiceTransport() : null;
    voiceSipTransport = config.voice.sip?.enabled ? new SipTransport() : null;
    voiceTransport = browserVoiceTransport ?? voiceSipTransport;
    if (!voiceTransport) {
      await cleanupBootstrapFailure(db, observability, logger);
      return err(new DaemonError('No voice transport is enabled'));
    }
    const browserAdapterSelection = browserVoiceTransport
      ? createVoiceAdapterSelection({ transport: browserVoiceTransport, engine: voiceProvider })
      : null;
    const sipAdapterSelection = voiceSipTransport
      ? createVoiceAdapterSelection({ transport: voiceSipTransport, engine: voiceProvider })
      : null;
    if (browserAdapterSelection?.isErr() || sipAdapterSelection?.isErr()) {
      await cleanupBootstrapFailure(db, observability, logger);
      return err(new DaemonError('Configured voice transport and engine capabilities are not proven'));
    }
    const voiceAdapterSelection = browserAdapterSelection ?? sipAdapterSelection;
    if (!voiceAdapterSelection || voiceAdapterSelection.isErr()) {
      await cleanupBootstrapFailure(db, observability, logger);
      return err(new DaemonError('Configured voice adapter selection is unavailable'));
    }
    const voiceCallAdmission = new VoiceCallAdmission(config.voice.maxConcurrentSessions, {
      maxSessionCreations: config.voice.maxSessionCreations,
      sessionCreationWindowMs: config.voice.sessionCreationWindowMs,
    });
    const voiceAuthorization = voiceAuth
      ? createVoiceAuthorization({
          resolve: (owner) => voiceAuth!.resolveResult(owner).map((session) => session?.owner),
          revoke: (owner) => {
            const resolved = voiceAuth!.resolveResult(owner);
            if (resolved.isErr()) return err(resolved.error);
            if (!resolved.value) return err(new PolicyError('Voice grant is missing or revoked'));
            return voiceAuth!.revoke(resolved.value);
          },
        })
      : undefined;
    const voiceChannel = registerVoiceChannel(
      {
        channelRepo: repos.channel,
        bindingRepo: repos.binding,
        personaId: voicePersonaId,
        logger,
      },
      BROWSER_VOICE_CHANNEL_NAME,
    );
    if (voiceChannel.isErr()) {
      await cleanupBootstrapFailure(db, observability, logger);
      return err(new DaemonError(`Failed to register browser voice channel: ${voiceChannel.error.message}`));
    }
    voiceChannelId = voiceChannel.value;
    const voiceExecutionGate = (input: VoiceExecutionGateInput): VoiceResult<void> => {
      const sessionResult = voiceStore.findSession(input.request.sessionId);
      if (sessionResult.isErr()) return err(sessionResult.error);
      if (!sessionResult.value) return err(new PolicyError('Voice session was not found'));
      if (
        sessionResult.value.transport === 'sip'
          ? !voiceSipIngress?.isProviderSessionActive(
              sessionResult.value.providerSessionId ?? '',
              input.owner,
              Date.now(),
            )
          : !voiceAuth?.resolve(input.owner)
      ) {
        return err(new PolicyError('Voice login is no longer active'));
      }
      const current = captureVoicePolicy(input.owner);
      if (current.isErr()) return err(current.error);
      const eligible = voicePolicy!.checkExecution({
        session: sessionResult.value,
        admitted: input.request.policy,
        current: current.value,
        now: Date.now(),
      });
      if (eligible.isErr()) return err(eligible.error);
      if (!eligible.value.eligible) {
        return err(new PolicyError(`Voice execution denied: ${eligible.value.reason ?? 'policy_changed'}`));
      }
      return ok(undefined);
    };
    voiceBackendBridge = new DurableVoiceBackendBridge(voiceStore, repos.queue, {
      executionGate: voiceExecutionGate,
      telemetry: voiceTelemetry,
      logger,
    });
    voiceOutputSink = new VoiceOutputSink(voiceStore, (result) => {
      voiceBackendBridge?.notifyResult(result);
    }, { telemetry: voiceTelemetry });
    const configuredVoiceTransports = new Map<string, VoiceTransport>();
    if (browserVoiceTransport) configuredVoiceTransports.set('webrtc', browserVoiceTransport);
    if (voiceSipTransport) configuredVoiceTransports.set('sip', voiceSipTransport);
    const configuredVoiceSelections = new Map<string, typeof voiceAdapterSelection.value>();
    if (browserAdapterSelection?.isOk()) {
      configuredVoiceSelections.set('webrtc', browserAdapterSelection.value);
    }
    if (sipAdapterSelection?.isOk()) {
      configuredVoiceSelections.set('sip', sipAdapterSelection.value);
    }
    voiceSessionService = new DurableVoiceSessionService({
      store: voiceStore,
      provider: voiceProvider,
      transport: voiceTransport,
      backendBridge: voiceBackendBridge,
      policy: voicePolicy,
      threadRepository: repos.thread,
      messageRepository: repos.message,
      channelId: voiceChannel.value,
      personaId: voicePersonaId,
      providerName: voiceProviderName,
      modelName: voiceBackendModel,
      liveModelName: voiceLiveModel,
      instructions: voiceInstructions,
      voiceName: config.voice.voice,
      generation: (): number => voiceGeneration.value,
      capturePolicy: captureVoicePolicy,
      currentPolicy: currentVoicePolicy,
      isOwnerActive: (owner): boolean =>
        voiceAuth ? voiceAuth.resolve(owner) !== undefined : true,
      authorization: voiceAuthorization,
      adapterSelection: voiceAdapterSelection.value,
      transports: configuredVoiceTransports,
      adapterSelections: configuredVoiceSelections,
      isIncomingOwnerActive: (owner, providerSessionId): boolean =>
        voiceSipIngress?.isProviderSessionActive(providerSessionId, owner) ?? false,
      onIncomingAccepted: (callId): VoiceResult<boolean> => {
        const accepted = voiceSipIngress?.markAccepted(callId);
        if (!accepted) return err(new PolicyError('Incoming SIP ingress is unavailable'));
        return accepted;
      },
      onIncomingClosed: (callId): void => {
        const closed = voiceSipIngress?.markClosed(callId);
        if (closed?.isErr()) {
          logger.warn({ callId, cause: closed.error }, 'voice: failed to record SIP closure');
        }
      },
      callAdmission: voiceCallAdmission,
      maxSessionLifetimeMs: config.voice.maxSessionLifetimeMs,
      maxContextChars: config.voice.maxContextChars,
      usdPerMinute: config.voice.usdPerMinute,
      telemetry: voiceTelemetry,
      logger,
    });
    if (config.voice.enabled) {
      const publicOrigins = [...config.voice.allowedOrigins];
      if (config.voice.publicHost) publicOrigins.push(`https://${config.voice.publicHost}`);
      voiceServer = new BrowserVoiceServer(
        {
          accessToken: voiceAccessToken!,
          host: config.voice.host,
          port: config.voice.port,
          staticDirectory: join(import.meta.dirname, '../voice/web'),
          allowedOrigins: publicOrigins.length > 0 ? publicOrigins : undefined,
          allowedTransportTypes: config.voice.allowedTransportTypes,
          maxConcurrentSessions: config.voice.maxConcurrentSessions,
          maxSessionCreations: config.voice.maxSessionCreations,
          sessionCreationWindowMs: config.voice.sessionCreationWindowMs,
          heartbeatIntervalMs: config.voice.heartbeatIntervalMs,
        },
        { sessionService: voiceSessionService, auth: voiceAuth!, telemetry: voiceTelemetry, logger },
      );
    }
    logger.info(
      { persona: voicePersonaName, provider: voiceProviderName },
      'bootstrap: browser voice runtime initialized',
    );
  }

  // Incoming SIP is an independent, disabled-by-default boundary. It may be
  // enabled without browser voice, but it never infers caller identity from
  // the provider delivery or ordinary SIP headers.
  if (config.voice?.sip?.enabled) {
    const sipConfig = config.voice.sip;
    const sipResolver = new ConfiguredSipAuthorizationResolver({
      issuer: sipConfig.issuer,
      audience: sipConfig.audience,
      publicKeys: sipConfig.publicKeys,
      endpointMappings: sipConfig.endpointMappings,
      revokedIssuers: sipConfig.revokedIssuers,
      revokedKeyIds: sipConfig.revokedKeyIds,
    });
    voiceSipIngress = new SipIngressService({
      repository: new VoiceSipRepository(db),
      authorization: sipResolver,
      deliveryReplayWindowMs: sipConfig.deliveryReplayWindowMs,
      acceptCall: async (input): Promise<SipCallControlResult> => {
        if (!voiceSessionService) return { outcome: 'unknown' as const };
        const accepted = await voiceSessionService.acceptIncomingSession({
          callId: input.callId,
          providerSessionId: input.providerSessionId,
          owner: {
            ownerId: input.grant.owner_id,
            loginRevision: input.grant.revision,
          },
          personaId: input.grant.persona_id,
          admissionExpiresAt: input.grant.expires_at * 1_000,
        });
        if (accepted.isOk()) return { outcome: 'accepted' as const };
        return classifySipAcceptanceFailure(accepted.error);
      },
    });
    const standardWebhookSecret =
      sipConfig.standardWebhookSecret ??
      config.auth.providers[sipConfig.standardWebhookSecretRef]?.apiKey ??
      config.auth.apiKey;
    voiceSipWebhookServer = new SipWebhookServer({
      enabled: true,
      host: sipConfig.host,
      port: sipConfig.port,
      path: sipConfig.path,
      standardWebhookSecret,
      maxRequestBytes: sipConfig.maxRequestBytes,
      timestampToleranceSeconds: sipConfig.timestampToleranceSeconds,
    }, { ingress: voiceSipIngress });
    const reconciledSip = voiceSipIngress.reconcileInterruptedAttempts();
    if (reconciledSip.isErr()) {
      await cleanupBootstrapFailure(db, observability, logger);
      return err(
        new DaemonError(
          `Failed to reconcile incoming SIP state: ${reconciledSip.error.message}`,
          reconciledSip.error,
        ),
      );
    }
    logger.info(
      { host: sipConfig.host, port: sipConfig.port, path: sipConfig.path },
      'bootstrap: incoming SIP ingress initialized',
    );
  }

  // 11. Generic recovery follows voice reconciliation and excludes voice rows.
  recoverFromCrash(repos.queue, logger);

  // 12. Channel registry
  const channelRegistry = new ChannelRegistry(logger);

  // 13. Queue manager. Voice rows must claim through the durable bridge.
  const queueDiagnosticResolver = createQueueDiagnosticResolver(repos.thread, repos.channel);
  const queueManager = new QueueManager(
    repos.queue,
    repos.thread,
    config.queue,
    logger,
    voiceBackendBridge?.claimQueueItem.bind(voiceBackendBridge),
    queueDiagnosticResolver,
  );

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
      // Share the same token store the foreground path uses so an
      // `talonctl auth-mcp` run unlocks Glean (etc.) for both run
      // types — without this, background runs receive raw
      // `auth: { kind: 'oauth2' }` entries and the MCP server 401s.
      oauthTokenStore,
      threadRepository: repos.thread,
      channelRepository: repos.channel,
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
  );

  registerChannels(config, channelRegistry, {
    channelRepo: repos.channel,
    bindingRepo: repos.binding,
    personaRepo: repos.persona,
    messagePipeline,
    logger,
  });
  if (voiceSessionService && voiceChannelId) {
    const voiceConnector = registerVoiceConnector({
      channelRegistry,
      channelRepo: repos.channel,
      threadRepository: repos.thread,
      sessionService: voiceSessionService,
      logger,
    });
    if (voiceConnector.isErr()) {
      await cleanupBootstrapFailure(db, observability, logger);
      return err(
        new DaemonError(`Failed to register browser voice connector: ${voiceConnector.error.message}`),
      );
    }
  }

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
    a2aServer,
    a2aTaskMapper,
    voiceStore,
    voicePolicy,
    voiceAuth,
    voiceBackendBridge,
    voiceOutputSink,
    voiceSessionService,
    voiceProvider,
    voiceTransport,
    voiceServer,
    voiceSipIngress,
    voiceSipWebhookServer,
    voiceTelemetry,
    voiceRuntimeConfig,
    voiceGeneration,
  } as Omit<DaemonContext, 'hostToolsBridge'> & { hostToolsBridge?: HostToolsBridge };

  const hostToolsBridge = new HostToolsBridge(partialCtx as DaemonContext);
  backgroundAgentManager?.setHostToolsBridge(hostToolsBridge);
  partialCtx.hostToolsBridge = hostToolsBridge;
  const ctx = partialCtx as DaemonContext;
  daemonContextRef.current = ctx;

  logger.info('bootstrap: context ready');

  return ok(ctx);
}

function classifySipAcceptanceFailure(error: unknown): SipCallControlResult {
  const candidate = error as {
    readonly code?: unknown;
    readonly reason?: unknown;
    readonly status?: unknown;
  };
  // A durable registration failure means the provider may already have
  // accepted the call. Keep the outcome unknown so no retry or false terminal
  // rejection can orphan an active provider session.
  if (candidate.code === 'DB_ERROR') return { outcome: 'unknown' };
  if (candidate.reason === 'http') {
    const status = typeof candidate.status === 'number' ? candidate.status : undefined;
    return status !== undefined && status >= 400 && status < 500 && ![408, 409, 429].includes(status)
      ? { outcome: 'rejected' }
      : { outcome: 'unknown' };
  }
  if (
    candidate.reason === 'invalid_request' ||
    candidate.reason === 'unsupported_transport' ||
    candidate.reason === 'configuration'
  ) {
    return { outcome: 'rejected' };
  }
  if (candidate.reason !== undefined) return { outcome: 'unknown' };
  return { outcome: 'rejected' };
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
