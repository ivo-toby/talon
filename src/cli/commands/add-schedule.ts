/**
 * `talonctl add-schedule` command.
 *
 * Inserts a new cron schedule directly into the database, creating a
 * schedule thread for the persona+channel combination if one does not
 * already exist.
 *
 * The pure `addSchedule()` function can be called programmatically
 * (e.g. from a setup skill). The `addScheduleCommand()` wrapper handles
 * config loading, DB lifecycle, console output, and process.exit.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

import { ScheduleRepository } from '../../core/database/repositories/schedule-repository.js';
import { PersonaRepository } from '../../core/database/repositories/persona-repository.js';
import { ChannelRepository } from '../../core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../core/database/repositories/thread-repository.js';
import { ScriptRepository } from '../../core/database/repositories/script-repository.js';
import { getNextCronTime, isValidCronExpression } from '../../scheduler/cron-evaluator.js';
import { resolveRunInput } from '../../scripts/run-input.js';
import type { AuthoredManifest } from '../../scripts/types.js';
import { SCRIPT_NAME_PATTERN } from './script.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddScheduleOptions {
  persona: string;
  channel: string;
  cron: string;
  label: string;
  /**
   * Inline prompt text. Mutually exclusive with `promptFile`. Exactly one
   * of the two MUST be provided — `addSchedule()` throws otherwise.
   */
  prompt?: string;
  /**
   * Prompt file basename (no `.md`) in the persona's `prompts/` directory.
   * The scheduler resolves this to file content at fire time via
   * `personaLoader.resolveTaskPrompt`. Mutually exclusive with `prompt`.
   */
  promptFile?: string;
  /**
   * Name of a stored script of the persona. Mutually exclusive with `prompt`
   * and `promptFile`. Needs no approval to be scheduled.
   */
  script?: string;
  /** JSON text of the input of a script run. Needs `script`. */
  input?: string;
  db: Database.Database;
}

export interface AddScheduleResult {
  id: string;
  threadId: string;
  expression: string;
  label: string;
  nextRunAt: number;
  /** The script name of a script schedule, or null. */
  script: string | null;
  /** The approved version of the script when the schedule was added, or null. */
  approvedVersion: number | null;
}

// ---------------------------------------------------------------------------
// Core logic (importable, no console / process.exit)
// ---------------------------------------------------------------------------

/**
 * Creates a new cron schedule in the database.
 *
 * Looks up the persona and channel by name, finds or creates a schedule
 * thread for that combination, validates the cron expression, and inserts
 * the schedule row.
 *
 * @throws Error with a descriptive message on any failure.
 */
