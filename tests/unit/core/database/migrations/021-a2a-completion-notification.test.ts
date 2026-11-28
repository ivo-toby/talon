import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../../src/core/database/migrations/runner.js';

const realDir = join(import.meta.dirname, '../../../../../src/core/database/migrations');
const MIGRATION = '021-a2a-completion-notification.sql';

describe('migration 021: a2a completion notification', () => {
  let db: Database.Database;

  afterEach(() => db.close());

  function seedTask(id: string): void {
    db.prepare(
      "INSERT INTO channels (id, type, name, config, enabled, created_at, updated_at) VALUES ('c', 'terminal', 'c', '{}', 1, 1, 1)",
    ).run();
    db.prepare(
      "INSERT OR IGNORE INTO threads (id, channel_id, external_id, metadata, created_at, updated_at) VALUES ('t', 'c', 'e', '{}', 1, 1)",
    ).run();
    db.prepare(
      `INSERT INTO a2a_tasks (id, source_persona, target_persona, thread_id, state, request_payload, submitted_at, updated_at)
       VALUES (?, 's', 'w', 't', 'completed', '{}', 1, 1)`,
    ).run(id);
  }

  it('is the next free number and is applied by the runner', () => {
    const files = readdirSync(realDir).filter((f) => f.endsWith('.sql'));
    expect(files).toContain(MIGRATION);
    db = new Database(':memory:');
    expect(runMigrations(db, realDir).isOk()).toBe(true);
    expect(db.pragma('user_version', { simple: true })).toBe(21);
  });

  it('keeps existing rows at notify=none with notified_at NULL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig021-'));
    for (const f of readdirSync(realDir).filter((x) => x.endsWith('.sql') && x < MIGRATION)) {
      copyFileSync(join(realDir, f), join(dir, f));
    }
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    expect(runMigrations(db, dir).isOk()).toBe(true);
    seedTask('old');
    copyFileSync(join(realDir, MIGRATION), join(dir, MIGRATION));
    expect(runMigrations(db, dir)._unsafeUnwrap()).toBe(1);
    const row = db.prepare("SELECT notify, notified_at FROM a2a_tasks WHERE id = 'old'").get() as {
      notify: string;
      notified_at: number | null;
    };
    expect(row).toEqual({ notify: 'none', notified_at: null });
  });

  it('rejects notify values other than wake or none and creates the owed index', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, realDir);
    seedTask('x');
    expect(() => db.prepare("UPDATE a2a_tasks SET notify = 'loud' WHERE id = 'x'").run()).toThrow(
      /CHECK/,
    );
    const idx = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_a2a_tasks_notify_owed'")
      .get() as { sql: string };
    expect(idx.sql).toMatch(/notify = 'wake'/);
    expect(idx.sql).toMatch(/completed_at IS NOT NULL/);
    expect(idx.sql).toMatch(/notified_at IS NULL/);
  });

  it('the owed-rows query is served by the partial index', () => {
    db = new Database(':memory:');
    runMigrations(db, realDir);
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM a2a_tasks
         WHERE notify = 'wake' AND notified_at IS NULL AND completed_at IS NOT NULL
         ORDER BY completed_at ASC, rowid ASC`,
      )
      .all() as Array<{ detail: string }>;
    console.info(plan.map((p) => p.detail).join(' | '));
    expect(plan.some((p) => p.detail.includes('idx_a2a_tasks_notify_owed'))).toBe(true);
  });
});
