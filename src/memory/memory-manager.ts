/**
 * Memory manager — orchestrates all memory layers for a thread.
 *
 * Provides a unified interface for reading and writing across structured
 * memory (DB), the working-memory window (recent messages), and the thread
 * notebook (filesystem files).
 */

import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, type Result } from 'neverthrow';
import type pino from 'pino';

import { MemoryError } from '../core/errors/index.js';
import type { MemoryRepository } from '../core/database/repositories/memory-repository.js';
import type { MessageRepository } from '../core/database/repositories/message-repository.js';
import type { ThreadWorkspace } from './thread-workspace.js';
import type { MemoryItem } from './memory-types.js';

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

/** Default number of recent messages returned for working memory. */
const DEFAULT_WORKING_MEMORY_LIMIT = 50;

// ---------------------------------------------------------------------------
// MemoryManager
// ---------------------------------------------------------------------------

/**
 * Orchestrates reads and writes across all memory layers for a given thread.
 *
 * - Structured memory: DB `memory_items` table via {@link MemoryRepository}.
 * - Working memory: recent messages from DB via {@link MessageRepository}.
 * - Notebook: markdown/text files in the thread's `memory/` directory.
 */
export class MemoryManager {
  constructor(
    private readonly memoryRepo: MemoryRepository,
    private readonly messageRepo: MessageRepository,
    private readonly workspace: ThreadWorkspace,
    private readonly logger: pino.Logger,
  ) {}

  // -------------------------------------------------------------------------
  // Structured memory
  // -------------------------------------------------------------------------

  /**
   * Reads structured memory items for a thread.
   *
   * @param threadId - Thread primary key.
   * @param type     - Optional type filter ('fact', 'summary', 'note', 'embedding_ref').
   *                   When omitted all types are returned.
   * @returns `Ok<MemoryItem[]>` or `Err<MemoryError>` on DB failure.
   */
  readMemory(threadId: string, type?: string): Result<MemoryItem[], MemoryError> {
    this.logger.debug({ threadId, type }, 'memory-manager: readMemory');

    const repoResult = this.memoryRepo.findByThread(
      threadId,
      type as 'fact' | 'summary' | 'note' | 'embedding_ref' | 'observation' | undefined,
    );

    if (repoResult.isErr()) {
      return err(
        new MemoryError(
          `Failed to read memory for thread "${threadId}": ${repoResult.error.message}`,
          repoResult.error,
        ),
      );
    }

    const items: MemoryItem[] = repoResult.value.map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      type: row.type,
      content: row.content,
      metadata: safeParseJson(row.metadata),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return ok(items);
  }

