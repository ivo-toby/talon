/**
 * Repository for the `bindings` table.
 *
 * Bindings map a (channel, thread) pair to a persona. A binding with a null
 * thread_id serves as the default persona for the channel.
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';

/** Row shape matching the `bindings` table exactly. */
export interface BindingRow {
  id: string;
  channel_id: string;
  thread_id: string | null;
  persona_id: string;
  is_default: number;
  created_at: number;
  updated_at: number;
}

/** Fields accepted when inserting a new binding. */
export type InsertBindingInput = Omit<BindingRow, 'created_at' | 'updated_at'>;

/** Repository for reading and writing binding records. */
export class BindingRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByChannelAndThreadStmt: Database.Statement;
  private readonly findDefaultForChannelStmt: Database.Statement;
  private readonly findByPersonaStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly deleteDefaultForChannelStmt: Database.Statement;
  private readonly updatePersonaStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO bindings (id, channel_id, thread_id, persona_id, is_default, created_at, updated_at)
      VALUES (@id, @channel_id, @thread_id, @persona_id, @is_default, @created_at, @updated_at)
    `);

    this.findByChannelAndThreadStmt = db.prepare(`
      SELECT * FROM bindings WHERE channel_id = ? AND thread_id = ?
    `);

    this.findDefaultForChannelStmt = db.prepare(`
      SELECT * FROM bindings WHERE channel_id = ? AND is_default = 1 LIMIT 1
    `);

    this.findByPersonaStmt = db.prepare(`
      SELECT * FROM bindings WHERE persona_id = ?
    `);

    this.deleteStmt = db.prepare(`DELETE FROM bindings WHERE id = ?`);

    this.deleteDefaultForChannelStmt = db.prepare(
      `DELETE FROM bindings WHERE channel_id = ? AND is_default = 1`,
    );

    this.updatePersonaStmt = db.prepare(
      `UPDATE bindings SET persona_id = ?, updated_at = ? WHERE id = ?`,
    );
  }

  /** Inserts a new binding. */
  insert(input: InsertBindingInput): Result<BindingRow, DbError> {
    try {
      const ts = this.now();
      const row: BindingRow = { ...input, created_at: ts, updated_at: ts };
      this.insertStmt.run(row);
      return ok(row);
    } catch (cause) {
      return err(new DbError(`Failed to insert binding: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Finds the binding for a specific (channel, thread) pair. */
  findByChannelAndThread(channelId: string, threadId: string): Result<BindingRow | null, DbError> {
    try {
      const row = this.findByChannelAndThreadStmt.get(channelId, threadId) as BindingRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to find binding by channel+thread: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns the default binding for a channel (is_default = 1). */
  findDefaultForChannel(channelId: string): Result<BindingRow | null, DbError> {
    try {
      const row = this.findDefaultForChannelStmt.get(channelId) as BindingRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to find default binding for channel: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns all bindings that reference the given persona. */
  findByPersona(personaId: string): Result<BindingRow[], DbError> {
    try {
      const rows = this.findByPersonaStmt.all(personaId) as BindingRow[];
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find bindings by persona: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Deletes a binding by id. */
  delete(id: string): Result<void, DbError> {
    try {
      this.deleteStmt.run(id);
      return ok(undefined);
    } catch (cause) {
      return err(new DbError(`Failed to delete binding: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Deletes the default binding for a channel (is_default = 1). */
  deleteDefaultForChannel(channelId: string): Result<void, DbError> {
    try {
      this.deleteDefaultForChannelStmt.run(channelId);
      return ok(undefined);
    } catch (cause) {
      return err(new DbError(`Failed to delete default binding for channel: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Updates the persona_id on an existing binding. */
  updatePersona(bindingId: string, personaId: string): Result<void, DbError> {
    try {
      this.updatePersonaStmt.run(personaId, this.now(), bindingId);
      return ok(undefined);
    } catch (cause) {
      return err(new DbError(`Failed to update binding persona: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }
}
