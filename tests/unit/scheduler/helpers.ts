/**
 * Shared test helpers for scheduler unit tests.
 *
 * Provides a fully-migrated in-memory SQLite database and seed utilities
 * for schedule, persona, thread, and channel rows.
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { ScheduleRepository } from '../../../src/core/database/repositories/schedule-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';

/** Absolute path to SQL migrations. */
function migrationsDir(): string {
  return join(import.meta.dirname, '../../../src/core/database/migrations');
}

/**
 * Creates a fully-migrated in-memory SQLite database.
 * Throws on migration failure (test setup error, not domain error).
 */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const result = runMigrations(db, migrationsDir());
  if (result.isErr()) {
    throw new Error(`Test DB migration failed: ${result.error.message}`);
  }
  return db;
}

/** Generates a random UUID. */
export function uuid(): string {
  return uuidv4();
}

/** Creates a silent pino logger for use in tests. */
export function createTestLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

/**
 * Seeds a persona row and returns its id.
 */
export function seedPersona(db: Database.Database): string {
  const personas = new PersonaRepository(db);
  const id = uuid();
  const result = personas.insert({
    id,
    name: `persona-${uuid()}`,
    model: 'claude-sonnet-4-6',
    system_prompt_file: null,
    skills: '[]',
    capabilities: '{}',
    max_concurrent: null,
  });
  if (result.isErr()) {
    throw new Error(`Failed to seed persona: ${result.error.message}`);
  }
  return id;
}

/**
 * Seeds a channel and thread into the database, returning the thread ID.
 */
export function seedThread(db: Database.Database): string {
  const channels = new ChannelRepository(db);
  const threads = new ThreadRepository(db);

  const channelId = uuid();
  channels.insert({
    id: channelId,
    type: 'telegram',
    name: `ch-${uuid()}`,
    config: '{}',
    credentials_ref: null,
    enabled: 1,
  });

  const threadId = uuid();
  threads.insert({
    id: threadId,
    channel_id: channelId,
    external_id: `ext-${uuid()}`,
    metadata: '{}',
  });

  return threadId;
}

/**
 * Seeds a schedule row that is due for execution (next_run_at is in the past).
 *
 * @param db         - Open database instance.
 * @param personaId  - Persona FK.
 * @param threadId   - Thread FK (may be null).
 * @param overrides  - Optional field overrides.
 */
export function seedDueSchedule(
  db: Database.Database,
  personaId: string,
  threadId: string | null,
  overrides: Partial<{
    type: 'cron' | 'interval' | 'one_shot' | 'event';
    expression: string;
    payload: string;
    next_run_at: number;
  }> = {},
): string {
  const repo = new ScheduleRepository(db);
  const id = uuid();
  const now = Date.now();
  const result = repo.insert({
    id,
    persona_id: personaId,
    thread_id: threadId,
    type: overrides.type ?? 'one_shot',
    expression: overrides.expression ?? String(now + 5000),
    payload: overrides.payload ?? '{}',
    enabled: 1,
    last_run_at: null,
    // Default: in the past so it is immediately due
    next_run_at: overrides.next_run_at ?? now - 1000,
  });
  if (result.isErr()) {
    throw new Error(`Failed to seed schedule: ${result.error.message}`);
  }
  return id;
}
