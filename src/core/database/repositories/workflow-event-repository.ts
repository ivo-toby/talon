import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';
import type { WorkflowEvent } from '../../../workflow/workflow-types.js';

interface WorkflowEventRow {
  id: string;
  workflow_item_id: string;
  event_type: string;
  actor_id: string | null;
  correlation_id: string | null;
  payload_json: string;
  created_at: number;
}

function parseJson(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function rowToWorkflowEvent(row: WorkflowEventRow): WorkflowEvent {
  return {
    id: row.id,
    workflowItemId: row.workflow_item_id,
    eventType: row.event_type,
    actorId: row.actor_id,
    correlationId: row.correlation_id,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
  };
}

export class WorkflowEventRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly listByWorkflowItemIdStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO workflow_events (
        id,
        workflow_item_id,
        event_type,
        actor_id,
        correlation_id,
        payload_json,
        created_at
      ) VALUES (
        @id,
        @workflow_item_id,
        @event_type,
        @actor_id,
        @correlation_id,
        @payload_json,
        @created_at
      )
    `);

    this.listByWorkflowItemIdStmt = db.prepare(`
      SELECT * FROM workflow_events
      WHERE workflow_item_id = ?
      ORDER BY created_at ASC, rowid ASC
    `);
  }

  insert(event: WorkflowEvent): Result<WorkflowEvent, DbError> {
    try {
      this.insertStmt.run({
        id: event.id,
        workflow_item_id: event.workflowItemId,
        event_type: event.eventType,
        actor_id: event.actorId,
        correlation_id: event.correlationId,
        payload_json: JSON.stringify(event.payload),
        created_at: event.createdAt,
      });
      return ok(event);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to insert workflow event: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  listByWorkflowItemId(workflowItemId: string): Result<WorkflowEvent[], DbError> {
    try {
      const rows = this.listByWorkflowItemIdStmt.all(workflowItemId) as WorkflowEventRow[];
      return ok(rows.map(rowToWorkflowEvent));
    } catch (cause) {
      return err(
        new DbError(
          `Failed to list workflow events by item: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }
}
