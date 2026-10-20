import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { err, ok, type Result } from 'neverthrow';
import { BackgroundAgentError } from '../../core/errors/error-types.js';

export interface BackgroundAgentProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  env?: Record<string, string>;
  /** When false, spawn with `env` only instead of merging it over `process.env`. */
  inheritEnv?: boolean;
  timeoutMs: number;
}

export interface BackgroundAgentProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface StartedBackgroundAgentProcess {
  pid: number | null;
  completion: Promise<Result<BackgroundAgentProcessResult, BackgroundAgentError>>;
}

const MAX_OUTPUT_BYTES = 100 * 1024;

export class BackgroundAgentProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private completion: Promise<Result<BackgroundAgentProcessResult, BackgroundAgentError>> | null = null;

  constructor(private readonly options: BackgroundAgentProcessOptions) {}

  start(): Result<StartedBackgroundAgentProcess, BackgroundAgentError> {
    if (this.child || this.completion) {
      return err(new BackgroundAgentError('Background agent process has already been started'));
    }

    try {
      const child = spawn(this.options.command, this.options.args, {
        cwd: this.options.cwd,
        env:
          this.options.inheritEnv === false
            ? { ...(this.options.env ?? {}) }
            : {
                ...process.env,
                ...(this.options.env ?? {}),
              },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;

      let timedOut = false;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;

      const completion = new Promise<Result<BackgroundAgentProcessResult, BackgroundAgentError>>(
        (resolve) => {
          const timeout = setTimeout(() => {
            timedOut = true;
            this.kill();
          }, this.options.timeoutMs);

          child.stdout.on('data', (chunk: Buffer) => {
            if (stdoutBytes >= MAX_OUTPUT_BYTES) {
              return;
            }
            stdoutChunks.push(chunk);
            stdoutBytes += chunk.length;
          });

          child.stderr.on('data', (chunk: Buffer) => {
            if (stderrBytes >= MAX_OUTPUT_BYTES) {
              return;
            }
            stderrChunks.push(chunk);
            stderrBytes += chunk.length;
          });

          child.on('error', (cause) => {
            clearTimeout(timeout);
            resolve(
              err(
                new BackgroundAgentError(
                  `Failed to run background agent process: ${cause.message}`,
                  cause,
                ),
              ),
            );
          });

          child.on('close', (exitCode, signal) => {
            clearTimeout(timeout);
            resolve(
              ok({
                stdout: Buffer.concat(stdoutChunks).toString('utf8').slice(0, MAX_OUTPUT_BYTES),
                stderr: Buffer.concat(stderrChunks).toString('utf8').slice(0, MAX_OUTPUT_BYTES),
                exitCode,
                signal,
                timedOut,
              }),
            );
          });
        },
      );

      child.stdin.on('error', () => {
        // Best-effort stdin delivery: short-lived commands can exit before
        // stdin closes, which is acceptable for this wrapper.
      });
      child.stdin.end(this.options.stdin);
      this.completion = completion;

      return ok({
        pid: child.pid ?? null,
        completion,
      });
    } catch (cause) {
      return err(
        new BackgroundAgentError(
          `Failed to spawn background agent process: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.child && !this.child.killed) {
      this.child.kill(signal);
    }
  }
}
