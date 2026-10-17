/**
 * Daemon IPC types and helpers for `talonctl <-> talond` communication.
 *
 * Uses the same file-based IPC transport as the agent channel, but with a
 * simpler command/response envelope suited for CLI control operations.
 *
 * Flow:
 *   talonctl writes a DaemonCommand to the daemon's command directory.
 *   talond reads it, executes the command, and writes a DaemonResponse to
 *   a per-command response directory that talonctl polls.
 */

import { z } from 'zod';
import { err, ok, type Result } from '../core/types/result.js';
import { SIGNAL_DELIVERY_REASONS } from '../core/errors/error-types.js';
import { SignalConnectorError, type SignalConnector, type SignalConnectorStatus } from '../channels/connectors/signal/signal-connector.js';
import { SignalVerificationError } from '../channels/connectors/signal/signal-account-verifier.js';
import { SignalStateError } from '../core/database/repositories/signal-account-state-repository.js';
import { SignalDeviceError } from '../channels/connectors/signal/signal-device-registry.js';
import { SignalRpcRemoteError } from '../channels/connectors/signal/signal-wire.js';
import { SignalRpcTransportError } from '../channels/connectors/signal/signal-rpc-client.js';

// ---------------------------------------------------------------------------
// Command types
// ---------------------------------------------------------------------------

/** Union of all supported daemon control commands. */
export type DaemonCommandType = 'status' | 'reload' | 'shutdown' | 'queue-purge' | 'signal-resume';

