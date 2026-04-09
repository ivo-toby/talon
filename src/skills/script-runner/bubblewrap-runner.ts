/**
 * BubblewrapRunner — Linux sandbox backend for skill script execution.
 *
 * Spawns `bwrap` with a carefully constructed argv that isolates the
 * sandboxed process: namespaces, curated PATH, secrets as env vars,
 * workdir bind-mounted, and optional network access.
 *
 * Resource limits are applied via systemd-run --scope when available.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type pino from 'pino';

import type {
  SkillScriptRunner,
  SkillExecInput,
  SkillExecResult,
} from './runner-types.js';
import { OutputCapture } from './output-capture.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STDOUT_MAX_BYTES = 65_536; // 64 KB
const STDERR_MAX_BYTES = 16_384; // 16 KB
const SIGKILL_GRACE_MS = 3_000;

// ---------------------------------------------------------------------------
// BubblewrapRunner
// ---------------------------------------------------------------------------

export class BubblewrapRunner implements SkillScriptRunner {
  readonly backend = 'bubblewrap' as const;

  private readonly hasSystemdRun: boolean;
  private readonly hasLib64: boolean;

  constructor(
    private readonly dataDir: string,
    private readonly logger: pino.Logger,
  ) {
    this.hasSystemdRun = detectSystemdRun();
    this.hasLib64 = existsSync('/lib64');

    if (!this.hasSystemdRun) {
      this.logger.debug(
        'bubblewrap-runner: systemd-run not available, resource limits will not be enforced',
      );
    }
  }

  async execute(input: SkillExecInput): Promise<SkillExecResult> {
    const startTime = Date.now();

    const bwrapArgs = this.buildBwrapArgs(input);
    const timeoutMs =
      (input.timeoutSeconds ?? input.profile.timeoutSeconds) * 1000;

    // Determine spawn binary and args — wrap with systemd-run if available
    let spawnBin: string;
    let spawnArgs: string[];

    if (this.hasSystemdRun) {
      const limits = input.profile.resourceLimits;
      spawnBin = 'systemd-run';
      spawnArgs = [
        '--scope',
        '--user',
        '--quiet',
        `--property=MemoryMax=${limits.memoryMb}M`,
        `--property=CPUQuota=${limits.cpus * 100}%`,
        `--property=TasksMax=${limits.pidsLimit}`,
        '--',
        'bwrap',
        ...bwrapArgs,
      ];
    } else {
      spawnBin = 'bwrap';
      spawnArgs = bwrapArgs;
    }

    // Artifact setup
    const threadId = input.context.threadId;
    const artifactDir = join(
      this.dataDir,
      'threads',
      threadId,
      'artifacts',
    );
    const timestamp = Date.now();
    const artifactPrefix = `${input.skillName}-${timestamp}.log`;

    const stdoutCapture = new OutputCapture(
      STDOUT_MAX_BYTES,
      artifactDir,
      `stdout-${artifactPrefix}`,
    );
    const stderrCapture = new OutputCapture(
      STDERR_MAX_BYTES,
      artifactDir,
      `stderr-${artifactPrefix}`,
    );

    return new Promise<SkillExecResult>((resolve) => {
      let child: ReturnType<typeof spawn>;

      try {
        child = spawn(spawnBin, spawnArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (spawnError: unknown) {
        const msg =
          spawnError instanceof Error
            ? spawnError.message
            : String(spawnError);
        resolve({
          status: 'error',
          exitCode: -1,
          stdout: '',
          stderr: msg,
          durationMs: Date.now() - startTime,
          truncated: false,
          artifactPath: null,
        });
        return;
      }

      let settled = false;
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = async (
        status: 'success' | 'error' | 'timeout',
        exitCode: number,
      ): Promise<void> => {
        if (settled) return;
        settled = true;

        if (killTimer) clearTimeout(killTimer);
        clearTimeout(timeoutTimer);

        const [stdoutResult, stderrResult] = await Promise.all([
          stdoutCapture.finalize(),
          stderrCapture.finalize(),
        ]);

        const truncated =
          stdoutResult.truncated || stderrResult.truncated;
        const artifactPath =
          stdoutResult.artifactPath ?? stderrResult.artifactPath ?? null;

        resolve({
          status,
          exitCode,
          stdout: stdoutResult.content,
          stderr: stderrResult.content,
          durationMs: Date.now() - startTime,
          truncated,
          artifactPath,
        });
      };

      // Wire up stdout/stderr capture
      child.stdout!.on('data', (chunk: Buffer) =>
        stdoutCapture.onData(chunk),
      );
      child.stderr!.on('data', (chunk: Buffer) =>
        stderrCapture.onData(chunk),
      );

      // Handle spawn errors (ENOENT, EPERM, etc.)
      child.on('error', (error: NodeJS.ErrnoException) => {
        stderrCapture.onData(Buffer.from(error.message));
        void finish('error', -1);
      });

      // Handle process exit
      child.on('close', (code: number | null, signal: string | null) => {
        if (timedOut) {
          void finish('timeout', code ?? -1);
          return;
        }

        if (signal !== null) {
          // Killed by signal
          void finish('error', -1);
          return;
        }

        const exitCode = code ?? -1;
        void finish(exitCode === 0 ? 'success' : 'error', exitCode);
      });

      // Timeout enforcement.
      // When systemd-run --scope wraps bwrap, killing systemd-run terminates
      // the scope, which cleans up all processes in its cgroup. Additionally,
      // bwrap's --die-with-parent ensures it dies when its parent exits.
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // Process may have already exited
        }

        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Process may have already exited
          }
        }, SIGKILL_GRACE_MS);
      }, timeoutMs);
    });
  }

  // -------------------------------------------------------------------------
  // Argv construction
  // -------------------------------------------------------------------------

  /**
   * Build the bwrap argument array from the input.
   *
   * The order follows the spec template exactly:
   * isolation → filesystem → env → chdir → shell -c command
   */
  private buildBwrapArgs(input: SkillExecInput): string[] {
    const { profile, staged, command } = input;
    const args: string[] = [];

    // -- Isolation flags --
    args.push('--die-with-parent');
    args.push('--unshare-all');

    if (profile.network === 'on') {
      args.push('--share-net');
    }

    args.push('--new-session');

    // -- Kernel pseudo-filesystems & tmpfs --
    args.push('--proc', '/proc');
    args.push('--dev', '/dev');
    args.push('--tmpfs', '/tmp');
    args.push('--tmpfs', '/run');

    // -- DNS (only when network is on) --
    if (profile.network === 'on') {
      args.push('--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf');
    }

    // -- Shared libraries for dynamically-linked binaries --
    args.push('--ro-bind', '/usr/lib', '/usr/lib');
    args.push('--ro-bind', '/lib', '/lib');

    if (this.hasLib64) {
      args.push('--ro-bind', '/lib64', '/lib64');
    }

    // -- Workdir bind --
    const workdirSource = this.resolveWorkdir(input);
    args.push('--bind', workdirSource, '/workspace');

    // -- Skill bundle (read-only) --
    args.push('--ro-bind', input.skillDir, '/skill');

    // -- Curated bin directory --
    // Use a tmpfs overlay at /skill/bin, then bind each resolved binary
    // individually. Symlinks from the staged binDir don't work inside the
    // sandbox because their targets (e.g. /usr/bin/bash) are not mounted.
    args.push('--tmpfs', '/skill/bin');
    for (const [name, hostPath] of Object.entries(staged.resolvedBins)) {
      args.push('--ro-bind', hostPath, `/skill/bin/${name}`);
    }

    // -- Extra mounts from staged.canonicalMounts --
    for (const mount of staged.canonicalMounts) {
      const flag = mount.mode === 'rw' ? '--bind' : '--ro-bind';
      args.push(flag, mount.source, mount.target);
    }

    // -- Environment variables --
    args.push('--setenv', 'HOME', '/tmp');
    args.push('--setenv', 'PATH', '/skill/bin');

    // Secrets
    for (const [key, value] of Object.entries(input.resolvedSecrets)) {
      args.push('--setenv', key, value);
    }

    // Profile env vars
    for (const [key, value] of Object.entries(profile.env)) {
      args.push('--setenv', key, value);
    }

    // -- Working directory inside the sandbox --
    args.push('--chdir', '/workspace');

    // -- Shell + command --
    const shellBasename = basename(profile.shell);
    // The shell binary is referenced via its sandbox path in /skill/bin
    const sandboxShell = `/skill/bin/${shellBasename}`;
    args.push(sandboxShell, '-c', command);

    return args;
  }

  /**
   * Resolve the host-side path for the workdir bind mount.
   */
  private resolveWorkdir(input: SkillExecInput): string {
    const { profile, context, skillDir } = input;

    if (profile.workdir === 'repo') {
      // Upstream validation guarantees repoPath is non-null when workdir === 'repo'
      return context.repoPath!;
    }

    if (profile.workdir === 'skill-bundle') {
      return skillDir;
    }

    // Absolute path — use directly
    return profile.workdir;
  }
}

// ---------------------------------------------------------------------------
// systemd-run detection (cached at module level per runner instance)
// ---------------------------------------------------------------------------

function detectSystemdRun(): boolean {
  try {
    execFileSync('systemd-run', ['--version'], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}
