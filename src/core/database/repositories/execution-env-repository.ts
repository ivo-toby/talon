import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';
import type {
  CreateExecutionEnvironmentRecordInput,
  ExecutionEnvironment,
  ExecutionEnvStatus,
} from '../../../execution-env/execution-env-types.js';

interface ExecutionEnvironmentRow {
  id: string;
  provider: 'sprites';
  sprite_id: string;
  thread_id: string;
  persona_id: string;
  owner_task_id: string | null;
  status: ExecutionEnvStatus;
  working_directory: string;
  base_snapshot: string | null;
  auto_destroy: number;
  cpus: number;
  memory_mb: number;
  disk_gb: number;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  destroyed_at: number | null;
}

function rowToExecutionEnvironment(row: ExecutionEnvironmentRow): ExecutionEnvironment {
  return {
    id: row.id,
    provider: row.provider,
    spriteId: row.sprite_id,
    threadId: row.thread_id,
    personaId: row.persona_id,
    ownerTaskId: row.owner_task_id,
    status: row.status,
    workingDirectory: row.working_directory,
    baseSnapshot: row.base_snapshot,
    autoDestroy: row.auto_destroy === 1,
    resourceLimits: {
      cpus: row.cpus,
      memoryMb: row.memory_mb,
      diskGb: row.disk_gb,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    destroyedAt: row.destroyed_at,
  };
}

export class ExecutionEnvRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly findByOwnerTaskIdStmt: Database.Statement;
  private readonly findActiveStmt: Database.Statement;
  private readonly updateStatusStmt: Database.Statement;
  private readonly markDestroyedStmt: Database.Statement;
  private readonly updateSpriteIdStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO execution_environments
        (id, provider, sprite_id, thread_id, persona_id, owner_task_id, status, working_directory, base_snapshot, auto_destroy, cpus, memory_mb, disk_gb, metadata_json, created_at, updated_at, destroyed_at)
      VALUES
        (@id, @provider, @sprite_id, @thread_id, @persona_id, @owner_task_id, @status, @working_directory, @base_snapshot, @auto_destroy, @cpus, @memory_mb, @disk_gb, @metadata_json, @created_at, @updated_at, @destroyed_at)
    `);
    this.findByIdStmt = db.prepare(`SELECT * FROM execution_environments WHERE id = ?`);
    this.findByOwnerTaskIdStmt = db.prepare(`
      SELECT * FROM execution_environments
      WHERE owner_task_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    this.findActiveStmt = db.prepare(`
      SELECT * FROM execution_environments
      WHERE status NOT IN ('destroyed', 'failed')
      ORDER BY created_at ASC
    `);
    this.updateStatusStmt = db.prepare(`
      UPDATE execution_environments
      SET status = @status,
          updated_at = @updated_at
      WHERE id = @id
    `);
    this.markDestroyedStmt = db.prepare(`
      UPDATE execution_environments
      SET status = 'destroyed',
          updated_at = @updated_at,
          destroyed_at = @destroyed_at
      WHERE id = @id
    `);
    this.updateSpriteIdStmt = db.prepare(`
      UPDATE execution_environments
      SET sprite_id = @sprite_id,
          updated_at = @updated_at
      WHERE id = @id
    `);
  }

  create(input: CreateExecutionEnvironmentRecordInput): Result<ExecutionEnvironment, DbError> {
    try {
      const now = this.now();
      const row: ExecutionEnvironmentRow = {
        id: input.id,
        provider: input.provider,
        sprite_id: input.spriteId,
        thread_id: input.threadId,
        persona_id: input.personaId,
        owner_task_id: input.ownerTaskId,
        status: input.status,
        working_directory: input.workingDirectory,
        base_snapshot: input.baseSnapshot,
        auto_destroy: input.autoDestroy ? 1 : 0,
        cpus: input.resourceLimits.cpus,
        memory_mb: input.resourceLimits.memoryMb,
        disk_gb: input.resourceLimits.diskGb,
        metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
        created_at: now,
        updated_at: now,
        destroyed_at: null,
      };

      this.insertStmt.run(row);
      return ok(rowToExecutionEnvironment(row));
    } catch (cause) {
      return err(
        new DbError(
          `Failed to create execution environment: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  findById(id: string): Result<ExecutionEnvironment | null, DbError> {
    try {
      const row = this.findByIdStmt.get(id) as ExecutionEnvironmentRow | undefined;
      return ok(row ? rowToExecutionEnvironment(row) : null);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find execution environment by id: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  findByOwnerTaskId(taskId: string): Result<ExecutionEnvironment | null, DbError> {
    try {
      const row = this.findByOwnerTaskIdStmt.get(taskId) as ExecutionEnvironmentRow | undefined;
      return ok(row ? rowToExecutionEnvironment(row) : null);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find execution environment by owner task id: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  findActive(): Result<ExecutionEnvironment[], DbError> {
    try {
      const rows = this.findActiveStmt.all() as ExecutionEnvironmentRow[];
      return ok(rows.map(rowToExecutionEnvironment));
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find active execution environments: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  updateStatus(id: string, status: ExecutionEnvStatus): Result<void, DbError> {
    try {
      this.updateStatusStmt.run({ id, status, updated_at: this.now() });
      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to update execution environment status: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  markDestroyed(id: string): Result<void, DbError> {
    try {
      const now = this.now();
      this.markDestroyedStmt.run({ id, updated_at: now, destroyed_at: now });
      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to mark execution environment destroyed: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  updateSpriteId(id: string, spriteId: string): Result<void, DbError> {
    try {
      this.updateSpriteIdStmt.run({ id, sprite_id: spriteId, updated_at: this.now() });
      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to update execution environment sprite id: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }
}
