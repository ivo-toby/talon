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
import type { ContextAssembler } from './context-assembler.js';
import type { ObservabilityService } from '../observability/langfuse/observability-types.js';
import type { A2AServer } from '../a2a/a2a-server.js';
import type { A2ATaskMapper } from '../a2a/a2a-task-mapper.js';

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
}

// ---------------------------------------------------------------------------
// DaemonContext
// ---------------------------------------------------------------------------

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
  readonly providerRegistry: ProviderRegistry<AgentRunnerProviderConfig>;
  readonly subAgentRunner: SubAgentRunner | null;
  readonly backgroundAgentManager: BackgroundAgentManager | null;
  readonly executionEnvManager: ExecutionEnvManager | null;
  readonly contextRoller: ContextRoller | null;
  readonly contextAssembler: ContextAssembler;
  readonly logger: pino.Logger;
  readonly toolInstructions: Map<string, string>;
  readonly a2aServer: A2AServer | null;
  readonly a2aTaskMapper: A2ATaskMapper | null;
}
