/**
 * Host-side tool: persona.send
 *
 * Submits a task to another persona over Talon's internal A2A layer.
 */

import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from 'neverthrow';
import type pino from 'pino';
import type { A2ATaskMapper } from '../../a2a/a2a-task-mapper.js';
import type { A2ATaskRow, A2ATaskState } from '../../a2a/a2a-types.js';
import type { A2ATaskRepository } from '../../core/database/repositories/a2a-task-repository.js';
import type { PersonaRepository } from '../../core/database/repositories/persona-repository.js';
import { ToolError } from '../../core/errors/error-types.js';
import type { ToolCallResult, ToolManifest } from '../tool-types.js';
import type { ToolExecutionContext } from './channel-send.js';
import {
  PERSONA_SEND_DEFAULT_MAX_WAIT_MS,
  PERSONA_TASK_WAIT_MAX_MS,
  resolvePersonaTaskWaitMs,
} from '../tool-timeouts.js';
import type { WorkflowKernelService } from '../../workflow/workflow-service.js';
import {
  mapA2ATaskStateToWorkflowState,
  ORCHESTRATOR_TASK_WORKFLOW_TYPE,
  orchestratorTaskDefaults,
} from '../../workflow/packs/orchestrator-task-pack.js';

export interface PersonaSendTool {
  readonly manifest: ToolManifest;
}

export interface PersonaSendArgs {
  target_persona: string;
  message: string;
  await_reply?: boolean;
  timeout_ms?: number;
  workflow_type?: string;
}

type PersonaSendState = A2ATaskState | 'timeout';

interface PersonaSendOutput {
  task_id: string;
  state: PersonaSendState;
  workflow_item_id?: string;
  result?: string;
  error?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const TERMINAL_STATES = new Set<A2ATaskState>(['completed', 'failed', 'canceled', 'input-required']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class PersonaSendHandler {
  static readonly manifest: ToolManifest = {
    name: 'persona.send',
    description: 'Sends a task to another persona via the A2A layer.',
    capabilities: ['persona.send:*'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      taskMapper: A2ATaskMapper;
      taskRepo: A2ATaskRepository;
      personaRepo: PersonaRepository;
      workflowService?: WorkflowKernelService;
      logger: pino.Logger;
      maxWaitMs?: number;
      pollIntervalMs?: number;
    },
  ) {}

  async execute(args: PersonaSendArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';

    this.deps.logger.info(
      {
        requestId,
        runId: context.runId,
        threadId: context.threadId,
        personaId: context.personaId,
        targetPersona: args.target_persona,
        awaitReply: args.await_reply ?? false,
      },
      'persona.send: executing',
    );

    const validatedArgs = this.validateArgs(args);
    if (validatedArgs.isErr()) {
      this.deps.logger.warn({ requestId }, validatedArgs.error.message);
      return this.errorResult(requestId, validatedArgs.error.message);
    }

    const sourcePersona = this.resolveSourcePersona(context.personaId);
    if (sourcePersona.isErr()) {
      this.deps.logger.error({ requestId, personaId: context.personaId }, sourcePersona.error.message);
      return this.errorResult(requestId, sourcePersona.error.message);
    }

    const workflowItemIdResult = this.maybeCreateWorkflowItem(validatedArgs.value, context);
    if (workflowItemIdResult.isErr()) {
      return this.errorResult(requestId, workflowItemIdResult.error.message);
    }
    const workflowItemId = workflowItemIdResult.value;

    const submitResult = this.deps.taskMapper.submitTask({
      sourcePersona: sourcePersona.value,
      targetPersona: validatedArgs.value.target_persona,
      sourceThreadId: context.threadId,
      content: validatedArgs.value.message,
      hopCount: (context.a2aHopCount ?? 0) + 1,
      ...(workflowItemId ? { workflowItemId } : {}),
      ...(context.a2aTaskId ? { parentTaskId: context.a2aTaskId } : {}),
    });

    if (submitResult.isErr()) {
      const message = `persona.send: submit failed - ${submitResult.error.message}`;
      this.deps.logger.warn(
        { requestId, targetPersona: validatedArgs.value.target_persona, err: submitResult.error },
        message,
      );
      return this.errorResult(requestId, message);
    }

    this.recordWorkflowSubmission(workflowItemId, submitResult.value.taskId, context);

    if (!validatedArgs.value.await_reply) {
      return this.successResult(requestId, {
        task_id: submitResult.value.taskId,
        state: 'submitted',
        ...(workflowItemId ? { workflow_item_id: workflowItemId } : {}),
      });
    }

    const awaitedResult = await this.pollUntilTerminal(
      submitResult.value.taskId,
      resolvePersonaTaskWaitMs(validatedArgs.value.timeout_ms, this.deps.maxWaitMs),
      workflowItemId,
    );
    if (awaitedResult.isErr()) {
      this.deps.logger.error({ requestId, taskId: submitResult.value.taskId }, awaitedResult.error.message);
      return this.errorResult(requestId, awaitedResult.error.message);
    }

    return this.successResult(requestId, awaitedResult.value);
  }

  private validateArgs(args: PersonaSendArgs): Result<PersonaSendArgs, ToolError> {
    if (!args.target_persona || typeof args.target_persona !== 'string' || args.target_persona.trim() === '') {
      return err(new ToolError('persona.send: target_persona is required and must be a non-empty string'));
    }

    if (!args.message || typeof args.message !== 'string' || args.message.trim() === '') {
      return err(new ToolError('persona.send: message is required and must be a non-empty string'));
    }

    if (args.await_reply !== undefined && typeof args.await_reply !== 'boolean') {
      return err(new ToolError('persona.send: await_reply must be a boolean'));
    }

    if (
      args.timeout_ms !== undefined
      && (!Number.isInteger(args.timeout_ms) || args.timeout_ms <= 0 || args.timeout_ms > PERSONA_TASK_WAIT_MAX_MS)
    ) {
      return err(
        new ToolError(
          `persona.send: timeout_ms must be a positive integer no greater than ${PERSONA_TASK_WAIT_MAX_MS}`,
        ),
      );
    }

    if (
      args.workflow_type !== undefined &&
      args.workflow_type !== ORCHESTRATOR_TASK_WORKFLOW_TYPE
    ) {
      return err(
        new ToolError(`persona.send: workflow_type must be "${ORCHESTRATOR_TASK_WORKFLOW_TYPE}" when provided`),
      );
    }

    return ok({
      target_persona: args.target_persona.trim(),
      message: args.message.trim(),
      await_reply: args.await_reply ?? false,
      ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}),
      ...(args.workflow_type !== undefined ? { workflow_type: args.workflow_type } : {}),
    });
  }

