// Tests that the starter bundles ship the Claude skills declared in their
// INCLUDED.txt allowlists, and that the release workflow syncs both bundles.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';

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

// ---------------------------------------------------------------------------
// starter/ bundle
// ---------------------------------------------------------------------------

describe('starter/.claude/skills', () => {
  const allowlist = resolve(ROOT, 'starter/.claude/skills/INCLUDED.txt');
  const skillsDir = resolve(ROOT, 'starter/.claude/skills');

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
});

// ---------------------------------------------------------------------------
// starter-stack/ bundle
// ---------------------------------------------------------------------------

describe('starter-stack/.claude/skills', () => {
  const allowlist = resolve(ROOT, 'starter-stack/.claude/skills/INCLUDED.txt');
  const skillsDir = resolve(ROOT, 'starter-stack/.claude/skills');

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
});

// ---------------------------------------------------------------------------
// Release workflow
// ---------------------------------------------------------------------------

describe('.github/workflows/release.yaml', () => {
  const workflowPath = resolve(ROOT, '.github/workflows/release.yaml');
  const workflow = readFileSync(workflowPath, 'utf8');

  it('syncs skills into starter/', () => {
    expect(workflow).toMatch(/scripts\/sync-starter-skills\.sh/);
  });

  it('syncs skills into starter-stack/', () => {
    // The workflow must run the sync for both bundles.
    expect(workflow).toMatch(/starter-stack.*sync|sync.*starter-stack|sync-starter-stack-skills/i);
  });
});
