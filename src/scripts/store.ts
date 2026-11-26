import { createHash, randomUUID } from 'node:crypto';
import { compileInputSchema, matchesInputSchema } from './run-input.js';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import type { Logger } from 'pino';
import { z } from 'zod';
import type {
  ScriptRepository,
  ScriptVersionRow,
} from '../core/database/repositories/script-repository.js';
import { createLogger } from '../core/logging/index.js';
import { ScriptError, type AuthoredManifest, type UnitCase, type VersionState } from './types.js';

export interface ScriptFile {
  path: string;
  content: string;
}

export interface StoredVersion {
  versionId: string;
  scriptId: string;
  version: number;
  contentHash: string;
  manifest: AuthoredManifest;
  state: VersionState;
  /** Absolute host directory. */
  dir: string;
  /** `<scriptId>/v<n>/script.ts`, with forward slashes. */
  scriptPath: string;
  threadId: string;
}

export interface ScriptStore {
  save(input: {
    personaId: string;
    threadId: string;
    files: ScriptFile[];
  }): Result<StoredVersion, ScriptError>;
  /** Builds the version from the database only. It does not read files. */
  load(versionId: string): Result<StoredVersion, ScriptError>;
  /** Reads the files again and compares the hash with the stored hash. */
  verify(version: StoredVersion): Result<void, ScriptError>;
  readUnitCases(version: StoredVersion): Result<UnitCase[], ScriptError>;
  hashFiles(files: ScriptFile[]): string;
}

const MIN_FILES = 2;
const MAX_FILES = 20;
const MAX_TOTAL_BYTES = 262_144;
const PATH_PATTERN =
  /^(script\.ts|manifest\.json|tests\.json|prompts\/[a-z0-9-]+\.md|fixtures\/[a-z0-9-]+\.json)$/;
const REQUIRED_FILES = ['script.ts', 'manifest.json', 'tests.json'] as const;
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

const manifestSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,48}$/),
  description: z.string().min(1).max(500),
  tools: z
    .array(
      z
        .string()
        .min(1)
        .max(200)
        .regex(/^[A-Za-z0-9._-]+$/)
        .refine((t) => t.includes('.')),
    )
    .max(50)
    .refine((tools) => new Set(tools).size === tools.length),
  channels: z.array(z.string().min(1).max(100)).max(5).default([]),
  dryRunInput: z.unknown(),
  liveInput: z.unknown().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});

const unitCaseSchema = z.strictObject({
  name: z.string().min(1).max(100),
  input: z.unknown(),
  stubs: z.record(z.string(), z.array(z.unknown())),
  expect: z.strictObject({
    ok: z.boolean().optional(),
    result: z.unknown().optional(),
    writes: z.array(z.strictObject({ name: z.string(), input: z.unknown() })).optional(),
  }),
});

const testsSchema = z
  .strictObject({ cases: z.array(unitCaseSchema).min(1).max(20) })
  .refine((t) => new Set(t.cases.map((c) => c.name)).size === t.cases.length);

function fail(
  code: ConstructorParameters<typeof ScriptError>[0],
  message: string,
  cause?: unknown,
): ScriptError {
  return new ScriptError(
    code,
    message,
    cause === undefined ? undefined : cause instanceof Error ? cause : new Error('non-error cause'),
  );
}

function hashEntries(entries: ReadonlyArray<{ path: string; bytes: Buffer }>): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash('sha256');
  const zero = Buffer.from([0]);
  for (const entry of sorted) {
    hash.update(Buffer.from(entry.path, 'utf8'));
    hash.update(zero);
    hash.update(Buffer.from(String(entry.bytes.length), 'ascii'));
    hash.update(zero);
    hash.update(entry.bytes);
  }
  return hash.digest('hex');
}

