/**
 * Tick-based task scheduler.
 *
 * On each tick the scheduler queries for all enabled schedules whose
 * next_run_at has elapsed, enqueues them as queue items, and advances
 * their next_run_at (or disables them for one-shot / event-triggered types).
 */

import type pino from 'pino';
import type { ScheduleRepository } from '../core/database/repositories/schedule-repository.js';
import type { ScheduleRow } from '../core/database/repositories/schedule-repository.js';
import type { PersonaLoader } from '../personas/persona-loader.js';
import type { QueueManager } from '../queue/queue-manager.js';
import { getNextCronTime } from './cron-evaluator.js';
import type { ScheduleConfig, SchedulePayload } from './schedule-types.js';

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

  constructor(
    private readonly scheduleRepo: ScheduleRepository,
    private readonly queueManager: QueueManager,
    private readonly personaLoader: PersonaLoader,
    private readonly config: ScheduleConfig,
    private readonly logger: pino.Logger,
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
    void this.tick(this.generation);
  }

  /**
   * Stops the scheduler.
   *
   * Clears any pending timer. In-flight tick processing (if any) runs to
   * completion but no new ticks are scheduled.
   */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info('scheduler stopped');
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
            await this.processSchedule(schedule, now);
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
          void this.tick(gen);
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
  private async processSchedule(schedule: ScheduleRow, now: number): Promise<void> {
    this.logger.info(
      { scheduleId: schedule.id, type: schedule.type, expression: schedule.expression },
      'scheduler: firing schedule',
    );

    // Enqueue only if a thread_id is set; schedules without a thread cannot
    // be enqueued (the queue FK requires an existing thread).
    if (schedule.thread_id === null) {
      this.logger.warn(
        { scheduleId: schedule.id },
        'scheduler: skipping schedule with null thread_id',
      );
      // Still advance / disable so we do not loop on it forever.
    } else {
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
      let promptFile =
        typeof schedulePayload.promptFile === 'string' ? schedulePayload.promptFile : undefined;
      let content =
        typeof schedulePayload.prompt === 'string' ? schedulePayload.prompt : '';

      // Defensive: agents and humans sometimes invent `prompt: "file:NAME"`
      // as if it were a documented convention (it isn't). Without this
      // promotion, the literal string ships to the agent and it falls back
      // to grepping/reading the file itself — expensive and non-deterministic.
      // Promote the alias here and warn so the operator can fix the schedule
      // row (or the agent that created it).
      if (!promptFile && content.startsWith('file:')) {
        const aliased = content.slice('file:'.length).trim();
        if (aliased.length > 0) {
          this.logger.warn(
            {
              scheduleId: schedule.id,
              personaId: schedule.persona_id,
              aliased,
            },
            'scheduler: prompt starts with "file:" — treating as promptFile alias. Update the schedule payload to use {promptFile: "..."} explicitly.',
          );
          promptFile = aliased;
          content = '';
        }
      }

      if (promptFile) {
        const promptResult = await this.personaLoader.resolveTaskPrompt(schedule.persona_id, promptFile);
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

      // Map schedule fields to the payload shape AgentRunner expects:
      // personaId (from schedule row) and content (from payload.prompt).
      const payload: Record<string, unknown> = {
        ...schedulePayload,
        personaId: schedule.persona_id,
        content,
      };

      const enqueueResult = this.queueManager.enqueue(schedule.thread_id, 'schedule', payload);
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
}
