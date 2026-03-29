import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  Sprite,
  type SpriteCommand,
  SpritesClient as FlySpritesClient,
} from '@fly/sprites';
import type { SpritesConfig } from '../core/config/config-types.js';
import { ExecutionEnvError } from '../core/errors/error-types.js';
import type { SpritesClientAdapter } from './sprites-client-adapter.js';
import type { ExecutionEnvResourceLimits } from './execution-env-types.js';

const MAX_UPLOAD_DIRECTORY_DEPTH = 32;
const MAX_UPLOAD_FILE_COUNT = 5_000;
const MAX_UPLOAD_TOTAL_BYTES = 256 * 1024 * 1024;
const CHECKPOINT_DISCOVERY_ATTEMPTS = 5;
const CHECKPOINT_DISCOVERY_DELAY_MS = 100;
const SESSION_START_TIMEOUT_MS = 5_000;

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
    if (input.baseSnapshot) {
      throw new ExecutionEnvError(
        'execution_env: [INVALID_ARGUMENT] baseSnapshot is not supported by the current Sprites API/SDK',
      );
    }
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
        const session = sprite.createSession('bash', ['-lc', input.command], {
          cwd: input.cwd,
          ...(input.env ? { env: input.env } : {}),
        });
        const processId = await this.waitForDetachedSessionId(
          session,
          Math.min(input.timeoutMs, SESSION_START_TIMEOUT_MS),
        );
        return {
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          processId,
        };
      }

      return await this.runForegroundCommand(sprite, {
        command: input.command,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        ...(input.env ? { env: input.env } : {}),
      });
    } catch (cause) {
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
    if (await this.remotePathIsDirectory(input.spriteId, input.sourcePath)) {
      throw new ExecutionEnvError(
        'execution_env: [SPRITES_TRANSFER_FAILED] directories are not supported for download; download files individually',
      );
    }

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
      const knownCheckpointIds = new Set((await sprite.listCheckpoints()).map((checkpoint) => checkpoint.id));
      const response = await sprite.createCheckpoint(input.label);
      await this.consumeNdjsonResponse(response, 'checkpoint');
      const remoteRef = await this.resolveCheckpointId(sprite, knownCheckpointIds);

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
      await this.consumeNdjsonResponse(response, 'restore');
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

  private async walkLocalFiles(
    root: string,
    depth = 0,
    state: { files: string[]; totalBytes: number } = { files: [], totalBytes: 0 },
  ): Promise<string[]> {
    if (depth > MAX_UPLOAD_DIRECTORY_DEPTH) {
      throw new Error(
        `Upload exceeds the maximum directory depth of ${MAX_UPLOAD_DIRECTORY_DEPTH}`,
      );
    }

    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(root, entry.name);
      if (entry.isDirectory()) {
        await this.walkLocalFiles(entryPath, depth + 1, state);
      } else if (entry.isFile()) {
        const entryStats = await stat(entryPath);
        state.totalBytes += entryStats.size;
        if (state.totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
          throw new Error(
            `Upload exceeds the maximum size of ${MAX_UPLOAD_TOTAL_BYTES} bytes`,
          );
        }
        state.files.push(entryPath);
        if (state.files.length > MAX_UPLOAD_FILE_COUNT) {
          throw new Error(
            `Upload exceeds the maximum file count of ${MAX_UPLOAD_FILE_COUNT}`,
          );
        }
      }
    }
    return state.files;
  }

  private async runForegroundCommand(
    sprite: Sprite,
    input: {
      command: string;
      cwd: string;
      timeoutMs: number;
      env?: Record<string, string>;
    },
  ): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }> {
    const command = sprite.spawn('bash', ['-lc', input.command], {
      cwd: input.cwd,
      ...(input.env ? { env: input.env } : {}),
    });

    return await new Promise((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        command.stdout.off('data', onStdout);
        command.stderr.off('data', onStderr);
        command.off('exit', onExit);
        command.off('error', onError);
      };

      const finalize = (result: {
        exitCode: number | null;
        stdout: string;
        stderr: string;
        timedOut: boolean;
      }) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      };

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const onStdout = (chunk: Buffer | string) => {
        stdoutChunks.push(this.toBuffer(chunk));
      };
      const onStderr = (chunk: Buffer | string) => {
        stderrChunks.push(this.toBuffer(chunk));
      };
      const onExit = (code: number) => {
        finalize({
          exitCode: code,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          timedOut: false,
        });
      };
      const onError = (error: unknown) => {
        fail(error);
      };

      const timeoutHandle = setTimeout(() => {
        try {
          command.kill();
        } catch {
          // Best effort: closing the session is the only timeout control the current SDK exposes.
        }
        finalize({
          exitCode: null,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          timedOut: true,
        });
      }, Math.max(1, input.timeoutMs));

      command.stdout.on('data', onStdout);
      command.stderr.on('data', onStderr);
      command.on('exit', onExit);
      command.on('error', onError);
    });
  }

  private async waitForDetachedSessionId(
    command: SpriteCommand,
    timeoutMs: number,
  ): Promise<string> {
    return await new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        command.off('message', onMessage);
        command.off('error', onError);
        command.off('exit', onExit);
      };

      const finalize = (result: { ok: true; value: string } | { ok: false; error: Error }) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (result.ok) {
          try {
            command.kill();
          } catch {
            // Detach by closing the local websocket once we have the session id.
          }
          resolve(result.value);
          return;
        }
        reject(result.error);
      };

      const onMessage = (message: unknown) => {
        if (!message || typeof message !== 'object') {
          return;
        }
        const record = message as Record<string, unknown>;
        if (record.type === 'session_info' && typeof record.session_id === 'number') {
          finalize({ ok: true, value: String(record.session_id) });
          return;
        }
        if (record.type === 'error') {
          finalize({
            ok: false,
            error: new Error(this.extractProgressMessage(record) ?? 'Detached session failed to start'),
          });
        }
      };

      const onError = (error: unknown) => {
        finalize({
          ok: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      };

      const onExit = (code: number) => {
        finalize({
          ok: false,
          error: new Error(`Detached session exited before reporting a session id (exit code ${code})`),
        });
      };

      const timeoutHandle = setTimeout(() => {
        try {
          command.kill();
        } catch {
          // Best effort cleanup.
        }
        finalize({
          ok: false,
          error: new Error(`Detached session did not report a session id within ${timeoutMs}ms`),
        });
      }, Math.max(1, timeoutMs));

      command.on('message', onMessage);
      command.on('error', onError);
      command.on('exit', onExit);
    });
  }

  private async writeRemoteFile(
    spriteId: string,
    localPath: string,
    remotePath: string,
  ): Promise<number> {
    const bytes = await readFile(localPath);
    const response = await this.requestFilesystem(spriteId, 'write', remotePath, {
      method: 'PUT',
      body: bytes,
      searchParams: {
        mkdir: 'true',
      },
    });
    await this.assertOk(response, 'write remote file');
    return bytes.byteLength;
  }

  private async readRemoteFile(spriteId: string, remotePath: string): Promise<Uint8Array> {
    const response = await this.requestFilesystem(spriteId, 'read', remotePath, {
      method: 'GET',
    });
    await this.assertOk(response, 'read remote file');

    return new Uint8Array(await response.arrayBuffer());
  }

  private async remotePathIsDirectory(spriteId: string, remotePath: string): Promise<boolean> {
    const response = await this.requestFilesystem(spriteId, 'list', remotePath, {
      method: 'GET',
    });
    if (response.status === 404) {
      return false;
    }
    await this.assertOk(response, 'inspect remote path');
    return true;
  }

  private async consumeNdjsonResponse(
    response: Response,
    operation: string,
  ): Promise<Array<Record<string, unknown>>> {
    const text = await response.text();
    const messages = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const errorMessage = messages
      .filter((message) => message.type === 'error')
      .map((message) => this.extractProgressMessage(message))
      .find((message): message is string => Boolean(message));
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    if (!messages.some((message) => message.type === 'complete')) {
      throw new Error(`${operation} did not report completion`);
    }
    return messages;
  }

  private async resolveCheckpointId(
    sprite: Sprite,
    knownCheckpointIds: Set<string>,
  ): Promise<string> {
    for (let attempt = 0; attempt < CHECKPOINT_DISCOVERY_ATTEMPTS; attempt += 1) {
      const checkpoints = await sprite.listCheckpoints();
      const newCheckpointIds = checkpoints
        .map((checkpoint) => checkpoint.id)
        .filter((id) => !knownCheckpointIds.has(id));

      if (newCheckpointIds.length === 1) {
        return newCheckpointIds[0];
      }
      if (newCheckpointIds.length > 1) {
        throw new Error('Checkpoint completed but multiple new checkpoints were created; checkpoint id is ambiguous');
      }
      if (attempt < CHECKPOINT_DISCOVERY_ATTEMPTS - 1) {
        await sleep(CHECKPOINT_DISCOVERY_DELAY_MS);
      }
    }
    throw new Error('Checkpoint completed but no new checkpoint id was returned');
  }

  private async requestFilesystem(
    spriteId: string,
    operation: string,
    remotePath: string,
    init: {
      method: 'GET' | 'PUT';
      body?: BodyInit;
      searchParams?: Record<string, string>;
    },
  ): Promise<Response> {
    const baseUrl = (this.client.baseURL || this.config.apiBaseUrl).replace(/\/+$/, '');
    const token = this.client.token || this.config.token;
    const url = new URL(`/v1/sprites/${spriteId}/fs/${operation}`, `${baseUrl}/`);
    url.searchParams.set('path', posix.basename(remotePath));
    url.searchParams.set('workingDir', posix.dirname(remotePath));
    for (const [key, value] of Object.entries(init.searchParams ?? {})) {
      url.searchParams.set(key, value);
    }

    return await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
      },
      ...(init.body ? { body: init.body } : {}),
    });
  }

  private async assertOk(response: Response, action: string): Promise<void> {
    if (response.ok) {
      return;
    }
    const body = await response.text();
    throw new Error(`Failed to ${action} (status ${response.status}): ${body}`);
  }

  private extractProgressMessage(message: Record<string, unknown>): string | null {
    if (typeof message.data === 'string') {
      return message.data;
    }
    if (typeof message.message === 'string') {
      return message.message;
    }
    return null;
  }

  private toBuffer(value: string | Uint8Array): Buffer {
    return typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
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
