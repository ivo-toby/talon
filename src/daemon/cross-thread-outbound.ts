/**
 * Cross-thread outbound notices for resumed provider sessions.
 *
 * A scheduled task (or any run on another thread, or a background task) can
 * send a message into a conversation with `channel.send` or
 * `channel.broadcast`. The message is persisted on the recipient thread, but
 * a resumed provider session never re-reads the database, so without help the
 * agent cannot place the user's reply to it. Discarding the session fixed
 * that at the cost of the whole conversation; instead, the next resumed run
 * on the recipient thread is shown the messages its session has not seen, in
 * the live content of that turn.
 *
 * "Not seen" is derived from the database only, so a daemon restart between
 * the send and the reply loses nothing:
 *
 *   window = [watermark, currentRun.created_at)
 *   watermark = created_at of the latest completed, non-collaboration run on
 *               the thread that recorded the session being resumed
 *               (fallback: any completed non-collaboration run on the thread)
 *
 * Every resumed run on the session shows its window, and consecutive windows
 * partition the timeline, so each outbound is shown exactly once. A run that
 * fails does not move the watermark, so the next run shows its window again
 * (at-least-once on failure). Fresh sessions skip this entirely: their
 * ContextAssembler history already holds the messages.
 */

import { ok, type Result } from 'neverthrow';
import type { DbError } from '../core/errors/index.js';
import type {
  CrossThreadOutboundRow,
  MessageRepository,
} from '../core/database/repositories/message-repository.js';
import type { RunRepository } from '../core/database/repositories/run-repository.js';
import {
  renderOutboundNotice,
  renderOmittedOutboundLine,
  OUTBOUND_NOTICES_END_LINE,
  type OutboundNoticeSource,
} from '../pipeline/message-context.js';

/** Fixed budgets, measured by JavaScript `string.length` including framing. */
export const CROSS_THREAD_OUTBOUND_LIMITS = {
  /** Most notices shown in one turn; older ones are counted as omitted. */
  maxNotices: 20,
  /** Body characters per notice before truncation. */
  maxNoticeChars: 4_000,
  /** Aggregate characters of all rendered notices plus framing. */
  maxTotalChars: 16_000,
} as const;

/** Notices to prepend to one run's live content. */
export interface PendingCrossThreadOutbound {
  /** Rendered notices, chronological. */
  rendered: string[];
  /** Matches in the window that were not rendered (count or budget). */
  omitted: number;
  /** Aggregate `string.length` of the block that will be prepended. */
  charCount: number;
}

/** An empty result, for runs that resume nothing. */
export const NO_PENDING_CROSS_THREAD_OUTBOUND: PendingCrossThreadOutbound = {
  rendered: [],
  omitted: 0,
  charCount: 0,
};

export interface CrossThreadOutboundDeps {
  messageRepository: Pick<MessageRepository, 'findCrossThreadOutbound'>;
  runRepository: Pick<RunRepository, 'findCompletedRunWatermark'>;
}

export interface CrossThreadOutboundInput {
  threadId: string;
  /** Provider session ID the run resumes. */
  sessionId: string;
  /** `created_at` of the current run's row: the exclusive upper bound. */
  currentRunCreatedAt: number;
  /** Override for tests; defaults to {@link CROSS_THREAD_OUTBOUND_LIMITS}. */
  limits?: Partial<typeof CROSS_THREAD_OUTBOUND_LIMITS>;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local `YYYY-MM-DD HH:MM`, matching the system prompt's time context. */
export function formatNoticeTime(epochMs: number): string {
  const d = new Date(epochMs);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function sourceOf(row: CrossThreadOutboundRow): OutboundNoticeSource {
  if (row.source_thread_id === null) return 'background_task';
  if (
    row.source_queue_type === 'schedule' ||
    (row.source_thread_external_id ?? '').startsWith('schedule:')
  ) {
    return 'schedule';
  }
  return 'other_conversation';
}

function bodyOf(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return typeof parsed.body === 'string' ? parsed.body : content;
  } catch {
    return content;
  }
}

function truncateBody(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  return `${body.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Loads and renders the outbound messages the resumed session on `threadId`
 * has not been shown yet. Drops the oldest notices first when the aggregate
 * budget is exceeded, and reports how many were left out.
 */
export function loadPendingCrossThreadOutbound(
  deps: CrossThreadOutboundDeps,
  input: CrossThreadOutboundInput,
): Result<PendingCrossThreadOutbound, DbError> {
  const limits = { ...CROSS_THREAD_OUTBOUND_LIMITS, ...input.limits };

  const sessionWatermark = deps.runRepository.findCompletedRunWatermark(
    input.threadId,
    input.currentRunCreatedAt,
    input.sessionId,
  );
  if (sessionWatermark.isErr()) return sessionWatermark.map(() => NO_PENDING_CROSS_THREAD_OUTBOUND);

  let watermark = sessionWatermark.value;
  if (watermark === null) {
    // The session ID is known (tracker or DB) but no completed run recorded
    // it — e.g. its update failed. Fall back to the thread's last completed
    // foreground run so the window stays bounded.
    const threadWatermark = deps.runRepository.findCompletedRunWatermark(
      input.threadId,
      input.currentRunCreatedAt,
    );
    if (threadWatermark.isErr()) {
      return threadWatermark.map(() => NO_PENDING_CROSS_THREAD_OUTBOUND);
    }
    watermark = threadWatermark.value;
  }
  // No completed run at all: nothing on this thread ever established the
  // session, so there is no window to recover.
  if (watermark === null) return ok(NO_PENDING_CROSS_THREAD_OUTBOUND);

  const page = deps.messageRepository.findCrossThreadOutbound(input.threadId, {
    fromInclusive: watermark,
    beforeExclusive: input.currentRunCreatedAt,
    limit: limits.maxNotices,
  });
  if (page.isErr()) return page.map(() => NO_PENDING_CROSS_THREAD_OUTBOUND);
  if (page.value.total === 0) return ok(NO_PENDING_CROSS_THREAD_OUTBOUND);

  const rendered = page.value.messages.map((row) =>
    renderOutboundNotice({
      body: truncateBody(bodyOf(row.content), limits.maxNoticeChars),
      sentAt: formatNoticeTime(row.created_at),
      source: sourceOf(row),
      ...(row.external_message_id ? { externalMessageId: row.external_message_id } : {}),
    }),
  );

  // Fit the aggregate budget, newest notices kept. Framing: the end line,
  // the omitted line, and the `\n\n` separators between parts.
  const blockLength = (kept: string[], omitted: number): number => {
    const parts = [
      ...(omitted > 0 ? [renderOmittedOutboundLine(omitted)] : []),
      ...kept,
      OUTBOUND_NOTICES_END_LINE,
    ];
    return parts.reduce((sum, part) => sum + part.length, 0) + (parts.length - 1) * 2;
  };
  let kept = rendered;
  let omitted = page.value.total - rendered.length;
  while (kept.length > 0 && blockLength(kept, omitted) > limits.maxTotalChars) {
    kept = kept.slice(1);
    omitted += 1;
  }

  return ok({ rendered: kept, omitted, charCount: blockLength(kept, omitted) });
}
