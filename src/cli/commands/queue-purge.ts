/**
 * `talonctl queue-purge` command.
 *
 * Sends a `queue-purge` command to the running talond daemon via file-based
 * IPC. Deletes queue items by status (default: pending, failed, completed).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import writeFileAtomic from 'write-file-atomic';

import type { DaemonResponse } from '../../ipc/daemon-ipc.js';
import { DaemonCommandSchema, DaemonResponseSchema } from '../../ipc/daemon-ipc.js';

const DEFAULT_IPC_DIR = 'data/ipc/daemon';
const DEFAULT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

const VALID_STATUSES = [
  'pending',
  'claimed',
  'processing',
  'completed',
  'failed',
  'dead_letter',
] as const;
type QueuePurgeStatus = (typeof VALID_STATUSES)[number];

function isQueuePurgeStatus(value: string): value is QueuePurgeStatus {
  return VALID_STATUSES.includes(value as QueuePurgeStatus);
}

export async function queuePurgeCommand(
  options: {
    ipcDir?: string;
    timeoutMs?: number;
    statuses?: string[];
    all?: boolean;
  } = {},
): Promise<void> {
  const ipcDir = options.ipcDir ?? DEFAULT_IPC_DIR;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const inputDir = path.join(ipcDir, 'input');
  const outputDir = path.join(ipcDir, 'output');

  const statuses = options.all
    ? [...VALID_STATUSES]
    : (options.statuses ?? ['pending', 'failed', 'completed']);

  // Validate provided status values.
  const invalidStatuses = statuses.filter((status) => !isQueuePurgeStatus(status));
  if (invalidStatuses.length > 0) {
    console.error(`Error: Invalid status value(s): ${invalidStatuses.join(', ')}`);
    console.error(`Valid statuses: ${VALID_STATUSES.join(', ')}`);
    process.exit(1);
    return;
  }
  const requestedStatuses = statuses.filter(isQueuePurgeStatus);

  const command = DaemonCommandSchema.parse({
    id: randomUUID(),
    command: 'queue-purge',
    payload: { statuses: requestedStatuses },
  });

  // Write command to daemon input directory.
  try {
    await fs.mkdir(inputDir, { recursive: true });
    const filename = `${Date.now()}-${command.id.replace(/-/g, '')}.json`;
    const filepath = path.join(inputDir, filename);
    await writeFileAtomic(filepath, JSON.stringify(command), { encoding: 'utf8' });
  } catch (cause) {
    console.error(`Error: Failed to write command: ${String(cause)}`);
    console.error('Is talond running?');
    process.exit(1);
    return;
  }

  console.log(`Purging queue items with statuses: ${requestedStatuses.join(', ')}...`);

  // Poll output directory for matching response.
  const deadline = Date.now() + timeoutMs;
  let response: DaemonResponse | null = null;

  while (Date.now() < deadline) {
    try {
      const entries = await fs.readdir(outputDir);
      for (const entry of entries.filter((e) => e.endsWith('.json')).sort()) {
        const filepath = path.join(outputDir, entry);
        const raw = await fs.readFile(filepath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        const validated = DaemonResponseSchema.safeParse(parsed);

        if (validated.success && validated.data.commandId === command.id) {
          await fs.unlink(filepath).catch(() => undefined);
          response = validated.data;
          break;
        }
      }
    } catch {
      // Directory may not exist yet.
    }

    if (response) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

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

  const data = response.data as { purged?: number; statuses?: string[] } | undefined;
  console.log(`Purged ${data?.purged ?? 0} queue items.`);
}
