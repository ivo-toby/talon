import { err, ok, type Result } from 'neverthrow';
import { v4 as uuidv4 } from 'uuid';
import {
  AttachWorkflowEvidenceInputSchema,
  CreateWorkflowItemInputSchema,
  SubmitWorkflowClaimInputSchema,
  type AcquireWorkflowLeaseInput,
  type AttachWorkflowEvidenceInput,
  type CreateWorkflowItemInput,
  type ReleaseWorkflowLeaseInput,
  type RenewWorkflowLeaseInput,
  type RequestWorkflowTransitionInput,
  type SubmitWorkflowClaimInput,
  type WorkflowClaim,
  type WorkflowDecision,
  type WorkflowEvaluationSummary,
  type WorkflowEvidence,
  type WorkflowEvent,
  type WorkflowIntervention,
  type WorkflowItem,
  type WorkflowLease,
  type WorkflowRolloutMode,
  WorkflowError,
} from './workflow-types.js';
import type {
  WorkflowClaimRepository,
  WorkflowEvidenceRepository,
  WorkflowEventRepository,
  WorkflowInterventionRepository,
  WorkflowItemRepository,
  WorkflowLeaseRepository,
} from '../core/database/repositories/index.js';
import type {
  WorkflowPolicyRegistry,
  WorkflowPolicyResolution,
} from './workflow-policy-registry.js';
import { orchestratorTaskPack } from './packs/orchestrator-task-pack.js';

interface WorkflowKernelServiceOptions {
  itemRepository: WorkflowItemRepository;
  claimRepository: WorkflowClaimRepository;
  evidenceRepository: WorkflowEvidenceRepository;
  eventRepository: WorkflowEventRepository;
  leaseRepository: WorkflowLeaseRepository;
  interventionRepository: WorkflowInterventionRepository;
  defaultRolloutMode?: WorkflowRolloutMode;
  defaultPolicyPack?: string;
  defaultPolicyVersion?: string;
  evaluateDueWorkFn?: (now?: number) => Result<WorkflowEvaluationSummary, WorkflowError>;
  policyRegistry?: WorkflowPolicyRegistry;
  now?: () => number;
}

export class WorkflowKernelService {
  private readonly itemRepository: WorkflowItemRepository;
  private readonly claimRepository: WorkflowClaimRepository;
  private readonly evidenceRepository: WorkflowEvidenceRepository;
  private readonly eventRepository: WorkflowEventRepository;
  private readonly leaseRepository: WorkflowLeaseRepository;
  private readonly interventionRepository: WorkflowInterventionRepository;
  private readonly defaultRolloutMode: WorkflowRolloutMode;
  private readonly defaultPolicyPack: string;
  private readonly defaultPolicyVersion: string;
  private readonly evaluateDueWorkFn?: (now?: number) => Result<WorkflowEvaluationSummary, WorkflowError>;
  private readonly policyRegistry?: WorkflowPolicyRegistry;
  private readonly now: () => number;

  constructor(options: WorkflowKernelServiceOptions) {
    this.itemRepository = options.itemRepository;
    this.claimRepository = options.claimRepository;
    this.evidenceRepository = options.evidenceRepository;
    this.eventRepository = options.eventRepository;
    this.leaseRepository = options.leaseRepository;
    this.interventionRepository = options.interventionRepository;
    this.defaultRolloutMode = options.defaultRolloutMode ?? 'observe';
    this.defaultPolicyPack = options.defaultPolicyPack ?? 'observe-only';
    this.defaultPolicyVersion = options.defaultPolicyVersion ?? '1';
    this.evaluateDueWorkFn = options.evaluateDueWorkFn;
    this.policyRegistry = options.policyRegistry;
    this.now = options.now ?? (() => Date.now());
  }

