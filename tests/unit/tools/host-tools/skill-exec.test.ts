import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from 'neverthrow';
import { SkillExecHandler } from '../../../../src/tools/host-tools/skill-exec.js';
import type { SkillExecArgs } from '../../../../src/tools/host-tools/skill-exec.js';
import type { ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import type { LoadedSkill } from '../../../../src/skills/skill-types.js';
import type { SkillScriptRunner, SkillExecResult } from '../../../../src/skills/script-runner/runner-types.js';
import type { SecretStore } from '../../../../src/core/secrets/index.js';
import { SecretError } from '../../../../src/core/secrets/index.js';
import type { AuditLogger, AuditEntry } from '../../../../src/core/logging/audit-logger.js';
import type { SkillSandboxProfile } from '../../../../src/skills/skill-sandbox-schema.js';
import type { StagedSkillSandbox } from '../../../../src/skills/skill-sandbox-staging.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

function makeSandboxProfile(overrides: Partial<SkillSandboxProfile> = {}): SkillSandboxProfile {
  return {
    workdir: 'repo',
    mounts: [],
    network: 'off',
    secrets: ['MY_SECRET'],
    env: {},
    bins: ['bash', 'sh', 'ls', 'cat'],
    image: 'talon-skill-runtime:latest',
    shell: '/bin/bash',
    timeoutSeconds: 60,
    resourceLimits: { memoryMb: 1024, cpus: 1, pidsLimit: 256 },
    ...overrides,
  };
}

function makeStagedSandbox(overrides: Partial<StagedSkillSandbox> = {}): StagedSkillSandbox {
  return {
    binDir: '/data/skills/test-skill/.bin',
    resolvedBins: { bash: '/usr/bin/bash', sh: '/usr/bin/sh', ls: '/usr/bin/ls', cat: '/usr/bin/cat' },
    canonicalMounts: [
      { source: '/home/user/project', target: '/workspace', mode: 'rw' },
    ],
    ...overrides,
  };
}

function makeLoadedSkill(
  name: string,
  sandbox: SkillSandboxProfile | undefined,
  staged: StagedSkillSandbox | null,
): LoadedSkill {
  return {
    manifest: {
      name,
      version: '1.0.0',
      description: `Skill ${name}`,
      requiredCapabilities: [`skill.exec:${name}`],
      promptFragments: [],
      toolManifests: [],
      mcpServers: [],
      migrations: [],
      sandbox,
    },
    skillDir: `/data/skills/${name}`,
    format: 'skillmd',
    promptContents: [],
    resolvedToolManifests: [],
    resolvedMcpServers: [],
    migrationPaths: [],
    stagedSandbox: staged,
  };
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: 'run-1',
    threadId: 'thread-1',
    personaId: 'persona-1',
    requestId: 'req-1',
    ...overrides,
  };
}

