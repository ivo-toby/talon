import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import { ExecutionBrokerError } from './errors.js';
import type {
  BackendCapabilities,
  BackendExecRequest,
  BackendExecSession,
  BackendStreamExecRequest,
  ContainerBackend,
  ContainerSpec,
  RawExecOutput,
} from './types.js';

/** Recorded exec call: identity and shape only — no signal, no output. */
export interface InMemoryExecCall {
  containerId: string;
  argv: string[];
  cwd: string;
}

/** What the exec handler receives: the recorded call plus the request's abort signal. */
export interface InMemoryExecCallInput extends InMemoryExecCall {
  signal: AbortSignal;
}

export type InMemoryExecHandler = (call: InMemoryExecCallInput) => Promise<RawExecOutput>;

/** What the stream handler receives: the recorded call, the abort signal and the stream hooks. */
export interface InMemoryExecStreamCall extends InMemoryExecCallInput {
  emitStdout(text: string): void;
  /** Called for every text written to the session's stdin, in order. */
  onStdin(listener: (text: string) => void): void;
  /** Called one time when the session's stdin is closed. */
  onStdinEnd(listener: () => void): void;
}

export type InMemoryExecStreamHandler = (
  call: InMemoryExecStreamCall,
) => Promise<{ exitCode: number; stderr: string }>;

export interface InMemoryContainerBackendOptions {
  /** Reported by capabilities(); drives the QUOTA_UNENFORCEABLE guard upstream. */
  diskQuotaEnforced?: boolean;
  /** Force every createContainer to fail with BACKEND_FAILURE. */
  failCreate?: boolean;
}

/**
 * Deterministic in-memory ContainerBackend. No Docker, network, or filesystem
 * access: containers are synthetic records and exec is delegated to a
 * replaceable handler, so cancel-while-running and timeout tests stay
 * deterministic.
 */
export class InMemoryContainerBackend implements ContainerBackend {
  createdCount = 0;
  execCalls: InMemoryExecCall[] = [];
  removeCalls: string[] = [];

  private readonly diskQuotaEnforced: boolean;
  private readonly failCreate: boolean;
  /** Live container IDs in creation (insertion) order. */
  private readonly live: Set<string> = new Set();
  private containerNumber = 0;
  private execHandler: InMemoryExecHandler = () =>
    Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });

  private execStreamHandler: InMemoryExecStreamHandler = () =>
    Promise.resolve({ exitCode: 0, stderr: '' });

  constructor(opts: InMemoryContainerBackendOptions = {}) {
    this.diskQuotaEnforced = opts.diskQuotaEnforced ?? false;
    this.failCreate = opts.failCreate ?? false;
  }

  capabilities(): BackendCapabilities {
    return { diskQuotaEnforced: this.diskQuotaEnforced };
  }

  liveContainers(): string[] {
    return [...this.live];
  }

  setExecStreamHandler(handler: InMemoryExecStreamHandler): void {
    this.execStreamHandler = handler;
  }

  setExecHandler(handler: InMemoryExecHandler): void {
    this.execHandler = handler;
  }

  createContainer(
    _spec: ContainerSpec,
  ): Promise<Result<{ containerId: string }, ExecutionBrokerError>> {
    if (this.failCreate) {
      return Promise.resolve(
        err(new ExecutionBrokerError('BACKEND_FAILURE', 'container creation failed')),
      );
    }
    const containerId = `mem-${++this.containerNumber}`;
    this.createdCount += 1;
    this.live.add(containerId);
    return Promise.resolve(ok({ containerId }));
  }

  async exec(
    containerId: string,
    request: BackendExecRequest,
  ): Promise<Result<RawExecOutput, ExecutionBrokerError>> {
    if (!this.live.has(containerId)) {
      // Fail closed: an exec on an unknown container is never recorded.
      return err(new ExecutionBrokerError('BACKEND_FAILURE', 'unknown container'));
    }
    this.execCalls.push({ containerId, argv: request.argv, cwd: request.cwd });
    try {
      const output = await this.execHandler({
        containerId,
        argv: request.argv,
        cwd: request.cwd,
        signal: request.signal,
      });
      return ok(output);
    } catch (error) {
      // Constraint: handler messages must not leak into broker error messages.
      const cause = error instanceof Error ? error : new Error('unknown exec failure');
      return err(
        new ExecutionBrokerError('BACKEND_FAILURE', 'in-memory exec handler failed', cause),
      );
    }
  }

  execStream(
    containerId: string,
    request: BackendStreamExecRequest,
  ): Promise<Result<BackendExecSession, ExecutionBrokerError>> {
    if (!this.live.has(containerId)) {
      return Promise.resolve(err(new ExecutionBrokerError('BACKEND_FAILURE', 'unknown container')));
    }
    this.execCalls.push({ containerId, argv: request.argv, cwd: request.cwd });

    const stdinListeners: ((text: string) => void)[] = [];
    const endListeners: (() => void)[] = [];
    let stdinEnded = false;
    let finished = false;

    let handled: Promise<{ exitCode: number; stderr: string }>;
    try {
      handled = this.execStreamHandler({
        containerId,
        argv: request.argv,
        cwd: request.cwd,
        signal: request.signal,
        emitStdout: (text) => {
          if (!finished) {
            request.onStdout(text);
          }
        },
        onStdin: (listener) => {
          stdinListeners.push(listener);
        },
        onStdinEnd: (listener) => {
          if (stdinEnded) {
            listener();
          } else {
            endListeners.push(listener);
          }
        },
      });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error('unknown exec failure');
      return Promise.resolve(
        err(new ExecutionBrokerError('BACKEND_FAILURE', 'in-memory exec handler failed', cause)),
      );
    }
    const done = handled.then(
      (output): Result<{ exitCode: number; stderr: string }, ExecutionBrokerError> => {
        finished = true;
        return ok({ exitCode: output.exitCode, stderr: output.stderr.slice(0, 65_536) });
      },
      (error: unknown): Result<{ exitCode: number; stderr: string }, ExecutionBrokerError> => {
        finished = true;
        // Constraint: handler messages must not leak into broker error messages.
        const cause = error instanceof Error ? error : new Error('unknown exec failure');
        return err(
          new ExecutionBrokerError('BACKEND_FAILURE', 'in-memory exec handler failed', cause),
        );
      },
    );

    return Promise.resolve(
      ok({
        writeStdin: (text: string): void => {
          if (finished || stdinEnded) {
            return;
          }
          for (const listener of stdinListeners) {
            listener(text);
          }
        },
        endStdin: (): void => {
          if (finished || stdinEnded) {
            return;
          }
          stdinEnded = true;
          for (const listener of endListeners) {
            listener();
          }
        },
        done,
      }),
    );
  }

  removeContainer(containerId: string): Promise<Result<void, ExecutionBrokerError>> {
    // Idempotent by design: every removal is recorded and always ok.
    this.removeCalls.push(containerId);
    this.live.delete(containerId);
    return Promise.resolve(ok(undefined));
  }
}
