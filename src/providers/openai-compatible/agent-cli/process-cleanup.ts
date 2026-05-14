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
 * This module provides a wrapper-level safety net that walks the wrapper's
 * descendant process tree at teardown and signals every surviving descendant
 * directly, regardless of what the upstream library did.
 *
 * See https://github.com/ivo-toby/talon/issues/210.
 */
import { execFileSync } from 'node:child_process';

/** Env marker stamped on every stdio MCP child spawned by the wrapper. */
export const MCP_CHILD_MARKER_ENV = 'TALON_MCP_CHILD';

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

export interface KillDescendantsOptions {
  /** How long to wait after SIGTERM before escalating to SIGKILL. */
  gracePeriodMs?: number;
  /**
   * Optional injection point for tests. Defaults to `readProcessTable`.
   */
  readProcesses?: () => ProcessInfo[];
  /** Optional sleep override for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional liveness check override for tests. */
  isAlive?: (pid: number) => boolean;
  /** Optional signal override for tests. Should match `process.kill` semantics. */
  signal?: (pid: number, sig: NodeJS.Signals) => boolean;
  /** Optional callback for diagnostic logging. */
  onSurvivor?: (pid: number) => void;
}

/**
 * Walk the wrapper's descendant process tree and signal every survivor.
 *
 * Sends SIGTERM first so processes get a chance to clean up (close ports,
 * release sockets), then escalates to SIGKILL after `gracePeriodMs`. The
 * function is best-effort: errors from individual `process.kill` calls are
 * swallowed since the target may legitimately be gone by the time the
 * signal lands.
 *
 * @returns the PIDs we attempted to terminate (does not imply success).
 */
export async function killDescendantTree(
  rootPid: number,
  options: KillDescendantsOptions = {},
): Promise<number[]> {
  const readProcesses = options.readProcesses ?? readProcessTable;
  const sleep = options.sleep ?? defaultSleep;
  const aliveCheck = options.isAlive ?? isPidAlive;
  const signal = options.signal ?? trySignal;
  const gracePeriodMs = options.gracePeriodMs ?? 500;

  const processes = readProcesses();
  const descendants = collectDescendantPids(rootPid, processes);
  if (descendants.length === 0) return [];

  for (const pid of descendants) {
    signal(pid, 'SIGTERM');
  }

  await sleep(gracePeriodMs);

  for (const pid of descendants) {
    if (aliveCheck(pid)) {
      options.onSurvivor?.(pid);
      signal(pid, 'SIGKILL');
    }
  }

  return descendants;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
