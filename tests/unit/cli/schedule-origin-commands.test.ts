import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { ScheduleRepository } from '../../../src/core/database/repositories/schedule-repository.js';
import { MemoryRepository } from '../../../src/core/database/repositories/memory-repository.js';
import { addSchedule } from '../../../src/cli/commands/add-schedule.js';
import { setScheduleOrigin } from '../../../src/cli/commands/set-schedule-origin.js';
import { readScheduleOriginExternalId } from '../../../src/daemon/schedule-thread-utils.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

describe('schedule origin from the CLI', () => {
  let db: Database.Database;
  let threads: ThreadRepository;
  let schedules: ScheduleRepository;
  let channelId: string;

  const base = {
    persona: 'assistant',
    channel: 'TalonMain',
    cron: '0 3 * * *',
    label: 'memory-grooming',
    prompt: 'Groom the memory',
  };

  beforeEach(() => {
    db = createTestDb();
    threads = new ThreadRepository(db);
    schedules = new ScheduleRepository(db);
    new PersonaRepository(db).insert({
      id: uuid(),
      name: 'assistant',
      model: 'm',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });
    channelId = uuid();
    new ChannelRepository(db).insert({
      id: channelId,
      type: 'telegram',
      name: 'TalonMain',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('add-schedule without --origin keeps the shared persona/channel thread', () => {
    const result = addSchedule({ ...base, db });

    const thread = threads.findById(result.threadId)._unsafeUnwrap()!;
    expect(thread.external_id).toBe('schedule:assistant:TalonMain');
    expect(readScheduleOriginExternalId(thread.metadata)).toBeNull();
  });

  it('add-schedule --origin uses the dedicated thread schedule_manage would create', () => {
    const result = addSchedule({ ...base, origin: '123456789', db });

    const thread = threads.findById(result.threadId)._unsafeUnwrap()!;
    expect(thread.external_id).toBe('schedule:assistant:TalonMain:123456789');
    expect(readScheduleOriginExternalId(thread.metadata)).toBe('123456789');
    // A second schedule for the same chat shares that thread.
    expect(addSchedule({ ...base, label: 'review', origin: '123456789', db }).threadId).toBe(
      result.threadId,
    );
  });

  it('set-schedule-origin moves only that schedule and reports what stays behind', () => {
    const grooming = addSchedule({ ...base, db });
    const heartbeat = addSchedule({ ...base, label: 'heartbeat', db });
    new MemoryRepository(db).insert({
      id: 'heartbeat:sent',
      thread_id: grooming.threadId,
      type: 'note',
      content: 'x',
      embedding_ref: null,
      metadata: '{}',
    });
    threads.insert({ id: uuid(), channel_id: channelId, external_id: '123456789', metadata: '{}' });

    const result = setScheduleOrigin({ scheduleId: grooming.id, origin: ' 123456789 ', db });

    expect(result.moved).toBe(true);
    expect(result.originThreadExists).toBe(true);
    expect(result.memoryItemsLeftBehind).toBe(1);
    expect(result.otherSchedulesOnPreviousThread).toBe(1);
    const moved = schedules.findById(grooming.id)._unsafeUnwrap()!;
    expect(moved.thread_id).toBe(result.toThreadId);
    const target = threads.findById(result.toThreadId)._unsafeUnwrap()!;
    expect(readScheduleOriginExternalId(target.metadata)).toBe('123456789');
    // The other schedule and the old thread are untouched.
    expect(schedules.findById(heartbeat.id)._unsafeUnwrap()!.thread_id).toBe(heartbeat.threadId);
    expect(
      readScheduleOriginExternalId(threads.findById(heartbeat.threadId)._unsafeUnwrap()!.metadata),
    ).toBeNull();

    // Repeating it is a no-op.
    expect(setScheduleOrigin({ scheduleId: grooming.id, origin: '123456789', db }).moved).toBe(
      false,
    );
  });

  it('warns when no conversation with that chat ID exists yet, and rejects bad input', () => {
    const grooming = addSchedule({ ...base, db });

    expect(
      setScheduleOrigin({ scheduleId: grooming.id, origin: '999', db }).originThreadExists,
    ).toBe(false);
    expect(() => setScheduleOrigin({ scheduleId: grooming.id, origin: '  ', db })).toThrow(/empty/);
    expect(() =>
      setScheduleOrigin({ scheduleId: grooming.id, origin: 'schedule:assistant:TalonMain', db }),
    ).toThrow(/chat ID/);
    expect(() => setScheduleOrigin({ scheduleId: 'nope', origin: '1', db })).toThrow(/not found/);
  });
});
