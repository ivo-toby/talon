/**
 * OS signal handler setup for the talond daemon.
 *
 * Registers handlers for the signals that affect daemon lifecycle:
 * - SIGTERM / SIGINT → graceful shutdown
 * - SIGHUP           → config reload
 * - unhandledRejection → consult the shield; exit(1) only when no matcher
 *   claims the rejection as a known connector-internal failure.
 *
 * Guards against double-shutdown: if a signal arrives while the daemon is
 * already stopping, subsequent signals are ignored.
 */

import type pino from 'pino';
import type { TalondDaemon } from './daemon.js';
import { classifyRejection } from './unhandled-rejection-shield.js';

// ---------------------------------------------------------------------------
// Signal handler setup
// ---------------------------------------------------------------------------

/**
 * Registers process-level signal handlers for the daemon.
 *
 * Must be called exactly once, after the daemon has been started.
 * All signal handlers are attached to the current `process` object.
 *
 * @param daemon - The running TalondDaemon instance.
 * @param logger - Logger used to emit shutdown/reload events.
 */
export function setupSignalHandlers(daemon: TalondDaemon, logger: pino.Logger): void {
  let shutdownInitiated = false;

  /**
   * Initiates a graceful shutdown sequence.
   * Guards against re-entrant calls (e.g. SIGTERM followed by SIGINT).
   */
  async function handleShutdown(signal: string): Promise<void> {
    if (shutdownInitiated) {
      logger.warn({ signal }, 'signal: shutdown already in progress — ignoring');
      return;
    }
    shutdownInitiated = true;
    logger.info({ signal }, 'signal: initiating graceful shutdown');

    try {
      await daemon.stop();
    } catch (cause) {
      logger.error({ cause, signal }, 'signal: error during graceful shutdown');
      process.exit(1);
    }

    process.exit(0);
  }

  /**
   * Initiates a config reload.
   * Errors are logged; the daemon continues running on failure.
   */
  async function handleReload(): Promise<void> {
    logger.info('signal: SIGHUP received — reloading config');

    try {
      const result = await daemon.reload();
      if (result.isErr()) {
        logger.error({ err: result.error }, 'signal: config reload failed');
      } else {
        logger.info('signal: config reload complete');
      }
    } catch (cause) {
      logger.error({ cause }, 'signal: unexpected error during config reload');
    }
  }

  // Graceful shutdown signals
  process.on('SIGTERM', () => {
    void handleShutdown('SIGTERM');
  });

  process.on('SIGINT', () => {
    void handleShutdown('SIGINT');
  });

  // Config reload signal
  process.on('SIGHUP', () => {
    void handleReload();
  });

  // Unhandled promise rejections. Connectors can register matchers via the
  // shield to mark rejections from their underlying libraries (e.g. Baileys
  // WebSocket teardown) as known and non-fatal — those are logged at warn
  // level and the daemon keeps running. Anything no matcher claims is treated
  // as a programming bug and crashes the process so it doesn't drift into
  // an unknown state.
  process.on('unhandledRejection', (reason) => {
    const classification = classifyRejection(reason);
    if (!classification.fatal) {
      logger.warn(
        { reason, matchedBy: classification.matchedBy },
        'signal: unhandled promise rejection from non-fatal source — ignoring',
      );
      return;
    }
    logger.fatal({ reason }, 'signal: unhandled promise rejection — exiting');
    process.exit(1);
  });
}
