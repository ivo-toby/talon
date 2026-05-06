import { v4 as uuidv4 } from 'uuid';
import { err, ok, type Result } from 'neverthrow';

import type { ToolCallResult } from '../tools/tool-types.js';
import type { BackgroundTask, BackgroundTaskResult } from '../subagents/background/background-agent-types.js';
import type { AttachWorkflowEvidenceInput } from './workflow-types.js';
import { WorkflowError } from './workflow-types.js';

export class WorkflowEvidenceAdapter {
  fromToolResult(input: {
    workflowItemId: string;
    claimId?: string | null;
    toolResult: ToolCallResult;
  }): Result<AttachWorkflowEvidenceInput, WorkflowError> {
    const evidence = input.toolResult.workflowMetadata?.evidence;
    if (!evidence) {
      return err(new WorkflowError('Tool result does not carry workflow evidence metadata'));
    }

    return ok({
      id: uuidv4(),
      workflowItemId: input.workflowItemId,
      claimId: input.claimId ?? null,
      evidenceType: evidence.evidenceType,
      source: evidence.source,
      locator: evidence.locator,
      capturedAt: evidence.capturedAt,
      provenance: evidence.provenance,
      payload: {
        tool: input.toolResult.tool,
        requestId: input.toolResult.requestId,
        status: input.toolResult.status,
        ...evidence.payload,
      },
    });
  }

  fromBackgroundTask(input: {
    workflowItemId: string;
    claimId?: string | null;
    task: BackgroundTask;
    taskResult?: BackgroundTaskResult | null;
  }): Result<AttachWorkflowEvidenceInput, WorkflowError> {
    const status = input.taskResult?.status ?? input.task.status;
    const evidenceType = this.backgroundTaskEvidenceType(status);
    if (!evidenceType) {
      return err(new WorkflowError(`Unsupported background task status for workflow evidence: ${status}`));
    }

    return ok({
      id: uuidv4(),
      workflowItemId: input.workflowItemId,
      claimId: input.claimId ?? null,
      evidenceType,
      source: 'background_task',
      locator: `task:${input.task.id}`,
      capturedAt: input.task.completedAt ?? input.task.createdAt,
      provenance: {
        taskId: input.task.id,
        providerName: input.task.providerName,
        threadId: input.task.threadId,
        personaId: input.task.personaId,
      },
      payload: {
        status,
        output: input.taskResult?.output ?? input.task.output,
        error: input.taskResult?.error ?? input.task.error,
        durationSeconds: input.taskResult?.durationSeconds ?? null,
        workingDirectory: input.task.workingDirectory,
        sandboxEnabled: input.task.sandboxEnabled,
        primaryExecutionEnvId: input.task.primaryExecutionEnvId,
      },
    });
  }

  private backgroundTaskEvidenceType(status: BackgroundTask['status']): string | null {
    switch (status) {
      case 'running':
        return 'background_task_spawned';
      case 'completed':
        return 'background_task_completed';
      case 'timed_out':
        return 'background_task_timed_out';
      case 'failed':
        return 'background_task_failed';
      default:
        return null;
    }
  }
}
