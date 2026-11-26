import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptRepository } from '../../../src/core/database/repositories/script-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import {
  listScripts,
  listScriptRuns,
  readVersionFiles,
  showScript,
} from '../../../src/cli/commands/script.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

describe('talonctl script', () => {
  let db: Database.Database;
  let repo: ScriptRepository;
  let root: string;

  function makePersona(name: string): string {
    const id = uuid();
    const r = new PersonaRepository(db).insert({
      id,
      name,
      model: 'm',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });
    expect(r.isOk()).toBe(true);
    return id;
  }

  function makeVersion(scriptId: string, contentHash = 'hash'): string {
    return repo
      .insertVersion({ id: uuid(), scriptId, contentHash, manifest: '{}', threadId: null })
      ._unsafeUnwrap().id;
  }

  beforeEach(() => {
    db = createTestDb();
    repo = new ScriptRepository(db);
    root = mkdtempSync(join(tmpdir(), 'talon-script-cli-'));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  describe('listScripts()', () => {
    it('lists the scripts of every persona with newest version, approved version and last run', () => {
      const personaA = makePersona('alpha');
      const personaB = makePersona('beta');
      const daily = repo.upsertScript(personaA, 'daily', uuid())._unsafeUnwrap();
      const v1 = makeVersion(daily.id);
      makeVersion(daily.id);
      repo.setVersionState(v1, ['draft'], 'approved');
      repo.insertRun({
        id: uuid(),
        versionId: v1,
        mode: 'live',
        trigger: 'schedule',
        startedAt: 500,
      });
      repo.upsertScript(personaB, 'weekly', uuid());

      const rows = listScripts({ db })._unsafeUnwrap();

      expect(rows).toEqual([
        {
          persona: 'alpha',
          name: 'daily',
          latestVersion: 2,
          latestState: 'draft',
          approvedVersion: 1,
          lastRunAt: new Date(500).toISOString(),
        },
        {
          persona: 'beta',
          name: 'weekly',
          latestVersion: null,
          latestState: null,
          approvedVersion: null,
          lastRunAt: null,
        },
      ]);
    });

    it('filters by persona name', () => {
      const personaA = makePersona('alpha');
      makePersona('beta');
      repo.upsertScript(personaA, 'daily', uuid());

      const rows = listScripts({ db, persona: 'alpha' })._unsafeUnwrap();
      expect(rows.map((r) => r.name)).toEqual(['daily']);
    });

    it('returns an error for an unknown persona', () => {
      const result = listScripts({ db, persona: 'nobody' });
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Unknown persona: "nobody"');
    });
  });

  describe('showScript()', () => {
    it('lists the versions newest first with state and content hash', () => {
      const personaId = makePersona('alpha');
      const script = repo.upsertScript(personaId, 'daily', uuid())._unsafeUnwrap();
      const v1 = makeVersion(script.id, 'hash-1');
      makeVersion(script.id, 'hash-2');
      repo.setVersionState(v1, ['draft'], 'approved');

      const shown = showScript({ db, persona: 'alpha', name: 'daily' })._unsafeUnwrap();

      expect(shown.persona).toBe('alpha');
      expect(shown.name).toBe('daily');
      expect(shown.versions.map((v) => [v.version, v.state, v.contentHash])).toEqual([
        [2, 'draft', 'hash-2'],
        [1, 'approved', 'hash-1'],
      ]);
    });

    it('narrows to one version when a number is given', () => {
      const personaId = makePersona('alpha');
      const script = repo.upsertScript(personaId, 'daily', uuid())._unsafeUnwrap();
      makeVersion(script.id, 'hash-1');
      makeVersion(script.id, 'hash-2');

      const shown = showScript({ db, persona: 'alpha', name: 'daily', version: 1 })._unsafeUnwrap();
      expect(shown.versions.map((v) => v.version)).toEqual([1]);
    });

    it('returns an error for an unknown persona, script or version', () => {
      makePersona('alpha');

      const noPersona = showScript({ db, persona: 'nobody', name: 'daily' });
      expect(noPersona._unsafeUnwrapErr().message).toContain('Unknown persona: "nobody"');

      const noScript = showScript({ db, persona: 'alpha', name: 'daily' });
      expect(noScript._unsafeUnwrapErr().message).toContain('Unknown script: "daily"');

      const script = repo.upsertScript(makePersona('beta'), 'daily', uuid())._unsafeUnwrap();
      makeVersion(script.id);
      const noVersion = showScript({ db, persona: 'beta', name: 'daily', version: 9 });
      expect(noVersion._unsafeUnwrapErr().message).toContain('Unknown version 9');
    });

    it('rejects a script name that does not match the name pattern', () => {
      makePersona('alpha');
      const result = showScript({ db, persona: 'alpha', name: 'Bad_Name' });
      expect(result._unsafeUnwrapErr().message).toContain('Invalid script name');
    });
  });

  describe('listScriptRuns()', () => {
    it('lists runs newest first with trigger, mode, result, error code, calls and start time', () => {
      const personaId = makePersona('alpha');
      const script = repo.upsertScript(personaId, 'daily', uuid())._unsafeUnwrap();
      const versionId = makeVersion(script.id);

      const okRun = uuid();
      repo.insertRun({ id: okRun, versionId, mode: 'live', trigger: 'schedule', startedAt: 100 });
      repo.finishRun(okRun, true, null, 3, 150);

      const failedRun = uuid();
      repo.insertRun({ id: failedRun, versionId, mode: 'live', trigger: 'agent', startedAt: 200 });
      repo.finishRun(failedRun, false, 'SCRIPT_FAILED', 1, 250);

      const runningRun = uuid();
      repo.insertRun({ id: runningRun, versionId, mode: 'unit', trigger: 'test', startedAt: 300 });

      const runs = listScriptRuns({
        db,
        persona: 'alpha',
        name: 'daily',
        limit: 20,
      })._unsafeUnwrap();

      expect(runs).toEqual([
        {
          version: 1,
          trigger: 'test',
          mode: 'unit',
          result: 'running',
          errorCode: null,
          callCount: 0,
          startedAt: new Date(300).toISOString(),
        },
        {
          version: 1,
          trigger: 'agent',
          mode: 'live',
          result: 'failed',
          errorCode: 'SCRIPT_FAILED',
          callCount: 1,
          startedAt: new Date(200).toISOString(),
        },
        {
          version: 1,
          trigger: 'schedule',
          mode: 'live',
          result: 'ok',
          errorCode: null,
          callCount: 3,
          startedAt: new Date(100).toISOString(),
        },
      ]);
    });

    it('honours the limit', () => {
      const personaId = makePersona('alpha');
      const script = repo.upsertScript(personaId, 'daily', uuid())._unsafeUnwrap();
      const versionId = makeVersion(script.id);
      for (let i = 1; i <= 3; i++) {
        repo.insertRun({ id: uuid(), versionId, mode: 'live', trigger: 'schedule', startedAt: i });
      }

      const runs = listScriptRuns({
        db,
        persona: 'alpha',
        name: 'daily',
        limit: 2,
      })._unsafeUnwrap();
      expect(runs).toHaveLength(2);
    });

    it('returns an error for an unknown script', () => {
      makePersona('alpha');
      const result = listScriptRuns({ db, persona: 'alpha', name: 'daily', limit: 20 });
      expect(result._unsafeUnwrapErr().message).toContain('Unknown script: "daily"');
    });
  });

  describe('readVersionFiles()', () => {
    function makeFiles(dir: string, files: Record<string, string>): void {
      for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, content);
      }
    }

    it('reads the regular files of a version with relative paths', () => {
      const dir = join(root, 'script-1', 'v1');
      makeFiles(dir, { 'main.js': 'run()', 'lib/helper.js': 'help()' });

      const result = readVersionFiles({ root, scriptId: 'script-1', version: 1 })._unsafeUnwrap();

      expect(result.truncated).toBe(false);
      expect(result.files).toEqual([
        { path: 'lib/helper.js', content: 'help()' },
        { path: 'main.js', content: 'run()' },
      ]);
    });

    it('skips symbolic links', () => {
      const dir = join(root, 'script-1', 'v1');
      makeFiles(dir, { 'main.js': 'run()' });
      const outside = join(root, 'outside.txt');
      writeFileSync(outside, 'secret');
      symlinkSync(outside, join(dir, 'link.txt'));

      const result = readVersionFiles({ root, scriptId: 'script-1', version: 1 })._unsafeUnwrap();
      expect(result.files.map((f) => f.path)).toEqual(['main.js']);
    });

    it('reads at most 20 files and reports the truncation', () => {
      const dir = join(root, 'script-1', 'v1');
      const files: Record<string, string> = {};
      for (let i = 0; i < 25; i++) {
        files[`f${String(i).padStart(2, '0')}.txt`] = `${i}`;
      }
      makeFiles(dir, files);

      const result = readVersionFiles({ root, scriptId: 'script-1', version: 1 })._unsafeUnwrap();
      expect(result.files).toHaveLength(20);
      expect(result.truncated).toBe(true);
    });

    it('returns an error when the version directory is missing', () => {
      const result = readVersionFiles({ root, scriptId: 'missing', version: 1 });
      expect(result.isErr()).toBe(true);
    });
  });
});
