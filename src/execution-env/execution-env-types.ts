export type ExecutionEnvProvider = 'sprites';

export type ExecutionEnvStatus =
  | 'creating'
  | 'ready'
  | 'busy'
  | 'checkpointing'
  | 'restoring'
  | 'destroying'
  | 'destroyed'
  | 'failed';

export type ExecutionEnvErrorCode =
  | 'CHECKPOINT_NOT_FOUND'
  | 'ENV_NOT_FOUND'
  | 'SPRITES_NOT_CONFIGURED'
  | 'SPRITES_AUTH_FAILED'
  | 'SPRITES_CREATE_FAILED'
  | 'SPRITES_EXEC_FAILED'
  | 'SPRITES_TRANSFER_FAILED'
  | 'SPRITES_CHECKPOINT_FAILED'
  | 'SPRITES_RESTORE_FAILED'
  | 'SPRITES_DESTROY_FAILED'
  | 'NOT_TASK_OWNER'
  | 'HOST_PATH_NOT_ALLOWED'
  | 'INVALID_ARGUMENT';

export interface ExecutionEnvResourceLimits {
  cpus: number;
  memoryMb: number;
  diskGb: number;
}

export interface ExecutionEnvironment {
  id: string;
  provider: ExecutionEnvProvider;
  spriteId: string;
  threadId: string;
  personaId: string;
  ownerTaskId: string | null;
  status: ExecutionEnvStatus;
  workingDirectory: string;
  baseSnapshot: string | null;
  autoDestroy: boolean;
  resourceLimits: ExecutionEnvResourceLimits;
  createdAt: number;
  updatedAt: number;
  destroyedAt: number | null;
}

export interface CreateExecutionEnvironmentRecordInput {
  id: string;
  provider: ExecutionEnvProvider;
  spriteId: string;
  threadId: string;
  personaId: string;
  ownerTaskId: string | null;
  status: ExecutionEnvStatus;
  workingDirectory: string;
  baseSnapshot: string | null;
  autoDestroy: boolean;
  resourceLimits: ExecutionEnvResourceLimits;
  metadata?: Record<string, string> | null;
}

export interface CreateExecutionEnvironmentInput {
  threadId: string;
  personaId: string;
  ownerTaskId?: string | null;
  workingDirectory?: string;
  baseSnapshot?: string;
  autoDestroy?: boolean;
  resourceLimits?: Partial<ExecutionEnvResourceLimits>;
  metadata?: Record<string, string>;
}

export interface ExecExecutionEnvironmentInput {
  envId: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  detach?: boolean;
  env?: Record<string, string>;
}

export interface UploadExecutionEnvironmentInput {
  envId: string;
  sourcePath: string;
  destinationPath: string;
  recursive?: boolean;
  allowedHostRoots: string[];
}

export interface DownloadExecutionEnvironmentInput {
  envId: string;
  sourcePath: string;
  destinationPath: string;
  overwrite?: boolean;
  allowedHostRoots: string[];
}

export interface ExecutionEnvExecResult {
  envId: string;
  status: 'completed' | 'running';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  processId?: string;
}

export interface ExecutionEnvTransferResult {
  direction: 'upload' | 'download';
  envId: string;
  sourcePath: string;
  destinationPath: string;
  bytes: number;
}

export interface CheckpointExecutionEnvironmentInput {
  envId: string;
  label?: string;
}

export interface RestoreExecutionEnvironmentInput {
  checkpointId: string;
  workingDirectory?: string;
  autoDestroy?: boolean;
  resourceLimits?: Partial<ExecutionEnvResourceLimits>;
}

export interface ExecutionEnvCheckpoint {
  id: string;
  envId: string;
  provider: ExecutionEnvProvider;
  remoteRef: string;
  label: string | null;
  status: 'creating' | 'ready' | 'failed';
  createdAt: number;
}

export interface CreateExecutionEnvCheckpointInput {
  id: string;
  envId: string;
  provider: ExecutionEnvProvider;
  remoteRef: string;
  label: string | null;
  status: ExecutionEnvCheckpoint['status'];
}
