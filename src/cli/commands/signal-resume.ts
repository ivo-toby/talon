import path from 'node:path';
import { err, type Result } from '../../core/types/result.js';
import { DaemonIpcClient } from '../../ipc/daemon-ipc-client.js';
import { SignalManagementError } from '../../ipc/daemon-ipc.js';
import type { SignalResumeData } from '../../ipc/daemon-ipc.js';

export interface SignalResumeOptions {
  channel?: unknown;
  externalChallengeResolved?: unknown;
  ipcDir?: string;
  timeoutMs?: number;
}

/** Local operator command only. TASK-012 authenticates/dispatches; no network or
 * pause mutation here. Timeout/refusal never automatically reasserts authority. */
export async function signalResume(
  options: SignalResumeOptions,
): Promise<Result<SignalResumeData, SignalManagementError>> {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    return err(new SignalManagementError('INVALID_REQUEST'));
  const ipcDir = options.ipcDir ?? 'data/ipc/daemon';
  const client = new DaemonIpcClient({
    inputDir: path.join(ipcDir, 'input'), outputDir: path.join(ipcDir, 'output'), timeoutMs,
  });
  return client.signalResume({
    channel: options.channel, externalChallengeResolved: options.externalChallengeResolved,
  });
}

export async function signalResumeCommand(options: SignalResumeOptions): Promise<void> {
  const result = await signalResume(options);
  if (result.isErr()) {
    console.error(`Signal resume unavailable: ${result.error.reason}. No automatic retry; inspect local status.`);
    process.exit(1);
    return;
  }
  if (result.value.outcome !== 'verified') {
    console.error(`Signal resume ${result.value.outcome}: ${result.value.reason}. No automatic retry; inspect local status.`);
    process.exit(1);
    return;
  }
  console.log('Signal challenge clearance verified by daemon. No message sent or replayed by this command.');
}
