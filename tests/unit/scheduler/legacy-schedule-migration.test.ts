/**
 * Unit tests for the legacy schedule migration.
 *
 * Uses real in-memory SQLite + real repositories (via helpers.ts) so the
 * migration exercises the actual row shapes and FK constraints it would
 * see in production.
 */

import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { ScheduleRepository } from '../../../src/core/database/repositories/schedule-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { migrateLegacySchedules } from '../../../src/scheduler/legacy-schedule-migration.js';
import { createTestDb, createTestLogger, seedPersona } from './helpers.js';

interface Seeded {
  channelId: string;
  liveThreadId: string;
  liveExternalId: string;
  personaId: string;
  personaName: string;
  channelName: string;
}

function seedChannelAndLiveThread(db: ReturnType<typeof createTestDb>, liveExternalId = '74575531'): Seeded {
  const channels = new ChannelRepository(db);
  const threads = new ThreadRepository(db);
  const personas = new PersonaRepository(db);

  const channelId = uuidv4();
  const channelName = `ch-${uuidv4()}`;
  channels.insert({
    id: channelId,
    type: 'telegram',
    name: channelName,
    config: '{}',
    credentials_ref: null,
    enabled: 1,
  });

  const liveThreadId = uuidv4();
  threads.insert({
    id: liveThreadId,
    channel_id: channelId,
    external_id: liveExternalId,
    metadata: JSON.stringify({ providerAffinityResetAt: null }),
  });

  const personaId = uuidv4();
  const personaName = `persona-${uuidv4()}`;
  personas.insert({
    id: personaId,
    name: personaName,
    model: 'claude-sonnet-4-6',
    system_prompt_file: null,
    skills: '[]',
    capabilities: '{}',
    mounts: '[]',
    max_concurrent: null,
  });

  return {
    channelId,
    liveThreadId,
    liveExternalId,
    personaId,
    personaName,
    channelName,
  };
}

function seedSchedule(
  db: ReturnType<typeof createTestDb>,
  personaId: string,
  threadId: string,
  overrides: { payload?: string; expression?: string } = {},
): string {
  const repo = new ScheduleRepository(db);
  const id = uuidv4();
  repo.insert({
    id,
    persona_id: personaId,
    thread_id: threadId,
    type: 'cron',
    expression: overrides.expression ?? '0 9 * * *',
    payload: overrides.payload ?? '{"label":"legacy","prompt":"ping"}',
    enabled: 1,
    last_run_at: null,
    next_run_at: Date.now() + 60_000,
  });
  return id;
}

