import { describe, expect, it } from 'vitest';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';
import {
  WorkflowItemRepository,
  WorkflowClaimRepository,
  WorkflowEvidenceRepository,
  WorkflowEventRepository,
  WorkflowLeaseRepository,
  WorkflowInterventionRepository,
} from '../../../src/core/database/repositories/index.js';
import { WorkflowKernelService } from '../../../src/workflow/workflow-service.js';
import { WorkflowReadModel } from '../../../src/workflow/workflow-read-model.js';

describe('WorkflowReadModel', () => {
  it('returns an operational view with current state, owner, blocker, and next expected transition', () => {
    const db = createTestDb();
    const workflowService = new WorkflowKernelService({
      itemRepository: new WorkflowItemRepository(db),
      claimRepository: new WorkflowClaimRepository(db),
      evidenceRepository: new WorkflowEvidenceRepository(db),
      eventRepository: new WorkflowEventRepository(db),
      leaseRepository: new WorkflowLeaseRepository(db),
      interventionRepository: new WorkflowInterventionRepository(db),
    });
    const readModel = new WorkflowReadModel(db);

    const item = workflowService.createItem({
      id: uuid(),
      workflowType: 'orchestrator_task',
      domain: 'operations',
      title: 'Coordinate delegated task',
      goal: { deliverable: 'verified output' },
      ownerActorId: 'persona-001',
      sourceThreadId: 'thread-001',
    })._unsafeUnwrap();
    workflowService.submitClaim({
      id: uuid(),
      workflowItemId: item.id,
      claimType: 'blockage',
      actorId: 'persona-001',
      actorKind: 'persona',
      action: 'report_blocker',
      target: 'delegated-task',
      assertedOutcome: 'blocked',
      summary: 'Waiting for credential approval.',
      payload: {},
    });
    workflowService.attachEvidence({
      id: uuid(),
      workflowItemId: item.id,
      claimId: null,
      evidenceType: 'tool_call_result',
      source: 'tool_result',
      locator: 'tool_result:req-001',
      capturedAt: 1_500,
      provenance: { tool: 'subagent.background' },
      payload: {},
    });
    db.prepare(`
      UPDATE workflow_items
      SET state = 'blocked',
          status_reason = 'waiting for credential approval',
          updated_at = 2_000
      WHERE id = ?
    `).run(item.id);
    db.prepare(`
      INSERT INTO workflow_leases (
        id, workflow_item_id, actor_id, actor_kind, lease_state, acquired_at, renewed_at, expires_at, released_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), item.id, 'persona-001', 'persona', 'active', 1_000, null, 2_500, null);

    const result = readModel.listOperationalView();

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([
      expect.objectContaining({
        workflowItemId: item.id,
        state: 'blocked',
        ownerActorId: 'persona-001',
        blockedReason: 'waiting for credential approval',
        latestClaimSummary: 'Waiting for credential approval.',
        latestEvidenceLocator: 'tool_result:req-001',
        leaseExpiresAt: 2_500,
        nextExpectedTransition: 'resolve_blocker',
      }),
    ]);
  });

  it('returns append-only audit events in chronological order', () => {
    const db = createTestDb();
    const workflowService = new WorkflowKernelService({
      itemRepository: new WorkflowItemRepository(db),
      claimRepository: new WorkflowClaimRepository(db),
      evidenceRepository: new WorkflowEvidenceRepository(db),
      eventRepository: new WorkflowEventRepository(db),
      leaseRepository: new WorkflowLeaseRepository(db),
      interventionRepository: new WorkflowInterventionRepository(db),
    });
    const readModel = new WorkflowReadModel(db);
    const item = workflowService.createItem({
      id: uuid(),
      workflowType: 'orchestrator_task',
      domain: 'operations',
      title: 'Coordinate delegated task',
      goal: { deliverable: 'verified output' },
      ownerActorId: 'persona-001',
      sourceThreadId: 'thread-001',
    })._unsafeUnwrap();

    workflowService.submitClaim({
      id: uuid(),
      workflowItemId: item.id,
      claimType: 'progress',
      actorId: 'persona-001',
      actorKind: 'persona',
      action: 'report_progress',
      target: 'delegated-task',
      assertedOutcome: 'in_progress',
      summary: 'Checkpoint reached.',
      payload: {},
    });
    workflowService.requestTransition({
      workflowItemId: item.id,
      requestedState: 'awaiting_validation',
      actorId: 'persona-001',
      reason: 'work_submitted',
      correlationId: 'transition-001',
    });

    const result = readModel.listAuditEvents(item.id);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().map((event) => event.eventType)).toEqual([
      'workflow.created',
      'workflow.claim_submitted',
      'workflow.transition_requested',
    ]);
  });
});
