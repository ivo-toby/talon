import type { A2ATaskState } from '../../a2a/a2a-types.js';
import type {
  WorkflowDecision,
  WorkflowEvidence,
  WorkflowItem,
  WorkflowRolloutMode,
  WorkflowState,
} from '../workflow-types.js';

export interface WorkflowPolicyPack {
  name: string;
  version: string;
  evaluateTransition(input: {
    item: WorkflowItem;
    requestedState: WorkflowState;
    evidence: WorkflowEvidence[];
  }): WorkflowDecision;
}

export const ORCHESTRATOR_TASK_WORKFLOW_TYPE = 'orchestrator_task';
export const ORCHESTRATOR_TASK_POLICY_PACK = 'orchestrator-task';
export const ORCHESTRATOR_TASK_POLICY_VERSION = '1';

const REQUIRED_COMPLETION_EVIDENCE = new Set(['a2a_task_completed']);

export const orchestratorTaskPack: WorkflowPolicyPack = {
  name: ORCHESTRATOR_TASK_POLICY_PACK,
  version: ORCHESTRATOR_TASK_POLICY_VERSION,
  evaluateTransition(input) {
    if (input.requestedState === 'done') {
      const hasCompletionEvidence = input.evidence.some((evidence) =>
        REQUIRED_COMPLETION_EVIDENCE.has(evidence.evidenceType),
      );
      if (!hasCompletionEvidence) {
        return {
          decision: 'rejected',
          reasonCodes: ['missing_required_evidence'],
          missingEvidence: ['a2a_task_completed'],
          recommendedIntervention: 'request_missing_evidence',
        };
      }
    }

    return {
      decision: 'accepted',
      reasonCodes: ['transition_accepted'],
      missingEvidence: [],
      recommendedIntervention: null,
    };
  },
};

export function orchestratorTaskDefaults(): {
  workflowType: string;
  rolloutMode: WorkflowRolloutMode;
  policyPack: string;
  policyVersion: string;
} {
  return {
    workflowType: ORCHESTRATOR_TASK_WORKFLOW_TYPE,
    rolloutMode: 'authoritative',
    policyPack: ORCHESTRATOR_TASK_POLICY_PACK,
    policyVersion: ORCHESTRATOR_TASK_POLICY_VERSION,
  };
}

export function mapA2ATaskStateToWorkflowState(state: A2ATaskState): WorkflowState {
  switch (state) {
    case 'submitted':
      return 'ready';
    case 'working':
      return 'in_progress';
    case 'input-required':
      return 'blocked';
    case 'completed':
      return 'done';
    case 'failed':
      return 'escalated';
    case 'canceled':
      return 'cancelled';
  }
}
