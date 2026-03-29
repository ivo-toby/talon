import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from 'neverthrow';
import type pino from 'pino';
import { ExecutionEnvError } from '../core/errors/error-types.js';
import { ExecutionEnvCheckpointRepository } from '../core/database/repositories/execution-env-checkpoint-repository.js';
import { ExecutionEnvRepository } from '../core/database/repositories/execution-env-repository.js';
import { resolveAllowedHostPath } from './path-policy.js';
import type { SpritesClientAdapter } from './sprites-client-adapter.js';
import type {
  CheckpointExecutionEnvironmentInput,
  CreateExecutionEnvironmentInput,
  DownloadExecutionEnvironmentInput,
  ExecutionEnvironment,
  ExecutionEnvCheckpoint,
  ExecutionEnvExecResult,
  ExecutionEnvResourceLimits,
  ExecutionEnvTransferResult,
  ExecExecutionEnvironmentInput,
  RestoreExecutionEnvironmentInput,
  UploadExecutionEnvironmentInput,
} from './execution-env-types.js';

interface ExecutionEnvManagerDeps {
  repository: ExecutionEnvRepository;
  checkpointRepository: ExecutionEnvCheckpointRepository;
  client: SpritesClientAdapter;
  defaultWorkingDirectory: string;
  defaultBaseSnapshot?: string;
  defaultAutoDestroy?: boolean;
  defaultExecTimeoutMs?: number;
  defaultResourceLimits: ExecutionEnvResourceLimits;
  logger: pino.Logger;
}

export class ExecutionEnvManager {
  constructor(private readonly deps: ExecutionEnvManagerDeps) {}

  async create(
    input: CreateExecutionEnvironmentInput,
  ): Promise<Result<ExecutionEnvironment, ExecutionEnvError>> {
    try {
      const workingDirectory = input.workingDirectory ?? this.deps.defaultWorkingDirectory;
      const resourceLimits = {
        ...this.deps.defaultResourceLimits,
        ...(input.resourceLimits ?? {}),
      };
      const baseSnapshot = input.baseSnapshot ?? this.deps.defaultBaseSnapshot;
      const autoDestroy = input.autoDestroy ?? this.deps.defaultAutoDestroy ?? true;
      const metadata = {
        threadId: input.threadId,
        personaId: input.personaId,
        ...(input.ownerTaskId ? { ownerTaskId: input.ownerTaskId } : {}),
        ...(input.metadata ?? {}),
      };

      const created = await this.deps.client.create({
        ...(baseSnapshot ? { baseSnapshot } : {}),
        resourceLimits,
        workingDirectory,
        metadata,
      });

      const repoResult = this.deps.repository.create({
        id: randomUUID(),
        provider: 'sprites',
        spriteId: created.spriteId,
        threadId: input.threadId,
        personaId: input.personaId,
        ownerTaskId: input.ownerTaskId ?? null,
        status: 'ready',
        workingDirectory,
        baseSnapshot: baseSnapshot ?? null,
        autoDestroy,
        resourceLimits,
        metadata,
      });

      if (repoResult.isErr()) {
        try {
          await this.deps.client.destroy(created.spriteId);
        } catch (cleanupError) {
          this.deps.logger.warn(
            { err: cleanupError, spriteId: created.spriteId },
            'execution-env: failed to destroy sprite after persistence failure',
          );
        }
        return err(new ExecutionEnvError(repoResult.error.message, repoResult.error));
      }

      return ok(repoResult.value);
    } catch (cause) {
      return err(this.wrapError('SPRITES_CREATE_FAILED', 'failed to create execution environment', cause));
    }
  }

