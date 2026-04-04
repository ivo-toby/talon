/**
 * `talonctl status` command.
 *
 * Sends a `status` command to the running talond daemon via file-based IPC,
 * polls for the response, and displays daemon health information to stdout.
 *
 * If the daemon is not running or fails to respond within the timeout,
 * a clear error message is shown.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import writeFileAtomic from 'write-file-atomic';

import type { DaemonCommand, DaemonResponse } from '../../ipc/daemon-ipc.js';
import { DaemonResponseSchema } from '../../ipc/daemon-ipc.js';
import type { DaemonStatusData } from '../cli-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default directory where the daemon reads commands. */
const DEFAULT_IPC_DIR = 'data/ipc/daemon';

/** How long (ms) to wait for a daemon response before giving up. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** Poll interval when waiting for daemon response. */
const POLL_INTERVAL_MS = 100;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes the `status` CLI command.
 *
 * Writes a status command file to the daemon input directory and polls
 * the output directory for a matching response.
 *
 * @param options.ipcDir - Override the IPC base directory (for testing).
 * @param options.timeoutMs - Response timeout in milliseconds.
 */
export async function statusCommand(options: {
  ipcDir?: string;
  timeoutMs?: number;
} = {}): Promise<void> {
  const ipcDir = options.ipcDir ?? DEFAULT_IPC_DIR;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const inputDir = path.join(ipcDir, 'input');
  const outputDir = path.join(ipcDir, 'output');

  const command: DaemonCommand = {
    id: randomUUID(),
    command: 'status',
  };

  // Write command to daemon input directory.
  const writeResult = await writeCommand(inputDir, command);
  if (!writeResult.success) {
    console.error(`Error: ${writeResult.error}`);
    console.error('Is talond running?');
    process.exit(1);
  }

  // Poll output directory for matching response.
  const response = await pollForResponse(outputDir, command.id, timeoutMs);
  if (!response) {
    console.error('Error: Daemon did not respond within timeout.');
    console.error('Is talond running?');
    process.exit(1);
    return;
  }

  if (!response.success) {
    console.error(`Error: ${response.error ?? 'Unknown daemon error'}`);
    process.exit(1);
    return;
  }

  displayStatus((response.data ?? {}) as Partial<DaemonStatusData>);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Atomically writes a DaemonCommand JSON file to the input directory.
 */
async function writeCommand(
  inputDir: string,
  command: DaemonCommand,
): Promise<{ success: boolean; error?: string }> {
  try {
    await fs.mkdir(inputDir, { recursive: true });
    const filename = `${Date.now()}-${command.id.replace(/-/g, '')}.json`;
    const filepath = path.join(inputDir, filename);
    await writeFileAtomic(filepath, JSON.stringify(command), { encoding: 'utf8' });
    return { success: true };
  } catch (cause) {
    return {
      success: false,
      error: `Failed to write command: ${String(cause)}`,
    };
  }
}

/**
 * Polls the output directory for a DaemonResponse matching `commandId`.
 *
 * Returns the response or null if the timeout is reached first.
 */
async function pollForResponse(
  outputDir: string,
  commandId: string,
  timeoutMs: number,
): Promise<DaemonResponse | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await checkOutputDir(outputDir, commandId);
    if (response) {
      return response;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return null;
}

/**
 * Scans the output directory for a response file matching `commandId`.
 * Deletes the file on successful parse.
 */
async function checkOutputDir(
  outputDir: string,
  commandId: string,
): Promise<DaemonResponse | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(outputDir);
  } catch {
    // Directory may not exist yet if daemon hasn't responded.
    return null;
  }

  for (const entry of entries.filter((e) => e.endsWith('.json')).sort()) {
    const filepath = path.join(outputDir, entry);
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
      // Skip unreadable or non-matching files.
    }
  }

  return null;
}

/**
 * Renders status data to stdout in a human-readable format.
 */
function displayStatus(data: Partial<DaemonStatusData>): void {
  const uptimeMs = data.uptimeMs ?? 0;
  const uptime = formatUptime(uptimeMs);

  console.log('talond status');
  console.log('-------------');
  console.log(`Uptime:            ${uptime}`);
  console.log(`Active containers: ${data.activeContainers ?? 'unknown'}`);
  console.log(`Queue depth:       ${data.queueDepth ?? 'unknown'}`);
  console.log(`Dead-letter items: ${data.deadLetterCount ?? 'unknown'}`);
  console.log(`Personas:          ${data.personaCount ?? 'unknown'}`);
  console.log(`Channels:          ${data.channelCount ?? 'unknown'}`);
  if (data.workflowSummary) {
    console.log(`Workflow items:    ${data.workflowSummary.totalItems}`);
    console.log(`Blocked workflows: ${data.workflowSummary.blockedItems}`);
    console.log(`Active leases:     ${data.workflowSummary.activeLeases}`);
  }

  if (data.tokenUsage24h !== undefined) {
    const { inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0, costUsd } = data.tokenUsage24h;
    const totalInput = inputTokens + cacheReadTokens + cacheWriteTokens;
    console.log(`Token usage (24h): ${totalInput} in (${inputTokens} new + ${cacheReadTokens} cache-read + ${cacheWriteTokens} cache-write) / ${outputTokens} out`);
    console.log(`Estimated cost (24h): $${costUsd.toFixed(4)}`);
  }
}

/** Formats a duration in ms into a human-readable string. */
function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(' ');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
