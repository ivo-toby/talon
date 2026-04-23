/**
 * Unit tests for ScheduleManageHandler.
 *
 * Tests cover:
 *   - create: success stores on a dedicated per-(persona, channel, origin)
 *     execution thread; validation errors; repository error propagation
 *   - update / cancel / delete: persona-scoped ownership (must work from
 *     the live thread even though the schedule sits on the dedicated one)
 *   - list: returns every schedule owned by the persona regardless of thread
 *   - invalid action
 */

import { describe, it, expect, vi } from 'vitest';
import { ok, err } from 'neverthrow';
import { ScheduleManageHandler } from '../../../../src/tools/host-tools/schedule-manage.js';
import type { ScheduleManageArgs } from '../../../../src/tools/host-tools/schedule-manage.js';
import type { ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import { DbError } from '../../../../src/core/errors/error-types.js';
import type {
  ScheduleRepository,
  ScheduleRow,
} from '../../../../src/core/database/repositories/schedule-repository.js';
import type {
  ThreadRepository,
  ThreadRow,
} from '../../../../src/core/database/repositories/thread-repository.js';
import type {
  ChannelRepository,
  ChannelRow,
} from '../../../../src/core/database/repositories/channel-repository.js';
import type {
  PersonaRepository,
  PersonaRow,
} from '../../../../src/core/database/repositories/persona-repository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as import('pino').Logger;
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: 'run-001',
    threadId: 'live-thread-001',
    personaId: 'persona-001',
    requestId: 'req-001',
    ...overrides,
  };
}

