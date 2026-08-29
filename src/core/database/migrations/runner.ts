/**
 * Database migration runner.
 *
 * Discovers numbered SQL files in a directory and applies any that have not
 * yet been applied, tracking progress via SQLite's built-in PRAGMA user_version.
 * Each migration runs inside a BEGIN IMMEDIATE transaction so it is atomic.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { MigrationError } from '../../errors/index.js';
import { registerLifecycleSqlFunctions } from '../lifecycle-sql-functions.js';

/**
 * Applies all pending migrations from `migrationsDir` to `db`.
 *
 * Migration files must be named `NNN-description.sql` where NNN is a
 * zero-padded integer version number (e.g. `001-initial-schema.sql`).
 * Files are applied in lexicographic order. The current schema version is
 * read from and written to `PRAGMA user_version` after each successful file.
 *
 * @param db            - Open better-sqlite3 Database instance.
 * @param migrationsDir - Absolute path to the directory containing .sql files.
 * @returns Result with the number of migrations applied, or a MigrationError.
 */
export function runMigrations(
  db: Database.Database,
  migrationsDir: string,
): Result<number, MigrationError> {
  // Tests and upgrade callers commonly construct better-sqlite3 directly.
  // Register before parsing migration SQL so the CHECK constraints are usable
  // immediately and unknown functions cannot accidentally weaken validation.
  try {
    registerLifecycleSqlFunctions(db);
  } catch (cause) {
    return err(
      new MigrationError(
        `Cannot register lifecycle SQLite validators: ${String(cause)}`,
        cause instanceof Error ? cause : undefined,
      ),
    );
  }
  // Read current schema version from the database.
  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch (cause) {
    return err(
      new MigrationError(
        `Cannot read migrations directory "${migrationsDir}": ${String(cause)}`,
        cause instanceof Error ? cause : undefined,
      ),
    );
  }

  let applied = 0;

  for (const file of files) {
    // Extract the numeric version prefix from the filename.
    const versionStr = file.split('-')[0];
    const version = parseInt(versionStr, 10);

    if (isNaN(version)) {
      return err(
        new MigrationError(
          `Migration file "${file}" does not start with a numeric version prefix.`,
        ),
      );
    }

    // Skip migrations that have already been applied.
    if (version <= currentVersion) {
      continue;
    }

    let sql: string;
    try {
      sql = readFileSync(join(migrationsDir, file), 'utf-8');
    } catch (cause) {
      return err(
        new MigrationError(
          `Cannot read migration file "${file}": ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }

    // Apply the migration inside an immediate transaction so that readers
    // are blocked during schema changes, preventing partial reads.
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec(sql);
      // user_version cannot be set via a bound parameter — use pragma directly.
      db.pragma(`user_version = ${version}`);
      db.exec('COMMIT');
      applied++;
    } catch (cause) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback errors; the original error is more informative.
      }
      return err(
        new MigrationError(
          `Migration "${file}" failed: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  return ok(applied);
}
