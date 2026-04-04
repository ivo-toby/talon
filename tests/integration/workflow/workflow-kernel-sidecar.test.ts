import { describe, expect, it } from 'vitest';

import { createTestDb, uuid } from '../../unit/core/database/repositories/helpers.js';
import {
  WorkflowItemRepository,
  WorkflowClaimRepository,
  WorkflowEvidenceRepository,
  WorkflowEventRepository,
  WorkflowLeaseRepository,
  WorkflowInterventionRepository,
} from '../../../src/core/database/repositories/index.js';
import { WorkflowKernelService } from '../../../src/workflow/workflow-service.js';

function createWorkflowService() {
  const db = createTestDb();
  const itemRepository = new WorkflowItemRepository(db);
  const workflowService = new WorkflowKernelService({
    itemRepository,
    claimRepository: new WorkflowClaimRepository(db),
    evidenceRepository: new WorkflowEvidenceRepository(db),
    eventRepository: new WorkflowEventRepository(db),
    leaseRepository: new WorkflowLeaseRepository(db),
    interventionRepository: new WorkflowInterventionRepository(db),
  });

  return { db, itemRepository, workflowService };
}

describe('Workflow kernel sidecar integration', () => {
  it('observe mode records completion requests without blocking the runtime path', () => {
    const { db, itemRepository, workflowService } = createWorkflowService();
    const item = workflowService.createItem({
      id: uuid(),
      workflowType: 'orchestrator_task',
      domain: 'operations',
      title: 'Coordinate delegated task',
      goal: { deliverable: 'verified output' },
      ownerActorId: 'assistant',
      sourceThreadId: 'thread-001',
      rolloutMode: 'observe',
      policyPack: 'orchestrator-task',
      policyVersion: '1',
    })._unsafeUnwrap();

    const result = workflowService.requestTransition({
      workflowItemId: item.id,
      requestedState: 'done',
      actorId: 'assistant',
      reason: 'a2a_completed',
      correlationId: 'task-123',
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().decision).toBe('accepted');
    expect(itemRepository.findById(item.id)._unsafeUnwrap()?.state).toBe('intake');

    db.close();
  });

  it('authoritative orchestrator mode rejects completion without the required evidence', () => {
    const { db, itemRepository, workflowService } = createWorkflowService();
    const item = workflowService.createItem({
      id: uuid(),
      workflowType: 'orchestrator_task',
      domain: 'operations',
      title: 'Coordinate delegated task',
      goal: { deliverable: 'verified output' },
      ownerActorId: 'assistant',
      sourceThreadId: 'thread-001',
      rolloutMode: 'authoritative',
      policyPack: 'orchestrator-task',
      policyVersion: '1',
    })._unsafeUnwrap();

    workflowService.requestTransition({
      workflowItemId: item.id,
      requestedState: 'ready',
      actorId: 'assistant',
      reason: 'a2a_submitted',
      correlationId: 'task-123',
    });
    const result = workflowService.requestTransition({
      workflowItemId: item.id,
      requestedState: 'done',
      actorId: 'assistant',
      reason: 'a2a_completed',
      correlationId: 'task-123',
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().decision).toBe('rejected');
    expect(itemRepository.findById(item.id)._unsafeUnwrap()?.state).toBe('ready');

    db.close();
  });
});
