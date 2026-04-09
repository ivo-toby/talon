import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type pino from 'pino';

import type { SkillExecInput } from '@talon/skills/script-runner/runner-types.js';
import type { StagedSkillSandbox } from '@talon/skills/skill-sandbox-staging.js';
import type { SkillSandboxProfile } from '@talon/skills/skill-sandbox-schema.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// We need to mock child_process, fs, and output-capture

const mockSpawn = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn((path: string) => path === '/lib64'),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Mock OutputCapture to avoid real file I/O
vi.mock('@talon/skills/script-runner/output-capture.js', () => {
  class MockOutputCapture {
    chunks: Buffer[] = [];
    maxBytes: number;
    constructor(maxBytes: number) {
      this.maxBytes = maxBytes;
    }
    onData(chunk: Buffer): void {
      this.chunks.push(chunk);
    }
    async finalize() {
      return {
        content: Buffer.concat(this.chunks).toString('utf-8'),
        truncated: false,
        artifactPath: null,
      };
    }
  }
  return { OutputCapture: MockOutputCapture };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockLogger(): pino.Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as unknown as pino.Logger;
}

function makeChildProcess(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 12345;
  return child;
}

function makeProfile(overrides: Partial<SkillSandboxProfile> = {}): SkillSandboxProfile {
  return {
    workdir: 'repo',
    mounts: [],
    network: 'off',
    secrets: [],
    env: {},
    bins: ['bash', 'sh', 'ls', 'cat'],
    image: 'talon-skill-runtime:latest',
    shell: '/bin/bash',
    timeoutSeconds: 60,
    resourceLimits: { memoryMb: 1024, cpus: 1, pidsLimit: 256 },
    ...overrides,
  };
}

function makeStaged(overrides: Partial<StagedSkillSandbox> = {}): StagedSkillSandbox {
  return {
    binDir: '/data/skills/test-skill/.bin',
    resolvedBins: {
      bash: '/usr/bin/bash',
      sh: '/usr/bin/sh',
      ls: '/usr/bin/ls',
      cat: '/usr/bin/cat',
    },
    canonicalMounts: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<SkillExecInput> = {}): SkillExecInput {
  return {
    skillName: 'test-skill',
    skillDir: '/skills/test-skill',
    profile: makeProfile(),
    staged: makeStaged(),
    command: 'echo hello',
    context: {
      threadId: 'thread-123',
      personaId: 'persona-1',
      requestId: 'req-abc',
      repoPath: '/home/user/repo',
    },
    resolvedSecrets: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BubblewrapRunner', () => {
  let BubblewrapRunner: typeof import('@talon/skills/script-runner/bubblewrap-runner.js').BubblewrapRunner;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // systemd-run detection: default to not available
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    // Re-import to get fresh module with mocks applied
    const mod = await import('@talon/skills/script-runner/bubblewrap-runner.js');
    BubblewrapRunner = mod.BubblewrapRunner;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('argv construction', () => {
    it('always includes --die-with-parent and --unshare-all', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new BubblewrapRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      // Verify args
      const [bin, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(bin).toBe('bwrap');
      expect(args).toContain('--die-with-parent');
      expect(args).toContain('--unshare-all');

      // Complete the process
      child.stdout.emit('data', Buffer.from(''));
      child.emit('close', 0, null);

      await resultPromise;
    });

    it('includes --share-net when network is on', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new BubblewrapRunner('/data', makeMockLogger());
      const input = makeInput({
        profile: makeProfile({ network: 'on' }),
      });
      const resultPromise = runner.execute(input);

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(args).toContain('--share-net');

      // Also check resolv.conf is bound: --ro-bind /etc/resolv.conf /etc/resolv.conf
      const roBindIdx = args.indexOf('/etc/resolv.conf');
      expect(roBindIdx).toBeGreaterThan(-1);
      expect(args[roBindIdx - 1]).toBe('--ro-bind');
      // source and target are the same path
      expect(args[roBindIdx + 1]).toBe('/etc/resolv.conf');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('omits --share-net and resolv.conf when network is off', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new BubblewrapRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(args).not.toContain('--share-net');
      expect(args).not.toContain('/etc/resolv.conf');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('uses context.repoPath for workdir: repo', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new BubblewrapRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      const bindIdx = args.indexOf('/workspace');
      expect(bindIdx).toBeGreaterThan(-1);
      expect(args[bindIdx - 1]).toBe('/home/user/repo');
      expect(args[bindIdx - 2]).toBe('--bind');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('uses skillDir for workdir: skill-bundle', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new BubblewrapRunner('/data', makeMockLogger());
      const input = makeInput({
        profile: makeProfile({ workdir: 'skill-bundle' }),
      });
      const resultPromise = runner.execute(input);

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      const bindIdx = args.indexOf('/workspace');
      expect(args[bindIdx - 1]).toBe('/skills/test-skill');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('uses absolute path for workdir when neither repo nor skill-bundle', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new BubblewrapRunner('/data', makeMockLogger());
      const input = makeInput({
        profile: makeProfile({ workdir: '/custom/path' }),
      });
      const resultPromise = runner.execute(input);

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      const bindIdx = args.indexOf('/workspace');
      expect(args[bindIdx - 1]).toBe('/custom/path');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('includes canonical mounts with correct flags', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new BubblewrapRunner('/data', makeMockLogger());
      const input = makeInput({
        staged: makeStaged({
          canonicalMounts: [
            { source: '/host/data', target: '/skill/data', mode: 'ro' },
            { source: '/host/output', target: '/skill/output', mode: 'rw' },
          ],
        }),
      });
      const resultPromise = runner.execute(input);

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];

      // ro mount
      const dataIdx = args.indexOf('/skill/data');
      expect(dataIdx).toBeGreaterThan(-1);
      expect(args[dataIdx - 1]).toBe('/host/data');
      expect(args[dataIdx - 2]).toBe('--ro-bind');

      // rw mount
      const outputIdx = args.indexOf('/skill/output');
      expect(outputIdx).toBeGreaterThan(-1);
      expect(args[outputIdx - 1]).toBe('/host/output');
      expect(args[outputIdx - 2]).toBe('--bind');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('sets environment variables from secrets and profile.env', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new BubblewrapRunner('/data', makeMockLogger());
      const input = makeInput({
        profile: makeProfile({
          env: { NODE_ENV: 'production' },
        }),
        resolvedSecrets: { API_KEY: 'secret-value' },
      });
      const resultPromise = runner.execute(input);

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];

      // PATH set to /skill/bin
      const pathIdx = args.indexOf('PATH');
      expect(pathIdx).toBeGreaterThan(-1);
      expect(args[pathIdx - 1]).toBe('--setenv');
      expect(args[pathIdx + 1]).toBe('/skill/bin');

      // HOME set to /tmp
      const homeIdx = args.indexOf('HOME');
      expect(homeIdx).toBeGreaterThan(-1);
      expect(args[homeIdx + 1]).toBe('/tmp');

      // Secret
      const apiKeyIdx = args.indexOf('API_KEY');
      expect(apiKeyIdx).toBeGreaterThan(-1);
      expect(args[apiKeyIdx + 1]).toBe('secret-value');

      // Env var
      const nodeEnvIdx = args.indexOf('NODE_ENV');
      expect(nodeEnvIdx).toBeGreaterThan(-1);
      expect(args[nodeEnvIdx + 1]).toBe('production');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('resolves shell from staged.resolvedBins and uses sandbox path', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new BubblewrapRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];

      // The shell should be the last three args: /skill/bin/bash -c <command>
      // Use lastIndexOf because /skill/bin/bash also appears in per-binary --ro-bind
      const shellIdx = args.lastIndexOf('/skill/bin/bash');
      expect(shellIdx).toBeGreaterThan(-1);
      expect(args[shellIdx + 1]).toBe('-c');
      expect(args[shellIdx + 2]).toBe('echo hello');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('includes /lib64 bind when it exists on host', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new BubblewrapRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];

      // /lib64 should be bound (mocked existsSync returns true for /lib64)
      const lib64Idx = args.lastIndexOf('/lib64');
      expect(lib64Idx).toBeGreaterThan(-1);
      expect(args[lib64Idx - 1]).toBe('/lib64');
      expect(args[lib64Idx - 2]).toBe('--ro-bind');

      child.emit('close', 0, null);
      await resultPromise;
    });
  });

  describe('exit code mapping', () => {
    it('maps exit 0 to success', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new BubblewrapRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      child.emit('close', 0, null);

      const result = await resultPromise;
      expect(result.status).toBe('success');
      expect(result.exitCode).toBe(0);
    });

    it('maps non-zero exit to error', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new BubblewrapRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      child.emit('close', 1, null);

      const result = await resultPromise;
      expect(result.status).toBe('error');
      expect(result.exitCode).toBe(1);
    });

    it('maps signal death to error with exitCode -1', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new BubblewrapRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      child.emit('close', null, 'SIGKILL');

      const result = await resultPromise;
      expect(result.status).toBe('error');
      expect(result.exitCode).toBe(-1);
    });
  });

  describe('timeout', () => {
    it('sends SIGTERM then SIGKILL on timeout', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new BubblewrapRunner('/data', makeMockLogger());
      const input = makeInput({ timeoutSeconds: 5 });
      const resultPromise = runner.execute(input);

      // Advance past timeout (5s)
      await vi.advanceTimersByTimeAsync(5_000);

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      // Advance past grace period (3s)
      await vi.advanceTimersByTimeAsync(3_000);

      expect(child.kill).toHaveBeenCalledWith('SIGKILL');

      // Process eventually exits
      child.emit('close', null, 'SIGKILL');

      const result = await resultPromise;
      expect(result.status).toBe('timeout');
    });
  });

  describe('spawn failure', () => {
    it('returns error result on spawn error', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new BubblewrapRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      const error = new Error('spawn ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      child.emit('error', error);

      const result = await resultPromise;
      expect(result.status).toBe('error');
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain('ENOENT');
    });
  });

  describe('systemd-run wrapping', () => {
    it('wraps with systemd-run when available', async () => {
      // Make systemd-run detection succeed
      mockExecFileSync.mockReturnValue(Buffer.from('systemd 256'));

      const mod = await import('@talon/skills/script-runner/bubblewrap-runner.js');
      const RunnerClass = mod.BubblewrapRunner;

      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new RunnerClass('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      const [bin, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(bin).toBe('systemd-run');
      expect(args).toContain('--scope');
      expect(args).toContain('--user');
      expect(args).toContain('--quiet');
      expect(args).toContain('--property=MemoryMax=1024M');
      expect(args).toContain('--property=CPUQuota=100%');
      expect(args).toContain('--property=TasksMax=256');
      expect(args).toContain('--');
      expect(args[args.indexOf('--') + 1]).toBe('bwrap');

      child.emit('close', 0, null);
      await resultPromise;
    });
  });

  describe('stdout/stderr capture', () => {
    it('captures stdout and stderr', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new BubblewrapRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      child.stdout.emit('data', Buffer.from('output'));
      child.stderr.emit('data', Buffer.from('error msg'));
      child.emit('close', 0, null);

      const result = await resultPromise;
      expect(result.stdout).toBe('output');
      expect(result.stderr).toBe('error msg');
      expect(result.status).toBe('success');
    });
  });

  describe('durationMs', () => {
    it('measures elapsed time', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new BubblewrapRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      // Advance time a bit before completing
      await vi.advanceTimersByTimeAsync(500);
      child.emit('close', 0, null);

      const result = await resultPromise;
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
