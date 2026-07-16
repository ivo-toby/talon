/**
 * SQLite connection factory.
 *
 * Opens a better-sqlite3 connection with WAL mode, foreign keys enabled,
 * and a busy timeout to handle concurrent access gracefully.
 */

import Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../errors/index.js';
import { registerLifecycleSqlFunctions } from './lifecycle-sql-functions.js';

/**
 * Opens a SQLite database at the given path and applies performance/safety PRAGMAs.
 *
 * @param dbPath - Filesystem path for the database file, or ':memory:' for in-memory.
 * @param options - Optional configuration (e.g. readonly mode).
 * @returns Result with the open Database instance, or a DbError on failure.
 */
export function createDatabase(
  dbPath: string,
  options?: { readonly?: boolean },
): Result<Database.Database, DbError> {
  try {
    const db = new Database(dbPath, { readonly: options?.readonly ?? false });
    registerLifecycleSqlFunctions(db);

    // WAL mode: concurrent readers do not block writers and vice versa.
    db.pragma('journal_mode = WAL');

    // Enforce referential integrity on all foreign key constraints.
    db.pragma('foreign_keys = ON');

    // Wait up to 5 seconds before giving up on a locked database.
    db.pragma('busy_timeout = 5000');

    return ok(db);
  } catch (cause) {
    return err(
      new DbError(
        `Failed to open database at "${dbPath}": ${String(cause)}`,
        cause instanceof Error ? cause : undefined,
      ),
    );
  }
}
