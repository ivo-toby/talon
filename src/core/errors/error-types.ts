/**
 * Domain error hierarchy for the Talon daemon.
 *
 * All expected errors extend TalonError and carry a machine-readable `code`
 * so callers can pattern-match without parsing message strings.
 * Unexpected / unrecoverable failures are still plain thrown exceptions.
 */

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

/**
 * Abstract base for all Talon domain errors.
 * Subclasses must declare a readonly `code` string.
 */
export abstract class TalonError extends Error {
  abstract readonly code: string;
  readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = this.constructor.name;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Domain-specific error classes
// ---------------------------------------------------------------------------

/** Configuration loading or validation error. */
export class ConfigError extends TalonError {
  readonly code = 'CONFIG_ERROR' as const;
}

/** SQLite / database operation error. */
export class DbError extends TalonError {
  readonly code = 'DB_ERROR' as const;
}

/** File-based IPC read/write error. */
export class IpcError extends TalonError {
  readonly code = 'IPC_ERROR' as const;
}

/** Container sandbox lifecycle error. */
export class SandboxError extends TalonError {
  readonly code = 'SANDBOX_ERROR' as const;
}

/** Tool invocation or policy error. */
export class ToolError extends TalonError {
  readonly code = 'TOOL_ERROR' as const;
}

/** Channel send/connect error. */
export class ChannelError extends TalonError {
  readonly code = 'CHANNEL_ERROR' as const;
}

/** Durable queue enqueue/dequeue error. */
export class QueueError extends TalonError {
  readonly code = 'QUEUE_ERROR' as const;
}

/** Cron / schedule expression error. */
export class ScheduleError extends TalonError {
  readonly code = 'SCHEDULE_ERROR' as const;
}

/** Database migration error. */
export class MigrationError extends TalonError {
  readonly code = 'MIGRATION_ERROR' as const;
}

/** Capability or approval policy violation. */
export class PolicyError extends TalonError {
  readonly code = 'POLICY_ERROR' as const;
}

/** Per-thread memory read/write error. */
export class MemoryError extends TalonError {
  readonly code = 'MEMORY_ERROR' as const;
}

/** Persona lookup or validation error. */
export class PersonaError extends TalonError {
  readonly code = 'PERSONA_ERROR' as const;
}

/** MCP proxy, registry, or forwarding error. */
export class McpError extends TalonError {
  readonly code = 'MCP_ERROR' as const;
}

/** Daemon lifecycle error (startup, shutdown, configuration reload). */
export class DaemonError extends TalonError {
  readonly code = 'DAEMON_ERROR' as const;
}

/** Message ingestion pipeline error (normalization, dedup, or routing failure). */
export class PipelineError extends TalonError {
  readonly code = 'PIPELINE_ERROR' as const;
}

/** Multi-agent collaboration session or worker coordination error. */
export class CollaborationError extends TalonError {
  readonly code = 'COLLABORATION_ERROR' as const;
}

/** Skill loading, validation, or resolution error. */
export class SkillError extends TalonError {
  readonly code = 'SKILL_ERROR' as const;
}

/** Sub-agent loading, execution, or timeout error. */
export class SubAgentError extends TalonError {
  readonly code = 'SUBAGENT_ERROR' as const;
}

/** Background Claude Code worker lifecycle error. */
export class BackgroundAgentError extends TalonError {
  readonly code = 'BACKGROUND_AGENT_ERROR' as const;
}

/** A2A protocol validation, routing, or task lifecycle error. */
export class A2AError extends TalonError {
  readonly code = 'A2A_ERROR' as const;
}

/** Sprites-backed execution environment lifecycle or policy error. */
export class ExecutionEnvError extends TalonError {
  readonly code = 'EXECUTION_ENV_ERROR' as const;
}

/** Lifecycle contract, registry, or policy error. */
export class LifecycleError extends TalonError {
  readonly code = 'LIFECYCLE_ERROR' as const;
}
