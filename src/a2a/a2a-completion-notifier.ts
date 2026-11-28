/**
 * A2ACompletionNotifier: wakes the delegating persona when delegated tasks finish (ADR 0003).
 *
 * A notification is OWED when an `a2a_tasks` row is terminal, `notify = 'wake'`
 * and `notified_at IS NULL`; there is no outbox. Each tick lists the owed rows,
 * groups them by source thread (and source persona), and delivers a group once
 * its oldest owed task finished at least `notifyBatchWindowSeconds` ago (a fixed
 * window from the first terminal task, not a sliding one).
 *
 * Delivery is exactly-once: ONE `message` queue item is enqueued and every
 * covered task gets `notified_at` in the same SQLite transaction
 * (`QueueManager.enqueueWithCommit`, same connection). If anything fails the
 * transaction rolls back, nothing is marked and the next tick retries. A crash
 * before commit leaves the rows owed, so startup needs no recovery step.
 *
 * The queue item carries `kind: 'a2a_task_notification'` and the SOURCE persona
 * as `personaId`. Like the background-agent completion message it has no
 * message ID and no author: the runner uses `content` as the live prompt of an
 * ordinary run in the source thread, and it is never persisted as human input.
 */

import { err, ok, type Result } from 'neverthrow';
import type pino from 'pino';
import type { A2ATaskRepository } from '../core/database/repositories/a2a-task-repository.js';
import type { ChannelRepository } from '../core/database/repositories/channel-repository.js';
import type { PersonaRepository } from '../core/database/repositories/persona-repository.js';
import type { ThreadRepository } from '../core/database/repositories/thread-repository.js';
import { createVoiceSafeLogger } from '../observability/langfuse/voice-observation.js';
import { resolveThreadRecipient } from '../daemon/schedule-thread-utils.js';
import { createQueueDiagnosticResolver, type QueueManager } from '../queue/queue-manager.js';
import type { A2ATaskRow } from './a2a-types.js';

/** How often the notifier looks for owed notifications. */
export const A2A_NOTIFIER_INTERVAL_MS = 5_000;

/** Excerpt cap per task, in characters. */
export const A2A_NOTIFY_EXCERPT_MAX_CHARS = 800;

/** Excerpt cap across one notification message, in characters. */
export const A2A_NOTIFY_TOTAL_EXCERPT_MAX_CHARS = 4_000;

/** Appended to a truncated excerpt. */
export const A2A_NOTIFY_TRUNCATION_MARKER = '... [truncated]';

/** Most tasks one notification covers; the rest stay owed for the next tick. */
export const A2A_NOTIFY_MAX_TASKS_PER_MESSAGE = 20;

export const A2A_NOTIFICATION_KIND = 'a2a_task_notification';

export interface A2ACompletionNotifierDeps {
  taskRepo: A2ATaskRepository;
  threadRepo: ThreadRepository;
  channelRepo: ChannelRepository;
  personaRepo: PersonaRepository;
  queueManager: QueueManager;
  logger: pino.Logger;
  /** a2a.notifyBatchWindowSeconds (fixed until restart). */
  batchWindowSeconds: number;
  /** Injectable clock (epoch ms) for tests. */
  now?: () => number;
}

/** Truncates `text` to at most `max` characters, ending with the marker when cut. */
export function truncateExcerpt(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const marker = A2A_NOTIFY_TRUNCATION_MARKER;
  if (max <= marker.length) return marker.slice(0, max);
  return `${text.slice(0, max - marker.length)}${marker}`;
}

/**
 * Result and error text comes from another model run, so it is untrusted. It is
 * rendered on ONE line of the form `Result: <text>`: every line break (CR, LF,
 * VT, FF, NEL, U+2028/U+2029) becomes the visible marker ' ⏎ '. Text can then
 * never start a new line, so it cannot forge a `Task ...` line or the closing
 * `Use persona_task_status ...` line. Collapsing happens BEFORE truncation, so
 * the 800/4000 caps apply to what is actually rendered.
 */