function makeThreadRow(overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: 'live-thread-001',
    channel_id: 'channel-001',
    external_id: 'chat-42',
    metadata: '{}',
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

function makeChannelRow(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: 'channel-001',
    type: 'telegram',
    name: 'telegram-main',
    config: '{}',
    credentials_ref: null,
    enabled: 1,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

function makePersonaRow(overrides: Partial<PersonaRow> = {}): PersonaRow {
  return {
    id: 'persona-001',
    name: 'assistant',
    model: 'claude-sonnet-4-6',
    system_prompt_file: null,
    skills: '[]',
    capabilities: '{}',
    mounts: '[]',
    max_concurrent: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

function makeScheduleRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched-001',
    persona_id: 'persona-001',
    thread_id: 'dedicated-schedule-thread-001',
    type: 'cron',
    expression: '0 9 * * 1',
    payload: '{"label":"Daily standup","prompt":"What should I focus on today?"}',
    enabled: 1,
    last_run_at: null,
    next_run_at: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

function makeScheduleRepo(overrides: Partial<ScheduleRepository> = {}): ScheduleRepository {
  return {
    insert: vi.fn().mockReturnValue(ok(makeScheduleRow())),
    update: vi.fn().mockReturnValue(ok(makeScheduleRow())),
    delete: vi.fn().mockReturnValue(ok(makeScheduleRow())),
    disable: vi.fn().mockReturnValue(ok(undefined)),
    enable: vi.fn().mockReturnValue(ok(undefined)),
    findByPersona: vi.fn().mockReturnValue(ok([])),
    findById: vi.fn().mockReturnValue(ok(makeScheduleRow())),
    findDue: vi.fn().mockReturnValue(ok([])),
    updateNextRun: vi.fn().mockReturnValue(ok(null)),
    ...overrides,
  } as unknown as ScheduleRepository;
}

function makeThreadRepo(overrides: Partial<ThreadRepository> = {}): ThreadRepository {
  return {
    findById: vi.fn().mockReturnValue(ok(makeThreadRow())),
    findByExternalId: vi.fn().mockReturnValue(ok(null)),
    findByChannelId: vi.fn().mockReturnValue(ok([])),
    insert: vi.fn().mockImplementation((row) => ok({
      ...makeThreadRow(),
      ...row,
      created_at: 1000,
      updated_at: 1000,
    })),
    update: vi.fn().mockReturnValue(ok(makeThreadRow())),
    ...overrides,
  } as unknown as ThreadRepository;
}

function makeChannelRepo(overrides: Partial<ChannelRepository> = {}): ChannelRepository {
  return {
    findById: vi.fn().mockReturnValue(ok(makeChannelRow())),
    findByName: vi.fn().mockReturnValue(ok(makeChannelRow())),
    findEnabled: vi.fn().mockReturnValue(ok([])),
    insert: vi.fn().mockReturnValue(ok(makeChannelRow())),
    update: vi.fn().mockReturnValue(ok(makeChannelRow())),
    delete: vi.fn().mockReturnValue(ok(undefined)),
    ...overrides,
  } as unknown as ChannelRepository;
}

function makePersonaRepo(overrides: Partial<PersonaRepository> = {}): PersonaRepository {
  return {
    findById: vi.fn().mockReturnValue(ok(makePersonaRow())),
    findByName: vi.fn().mockReturnValue(ok(makePersonaRow())),
    findAll: vi.fn().mockReturnValue(ok([])),
    insert: vi.fn().mockReturnValue(ok(makePersonaRow())),
    update: vi.fn().mockReturnValue(ok(makePersonaRow())),
    delete: vi.fn().mockReturnValue(ok(undefined)),
    ...overrides,
  } as unknown as PersonaRepository;
}

function makeHandler(overrides: {
  scheduleRepository?: ScheduleRepository;
  threadRepository?: ThreadRepository;
  channelRepository?: ChannelRepository;
  personaRepository?: PersonaRepository;
} = {}) {
  return new ScheduleManageHandler({
    scheduleRepository: overrides.scheduleRepository ?? makeScheduleRepo(),
    threadRepository: overrides.threadRepository ?? makeThreadRepo(),
    channelRepository: overrides.channelRepository ?? makeChannelRepo(),
    personaRepository: overrides.personaRepository ?? makePersonaRepo(),
    logger: makeLogger(),
  });
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe('ScheduleManageHandler — manifest', () => {
  it('has the correct tool name', () => {
    expect(ScheduleManageHandler.manifest.name).toBe('schedule.manage');
  });

  it('has executionLocation set to host', () => {
    expect(ScheduleManageHandler.manifest.executionLocation).toBe('host');
  });

  it('declares schedule.write:own capability', () => {
    expect(ScheduleManageHandler.manifest.capabilities).toContain('schedule.write:own');
  });
});

// ---------------------------------------------------------------------------
// Action: create
// ---------------------------------------------------------------------------

describe('ScheduleManageHandler — create', () => {
  it('creates a schedule on a newly-provisioned dedicated execution thread', async () => {
    const insertSchedule = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const findByExternalId = vi.fn().mockReturnValue(ok(null));
    const insertThread = vi.fn().mockImplementation((row) => ok({
      ...makeThreadRow(),
      ...row,
      created_at: 1000,
      updated_at: 1000,
    }));
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({ insert: insertSchedule }),
      threadRepository: makeThreadRepo({ findByExternalId, insert: insertThread }),
    });

    const result = await handler.execute(
      { action: 'create', cronExpr: '0 9 * * 1', label: 'Standup', prompt: 'What to do?' },
      makeContext(),
    );

    expect(result.status).toBe('success');
    expect((result.result as { created: boolean }).created).toBe(true);

    // A dedicated schedule thread keyed `schedule:<persona>:<channel>:<origin>`
    // was provisioned on the same channel as the live thread.
    expect(findByExternalId).toHaveBeenCalledWith(
      'channel-001',
      'schedule:assistant:telegram-main:chat-42',
    );
    expect(insertThread).toHaveBeenCalledTimes(1);
    const insertedThread = insertThread.mock.calls[0][0];
    expect(insertedThread.channel_id).toBe('channel-001');
    expect(insertedThread.external_id).toBe('schedule:assistant:telegram-main:chat-42');
    expect(JSON.parse(insertedThread.metadata)).toMatchObject({
      kind: 'schedule',
      originExternalId: 'chat-42',
      personaName: 'assistant',
      channelName: 'telegram-main',
    });

    // The schedule row was stored against the dedicated thread, not the live one.
    expect(insertSchedule).toHaveBeenCalledTimes(1);
    const insertedSchedule = insertSchedule.mock.calls[0][0];
    expect(insertedSchedule.thread_id).toBe(insertedThread.id);
    expect(insertedSchedule.thread_id).not.toBe('live-thread-001');
  });

  it('reuses an existing dedicated thread when one already exists for (persona, channel, origin)', async () => {
    const existingDedicated = makeThreadRow({
      id: 'dedicated-thread-xyz',
      external_id: 'schedule:assistant:telegram-main:chat-42',
      metadata: JSON.stringify({
        kind: 'schedule',
        originExternalId: 'chat-42',
        personaName: 'assistant',
        channelName: 'telegram-main',
      }),
    });
    const insertSchedule = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const insertThread = vi.fn();
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({ insert: insertSchedule }),
      threadRepository: makeThreadRepo({
        findByExternalId: vi.fn().mockReturnValue(ok(existingDedicated)),
        insert: insertThread,
      }),
    });

    const result = await handler.execute(
      { action: 'create', cronExpr: '0 9 * * *', prompt: 'Ping' },
      makeContext(),
    );

    expect(result.status).toBe('success');
    expect(insertThread).not.toHaveBeenCalled();
    expect(insertSchedule.mock.calls[0][0].thread_id).toBe('dedicated-thread-xyz');
  });

  it('recovers from a UNIQUE-key race by re-querying the dedicated thread on insert failure (Codex P1)', async () => {
    // Two concurrent schedule.manage create calls for the same
    // (persona, channel, origin) can both pass findByExternalId → null
    // and both attempt the insert. The first wins; the second hits
    // threads.UNIQUE(channel_id, external_id). That second call must
    // still succeed by re-querying the just-materialised row.
    const winnerRow = makeThreadRow({
      id: 'dedicated-winner',
      external_id: 'schedule:assistant:telegram-main:chat-42',
      metadata: JSON.stringify({
        kind: 'schedule',
        originExternalId: 'chat-42',
      }),
    });
    let findCallCount = 0;
    const findByExternalId = vi.fn().mockImplementation(() => {
      findCallCount += 1;
      // First lookup (before insert attempt): no thread yet.
      // Second lookup (after insert failure): winner now materialised.
      return findCallCount === 1 ? ok(null) : ok(winnerRow);
    });
    const insertThread = vi.fn().mockReturnValue(err(new DbError('UNIQUE constraint failed')));
    const insertSchedule = vi.fn().mockReturnValue(ok(makeScheduleRow()));

    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({ insert: insertSchedule }),
      threadRepository: makeThreadRepo({ findByExternalId, insert: insertThread }),
    });

    const result = await handler.execute(
      { action: 'create', cronExpr: '0 9 * * *', prompt: 'Ping' },
      makeContext(),
    );

    expect(result.status).toBe('success');
    expect(findByExternalId).toHaveBeenCalledTimes(2);
    expect(insertSchedule.mock.calls[0][0].thread_id).toBe('dedicated-winner');
  });

  it('unwraps origin external_id from metadata when invoked from an existing schedule thread (Codex P2)', async () => {
    // When a scheduled run itself invokes schedule.manage to create a
    // follow-up schedule, the invoking thread's external_id is the
    // synthetic `schedule:persona:channel:origin` id. Passing that as
    // the new schedule's origin would chain synthetic → synthetic and
    // break outbound routing. The handler must unwrap the real origin
    // from the invoking thread's metadata.
    const invokingScheduleThread = makeThreadRow({
      id: 'live-thread-001',
      channel_id: 'channel-001',
      external_id: 'schedule:assistant:telegram-main:chat-42',
      metadata: JSON.stringify({
        kind: 'schedule',
        originExternalId: 'chat-42',
      }),
    });
    const findById = vi.fn().mockReturnValue(ok(invokingScheduleThread));
    const findByExternalId = vi.fn().mockReturnValue(ok(null));
    const insertThread = vi.fn().mockImplementation((row) => ok({
      ...makeThreadRow(),
      ...row,
      created_at: 1000,
      updated_at: 1000,
    }));
    const insertSchedule = vi.fn().mockReturnValue(ok(makeScheduleRow()));

    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({ insert: insertSchedule }),
      threadRepository: makeThreadRepo({ findById, findByExternalId, insert: insertThread }),
    });

    const result = await handler.execute(
      { action: 'create', cronExpr: '0 9 * * *', prompt: 'Follow-up' },
      makeContext(),
    );

    expect(result.status).toBe('success');
    // The resolved dedicated thread must re-use the unwrapped origin,
    // not the synthetic external_id of the invoking thread.
    expect(findByExternalId).toHaveBeenCalledWith(
      'channel-001',
      'schedule:assistant:telegram-main:chat-42',
    );
    const insertedMetadata = JSON.parse(insertThread.mock.calls[0][0].metadata) as Record<string, unknown>;
    expect(insertedMetadata.originExternalId).toBe('chat-42');
    expect(insertedMetadata.originExternalId).not.toMatch(/^schedule:/);
  });

  it('writes thread metadata that round-trips back through the schedule-thread marker reader', async () => {
    // Regression cover: if the insert-call shape test passes but the
    // metadata the handler emits is not in the shape channel.send /
    // agent-runner consume, scheduled delivery silently breaks. Assert
    // the contract end-to-end by parsing the metadata the way the
    // consumers do.
    const insertThread = vi.fn().mockImplementation((row) => ok({
      ...makeThreadRow(),
      ...row,
      created_at: 1000,
      updated_at: 1000,
    }));
    const handler = makeHandler({
      threadRepository: makeThreadRepo({
        findByExternalId: vi.fn().mockReturnValue(ok(null)),
        insert: insertThread,
      }),
    });

    await handler.execute(
      { action: 'create', cronExpr: '0 9 * * *', prompt: 'Round trip' },
      makeContext(),
    );

    const rawMetadata: string = insertThread.mock.calls[0][0].metadata;
    // Mirrors readOriginExternalId in channel-send.ts / agent-runner.ts.
    const parsed = JSON.parse(rawMetadata) as Record<string, unknown>;
    expect(parsed.kind).toBe('schedule');
    expect(parsed.originExternalId).toBe('chat-42');
  });

  it('inserts schedule with correct persona_id, cron, and computed next_run_at', async () => {
    const insertSchedule = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({ insert: insertSchedule }),
    });

    await handler.execute(
      { action: 'create', cronExpr: '*/5 * * * *', label: 'Poll', prompt: 'Check status' },
      makeContext({ personaId: 'persona-001' }),
    );

    const insertArg = insertSchedule.mock.calls[0][0];
    expect(insertArg.persona_id).toBe('persona-001');
    expect(insertArg.expression).toBe('*/5 * * * *');
    expect(insertArg.type).toBe('cron');
    expect(insertArg.enabled).toBe(1);
    expect(insertArg.next_run_at).toEqual(expect.any(Number));
    expect(insertArg.next_run_at).toBeGreaterThan(Date.now() - 60_000);
    expect(JSON.parse(insertArg.payload)).toEqual({ label: 'Poll', prompt: 'Check status' });
  });

  it('accepts promptFile when creating a schedule', async () => {
    const insertSchedule = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({ insert: insertSchedule }),
    });

    const result = await handler.execute(
      { action: 'create', cronExpr: '0 7 * * 1-5', label: 'Morning briefing', promptFile: 'morning-briefing' },
      makeContext(),
    );

    expect(result.status).toBe('success');
    expect(JSON.parse(insertSchedule.mock.calls[0][0].payload)).toEqual({
      label: 'Morning briefing',
      promptFile: 'morning-briefing',
    });
  });

  it('rejects create when prompt and promptFile are both provided', async () => {
    const handler = makeHandler();

    const result = await handler.execute(
      {
        action: 'create',
        cronExpr: '0 7 * * 1-5',
        prompt: 'Inline prompt',
        promptFile: 'morning-briefing',
      },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/mutually exclusive/i);
  });

  it('returns error when cronExpr is missing', async () => {
    const handler = makeHandler();
    const result = await handler.execute({ action: 'create' }, makeContext());
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/cronExpr is required/);
  });

  it('returns error for invalid cron expression', async () => {
    const handler = makeHandler();
    const result = await handler.execute(
      { action: 'create', cronExpr: 'not-a-cron' },
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/invalid cron expression/);
  });

  it('propagates insert repository errors', async () => {
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({
        insert: vi.fn().mockReturnValue(err(new DbError('db locked'))),
      }),
    });

    const result = await handler.execute(
      { action: 'create', cronExpr: '0 * * * *' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/create failed/);
  });

  it('returns an error when the invoking thread cannot be resolved', async () => {
    const handler = makeHandler({
      threadRepository: makeThreadRepo({
        findById: vi.fn().mockReturnValue(ok(null)),
      }),
    });

    const result = await handler.execute(
      { action: 'create', cronExpr: '0 9 * * 1' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/invoking thread .* not found/);
  });

  it('returns an error when the channel cannot be resolved', async () => {
    const handler = makeHandler({
      channelRepository: makeChannelRepo({
        findById: vi.fn().mockReturnValue(ok(null)),
      }),
    });

    const result = await handler.execute(
      { action: 'create', cronExpr: '0 9 * * 1' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/channel .* not found/);
  });

  it('returns an error when the persona cannot be resolved', async () => {
    const handler = makeHandler({
      personaRepository: makePersonaRepo({
        findById: vi.fn().mockReturnValue(ok(null)),
      }),
    });

    const result = await handler.execute(
      { action: 'create', cronExpr: '0 9 * * 1' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/persona .* not found/);
  });

  it('surfaces errors from the dedicated-thread lookup', async () => {
    const handler = makeHandler({
      threadRepository: makeThreadRepo({
        findByExternalId: vi.fn().mockReturnValue(err(new DbError('lookup failed'))),
      }),
    });

    const result = await handler.execute(
      { action: 'create', cronExpr: '0 9 * * 1' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/dedicated schedule thread/i);
  });

  it('surfaces errors from the dedicated-thread insert', async () => {
    const handler = makeHandler({
      threadRepository: makeThreadRepo({
        findByExternalId: vi.fn().mockReturnValue(ok(null)),
        insert: vi.fn().mockReturnValue(err(new DbError('insert failed'))),
      }),
    });

    const result = await handler.execute(
      { action: 'create', cronExpr: '0 9 * * 1' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/dedicated schedule thread/i);
  });

  it('handles missing label and prompt gracefully', async () => {
    const insertSchedule = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({ insert: insertSchedule }),
    });

    const result = await handler.execute(
      { action: 'create', cronExpr: '0 0 * * *' },
      makeContext(),
    );

    expect(result.status).toBe('success');
    const payload = JSON.parse(insertSchedule.mock.calls[0][0].payload);
    expect(payload).toEqual({ label: '' });
  });
});

// ---------------------------------------------------------------------------
// Action: update
// ---------------------------------------------------------------------------

describe('ScheduleManageHandler — update', () => {
  it('updates an existing schedule from the live thread', async () => {
    const updateFn = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({ update: updateFn }),
    });

    const result = await handler.execute(
      { action: 'update', scheduleId: 'sched-001', cronExpr: '0 10 * * *', label: 'New label' },
      makeContext({ threadId: 'live-thread-001' }),
    );

    expect(result.status).toBe('success');
    expect((result.result as { updated: boolean }).updated).toBe(true);
  });

  it('recomputes next_run_at when cronExpr changes', async () => {
    const updateFn = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({ update: updateFn }),
    });

    await handler.execute(
      { action: 'update', scheduleId: 'sched-001', cronExpr: '0 10 * * *' },
      makeContext(),
    );

    const updateArg = updateFn.mock.calls[0][2];
    expect(updateArg.expression).toBe('0 10 * * *');
    expect(updateArg.next_run_at).toEqual(expect.any(Number));
    expect(updateArg.next_run_at).toBeGreaterThan(Date.now() - 60_000);
  });

  it('enforces ownership by persona, not by invoking thread', async () => {
    const updateFn = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({ update: updateFn }),
    });

    await handler.execute(
      { action: 'update', scheduleId: 'sched-001', cronExpr: '0 10 * * *' },
      makeContext({ personaId: 'persona-xyz', threadId: 'some-other-thread' }),
    );

    expect(updateFn).toHaveBeenCalledWith('sched-001', 'persona-xyz', expect.any(Object));
  });

  it('returns error when scheduleId is missing', async () => {
    const handler = makeHandler();
    const result = await handler.execute(
      { action: 'update', cronExpr: '0 * * * *' },
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/scheduleId is required/);
  });

  it('returns error for invalid cron expression in update', async () => {
    const handler = makeHandler();
    const result = await handler.execute(
      { action: 'update', scheduleId: 'sched-001', cronExpr: 'bad cron here' },
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/invalid cron expression/);
  });

  it('returns error when no update fields are provided', async () => {
    const handler = makeHandler();
    const result = await handler.execute(
      { action: 'update', scheduleId: 'sched-001' },
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/no fields provided to update/);
  });

  it('propagates update repository errors', async () => {
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({
        update: vi.fn().mockReturnValue(err(new DbError('not found'))),
      }),
    });

    const result = await handler.execute(
      { action: 'update', scheduleId: 'sched-001', label: 'Updated label' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/update failed/);
  });

  it('accepts promptFile when updating a schedule', async () => {
    const updateFn = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({ update: updateFn }),
    });

    const result = await handler.execute(
      { action: 'update', scheduleId: 'sched-001', promptFile: 'meeting-prep' },
      makeContext(),
    );

    expect(result.status).toBe('success');
    expect(JSON.parse(updateFn.mock.calls[0][2].payload)).toEqual({
      label: 'Daily standup',
      promptFile: 'meeting-prep',
    });
  });

  it('rejects update when prompt and promptFile are both provided', async () => {
    const handler = makeHandler();
    const result = await handler.execute(
      {
        action: 'update',
        scheduleId: 'sched-001',
        prompt: 'Inline prompt',
        promptFile: 'meeting-prep',
      },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/mutually exclusive/i);
  });

  it('preserves the existing prompt source when only label changes', async () => {
    const updateFn = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({
        update: updateFn,
        findById: vi.fn().mockReturnValue(ok(makeScheduleRow())),
      }),
    });

    await handler.execute(
      { action: 'update', scheduleId: 'sched-001', label: 'Renamed schedule' },
      makeContext(),
    );

    expect(JSON.parse(updateFn.mock.calls[0][2].payload)).toEqual({
      label: 'Renamed schedule',
      prompt: 'What should I focus on today?',
    });
  });

  it('replaces inline prompt with promptFile on update', async () => {
    const updateFn = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({
        update: updateFn,
        findById: vi.fn().mockReturnValue(ok(makeScheduleRow())),
      }),
    });

    await handler.execute(
      { action: 'update', scheduleId: 'sched-001', promptFile: 'meeting-prep' },
      makeContext(),
    );

    expect(JSON.parse(updateFn.mock.calls[0][2].payload)).toEqual({
      label: 'Daily standup',
      promptFile: 'meeting-prep',
    });
  });

  it('rejects update when schedule does not exist', async () => {
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({
        findById: vi.fn().mockReturnValue(ok(null)),
      }),
    });

    const result = await handler.execute(
      { action: 'update', scheduleId: 'nonexistent', label: 'New label' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/not found/);
  });

  it('rejects update when schedule belongs to a different persona', async () => {
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({
        findById: vi.fn().mockReturnValue(ok(makeScheduleRow({ persona_id: 'other-persona' }))),
      }),
    });

    const result = await handler.execute(
      { action: 'update', scheduleId: 'sched-001', label: 'New label' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/does not belong/);
  });

  it('replaces promptFile with inline prompt on update', async () => {
    const updateFn = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({
        update: updateFn,
        findById: vi.fn().mockReturnValue(
          ok(
            makeScheduleRow({
              payload: '{"label":"Daily standup","promptFile":"meeting-prep"}',
            }),
          ),
        ),
      }),
    });

    await handler.execute(
      { action: 'update', scheduleId: 'sched-001', prompt: 'Use inline prompt instead' },
      makeContext(),
    );

    expect(JSON.parse(updateFn.mock.calls[0][2].payload)).toEqual({
      label: 'Daily standup',
      prompt: 'Use inline prompt instead',
    });
  });
});