/** A command sent by `talonctl` to the running `talond` process. */
export interface DaemonCommand {
  /** UUID v4 uniquely identifying this command instance. */
  id: string;
  /** The command to execute. */
  command: DaemonCommandType;
  /** Optional command-specific parameters. */
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/** The daemon's response to a {@link DaemonCommand}. */
export interface DaemonResponse {
  /** UUID v4 uniquely identifying this response. */
  id: string;
  /** ID of the {@link DaemonCommand} this response is for. */
  commandId: string;
  /** Whether the command completed successfully. */
  success: boolean;
  /** Command-specific response data on success. */
  data?: Record<string, unknown>;
  /** Human-readable error description on failure. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/** Zod schema for validating serialised {@link DaemonCommand} objects. */
const LegacyDaemonCommandSchema = z.object({
  id: z.uuid(),
  command: z.enum(['status', 'reload', 'shutdown', 'queue-purge']),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const ChannelName = z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/);
export const SignalResumeRequestSchema = z.object({
  channel: ChannelName,
  externalChallengeResolved: z.literal(true),
}).strict();
export type SignalResumeRequest = z.infer<typeof SignalResumeRequestSchema>;
const SignalResumeCommandSchema = z.object({
  id: z.uuid(), command: z.literal('signal-resume'), payload: SignalResumeRequestSchema,
}).strict();
export type SignalResumeCommand = z.infer<typeof SignalResumeCommandSchema>;

// The existing server serializes Zod errors. Never let strict unknown-key diagnostics
// carry arbitrary field names/values into that serializer.
const SafeSignalResumeCommandSchema = z.custom<SignalResumeCommand>(
  (value) => SignalResumeCommandSchema.safeParse(value).success,
  { message: 'Invalid Signal resume command' },
);
export const DaemonCommandSchema = z.union([LegacyDaemonCommandSchema, SafeSignalResumeCommandSchema]);

/** Zod schema for validating serialised {@link DaemonResponse} objects. */
export const DaemonResponseSchema = z.object({
  id: z.uuid(),
  commandId: z.uuid(),
  success: z.boolean(),
  data: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

/** Fixed local failure labels only; no raw cause, remote error, path or payload. */
export class SignalManagementError extends Error {
  readonly code = 'SIGNAL_MANAGEMENT_ERROR';
  constructor(readonly reason: 'INVALID_REQUEST' | 'INVALID_RESPONSE' | 'UNAVAILABLE' | 'TIMEOUT') {
    super(`Signal management unavailable: ${reason}`);
    this.name = 'SignalManagementError';
  }
}

export const SignalResumeDataSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('verified') }).strict(),
  z.object({ outcome: z.literal('blocked'), reason: z.enum([
    'NEEDS_SETUP', 'RATE_LIMITED', 'CHALLENGE_REQUIRED', 'RECOVERY_PENDING',
    'BUDGET', 'DATABASE', 'CONFLICT', 'BUSY', 'PAUSED', 'VERIFICATION_PENDING', 'VERIFICATION_STALE',
  ]) }).strict(),
  z.object({ outcome: z.literal('unavailable'), reason: z.enum([
    'STOPPED', 'DISCONNECTED', 'TIMEOUT', 'CANCELLED', 'CAPACITY', 'INVALID_REQUEST',
    'PROTOCOL_FAILURE', 'FRAME_TOO_LARGE', 'PRE_RESPONSE_OVERFLOW', 'UNTRUSTED_SOCKET',
    'NOT_FOUND', 'UNSUPPORTED', 'VERIFICATION_FAILED',
  ]) }).strict(),
]);
export type SignalResumeData = z.infer<typeof SignalResumeDataSchema>;

/** Presentation ONLY of this invocation's actual Result. Never invoke a connector,
 * retry a failed assertion, read a database or infer permission from health/status. */
export function projectSignalResumeResult(
  result: Awaited<ReturnType<SignalConnector['resumeChallenge']>>,
): SignalResumeData {
  if (result.isOk()) {
    const status = result.value;
    // checking is active-promise bookkeeping in the returned immutable snapshot;
    // the producer clears the exact challenge and publishes proof before this Ok.
    if (status.state === 'verified' && status.reason === undefined)
      return { outcome: 'verified' };
    if (status.reason === 'PAUSED') return { outcome: 'blocked', reason: 'PAUSED' };
    if (status.state === 'needs_setup') return { outcome: 'blocked', reason: 'NEEDS_SETUP' };
    if (status.state === 'stopped') return { outcome: 'unavailable', reason: 'STOPPED' };
    return { outcome: 'blocked', reason: status.state === 'stale' ? 'VERIFICATION_STALE' : 'VERIFICATION_PENDING' };
  }
  const failure = result.error;
  if (failure instanceof SignalConnectorError || failure instanceof SignalDeviceError)
    return { outcome: 'blocked', reason: 'NEEDS_SETUP' };
  if (failure instanceof SignalStateError) {
    if (failure.reason === 'NOT_FOUND') return { outcome: 'unavailable', reason: 'NOT_FOUND' };
    if (failure.reason !== 'INVALID_INPUT') return { outcome: 'blocked', reason: failure.reason };
  }
  if (failure instanceof SignalVerificationError) {
    if (failure.reason === 'VERIFICATION_PENDING' || failure.reason === 'VERIFICATION_STALE')
      return { outcome: 'blocked', reason: failure.reason };
    if (failure.reason === 'STOPPED') return { outcome: 'unavailable', reason: 'STOPPED' };
    if (failure.reason === 'STALE_CONNECTION') return { outcome: 'unavailable', reason: 'DISCONNECTED' };
  }
  if (failure instanceof SignalRpcRemoteError) {
    if (failure.remoteCode === 'RATE_LIMIT') return { outcome: 'blocked', reason: 'RATE_LIMITED' };
    if (failure.remoteCode === 'CHALLENGE_REQUIRED') return { outcome: 'blocked', reason: 'CHALLENGE_REQUIRED' };
    if (failure.remoteCode === 'METHOD_NOT_FOUND') return { outcome: 'unavailable', reason: 'UNSUPPORTED' };
  }
  if (failure instanceof SignalRpcTransportError)
    return { outcome: 'unavailable', reason: failure.transportCode };
  return { outcome: 'unavailable', reason: 'VERIFICATION_FAILED' };
}
export const SignalResumeResponseSchema = z.object({
  id: z.uuid(), commandId: z.uuid(), success: z.boolean(), data: SignalResumeDataSchema,
}).strict();
export type SignalResumeResponse = z.infer<typeof SignalResumeResponseSchema>;

/** Only TASK-012's authenticated handler may report verified, AFTER the exact
 * connector.resumeChallenge assertion returns Ok with verified, unpaused proof.
 * No status/health count or generic success boolean substitutes for that result. */
export function parseSignalResumeResponse(
  value: unknown, commandId: string,
): Result<SignalResumeData, SignalManagementError> {
  const parsed = SignalResumeResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.commandId !== commandId ||
      parsed.data.success !== (parsed.data.data.outcome === 'verified'))
    return err(new SignalManagementError('INVALID_RESPONSE'));
  return ok(parsed.data.data);
}

