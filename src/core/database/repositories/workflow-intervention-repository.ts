import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';
import type { WorkflowIntervention } from '../../../workflow/workflow-types.js';

interface WorkflowInterventionRow {
  id: string;
  workflow_item_id: string;
  intervention_type: string;
  reason: string;
  status: string;
  payload_json: string;
  created_at: number;
  resolved_at: number | null;
}

function parseJson(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function rowToWorkflowIntervention(row: WorkflowInterventionRow): WorkflowIntervention {
  return {
    id: row.id,
    workflowItemId: row.workflow_item_id,
    interventionType: row.intervention_type,
    reason: row.reason,
    status: row.status as WorkflowIntervention['status'],
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export class WorkflowInterventionRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly listByWorkflowItemIdStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO workflow_interventions (
        id,
        workflow_item_id,
        intervention_type,
        reason,
        status,
        payload_json,
        created_at,
        resolved_at
      ) VALUES (
        @id,
        @workflow_item_id,
        @intervention_type,
        @reason,
        @status,
        @payload_json,
        @created_at,
        @resolved_at
      )
    `);

    this.listByWorkflowItemIdStmt = db.prepare(`
      SELECT * FROM workflow_interventions
      WHERE workflow_item_id = ?
      ORDER BY created_at ASC
    `);
  }

  insert(intervention: WorkflowIntervention): Result<WorkflowIntervention, DbError> {
    try {
      this.insertStmt.run({
        id: intervention.id,
        workflow_item_id: intervention.workflowItemId,
        intervention_type: intervention.interventionType,
        reason: intervention.reason,
        status: intervention.status,
        payload_json: JSON.stringify(intervention.payload),
        created_at: intervention.createdAt,
        resolved_at: intervention.resolvedAt,
      });
      return ok(intervention);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to insert workflow intervention: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  listByWorkflowItemId(workflowItemId: string): Result<WorkflowIntervention[], DbError> {
    try {
      const rows = this.listByWorkflowItemIdStmt.all(workflowItemId) as WorkflowInterventionRow[];
      return ok(rows.map(rowToWorkflowIntervention));
    } catch (cause) {
      return err(
        new DbError(
          `Failed to list workflow interventions by item: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }
}
