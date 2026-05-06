import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';

import type { WorkflowEvent } from './workflow-types.js';
import { WorkflowError } from './workflow-types.js';

interface WorkflowOperationalViewRow {
  workflow_item_id: string;
  title: string;
  workflow_type: string;
  state: string;
  owner_actor_id: string | null;
  policy_pack: string;
  rollout_mode: string;
  latest_claim_summary: string | null;
  latest_evidence_locator: string | null;
  blocked_reason: string | null;
  lease_expires_at: number | null;
  updated_at: number;
}

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

export interface WorkflowOperationalView {
  workflowItemId: string;
  title: string;
  workflowType: string;
  state: string;
  ownerActorId: string | null;
  policyPack: string;
  rolloutMode: string;
  latestClaimSummary: string | null;
  latestEvidenceLocator: string | null;
  blockedReason: string | null;
  leaseExpiresAt: number | null;
  nextExpectedTransition: string;
  updatedAt: number;
}

export interface WorkflowOperationalSummary {
  totalItems: number;
  blockedItems: number;
  activeLeases: number;
}

export class WorkflowReadModel {
  private readonly listOperationalViewStmt: Database.Statement;
  private readonly listAuditEventsStmt: Database.Statement;
  private readonly summarizeStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.listOperationalViewStmt = db.prepare(`
      SELECT
        i.id AS workflow_item_id,
        i.title,
        i.workflow_type,
        i.state,
        i.owner_actor_id,
        i.policy_pack,
        i.rollout_mode,
        (
          SELECT c.summary
          FROM workflow_claims c
          WHERE c.workflow_item_id = i.id
          ORDER BY c.created_at DESC
          LIMIT 1
        ) AS latest_claim_summary,
        (
          SELECT e.locator
          FROM workflow_evidence e
          WHERE e.workflow_item_id = i.id
          ORDER BY e.created_at DESC
          LIMIT 1
        ) AS latest_evidence_locator,
        i.status_reason AS blocked_reason,
        (
          SELECT l.expires_at
          FROM workflow_leases l
          WHERE l.workflow_item_id = i.id AND l.lease_state = 'active'
          ORDER BY l.expires_at DESC
          LIMIT 1
        ) AS lease_expires_at,
        i.updated_at
      FROM workflow_items i
      ORDER BY i.updated_at DESC, i.created_at DESC
    `);

    this.listAuditEventsStmt = db.prepare(`
      SELECT *
      FROM workflow_events
      WHERE workflow_item_id = ?
      ORDER BY created_at ASC, rowid ASC
    `);

    this.summarizeStmt = db.prepare(`
      SELECT
        COUNT(*) AS total_items,
        SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END) AS blocked_items,
        (
          SELECT COUNT(*)
          FROM workflow_leases
          WHERE lease_state = 'active'
        ) AS active_leases
      FROM workflow_items
    `);
  }

  listOperationalView(): Result<WorkflowOperationalView[], WorkflowError> {
    try {
      const rows = this.listOperationalViewStmt.all() as WorkflowOperationalViewRow[];
      return ok(
        rows.map((row) => ({
          workflowItemId: row.workflow_item_id,
          title: row.title,
          workflowType: row.workflow_type,
          state: row.state,
          ownerActorId: row.owner_actor_id,
          policyPack: row.policy_pack,
          rolloutMode: row.rollout_mode,
          latestClaimSummary: row.latest_claim_summary,
          latestEvidenceLocator: row.latest_evidence_locator,
          blockedReason: row.blocked_reason,
          leaseExpiresAt: row.lease_expires_at,
          nextExpectedTransition: this.nextExpectedTransition(row.state),
          updatedAt: row.updated_at,
        })),
      );
    } catch (cause) {
      return err(
        new WorkflowError(
          `Failed to build workflow operational view: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  listAuditEvents(workflowItemId: string): Result<WorkflowEvent[], WorkflowError> {
    try {
      const rows = this.listAuditEventsStmt.all(workflowItemId) as WorkflowEventRow[];
      return ok(
        rows.map((row) => ({
          id: row.id,
          workflowItemId: row.workflow_item_id,
          eventType: row.event_type,
          actorId: row.actor_id,
          correlationId: row.correlation_id,
          payload: parseJson(row.payload_json),
          createdAt: row.created_at,
        })),
      );
    } catch (cause) {
      return err(
        new WorkflowError(
          `Failed to load workflow audit events: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  summarizeOperationalView(): Result<WorkflowOperationalSummary, WorkflowError> {
    try {
      const row = this.summarizeStmt.get() as {
        total_items: number | null;
        blocked_items: number | null;
        active_leases: number | null;
      };
      return ok({
        totalItems: row.total_items ?? 0,
        blockedItems: row.blocked_items ?? 0,
        activeLeases: row.active_leases ?? 0,
      });
    } catch (cause) {
      return err(
        new WorkflowError(
          `Failed to summarize workflow operational view: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  private nextExpectedTransition(state: string): string {
    switch (state) {
      case 'blocked':
        return 'resolve_blocker';
      case 'in_progress':
        return 'claim_update';
      case 'awaiting_validation':
        return 'validation_decision';
      default:
        return 'transition_request';
    }
  }
}
