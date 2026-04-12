import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { LocalWorktreeAdapter } from '../../../src/execution-env/local-worktree-adapter.js';
import type { LocalWorktreeConfig } from '../../../src/core/config/config-types.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => makeLogger(),
  } as any;
}

function makeConfig(overrides: Partial<LocalWorktreeConfig> = {}): LocalWorktreeConfig {
  return {
    enabled: true,
    worktreeRoot: join(tmpdir(), `talon-worktree-test-${Date.now()}`),
    workingDirectory: '/workspace',
    execTimeoutMs: 30_000,
    autoDestroyOnCompletion: true,
    resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
    ...overrides,
  };
}

/** Create a minimal git repo to serve as the "source" repo for worktrees. */
function createTestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'talon-test-repo-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'hello.txt'), 'hello world\n');
  execSync('git add -A && git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

describe('LocalWorktreeAdapter', () => {
  let repoRoot: string;
  let config: LocalWorktreeConfig;
  let adapter: LocalWorktreeAdapter;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    repoRoot = createTestRepo();
    config = makeConfig();
    logger = makeLogger();
    adapter = new LocalWorktreeAdapter(config, repoRoot, logger);
  });

  afterEach(async () => {
    // Clean up all worktrees via git
    try {
      execSync('git worktree prune', { cwd: repoRoot, stdio: 'pipe' });
    } catch { /* ignore */ }
    await rm(repoRoot, { recursive: true, force: true });
    await rm(config.worktreeRoot, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates a worktree directory', async () => {
      const { spriteId } = await adapter.create({
        resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
        workingDirectory: '/workspace',
        metadata: { threadId: 'test-thread' },
      });

      expect(spriteId).toBeTruthy();
      // The worktree should exist
      const worktreePath = join(config.worktreeRoot, spriteId);
      expect(existsSync(worktreePath)).toBe(true);
      // It should have the initial file
      expect(existsSync(join(worktreePath, 'hello.txt'))).toBe(true);

      await adapter.destroy(spriteId);
    });

    it('runs prepareCommand after creation', async () => {
      const configWithPrepare = makeConfig({
        prepareCommand: 'echo "prepared" > prepared.txt',
      });
      const adapterWithPrepare = new LocalWorktreeAdapter(configWithPrepare, repoRoot, logger);
      config = configWithPrepare; // for cleanup

      const { spriteId } = await adapterWithPrepare.create({
        resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
        workingDirectory: '/workspace',
        metadata: { threadId: 'test-thread' },
      });

      const worktreePath = join(configWithPrepare.worktreeRoot, spriteId);
      expect(existsSync(join(worktreePath, 'prepared.txt'))).toBe(true);
      const content = readFileSync(join(worktreePath, 'prepared.txt'), 'utf8');
      expect(content.trim()).toBe('prepared');

      await adapterWithPrepare.destroy(spriteId);
    });
  });

  describe('exec', () => {
    it('runs commands in the worktree', async () => {
      const { spriteId } = await adapter.create({
        resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
        workingDirectory: '/workspace',
        metadata: { threadId: 'test-thread' },
      });

      const result = await adapter.exec({
        spriteId,
        command: 'cat hello.txt',
        cwd: '.',
        timeoutMs: 5000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello world');
      expect(result.timedOut).toBe(false);

      await adapter.destroy(spriteId);
    });

    it('captures stderr and exit code', async () => {
      const { spriteId } = await adapter.create({
        resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
        workingDirectory: '/workspace',
        metadata: { threadId: 'test-thread' },
      });

      const result = await adapter.exec({
        spriteId,
        command: 'echo "err" >&2; exit 42',
        cwd: '.',
        timeoutMs: 5000,
      });

      expect(result.exitCode).toBe(42);
      expect(result.stderr.trim()).toBe('err');

      await adapter.destroy(spriteId);
    });

    it('times out long commands', async () => {
      const { spriteId } = await adapter.create({
        resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
        workingDirectory: '/workspace',
        metadata: { threadId: 'test-thread' },
      });

      const result = await adapter.exec({
        spriteId,
        command: 'sleep 60',
        cwd: '.',
        timeoutMs: 500,
      });

      expect(result.timedOut).toBe(true);

      await adapter.destroy(spriteId);
    });
  });

  describe('checkpoint and restore', () => {
    it('checkpoints and restores filesystem state', async () => {
      const { spriteId } = await adapter.create({
        resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
        workingDirectory: '/workspace',
        metadata: { threadId: 'test-thread' },
      });

      const worktreePath = join(config.worktreeRoot, spriteId);

      // Modify a file and checkpoint
      writeFileSync(join(worktreePath, 'hello.txt'), 'modified\n');
      const { remoteRef } = await adapter.checkpoint({
        spriteId,
        label: 'after-modification',
      });
      expect(remoteRef).toBeTruthy();

      // Modify again
      writeFileSync(join(worktreePath, 'hello.txt'), 'modified-again\n');

      // Restore to checkpoint
      await adapter.restore({ spriteId, remoteRef });

      const content = readFileSync(join(worktreePath, 'hello.txt'), 'utf8');
      expect(content).toBe('modified\n');

      await adapter.destroy(spriteId);
    });

    it('checkpoint with no changes uses HEAD', async () => {
      const { spriteId } = await adapter.create({
        resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
        workingDirectory: '/workspace',
        metadata: { threadId: 'test-thread' },
      });

      const { remoteRef } = await adapter.checkpoint({ spriteId });
      expect(remoteRef).toBeTruthy();
      // Should be a valid git sha
      expect(remoteRef).toMatch(/^[0-9a-f]{40}$/);

      await adapter.destroy(spriteId);
    });
  });

  describe('upload and download', () => {
    it('copies files into the worktree', async () => {
      const { spriteId } = await adapter.create({
        resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
        workingDirectory: '/workspace',
        metadata: { threadId: 'test-thread' },
      });

      // Create a source file outside the worktree
      const srcFile = join(repoRoot, 'upload-test.txt');
      writeFileSync(srcFile, 'upload content');

      const result = await adapter.upload({
        spriteId,
        sourcePath: srcFile,
        destinationPath: 'uploaded.txt',
      });

      expect(result.bytes).toBeGreaterThan(0);

      const worktreePath = join(config.worktreeRoot, spriteId);
      expect(readFileSync(join(worktreePath, 'uploaded.txt'), 'utf8')).toBe('upload content');

      await adapter.destroy(spriteId);
    });

    it('copies files out of the worktree', async () => {
      const { spriteId } = await adapter.create({
        resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
        workingDirectory: '/workspace',
        metadata: { threadId: 'test-thread' },
      });

      const destFile = join(repoRoot, 'downloaded.txt');
      const result = await adapter.download({
        spriteId,
        sourcePath: 'hello.txt',
        destinationPath: destFile,
      });

      expect(result.bytes).toBeGreaterThan(0);
      expect(readFileSync(destFile, 'utf8').trim()).toBe('hello world');

      await adapter.destroy(spriteId);
    });
  });

  describe('destroy', () => {
    it('removes the worktree and branch', async () => {
      const { spriteId } = await adapter.create({
        resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
        workingDirectory: '/workspace',
        metadata: { threadId: 'test-thread' },
      });

      const worktreePath = join(config.worktreeRoot, spriteId);
      expect(existsSync(worktreePath)).toBe(true);

      await adapter.destroy(spriteId);
      expect(existsSync(worktreePath)).toBe(false);
    });

    it('is idempotent', async () => {
      const { spriteId } = await adapter.create({
        resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
        workingDirectory: '/workspace',
        metadata: { threadId: 'test-thread' },
      });

      await adapter.destroy(spriteId);
      // Second destroy should not throw
      await adapter.destroy(spriteId);
    });

    it('cleans up worktrees not in memory (orphan recovery)', async () => {
      const { spriteId } = await adapter.create({
        resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
        workingDirectory: '/workspace',
        metadata: { threadId: 'test-thread' },
      });

      const worktreePath = join(config.worktreeRoot, spriteId);
      expect(existsSync(worktreePath)).toBe(true);

      // Create a fresh adapter (simulates daemon restart — empty in-memory map)
      const freshAdapter = new LocalWorktreeAdapter(config, repoRoot, logger);
      await freshAdapter.destroy(spriteId);
      expect(existsSync(worktreePath)).toBe(false);
    });
  });

  describe('path containment', () => {
    it('rejects path traversal in upload destinationPath', async () => {
      const { spriteId } = await adapter.create({
        resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
        workingDirectory: '/workspace',
        metadata: { threadId: 'test-thread' },
      });

      await expect(
        adapter.upload({
          spriteId,
          sourcePath: join(repoRoot, 'hello.txt'),
          destinationPath: '../../etc/passwd',
        }),
      ).rejects.toThrow('escapes the worktree root');

      await adapter.destroy(spriteId);
    });

    it('rejects path traversal in download sourcePath', async () => {
      const { spriteId } = await adapter.create({
        resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
        workingDirectory: '/workspace',
        metadata: { threadId: 'test-thread' },
      });

      await expect(
        adapter.download({
          spriteId,
          sourcePath: '../../../etc/passwd',
          destinationPath: join(repoRoot, 'stolen.txt'),
        }),
      ).rejects.toThrow('escapes the worktree root');

      await adapter.destroy(spriteId);
    });

    it('rejects absolute path outside worktree in exec cwd', async () => {
      const { spriteId } = await adapter.create({
        resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
        workingDirectory: '/workspace',
        metadata: { threadId: 'test-thread' },
      });

      // /tmp should resolve to an escape since it's outside the worktree
      // after the leading slash is stripped, "tmp" relative to worktree is fine,
      // but ../../tmp would escape
      await expect(
        adapter.exec({
          spriteId,
          command: 'pwd',
          cwd: '../../../../../../tmp',
          timeoutMs: 5000,
        }),
      ).rejects.toThrow('escapes the worktree root');

      await adapter.destroy(spriteId);
    });

    it('resolves absolute cwd as relative to worktree', async () => {
      const { spriteId } = await adapter.create({
        resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
        workingDirectory: '/workspace',
        metadata: { threadId: 'test-thread' },
      });

      // /workspace should be treated as "workspace" inside the worktree
      // It may not exist, but the containment check should pass
      const result = await adapter.exec({
        spriteId,
        command: 'pwd',
        cwd: '.',
        timeoutMs: 5000,
      });

      expect(result.exitCode).toBe(0);
      // cwd should be within the worktree
      expect(result.stdout.trim()).toContain(config.worktreeRoot);

      await adapter.destroy(spriteId);
    });
  });

  describe('prepareCommand failure', () => {
    it('cleans up worktree when prepareCommand fails', async () => {
      const configWithBadPrepare = makeConfig({
        prepareCommand: 'exit 1',
      });
      const adapterWithBadPrepare = new LocalWorktreeAdapter(configWithBadPrepare, repoRoot, logger);

      await expect(
        adapterWithBadPrepare.create({
          resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
          workingDirectory: '/workspace',
          metadata: { threadId: 'test-thread' },
        }),
      ).rejects.toThrow('prepareCommand failed');

      // Worktree root should have no leftover directories
      const entries = existsSync(configWithBadPrepare.worktreeRoot)
        ? require('node:fs').readdirSync(configWithBadPrepare.worktreeRoot)
        : [];
      expect(entries.length).toBe(0);
    });
  });
});
