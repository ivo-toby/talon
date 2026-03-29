import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix, relative } from 'node:path';
import { ExecError, SpritesClient as FlySpritesClient } from '@fly/sprites';
import type { SpritesConfig } from '../core/config/config-types.js';
import { ExecutionEnvError } from '../core/errors/error-types.js';
import type { SpritesClientAdapter } from './sprites-client-adapter.js';
import type { ExecutionEnvResourceLimits } from './execution-env-types.js';

export class SpritesClient implements SpritesClientAdapter {
  private readonly client: FlySpritesClient;

  constructor(private readonly config: SpritesConfig) {
    this.client = new FlySpritesClient(config.token, {
      baseURL: config.apiBaseUrl,
      timeout: config.execTimeoutMs,
    });
  }

  async create(input: {
    baseSnapshot?: string;
    resourceLimits: ExecutionEnvResourceLimits;
    workingDirectory: string;
    metadata: Record<string, string>;
  }): Promise<{ spriteId: string }> {
    this.ensureConfigured();
    try {
      const sprite = await this.client.createSprite(
        this.buildSpriteName(input.metadata),
        {
          cpus: input.resourceLimits.cpus,
          ramMB: input.resourceLimits.memoryMb,
          storageGB: input.resourceLimits.diskGb,
        },
      );
      return { spriteId: sprite.name };
    } catch (cause) {
      throw this.wrapSpritesError('SPRITES_CREATE_FAILED', 'failed to create sprite', cause);
    }
  }

