import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import { ExecutionBrokerError } from './errors.js';
import type {
  BackendCapabilities,
  BackendExecRequest,
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

  removeContainer(containerId: string): Promise<Result<void, ExecutionBrokerError>> {
    // Idempotent by design: every removal is recorded and always ok.
    this.removeCalls.push(containerId);
    this.live.delete(containerId);
    return Promise.resolve(ok(undefined));
  }
}
