/**
 * Daemon-boot defensive cleanup for orphaned MCP subprocesses.
 *
 * The openai-compatible wrapper stamps `TALON_MCP_CHILD=1` on every stdio
 * MCP child it spawns and sweeps its descendant tree on exit. That covers
 * the normal exit path, but if the wrapper itself dies abruptly (e.g.
 * SIGKILL on a parent timeout), the stamped grandchildren can still
 * reparent to PID 1 and survive across daemon restarts.
 *
 * This module runs once at daemon boot and SIGKILLs any process whose
 * environment carries the marker and whose parent is PID 1. It is a
 * defensive net for past leaks only — the normal exit path is the
 * primary fix (see openai-compatible/agent-cli/process-cleanup.ts).
 *
 * Linux is the supported scanning target (uses `/proc/<pid>/environ`,
 * `/proc/<pid>/stat`). On other platforms the function is a no-op since
 * the process environment of an arbitrary PID is not portably readable.
 *
 * See https://github.com/ivo-toby/talon/issues/210.
 */
import { readFileSync, readdirSync } from 'node:fs';
import type { Logger } from 'pino';
import { MCP_CHILD_MARKER_ENV } from '../providers/mcp-child-marker.js';

export interface OrphanCleanupResult {
  scanned: number;
  candidates: number[];
  killed: number[];
}

export interface OrphanCleanupOptions {
  /** Override for tests. Defaults to scanning `/proc` on Linux. */
  findCandidates?: () => number[];
  /** Override for tests. Defaults to `process.kill`. */
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
}

/**
 * Scan for orphaned MCP subprocesses and SIGKILL them.
 *
 * No-op on non-Linux platforms. Errors from individual /proc reads are
 * swallowed — entries disappear as processes exit, which is expected.
 */
export function cleanupOrphanedMcpChildren(
  logger: Logger,
  options: OrphanCleanupOptions = {},
): OrphanCleanupResult {
  if (process.platform !== 'linux') {
    return { scanned: 0, candidates: [], killed: [] };
  }

  const findCandidates = options.findCandidates ?? findOrphanedMarkedPids;
  const kill =
    options.kill
    ?? ((pid: number, signal: NodeJS.Signals): boolean => {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    });

  let candidates: number[];
  try {
    candidates = findCandidates();
  } catch (cause) {
    logger.warn({ cause }, 'mcp-orphan-cleanup: scan failed, skipping');
    return { scanned: 0, candidates: [], killed: [] };
  }

  const killed: number[] = [];
  for (const pid of candidates) {
    if (kill(pid, 'SIGKILL')) {
      killed.push(pid);
    }
  }

  if (killed.length > 0) {
    logger.warn(
      { killed },
      'mcp-orphan-cleanup: killed orphaned MCP subprocesses left over from a previous run',
    );
  } else {
    logger.debug({ candidates }, 'mcp-orphan-cleanup: no orphans found');
  }

  return { scanned: candidates.length, candidates, killed };
}

/**
 * Walk /proc for processes that (a) are reparented to PID 1 and (b) have
 * the MCP marker env var set. Returns the matching PIDs.
 */
function findOrphanedMarkedPids(): number[] {
  const orphaned: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return orphaned;
  }

  const selfPid = process.pid;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    if (pid === selfPid || pid === 1) continue;

    const ppid = readPpid(pid);
    if (ppid !== 1) continue;

    if (!hasMarkerEnv(pid)) continue;

    orphaned.push(pid);
  }
  return orphaned;
}

function readPpid(pid: number): number | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }
  // /proc/<pid>/stat format: pid (comm) state ppid ...
  // The `comm` field may contain spaces/parens; locate the LAST ')' so we
  // parse the fields that follow it reliably.
  const close = stat.lastIndexOf(')');
  if (close < 0) return undefined;
  const fields = stat.slice(close + 2).split(' ');
  if (fields.length < 2) return undefined;
  const ppid = Number.parseInt(fields[1], 10);
  return Number.isInteger(ppid) ? ppid : undefined;
}

function hasMarkerEnv(pid: number): boolean {
  let raw: Buffer;
  try {
    raw = readFileSync(`/proc/${pid}/environ`);
  } catch {
    return false;
  }
  const needle = `${MCP_CHILD_MARKER_ENV}=`;
  for (const entry of raw.toString('utf8').split('\0')) {
    if (entry.startsWith(needle)) return true;
  }
  return false;
}