  /**
   * Persists a new structured memory item for a thread.
   *
   * @param item - Memory item data (id, createdAt, and updatedAt are generated).
   * @returns `Ok<MemoryItem>` with the persisted item, or `Err<MemoryError>`.
   */
  writeMemory(
    item: Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'>,
  ): Result<MemoryItem, MemoryError> {
    this.logger.debug({ threadId: item.threadId, type: item.type }, 'memory-manager: writeMemory');

    const id = uuidv4();
    const repoResult = this.memoryRepo.insert({
      id,
      thread_id: item.threadId,
      type: item.type,
      content: item.content,
      embedding_ref: null,
      metadata: JSON.stringify(item.metadata),
    });

    if (repoResult.isErr()) {
      return err(
        new MemoryError(
          `Failed to write memory for thread "${item.threadId}": ${repoResult.error.message}`,
          repoResult.error,
        ),
      );
    }

    const row = repoResult.value;
    return ok({
      id: row.id,
      threadId: row.thread_id,
      type: row.type,
      content: row.content,
      metadata: safeParseJson(row.metadata),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  // -------------------------------------------------------------------------
  // Working memory (transcript window)
  // -------------------------------------------------------------------------

  /**
   * Returns the most recent `limit` messages for a thread in ascending
   * chronological order (oldest first), suitable for injection into prompts.
   *
   * @param threadId - Thread primary key.
   * @param limit    - Maximum number of messages to return (default 50).
   * @returns `Ok<Array<...>>` or `Err<MemoryError>` on DB failure.
   */
  getWorkingMemory(
    threadId: string,
    limit: number = DEFAULT_WORKING_MEMORY_LIMIT,
  ): Result<Array<{ direction: string; content: string; createdAt: number }>, MemoryError> {
    this.logger.debug({ threadId, limit }, 'memory-manager: getWorkingMemory');

    const repoResult = this.messageRepo.findByThread(threadId, limit, 0);

    if (repoResult.isErr()) {
      return err(
        new MemoryError(
          `Failed to get working memory for thread "${threadId}": ${repoResult.error.message}`,
          repoResult.error,
        ),
      );
    }

    const messages = repoResult.value.map((row) => ({
      direction: row.direction,
      content: row.content,
      createdAt: row.created_at,
    }));

    return ok(messages);
  }

  // -------------------------------------------------------------------------
  // Thread notebook (filesystem)
  // -------------------------------------------------------------------------

  /**
   * Reads all text files from the thread's `memory/` notebook directory.
   *
   * Each file's content is returned keyed by its base filename.
   * Non-text files and unreadable files are silently skipped.
   *
   * @param threadId - Thread primary key.
   * @returns `Ok<Record<string, string>>` mapping filename to content,
   *          or `Err<MemoryError>` if the directory cannot be listed.
   */
  readNotebook(threadId: string): Result<Record<string, string>, MemoryError> {
    this.logger.debug({ threadId }, 'memory-manager: readNotebook');

    const memoryDir = this.workspace.getMemoryDir(threadId);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(memoryDir, { withFileTypes: true });
    } catch (cause) {
      // If the directory does not exist (workspace not yet created) return
      // an empty notebook rather than an error — callers tolerate this.
      if (isNodeError(cause) && cause.code === 'ENOENT') {
        return ok({});
      }
      return err(
        new MemoryError(
          `Failed to list notebook directory for thread "${threadId}": ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }

    const files: Record<string, string> = {};

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const filePath = path.join(memoryDir, entry.name);
      try {
        files[entry.name] = fs.readFileSync(filePath, 'utf8');
      } catch {
        // Skip unreadable files silently — log at debug level.
        this.logger.debug({ threadId, file: entry.name }, 'memory-manager: skipping unreadable notebook file');
      }
    }

    return ok(files);
  }

  /**
   * Writes (or overwrites) a file in the thread's `memory/` notebook directory.
   *
   * Ensures the directory exists before writing.
   *
   * @param threadId - Thread primary key.
   * @param filename - Base filename (no path separators allowed).
   * @param content  - UTF-8 text content to write.
   * @returns `Ok<void>` on success or `Err<MemoryError>` on I/O failure.
   */
  writeNotebook(threadId: string, filename: string, content: string): Result<void, MemoryError> {
    this.logger.debug({ threadId, filename }, 'memory-manager: writeNotebook');

    if (filename.includes(path.sep) || filename.includes('/') || filename.includes('\\')) {
      return err(
        new MemoryError(`Notebook filename must not contain path separators: "${filename}"`),
      );
    }

    // Ensure the memory directory exists.
    const ensureResult = this.workspace.ensureDirectories(threadId);
    if (ensureResult.isErr()) {
      return err(ensureResult.error);
    }

    const filePath = path.join(this.workspace.getMemoryDir(threadId), filename);

    try {
      fs.writeFileSync(filePath, content, 'utf8');
      return ok(undefined);
    } catch (cause) {
      return err(
        new MemoryError(
          `Failed to write notebook file "${filename}" for thread "${threadId}": ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses a JSON string into a plain object.
 * Returns an empty object on parse failure rather than throwing.
 */
function safeParseJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Type guard for Node.js system errors with a `code` property. */
function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