  async exec(
    input: ExecExecutionEnvironmentInput,
  ): Promise<Result<ExecutionEnvExecResult, ExecutionEnvError>> {
    const env = this.findEnvOrError(input.envId);
    if (env.isErr()) {
      return err(env.error);
    }

    try {
      this.deps.repository.updateStatus(input.envId, 'busy');
      const result = await this.deps.client.exec({
        spriteId: env.value.spriteId,
        command: input.command,
        cwd: input.cwd ?? env.value.workingDirectory,
        timeoutMs: input.timeoutMs ?? this.deps.defaultExecTimeoutMs ?? 30_000,
        ...(input.detach !== undefined ? { detach: input.detach } : {}),
        ...(input.env ? { env: input.env } : {}),
      });
      this.deps.repository.updateStatus(input.envId, 'ready');

      return ok({
        envId: input.envId,
        status: result.processId ? 'running' : 'completed',
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        ...(result.processId ? { processId: result.processId } : {}),
      });
    } catch (cause) {
      this.deps.repository.updateStatus(input.envId, 'failed');
      return err(this.wrapError('SPRITES_EXEC_FAILED', 'failed to execute command', cause));
    }
  }

  async upload(
    input: UploadExecutionEnvironmentInput,
  ): Promise<Result<ExecutionEnvTransferResult, ExecutionEnvError>> {
    const env = this.findEnvOrError(input.envId);
    if (env.isErr()) {
      return err(env.error);
    }

    const sourcePath = resolveAllowedHostPath(input.sourcePath, input.allowedHostRoots);
    if (sourcePath.isErr()) {
      return err(sourcePath.error);
    }

    try {
      const transfer = await this.deps.client.upload({
        spriteId: env.value.spriteId,
        sourcePath: sourcePath.value,
        destinationPath: input.destinationPath,
        ...(input.recursive !== undefined ? { recursive: input.recursive } : {}),
      });

      return ok({
        direction: 'upload',
        envId: input.envId,
        sourcePath: sourcePath.value,
        destinationPath: input.destinationPath,
        bytes: transfer.bytes,
      });
    } catch (cause) {
      return err(this.wrapError('SPRITES_TRANSFER_FAILED', 'failed to upload files', cause));
    }
  }

