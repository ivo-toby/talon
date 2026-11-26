import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { err } from 'neverthrow';
import type { Logger } from 'pino';
import { DbError } from '../../../src/core/errors/index.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { ScriptRepository } from '../../../src/core/database/repositories/script-repository.js';
import {
  createScriptStore,
  type ScriptFile,
  type ScriptStore,
} from '../../../src/scripts/index.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

const manifest = {
  name: 'daily-digest',
  description: 'Summarises the mailbox.',
  tools: ['mailbox.list_metadata'],
  channels: [],
  dryRunInput: { limit: 3 },
};
const tests = {
  cases: [
    {
      name: 'happy path',
      input: {},
      stubs: { 'mailbox.list_metadata': [[]] },
      expect: { ok: true },
    },
  ],
};

function goodFiles(overrides: Record<string, string | null> = {}): ScriptFile[] {
  const base: Record<string, string> = {
    'script.ts': 'export default async () => 1;\n',
    'manifest.json': JSON.stringify(manifest),
    'tests.json': JSON.stringify(tests),
  };
  for (const [path, content] of Object.entries(overrides)) {
    if (content === null) {
      delete base[path];
    } else {
      base[path] = content;
    }
  }
  return Object.entries(base).map(([path, content]) => ({ path, content }));
}

