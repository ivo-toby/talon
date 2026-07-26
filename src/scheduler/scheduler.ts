/**
 * Tick-based task scheduler.
 *
 * On each tick the scheduler queries for all enabled schedules whose
 * next_run_at has elapsed, enqueues them as queue items, and advances
 * their next_run_at (or disables them for one-shot / event-triggered types).
 */

import type pino from 'pino';
import { err, ok } from 'neverthrow';
import type { ScheduleRepository } from '../core/database/repositories/schedule-repository.js';
import type { ScheduleRow } from '../core/database/repositories/schedule-repository.js';
import type { PersonaLoader } from '../personas/persona-loader.js';
import type { QueueManager } from '../queue/queue-manager.js';
import { getNextCronTime } from './cron-evaluator.js';
import type { ScheduleConfig, SchedulePayload } from './schedule-types.js';
import { v4 as uuidv4 } from 'uuid';
import type { LifecycleRuntime } from '../lifecycle/lifecycle-runtime.js';
import type { BehaviorReviewService } from '../lifecycle/behavior/index.js';

export interface SchedulerDrainResult {
  readonly status: 'drained' | 'timed_out';
}

const DEFAULT_DRAIN_TIMEOUT_MS = 25_000;

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Polls the schedule repository on a fixed interval and enqueues due items.
 *
 * Call `start()` to begin ticking and `stop()` to halt. The scheduler is
 * safe to stop and restart.
 */
export class Scheduler {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  /** Generation counter to prevent stale ticks from re-arming after stop()+start(). */
  private generation = 0;
  private readonly activeTicks = new Set<Promise<void>>();

