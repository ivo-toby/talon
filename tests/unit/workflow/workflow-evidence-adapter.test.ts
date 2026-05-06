import { describe, expect, it } from 'vitest';

import { WorkflowEvidenceAdapter } from '../../../src/workflow/workflow-evidence-adapter.js';
import type { ToolCallResult } from '../../../src/tools/tool-types.js';
import type { BackgroundTask, BackgroundTaskResult } from '../../../src/subagents/background/background-agent-types.js';

function makeToolResult(): ToolCallResult {
  return {
    requestId: 'req-001',
    tool: 'subagent.background',
    status: 'success',
    result: { taskId: 'task-123' },
    workflowMetadata: {
      evidence: {
        evidenceType: 'background_task_spawned',
        source: 'background_task',
        locator: 'task:task-123',
        capturedAt: 1_000,
        provenance: {
          tool: 'subagent.background',
          runId: 'run-001',
          threadId: 'thread-001',
          requestId: 'req-001',
        },
        payload: {
          status: 'running',
        },
      },
    },
  };
}

function makeBackgroundTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: 'task-123',
    personaId: 'persona-001',
    providerName: 'claude-code',
    threadId: 'thread-001',
    channelId: 'channel-001',
    prompt: 'Investigate this issue',
    workingDirectory: '/workspace/repo',
    status: 'running',
    output: null,
    error: null,
    pid: 4242,
    createdAt: 1_000,
    startedAt: 1_000,
    completedAt: null,
    timeoutMinutes: 30,
    parentTraceparent: null,
    sandboxEnabled: false,
    primaryExecutionEnvId: null,
    ...overrides,
  };
}

function makeBackgroundResult(overrides: Partial<BackgroundTaskResult> = {}): BackgroundTaskResult {
  return {
    taskId: 'task-123',
    providerName: 'claude-code',
    status: 'completed',
    output: 'Done',
    error: null,
    durationSeconds: 12,
    ...overrides,
  };
}

describe('WorkflowEvidenceAdapter', () => {
  it('normalizes tool-call workflow metadata into workflow evidence input', () => {
    const adapter = new WorkflowEvidenceAdapter();

    const result = adapter.fromToolResult({
      workflowItemId: 'workflow-123',
      toolResult: makeToolResult(),
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(
      expect.objectContaining({
        workflowItemId: 'workflow-123',
        evidenceType: 'background_task_spawned',
        source: 'background_task',
        locator: 'task:task-123',
        capturedAt: 1_000,
        provenance: expect.objectContaining({
          tool: 'subagent.background',
          runId: 'run-001',
          requestId: 'req-001',
        }),
      }),
    );
  });

  it.each([
    ['running', 'background_task_spawned'],
    ['completed', 'background_task_completed'],
    ['timed_out', 'background_task_timed_out'],
    ['failed', 'background_task_failed'],
  ] as const)(
    'maps %s background task state into %s evidence',
    (status, evidenceType) => {
      const adapter = new WorkflowEvidenceAdapter();
      const task = makeBackgroundTask({
        status,
        completedAt: status === 'running' ? null : 2_000,
        output: status === 'completed' ? 'Done' : null,
        error: status === 'failed' ? 'process crashed' : null,
      });
      const taskResult = makeBackgroundResult({
        status,
        output: status === 'completed' ? 'Done' : null,
        error:
          status === 'failed'
            ? 'process crashed'
            : status === 'timed_out'
              ? 'Process timed out'
              : null,
      });

      const result = adapter.fromBackgroundTask({
        workflowItemId: 'workflow-123',
        task,
        taskResult,
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual(
        expect.objectContaining({
          workflowItemId: 'workflow-123',
          evidenceType,
          source: 'background_task',
          locator: 'task:task-123',
        }),
      );
    },
  );
});
