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
  ContainerBackend,
  ExecutionResult,
  OperatorAllowlist,
  ProfileConfig,
  WorkspaceConfig,
} from './types.js';

/**
 * Per-lease runtime state that the immutable LeaseRecord does not carry.
 * `containerId` is created lazily on the first execute and cleared on revoke.
 */
interface LeaseState {
  profile: ProfileConfig;
  workspace: WorkspaceConfig;
  containerId: string | null;
}

/**
 * Sequential execution-broker core: createLease -> execute -> revoke.
 *
 * Constraints:
 * - Validation happens before any backend mutation; error details never echo
 *   lease IDs, argv elements, or command output.
 * - A failed createContainer makes the lease terminal (revoked, fail-closed).
 * - backend.exec stays isolated in runExec so a later slice can wrap it with
 *   a settle-once latch, an AbortController timeout, and per-lease exec
 *   concurrency without touching the rest of the lifecycle.
 *
 * Out of scope for this slice: timeouts, cancellation of in-flight execs,
 * per-lease exec concurrency, exec backend-failure cleanup.
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
  createLease(
    input: unknown,
  ): Promise<Result<{ leaseId: string }, ExecutionBrokerError>> {
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
    this.leases.set(leaseId, { profile, workspace, containerId: null });
    return Promise.resolve(ok({ leaseId }));
  }

  async execute(
    input: unknown,
  ): Promise<Result<ExecutionResult, ExecutionBrokerError>> {
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
        new ExecutionBrokerError(
          'LEASE_MISMATCH',
          'the caller does not match the lease binding',
        ),
      );
    }
    const state = this.leases.get(leaseId);
    if (state === undefined) {
      // Defensive: the private map mirrors the store; a gap means no usable lease.
      return err(
        new ExecutionBrokerError('LEASE_NOT_FOUND', 'no lease for this request'),
      );
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
    let containerId = state.containerId;
    if (containerId === null) {
      const created = await this.opts.backend.createContainer({
        taskId: binding.taskId,
        profile: state.profile,
        workspace: state.workspace,
      });
      if (created.isErr()) {
        // Fail-closed: no container exists, so the lease is terminal.
        this.store.revoke(leaseId);
        this.leases.delete(leaseId);
        return err(created.error);
      }
      containerId = created.value.containerId;
      state.containerId = containerId;
    }
    return await this.runExec(
      containerId,
      state.profile,
      argv,
      containerCwd.value,
    );
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
      if (state.containerId !== null) {
        // Removal is requested exactly once per lease; the lease becomes
        // terminal regardless (cleanup ownership is a later slice).
        await this.opts.backend.removeContainer(state.containerId);
      }
      state.containerId = null;
      this.leases.delete(leaseId);
    }
    return this.store.revoke(leaseId);
  }

  /**
   * The single backend.exec call site: a later slice wraps this with a
   * settle-once latch and an AbortController for timeout/cancellation.
   * A non-zero exit code is a normal ok result.
   */
  private async runExec(
    containerId: string,
    profile: ProfileConfig,
    argv: string[],
    cwd: string,
  ): Promise<Result<ExecutionResult, ExecutionBrokerError>> {
    const result = await this.opts.backend.exec(containerId, {
      argv,
      cwd,
      signal: new AbortController().signal,
    });
    if (result.isErr()) {
      return err(result.error);
    }
    const cap = profile.outputCapChars;
    const { exitCode, stdout, stderr } = result.value;
    return ok({
      exitCode,
      stdout: stdout.slice(0, cap),
      stderr: stderr.slice(0, cap),
      stdoutTruncated: stdout.length > cap,
      stderrTruncated: stderr.length > cap,
      timedOut: false,
      cancelled: false,
    });
  }
}
