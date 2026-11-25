import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import {
  checkArgvBounds,
  findGrant,
  parseCreateLeaseInput,
  parseExecuteInput,
} from './allowlist.js';
import { ExecutionBrokerError } from './errors.js';
import { LeaseStore } from './lease.js';
import { resolveWorkspaceCwd } from './path-validation.js';
import type {
  BackendExecSession,
  ContainerBackend,
  ExecutionResult,
  OperatorAllowlist,
  ProfileConfig,
  StreamExecution,
  WorkspaceConfig,
} from './types.js';

/**
 * One reserved per-lease exec slot. `settle` is a settle-once latch: the
 * first caller wins, the timer (if any) is cleared, and the slot is released
 * from `LeaseState.inFlight`. `controller` aborts the backend exec on timeout
 * or revoke.
 */
interface PendingExec {
  controller: AbortController;
  settle: (r: Result<ExecutionResult, ExecutionBrokerError>) => void;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

type EndLease = (result: Result<ExecutionResult, ExecutionBrokerError>) => Promise<void>;

/** A request that passed validation and holds a reserved slot and a container. */
interface Admitted {
  leaseId: string;
  state: LeaseState;
  pending: PendingExec;
  containerId: string;
  argv: string[];
  /** Container-side absolute path. */
  cwd: string;
  timeoutMs: number;
}

/**
 * Per-lease runtime state that the immutable LeaseRecord does not carry.
 * `containerId` is created lazily on the first execute and cleared on revoke.
 * `inFlight` holds reserved exec slots: one exists from the synchronous
 * reservation in execute until its settle latch fires exactly once.
 * `creating` is the single-flight container-creation promise: the first
 * execute starts it, concurrent executes await the same promise so only
 * one container is created per lease.
 */
interface LeaseState {
  profile: ProfileConfig;
  workspace: WorkspaceConfig;
  containerId: string | null;
  inFlight: Set<PendingExec>;
  creating: Promise<Result<{ containerId: string }, ExecutionBrokerError>> | null;
}

/**
 * Execution-broker core: createLease -> execute -> revoke.
 *
 * Constraints:
 * - Validation happens before any backend mutation; error details never echo
 *   lease IDs, argv elements, or command output.
 * - A failed createContainer makes the lease terminal (revoked, fail-closed).
 * - Each execute reserves one per-lease exec slot synchronously (before the
 *   first await) and releases it exactly once through the settle latch.
 * - Container creation is single-flight: concurrent first-executes share one
 *   createContainer promise so only one container is created per lease.
 * - Timeout, exec backend failure, and revoke are terminal: sibling in-flight
 *   execs are aborted and settled as cancelled, the container is removed, and
 *   the lease is revoked before the triggering execute promise settles.
 * - backend.exec stays isolated in runExec, where the exec result, the exec
 *   error, and the timeout timer race through one settle-once latch.
 */
export class ExecutionBroker {
  private readonly opts: { allowlist: OperatorAllowlist; backend: ContainerBackend };
  private readonly store = new LeaseStore();
  private readonly leases = new Map<string, LeaseState>();

  constructor(opts: { allowlist: OperatorAllowlist; backend: ContainerBackend }) {
    this.opts = opts;
  }

  /**
   * Synchronous core behind the Promise contract: parse, grant, quota guard,
   * active-lease bound, opaque lease ID. No backend call and no await, so the
   * method is deliberately not async (require-await).
   */
  createLease(input: unknown): Promise<Result<{ leaseId: string }, ExecutionBrokerError>> {
    const parsed = parseCreateLeaseInput(input);
    if (parsed.isErr()) {
      return Promise.resolve(err(parsed.error));
    }
    const { taskId, personaId } = parsed.value;
    const grant = findGrant(this.opts.allowlist, parsed.value);
    if (grant.isErr()) {
      return Promise.resolve(err(grant.error));
    }
    const { profile, workspace } = grant.value;
    const diskQuotaEnforced = this.opts.backend.capabilities().diskQuotaEnforced;
    if (workspace.mode === 'rw' && !diskQuotaEnforced) {
      return Promise.resolve(
        err(
          new ExecutionBrokerError(
            'QUOTA_UNENFORCEABLE',
            'the backend cannot enforce a disk quota for a read-write workspace',
          ),
        ),
      );
    }
    if (this.store.activeCount(profile.id) >= profile.maxActiveLeases) {
      return Promise.resolve(
        err(
          new ExecutionBrokerError(
            'CONCURRENCY_LIMIT',
            'the profile has reached its active-lease limit',
          ),
        ),
      );
    }
    const leaseId = this.store.create({
      taskId,
      personaId,
      profile: profile.id,
      workspace: workspace.id,
    });
    this.leases.set(leaseId, {
      profile,
      workspace,
      containerId: null,
      inFlight: new Set(),
      creating: null,
    });
    return Promise.resolve(ok({ leaseId }));
  }

