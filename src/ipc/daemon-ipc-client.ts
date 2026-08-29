/**
 * Daemon IPC client — used by `talonctl`.
 *
 * Provides a convenient class-based interface for sending DaemonCommand files
 * and polling for DaemonResponse files, following the same file-based IPC
 * transport used throughout the daemon.
 */

import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import writeFileAtomic from 'write-file-atomic';

import { DaemonCommandSchema, DaemonResponseSchema } from './daemon-ipc.js';
import type { DaemonCommand, DaemonCommandType, DaemonResponse } from './daemon-ipc.js';
import { ensureOwnerOnlyDir } from '../core/fs/private-paths.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Configuration for {@link DaemonIpcClient}. */
export interface DaemonIpcClientOptions {
  /** Directory the daemon reads commands from (client writes here). */
  inputDir: string;
  /** Directory the daemon writes responses to (client reads from here). */
  outputDir: string;
  /** How long (ms) to wait for a response before returning null. Default: 5000. */
  timeoutMs?: number;
  /** How often (ms) to poll `outputDir` for a matching response. Default: 100. */
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// DaemonIpcClient
// ---------------------------------------------------------------------------

/**
 * Client-side daemon IPC component.
 *
 * Writes a {@link DaemonCommand} atomically to `inputDir` and polls
 * `outputDir` for a matching {@link DaemonResponse} (matched by `commandId`).
 *
 * Returns `null` if no response is received within the timeout window.
 *
 * @example
 * ```ts
 * const client = new DaemonIpcClient({
 *   inputDir: 'data/ipc/daemon/input',
 *   outputDir: 'data/ipc/daemon/output',
 * });
 * const response = await client.sendCommand('status');
 * if (response?.success) {
 *   console.log(response.data);
 * }
 * ```
 */
export class DaemonIpcClient {
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly opts: DaemonIpcClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 100;
  }

  /**
   * Builds a {@link DaemonCommand} with a freshly generated UUID and sends it.
   *
   * Convenience wrapper around {@link send} that removes the need for callers
   * to construct the full command object.
   *
   * @param type    - The command type to execute.
   * @param payload - Optional command-specific parameters.
   * @returns The matching DaemonResponse, or `null` on timeout.
   */
  async sendCommand(
    type: DaemonCommandType,
    payload?: Record<string, unknown>,
  ): Promise<DaemonResponse | null> {
    const command = DaemonCommandSchema.parse({
      id: randomUUID(),
      command: type,
      ...(payload !== undefined ? { payload } : {}),
    });
    return this.send(command);
  }

  /**
   * Writes `command` atomically to `inputDir`, then polls `outputDir` for a
   * {@link DaemonResponse} whose `commandId` matches `command.id`.
   *
   * The response file is deleted after reading.
   *
   * @param command - The command to send.
   * @returns The matching DaemonResponse, or `null` if the timeout elapses
   *          without a valid matching response appearing.
   */
  async send(command: DaemonCommand): Promise<DaemonResponse | null> {
    // --- Write command ---
    try {
      await ensureOwnerOnlyDir(this.opts.inputDir);
      const paddedTs = String(Date.now()).padStart(15, '0');
      const cleanId = command.id.replace(/-/g, '');
      const filename = `${paddedTs}-${cleanId}.json`;
      const filepath = path.join(this.opts.inputDir, filename);
      await writeFileAtomic(filepath, JSON.stringify(command), { encoding: 'utf8' });
    } catch (cause) {
      throw new Error(`DaemonIpcClient: failed to write command: ${String(cause)}`);
    }

    // --- Poll for response ---
    const deadline = Date.now() + this.timeoutMs;

    while (Date.now() < deadline) {
      const response = await this.checkOutputDir(command.id);
      if (response !== null) {
        return response;
      }
      await sleep(this.pollIntervalMs);
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Scans `outputDir` for a DaemonResponse file whose `commandId` matches.
   *
   * Deletes the matching file after reading so it is not returned twice.
   *
   * @returns The validated response, or `null` if not found.
   */
  private async checkOutputDir(commandId: string): Promise<DaemonResponse | null> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.opts.outputDir);
    } catch {
      // Directory may not exist yet if the daemon hasn't responded.
      return null;
    }

    for (const entry of entries.filter((e) => e.endsWith('.json')).sort()) {
      const filepath = path.join(this.opts.outputDir, entry);
      try {
        const raw = await fs.readFile(filepath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        const validated = DaemonResponseSchema.safeParse(parsed);

        if (validated.success && validated.data.commandId === commandId) {
          // Clean up the response file.
          await fs.unlink(filepath).catch(() => undefined);
          return validated.data;
        }
      } catch {
        // Skip unreadable or non-matching files — try the next one.
      }
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
