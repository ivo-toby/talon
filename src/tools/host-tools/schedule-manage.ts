/**
 * Host-side tool: schedule.manage
 *
 * Creates, updates, or cancels scheduled tasks on behalf of a persona.
 * Gated by the `schedule.write:own` capability.
 */

import type pino from 'pino';
import { ok, err, type Result } from 'neverthrow';
import { v4 as uuidv4 } from 'uuid';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import type { ScheduleRepository } from '../../core/database/repositories/schedule-repository.js';
import type { ThreadRepository } from '../../core/database/repositories/thread-repository.js';
import type { ChannelRepository } from '../../core/database/repositories/channel-repository.js';
import type { PersonaRepository } from '../../core/database/repositories/persona-repository.js';
import { ToolError } from '../../core/errors/error-types.js';
import { getNextCronTime } from '../../scheduler/cron-evaluator.js';
import type { SchedulePayload } from '../../scheduler/schedule-types.js';
import type { ToolExecutionContext } from './channel-send.js';

/** Manifest for the schedule.manage host tool. */
export interface ScheduleManageTool {
  readonly manifest: ToolManifest;
}

/** Arguments accepted by the schedule.manage tool. */
export interface ScheduleManageArgs {
  /** Action to perform on the schedule entry. */
  action: 'create' | 'update' | 'cancel' | 'delete' | 'list';
  /** Unique schedule identifier (required for update/cancel/delete). */
  scheduleId?: string;
  /** Cron expression defining when the task fires (required for create/update). */
  cronExpr?: string;
  /** Human-readable label for the scheduled task. */
  label?: string;
  /** Prompt or instruction to execute when the schedule fires. */
  prompt?: string;
  /** Prompt file alias to resolve from the persona's prompts/ directory. */
  promptFile?: string;
}

/** Valid actions for the schedule.manage tool. */
const VALID_ACTIONS = new Set(['create', 'update', 'cancel', 'delete', 'list']);

/**
 * Basic validation for cron expressions.
 *
 * Accepts standard 5-field cron format: minute hour day-of-month month day-of-week.
 * Each field may be a number, '*', or a simple expression. This is intentionally
 * lenient — the scheduler will perform stricter validation at runtime.
 */
const CRON_PATTERN = /^(\S+\s+){4}\S+$/;

/** Metadata marker applied to dedicated schedule execution threads. */
const SCHEDULE_THREAD_KIND = 'schedule';

/**
 * Returns the origin chat's external_id stored in a dedicated schedule
 * thread's metadata, or null when the thread is not a schedule thread.
 * Used by handleCreate to unwrap nested schedule-thread invocations so
 * a schedule created from a schedule run still chains back to the real
 * live chat, not to another synthetic id.
 */
function readOriginExternalIdFromMetadata(metadataJson: string | null | undefined): string | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
    if (parsed && parsed.kind === SCHEDULE_THREAD_KIND && typeof parsed.originExternalId === 'string') {
      return parsed.originExternalId;
    }
  } catch {
    /* ignore — treat unparseable metadata as absent */
  }
  return null;
}

/**
 * Handler class for the schedule.manage host tool.
 *
 * Creates, updates, or cancels scheduled tasks via the ScheduleRepository.
 * Schedules are owned by the persona. On create, the schedule is stored on
 * a dedicated per-(persona, channel, origin-chat) thread so scheduled runs
 * do not pollute the live conversation session — but listing/updating/
 * cancelling/deleting remain persona-scoped so those operations are visible
 * from the live thread that invoked the tool.
 */
export class ScheduleManageHandler {
  /** Static manifest describing the tool. */
  static readonly manifest: ToolManifest = {
    name: 'schedule.manage',
    description:
      'Creates, updates, cancels, deletes, or lists scheduled tasks on behalf of a persona. Gated by schedule.write:own.',
    capabilities: ['schedule.write:own'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      scheduleRepository: ScheduleRepository;
      threadRepository: ThreadRepository;
      channelRepository: ChannelRepository;
      personaRepository: PersonaRepository;
      logger: pino.Logger;
    },
  ) {}