export function neutralizeExcerpt(text: string): string {
  return text.replace(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/g, ' ⏎ ');
}

function extractExcerptSource(task: A2ATaskRow): string {
  if (task.state === 'completed') {
    if (!task.result_payload) return '';
    try {
      const parsed = JSON.parse(task.result_payload) as { text?: unknown };
      return typeof parsed.text === 'string' ? neutralizeExcerpt(parsed.text.trim()) : '';
    } catch {
      return '';
    }
  }
  return neutralizeExcerpt((task.error_message ?? task.error_code ?? '').trim());
}

/**
 * Renders the notification text. With `excerpts: false` (voice or unclassifiable
 * thread) only task ID and state are included: no target persona, no excerpt.
 */
export function renderNotification(
  tasks: readonly A2ATaskRow[],
  excerpts: boolean,
  moreOwed = 0,
): string {
  const lines: string[] = [
    tasks.length === 1
      ? '[Delegated task finished] 1 task you delegated has finished.'
      : `[Delegated tasks finished] ${tasks.length} tasks you delegated have finished.`,
  ];
  let budget = A2A_NOTIFY_TOTAL_EXCERPT_MAX_CHARS;
  for (const task of tasks) {
    if (!excerpts) {
      lines.push(`Task ${task.id}: ${task.state}`);
      continue;
    }
    lines.push(`Task ${task.id} (target: ${task.target_persona}): ${task.state}`);
    const source = extractExcerptSource(task);
    if (source === '') continue;
    const label = task.state === 'completed' ? 'Result' : 'Error';
    const allowed = Math.min(A2A_NOTIFY_EXCERPT_MAX_CHARS, budget);
    if (allowed <= 0) {
      lines.push(`${label}: ${A2A_NOTIFY_TRUNCATION_MARKER}`);
      continue;
    }
    const excerpt = truncateExcerpt(source, allowed);
    budget -= excerpt.length;
    lines.push(`${label}: ${excerpt}`);
  }
  if (moreOwed > 0) {
    lines.push(
      `... and ${moreOwed} more finished task(s); they follow in the next message (or use persona_task_status).`,
    );
  }
  lines.push('Use persona_task_status with a task ID to fetch the full result.');
  return lines.join('\n');
}

/** Periodic dispatcher for owed A2A completion notifications. */
export class A2ACompletionNotifier {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly resolver: ReturnType<typeof createQueueDiagnosticResolver>;

  constructor(private readonly deps: A2ACompletionNotifierDeps) {
    this.now = deps.now ?? Date.now;
    this.resolver = createQueueDiagnosticResolver(deps.threadRepo, deps.channelRepo);
  }

  /** Starts the periodic tick (idempotent). The timer never keeps the process alive. */
  start(intervalMs: number = A2A_NOTIFIER_INTERVAL_MS): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.safeTick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One tick that never throws; failures are logged and retried on the next tick. */
  private safeTick(): void {
    try {
      const result = this.tick();
      if (result.isErr()) {
        this.deps.logger.warn({ err: result.error.message }, 'a2a-notifier: tick failed');
      }
    } catch (cause) {
      this.deps.logger.warn({ cause: String(cause) }, 'a2a-notifier: tick threw');
    }
  }

  /**
   * Delivers every owed group whose window has elapsed.
   *
   * @returns Ok(number of notification messages enqueued).
   */
  tick(): Result<number, Error> {
    const owed = this.deps.taskRepo.findOwedNotifications();
    if (owed.isErr()) return err(owed.error);

    const groups = new Map<string, A2ATaskRow[]>();
    for (const task of owed.value) {
      const key = `${task.thread_id}\u0000${task.source_persona}`;
      const group = groups.get(key);
      if (group) group.push(task);
      else groups.set(key, [task]);
    }

    const windowMs = this.deps.batchWindowSeconds * 1000;
    const nowMs = this.now();
    let delivered = 0;
    for (const tasks of groups.values()) {
      const oldest = Math.min(...tasks.map((t) => t.completed_at ?? t.updated_at));
      if (nowMs - oldest < windowMs) continue;
      if (this.deliver(tasks)) delivered++;
    }
    return ok(delivered);
  }

