/**
 * Unit tests for DbQueryHandler.
 *
 * Tests cover:
 *   - Successful SELECT queries with scoping
 *   - Table whitelist enforcement
 *   - Complex SQL rejection (UNION, subqueries, CTEs)
 *   - Thread/persona scoping auto-injection
 *   - SQL safety (DML/DDL rejection, comment injection)
 *   - Adversarial / prompt-injection attempts
 *   - Arg validation and database errors
 */

import { describe, it, expect, vi } from 'vitest';
import { DbQueryHandler, extractTableNames } from '../../../../src/tools/host-tools/db-query.js';
import type { DbQueryArgs } from '../../../../src/tools/host-tools/db-query.js';
import type { ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import type Database from 'better-sqlite3';
import BetterSqlite from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as import('pino').Logger;
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: 'run-001',
    threadId: 'thread-001',
    personaId: 'persona-001',
    requestId: 'req-001',
    ...overrides,
  };
}

function makeArgs(overrides: Partial<DbQueryArgs> = {}): DbQueryArgs {
  return {
    sql: 'SELECT * FROM memory_items',
    ...overrides,
  };
}

function makeStatement(rows: Record<string, unknown>[]): Database.Statement {
  return {
    all: vi.fn().mockReturnValue(rows),
  } as unknown as Database.Statement;
}

function makeDb(statement?: Database.Statement): Database.Database {
  return {
    prepare: vi.fn().mockReturnValue(statement ?? makeStatement([])),
  } as unknown as Database.Database;
}

// ---------------------------------------------------------------------------
// extractTableNames
// ---------------------------------------------------------------------------

describe('extractTableNames', () => {
  it('extracts single table from simple SELECT', () => {
    expect(extractTableNames('SELECT * FROM memory_items')).toEqual(['memory_items']);
  });

  it('extracts multiple tables from comma-separated FROM', () => {
    const tables = extractTableNames('SELECT * FROM memory_items, messages');
    expect(tables).toContain('memory_items');
    expect(tables).toContain('messages');
  });

  it('extracts JOIN table', () => {
    const tables = extractTableNames(
      'SELECT * FROM memory_items JOIN threads ON memory_items.thread_id = threads.id',
    );
    expect(tables).toContain('memory_items');
    expect(tables).toContain('threads');
  });

  it('handles case-insensitive keywords', () => {
    expect(extractTableNames('select * from Memory_Items')).toEqual(['memory_items']);
  });

  it('returns empty for no FROM clause', () => {
    expect(extractTableNames('SELECT 1')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe('DbQueryHandler — manifest', () => {
  it('has the correct tool name', () => {
    expect(DbQueryHandler.manifest.name).toBe('db.query');
  });

  it('has executionLocation set to host', () => {
    expect(DbQueryHandler.manifest.executionLocation).toBe('host');
  });

  it('declares db.read:own capability', () => {
    expect(DbQueryHandler.manifest.capabilities).toContain('db.read:own');
  });
});

// ---------------------------------------------------------------------------
// Happy paths — allowed tables with scoping
// ---------------------------------------------------------------------------

describe('DbQueryHandler — happy paths', () => {
  it('queries memory_items with auto-injected thread_id scoping', async () => {
    const db = makeDb(makeStatement([{ id: '1', content: 'hello' }]));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: 'SELECT * FROM memory_items' }),
      makeContext({ threadId: 'thread-abc' }),
    );

    expect(result.status).toBe('success');
    // Verify scoping was injected
    const prepareCall = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prepareCall).toContain('thread_id = ?');
    // Verify thread_id param was passed
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.all).toHaveBeenCalledWith('thread-abc');
  });

  it('queries schedules with both thread_id and persona_id scoping', async () => {
    const db = makeDb(makeStatement([]));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    await handler.execute(
      makeArgs({ sql: 'SELECT * FROM schedules' }),
      makeContext({ threadId: 'thread-abc', personaId: 'persona-xyz' }),
    );

    const prepareCall = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prepareCall).toContain('thread_id = ?');
    expect(prepareCall).toContain('persona_id = ?');
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.all).toHaveBeenCalledWith('thread-abc', 'persona-xyz');
  });

  it('preserves existing WHERE clause and adds scoping with AND', async () => {
    const db = makeDb(makeStatement([]));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    await handler.execute(
      makeArgs({ sql: "SELECT * FROM memory_items WHERE type = 'note'" }),
      makeContext({ threadId: 'thread-abc' }),
    );

    const prepareCall = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prepareCall).toContain('thread_id = ?');
    expect(prepareCall).toContain("type = 'note'");
  });

  it('queries threads table scoped by id = threadId', async () => {
    const db = makeDb(makeStatement([{ id: 't1' }]));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: 'SELECT * FROM threads' }),
      makeContext({ threadId: 'thread-abc' }),
    );

    expect(result.status).toBe('success');
    const prepareCall = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prepareCall).toContain('id = ?');
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.all).toHaveBeenCalledWith('thread-abc');
  });

  it('passes user params after scoping params', async () => {
    const stmt = makeStatement([]);
    const db = makeDb(stmt);
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    await handler.execute(
      makeArgs({ sql: 'SELECT * FROM memory_items WHERE type = ?', params: ['note'] }),
      makeContext({ threadId: 'thread-abc' }),
    );

    // scoping param first, then user param
    expect(stmt.all).toHaveBeenCalledWith('thread-abc', 'note');
  });

  it('returns columns, rows, and rowCount', async () => {
    const rows = [
      { id: '1', content: 'hello' },
      { id: '2', content: 'world' },
    ];
    const db = makeDb(makeStatement(rows));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('success');
    expect(result.result).toEqual({
      columns: ['id', 'content'],
      rows: [
        ['1', 'hello'],
        ['2', 'world'],
      ],
      rowCount: 2,
    });
  });

  it('applies default limit of 100', async () => {
    const db = makeDb(makeStatement([]));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    await handler.execute(makeArgs(), makeContext());

    const prepareCall = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prepareCall).toMatch(/LIMIT 100$/);
  });

  it('clamps limit to MAX_LIMIT of 1000', async () => {
    const db = makeDb(makeStatement([]));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    await handler.execute(makeArgs({ limit: 9999 }), makeContext());

    const prepareCall = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prepareCall).toMatch(/LIMIT 1000$/);
  });

  it('injects scoping before ORDER BY', async () => {
    const db = makeDb(makeStatement([]));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    await handler.execute(
      makeArgs({ sql: 'SELECT * FROM memory_items ORDER BY created_at DESC' }),
      makeContext({ threadId: 'thread-abc' }),
    );

    const prepareCall = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prepareCall).toContain('WHERE thread_id = ?');
    expect(prepareCall).toContain('ORDER BY created_at DESC');
    // WHERE should come before ORDER BY
    const whereIdx = prepareCall.indexOf('WHERE');
    const orderIdx = prepareCall.indexOf('ORDER BY');
    expect(whereIdx).toBeLessThan(orderIdx);
  });
});

