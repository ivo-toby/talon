/**
 * Systemd watchdog integration for talond.
 *
 * Provides a portable, file-based approach to watchdog notification that
 * works with or without a live systemd environment. The daemon writes a
 * timestamp to `data/watchdog` at a configurable interval so that an
 * external supervisor (systemd, or a custom health-check script) can detect
 * a stalled process.
 *
 * Status files:
 *   data/watchdog  — updated every `intervalMs` while the daemon is running
 *   data/ready     — written once when the daemon is fully started
 *   data/stopping  — written once when graceful shutdown begins
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type pino from 'pino';
import type { Result } from 'neverthrow';
import type { WorkflowEvaluationSummary } from '../workflow/workflow-types.js';

// ---------------------------------------------------------------------------
// WatchdogNotifier
// ---------------------------------------------------------------------------

/** Options accepted by the WatchdogNotifier constructor. */
export interface WatchdogOptions {
  /** How often (in ms) the watchdog file should be touched. */
  intervalMs: number;
  /** Pino logger instance for diagnostic messages. */
  logger: pino.Logger;
  /** Directory where watchdog state files are written. Defaults to 'data'. */
  dataDir?: string;
}

/**
 * Systemd-compatible watchdog notifier using file-based status signals.
 *
 * File-touch approach is used instead of `sd_notify` over a Unix socket so
 * that the implementation remains portable and fully testable without a live
 * systemd environment.
 *
 * Usage:
 * ```ts
 * const watchdog = new WatchdogNotifier({ intervalMs: 10_000, logger });
 * await watchdog.notifyReady();
 * watchdog.start();
 * // ... daemon runs ...
 * await watchdog.notifyStopping();
 * watchdog.stop();
 * ```
 */
export class WatchdogNotifier {
  private readonly intervalMs: number;
  private readonly logger: pino.Logger;
  private readonly dataDir: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WatchdogOptions) {
    this.intervalMs = options.intervalMs;
    this.logger = options.logger;
    this.dataDir = options.dataDir ?? 'data';
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Starts the watchdog heartbeat timer.
   *
   * Immediately writes the first heartbeat then continues at `intervalMs`.
   * Calling `start()` on an already-running notifier is a no-op.
   */
  start(): void {
    if (this.timer !== null) {
      return;
    }

    // Write first heartbeat immediately so systemd sees WATCHDOG=1 at startup.
    this.touch();

    this.timer = setInterval(() => {
      this.touch();
    }, this.intervalMs);

    // Allow the Node.js event loop to exit even if this timer is still active.
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }

    this.logger.debug({ intervalMs: this.intervalMs }, 'watchdog: heartbeat timer started');
  }

  /**
   * Stops the watchdog heartbeat timer.
   *
   * Calling `stop()` on a notifier that was never started is a no-op.
   */
  stop(): void {
    if (this.timer === null) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
    this.logger.debug('watchdog: heartbeat timer stopped');
  }

  /**
   * Writes the `ready` status file, signalling that the daemon has fully
   * initialised and is ready to serve traffic.
   *
   * Equivalent to `sd_notify('READY=1')`.
   */
  notifyReady(): void {
    this.writeStatus('ready', 'READY=1');
    this.logger.info('watchdog: notified READY');
  }

  /**
   * Writes the `stopping` status file, signalling that the daemon has begun
   * graceful shutdown and systemd should stop waiting for new requests.
   *
   * Equivalent to `sd_notify('STOPPING=1')`.
   */
  notifyStopping(): void {
    this.writeStatus('stopping', 'STOPPING=1');
    this.logger.info('watchdog: notified STOPPING');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Writes the current ISO-8601 timestamp to `data/watchdog`.
   *
   * Any filesystem errors are caught and logged; a single failed touch does
   * not stop the heartbeat timer.
   */
  private touch(): void {
    const path = join(this.dataDir, 'watchdog');
    try {
      ensureDir(path);
      writeFileSync(path, new Date().toISOString(), 'utf-8');
    } catch (cause) {
      this.logger.warn({ cause }, 'watchdog: failed to write heartbeat file');
    }
  }

  /**
   * Writes a named status string to `data/<name>`.
   */
  private writeStatus(name: string, content: string): void {
    const path = join(this.dataDir, name);
    try {
      ensureDir(path);
      writeFileSync(path, content, 'utf-8');
    } catch (cause) {
      this.logger.warn({ cause, name }, 'watchdog: failed to write status file');
    }
  }
}

export interface WorkflowWatchdogSchedulerOptions {
  intervalMs: number;
  logger: pino.Logger;
  tick: (now: number) => Result<WorkflowEvaluationSummary, Error>;
}

export class WorkflowWatchdogScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: WorkflowWatchdogSchedulerOptions) {}

  start(): void {
    if (this.timer !== null) {
      return;
    }

    this.timer = setInterval(() => {
      const result = this.options.tick(Date.now());
      if (result.isErr()) {
        this.options.logger.warn(
          { error: result.error.message },
          'workflow-watchdog: evaluation failed',
        );
        return;
      }

      this.options.logger.debug(
        { summary: result.value },
        'workflow-watchdog: evaluation complete',
      );
    }, this.options.intervalMs);

    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer === null) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Ensures that the parent directory of `filePath` exists.
 * Creates it (and any missing ancestors) if necessary.
 */
function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
