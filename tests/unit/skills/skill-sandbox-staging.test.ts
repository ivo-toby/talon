import { mkdtemp, mkdir, rm, readlink, symlink, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';

import { stageSkillSandbox, StagingError } from '@talon/skills/skill-sandbox-staging.js';
import type { SkillSandboxProfile } from '@talon/skills/skill-sandbox-schema.js';

/** Build a minimal profile with overrides. */
function makeProfile(overrides: Partial<SkillSandboxProfile> = {}): SkillSandboxProfile {
  return {
    workdir: 'repo',
    mounts: [],
    network: 'off',
    secrets: [],
    env: {},
    bins: ['bash', 'ls'],
    image: 'talon-skill-runtime:latest',
    shell: '/bin/bash',
    timeoutSeconds: 60,
    resourceLimits: { memoryMb: 1024, cpus: 1, pidsLimit: 256 },
    ...overrides,
  };
}

describe('stageSkillSandbox', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(prefix = 'staging-test-'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tempDirs.length = 0;
  });

  it('resolves bins and creates .bin/ directory with symlinks', async () => {
    const dataDir = await makeTempDir();
    const skillDir = await makeTempDir('skill-');
    const profile = makeProfile({ bins: ['bash', 'ls'] });

    const result = await stageSkillSandbox(profile, skillDir, dataDir, 'test-skill');

    expect(result.isOk()).toBe(true);
    const staged = result._unsafeUnwrap();

    expect(staged.binDir).toBe(join(dataDir, 'skills', 'test-skill', '.bin'));
    expect(Object.keys(staged.resolvedBins)).toHaveLength(2);
    expect(staged.resolvedBins['bash']).toBeTruthy();
    expect(staged.resolvedBins['ls']).toBeTruthy();

    // Verify symlinks exist and point to the right targets
    const bashLink = await readlink(join(staged.binDir, 'bash'));
    expect(bashLink).toBe(staged.resolvedBins['bash']);

    const lsLink = await readlink(join(staged.binDir, 'ls'));
    expect(lsLink).toBe(staged.resolvedBins['ls']);
  });

  it('returns Err listing all missing bins', async () => {
    const dataDir = await makeTempDir();
    const skillDir = await makeTempDir('skill-');
    const profile = makeProfile({ bins: ['bash', 'nonexistent-binary-xyz'] });

    const result = await stageSkillSandbox(profile, skillDir, dataDir, 'test-skill');

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(StagingError);
    expect(error.skillName).toBe('test-skill');
    expect(error.reason).toContain('nonexistent-binary-xyz');
    expect((error.details as { missingBins: string[] }).missingBins).toEqual([
      'nonexistent-binary-xyz',
    ]);
  });

  it('is idempotent — second call replaces symlinks cleanly', async () => {
    const dataDir = await makeTempDir();
    const skillDir = await makeTempDir('skill-');
    const profile = makeProfile({ bins: ['bash', 'ls'] });

    const result1 = await stageSkillSandbox(profile, skillDir, dataDir, 'test-skill');
    expect(result1.isOk()).toBe(true);

    const result2 = await stageSkillSandbox(profile, skillDir, dataDir, 'test-skill');
    expect(result2.isOk()).toBe(true);

    const staged = result2._unsafeUnwrap();
    const bashLink = await readlink(join(staged.binDir, 'bash'));
    expect(bashLink).toBe(staged.resolvedBins['bash']);
  });

  it('canonicalises ${skill.dir} mount sources', async () => {
    const skillDir = await makeTempDir('skill-');
    const dataDir = await makeTempDir();
    const fixturesDir = join(skillDir, 'fixtures');
    await mkdir(fixturesDir, { recursive: true });

    const profile = makeProfile({
      mounts: [{ source: '${skill.dir}/fixtures', target: '/skill/data', mode: 'ro' }],
    });

    const result = await stageSkillSandbox(profile, skillDir, dataDir, 'test-skill');
    expect(result.isOk()).toBe(true);

    const staged = result._unsafeUnwrap();
    expect(staged.canonicalMounts).toHaveLength(1);
    const mount = staged.canonicalMounts[0]!;
    expect(mount.source).toBe(await realpath(fixturesDir));
    expect(mount.target).toBe('/skill/data');
    expect(mount.mode).toBe('ro');
  });

  it('rejects ${skill.dir} mount that escapes via symlink', async () => {
    const dataDir = await makeTempDir();
    const skillDir = await makeTempDir('skill-');
    const outsideDir = await makeTempDir('outside-');
    await symlink(outsideDir, join(skillDir, 'escape-link'));

    const profile = makeProfile({
      mounts: [{ source: '${skill.dir}/escape-link', target: '/skill/data', mode: 'ro' }],
    });

    const result = await stageSkillSandbox(profile, skillDir, dataDir, 'test-skill');
    expect(result.isErr()).toBe(true);

    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(StagingError);
    expect(error.reason).toContain('escapes skill directory');
  });

  it('allows absolute mount source without containment check', async () => {
    const dataDir = await makeTempDir();
    const skillDir = await makeTempDir('skill-');
    const absoluteDir = await makeTempDir('abs-mount-');

    const profile = makeProfile({
      mounts: [{ source: absoluteDir, target: '/skill/custom', mode: 'rw' }],
    });

    const result = await stageSkillSandbox(profile, skillDir, dataDir, 'test-skill');
    expect(result.isOk()).toBe(true);

    const staged = result._unsafeUnwrap();
    expect(staged.canonicalMounts).toHaveLength(1);
    expect(staged.canonicalMounts[0]!.source).toBe(await realpath(absoluteDir));
    expect(staged.canonicalMounts[0]!.mode).toBe('rw');
  });

  it('returns Err when mount source does not exist', async () => {
    const dataDir = await makeTempDir();
    const skillDir = await makeTempDir('skill-');

    const profile = makeProfile({
      mounts: [{ source: '${skill.dir}/missing', target: '/skill/data', mode: 'ro' }],
    });

    const result = await stageSkillSandbox(profile, skillDir, dataDir, 'test-skill');
    expect(result.isErr()).toBe(true);

    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(StagingError);
    expect(error.reason).toContain('mount source does not exist');
  });

  it('cleans up stale symlinks from previous staging', async () => {
    const dataDir = await makeTempDir();
    const skillDir = await makeTempDir('skill-');
    const binDir = join(dataDir, 'skills', 'test-skill', '.bin');
    await mkdir(binDir, { recursive: true });

    // Create a stale symlink
    await symlink('/usr/bin/env', join(binDir, 'stale-bin'));

    const profile = makeProfile({ bins: ['bash'] });
    const result = await stageSkillSandbox(profile, skillDir, dataDir, 'test-skill');
    expect(result.isOk()).toBe(true);

    // stale-bin should be gone
    await expect(readlink(join(binDir, 'stale-bin'))).rejects.toThrow();

    // bash should exist
    const staged = result._unsafeUnwrap();
    const bashLink = await readlink(join(staged.binDir, 'bash'));
    expect(bashLink).toBe(staged.resolvedBins['bash']);
  });
});
