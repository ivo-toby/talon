/**
 * Type definitions for the tick-based scheduler.
 *
 * Provides the ScheduleConfig needed by Scheduler and re-exports the core
 * schedule types so consumers only need to import from this module.
 */

import type { Result } from 'neverthrow';
import type { ScriptError, ScriptRunReport } from '../scripts/types.js';

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
  /** Name of an approved script. Excludes `prompt` and `promptFile`. */
  script?: string;
  /** Input of a script run. Present only for a script schedule. `null` is a real input. */
  input?: unknown;
}

/** What the scheduler needs from the script service. */
/** Why a scheduled run did not start. */
export type ScriptNotRunReason = 'changed' | 'not-approved' | 'not-permitted' | 'bad-input';

export interface ScriptScheduleRunner {
  runScheduled(input: {
    personaId: string;
    threadId: string;
    scriptName: string;
    scheduleId: string;
    input?: unknown;
  }): Promise<Result<ScriptRunReport | 'skipped', ScriptError>>;
  /** `reason` is set when the run did not start: its files changed, no version is approved, or the persona may not run it. */
  notifyFailure(input: {
    threadId: string;
    scriptName: string;
    errorCode: string;
    reason?: ScriptNotRunReason;
  }): Promise<void>;
  /** True if the last scheduled run of this script failed or did not start. */
  lastScheduledRunFailed(personaId: string, scriptName: string): boolean;
}

// ---------------------------------------------------------------------------
// Scheduler configuration
// ---------------------------------------------------------------------------

/** Runtime configuration for the Scheduler, derived from TalondConfig.scheduler. */
export interface ScheduleConfig {
  /** How often the scheduler ticks to check for due schedules (milliseconds). */
  tickIntervalMs: number;
}
