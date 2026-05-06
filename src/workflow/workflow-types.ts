import { z } from 'zod';

const JsonRecordSchema = z.record(z.string(), z.unknown());

export const WorkflowStateSchema = z.enum([
  'intake',
  'ready',
  'in_progress',
  'awaiting_validation',
  'blocked',
  'escalated',
  'done',
  'cancelled',
]);

export const WorkflowRolloutModeSchema = z.enum(['observe', 'guided', 'authoritative']);
export const WorkflowActorKindSchema = z.enum(['persona', 'human', 'system', 'background_agent', 'tool']);
export const WorkflowClaimStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'superseded']);
export const WorkflowLeaseStateSchema = z.enum(['active', 'expired', 'released']);
export const WorkflowInterventionStatusSchema = z.enum(['pending', 'applied', 'dismissed']);
export const WorkflowDecisionStateSchema = z.enum(['accepted', 'rejected', 'deferred']);

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;
export type WorkflowRolloutMode = z.infer<typeof WorkflowRolloutModeSchema>;
export type WorkflowActorKind = z.infer<typeof WorkflowActorKindSchema>;
export type WorkflowClaimStatus = z.infer<typeof WorkflowClaimStatusSchema>;
export type WorkflowLeaseState = z.infer<typeof WorkflowLeaseStateSchema>;
export type WorkflowInterventionStatus = z.infer<typeof WorkflowInterventionStatusSchema>;
export type WorkflowDecisionState = z.infer<typeof WorkflowDecisionStateSchema>;
export type WorkflowJson = Record<string, unknown>;

export interface WorkflowItem {
  id: string;
  workflowType: string;
  domain: string;
  title: string;
  goal: WorkflowJson;
  state: WorkflowState;
  statusReason: string | null;
  rolloutMode: WorkflowRolloutMode;
  policyPack: string;
  policyVersion: string;
  ownerActorId: string | null;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  sourceRunId: string | null;
  priority: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface WorkflowClaim {
  id: string;
  workflowItemId: string;
  claimType: string;
  actorId: string;
  actorKind: WorkflowActorKind;
  action: string;
  target: string;
  assertedOutcome: string;
  summary: string;
  payload: WorkflowJson;
  status: WorkflowClaimStatus;
  policyDecision: WorkflowJson | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface WorkflowEvidence {
  id: string;
  workflowItemId: string;
  claimId: string | null;
  evidenceType: string;
  source: string;
  locator: string;
  capturedAt: number;
  provenance: WorkflowJson;
  payload: WorkflowJson;
  createdAt: number;
}

export interface WorkflowEvent {
  id: string;
  workflowItemId: string;
  eventType: string;
  actorId: string | null;
  correlationId: string | null;
  payload: WorkflowJson;
  createdAt: number;
}

export interface WorkflowLease {
  id: string;
  workflowItemId: string;
  actorId: string;
  actorKind: WorkflowActorKind;
  leaseState: WorkflowLeaseState;
  acquiredAt: number;
  renewedAt: number | null;
  expiresAt: number;
  releasedAt: number | null;
}

export interface WorkflowIntervention {
  id: string;
  workflowItemId: string;
  interventionType: string;
  reason: string;
  status: WorkflowInterventionStatus;
  payload: WorkflowJson;
  createdAt: number;
  resolvedAt: number | null;
}

export interface WorkflowDecision {
  decision: WorkflowDecisionState;
  reasonCodes: string[];
  missingEvidence: string[];
  recommendedIntervention: string | null;
}

export interface WorkflowEvaluationSummary {
  evaluatedItems: number;
  interventionsRequested: number;
}

export const CreateWorkflowItemInputSchema = z.object({
  id: z.string().min(1),
  workflowType: z.string().min(1),
  domain: z.string().min(1),
  title: z.string().min(1),
  goal: JsonRecordSchema,
  ownerActorId: z.string().min(1).optional(),
  sourceThreadId: z.string().min(1).optional(),
  sourceMessageId: z.string().min(1).optional(),
  sourceRunId: z.string().min(1).optional(),
  priority: z.number().int().default(0),
  rolloutMode: WorkflowRolloutModeSchema.optional(),
  policyPack: z.string().min(1).optional(),
  policyVersion: z.string().min(1).optional(),
});

export const SubmitWorkflowClaimInputSchema = z.object({
  id: z.string().min(1),
  workflowItemId: z.string().min(1),
  claimType: z.string().min(1),
  actorId: z.string().min(1),
  actorKind: WorkflowActorKindSchema,
  action: z.string().min(1),
  target: z.string().min(1),
  assertedOutcome: z.string().min(1),
  summary: z.string().min(1),
  payload: JsonRecordSchema.default({}),
});

export const AttachWorkflowEvidenceInputSchema = z.object({
  id: z.string().min(1),
  workflowItemId: z.string().min(1),
  claimId: z.string().min(1).nullable().optional(),
  evidenceType: z.string().min(1),
  source: z.string().min(1),
  locator: z.string().min(1),
  capturedAt: z.number().int().nonnegative(),
  provenance: JsonRecordSchema,
  payload: JsonRecordSchema.default({}),
});

export type CreateWorkflowItemInput = z.infer<typeof CreateWorkflowItemInputSchema>;
export type SubmitWorkflowClaimInput = z.infer<typeof SubmitWorkflowClaimInputSchema>;
export type AttachWorkflowEvidenceInput = z.infer<typeof AttachWorkflowEvidenceInputSchema>;

export interface RequestWorkflowTransitionInput {
  workflowItemId: string;
  requestedState: WorkflowState;
  actorId: string;
  reason: string;
  correlationId?: string;
}

export interface AcquireWorkflowLeaseInput {
  id: string;
  workflowItemId: string;
  actorId: string;
  actorKind: WorkflowActorKind;
  expiresAt: number;
}

export interface RenewWorkflowLeaseInput {
  leaseId: string;
  expiresAt: number;
}

export interface ReleaseWorkflowLeaseInput {
  leaseId: string;
}

export class WorkflowError extends Error {
  constructor(message: string, readonly cause?: Error) {
    super(message);
    this.name = 'WorkflowError';
  }
}
