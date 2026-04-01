/**
 * Repository for the `threads` table.
 *
 * Threads represent a conversation context within a channel. Each thread
 * has a channel-assigned external identifier (e.g. Telegram chat_id).
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';

/** Row shape matching the `threads` table exactly. */
export interface ThreadRow {
  id: string;
  channel_id: string;
  external_id: string;
  metadata: string;
  created_at: number;
  updated_at: number;
}

/** Fields accepted when inserting a new thread. */
export type InsertThreadInput = Omit<ThreadRow, 'created_at' | 'updated_at'>;

/** Fields that may be updated on an existing thread. */
export type UpdateThreadInput = Partial<Pick<ThreadRow, 'metadata'>>;

/** Repository for reading and writing thread records. */
export class ThreadRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly findByExternalIdStmt: Database.Statement;
  private readonly findByChannelIdStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO threads (id, channel_id, external_id, metadata, created_at, updated_at)
      VALUES (@id, @channel_id, @external_id, @metadata, @created_at, @updated_at)
    `);

    this.findByIdStmt = db.prepare(`SELECT * FROM threads WHERE id = ?`);

    this.findByExternalIdStmt = db.prepare(`
      SELECT * FROM threads WHERE channel_id = ? AND external_id = ?
    `);

    this.findByChannelIdStmt = db.prepare(`
      SELECT * FROM threads WHERE channel_id = ? ORDER BY updated_at DESC, created_at DESC
    `);
  }

  /** Inserts a new thread row. */
  insert(input: InsertThreadInput): Result<ThreadRow, DbError> {
    try {
      const ts = this.now();
      const row: ThreadRow = { ...input, created_at: ts, updated_at: ts };
      this.insertStmt.run(row);
      return ok(row);
    } catch (cause) {
      return err(new DbError(`Failed to insert thread: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Finds a thread by its primary key. */
  findById(id: string): Result<ThreadRow | null, DbError> {
    try {
      const row = this.findByIdStmt.get(id) as ThreadRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to find thread by id: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Finds a thread by its channel and channel-specific external identifier. */
  findByExternalId(channelId: string, externalId: string): Result<ThreadRow | null, DbError> {
    try {
      const row = this.findByExternalIdStmt.get(channelId, externalId) as ThreadRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to find thread by external id: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns all threads for a channel in descending update order. */
  findByChannelId(channelId: string): Result<ThreadRow[], DbError> {
    try {
      const rows = this.findByChannelIdStmt.all(channelId) as ThreadRow[];
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find threads by channel id: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Updates mutable fields on an existing thread. */
  update(id: string, fields: UpdateThreadInput): Result<ThreadRow | null, DbError> {
    try {
      const setClause = Object.keys(fields)
        .map((k) => `${k} = @${k}`)
        .join(', ');
      if (!setClause) {
        return this.findById(id);
      }
      const stmt = this.db.prepare(
        `UPDATE threads SET ${setClause}, updated_at = @updated_at WHERE id = @id`,
      );
      stmt.run({ ...fields, updated_at: this.now(), id });
      return this.findById(id);
    } catch (cause) {
      return err(new DbError(`Failed to update thread: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }
}
