import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';
import type { WorkflowClaim } from '../../../workflow/workflow-types.js';

interface WorkflowClaimRow {
  id: string;
  workflow_item_id: string;
  claim_type: string;
  actor_id: string;
  actor_kind: string;
  action: string;
  target: string;
  asserted_outcome: string;
  summary: string;
  payload_json: string;
  status: string;
  policy_decision_json: string | null;
  created_at: number;
  resolved_at: number | null;
}

function parseJson(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function rowToWorkflowClaim(row: WorkflowClaimRow): WorkflowClaim {
  return {
    id: row.id,
    workflowItemId: row.workflow_item_id,
    claimType: row.claim_type,
    actorId: row.actor_id,
    actorKind: row.actor_kind as WorkflowClaim['actorKind'],
    action: row.action,
    target: row.target,
    assertedOutcome: row.asserted_outcome,
    summary: row.summary,
    payload: parseJson(row.payload_json),
    status: row.status as WorkflowClaim['status'],
    policyDecision: row.policy_decision_json ? parseJson(row.policy_decision_json) : null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export class WorkflowClaimRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly listByWorkflowItemIdStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO workflow_claims (
        id,
        workflow_item_id,
        claim_type,
        actor_id,
        actor_kind,
        action,
        target,
        asserted_outcome,
        summary,
        payload_json,
        status,
        policy_decision_json,
        created_at,
        resolved_at
      ) VALUES (
        @id,
        @workflow_item_id,
        @claim_type,
        @actor_id,
        @actor_kind,
        @action,
        @target,
        @asserted_outcome,
        @summary,
        @payload_json,
        @status,
        @policy_decision_json,
        @created_at,
        @resolved_at
      )
    `);

    this.listByWorkflowItemIdStmt = db.prepare(`
      SELECT * FROM workflow_claims
      WHERE workflow_item_id = ?
      ORDER BY created_at ASC
    `);

    this.findByIdStmt = db.prepare(`SELECT * FROM workflow_claims WHERE id = ?`);
  }

  insert(claim: WorkflowClaim): Result<WorkflowClaim, DbError> {
    try {
      this.insertStmt.run({
        id: claim.id,
        workflow_item_id: claim.workflowItemId,
        claim_type: claim.claimType,
        actor_id: claim.actorId,
        actor_kind: claim.actorKind,
        action: claim.action,
        target: claim.target,
        asserted_outcome: claim.assertedOutcome,
        summary: claim.summary,
        payload_json: JSON.stringify(claim.payload),
        status: claim.status,
        policy_decision_json: claim.policyDecision ? JSON.stringify(claim.policyDecision) : null,
        created_at: claim.createdAt,
        resolved_at: claim.resolvedAt,
      });
      return ok(claim);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to insert workflow claim: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  findById(id: string): Result<WorkflowClaim | null, DbError> {
    try {
      const row = this.findByIdStmt.get(id) as WorkflowClaimRow | undefined;
      return ok(row ? rowToWorkflowClaim(row) : null);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find workflow claim by id: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  listByWorkflowItemId(workflowItemId: string): Result<WorkflowClaim[], DbError> {
    try {
      const rows = this.listByWorkflowItemIdStmt.all(workflowItemId) as WorkflowClaimRow[];
      return ok(rows.map(rowToWorkflowClaim));
    } catch (cause) {
      return err(
        new DbError(
          `Failed to list workflow claims by item: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }
}