  async download(
    input: DownloadExecutionEnvironmentInput,
  ): Promise<Result<ExecutionEnvTransferResult, ExecutionEnvError>> {
    const env = this.findEnvOrError(input.envId);
    if (env.isErr()) {
      return err(env.error);
    }

    const destinationPath = resolveAllowedHostPath(input.destinationPath, input.allowedHostRoots);
    if (destinationPath.isErr()) {
      return err(destinationPath.error);
    }

    try {
      const transfer = await this.deps.client.download({
        spriteId: env.value.spriteId,
        sourcePath: input.sourcePath,
        destinationPath: destinationPath.value,
        ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {}),
      });

      return ok({
        direction: 'download',
        envId: input.envId,
        sourcePath: input.sourcePath,
        destinationPath: destinationPath.value,
        bytes: transfer.bytes,
      });
    } catch (cause) {
      return err(this.wrapError('SPRITES_TRANSFER_FAILED', 'failed to download files', cause));
    }
  }

  async destroy(envId: string): Promise<Result<void, ExecutionEnvError>> {
    const env = this.findEnvOrError(envId);
    if (env.isErr()) {
      return err(env.error);
    }

    if (env.value.status === 'destroyed') {
      return ok(undefined);
    }

    try {
      this.deps.repository.updateStatus(envId, 'destroying');
      await this.deps.client.destroy(env.value.spriteId);
      const markDestroyed = this.deps.repository.markDestroyed(envId);
      return markDestroyed.isOk()
        ? ok(undefined)
        : err(new ExecutionEnvError(markDestroyed.error.message, markDestroyed.error));
    } catch (cause) {
      this.deps.repository.updateStatus(envId, 'failed');
      return err(this.wrapError('SPRITES_DESTROY_FAILED', 'failed to destroy execution environment', cause));
    }
  }

  async checkpoint(
    input: CheckpointExecutionEnvironmentInput,
  ): Promise<Result<ExecutionEnvCheckpoint, ExecutionEnvError>> {
    const env = this.findEnvOrError(input.envId);
    if (env.isErr()) {
      return err(env.error);
    }

    try {
      const result = await this.deps.client.checkpoint({
        spriteId: env.value.spriteId,
        ...(input.label !== undefined ? { label: input.label } : {}),
      });
      const checkpointResult = this.deps.checkpointRepository.create({
        id: randomUUID(),
        envId: env.value.id,
        provider: 'sprites',
        remoteRef: result.remoteRef,
        label: input.label ?? null,
        status: 'ready',
      });
      return checkpointResult.isOk()
        ? ok(checkpointResult.value)
        : err(new ExecutionEnvError(checkpointResult.error.message, checkpointResult.error));
    } catch (cause) {
      return err(this.wrapError('SPRITES_CHECKPOINT_FAILED', 'failed to checkpoint execution environment', cause));
    }
  }

  async restore(
    input: RestoreExecutionEnvironmentInput,
  ): Promise<Result<ExecutionEnvironment, ExecutionEnvError>> {
    const env = this.findEnvOrError(input.envId);
    if (env.isErr()) {
      return err(env.error);
    }
    const checkpointResult = this.deps.checkpointRepository.findById(input.checkpointId);
    if (checkpointResult.isErr()) {
      return err(new ExecutionEnvError(checkpointResult.error.message, checkpointResult.error));
    }
    if (!checkpointResult.value) {
      return err(
        new ExecutionEnvError(
          `execution_env: [CHECKPOINT_NOT_FOUND] checkpoint "${input.checkpointId}" not found`,
        ),
      );
    }

    try {
      if (checkpointResult.value.envId !== env.value.id) {
        return err(
          new ExecutionEnvError(
            `execution_env: [INVALID_ARGUMENT] checkpoint "${input.checkpointId}" does not belong to env "${input.envId}"`,
          ),
        );
      }

      this.deps.repository.updateStatus(input.envId, 'restoring');
      await this.deps.client.restore({
        spriteId: env.value.spriteId,
        remoteRef: checkpointResult.value.remoteRef,
      });
      this.deps.repository.updateStatus(input.envId, 'ready');
      const refreshed = this.deps.repository.findById(input.envId);
      return refreshed.isOk() && refreshed.value
        ? ok(refreshed.value)
        : err(new ExecutionEnvError(`execution_env: [ENV_NOT_FOUND] env "${input.envId}" not found after restore`));
    } catch (cause) {
      this.deps.repository.updateStatus(input.envId, 'failed');
      return err(this.wrapError('SPRITES_RESTORE_FAILED', 'failed to restore execution environment', cause));
    }
  }

  async destroyOwnedByTask(taskId: string): Promise<void> {
    const envResult = this.deps.repository.findByOwnerTaskId(taskId);
    if (envResult.isErr() || !envResult.value || !envResult.value.autoDestroy) {
      return;
    }

    await this.destroy(envResult.value.id);
  }

  async recoverOrphanedEnvironments(): Promise<void> {
    const active = this.deps.repository.findActive();
    if (active.isErr()) {
      this.deps.logger.error({ err: active.error }, 'execution-env: failed to load active environments');
      return;
    }

    for (const env of active.value) {
      if (!env.autoDestroy) {
        continue;
      }
      await this.destroy(env.id);
    }
  }

  private findEnvOrError(envId: string): Result<ExecutionEnvironment, ExecutionEnvError> {
    const envResult = this.deps.repository.findById(envId);
    if (envResult.isErr()) {
      return err(new ExecutionEnvError(envResult.error.message, envResult.error));
    }
    if (!envResult.value) {
      return err(new ExecutionEnvError(`execution_env: [ENV_NOT_FOUND] env "${envId}" not found`));
    }
    return ok(envResult.value);
  }

  private wrapError(
    code: string,
    message: string,
    cause: unknown,
  ): ExecutionEnvError {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    return new ExecutionEnvError(`execution_env: [${code}] ${message}: ${error.message}`, error);
  }
}