const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const BufferCounts = z.object({ held: Count.max(64), dropped: Count }).strict();
const Verification = z.object({
  state: z.enum(['pending', 'verified', 'stale', 'needs_setup', 'suspended', 'stopped']),
  reason: z.enum(['VERIFICATION_PENDING', 'VERIFICATION_STALE', 'DEVICE_METADATA_INVALID',
    'UNSUPPORTED_BRIDGE_MODE', 'STATE_WRITE_FAILED', 'PAUSED', 'STOPPED']).optional(),
  checking: z.boolean(),
}).strict();
const Connector = z.object({
  state: z.enum(['stopped', 'reconnecting', 'ready', 'needs_setup']),
  reason: z.enum(['RECEIPT_REQUIRED', 'OWNER_BUSY', 'UNSUPPORTED_VERSION', 'UNSUPPORTED_BRIDGE_MODE',
    'ACCOUNT_MISMATCH', 'DEVICE_METADATA_INVALID', 'UNTRUSTED_SOCKET', 'PROTOCOL_FAILURE_LOOP',
    'VERIFICATION_PENDING', 'VERIFICATION_STALE', 'STATE_WRITE_FAILED', 'OUTBOUND_STOPPED', 'DISCONNECTED']).optional(),
  verification: Verification.optional(),
  sender: z.object({ state: z.enum(['healthy', 'blocked']), stopped: z.boolean(), pendingWrites: Count }).strict().optional(),
  outboundSuspended: z.boolean(),
  buffers: z.object({ alias: BufferCounts, proof: BufferCounts, receipt: BufferCounts }).strict().optional(),
  draining: z.boolean(), replacementAllowed: z.boolean(), persistenceBlocked: z.boolean(),
}).strict();
export type SignalConnectorStatusData = z.infer<typeof Connector>;

/** Explicit projection of actual TASK-008 public status. No proof roster, next-check
 * timestamp, account/target/device identity, body or raw diagnostic crosses IPC. */
export function projectSignalConnectorStatus(
  status: SignalConnectorStatus,
): Result<SignalConnectorStatusData, SignalManagementError> {
  const verification = status.verification;
  const parsed = Connector.safeParse({
    state: status.state, reason: status.reason,
    verification: verification === undefined ? undefined : {
      state: verification.state, reason: verification.reason, checking: verification.checking,
    },
    sender: status.sender === undefined ? undefined : {
      state: status.sender.state, stopped: status.sender.stopped, pendingWrites: status.sender.pendingWrites,
    },
    outboundSuspended: status.outboundSuspended,
    buffers: status.buffers === undefined ? undefined : Object.fromEntries(
      (['alias', 'proof', 'receipt'] as const).map((kind) => [kind, {
        held: status.buffers?.[kind].held, dropped: status.buffers?.[kind].dropped,
      }]),
    ),
    draining: status.draining, replacementAllowed: status.replacementAllowed,
    persistenceBlocked: status.persistenceBlocked,
  });
  return parsed.success ? ok(parsed.data) : err(new SignalManagementError('INVALID_RESPONSE'));
}

/** Optional status extension. Omitted components mean unavailable, NOT healthy/zero.
 * TASK-012 supplies repository-derived saved aggregates and projected current connectors. */
export const SignalStatusDataSchema = z.object({
  saved: z.object({
    pending: Count, terminal: Count,
    reasons: z.array(z.object({ reason: z.enum(SIGNAL_DELIVERY_REASONS), count: Count }).strict())
      .max(SIGNAL_DELIVERY_REASONS.length),
  }).strict().optional(),
  channels: z.array(Connector.extend({ channel: ChannelName }).strict()).max(64).optional(),
}).strict().refine((data) => data.saved !== undefined || data.channels !== undefined);
export type SignalStatusData = z.infer<typeof SignalStatusDataSchema>;
export function parseSignalStatusData(value: unknown): Result<SignalStatusData, SignalManagementError> {
  const parsed = SignalStatusDataSchema.safeParse(value);
  return parsed.success ? ok(parsed.data) : err(new SignalManagementError('INVALID_RESPONSE'));
}

// ---------------------------------------------------------------------------
// Server and client re-exports
// ---------------------------------------------------------------------------

export { DaemonIpcServer } from './daemon-ipc-server.js';
export type { DaemonIpcServerOptions } from './daemon-ipc-server.js';

export { DaemonIpcClient } from './daemon-ipc-client.js';
export type { DaemonIpcClientOptions } from './daemon-ipc-client.js';
