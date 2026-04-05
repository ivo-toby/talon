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
import { getNextCronTime, isValidCronExpression } from '../../scheduler/cron-evaluator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddScheduleOptions {
  persona: string;
  channel: string;
  cron: string;
  label: string;
  prompt: string;
  db: Database.Database;
}

export interface AddScheduleResult {
  id: string;
  threadId: string;
  expression: string;
  label: string;
  nextRunAt: number;
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
  const { db, persona, channel, cron, label, prompt } = options;

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
  const scheduleId = uuidv4();
  const scheduleRepo = new ScheduleRepository(db);
  const payload = JSON.stringify({ label, prompt });

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
  prompt: string;
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
      prompt: options.prompt,
      db,
    });

    console.log(`Schedule created successfully.`);
    console.log(`  ID:         ${result.id}`);
    console.log(`  Thread:     ${result.threadId}`);
    console.log(`  Expression: ${result.expression}`);
    console.log(`  Label:      ${result.label}`);
    console.log(`  Next run:   ${new Date(result.nextRunAt).toISOString()}`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}
