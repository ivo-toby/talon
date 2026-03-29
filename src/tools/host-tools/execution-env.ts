import type pino from 'pino';
import type { ToolCallResult, ToolManifest } from '../tool-types.js';
import type { ToolExecutionContext } from './channel-send.js';
import type { ExecutionEnvManager } from '../../execution-env/execution-env-manager.js';
import type { ExecutionEnvResourceLimits } from '../../execution-env/execution-env-types.js';

export interface ExecutionEnvArgs {
  action: 'create' | 'exec' | 'upload' | 'download' | 'checkpoint' | 'restore' | 'destroy';
  envId?: string;
  checkpointId?: string;
  label?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  detach?: boolean;
  env?: Record<string, string>;
  sourcePath?: string;
  destinationPath?: string;
  recursive?: boolean;
  overwrite?: boolean;
  sandboxProfile?: string;
  baseSnapshot?: string;
  workingDirectory?: string;
  autoDestroy?: boolean;
  resourceLimits?: Partial<ExecutionEnvResourceLimits>;
}

interface ExecutionEnvHandlerDeps {
  executionEnvManager: ExecutionEnvManager;
  logger: pino.Logger;
}

export class ExecutionEnvHandler {
  static readonly manifest: ToolManifest = {
    name: 'execution.env',
    description: 'Manage isolated Sprite execution environments for background tasks.',
    capabilities: ['execution.env'],
    executionLocation: 'host',
  };

  constructor(private readonly deps: ExecutionEnvHandlerDeps) {}

  async execute(args: ExecutionEnvArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';
    this.deps.logger.debug(
      { requestId, action: args.action, threadId: context.threadId, personaId: context.personaId },
      'execution.env: executing',
    );

    switch (args.action) {
      case 'create':
        return this.create(args, context, requestId);
      case 'exec':
        return this.exec(args, requestId);
      case 'upload':
        return this.upload(args, context, requestId);
      case 'download':
        return this.download(args, context, requestId);
      case 'checkpoint':
        return this.checkpoint(args, requestId);
      case 'restore':
        return this.restore(args, requestId);
      case 'destroy':
        return this.destroy(args, requestId);
      default:
        return this.errorResult(
          requestId,
          `Unsupported action: ${String((args as { action?: unknown }).action)}`,
        );
    }
  }

  private async create(
    args: ExecutionEnvArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): Promise<ToolCallResult> {
    const resourceLimits = this.sanitizeResourceLimits(args.resourceLimits);
    if (!resourceLimits.ok) {
      return this.errorResult(requestId, resourceLimits.error);
    }

    const result = await this.deps.executionEnvManager.create({
      threadId: context.threadId,
      personaId: context.personaId,
      ownerTaskId: context.backgroundTaskId ?? null,
      ...(args.baseSnapshot ? { baseSnapshot: args.baseSnapshot } : {}),
      ...(args.workingDirectory ? { workingDirectory: args.workingDirectory } : {}),
      ...(args.autoDestroy !== undefined ? { autoDestroy: args.autoDestroy } : {}),
      ...(resourceLimits.value ? { resourceLimits: resourceLimits.value } : {}),
    });

    return result.isOk()
      ? this.successResult(requestId, { env: result.value })
      : this.errorResult(requestId, result.error.message);
  }

  private async exec(args: ExecutionEnvArgs, requestId: string): Promise<ToolCallResult> {
    if (!args.envId || !args.command) {
      return this.errorResult(requestId, 'exec requires envId and command');
    }

    const result = await this.deps.executionEnvManager.exec({
      envId: args.envId,
      command: args.command,
      ...(args.cwd ? { cwd: args.cwd } : {}),
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      ...(args.detach !== undefined ? { detach: args.detach } : {}),
      ...(args.env ? { env: args.env } : {}),
    });

    return result.isOk()
      ? this.successResult(requestId, { exec: result.value })
      : this.errorResult(requestId, result.error.message);
  }

  private async upload(
    args: ExecutionEnvArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): Promise<ToolCallResult> {
    if (!args.envId || !args.sourcePath || !args.destinationPath) {
      return this.errorResult(requestId, 'upload requires envId, sourcePath, and destinationPath');
    }

    const result = await this.deps.executionEnvManager.upload({
      envId: args.envId,
      sourcePath: args.sourcePath,
      destinationPath: args.destinationPath,
      ...(args.recursive !== undefined ? { recursive: args.recursive } : {}),
      allowedHostRoots: context.allowedHostRoots ?? [],
    });

    return result.isOk()
      ? this.successResult(requestId, { transfer: result.value })
      : this.errorResult(requestId, result.error.message);
  }

