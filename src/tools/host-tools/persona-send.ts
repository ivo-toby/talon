/**
 * Host-side tool: persona.send
 *
 * Submits a task to another persona over Talon's internal A2A layer.
 */

import { err, ok, type Result } from 'neverthrow';
import type pino from 'pino';
import type { A2ATaskMapper } from '../../a2a/a2a-task-mapper.js';
import type { A2ATaskRow, A2ATaskState } from '../../a2a/a2a-types.js';
import type { A2ATaskRepository } from '../../core/database/repositories/a2a-task-repository.js';
import type { PersonaRepository } from '../../core/database/repositories/persona-repository.js';
import { ToolError } from '../../core/errors/error-types.js';
import type { ToolCallResult, ToolManifest } from '../tool-types.js';
import type { ToolExecutionContext } from './channel-send.js';
import { PERSONA_SEND_DEFAULT_MAX_WAIT_MS } from '../tool-timeouts.js';

export interface PersonaSendTool {
  readonly manifest: ToolManifest;
}

export interface PersonaSendArgs {
  target_persona: string;
  message: string;
  await_reply?: boolean;
}

type PersonaSendState = A2ATaskState | 'timeout';

interface PersonaSendOutput {
  task_id: string;
  state: PersonaSendState;
  result?: string;
  error?: string;
}

// Must be less than the bridge REQUEST_TIMEOUT_MS (30_000) so polling always
// returns a clean timeout result before the transport layer cuts the connection.
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

    const submitResult = this.deps.taskMapper.submitTask({
      sourcePersona: sourcePersona.value,
      targetPersona: validatedArgs.value.target_persona,
      sourceThreadId: context.threadId,
      content: validatedArgs.value.message,
      hopCount: (context.a2aHopCount ?? 0) + 1,
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

    if (!validatedArgs.value.await_reply) {
      return this.successResult(requestId, {
        task_id: submitResult.value.taskId,
        state: 'submitted',
      });
    }

    const awaitedResult = await this.pollUntilTerminal(submitResult.value.taskId);
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

    return ok({
      target_persona: args.target_persona.trim(),
      message: args.message.trim(),
      await_reply: args.await_reply ?? false,
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

  private async pollUntilTerminal(taskId: string): Promise<Result<PersonaSendOutput, ToolError>> {
    const maxWaitMs = this.deps.maxWaitMs ?? PERSONA_SEND_DEFAULT_MAX_WAIT_MS;
    const pollIntervalMs = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + maxWaitMs;

    while (true) {
      const rowResult = this.deps.taskRepo.findById(taskId);
      if (rowResult.isErr()) {
        return err(new ToolError(`persona.send: failed to load task ${taskId}: ${rowResult.error.message}`));
      }

      if (!rowResult.value) {
        return err(new ToolError(`persona.send: task ${taskId} not found after submission`));
      }

      this.deps.logger.debug({ taskId, state: rowResult.value.state }, 'persona.send: polled task state');

      if (TERMINAL_STATES.has(rowResult.value.state)) {
        return ok(this.toOutput(rowResult.value));
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
      error: 'Timed out waiting for delegated persona reply. The delegated task may still complete asynchronously.',
    });
  }

  private toOutput(row: A2ATaskRow): PersonaSendOutput {
    if (row.state === 'completed') {
      const result = this.parseResultPayload(row.result_payload);
      return {
        task_id: row.id,
        state: 'completed',
        ...(result ? { result } : {}),
      };
    }

    if (row.state === 'failed') {
      return {
        task_id: row.id,
        state: 'failed',
        error: row.error_message ?? row.error_code ?? 'Task failed',
      };
    }

    // covers 'canceled' and 'input-required'
    return {
      task_id: row.id,
      state: row.state,
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
}
