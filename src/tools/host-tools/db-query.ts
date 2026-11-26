/**
 * Host-side tool: db.query
 *
 * Executes read-only SQL queries against the talond SQLite database on behalf
 * of a persona. Write operations are not exposed through this tool — agents
 * use higher-level domain tools (e.g. memory.access) for mutations.
 *
 * Security layers (defense-in-depth):
 *   1. Regex pre-check — reject non-SELECT, forbidden keywords, complex SQL
 *   2. Table whitelist — only approved tables can be queried
 *   3. Thread/persona scoping — auto-inject WHERE clauses for data isolation
 *   4. Row limit — hard cap on returned rows
 *   5. Read-only connection — uses a separate better-sqlite3 connection opened
 *      with { readonly: true }, so writes are rejected at the SQLite level
 *
 * Gated by `db.read:own` (persona can only query its own data).
 */

import type Database from 'better-sqlite3';
import type pino from 'pino';
import { err, ok, type Result } from 'neverthrow';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import { ToolError } from '../../core/errors/error-types.js';
import type { ToolExecutionContext } from './channel-send.js';

/** Manifest for the db.query host tool. */
export interface DbQueryTool {
  readonly manifest: ToolManifest;
}

/** Arguments accepted by the db.query tool. */
export interface DbQueryArgs {
  /** SQL SELECT statement. Must be a read-only query. */
  sql: string;
  /** Positional or named parameters for the prepared statement. */
  params?: unknown[];
  /** Maximum number of rows to return (default: 100, max: 1 000). */
  limit?: number;
}

/** Default and maximum row limits for db.query results. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

/**
 * Tables the agent is allowed to query. All other tables are blocked.
 * Tables with thread_id or persona_id will be auto-scoped.
 */
const ALLOWED_TABLES: ReadonlyMap<string, { scopeColumn?: string; personaId: boolean }> = new Map([
  ['memory_items', { scopeColumn: 'thread_id', personaId: false }],
  ['schedules', { scopeColumn: 'thread_id', personaId: true }],
  ['messages', { scopeColumn: 'thread_id', personaId: false }],
  ['threads', { scopeColumn: 'id', personaId: false }],
]);

/**
 * SQL safety check: reject any statement that is not a pure SELECT.
 */
const FORBIDDEN_KEYWORDS =
  /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|ATTACH|DETACH|PRAGMA|REPLACE|TRUNCATE|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/**
 * Patterns that indicate complex SQL we don't want to allow.
 * These could be used to bypass table restrictions via subqueries.
 */
