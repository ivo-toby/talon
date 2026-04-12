/**
 * Local git-worktree-based execution environment adapter.
 *
 * Implements the same SpritesClientAdapter interface so ExecutionEnvManager
 * can drive it identically to the remote Sprites provider. Uses git worktrees
 * for filesystem isolation, git commits for checkpoints, and git checkout for
 * restore.
 */

import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve, isAbsolute, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type pino from 'pino';
import type { SpritesClientAdapter } from './sprites-client-adapter.js';
import type { ExecutionEnvResourceLimits } from './execution-env-types.js';
import type { LocalWorktreeConfig } from '../core/config/config-types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorktreeInfo {
  id: string;
  path: string;
  branch: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// LocalWorktreeAdapter
// ---------------------------------------------------------------------------

export class LocalWorktreeAdapter implements SpritesClientAdapter {
  /** Track worktrees by their sprite-equivalent ID. */
  private readonly worktrees = new Map<string, WorktreeInfo>();

  constructor(
    private readonly config: LocalWorktreeConfig,
    private readonly repoRoot: string,
    private readonly logger: pino.Logger,
  ) {}

  async create(input: {
    baseSnapshot?: string;
    resourceLimits: ExecutionEnvResourceLimits;
    workingDirectory: string;
    metadata: Record<string, string>;
  }): Promise<{ spriteId: string }> {
    const id = this.generateId(input.metadata);
    const branch = `talon-env/${id}`;
    const worktreePath = resolve(this.config.worktreeRoot, id);

    await mkdir(this.config.worktreeRoot, { recursive: true });

    // Create an orphan branch so the worktree starts clean from HEAD
    await this.git(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], this.repoRoot);

    this.logger.info(
      { envId: id, path: worktreePath, branch },
      'local-worktree: created',
    );

