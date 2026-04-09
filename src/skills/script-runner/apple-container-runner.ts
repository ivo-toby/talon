/**
 * AppleContainerRunner — macOS Apple Container sandbox backend for skill script execution.
 *
 * Spawns `container run --rm` with volume mounts, network isolation,
 * environment variables, and an image specification. The Apple Container
 * CLI runs a lightweight Linux VM, so volume mounts work like Docker
 * bind mounts. We still mount staged.binDir at /skill/bin and set PATH
 * there for consistency with the BubblewrapRunner.
 *
 * Resource limits are not natively supported by the container CLI in v1;
 * a debug message is logged when limits are present but cannot be enforced.
 */

import { spawn } from 'node:child_process';
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
// AppleContainerRunner
// ---------------------------------------------------------------------------

export class AppleContainerRunner implements SkillScriptRunner {
  readonly backend = 'apple-container' as const;

  constructor(
    private readonly dataDir: string,
    private readonly logger: pino.Logger,
  ) {
    this.logger.debug(
      'apple-container-runner: resource limits are not enforced — container CLI does not support them natively',
    );
  }

  async execute(input: SkillExecInput): Promise<SkillExecResult> {
    const startTime = Date.now();

    const containerArgs = this.buildContainerArgs(input);
    const timeoutMs =
      (input.timeoutSeconds ?? input.profile.timeoutSeconds) * 1000;

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
        child = spawn('container', containerArgs, {
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
          void finish('error', -1);
          return;
        }

        const exitCode = code ?? -1;
        void finish(exitCode === 0 ? 'success' : 'error', exitCode);
      });

      // Timeout enforcement: SIGTERM → grace period → SIGKILL
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
   * Build the `container run` argument array from the input.
   *
   * Order: run --rm → volumes → network → env → workdir → image → shell -c command
   */
  private buildContainerArgs(input: SkillExecInput): string[] {
    const { profile, staged, command } = input;
    const args: string[] = [];

    // -- Base command --
    args.push('run', '--rm');

    // -- Volume mounts --
    const workdirSource = this.resolveWorkdir(input);
    args.push('--volume', `${workdirSource}:/workspace`);

    // Skill bundle (read-only)
    args.push('--volume', `${input.skillDir}:/skill:ro`);

    // Curated bin directory — mount each resolved binary individually.
    // The staged binDir contains symlinks to host paths, which would be
    // broken inside the container VM. Mount each real binary directly,
    // mirroring the BubblewrapRunner approach.
    for (const [name, hostPath] of Object.entries(staged.resolvedBins)) {
      args.push('--volume', `${hostPath}:/skill/bin/${name}:ro`);
    }

    // Extra mounts from staged.canonicalMounts
    for (const mount of staged.canonicalMounts) {
      const mode = mount.mode === 'rw' ? 'rw' : 'ro';
      args.push('--volume', `${mount.source}:${mount.target}:${mode}`);
    }

    // -- Network --
    args.push('--network', profile.network === 'on' ? 'bridge' : 'none');

    // -- Environment variables --
    args.push('--env', 'HOME=/tmp');
    args.push('--env', 'PATH=/skill/bin');

    // Secrets
    for (const [key, value] of Object.entries(input.resolvedSecrets)) {
      args.push('--env', `${key}=${value}`);
    }

    // Profile env vars
    for (const [key, value] of Object.entries(profile.env)) {
      args.push('--env', `${key}=${value}`);
    }

    // -- Working directory inside the container --
    args.push('--workdir', '/workspace');

    // -- Image --
    args.push('--image', profile.image);

    // -- Shell + command --
    const shellBasename = basename(profile.shell);
    const containerShell = `/skill/bin/${shellBasename}`;
    args.push(containerShell, '-c', command);

    return args;
  }

  /**
   * Resolve the host-side path for the workdir volume mount.
   */
  private resolveWorkdir(input: SkillExecInput): string {
    const { profile, context, skillDir } = input;

    if (profile.workdir === 'repo') {
      return context.repoPath!;
    }

    if (profile.workdir === 'skill-bundle') {
      return skillDir;
    }

    // Absolute path
    return profile.workdir;
  }
}