  private resolveSourcePersona(personaId: string): Result<string, ToolError> {
    const personaResult = this.deps.personaRepo.findById(personaId);
    if (personaResult.isErr()) {
      return err(
        new ToolError(`persona.send: failed to resolve source persona ${personaId}: ${personaResult.error.message}`),
      );
    }

    if (!personaResult.value) {
      return err(new ToolError(`persona.send: source persona ${personaId} not found`));
    }

    return ok(personaResult.value.name);
  }

  private async pollUntilTerminal(
    taskId: string,
    maxWaitMs: number = PERSONA_SEND_DEFAULT_MAX_WAIT_MS,
    workflowItemId?: string,
  ): Promise<Result<PersonaSendOutput, ToolError>> {
    const pollIntervalMs = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + maxWaitMs;
    let lastObservedState: A2ATaskState | null = null;

    while (true) {
      const rowResult = this.deps.taskRepo.findById(taskId);
      if (rowResult.isErr()) {
        return err(new ToolError(`persona.send: failed to load task ${taskId}: ${rowResult.error.message}`));
      }

      if (!rowResult.value) {
        return err(new ToolError(`persona.send: task ${taskId} not found after submission`));
      }

      this.deps.logger.debug({ taskId, state: rowResult.value.state }, 'persona.send: polled task state');

      if (workflowItemId && rowResult.value.state !== lastObservedState) {
        this.recordWorkflowTaskState(workflowItemId, rowResult.value);
        lastObservedState = rowResult.value.state;
      }

      if (TERMINAL_STATES.has(rowResult.value.state)) {
        return ok(this.toOutput(rowResult.value, workflowItemId));
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }

      await sleep(Math.min(pollIntervalMs, remaining));
    }

    // TODO: cancel the in-flight task when polling times out to avoid orphaned A2A runs.
    // Requires a task cancellation API in A2ATaskMapper.
    return ok({
      task_id: taskId,
      state: 'timeout',
      ...(workflowItemId ? { workflow_item_id: workflowItemId } : {}),
      error: 'Timed out waiting for delegated persona reply. The delegated task may still complete asynchronously. Use persona_task_status with this task_id to fetch the final result later.',
    });
  }

