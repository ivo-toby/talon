import type { Result } from 'neverthrow';
import type { ExecutionBrokerError } from './errors.js';

export type ExecutionBrokerErrorCode =
  | 'INVALID_ARGUMENT'
  | 'GRANT_DENIED'
  | 'UNKNOWN_PROFILE'
  | 'UNKNOWN_WORKSPACE'
  | 'CWD_OUTSIDE_WORKSPACE'
  | 'SYMLINK_ESCAPE'
  | 'LEASE_NOT_FOUND'
  | 'LEASE_MISMATCH'
  | 'LEASE_REVOKED'
  | 'TIMEOUT_EXCEEDS_PROFILE'
  | 'CONCURRENCY_LIMIT'
  | 'QUOTA_UNENFORCEABLE'
  | 'BACKEND_FAILURE';

export type LeaseStatus = 'active' | 'revoked';

export type WorkspaceMode = 'ro' | 'rw';

/** Operator-owned workspace mapping. `hostPath` is absolute on the Docker host. */
export interface WorkspaceConfig {
  id: string;
  hostPath: string;
  /** Absolute POSIX path inside the worker container. */
  mountTarget: string;
  mode: WorkspaceMode;
}

export interface ProfileConfig {
  id: string;
  maxTimeoutMs: number;
  /** Cap applied separately to stdout and stderr, in UTF-16 code units (string length). */
  outputCapChars: number;
  maxArgvCount: number;
  /** Sum of `argv[i].length` over all elements. */
  maxArgvChars: number;
  maxConcurrentExecsPerLease: number;
  maxActiveLeases: number;
}

export interface TaskGrant {
  parentPersona: string;
  workerPersona: string;
  profile: string;
  workspace: string;
}

export interface OperatorAllowlist {
  profiles: ProfileConfig[];
  workspaces: WorkspaceConfig[];
  grants: TaskGrant[];
}

/** Exact accepted keys; any other key is INVALID_ARGUMENT. */
export interface CreateLeaseInput {
  taskId: string;
  parentPersonaId: string;
  personaId: string;
  profile: string;
  workspace: string;
}

export interface LeaseBinding {
  readonly taskId: string;
  readonly personaId: string;
  readonly profile: string;
  readonly workspace: string;
}

export interface LeaseRecord {
  readonly leaseId: string;
  /** Frozen at creation. */
  readonly binding: LeaseBinding;
  status: LeaseStatus;
}

/** Exact accepted keys; any other key is INVALID_ARGUMENT. */
export interface ExecuteInput {
  leaseId: string;
  taskId: string;
  personaId: string;
  argv: string[];
  /** Workspace-relative; '' or '.' means the workspace root. */
  cwd: string;
  timeoutMs: number;
}

export interface ExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

export interface ContainerSpec {
  taskId: string;
  profile: ProfileConfig;
  workspace: WorkspaceConfig;
}

export interface BackendExecRequest {
  argv: string[];
  /** Container-side absolute path produced by path validation. */
  cwd: string;
  signal: AbortSignal;
}

export interface RawExecOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BackendCapabilities {
  diskQuotaEnforced: boolean;
}

export interface ContainerBackend {
  capabilities(): BackendCapabilities;
  createContainer(spec: ContainerSpec): Promise<Result<{ containerId: string }, ExecutionBrokerError>>;
  exec(containerId: string, request: BackendExecRequest): Promise<Result<RawExecOutput, ExecutionBrokerError>>;
  removeContainer(containerId: string): Promise<Result<void, ExecutionBrokerError>>;
}
