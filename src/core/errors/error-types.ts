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

/** Local enums only: remote messages, identifiers and challenge values are never causes. */
export const SIGNAL_DELIVERY_REASONS = [
  'UNAVAILABLE',
  'NEEDS_SETUP',
  'UNSUPPORTED_VERSION',
  'UNSUPPORTED_BRIDGE_MODE',
  'UNTRUSTED_SOCKET',
  'ACCOUNT_MISMATCH',
  'DEVICE_METADATA_INVALID',
  'VERIFICATION_PENDING',
  'VERIFICATION_STALE',
  'PROTOCOL_FAILURE_LOOP',
  'UNSUPPORTED_ATTACHMENT',
  'INVALID_DESTINATION',
  'TARGET_UNVERIFIABLE',
  'TARGET_REFUSED',
  'TARGET_LOOKUP_FAILED',
  'RPC_CAPACITY',
  'ACCOUNT_BUSY',
  'WAIT_EXPIRED',
  'RATE_LIMITED',
  'CHALLENGE_REQUIRED',
  'RECOVERY_PENDING',
  'STATE_WRITE_FAILED',
  'TIMEOUT',
  'DISCONNECTED',
  'CANCELLED',
  'NETWORK_FAILURE',
  'RECIPIENT_REFUSED',
  'INVALID_RESPONSE',
  'RPC_ERROR',
  'PARTIAL_ACCEPTANCE',
  'UNKNOWN_ACCEPTANCE',
  'CHECKPOINT_INVALID',
  'CHECKPOINT_EXPIRED',
  'OUTPUT_TOO_LARGE',
  'TARGET_LATCHED',
] as const;

export type SignalDeliveryReason = (typeof SIGNAL_DELIVERY_REASONS)[number];
export type SignalDeliveryOutcome = 'NOT_SENT' | 'PARTIAL' | 'UNKNOWN';
export type SignalChunkAcceptance = 'unwritten' | 'refused' | 'complete' | 'partial' | 'unknown';
export type SignalRetryScope = 'delivery_only' | 'none';

export interface SignalDeliveryFailure {
  readonly reason: SignalDeliveryReason;
  readonly outcome: SignalDeliveryOutcome;
  readonly acceptedChunks: number;
  readonly currentChunkAcceptance: SignalChunkAcceptance;
  readonly successCount: number;
  readonly failureCount: number;
  readonly retryScope: SignalRetryScope;
  readonly notBefore?: number;
}

/** Preserve this identity through wrappers; retry delivery, never the provider turn. */
export class SignalDeliveryError extends ChannelError implements SignalDeliveryFailure {
  readonly reason: SignalDeliveryReason;
  readonly outcome: SignalDeliveryOutcome;
  readonly acceptedChunks: number;
  readonly currentChunkAcceptance: SignalChunkAcceptance;
  readonly successCount: number;
  readonly failureCount: number;
  readonly retryScope: SignalRetryScope;
  readonly notBefore?: number;
  readonly providerRetryable = false;

  constructor(failure: SignalDeliveryFailure) {
    const reason =
      SIGNAL_DELIVERY_REASONS.find((value) => value === failure.reason) ?? 'INVALID_RESPONSE';
    super(`Signal delivery failed: ${reason}`);
    this.reason = reason;
    const isSafeCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
    const safeCount = (value: number): number => (isSafeCount(value) ? value : 0);
    const currentUnsent =
      failure.currentChunkAcceptance === 'unwritten' ||
      failure.currentChunkAcceptance === 'refused';
    const currentAccepted =
      failure.currentChunkAcceptance === 'partial' || failure.currentChunkAcceptance === 'complete';
    // Each complete chunk and an accepted current chunk require at least one recipient success.
    // Group recipient totals can exceed this lower bound; they are not chunk counts.
    const countsConsistent =
      failure.successCount >= failure.acceptedChunks &&
      (!currentAccepted || failure.successCount > failure.acceptedChunks) &&
      (!currentUnsent || failure.acceptedChunks > 0 || failure.successCount === 0);
    const outcomeConsistent =
      failure.outcome === 'NOT_SENT'
        ? currentUnsent && failure.acceptedChunks === 0 && failure.successCount === 0
        : failure.outcome === 'PARTIAL'
          ? failure.successCount > 0 &&
            (currentUnsent ? failure.acceptedChunks > 0 : currentAccepted)
          : failure.outcome === 'UNKNOWN' && failure.currentChunkAcceptance === 'unknown';
    const valid =
      countsConsistent &&
      outcomeConsistent &&
      reason === failure.reason &&
      ['NOT_SENT', 'PARTIAL', 'UNKNOWN'].includes(failure.outcome) &&
      ['unwritten', 'refused', 'complete', 'partial', 'unknown'].includes(
        failure.currentChunkAcceptance,
      ) &&
      [failure.acceptedChunks, failure.successCount, failure.failureCount].every(isSafeCount);
    this.outcome = valid ? failure.outcome : 'UNKNOWN';
    this.acceptedChunks = safeCount(failure.acceptedChunks);
    this.currentChunkAcceptance = valid ? failure.currentChunkAcceptance : 'unknown';
    this.successCount = safeCount(failure.successCount);
    this.failureCount = safeCount(failure.failureCount);
    this.retryScope =
      this.outcome !== 'UNKNOWN' &&
      (this.currentChunkAcceptance === 'unwritten' || this.currentChunkAcceptance === 'refused') &&
      failure.retryScope === 'delivery_only'
        ? 'delivery_only'
        : 'none';
    this.notBefore =
      failure.notBefore !== undefined &&
      Number.isSafeInteger(failure.notBefore) &&
      failure.notBefore >= 0
        ? failure.notBefore
        : undefined;
  }
}

export class DeliveryDeferredError extends TalonError {
  readonly code = 'DELIVERY_DEFERRED' as const;
  readonly notBefore?: number;
  constructor(
    readonly deliveryError: SignalDeliveryError,
    readonly expiresAt: number,
  ) {
    super('Signal delivery deferred');
    this.notBefore = deliveryError.notBefore;
  }
}

export class DeliveryCancelled extends TalonError {
  readonly code = 'DELIVERY_CANCELLED' as const;
  constructor() {
    super('Signal delivery cancelled');
  }
}

export class NonRetryableRunError extends TalonError {
  readonly code = 'NON_RETRYABLE_RUN' as const;
  constructor(readonly deliveryError?: SignalDeliveryError) {
    super('Provider execution must not be replayed after Signal delivery');
  }
}