  private toOutput(row: A2ATaskRow, workflowItemId?: string): PersonaSendOutput {
    if (row.state === 'completed') {
      const result = this.parseResultPayload(row.result_payload);
      return {
        task_id: row.id,
        state: 'completed',
        ...(workflowItemId ? { workflow_item_id: workflowItemId } : {}),
        ...(result ? { result } : {}),
      };
    }

    if (row.state === 'failed') {
      return {
        task_id: row.id,
        state: 'failed',
        ...(workflowItemId ? { workflow_item_id: workflowItemId } : {}),
        error: row.error_message ?? row.error_code ?? 'Task failed',
      };
    }

    // covers 'canceled' and 'input-required'
    return {
      task_id: row.id,
      state: row.state,
      ...(workflowItemId ? { workflow_item_id: workflowItemId } : {}),
    };
  }

  private parseResultPayload(payload: string | null): string | undefined {
    if (!payload) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(payload) as { text?: unknown };
      return typeof parsed.text === 'string' && parsed.text.trim() !== '' ? parsed.text : undefined;
    } catch {
      return undefined;
    }
  }

  private successResult(requestId: string, result: PersonaSendOutput): ToolCallResult {
    return {
      requestId,
      tool: 'persona.send',
      status: 'success',
      result,
    };
  }

  private errorResult(requestId: string, error: string): ToolCallResult {
    return {
      requestId,
      tool: 'persona.send',
      status: 'error',
      error,
    };
  }

  private maybeCreateWorkflowItem(
    args: PersonaSendArgs,
    context: ToolExecutionContext,
  ): Result<string | undefined, ToolError> {
    if (args.workflow_type !== ORCHESTRATOR_TASK_WORKFLOW_TYPE) {
      return ok(undefined);
    }

    if (!this.deps.workflowService) {
      return err(new ToolError('persona.send: workflow service is not available'));
    }

    const defaults = orchestratorTaskDefaults();
    const createItem = this.deps.workflowService.createItem({
      id: randomUUID(),
      workflowType: defaults.workflowType,
      domain: 'operations',
      title: `Delegate to ${args.target_persona}`,
      goal: {
        targetPersona: args.target_persona,
        message: args.message,
      },
      priority: 0,
      ownerActorId: context.personaId,
      sourceThreadId: context.threadId,
      sourceRunId: context.runId,
      rolloutMode: defaults.rolloutMode,
      policyPack: defaults.policyPack,
      policyVersion: defaults.policyVersion,
    });
    if (createItem.isErr()) {
      return err(new ToolError(`persona.send: failed to create workflow item: ${createItem.error.message}`));
    }

    return ok(createItem.value.id);
  }

  private recordWorkflowSubmission(
    workflowItemId: string | undefined,
    taskId: string,
    context: ToolExecutionContext,
  ): void {
    if (!workflowItemId || !this.deps.workflowService) {
      return;
    }

    this.deps.workflowService.attachEvidence({
      id: randomUUID(),
      workflowItemId,
      claimId: null,
      evidenceType: 'a2a_task_submitted',
      source: 'a2a_task',
      locator: `task:${taskId}`,
      capturedAt: Date.now(),
      provenance: {
        tool: 'persona.send',
        runId: context.runId,
        threadId: context.threadId,
        personaId: context.personaId,
      },
      payload: {
        state: 'submitted',
      },
    });
    this.deps.workflowService.requestTransition({
      workflowItemId,
      requestedState: 'ready',
      actorId: context.personaId,
      reason: 'a2a_submitted',
      correlationId: taskId,
    });
  }

  private recordWorkflowTaskState(workflowItemId: string, row: A2ATaskRow): void {
    if (!this.deps.workflowService) {
      return;
    }

    if (row.state === 'completed') {
      this.deps.workflowService.attachEvidence({
        id: randomUUID(),
        workflowItemId,
        claimId: null,
        evidenceType: 'a2a_task_completed',
        source: 'a2a_task',
        locator: `task:${row.id}`,
        capturedAt: row.completed_at ?? row.updated_at,
        provenance: {
          taskId: row.id,
          state: row.state,
        },
        payload: {
          resultPayload: row.result_payload,
        },
      });
    }

    this.deps.workflowService.requestTransition({
      workflowItemId,
      requestedState: mapA2ATaskStateToWorkflowState(row.state),
      actorId: row.source_persona,
      reason: `a2a_${row.state}`,
      correlationId: row.id,
    });
  }
}