describe('ScriptStore', () => {
  let db: Database.Database;
  let repo: ScriptRepository;
  let root: string;
  let store: ScriptStore;
  let personaId: string;

  beforeEach(() => {
    db = createTestDb();
    repo = new ScriptRepository(db);
    root = mkdtempSync(join(tmpdir(), 'script-store-'));
    store = createScriptStore({ root, repo });
    personaId = uuid();
    new PersonaRepository(db)
      .insert({
        id: personaId,
        name: `p-${personaId}`,
        model: 'm',
        system_prompt_file: null,
        skills: '[]',
        capabilities: '{}',
        mounts: '[]',
        max_concurrent: null,
      })
      ._unsafeUnwrap();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const save = (files: ScriptFile[]) => store.save({ personaId, threadId: 't1', files });

  function expectInvalid(files: ScriptFile[]): void {
    const r = save(files);
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
    expect(readdirSync(root)).toEqual([]);
  }

  describe('save', () => {
    it('writes the files and records a draft version', () => {
      const v = save(goodFiles())._unsafeUnwrap();
      expect(v.version).toBe(1);
      expect(v.state).toBe('draft');
      expect(v.threadId).toBe('t1');
      expect(v.manifest.name).toBe('daily-digest');
      expect(v.scriptPath).toBe(`${v.scriptId}/v1/script.ts`);
      expect(v.dir).toBe(join(root, v.scriptId, 'v1'));
      expect(readFileSync(join(v.dir, 'script.ts'), 'utf8')).toContain('export default');
      expect(v.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(v.contentHash).toBe(store.hashFiles(goodFiles()));
    });

    it('sets modes explicitly regardless of umask', () => {
      const old = process.umask(0o077);
      try {
        const v = save(
          goodFiles({ 'prompts/judge.md': 'hello', 'fixtures/a.json': '{}' }),
        )._unsafeUnwrap();
        expect(statSync(v.dir).mode & 0o777).toBe(0o755);
        expect(statSync(join(root, v.scriptId)).mode & 0o777).toBe(0o755);
        expect(statSync(join(v.dir, 'prompts')).mode & 0o777).toBe(0o755);
        expect(statSync(join(v.dir, 'script.ts')).mode & 0o777).toBe(0o644);
        expect(statSync(join(v.dir, 'prompts/judge.md')).mode & 0o777).toBe(0o644);
      } finally {
        process.umask(old);
      }
    });

    it('returns the latest version and writes nothing for identical content', () => {
      const a = save(goodFiles())._unsafeUnwrap();
      const b = save(goodFiles().reverse())._unsafeUnwrap();
      expect(b.versionId).toBe(a.versionId);
      expect(readdirSync(join(root, a.scriptId))).toEqual(['v1']);
    });

    it('creates version 2 for changed content of the same script', () => {
      const a = save(goodFiles())._unsafeUnwrap();
      const b = save(goodFiles({ 'script.ts': '// changed\n' }))._unsafeUnwrap();
      expect(b.scriptId).toBe(a.scriptId);
      expect(b.version).toBe(2);
      expect(b.scriptPath).toBe(`${a.scriptId}/v2/script.ts`);
    });

    it('does not dedupe against a retired latest version', () => {
      const a = save(goodFiles())._unsafeUnwrap();
      repo.setVersionState(a.versionId, ['draft'], 'retired');
      const b = save(goodFiles())._unsafeUnwrap();
      expect(b.version).toBe(2);
    });

    it('creates a new version for identical content when the latest is rejected', () => {
      const a = save(goodFiles())._unsafeUnwrap();
      repo.setVersionState(a.versionId, ['draft'], 'rejected');
      const b = save(goodFiles())._unsafeUnwrap();
      expect(b.version).toBe(2);
      expect(b.state).toBe('draft');
    });

    it('returns the existing version for identical content when it is approved', () => {
      const a = save(goodFiles())._unsafeUnwrap();
      repo.setVersionState(a.versionId, ['draft'], 'approved');
      const b = save(goodFiles())._unsafeUnwrap();
      expect(b.versionId).toBe(a.versionId);
      expect(b.state).toBe('approved');
    });

    it('rejects a missing required file', () => {
      expectInvalid(goodFiles({ 'script.ts': null }));
      expectInvalid(goodFiles({ 'manifest.json': null }));
      expectInvalid(goodFiles({ 'tests.json': null }));
    });

    it('rejects too few and too many files', () => {
      expectInvalid([{ path: 'script.ts', content: 'x' }]);
      const many = goodFiles();
      for (let i = 0; i < 18; i++) many.push({ path: `fixtures/f${i}.json`, content: '{}' });
      expectInvalid(many);
    });

    it('accepts exactly 20 files', () => {
      const files = goodFiles();
      for (let i = 0; i < 17; i++) files.push({ path: `fixtures/f${i}.json`, content: '{}' });
      expect(save(files).isOk()).toBe(true);
    });

    it('rejects files over the total size, measured in UTF-8 bytes', () => {
      const bytes = goodFiles({ 'script.ts': '' }).reduce(
        (n, f) => n + Buffer.byteLength(f.content),
        0,
      );
      // 'é' is 2 bytes but 1 character: the character count stays under the limit.
      const pad = 'é'.repeat(Math.ceil((262_144 - bytes) / 2) + 1);
      expect(pad.length).toBeLessThan(262_144 - bytes);
      expectInvalid(goodFiles({ 'script.ts': pad }));
    });

    it('accepts content exactly at the size limit', () => {
      const others = goodFiles({ 'script.ts': '' });
      const used = others.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
      expect(save(goodFiles({ 'script.ts': 'a'.repeat(262_144 - used) })).isOk()).toBe(true);
    });

    it.each([
      '../script.ts',
      '/etc/passwd',
      'prompts/../../x.md',
      'prompts/a/b.md',
      'prompts/A.md',
      'fixtures/a.txt',
      'other.txt',
      'script.ts/',
      'prompts\\a.md',
      '.hidden',
      'script.ts\n',
    ])('rejects the path %j', (path) => {
      expectInvalid([...goodFiles(), { path, content: 'x' }]);
    });

    it('rejects duplicate paths', () => {
      expectInvalid([...goodFiles(), { path: 'script.ts', content: 'other' }]);
    });

    it('rejects a NUL character in content', () => {
      expectInvalid(goodFiles({ 'script.ts': 'a\0b' }));
    });

    it('rejects invalid JSON and wrong shapes in manifest.json', () => {
      expectInvalid(goodFiles({ 'manifest.json': '{nope' }));
      expectInvalid(goodFiles({ 'manifest.json': '[]' }));
      expectInvalid(goodFiles({ 'manifest.json': 'null' }));
      const bad = (patch: Record<string, unknown>): string =>
        JSON.stringify({ ...manifest, ...patch });
      expectInvalid(goodFiles({ 'manifest.json': bad({ name: 'Bad Name' }) }));
      expectInvalid(goodFiles({ 'manifest.json': bad({ name: 'a' }) }));
      expectInvalid(goodFiles({ 'manifest.json': bad({ description: '' }) }));
      expectInvalid(goodFiles({ 'manifest.json': bad({ description: 'x'.repeat(501) }) }));
      expectInvalid(goodFiles({ 'manifest.json': bad({ tools: ['nodot'] }) }));
      expectInvalid(goodFiles({ 'manifest.json': bad({ tools: ['a.b', 'a.b'] }) }));
      expectInvalid(goodFiles({ 'manifest.json': bad({ tools: ['a.b c'] }) }));
      expectInvalid(
        goodFiles({
          'manifest.json': bad({ tools: Array.from({ length: 51 }, (_, i) => `t.n${i}`) }),
        }),
      );
      expectInvalid(goodFiles({ 'manifest.json': bad({ channels: Array(6).fill('c') }) }));
      expectInvalid(goodFiles({ 'manifest.json': bad({ extra: 1 }) }));
    });

    it('requires the dryRunInput key but allows null; defaults channels', () => {
      const { dryRunInput: _d, ...without } = manifest;
      expectInvalid(goodFiles({ 'manifest.json': JSON.stringify(without) }));
      const { channels: _c, ...noChannels } = { ...manifest, dryRunInput: null };
      const v = save(goodFiles({ 'manifest.json': JSON.stringify(noChannels) }))._unsafeUnwrap();
      expect(v.manifest.channels).toEqual([]);
      expect(v.manifest.dryRunInput).toBeNull();
    });

    describe('inputSchema', () => {
      const schema = {
        type: 'object',
        properties: { quiet: { type: 'boolean' } },
        additionalProperties: false,
      };
      const withManifest = (patch: Record<string, unknown>): ScriptFile[] =>
        goodFiles({ 'manifest.json': JSON.stringify({ ...manifest, ...patch }) });

      it('keeps a valid schema that dryRunInput and liveInput match', () => {
        const v = save(
          withManifest({ inputSchema: schema, dryRunInput: { quiet: true }, liveInput: {} }),
        )._unsafeUnwrap();
        expect(v.manifest.inputSchema).toEqual(schema);
      });

      it('refuses a schema that fails the safety walk', () => {
        const bad = { type: 'object', properties: { a: { type: 'string', pattern: '(a+)+$' } } };
        expectInvalid(withManifest({ inputSchema: bad, dryRunInput: {} }));
      });

      it('refuses a schema that is not an object', () => {
        expectInvalid(withManifest({ inputSchema: 'x', dryRunInput: {} }));
        expectInvalid(withManifest({ inputSchema: [], dryRunInput: {} }));
      });

      it('refuses a schema over 4,000 characters of JSON', () => {
        const props = Object.fromEntries(
          Array.from({ length: 150 }, (_, i) => [`property${i}`, { type: 'string' }]),
        );
        const big = { type: 'object', properties: props };
        expect(JSON.stringify(big).length).toBeGreaterThan(4000);
        expectInvalid(withManifest({ inputSchema: big, dryRunInput: {} }));
      });

      it('refuses a dryRunInput or liveInput that does not match', () => {
        expectInvalid(withManifest({ inputSchema: schema, dryRunInput: { quiet: 'yes' } }));
        expectInvalid(
          withManifest({ inputSchema: schema, dryRunInput: {}, liveInput: { other: 1 } }),
        );
      });
    });

    it('rejects invalid tests.json', () => {
      expectInvalid(goodFiles({ 'tests.json': 'nope' }));
      expectInvalid(goodFiles({ 'tests.json': '{"cases":[]}' }));
      expectInvalid(goodFiles({ 'tests.json': '{"cases":[],"x":1}' }));
      const c = tests.cases[0]!;
      expectInvalid(goodFiles({ 'tests.json': JSON.stringify({ cases: [c, { ...c }] }) }));
      expectInvalid(
        goodFiles({
          'tests.json': JSON.stringify({ cases: [{ ...c, stubs: { 'other.tool': [1] } }] }),
        }),
      );
      expectInvalid(
        goodFiles({
          'tests.json': JSON.stringify({
            cases: [{ ...c, stubs: { 'mailbox.list_metadata': 1 } }],
          }),
        }),
      );
      expectInvalid(
        goodFiles({
          'tests.json': JSON.stringify({
            cases: Array.from({ length: 21 }, (_, i) => ({ ...c, name: `c${i}` })),
          }),
        }),
      );
    });

    it('keeps messages free of content', () => {
      const r = save(goodFiles({ 'manifest.json': '{"secret-token-123":' }));
      expect(r._unsafeUnwrapErr().message).not.toContain('secret-token-123');
    });

    it('writes no row when the root is missing', () => {
      const bad = createScriptStore({ root: join(root, 'missing'), repo });
      const r = bad.save({ personaId, threadId: 't', files: goodFiles() });
      expect(r._unsafeUnwrapErr().scriptCode).toBe('SANDBOX');

      const script = repo.findScript(personaId, 'daily-digest')._unsafeUnwrap();
      expect(script).toBeNull();
    });

    it('retires the inserted draft when files cannot be written', () => {
      const first = save(goodFiles())._unsafeUnwrap();
      // Block v2: a read-only script directory.
      chmodSync(join(root, first.scriptId), 0o555);
      try {
        if (process.getuid?.() === 0) return; // root ignores modes
        const r = save(goodFiles({ 'script.ts': '// v2\n' }));
        expect(r._unsafeUnwrapErr().scriptCode).toBe('SANDBOX');
        const latest = repo.latestVersion(first.scriptId)._unsafeUnwrap()!;
        expect(latest.version).toBe(2);
        expect(latest.state).toBe('retired');
      } finally {
        chmodSync(join(root, first.scriptId), 0o755);
      }
    });

    it('logs the version id and still returns SANDBOX when retiring fails', () => {
      const logged: unknown[][] = [];
      const logger = { error: (...a: unknown[]) => logged.push(a) } as unknown as Logger;
      const s = createScriptStore({ root, repo, logger });
      const first = s.save({ personaId, threadId: 't', files: goodFiles() })._unsafeUnwrap();
      if (process.getuid?.() === 0) return;
      chmodSync(join(root, first.scriptId), 0o555);
      const real = repo.setVersionState.bind(repo);
      repo.setVersionState = () => err(new DbError('boom'));
      try {
        const r = s.save({ personaId, threadId: 't', files: goodFiles({ 'script.ts': '// 2' }) });
        expect(r._unsafeUnwrapErr().scriptCode).toBe('SANDBOX');
        expect(logged).toHaveLength(1);
        const latest = repo.latestVersion(first.scriptId)._unsafeUnwrap()!;
        expect(logged[0]![0]).toEqual({ versionId: latest.id });
        expect(JSON.stringify(logged)).not.toContain(root);
      } finally {
        repo.setVersionState = real;
        chmodSync(join(root, first.scriptId), 0o755);
      }
    });

    it('returns SANDBOX when the root is missing or relative', () => {
      for (const r of [join(root, 'nope'), 'relative/dir']) {
        const s = createScriptStore({ root: r, repo });
        const res = s.save({ personaId, threadId: 't', files: goodFiles() });
        expect(res._unsafeUnwrapErr().scriptCode).toBe('SANDBOX');
      }
    });
  });

  describe('hashFiles', () => {
    it('is independent of order and sensitive to path and content', () => {
      const files = goodFiles();
      const h = store.hashFiles(files);
      expect(store.hashFiles([...files].reverse())).toBe(h);
      expect(store.hashFiles(goodFiles({ 'script.ts': 'x' }))).not.toBe(h);
      expect(store.hashFiles([...files, { path: 'prompts/a.md', content: '' }])).not.toBe(h);
    });

    it('does not let path and content boundaries collide', () => {
      const a = store.hashFiles([{ path: 'a', content: '1\0bx' }]);
      const b = store.hashFiles([
        { path: 'a', content: '1' },
        { path: 'b', content: 'x' },
      ]);
      expect(a).not.toBe(b);
    });

    it('matches the documented byte layout', async () => {
      const { createHash } = await import('node:crypto');
      const expected = createHash('sha256')
        .update(Buffer.from('a.md\x002\x00hi', 'utf8'))
        .update(Buffer.from('b.md\x002\x00é', 'utf8'))
        .digest('hex');
      const got = store.hashFiles([
        { path: 'b.md', content: 'é' },
        { path: 'a.md', content: 'hi' },
      ]);
      expect(got).toBe(expected);
    });
  });

  describe('load', () => {
    it('rebuilds the version from the database', () => {
      const v = save(goodFiles())._unsafeUnwrap();
      const l = store.load(v.versionId)._unsafeUnwrap();
      expect(l).toEqual(v);
    });

    it('rejects an unknown id', () => {
      expect(store.load(uuid())._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
    });
  });

  describe('verify', () => {
    it('passes for an untouched version', () => {
      const v = save(
        goodFiles({ 'prompts/judge.md': 'p', 'fixtures/a.json': '{}' }),
      )._unsafeUnwrap();
      expect(store.verify(v).isOk()).toBe(true);
    });

    function expectFailed(v: Parameters<ScriptStore['verify']>[0]): void {
      const r = store.verify(v);
      expect(r.isErr()).toBe(true);
      const e = r._unsafeUnwrapErr();
      expect(e.scriptCode).toBe('SCRIPT_FAILED');
      expect(e.message).not.toContain(root);
    }

    it('fails after a changed byte', () => {
      const v = save(goodFiles())._unsafeUnwrap();
      writeFileSync(join(v.dir, 'script.ts'), 'export default async () => 2;\n');
      expectFailed(v);
    });

    it('fails after an added file, also in a subdirectory', () => {
      const v = save(goodFiles())._unsafeUnwrap();
      writeFileSync(join(v.dir, 'extra.ts'), 'x');
      expectFailed(v);
      rmSync(join(v.dir, 'extra.ts'));
      expect(store.verify(v).isOk()).toBe(true);
      mkdirSync(join(v.dir, 'prompts'));
      writeFileSync(join(v.dir, 'prompts', 'Bad Name.md'), 'x');
      expectFailed(v);
    });

    it('fails after a removed file', () => {
      const v = save(goodFiles())._unsafeUnwrap();
      rmSync(join(v.dir, 'tests.json'));
      expectFailed(v);
    });

    it('fails when the directory is gone', () => {
      const v = save(goodFiles())._unsafeUnwrap();
      rmSync(v.dir, { recursive: true });
      expectFailed(v);
    });

    it('fails for a symbolic link to a file or a directory', () => {
      const v = save(goodFiles())._unsafeUnwrap();
      const outside = mkdtempSync(join(tmpdir(), 'outside-'));
      try {
        writeFileSync(join(outside, 'x.md'), 'x');
        symlinkSync(join(outside, 'x.md'), join(v.dir, 'prompts-link.md'));
        expectFailed(v);
        rmSync(join(v.dir, 'prompts-link.md'));
        symlinkSync(outside, join(v.dir, 'prompts'));
        expectFailed(v);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('fails when a file is replaced by a link to the same bytes', () => {
      const v = save(goodFiles())._unsafeUnwrap();
      const outside = mkdtempSync(join(tmpdir(), 'outside-'));
      try {
        writeFileSync(join(outside, 'script.ts'), goodFiles()[0]!.content);
        rmSync(join(v.dir, 'script.ts'));
        symlinkSync(join(outside, 'script.ts'), join(v.dir, 'script.ts'));
        expectFailed(v);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('uses the stored hash, not the hash the caller passes', () => {
      const v = save(goodFiles())._unsafeUnwrap();
      writeFileSync(join(v.dir, 'script.ts'), 'tampered');
      const forged = { ...v, contentHash: store.hashFiles(goodFiles({ 'script.ts': 'tampered' })) };
      expectFailed(forged);
    });

    it('uses the stored script id and version for the directory', () => {
      const v = save(goodFiles())._unsafeUnwrap();
      expect(store.verify({ ...v, scriptId: '../..', dir: root }).isOk()).toBe(true);
      expect(store.verify({ ...v, version: 99 }).isOk()).toBe(true);
    });

    it('fails for an unknown version id', () => {
      const v = save(goodFiles())._unsafeUnwrap();
      expectFailed({ ...v, versionId: uuid() });
    });

    it('fails for an empty extra directory or a nested directory', () => {
      const v = save(goodFiles())._unsafeUnwrap();
      mkdirSync(join(v.dir, 'empty'));
      expectFailed(v);
      rmdirSync(join(v.dir, 'empty'));
      mkdirSync(join(v.dir, 'prompts/deep'), { recursive: true });
      expectFailed(v);
      rmSync(join(v.dir, 'prompts'), { recursive: true });
      expect(store.verify(v).isOk()).toBe(true);
    });

    it('accepts empty prompts and fixtures directories', () => {
      const v = save(goodFiles())._unsafeUnwrap();
      mkdirSync(join(v.dir, 'prompts'));
      mkdirSync(join(v.dir, 'fixtures'));
      expect(store.verify(v).isOk()).toBe(true);
    });

    it('fails when the script directory is a symbolic link', () => {
      const v = save(goodFiles())._unsafeUnwrap();
      const moved = join(root, 'moved');
      renameSync(join(root, v.scriptId), moved);
      symlinkSync(moved, join(root, v.scriptId));
      expectFailed(v);
    });
  });

  describe('readUnitCases', () => {
    it('returns the cases from disk', () => {
      const v = save(goodFiles())._unsafeUnwrap();
      expect(store.readUnitCases(v)._unsafeUnwrap()).toEqual(tests.cases);
    });

    it('fails if tests.json on disk is no longer valid', () => {
      const v = save(goodFiles())._unsafeUnwrap();
      writeFileSync(join(v.dir, 'tests.json'), '{bad');
      expect(store.readUnitCases(v)._unsafeUnwrapErr().scriptCode).toBe('SCRIPT_FAILED');
    });

    it('fails if tests.json is missing', () => {
      const v = save(goodFiles())._unsafeUnwrap();
      rmSync(join(v.dir, 'tests.json'));
      expect(store.readUnitCases(v).isErr()).toBe(true);
    });
  });
});
