/**
 * `talonctl script` command group (read-only).
 *
 *   talonctl script list [--persona <name>]
 *   talonctl script show <persona> <name> [--version <n>] [--code]
 *   talonctl script runs <persona> <name> [--limit <n>]
 *
 * The pure functions (`listScripts`, `showScript`, `listScriptRuns`,
 * `readVersionFiles`) read the database and the script store directly and
 * return neverthrow `Result`s. They do not need a running daemon. The
 * `*Command()` wrappers handle config loading, DB lifecycle, console output
 * and process.exit.
 */

import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import { readdirSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PersonaRepository } from '../../core/database/repositories/persona-repository.js';
import { ScriptRepository } from '../../core/database/repositories/script-repository.js';
import type {
  ScriptRunRow,
  ScriptVersionRow,
} from '../../core/database/repositories/script-repository.js';
import type { VersionState } from '../../scripts/types.js';
import { CliError } from '../cli-types.js';

/** The name pattern of a stored script, shared with the manifest check. */
export const SCRIPT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,48}$/;
/** The directory name of a script ID, as the script store writes it. */
const SCRIPT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** Most files that `script show --code` reads. */
export const MAX_CODE_FILES = 20;
/** Default number of runs that `script runs` lists. */
export const DEFAULT_RUN_LIMIT = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScriptListEntry {
  persona: string;
  name: string;
  latestVersion: number | null;
  latestState: VersionState | null;
  approvedVersion: number | null;
  lastRunAt: string | null;
}

export interface ScriptVersionEntry {
  version: number;
  state: VersionState;
  contentHash: string;
  createdAt: string;
}

export interface ScriptShowResult {
  persona: string;
  name: string;
  scriptId: string;
  /** Newest first. Holds one entry when a version number was asked for. */
  versions: ScriptVersionEntry[];
}

export interface ScriptRunEntry {
  version: number;
  trigger: string;
  mode: string;
  result: 'running' | 'ok' | 'failed';
  errorCode: string | null;
  callCount: number;
  startedAt: string;
}

export interface ScriptFileText {
  /** Path relative to the version directory, with `/` separators. */
  path: string;
  content: string;
}

