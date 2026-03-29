import type { ExecutionEnvResourceLimits } from './execution-env-types.js';

export interface SpritesClientAdapter {
  create(input: {
    baseSnapshot?: string;
    resourceLimits: ExecutionEnvResourceLimits;
    workingDirectory: string;
    metadata: Record<string, string>;
  }): Promise<{ spriteId: string }>;

  exec(input: {
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
  }>;

  upload(input: {
    spriteId: string;
    sourcePath: string;
    destinationPath: string;
    recursive?: boolean;
  }): Promise<{ bytes: number }>;

  download(input: {
    spriteId: string;
    sourcePath: string;
    destinationPath: string;
    overwrite?: boolean;
  }): Promise<{ bytes: number }>;

  checkpoint(input: {
    spriteId: string;
    label?: string;
  }): Promise<{ remoteRef: string }>;

  restore(input: {
    spriteId: string;
    remoteRef: string;
  }): Promise<void>;

  destroy(spriteId: string): Promise<void>;
}
