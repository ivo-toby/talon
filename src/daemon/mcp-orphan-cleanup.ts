/**
 * Reaper for orphaned MCP subprocesses identified by the
 * `TALON_MCP_CHILD=1` env marker that every Talon provider stamps onto
 * its stdio MCP children.
 *
 * The function runs in two places:
 *
 *   1. Daemon boot — cleans up orphans left by a previous daemon
 *      process. The openai-compatible wrapper sweeps its own descendant
 *      tree on exit, but if the wrapper itself dies abruptly (e.g.
 *      SIGKILL on parent timeout) the stamped grandchildren can still
 *      reparent to PID 1 and survive across a restart.
 *
 *   2. After every queue item — closes the cross-run gap inside a
 *      single daemon session. The CLI providers (`claude`, `gemini`,
 *      `codex`) spawn MCPs as their own descendants and Talon has no
 *      per-process `finally` block to clean them up. When the CLI exits
 *      its MCP grandchildren reparent to PID 1 still holding their
 *      ports (e.g. `mcp-remote`'s OAuth callback on 8787), and the next
 *      agent run on the same persona collides. Reaping right after each
 *      run keeps that from accumulating.
 *
 * Either invocation SIGKILLs every process whose environment carries
 * the marker and whose parent is PID 1.
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
