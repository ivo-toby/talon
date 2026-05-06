import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

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

describe('WorkflowKernelService', () => {
  let db: Database.Database;
  let itemRepo: WorkflowItemRepository;
  let claimRepo: WorkflowClaimRepository;
  let evidenceRepo: WorkflowEvidenceRepository;
  let eventRepo: WorkflowEventRepository;
  let leaseRepo: WorkflowLeaseRepository;
  let interventionRepo: WorkflowInterventionRepository;
  let service: WorkflowKernelService;

  beforeEach(() => {
    db = createTestDb();
    itemRepo = new WorkflowItemRepository(db);
    claimRepo = new WorkflowClaimRepository(db);
    evidenceRepo = new WorkflowEvidenceRepository(db);
    eventRepo = new WorkflowEventRepository(db);
    leaseRepo = new WorkflowLeaseRepository(db);
    interventionRepo = new WorkflowInterventionRepository(db);
    service = new WorkflowKernelService({
      itemRepository: itemRepo,
      claimRepository: claimRepo,
      evidenceRepository: evidenceRepo,
      eventRepository: eventRepo,
      leaseRepository: leaseRepo,
      interventionRepository: interventionRepo,
    });
  });

  function createItem() {
    const result = service.createItem({
      id: uuid(),
      workflowType: 'orchestrator_task',
      domain: 'operations',
      title: 'Verify delegated task',
      goal: {
        deliverable: 'validated handoff',
      },
      ownerActorId: 'persona:orchestrator',
      sourceThreadId: 'thread-001',
    });

    expect(result.isOk()).toBe(true);
    return result._unsafeUnwrap();
  }

  it('initializes workflow repositories cleanly on a fresh database', () => {
    expect(itemRepo.findById('missing-item')._unsafeUnwrap()).toBeNull();
    expect(claimRepo.listByWorkflowItemId('missing-item')._unsafeUnwrap()).toEqual([]);
    expect(evidenceRepo.listByWorkflowItemId('missing-item')._unsafeUnwrap()).toEqual([]);
    expect(eventRepo.listByWorkflowItemId('missing-item')._unsafeUnwrap()).toEqual([]);
    expect(leaseRepo.listByWorkflowItemId('missing-item')._unsafeUnwrap()).toEqual([]);
    expect(interventionRepo.listByWorkflowItemId('missing-item')._unsafeUnwrap()).toEqual([]);
  });

  it('creates a workflow item and emits workflow.created', () => {
    const item = createItem();

    expect(item.state).toBe('intake');
    expect(item.rolloutMode).toBe('observe');
    expect(item.policyPack).toBe('observe-only');

    const events = eventRepo.listByWorkflowItemId(item.id)._unsafeUnwrap();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('workflow.created');
    expect(events[0]?.workflowItemId).toBe(item.id);
  });

  it('rejects claims that do not satisfy the core claim schema', () => {
    const item = createItem();

    const result = service.submitClaim({
      id: uuid(),
      workflowItemId: item.id,
      claimType: 'progress',
      actorId: 'persona:orchestrator',
      actorKind: 'persona',
      action: '',
      target: 'delegated-task',
      assertedOutcome: 'in_progress',
      summary: 'The work is moving forward.',
      payload: {
        percentComplete: 50,
      },
    });

    expect(result.isErr()).toBe(true);
    expect(claimRepo.listByWorkflowItemId(item.id)._unsafeUnwrap()).toEqual([]);
  });

  it('rejects evidence that does not satisfy the core evidence schema', () => {
    const item = createItem();

    const result = service.attachEvidence({
      id: uuid(),
      workflowItemId: item.id,
      claimId: null,
      evidenceType: 'tool_result',
      source: '',
      locator: 'tool_result:req-001',
      capturedAt: Date.now(),
      provenance: {
        toolName: 'persona.send',
      },
      payload: {
        requestId: 'req-001',
      },
    });

    expect(result.isErr()).toBe(true);
    expect(evidenceRepo.listByWorkflowItemId(item.id)._unsafeUnwrap()).toEqual([]);
  });
});