    // Run the prepare command if configured (e.g. npm ci)
    if (this.config.prepareCommand) {
      this.logger.info(
        { envId: id, command: this.config.prepareCommand },
        'local-worktree: running prepare command',
      );
      const result = await this.runCommand(
        this.config.prepareCommand,
        worktreePath,
        this.config.execTimeoutMs,
      );
      if (result.exitCode !== 0) {
        // Clean up the worktree on prepare failure
        this.logger.warn(
          { envId: id, exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
          'local-worktree: prepareCommand failed, cleaning up',
        );
        await this.git(['worktree', 'remove', worktreePath, '--force'], this.repoRoot).catch(() => {});
        await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
        await this.git(['branch', '-D', branch], this.repoRoot).catch(() => {});
        throw new Error(
          `local-worktree: prepareCommand failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
        );
      }
    }

    this.worktrees.set(id, {
      id,
      path: worktreePath,
      branch,
      createdAt: Date.now(),
    });

    return { spriteId: id };
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
    const worktree = this.requireWorktree(input.spriteId);

    // All cwd paths are resolved relative to the worktree root.
    // Absolute paths like /workspace are treated as relative to the worktree.
    const cwdInput = isAbsolute(input.cwd)
      ? input.cwd.replace(/^\/+/, '')
      : input.cwd;
    const cwd = this.resolveEnvPath(worktree.path, cwdInput || '.');

    if (input.detach) {
      const child = spawn('bash', ['-lc', input.command], {
        cwd,
        env: { ...process.env, ...input.env },
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      const processId = String(child.pid ?? randomUUID());
      return {
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        processId,
      };
    }

    return await this.runCommand(
      input.command,
      cwd,
      input.timeoutMs,
      input.env,
    );
  }

  async upload(input: {
    spriteId: string;
    sourcePath: string;
    destinationPath: string;
    recursive?: boolean;
  }): Promise<{ bytes: number }> {
    const worktree = this.requireWorktree(input.spriteId);
    const dest = this.resolveEnvPath(worktree.path, input.destinationPath);

    const sourceStats = await stat(input.sourcePath);
    if (sourceStats.isDirectory() && !input.recursive) {
      throw new Error('recursive=true is required to upload directories');
    }

    await mkdir(join(dest, '..'), { recursive: true });
    await cp(input.sourcePath, dest, { recursive: input.recursive ?? false });

    const destStats = await stat(dest).catch(() => null);
    return { bytes: destStats?.size ?? sourceStats.size };
  }

  async download(input: {
    spriteId: string;
    sourcePath: string;
    destinationPath: string;
    overwrite?: boolean;
  }): Promise<{ bytes: number }> {
    const worktree = this.requireWorktree(input.spriteId);
    const src = this.resolveEnvPath(worktree.path, input.sourcePath);

    if (!input.overwrite) {
      const exists = await stat(input.destinationPath).catch(() => null);
      if (exists) {
        throw new Error(`destination "${input.destinationPath}" already exists and overwrite is false`);
      }
    }

    await mkdir(join(input.destinationPath, '..'), { recursive: true });
    await cp(src, input.destinationPath, { recursive: true });

    const srcStats = await stat(src);
    return { bytes: srcStats.size };
  }

  async checkpoint(input: {
    spriteId: string;
    label?: string;
  }): Promise<{ remoteRef: string }> {
    const worktree = this.requireWorktree(input.spriteId);
    const label = input.label ?? `checkpoint-${Date.now()}`;

    // Stage all changes including ignored files (e.g. node_modules, build outputs)
    await this.git(['add', '-Af'], worktree.path);

    // Check if there are changes to commit
    const { stdout: statusOut } = await execFileAsync(
      'git', ['status', '--porcelain'], { cwd: worktree.path },
    );

    let commitSha: string;
    if (statusOut.trim().length === 0) {
      // No changes — use current HEAD as the checkpoint
      const { stdout: headSha } = await execFileAsync(
        'git', ['rev-parse', 'HEAD'], { cwd: worktree.path },
      );
      commitSha = headSha.trim();
      this.logger.info(
        { envId: input.spriteId, sha: commitSha, label },
        'local-worktree: checkpoint (no changes, using HEAD)',
      );
    } else {
      await this.git(
        ['commit', '-m', `checkpoint: ${label}`, '--allow-empty'],
        worktree.path,
      );

      const { stdout: sha } = await execFileAsync(
        'git', ['rev-parse', 'HEAD'], { cwd: worktree.path },
      );
      commitSha = sha.trim();
      this.logger.info(
        { envId: input.spriteId, sha: commitSha, label },
        'local-worktree: checkpoint created',
      );
    }

    return { remoteRef: commitSha };
  }

  async restore(input: {
    spriteId: string;
    remoteRef: string;
  }): Promise<void> {
    const worktree = this.requireWorktree(input.spriteId);

    // Hard reset to the checkpoint commit
    await this.git(['checkout', input.remoteRef, '--', '.'], worktree.path);
    await this.git(['clean', '-fdx'], worktree.path);

    this.logger.info(
      { envId: input.spriteId, ref: input.remoteRef },
      'local-worktree: restored',
    );
  }

  async destroy(spriteId: string): Promise<void> {
    const tracked = this.worktrees.get(spriteId);

    // Derive path and branch even if not in the in-memory map (e.g. after restart)
    const worktreePath = tracked?.path ?? resolve(this.config.worktreeRoot, spriteId);
    const branch = tracked?.branch ?? `talon-env/${spriteId}`;

    // Check if the worktree directory actually exists
    const exists = await stat(worktreePath).catch(() => null);
    if (!exists && !tracked) {
      return; // Nothing to clean up
    }

    try {
      await this.git(
        ['worktree', 'remove', worktreePath, '--force'],
        this.repoRoot,
      );
    } catch {
      // If worktree remove fails, try manual cleanup
      await rm(worktreePath, { recursive: true, force: true });
      await this.git(['worktree', 'prune'], this.repoRoot).catch(() => {});
    }

    // Delete the branch
    try {
      await this.git(['branch', '-D', branch], this.repoRoot);
    } catch {
      // Branch may not exist if worktree was created from detached HEAD
    }

    this.worktrees.delete(spriteId);
    this.logger.info({ envId: spriteId }, 'local-worktree: destroyed');
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private generateId(metadata: Record<string, string>): string {
    const base = metadata.ownerTaskId ?? metadata.threadId ?? 'env';
    const sanitized = base.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    return `${sanitized || 'env'}-${randomUUID().slice(0, 12)}`;
  }

  private requireWorktree(spriteId: string): WorktreeInfo {
    const worktree = this.worktrees.get(spriteId);
    if (!worktree) {
      throw new Error(`local-worktree: environment "${spriteId}" not found`);
    }
    return worktree;
  }

  /**
   * Resolve a path to be contained within the worktree.
   * Both absolute and relative paths are confined — `../../etc/passwd` is rejected.
   */
  private resolveEnvPath(worktreePath: string, envPath: string): string {
    const resolved = isAbsolute(envPath)
      ? resolve(envPath)
      : resolve(worktreePath, envPath);
    const rel = relative(worktreePath, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `local-worktree: path "${envPath}" escapes the worktree root`,
      );
    }
    return resolved;
  }

  private async git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    const result = await execFileAsync('git', args, {
      cwd,
      timeout: 30_000,
      env: {
        ...process.env,
        // Prevent git from prompting for credentials
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    return { stdout: result.stdout, stderr: result.stderr };
  }

  private async runCommand(
    command: string,
    cwd: string,
    timeoutMs: number,
    env?: Record<string, string>,
  ): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }> {
    return new Promise((resolvePromise) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let timedOut = false;

      const child = spawn('bash', ['-lc', command], {
        cwd,
        env: { ...process.env, ...env },
      });

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // Force kill after 5s if still alive
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolvePromise({
          exitCode: code,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          timedOut,
        });
      };

      child.on('exit', (code) => finish(code));
      child.on('error', () => finish(null));
    });
  }
}
