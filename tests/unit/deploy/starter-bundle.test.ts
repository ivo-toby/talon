// Tests that the starter bundles ship the Claude skills declared in their
// INCLUDED.txt allowlists, and that the release workflow syncs both bundles.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

const ROOT = resolve(import.meta.dirname, '../../..');

function readLines(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.split('#')[0]!.trim())
    .filter((l) => l.length > 0);
}

function listSkillDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

// Sync skills before running assertions so the test passes on a fresh clone.
// Note: this writes into the working tree (`<bundle>/.claude/skills/`). On a
// clean tree it's idempotent; if a developer has uncommitted edits in
// `.claude/skills/`, those will be reflected in the bundle dirs afterwards.
beforeAll(() => {
  const script = resolve(ROOT, 'scripts/sync-starter-skills.sh');
  execSync(`bash "${script}" starter`, { stdio: 'ignore' });
  execSync(`bash "${script}" starter-stack`, { stdio: 'ignore' });
});

// ---------------------------------------------------------------------------
// starter/ bundle
// ---------------------------------------------------------------------------

for (const bundle of ['starter', 'starter-stack'] as const) {
  describe(`${bundle}/.claude/skills`, () => {
    const allowlist = resolve(ROOT, bundle, '.claude/skills/INCLUDED.txt');
    const skillsDir = resolve(ROOT, bundle, '.claude/skills');
    const sourceDir = resolve(ROOT, '.claude/skills');

    it('has an INCLUDED.txt allowlist', () => {
      expect(existsSync(allowlist)).toBe(true);
    });

    it('every allowlisted skill exists as a directory', () => {
      const expected = readLines(allowlist);
      expect(expected.length).toBeGreaterThan(0);

      const actual = listSkillDirs(skillsDir);
      for (const skill of expected) {
        expect(actual).toContain(skill);
      }
    });

    it('synced SKILL.md content matches the source', () => {
      const expected = readLines(allowlist);
      for (const skill of expected) {
        const src = readFileSync(resolve(sourceDir, skill, 'SKILL.md'), 'utf8');
        const dst = readFileSync(resolve(skillsDir, skill, 'SKILL.md'), 'utf8');
        expect(dst, `${bundle}/${skill}/SKILL.md drifted from source`).toBe(src);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Release workflow
// ---------------------------------------------------------------------------

describe('.github/workflows/release.yaml', () => {
  const workflowPath = resolve(ROOT, '.github/workflows/release.yaml');
  const workflow = readFileSync(workflowPath, 'utf8');

  it('syncs skills into starter/', () => {
    // Negative lookahead prevents `starter\b` from matching inside `starter-stack`.
    expect(workflow).toMatch(/sync-starter-skills\.sh\s+starter(?![-\w])/);
  });

  it('syncs skills into starter-stack/', () => {
    expect(workflow).toMatch(/sync-starter-skills\.sh\s+starter-stack(?![-\w])/);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle documentation/adoption drift
// ---------------------------------------------------------------------------

describe('lifecycle documentation/adoption surfaces', () => {
  it('documents lifecycle config and operator commands in the schema reference', () => {
    const docs = readFileSync(resolve(ROOT, 'docs/reference/config-schema.mdx'), 'utf8');

    expect(docs).toContain('## `lifecycle`');
    expect(docs).toContain('### `personas[].lifecycle`');
    expect(docs).toContain('talon.lifecycle.event.envelope.v1');
    expect(docs).toContain('behavior.feedback.detected.v1');
    expect(docs).toContain('current dispatcher concurrency is enforced by dispatcher policy');
    expect(docs).toContain('subagents');
    expect(docs).toMatch(/lifecycle subscription alone does\s+not load or authorize/);
    expect(docs).toContain('talonctl lifecycle handlers');
    expect(docs).toContain('talonctl lifecycle rollback-promotion');
  });

  it('keeps starter docs and example configs discoverable without enabling lifecycle', () => {
    for (const bundle of ['starter', 'starter-stack'] as const) {
      const readme = readFileSync(resolve(ROOT, bundle, 'README.md'), 'utf8');
      const config = readFileSync(resolve(ROOT, bundle, 'config/talond.example.yaml'), 'utf8');

      expect(readme).toContain('talonctl lifecycle handlers');
      expect(readme).toContain('talonctl lifecycle candidates assistant --limit 25');
      expect(config).toContain('Durable lifecycle (optional)');
      expect(config).toContain('#   enabled: false');
      expect(config).toContain('behavior prompt promotion');
      expect(config).toContain("add that handler ref to the persona's subagents list");
    }
  });

  it('keeps setup skills aligned with lifecycle inspection and governed promotion', () => {
    const skillPaths = [
      '.agents/skills/talon-setup/SKILL.md',
      '.claude/skills/talon-setup/SKILL.md',
      '.agents/skills/talon-setup-docker/SKILL.md',
      '.claude/skills/talon-setup-docker/SKILL.md',
      '.agents/skills/manage-schedules/SKILL.md',
      '.claude/skills/manage-schedules/SKILL.md',
      '.agents/skills/create-profile/SKILL.md',
      '.claude/skills/create-profile/SKILL.md',
      '.agents/skills/create-personality/SKILL.md',
      '.claude/skills/create-personality/SKILL.md',
    ];

    for (const skillPath of skillPaths) {
      const skill = readFileSync(resolve(ROOT, skillPath), 'utf8');
      expect(skill, skillPath).toContain('talonctl lifecycle candidates');
      expect(skill, skillPath).toContain('promote');
      expect(skill, skillPath).toContain('rollback-promotion');
    }

    const smoke = readFileSync(resolve(ROOT, '.agents/skills/run-talon-smoke/SKILL.md'), 'utf8');
    expect(smoke).toContain('talonctl lifecycle handlers');
  });
});