export interface ScriptCodeResult {
  files: ScriptFileText[];
  /** True when the version holds more regular files than were read. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** Looks up a persona by name and returns its ID. */
function findPersonaId(db: Database.Database, persona: string): Result<string, CliError> {
  const result = new PersonaRepository(db).findByName(persona);
  if (result.isErr()) {
    return err(new CliError(`Database error looking up persona: ${result.error.message}`));
  }
  if (result.value === null) {
    return err(new CliError(`Unknown persona: "${persona}"`));
  }
  return ok(result.value.id);
}

/** Resolves a persona name and a script name to the script row. */
function findScriptRow(
  db: Database.Database,
  persona: string,
  name: string,
): Result<{ personaId: string; scriptId: string }, CliError> {
  if (!SCRIPT_NAME_PATTERN.test(name)) {
    return err(new CliError(`Invalid script name: "${name}"`));
  }
  const personaId = findPersonaId(db, persona);
  if (personaId.isErr()) return err(personaId.error);
  const script = new ScriptRepository(db).findScript(personaId.value, name);
  if (script.isErr()) {
    return err(new CliError(`Database error looking up script: ${script.error.message}`));
  }
  if (script.value === null) {
    return err(new CliError(`Unknown script: "${name}" for persona "${persona}"`));
  }
  return ok({ personaId: personaId.value, scriptId: script.value.id });
}

function listVersionsOf(
  db: Database.Database,
  scriptId: string,
): Result<ScriptVersionRow[], CliError> {
  const versions = new ScriptRepository(db).listVersions(scriptId);
  if (versions.isErr()) {
    return err(new CliError(`Database error loading versions: ${versions.error.message}`));
  }
  return ok(versions.value);
}

// ---------------------------------------------------------------------------
// Core logic (importable, no console / process.exit)
// ---------------------------------------------------------------------------

/**
 * Lists the scripts of one persona, or of every persona when `persona` is not
 * given, with the newest version, the approved version and the last run.
 */
export function listScripts(options: {
  db: Database.Database;
  persona?: string;
}): Result<ScriptListEntry[], CliError> {
  const { db, persona } = options;
  const personaRepo = new PersonaRepository(db);
  const scriptRepo = new ScriptRepository(db);

  let personas: Array<{ id: string; name: string }>;
  if (persona !== undefined) {
    const id = findPersonaId(db, persona);
    if (id.isErr()) return err(id.error);
    personas = [{ id: id.value, name: persona }];
  } else {
    const all = personaRepo.findAll();
    if (all.isErr()) {
      return err(new CliError(`Database error loading personas: ${all.error.message}`));
    }
    personas = all.value.map((p) => ({ id: p.id, name: p.name }));
  }

  const entries: ScriptListEntry[] = [];
  for (const p of personas) {
    const scripts = scriptRepo.listScripts(p.id);
    if (scripts.isErr()) {
      return err(new CliError(`Database error loading scripts: ${scripts.error.message}`));
    }
    for (const script of scripts.value) {
      const latest = scriptRepo.latestVersion(script.id);
      const approved = scriptRepo.latestApproved(script.id);
      const lastRun = scriptRepo.listRuns(script.id, 1);
      if (latest.isErr() || approved.isErr() || lastRun.isErr()) {
        return err(new CliError('Database error loading script details'));
      }
      entries.push({
        persona: p.name,
        name: script.name,
        latestVersion: latest.value?.version ?? null,
        latestState: latest.value?.state ?? null,
        approvedVersion: approved.value?.version ?? null,
        lastRunAt: toIso(lastRun.value[0]?.started_at ?? null),
      });
    }
  }
  return ok(entries);
}

/**
 * Shows the versions of a script with state and content hash. With `version`,
 * only that version is returned.
 */
export function showScript(options: {
  db: Database.Database;
  persona: string;
  name: string;
  version?: number;
}): Result<ScriptShowResult, CliError> {
  const { db, persona, name, version } = options;
  const found = findScriptRow(db, persona, name);
  if (found.isErr()) return err(found.error);

  const rows = listVersionsOf(db, found.value.scriptId);
  if (rows.isErr()) return err(rows.error);

  let selected = rows.value;
  if (version !== undefined) {
    selected = rows.value.filter((r) => r.version === version);
    if (selected.length === 0) {
      return err(new CliError(`Unknown version ${version} of script "${name}"`));
    }
  }

  return ok({
    persona,
    name,
    scriptId: found.value.scriptId,
    versions: selected.map((r) => ({
      version: r.version,
      state: r.state,
      contentHash: r.content_hash,
      createdAt: new Date(r.created_at).toISOString(),
    })),
  });
}

/** Lists the runs of all versions of a script, newest first. */
export function listScriptRuns(options: {
  db: Database.Database;
  persona: string;
  name: string;
  limit: number;
}): Result<ScriptRunEntry[], CliError> {
  const { db, persona, name, limit } = options;
  if (!Number.isInteger(limit) || limit < 1) {
    return err(new CliError('--limit must be a positive integer'));
  }
  const found = findScriptRow(db, persona, name);
  if (found.isErr()) return err(found.error);

  const runs = new ScriptRepository(db).listRuns(found.value.scriptId, limit);
  if (runs.isErr()) {
    return err(new CliError(`Database error loading runs: ${runs.error.message}`));
  }
  const versions = listVersionsOf(db, found.value.scriptId);
  if (versions.isErr()) return err(versions.error);
  const numberOf = new Map(versions.value.map((v) => [v.id, v.version]));

  return ok(runs.value.map((r: ScriptRunRow) => toRunEntry(r, numberOf.get(r.version_id) ?? 0)));
}

function toRunEntry(row: ScriptRunRow, version: number): ScriptRunEntry {
  let result: ScriptRunEntry['result'] = 'failed';
  if (row.ended_at === null) {
    result = 'running';
  } else if (row.ok === 1) {
    result = 'ok';
  }
  return {
    version,
    trigger: row.trigger,
    mode: row.mode,
    result,
    errorCode: row.error_code,
    callCount: row.call_count,
    startedAt: new Date(row.started_at).toISOString(),
  };
}

/**
 * Makes model-written text safe for a terminal: every control character except
 * newline and tab (ESC and C1 included), every format character and U+2028 and
 * U+2029 become a visible `\xNN` or `\uNNNN` escape.
 */
export function escapeForTerminal(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu, (ch) => {
    const code = ch.codePointAt(0)!;
    if (code <= 0xff) return `\\x${code.toString(16).padStart(2, '0')}`;
    if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, '0')}`;
    return `\\u{${code.toString(16)}}`;
  });
}

/**
 * Reads the regular files of one stored version from
 * `<root>/<scriptId>/v<version>/`. Symbolic links and other non-regular entries
 * are skipped. At most {@link MAX_CODE_FILES} files are read.
 */
export function readVersionFiles(options: {
  root: string;
  scriptId: string;
  version: number;
}): Result<ScriptCodeResult, CliError> {
  const { root, scriptId, version } = options;
  if (!SCRIPT_ID_PATTERN.test(scriptId) || !Number.isInteger(version) || version < 1) {
    return err(new CliError('Invalid script version'));
  }
  const versionDir = join(root, scriptId, `v${version}`);
  const unreadable = (): CliError => new CliError('The files of this version cannot be read');

  try {
    if (!lstatSync(versionDir).isDirectory()) return err(unreadable());
    const paths = collectFiles(versionDir, '').sort();
    const files: ScriptFileText[] = [];
    for (const path of paths.slice(0, MAX_CODE_FILES)) {
      files.push({
        path: escapeForTerminal(path),
        content: escapeForTerminal(readFileSync(join(versionDir, path), 'utf8')),
      });
    }
    return ok({ files, truncated: paths.length > MAX_CODE_FILES });
  } catch {
    return err(unreadable());
  }
}

/** Relative paths of the regular files under `dir`. Never follows symbolic links. */
function collectFiles(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...collectFiles(dir, relative));
    } else if (entry.isFile()) {
      out.push(relative);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Printing helpers
// ---------------------------------------------------------------------------

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const formatRow = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(formatRow(header));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

/** Loads the config and opens the database. Exits on failure. */
async function openDatabase(
  configPath: string,
): Promise<{ db: Database.Database; scriptsRoot: string }> {
  const { loadConfig } = await import('../../core/config/config-loader.js');
  const { createDatabase } = await import('../../core/database/connection.js');

  const configResult = loadConfig(configPath);
  if (configResult.isErr()) {
    fail(`Error loading config: ${configResult.error.message}`);
  }
  const dbResult = createDatabase(configResult.value.storage.path);
  if (dbResult.isErr()) {
    fail(`Error opening database: ${dbResult.error.message}`);
  }
  return { db: dbResult.value, scriptsRoot: configResult.value.scripts.root };
}

// ---------------------------------------------------------------------------
// CLI wrappers
// ---------------------------------------------------------------------------

/** CLI entrypoint for `talonctl script list`. */
export async function scriptListCommand(options: {
  configPath: string;
  persona?: string;
}): Promise<void> {
  const { db } = await openDatabase(options.configPath);
  try {
    const result = listScripts({ db, persona: options.persona });
    if (result.isErr()) fail(result.error.message);
    if (result.value.length === 0) {
      console.log('No scripts found.');
      return;
    }
    printTable(
      ['PERSONA', 'NAME', 'NEWEST', 'STATE', 'APPROVED', 'LAST RUN'],
      result.value.map((s) => [
        s.persona,
        s.name,
        s.latestVersion === null ? '—' : `v${s.latestVersion}`,
        s.latestState ?? '—',
        s.approvedVersion === null ? '—' : `v${s.approvedVersion}`,
        s.lastRunAt ?? '—',
      ]),
    );
  } finally {
    db.close();
  }
}

/** CLI entrypoint for `talonctl script show`. */
export async function scriptShowCommand(options: {
  configPath: string;
  persona: string;
  name: string;
  version?: number;
  code?: boolean;
}): Promise<void> {
  const { db, scriptsRoot } = await openDatabase(options.configPath);
  try {
    const result = showScript({
      db,
      persona: options.persona,
      name: options.name,
      version: options.version,
    });
    if (result.isErr()) fail(result.error.message);
    const shown = result.value;

    console.log(`Script: ${shown.persona}/${shown.name}`);
    if (shown.versions.length === 0) {
      console.log('No versions.');
    } else {
      printTable(
        ['VERSION', 'STATE', 'HASH', 'CREATED'],
        shown.versions.map((v) => [`v${v.version}`, v.state, v.contentHash, v.createdAt]),
      );
    }

    if (options.code) {
      const newest = shown.versions[0];
      if (newest === undefined) fail('the script has no version to show code for');
      const code = readVersionFiles({
        root: scriptsRoot,
        scriptId: shown.scriptId,
        version: newest.version,
      });
      if (code.isErr()) fail(code.error.message);
      for (const file of code.value.files) {
        console.log(`\n=== ${file.path} ===`);
        console.log(file.content);
      }
      if (code.value.truncated) {
        console.log(`\nShowing the first ${MAX_CODE_FILES} files. More files exist.`);
      }
    }
  } finally {
    db.close();
  }
}

/** CLI entrypoint for `talonctl script runs`. */
export async function scriptRunsCommand(options: {
  configPath: string;
  persona: string;
  name: string;
  limit: number;
}): Promise<void> {
  const { db } = await openDatabase(options.configPath);
  try {
    const result = listScriptRuns({
      db,
      persona: options.persona,
      name: options.name,
      limit: options.limit,
    });
    if (result.isErr()) fail(result.error.message);
    if (result.value.length === 0) {
      console.log('No runs found.');
      return;
    }
    printTable(
      ['VERSION', 'TRIGGER', 'MODE', 'RESULT', 'ERROR', 'CALLS', 'STARTED'],
      result.value.map((r) => [
        `v${r.version}`,
        r.trigger,
        r.mode,
        r.result,
        r.errorCode ?? '—',
        String(r.callCount),
        r.startedAt,
      ]),
    );
  } finally {
    db.close();
  }
}