  createItem(input: CreateWorkflowItemInput): Result<WorkflowItem, WorkflowError> {
    const parsed = CreateWorkflowItemInputSchema.safeParse(input);
    if (!parsed.success) {
      return err(new WorkflowError(parsed.error.issues.map((issue) => issue.message).join('; ')));
    }

    const now = this.now();
    const resolvedPolicy = this.resolvePolicy(parsed.data.workflowType);
    const item: WorkflowItem = {
      id: parsed.data.id,
      workflowType: parsed.data.workflowType,
      domain: parsed.data.domain,
      title: parsed.data.title,
      goal: parsed.data.goal,
      state: 'intake',
      statusReason: null,
      rolloutMode:
        parsed.data.rolloutMode
        ?? resolvedPolicy?.rolloutMode
        ?? this.defaultRolloutMode,
      policyPack:
        parsed.data.policyPack
        ?? resolvedPolicy?.policyPack
        ?? this.defaultPolicyPack,
      policyVersion:
        parsed.data.policyVersion
        ?? resolvedPolicy?.policyVersion
        ?? this.defaultPolicyVersion,
      ownerActorId: parsed.data.ownerActorId ?? null,
      sourceThreadId: parsed.data.sourceThreadId ?? null,
      sourceMessageId: parsed.data.sourceMessageId ?? null,
      sourceRunId: parsed.data.sourceRunId ?? null,
      priority: parsed.data.priority,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    try {
      this.itemRepository.transaction(() => {
        const insertItem = this.itemRepository.insert(item);
        if (insertItem.isErr()) {
          throw insertItem.error;
        }

        const event = this.buildEvent({
          workflowItemId: item.id,
          eventType: 'workflow.created',
          actorId: item.ownerActorId,
          payload: {
            state: item.state,
            rolloutMode: item.rolloutMode,
            policyPack: item.policyPack,
          },
        });
        const insertEvent = this.eventRepository.insert(event);
        if (insertEvent.isErr()) {
          throw insertEvent.error;
        }
      });

      return ok(item);
    } catch (cause) {
      return err(this.wrapError('Failed to create workflow item', cause));
    }
  }

  submitClaim(input: SubmitWorkflowClaimInput): Result<WorkflowClaim, WorkflowError> {
    const parsed = SubmitWorkflowClaimInputSchema.safeParse(input);
    if (!parsed.success) {
      return err(new WorkflowError(parsed.error.issues.map((issue) => issue.message).join('; ')));
    }

    const itemResult = this.ensureWorkflowItem(parsed.data.workflowItemId);
    if (itemResult.isErr()) {
      return err(itemResult.error);
    }

    const now = this.now();
    const claim: WorkflowClaim = {
      id: parsed.data.id,
      workflowItemId: parsed.data.workflowItemId,
      claimType: parsed.data.claimType,
      actorId: parsed.data.actorId,
      actorKind: parsed.data.actorKind,
      action: parsed.data.action,
      target: parsed.data.target,
      assertedOutcome: parsed.data.assertedOutcome,
      summary: parsed.data.summary,
      payload: parsed.data.payload,
      status: 'pending',
      policyDecision: null,
      createdAt: now,
      resolvedAt: null,
    };

    try {
      this.itemRepository.transaction(() => {
        const insertClaim = this.claimRepository.insert(claim);
        if (insertClaim.isErr()) {
          throw insertClaim.error;
        }

        const event = this.buildEvent({
          workflowItemId: claim.workflowItemId,
          eventType: 'workflow.claim_submitted',
          actorId: claim.actorId,
          correlationId: claim.id,
          payload: {
            claimType: claim.claimType,
            action: claim.action,
            target: claim.target,
            assertedOutcome: claim.assertedOutcome,
            status: claim.status,
          },
        });
        const insertEvent = this.eventRepository.insert(event);
        if (insertEvent.isErr()) {
          throw insertEvent.error;
        }
      });

      return ok(claim);
    } catch (cause) {
      return err(this.wrapError('Failed to submit workflow claim', cause));
    }
  }

  attachEvidence(input: AttachWorkflowEvidenceInput): Result<WorkflowEvidence, WorkflowError> {
    const parsed = AttachWorkflowEvidenceInputSchema.safeParse(input);
    if (!parsed.success) {
      return err(new WorkflowError(parsed.error.issues.map((issue) => issue.message).join('; ')));
    }

    const itemResult = this.ensureWorkflowItem(parsed.data.workflowItemId);
    if (itemResult.isErr()) {
      return err(itemResult.error);
    }

    if (parsed.data.claimId) {
      const claimResult = this.claimRepository.findById(parsed.data.claimId);
      if (claimResult.isErr()) {
        return err(this.wrapError('Failed to validate workflow claim for evidence', claimResult.error));
      }
      if (claimResult.value === null) {
        return err(new WorkflowError(`Workflow claim ${parsed.data.claimId} does not exist`));
      }
    }

    const evidence: WorkflowEvidence = {
      id: parsed.data.id,
      workflowItemId: parsed.data.workflowItemId,
      claimId: parsed.data.claimId ?? null,
      evidenceType: parsed.data.evidenceType,
      source: parsed.data.source,
      locator: parsed.data.locator,
      capturedAt: parsed.data.capturedAt,
      provenance: parsed.data.provenance,
      payload: parsed.data.payload,
      createdAt: this.now(),
    };

    try {
      this.itemRepository.transaction(() => {
        const insertEvidence = this.evidenceRepository.insert(evidence);
        if (insertEvidence.isErr()) {
          throw insertEvidence.error;
        }

        const event = this.buildEvent({
          workflowItemId: evidence.workflowItemId,
          eventType: 'workflow.evidence_added',
          correlationId: evidence.id,
          payload: {
            claimId: evidence.claimId,
            evidenceType: evidence.evidenceType,
            source: evidence.source,
            locator: evidence.locator,
          },
        });
        const insertEvent = this.eventRepository.insert(event);
        if (insertEvent.isErr()) {
          throw insertEvent.error;
        }
      });

      return ok(evidence);
    } catch (cause) {
      return err(this.wrapError('Failed to attach workflow evidence', cause));
    }
  }

  requestTransition(_input: RequestWorkflowTransitionInput): Result<WorkflowDecision, WorkflowError> {
    const itemResult = this.ensureWorkflowItem(_input.workflowItemId);
    if (itemResult.isErr()) {
      return err(itemResult.error);
    }
    const item = itemResult.value;
    const decisionResult = this.evaluateTransitionDecision(item, _input.requestedState);
    if (decisionResult.isErr()) {
      return decisionResult;
    }
    const decision = decisionResult.value;
    const now = this.now();

    try {
      this.itemRepository.transaction(() => {
        const event = this.buildEvent({
          workflowItemId: item.id,
          eventType: 'workflow.transition_requested',
          actorId: _input.actorId,
          correlationId: _input.correlationId,
          payload: {
            requestedState: _input.requestedState,
            reason: _input.reason,
            decision: decision.decision,
            reasonCodes: decision.reasonCodes,
            missingEvidence: decision.missingEvidence,
          },
        });
        const insertEvent = this.eventRepository.insert(event);
        if (insertEvent.isErr()) {
          throw insertEvent.error;
        }

        if (item.rolloutMode !== 'observe' && decision.decision === 'accepted') {
          const updateItem = this.itemRepository.updateState(item.id, _input.requestedState, {
            updatedAt: now,
            completedAt:
              _input.requestedState === 'done' || _input.requestedState === 'cancelled'
                ? now
                : item.completedAt,
          });
          if (updateItem.isErr()) {
            throw updateItem.error;
          }

          const stateChangedEvent = this.buildEvent({
            workflowItemId: item.id,
            eventType: 'workflow.state_changed',
            actorId: _input.actorId,
            correlationId: _input.correlationId,
            payload: {
              fromState: item.state,
              toState: _input.requestedState,
              reason: _input.reason,
            },
          });
          const insertStateChangedEvent = this.eventRepository.insert(stateChangedEvent);
          if (insertStateChangedEvent.isErr()) {
            throw insertStateChangedEvent.error;
          }
        }
      });

      return ok(decision);
    } catch (cause) {
      return err(this.wrapError('Failed to request workflow transition', cause));
    }
  }

  acquireLease(_input: AcquireWorkflowLeaseInput): Result<WorkflowLease, WorkflowError> {
    return err(new WorkflowError('Workflow lease acquisition is not implemented yet'));
  }

  renewLease(_input: RenewWorkflowLeaseInput): Result<WorkflowLease, WorkflowError> {
    return err(new WorkflowError('Workflow lease renewal is not implemented yet'));
  }

  releaseLease(_input: ReleaseWorkflowLeaseInput): Result<void, WorkflowError> {
    return err(new WorkflowError('Workflow lease release is not implemented yet'));
  }

  evaluateDueWork(_now?: number): Result<WorkflowEvaluationSummary, WorkflowError> {
    return this.evaluateDueWorkFn?.(_now) ?? ok({ evaluatedItems: 0, interventionsRequested: 0 });
  }

  private ensureWorkflowItem(workflowItemId: string): Result<WorkflowItem, WorkflowError> {
    const itemResult = this.itemRepository.findById(workflowItemId);
    if (itemResult.isErr()) {
      return err(this.wrapError('Failed to load workflow item', itemResult.error));
    }
    if (itemResult.value === null) {
      return err(new WorkflowError(`Workflow item ${workflowItemId} does not exist`));
    }
    return ok(itemResult.value);
  }

  private buildEvent(input: {
    workflowItemId: string;
    eventType: string;
    actorId?: string | null;
    correlationId?: string | null;
    payload: Record<string, unknown>;
  }): WorkflowEvent {
    return {
      id: uuidv4(),
      workflowItemId: input.workflowItemId,
      eventType: input.eventType,
      actorId: input.actorId ?? null,
      correlationId: input.correlationId ?? null,
      payload: input.payload,
      createdAt: this.now(),
    };
  }

  private wrapError(message: string, cause: unknown): WorkflowError {
    if (cause instanceof WorkflowError) {
      return cause;
    }
    return new WorkflowError(message, cause instanceof Error ? cause : undefined);
  }

  private resolvePolicy(workflowType: string): WorkflowPolicyResolution | null {
    return this.policyRegistry?.resolve(workflowType) ?? null;
  }

  private evaluateTransitionDecision(
    item: WorkflowItem,
    requestedState: RequestWorkflowTransitionInput['requestedState'],
  ): Result<WorkflowDecision, WorkflowError> {
    if (item.rolloutMode !== 'authoritative') {
      return ok({
        decision: 'accepted',
        reasonCodes: ['transition_recorded'],
        missingEvidence: [],
        recommendedIntervention: null,
      });
    }

    const pack =
      this.policyRegistry?.getPack(item.policyPack)
      ?? (item.policyPack === orchestratorTaskPack.name ? orchestratorTaskPack : null);
    if (!pack) {
      return ok({
        decision: 'rejected',
        reasonCodes: ['policy_pack_not_found'],
        missingEvidence: [],
        recommendedIntervention: null,
      });
    }

    const evidenceResult = this.evidenceRepository.listByWorkflowItemId(item.id);
    if (evidenceResult.isErr()) {
      return err(
        this.wrapError(
          'Failed to load workflow evidence for transition decision',
          evidenceResult.error,
        ),
      );
    }

    return ok(
      pack.evaluateTransition({
        item,
        requestedState,
        evidence: evidenceResult.value,
      }),
    );
  }
}
