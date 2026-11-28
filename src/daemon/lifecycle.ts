/**
 * Daemon lifecycle utilities.
 *
 * Provides crash-recovery logic (resetting in-flight queue items back to
 * 'pending' after an unclean shutdown) and PID file management for
 * single-instance enforcement.
 */

import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type pino from 'pino';
import type { QueueRepository } from '../core/database/repositories/queue-repository.js';

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

/**
 * Resets orphaned in-flight queue items back to 'pending' status.
 *
 * After an unclean shutdown, queue items that were 'claimed' or 'processing'
 * are stuck in a non-terminal state and would never be retried. This function
 * resets them so they are eligible for reprocessing on the next poll tick.
 *
 * Call this during daemon startup, before starting the processing loop.
 *
 * @param queueRepo - Repository used to query and reset items.
 * @param logger    - Logger for audit entries.
 */
export function recoverFromCrash(queueRepo: QueueRepository, logger: pino.Logger): void {
  const db = (queueRepo as unknown as { db: import('better-sqlite3').Database }).db;

  try {
    const now = Date.now();
    const result = db
      .prepare(
        `UPDATE queue_items
         SET status = 'pending', updated_at = ?
         WHERE status IN ('claimed', 'processing')
           AND NOT (
             type = 'collaboration'
             AND COALESCE(
               CASE WHEN json_valid(payload) = 1
                 THEN json_extract(payload, '$.kind')
               END,
               ''
             ) = 'voice_backend'
           )`,
      )
      .run(now);

    const count = result.changes;
    if (count > 0) {
      logger.warn(
        { count },
        'daemon: recovered in-flight queue items from previous crash',
      );
    } else {
      logger.debug('daemon: no in-flight queue items to recover');
    }
  } catch (cause) {
    logger.error({ cause }, 'daemon: failed to recover in-flight queue items');
  }
}

// ---------------------------------------------------------------------------
// PID file management
// ---------------------------------------------------------------------------

/**
 * Writes the current process PID to `<dataDir>/talond.pid`.
 *
 * Creates the data directory if it does not exist. The PID file is used by
 * external tooling (init scripts, monitoring) to identify the daemon process.
 *
 * @param dataDir - Absolute or relative path to the daemon data directory.
 */
export function writePidFile(dataDir: string): void {
  const pidPath = join(dataDir, 'talond.pid');
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, String(process.pid), 'utf-8');
}

/**
 * Removes the PID file written by `writePidFile`.
 *
 * No-op if the file does not exist (e.g. was never written, or already
 * removed by a previous clean shutdown). Called during graceful shutdown.
 *
 * @param dataDir - Absolute or relative path to the daemon data directory.
 */
export function removePidFile(dataDir: string): void {
  const pidPath = join(dataDir, 'talond.pid');
  try {
    unlinkSync(pidPath);
  } catch (cause) {
    // ENOENT is expected if the file was never created or already removed.
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw cause;
    }
  }
}
