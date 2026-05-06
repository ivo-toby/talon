import { v4 as uuidv4 } from 'uuid';
import { err, ok, type Result } from 'neverthrow';

import type {
  WorkflowClaimRepository,
  WorkflowEventRepository,
  WorkflowInterventionRepository,
  WorkflowItemRepository,
  WorkflowLeaseRepository,
} from '../core/database/repositories/index.js';
import type { WorkflowEvaluationSummary } from './workflow-types.js';
import { WorkflowError } from './workflow-types.js';

interface WorkflowWatchdogOptions {
  itemRepository: WorkflowItemRepository;
  claimRepository: WorkflowClaimRepository;
  eventRepository: WorkflowEventRepository;
  leaseRepository: WorkflowLeaseRepository;
  interventionRepository: WorkflowInterventionRepository;
  claimRejectionThreshold?: number;
  now?: () => number;
}

export class WorkflowWatchdog {
  private readonly itemRepository: WorkflowItemRepository;
  private readonly claimRepository: WorkflowClaimRepository;
  private readonly eventRepository: WorkflowEventRepository;
  private readonly leaseRepository: WorkflowLeaseRepository;
  private readonly interventionRepository: WorkflowInterventionRepository;
  private readonly claimRejectionThreshold: number;
  private readonly now: () => number;

  constructor(options: WorkflowWatchdogOptions) {
    this.itemRepository = options.itemRepository;
    this.claimRepository = options.claimRepository;
    this.eventRepository = options.eventRepository;
    this.leaseRepository = options.leaseRepository;
    this.interventionRepository = options.interventionRepository;
    this.claimRejectionThreshold = options.claimRejectionThreshold ?? 2;
    this.now = options.now ?? (() => Date.now());
  }

  evaluate(now = this.now()): Result<WorkflowEvaluationSummary, WorkflowError> {
    try {
      let interventionsRequested = 0;

      this.itemRepository.transaction(() => {
        const expiringLeases = this.leaseRepository.listActiveExpiringBefore(now);
        if (expiringLeases.isErr()) {
          throw expiringLeases.error;
        }

        for (const lease of expiringLeases.value) {
          const updateLease = this.leaseRepository.updateState(lease.id, 'expired');
          if (updateLease.isErr()) {
            throw updateLease.error;
          }

          const insertEvent = this.eventRepository.insert({
            id: uuidv4(),
            workflowItemId: lease.workflowItemId,
            eventType: 'workflow.lease_expired',
            actorId: lease.actorId,
            correlationId: lease.id,
            payload: {
              leaseId: lease.id,
              expiresAt: lease.expiresAt,
            },
            createdAt: now,
          });
          if (insertEvent.isErr()) {
            throw insertEvent.error;
          }
        }

        const items = this.itemRepository.listAll();
        if (items.isErr()) {
          throw items.error;
        }

        for (const item of items.value) {
          const claims = this.claimRepository.listByWorkflowItemId(item.id);
          if (claims.isErr()) {
            throw claims.error;
          }

          const rejectedClaims = claims.value.filter((claim) => claim.status === 'rejected');
          if (rejectedClaims.length < this.claimRejectionThreshold) {
            continue;
          }

          const interventions = this.interventionRepository.listByWorkflowItemId(item.id);
          if (interventions.isErr()) {
            throw interventions.error;
          }

          const alreadyPending = interventions.value.some(
            (intervention) =>
              intervention.reason === 'claim_rejection_threshold_exceeded' &&
              intervention.status === 'pending',
          );
          if (alreadyPending) {
            continue;
          }

          const interventionId = uuidv4();
          const insertIntervention = this.interventionRepository.insert({
            id: interventionId,
            workflowItemId: item.id,
            interventionType: 'request_status_audit',
            reason: 'claim_rejection_threshold_exceeded',
            status: 'pending',
            payload: {
              rejectedClaimCount: rejectedClaims.length,
            },
            createdAt: now,
            resolvedAt: null,
          });
          if (insertIntervention.isErr()) {
            throw insertIntervention.error;
          }

          const insertEvent = this.eventRepository.insert({
            id: uuidv4(),
            workflowItemId: item.id,
            eventType: 'workflow.intervention_requested',
            actorId: null,
            correlationId: interventionId,
            payload: {
              interventionType: 'request_status_audit',
              reason: 'claim_rejection_threshold_exceeded',
              rejectedClaimCount: rejectedClaims.length,
            },
            createdAt: now,
          });
          if (insertEvent.isErr()) {
            throw insertEvent.error;
          }

          interventionsRequested += 1;
        }
      });

      return ok({
        evaluatedItems: this.itemRepository.listAll().match((items) => items.length, () => 0),
        interventionsRequested,
      });
    } catch (cause) {
      return err(
        new WorkflowError(
          `Failed to evaluate workflow watchdog state: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }
}
