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
