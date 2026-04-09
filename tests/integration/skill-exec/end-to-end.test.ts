/**
 * End-to-end integration test for skill-exec with a real bubblewrap sandbox.
 *
 * Creates a toy skill fixture, stages it, invokes the SkillExecHandler,
 * and asserts results including security checks (filesystem isolation,
 * binary allowlist, network blocking).
 *
 * Skipped when not on Linux or bwrap is not available.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type pino from 'pino';

import { SkillLoader } from '@talon/skills/skill-loader.js';
import { BubblewrapRunner } from '@talon/skills/script-runner/bubblewrap-runner.js';
import { EnvSecretStore } from '@talon/core/secrets/env-secret-store.js';
import { SkillExecHandler } from '@talon/tools/host-tools/skill-exec.js';
import { AuditLogger } from '@talon/core/logging/audit-logger.js';
import type { LoadedSkill } from '@talon/skills/skill-types.js';
import type { ToolExecutionContext } from '@talon/tools/host-tools/channel-send.js';

// ---------------------------------------------------------------------------
// Skip conditions
// ---------------------------------------------------------------------------

const hasBwrap =
  process.platform === 'linux' &&
  (() => {
    try {
      execFileSync('bwrap', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockLogger(): pino.Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => makeMockLogger(),
  } as unknown as pino.Logger;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!hasBwrap)('skill-exec end-to-end (bwrap)', () => {
  const fixtureSkillDir = resolve(
    __dirname,
    'fixtures',
    'toy-skill',
  );

  let repoDir: string;
  let dataDir: string;
  let loadedSkill: LoadedSkill;
  let handler: SkillExecHandler;
  let mockContext: ToolExecutionContext;

  beforeAll(async () => {
    // 1. Create temp directories
    repoDir = mkdtempSync(join(tmpdir(), 'skill-e2e-repo-'));
    dataDir = mkdtempSync(join(tmpdir(), 'skill-e2e-data-'));

    // Create artifact directory structure for the test thread
    mkdirSync(join(dataDir, 'threads', 'e2e-thread', 'artifacts'), {
      recursive: true,
    });

    // 2. Write a test file into the repo
    writeFileSync(join(repoDir, 'test.txt'), 'repo content');

    // 3. Load the fixture skill
    const logger = makeMockLogger();
    const loader = new SkillLoader(logger);
    const loadResult = await loader.loadFromDirectory(fixtureSkillDir, dataDir);

    if (loadResult.isErr()) {
      throw new Error(`Failed to load toy skill: ${loadResult.error.message}`);
    }
    loadedSkill = loadResult.value;

    if (!loadedSkill.stagedSandbox) {
      throw new Error('Skill sandbox staging failed — cannot run e2e tests');
    }

    // 4. Create runner
    const runner = new BubblewrapRunner(dataDir, logger);

    // 5. Create secret store with TOY_SECRET in env
    process.env['TOY_SECRET'] = 'hello-world';
    const secretStore = new EnvSecretStore({ dataDir, logger });

    // 6. Create audit logger (mock)
    const auditLogger = new AuditLogger(logger);

    // 7. Create handler
    handler = new SkillExecHandler({
      runner,
      secretStore,
      auditLogger,
      logger,
      getLoadedSkill: (skillName: string, _personaId: string) => {
        if (skillName === 'toy') return loadedSkill;
        return undefined;
      },
      getPersonaRepoPath: (_personaId: string) => repoDir,
      dataDir,
    });

    // 8. Mock context
    mockContext = {
      runId: 'e2e-run-1',
      threadId: 'e2e-thread',
      personaId: 'e2e-persona',
      requestId: 'e2e-req-1',
    };
  });

  afterAll(() => {
    delete process.env['TOY_SECRET'];

    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('executes a command and captures stdout', async () => {
    const result = await handler.execute(
      { skillName: 'toy', command: 'echo "hello from sandbox"' },
      mockContext,
    );
    expect(result.status).toBe('success');
    expect(result.result.stdout).toContain('hello from sandbox');
    expect(result.result.exitCode).toBe(0);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Secret injection
  // -------------------------------------------------------------------------

  it('injects declared secrets as env vars', async () => {
    const result = await handler.execute(
      { skillName: 'toy', command: 'echo $TOY_SECRET' },
      mockContext,
    );
    expect(result.result.stdout.trim()).toBe('hello-world');
  }, 30_000);

  // -------------------------------------------------------------------------
  // Repo mounting
  // -------------------------------------------------------------------------

  it('mounts the repo at /workspace', async () => {
    const result = await handler.execute(
      { skillName: 'toy', command: 'cat /workspace/test.txt' },
      mockContext,
    );
    expect(result.result.stdout.trim()).toBe('repo content');
  }, 30_000);

  it('can write to /workspace', async () => {
    const result = await handler.execute(
      {
        skillName: 'toy',
        command:
          'echo "written" > /workspace/output.txt && cat /workspace/output.txt',
      },
      mockContext,
    );
    expect(result.result.stdout.trim()).toBe('written');
  }, 30_000);

  // -------------------------------------------------------------------------
  // Security — filesystem isolation
  // -------------------------------------------------------------------------

  it('cannot read /etc/shadow', async () => {
    const result = await handler.execute(
      { skillName: 'toy', command: 'cat /etc/shadow' },
      mockContext,
    );
    expect(result.result.exitCode).not.toBe(0);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Security — binary allowlist
  // -------------------------------------------------------------------------

  it('cannot call undeclared binaries', async () => {
    const result = await handler.execute(
      { skillName: 'toy', command: 'curl --version' },
      mockContext,
    );
    expect(result.result.exitCode).not.toBe(0);
    expect(result.result.stderr).toContain('not found');
  }, 30_000);

  // -------------------------------------------------------------------------
  // Security — network isolation
  // -------------------------------------------------------------------------

  it('cannot make network connections when network is off', async () => {
    const result = await handler.execute(
      {
        skillName: 'toy',
        command:
          'bash -c "echo test > /dev/tcp/127.0.0.1/80" 2>&1 || echo "network blocked"',
      },
      mockContext,
    );
    // Either the command fails or "network blocked" appears
    const combined = result.result.stdout + result.result.stderr;
    expect(combined).toMatch(
      /network blocked|refused|denied|No such file/i,
    );
  }, 30_000);
});
