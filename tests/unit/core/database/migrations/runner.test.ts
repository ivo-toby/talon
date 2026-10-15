import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../../src/core/database/migrations/runner.js';

/** Creates an isolated in-memory database with WAL disabled (not needed for tests). */
function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Creates a temp directory and returns its path. */
function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'talon-migration-test-'));
}

describe('runMigrations', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = freshDb();
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    db.close();
  });

  it('returns ok(0) when there are no migration files', () => {
    const result = runMigrations(db, tmpDir);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(0);
  });

  it('applies migrations in numeric order', () => {
    writeFileSync(join(tmpDir, '002-second.sql'), 'CREATE TABLE b (id TEXT PRIMARY KEY);');
    writeFileSync(join(tmpDir, '001-first.sql'), 'CREATE TABLE a (id TEXT PRIMARY KEY);');

    const result = runMigrations(db, tmpDir);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(2);

    // Both tables should now exist.
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('a');
    expect(names).toContain('b');
  });

  it('sets user_version after each migration', () => {
    writeFileSync(join(tmpDir, '001-init.sql'), 'CREATE TABLE x (id TEXT PRIMARY KEY);');
    writeFileSync(join(tmpDir, '002-add.sql'), 'CREATE TABLE y (id TEXT PRIMARY KEY);');

    runMigrations(db, tmpDir);

    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(2);
  });

  it('skips already-applied migrations on re-run', () => {
    writeFileSync(join(tmpDir, '001-init.sql'), 'CREATE TABLE x (id TEXT PRIMARY KEY);');

    // First run: applies migration 001.
    const first = runMigrations(db, tmpDir);
    expect(first._unsafeUnwrap()).toBe(1);

    // Add a second migration file.
    writeFileSync(join(tmpDir, '002-add.sql'), 'CREATE TABLE y (id TEXT PRIMARY KEY);');

    // Second run: should only apply 002.
    const second = runMigrations(db, tmpDir);
    expect(second._unsafeUnwrap()).toBe(1);

    // Final version should be 2.
    expect(db.pragma('user_version', { simple: true })).toBe(2);
  });

  it('is idempotent — re-running with same files applies 0 migrations', () => {
    writeFileSync(join(tmpDir, '001-init.sql'), 'CREATE TABLE x (id TEXT PRIMARY KEY);');
    runMigrations(db, tmpDir);

    const second = runMigrations(db, tmpDir);
    expect(second._unsafeUnwrap()).toBe(0);
  });

  it('rolls back and returns err when a migration contains invalid SQL', () => {
    writeFileSync(join(tmpDir, '001-good.sql'), 'CREATE TABLE good (id TEXT PRIMARY KEY);');
    writeFileSync(join(tmpDir, '002-bad.sql'), 'THIS IS NOT VALID SQL;');

    const result = runMigrations(db, tmpDir);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('MIGRATION_ERROR');
    expect(error.message).toMatch(/002-bad\.sql/);

    // user_version should remain at 1 (only first migration applied).
    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(1);
  });

  it('rolls back partial changes from a failed migration', () => {
    // Migration 001 creates table_a successfully.
    writeFileSync(
      join(tmpDir, '001-setup.sql'),
      'CREATE TABLE table_a (id TEXT PRIMARY KEY);',
    );
    // Migration 002 creates table_b then fails — table_b should be rolled back.
    writeFileSync(
      join(tmpDir, '002-partial.sql'),
      'CREATE TABLE table_b (id TEXT PRIMARY KEY); THIS IS INVALID;',
    );

    runMigrations(db, tmpDir);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('table_a');
    expect(names).not.toContain('table_b');
  });

  it('returns err when migrationsDir does not exist', () => {
    const result = runMigrations(db, '/nonexistent/path/to/migrations');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('MIGRATION_ERROR');
  });

  it('returns err for a migration file with non-numeric prefix', () => {
    writeFileSync(join(tmpDir, 'abc-invalid.sql'), 'CREATE TABLE z (id TEXT PRIMARY KEY);');
    const result = runMigrations(db, tmpDir);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(/numeric version prefix/);
  });

  it('upgrades a real version-013 database to Signal state without disturbing queued work', () => {
    const realMigrationsDir = join(import.meta.dirname, '../../../../../src/core/database/migrations');
    for (const file of readdirSync(realMigrationsDir).filter((file) => /^\d+.*\.sql$/.test(file) && Number(file.split('-')[0]) <= 13)) {
      copyFileSync(join(realMigrationsDir, file), join(tmpDir, file));
    }
    expect(runMigrations(db, tmpDir).isOk()).toBe(true);
    expect(db.pragma('user_version', { simple: true })).toBe(13);
    db.exec(`
      INSERT INTO channels (id, type, name, created_at, updated_at) VALUES ('c', 'terminal', 'test', 1, 1);
      INSERT INTO threads (id, channel_id, external_id, created_at, updated_at) VALUES ('t', 'c', 'test', 1, 1);
      INSERT INTO queue_items (id, thread_id, payload, created_at, updated_at) VALUES ('q', 't', '{"saved":true}', 1, 1);
    `);
    expect(runMigrations(db, realMigrationsDir)._unsafeUnwrap()).toBe(1);
    expect(db.pragma('user_version', { simple: true })).toBe(14);
    expect(db.prepare('SELECT payload FROM queue_items WHERE id = ?').get('q')).toEqual({ payload: '{"saved":true}' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('signal_account_state', 'signal_destination_leases')").all()).toHaveLength(2);
    expect(runMigrations(db, realMigrationsDir)._unsafeUnwrap()).toBe(0);
  });

  it('rejects incomplete persisted reservations and invalid lease purposes', () => {
    const realMigrationsDir = join(import.meta.dirname, '../../../../../src/core/database/migrations');
    runMigrations(db, realMigrationsDir)._unsafeUnwrap();
    expect(() => db.prepare(`INSERT INTO signal_account_state
      (account_uuid, reservation_delivery_id, created_at, updated_at) VALUES (?, 'delivery', 1, 1)`)
      .run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toThrow(/CHECK constraint/);
    expect(() => db.prepare(`INSERT INTO signal_destination_leases
      (account_uuid, external_thread_id, lease_id, queue_item_id, delivery_id, kind, created_at, updated_at)
      VALUES ('account', 'destination', 'lease', 'queue', 'delivery', 'invalid', 1, 1)`).run()).toThrow(/CHECK constraint/);
  });

  it('applies the real initial schema migration without error', () => {
    // Point at the real migrations directory relative to this worktree.
    const realMigrationsDir = join(
      import.meta.dirname,
      '../../../../../src/core/database/migrations',
    );
    const result = runMigrations(db, realMigrationsDir);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeGreaterThanOrEqual(1);

    // Spot-check: channels table should exist.
    const tbl = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='channels'`)
      .get();
    expect(tbl).toBeDefined();
  });
});