  constructor(
    private readonly scheduleRepo: ScheduleRepository,
    private readonly queueManager: QueueManager,
    private readonly personaLoader: PersonaLoader,
    private readonly config: ScheduleConfig,
    private readonly logger: pino.Logger,
    private readonly lifecycleRuntime?: LifecycleRuntime,
    private readonly behaviorReviewService?: Pick<BehaviorReviewService, 'review'>,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Starts the scheduler.
   *
   * Fires an immediate first tick then schedules subsequent ticks at
   * `config.tickIntervalMs` intervals.
   */
  start(): void {
    if (this.running) {
      this.logger.warn('scheduler already running — ignoring start()');
      return;
    }
    this.running = true;
    this.generation += 1;
    this.logger.info({ tickIntervalMs: this.config.tickIntervalMs }, 'scheduler started');
    this.launchTick(this.generation);
  }

  /**
   * Stops the scheduler.
   *
   * Clears any pending timer. In-flight tick processing (if any) runs to
   * completion but no new ticks are scheduled.
   */
  async stop(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<SchedulerDrainResult> {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info('scheduler stopped');
    const settled = Promise.allSettled([...this.activeTicks]).then(() => 'drained' as const);
    let timer: NodeJS.Timeout | undefined;
    try {
      const status = await Promise.race([
        settled,
        new Promise<'timed_out'>((resolve) => {
          timer = setTimeout(() => resolve('timed_out'), timeoutMs);
          timer.unref();
        }),
      ]);
      return { status };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  waitForDrain(): Promise<void> {
    return Promise.allSettled([...this.activeTicks]).then(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Tick
  // ---------------------------------------------------------------------------

  /**
   * Processes a single scheduler tick.
   *
   * Finds all due schedules, enqueues each one, updates timestamps, and
   * disables one-shot / event schedules. Errors on individual schedules are
   * logged and skipped so one bad schedule cannot block the rest.
   */
  private async tick(gen: number): Promise<void> {
    if (!this.running || gen !== this.generation) {
      return;
    }

    try {
      const now = Date.now();

      const dueResult = this.scheduleRepo.findDue(now);
      if (dueResult.isErr()) {
        this.logger.error({ err: dueResult.error }, 'scheduler: failed to query due schedules');
      } else {
        const due = dueResult.value;
        this.logger.debug({ count: due.length, now }, 'scheduler tick');

        // Process due schedules serially. Each schedule is wrapped in its own
        // try/catch so one failure does not block the rest.
        for (const schedule of due) {
          try {
            await this.processSchedule(schedule, now, gen);
          } catch (scheduleErr) {
            this.logger.error(
              { scheduleId: schedule.id, err: scheduleErr },
              'scheduler: unexpected error processing schedule',
            );
          }
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'scheduler: unexpected tick failure');
    } finally {
      // Schedule the next tick only if still running and this tick belongs to
      // the current generation (stop()+start() may have spawned a new loop).
      if (this.running && gen === this.generation) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.launchTick(gen);
        }, this.config.tickIntervalMs);
      }
    }
  }

  /**
   * Enqueues a single due schedule and advances its state.
   *
   * @param schedule - The schedule row to process.
   * @param now      - Current epoch ms (used for last_run_at).
   */
  private async processSchedule(schedule: ScheduleRow, now: number, gen: number): Promise<void> {
    if (!this.isCurrentGeneration(gen)) return;
    this.logger.info(
      { scheduleId: schedule.id, type: schedule.type, expression: schedule.expression },
      'scheduler: firing schedule',
    );

    let rawPayload: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(schedule.payload);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rawPayload = parsed as Record<string, unknown>;
      } else {
        this.logger.warn(
          { scheduleId: schedule.id, raw: schedule.payload },
          'scheduler: schedule payload is not a JSON object — using empty object',
        );
      }
    } catch {
      this.logger.warn(
        { scheduleId: schedule.id, raw: schedule.payload },
        'scheduler: schedule has invalid JSON payload — using empty object',
      );
    }

    const schedulePayload = rawPayload as SchedulePayload & Record<string, unknown>;
    const behaviorReview = parseBehaviorReviewSchedule(schedulePayload);
    if (behaviorReview) {
      const persona = this.personaLoader.getById(schedule.persona_id);
      const personaName = persona.isOk() && persona.value ? persona.value.config.name : undefined;
      if (!personaName) {
        this.logger.error(
          { scheduleId: schedule.id, personaId: schedule.persona_id },
          'scheduler: behavior review persona unavailable; schedule will be retried',
        );
        return;
      }
      if (!this.behaviorReviewService) {
        this.logger.error(
          { scheduleId: schedule.id, personaId: schedule.persona_id },
          'scheduler: behavior review service unavailable; schedule will be retried',
        );
        return;
      }
      const reviewed = await this.behaviorReviewService.review({
        persona: personaName,
        cadence: behaviorReview.cadence,
        now: new Date(now).toISOString(),
        trigger: {
          kind: 'schedule',
          scheduleId: schedule.id,
          firedAt: new Date(now).toISOString(),
        },
      });
      if (!this.isCurrentGeneration(gen)) return;
      if (reviewed.isErr()) {
        this.logger.error(
          { scheduleId: schedule.id, err: reviewed.error },
          'scheduler: behavior review failed',
        );
        return;
      }
      this.advanceScheduleAfterNativeRun(schedule, now);
      return;
    }

    // Enqueue only if a thread_id is set; schedules without a thread cannot
    // be enqueued (the queue FK requires an existing thread).
    if (schedule.thread_id === null) {
      this.logger.warn(
        { scheduleId: schedule.id },
        'scheduler: skipping schedule with null thread_id',
      );
      // Still advance / disable so we do not loop on it forever.
    } else {
      const threadId = schedule.thread_id;

      let promptFile =
        typeof schedulePayload.promptFile === 'string' ? schedulePayload.promptFile : undefined;
      let content = typeof schedulePayload.prompt === 'string' ? schedulePayload.prompt : '';

      // Defensive: agents and humans sometimes invent `prompt: "file:NAME"`
      // as if it were a documented convention (it isn't). Without this
      // promotion, the literal string ships to the agent and it falls back
      // to grepping for the file itself — expensive and non-deterministic.
      //
      // The pattern MUST be strict (`file:` followed by exactly one filename
      // token and nothing else) to avoid hijacking a legitimate prompt that
      // happens to start with the word "file:" — e.g.
      // `"file: summarize the latest backup log"`. A loose match would
      // discard such a prompt's body and call resolveTaskPrompt against an
      // alias that does not exist, which fails and stalls the schedule
      // (early return = no enqueue + no next-run advance).
      const FILE_ALIAS_RE = /^file:([A-Za-z0-9._-]+)$/;
      if (!promptFile) {
        const match = FILE_ALIAS_RE.exec(content.trim());
        if (match) {
          const aliased = match[1];
          this.logger.warn(
            {
              scheduleId: schedule.id,
              personaId: schedule.persona_id,
              aliased,
            },
            'scheduler: prompt matches "file:<name>" — treating as promptFile alias. Update the schedule payload to use {promptFile: "..."} explicitly.',
          );
          promptFile = aliased;
          content = '';
        }
      }

      if (promptFile) {
        const promptResult = await this.personaLoader.resolveTaskPrompt(
          schedule.persona_id,
          promptFile,
        );
        if (!this.isCurrentGeneration(gen)) return;
        if (promptResult.isErr()) {
          this.logger.error(
            {
              scheduleId: schedule.id,
              personaId: schedule.persona_id,
              promptFile,
              err: promptResult.error,
            },
            'scheduler: failed to resolve promptFile',
          );
          return;
        }
        content = promptResult.value;
      }
      // A stop may have raced an asynchronous prompt load. Do not enqueue or
      // update schedule state after the daemon begins draining dependencies.
      if (!this.isCurrentGeneration(gen)) return;

      // Map schedule fields to the payload shape AgentRunner expects:
      // personaId (from schedule row) and content (from payload.prompt).
      const payload: Record<string, unknown> = {
        ...schedulePayload,
        personaId: schedule.persona_id,
        content,
      };

      let personaName: string | undefined;
      if (this.lifecycleRuntime) {
        const persona = this.personaLoader.getById(schedule.persona_id);
        if (persona.isOk() && persona.value) {
          personaName = persona.value.config.name;
        }
        if (!personaName) {
          this.logger.error(
            { scheduleId: schedule.id, personaId: schedule.persona_id },
            'scheduler: lifecycle persona unavailable; schedule will be retried without enqueue',
          );
          return;
        }
      }

      if (this.lifecycleRuntime) {
        if (!this.isCurrentGeneration(gen)) return;
        // The enabled-mode resolution guard above establishes this immutable
        // scope before the transactional callback captures it.
        const lifecyclePersona = personaName;
        if (!lifecyclePersona) return;
        const nextRun = this.computeNextRun(schedule);
        const fired = this.lifecycleRuntime.transaction((transaction) => {
          const enqueued = this.queueManager.enqueueInLifecycleTransaction(
            threadId,
            'schedule',
            payload,
            { persona: lifecyclePersona, itemType: 'schedule' },
            transaction,
          );
          if (enqueued.isErr()) return err(new Error(enqueued.error.message));

          const scheduleUpdate =
            nextRun === null
              ? this.scheduleRepo
                  .disable(schedule.id)
                  .andThen(() => this.scheduleRepo.updateNextRun(schedule.id, now, null))
              : this.scheduleRepo.updateNextRun(schedule.id, now, nextRun);
          if (scheduleUpdate.isErr()) return err(new Error(scheduleUpdate.error.message));

          const publication = this.lifecycleRuntime!.publish(
            {
              event: {
                version: 'v1',
                type: 'schedule.fired.v1',
                eventId: uuidv4(),
                occurredAt: new Date(now).toISOString(),
                context: {
                  aggregate: { type: 'schedule', id: schedule.id },
                  correlationId: enqueued.value.id,
                  recursion: { depth: 0, maxDepth: 8 },
                  provenance: {
                    source: 'scheduler',
                    sourceEventIds: [],
                    sourceReferences: [{ type: 'queue_item', id: enqueued.value.id }],
                  },
                },
                payload: {
                  references: [
                    { type: 'schedule', id: schedule.id },
                    { type: 'queue_item', id: enqueued.value.id },
                    { type: 'thread', id: threadId },
                  ],
                  metadata: { scheduleType: schedule.type },
                },
              },
              persona: lifecyclePersona,
              itemOrigin: 'scheduler',
              itemType: 'schedule',
              scheduleSource:
                schedule.type === 'one_shot'
                  ? 'oneshot'
                  : schedule.type === 'event'
                    ? 'manual'
                    : schedule.type,
            },
            transaction,
          );
          return publication.isErr()
            ? err(new Error(`Failed to publish schedule fired event: ${publication.error.message}`))
            : ok(undefined);
        });
        if (fired.isErr()) {
          this.logger.error(
            { scheduleId: schedule.id, err: fired.error },
            'scheduler: failed to atomically fire schedule lifecycle event',
          );
        }
        return;
      }

      if (!this.isCurrentGeneration(gen)) return;
      const enqueueResult = this.queueManager.enqueue(threadId, 'schedule', payload);
      if (enqueueResult.isErr()) {
        this.logger.error(
          { scheduleId: schedule.id, err: enqueueResult.error },
          'scheduler: failed to enqueue schedule',
        );
        // Do not advance the schedule so it will be retried on the next tick.
        return;
      }
    }

    // Compute the next run time (null for one_shot / event).
    if (!this.isCurrentGeneration(gen)) return;
    const nextRun = this.computeNextRun(schedule);

    if (nextRun === null) {
      // One-shot or event-triggered — disable the schedule.
      const disableResult = this.scheduleRepo.disable(schedule.id);
      if (disableResult.isErr()) {
        this.logger.error(
          { scheduleId: schedule.id, err: disableResult.error },
          'scheduler: failed to disable one-shot/event schedule',
        );
      }
      // Also record the last run time.
      this.scheduleRepo.updateNextRun(schedule.id, now, null);
    } else {
      const updateResult = this.scheduleRepo.updateNextRun(schedule.id, now, nextRun);
      if (updateResult.isErr()) {
        this.logger.error(
          { scheduleId: schedule.id, err: updateResult.error },
          'scheduler: failed to update next_run_at',
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Next-run computation
  // ---------------------------------------------------------------------------

  /**
   * Computes the next execution time for a schedule.
   *
   * @param schedule - The schedule row.
   * @returns Epoch ms of the next run, or `null` for types that do not repeat.
   */
  private computeNextRun(schedule: ScheduleRow): number | null {
    switch (schedule.type) {
      case 'cron': {
        const result = getNextCronTime(schedule.expression, new Date());
        if (result.isErr()) {
          this.logger.error(
            { scheduleId: schedule.id, expression: schedule.expression, err: result.error },
            'scheduler: invalid cron expression — disabling schedule',
          );
          return null;
        }
        return result.value;
      }

      case 'interval': {
        const intervalMs = parseInt(schedule.expression, 10);
        if (isNaN(intervalMs) || intervalMs <= 0) {
          this.logger.error(
            { scheduleId: schedule.id, expression: schedule.expression },
            'scheduler: invalid interval expression — disabling schedule',
          );
          return null;
        }
        return Date.now() + intervalMs;
      }

      case 'one_shot':
        // Does not repeat.
        return null;

      case 'event':
        // Event-triggered schedules are not time-based; disable after first fire.
        return null;

      default: {
        // TypeScript exhaustiveness guard.
        const _exhaustive: never = schedule.type;
        this.logger.error(
          { scheduleId: schedule.id, type: _exhaustive },
          'scheduler: unknown schedule type',
        );
        return null;
      }
    }
  }

  private advanceScheduleAfterNativeRun(schedule: ScheduleRow, now: number): void {
    const nextRun = this.computeNextRun(schedule);
    if (nextRun === null) {
      const disableResult = this.scheduleRepo.disable(schedule.id);
      if (disableResult.isErr()) {
        this.logger.error(
          { scheduleId: schedule.id, err: disableResult.error },
          'scheduler: failed to disable native schedule',
        );
      }
      this.scheduleRepo.updateNextRun(schedule.id, now, null);
      return;
    }

    const updateResult = this.scheduleRepo.updateNextRun(schedule.id, now, nextRun);
    if (updateResult.isErr()) {
      this.logger.error(
        { scheduleId: schedule.id, err: updateResult.error },
        'scheduler: failed to update native schedule next_run_at',
      );
    }
  }

  private launchTick(gen: number): void {
    const tick = this.tick(gen);
    this.activeTicks.add(tick);
    void tick.finally(() => this.activeTicks.delete(tick));
  }

  private isCurrentGeneration(gen: number): boolean {
    return this.running && gen === this.generation;
  }
}

function parseBehaviorReviewSchedule(
  payload: SchedulePayload & Record<string, unknown>,
): { cadence: 'daily' | 'weekly' } | null {
  const review = payload.behaviorReview;
  if (!review || typeof review !== 'object' || Array.isArray(review)) return null;
  const cadence = (review as Record<string, unknown>).cadence;
  return cadence === 'daily' || cadence === 'weekly' ? { cadence } : null;
}
