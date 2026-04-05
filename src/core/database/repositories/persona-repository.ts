/**
 * Repository for the `personas` table.
 *
 * Personas define an agent's identity: model, system prompt, skills,
 * capabilities, and container configuration.
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';

/** Row shape matching the `personas` table exactly. */
export interface PersonaRow {
  id: string;
  name: string;
  model: string;
  system_prompt_file: string | null;
  skills: string;
  capabilities: string;
  max_concurrent: number | null;
  created_at: number;
  updated_at: number;
}

/** Fields accepted when inserting a new persona. */
export type InsertPersonaInput = Omit<PersonaRow, 'created_at' | 'updated_at'>;

/** Fields that may be updated on an existing persona. */
export type UpdatePersonaInput = Partial<
  Pick<
    PersonaRow,
    'name' | 'model' | 'system_prompt_file' | 'skills' | 'capabilities' | 'max_concurrent'
  >
>;

/** Repository for reading and writing persona records. */
export class PersonaRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly findByNameStmt: Database.Statement;
  private readonly findAllStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO personas
        (id, name, model, system_prompt_file, skills, capabilities, max_concurrent, created_at, updated_at)
      VALUES
        (@id, @name, @model, @system_prompt_file, @skills, @capabilities, @max_concurrent, @created_at, @updated_at)
    `);

    this.findByIdStmt = db.prepare(`SELECT * FROM personas WHERE id = ?`);
    this.findByNameStmt = db.prepare(`SELECT * FROM personas WHERE name = ?`);
    this.findAllStmt = db.prepare(`SELECT * FROM personas ORDER BY name ASC`);
    this.deleteStmt = db.prepare(`DELETE FROM personas WHERE id = ?`);
  }

  /** Inserts a new persona row. */
  insert(input: InsertPersonaInput): Result<PersonaRow, DbError> {
    try {
      const ts = this.now();
      const row: PersonaRow = { ...input, created_at: ts, updated_at: ts };
      this.insertStmt.run(row);
      return ok(row);
    } catch (cause) {
      return err(new DbError(`Failed to insert persona: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Finds a persona by its primary key. */
  findById(id: string): Result<PersonaRow | null, DbError> {
    try {
      const row = this.findByIdStmt.get(id) as PersonaRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to find persona by id: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Finds a persona by its unique name. */
  findByName(name: string): Result<PersonaRow | null, DbError> {
    try {
      const row = this.findByNameStmt.get(name) as PersonaRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to find persona by name: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns all personas ordered by name. */
  findAll(): Result<PersonaRow[], DbError> {
    try {
      const rows = this.findAllStmt.all() as PersonaRow[];
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to list personas: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Updates mutable fields on an existing persona. */
  update(id: string, fields: UpdatePersonaInput): Result<PersonaRow | null, DbError> {
    try {
      const setClause = Object.keys(fields)
        .map((k) => `${k} = @${k}`)
        .join(', ');
      if (!setClause) {
        return this.findById(id);
      }
      const stmt = this.db.prepare(
        `UPDATE personas SET ${setClause}, updated_at = @updated_at WHERE id = @id`,
      );
      stmt.run({ ...fields, updated_at: this.now(), id });
      return this.findById(id);
    } catch (cause) {
      return err(new DbError(`Failed to update persona: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Deletes a persona by id (cascades to bindings and schedules). */
  delete(id: string): Result<void, DbError> {
    try {
      this.deleteStmt.run(id);
      return ok(undefined);
    } catch (cause) {
      return err(new DbError(`Failed to delete persona: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }
}