// ---------------------------------------------------------------------------
// Table whitelist enforcement
// ---------------------------------------------------------------------------

describe('DbQueryHandler — blocked tables', () => {
  const blockedTables = [
    'personas',
    'channels',
    'runs',
    'audit_log',
    'bindings',
    'queue_items',
    'artifacts',
    'tool_results',
  ];

  for (const table of blockedTables) {
    it(`blocks access to ${table}`, async () => {
      const db = makeDb();
      const handler = new DbQueryHandler({ db, logger: makeLogger() });

      const result = await handler.execute(
        makeArgs({ sql: `SELECT * FROM ${table}` }),
        makeContext(),
      );

      expect(result.status).toBe('error');
      expect(result.error).toContain('not accessible');
      expect(result.error).toContain(table);
      // DB should never be called
      expect(db.prepare).not.toHaveBeenCalled();
    });
  }

  it('blocks JOIN to a restricted table', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({
        sql: 'SELECT * FROM memory_items JOIN personas ON memory_items.id = personas.id',
      }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('personas');
    expect(result.error).toContain('not accessible');
  });
});

// ---------------------------------------------------------------------------
// Complex SQL rejection
// ---------------------------------------------------------------------------

describe('DbQueryHandler — complex SQL rejection', () => {
  it('rejects UNION', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: 'SELECT * FROM memory_items UNION SELECT * FROM personas' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('complex SQL');
  });

  it('rejects UNION ALL', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: 'SELECT * FROM memory_items UNION ALL SELECT * FROM personas' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('complex SQL');
  });

  it('rejects subqueries', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: 'SELECT * FROM memory_items WHERE id IN (SELECT id FROM personas)' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('complex SQL');
  });

  it('rejects CTEs', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: 'WITH x AS (SELECT * FROM personas) SELECT * FROM x' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
  });

  it('rejects EXCEPT', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: 'SELECT * FROM memory_items EXCEPT SELECT * FROM memory_items WHERE 1=0' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('complex SQL');
  });

  it('rejects INTERSECT', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: 'SELECT * FROM memory_items INTERSECT SELECT * FROM memory_items' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('complex SQL');
  });
});

