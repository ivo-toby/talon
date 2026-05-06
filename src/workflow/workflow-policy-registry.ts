import type { WorkflowConfig } from '../core/config/config-types.js';
import type { WorkflowRolloutMode } from './workflow-types.js';
import {
  orchestratorTaskPack,
  type WorkflowPolicyPack,
} from './packs/orchestrator-task-pack.js';

export interface WorkflowPolicyResolution {
  workflowType: string;
  rolloutMode: WorkflowRolloutMode;
  policyPack: string;
  policyVersion: string;
  pack: WorkflowPolicyPack | null;
}

export class WorkflowPolicyRegistry {
  private readonly bindings: WorkflowConfig['bindings'];
  private readonly packs = new Map<string, WorkflowPolicyPack>([
    [orchestratorTaskPack.name, orchestratorTaskPack],
  ]);

  constructor(config: Pick<WorkflowConfig, 'bindings'>) {
    this.bindings = config.bindings;
  }

  resolve(workflowType: string): WorkflowPolicyResolution | null {
    const binding = this.bindings.find((candidate) => candidate.workflowType === workflowType);
    if (!binding) {
      return null;
    }

    const pack = this.packs.get(binding.policyPack) ?? null;
    return {
      workflowType,
      rolloutMode: binding.rolloutMode,
      policyPack: binding.policyPack,
      policyVersion: pack?.version ?? '1',
      pack,
    };
  }

  getPack(policyPack: string): WorkflowPolicyPack | null {
    return this.packs.get(policyPack) ?? null;
  }
}