  private async download(
    args: ExecutionEnvArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): Promise<ToolCallResult> {
    if (!args.envId || !args.sourcePath || !args.destinationPath) {
      return this.errorResult(
        requestId,
        'download requires envId, sourcePath, and destinationPath',
      );
    }

    const result = await this.deps.executionEnvManager.download({
      envId: args.envId,
      sourcePath: args.sourcePath,
      destinationPath: args.destinationPath,
      ...(args.overwrite !== undefined ? { overwrite: args.overwrite } : {}),
      allowedHostRoots: context.allowedHostRoots ?? [],
    });

    return result.isOk()
      ? this.successResult(requestId, { transfer: result.value })
      : this.errorResult(requestId, result.error.message);
  }

  private async destroy(args: ExecutionEnvArgs, requestId: string): Promise<ToolCallResult> {
    if (!args.envId) {
      return this.errorResult(requestId, 'destroy requires envId');
    }

    const result = await this.deps.executionEnvManager.destroy(args.envId);
    return result.isOk()
      ? this.successResult(requestId, { destroyed: true, envId: args.envId })
      : this.errorResult(requestId, result.error.message);
  }

  private async checkpoint(args: ExecutionEnvArgs, requestId: string): Promise<ToolCallResult> {
    if (!args.envId) {
      return this.errorResult(requestId, 'checkpoint requires envId');
    }

    const result = await this.deps.executionEnvManager.checkpoint({
      envId: args.envId,
      ...(args.label !== undefined ? { label: args.label } : {}),
    });

    return result.isOk()
      ? this.successResult(requestId, { checkpoint: result.value })
      : this.errorResult(requestId, result.error.message);
  }

  private async restore(args: ExecutionEnvArgs, requestId: string): Promise<ToolCallResult> {
    if (!args.checkpointId) {
      return this.errorResult(requestId, 'restore requires checkpointId');
    }

    const result = await this.deps.executionEnvManager.restore({
      checkpointId: args.checkpointId,
      ...(args.workingDirectory ? { workingDirectory: args.workingDirectory } : {}),
      ...(args.autoDestroy !== undefined ? { autoDestroy: args.autoDestroy } : {}),
      ...(args.resourceLimits ? { resourceLimits: args.resourceLimits } : {}),
    });

    return result.isOk()
      ? this.successResult(requestId, { env: result.value })
      : this.errorResult(requestId, result.error.message);
  }

  private successResult(requestId: string, result: unknown): ToolCallResult {
    return {
      requestId,
      tool: ExecutionEnvHandler.manifest.name,
      status: 'success',
      result,
    };
  }

  private errorResult(requestId: string, message: string): ToolCallResult {
    return {
      requestId,
      tool: ExecutionEnvHandler.manifest.name,
      status: 'error',
      error: message,
    };
  }

  private sanitizeResourceLimits(
    value: unknown,
  ): { ok: true; value?: Partial<ExecutionEnvResourceLimits> } | { ok: false; error: string } {
    if (value === undefined) {
      return { ok: true };
    }

    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'resourceLimits must be an object when provided' };
    }

    const record = value as Record<string, unknown>;
    const sanitized: Partial<ExecutionEnvResourceLimits> = {};
    const numericFields: Array<{
      key: keyof ExecutionEnvResourceLimits;
      min: number;
      max: number;
      integer?: boolean;
    }> = [
      { key: 'cpus', min: 0.25, max: 64 },
      { key: 'memoryMb', min: 256, max: 262144, integer: true },
      { key: 'diskGb', min: 1, max: 2048, integer: true },
    ];

    for (const field of numericFields) {
      const raw = record[field.key];
      if (raw === undefined) {
        continue;
      }
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return { ok: false, error: `resourceLimits.${field.key} must be a finite number` };
      }
      if (field.integer && !Number.isInteger(raw)) {
        return { ok: false, error: `resourceLimits.${field.key} must be an integer` };
      }
      if (raw < field.min || raw > field.max) {
        return {
          ok: false,
          error: `resourceLimits.${field.key} must be between ${field.min} and ${field.max}`,
        };
      }
      sanitized[field.key] = raw;
    }

    const unknownKeys = Object.keys(record).filter((key) =>
      !numericFields.some((field) => field.key === key),
    );
    if (unknownKeys.length > 0) {
      return { ok: false, error: `resourceLimits contains unknown keys: ${unknownKeys.join(', ')}` };
    }

    return { ok: true, value: sanitized };
  }
}
