/**
 * `talonctl set-schedule-origin` command.
 *
 * Gives an existing schedule an origin chat by moving it onto the dedicated
 * schedule thread for (persona, channel, origin) — the thread a schedule gets
 * when it is created from that chat with `schedule_manage`, or with
 * `talonctl add-schedule --origin`. Schedules created from the CLI without an
 * origin share one `schedule:<persona>:<channel>` thread and cannot reach
 * their chat's memory with `scope: "conversation"`.
 *
 * Only the schedule row moves. Memory items stay on the old thread, because a
 * thread can be shared by several schedules and no key says which schedule
 * wrote it; the result reports what was left behind.
 *
 * The pure `setScheduleOrigin()` function can be called programmatically.
 * The `setScheduleOriginCommand()` wrapper handles config loading, DB
 * lifecycle, console output, and process.exit.
 */

import type Database from 'better-sqlite3';

import { ScheduleRepository } from '../../core/database/repositories/schedule-repository.js';
import { PersonaRepository } from '../../core/database/repositories/persona-repository.js';
import { ChannelRepository } from '../../core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../core/database/repositories/thread-repository.js';
import { MemoryRepository } from '../../core/database/repositories/memory-repository.js';
import { findOrCreateDedicatedScheduleThread } from './add-schedule.js';

export interface SetScheduleOriginResult {
  scheduleId: string;
  fromThreadId: string;
  toThreadId: string;
  /** False when the schedule already was on that thread. */
  moved: boolean;
  /** Whether a conversation thread with that external ID exists on the channel. */
  originThreadExists: boolean;
  /** Memory items that stay on the previous thread. */
  memoryItemsLeftBehind: number;
  /** Other schedules that remain on the previous thread. */
  otherSchedulesOnPreviousThread: number;
}

/**
 * Moves a schedule onto the dedicated thread of its persona, its current
 * thread's channel and `origin`.
 *
 * @throws Error if the schedule, its thread, persona or channel cannot be
 *   found, the origin is empty, or a DB error occurs.
 */
export function setScheduleOrigin(options: {
  scheduleId: string;
  origin: string;
  db: Database.Database;
}): SetScheduleOriginResult {
  const { db, scheduleId } = options;
  const origin = options.origin.trim();
  if (origin === '') {
    throw new Error('Origin chat ID must not be empty');
  }
  if (origin.startsWith('schedule:')) {
    throw new Error(`Origin must be a chat ID, not a schedule thread ("${origin}")`);
  }

  const schedules = new ScheduleRepository(db);
  const threads = new ThreadRepository(db);

  const schedule = schedules.findById(scheduleId);
  if (schedule.isErr()) {
    throw new Error(`Database error looking up schedule: ${schedule.error.message}`);
  }
  if (schedule.value === null) {
    throw new Error(`Schedule not found: "${scheduleId}"`);
  }
  if (schedule.value.thread_id === null) {
    throw new Error(`Schedule "${scheduleId}" has no thread`);
  }
  const fromThreadId = schedule.value.thread_id;

  const thread = threads.findById(fromThreadId);
  if (thread.isErr() || thread.value === null) {
    throw new Error(`Thread of schedule "${scheduleId}" not found`);
  }
  const persona = new PersonaRepository(db).findById(schedule.value.persona_id);
  if (persona.isErr() || persona.value === null) {
    throw new Error(`Persona of schedule "${scheduleId}" not found`);
  }
  const channel = new ChannelRepository(db).findById(thread.value.channel_id);
  if (channel.isErr() || channel.value === null) {
    throw new Error(`Channel of schedule "${scheduleId}" not found`);
  }

  const toThreadId = findOrCreateDedicatedScheduleThread(db, {
    channelId: channel.value.id,
    channelName: channel.value.name,
    personaName: persona.value.name,
    originExternalId: origin,
  });

  const moved = toThreadId !== fromThreadId;
  if (moved) {
    const rebind = schedules.rebindThread(scheduleId, toThreadId);
    if (rebind.isErr()) {
      throw new Error(`Failed to move schedule: ${rebind.error.message}`);
    }
  }

  const originThread = threads.findByExternalId(channel.value.id, origin);
  const memory = new MemoryRepository(db).findByThread(fromThreadId);
  const remaining = schedules.findAll();

  return {
    scheduleId,
    fromThreadId,
    toThreadId,
    moved,
    originThreadExists: originThread.isOk() && originThread.value !== null,
    memoryItemsLeftBehind: moved && memory.isOk() ? memory.value.length : 0,
    otherSchedulesOnPreviousThread: remaining.isOk()
      ? remaining.value.filter((s) => s.thread_id === fromThreadId && s.id !== scheduleId).length
      : 0,
  };
}

/** CLI entrypoint for `talonctl set-schedule-origin`. */
export async function setScheduleOriginCommand(options: {
  scheduleId: string;
  origin: string;
  configPath?: string;
}): Promise<void> {
  const { loadConfig } = await import('../../core/config/config-loader.js');
  const { createDatabase } = await import('../../core/database/connection.js');

  const configResult = loadConfig(options.configPath ?? 'talond.yaml');
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
    const result = setScheduleOrigin({
      scheduleId: options.scheduleId,
      origin: options.origin,
      db,
    });
    if (!result.moved) {
      console.log(
        `Schedule ${result.scheduleId.slice(0, 8)}… already has origin "${options.origin.trim()}".`,
      );
      return;
    }
    console.log(
      `Schedule ${result.scheduleId.slice(0, 8)}… now serves chat "${options.origin.trim()}".`,
    );
    console.log(`  Thread: ${result.fromThreadId} -> ${result.toThreadId}`);
    if (!result.originThreadExists) {
      console.log(
        '  Warning: no conversation with that chat ID exists on this channel yet. ' +
          'Check the ID (`/chatid` in the chat); scope "conversation" works once the chat has spoken.',
      );
    }
    if (result.memoryItemsLeftBehind > 0) {
      console.log(
        `  Note: ${result.memoryItemsLeftBehind} memory item(s) stay on the previous thread` +
          (result.otherSchedulesOnPreviousThread > 0
            ? `, which ${result.otherSchedulesOnPreviousThread} other schedule(s) still use.`
            : '.') +
          ' This schedule no longer sees them under scope "thread".',
      );
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}
