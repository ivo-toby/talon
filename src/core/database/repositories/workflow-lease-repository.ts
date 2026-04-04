import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';
import type { WorkflowLease } from '../../../workflow/workflow-types.js';

interface WorkflowLeaseRow {
  id: string;
  workflow_item_id: string;
  actor_id: string;
  actor_kind: string;
  lease_state: string;
  acquired_at: number;
  renewed_at: number | null;
  expires_at: number;
  released_at: number | null;
}

function rowToWorkflowLease(row: WorkflowLeaseRow): WorkflowLease {
  return {
    id: row.id,
    workflowItemId: row.workflow_item_id,
    actorId: row.actor_id,
    actorKind: row.actor_kind as WorkflowLease['actorKind'],
    leaseState: row.lease_state as WorkflowLease['leaseState'],
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
  };
}

export class WorkflowLeaseRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly listByWorkflowItemIdStmt: Database.Statement;
  private readonly listActiveExpiringBeforeStmt: Database.Statement;
  private readonly updateStateStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO workflow_leases (
        id,
        workflow_item_id,
        actor_id,
        actor_kind,
        lease_state,
        acquired_at,
        renewed_at,
        expires_at,
        released_at
      ) VALUES (
        @id,
        @workflow_item_id,
        @actor_id,
        @actor_kind,
        @lease_state,
        @acquired_at,
        @renewed_at,
        @expires_at,
        @released_at
      )
    `);

    this.listByWorkflowItemIdStmt = db.prepare(`
      SELECT * FROM workflow_leases
      WHERE workflow_item_id = ?
      ORDER BY acquired_at ASC
    `);

    this.listActiveExpiringBeforeStmt = db.prepare(`
      SELECT * FROM workflow_leases
      WHERE lease_state = 'active' AND expires_at <= ?
      ORDER BY expires_at ASC
    `);

    this.updateStateStmt = db.prepare(`
      UPDATE workflow_leases
      SET lease_state = @lease_state,
          renewed_at = COALESCE(@renewed_at, renewed_at),
          released_at = COALESCE(@released_at, released_at)
      WHERE id = @id
    `);
  }

  insert(lease: WorkflowLease): Result<WorkflowLease, DbError> {
    try {
      this.insertStmt.run({
        id: lease.id,
        workflow_item_id: lease.workflowItemId,
        actor_id: lease.actorId,
        actor_kind: lease.actorKind,
        lease_state: lease.leaseState,
        acquired_at: lease.acquiredAt,
        renewed_at: lease.renewedAt,
        expires_at: lease.expiresAt,
        released_at: lease.releasedAt,
      });
      return ok(lease);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to insert workflow lease: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  listByWorkflowItemId(workflowItemId: string): Result<WorkflowLease[], DbError> {
    try {
      const rows = this.listByWorkflowItemIdStmt.all(workflowItemId) as WorkflowLeaseRow[];
      return ok(rows.map(rowToWorkflowLease));
    } catch (cause) {
      return err(
        new DbError(
          `Failed to list workflow leases by item: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  listActiveExpiringBefore(expiresAt: number): Result<WorkflowLease[], DbError> {
    try {
      const rows = this.listActiveExpiringBeforeStmt.all(expiresAt) as WorkflowLeaseRow[];
      return ok(rows.map(rowToWorkflowLease));
    } catch (cause) {
      return err(
        new DbError(
          `Failed to list expiring workflow leases: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  updateState(
    id: string,
    leaseState: WorkflowLease['leaseState'],
    options: { renewedAt?: number | null; releasedAt?: number | null } = {},
  ): Result<void, DbError> {
    try {
      this.updateStateStmt.run({
        id,
        lease_state: leaseState,
        renewed_at: options.renewedAt ?? null,
        released_at: options.releasedAt ?? null,
      });
      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to update workflow lease state: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }
}
