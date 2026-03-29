import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';
import type {
  BackgroundTask,
  BackgroundTaskStatus,
  CreateBackgroundTaskInput,
} from '../../../subagents/background/background-agent-types.js';

interface BackgroundTaskRow {
  id: string;
  persona_id: string;
  provider_name: string;
  thread_id: string;
  channel_id: string;
  prompt: string;
  working_dir: string | null;
  status: BackgroundTaskStatus;
  output: string | null;
  error: string | null;
  pid: number | null;
  created_at: number;
  started_at: number;
  completed_at: number | null;
  timeout_minutes: number;
  parent_traceparent: string | null;
  sandbox_enabled: number;
  primary_execution_env_id: string | null;
}

function rowToTask(row: BackgroundTaskRow): BackgroundTask {
  return {
    id: row.id,
    personaId: row.persona_id,
    providerName: row.provider_name,
    threadId: row.thread_id,
    channelId: row.channel_id,
    prompt: row.prompt,
    workingDirectory: row.working_dir,
    status: row.status,
    output: row.output,
    error: row.error,
    pid: row.pid,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    timeoutMinutes: row.timeout_minutes,
    parentTraceparent: row.parent_traceparent,
    sandboxEnabled: row.sandbox_enabled === 1,
    primaryExecutionEnvId: row.primary_execution_env_id,
  };
}

export class BackgroundTaskRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly findActiveStmt: Database.Statement;
  private readonly findByThreadStmt: Database.Statement;
  private readonly countActiveStmt: Database.Statement;
  private readonly updatePidStmt: Database.Statement;
  private readonly updateRunningStatusStmt: Database.Statement;
  private readonly updateTerminalStatusStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO background_tasks
        (id, persona_id, provider_name, thread_id, channel_id, prompt, working_dir, status, output, error, pid, created_at, started_at, completed_at, timeout_minutes, parent_traceparent, sandbox_enabled, primary_execution_env_id)
      VALUES
        (@id, @persona_id, @provider_name, @thread_id, @channel_id, @prompt, @working_dir, @status, @output, @error, @pid, @created_at, @started_at, @completed_at, @timeout_minutes, @parent_traceparent, @sandbox_enabled, @primary_execution_env_id)
    `);

    this.findByIdStmt = db.prepare(`SELECT * FROM background_tasks WHERE id = ?`);
    this.findActiveStmt = db.prepare(`
      SELECT * FROM background_tasks
      WHERE status = 'running'
      ORDER BY created_at ASC
    `);
    this.findByThreadStmt = db.prepare(`
      SELECT * FROM background_tasks
      WHERE thread_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    this.countActiveStmt = db.prepare(`
      SELECT COUNT(*) as count FROM background_tasks WHERE status = 'running'
    `);
    this.updatePidStmt = db.prepare(`
      UPDATE background_tasks SET pid = @pid WHERE id = @id
    `);
    this.updateRunningStatusStmt = db.prepare(`
      UPDATE background_tasks
      SET status = @status,
          output = COALESCE(@output, output),
          error = COALESCE(@error, error)
      WHERE id = @id
    `);
    this.updateTerminalStatusStmt = db.prepare(`
      UPDATE background_tasks
      SET status = @status,
          output = COALESCE(@output, output),
          error = COALESCE(@error, error),
          completed_at = @completed_at
      WHERE id = @id
    `);
  }

  create(input: CreateBackgroundTaskInput): Result<BackgroundTask, DbError> {
    try {
      const now = this.now();
      const row: BackgroundTaskRow = {
        id: input.id,
        persona_id: input.personaId,
        provider_name: input.providerName,
        thread_id: input.threadId,
        channel_id: input.channelId,
        prompt: input.prompt,
        working_dir: input.workingDirectory,
        status: input.status,
        output: input.output,
        error: input.error,
        pid: input.pid,
        created_at: now,
        started_at: now,
        completed_at: null,
        timeout_minutes: input.timeoutMinutes,
        parent_traceparent: input.parentTraceparent ?? null,
        sandbox_enabled: input.sandboxEnabled ? 1 : 0,
        primary_execution_env_id: input.primaryExecutionEnvId ?? null,
      };

      this.insertStmt.run(row);
      return ok(rowToTask(row));
    } catch (cause) {
      return err(
        new DbError(
          `Failed to create background task: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  updatePid(id: string, pid: number): Result<void, DbError> {
    try {
      this.updatePidStmt.run({ id, pid });
      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to update background task pid: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  updateStatus(
    id: string,
    status: BackgroundTaskStatus,
    output?: string,
    error?: string,
  ): Result<void, DbError> {
    try {
      if (status === 'running') {
        this.updateRunningStatusStmt.run({
          id,
          status,
          output: output ?? null,
          error: error ?? null,
        });
      } else {
        this.updateTerminalStatusStmt.run({
          id,
          status,
          output: output ?? null,
          error: error ?? null,
          completed_at: this.now(),
        });
      }

      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to update background task status: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  findById(id: string): Result<BackgroundTask | null, DbError> {
    try {
      const row = this.findByIdStmt.get(id) as BackgroundTaskRow | undefined;
      return ok(row ? rowToTask(row) : null);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find background task by id: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  findActive(): Result<BackgroundTask[], DbError> {
    try {
      const rows = this.findActiveStmt.all() as BackgroundTaskRow[];
      return ok(rows.map(rowToTask));
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find active background tasks: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  findByThread(threadId: string, limit = 10): Result<BackgroundTask[], DbError> {
    try {
      const rows = this.findByThreadStmt.all(threadId, limit) as BackgroundTaskRow[];
      return ok(rows.map(rowToTask));
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find background tasks by thread: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  countActive(): Result<number, DbError> {
    try {
      const row = this.countActiveStmt.get() as { count: number };
      return ok(row.count);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to count active background tasks: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }
}
