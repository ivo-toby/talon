import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';
import type { WorkflowEvidence } from '../../../workflow/workflow-types.js';

interface WorkflowEvidenceRow {
  id: string;
  workflow_item_id: string;
  claim_id: string | null;
  evidence_type: string;
  source: string;
  locator: string;
  captured_at: number;
  provenance_json: string;
  payload_json: string;
  created_at: number;
}

function parseJson(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function rowToWorkflowEvidence(row: WorkflowEvidenceRow): WorkflowEvidence {
  return {
    id: row.id,
    workflowItemId: row.workflow_item_id,
    claimId: row.claim_id,
    evidenceType: row.evidence_type,
    source: row.source,
    locator: row.locator,
    capturedAt: row.captured_at,
    provenance: parseJson(row.provenance_json),
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
  };
}

export class WorkflowEvidenceRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly listByWorkflowItemIdStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO workflow_evidence (
        id,
        workflow_item_id,
        claim_id,
        evidence_type,
        source,
        locator,
        captured_at,
        provenance_json,
        payload_json,
        created_at
      ) VALUES (
        @id,
        @workflow_item_id,
        @claim_id,
        @evidence_type,
        @source,
        @locator,
        @captured_at,
        @provenance_json,
        @payload_json,
        @created_at
      )
    `);

    this.listByWorkflowItemIdStmt = db.prepare(`
      SELECT * FROM workflow_evidence
      WHERE workflow_item_id = ?
      ORDER BY created_at ASC
    `);
  }

  insert(evidence: WorkflowEvidence): Result<WorkflowEvidence, DbError> {
    try {
      this.insertStmt.run({
        id: evidence.id,
        workflow_item_id: evidence.workflowItemId,
        claim_id: evidence.claimId,
        evidence_type: evidence.evidenceType,
        source: evidence.source,
        locator: evidence.locator,
        captured_at: evidence.capturedAt,
        provenance_json: JSON.stringify(evidence.provenance),
        payload_json: JSON.stringify(evidence.payload),
        created_at: evidence.createdAt,
      });
      return ok(evidence);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to insert workflow evidence: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  listByWorkflowItemId(workflowItemId: string): Result<WorkflowEvidence[], DbError> {
    try {
      const rows = this.listByWorkflowItemIdStmt.all(workflowItemId) as WorkflowEvidenceRow[];
      return ok(rows.map(rowToWorkflowEvidence));
    } catch (cause) {
      return err(
        new DbError(
          `Failed to list workflow evidence by item: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }
}