// ---------------------------------------------------------------------------
// SQL safety — DML/DDL rejection
// ---------------------------------------------------------------------------

describe('DbQueryHandler — SQL safety', () => {
  const forbiddenStatements = [
    { desc: 'INSERT', sql: 'INSERT INTO memory_items VALUES (1)' },
    { desc: 'UPDATE', sql: 'UPDATE memory_items SET content = "hacked"' },
    { desc: 'DELETE', sql: 'DELETE FROM memory_items WHERE 1=1' },
    { desc: 'DROP', sql: 'DROP TABLE memory_items' },
    { desc: 'CREATE', sql: 'CREATE TABLE evil (id TEXT)' },
    { desc: 'ALTER', sql: 'ALTER TABLE memory_items ADD COLUMN secret TEXT' },
    { desc: 'ATTACH', sql: 'ATTACH DATABASE "/etc/passwd" AS pw' },
    { desc: 'PRAGMA', sql: 'PRAGMA wal_checkpoint' },
    { desc: 'TRUNCATE', sql: 'TRUNCATE TABLE memory_items' },
    { desc: 'BEGIN', sql: 'BEGIN TRANSACTION' },
    { desc: 'COMMIT', sql: 'COMMIT' },
    { desc: 'ROLLBACK', sql: 'ROLLBACK' },
  ];

  for (const { desc, sql } of forbiddenStatements) {
    it(`rejects ${desc} statement`, async () => {
      const db = makeDb();
      const handler = new DbQueryHandler({ db, logger: makeLogger() });

      const result = await handler.execute(makeArgs({ sql }), makeContext());

      expect(result.status).toBe('error');
      expect(result.error).toMatch(/only SELECT statements are allowed/i);
    });
  }

  it('rejects block-comment injection to bypass safety check', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: '/* SELECT * FROM t */ DROP TABLE t' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
  });

  it('rejects line-comment injection to bypass safety check', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: '-- SELECT * FROM t\nDELETE FROM t' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
  });

  it('rejects EXPLAIN', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ sql: 'EXPLAIN SELECT 1' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/must begin with SELECT/);
  });
});

// ---------------------------------------------------------------------------
// Adversarial / prompt injection attempts
// ---------------------------------------------------------------------------

describe('DbQueryHandler — adversarial', () => {
  it('blocks reading all personas via direct query', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: 'SELECT * FROM personas' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('not accessible');
  });

  it('blocks reading channels config', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: 'SELECT * FROM channels' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('not accessible');
  });

  it('blocks subquery to bypass table whitelist', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: 'SELECT * FROM memory_items WHERE id IN (SELECT id FROM personas)' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('complex SQL');
  });

  it('blocks UNION to exfiltrate from blocked table', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: 'SELECT id, content FROM memory_items UNION SELECT id, name FROM personas' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
  });

  it('blocks CTE to bypass table whitelist', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: 'WITH leaked AS (SELECT * FROM audit_log) SELECT * FROM leaked' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
  });

  it('blocks reading other threads data (scoping enforcement)', async () => {
    const db = makeDb(makeStatement([]));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    await handler.execute(
      makeArgs({ sql: 'SELECT * FROM memory_items' }),
      makeContext({ threadId: 'my-thread' }),
    );

    // The prepared SQL must contain the scoping clause
    const prepareCall = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prepareCall).toContain('thread_id = ?');
    // And the param must be our thread
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.all).toHaveBeenCalledWith('my-thread');
  });

  it('blocks comment-hidden table access', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: 'SELECT * FROM /* memory_items */ personas' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('not accessible');
  });

  it('prevents OR-based scoping bypass', async () => {
    const db = makeDb(makeStatement([]));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    await handler.execute(
      makeArgs({ sql: "SELECT * FROM memory_items WHERE type = 'a' OR 1=1" }),
      makeContext({ threadId: 'my-thread' }),
    );

    // The user's conditions must be wrapped in parens to prevent OR bypass:
    // WHERE thread_id = ? AND (type = 'a' OR 1=1)  ← correct
    // WHERE thread_id = ? AND type = 'a' OR 1=1     ← wrong (bypasses scoping)
    const prepareCall = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prepareCall).toContain("AND (type = 'a' OR 1=1)");
  });

  it('blocks WITH RECURSIVE', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: 'WITH RECURSIVE cte AS (SELECT 1) SELECT * FROM cte' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
  });

  it('rejects query with no identifiable table', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ sql: 'SELECT 1' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toContain('could not identify any table');
  });
});

