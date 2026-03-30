/**
 * Type definitions for talonctl CLI commands and responses.
 *
 * Provides strongly-typed structures for:
 *   - Daemon IPC command/response wrappers used by status and reload commands
 *   - Doctor check results
 *   - Migrate command output
 *   - Backup command output
 */

// ---------------------------------------------------------------------------
// Doctor check types
// ---------------------------------------------------------------------------

/** Result of a single doctor check. */
export interface DoctorCheck {
  /** Human-readable name of the check. */
  name: string;
  /** Whether the check passed. */
  passed: boolean;
  /** Human-readable message describing the result or failure reason. */
  message: string;
  /** Optional hint for fixing a failing check. */
  hint?: string;
}

/** Aggregated output of the doctor command. */
export interface DoctorResult {
  /** Individual check results. */
  checks: DoctorCheck[];
  /** True if all checks passed. */
  allPassed: boolean;
}

// ---------------------------------------------------------------------------
// Migrate command types
// ---------------------------------------------------------------------------

/** Output of the migrate command. */
export interface MigrateResult {
  /** Number of migrations applied. */
  applied: number;
  /** Path to the database file migrations were applied to. */
  dbPath: string;
}

// ---------------------------------------------------------------------------
// Backup command types
// ---------------------------------------------------------------------------

/** Output of the backup command. */
export interface BackupResult {
  /** Absolute path to the created backup file. */
  backupPath: string;
  /** Timestamp (ISO 8601) when the backup was completed. */
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Status response types
// ---------------------------------------------------------------------------

/** Daemon status payload returned by a successful `status` IPC command. */
export interface DaemonStatusData {
  /** Daemon uptime in milliseconds. */
  uptimeMs: number;
  /** Number of currently active (warm) containers. */
  activeContainers: number;
  /** Number of pending queue items. */
  queueDepth: number;
  /** Number of configured personas. */
  personaCount: number;
  /** Number of configured channel connectors. */
  channelCount: number;
  /** Number of items in dead-letter state. */
  deadLetterCount: number;
  /**
   * Aggregate token usage over the last 24 hours (all personas).
   * Omitted when the daemon has no usage data available.
   */
  tokenUsage24h?: {
    /** Total input tokens consumed in the last 24 hours. */
    inputTokens: number;
    /** Total output tokens consumed in the last 24 hours. */
    outputTokens: number;
    /** Total tokens read from prompt cache in the last 24 hours. */
    cacheReadTokens: number;
    /** Total tokens written to prompt cache in the last 24 hours. */
    cacheWriteTokens: number;
    /** Estimated cost in USD for the last 24 hours. */
    costUsd: number;
  };
  /** Governance status — spending caps, rate limits, and recent violations. */
  governance?: {
    /** Per-persona spending status. */
    perPersonaStatus: Array<{
      personaId: string;
      personaName: string;
      dailyTokensUsed: number;
      dailyTokenCap?: number;
      hourlyTokensUsed: number;
      hourlyTokenCap?: number;
      percentOfDailyBudgetUsed?: number;
      percentOfHourlyBudgetUsed?: number;
    }>;
    /** Recent governance violations (last 24h, max 10). */
    recentViolations: Array<{
      id: string;
      personaId?: string;
      violation: string;
      detail: unknown;
      actionTaken: string;
      timestamp: number;
    }>;
    /** Active alerts (budget warnings and breaches). */
    alerts: Array<{
      level: 'warning' | 'critical';
      message: string;
      personaId?: string;
    }>;
  };
}

// ---------------------------------------------------------------------------
// Reload response types
// ---------------------------------------------------------------------------

/** Daemon reload payload returned by a successful `reload` IPC command. */
export interface DaemonReloadData {
  /** Whether config was reloaded. */
  configReloaded: boolean;
  /** Whether personas were reloaded. */
  personasReloaded: boolean;
  /** Whether channels were reloaded. */
  channelsReloaded: boolean;
}

// ---------------------------------------------------------------------------
// CLI error type
// ---------------------------------------------------------------------------

/** Error type for CLI-level failures. */
export class CliError extends Error {
  readonly code = 'CLI_ERROR' as const;

  constructor(message: string, readonly cause?: Error) {
    super(message);
    this.name = 'CliError';
  }
}
