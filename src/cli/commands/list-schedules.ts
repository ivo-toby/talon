/**
 * `talonctl list-schedules` command.
 *
 * Lists all schedules in the database, optionally filtered by persona.
 *
 * The pure `listSchedules()` function can be called programmatically.
 * The `listSchedulesCommand()` wrapper handles config loading, DB lifecycle,
 * console output, and process.exit.
 */

import type Database from 'better-sqlite3';

import { ScheduleRepository } from '../../core/database/repositories/schedule-repository.js';
import { PersonaRepository } from '../../core/database/repositories/persona-repository.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduleInfo {
  id: string;
  personaName: string;
  expression: string;
  label: string;
  prompt: string;
  promptFile: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

// ---------------------------------------------------------------------------
// Core logic (importable, no console / process.exit)
// ---------------------------------------------------------------------------

/**
 * Lists schedules from the database, optionally filtered by persona name.
 *
 * Resolves persona IDs to names and parses JSON payloads to extract
 * label and prompt fields.
 *
 * @throws Error with a descriptive message on any failure.
 */
export function listSchedules(options: { db: Database.Database; persona?: string }): ScheduleInfo[] {
  const { db, persona } = options;

  const personaRepo = new PersonaRepository(db);
  const scheduleRepo = new ScheduleRepository(db);

  // --- Build persona id→name map -------------------------------------------
  const allPersonasResult = personaRepo.findAll();
  if (allPersonasResult.isErr()) {
    throw new Error(`Database error loading personas: ${allPersonasResult.error.message}`);
  }
  const personaMap = new Map<string, string>();
  for (const p of allPersonasResult.value) {
    personaMap.set(p.id, p.name);
  }

  // --- Fetch schedules -----------------------------------------------------
  if (persona) {
    const personaResult = personaRepo.findByName(persona);
    if (personaResult.isErr()) {
      throw new Error(`Database error looking up persona: ${personaResult.error.message}`);
    }
    if (personaResult.value === null) {
      throw new Error(`Unknown persona: "${persona}"`);
    }

    const schedulesResult = scheduleRepo.findByPersona(personaResult.value.id);
    if (schedulesResult.isErr()) {
      throw new Error(`Database error loading schedules: ${schedulesResult.error.message}`);
    }

    return schedulesResult.value.map((row) => toScheduleInfo(row, personaMap));
  }

  const schedulesResult = scheduleRepo.findAll();
  if (schedulesResult.isErr()) {
    throw new Error(`Database error loading schedules: ${schedulesResult.error.message}`);
  }

  return schedulesResult.value.map((row) => toScheduleInfo(row, personaMap));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

function toScheduleInfo(
  row: { id: string; persona_id: string; expression: string; payload: string; enabled: number; next_run_at: number | null; last_run_at: number | null },
  personaMap: Map<string, string>,
): ScheduleInfo {
  let label = '';
  let prompt = '';
  let promptFile = '';
  try {
    const parsed = JSON.parse(row.payload) as Record<string, unknown>;
    label = typeof parsed.label === 'string' ? parsed.label : '';
    prompt = typeof parsed.prompt === 'string' ? parsed.prompt : '';
    promptFile = typeof parsed.promptFile === 'string' ? parsed.promptFile : '';
  } catch {
    // payload may not be valid JSON — leave defaults
  }

  return {
    id: row.id,
    personaName: personaMap.get(row.persona_id) ?? 'unknown',
    expression: row.expression,
    label,
    prompt,
    promptFile,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at !== null ? new Date(row.next_run_at).toISOString() : null,
    lastRunAt: row.last_run_at !== null ? new Date(row.last_run_at).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/**
 * CLI entrypoint for `talonctl list-schedules`.
 *
 * Loads config to find the DB path, opens the database, delegates to
 * {@link listSchedules}, then prints a table and closes the DB.
 */
export async function listSchedulesCommand(options: {
  configPath?: string;
  persona?: string;
}): Promise<void> {
  const { loadConfig } = await import('../../core/config/config-loader.js');
  const { createDatabase } = await import('../../core/database/connection.js');

  const configPath = options.configPath ?? 'talond.yaml';
  const configResult = loadConfig(configPath);
  if (configResult.isErr()) {
    console.error(`Error loading config: ${configResult.error.message}`);
    process.exit(1);
    return;
  }

  const dbResult = createDatabase(configResult.value.storage.path);
  if (dbResult.isErr()) {
    console.error(`Error opening database: ${dbResult.error.message}`);
    process.exit(1);
    return;
  }

  const db = dbResult.value;

  try {
    const schedules = listSchedules({ db, persona: options.persona });

    if (schedules.length === 0) {
      console.log('No schedules found.');
      return;
    }

    // Print table header
    const header = ['ID', 'PERSONA', 'LABEL', 'PROMPT', 'CRON', 'ENABLED', 'NEXT RUN'];
    const rows = schedules.map((s) => [
      s.id,
      s.personaName,
      s.label,
      s.promptFile ? `file:${s.promptFile}` : s.prompt ? truncate(s.prompt, 40) : '',
      s.expression,
      s.enabled ? 'yes' : 'no',
      s.nextRunAt ?? '—',
    ]);

    // Compute column widths
    const widths = header.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => r[i].length)),
    );

    const formatRow = (cols: string[]) =>
      cols.map((c, i) => c.padEnd(widths[i])).join('  ');

    console.log(formatRow(header));
    console.log(widths.map((w) => '─'.repeat(w)).join('  '));
    for (const row of rows) {
      console.log(formatRow(row));
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}
