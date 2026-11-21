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
export type DaemonCommandType = 'status' | 'reload' | 'shutdown' | 'queue-purge' | 'a2a-cancel';

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
export const DaemonCommandSchema = z.object({
  id: z.uuid(),
  command: z.enum(['status', 'reload', 'shutdown', 'queue-purge', 'a2a-cancel']),
  payload: z.record(z.string(), z.unknown()).optional(),
});

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
