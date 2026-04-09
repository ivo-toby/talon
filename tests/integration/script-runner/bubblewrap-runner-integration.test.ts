/**
 * Integration tests for BubblewrapRunner.
 *
 * These tests spawn real bwrap processes and verify sandbox isolation.
 * Skipped when not on Linux or bwrap is not on PATH.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pino from 'pino';

import { BubblewrapRunner } from '@talon/skills/script-runner/bubblewrap-runner.js';
import type { SkillExecInput } from '@talon/skills/script-runner/runner-types.js';
import type { StagedSkillSandbox } from '@talon/skills/skill-sandbox-staging.js';
import type { SkillSandboxProfile } from '@talon/skills/skill-sandbox-schema.js';

// ---------------------------------------------------------------------------
// Skip conditions
// ---------------------------------------------------------------------------

function isBwrapAvailable(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('bwrap', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const bwrapAvailable = isBwrapAvailable();

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

function makeProfile(overrides: Partial<SkillSandboxProfile> = {}): SkillSandboxProfile {
  return {
    workdir: 'skill-bundle',
    mounts: [],
    network: 'off',
    secrets: [],
    env: {},
    bins: ['bash', 'sh', 'ls', 'cat', 'echo'],
    image: 'talon-skill-runtime:latest',
    shell: '/bin/bash',
    timeoutSeconds: 10,
    resourceLimits: { memoryMb: 512, cpus: 1, pidsLimit: 128 },
    ...overrides,
  };
}

function resolveOnPath(name: string): string {
  const result = execFileSync('which', [name], { encoding: 'utf-8' }).trim();
  return result;
}

function makeStaged(bins: string[]): StagedSkillSandbox {
  const tmpDir = mkdtempSync(join(tmpdir(), 'bwrap-test-bin-'));
  const resolvedBins: Record<string, string> = {};

  for (const name of bins) {
    try {
      const resolved = resolveOnPath(name);
      resolvedBins[name] = resolved;
      // Create symlink in bin dir
      const { symlinkSync } = require('node:fs');
      symlinkSync(resolved, join(tmpDir, name));
    } catch {
      // skip if not found
    }
  }

  return {
    binDir: tmpDir,
    resolvedBins,
    canonicalMounts: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!bwrapAvailable)('BubblewrapRunner integration', () => {
  let dataDir: string;
  let skillDir: string;
  let staged: StagedSkillSandbox;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'bwrap-test-data-'));
    skillDir = mkdtempSync(join(tmpdir(), 'bwrap-test-skill-'));
    mkdirSync(join(dataDir, 'threads', 'test-thread', 'artifacts'), { recursive: true });

    // Create a test file in the skill dir
    writeFileSync(join(skillDir, 'test.txt'), 'skill-content');

    // bwrap needs mountpoints to exist inside parent mounts.
    // /skill/bin is a nested bind inside /skill (which maps to skillDir),
    // so skillDir must contain a 'bin' subdirectory for the mountpoint.
    mkdirSync(join(skillDir, 'bin'), { recursive: true });

    staged = makeStaged(['bash', 'sh', 'ls', 'cat', 'echo']);
  });

  function makeInput(overrides: Partial<SkillExecInput> = {}): SkillExecInput {
    return {
      skillName: 'integration-test',
      skillDir,
      profile: makeProfile(),
      staged,
      command: 'echo hello',
      context: {
        threadId: 'test-thread',
        personaId: 'persona-1',
        requestId: 'req-1',
        repoPath: null,
      },
      resolvedSecrets: {},
      ...overrides,
    };
  }

  it('captures stdout from echo', async () => {
    const runner = new BubblewrapRunner(dataDir, makeMockLogger());
    const result = await runner.execute(makeInput({ command: 'echo "hello world"' }));

    expect(result.status).toBe('success');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello world');
    expect(result.durationMs).toBeGreaterThan(0);
  }, 15_000);

  it('cannot read /etc/shadow (sandbox isolation)', async () => {
    const runner = new BubblewrapRunner(dataDir, makeMockLogger());
    const result = await runner.execute(makeInput({ command: 'cat /etc/shadow' }));

    expect(result.status).toBe('error');
    expect(result.exitCode).not.toBe(0);
  }, 15_000);

  it('injects environment variables from secrets', async () => {
    const runner = new BubblewrapRunner(dataDir, makeMockLogger());
    const input = makeInput({
      command: 'echo $MY_SECRET',
      resolvedSecrets: { MY_SECRET: 'top-secret-value' },
    });
    const result = await runner.execute(input);

    expect(result.status).toBe('success');
    expect(result.stdout.trim()).toBe('top-secret-value');
  }, 15_000);

  it('cannot access network when network is off', async () => {
    const runner = new BubblewrapRunner(dataDir, makeMockLogger());
    // Try to read /etc/resolv.conf — it should not be mounted
    const result = await runner.execute(makeInput({ command: 'cat /etc/resolv.conf' }));

    // /etc/resolv.conf is not bind-mounted when network is off
    expect(result.exitCode).not.toBe(0);
  }, 15_000);
});