  /**
   * Execute the schedule.manage tool.
   *
   * @param args    - Validated tool arguments.
   * @param context - Execution context (runId, threadId, personaId).
   * @returns ToolCallResult with status 'success' or 'error'.
   */
  execute(args: ScheduleManageArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    return Promise.resolve(this.executeSync(args, context));
  }

  /** Synchronous dispatch — wrapped by execute() to satisfy the async tool interface. */
  private executeSync(args: ScheduleManageArgs, context: ToolExecutionContext): ToolCallResult {
    const requestId = context.requestId ?? 'unknown';
    const { action } = args;

    this.deps.logger.info(
      { requestId, runId: context.runId, personaId: context.personaId, action },
      'schedule.manage: executing',
    );

    // Validate action
    if (!action || !VALID_ACTIONS.has(action)) {
      const error = new ToolError(
        `schedule.manage: invalid action "${action}". Must be one of: create, update, cancel, delete, list`,
      );
      this.deps.logger.warn({ requestId, action }, error.message);
      return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
    }

    switch (action) {
      case 'create':
        return this.handleCreate(args, context, requestId);
      case 'update':
        return this.handleUpdate(args, context, requestId);
      case 'cancel':
        return this.handleCancel(args, context, requestId);
      case 'delete':
        return this.handleDelete(args, context, requestId);
      case 'list':
        return this.handleList(context, requestId);
      default: {
        // TypeScript exhaustiveness guard
        const error = new ToolError(`schedule.manage: unknown action "${action as string}"`);
        return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
      }
    }
  }

