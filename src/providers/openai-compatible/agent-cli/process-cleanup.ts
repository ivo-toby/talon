/**
 * Process-tree cleanup utilities for the openai-compatible wrapper.
 *
 * Background: Mastra's `MCPClient.disconnect()` ultimately calls
 * `child.kill('SIGTERM')` on the direct stdio child only. When that child is
 * an `npx` shim it spawns a `sh` shim that spawns the real MCP `node`
 * process. Killing the npx shim leaves `sh` and `node` reparented to PID 1,
 * still holding their resources (e.g. the OAuth callback port of
 * `mcp-remote`). The next wrapper run then fails to bind the port and
 * Mastra silently drops the MCP from the toolset.
 *
 * This module provides a wrapper-level safety net. Critically the API is
 * split into a *snapshot* step and a *terminate* step, so callers can
 * record the descendant tree BEFORE asking the upstream library to
 * disconnect. Otherwise the race below defeats the whole point:
 *
 *   1. snapshot → Mastra disconnect kills npx
 *   2. sh / node reparent to PID 1
 *   3. tree walk run AFTER disconnect would find nothing — the orphans are
 *      no longer descendants of the wrapper.
 *
 * See https://github.com/ivo-toby/talon/issues/210.
 */
import { execFileSync } from 'node:child_process';

export { MCP_CHILD_MARKER_ENV } from '../../mcp-child-marker.js';

export interface ProcessInfo {
  pid: number;
  ppid: number;
}

/**
 * Read the full process table as (pid, ppid) pairs.
 *
 * Uses `ps -A -o pid=,ppid=` which is supported on both Linux and macOS.
 * Returns an empty list when `ps` is unavailable or fails — callers must
 * treat cleanup as best-effort.
 */
export function readProcessTable(): ProcessInfo[] {
  let output: string;
  try {
    output = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
  } catch {
    return [];
  }

  const processes: ProcessInfo[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number.parseInt(parts[0], 10);
    const ppid = Number.parseInt(parts[1], 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    processes.push({ pid, ppid });
  }
  return processes;
}

/**
 * Collect every descendant PID of `rootPid`, given a process table.
 *
 * The root itself is excluded from the result. Walks the tree iteratively
 * (BFS) so deeply-nested chains (wrapper → npx → sh → node) are all
 * captured.
 */
export function collectDescendantPids(rootPid: number, processes: ProcessInfo[]): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const proc of processes) {
    const siblings = childrenByParent.get(proc.ppid);
    if (siblings) {
      siblings.push(proc.pid);
    } else {
      childrenByParent.set(proc.ppid, [proc.pid]);
    }
  }

  const descendants: number[] = [];
  const queue: number[] = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const children = childrenByParent.get(next);
    if (!children) continue;
    for (const child of children) {
      if (seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}

/**
 * Snapshot the descendant PIDs of `rootPid` from the live process table.
 *
 * Call this BEFORE the upstream library tears down its direct child. If
 * you snapshot afterwards, grandchildren that have already been reparented
 * to PID 1 will not appear in the tree and you will not be able to kill
 * them.
 */
export function snapshotDescendantPids(
  rootPid: number,
  readProcesses: () => ProcessInfo[] = readProcessTable,
): number[] {
  return collectDescendantPids(rootPid, readProcesses());
}

/**
 * Best-effort signal delivery. Returns true on success, false when the
 * process no longer exists or the signal could not be delivered.
 */
function trySignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the given PID is still alive.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface TerminateOptions {
  /** How long to wait after SIGTERM before escalating to SIGKILL. */
  gracePeriodMs?: number;
  /** Optional sleep override for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional liveness check override for tests. */
  isAlive?: (pid: number) => boolean;
  /** Optional signal override for tests. Should match `process.kill` semantics. */
  signal?: (pid: number, sig: NodeJS.Signals) => boolean;
  /** Optional callback invoked for each pid escalated to SIGKILL. */
  onSurvivor?: (pid: number) => void;
}

/**
 * Send SIGTERM to every pid, wait `gracePeriodMs`, then SIGKILL anything
 * still alive. Best-effort: individual signal failures are swallowed.
 *
 * Skips pids that are already dead at call time so we don't accidentally
 * race against PID reuse on busy hosts.
 *
 * @returns the pids that received at least one signal attempt.
 */
export async function terminateProcesses(
  pids: readonly number[],
  options: TerminateOptions = {},
): Promise<number[]> {
  if (pids.length === 0) return [];

  const sleep = options.sleep ?? defaultSleep;
  const aliveCheck = options.isAlive ?? isPidAlive;
  const signal = options.signal ?? trySignal;
  const gracePeriodMs = options.gracePeriodMs ?? 500;

  const targets = pids.filter((pid) => aliveCheck(pid));
  if (targets.length === 0) return [];

  for (const pid of targets) {
    signal(pid, 'SIGTERM');
  }

  await sleep(gracePeriodMs);

  for (const pid of targets) {
    if (aliveCheck(pid)) {
      options.onSurvivor?.(pid);
      signal(pid, 'SIGKILL');
    }
  }

  return targets;
}

export interface KillDescendantsOptions extends TerminateOptions {
  /** Optional injection point for tests. Defaults to `readProcessTable`. */
  readProcesses?: () => ProcessInfo[];
}

/**
 * Convenience: snapshot descendants and terminate them in one call.
 *
 * NOT appropriate when an upstream `disconnect`/`destroy` step runs
 * between the snapshot and the terminate — for that case, call
 * `snapshotDescendantPids` first, run the disconnect, then
 * `terminateProcesses` on the snapshot. See the wrapper's `finally`
 * block for the canonical example.
 *
 * @returns the PIDs we attempted to terminate (does not imply success).
 */
export async function killDescendantTree(
  rootPid: number,
  options: KillDescendantsOptions = {},
): Promise<number[]> {
  const readProcesses = options.readProcesses ?? readProcessTable;
  const descendants = snapshotDescendantPids(rootPid, readProcesses);
  return terminateProcesses(descendants, options);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

