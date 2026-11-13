/**
 * DaemonContext — fully-initialized runtime state for the daemon.
 *
 * Built once by DaemonBootstrap.bootstrap(). All fields are non-null
 * and readonly, eliminating the defensive null checks that plagued
 * the monolithic TalondDaemon class.
 *
 * Passed by reference to AgentRunner and other subsystems that need
 * access to shared daemon state.
 */

import type pino from 'pino';
import type { Result } from 'neverthrow';
import type Database from 'better-sqlite3';
import type { AgentRunnerProviderConfig, TalondConfig } from '../core/config/config-types.js';
import type {
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
  ImageRepository,
  ImageIngestionRepository,
} from '../core/database/repositories/index.js';
import type { ChannelRegistry } from '../channels/channel-registry.js';
import type { QueueManager } from '../queue/queue-manager.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { PersonaLoader } from '../personas/persona-loader.js';
import type { SessionTracker } from '../sandbox/session-tracker.js';
import type { ThreadWorkspace } from '../memory/thread-workspace.js';
import type { AuditLogger } from '../core/logging/audit-logger.js';
import type { LoadedSkill } from '../skills/skill-types.js';
import type { SkillResolver } from '../skills/skill-resolver.js';
import type { MessagePipeline } from '../pipeline/message-pipeline.js';
import type { HostToolsBridge } from '../tools/host-tools-bridge.js';
import type { SubAgentRunner } from '../subagents/subagent-runner.js';
import type { BackgroundAgentManager } from '../subagents/background/background-agent-manager.js';
import type { ExecutionEnvManager } from '../execution-env/execution-env-manager.js';
import type { ProviderRegistry } from '../providers/provider-registry.js';
import type { ContextRoller } from './context-roller.js';
import type { ContextAssembler, ImageContextSource } from './context-assembler.js';
import type { ObservabilityService } from '../observability/langfuse/observability-types.js';
import type { A2AServer } from '../a2a/a2a-server.js';
import type { A2ATaskMapper } from '../a2a/a2a-task-mapper.js';
import type { A2AAgentCard } from '../a2a/a2a-types.js';
import type { OAuthTokenStore } from '../auth/oauth-token-store.js';
import type { SignalToolExecutionRegistry } from '../tools/host-tools/signal-tool-execution.js';
import type { ImageStore } from '../images/image-store.js';
import type { ImageIngestionCoordinator } from '../images/image-ingestion.js';
import type { ImageAccess } from '../images/image-types.js';
import type { ImageLifecycleManager } from '../images/image-lifecycle.js';

// ---------------------------------------------------------------------------
// Repository bundle
// ---------------------------------------------------------------------------

/** All database repositories, grouped for clean dependency passing. */
export interface DaemonRepos {
  readonly queue: QueueRepository;
  readonly thread: ThreadRepository;
  readonly channel: ChannelRepository;
  readonly persona: PersonaRepository;
  readonly backgroundTask: BackgroundTaskRepository;
  readonly executionEnv: ExecutionEnvRepository;
  readonly executionEnvCheckpoint: ExecutionEnvCheckpointRepository;
  readonly schedule: ScheduleRepository;
  readonly audit: AuditRepository;
  readonly message: MessageRepository;
  readonly run: RunRepository;
  readonly binding: BindingRepository;
  readonly memory: MemoryRepository;
  readonly a2aTask: A2ATaskRepository;
  readonly image: ImageRepository;
  readonly imageIngestion: ImageIngestionRepository;
}

// ---------------------------------------------------------------------------
// DaemonContext
// ---------------------------------------------------------------------------

/** Exact authenticated provider-attempt generation. Secrets remain in process/MCP env only. */
export interface SignalRunGeneration {
  readonly runId: string;
  readonly threadId: string;
  readonly personaId: string;
  readonly bridgeSecret: string;
}

/**
 * Immutable runtime context populated during bootstrap.
 *
 * Most fields are guaranteed non-null. If bootstrap fails, no context
 * is created — the daemon never enters 'running' state.
 *
 * Exceptions: `a2aServer` and `a2aTaskMapper` are nullable — they are only
 * populated when the A2A feature is enabled in config. Callers must null-check
 * these fields before use.
 */
