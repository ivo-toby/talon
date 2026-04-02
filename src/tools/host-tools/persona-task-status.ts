/**
 * Host-side tool: persona.task_status
 *
 * Reads the status/result of an A2A task previously submitted via persona.send.
 */

import { err, ok, type Result } from 'neverthrow';
import type pino from 'pino';
import type { A2ATaskMapper } from '../../a2a/a2a-task-mapper.js';
import type { A2ATaskState } from '../../a2a/a2a-types.js';
import { ToolError } from '../../core/errors/error-types.js';
import type { ToolCallResult, ToolManifest } from '../tool-types.js';
import type { ToolExecutionContext } from './channel-send.js';
import { PERSONA_TASK_WAIT_MAX_MS, resolvePersonaTaskWaitMs } from '../tool-timeouts.js';

export interface PersonaTaskStatusTool {
  readonly manifest: ToolManifest;
}

export interface PersonaTaskStatusArgs {
  task_id: string;
  wait_ms?: number;
}

export interface PersonaTaskStatusOutput {
  task_id: string;
  state: A2ATaskState;
  source_persona: string;
  target_persona: string;
  completed_at?: number;
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

export class PersonaTaskStatusHandler {
  static readonly manifest: ToolManifest = {
    name: 'persona.task_status',
    description: 'Fetches the status or final result of a delegated A2A task created via persona.send.',
    capabilities: ['persona.send:*'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      taskMapper: A2ATaskMapper;
      logger: pino.Logger;
      pollIntervalMs?: number;
    },
  ) {}

  async execute(args: PersonaTaskStatusArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';

    this.deps.logger.info(
      {
        requestId,
        runId: context.runId,
        threadId: context.threadId,
        personaId: context.personaId,
        taskId: args.task_id,
        waitMs: args.wait_ms ?? 0,
      },
      'persona.task_status: executing',
    );

    const validated = this.validateArgs(args);
    if (validated.isErr()) {
      return this.errorResult(requestId, validated.error.message);
    }

    const waitMs = resolvePersonaTaskWaitMs(validated.value.wait_ms, 0);
    const statusResult = waitMs > 0
      ? await this.pollUntilTerminal(validated.value.task_id, waitMs, context.threadId)
      : this.loadStatus(validated.value.task_id, context.threadId);
    if (statusResult.isErr()) {
      return this.errorResult(requestId, statusResult.error.message);
    }

    return {
      requestId,
      tool: 'persona.task_status',
      status: 'success',
      result: statusResult.value,
    };
  }

  private validateArgs(args: PersonaTaskStatusArgs): Result<PersonaTaskStatusArgs, ToolError> {
    if (!args.task_id || typeof args.task_id !== 'string' || args.task_id.trim() === '') {
      return err(new ToolError('persona.task_status: task_id is required and must be a non-empty string'));
    }

    if (
      args.wait_ms !== undefined
      && (!Number.isInteger(args.wait_ms) || args.wait_ms < 0 || args.wait_ms > PERSONA_TASK_WAIT_MAX_MS)
    ) {
      return err(
        new ToolError(
          `persona.task_status: wait_ms must be an integer between 0 and ${PERSONA_TASK_WAIT_MAX_MS}`,
        ),
      );
    }

    return ok({
      task_id: args.task_id.trim(),
      ...(args.wait_ms !== undefined ? { wait_ms: args.wait_ms } : {}),
    });
  }

  private loadStatus(taskId: string, threadId: string): Result<PersonaTaskStatusOutput, ToolError> {
    const result = this.deps.taskMapper.getTaskStatus(taskId);
    if (result.isErr()) {
      return err(new ToolError(`persona.task_status: failed to load task ${taskId}: ${result.error.message}`));
    }

    if (!result.value) {
      return err(new ToolError(`persona.task_status: task ${taskId} not found`));
    }

    if (result.value.threadId !== threadId) {
      return err(new ToolError(`persona.task_status: task ${taskId} does not belong to the current thread`));
    }

    return ok({
      task_id: result.value.taskId,
      state: result.value.state,
      source_persona: result.value.sourcePersona,
      target_persona: result.value.targetPersona,
      ...(result.value.completedAt !== undefined ? { completed_at: result.value.completedAt } : {}),
      ...(result.value.result?.text ? { result: result.value.result.text } : {}),
      ...(result.value.error?.message ? { error: result.value.error.message } : {}),
    });
  }

  private async pollUntilTerminal(
    taskId: string,
    waitMs: number,
    threadId: string,
  ): Promise<Result<PersonaTaskStatusOutput, ToolError>> {
    const pollIntervalMs = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + waitMs;
    let lastStatus: PersonaTaskStatusOutput | null = null;

    while (true) {
      const status = this.loadStatus(taskId, threadId);
      if (status.isErr()) {
        return status;
      }
      lastStatus = status.value;

      if (TERMINAL_STATES.has(status.value.state)) {
        return ok(status.value);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }

      await sleep(Math.min(pollIntervalMs, remaining));
    }

    return ok({
      ...(lastStatus ?? {
        task_id: taskId,
        state: 'submitted' as const,
        source_persona: '',
        target_persona: '',
      }),
      error: 'Timed out waiting for delegated task to reach a terminal state.',
    });
  }

  private errorResult(requestId: string, error: string): ToolCallResult {
    return {
      requestId,
      tool: 'persona.task_status',
      status: 'error',
      error,
    };
  }
}