// ---------------------------------------------------------------------------
// Arg validation
// ---------------------------------------------------------------------------

describe('DbQueryHandler — arg validation', () => {
  it('returns error when sql is empty', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ sql: '' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/sql is required/);
  });

  it('returns error when sql is whitespace only', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ sql: '   ' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/sql is required/);
  });

  it('returns error when params is not an array', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({
        sql: 'SELECT * FROM memory_items',
        params: 'not-an-array' as unknown as unknown[],
      }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/params must be an array/);
  });
});

// ---------------------------------------------------------------------------
// Database execution errors
// ---------------------------------------------------------------------------

describe('DbQueryHandler — database errors', () => {
  it('returns error when prepare throws', async () => {
    const db = {
      prepare: vi.fn().mockImplementation(() => {
        throw new Error('syntax error near "FROM"');
      }),
    } as unknown as Database.Database;
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/query execution failed/);
  });

  it('returns error when statement.all throws', async () => {
    const stmt = {
      all: vi.fn().mockImplementation(() => {
        throw new Error('table not found');
      }),
    } as unknown as Database.Statement;
    const db = makeDb(stmt);
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/query execution failed/);
  });
});

describe('DbQueryHandler — hidden tables (real SQLite)', () => {
  function realDb(): Database.Database {
    const db = new BetterSqlite(':memory:');
    db.exec(`
      CREATE TABLE messages (id TEXT, thread_id TEXT, body TEXT);
      CREATE TABLE memory_items (id TEXT, thread_id TEXT);
      CREATE TABLE schedules (id TEXT, thread_id TEXT, persona_id TEXT);
      CREATE TABLE threads (id TEXT);
      CREATE TABLE script_approvals (code_hash TEXT);
      INSERT INTO messages VALUES ('m1', 'thread-001', 'hi');
      INSERT INTO script_approvals VALUES ('SECRETHASH');
    `);
    return db;
  }

  const refused = [
    'SELECT code_hash FROM messages m, script_approvals',
    'SELECT a.code_hash FROM messages m JOIN "script_approvals" a ON 1=1',
    'SELECT code_hash FROM messages, "script_approvals"',
    'SELECT 1 FROM messages m, (script_approvals)',
    'SELECT code_hash FROM messages, `script_approvals`',
    'SELECT code_hash FROM messages, [script_approvals]',
    'SELECT 1 FROM messages m, (`script_approvals`)',
    'SELECT name FROM messages, sqlite_schema',
  ];

  it.each(refused)('refuses %s', async (sql) => {
    const handler = new DbQueryHandler({ db: realDb(), logger: makeLogger() });
    const result = await handler.execute({ sql }, makeContext());
    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).not.toContain('SECRETHASH');
  });

  it('refuses at the EXPLAIN layer when the regex layer is blind', async () => {
    const handler = new DbQueryHandler({ db: realDb(), logger: makeLogger() });
    const result = await handler.execute(
      { sql: 'SELECT code_hash FROM messages m, (script_approvals)' },
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/script_approvals|not accessible/);
  });

  it('still answers an aliased query with a schema prefix', async () => {
    const handler = new DbQueryHandler({ db: realDb(), logger: makeLogger() });
    const result = await handler.execute(
      { sql: 'SELECT m.id FROM main.messages m' },
      makeContext(),
    );
    expect(result.status).toBe('success');
  });

  it('answers a plain query of one allowed table', async () => {
    const handler = new DbQueryHandler({ db: realDb(), logger: makeLogger() });
    const result = await handler.execute(
      { sql: "SELECT id FROM messages WHERE body = 'hi'" },
      makeContext(),
    );
    expect(result.status).toBe('success');
    expect((result.result as { rowCount: number }).rowCount).toBe(1);
  });

  it('refuses when EXPLAIN throws', async () => {
    const db = {
      prepare: vi.fn().mockImplementation((s: string) => {
        if (s.startsWith('EXPLAIN')) throw new Error('boom');
        return makeStatement([]);
      }),
    } as unknown as Database.Database;
    const result = await new DbQueryHandler({ db, logger: makeLogger() }).execute(
      makeArgs(),
      makeContext(),
    );
    expect(result.status).toBe('error');
  });
});