export interface DaemonContext {
  readonly db: Database.Database;
  readonly config: TalondConfig;
  readonly configPath: string;
  readonly dataDir: string;
  readonly repos: DaemonRepos;
  readonly channelRegistry: ChannelRegistry;
  /** TASK012 injects this SAME registry into the authenticated bridge handlers, backed by this
   * context's queue/run/persona graph. Required on ALL dispatch, not just Signal origins.
   * Absence supports legacy ordinary callers only; it grants no Signal send/replay authority. */
  readonly signalRuntime?: {
    readonly executions: SignalToolExecutionRegistry;
    /**
     * Seal and drain one authenticated provider-attempt generation.
     *
     * When called: by AgentRunner once per foreground run, idempotently (the runner caches the first
     * promise). It is awaited before any Signal reply is saved, on provider failure/timeout paths,
     * and in the run's finally. It is never called for background-notification runs.
     *
     * Ok: new admission for this exact generation (runId, threadId, personaId, bridgeSecret) is sealed
     * AND every admitted original dispatch/continuation has settled, including timeout losers and
     * retained producer repair Results. Ok certifies settled lifetime only, NOT tool success.
     *
     * Err or throw: settlement is NOT certified. The implementation must not close, recover or replay
     * anything on failure, and must stay idempotent. A newer generation must not be sealed by stale
     * cleanup. The runner retries the call up to SIGNAL_STATE_RETRY_MAX_ATTEMPTS (8) times with capped
     * backoff (250 ms doubling to 10 s), under an overall 60 s deadline. A call still pending at the
     * deadline counts as Err, and later results are ignored. Exhaustion returns a typed
     * SignalGenerationDrainError (reason DRAIN_EXHAUSTED) with no causes, so the queue item takes its
     * normal retry/dead-letter path. If a Signal tool was already invoked, the failure is terminal for
     * provider replay (NonRetryableRunError).
     *
     * Not implemented by the current HostToolsBridge. There is no no-op production fallback.
     */
    readonly sealAndDrain: (generation: SignalRunGeneration) => Promise<Result<void, Error>>;
  };
  readonly queueManager: QueueManager;
  readonly scheduler: Scheduler;
  readonly personaLoader: PersonaLoader;
  readonly sessionTracker: SessionTracker;
  readonly threadWorkspace: ThreadWorkspace;
  readonly auditLogger: AuditLogger;
  readonly skillResolver: SkillResolver;
  readonly loadedSkills: LoadedSkill[];
  readonly messagePipeline: MessagePipeline;
  readonly observability: ObservabilityService;
  readonly hostToolsBridge: HostToolsBridge;
  readonly oauthTokenStore: OAuthTokenStore;
  readonly providerRegistry: ProviderRegistry<AgentRunnerProviderConfig>;
  readonly backgroundProviderRegistry: ProviderRegistry;
  readonly subAgentRunner: SubAgentRunner | null;
  readonly backgroundAgentManager: BackgroundAgentManager | null;
  readonly executionEnvManager: ExecutionEnvManager | null;
  readonly contextRoller: ContextRoller | null;
  readonly contextAssembler: ContextAssembler;
  readonly logger: pino.Logger;
  readonly toolInstructions: Map<string, string>;
  readonly a2aServer: A2AServer | null;
  readonly a2aTaskMapper: A2ATaskMapper | null;
  /**
   * Agent-card registry shared by the A2A server and mapper. Rebuilt IN PLACE
   * (clear + repopulate) on hot reload so new personas become routable.
   */
  readonly a2aCardRegistry?: Map<string, A2AAgentCard>;
  // Durable image subsystem (TASK-010): store, ingestion coordinator,
  // the ImageAccess port implementation, and the startup/periodic
  // recovery + retention lifecycle.
  readonly imageStore: ImageStore;
  readonly imageIngestionCoordinator: ImageIngestionCoordinator;
  readonly imageAccess: ImageAccess;
  readonly imageLifecycle: ImageLifecycleManager;
  /**
   * Refreshed Image/Finding reads for ADR-0002 context replay (live
   * descriptors, thread inventory, canonical Findings). Passed to AgentRunner
   * at construction; ContextRoller receives it per rotation call.
   */
  readonly imageContextSource: ImageContextSource;
}
