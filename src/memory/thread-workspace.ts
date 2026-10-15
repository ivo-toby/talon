/**
 * Thread workspace manager.
 *
 * Creates and queries the per-thread directory tree under the data directory.
 * Each thread gets an isolated workspace with subdirectories for memory,
 * attachments, artifacts, and IPC communication.
 *
 * Directory layout:
 * ```
 * {dataDir}/threads/{threadId}/
 *   memory/          - notebook files (CLAUDE.md, facts.md, etc.)
 *   attachments/
 *     images/        - Normalized JPEG files owned by Images (TASK-003)
 *   artifacts/       - files produced by agent runs
 *   artifacts/       - files produced by agent runs
 *   ipc/
 *     input/         - host -> sandbox messages
 *     output/        - sandbox -> host messages
 *     errors/        - sandbox error reports
 * ```
 */

import fs from 'node:fs';
import path from 'node:path';
import { ok, err, type Result } from 'neverthrow';
import { MemoryError } from '../core/errors/index.js';

// ---------------------------------------------------------------------------
// ThreadWorkspace
// ---------------------------------------------------------------------------

/**
 * Manages the per-thread directory tree on the host filesystem.
 *
 * All methods are synchronous so they can be used in contexts where
 * async I/O is not practical (e.g., during synchronous initialisation).
 */
export class ThreadWorkspace {
  constructor(private readonly dataDir: string) {}

  // -------------------------------------------------------------------------
  // Path helpers
  // -------------------------------------------------------------------------

  /** Absolute path to the root directory for a thread. */
  getThreadDir(threadId: string): string {
    return path.join(this.dataDir, 'threads', threadId);
  }

  /** Absolute path to the memory/notebook directory for a thread. */
  getMemoryDir(threadId: string): string {
    return path.join(this.getThreadDir(threadId), 'memory');
  }

  /** Absolute path to the attachments directory for a thread. */
  getAttachmentsDir(threadId: string): string {
    return path.join(this.getThreadDir(threadId), 'attachments');
  }

  /**
   * Absolute path to the thread's owned image subtree — the final home of
   * Normalized JPEG files (`attachments/images/{imageId}.jpg`).
   */
  getImageAttachmentsDir(threadId: string): string {
    return path.join(this.getAttachmentsDir(threadId), 'images');
  }

  /** Absolute path to the artifacts directory for a thread. */
  getArtifactsDir(threadId: string): string {
    return path.join(this.getThreadDir(threadId), 'artifacts');
  }

  /** Absolute path to the IPC input directory for a thread (host -> sandbox). */
  getIpcInputDir(threadId: string): string {
    return path.join(this.getThreadDir(threadId), 'ipc', 'input');
  }

  /** Absolute path to the IPC output directory for a thread (sandbox -> host). */
  getIpcOutputDir(threadId: string): string {
    return path.join(this.getThreadDir(threadId), 'ipc', 'output');
  }

  /** Absolute path to the IPC errors directory for a thread. */
  getIpcErrorsDir(threadId: string): string {
    return path.join(this.getThreadDir(threadId), 'ipc', 'errors');
  }

  // -------------------------------------------------------------------------
  // Directory creation
  // -------------------------------------------------------------------------

  /**
   * Creates all required subdirectories for a thread workspace.
   *
   * Idempotent — safe to call on an already-existing workspace.
   *
   * @returns `Ok<string>` with the thread directory path on success, or
   *          `Err<MemoryError>` if a directory could not be created.
   */
  ensureDirectories(threadId: string): Result<string, MemoryError> {
    const dirs = [
      this.getMemoryDir(threadId),
      this.getAttachmentsDir(threadId),
      this.getImageAttachmentsDir(threadId),
      this.getArtifactsDir(threadId),
      this.getIpcInputDir(threadId),
      this.getIpcOutputDir(threadId),
      this.getIpcErrorsDir(threadId),
    ];

    try {
      for (const dir of dirs) {
        fs.mkdirSync(dir, { recursive: true });
      }
      return ok(this.getThreadDir(threadId));
    } catch (cause) {
      return err(
        new MemoryError(
          `Failed to create thread workspace for "${threadId}": ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Returns `true` if the thread's root directory exists on the filesystem.
   *
   * Note: existence of the root directory does not guarantee that all
   * subdirectories are present. Call {@link ensureDirectories} to guarantee
   * the full layout.
   */
  exists(threadId: string): boolean {
    try {
      const stat = fs.statSync(this.getThreadDir(threadId));
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Returns the thread IDs for all thread directories that currently exist
   * under the data directory.
   *
   * Directories that cannot be read (e.g. due to permissions) are silently
   * omitted. Returns an empty array when the threads root does not exist.
   */
  listThreads(): string[] {
    const threadsRoot = path.join(this.dataDir, 'threads');

    try {
      const entries = fs.readdirSync(threadsRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      // threads directory does not exist or is not readable
      return [];
    }
  }
}
