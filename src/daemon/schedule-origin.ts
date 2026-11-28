/**
 * Resolves the conversation a schedule run serves.
 *
 * Since dedicated schedule threads (#200), a scheduled run executes on its own
 * `schedule:…` thread. Thread-scoped tools (`memory.access`, `db.query`) would
 * then only see that thread, so a scheduled maintenance task — grooming notes,
 * reviewing a week of conversation — never reaches the chat it was created
 * in. The origin chat is recorded on the schedule thread as
 * `originExternalId`; this module turns it into the chat's thread row, but
 * only when that chat is routed to the same persona, so a schedule never
 * reads or writes another persona's memory.
 *
 * The routing check mirrors `ChannelRouter`: a thread-scoped binding for the
 * chat decides alone; otherwise the channel default does.
 */

import { ok, type Result } from 'neverthrow';
import type { DbError } from '../core/errors/index.js';
import type { BindingRepository } from '../core/database/repositories/binding-repository.js';
import type {
  ThreadRepository,
  ThreadRow,
} from '../core/database/repositories/thread-repository.js';
import { readScheduleOriginExternalId } from './schedule-thread-utils.js';

/** Why a schedule thread has no usable origin conversation. */
export type ScheduleOriginUnavailableReason =
  'not_schedule_thread' | 'origin_thread_missing' | 'persona_mismatch';

export type ScheduleOriginResolution =
  { thread: ThreadRow } | { thread: null; reason: ScheduleOriginUnavailableReason };

export interface ScheduleOriginDeps {
  threadRepository: Pick<ThreadRepository, 'findByExternalId'>;
  bindingRepository: Pick<BindingRepository, 'findByChannelAndThread' | 'findDefaultForChannel'>;
}

/**
 * The origin conversation thread of `scheduleThread` when it belongs to the
 * same channel and is routed to `personaId`; otherwise a reason.
 */
export function resolveScheduleOriginThread(
  deps: ScheduleOriginDeps,
  scheduleThread: { channel_id: string; metadata: string | null | undefined },
  personaId: string,
): Result<ScheduleOriginResolution, DbError> {
  const originExternalId = readScheduleOriginExternalId(scheduleThread.metadata);
  if (originExternalId === null) {
    return ok({ thread: null, reason: 'not_schedule_thread' });
  }

  const originResult = deps.threadRepository.findByExternalId(
    scheduleThread.channel_id,
    originExternalId,
  );
  if (originResult.isErr())
    return originResult.map(() => ({ thread: null, reason: 'origin_thread_missing' as const }));
  const origin = originResult.value;
  if (origin === null) {
    return ok({ thread: null, reason: 'origin_thread_missing' });
  }

  const scoped = deps.bindingRepository.findByChannelAndThread(origin.channel_id, origin.id);
  if (scoped.isErr())
    return scoped.map(() => ({ thread: null, reason: 'persona_mismatch' as const }));
  let routedPersonaId: string | null = scoped.value?.persona_id ?? null;
  if (scoped.value === null) {
    const fallback = deps.bindingRepository.findDefaultForChannel(origin.channel_id);
    if (fallback.isErr()) {
      return fallback.map(() => ({ thread: null, reason: 'persona_mismatch' as const }));
    }
    routedPersonaId = fallback.value?.persona_id ?? null;
  }

  return ok(
    routedPersonaId === personaId
      ? { thread: origin }
      : { thread: null, reason: 'persona_mismatch' },
  );
}
