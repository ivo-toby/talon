/**
 * Repository for the `runs` table.
 *
 * A run represents one agent execution: it tracks which sandbox was used,
 * the SDK session, token consumption, cost, and final status.
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';

/** Valid run status values. */
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Row shape returned by token aggregation queries. */
export interface TokenAggregateRow {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_cost_usd: number;
  run_count: number;
}

/** Row shape matching the `runs` table exactly. */
export interface RunRow {
  id: string;
  thread_id: string;
  persona_id: string;
  provider_name: string;
  sandbox_id: string | null;
  session_id: string | null;
  status: RunStatus;
  parent_run_id: string | null;
  queue_item_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  error: string | null;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

/** Fields accepted when inserting a new run. */
export type InsertRunInput = Omit<RunRow, 'created_at'>;

/** Token usage and cost fields that can be updated. */
export interface UpdateTokensInput {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd?: number;
}

/** Repository for reading and writing run records. */
export class RunRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly findByThreadStmt: Database.Statement;
  private readonly findByParentStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO runs
        (id, thread_id, persona_id, provider_name, sandbox_id, session_id, status,
         parent_run_id, queue_item_id, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, error,
         started_at, ended_at, created_at)
      VALUES
        (@id, @thread_id, @persona_id, @provider_name, @sandbox_id, @session_id, @status,
         @parent_run_id, @queue_item_id, @input_tokens, @output_tokens,
         @cache_read_tokens, @cache_write_tokens, @cost_usd, @error,
         @started_at, @ended_at, @created_at)
    `);

    this.findByIdStmt = db.prepare(`SELECT * FROM runs WHERE id = ?`);

    this.findByThreadStmt = db.prepare(`
      SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at DESC
    `);

    this.findByParentStmt = db.prepare(`
      SELECT * FROM runs WHERE parent_run_id = ? ORDER BY created_at ASC
    `);
  }

  /** Inserts a new run row. */
  insert(input: InsertRunInput): Result<RunRow, DbError> {
    try {
      const row: RunRow = { ...input, created_at: this.now() };
      this.insertStmt.run(row);
      return ok(row);
    } catch (cause) {
      return err(new DbError(`Failed to insert run: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Finds a run by its primary key. */
  findById(id: string): Result<RunRow | null, DbError> {
    try {
      const row = this.findByIdStmt.get(id) as RunRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to find run by id: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns all runs for a thread in descending chronological order. */
  findByThread(threadId: string): Result<RunRow[], DbError> {
    try {
      const rows = this.findByThreadStmt.all(threadId) as RunRow[];
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find runs by thread: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns all child runs spawned by the given parent run. */
  findByParent(parentRunId: string): Result<RunRow[], DbError> {
    try {
      const rows = this.findByParentStmt.all(parentRunId) as RunRow[];
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find child runs: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Updates the status (and optional started_at / ended_at) of a run. */
  updateStatus(
    id: string,
    status: RunStatus,
    timestamps?: { started_at?: number; ended_at?: number; error?: string },
  ): Result<RunRow | null, DbError> {
    try {
      const stmt = this.db.prepare(`
        UPDATE runs
        SET status = @status,
            started_at = COALESCE(@started_at, started_at),
            ended_at   = COALESCE(@ended_at,   ended_at),
            error      = COALESCE(@error,       error)
        WHERE id = @id
      `);
      stmt.run({
        id,
        status,
        started_at: timestamps?.started_at ?? null,
        ended_at: timestamps?.ended_at ?? null,
        error: timestamps?.error ?? null,
      });
      return this.findById(id);
    } catch (cause) {
      return err(new DbError(`Failed to update run status: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Updates the session_id of a run (used to persist Agent SDK session for resumption). */
  updateSessionId(id: string, sessionId: string): Result<void, DbError> {
    try {
      const stmt = this.db.prepare(`UPDATE runs SET session_id = @sessionId WHERE id = @id`);
      stmt.run({ id, sessionId });
      return ok(undefined);
    } catch (cause) {
      return err(new DbError(`Failed to update run session_id: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns the most recent session_id for a thread from completed runs. */
  getLatestSessionId(threadId: string): Result<string | null, DbError> {
    try {
      const stmt = this.db.prepare(`
        SELECT session_id FROM runs
        WHERE thread_id = ? AND session_id IS NOT NULL AND status = 'completed'
        ORDER BY created_at DESC LIMIT 1
      `);
      const row = stmt.get(threadId) as { session_id: string } | undefined;
      return ok(row?.session_id ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to get latest session_id: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns the most recent provider_name for a thread. */
  getLatestProviderName(threadId: string): Result<string | null, DbError> {
    try {
      const stmt = this.db.prepare(`
        SELECT provider_name FROM runs
        WHERE thread_id = ? AND provider_name IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
      `);
      const row = stmt.get(threadId) as { provider_name: string } | undefined;
      return ok(row?.provider_name ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to get latest provider_name: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  // ---------------------------------------------------------------------------
  // Aggregation queries
  // ---------------------------------------------------------------------------

  /**
   * Returns aggregate token usage for all completed runs belonging to a persona.
   *
   * @param personaId - Persona primary key.
   * @param since - Optional lower bound timestamp (Unix epoch ms, inclusive).
   * @param until - Optional upper bound timestamp (Unix epoch ms, inclusive).
   */
  aggregateByPersona(personaId: string, since?: number, until?: number): Result<TokenAggregateRow, DbError> {
    return this._aggregate({ personaId, since, until });
  }

  /**
   * Returns aggregate token usage for all completed runs in a thread.
   *
   * @param threadId - Thread primary key.
   * @param since - Optional lower bound timestamp (Unix epoch ms, inclusive).
   * @param until - Optional upper bound timestamp (Unix epoch ms, inclusive).
   */
  aggregateByThread(threadId: string, since?: number, until?: number): Result<TokenAggregateRow, DbError> {
    return this._aggregate({ threadId, since, until });
  }

  /**
   * Returns aggregate token usage for all completed runs in a time period
   * across all personas and threads.
   *
   * @param since - Lower bound timestamp (Unix epoch ms, inclusive).
   * @param until - Optional upper bound timestamp (Unix epoch ms, inclusive). Defaults to now.
   */
  aggregateByPeriod(since: number, until?: number): Result<TokenAggregateRow, DbError> {
    return this._aggregate({ since, until });
  }

  /**
   * Internal helper that builds and executes an aggregation query with
   * optional persona/thread/time filters.
   */
  private _aggregate(filters: {
    personaId?: string;
    threadId?: string;
    since?: number;
    until?: number;
  }): Result<TokenAggregateRow, DbError> {
    try {
      const conditions: string[] = [`status IN ('completed', 'running')`];
      const params: (string | number)[] = [];

      if (filters.personaId !== undefined) {
        conditions.push('persona_id = ?');
        params.push(filters.personaId);
      }

      if (filters.threadId !== undefined) {
        conditions.push('thread_id = ?');
        params.push(filters.threadId);
      }

      if (filters.since !== undefined) {
        conditions.push('created_at >= ?');
        params.push(filters.since);
      }

      if (filters.until !== undefined) {
        conditions.push('created_at <= ?');
        params.push(filters.until);
      }

      const where = conditions.join(' AND ');
      const sql = `
        SELECT
          COALESCE(SUM(input_tokens),       0) AS total_input_tokens,
          COALESCE(SUM(output_tokens),      0) AS total_output_tokens,
          COALESCE(SUM(cache_read_tokens),  0) AS total_cache_read_tokens,
          COALESCE(SUM(cache_write_tokens), 0) AS total_cache_write_tokens,
          COALESCE(SUM(cost_usd),           0) AS total_cost_usd,
          COUNT(*)                              AS run_count
        FROM runs
        WHERE ${where}
      `;

      const stmt = this.db.prepare(sql);
      const row = stmt.get(...params) as TokenAggregateRow;
      return ok(row);
    } catch (cause) {
      return err(new DbError(`Failed to aggregate token usage: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Updates token usage and cost figures for a run. */
  updateTokens(id: string, tokens: UpdateTokensInput): Result<RunRow | null, DbError> {
    try {
      const stmt = this.db.prepare(`
        UPDATE runs
        SET input_tokens        = COALESCE(@input_tokens,        input_tokens),
            output_tokens       = COALESCE(@output_tokens,       output_tokens),
            cache_read_tokens   = COALESCE(@cache_read_tokens,   cache_read_tokens),
            cache_write_tokens  = COALESCE(@cache_write_tokens,  cache_write_tokens),
            cost_usd            = COALESCE(@cost_usd,            cost_usd)
        WHERE id = @id
      `);
      stmt.run({
        id,
        input_tokens: tokens.input_tokens ?? null,
        output_tokens: tokens.output_tokens ?? null,
        cache_read_tokens: tokens.cache_read_tokens ?? null,
        cache_write_tokens: tokens.cache_write_tokens ?? null,
        cost_usd: tokens.cost_usd ?? null,
      });
      return this.findById(id);
    } catch (cause) {
      return err(new DbError(`Failed to update run tokens: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }
}
