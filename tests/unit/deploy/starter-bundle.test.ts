// Tests that the starter bundles ship the Claude skills declared in their
// INCLUDED.txt allowlists, and that the release workflow syncs both bundles.
//
// The sync script is run into a throwaway sandbox copy of the repo layout, so
// this test never rewrites tracked files under starter/ or starter-stack/. The
// tracked copies in the working tree are compared against the source instead,
// so drift fails the test rather than being silently repaired.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  cpSync,
  rmSync,
} from 'fs';
import { resolve, join, relative } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const ROOT = resolve(import.meta.dirname, '../../..');
const SCRIPT = resolve(ROOT, 'scripts/sync-starter-skills.sh');
const SOURCE_DIR = resolve(ROOT, '.claude/skills');
const BUNDLES = ['starter', 'starter-stack'] as const;

// Names that must never appear inside a bundled skill: build output, installed
// dependencies, Signal account state and key material, and local credentials.
const FORBIDDEN_ENTRY_NAMES = new Set(['node_modules', 'dist', 'signal-cli', '.local', 'keys']);
const FORBIDDEN_FILE_PATTERNS = [/^\.env/, /\.(db|sqlite|sqlite3|key|pem|p12)$/, /-(wal|shm)$/];

function readLines(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.split('#')[0]!.trim())
    .filter((l) => l.length > 0);
}

interface TreeEntry {
  path: string;
  isDir: boolean;
}

function walk(dir: string, base = dir): TreeEntry[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      const rel = relative(base, full);
      if (entry.isDirectory()) {
        return [{ path: rel, isDir: true }, ...walk(full, base)];
      }
      return [{ path: rel, isDir: false }];
    });
}

function filesIn(dir: string): string[] {
  return walk(dir)
    .filter((e) => !e.isDir)
    .map((e) => e.path);
}

// Asserts that `actualDir` holds exactly the same files as `expectedDir`, with
// identical content. Presence alone is not enough: a stale copy must fail.
function expectSameTree(actualDir: string, expectedDir: string, label: string): void {
  expect(existsSync(actualDir), `${label} is missing`).toBe(true);
  const expectedFiles = filesIn(expectedDir);
  expect(filesIn(actualDir), `${label} file set differs from source`).toEqual(expectedFiles);
  for (const rel of expectedFiles) {
    const actual = readFileSync(join(actualDir, rel), 'utf8');
    const expected = readFileSync(join(expectedDir, rel), 'utf8');
    expect(actual, `${label}/${rel} drifted from source`).toBe(expected);
  }
}

function expectNoForbiddenEntries(skillDir: string, label: string): void {
  for (const entry of walk(skillDir)) {
    const name = entry.path.split('/').pop()!;
    expect(FORBIDDEN_ENTRY_NAMES.has(name), `${label} bundles forbidden entry ${entry.path}`).toBe(
      false,
    );
    if (!entry.isDir) {
      for (const pattern of FORBIDDEN_FILE_PATTERNS) {
        expect(pattern.test(name), `${label} bundles forbidden file ${entry.path}`).toBe(false);
      }
    }
  }
}

// Runs the real sync script against a sandbox that mirrors the repo layout
// (scripts/, .claude/skills/, and each bundle's INCLUDED.txt). The script
// derives its root from its own location, so writes stay inside the sandbox.
let sandbox = '';

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'talon-starter-sync-'));
  mkdirSync(join(sandbox, 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, join(sandbox, 'scripts/sync-starter-skills.sh'));
  cpSync(SOURCE_DIR, join(sandbox, '.claude/skills'), { recursive: true });
  for (const bundle of BUNDLES) {
    mkdirSync(join(sandbox, bundle, '.claude/skills'), { recursive: true });
    copyFileSync(
      resolve(ROOT, bundle, '.claude/skills/INCLUDED.txt'),
      join(sandbox, bundle, '.claude/skills/INCLUDED.txt'),
    );
    execFileSync('bash', [join(sandbox, 'scripts/sync-starter-skills.sh'), bundle], {
      stdio: 'pipe',
    });
  }
});

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// starter/ and starter-stack/ bundles
// ---------------------------------------------------------------------------

for (const bundle of BUNDLES) {
  describe(`${bundle}/.claude/skills`, () => {
    const allowlist = resolve(ROOT, bundle, '.claude/skills/INCLUDED.txt');
    const trackedDir = resolve(ROOT, bundle, '.claude/skills');
    // The sandbox is created in beforeAll, so resolve its path inside each test.
    const syncedDir = () => join(sandbox, bundle, '.claude/skills');

    it('has an INCLUDED.txt allowlist', () => {
      expect(existsSync(allowlist)).toBe(true);
    });

    it('allowlists add-signal', () => {
      expect(readLines(allowlist)).toContain('add-signal');
    });

    it('every allowlisted skill is produced by the sync script with source content', () => {
      const expected = readLines(allowlist);
      expect(expected.length).toBeGreaterThan(0);

      for (const skill of expected) {
        expectSameTree(
          join(syncedDir(), skill),
          join(SOURCE_DIR, skill),
          `${bundle}/${skill} (sync output)`,
        );
      }
    });

    it('in-tree skill copies match the source', () => {
      for (const skill of readLines(allowlist)) {
        const copy = join(trackedDir, skill);
        // starter-stack copies are tracked, so they must exist. starter/ copies
        // are gitignored generated output, so they are checked only when present.
        if (bundle === 'starter-stack' || existsSync(copy)) {
          expectSameTree(copy, join(SOURCE_DIR, skill), `${bundle}/${skill}`);
        }
      }
    });

    it('bundles no Signal key/data dirs, runtime credentials, node_modules or dist', () => {
      for (const skill of readLines(allowlist)) {
        expectNoForbiddenEntries(join(syncedDir(), skill), `${bundle}/${skill} (sync output)`);
        const copy = join(trackedDir, skill);
        if (existsSync(copy)) {
          expectNoForbiddenEntries(copy, `${bundle}/${skill}`);
        }
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