describe('migrateLegacySchedules', () => {
  it('rebinds schedules stored on a live chat thread onto a dedicated schedule thread', () => {
    const db = createTestDb();
    const seeded = seedChannelAndLiveThread(db);
    const scheduleId = seedSchedule(db, seeded.personaId, seeded.liveThreadId);

    const threads = new ThreadRepository(db);
    const result = migrateLegacySchedules({
      scheduleRepo: new ScheduleRepository(db),
      threadRepo: threads,
      channelRepo: new ChannelRepository(db),
      personaRepo: new PersonaRepository(db),
      logger: createTestLogger(),
    });

    expect(result.rebound).toBe(1);
    expect(result.metadataRehydrated).toBe(0);
    expect(result.alreadyMigrated).toBe(0);
    expect(result.skipped).toBe(0);

    // Schedule now points at a dedicated thread whose external_id encodes
    // persona:channel:origin AND whose metadata carries the origin marker.
    const schedRow = new ScheduleRepository(db).findById(scheduleId);
    expect(schedRow.isOk()).toBe(true);
    const newThreadId = schedRow._unsafeUnwrap()!.thread_id!;
    expect(newThreadId).not.toBe(seeded.liveThreadId);

    const dedicated = threads.findById(newThreadId);
    const dedicatedRow = dedicated._unsafeUnwrap()!;
    expect(dedicatedRow.external_id).toBe(
      `schedule:${seeded.personaName}:${seeded.channelName}:${seeded.liveExternalId}`,
    );
    const meta = JSON.parse(dedicatedRow.metadata) as Record<string, unknown>;
    expect(meta.kind).toBe('schedule');
    expect(meta.originExternalId).toBe(seeded.liveExternalId);
    expect(meta.migratedFrom).toBe('legacy-live-thread');
  });

  it('rehydrates metadata on old-style dedicated threads whose marker was never written', () => {
    const db = createTestDb();
    const seeded = seedChannelAndLiveThread(db);
    const threads = new ThreadRepository(db);

    // Old-style dedicated thread: correct external_id shape but metadata
    // never carried the { kind: 'schedule', ... } marker (the partial local
    // fix referenced in issue #200).
    const oldStyleId = uuidv4();
    threads.insert({
      id: oldStyleId,
      channel_id: seeded.channelId,
      external_id: `schedule:${seeded.personaName}:${seeded.channelName}:${seeded.liveExternalId}`,
      metadata: '{}',
    });
    const scheduleId = seedSchedule(db, seeded.personaId, oldStyleId);

    const result = migrateLegacySchedules({
      scheduleRepo: new ScheduleRepository(db),
      threadRepo: threads,
      channelRepo: new ChannelRepository(db),
      personaRepo: new PersonaRepository(db),
      logger: createTestLogger(),
    });

    expect(result.metadataRehydrated).toBe(1);
    expect(result.rebound).toBe(0);

    // Schedule.thread_id is unchanged — only the thread's metadata gained
    // the marker.
    const schedRow = new ScheduleRepository(db).findById(scheduleId);
    expect(schedRow._unsafeUnwrap()!.thread_id).toBe(oldStyleId);

    const dedicated = threads.findById(oldStyleId);
    const meta = JSON.parse(dedicated._unsafeUnwrap()!.metadata) as Record<string, unknown>;
    expect(meta.kind).toBe('schedule');
    expect(meta.originExternalId).toBe(seeded.liveExternalId);
    expect(meta.migratedFrom).toBe('legacy-dedicated-thread-without-marker');
  });

  it('is idempotent on schedules already on a properly-marked dedicated thread', () => {
    const db = createTestDb();
    const seeded = seedChannelAndLiveThread(db);
    const threads = new ThreadRepository(db);

    const dedicatedId = uuidv4();
    threads.insert({
      id: dedicatedId,
      channel_id: seeded.channelId,
      external_id: `schedule:${seeded.personaName}:${seeded.channelName}:${seeded.liveExternalId}`,
      metadata: JSON.stringify({
        kind: 'schedule',
        originExternalId: seeded.liveExternalId,
        personaName: seeded.personaName,
        channelName: seeded.channelName,
      }),
    });
    seedSchedule(db, seeded.personaId, dedicatedId);

    const result = migrateLegacySchedules({
      scheduleRepo: new ScheduleRepository(db),
      threadRepo: threads,
      channelRepo: new ChannelRepository(db),
      personaRepo: new PersonaRepository(db),
      logger: createTestLogger(),
    });

    expect(result.alreadyMigrated).toBe(1);
    expect(result.rebound).toBe(0);
    expect(result.metadataRehydrated).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('reuses an existing dedicated thread rather than creating a duplicate on rebind', () => {
    const db = createTestDb();
    const seeded = seedChannelAndLiveThread(db);
    const threads = new ThreadRepository(db);

    // A canonical dedicated thread already exists (e.g. schedule.manage ran
    // once after the upgrade).
    const canonicalId = uuidv4();
    threads.insert({
      id: canonicalId,
      channel_id: seeded.channelId,
      external_id: `schedule:${seeded.personaName}:${seeded.channelName}:${seeded.liveExternalId}`,
      metadata: JSON.stringify({
        kind: 'schedule',
        originExternalId: seeded.liveExternalId,
      }),
    });

    // Legacy schedule still on the live thread.
    const scheduleId = seedSchedule(db, seeded.personaId, seeded.liveThreadId);

    const result = migrateLegacySchedules({
      scheduleRepo: new ScheduleRepository(db),
      threadRepo: threads,
      channelRepo: new ChannelRepository(db),
      personaRepo: new PersonaRepository(db),
      logger: createTestLogger(),
    });

    expect(result.rebound).toBe(1);
    const schedRow = new ScheduleRepository(db).findById(scheduleId);
    expect(schedRow._unsafeUnwrap()!.thread_id).toBe(canonicalId);
  });

  it('preserves colons inside the origin external_id when parsing the synthetic marker', () => {
    // Slack encodes origin external_ids as `<channelId>:<thread_ts>` so the
    // migration must keep everything after the third colon intact.
    const db = createTestDb();
    const seeded = seedChannelAndLiveThread(db);
    const threads = new ThreadRepository(db);

    const slackLikeOrigin = 'C01234:1700000000.123';
    const oldStyleId = uuidv4();
    threads.insert({
      id: oldStyleId,
      channel_id: seeded.channelId,
      external_id: `schedule:${seeded.personaName}:${seeded.channelName}:${slackLikeOrigin}`,
      metadata: '{}',
    });
    seedSchedule(db, seeded.personaId, oldStyleId);

    const result = migrateLegacySchedules({
      scheduleRepo: new ScheduleRepository(db),
      threadRepo: threads,
      channelRepo: new ChannelRepository(db),
      personaRepo: new PersonaRepository(db),
      logger: createTestLogger(),
    });

    expect(result.metadataRehydrated).toBe(1);
    const meta = JSON.parse(threads.findById(oldStyleId)._unsafeUnwrap()!.metadata) as Record<string, unknown>;
    expect(meta.originExternalId).toBe(slackLikeOrigin);
  });

  it('skips schedules whose thread row no longer exists and logs a warning', () => {
    const db = createTestDb();
    const personaId = seedPersona(db);
    // Schedule points at a UUID that was never inserted into threads.
    // Schedule FK references threads(id), so we have to temporarily disable
    // FKs for this test seed — this mirrors the "dangling thread" state the
    // migration is designed to tolerate in production.
    db.pragma('foreign_keys = OFF');
    const scheduleRepo = new ScheduleRepository(db);
    const scheduleId = uuidv4();
    scheduleRepo.insert({
      id: scheduleId,
      persona_id: personaId,
      thread_id: uuidv4(),
      type: 'cron',
      expression: '0 9 * * *',
      payload: '{}',
      enabled: 1,
      last_run_at: null,
      next_run_at: Date.now() + 60_000,
    });
    db.pragma('foreign_keys = ON');

    const result = migrateLegacySchedules({
      scheduleRepo,
      threadRepo: new ThreadRepository(db),
      channelRepo: new ChannelRepository(db),
      personaRepo: new PersonaRepository(db),
      logger: createTestLogger(),
    });

    expect(result.skipped).toBe(1);
    expect(result.rebound).toBe(0);
    expect(result.metadataRehydrated).toBe(0);
  });

  it('refuses already-corrupted dedicated threads whose metadata.originExternalId is itself synthetic (issue #205)', () => {
    // Production-corrupted shape produced by an earlier version of this
    // migration: kind=schedule marker IS present but originExternalId
    // points to a synthetic `schedule:<persona>:<channel>` id rather
    // than the real chat recipient. Pre-fix the migration treated this
    // as alreadyMigrated and never logged. We now refuse and skip.
    const db = createTestDb();
    const seeded = seedChannelAndLiveThread(db);
    const threads = new ThreadRepository(db);

    const corruptedId = uuidv4();
    threads.insert({
      id: corruptedId,
      channel_id: seeded.channelId,
      external_id: `schedule:${seeded.personaName}:${seeded.channelName}:schedule:${seeded.personaName}:${seeded.channelName}`,
      metadata: JSON.stringify({
        kind: 'schedule',
        originExternalId: `schedule:${seeded.personaName}:${seeded.channelName}`,
        personaName: seeded.personaName,
        channelName: seeded.channelName,
        migratedFrom: 'legacy-live-thread',
      }),
    });
    const scheduleId = seedSchedule(db, seeded.personaId, corruptedId);

    const scheduleRepo = new ScheduleRepository(db);
    const result = migrateLegacySchedules({
      scheduleRepo,
      threadRepo: threads,
      channelRepo: new ChannelRepository(db),
      personaRepo: new PersonaRepository(db),
      logger: createTestLogger(),
    });

    expect(result.skipped).toBe(1);
    expect(result.alreadyMigrated).toBe(0);
    expect(result.rebound).toBe(0);
    expect(result.metadataRehydrated).toBe(0);

    // Schedule remains on the corrupted thread (no destructive automatic
    // recovery) — operator removes/recreates manually.
    const schedRow = scheduleRepo.findById(scheduleId);
    expect(schedRow._unsafeUnwrap()!.thread_id).toBe(corruptedId);
  });

  it('refuses to rebind when the thread external_id is itself synthetic (3-part schedule prefix) and skips the schedule (issue #205)', () => {
    // Pre-fix bug: a thread whose external_id matched the older 3-part
    // synthetic shape `schedule:<persona>:<channel>` (no origin appended,
    // no kind=schedule marker) flowed past parseSyntheticOrigin (length
    // < 4 → null) into Case C, which then concatenated it as if it were a
    // real chat id, producing a doubly-nested external_id and a synthetic
    // originExternalId. We now log + skip such cases, leaving the schedule
    // on its legacy thread for manual remediation.
    const db = createTestDb();
    const seeded = seedChannelAndLiveThread(db);
    const threads = new ThreadRepository(db);

    // 3-part synthetic external_id with no kind=schedule marker — exactly
    // the shape the buggy migration silently corrupted into doubly-nested
    // dedicated threads on production databases.
    const syntheticThreeId = uuidv4();
    threads.insert({
      id: syntheticThreeId,
      channel_id: seeded.channelId,
      external_id: `schedule:${seeded.personaName}:${seeded.channelName}`,
      metadata: '{}',
    });
    const scheduleId = seedSchedule(db, seeded.personaId, syntheticThreeId);

    const scheduleRepo = new ScheduleRepository(db);
    const result = migrateLegacySchedules({
      scheduleRepo,
      threadRepo: threads,
      channelRepo: new ChannelRepository(db),
      personaRepo: new PersonaRepository(db),
      logger: createTestLogger(),
    });

    expect(result.skipped).toBe(1);
    expect(result.rebound).toBe(0);
    expect(result.metadataRehydrated).toBe(0);

    // Schedule is still bound to the legacy thread — we did not create a
    // doubly-nested replacement.
    const schedRow = scheduleRepo.findById(scheduleId);
    expect(schedRow._unsafeUnwrap()!.thread_id).toBe(syntheticThreeId);

    // No new thread was created for this (persona, channel, synthetic
    // origin) tuple. (The only schedule-prefixed thread should remain the
    // one we seeded.)
    const candidate = threads.findByExternalId(
      seeded.channelId,
      `schedule:${seeded.personaName}:${seeded.channelName}:schedule:${seeded.personaName}:${seeded.channelName}`,
    );
    expect(candidate.isOk()).toBe(true);
    expect(candidate._unsafeUnwrap()).toBeNull();
  });

  it('skips schedules with a null thread_id', () => {
    const db = createTestDb();
    const personaId = seedPersona(db);
    db.pragma('foreign_keys = OFF');
    const scheduleRepo = new ScheduleRepository(db);
    scheduleRepo.insert({
      id: uuidv4(),
      persona_id: personaId,
      thread_id: null,
      type: 'cron',
      expression: '0 9 * * *',
      payload: '{}',
      enabled: 1,
      last_run_at: null,
      next_run_at: Date.now() + 60_000,
    });
    db.pragma('foreign_keys = ON');

    const result = migrateLegacySchedules({
      scheduleRepo,
      threadRepo: new ThreadRepository(db),
      channelRepo: new ChannelRepository(db),
      personaRepo: new PersonaRepository(db),
      logger: createTestLogger(),
    });

    expect(result.skipped).toBe(1);
  });
});