  /** Handle the 'create' action — insert a new schedule on a dedicated execution thread. */
  private handleCreate(
    args: ScheduleManageArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): ToolCallResult {
    const { cronExpr } = args;

    if (!cronExpr || typeof cronExpr !== 'string' || cronExpr.trim() === '') {
      const error = new ToolError('schedule.manage: cronExpr is required for create action');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
    }

    if (!CRON_PATTERN.test(cronExpr.trim())) {
      const error = new ToolError(
        `schedule.manage: invalid cron expression "${cronExpr}". Expected 5-field cron format (minute hour day month weekday)`,
      );
      this.deps.logger.warn({ requestId, cronExpr }, error.message);
      return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
    }

    const payloadResult = this.buildSchedulePayload(args);
    if (payloadResult.isErr()) {
      this.deps.logger.warn({ requestId }, payloadResult.error.message);
      return {
        requestId,
        tool: 'schedule.manage',
        status: 'error',
        error: payloadResult.error.message,
      };
    }

    // Resolve the invoking thread + its channel so the schedule can be
    // stored on a dedicated execution thread rather than polluting the
    // live conversation session. The origin thread's external_id is
    // captured in the dedicated thread's metadata so scheduled runs can
    // still deliver notifications back to the originating chat.
    const threadResult = this.deps.threadRepository.findById(context.threadId);
    if (threadResult.isErr()) {
      const msg = `schedule.manage: failed to load invoking thread — ${threadResult.error.message}`;
      this.deps.logger.error({ requestId, threadId: context.threadId, err: threadResult.error }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }
    const originThread = threadResult.value;
    if (!originThread) {
      const msg = `schedule.manage: invoking thread "${context.threadId}" not found`;
      this.deps.logger.warn({ requestId, threadId: context.threadId }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }

    const channelResult = this.deps.channelRepository.findById(originThread.channel_id);
    if (channelResult.isErr()) {
      const msg = `schedule.manage: failed to load channel — ${channelResult.error.message}`;
      this.deps.logger.error({ requestId, channelId: originThread.channel_id, err: channelResult.error }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }
    const channelRow = channelResult.value;
    if (!channelRow) {
      const msg = `schedule.manage: channel "${originThread.channel_id}" not found`;
      this.deps.logger.warn({ requestId, channelId: originThread.channel_id }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }

    const personaResult = this.deps.personaRepository.findById(context.personaId);
    if (personaResult.isErr()) {
      const msg = `schedule.manage: failed to load persona — ${personaResult.error.message}`;
      this.deps.logger.error({ requestId, personaId: context.personaId, err: personaResult.error }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }
    const personaRow = personaResult.value;
    if (!personaRow) {
      const msg = `schedule.manage: persona "${context.personaId}" not found`;
      this.deps.logger.warn({ requestId, personaId: context.personaId }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }

    // If this tool is invoked from an already-dedicated schedule thread
    // (e.g. a scheduled run itself creating follow-up schedules), the
    // invoking thread's external_id is the synthetic `schedule:...` id
    // — not a provider-valid recipient. Unwrap it from thread metadata
    // so the new schedule chains back to the real live chat instead of
    // building a second-level synthetic origin that outbound routing
    // cannot resolve.
    const originExternalId =
      readOriginExternalIdFromMetadata(originThread.metadata) ?? originThread.external_id;

    const dedicatedThreadResult = this.resolveDedicatedThread({
      channelId: channelRow.id,
      channelName: channelRow.name,
      personaName: personaRow.name,
      originExternalId,
      requestId,
    });
    if (dedicatedThreadResult.isErr()) {
      return {
        requestId,
        tool: 'schedule.manage',
        status: 'error',
        error: dedicatedThreadResult.error.message,
      };
    }
    const dedicatedThreadId = dedicatedThreadResult.value;

    const scheduleId = uuidv4();
    const payload = JSON.stringify(payloadResult.value);

    // Compute next_run_at from the cron expression so the scheduler
    // can find this schedule on its next tick. (Fixes BUG-005.)
    const nextRunResult = getNextCronTime(cronExpr.trim());
    if (nextRunResult.isErr()) {
      const msg = `schedule.manage: failed to compute next run time — ${nextRunResult.error.message}`;
      this.deps.logger.warn({ requestId, cronExpr }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }

    const insertResult = this.deps.scheduleRepository.insert({
      id: scheduleId,
      persona_id: context.personaId,
      thread_id: dedicatedThreadId,
      type: 'cron',
      expression: cronExpr.trim(),
      payload,
      enabled: 1,
      last_run_at: null,
      next_run_at: nextRunResult.value,
    });

    if (insertResult.isErr()) {
      const msg = `schedule.manage: create failed — ${insertResult.error.message}`;
      this.deps.logger.error({ requestId, err: insertResult.error }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }

    this.deps.logger.info(
      {
        requestId,
        scheduleId,
        personaId: context.personaId,
        personaName: personaRow.name,
        channelName: channelRow.name,
        originThreadId: context.threadId,
        dedicatedThreadId,
      },
      'schedule.manage: schedule created on dedicated execution thread',
    );

    return {
      requestId,
      tool: 'schedule.manage',
      status: 'success',
      result: { scheduleId, action: 'create', created: true },
    };
  }

  /** Handle the 'update' action — update an existing schedule's fields. */
  private handleUpdate(
    args: ScheduleManageArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): ToolCallResult {
    const { scheduleId, cronExpr, label, prompt, promptFile } = args;

    if (!scheduleId || typeof scheduleId !== 'string' || scheduleId.trim() === '') {
      const error = new ToolError('schedule.manage: scheduleId is required for update action');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
    }

    if (cronExpr !== undefined && !CRON_PATTERN.test(cronExpr.trim())) {
      const error = new ToolError(
        `schedule.manage: invalid cron expression "${cronExpr}". Expected 5-field cron format`,
      );
      this.deps.logger.warn({ requestId, cronExpr }, error.message);
      return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
    }

    // Build a dynamic UPDATE. We only update expression and payload if provided.
    const fields: Record<string, unknown> = {};
    if (cronExpr !== undefined) {
      fields['expression'] = cronExpr.trim();
      // Recompute next_run_at so the schedule fires at the new time.
      const nextRunResult = getNextCronTime(cronExpr.trim());
      if (nextRunResult.isErr()) {
        const msg = `schedule.manage: failed to compute next run time — ${nextRunResult.error.message}`;
        this.deps.logger.warn({ requestId, cronExpr }, msg);
        return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
      }
      fields['next_run_at'] = nextRunResult.value;
    }
    if (label !== undefined || prompt !== undefined || promptFile !== undefined) {
      const existingSchedule = this.deps.scheduleRepository.findById(scheduleId);
      if (existingSchedule.isErr()) {
        const msg = `schedule.manage: failed to load existing schedule — ${existingSchedule.error.message}`;
        this.deps.logger.error({ requestId, scheduleId, err: existingSchedule.error }, msg);
        return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
      }

      if (!existingSchedule.value) {
        const msg = `schedule.manage: schedule "${scheduleId}" not found`;
        this.deps.logger.warn({ requestId, scheduleId }, msg);
        return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
      }

      // Ownership check by persona — NOT by invoking thread. A schedule
      // created on a dedicated execution thread must still be editable
      // from the live chat thread that owns the persona.
      if (existingSchedule.value.persona_id !== context.personaId) {
        const msg = `schedule.manage: schedule "${scheduleId}" does not belong to this persona`;
        this.deps.logger.warn({ requestId, scheduleId, personaId: context.personaId }, msg);
        return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
      }

      const payloadResult = this.buildSchedulePayload(args, existingSchedule.value.payload);
      if (payloadResult.isErr()) {
        this.deps.logger.warn({ requestId, scheduleId }, payloadResult.error.message);
        return {
          requestId,
          tool: 'schedule.manage',
          status: 'error',
          error: payloadResult.error.message,
        };
      }

      fields['payload'] = JSON.stringify(payloadResult.value);
    }

    if (Object.keys(fields).length === 0) {
      const error = new ToolError(
        'schedule.manage: no fields provided to update (provide at least one of: cronExpr, label, prompt, promptFile)',
      );
      this.deps.logger.warn({ requestId, scheduleId }, error.message);
      return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
    }

    // Build a typed UpdateScheduleInput from the collected fields
    const updateInput: { expression?: string; payload?: string; next_run_at?: number } = {};
    if (typeof fields['expression'] === 'string') {
      updateInput.expression = fields['expression'];
    }
    if (typeof fields['next_run_at'] === 'number') {
      updateInput.next_run_at = fields['next_run_at'];
    }
    if (typeof fields['payload'] === 'string') {
      updateInput.payload = fields['payload'];
    }

    const updateResult = this.deps.scheduleRepository.update(scheduleId, context.personaId, updateInput);
    if (updateResult.isErr()) {
      const msg = `schedule.manage: update failed — ${updateResult.error.message}`;
      this.deps.logger.error({ requestId, scheduleId, err: updateResult.error }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }

    this.deps.logger.info(
      { requestId, scheduleId, personaId: context.personaId },
      'schedule.manage: schedule updated',
    );

    return {
      requestId,
      tool: 'schedule.manage',
      status: 'success',
      result: { scheduleId, action: 'update', updated: true },
    };
  }

  /** Handle the 'cancel' action — disable the schedule (sets enabled=0). */
  private handleCancel(
    args: ScheduleManageArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): ToolCallResult {
    const { scheduleId } = args;

    if (!scheduleId || typeof scheduleId !== 'string' || scheduleId.trim() === '') {
      const error = new ToolError('schedule.manage: scheduleId is required for cancel action');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
    }

    // Persona-ownership check: cancel must work from any invoking thread
    // that owns the persona, not only the dedicated schedule thread.
    const existing = this.deps.scheduleRepository.findById(scheduleId);
    if (existing.isErr()) {
      const msg = `schedule.manage: failed to load schedule — ${existing.error.message}`;
      this.deps.logger.error({ requestId, scheduleId, err: existing.error }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }
    if (!existing.value) {
      const msg = `schedule.manage: schedule "${scheduleId}" not found`;
      this.deps.logger.warn({ requestId, scheduleId }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }
    if (existing.value.persona_id !== context.personaId) {
      const msg = `schedule.manage: schedule "${scheduleId}" does not belong to this persona`;
      this.deps.logger.warn({ requestId, scheduleId, personaId: context.personaId }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }

    const disableResult = this.deps.scheduleRepository.disable(scheduleId);
    if (disableResult.isErr()) {
      const msg = `schedule.manage: cancel failed — ${disableResult.error.message}`;
      this.deps.logger.error({ requestId, scheduleId, err: disableResult.error }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }

    this.deps.logger.info(
      { requestId, scheduleId, personaId: context.personaId },
      'schedule.manage: schedule cancelled',
    );

    return {
      requestId,
      tool: 'schedule.manage',
      status: 'success',
      result: { scheduleId, action: 'cancel', cancelled: true },
    };
  }

  /** Handle the 'delete' action — permanently remove the schedule row. */
  private handleDelete(
    args: ScheduleManageArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): ToolCallResult {
    const { scheduleId } = args;

    if (!scheduleId || typeof scheduleId !== 'string' || scheduleId.trim() === '') {
      const error = new ToolError('schedule.manage: scheduleId is required for delete action');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
    }

    const deleteResult = this.deps.scheduleRepository.delete(scheduleId, context.personaId);
    if (deleteResult.isErr()) {
      const msg = `schedule.manage: delete failed — ${deleteResult.error.message}`;
      this.deps.logger.error({ requestId, scheduleId, err: deleteResult.error }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }

    if (deleteResult.value === null) {
      const msg = `schedule.manage: schedule "${scheduleId}" not found or not owned by this persona`;
      this.deps.logger.warn({ requestId, scheduleId, personaId: context.personaId }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }

    this.deps.logger.info(
      { requestId, scheduleId, personaId: context.personaId },
      'schedule.manage: schedule deleted',
    );

    return {
      requestId,
      tool: 'schedule.manage',
      status: 'success',
      result: { scheduleId, action: 'delete', deleted: true },
    };
  }

  /**
   * Handle the 'list' action — return all schedules for the persona.
   *
   * Returns every schedule owned by the invoking persona regardless of which
   * thread (live or dedicated) it is stored against. This keeps schedules
   * visible from the live chat that will normally be used to inspect them.
   */
  private handleList(context: ToolExecutionContext, requestId: string): ToolCallResult {
    const result = this.deps.scheduleRepository.findByPersona(context.personaId);
    if (result.isErr()) {
      const msg = `schedule.manage: list failed — ${result.error.message}`;
      this.deps.logger.error({ requestId, err: result.error }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }

    const schedules = result.value.map((row) => {
      const payload = ((): Record<string, unknown> | null => {
        try {
          return JSON.parse(row.payload) as Record<string, unknown>;
        } catch {
          return null;
        }
      })();
      const schedule = {
        scheduleId: row.id,
        type: row.type,
        expression: row.expression,
        label: typeof payload?.label === 'string' ? payload.label : '',
        prompt: typeof payload?.prompt === 'string' ? payload.prompt : '',
        enabled: row.enabled === 1,
        nextRunAt: row.next_run_at ? new Date(row.next_run_at).toISOString() : null,
        lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
      };

      if (typeof payload?.promptFile === 'string') {
        return {
          ...schedule,
          promptFile: payload.promptFile,
        };
      }

      return schedule;
    });

    this.deps.logger.debug(
      { requestId, personaId: context.personaId, count: schedules.length },
      'schedule.manage: list complete',
    );

    return {
      requestId,
      tool: 'schedule.manage',
      status: 'success',
      result: { schedules, count: schedules.length },
    };
  }

  /**
   * Resolve (find or create) the dedicated execution thread for a schedule.
   *
   * Dedicated threads are keyed by `schedule:<persona>:<channel>:<origin>` so
   * each originating chat has its own execution container. Scheduled runs
   * therefore do not overwrite live-conversation session state, while the
   * origin chat's external_id is persisted in the thread metadata so outbound
   * notifications can still be routed back to the user.
   */
  private resolveDedicatedThread(input: {
    channelId: string;
    channelName: string;
    personaName: string;
    originExternalId: string;
    requestId: string;
  }): Result<string, ToolError> {
    const { channelId, channelName, personaName, originExternalId, requestId } = input;
    const dedicatedExternalId = `schedule:${personaName}:${channelName}:${originExternalId}`;

    const existing = this.deps.threadRepository.findByExternalId(channelId, dedicatedExternalId);
    if (existing.isErr()) {
      const msg = `schedule.manage: failed to look up dedicated schedule thread — ${existing.error.message}`;
      this.deps.logger.error({ requestId, channelId, dedicatedExternalId, err: existing.error }, msg);
      return err(new ToolError(msg));
    }
    if (existing.value) {
      return ok(existing.value.id);
    }

    const dedicatedThreadId = uuidv4();
    const metadata = JSON.stringify({
      kind: SCHEDULE_THREAD_KIND,
      originExternalId,
      personaName,
      channelName,
    });
    const insertResult = this.deps.threadRepository.insert({
      id: dedicatedThreadId,
      channel_id: channelId,
      external_id: dedicatedExternalId,
      metadata,
    });
    if (insertResult.isErr()) {
      // UNIQUE(channel_id, external_id) race: a concurrent create may have
      // just inserted the same dedicated thread. Re-query before bailing —
      // schedule creation should succeed regardless of who won the race.
      const retry = this.deps.threadRepository.findByExternalId(channelId, dedicatedExternalId);
      if (retry.isOk() && retry.value) {
        this.deps.logger.info(
          { requestId, channelId, dedicatedExternalId, threadId: retry.value.id },
          'schedule.manage: dedicated schedule thread materialised by concurrent create, reusing',
        );
        return ok(retry.value.id);
      }
      const msg = `schedule.manage: failed to create dedicated schedule thread — ${insertResult.error.message}`;
      this.deps.logger.error({ requestId, channelId, dedicatedExternalId, err: insertResult.error }, msg);
      return err(new ToolError(msg));
    }
    return ok(dedicatedThreadId);
  }

  private buildSchedulePayload(
    args: Pick<ScheduleManageArgs, 'label' | 'prompt' | 'promptFile'>,
    existingPayloadJson?: string,
  ): Result<SchedulePayload, ToolError> {
    if (args.prompt !== undefined && args.promptFile !== undefined) {
      return err(
        new ToolError('schedule.manage: prompt and promptFile are mutually exclusive'),
      );
    }

    const existingPayload = this.parseSchedulePayload(existingPayloadJson);
    const payload: SchedulePayload = {
      label: args.label ?? existingPayload.label ?? '',
    };

    if (args.promptFile !== undefined) {
      payload.promptFile = args.promptFile;
      return ok(payload);
    }

    if (args.prompt !== undefined) {
      payload.prompt = args.prompt;
      return ok(payload);
    }

    if (existingPayload.promptFile !== undefined) {
      payload.promptFile = existingPayload.promptFile;
      return ok(payload);
    }

    if (existingPayload.prompt !== undefined) {
      payload.prompt = existingPayload.prompt;
    }

    return ok(payload);
  }

  private parseSchedulePayload(payloadJson?: string): SchedulePayload {
    if (!payloadJson) {
      return { label: '' };
    }

    try {
      const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
      const payload: SchedulePayload = {
        label: typeof parsed.label === 'string' ? parsed.label : '',
      };

      if (typeof parsed.prompt === 'string') {
        payload.prompt = parsed.prompt;
      }
      if (typeof parsed.promptFile === 'string') {
        payload.promptFile = parsed.promptFile;
      }

      return payload;
    } catch {
      return { label: '' };
    }
  }
}
