/**
 * One-shot startup migration for schedules that predate the dedicated
 * schedule-thread model.
 *
 * Three legacy shapes exist in production databases and all three block
 * outbound delivery from scheduled runs (PR #201, https://github.com/ivo-toby/talon/issues/200):
 *
 *  1. Schedule.thread_id points at a live chat thread (pre-issue-#200).
 *     Execution mixes with the live conversation's session/OM state, but
 *     delivery still worked because the live thread's external_id is the
 *     real chat id.
 *  2. Schedule.thread_id points at an old-style dedicated thread whose
 *     external_id matches `schedule:<persona>:<channel>...` but whose
 *     metadata lacks `{ kind: 'schedule', originExternalId: ... }` (the
 *     partial local fix referenced in #200). channel.send for such runs
 *     now falls back to the synthetic external_id and the provider
 *     rejects with "chat not found".
 *  3. Schedule.thread_id references a thread row that no longer exists.
 *     Cannot be healed automatically — logged and skipped.
 *
 * Two shapes look legacy but are left alone:
 *
 *  - A CLI schedule thread `schedule:<persona>:<channel>` with no origin
 *    metadata (what `talonctl add-schedule` creates without `--origin`).
 *    It is valid: the schedule simply has no origin chat. A thread whose
 *    external_id starts with `schedule:` is never a live chat, so it is
 *    never rebound.
 *  - A thread whose origin is itself a synthetic `schedule:…` id, written
 *    by an earlier version of this migration that did rebind CLI threads
 *    (issue #205). The real chat cannot be recovered from it, so every
 *    boot logs one warning naming the affected schedule IDs and the
 *    `talonctl set-schedule-origin <id> --origin <chatId>` fix. The thread
 *    and its memory items are never touched.
 *
 * This module rehydrates metadata on old-style dedicated threads and
 * rebinds legacy-live-thread schedules onto the canonical dedicated
 * thread for their (persona, channel, origin) triple, using the same
 * logic as schedule.manage so all schedules end up in one consistent
 * shape after startup.
 *
 * Safe to run on every boot — already-healed schedules are detected by
 * the presence of the schedule-metadata marker and skipped.
 */

import { v4 as uuidv4 } from 'uuid';
import type pino from 'pino';
import type { ScheduleRepository } from '../core/database/repositories/schedule-repository.js';
import type { ThreadRepository } from '../core/database/repositories/thread-repository.js';
import type { ChannelRepository } from '../core/database/repositories/channel-repository.js';
import type { PersonaRepository } from '../core/database/repositories/persona-repository.js';

/** Metadata marker shared with schedule-manage.ts. */
const SCHEDULE_THREAD_KIND = 'schedule';

/** Prefix of every synthetic schedule-thread external_id. */
const SCHEDULE_THREAD_PREFIX = 'schedule:';

export interface LegacyScheduleMigrationDeps {
  scheduleRepo: ScheduleRepository;
  threadRepo: ThreadRepository;
  channelRepo: ChannelRepository;
  personaRepo: PersonaRepository;
  logger: pino.Logger;
}

export interface LegacyScheduleMigrationResult {
  /** Schedules whose dedicated thread was already correctly annotated. */
  alreadyMigrated: number;
  /** Old-style dedicated threads that needed metadata rehydration. */
  metadataRehydrated: number;
  /** Legacy-live-thread schedules that were rebound onto a dedicated thread. */
  rebound: number;
  /** Schedules on a CLI schedule thread without an origin — valid, left alone. */
  noOrigin: number;
  /**
   * Schedules whose thread's origin is itself a synthetic `schedule:…` id.
   * Left as they are and reported; the operator fixes each with
   * `talonctl set-schedule-origin`.
   */
  brokenOrigin: BrokenOriginSchedule[];
  /** Schedules that could not be healed (missing thread row, missing persona, etc.). */
  skipped: number;
}

/** A schedule whose thread carries a synthetic origin instead of a chat id. */
export interface BrokenOriginSchedule {
  scheduleId: string;
  threadId: string;
  externalId: string;
  originExternalId: string;
}

/**
 * Checks whether a thread's metadata already carries the schedule marker.
 * Returns the embedded originExternalId when present, otherwise null.
 */
function readMarker(metadataJson: string | null | undefined): string | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
    if (
      parsed &&
      parsed.kind === SCHEDULE_THREAD_KIND &&
      typeof parsed.originExternalId === 'string'
    ) {
      return parsed.originExternalId;
    }
  } catch {
    /* fall through — treat malformed metadata as absent */
  }
  return null;
}

/**
 * Parses the origin external_id out of an old-style synthetic
 * `schedule:<persona>:<channel>:<origin>` external id. Returns null when
 * the id doesn't match the expected prefix.
 *
 * Origin external ids may themselves contain colons (Slack encodes
 * `<channelId>:<thread_ts>`), so the origin is everything after the
 * third colon.
 */
