import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';
import type { WorkflowItem } from '../../../workflow/workflow-types.js';

interface WorkflowItemRow {
  id: string;
  workflow_type: string;
  domain: string;
  title: string;
  goal_json: string;
  state: string;
  status_reason: string | null;
  rollout_mode: string;
  policy_pack: string;
  policy_version: string;
  owner_actor_id: string | null;
  source_thread_id: string | null;
  source_message_id: string | null;
  source_run_id: string | null;
  priority: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function parseJson(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function rowToWorkflowItem(row: WorkflowItemRow): WorkflowItem {
  return {
    id: row.id,
    workflowType: row.workflow_type,
    domain: row.domain,
    title: row.title,
    goal: parseJson(row.goal_json),
    state: row.state as WorkflowItem['state'],
    statusReason: row.status_reason,
    rolloutMode: row.rollout_mode as WorkflowItem['rolloutMode'],
    policyPack: row.policy_pack,
    policyVersion: row.policy_version,
    ownerActorId: row.owner_actor_id,
    sourceThreadId: row.source_thread_id,
    sourceMessageId: row.source_message_id,
    sourceRunId: row.source_run_id,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export class WorkflowItemRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly listAllStmt: Database.Statement;
  private readonly updateStateStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO workflow_items (
        id,
        workflow_type,
        domain,
        title,
        goal_json,
        state,
        status_reason,
        rollout_mode,
        policy_pack,
        policy_version,
        owner_actor_id,
        source_thread_id,
        source_message_id,
        source_run_id,
        priority,
        created_at,
        updated_at,
        completed_at
      ) VALUES (
        @id,
        @workflow_type,
        @domain,
        @title,
        @goal_json,
        @state,
        @status_reason,
        @rollout_mode,
        @policy_pack,
        @policy_version,
        @owner_actor_id,
        @source_thread_id,
        @source_message_id,
        @source_run_id,
        @priority,
        @created_at,
        @updated_at,
        @completed_at
      )
    `);

    this.findByIdStmt = db.prepare(`SELECT * FROM workflow_items WHERE id = ?`);
    this.listAllStmt = db.prepare(`SELECT * FROM workflow_items ORDER BY created_at ASC`);
    this.updateStateStmt = db.prepare(`
      UPDATE workflow_items
      SET state = @state,
          status_reason = @status_reason,
          updated_at = @updated_at,
          completed_at = @completed_at
      WHERE id = @id
    `);
  }

  insert(item: WorkflowItem): Result<WorkflowItem, DbError> {
    try {
      this.insertStmt.run({
        id: item.id,
        workflow_type: item.workflowType,
        domain: item.domain,
        title: item.title,
        goal_json: JSON.stringify(item.goal),
        state: item.state,
        status_reason: item.statusReason,
        rollout_mode: item.rolloutMode,
        policy_pack: item.policyPack,
        policy_version: item.policyVersion,
        owner_actor_id: item.ownerActorId,
        source_thread_id: item.sourceThreadId,
        source_message_id: item.sourceMessageId,
        source_run_id: item.sourceRunId,
        priority: item.priority,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
        completed_at: item.completedAt,
      });
      return ok(item);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to insert workflow item: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  findById(id: string): Result<WorkflowItem | null, DbError> {
    try {
      const row = this.findByIdStmt.get(id) as WorkflowItemRow | undefined;
      return ok(row ? rowToWorkflowItem(row) : null);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find workflow item by id: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  listAll(): Result<WorkflowItem[], DbError> {
    try {
      const rows = this.listAllStmt.all() as WorkflowItemRow[];
      return ok(rows.map(rowToWorkflowItem));
    } catch (cause) {
      return err(
        new DbError(
          `Failed to list workflow items: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  updateState(
    id: string,
    state: WorkflowItem['state'],
    options: { statusReason?: string | null; updatedAt: number; completedAt?: number | null },
  ): Result<void, DbError> {
    try {
      this.updateStateStmt.run({
        id,
        state,
        status_reason: options.statusReason ?? null,
        updated_at: options.updatedAt,
        completed_at: options.completedAt ?? null,
      });
      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to update workflow item state: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }
}
