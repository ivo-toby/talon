/**
 * Application error types and Result utilities.
 *
 * Uses neverthrow Result<T, E> for expected errors throughout the daemon.
 * Defines a tagged union of domain error types so call sites can pattern-match
 * on failure reasons without catching exceptions.
 */

export {
  TalonError,
  ConfigError,
  DbError,
  IpcError,
  SandboxError,
  ToolError,
  ChannelError,
  SignalDeliveryError,
  DeliveryDeferredError,
  DeliveryCancelled,
  NonRetryableRunError,
  SIGNAL_DELIVERY_REASONS,
  QueueError,
  ScheduleError,
  MigrationError,
  PolicyError,
  MemoryError,
  PersonaError,
  McpError,
  DaemonError,
  PipelineError,
  CollaborationError,
  SkillError,
  SubAgentError,
  BackgroundAgentError,
  A2AError,
  ExecutionEnvError,
} from './error-types.js';

export type {
  SignalDeliveryReason,
  SignalDeliveryOutcome,
  SignalChunkAcceptance,
  SignalRetryScope,
  SignalDeliveryFailure,
} from './error-types.js';

export { ErrorCodes } from './error-codes.js';
export type { ErrorCode } from './error-codes.js';
