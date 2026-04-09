import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type pino from 'pino';
import type { RunnerBackend } from './runner-types.js';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 5_000;
const MAX_VERSION_LENGTH = 120;

export interface AvailableBackend {
  backend: RunnerBackend;
  version: string;
}

interface ProbeSpec {
  backend: RunnerBackend;
  binary: string;
  args: string[];
}

const PLATFORM_PROBES: Record<string, ProbeSpec> = {
  linux: { backend: 'bubblewrap', binary: 'bwrap', args: ['--version'] },
  darwin: {
    backend: 'apple-container',
    binary: 'container',
    args: ['--help'],
  },
};

/**
 * Sanitise subprocess output before logging: take only the first line and
 * truncate to a safe length so we never write unbounded or sensitive
 * diagnostics into log files.
 */
function sanitiseVersionOutput(raw: string): string {
  const firstLine = raw.trim().split('\n')[0] || 'unknown';
  return firstLine.length > MAX_VERSION_LENGTH
    ? firstLine.slice(0, MAX_VERSION_LENGTH) + '...'
    : firstLine;
}

/**
 * Wrap execFileAsync with AbortController so that even if the child ignores
 * SIGTERM the promise settles within the timeout window.
 */
async function probeWithAbort(
  binary: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);

  try {
    const result = await execFileAsync(binary, args, {
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      signal: ac.signal,
    });
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detect which sandbox backend is available on this system.
 * Returns the first available backend, or null if none.
 *
 * On Linux: probes for `bwrap --version`
 * On macOS (darwin): probes for `container --help` (or similar)
 * On other platforms: returns null immediately
 */
export async function detectRunnerBackend(
  logger: pino.Logger,
): Promise<AvailableBackend | null> {
  const probe = PLATFORM_PROBES[process.platform];

  if (!probe) {
    logger.info(
      { platform: process.platform },
      'skill-exec: no supported platform detected',
    );
    return null;
  }

  try {
    const { stdout, stderr } = await probeWithAbort(probe.binary, probe.args);

    const version = sanitiseVersionOutput(stdout || stderr);

    logger.info(
      { backend: probe.backend, version },
      `skill-exec: detected ${probe.backend} (${version})`,
    );

    return { backend: probe.backend, version };
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;

    if (error.code === 'ENOENT' || error.code === 'EACCES') {
      logger.info(
        { binary: probe.binary, errorCode: error.code },
        `skill-exec: ${probe.binary} not found, script execution disabled`,
      );
    } else {
      logger.warn(
        { binary: probe.binary, errorCode: error.code ?? 'UNKNOWN' },
        `skill-exec: ${probe.binary} probe failed, script execution disabled`,
      );
    }

    return null;
  }
}