// ---------------------------------------------------------------------------
// Action: cancel
// ---------------------------------------------------------------------------

describe('ScheduleManageHandler — cancel', () => {
  it('cancels a schedule by disabling it when invoked from the live thread', async () => {
    const disableFn = vi.fn().mockReturnValue(ok(undefined));
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({
        disable: disableFn,
        findById: vi.fn().mockReturnValue(ok(makeScheduleRow())),
      }),
    });

    const result = await handler.execute(
      { action: 'cancel', scheduleId: 'sched-001' },
      makeContext({ threadId: 'some-live-thread' }),
    );

    expect(result.status).toBe('success');
    expect((result.result as { cancelled: boolean }).cancelled).toBe(true);
    expect(disableFn).toHaveBeenCalledWith('sched-001');
  });

  it('returns error when scheduleId is missing', async () => {
    const handler = makeHandler();
    const result = await handler.execute({ action: 'cancel' }, makeContext());
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/scheduleId is required/);
  });

  it('returns error when scheduleId is empty string', async () => {
    const handler = makeHandler();
    const result = await handler.execute(
      { action: 'cancel', scheduleId: '' },
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/scheduleId is required/);
  });

  it('rejects cancel when schedule belongs to a different persona', async () => {
    const disableFn = vi.fn().mockReturnValue(ok(undefined));
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({
        disable: disableFn,
        findById: vi.fn().mockReturnValue(ok(makeScheduleRow({ persona_id: 'other-persona' }))),
      }),
    });

    const result = await handler.execute(
      { action: 'cancel', scheduleId: 'sched-001' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/does not belong/);
    expect(disableFn).not.toHaveBeenCalled();
  });

  it('rejects cancel when schedule does not exist', async () => {
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({
        findById: vi.fn().mockReturnValue(ok(null)),
      }),
    });

    const result = await handler.execute(
      { action: 'cancel', scheduleId: 'missing' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/not found/);
  });

  it('propagates disable repository errors', async () => {
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({
        disable: vi.fn().mockReturnValue(err(new DbError('row not found'))),
      }),
    });

    const result = await handler.execute(
      { action: 'cancel', scheduleId: 'sched-001' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/cancel failed/);
  });
});