  /** @returns true when a message was enqueued. */
  private deliver(owedTasks: A2ATaskRow[]): boolean {
    const { taskRepo } = this.deps;
    const threadId = owedTasks[0].thread_id;
    const sourcePersona = owedTasks[0].source_persona;
    // Oldest first; anything beyond the cap stays owed for the next tick.
    const tasks = owedTasks.slice(0, A2A_NOTIFY_MAX_TASKS_PER_MESSAGE);
    const moreOwed = owedTasks.length - tasks.length;
    const taskIds = tasks.map((t) => t.id);

    // Classify first: every log below is voice-safe unless the thread is
    // positively known to be a text channel.
    const nonVoice = this.resolver.resolveThread(threadId) === 'nonvoice';
    const log = nonVoice ? this.deps.logger : createVoiceSafeLogger(this.deps.logger);

    const thread = this.deps.threadRepo.findById(threadId);
    if (thread.isErr()) {
      log.warn(
        { threadId, err: thread.error.message },
        'a2a-notifier: thread lookup failed; will retry',
      );
      return false;
    }
    const persona = this.deps.personaRepo.findByName(sourcePersona);
    if (persona.isErr()) {
      log.warn(
        { threadId, sourcePersona, err: persona.error.message },
        'a2a-notifier: persona lookup failed; will retry',
      );
      return false;
    }
    if (thread.value === null || persona.value === null) {
      this.retire(
        owedTasks,
        thread.value === null
          ? 'source thread no longer exists'
          : 'source persona no longer exists',
        log,
        { threadId, sourcePersona },
      );
      return false;
    }
    if (resolveThreadRecipient(thread.value) === null) {
      // A CLI-created schedule thread has no chat: a wake would run pointlessly.
      this.retire(owedTasks, 'source thread has no chat to deliver to', log, { threadId });
      return false;
    }

    const content = renderNotification(tasks, nonVoice, moreOwed);
    const enqueued = this.deps.queueManager.enqueueWithCommit(
      threadId,
      'message',
      { personaId: persona.value.id, kind: A2A_NOTIFICATION_KIND, taskIds, content },
      undefined,
      () => {
        for (const id of taskIds) {
          const marked = taskRepo.markNotified(id);
          if (marked.isErr()) return err(marked.error);
          if (!marked.value) return err(new Error(`task ${id} was already notified`));
        }
        return ok(undefined);
      },
      // QueueManager would log threadId unclassified; this class logs below.
      { logSuccess: false },
    );
    if (enqueued.isErr()) {
      log.warn(
        nonVoice ? { threadId, taskIds, err: enqueued.error.message } : {},
        'a2a-notifier: failed to enqueue completion notification; will retry',
      );
      return false;
    }
    log.info(
      nonVoice ? { threadId, taskIds, itemId: enqueued.value.item.id } : {},
      'a2a-notifier: completion notification enqueued',
    );
    return true;
  }

  /**
   * Marks tasks notified without enqueueing, in one transaction. Identifying
   * fields are logged only through `log` (voice-safe for non-text threads).
   */
  private retire(
    tasks: readonly A2ATaskRow[],
    reason: string,
    log: pino.Logger,
    context: Record<string, unknown>,
  ): void {
    const { taskRepo } = this.deps;
    const taskIds = tasks.map((t) => t.id);
    try {
      taskRepo.transaction(() => {
        for (const id of taskIds) {
          const marked = taskRepo.markNotified(id);
          if (marked.isErr()) throw marked.error;
        }
      });
      log.warn({ ...context, taskIds }, `a2a-notifier: ${reason}; completion notification dropped`);
    } catch (cause) {
      log.warn(
        { ...context, taskIds, cause: String(cause) },
        'a2a-notifier: failed to retire notification',
      );
    }
  }
}
