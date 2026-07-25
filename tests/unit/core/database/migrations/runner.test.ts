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
    writeFileSync(join(tmpDir, '001-setup.sql'), 'CREATE TABLE table_a (id TEXT PRIMARY KEY);');
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

  it('enforces behavior ledger evidence and lineage invariants at the migration boundary', () => {
    const realMigrationsDir = join(
      import.meta.dirname,
      '../../../../../src/core/database/migrations',
    );
    const result = runMigrations(db, realMigrationsDir);
    expect(result.isOk()).toBe(true);

    expect(() =>
      db
        .prepare(
          `INSERT INTO behavior_candidates (
            candidate_id, persona, kind, status, summary, proposed_behavior, confidence,
            created_at, updated_at
          ) VALUES (
            'direct-ready-no-evidence', 'support', 'style', 'ready',
            'Direct SQL should not bypass evidence.',
            'Keep answers concise unless detail is explicitly requested.',
            0.7, 1, 1
          )`,
        )
        .run(),
    ).toThrow();

    const insertEvidence = db.prepare(
      `INSERT INTO behavior_evidence (
        evidence_id, persona, source_kind, source_id, source_occurred_at, fingerprint,
        sentiment, confidence, summary, metadata, created_at
      ) VALUES (
        @evidenceId, 'support', 'message', @sourceId, '2026-07-25T12:00:00.000Z',
        @fingerprint, 'positive', 0.8, 'User explicitly asked for concise responses.',
        '{"detector":"migration-test"}', @createdAt
      )`,
    );
    insertEvidence.run({
      evidenceId: 'direct-evidence-a',
      sourceId: 'direct-message-a',
      fingerprint: 'direct-fingerprint-a',
      createdAt: 1,
    });
    insertEvidence.run({
      evidenceId: 'direct-evidence-b',
      sourceId: 'direct-message-b',
      fingerprint: 'direct-fingerprint-b',
      createdAt: 2,
    });

    db.prepare(
      `INSERT INTO behavior_candidates (
        candidate_id, persona, kind, status, summary, proposed_behavior, confidence,
        created_at, updated_at
      ) VALUES (
        'direct-candidate-a', 'support', 'style', 'collecting',
        'Prefer concise responses.',
        'Keep answers concise unless detail is explicitly requested.',
        0.7, 3, 3
      )`,
    ).run();
    db.prepare(
      `INSERT INTO behavior_candidate_evidence (
        candidate_id, persona, evidence_id, created_at
      ) VALUES ('direct-candidate-a', 'support', 'direct-evidence-a', 4)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `UPDATE behavior_candidates
           SET status = 'ready', updated_at = 5
           WHERE candidate_id = 'direct-candidate-a'`,
        )
        .run(),
    ).toThrow();
    db.prepare(
      `INSERT INTO behavior_candidate_evidence (
        candidate_id, persona, evidence_id, created_at
      ) VALUES ('direct-candidate-a', 'support', 'direct-evidence-b', 6)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `UPDATE behavior_candidates
           SET status = 'ready', updated_at = 7
           WHERE candidate_id = 'direct-candidate-a'`,
        )
        .run(),
    ).not.toThrow();

    db.prepare(
      `INSERT INTO behavior_promotions (
        promotion_id, persona, candidate_id, status, policy, evaluation, created_at, updated_at
      ) VALUES (
        'direct-promotion-a', 'support', 'direct-candidate-a', 'proposed',
        '{"approval":"operator"}', '{"dryRun":"passed"}', 8, 8
      )`,
    ).run();
    for (const [status, updatedAt] of [
      ['evaluating', 9],
      ['approved', 10],
      ['activating', 11],
    ] as const) {
      db.prepare(
        `UPDATE behavior_promotions
         SET status = ?, updated_at = ?
         WHERE promotion_id = 'direct-promotion-a'`,
      ).run(status, updatedAt);
    }
    expect(() =>
      db
        .prepare(
          `UPDATE behavior_promotions
           SET status = 'active', updated_at = 12
           WHERE promotion_id = 'direct-promotion-a'`,
        )
        .run(),
    ).toThrow();
    expect(
      db
        .prepare(`SELECT status FROM behavior_promotions WHERE promotion_id = 'direct-promotion-a'`)
        .get(),
    ).toEqual({ status: 'activating' });
    db.prepare(
      `INSERT INTO behavior_promotion_activations (
        activation_id, persona, promotion_id, prompt_artifact_id, reload_id, activated_at
      ) VALUES (
        'direct-activation-a', 'support', 'direct-promotion-a',
        'direct-prompt-a', 'direct-reload-a', 12
      )`,
    ).run();
    db.prepare(
      `INSERT INTO behavior_promotion_activations (
        activation_id, persona, promotion_id, prompt_artifact_id, reload_id, activated_at
      ) VALUES (
        'direct-activation-b', 'support', 'direct-promotion-a',
        'direct-prompt-b', 'direct-reload-b', 12
      )`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO behavior_promotion_rollbacks (
            rollback_id, persona, activation_id, promotion_id, reason, rolled_back_at
          ) VALUES (
            'direct-rollback-before-active', 'support', 'direct-activation-a',
            'direct-promotion-a', 'operator-rejected', 12
          )`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE behavior_promotions
           SET status = 'active', updated_at = 12
           WHERE promotion_id = 'direct-promotion-a'`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE behavior_promotions
           SET status = 'rolled_back', updated_at = 14
           WHERE promotion_id = 'direct-promotion-a'`,
        )
        .run(),
    ).toThrow();
    expect(
      db
        .prepare(`SELECT status FROM behavior_promotions WHERE promotion_id = 'direct-promotion-a'`)
        .get(),
    ).toEqual({ status: 'active' });
    expect(() =>
      db
        .prepare(
          `INSERT INTO behavior_promotion_rollbacks (
            rollback_id, persona, activation_id, promotion_id, reason, rolled_back_at
          ) VALUES (
            'direct-rollback-active', 'support', 'direct-activation-a',
            'direct-promotion-a', 'operator-rejected', 13
          )`,
        )
        .run(),
    ).not.toThrow();
    expect(
      db
        .prepare(
          `SELECT rollback_id FROM behavior_promotion_rollbacks
           WHERE rollback_id = 'direct-rollback-active'`,
        )
        .get(),
    ).toEqual({ rollback_id: 'direct-rollback-active' });
    db.prepare(
      `UPDATE behavior_promotions
       SET status = 'rolled_back', updated_at = 13
       WHERE promotion_id = 'direct-promotion-a'`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO behavior_promotion_rollbacks (
            rollback_id, persona, activation_id, promotion_id, reason, rolled_back_at
          ) VALUES (
            'direct-rollback-after-rollback', 'support', 'direct-activation-b',
            'direct-promotion-a', 'operator-rejected', 14
          )`,
        )
        .run(),
    ).toThrow();

    insertEvidence.run({
      evidenceId: 'direct-evidence-c',
      sourceId: 'direct-message-c',
      fingerprint: 'direct-fingerprint-c',
      createdAt: 14,
    });
    insertEvidence.run({
      evidenceId: 'direct-evidence-d',
      sourceId: 'direct-message-d',
      fingerprint: 'direct-fingerprint-d',
      createdAt: 15,
    });
    db.prepare(
      `INSERT INTO behavior_candidates (
        candidate_id, persona, kind, status, summary, proposed_behavior, confidence,
        created_at, updated_at
      ) VALUES (
        'direct-candidate-b', 'support', 'style', 'collecting',
        'Prefer brief replies.',
        'Use a compact answer shape unless asked for detail.',
        0.7, 16, 16
      )`,
    ).run();
    for (const [evidenceId, createdAt] of [
      ['direct-evidence-c', 17],
      ['direct-evidence-d', 18],
    ] as const) {
      db.prepare(
        `INSERT INTO behavior_candidate_evidence (
          candidate_id, persona, evidence_id, created_at
        ) VALUES ('direct-candidate-b', 'support', ?, ?)`,
      ).run(evidenceId, createdAt);
    }
    db.prepare(
      `UPDATE behavior_candidates
       SET status = 'ready', updated_at = 19
       WHERE candidate_id = 'direct-candidate-b'`,
    ).run();
    db.prepare(
      `INSERT INTO behavior_promotions (
        promotion_id, persona, candidate_id, status, policy, evaluation, created_at, updated_at
      ) VALUES (
        'direct-promotion-b', 'support', 'direct-candidate-b', 'proposed',
        '{"approval":"operator"}', '{"dryRun":"passed"}', 20, 20
      )`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO behavior_promotion_rollbacks (
            rollback_id, persona, activation_id, promotion_id, reason, rolled_back_at
          ) VALUES (
            'direct-rollback-mismatch', 'support', 'direct-activation-a',
            'direct-promotion-b', 'operator-rejected', 21
          )`,
        )
        .run(),
    ).toThrow();
  });

  it('upgrades a pre-lifecycle schema with the durable event tables', () => {
    const realMigrationsDir = join(
      import.meta.dirname,
      '../../../../../src/core/database/migrations',
    );
    const legacyDir = makeTmpDir();
    for (const file of readdirSync(realMigrationsDir)) {
      if (file.endsWith('.sql') && Number.parseInt(file, 10) <= 13) {
        copyFileSync(join(realMigrationsDir, file), join(legacyDir, file));
      }
    }

    expect(runMigrations(db, legacyDir)._unsafeUnwrap()).toBeGreaterThan(0);
    expect(db.pragma('user_version', { simple: true })).toBe(13);

    const upgrade = runMigrations(db, realMigrationsDir);
    expect(upgrade._unsafeUnwrap()).toBe(5);
    expect(db.pragma('user_version', { simple: true })).toBe(18);
    for (const table of [
      'lifecycle_events',
      'lifecycle_event_deliveries',
      'lifecycle_signal_handoffs',
      'lifecycle_signals',
      'behavior_evidence',
      'behavior_candidates',
      'behavior_promotions',
      'behavior_promotion_activations',
      'behavior_promotion_rollbacks',
    ]) {
      expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table),
      ).toBeDefined();
    }

    const indexes = db.prepare(`PRAGMA index_list('lifecycle_event_deliveries')`).all() as Array<{
      name: string;
      partial: number;
    }>;
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'idx_lifecycle_deliveries_ready', partial: 1 }),
        expect.objectContaining({ name: 'idx_lifecycle_deliveries_expired_claims', partial: 1 }),
        expect.objectContaining({ name: 'idx_lifecycle_deliveries_handler_status', partial: 0 }),
      ]),
    );
    const expiredColumns = db
      .prepare(`PRAGMA index_info('idx_lifecycle_deliveries_expired_claims')`)
      .all() as Array<{ name: string }>;
    expect(expiredColumns.map((column) => column.name)).toEqual([
      'claim_expires_at',
      'priority',
      'created_at',
    ]);
    const triggers = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'lifecycle_event_deliveries'`,
      )
      .all() as Array<{ name: string }>;
    expect(triggers.map((trigger) => trigger.name)).toEqual(
      expect.arrayContaining([
        'lifecycle_event_deliveries_guard_initial_insert',
        'lifecycle_event_deliveries_reject_replacements',
        'lifecycle_event_deliveries_guard_transitions',
      ]),
    );
    const foreignKeys = db
      .prepare(`PRAGMA foreign_key_list('lifecycle_event_deliveries')`)
      .all() as Array<{ table: string; from: string; to: string; on_delete: string }>;
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'lifecycle_events',
          from: 'event_id',
          to: 'event_id',
          on_delete: 'CASCADE',
        }),
      ]),
    );

    db.prepare(
      `INSERT INTO lifecycle_events (
        event_id, version, type, aggregate_type, aggregate_id, correlation_id,
        causation_id, recursion_depth, recursion_max_depth, provenance, payload,
        occurred_at, created_at
      ) VALUES (?, 'v1', 'run.completed.v1', 'thread', 'thread-1', 'correlation-1',
        NULL, 0, 1, '{"source":"daemon","sourceEventIds":[],"sourceReferences":[]}', '{"references":[],"metadata":{}}',
        '2026-07-16T10:00:00.000Z', 1)`,
    ).run('event-1');
    const insertEventWithPayload = db.prepare(
      `INSERT INTO lifecycle_events (
        event_id, version, type, aggregate_type, aggregate_id, correlation_id,
        causation_id, recursion_depth, recursion_max_depth, provenance, payload,
        occurred_at, created_at
      ) VALUES (@eventId, 'v1', 'run.completed.v1', 'thread', 'thread-1', @eventId,
        NULL, @recursionDepth, @recursionMaxDepth,
        '{"source":"daemon","sourceEventIds":[],"sourceReferences":[]}', @payload,
        '2026-07-16T10:00:00.000Z', 1)`,
    );
    expect(() =>
      insertEventWithPayload.run({
        eventId: 'event-recursion-max-zero',
        recursionDepth: 0,
        recursionMaxDepth: 0,
        payload: '{"references":[],"metadata":{}}',
      }),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO lifecycle_event_deliveries (
          event_id, handler_id, persona, priority, handler_identity, failure_policy,
          status, attempts, max_attempts, created_at, updated_at
        ) VALUES ('event-1', 'handler-1', 'support', 0, '{"version":"v1"}',
          '{"version":"v1","mode":"dead_letter"}', 'not-a-state', 0, 1, 1, 1)`,
        )
        .run(),
    ).toThrow();
    // Escaped lone surrogates cannot be faithfully represented by JSON1 and
    // must fail, while ordinary escaped Unicode remains valid. Use INSERTs:
    // the event outbox itself is intentionally immutable after persistence.
    expect(() =>
      insertEventWithPayload.run({
        eventId: 'event-payload-lone-surrogate',
        recursionDepth: 0,
        recursionMaxDepth: 1,
        payload: '{"references":[],"metadata":{"bad":"\\ud800"}}',
      }),
    ).toThrow();
    for (const [index, payload] of [
      '{"references":[{"type":"run"}],"metadata":{}}',
      '{"references":[{"type":"run","id":null}],"metadata":{}}',
      '{"references":[{"type":" bad","id":"reference-1"}],"metadata":{}}',
      '{"references":[{"type":"run","id":" reference-1"}],"metadata":{}}',
      '{"references":[],"metadata":{" unicode":"value"}}',
      '{"references":["{\\"type\\":\\"run\\",\\"id\\":\\"reference-1\\"}"],"metadata":{}}',
      '{"references":[],"metadata":{"a":1,"a":2}}',
      '{"references":[],"metadata":{"huge":1e999}}',
      '{"references":[],"metadata":{"negative":-1e999}}',
      '{"references":[],"metadata":{"A":true,"Ａ":false}}',
    ].entries()) {
      expect(() =>
        insertEventWithPayload.run({
          eventId: `event-invalid-payload-${index}`,
          recursionDepth: 0,
          recursionMaxDepth: 1,
          payload,
        }),
      ).toThrow();
    }
    for (const [index, payload] of [
      '{"references":[],"metadata":{"café":"emoji 😀"}}',
      '{"references":[],"metadata":{"escaped":"line\\nbreak\\tand \\u0001"}}',
      '{"references":[],"metadata":{"literal":"\\\\u1234"}}',
    ].entries()) {
      expect(() =>
        insertEventWithPayload.run({
          eventId: `event-valid-payload-${index}`,
          recursionDepth: 0,
          recursionMaxDepth: 1,
          payload,
        }),
      ).not.toThrow();
      expect(
        db
          .prepare(`SELECT payload FROM lifecycle_events WHERE event_id = ?`)
          .get(`event-valid-payload-${index}`),
      ).toEqual({ payload });
    }
    expect(() =>
      db
        .prepare(`UPDATE lifecycle_events SET aggregate_type = 'Thread' WHERE event_id = 'event-1'`)
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE lifecycle_events SET aggregate_id = 'forged-thread' WHERE event_id = 'event-1'`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(`UPDATE lifecycle_events SET provenance = ? WHERE event_id = 'event-1'`)
        .run('{"source":"daemon","sourceEventIds":[],"sourceReferences":[{"type":"run"}]}'),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO lifecycle_event_deliveries (
          event_id, handler_id, persona, priority, handler_identity, failure_policy,
          status, attempts, max_attempts, created_at, updated_at
        ) VALUES ('event-1', 'handler-2', 'support', 0, '{not-json}',
          '{"version":"v1","mode":"dead_letter"}', 'pending', 0, 1, 1, 1)`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO lifecycle_event_deliveries (
          event_id, handler_id, persona, priority, handler_identity, failure_policy,
          status, attempts, max_attempts, created_at, updated_at
        ) VALUES ('event-1', 'handler-3', 'support', 0,
          '{"version":"v2"}', '{"version":"v1","mode":"dead_letter"}',
          'pending', 0, 1, 1, 1)`,
        )
        .run(),
    ).toThrow();

    const insertValidDelivery = db.prepare(
      `INSERT INTO lifecycle_event_deliveries (
        event_id, handler_id, persona, priority, handler_identity, failure_policy,
        status, attempts, max_attempts, created_at, updated_at
      ) VALUES ('event-1', @handlerId, @persona, 0, @identity, @failurePolicy,
        'pending', 0, 1, 1, 1)`,
    );
    const failurePolicy = '{"version":"v1","mode":"dead_letter"}';
    const identityFor = (handlerId: string): string =>
      JSON.stringify({
        version: 'v1',
        handlerId,
        runtimeKind: 'native',
        implementationRef: 'run-projector',
        implementationVersion: '1.0.0',
        mode: 'event',
        inputContract: 'talon.lifecycle.event.envelope.v1',
        outputContract: 'talon.lifecycle.signal.envelopes.v1',
      });
    const interceptorIdentity = (
      handlerId: string,
      overrides: Record<string, unknown> = {},
    ): string =>
      JSON.stringify({
        version: 'v1',
        handlerId,
        runtimeKind: 'native',
        implementationRef: 'run-projector',
        implementationVersion: '1.0.0',
        mode: 'interceptor',
        inputContract: 'talon.lifecycle.interceptor.input.v1',
        outputContract: 'talon.lifecycle.advisory.interceptor.output.v1',
        interceptorSafety: 'advisory',
        ...overrides,
      });
    // A database already at v14 receives only the additive rebuild. Its valid
    // durable rows must survive while the rebuilt indexes, foreign key, and
    // transition triggers remain present.
    const v14Dir = makeTmpDir();
    for (const file of readdirSync(realMigrationsDir)) {
      if (file.endsWith('.sql') && Number.parseInt(file, 10) <= 14) {
        copyFileSync(join(realMigrationsDir, file), join(v14Dir, file));
      }
    }
    const preservedDb = freshDb();
    try {
      expect(runMigrations(preservedDb, legacyDir)._unsafeUnwrap()).toBeGreaterThan(0);
      expect(runMigrations(preservedDb, v14Dir)._unsafeUnwrap()).toBe(1);
      expect(preservedDb.pragma('user_version', { simple: true })).toBe(14);
      preservedDb
        .prepare(
          `INSERT INTO lifecycle_events (
            event_id, version, type, aggregate_type, aggregate_id, correlation_id,
            causation_id, recursion_depth, recursion_max_depth, provenance, payload,
            occurred_at, created_at
          ) VALUES ('preserved-event', 'v1', 'run.completed.v1', 'thread', 'preserved-thread',
            'preserved-correlation', NULL, 0, 1,
            '{"source":"daemon","sourceEventIds":[],"sourceReferences":[]}',
            '{"references":[],"metadata":{}}', '2026-07-16T10:00:00.000Z', 1)`,
        )
        .run();
      preservedDb
        .prepare(
          `INSERT INTO lifecycle_event_deliveries (
            event_id, handler_id, persona, priority, handler_identity, failure_policy,
            status, attempts, max_attempts, created_at, updated_at
          ) VALUES ('preserved-event', 'preserved-handler', 'support', 0, ?,
            '{"version":"v1","mode":"dead_letter"}', 'pending', 0, 3, 1, 1)`,
        )
        .run(identityFor('preserved-handler'));

      expect(runMigrations(preservedDb, realMigrationsDir)._unsafeUnwrap()).toBe(4);
      expect(preservedDb.pragma('user_version', { simple: true })).toBe(18);
      expect(
        preservedDb
          .prepare(
            `SELECT status, attempts, max_attempts FROM lifecycle_event_deliveries
             WHERE event_id = 'preserved-event' AND handler_id = 'preserved-handler'`,
          )
          .get(),
      ).toEqual({ status: 'pending', attempts: 0, max_attempts: 3 });
      expect(
        preservedDb
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'trigger'
             AND name = 'lifecycle_event_deliveries_guard_transitions'`,
          )
          .get(),
      ).toBeDefined();
      expect(
        preservedDb.prepare(`PRAGMA foreign_key_list('lifecycle_event_deliveries')`).all(),
      ).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'lifecycle_events' })]));
    } finally {
      preservedDb.close();
    }
    for (const [handlerId, identity] of [
      [
        'handler-advisory-enforcing-output',
        interceptorIdentity('handler-advisory-enforcing-output', {
          outputContract: 'talon.lifecycle.enforcing.interceptor.output.v1',
        }),
      ],
      [
        'handler-enforcing-advisory-output',
        interceptorIdentity('handler-enforcing-advisory-output', {
          interceptorSafety: 'enforcing',
        }),
      ],
      [
        'handler-enforcing-subagent',
        interceptorIdentity('handler-enforcing-subagent', {
          interceptorSafety: 'enforcing',
          outputContract: 'talon.lifecycle.enforcing.interceptor.output.v1',
          runtimeKind: 'subagent',
        }),
      ],
      [
        'handler-enforcing-missing-safety',
        interceptorIdentity('handler-enforcing-missing-safety', {
          outputContract: 'talon.lifecycle.enforcing.interceptor.output.v1',
          interceptorSafety: undefined,
        }),
      ],
    ] as const) {
      expect(() =>
        insertValidDelivery.run({ handlerId, persona: 'support', identity, failurePolicy }),
      ).toThrow();
    }
    expect(() =>
      insertValidDelivery.run({
        handlerId: 'handler-4',
        persona: 'support',
        identity: identityFor('handler-4'),
        failurePolicy,
      }),
    ).not.toThrow();
    // Identity and policy are one authority decision. A syntactically valid
    // policy cannot be paired with the wrong handler mode on INSERT or UPDATE.
    for (const [handlerId, identity, incompatiblePolicy] of [
      ['handler-event-fail-open', identityFor('handler-event-fail-open'), 'fail_open'],
      [
        'handler-advisory-dead-letter',
        interceptorIdentity('handler-advisory-dead-letter'),
        'dead_letter',
      ],
      [
        'handler-enforcing-fail-open',
        interceptorIdentity('handler-enforcing-fail-open', {
          interceptorSafety: 'enforcing',
          outputContract: 'talon.lifecycle.enforcing.interceptor.output.v1',
        }),
        'fail_open',
      ],
    ] as const) {
      expect(() =>
        insertValidDelivery.run({
          handlerId,
          persona: 'support',
          identity,
          failurePolicy: JSON.stringify({ version: 'v1', mode: incompatiblePolicy }),
        }),
      ).toThrow();
    }
    expect(() =>
      db
        .prepare(
          `UPDATE lifecycle_event_deliveries
           SET failure_policy = '{"version":"v1","mode":"fail_open"}'
           WHERE handler_id = 'handler-4'`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE lifecycle_event_deliveries
           SET handler_identity = ?
           WHERE handler_id = 'handler-4'`,
        )
        .run(interceptorIdentity('handler-4')),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE lifecycle_event_deliveries SET handler_identity = ? WHERE handler_id = 'handler-4'`,
        )
        .run(
          JSON.stringify({
            ...JSON.parse(identityFor('handler-4')),
            mode: 'event',
            inputContract: 'talon.lifecycle.signal.envelope.v1',
          }),
        ),
    ).toThrow();
    // Individually valid, policy-compatible replacements are still forged
    // authority snapshots and must remain immutable after fan-out.
    expect(() =>
      db
        .prepare(
          `UPDATE lifecycle_event_deliveries SET handler_identity = ? WHERE handler_id = 'handler-4'`,
        )
        .run(
          JSON.stringify({
            ...JSON.parse(identityFor('handler-4')),
            implementationVersion: '2.0.0',
          }),
        ),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE lifecycle_event_deliveries
           SET failure_policy = '{"version":"v1","mode":"preserve_session"}'
           WHERE handler_id = 'handler-4'`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      insertValidDelivery.run({
        handlerId: 'handler-policy-null',
        persona: 'support',
        identity: identityFor('handler-policy-null'),
        failurePolicy: '{"version":"v1","mode":null}',
      }),
    ).toThrow();
    expect(() =>
      insertValidDelivery.run({
        handlerId: 'handler-persona-boundary',
        persona: 'p'.repeat(256),
        identity: identityFor('handler-persona-boundary'),
        failurePolicy,
      }),
    ).not.toThrow();
    expect(() =>
      insertValidDelivery.run({
        handlerId: 'handler-persona-overflow',
        persona: 'p'.repeat(257),
        identity: identityFor('handler-persona-overflow'),
        failurePolicy,
      }),
    ).toThrow();
    const maxUtf8Persona = '😀'.repeat(256);
    expect(Array.from(maxUtf8Persona)).toHaveLength(256);
    expect(Buffer.byteLength(maxUtf8Persona, 'utf8')).toBe(1_024);
    expect(() =>
      insertValidDelivery.run({
        handlerId: 'handler-persona-utf8-boundary',
        persona: maxUtf8Persona,
        identity: identityFor('handler-persona-utf8-boundary'),
        failurePolicy,
      }),
    ).not.toThrow();
    expect(() =>
      insertValidDelivery.run({
        handlerId: 'handler-persona-utf8-overflow',
        persona: `${maxUtf8Persona}😀`,
        identity: identityFor('handler-persona-utf8-overflow'),
        failurePolicy,
      }),
    ).toThrow();
    // Bind the value so this regression covers SQLite's TEXT handling without
    // leaving an invalid fixture row behind for later assertions.
    expect(() =>
      insertValidDelivery.run({
        handlerId: 'handler-persona-nul',
        persona: 'support\0poison',
        identity: identityFor('handler-persona-nul'),
        failurePolicy,
      }),
    ).toThrow();
    for (const [handlerId, persona, identity] of [
      ['handler-5', 'support', '{"handlerId":"handler-5"}'],
      ['handler-6', 'support', '[]'],
      ['handler-7', 'support', identityFor('another-handler')],
      ['handler-8', '', identityFor('handler-8')],
    ]) {
      expect(() =>
        insertValidDelivery.run({ handlerId, persona, identity, failurePolicy }),
      ).toThrow();
    }
    expect(() =>
      db
        .prepare(
          `INSERT INTO lifecycle_event_deliveries (
            event_id, handler_id, persona, priority, handler_identity, failure_policy,
            status, attempts, max_attempts, created_at, updated_at
          ) VALUES ('event-1', 'handler-9', 'support', 0, ?, ?, 'claimed', 0, 1, 1, 1)`,
        )
        .run(identityFor('handler-9'), failurePolicy),
    ).toThrow();
    expect(() =>
      db.prepare(`UPDATE lifecycle_events SET causation_id = '' WHERE event_id = 'event-1'`).run(),
    ).toThrow();

    // The migration is also the durability boundary: direct SQL cannot bypass
    // the bounded lifecycle contract even when repository validation is absent.
    expect(() =>
      db
        .prepare(
          `UPDATE lifecycle_events SET type = 'unshipped.event.v1' WHERE event_id = 'event-1'`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE lifecycle_events SET occurred_at = 'not-a-timestamp' WHERE event_id = 'event-1'`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE lifecycle_events SET occurred_at = '2026-07-16T10:00:00.000+00:00' WHERE event_id = 'event-1'`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(`UPDATE lifecycle_events SET recursion_max_depth = 17 WHERE event_id = 'event-1'`)
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(`UPDATE lifecycle_events SET provenance = ? WHERE event_id = 'event-1'`)
        .run('{"source":"daemon","sourceEventIds":[1],"sourceReferences":[]}'),
    ).toThrow();
    expect(() =>
      db.prepare(`UPDATE lifecycle_events SET payload = ? WHERE event_id = 'event-1'`).run(
        JSON.stringify({
          references: [],
          metadata: Object.fromEntries(
            Array.from({ length: 33 }, (_, index) => [`k${index}`, index]),
          ),
        }),
      ),
    ).toThrow();
    expect(() =>
      db
        .prepare(`UPDATE lifecycle_events SET payload = ? WHERE event_id = 'event-1'`)
        .run(JSON.stringify({ references: [{ type: 'run', id: 1 }], metadata: {} })),
    ).toThrow();
    expect(() =>
      db
        .prepare(`UPDATE lifecycle_events SET payload = ? WHERE event_id = 'event-1'`)
        .run(JSON.stringify({ references: [], metadata: { body: 'x'.repeat(262_144) } })),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE lifecycle_event_deliveries SET handler_identity = ? WHERE handler_id = 'handler-4'`,
        )
        .run(JSON.stringify({ ...JSON.parse(identityFor('handler-4')), extra: true })),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE lifecycle_event_deliveries SET failure_policy = ? WHERE handler_id = 'handler-4'`,
        )
        .run('{"version":"v1","mode":"dead_letter","extra":true}'),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE lifecycle_event_deliveries SET handler_identity = ? WHERE handler_id = 'handler-4'`,
        )
        .run(
          JSON.stringify({
            ...JSON.parse(identityFor('handler-4')),
            implementationRef: 'x'.repeat(129),
          }),
        ),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE lifecycle_event_deliveries
           SET status = 'completed', completed_at = 2, updated_at = 2
           WHERE handler_id = 'handler-4'`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE lifecycle_event_deliveries
           SET status = 'failed', attempts = 1, max_attempts = 2, next_retry_at = 2,
               last_error = '{}'
           WHERE handler_id = 'handler-4'`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE lifecycle_event_deliveries
           SET status = 'failed', attempts = 1, max_attempts = 2, next_retry_at = 2,
               last_error = ?
           WHERE handler_id = 'handler-4'`,
        )
        .run(JSON.stringify({ code: 'x'.repeat(129) })),
    ).toThrow();

    // Direct SQL must not be able to create a terminal delivery or use
    // conflict replacement to sidestep the immutable event/fan-out snapshots.
    // These are real SQLite statements, rather than repository tests, because
    // the migration is the final durability boundary.
    const replaceEventId = 'event-replace-guard';
    db.prepare(
      `INSERT INTO lifecycle_events (
        event_id, version, type, aggregate_type, aggregate_id, correlation_id,
        causation_id, recursion_depth, recursion_max_depth, provenance, payload,
        occurred_at, created_at
      ) VALUES (?, 'v1', 'run.completed.v1', 'thread', 'original-thread', 'replace-correlation',
        NULL, 0, 1, '{"source":"daemon","sourceEventIds":[],"sourceReferences":[]}',
        '{"references":[],"metadata":{"original":true}}', '2026-07-16T10:00:00.000Z', 10)`,
    ).run(replaceEventId);
    const originalEvent = db
      .prepare(
        `SELECT event_sequence, aggregate_id, payload FROM lifecycle_events WHERE event_id = ?`,
      )
      .get(replaceEventId);
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO lifecycle_events (
            event_id, version, type, aggregate_type, aggregate_id, correlation_id,
            causation_id, recursion_depth, recursion_max_depth, provenance, payload,
            occurred_at, created_at
          ) VALUES (?, 'v1', 'run.completed.v1', 'thread', 'forged-thread', 'replace-correlation',
            NULL, 0, 1, '{"source":"daemon","sourceEventIds":[],"sourceReferences":[]}',
            '{"references":[],"metadata":{"forged":true}}', '2026-07-16T10:00:00.000Z', 11)`,
        )
        .run(replaceEventId),
    ).toThrow();
    expect(
      db
        .prepare(
          `SELECT event_sequence, aggregate_id, payload FROM lifecycle_events WHERE event_id = ?`,
        )
        .get(replaceEventId),
    ).toEqual(originalEvent);
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO lifecycle_events (
            event_sequence, event_id, version, type, aggregate_type, aggregate_id, correlation_id,
            causation_id, recursion_depth, recursion_max_depth, provenance, payload,
            occurred_at, created_at
          ) VALUES (?, 'forged-sequence-event', 'v1', 'run.completed.v1', 'thread',
            'forged-thread', 'forged-sequence-correlation', NULL, 0, 1,
            '{"source":"daemon","sourceEventIds":[],"sourceReferences":[]}',
            '{"references":[],"metadata":{"forged":true}}', '2026-07-16T10:00:00.000Z', 11)`,
        )
        .run((originalEvent as { event_sequence: number }).event_sequence),
    ).toThrow();
    expect(
      db
        .prepare(
          `SELECT event_sequence, aggregate_id, payload FROM lifecycle_events WHERE event_id = ?`,
        )
        .get(replaceEventId),
    ).toEqual(originalEvent);

    // SQLite exposes an omitted INTEGER PRIMARY KEY as -1 in a BEFORE INSERT
    // trigger. The durable table must nevertheless reject direct sentinel
    // sequences, while leaving a repository-shaped omitted insert functional.
    expect(() =>
      db
        .prepare(
          `INSERT INTO lifecycle_events (
            event_sequence, event_id, version, type, aggregate_type, aggregate_id, correlation_id,
            causation_id, recursion_depth, recursion_max_depth, provenance, payload,
            occurred_at, created_at
          ) VALUES (-1, 'event-negative-sequence', 'v1', 'run.completed.v1', 'thread',
            'thread-negative-sequence', 'correlation-negative-sequence', NULL, 0, 1,
            '{"source":"daemon","sourceEventIds":[],"sourceReferences":[]}',
            '{"references":[],"metadata":{}}', '2026-07-16T10:00:00.000Z', 12)`,
        )
        .run(),
    ).toThrow();
    expect(
      db
        .prepare(`SELECT event_sequence FROM lifecycle_events WHERE event_id = ?`)
        .get('event-negative-sequence'),
    ).toBeUndefined();
    expect(() =>
      insertEventWithPayload.run({
        eventId: 'event-auto-after-negative-sequence',
        recursionDepth: 0,
        recursionMaxDepth: 1,
        payload: '{"references":[],"metadata":{}}',
      }),
    ).not.toThrow();
    const autoInsertedEvent = db
      .prepare(`SELECT event_sequence FROM lifecycle_events WHERE event_id = ?`)
      .get('event-auto-after-negative-sequence') as { event_sequence: number };
    expect(autoInsertedEvent.event_sequence).toBeGreaterThan(0);

    // A legacy or externally damaged database may already contain -1. Its
    // replacement attempt still must be atomic: the failed statement cannot
    // delete the original event and cascade-delete its existing delivery.
    db.pragma('ignore_check_constraints = ON');
    try {
      db.prepare(
        `INSERT INTO lifecycle_events (
          event_sequence, event_id, version, type, aggregate_type, aggregate_id, correlation_id,
          causation_id, recursion_depth, recursion_max_depth, provenance, payload,
          occurred_at, created_at
        ) VALUES (-1, 'legacy-negative-sequence', 'v1', 'run.completed.v1', 'thread',
          'legacy-thread', 'legacy-correlation', NULL, 0, 1,
          '{"source":"daemon","sourceEventIds":[],"sourceReferences":[]}',
          '{"references":[],"metadata":{"original":true}}', '2026-07-16T10:00:00.000Z', 12)`,
      ).run();
    } finally {
      db.pragma('ignore_check_constraints = OFF');
    }
    const legacyNegativeEvent = db
      .prepare(
        `SELECT event_sequence, aggregate_id, payload FROM lifecycle_events WHERE event_id = ?`,
      )
      .get('legacy-negative-sequence');
    const legacyHandlerId = 'legacy-negative-handler';
    db.prepare(
      `INSERT INTO lifecycle_event_deliveries (
        event_id, handler_id, persona, priority, handler_identity, failure_policy,
        status, attempts, max_attempts, created_at, updated_at
      ) VALUES (?, ?, 'support', 1, ?, ?, 'pending', 0, 2, 12, 12)`,
    ).run('legacy-negative-sequence', legacyHandlerId, identityFor(legacyHandlerId), failurePolicy);
    const legacyNegativeDelivery = db
      .prepare(
        `SELECT event_id, handler_id, persona, priority, status, attempts
         FROM lifecycle_event_deliveries WHERE event_id = ? AND handler_id = ?`,
      )
      .get('legacy-negative-sequence', legacyHandlerId);
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO lifecycle_events (
            event_sequence, event_id, version, type, aggregate_type, aggregate_id, correlation_id,
            causation_id, recursion_depth, recursion_max_depth, provenance, payload,
            occurred_at, created_at
          ) VALUES (-1, 'forged-negative-sequence', 'v1', 'run.completed.v1', 'thread',
            'forged-thread', 'forged-correlation', NULL, 0, 1,
            '{"source":"daemon","sourceEventIds":[],"sourceReferences":[]}',
            '{"references":[],"metadata":{"forged":true}}', '2026-07-16T10:00:00.000Z', 13)`,
        )
        .run(),
    ).toThrow();
    expect(
      db
        .prepare(
          `SELECT event_sequence, aggregate_id, payload FROM lifecycle_events WHERE event_id = ?`,
        )
        .get('legacy-negative-sequence'),
    ).toEqual(legacyNegativeEvent);
    expect(
      db
        .prepare(`SELECT event_id FROM lifecycle_events WHERE event_id = ?`)
        .get('forged-negative-sequence'),
    ).toBeUndefined();
    expect(
      db
        .prepare(
          `SELECT event_id, handler_id, persona, priority, status, attempts
           FROM lifecycle_event_deliveries WHERE event_id = ? AND handler_id = ?`,
        )
        .get('legacy-negative-sequence', legacyHandlerId),
    ).toEqual(legacyNegativeDelivery);

    const replaceHandlerId = 'replace-guard-handler';
    db.prepare(
      `INSERT INTO lifecycle_event_deliveries (
        event_id, handler_id, persona, priority, handler_identity, failure_policy,
        status, attempts, max_attempts, created_at, updated_at
      ) VALUES (?, ?, 'support', 1, ?, ?, 'pending', 0, 2, 10, 10)`,
    ).run(replaceEventId, replaceHandlerId, identityFor(replaceHandlerId), failurePolicy);
    const originalDelivery = db
      .prepare(
        `SELECT persona, priority, handler_identity, status, attempts
         FROM lifecycle_event_deliveries WHERE event_id = ? AND handler_id = ?`,
      )
      .get(replaceEventId, replaceHandlerId);
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO lifecycle_event_deliveries (
            event_id, handler_id, persona, priority, handler_identity, failure_policy,
            status, attempts, max_attempts, created_at, updated_at
          ) VALUES (?, ?, 'forged', 99, ?, ?, 'pending', 0, 2, 11, 11)`,
        )
        .run(replaceEventId, replaceHandlerId, identityFor(replaceHandlerId), failurePolicy),
    ).toThrow();
    expect(
      db
        .prepare(
          `SELECT persona, priority, handler_identity, status, attempts
           FROM lifecycle_event_deliveries WHERE event_id = ? AND handler_id = ?`,
        )
        .get(replaceEventId, replaceHandlerId),
    ).toEqual(originalDelivery);

    expect(() =>
      db
        .prepare(
          `INSERT INTO lifecycle_event_deliveries (
            event_id, handler_id, persona, priority, handler_identity, failure_policy,
            status, attempts, max_attempts, completed_at, created_at, updated_at
          ) VALUES (?, 'forged-terminal-handler', 'support', 0, ?, ?,
            'completed', 0, 1, 12, 12, 12)`,
        )
        .run(replaceEventId, identityFor('forged-terminal-handler'), failurePolicy),
    ).toThrow();
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM lifecycle_event_deliveries
           WHERE event_id = ? AND handler_id = 'forged-terminal-handler'`,
        )
        .get(replaceEventId),
    ).toEqual({ count: 0 });
  });
});