// ---------------------------------------------------------------------------
// Action: delete
// ---------------------------------------------------------------------------

describe('ScheduleManageHandler — delete', () => {
  it('permanently deletes a schedule when invoked from the live thread', async () => {
    const deleteFn = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({ delete: deleteFn }),
    });

    const result = await handler.execute(
      { action: 'delete', scheduleId: 'sched-001' },
      makeContext({ threadId: 'some-live-thread' }),
    );

    expect(result.status).toBe('success');
    expect((result.result as { deleted: boolean }).deleted).toBe(true);
    expect(deleteFn).toHaveBeenCalledWith('sched-001', 'persona-001');
  });

  it('returns error when scheduleId is missing', async () => {
    const handler = makeHandler();
    const result = await handler.execute({ action: 'delete' }, makeContext());
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/scheduleId is required/);
  });

  it('returns error when scheduleId is empty string', async () => {
    const handler = makeHandler();
    const result = await handler.execute(
      { action: 'delete', scheduleId: '' },
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/scheduleId is required/);
  });

  it('returns error when schedule not found or not owned', async () => {
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({
        delete: vi.fn().mockReturnValue(ok(null)),
      }),
    });

    const result = await handler.execute(
      { action: 'delete', scheduleId: 'nonexistent' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/not found or not owned/);
  });

  it('propagates delete repository errors', async () => {
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({
        delete: vi.fn().mockReturnValue(err(new DbError('db locked'))),
      }),
    });

    const result = await handler.execute(
      { action: 'delete', scheduleId: 'sched-001' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/delete failed/);
  });
});

