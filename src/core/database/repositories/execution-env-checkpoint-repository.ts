import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';
import type {
  CreateExecutionEnvCheckpointInput,
  ExecutionEnvCheckpoint,
} from '../../../execution-env/execution-env-types.js';

interface ExecutionEnvCheckpointRow {
  id: string;
  env_id: string;
  provider: 'sprites';
  remote_ref: string;
  label: string | null;
  status: ExecutionEnvCheckpoint['status'];
  created_at: number;
}

function rowToCheckpoint(row: ExecutionEnvCheckpointRow): ExecutionEnvCheckpoint {
  return {
    id: row.id,
    envId: row.env_id,
    provider: row.provider,
    remoteRef: row.remote_ref,
    label: row.label,
    status: row.status,
    createdAt: row.created_at,
  };
}

export class ExecutionEnvCheckpointRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly findByEnvIdStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO execution_env_checkpoints
        (id, env_id, provider, remote_ref, label, status, created_at)
      VALUES
        (@id, @env_id, @provider, @remote_ref, @label, @status, @created_at)
    `);
    this.findByIdStmt = db.prepare(`SELECT * FROM execution_env_checkpoints WHERE id = ?`);
    this.findByEnvIdStmt = db.prepare(`
      SELECT * FROM execution_env_checkpoints
      WHERE env_id = ?
      ORDER BY created_at DESC, rowid DESC
    `);
  }

  create(input: CreateExecutionEnvCheckpointInput): Result<ExecutionEnvCheckpoint, DbError> {
    try {
      const row: ExecutionEnvCheckpointRow = {
        id: input.id,
        env_id: input.envId,
        provider: input.provider,
        remote_ref: input.remoteRef,
        label: input.label,
        status: input.status,
        created_at: this.now(),
      };

      this.insertStmt.run(row);
      return ok(rowToCheckpoint(row));
    } catch (cause) {
      return err(
        new DbError(
          `Failed to create execution environment checkpoint: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  findById(id: string): Result<ExecutionEnvCheckpoint | null, DbError> {
    try {
      const row = this.findByIdStmt.get(id) as ExecutionEnvCheckpointRow | undefined;
      return ok(row ? rowToCheckpoint(row) : null);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find execution environment checkpoint by id: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  findByEnvId(envId: string): Result<ExecutionEnvCheckpoint[], DbError> {
    try {
      const rows = this.findByEnvIdStmt.all(envId) as ExecutionEnvCheckpointRow[];
      return ok(rows.map(rowToCheckpoint));
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find execution environment checkpoints by env id: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }
}