function hashFileList(files: readonly ScriptFile[]): string {
  return hashEntries(files.map((f) => ({ path: f.path, bytes: Buffer.from(f.content, 'utf8') })));
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function parseManifest(text: string): Result<AuthoredManifest, ScriptError> {
  const json = parseJson(text);
  if (!json.ok || typeof json.value !== 'object' || json.value === null) {
    return err(fail('INVALID_ARGUMENT', 'manifest.json is not valid'));
  }
  // `z.unknown()` makes the key optional; the manifest must carry it.
  if (!Object.prototype.hasOwnProperty.call(json.value, 'dryRunInput')) {
    return err(fail('INVALID_ARGUMENT', 'manifest.json is not valid'));
  }
  const parsed = manifestSchema.safeParse(json.value);
  if (!parsed.success) {
    return err(fail('INVALID_ARGUMENT', 'manifest.json is not valid'));
  }
  const { inputSchema } = parsed.data;
  if (inputSchema !== undefined) {
    const check = compileInputSchema(inputSchema);
    const hasLive = Object.prototype.hasOwnProperty.call(json.value, 'liveInput');
    if (
      check === undefined ||
      !matchesInputSchema(check, parsed.data.dryRunInput) ||
      (hasLive && !matchesInputSchema(check, parsed.data.liveInput))
    ) {
      return err(fail('INVALID_ARGUMENT', 'manifest.json is not valid'));
    }
  }
  return ok(parsed.data);
}

function parseTests(
  text: string,
  tools: readonly string[],
  code: 'INVALID_ARGUMENT' | 'SCRIPT_FAILED',
): Result<UnitCase[], ScriptError> {
  const json = parseJson(text);
  const parsed = json.ok ? testsSchema.safeParse(json.value) : undefined;
  // `z.unknown()` makes `input` optional; every case must carry the key.
  const rawCases =
    json.ok && typeof json.value === 'object' && json.value !== null
      ? (json.value as { cases?: unknown }).cases
      : undefined;
  const allHaveInput =
    Array.isArray(rawCases) &&
    rawCases.every(
      (c) =>
        typeof c === 'object' && c !== null && Object.prototype.hasOwnProperty.call(c, 'input'),
    );
  if (!parsed?.success || !allHaveInput) {
    return err(fail(code, 'tests.json is not valid'));
  }
  const known = new Set(tools);
  for (const testCase of parsed.data.cases) {
    if (Object.keys(testCase.stubs).some((name) => !known.has(name))) {
      return err(fail(code, 'tests.json stubs a tool that the manifest does not list'));
    }
  }
  return ok(parsed.data.cases as UnitCase[]);
}

export function createScriptStore(options: {
  root: string;
  repo: ScriptRepository;
  logger?: Logger;
}): ScriptStore {
  const { root, repo } = options;
  const logger = options.logger ?? createLogger({ level: 'info', pretty: false });

  function checkRoot(): Result<void, ScriptError> {
    try {
      if (isAbsolute(root) && statSync(root).isDirectory()) {
        return ok(undefined);
      }
    } catch {
      // fall through
    }
    return err(fail('SANDBOX', 'scripts root is not an existing absolute directory'));
  }

  function versionDir(scriptId: string, version: number): string {
    return join(root, scriptId, `v${version}`);
  }

  function toStored(row: ScriptVersionRow): Result<StoredVersion, ScriptError> {
    const manifest = parseJson(row.manifest);
    const parsed = manifest.ok ? manifestSchema.safeParse(manifest.value) : undefined;
    if (!parsed?.success) {
      return err(fail('SANDBOX', 'stored manifest is not valid'));
    }
    return ok({
      versionId: row.id,
      scriptId: row.script_id,
      version: row.version,
      contentHash: row.content_hash,
      manifest: parsed.data,
      state: row.state,
      dir: versionDir(row.script_id, row.version),
      scriptPath: `${row.script_id}/v${row.version}/script.ts`,
      threadId: row.thread_id ?? '',
    });
  }

  function writeVersion(dir: string, files: readonly ScriptFile[]): void {
    // `mkdirSync` returns the first directory it created; mode only those.
    const created = mkdirSync(dirname(dir), { recursive: true });
    if (created !== undefined) {
      chmodSync(dirname(dir), 0o755);
    }
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    for (const file of files) {
      const target = join(dir, file.path);
      const sub = dirname(target);
      if (sub !== dir) {
        mkdirSync(sub, { recursive: true });
        chmodSync(sub, 0o755);
      }
      writeFileSync(target, file.content, { mode: 0o644, flag: 'wx' });
      chmodSync(target, 0o644);
    }
  }

  /** Reads a version directory as `path -> bytes`, refusing links and odd entries. */
  function readTree(dir: string): Result<Array<{ path: string; bytes: Buffer }>, ScriptError> {
    const tooBad = fail('SCRIPT_FAILED', 'script files do not match the approved content');
    const out: Array<{ path: string; bytes: Buffer }> = [];
    const walk = (abs: string, rel: string, depth: number): boolean => {
      if (!lstatSync(abs).isDirectory()) {
        return false;
      }
      for (const name of readdirSync(abs)) {
        const childAbs = join(abs, name);
        const childRel = rel === '' ? name : `${rel}/${name}`;
        const stat = lstatSync(childAbs);
        if (stat.isDirectory()) {
          // Only `prompts` and `fixtures` at the top level; nothing nested below.
          if (depth > 0 || (name !== 'prompts' && name !== 'fixtures')) return false;
          if (!walk(childAbs, childRel, depth + 1)) return false;
        } else if (stat.isFile() && PATH_PATTERN.test(childRel)) {
          out.push({ path: childRel, bytes: readFileSync(childAbs) });
        } else {
          return false;
        }
      }
      return true;
    };
    try {
      return walk(dir, '', 0) ? ok(out) : err(tooBad);
    } catch {
      return err(tooBad);
    }
  }

  /** The directory is derived from root and ids, never taken from the caller. */
  function safeDir(version: StoredVersion): string | undefined {
    if (!ID_PATTERN.test(version.scriptId) || !Number.isInteger(version.version)) {
      return undefined;
    }
    return versionDir(version.scriptId, version.version);
  }

  const store: ScriptStore = {
    hashFiles(files) {
      return hashFileList(files);
    },

    save({ personaId, threadId, files }) {
      if (files.length < MIN_FILES || files.length > MAX_FILES) {
        return err(fail('INVALID_ARGUMENT', 'a script needs 2 to 20 files'));
      }
      const byPath = new Map<string, string>();
      let total = 0;
      for (const file of files) {
        if (typeof file.path !== 'string' || !PATH_PATTERN.test(file.path)) {
          return err(fail('INVALID_ARGUMENT', 'a file path is not allowed'));
        }
        if (typeof file.content !== 'string' || file.content.includes('\0')) {
          return err(fail('INVALID_ARGUMENT', 'file content must be text without NUL'));
        }
        if (byPath.has(file.path)) {
          return err(fail('INVALID_ARGUMENT', 'a file path is listed twice'));
        }
        byPath.set(file.path, file.content);
        total += Buffer.byteLength(file.content, 'utf8');
      }
      if (total > MAX_TOTAL_BYTES) {
        return err(fail('INVALID_ARGUMENT', 'the files are larger than 262144 bytes'));
      }
      if (REQUIRED_FILES.some((p) => !byPath.has(p))) {
        return err(
          fail('INVALID_ARGUMENT', 'script.ts, manifest.json and tests.json are required'),
        );
      }
      const manifest = parseManifest(byPath.get('manifest.json')!);
      if (manifest.isErr()) return err(manifest.error);
      const cases = parseTests(byPath.get('tests.json')!, manifest.value.tools, 'INVALID_ARGUMENT');
      if (cases.isErr()) return err(cases.error);

      const rootOk = checkRoot();
      if (rootOk.isErr()) return err(rootOk.error);

      const dbFailed = (cause: unknown): ScriptError =>
        fail('SANDBOX', 'the script database failed', cause);

      const script = repo.upsertScript(personaId, manifest.value.name, randomUUID());
      if (script.isErr()) return err(dbFailed(script.error));
      const contentHash = hashFileList(files);

      const latest = repo.latestVersion(script.value.id);
      if (latest.isErr()) return err(dbFailed(latest.error));
      // A rejected or retired version cannot be tested again (a retired one may
      // have no files); identical content then becomes a new version.
      if (
        latest.value &&
        latest.value.content_hash === contentHash &&
        latest.value.state !== 'retired' &&
        latest.value.state !== 'rejected'
      ) {
        return toStored(latest.value);
      }

      const row = repo.insertVersion({
        id: randomUUID(),
        scriptId: script.value.id,
        contentHash,
        manifest: JSON.stringify(manifest.value),
        threadId,
      });
      if (row.isErr()) return err(dbFailed(row.error));

      const dir = versionDir(row.value.script_id, row.value.version);
      try {
        writeVersion(dir, files);
      } catch (cause) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best effort
        }
        // Never leave a draft row without its files.
        const retired = repo.setVersionState(row.value.id, ['draft'], 'retired');
        if (retired.isErr() || !retired.value) {
          logger.error(
            { versionId: row.value.id },
            'could not retire a script version after a failed file write',
          );
        }
        return err(fail('SANDBOX', 'could not write the script files', cause));
      }
      return toStored(row.value);
    },

    load(versionId) {
      const row = repo.getVersion(versionId);
      if (row.isErr()) return err(fail('SANDBOX', 'the script database failed', row.error));
      if (!row.value) return err(fail('INVALID_ARGUMENT', 'unknown script version'));
      return toStored(row.value);
    },

    verify(version) {
      const failed = (): ScriptError =>
        fail('SCRIPT_FAILED', 'script files do not match the approved content');
      // The hash and the directory come from the database row, not from the caller.
      const row = repo.getVersion(version.versionId);
      if (row.isErr() || !row.value || !ID_PATTERN.test(row.value.script_id)) {
        return err(failed());
      }
      const dir = versionDir(row.value.script_id, row.value.version);
      try {
        if (!lstatSync(join(root, row.value.script_id)).isDirectory()) {
          return err(failed());
        }
      } catch {
        return err(failed());
      }
      const tree = readTree(dir);
      if (tree.isErr()) return err(tree.error);
      if (hashEntries(tree.value) !== row.value.content_hash) {
        return err(failed());
      }
      return ok(undefined);
    },

    readUnitCases(version) {
      const dir = safeDir(version);
      if (dir === undefined) {
        return err(fail('SCRIPT_FAILED', 'tests.json cannot be read'));
      }
      let text: string;
      try {
        const path = join(dir, 'tests.json');
        if (!lstatSync(path).isFile()) {
          return err(fail('SCRIPT_FAILED', 'tests.json cannot be read'));
        }
        text = readFileSync(path, 'utf8');
      } catch {
        return err(fail('SCRIPT_FAILED', 'tests.json cannot be read'));
      }
      return parseTests(text, version.manifest.tools, 'SCRIPT_FAILED');
    },
  };
  return store;
}