export function addSchedule(options: AddScheduleOptions): AddScheduleResult {
  const { db, persona, channel, cron, label, prompt, promptFile, script, input } = options;

  // --- Validate prompt vs promptFile vs script ----------------------------
  // Match the host-tool contract (schedule-manage.ts buildSchedulePayload):
  // a schedule needs either inline prompt text OR a promptFile alias OR a
  // script — never two of them, never none. Catching this here keeps the DB
  // clean even when addSchedule() is called programmatically.
  if (script !== undefined) {
    if (prompt !== undefined || promptFile !== undefined) {
      throw new Error('addSchedule: script is mutually exclusive with prompt and promptFile');
    }
    if (!SCRIPT_NAME_PATTERN.test(script)) {
      throw new Error(`addSchedule: Invalid script name: "${script}"`);
    }
  } else {
    if (input !== undefined) {
      throw new Error('addSchedule: input needs a script');
    }
    if (prompt !== undefined && promptFile !== undefined) {
      throw new Error('addSchedule: prompt and promptFile are mutually exclusive');
    }
    if (prompt === undefined && promptFile === undefined) {
      throw new Error('addSchedule: one of prompt or promptFile is required');
    }
  }

  // --- Validate cron expression (must be exactly 5 fields) ----------------
  const cronFields = cron.trim().split(/\s+/);
  if (cronFields.length !== 5) {
    throw new Error(`Invalid cron expression: "${cron}". Expected exactly 5 fields: "<minute> <hour> <day-of-month> <month> <day-of-week>"`);
  }
  if (!isValidCronExpression(cron)) {
    throw new Error(`Invalid cron expression: "${cron}"`);
  }

  // --- Look up persona by name -------------------------------------------
  const personaRepo = new PersonaRepository(db);
  const personaResult = personaRepo.findByName(persona);
  if (personaResult.isErr()) {
    throw new Error(`Database error looking up persona: ${personaResult.error.message}`);
  }
  const personaRow = personaResult.value;
  if (personaRow === null) {
    throw new Error(`Unknown persona: "${persona}"`);
  }

  // --- Script: look up, read the approved version, check the input -------
  // The input is parsed here so that text that is not JSON fails before any
  // row is written. A check against the manifest needs an approved version;
  // without one the input is stored as given and checked at run time.
  let scriptInput: unknown;
  let approvedVersion: number | null = null;
  if (script !== undefined) {
    const scripts = new ScriptRepository(db);
    const scriptResult = scripts.findScript(personaRow.id, script);
    if (scriptResult.isErr()) {
      throw new Error(`Database error looking up script: ${scriptResult.error.message}`);
    }
    if (scriptResult.value === null) {
      throw new Error(`Unknown script: "${script}" for persona "${persona}"`);
    }
    if (input !== undefined) {
      try {
        scriptInput = JSON.parse(input) as unknown;
      } catch {
        throw new Error('addSchedule: --input is not valid JSON');
      }
    }
    const approvedResult = scripts.latestApproved(scriptResult.value.id);
    if (approvedResult.isErr()) {
      throw new Error(`Database error looking up approved version: ${approvedResult.error.message}`);
    }
    const approved = approvedResult.value;
    if (approved !== null) {
      approvedVersion = approved.version;
      if (input !== undefined) {
        const manifest = JSON.parse(approved.manifest) as AuthoredManifest;
        const checked = resolveRunInput(manifest, scriptInput);
        if (checked.isErr()) {
          throw new Error(`addSchedule: ${checked.error.message}`);
        }
      }
    }
  }

  // --- Look up channel by name -------------------------------------------
  const channelRepo = new ChannelRepository(db);
  const channelResult = channelRepo.findByName(channel);
  if (channelResult.isErr()) {
    throw new Error(`Database error looking up channel: ${channelResult.error.message}`);
  }
  const channelRow = channelResult.value;
  if (channelRow === null) {
    throw new Error(`Unknown channel: "${channel}"`);
  }

  // --- Find or create schedule thread ------------------------------------
  const threadRepo = new ThreadRepository(db);
  const scheduleExternalId = `schedule:${persona}:${channel}`;
  let threadId: string;

  const existing = threadRepo.findByExternalId(channelRow.id, scheduleExternalId);
  if (existing.isErr()) {
    throw new Error(`Failed to look up schedule thread: ${existing.error.message}`);
  }
  if (existing.value !== null) {
    threadId = existing.value.id;
  } else {
    threadId = uuidv4();
    const insertResult = threadRepo.insert({
      id: threadId,
      channel_id: channelRow.id,
      external_id: scheduleExternalId,
      metadata: '{}',
    });
    if (insertResult.isErr()) {
      throw new Error(`Failed to create schedule thread: ${insertResult.error.message}`);
    }
  }

  // --- Compute next run time ---------------------------------------------
  const nextRunResult = getNextCronTime(cron);
  if (nextRunResult.isErr()) {
    throw new Error(`Failed to compute next run time: ${nextRunResult.error.message}`);
  }
  const nextRunAt = nextRunResult.value;

  // --- Insert schedule row -----------------------------------------------
  // Payload shape matches what the scheduler reads at fire time:
  //   { label, prompt }            — inline text used as-is
  //   { label, promptFile }        — basename resolved to prompts/<name>.md content
  //   { label, script, input? }    — stored script; input only when given
  // The three are mutually exclusive (validated above).
  const scheduleId = uuidv4();
  const scheduleRepo = new ScheduleRepository(db);
  let payload: string;
  if (script !== undefined) {
    payload = JSON.stringify(
      input !== undefined ? { label, script, input: scriptInput } : { label, script },
    );
  } else {
    payload = JSON.stringify(
      promptFile !== undefined ? { label, promptFile } : { label, prompt },
    );
  }

  const insertResult = scheduleRepo.insert({
    id: scheduleId,
    persona_id: personaRow.id,
    thread_id: threadId,
    type: 'cron',
    expression: cron,
    payload,
    enabled: 1,
    last_run_at: null,
    next_run_at: nextRunAt,
  });

  if (insertResult.isErr()) {
    throw new Error(`Failed to insert schedule: ${insertResult.error.message}`);
  }

  return {
    id: scheduleId,
    threadId,
    expression: cron,
    label,
    nextRunAt,
    script: script ?? null,
    approvedVersion,
  };
}

