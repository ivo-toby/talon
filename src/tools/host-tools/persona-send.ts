/**
 * Host-side tool: persona.send
 *
 * Submits a task to another persona over Talon's internal A2A layer.
 */

import { err, ok, type Result } from 'neverthrow';
import type pino from 'pino';
import type { A2ATaskMapper } from '../../a2a/a2a-task-mapper.js';
import type { A2ANotifyPolicy, A2ATaskRow, A2ATaskState } from '../../a2a/a2a-types.js';
import type { A2ATaskRepository } from '../../core/database/repositories/a2a-task-repository.js';
import type { PersonaRepository } from '../../core/database/repositories/persona-repository.js';
import type { RunRepository } from '../../core/database/repositories/run-repository.js';
import type { ThreadRepository } from '../../core/database/repositories/thread-repository.js';
import { resolveThreadRecipient } from '../../daemon/schedule-thread-utils.js';
import { ToolError } from '../../core/errors/error-types.js';
import {
  allowedDelegationTargets,
  describeDelegationTargets,
} from '../../personas/persona-delegation.js';
import type { ResolvedCapabilities } from '../../personas/persona-types.js';
import type { ToolCallResult, ToolManifest } from '../tool-types.js';
import type { ToolExecutionContext } from './channel-send.js';
import {
  PERSONA_SEND_DEFAULT_MAX_WAIT_MS,
  PERSONA_TASK_WAIT_MAX_MS,
  resolvePersonaTaskWaitMs,
} from '../tool-timeouts.js';

export interface PersonaSendTool {
  readonly manifest: ToolManifest;
}

export interface PersonaSendArgs {
  target_persona: string;
  message: string;
  await_reply?: boolean;
  timeout_ms?: number;
  cancel_on_timeout?: boolean;
  /** 'wake' notifies the source thread when the task finishes. Default: 'wake' unless await_reply. */
  notify?: A2ANotifyPolicy;
}

type PersonaSendState = A2ATaskState | 'timeout';

interface PersonaSendOutput {
  task_id: string;
  state: PersonaSendState;
  result?: string;
  error?: string;
  /** Effective completion notification policy at submit time. */
  notify?: A2ANotifyPolicy;
  /** Why notify differs from what was asked or defaulted. */
  notify_hint?: string;
}

const NOTIFY_HINT_NOT_WAKEABLE =
  'notify forced to none: this run cannot be woken (only foreground runs can); use await_reply or persona_task_status';
const NOTIFY_HINT_NO_CHAT =
  'notify forced to none: this conversation has no chat to deliver to; use await_reply or persona_task_status';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const TERMINAL_STATES = new Set<A2ATaskState>(['completed', 'failed', 'canceled', 'input-required']);