function parseSyntheticOrigin(externalId: string): string | null {
  if (!externalId.startsWith(SCHEDULE_THREAD_PREFIX)) return null;
  const parts = externalId.split(':');
  if (parts.length < 4) return null;
  return parts.slice(3).join(':');
}

/**
 * Run the migration over every schedule in the database.
 *
 * Idempotent: schedules already on a thread with the correct marker are
 * a no-op. Safe to invoke on every daemon start.
 */
export function migrateLegacySchedules(
  deps: LegacyScheduleMigrationDeps,
): LegacyScheduleMigrationResult {
  const { scheduleRepo, threadRepo, channelRepo, personaRepo, logger } = deps;
  const result: LegacyScheduleMigrationResult = {
    alreadyMigrated: 0,
    metadataRehydrated: 0,
    rebound: 0,
    noOrigin: 0,
    brokenOrigin: [],
    skipped: 0,
  };

  const schedulesResult = scheduleRepo.findAll();
  if (schedulesResult.isErr()) {
    logger.error(
      { err: schedulesResult.error },
      'schedule-migration: failed to list schedules, skipping',
    );
    return result;
  }

  for (const schedule of schedulesResult.value) {
    if (schedule.thread_id === null) {
      // Nothing to heal — the scheduler already refuses to dispatch
      // schedules with a null thread_id.
      result.skipped += 1;
      continue;
    }

    const threadResult = threadRepo.findById(schedule.thread_id);
    if (threadResult.isErr()) {
      logger.warn(
        { scheduleId: schedule.id, threadId: schedule.thread_id, err: threadResult.error },
        'schedule-migration: failed to load thread, skipping',
      );
      result.skipped += 1;
      continue;
    }
    const thread = threadResult.value;
    if (!thread) {
      logger.warn(
        { scheduleId: schedule.id, threadId: schedule.thread_id },
        'schedule-migration: thread referenced by schedule is missing — cannot heal automatically',
      );
      result.skipped += 1;
      continue;
    }

    // Case A — already migrated.
    const existingMarker = readMarker(thread.metadata);
    if (existingMarker !== null) {
      // An earlier version of this migration rebound CLI schedule threads
      // as if they were live chats and stored their synthetic external_id
      // as the origin (issue #205). Such a schedule has no recipient and no
      // origin chat; report it instead of counting it as healthy.
      if (existingMarker.startsWith(SCHEDULE_THREAD_PREFIX)) {
        result.brokenOrigin.push({
          scheduleId: schedule.id,
          threadId: thread.id,
          externalId: thread.external_id,
          originExternalId: existingMarker,
        });
        continue;
      }
      result.alreadyMigrated += 1;
      continue;
    }

    // Case B — old-style dedicated thread whose metadata was never written.
    // Recover the origin from the synthetic external_id and rehydrate
    // metadata in place. No rebind needed: the schedule is already on the
    // right thread, only the marker is missing.
    const syntheticOrigin = parseSyntheticOrigin(thread.external_id);
    if (syntheticOrigin !== null && syntheticOrigin.startsWith(SCHEDULE_THREAD_PREFIX)) {
      // Doubly-nested thread whose marker was never written: the parsed
      // origin is a schedule thread, not a chat. Same remedy as above.
      result.brokenOrigin.push({
        scheduleId: schedule.id,
        threadId: thread.id,
        externalId: thread.external_id,
        originExternalId: syntheticOrigin,
      });
      continue;
    }
    if (syntheticOrigin !== null) {
      const personaResult = personaRepo.findById(schedule.persona_id);
      const channelResult = channelRepo.findById(thread.channel_id);
      const metadata = JSON.stringify({
        kind: SCHEDULE_THREAD_KIND,
        originExternalId: syntheticOrigin,
        personaName:
          personaResult.isOk() && personaResult.value ? personaResult.value.name : undefined,
        channelName:
          channelResult.isOk() && channelResult.value ? channelResult.value.name : undefined,
        migratedFrom: 'legacy-dedicated-thread-without-marker',
      });
      const updateResult = threadRepo.update(thread.id, { metadata });
      if (updateResult.isErr()) {
        logger.warn(
          { scheduleId: schedule.id, threadId: thread.id, err: updateResult.error },
          'schedule-migration: failed to rehydrate thread metadata, skipping',
        );
        result.skipped += 1;
        continue;
      }
      logger.info(
        {
          scheduleId: schedule.id,
          threadId: thread.id,
          originExternalId: syntheticOrigin,
        },
        'schedule-migration: rehydrated metadata on legacy dedicated schedule thread',
      );
      result.metadataRehydrated += 1;
      continue;
    }

    // A thread whose external_id starts with `schedule:` is never a live
    // chat. What reaches this point is a CLI schedule thread
    // (`schedule:<persona>:<channel>`, no origin metadata): a valid shape
    // for a schedule without an origin chat. Leave it where it is.
    if (thread.external_id.startsWith(SCHEDULE_THREAD_PREFIX)) {
      logger.debug(
        { scheduleId: schedule.id, threadId: thread.id, externalId: thread.external_id },
        'schedule-migration: schedule thread has no origin chat, leaving it as is',
      );
      result.noOrigin += 1;
      continue;
    }

    // Case C — schedule stored on a live chat thread (pre-issue-#200).
    // Provision or reuse the canonical dedicated schedule thread and
    // rebind the schedule onto it. The live thread's external_id is a
    // real provider recipient, so we capture it as the originExternalId.
    const personaResult = personaRepo.findById(schedule.persona_id);
    if (personaResult.isErr() || !personaResult.value) {
      logger.warn(
        { scheduleId: schedule.id, personaId: schedule.persona_id },
        'schedule-migration: persona not found, skipping',
      );
      result.skipped += 1;
      continue;
    }
    const channelResult = channelRepo.findById(thread.channel_id);
    if (channelResult.isErr() || !channelResult.value) {
      logger.warn(
        { scheduleId: schedule.id, channelId: thread.channel_id },
        'schedule-migration: channel not found, skipping',
      );
      result.skipped += 1;
      continue;
    }
    const personaName = personaResult.value.name;
    const channelName = channelResult.value.name;
    const originExternalId = thread.external_id;
    const dedicatedExternalId = `schedule:${personaName}:${channelName}:${originExternalId}`;

    const existing = threadRepo.findByExternalId(thread.channel_id, dedicatedExternalId);
    if (existing.isErr()) {
      logger.warn(
        { scheduleId: schedule.id, dedicatedExternalId, err: existing.error },
        'schedule-migration: failed to look up dedicated thread, skipping',
      );
      result.skipped += 1;
      continue;
    }

    let dedicatedThreadId: string;
    if (existing.value) {
      dedicatedThreadId = existing.value.id;
    } else {
      dedicatedThreadId = uuidv4();
      const metadata = JSON.stringify({
        kind: SCHEDULE_THREAD_KIND,
        originExternalId,
        personaName,
        channelName,
        migratedFrom: 'legacy-live-thread',
      });
      const insertResult = threadRepo.insert({
        id: dedicatedThreadId,
        channel_id: thread.channel_id,
        external_id: dedicatedExternalId,
        metadata,
      });
      if (insertResult.isErr()) {
        // Race: another migration step or schedule.manage already inserted
        // the same dedicated thread. Re-query and reuse.
        const retry = threadRepo.findByExternalId(thread.channel_id, dedicatedExternalId);
        if (retry.isOk() && retry.value) {
          dedicatedThreadId = retry.value.id;
        } else {
          logger.warn(
            { scheduleId: schedule.id, dedicatedExternalId, err: insertResult.error },
            'schedule-migration: failed to create dedicated thread, skipping',
          );
          result.skipped += 1;
          continue;
        }
      }
    }

    const rebindResult = scheduleRepo.rebindThread(schedule.id, dedicatedThreadId);
    if (rebindResult.isErr()) {
      logger.warn(
        { scheduleId: schedule.id, dedicatedThreadId, err: rebindResult.error },
        'schedule-migration: failed to rebind schedule to dedicated thread, skipping',
      );
      result.skipped += 1;
      continue;
    }

    logger.info(
      {
        scheduleId: schedule.id,
        oldThreadId: schedule.thread_id,
        newThreadId: dedicatedThreadId,
        personaName,
        channelName,
        originExternalId,
      },
      'schedule-migration: rebound legacy live-thread schedule onto dedicated schedule thread',
    );
    result.rebound += 1;
  }

  if (result.brokenOrigin.length > 0) {
    logger.warn(
      {
        scheduleIds: result.brokenOrigin.map((b) => b.scheduleId),
        schedules: result.brokenOrigin,
      },
      `schedule-migration: ${result.brokenOrigin.length} schedule(s) have a schedule thread as origin instead of a chat (left unchanged, memory untouched). For each, run: talonctl set-schedule-origin <id> --origin <chatId>`,
    );
  }

  logger.info(
    {
      alreadyMigrated: result.alreadyMigrated,
      metadataRehydrated: result.metadataRehydrated,
      rebound: result.rebound,
      noOrigin: result.noOrigin,
      brokenOrigin: result.brokenOrigin.length,
      skipped: result.skipped,
    },
    'schedule-migration: complete',
  );
  return result;
}