// ---------------------------------------------------------------------------
// Invalid action
// ---------------------------------------------------------------------------

describe('ScheduleManageHandler — invalid action', () => {
  it('returns error for unknown action', async () => {
    const handler = makeHandler();
    const result = await handler.execute(
      { action: 'pause' as ScheduleManageArgs['action'] },
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/invalid action/);
  });

  it('returns error for missing action', async () => {
    const handler = makeHandler();
    const result = await handler.execute(
      { action: undefined as unknown as ScheduleManageArgs['action'] },
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/invalid action/);
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe('ScheduleManageHandler — list', () => {
  it('returns every schedule owned by the persona regardless of invoking thread', async () => {
    const schedules = [
      // Schedule stored against the dedicated execution thread — must still be listed
      // when the agent invokes list from the live chat thread.
      makeScheduleRow({
        id: 'sched-001',
        expression: '0 9 * * 1',
        next_run_at: 1700000000000,
        thread_id: 'dedicated-schedule-thread-001',
      }),
      makeScheduleRow({
        id: 'sched-002',
        expression: '30 18 * * *',
        next_run_at: 1700050000000,
        enabled: 0,
        payload: '{"label":"Meeting prep","promptFile":"meeting-prep"}',
        thread_id: 'dedicated-schedule-thread-001',
      }),
    ];
    const findByPersona = vi.fn().mockReturnValue(ok(schedules));
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({ findByPersona }),
    });

    const result = await handler.execute(
      { action: 'list' },
      makeContext({ threadId: 'live-thread-001' }),
    );

    expect(result.status).toBe('success');
    expect(findByPersona).toHaveBeenCalledWith('persona-001');
    const data = result.result as { schedules: unknown[]; count: number };
    expect(data.count).toBe(2);
    expect(data.schedules).toHaveLength(2);
    expect(data.schedules[0]).toMatchObject({
      scheduleId: 'sched-001',
      expression: '0 9 * * 1',
      enabled: true,
    });
    expect(data.schedules[0]).not.toHaveProperty('promptFile');
    expect(data.schedules[1]).toMatchObject({
      scheduleId: 'sched-002',
      enabled: false,
      promptFile: 'meeting-prep',
    });
  });

  it('returns empty list when no schedules exist', async () => {
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({
        findByPersona: vi.fn().mockReturnValue(ok([])),
      }),
    });

    const result = await handler.execute({ action: 'list' }, makeContext());

    expect(result.status).toBe('success');
    const data = result.result as { schedules: unknown[]; count: number };
    expect(data.count).toBe(0);
    expect(data.schedules).toHaveLength(0);
  });

  it('returns error when repository fails', async () => {
    const handler = makeHandler({
      scheduleRepository: makeScheduleRepo({
        findByPersona: vi.fn().mockReturnValue(err(new DbError('DB read failed'))),
      }),
    });

    const result = await handler.execute({ action: 'list' }, makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toContain('list failed');
  });
});