const TIMEOUT_MESSAGE =
  'Timed out waiting for delegated persona reply. The delegated task may still complete asynchronously. Use persona_task_status with this task_id to fetch the final result later.';

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
      /** Identifies the calling run; without it no run counts as foreground (fail closed). */
      runRepo?: Pick<RunRepository, 'findById'>;
      /** Resolves the source thread's chat; without it no thread counts as having one. */
      threadRepo?: Pick<ThreadRepository, 'findById'>;
      logger: pino.Logger;
      /**
       * Resolves the CALLING persona's capabilities on the host from the trusted
       * run context (fail-closed). Used to enforce `persona.send:<name>` scopes.
       */
      resolveCapabilities: (personaId: string) => ResolvedCapabilities;
      maxWaitMs?: number;
      pollIntervalMs?: number;
      /**
       * Wraps the waiting/polling portion so the caller's queue slot can be
       * released while it waits. Never wraps task submission.
       */
      waitScope?: <T>(fn: () => Promise<T>, context: ToolExecutionContext) => Promise<T>;
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

    // Host-side scope enforcement from the caller's own resolved capabilities,
    // before anything is persisted or queued. A delegated persona's own
    // persona_send runs through here with ITS capabilities, so hops cannot widen
    // the set of reachable personas.
    const allowedTargets = allowedDelegationTargets(this.deps.resolveCapabilities(context.personaId));
    if (allowedTargets !== 'all' && !allowedTargets.has(validatedArgs.value.target_persona)) {
      const message =
        `persona.send: delegating to "${validatedArgs.value.target_persona}" is not allowed for this persona. `
        + `Allowed targets: ${describeDelegationTargets(allowedTargets)}.`;
      this.deps.logger.warn(
        { requestId, personaId: context.personaId, targetPersona: validatedArgs.value.target_persona },
        'persona.send: rejected target outside persona.send scope',
      );
      return this.errorResult(requestId, message);
    }

    // A wake runs the source persona as a FOREGROUND run in the source thread.
    // That is only correct when the caller IS a foreground run of that thread:
    // a delegated persona's run and a background agent share the thread but are
    // not foreground runs, so a wake would answer in the human's chat. Fail
    // closed: anything that is not positively a foreground run cannot wake.
    const requested = validatedArgs.value.notify;
    const foreground = this.isForegroundRun(context);
    if (!foreground && requested === 'wake') {
      const message =
        "persona.send: this run cannot be woken: notify 'wake' is only available to foreground runs, " +
        'not to delegated personas or background agents. ' +
        'Use await_reply: true, or send with notify: "none" and follow the task with persona_task_status.';
      this.deps.logger.warn({ requestId, runId: context.runId }, message);
      return this.errorResult(requestId, message);
    }
    const wanted: A2ANotifyPolicy =
      requested ?? (validatedArgs.value.await_reply ? 'none' : 'wake');
    // A conversation with no chat (CLI-created schedule thread) cannot receive the wake.
    const hasChat = foreground && this.threadHasChat(context.threadId);
    let notify: A2ANotifyPolicy = wanted;
    let notifyHint: string | undefined;
    if (wanted === 'wake' && !hasChat) {
      notify = 'none';
      notifyHint = foreground ? NOTIFY_HINT_NO_CHAT : NOTIFY_HINT_NOT_WAKEABLE;
    }
    // A timed-out or failed wait may switch the task to wake, only for a run that
    // can be woken and has not explicitly opted out.
    const wakeOnLostWait = hasChat && requested !== 'none';

    const submitResult = this.deps.taskMapper.submitTask({
      sourcePersona: sourcePersona.value,
      targetPersona: validatedArgs.value.target_persona,
      sourceThreadId: context.threadId,
      content: validatedArgs.value.message,
      notify,
      hopCount: (context.a2aHopCount ?? 0) + 1,
      ...(context.a2aTaskId ? { parentTaskId: context.a2aTaskId } : {}),
    });
    const withNotify = (out: PersonaSendOutput): PersonaSendOutput => ({
      ...out,
      notify,
      ...(notifyHint ? { notify_hint: notifyHint } : {}),
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
      return this.successResult(
        requestId,
        withNotify({ task_id: submitResult.value.taskId, state: 'submitted' }),
      );
    }

    const taskId = submitResult.value.taskId;
    const maxWaitMs = resolvePersonaTaskWaitMs(validatedArgs.value.timeout_ms, this.deps.maxWaitMs);
    const cancelOnTimeout = validatedArgs.value.cancel_on_timeout ?? false;
    const poll = (): Promise<Result<PersonaSendOutput, ToolError>> =>
      this.pollUntilTerminal(taskId, maxWaitMs, cancelOnTimeout, wakeOnLostWait);
    const awaitedResult = this.deps.waitScope ? await this.deps.waitScope(poll, context) : await poll();
    if (awaitedResult.isErr()) {
      this.deps.logger.error({ requestId, taskId: submitResult.value.taskId }, awaitedResult.error.message);
      return this.errorResult(requestId, awaitedResult.error.message);
    }

    return this.successResult(requestId, withNotify(awaitedResult.value));
  }

  /**
   * True only when the caller is positively a foreground, non-A2A run of its
   * thread, using host-owned state rather than client-supplied context alone:
   * no a2a/background task ID in the context, a `runs` row for this run in this
   * thread (a background agent's task ID has none), and no A2A task bound to
   * the run (an A2A run is recorded on its task by markWorking before it can
   * call any tool). Any lookup failure means "not foreground".
   */
  private isForegroundRun(context: ToolExecutionContext): boolean {
    if (context.a2aTaskId || context.backgroundTaskId) return false;
    if (!this.deps.runRepo) return false;
    const run = this.deps.runRepo.findById(context.runId);
    if (run.isErr() || run.value === null || run.value.thread_id !== context.threadId) return false;
    const bound = this.deps.taskRepo.isRunBoundToTask(context.runId);
    return bound.isOk() && !bound.value;
  }

  private threadHasChat(threadId: string): boolean {
    if (!this.deps.threadRepo) return false;
    const thread = this.deps.threadRepo.findById(threadId);
    return thread.isOk() && thread.value !== null && resolveThreadRecipient(thread.value) !== null;
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

    if (args.notify !== undefined && args.notify !== 'wake' && args.notify !== 'none') {
      return err(new ToolError("persona.send: notify must be 'wake' or 'none'"));
    }

    if (args.await_reply === true && args.notify === 'wake') {
      return err(
        new ToolError(
          "persona.send: notify 'wake' with await_reply: true would deliver the result twice; " +
            "use notify 'wake' only without await_reply",
        ),
      );
    }

    if (args.cancel_on_timeout !== undefined && typeof args.cancel_on_timeout !== 'boolean') {
      return err(new ToolError('persona.send: cancel_on_timeout must be a boolean'));
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

    return ok({
      target_persona: args.target_persona.trim(),
      message: args.message.trim(),
      await_reply: args.await_reply ?? false,
      cancel_on_timeout: args.cancel_on_timeout ?? false,
      ...(args.notify !== undefined ? { notify: args.notify } : {}),
      ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}),
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
    cancelOnTimeout = false,
    wakeOnLostWait = false,
  ): Promise<Result<PersonaSendOutput, ToolError>> {
    const pollIntervalMs = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + maxWaitMs;

    while (true) {
      const rowResult = this.deps.taskRepo.findById(taskId);
      if (rowResult.isErr()) {
        // The wait is lost: make sure the result still reaches the caller.
        if (wakeOnLostWait) this.switchToWake(taskId);
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

    if (cancelOnTimeout) {
      return this.cancelAfterTimeout(taskId, wakeOnLostWait);
    }

    return this.timeoutResult(taskId, wakeOnLostWait);
  }

  /**
   * An awaited call gave up without cancelling: switch the task to 'wake' so
   * the late result still reaches the delegating persona (ADR 0003).
   */
  private timeoutResult(taskId: string, wake: boolean): Result<PersonaSendOutput, ToolError> {
    if (wake) this.switchToWake(taskId);
    return ok({
      task_id: taskId,
      state: 'timeout',
      error: TIMEOUT_MESSAGE,
    });
  }

  private switchToWake(taskId: string): void {
    const switched = this.deps.taskRepo.setNotifyWake(taskId);
    if (switched.isErr()) {
      this.deps.logger.warn(
        { taskId, err: switched.error.message },
        'persona.send: failed to switch task to notify=wake',
      );
    }
  }

  private cancelAfterTimeout(taskId: string, wake: boolean): Result<PersonaSendOutput, ToolError> {
    const reason = 'await_reply timed out';
    const cancelResult = this.deps.taskMapper.cancelTask(taskId, reason);
    if (cancelResult.isErr()) {
      this.timeoutResult(taskId, wake);
      return ok({
        task_id: taskId,
        state: 'timeout',
        error: `${TIMEOUT_MESSAGE} Cancellation was requested but failed: ${cancelResult.error.message}`,
      });
    }

    if (cancelResult.value) {
      return ok({
        task_id: taskId,
        state: 'canceled',
        error: `Timed out waiting for delegated persona reply; the delegated task was canceled (${reason}).`,
      });
    }

    // Task reached a terminal state before it could be canceled: report the real outcome.
    const rowResult = this.deps.taskRepo.findById(taskId);
    if (rowResult.isErr()) {
      return err(new ToolError(`persona.send: failed to load task ${taskId}: ${rowResult.error.message}`));
    }
    if (!rowResult.value) {
      return err(new ToolError(`persona.send: task ${taskId} not found after submission`));
    }
    if (TERMINAL_STATES.has(rowResult.value.state)) {
      return ok(this.toOutput(rowResult.value));
    }
    return this.timeoutResult(taskId, wake);
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

    if (row.state === 'canceled') {
      return {
        task_id: row.id,
        state: 'canceled',
        ...(row.error_message ? { error: row.error_message } : {}),
      };
    }

    // covers 'input-required'
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
