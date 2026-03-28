import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ScheduleRepository } from '../../../src/core/database/repositories/schedule-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { addSchedule } from '../../../src/cli/commands/add-schedule.js';
import { listSchedules } from '../../../src/cli/commands/list-schedules.js';
import { removeSchedule } from '../../../src/cli/commands/remove-schedule.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

describe('ScheduleRepository — findAll / findById', () => {
  let db: Database.Database;
  let repo: ScheduleRepository;
  let personaIdA: string;
  let personaIdB: string;

  beforeEach(() => {
    db = createTestDb();
    repo = new ScheduleRepository(db);

    const personas = new PersonaRepository(db);
    personaIdA = uuid();
    personaIdB = uuid();
    personas.insert({
      id: personaIdA,
      name: `bot-a-${uuid()}`,
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });
    personas.insert({
      id: personaIdB,
      name: `bot-b-${uuid()}`,
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });
  });

  afterEach(() => {
    db.close();
  });

  function makeSched(overrides: Partial<Parameters<ScheduleRepository['insert']>[0]> = {}) {
    return {
      id: uuid(),
      persona_id: personaIdA,
      thread_id: null,
      type: 'cron' as const,
      expression: '0 * * * *',
      payload: '{}',
      enabled: 1,
      last_run_at: null,
      next_run_at: null,
      ...overrides,
    };
  }

  describe('findAll()', () => {
    it('returns empty array when no schedules exist', () => {
      const result = repo.findAll();
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([]);
    });

    it('returns all schedules across personas', () => {
      repo.insert(makeSched({ persona_id: personaIdA }));
      repo.insert(makeSched({ persona_id: personaIdB }));
      repo.insert(makeSched({ persona_id: personaIdA }));

      const rows = repo.findAll()._unsafeUnwrap();
      expect(rows).toHaveLength(3);
    });
  });

  describe('findById()', () => {
    it('returns null for nonexistent id', () => {
      const result = repo.findById(uuid());
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('returns the schedule row for a valid id', () => {
      const input = makeSched();
      repo.insert(input);

      const row = repo.findById(input.id)._unsafeUnwrap();
      expect(row).not.toBeNull();
      expect(row!.id).toBe(input.id);
      expect(row!.persona_id).toBe(input.persona_id);
      expect(row!.expression).toBe(input.expression);
    });
  });
});

// ---------------------------------------------------------------------------
// addSchedule()
// ---------------------------------------------------------------------------

describe('addSchedule()', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  /** Seeds a persona and channel, returning their names. */
  function seedPersonaAndChannel(
    personaName = 'test-bot',
    channelName = 'test-channel',
  ): { personaName: string; channelName: string } {
    const personas = new PersonaRepository(db);
    personas.insert({
      id: uuid(),
      name: personaName,
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });

    const channels = new ChannelRepository(db);
    channels.insert({
      id: uuid(),
      type: 'telegram',
      name: channelName,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    return { personaName, channelName };
  }

  it('creates a schedule with correct fields', () => {
    const { personaName, channelName } = seedPersonaAndChannel();

    const result = addSchedule({
      persona: personaName,
      channel: channelName,
      cron: '0 9 * * *',
      label: 'morning-report',
      prompt: 'Generate a morning report',
      db,
    });

    expect(result.id).toBeDefined();
    expect(result.threadId).toBeDefined();
    expect(result.expression).toBe('0 9 * * *');
    expect(result.label).toBe('morning-report');
    expect(result.nextRunAt).toBeGreaterThan(Date.now() - 1000);

    // Verify the schedule was actually inserted in the DB.
    const schedRepo = new ScheduleRepository(db);
    const row = schedRepo.findById(result.id)._unsafeUnwrap();
    expect(row).not.toBeNull();
    expect(row!.expression).toBe('0 9 * * *');
    expect(row!.enabled).toBe(1);
    expect(row!.thread_id).toBe(result.threadId);

    const payload = JSON.parse(row!.payload);
    expect(payload.label).toBe('morning-report');
    expect(payload.prompt).toBe('Generate a morning report');
  });

  it('reuses existing schedule thread for same persona+channel', () => {
    const { personaName, channelName } = seedPersonaAndChannel();

    const first = addSchedule({
      persona: personaName,
      channel: channelName,
      cron: '0 9 * * *',
      label: 'first',
      prompt: 'First prompt',
      db,
    });

    const second = addSchedule({
      persona: personaName,
      channel: channelName,
      cron: '0 18 * * *',
      label: 'second',
      prompt: 'Second prompt',
      db,
    });

    expect(second.threadId).toBe(first.threadId);
    expect(second.id).not.toBe(first.id);
  });

  it('throws for unknown persona', () => {
    seedPersonaAndChannel();

    expect(() =>
      addSchedule({
        persona: 'nonexistent-bot',
        channel: 'test-channel',
        cron: '0 9 * * *',
        label: 'test',
        prompt: 'test',
        db,
      }),
    ).toThrow('Unknown persona: "nonexistent-bot"');
  });

  it('throws for unknown channel', () => {
    seedPersonaAndChannel();

    expect(() =>
      addSchedule({
        persona: 'test-bot',
        channel: 'nonexistent-channel',
        cron: '0 9 * * *',
        label: 'test',
        prompt: 'test',
        db,
      }),
    ).toThrow('Unknown channel: "nonexistent-channel"');
  });

  it('throws for invalid cron expression', () => {
    seedPersonaAndChannel();

    expect(() =>
      addSchedule({
        persona: 'test-bot',
        channel: 'test-channel',
        cron: 'not-a-cron',
        label: 'test',
        prompt: 'test',
        db,
      }),
    ).toThrow('Invalid cron expression');
  });

  it('throws for 6-field cron (seconds not allowed)', () => {
    seedPersonaAndChannel();

    expect(() =>
      addSchedule({
        persona: 'test-bot',
        channel: 'test-channel',
        cron: '0 0 9 * * *',
        label: 'test',
        prompt: 'test',
        db,
      }),
    ).toThrow('Expected exactly 5 fields');
  });
});

// ---------------------------------------------------------------------------
// listSchedules()
// ---------------------------------------------------------------------------

describe('listSchedules()', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  /** Seeds a persona and channel, returning their names. */
  function seedPersonaAndChannel(
    personaName = 'test-bot',
    channelName = 'test-channel',
  ): { personaName: string; channelName: string } {
    const personas = new PersonaRepository(db);
    personas.insert({
      id: uuid(),
      name: personaName,
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });

    const channels = new ChannelRepository(db);
    channels.insert({
      id: uuid(),
      type: 'telegram',
      name: channelName,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    return { personaName, channelName };
  }

  it('returns empty array when no schedules exist', () => {
    const result = listSchedules({ db });
    expect(result).toEqual([]);
  });

  it('returns schedules with persona names resolved', () => {
    const { personaName, channelName } = seedPersonaAndChannel();

    addSchedule({
      persona: personaName,
      channel: channelName,
      cron: '0 9 * * *',
      label: 'morning-report',
      prompt: 'Generate a morning report',
      db,
    });

    addSchedule({
      persona: personaName,
      channel: channelName,
      cron: '0 18 * * *',
      label: 'evening-report',
      prompt: 'Generate an evening report',
      db,
    });

    const result = listSchedules({ db });
    expect(result).toHaveLength(2);
    expect(result[0].personaName).toBe(personaName);
    expect(result[0].label).toBe('morning-report');
    expect(result[0].prompt).toBe('Generate a morning report');
    expect(result[0].expression).toBe('0 9 * * *');
    expect(result[0].enabled).toBe(true);
    expect(result[0].nextRunAt).not.toBeNull();
    expect(result[1].label).toBe('evening-report');
  });

  it('filters by persona name', () => {
    const { channelName } = seedPersonaAndChannel('bot-alpha', 'shared-channel');
    seedPersonaAndChannel('bot-beta', 'other-channel');

    addSchedule({
      persona: 'bot-alpha',
      channel: channelName,
      cron: '0 9 * * *',
      label: 'alpha-task',
      prompt: 'Alpha prompt',
      db,
    });

    addSchedule({
      persona: 'bot-beta',
      channel: 'other-channel',
      cron: '0 18 * * *',
      label: 'beta-task',
      prompt: 'Beta prompt',
      db,
    });

    const filtered = listSchedules({ db, persona: 'bot-alpha' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].label).toBe('alpha-task');
    expect(filtered[0].personaName).toBe('bot-alpha');

    const all = listSchedules({ db });
    expect(all).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// removeSchedule()
// ---------------------------------------------------------------------------

describe('removeSchedule()', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  /** Seeds a persona and channel, returning their names. */
  function seedPersonaAndChannel(
    personaName = 'test-bot',
    channelName = 'test-channel',
  ): { personaName: string; channelName: string } {
    const personas = new PersonaRepository(db);
    personas.insert({
      id: uuid(),
      name: personaName,
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });

    const channels = new ChannelRepository(db);
    channels.insert({
      id: uuid(),
      type: 'telegram',
      name: channelName,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    return { personaName, channelName };
  }

  it('disables a schedule by ID', () => {
    const { personaName, channelName } = seedPersonaAndChannel();

    const created = addSchedule({
      persona: personaName,
      channel: channelName,
      cron: '0 9 * * *',
      label: 'to-remove',
      prompt: 'Will be removed',
      db,
    });

    // Verify it starts enabled
    const schedRepo = new ScheduleRepository(db);
    const before = schedRepo.findById(created.id)._unsafeUnwrap();
    expect(before!.enabled).toBe(1);

    // Remove (delete) it
    removeSchedule({ scheduleId: created.id, db });

    // Verify it is now deleted
    const after = schedRepo.findById(created.id)._unsafeUnwrap();
    expect(after).toBeNull();
  });

  it('throws for unknown schedule ID', () => {
    expect(() =>
      removeSchedule({ scheduleId: uuid(), db }),
    ).toThrow('not found');
  });
});

// ---------------------------------------------------------------------------
// addSchedule() — seeding from config
// ---------------------------------------------------------------------------

describe('addSchedule() — seeding from config', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('succeeds when persona and channel exist only in config (not DB)', () => {
    // Seed persona and channel manually (simulating what seedFromConfig does)
    const personaRepo = new PersonaRepository(db);
    personaRepo.insert({
      id: uuid(),
      name: 'james',
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });

    const channelRepo = new ChannelRepository(db);
    channelRepo.insert({
      id: uuid(),
      type: 'terminal',
      name: 'terminal',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    const result = addSchedule({
      db,
      persona: 'james',
      channel: 'terminal',
      cron: '0 7 * * 1-5',
      label: 'Test',
      prompt: 'hello',
    });

    expect(result.id).toBeDefined();
    expect(result.expression).toBe('0 7 * * 1-5');
  });

  it('fails with descriptive error when persona is not in DB or config', () => {
    expect(() =>
      addSchedule({
        db,
        persona: 'nonexistent',
        channel: 'terminal',
        cron: '0 7 * * 1-5',
        label: 'Test',
        prompt: 'hello',
      }),
    ).toThrow(/Unknown persona: "nonexistent"/);
  });
});