const COMPLEX_SQL_PATTERNS = [
  /\bUNION\b/i,
  /\bEXCEPT\b/i,
  /\bINTERSECT\b/i,
  /\bWITH\b\s+/i, // CTEs (also catches WITH RECURSIVE)
  /\(\s*SELECT\b/i, // subqueries
];

/**
 * Extract table names from a simple SELECT statement.
 * Matches FROM and JOIN clauses. Does not handle subqueries or CTEs
 * (those are rejected by COMPLEX_SQL_PATTERNS).
 */
export function extractTableNames(sql: string): string[] {
  const stripped = stripSqlComments(sql);
  const tables = new Set<string>();

  // Match FROM clause table(s) — handles "FROM t1, t2" and "FROM t1"
  // Also handles schema-qualified names like "main.tablename" by extracting
  // the part after the dot.
  const fromMatch = stripped.match(
    /\bFROM\s+([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?(?:\s*,\s*[a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?)*)/i,
  );
  if (fromMatch?.[1]) {
    for (const t of fromMatch[1].split(',')) {
      const raw = t.trim().split(/\s+/)[0];
      if (!raw) continue;
      // Strip schema prefix (e.g. "main.personas" → "personas")
      const name = raw.includes('.') ? raw.split('.').pop()! : raw;
      tables.add(name.toLowerCase());
    }
  }

  // Match JOIN clauses (also handles schema-qualified names)
  const joinRegex = /\bJOIN\s+([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?)/gi;
  let match;
  while ((match = joinRegex.exec(stripped)) !== null) {
    const raw = match[1];
    const name = raw.includes('.') ? raw.split('.').pop()! : raw;
    tables.add(name.toLowerCase());
  }

  return [...tables];
}

/**
 * Handler class for the db.query host tool.
 *
 * Accepts a SQL SELECT statement, validates it through multiple security
 * layers, and executes it against the provided Database instance. Returns
 * column names, rows, and the row count.
 */
export class DbQueryHandler {
  /** Static manifest describing the tool. */
  static readonly manifest: ToolManifest = {
    name: 'db.query',
    description:
      'Executes read-only SQL SELECT queries against the talond SQLite database. Only SELECT statements are permitted. Queries are scoped to the current thread/persona.',
    capabilities: ['db.read:own'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      db: Database.Database;
      logger: pino.Logger;
    },
  ) {}

  /**
   * Execute the db.query tool.
   *
   * @param args    - Validated tool arguments.
   * @param context - Execution context (runId, threadId, personaId).
   * @returns ToolCallResult with status 'success' or 'error'.
   */
  execute(args: DbQueryArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    return Promise.resolve(this.executeSync(args, context));
  }

  /**
   * Run EXPLAIN on the final statement and return the names of the tables whose
   * b-trees it opens. Independent of any SQL parsing in this file.
   */
  private openedTables(sql: string, params: unknown[]): Result<string[], string> {
    const fail = (cause: unknown): Result<string[], string> =>
      err(
        `db.query: query execution failed — ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    try {
      const ops = this.deps.db.prepare(`EXPLAIN ${sql}`).all(...params) as Record<
        string,
        unknown
      >[];
      const pages = new Set<number>();
      for (const op of ops) {
        if (op.opcode !== 'OpenRead' && op.opcode !== 'OpenWrite' && op.opcode !== 'ReopenIdx') {
          continue;
        }
        if (op.p3 !== 0) {
          return err('db.query: table "unknown" is not accessible');
        }
        if (typeof op.p2 === 'number') pages.add(op.p2);
      }
      if (pages.has(1)) {
        return err('db.query: table "sqlite_schema" is not accessible');
      }
      if (pages.size === 0) return ok([]);
      const schema = this.deps.db
        .prepare('SELECT name, tbl_name, rootpage FROM sqlite_schema')
        .all() as { tbl_name: string; rootpage: number }[];
      const names = new Set<string>();
      for (const page of pages) {
        const row = schema.find((r) => r.rootpage === page);
        if (!row) return err('db.query: table "unknown" is not accessible');
        names.add(row.tbl_name.toLowerCase());
      }
      return ok([...names]);
    } catch (cause) {
      return fail(cause);
    }
  }

  /** Synchronous implementation — wrapped by execute() to satisfy the async tool interface. */
  private executeSync(args: DbQueryArgs, context: ToolExecutionContext): ToolCallResult {
    const requestId = context.requestId ?? 'unknown';
    const { sql, params, limit } = args;

    this.deps.logger.info(
      { requestId, runId: context.runId, personaId: context.personaId },
      'db.query: executing',
    );

    // Validate sql argument
    if (!sql || typeof sql !== 'string' || sql.trim() === '') {
      const error = new ToolError('db.query: sql is required and must be a non-empty string');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'db.query', status: 'error', error: error.message };
    }

    // Strip inline comments (--) and block comments (/* */) for safety check.
    const strippedSql = stripSqlComments(sql.trim());

    // --- Layer 1: Regex pre-check ---

    // Enforce SELECT-only rule
    if (FORBIDDEN_KEYWORDS.test(strippedSql)) {
      const error = new ToolError(
        'db.query: only SELECT statements are allowed. INSERT, UPDATE, DELETE, DROP, and other write operations are forbidden',
      );
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'db.query', status: 'error', error: error.message };
    }

    if (!strippedSql.match(/^\s*SELECT\b/i)) {
      const error = new ToolError(
        'db.query: statement must begin with SELECT. Only read-only queries are allowed',
      );
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'db.query', status: 'error', error: error.message };
    }

    // Reject complex SQL patterns (subqueries, UNION, CTEs)
    for (const pattern of COMPLEX_SQL_PATTERNS) {
      if (pattern.test(strippedSql)) {
        const error = new ToolError(
          'db.query: complex SQL (UNION, subqueries, CTEs) is not allowed. Use simple SELECT queries only',
        );
        this.deps.logger.warn({ requestId, sql: strippedSql }, error.message);
        return { requestId, tool: 'db.query', status: 'error', error: error.message };
      }
    }

    // Quoted identifiers hide table names from the regex layer.
    if (/["`[]/.test(stripSingleQuotedLiterals(strippedSql))) {
      const error = new ToolError('db.query: quoted identifiers are not supported');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'db.query', status: 'error', error: error.message };
    }

    // --- Layer 2: Table whitelist ---

    const tables = extractTableNames(strippedSql);
    if (tables.length === 0) {
      const error = new ToolError('db.query: could not identify any table in the query');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'db.query', status: 'error', error: error.message };
    }

    for (const table of tables) {
      if (!ALLOWED_TABLES.has(table)) {
        const error = new ToolError(
          `db.query: table "${table}" is not accessible. Allowed tables: ${[...ALLOWED_TABLES.keys()].join(', ')}`,
        );
        this.deps.logger.warn({ requestId, table }, error.message);
        return { requestId, tool: 'db.query', status: 'error', error: error.message };
      }
    }

    // --- Layer 3: Auto-inject thread/persona scoping ---

    const scopingClauses: string[] = [];
    const scopingParams: unknown[] = [];

    for (const table of tables) {
      const scoping = ALLOWED_TABLES.get(table);
      if (!scoping) continue;
      // Use unqualified column names to support table aliases (e.g. "FROM memory_items m").
      // Safe because the allowed tables don't share ambiguous column names.
      if (scoping.scopeColumn && context.threadId) {
        scopingClauses.push(`${scoping.scopeColumn} = ?`);
        scopingParams.push(context.threadId);
      }
      if (scoping.personaId && context.personaId) {
        scopingClauses.push(`persona_id = ?`);
        scopingParams.push(context.personaId);
      }
    }

    // --- Layer 4: Row limit ---

    const rowLimit = Math.min(
      typeof limit === 'number' && limit > 0 ? limit : DEFAULT_LIMIT,
      MAX_LIMIT,
    );

    // Validate params type
    if (params !== undefined && !Array.isArray(params)) {
      const error = new ToolError('db.query: params must be an array if provided');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'db.query', status: 'error', error: error.message };
    }

    // Build the final SQL: inject scoping WHERE clause and LIMIT.
    // Use strippedSql (comments removed) to prevent comment-based injection
    // that could confuse WHERE/ORDER BY keyword detection during injection.
    let finalSql = strippedSql;

    if (scopingClauses.length > 0) {
      const scopingWhere = scopingClauses.join(' AND ');
      // Inject scoping WHERE clause. The user's original conditions are wrapped
      // in parentheses to prevent OR-based precedence bypasses like:
      //   WHERE thread_id = ? AND type = 'a' OR 1=1
      // which would parse as (thread_id = ? AND type = 'a') OR 1=1.
      if (/\bWHERE\b/i.test(finalSql)) {
        // Wrap user's WHERE conditions in parens: WHERE scope AND (original)
        // Find the end of the WHERE clause (before GROUP BY, HAVING, ORDER BY, LIMIT)
        const whereMatch = finalSql.match(/\bWHERE\b/i);
        const whereIdx = whereMatch?.index ?? 0;
        const afterWhere = whereIdx + 5; // length of "WHERE"
        const rest = finalSql.slice(afterWhere);
        const endOfConditions = rest.search(/\b(GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT)\b/i);
        if (endOfConditions === -1) {
          // No trailing clause — wrap everything after WHERE
          finalSql = `${finalSql.slice(0, whereIdx)}WHERE ${scopingWhere} AND (${rest.trim()})`;
        } else {
          const conditions = rest.slice(0, endOfConditions).trim();
          const trailing = rest.slice(endOfConditions);
          finalSql = `${finalSql.slice(0, whereIdx)}WHERE ${scopingWhere} AND (${conditions}) ${trailing}`;
        }
      } else {
        // No existing WHERE — find insertion point before trailing clauses
        const insertBefore = finalSql.search(/\b(GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT)\b/i);
        if (insertBefore === -1) {
          finalSql = `${finalSql} WHERE ${scopingWhere}`;
        } else {
          finalSql = `${finalSql.slice(0, insertBefore)} WHERE ${scopingWhere} ${finalSql.slice(insertBefore)}`;
        }
      }
    }

    // Wrap in subquery with LIMIT for safe row capping
    const limitedSql = `SELECT * FROM (${finalSql}) LIMIT ${rowLimit}`;

    // Combine scoping params with user params
    const allParams = [...scopingParams, ...(params ?? [])];

    // --- Layer 5: ask SQLite which tables the final statement opens ---
    const opened = this.openedTables(limitedSql, allParams);
    if (opened.isErr()) {
      this.deps.logger.warn({ requestId }, opened.error);
      return { requestId, tool: 'db.query', status: 'error', error: opened.error };
    }
    for (const table of opened.value) {
      if (!ALLOWED_TABLES.has(table) || !tables.includes(table)) {
        const error = new ToolError(
          `db.query: table "${table}" is not accessible. Allowed tables: ${[...ALLOWED_TABLES.keys()].join(', ')}`,
        );
        this.deps.logger.warn({ requestId, table }, error.message);
        return { requestId, tool: 'db.query', status: 'error', error: error.message };
      }
    }

    try {
      const stmt = this.deps.db.prepare(limitedSql);
      const rawRows = stmt.all(...allParams);

      // Extract column names from the first row.
      const columns: string[] =
        rawRows.length > 0 ? Object.keys(rawRows[0] as Record<string, unknown>) : [];

      // Convert rows to arrays for a compact wire format.
      const rows = (rawRows as Record<string, unknown>[]).map((row) =>
        columns.map((col) => row[col] ?? null),
      );

      this.deps.logger.info(
        { requestId, rowCount: rows.length, tables },
        'db.query: query completed',
      );

      return {
        requestId,
        tool: 'db.query',
        status: 'success',
        result: {
          columns,
          rows,
          rowCount: rows.length,
        },
      };
    } catch (cause) {
      const msg = `db.query: query execution failed — ${cause instanceof Error ? cause.message : String(cause)}`;
      this.deps.logger.error({ requestId, err: cause }, msg);
      return { requestId, tool: 'db.query', status: 'error', error: msg };
    }
  }
}

/**
 * Strip SQL line comments (-- ...) and block comments from a SQL string.
 * Used to prevent comment-injection bypass of the keyword check.
 */
function stripSqlComments(sql: string): string {
  // Remove block comments first (/* ... */)
  let result = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Remove line comments (-- ...)
  result = result.replace(/--[^\n]*/g, ' ');
  return result.trim();
}

/** Replace every single-quoted string literal (with '' escapes) by a blank. */
function stripSingleQuotedLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, ' ');
}
