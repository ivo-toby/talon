import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { createTestDb, uuid } from '../core/database/repositories/helpers.js';
import {
  WorkflowItemRepository,
  WorkflowClaimRepository,
  WorkflowEventRepository,
  WorkflowLeaseRepository,
  WorkflowInterventionRepository,
} from '../../../src/core/database/repositories/index.js';
import { WorkflowKernelService } from '../../../src/workflow/workflow-service.js';
import { WorkflowWatchdog } from '../../../src/workflow/workflow-watchdog.js';

describe('WorkflowWatchdog', () => {
  let db: Database.Database;
  let itemRepository: WorkflowItemRepository;
  let claimRepository: WorkflowClaimRepository;
  let eventRepository: WorkflowEventRepository;
  let leaseRepository: WorkflowLeaseRepository;
  let interventionRepository: WorkflowInterventionRepository;
  let workflowService: WorkflowKernelService;
  let watchdog: WorkflowWatchdog;

  beforeEach(() => {
    db = createTestDb();
    itemRepository = new WorkflowItemRepository(db);
    claimRepository = new WorkflowClaimRepository(db);
    eventRepository = new WorkflowEventRepository(db);
    leaseRepository = new WorkflowLeaseRepository(db);
    interventionRepository = new WorkflowInterventionRepository(db);
    workflowService = new WorkflowKernelService({
      itemRepository,
      claimRepository,
      evidenceRepository: {} as any,
      eventRepository,
      leaseRepository,
      interventionRepository,
    });
    watchdog = new WorkflowWatchdog({
      itemRepository,
      claimRepository,
      eventRepository,
      leaseRepository,
      interventionRepository,
      claimRejectionThreshold: 2,
    });
  });

  it('expires active leases deterministically and emits workflow.lease_expired', () => {
    const item = workflowService.createItem({
      id: uuid(),
      workflowType: 'orchestrator_task',
      domain: 'operations',
      title: 'Follow up on delegated work',
      goal: { deliverable: 'validated result' },
      ownerActorId: 'persona-001',
      sourceThreadId: 'thread-001',
    })._unsafeUnwrap();

    leaseRepository.insert({
      id: uuid(),
      workflowItemId: item.id,
      actorId: 'persona-001',
      actorKind: 'persona',
      leaseState: 'active',
      acquiredAt: 1_000,
      renewedAt: null,
      expiresAt: 1_500,
      releasedAt: null,
    });

    const result = watchdog.evaluate(2_000);

    expect(result.isOk()).toBe(true);
    expect(leaseRepository.listByWorkflowItemId(item.id)._unsafeUnwrap()[0]?.leaseState).toBe('expired');
    expect(eventRepository.listByWorkflowItemId(item.id)._unsafeUnwrap().map((event) => event.eventType)).toContain(
      'workflow.lease_expired',
    );
  });

  it('creates an intervention request after repeated claim rejection', () => {
    const item = workflowService.createItem({
      id: uuid(),
      workflowType: 'orchestrator_task',
      domain: 'operations',
      title: 'Follow up on delegated work',
      goal: { deliverable: 'validated result' },
      ownerActorId: 'persona-001',
      sourceThreadId: 'thread-001',
    })._unsafeUnwrap();

    claimRepository.insert({
      id: uuid(),
      workflowItemId: item.id,
      claimType: 'completion',
      actorId: 'persona-001',
      actorKind: 'persona',
      action: 'report_completion',
      target: 'delegated-task',
      assertedOutcome: 'done',
      summary: 'Marked complete without evidence.',
      payload: {},
      status: 'rejected',
      policyDecision: { reason: 'missing_evidence' },
      createdAt: 1_000,
      resolvedAt: 1_100,
    });
    claimRepository.insert({
      id: uuid(),
      workflowItemId: item.id,
      claimType: 'completion',
      actorId: 'persona-001',
      actorKind: 'persona',
      action: 'report_completion',
      target: 'delegated-task',
      assertedOutcome: 'done',
      summary: 'Marked complete without evidence again.',
      payload: {},
      status: 'rejected',
      policyDecision: { reason: 'missing_evidence' },
      createdAt: 1_200,
      resolvedAt: 1_300,
    });

    const result = watchdog.evaluate(2_000);

    expect(result.isOk()).toBe(true);
    const interventions = interventionRepository.listByWorkflowItemId(item.id)._unsafeUnwrap();
    expect(interventions).toHaveLength(1);
    expect(interventions[0]?.reason).toBe('claim_rejection_threshold_exceeded');
    expect(eventRepository.listByWorkflowItemId(item.id)._unsafeUnwrap().map((event) => event.eventType)).toContain(
      'workflow.intervention_requested',
    );
  });
});