function makeSuccessResult(overrides: Partial<SkillExecResult> = {}): SkillExecResult {
  return {
    status: 'success',
    exitCode: 0,
    stdout: 'hello world',
    stderr: '',
    durationMs: 123,
    truncated: false,
    artifactPath: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Deps factory
// ---------------------------------------------------------------------------

function makeDeps() {
  const profile = makeSandboxProfile();
  const staged = makeStagedSandbox();
  const skill = makeLoadedSkill('test-skill', profile, staged);

  const runner: SkillScriptRunner = {
    backend: 'bubblewrap',
    execute: vi.fn<(input: unknown) => Promise<SkillExecResult>>().mockResolvedValue(makeSuccessResult()),
  };

  const secretStore: SecretStore = {
    resolve: vi.fn().mockReturnValue(ok({ MY_SECRET: 'secret-value' })),
  };

  const auditEntries: AuditEntry[] = [];
  const auditLogger = {
    logToolExecution: vi.fn((entry: AuditEntry) => auditEntries.push(entry)),
  } as unknown as AuditLogger;

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as import('pino').Logger;

  const getLoadedSkill = vi.fn<(name: string, _pid: string) => LoadedSkill | undefined>().mockReturnValue(skill);
  const getPersonaRepoPath = vi.fn<(_pid: string) => string | undefined>().mockReturnValue('/home/user/project');

  return {
    deps: {
      runner,
      secretStore,
      auditLogger,
      logger,
      getLoadedSkill,
      getPersonaRepoPath,
      dataDir: '/data',
    },
    mocks: {
      runner,
      secretStore,
      auditLogger,
      getLoadedSkill,
      getPersonaRepoPath,
      auditEntries,
      skill,
      profile,
      staged,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillExecHandler', () => {
  let handler: SkillExecHandler;
  let mocks: ReturnType<typeof makeDeps>['mocks'];
  let deps: ReturnType<typeof makeDeps>['deps'];

  beforeEach(() => {
    const created = makeDeps();
    handler = new SkillExecHandler(created.deps);
    mocks = created.mocks;
    deps = created.deps;
  });

  // -------------------------------------------------------------------------
  // Static manifest
  // -------------------------------------------------------------------------

  it('has a static manifest with correct shape', () => {
    expect(SkillExecHandler.manifest).toEqual({
      name: 'skill.exec',
      description: 'Execute a command in a skill sandbox',
      capabilities: ['skill.exec'],
      executionLocation: 'host',
    });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('happy path: executes command, returns result, writes audit', async () => {
    const args: SkillExecArgs = { skillName: 'test-skill', command: 'echo hello' };
    const ctx = makeContext();

    const result = await handler.execute(args, ctx);

    // Runner was called with correct input
    expect(mocks.runner.execute).toHaveBeenCalledOnce();
    const input = vi.mocked(mocks.runner.execute).mock.calls[0]![0];
    expect(input).toMatchObject({
      skillName: 'test-skill',
      skillDir: '/data/skills/test-skill',
      command: 'echo hello',
      timeoutSeconds: 60,
      context: {
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
        repoPath: '/home/user/project',
      },
    });

    // Secrets were resolved
    expect(mocks.secretStore.resolve).toHaveBeenCalledWith(
      ['MY_SECRET'],
      { personaId: 'persona-1', skillName: 'test-skill' },
    );

    // Result shape
    expect(result.status).toBe('success');
    expect(result.tool).toBe('skill.exec');
    expect(result.requestId).toBe('req-1');
    expect(result.result).toEqual({
      status: 'success',
      exitCode: 0,
      stdout: 'hello world',
      stderr: '',
      durationMs: 123,
      truncated: false,
      artifactPath: null,
    });

    // Audit logged
    expect(mocks.auditLogger.logToolExecution).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Validation error paths
  // -------------------------------------------------------------------------

  it('returns error when skill not found', async () => {
    mocks.getLoadedSkill.mockReturnValue(undefined);

    const result = await handler.execute(
      { skillName: 'nonexistent', command: 'ls' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('not loaded for persona');
    expect(mocks.runner.execute).not.toHaveBeenCalled();
  });

  it('returns error when stagedSandbox is null', async () => {
    const skill = makeLoadedSkill('test-skill', makeSandboxProfile(), null);
    mocks.getLoadedSkill.mockReturnValue(skill);

    const result = await handler.execute(
      { skillName: 'test-skill', command: 'ls' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('sandbox staging failed');
    expect(result.error).toContain('test-skill_exec unavailable');
    expect(mocks.runner.execute).not.toHaveBeenCalled();
  });

  it('returns error when skill has no sandbox configuration', async () => {
    const skill = makeLoadedSkill('test-skill', undefined, makeStagedSandbox());
    mocks.getLoadedSkill.mockReturnValue(skill);

    const result = await handler.execute(
      { skillName: 'test-skill', command: 'ls' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('no sandbox configuration');
    expect(mocks.runner.execute).not.toHaveBeenCalled();
  });

  it('returns error when workdir is repo but no repoPath', async () => {
    mocks.getPersonaRepoPath.mockReturnValue(undefined);

    const result = await handler.execute(
      { skillName: 'test-skill', command: 'ls' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('no repoPath configured');
    expect(mocks.runner.execute).not.toHaveBeenCalled();
  });

  it('returns error when secret resolution fails', async () => {
    vi.mocked(mocks.secretStore.resolve).mockReturnValue(
      err(new SecretError(['MISSING_KEY', 'ANOTHER_KEY'])),
    );

    const result = await handler.execute(
      { skillName: 'test-skill', command: 'ls' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('MISSING_KEY');
    expect(result.error).toContain('ANOTHER_KEY');
    expect(mocks.runner.execute).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Runner result propagation
  // -------------------------------------------------------------------------

  it('returns error when runner throws', async () => {
    vi.mocked(mocks.runner.execute).mockRejectedValue(new Error('bwrap not found'));

    const result = await handler.execute(
      { skillName: 'test-skill', command: 'ls' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('runner error');
    expect(result.error).toContain('bwrap not found');
    // Audit should NOT be written when runner throws
    expect(mocks.auditLogger.logToolExecution).not.toHaveBeenCalled();
  });

  it('propagates timeout status from runner', async () => {
    vi.mocked(mocks.runner.execute).mockResolvedValue(
      makeSuccessResult({ status: 'timeout', exitCode: -1, stdout: '', stderr: 'killed' }),
    );

    const result = await handler.execute(
      { skillName: 'test-skill', command: 'sleep 999' },
      makeContext(),
    );

    expect(result.status).toBe('timeout');
    expect((result.result as Record<string, unknown>).exitCode).toBe(-1);
  });

  it('propagates non-zero exit code as error status', async () => {
    vi.mocked(mocks.runner.execute).mockResolvedValue(
      makeSuccessResult({ status: 'error', exitCode: 1, stderr: 'command not found' }),
    );

    const result = await handler.execute(
      { skillName: 'test-skill', command: 'bad-command' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect((result.result as Record<string, unknown>).exitCode).toBe(1);
    expect((result.result as Record<string, unknown>).stderr).toBe('command not found');
  });

  // -------------------------------------------------------------------------
  // Audit log shape
  // -------------------------------------------------------------------------

  it('audit entry has all expected fields with correct values', async () => {
    const runnerResult = makeSuccessResult({
      stdout: 'output-text',
      stderr: 'error-text',
      exitCode: 0,
      durationMs: 456,
      truncated: true,
      artifactPath: '/data/artifacts/test.log',
    });
    vi.mocked(mocks.runner.execute).mockResolvedValue(runnerResult);

    await handler.execute(
      { skillName: 'test-skill', command: 'echo test' },
      makeContext(),
    );

    expect(mocks.auditLogger.logToolExecution).toHaveBeenCalledOnce();
    const entry = vi.mocked(mocks.auditLogger.logToolExecution).mock.calls[0]![0];

    expect(entry.runId).toBe('run-1');
    expect(entry.threadId).toBe('thread-1');
    expect(entry.personaId).toBe('persona-1');
    expect(entry.action).toBe('skill.exec');
    expect(entry.tool).toBe('test-skill_exec');
    expect(entry.requestId).toBe('req-1');

    const details = entry.details;
    expect(details.skillName).toBe('test-skill');
    expect(details.command).toBe('echo test');
    expect(details.exitCode).toBe(0);
    expect(details.durationMs).toBe(456);
    expect(details.timeoutSeconds).toBe(60);
    expect(details.network).toBe('off');
    expect(details.truncated).toBe(true);
    expect(details.artifactPath).toBe('/data/artifacts/test.log');

    // Secret names only, never values
    expect(details.secretsUsed).toEqual(['MY_SECRET']);

    // Bins list
    expect(details.bins).toEqual(['bash', 'sh', 'ls', 'cat']);

    // Mounts: targets and modes only, no sources
    expect(details.mounts).toEqual([
      { target: '/workspace', mode: 'rw' },
    ]);
  });

  // -------------------------------------------------------------------------
  // SHA-256 hashes
  // -------------------------------------------------------------------------

  it('stdout/stderr hashes are correct SHA-256', async () => {
    const stdout = 'hello from skill';
    const stderr = 'some warning';
    vi.mocked(mocks.runner.execute).mockResolvedValue(
      makeSuccessResult({ stdout, stderr }),
    );

    await handler.execute(
      { skillName: 'test-skill', command: 'run' },
      makeContext(),
    );

    const entry = vi.mocked(mocks.auditLogger.logToolExecution).mock.calls[0]![0];
    expect(entry.details.stdoutHash).toBe(sha256(stdout));
    expect(entry.details.stderrHash).toBe(sha256(stderr));
  });

  // -------------------------------------------------------------------------
  // workdir: skill-bundle
  // -------------------------------------------------------------------------

  it('passes null repoPath when workdir is skill-bundle', async () => {
    const profile = makeSandboxProfile({ workdir: 'skill-bundle', secrets: [] });
    const skill = makeLoadedSkill('bundle-skill', profile, makeStagedSandbox());
    mocks.getLoadedSkill.mockReturnValue(skill);
    vi.mocked(deps.secretStore.resolve).mockReturnValue(ok({}));

    await handler.execute(
      { skillName: 'bundle-skill', command: 'ls' },
      makeContext(),
    );

    const input = vi.mocked(mocks.runner.execute).mock.calls[0]![0];
    expect(input.context.repoPath).toBeNull();
    // Should NOT call getPersonaRepoPath for skill-bundle workdir
    // (it may be called but the result is not used)
  });

  // -------------------------------------------------------------------------
  // timeoutSeconds override
  // -------------------------------------------------------------------------

  it('uses args.timeoutSeconds when provided', async () => {
    await handler.execute(
      { skillName: 'test-skill', command: 'ls', timeoutSeconds: 30 },
      makeContext(),
    );

    const input = vi.mocked(mocks.runner.execute).mock.calls[0]![0];
    expect(input.timeoutSeconds).toBe(30);
  });

  it('falls back to profile.timeoutSeconds when args omit it', async () => {
    await handler.execute(
      { skillName: 'test-skill', command: 'ls' },
      makeContext(),
    );

    const input = vi.mocked(mocks.runner.execute).mock.calls[0]![0];
    expect(input.timeoutSeconds).toBe(60);
  });

  // -------------------------------------------------------------------------
  // Missing requestId defaults to 'unknown'
  // -------------------------------------------------------------------------

  it('defaults requestId to unknown when not in context', async () => {
    const result = await handler.execute(
      { skillName: 'test-skill', command: 'ls' },
      makeContext({ requestId: undefined }),
    );

    expect(result.requestId).toBe('unknown');
  });
});
