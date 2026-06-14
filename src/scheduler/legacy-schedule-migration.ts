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
  /** Schedules that could not be healed (missing thread row, missing persona, etc.). */
  skipped: number;
}

/**
 * Checks whether a thread's metadata already carries the schedule marker.
 * Returns the embedded originExternalId when present, otherwise null.
 */
function readMarker(metadataJson: string | null | undefined): string | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
    if (parsed && parsed.kind === SCHEDULE_THREAD_KIND && typeof parsed.originExternalId === 'string') {
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
  if (!externalId.startsWith('schedule:')) return null;
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
    skipped: 0,
  };

  const schedulesResult = scheduleRepo.findAll();
  if (schedulesResult.isErr()) {
    logger.error({ err: schedulesResult.error }, 'schedule-migration: failed to list schedules, skipping');
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
      // A previous version of this migration would, for threads whose
      // external_id was an old 3-part synthetic `schedule:<persona>:<channel>`
      // shape, fall through to Case C and concatenate that synthetic id
      // as if it were a real recipient — producing doubly-nested
      // external_ids and, in metadata, an `originExternalId` that is
      // itself synthetic. channel.send and agent-runner then handed
      // that synthetic id to the connector and got `chat not found`.
      // Refuse such corrupted markers loudly so production schedules
      // stop being treated as healthy. We can't auto-recover the real
      // chat id from a synthetic origin alone (issue #205).
      if (existingMarker.startsWith('schedule:')) {
        logger.error(
          {
            scheduleId: schedule.id,
            threadId: thread.id,
            externalId: thread.external_id,
            corruptedOriginExternalId: existingMarker,
            personaId: schedule.persona_id,
            channelId: thread.channel_id,
          },
          'schedule-migration: thread metadata is corrupted — originExternalId is itself synthetic; delete and recreate the schedule from a live chat to fix',
        );
        result.skipped += 1;
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

    // Case C — schedule stored on a live chat thread (pre-issue-#200).
    // Provision or reuse the canonical dedicated schedule thread and
    // rebind the schedule onto it. The live thread's external_id is a
    // real provider recipient, so we capture it as the originExternalId.
    //
    // Refuse if the existing thread's external_id is itself synthetic
    // (starts with `schedule:`). Earlier versions of this migration
    // mistakenly treated such ids as a real recipient and produced
    // doubly-nested external_ids whose `originExternalId` was still
    // synthetic — which channel.send and agent-runner then handed to
    // the connector, getting "chat not found" rejections. We can't
    // recover the real chat id from a synthetic external_id alone, so
    // log a structured error per affected schedule and leave it on the
    // legacy thread for manual remediation (issue #205).
    if (thread.external_id.startsWith('schedule:')) {
      logger.error(
        {
          scheduleId: schedule.id,
          threadId: thread.id,
          syntheticExternalId: thread.external_id,
          personaId: schedule.persona_id,
          channelId: thread.channel_id,
        },
        'schedule-migration: refusing to migrate — thread external_id is itself synthetic, cannot recover origin chat id; delete and recreate the schedule from a live chat to fix',
      );
      result.skipped += 1;
      continue;
    }
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

  logger.info(result, 'schedule-migration: complete');
  return result;
}
