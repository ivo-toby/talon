/**
 * Database migration runner.
 *
 * Applies SQL migration files and tracks progress via SQLite's built-in
 * PRAGMA user_version. Bundled Talon migrations use an explicit manifest
 * order; ad-hoc directories fall back to lexicographic filename order.
 * Each migration runs inside a BEGIN IMMEDIATE transaction so it is atomic.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { MigrationError } from '../../errors/index.js';
import { REGISTERED_MIGRATIONS } from './manifest.js';

/**
 * Applies all pending migrations from `migrationsDir` to `db`.
 *
 * Migration files in arbitrary directories must be named
 * `NNN-description.sql` where NNN is a zero-padded integer version number
 * (e.g. `001-initial-schema.sql`). Bundled Talon migrations are applied in
 * the explicit order declared in `REGISTERED_MIGRATIONS`.
 *
 * @param db            - Open better-sqlite3 Database instance.
 * @param migrationsDir - Absolute path to the directory containing .sql files.
 * @returns Result with the number of migrations applied, or a MigrationError.
 */
export function runMigrations(
  db: Database.Database,
  migrationsDir: string,
): Result<number, MigrationError> {
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

  const bundledMigrationsDir = resolve(import.meta.dirname);
  const isBundledMigrationsDir = resolve(migrationsDir) === bundledMigrationsDir;

  const orderedFiles = isBundledMigrationsDir
    ? validateBundledMigrations(files)
    : validateAdHocMigrations(files);

  if (orderedFiles.isErr()) {
    return err(orderedFiles.error);
  }

  let applied = 0;

  for (const [index, file] of orderedFiles.value.entries()) {
    const version = isBundledMigrationsDir
      ? index + 1
      : parseInt(file.split('-')[0], 10);

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

function validateBundledMigrations(files: string[]): Result<string[], MigrationError> {
  const missing = REGISTERED_MIGRATIONS.filter((file) => !files.includes(file));
  if (missing.length > 0) {
    return err(
      new MigrationError(
        `Bundled migrations directory is missing registered files: ${missing.join(', ')}`,
      ),
    );
  }

  const extras = files.filter((file) => !REGISTERED_MIGRATIONS.includes(file as (typeof REGISTERED_MIGRATIONS)[number]));
  if (extras.length > 0) {
    return err(
      new MigrationError(
        `Bundled migrations directory contains unregistered files: ${extras.join(', ')}`,
      ),
    );
  }

  return ok([...REGISTERED_MIGRATIONS]);
}

function validateAdHocMigrations(files: string[]): Result<string[], MigrationError> {
  const orderedFiles = [...files].sort();

  for (const file of orderedFiles) {
    const versionStr = file.split('-')[0];
    const version = parseInt(versionStr, 10);

    if (isNaN(version)) {
      return err(
        new MigrationError(
          `Migration file "${file}" does not start with a numeric version prefix.`,
        ),
      );
    }
  }

  return ok(orderedFiles);
}