  async execute(input: unknown): Promise<Result<ExecutionResult, ExecutionBrokerError>> {
    const admitted = await this.admit(input);
    if (admitted.isErr()) {
      return err(admitted.error);
    }
    const { leaseId, state, pending, containerId, argv, cwd, timeoutMs } = admitted.value;
    return await this.runExec(leaseId, state, pending, containerId, argv, cwd, timeoutMs);
  }

  /**
   * Same rules as execute, for a long-lived exec whose stdin and stdout the
   * caller drives. Validation, admission and the settle-once latch are shared
   * with execute (admit / armExec). Resolves with err for every admission error
   * and for a backend that refuses to start the stream; everything after the
   * session exists is reported through StreamExecution.result.
   */
  async executeStream(
    input: unknown,
    handlers: { onStdout(text: string): void },
  ): Promise<Result<StreamExecution, ExecutionBrokerError>> {
    const admitted = await this.admit(input);
    if (admitted.isErr()) {
      return err(admitted.error);
    }
    const { leaseId, state, pending, containerId, argv, cwd, timeoutMs } = admitted.value;
    let endLease!: (r: Result<ExecutionResult, ExecutionBrokerError>) => Promise<void>;
    const result = new Promise<Result<ExecutionResult, ExecutionBrokerError>>((resolve) => {
      endLease = this.armExec(leaseId, state, pending, timeoutMs, resolve).endLease;
    });
    const backendFailure = (cause?: Error): Result<ExecutionResult, ExecutionBrokerError> =>
      err(new ExecutionBrokerError('BACKEND_FAILURE', 'the container exec backend failed', cause));
    // Whoever aborted the exec owns the outcome, and no output follows it.
    const live = (): boolean => !pending.settled && !pending.controller.signal.aborted;

    let started: Result<BackendExecSession, ExecutionBrokerError>;
    try {
      started = await this.opts.backend.execStream(containerId, {
        argv,
        cwd,
        signal: pending.controller.signal,
        onStdout: (text: string): void => {
          if (!live()) {
            return;
          }
          try {
            handlers.onStdout(text);
          } catch {
            // Constraint: a handler failure must not crash the broker or echo its message.
            pending.controller.abort();
            void endLease(
              err(new ExecutionBrokerError('BACKEND_FAILURE', 'the stdout handler failed')),
            );
          }
        },
      });
    } catch (error) {
      started = err(
        new ExecutionBrokerError(
          'BACKEND_FAILURE',
          'the container exec backend failed',
          error instanceof Error ? error : undefined,
        ),
      );
    }
    if (started.isErr()) {
      if (pending.controller.signal.aborted) {
        // A timeout or revoke owns the outcome; it is already on `result`.
        return ok({ writeStdin: (): void => undefined, endStdin: (): void => undefined, result });
      }
      const failure = new ExecutionBrokerError(
        'BACKEND_FAILURE',
        'the container exec backend failed',
        started.error,
      );
      await endLease(err(failure));
      return err(failure);
    }
    const session = started.value;
    void session.done.then((done) => {
      if (done.isOk()) {
        const cap = state.profile.outputCapChars;
        const { exitCode, stderr } = done.value;
        pending.settle(
          ok({
            exitCode,
            stdout: '',
            stderr: stderr.slice(0, cap),
            stdoutTruncated: false,
            stderrTruncated: stderr.length > cap,
            timedOut: false,
            cancelled: false,
          }),
        );
        return;
      }
      if (pending.controller.signal.aborted) {
        return;
      }
      void endLease(backendFailure(done.error));
    });
    return ok({
      writeStdin: (text: string): void => {
        if (live()) {
          session.writeStdin(text);
        }
      },
      endStdin: (): void => {
        if (live()) {
          session.endStdin();
        }
      },
      result,
    });
  }

