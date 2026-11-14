/**
 * `talonctl reload` command.
 *
 * Sends a `reload` command to the running talond daemon via file-based IPC
 * and polls for the response, then displays what was reloaded.
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
import type { DaemonReloadData } from '../cli-types.js';

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
 * Executes the `reload` CLI command.
 *
 * Writes a reload command file to the daemon input directory and polls
 * the output directory for a matching response.
 *
 * @param options.ipcDir - Override the IPC base directory (for testing).
 * @param options.timeoutMs - Response timeout in milliseconds.
 */
export async function reloadCommand(options: {
  ipcDir?: string;
  timeoutMs?: number;
} = {}): Promise<void> {
  const ipcDir = options.ipcDir ?? DEFAULT_IPC_DIR;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const inputDir = path.join(ipcDir, 'input');
  const outputDir = path.join(ipcDir, 'output');

  const command: DaemonCommand = {
    id: randomUUID(),
    command: 'reload',
  };

  // Write command to daemon input directory.
  const writeResult = await writeCommand(inputDir, command);
  if (!writeResult.success) {
    console.error(`Error: ${writeResult.error}`);
    console.error('Is talond running?');
    process.exit(1);
    return;
  }

  console.log('Reload signal sent. Waiting for daemon response...');

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

  displayReloadResult((response.data ?? {}));
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
 * Renders reload result to stdout.
 */
function displayReloadResult(data: Partial<DaemonReloadData>): void {
  console.log('Reload completed successfully.');
  console.log(`  Config reloaded:   ${data.configReloaded ? 'yes' : 'no'}`);
  console.log(`  Personas reloaded: ${data.personasReloaded ? 'yes' : 'no'}`);
  console.log(`  Channels reloaded: ${data.channelsReloaded ? 'yes' : 'no'}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
