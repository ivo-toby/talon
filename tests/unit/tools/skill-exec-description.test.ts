/**
 * Unit tests for skill-exec-description.ts
 */

import { describe, it, expect } from 'vitest';
import { buildSkillExecDescription, SKILL_EXEC_INPUT_SCHEMA } from '../../../src/tools/skill-exec-description.js';
import type { SkillSandboxProfile } from '../../../src/skills/skill-sandbox-schema.js';

function makeProfile(overrides: Partial<SkillSandboxProfile> = {}): SkillSandboxProfile {
  return {
    workdir: 'repo',
    mounts: [],
    network: 'off',
    secrets: [],
    env: {},
    bins: ['bash', 'node', 'npm'],
    image: 'talon-skill-runtime:latest',
    shell: '/bin/bash',
    timeoutSeconds: 60,
    resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
    ...overrides,
  };
}

describe('buildSkillExecDescription', () => {
  it('includes skill name in description', () => {
    const desc = buildSkillExecDescription(makeProfile(), 'contentful');
    expect(desc).toContain("'contentful'");
  });

  it('shows "Network: on" when network is enabled', () => {
    const desc = buildSkillExecDescription(makeProfile({ network: 'on' }), 'my-skill');
    expect(desc).toContain('Network: on');
  });

  it('shows "Network: off" when network is disabled', () => {
    const desc = buildSkillExecDescription(makeProfile({ network: 'off' }), 'my-skill');
    expect(desc).toContain('Network: off');
  });

  it('lists secret names without values', () => {
    const desc = buildSkillExecDescription(
      makeProfile({ secrets: ['API_KEY', 'DB_PASSWORD'] }),
      'deploy-tool',
    );
    expect(desc).toContain('API_KEY, DB_PASSWORD');
    expect(desc).not.toContain('=');
  });

  it('shows "none" when no secrets', () => {
    const desc = buildSkillExecDescription(makeProfile({ secrets: [] }), 'basic');
    expect(desc).toContain('Secrets injected (names only): none');
  });

  it('lists allowed binaries', () => {
    const desc = buildSkillExecDescription(
      makeProfile({ bins: ['bash', 'curl', 'jq'] }),
      'api-skill',
    );
    expect(desc).toContain('bash, curl, jq');
  });

  it('shows timeout value', () => {
    const desc = buildSkillExecDescription(makeProfile({ timeoutSeconds: 120 }), 'long-task');
    expect(desc).toContain('Timeout 120s');
  });

  it('includes skill_load reference', () => {
    const desc = buildSkillExecDescription(makeProfile(), 'contentful');
    expect(desc).toContain('skill_load contentful');
  });
});

describe('SKILL_EXEC_INPUT_SCHEMA', () => {
  it('requires command property', () => {
    expect(SKILL_EXEC_INPUT_SCHEMA.required).toContain('command');
  });

  it('has command and timeoutSeconds properties', () => {
    expect(SKILL_EXEC_INPUT_SCHEMA.properties).toHaveProperty('command');
    expect(SKILL_EXEC_INPUT_SCHEMA.properties).toHaveProperty('timeoutSeconds');
  });

  it('timeoutSeconds has minimum of 1', () => {
    expect(SKILL_EXEC_INPUT_SCHEMA.properties.timeoutSeconds.minimum).toBe(1);
  });
});