  /**
   * Validation and admission shared by execute and executeStream: parse, lease
   * binding, argv bounds, timeout bound, cwd, concurrency, then the slot
   * reservation and single-flight container creation. Returns the reserved
   * slot and the container to run in.
   */
  private async admit(input: unknown): Promise<Result<Admitted, ExecutionBrokerError>> {
    const parsed = parseExecuteInput(input);
    if (parsed.isErr()) {
      return err(parsed.error);
    }
    const { leaseId, taskId, personaId, argv, cwd, timeoutMs } = parsed.value;
    const record = this.store.get(leaseId);
    if (record.isErr()) {
      return err(record.error);
    }
    const binding = record.value.binding;
    if (taskId !== binding.taskId || personaId !== binding.personaId) {
      return err(
        new ExecutionBrokerError('LEASE_MISMATCH', 'the caller does not match the lease binding'),
      );
    }
    const state = this.leases.get(leaseId);
    if (state === undefined) {
      // Defensive: the private map mirrors the store; a gap means no usable lease.
      return err(new ExecutionBrokerError('LEASE_NOT_FOUND', 'no lease for this request'));
    }
    const argvBounds = checkArgvBounds(argv, state.profile);
    if (argvBounds.isErr()) {
      return err(argvBounds.error);
    }
    if (timeoutMs > state.profile.maxTimeoutMs) {
      return err(
        new ExecutionBrokerError(
          'TIMEOUT_EXCEEDS_PROFILE',
          'the requested timeout exceeds the profile maximum',
        ),
      );
    }
    const containerCwd = resolveWorkspaceCwd(cwd, state.workspace);
    if (containerCwd.isErr()) {
      return err(containerCwd.error);
    }
    if (state.inFlight.size >= state.profile.maxConcurrentExecsPerLease) {
      return err(
        new ExecutionBrokerError(
          'CONCURRENCY_LIMIT',
          'the lease has reached its concurrent-exec limit',
        ),
      );
    }
    // Reserve the slot before the first await so a concurrent execute sees it;
    // the settle-once latch releases it exactly once. `settle` is a no-op
    // placeholder until runExec wires the real latch; a revoke landing in that
    // window is answered by the post-createContainer race check below.
    const pending: PendingExec = {
      controller: new AbortController(),
      settle: (): void => undefined,
      settled: false,
      timer: undefined,
    };
    state.inFlight.add(pending);
    let containerId = state.containerId;
    if (containerId === null) {
      // Single-flight: the first execute starts the creation; concurrent
      // executes await the same promise so only one container is created.
      if (state.creating === null) {
        state.creating = this.opts.backend.createContainer({
          taskId: binding.taskId,
          profile: state.profile,
          workspace: state.workspace,
        });
      }
      const created = await state.creating;
      if (created.isErr()) {
        // Fail-closed: no container exists, so the lease is terminal.
        state.creating = null;
        state.inFlight.delete(pending);
        this.store.revoke(leaseId);
        this.leases.delete(leaseId);
        return err(created.error);
      }
      // Race: the lease may have been revoked while createContainer ran. The
      // just-created container is removed and the request fails as revoked.
      if (this.store.get(leaseId).isErr() || !this.leases.has(leaseId)) {
        await this.opts.backend.removeContainer(created.value.containerId);
        return err(
          new ExecutionBrokerError(
            'LEASE_REVOKED',
            'the lease was revoked while the container was being created',
          ),
        );
      }
      // Claim the container ID exactly once across concurrent first-executes.
      if (state.containerId === null) {
        state.containerId = created.value.containerId;
      }
      state.creating = null;
      containerId = created.value.containerId;
    }
    return ok({
      leaseId,
      state,
      pending,
      containerId,
      argv,
      cwd: containerCwd.value,
      timeoutMs,
    });
  }

  async revoke(leaseId: string): Promise<Result<void, ExecutionBrokerError>> {
    const record = this.store.get(leaseId);
    if (record.isErr()) {
      // Idempotent: revoking an already-revoked lease is a no-op success
      // and never touches the backend.
      if (record.error.brokerCode === 'LEASE_REVOKED') {
        return ok(undefined);
      }
      return err(record.error);
    }
    const state = this.leases.get(leaseId);
    if (state !== undefined) {
      // Cancel every in-flight exec first: abort the signal and settle the
      // latch as cancelled so each pending execute resolves deterministically.
      // settle() deletes from the set, so iterate a snapshot.
      for (const pendingExec of [...state.inFlight]) {
        pendingExec.controller.abort();
        pendingExec.settle(
          ok({
            exitCode: null,
            stdout: '',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
            cancelled: true,
          }),
        );
      }
      const container = state.containerId;
      state.containerId = null;
      if (container !== null) {
        // Removal is requested exactly once per lease. The Result is checked
        // and deliberately ignored: the lease is terminal regardless, and
        // cleanup must never throw.
        const removed = await this.opts.backend.removeContainer(container);
        void removed;
      }
      this.leases.delete(leaseId);
    }
    return this.store.revoke(leaseId);
  }

