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

// ---------------------------------------------------------------------------
// Command types
// ---------------------------------------------------------------------------

/** Union of all supported daemon control commands. */
export type DaemonCommandType =
  | 'status'
  | 'reload'
  | 'shutdown'
  | 'queue-purge'
  | 'lifecycle-handlers'
  | 'lifecycle-inspect'
  | 'lifecycle-replay'
  | 'lifecycle-disable'
  | 'lifecycle-candidates'
  | 'lifecycle-promote'
  | 'lifecycle-rollback-promotion';

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

const CommandIdSchema = z.uuid();
const LifecycleLimitSchema = z.number().int().min(1).max(100).optional();
const QueueStatusSchema = z.enum([
  'pending',
  'claimed',
  'processing',
  'completed',
  'failed',
  'dead_letter',
]);

const EmptyPayloadSchema = z.object({}).strict();
const ReloadPayloadSchema = z.object({ configPath: z.string().min(1).optional() }).strict();
const QueuePurgePayloadSchema = z
  .object({ statuses: z.array(QueueStatusSchema).min(1).max(6).optional() })
  .strict();
const LifecycleHandlersPayloadSchema = z.object({ limit: LifecycleLimitSchema }).strict();
const LifecycleInspectPayloadSchema = z
  .object({ eventId: z.string().min(1), handlerId: z.string().min(1).optional() })
  .strict();
const LifecycleReplayPayloadSchema = z
  .object({ eventId: z.string().min(1), handlerId: z.string().min(1) })
  .strict();
const LifecycleDisablePayloadSchema = z.object({ handlerId: z.string().min(1) }).strict();
const LifecycleCandidatesPayloadSchema = z
  .object({ persona: z.string().min(1), limit: LifecycleLimitSchema })
  .strict();
const LifecyclePromotePayloadSchema = z
  .object({
    persona: z.string().min(1),
    promotionId: z.string().min(1),
    approvedBy: z.string().min(1).optional(),
  })
  .strict();
const LifecycleRollbackPromotionPayloadSchema = z
  .object({
    persona: z.string().min(1),
    activationId: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

/** Zod schema for validating serialised {@link DaemonCommand} objects. */
export const DaemonCommandSchema = z.discriminatedUnion('command', [
  z
    .object({
      id: CommandIdSchema,
      command: z.literal('status'),
      payload: EmptyPayloadSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: CommandIdSchema,
      command: z.literal('reload'),
      payload: ReloadPayloadSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: CommandIdSchema,
      command: z.literal('shutdown'),
      payload: EmptyPayloadSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: CommandIdSchema,
      command: z.literal('queue-purge'),
      payload: QueuePurgePayloadSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: CommandIdSchema,
      command: z.literal('lifecycle-handlers'),
      payload: LifecycleHandlersPayloadSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: CommandIdSchema,
      command: z.literal('lifecycle-inspect'),
      payload: LifecycleInspectPayloadSchema,
    })
    .strict(),
  z
    .object({
      id: CommandIdSchema,
      command: z.literal('lifecycle-replay'),
      payload: LifecycleReplayPayloadSchema,
    })
    .strict(),
  z
    .object({
      id: CommandIdSchema,
      command: z.literal('lifecycle-disable'),
      payload: LifecycleDisablePayloadSchema,
    })
    .strict(),
  z
    .object({
      id: CommandIdSchema,
      command: z.literal('lifecycle-candidates'),
      payload: LifecycleCandidatesPayloadSchema,
    })
    .strict(),
  z
    .object({
      id: CommandIdSchema,
      command: z.literal('lifecycle-promote'),
      payload: LifecyclePromotePayloadSchema,
    })
    .strict(),
  z
    .object({
      id: CommandIdSchema,
      command: z.literal('lifecycle-rollback-promotion'),
      payload: LifecycleRollbackPromotionPayloadSchema,
    })
    .strict(),
]);

/** A command sent by `talonctl` to the running `talond` process. */
export type DaemonCommand = z.infer<typeof DaemonCommandSchema>;

/** Zod schema for validating serialised {@link DaemonResponse} objects. */
export const DaemonResponseSchema = z.object({
  id: z.uuid(),
  commandId: z.uuid(),
  success: z.boolean(),
  data: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Server and client re-exports
// ---------------------------------------------------------------------------

export { DaemonIpcServer } from './daemon-ipc-server.js';
export type { DaemonIpcServerOptions } from './daemon-ipc-server.js';

export { DaemonIpcClient } from './daemon-ipc-client.js';
export type { DaemonIpcClientOptions } from './daemon-ipc-client.js';