// ---------------------------------------------------------------------------
// Seeding helper
// ---------------------------------------------------------------------------

/**
 * Seeds persona and channel rows from config into the database if they
 * don't already exist. This allows CLI commands to work before the daemon
 * has ever booted.
 */
export function seedFromConfig(
  db: import('better-sqlite3').Database,
  config: {
    personas: Array<{
      name: string;
      model: string;
      systemPromptFile?: string;
      skills: string[];
      capabilities: Record<string, unknown>;
      mounts?: unknown[];
    }>;
    channels: Array<{
      name: string;
      type: string;
      config: Record<string, unknown>;
    }>;
  },
  personaName: string,
  channelName: string,
): void {
  const personaRepo = new PersonaRepository(db);
  const channelRepo = new ChannelRepository(db);

  // Seed persona if not in DB.
  const personaResult = personaRepo.findByName(personaName);
  if (personaResult.isErr()) {
    throw new Error(`Failed to look up persona "${personaName}" in database: ${personaResult.error.message}`);
  }
  if (personaResult.value === null) {
    const personaConfig = config.personas.find((p) => p.name === personaName);
    if (!personaConfig) {
      throw new Error(`Persona "${personaName}" is not defined in the configuration file.`);
    }
    const insertResult = personaRepo.insert({
      id: uuidv4(),
      name: personaConfig.name,
      model: personaConfig.model,
      system_prompt_file: personaConfig.systemPromptFile ?? null,
      skills: JSON.stringify(personaConfig.skills),
      capabilities: JSON.stringify(personaConfig.capabilities),
      mounts: JSON.stringify(personaConfig.mounts ?? []),
      max_concurrent: null,
    });
    if (insertResult.isErr()) {
      throw new Error(`Failed to seed persona "${personaName}" in database: ${insertResult.error.message}`);
    }
  }

  // Seed channel if not in DB.
  const channelResult = channelRepo.findByName(channelName);
  if (channelResult.isErr()) {
    throw new Error(`Failed to look up channel "${channelName}" in database: ${channelResult.error.message}`);
  }
  if (channelResult.value === null) {
    const channelConfig = config.channels.find((c) => c.name === channelName);
    if (!channelConfig) {
      throw new Error(`Channel "${channelName}" is not defined in the configuration file.`);
    }
    const insertResult = channelRepo.insert({
      id: uuidv4(),
      type: channelConfig.type,
      name: channelConfig.name,
      config: JSON.stringify(channelConfig.config),
      credentials_ref: null,
      enabled: 1,
    });
    if (insertResult.isErr()) {
      throw new Error(`Failed to seed channel "${channelName}" in database: ${insertResult.error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/**
 * CLI entrypoint for `talonctl add-schedule`.
 *
 * Loads config to find the DB path, opens the database, delegates to
 * {@link addSchedule}, then prints the result and closes the DB.
 */
export async function addScheduleCommand(options: {
  persona: string;
  channel: string;
  cron: string;
  label: string;
  prompt?: string;
  promptFile?: string;
  script?: string;
  input?: string;
  configPath?: string;
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

  // Seed persona/channel from config so the command works before the daemon
  // has ever booted (the daemon normally seeds these on startup).
  seedFromConfig(db, configResult.value, options.persona, options.channel);

  try {
    const result = addSchedule({
      persona: options.persona,
      channel: options.channel,
      cron: options.cron,
      label: options.label,
      ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
      ...(options.promptFile !== undefined ? { promptFile: options.promptFile } : {}),
      ...(options.script !== undefined ? { script: options.script } : {}),
      ...(options.input !== undefined ? { input: options.input } : {}),
      db,
    });

    console.log(`Schedule created successfully.`);
    console.log(`  ID:         ${result.id}`);
    console.log(`  Thread:     ${result.threadId}`);
    console.log(`  Expression: ${result.expression}`);
    console.log(`  Label:      ${result.label}`);
    console.log(`  Next run:   ${new Date(result.nextRunAt).toISOString()}`);
    if (result.script !== null) {
      console.log(`  Script:     ${result.script}`);
      if (result.approvedVersion === null) {
        console.warn(
          `Warning: script "${result.script}" has no approved version yet. Runs will not start until one is approved.`,
        );
      }
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}
