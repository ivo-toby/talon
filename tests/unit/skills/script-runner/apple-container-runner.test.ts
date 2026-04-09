// Integration tests require macOS 15+ with Apple Silicon and container CLI — manual only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type pino from 'pino';

import type { SkillExecInput } from '@talon/skills/script-runner/runner-types.js';
import type { StagedSkillSandbox } from '@talon/skills/skill-sandbox-staging.js';
import type { SkillSandboxProfile } from '@talon/skills/skill-sandbox-schema.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSpawn = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
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

describe('AppleContainerRunner', () => {
  let AppleContainerRunner: typeof import('@talon/skills/script-runner/apple-container-runner.js').AppleContainerRunner;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    const mod = await import('@talon/skills/script-runner/apple-container-runner.js');
    AppleContainerRunner = mod.AppleContainerRunner;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('argv construction', () => {
    it('starts with container run --rm', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new AppleContainerRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      const [bin, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(bin).toBe('container');
      expect(args[0]).toBe('run');
      expect(args[1]).toBe('--rm');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('includes correct --volume mounts for workdir, skill, and individual bins', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new AppleContainerRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];

      // Workdir volume
      expect(args).toContain('/home/user/repo:/workspace');

      // Skill bundle volume (read-only)
      expect(args).toContain('/skills/test-skill:/skill:ro');

      // Individual binary volumes (not the whole binDir)
      expect(args).toContain('/usr/bin/bash:/skill/bin/bash:ro');
      expect(args).toContain('/usr/bin/sh:/skill/bin/sh:ro');
      expect(args).toContain('/usr/bin/ls:/skill/bin/ls:ro');
      expect(args).toContain('/usr/bin/cat:/skill/bin/cat:ro');

      // Should NOT mount the binDir as a whole
      expect(args).not.toContain('/data/skills/test-skill/.bin:/skill/bin:ro');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('maps network off to --network none', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new AppleContainerRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      const netIdx = args.indexOf('--network');
      expect(netIdx).toBeGreaterThan(-1);
      expect(args[netIdx + 1]).toBe('none');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('maps network on to --network bridge', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new AppleContainerRunner('/data', makeMockLogger());
      const input = makeInput({
        profile: makeProfile({ network: 'on' }),
      });
      const resultPromise = runner.execute(input);

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      const netIdx = args.indexOf('--network');
      expect(netIdx).toBeGreaterThan(-1);
      expect(args[netIdx + 1]).toBe('bridge');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('uses context.repoPath for workdir: repo', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new AppleContainerRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(args).toContain('/home/user/repo:/workspace');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('uses skillDir for workdir: skill-bundle', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new AppleContainerRunner('/data', makeMockLogger());
      const input = makeInput({
        profile: makeProfile({ workdir: 'skill-bundle' }),
      });
      const resultPromise = runner.execute(input);

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(args).toContain('/skills/test-skill:/workspace');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('uses absolute path for workdir when neither repo nor skill-bundle', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new AppleContainerRunner('/data', makeMockLogger());
      const input = makeInput({
        profile: makeProfile({ workdir: '/custom/path' }),
      });
      const resultPromise = runner.execute(input);

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(args).toContain('/custom/path:/workspace');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('includes canonical mounts with correct mode suffix', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new AppleContainerRunner('/data', makeMockLogger());
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

      expect(args).toContain('/host/data:/skill/data:ro');
      expect(args).toContain('/host/output:/skill/output:rw');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('sets environment variables from secrets and profile.env', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new AppleContainerRunner('/data', makeMockLogger());
      const input = makeInput({
        profile: makeProfile({
          env: { NODE_ENV: 'production' },
        }),
        resolvedSecrets: { API_KEY: 'secret-value' },
      });
      const resultPromise = runner.execute(input);

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];

      expect(args).toContain('HOME=/tmp');
      expect(args).toContain('PATH=/skill/bin');
      expect(args).toContain('API_KEY=secret-value');
      expect(args).toContain('NODE_ENV=production');

      // All env values should be preceded by --env
      for (const envVal of ['HOME=/tmp', 'PATH=/skill/bin', 'API_KEY=secret-value', 'NODE_ENV=production']) {
        const idx = args.indexOf(envVal);
        expect(args[idx - 1]).toBe('--env');
      }

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('includes --workdir /workspace', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new AppleContainerRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      const wdIdx = args.indexOf('--workdir');
      expect(wdIdx).toBeGreaterThan(-1);
      expect(args[wdIdx + 1]).toBe('/workspace');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('includes --image with the profile image', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new AppleContainerRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      const imgIdx = args.indexOf('--image');
      expect(imgIdx).toBeGreaterThan(-1);
      expect(args[imgIdx + 1]).toBe('talon-skill-runtime:latest');

      child.emit('close', 0, null);
      await resultPromise;
    });

    it('uses shell basename from profile.shell and appends -c command', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new AppleContainerRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];

      // Last three args: /skill/bin/bash -c "echo hello"
      const shellIdx = args.indexOf('/skill/bin/bash');
      expect(shellIdx).toBeGreaterThan(-1);
      expect(args[shellIdx + 1]).toBe('-c');
      expect(args[shellIdx + 2]).toBe('echo hello');

      child.emit('close', 0, null);
      await resultPromise;
    });
  });

  describe('exit code mapping', () => {
    it('maps exit 0 to success', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new AppleContainerRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      child.emit('close', 0, null);

      const result = await resultPromise;
      expect(result.status).toBe('success');
      expect(result.exitCode).toBe(0);
    });

    it('maps non-zero exit to error', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new AppleContainerRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      child.emit('close', 1, null);

      const result = await resultPromise;
      expect(result.status).toBe('error');
      expect(result.exitCode).toBe(1);
    });

    it('maps signal death to error with exitCode -1', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new AppleContainerRunner('/data', makeMockLogger());
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

      const runner = new AppleContainerRunner('/data', makeMockLogger());
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

      const runner = new AppleContainerRunner('/data', makeMockLogger());
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

  describe('stdout/stderr capture', () => {
    it('captures stdout and stderr', async () => {
      const child = makeChildProcess();
      mockSpawn.mockReturnValue(child);

      const runner = new AppleContainerRunner('/data', makeMockLogger());
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

      const runner = new AppleContainerRunner('/data', makeMockLogger());
      const resultPromise = runner.execute(makeInput());

      await vi.advanceTimersByTimeAsync(500);
      child.emit('close', 0, null);

      const result = await resultPromise;
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('resource limits', () => {
    it('logs debug message about unsupported resource limits', () => {
      const logger = makeMockLogger();
      new AppleContainerRunner('/data', logger);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('resource limits are not enforced'),
      );
    });
  });
});