  /**
   * The settle-once latch and the timeout timer for one reserved slot, shared
   * by runExec and executeStream. Outcomes race into `settle`: the backend
   * result, a terminal failure (endLease) and the timeout timer. Terminal
   * cleanup runs before settle so a caller that awaits the result sees an
   * already-removed container and a revoked lease.
   */
  private armExec(
    leaseId: string,
    state: LeaseState,
    pending: PendingExec,
    timeoutMs: number,
    resolve: (r: Result<ExecutionResult, ExecutionBrokerError>) => void,
  ): { settle: PendingExec['settle']; endLease: EndLease } {
    const settle = (r: Result<ExecutionResult, ExecutionBrokerError>): void => {
      if (pending.settled) {
        return;
      }
      pending.settled = true;
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
        pending.timer = undefined;
      }
      state.inFlight.delete(pending);
      resolve(r);
    };
    pending.settle = settle;

    // Terminal cleanup: cancel every OTHER in-flight exec on this lease,
    // then take and clear the shared container ID before the await so racing
    // terminal paths cannot remove it twice, revoke the lease, and settle.
    // An err removal is tolerated: the lease is terminal either way.
    const endLease: EndLease = async (result) => {
      // Cancel every other in-flight exec before cleanup. settle() removes
      // from the set, so iterate a snapshot and skip the current pending.
      for (const sibling of [...state.inFlight]) {
        if (sibling === pending) {
          continue;
        }
        sibling.controller.abort();
        sibling.settle(
          ok({
            exitCode: null,
            stdout: '',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
            cancelled: true,
          }),
        );
      }
      const container = state.containerId;
      state.containerId = null;
      if (container !== null) {
        await this.opts.backend.removeContainer(container);
      }
      this.store.revoke(leaseId);
      this.leases.delete(leaseId);
      settle(result);
    };

    pending.timer = setTimeout(() => {
      pending.controller.abort();
      void endLease(
        ok({
          exitCode: null,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: true,
          cancelled: false,
        }),
      );
    }, timeoutMs);
    return { settle, endLease };
  }

  /**
   * The single backend.exec call site. The exec result, the exec error and
   * the timeout race through the armExec latch. A non-zero exit code is a
   * normal ok result.
   *
   * Deliberately not async (require-await): the promise is built by hand so
   * the latch can resolve it exactly once from any of the racing paths.
   */
  private runExec(
    leaseId: string,
    state: LeaseState,
    pending: PendingExec,
    containerId: string,
    argv: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<Result<ExecutionResult, ExecutionBrokerError>> {
    return new Promise<Result<ExecutionResult, ExecutionBrokerError>>((resolve) => {
      const { settle, endLease } = this.armExec(leaseId, state, pending, timeoutMs, resolve);

      void (async (): Promise<void> => {
        const result = await this.opts.backend.exec(containerId, {
          argv,
          cwd,
          signal: pending.controller.signal,
        });
        if (result.isOk()) {
          const cap = state.profile.outputCapChars;
          const { exitCode, stdout, stderr } = result.value;
          settle(
            ok({
              exitCode,
              stdout: stdout.slice(0, cap),
              stderr: stderr.slice(0, cap),
              stdoutTruncated: stdout.length > cap,
              stderrTruncated: stderr.length > cap,
              timedOut: false,
              cancelled: false,
            }),
          );
          return;
        }
        if (pending.controller.signal.aborted) {
          // Constraint: whoever aborted this exec (timeout, revoke, or a
          // terminal sibling) owns the outcome. A real backend fails its exec
          // when aborted; that error must not outrun the timeout result.
          return;
        }
        void endLease(
          err(
            new ExecutionBrokerError(
              'BACKEND_FAILURE',
              'the container exec backend failed',
              result.error,
            ),
          ),
        );
      })();
    });
  }
}
