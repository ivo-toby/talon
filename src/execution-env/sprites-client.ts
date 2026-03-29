import type { SpritesConfig } from '../core/config/config-types.js';
import { ExecutionEnvError } from '../core/errors/error-types.js';
import type { SpritesClientAdapter } from './sprites-client-adapter.js';
import type { ExecutionEnvResourceLimits } from './execution-env-types.js';

export class SpritesClient implements SpritesClientAdapter {
  constructor(private readonly config: SpritesConfig) {}

  async create(_input: {
    baseSnapshot?: string;
    resourceLimits: ExecutionEnvResourceLimits;
    workingDirectory: string;
    metadata: Record<string, string>;
  }): Promise<{ spriteId: string }> {
    throw new ExecutionEnvError(
      'execution_env: [SPRITES_CREATE_FAILED] Sprites client is not wired yet',
    );
  }

  async exec(_input: {
    spriteId: string;
    command: string;
    cwd: string;
    timeoutMs: number;
    detach?: boolean;
    env?: Record<string, string>;
  }): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    processId?: string;
  }> {
    throw new ExecutionEnvError(
      'execution_env: [SPRITES_EXEC_FAILED] Sprites client is not wired yet',
    );
  }

  async upload(_input: {
    spriteId: string;
    sourcePath: string;
    destinationPath: string;
    recursive?: boolean;
  }): Promise<{ bytes: number }> {
    throw new ExecutionEnvError(
      'execution_env: [SPRITES_TRANSFER_FAILED] Sprites client is not wired yet',
    );
  }

  async download(_input: {
    spriteId: string;
    sourcePath: string;
    destinationPath: string;
    overwrite?: boolean;
  }): Promise<{ bytes: number }> {
    throw new ExecutionEnvError(
      'execution_env: [SPRITES_TRANSFER_FAILED] Sprites client is not wired yet',
    );
  }

  async destroy(_spriteId: string): Promise<void> {
    throw new ExecutionEnvError(
      'execution_env: [SPRITES_DESTROY_FAILED] Sprites client is not wired yet',
    );
  }

  async checkpoint(_input: {
    spriteId: string;
    label?: string;
  }): Promise<{ remoteRef: string }> {
    throw new ExecutionEnvError(
      'execution_env: [SPRITES_CHECKPOINT_FAILED] Sprites client is not wired yet',
    );
  }

  async restore(_input: {
    remoteRef: string;
    resourceLimits: ExecutionEnvResourceLimits;
    workingDirectory: string;
    metadata: Record<string, string>;
  }): Promise<{ spriteId: string }> {
    throw new ExecutionEnvError(
      'execution_env: [SPRITES_RESTORE_FAILED] Sprites client is not wired yet',
    );
  }
}
