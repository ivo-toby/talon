/**
 * Daemon lifecycle utilities.
 *
 * Provides checkpoint-aware queue crash recovery and PID file management
 * for single-instance enforcement.
 */

import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type pino from 'pino';
import type { Result } from 'neverthrow';
import type { QueueRepository } from '../core/database/repositories/queue-repository.js';
import type { SignalQueueFailure, SignalQueueRecovery } from '../queue/index.js';

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

/**
 * Classifies interrupted Signal work before resetting ordinary orphan claims.
 *
 * Call once with no concurrent in-memory queue/Signal work or new claims.
 * Cold startup before QueueManager construction meets this precondition; durable
 * orphan claimed/processing rows are expected inputs, not proof of active work.
 * For live recovery, await QueueManager.quiesceAndDrainClaims() outside its
 * dispatch callbacks: the full dispatch, including inspection/state-write retries,
 * must finish. Callback promises or database claim counts alone cannot prove idle.
 * Separately prevent new independent Signal actor/account dispatch and drain its
 * actors/RPCs; the manager barrier does not drain those. Keep both paths quiesced
 * throughout recovery, and serialize recovery/resume under one lifecycle owner.
 * A drain timeout never establishes idle or authorizes recovery.
 *
 * Returns the repository's exact Result, including rollback Err identity. Err is
 * NOT authorization to start Signal or resume claims; retry only recovery while
 * quiesced. Only after Ok AND registry/actor readiness may the caller explicitly
 * resumeClaims (which does not restart stopped polling) with a saved-delivery
 * handler: ready is delivery-only; delivered is local-only, even after expiry.
 * This function never starts/resumes processing. Returned interrupted invocation
 * records are available for safe operation audits; logs here contain counts only.
 *
 * TASK-012 must consume this Result and wire the saved handler/drain. The legacy
 * bootstrap currently ignores the return value and does not implement that gate.
 */
export function recoverFromCrash(
  queueRepo: QueueRepository,
  logger: pino.Logger,
): Result<SignalQueueRecovery, SignalQueueFailure> {
  const result = queueRepo.recoverSignalQueue(Date.now());
  if (result.isErr()) {
    logger.error('daemon: queue recovery failed; claims must remain quiesced');
    return result;
  }

  const { ordinaryReset: count, interruptedInvocations, ...signalCounts } = result.value;
  if (count > 0) {
    logger.warn({ count }, 'daemon: recovered in-flight queue items from previous crash');
  } else {
    logger.debug('daemon: no in-flight queue items to recover');
  }
  if (Object.values(signalCounts).some((value) => value > 0) || interruptedInvocations.length > 0) {
    logger.warn(
      { ...signalCounts, interruptedInvocations: interruptedInvocations.length },
      'daemon: recovered Signal queue state',
    );
  }
  return result;
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
