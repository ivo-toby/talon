/**
 * Type definitions for the tick-based scheduler.
 *
 * Provides the ScheduleConfig needed by Scheduler and re-exports the core
 * schedule types so consumers only need to import from this module.
 */

export type {
  ScheduleType,
  ScheduleRow,
} from '../core/database/repositories/schedule-repository.js';

// ---------------------------------------------------------------------------
// Schedule payload
// ---------------------------------------------------------------------------

/** JSON payload stored with a schedule row. */
export interface SchedulePayload {
  /** Human-readable label for the schedule. */
  label: string;
  /** Inline prompt content, if the schedule stores one directly. */
  prompt?: string;
  /** Persona-relative prompt file alias from `prompts/*.md`. */
  promptFile?: string;
  /** Native behavior-learning review cadence. When set, no agent queue item is enqueued. */
  behaviorReview?: {
    cadence: 'daily' | 'weekly';
  };
}

// ---------------------------------------------------------------------------
// Scheduler configuration
// ---------------------------------------------------------------------------

/** Runtime configuration for the Scheduler, derived from TalondConfig.scheduler. */
export interface ScheduleConfig {
  /** How often the scheduler ticks to check for due schedules (milliseconds). */
  tickIntervalMs: number;
}
