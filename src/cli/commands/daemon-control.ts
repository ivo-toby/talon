import path from 'node:path';

import { DaemonIpcClient } from '../../ipc/daemon-ipc-client.js';
import type { DaemonCommandType, DaemonResponse } from '../../ipc/daemon-ipc.js';

const DEFAULT_IPC_DIR = 'data/ipc/daemon';
const DEFAULT_TIMEOUT_MS = 5_000;

export interface DaemonControlOptions {
  readonly ipcDir?: string;
  readonly timeoutMs?: number;
}

export async function sendDaemonControlCommand(
  command: DaemonCommandType,
  payload?: Record<string, unknown>,
  options: DaemonControlOptions = {},
): Promise<DaemonResponse | null> {
  const ipcDir = options.ipcDir ?? DEFAULT_IPC_DIR;
  const client = new DaemonIpcClient({
    inputDir: path.join(ipcDir, 'input'),
    outputDir: path.join(ipcDir, 'output'),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  return client.sendCommand(command, payload);
}
