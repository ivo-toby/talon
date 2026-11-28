/**
 * Host-side tool: persona.task_cancel
 *
 * Cancels an A2A task previously submitted by the calling persona via
 * persona.send. Authorization is checked on the host from the trusted run
 * context: the task must live in the caller's current thread AND have been
 * submitted by the calling persona, so one persona can never cancel another's
 * delegation.
 */

import { err, ok, type Result } from 'neverthrow';
import type pino from 'pino';
import type { A2ATaskMapper } from '../../a2a/a2a-task-mapper.js';
import type { A2ATaskState, A2ATaskStatus } from '../../a2a/a2a-types.js';
import type { PersonaRepository } from '../../core/database/repositories/persona-repository.js';
import { ToolError } from '../../core/errors/error-types.js';
import type { ToolCallResult, ToolManifest } from '../tool-types.js';
import type { ToolExecutionContext } from './channel-send.js';

export interface PersonaTaskCancelTool {
  readonly manifest: ToolManifest;
}

export interface PersonaTaskCancelArgs {
  task_id: string;
  reason?: string;
}

export interface PersonaTaskCancelOutput {
  task_id: string;
  state: A2ATaskState;
  /** false when the task was already terminal; `state` is then its real state. */
  canceled: boolean;
}

const MAX_REASON_CHARS = 500;

export class PersonaTaskCancelHandler {
  static readonly manifest: ToolManifest = {
    name: 'persona.task_cancel',
    description:
      'Cancels a delegated A2A task you created via persona.send, stopping it if it is still queued or running.',
    capabilities: ['persona.send:*'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      taskMapper: A2ATaskMapper;
      personaRepo: Pick<PersonaRepository, 'findById'>;
      logger: pino.Logger;
    },
  ) {}

  execute(args: PersonaTaskCancelArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';

    this.deps.logger.info(
      {
        requestId,
        runId: context.runId,
        threadId: context.threadId,
        personaId: context.personaId,
        taskId: args?.task_id,
      },
      'persona.task_cancel: executing',
    );

    const outcome = this.cancel(args, context);
    if (outcome.isErr()) {
      this.deps.logger.warn({ requestId }, outcome.error.message);
      return Promise.resolve({
        requestId,
        tool: 'persona.task_cancel',
        status: 'error',
        error: outcome.error.message,
      });
    }
    return Promise.resolve({ requestId, tool: 'persona.task_cancel', status: 'success', result: outcome.value });
  }

  private cancel(
    args: PersonaTaskCancelArgs,
    context: ToolExecutionContext,
  ): Result<PersonaTaskCancelOutput, ToolError> {
    if (!args || typeof args.task_id !== 'string' || args.task_id.trim() === '') {
      return err(new ToolError('persona.task_cancel: task_id is required and must be a non-empty string'));
    }
    if (args.reason !== undefined && typeof args.reason !== 'string') {
      return err(new ToolError('persona.task_cancel: reason must be a string'));
    }
    const taskId = args.task_id.trim();

    const caller = this.deps.personaRepo.findById(context.personaId);
    if (caller.isErr() || !caller.value) {
      return err(new ToolError(`persona.task_cancel: could not resolve calling persona ${context.personaId}`));
    }
    const callerName = caller.value.name;

    const task = this.authorize(taskId, callerName, context.threadId);
    if (task.isErr()) return err(task.error);

    const trimmedReason = args.reason?.trim();
    const reason = trimmedReason
      ? trimmedReason.slice(0, MAX_REASON_CHARS)
      : `canceled by ${callerName} via persona_task_cancel`;

    const cancelResult = this.deps.taskMapper.cancelTask(taskId, reason);
    if (cancelResult.isErr()) {
      return err(new ToolError(`persona.task_cancel: failed to cancel task ${taskId}: ${cancelResult.error.message}`));
    }

    if (cancelResult.value) {
      return ok({ task_id: taskId, state: 'canceled', canceled: true });
    }

    // Already terminal (or finished while we were canceling): report the real state.
    const after = this.deps.taskMapper.getTaskStatus(taskId);
    if (after.isErr() || !after.value) {
      return err(new ToolError(`persona.task_cancel: task ${taskId} not found`));
    }
    return ok({ task_id: taskId, state: after.value.state, canceled: false });
  }

  private authorize(
    taskId: string,
    callerName: string,
    threadId: string,
  ): Result<A2ATaskStatus, ToolError> {
    const status = this.deps.taskMapper.getTaskStatus(taskId);
    if (status.isErr()) {
      return err(new ToolError(`persona.task_cancel: failed to load task ${taskId}: ${status.error.message}`));
    }
    if (!status.value) {
      return err(new ToolError(`persona.task_cancel: task ${taskId} not found`));
    }
    if (status.value.threadId !== threadId) {
      return err(new ToolError(`persona.task_cancel: task ${taskId} does not belong to the current thread`));
    }
    if (status.value.sourcePersona !== callerName) {
      return err(
        new ToolError(`persona.task_cancel: task ${taskId} was not submitted by this persona; only the delegating persona can cancel it`),
      );
    }
    return ok(status.value);
  }
}