  async exec(input: {
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
    this.ensureConfigured();
    try {
      const sprite = this.client.sprite(input.spriteId);
      if (input.detach) {
        sprite.createSession('bash', ['-lc', input.command], {
          cwd: input.cwd,
          ...(input.env ? { env: input.env } : {}),
        });
        return {
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          processId: `session-${randomUUID()}`,
        };
      }

      const result = await sprite.execFile('bash', ['-lc', input.command], {
        cwd: input.cwd,
        ...(input.env ? { env: input.env } : {}),
      });
      return {
        exitCode: result.exitCode,
        stdout: this.toText(result.stdout),
        stderr: this.toText(result.stderr),
        timedOut: false,
      };
    } catch (cause) {
      if (cause instanceof ExecError) {
        return {
          exitCode: cause.exitCode,
          stdout: this.toText(cause.stdout),
          stderr: this.toText(cause.stderr),
          timedOut: false,
        };
      }
      throw this.wrapSpritesError('SPRITES_EXEC_FAILED', 'failed to execute command', cause);
    }
  }

  async upload(input: {
    spriteId: string;
    sourcePath: string;
    destinationPath: string;
    recursive?: boolean;
  }): Promise<{ bytes: number }> {
    this.ensureConfigured();

    const sourceStats = await stat(input.sourcePath);
    if (sourceStats.isDirectory()) {
      if (!input.recursive) {
        throw new ExecutionEnvError(
          'execution_env: [SPRITES_TRANSFER_FAILED] recursive=true is required to upload directories',
        );
      }
      const files = await this.walkLocalFiles(input.sourcePath);
      let totalBytes = 0;
      for (const filePath of files) {
        const rel = relative(input.sourcePath, filePath);
        const remotePath = posix.join(input.destinationPath, rel.split('\\').join('/'));
        totalBytes += await this.writeRemoteFile(input.spriteId, filePath, remotePath);
      }
      return { bytes: totalBytes };
    }

    return { bytes: await this.writeRemoteFile(input.spriteId, input.sourcePath, input.destinationPath) };
  }

  async download(input: {
    spriteId: string;
    sourcePath: string;
    destinationPath: string;
    overwrite?: boolean;
  }): Promise<{ bytes: number }> {
    this.ensureConfigured();

    const bytes = await this.readRemoteFile(input.spriteId, input.sourcePath);
    await mkdir(dirname(input.destinationPath), { recursive: true });
    await writeFile(input.destinationPath, bytes, {
      flag: input.overwrite ? 'w' : 'wx',
    });
    return { bytes: bytes.byteLength };
  }

  async destroy(spriteId: string): Promise<void> {
    this.ensureConfigured();
    try {
      await this.client.deleteSprite(spriteId);
    } catch (cause) {
      throw this.wrapSpritesError('SPRITES_DESTROY_FAILED', 'failed to destroy sprite', cause);
    }
  }

  async checkpoint(input: {
    spriteId: string;
    label?: string;
  }): Promise<{ remoteRef: string }> {
    this.ensureConfigured();
    try {
      const sprite = this.client.sprite(input.spriteId);
      const response = await sprite.createCheckpoint(input.label);
      const messages = await this.consumeNdjsonResponse(response);
      const remoteRef = this.extractCheckpointId(messages)
        ?? (await sprite.listCheckpoints())[0]?.id;

      if (!remoteRef) {
        throw new Error('Checkpoint completed but no checkpoint id was returned');
      }

      return { remoteRef };
    } catch (cause) {
      throw this.wrapSpritesError('SPRITES_CHECKPOINT_FAILED', 'failed to checkpoint sprite', cause);
    }
  }

  async restore(input: {
    spriteId: string;
    remoteRef: string;
  }): Promise<void> {
    this.ensureConfigured();
    try {
      const sprite = this.client.sprite(input.spriteId);
      const response = await sprite.restoreCheckpoint(input.remoteRef);
      await this.consumeNdjsonResponse(response);
    } catch (cause) {
      throw this.wrapSpritesError('SPRITES_RESTORE_FAILED', 'failed to restore sprite checkpoint', cause);
    }
  }

  private ensureConfigured(): void {
    if (!this.config.enabled || this.config.token.trim().length === 0) {
      throw new ExecutionEnvError(
        'execution_env: [SPRITES_NOT_CONFIGURED] sprites.enabled=true and a non-empty token are required',
      );
    }
  }

  private buildSpriteName(metadata: Record<string, string>): string {
    const base = metadata.ownerTaskId ?? metadata.threadId ?? 'env';
    const sanitized = base.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    return `talon-${sanitized || 'env'}-${randomUUID().slice(0, 12)}`;
  }

  private async walkLocalFiles(root: string): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const entryPath = join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.walkLocalFiles(entryPath));
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
    return files;
  }

  private async writeRemoteFile(
    spriteId: string,
    localPath: string,
    remotePath: string,
  ): Promise<number> {
    const bytes = await readFile(localPath);
    const remoteDir = posix.dirname(remotePath);
    const remoteFile = posix.basename(remotePath);
    const response = await fetch(
      `${this.config.apiBaseUrl.replace(/\/+$/, '')}/v1/sprites/${spriteId}/fs/write?${new URLSearchParams({
        path: remoteFile,
        workingDir: remoteDir,
        mkdir: 'true',
      }).toString()}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.config.token}`,
        },
        body: bytes,
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to write remote file (status ${response.status})`);
    }
    return bytes.byteLength;
  }

  private async readRemoteFile(spriteId: string, remotePath: string): Promise<Uint8Array> {
    const remoteDir = posix.dirname(remotePath);
    const remoteFile = posix.basename(remotePath);
    const response = await fetch(
      `${this.config.apiBaseUrl.replace(/\/+$/, '')}/v1/sprites/${spriteId}/fs/read?${new URLSearchParams({
        path: remoteFile,
        workingDir: remoteDir,
      }).toString()}`,
      {
        headers: {
          Authorization: `Bearer ${this.config.token}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to read remote file (status ${response.status})`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  private async consumeNdjsonResponse(response: Response): Promise<Array<Record<string, unknown>>> {
    const text = await response.text();
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  private extractCheckpointId(messages: Array<Record<string, unknown>>): string | null {
    for (const message of messages.reverse()) {
      if (message.type !== 'complete' || typeof message.data !== 'string') {
        continue;
      }
      const match = message.data.match(/Checkpoint\s+([^\s]+)\s+created/i);
      if (match?.[1]) {
        return match[1];
      }
    }
    return null;
  }

  private toText(value: string | Buffer): string {
    return typeof value === 'string' ? value : value.toString('utf8');
  }

  private wrapSpritesError(code: string, message: string, cause: unknown): ExecutionEnvError {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (/status 401|unauthorized/i.test(error.message)) {
      return new ExecutionEnvError(
        `execution_env: [SPRITES_AUTH_FAILED] ${message}: ${error.message}`,
        error,
      );
    }
    return new ExecutionEnvError(`execution_env: [${code}] ${message}: ${error.message}`, error);
  }
}
