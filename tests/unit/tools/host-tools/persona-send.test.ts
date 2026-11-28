/**
 * Unit tests for PersonaSendHandler.
 *
 * Tests cover:
 *   - Manifest metadata
 *   - Fire-and-forget submission
 *   - Await-reply polling to completion
 *   - Await-reply timeout
 *   - Unknown target persona surfaced from submitTask()
 *   - Empty message validation
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from 'neverthrow';
import { PersonaSendHandler } from '../../../../src/tools/host-tools/persona-send.js';
import type { PersonaSendArgs } from '../../../../src/tools/host-tools/persona-send.js';
import type { ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import type { A2ATaskMapper } from '../../../../src/a2a/a2a-task-mapper.js';
import type { A2ATaskRow } from '../../../../src/a2a/a2a-types.js';
import type { A2ATaskRepository } from '../../../../src/core/database/repositories/a2a-task-repository.js';
import type { PersonaRepository, PersonaRow } from '../../../../src/core/database/repositories/persona-repository.js';
import type { ResolvedCapabilities } from '../../../../src/personas/persona-types.js';
import { A2AError } from '../../../../src/core/errors/error-types.js';

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
    threadId: 'thread-001',
    personaId: 'persona-001',
    requestId: 'req-001',
    ...overrides,
  };
}

function makeArgs(overrides: Partial<PersonaSendArgs> = {}): PersonaSendArgs {
  return {
    target_persona: 'researcher',
    message: 'Investigate this task',
    ...overrides,
  };
}

function makePersonaRow(overrides: Partial<PersonaRow> = {}): PersonaRow {
  return {
    id: 'persona-001',
    name: 'coordinator',
    model: 'gpt-test',
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

function makeTaskRow(overrides: Partial<A2ATaskRow> = {}): A2ATaskRow {
  return {
    id: 'task-123',
    source_persona: 'coordinator',
    target_persona: 'researcher',
    thread_id: 'thread-001',
    queue_item_id: 'queue-123',
    run_id: null,
    state: 'submitted',
    request_payload: '{"content":"Investigate this task"}',
    result_payload: null,
    error_code: null,
    error_message: null,
    hop_count: 0,
    parent_task_id: null,
    submitted_at: 1000,
    updated_at: 1000,
    completed_at: null,
    ...overrides,
  };
}

function makeTaskMapper(): A2ATaskMapper {
  return {
    cancelTask: vi.fn().mockReturnValue(ok(true)),
    submitTask: vi.fn().mockReturnValue(
      ok({
        taskId: 'task-123',
        state: 'submitted',
        sourcePersona: 'coordinator',
        targetPersona: 'researcher',
        threadId: 'thread-001',
        queueItemId: 'queue-123',
        submittedAt: 1000,
        updatedAt: 1000,
      }),
    ),
  } as unknown as A2ATaskMapper;
}

function makeTaskRepo(): A2ATaskRepository {
  return {
    findById: vi.fn().mockReturnValue(ok(makeTaskRow())),
  } as unknown as A2ATaskRepository;
}

function makePersonaRepo(): PersonaRepository {
  return {
    findById: vi.fn().mockReturnValue(ok(makePersonaRow())),
  } as unknown as PersonaRepository;
}

const allCaps = (): ResolvedCapabilities => ({ allow: ['persona.send:*'], requireApproval: [] });

afterEach(() => {
  vi.useRealTimers();
});

describe('PersonaSendHandler — manifest', () => {
  it('has the correct tool name', () => {
    expect(PersonaSendHandler.manifest.name).toBe('persona.send');
  });
});

describe('PersonaSendHandler — success', () => {
  it('fire-and-forget: valid target and message returns submitted state', async () => {
    const taskMapper = makeTaskMapper();
    const taskRepo = makeTaskRepo();
    const personaRepo = makePersonaRepo();
    const handler = new PersonaSendHandler({ taskMapper, taskRepo, personaRepo, logger: makeLogger(), resolveCapabilities: allCaps });

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('success');
    expect(result.tool).toBe('persona.send');
    expect(result.requestId).toBe('req-001');
    expect(result.result).toEqual({ task_id: 'task-123', state: 'submitted' });
    expect(taskMapper.submitTask).toHaveBeenCalledWith({
      sourcePersona: 'coordinator',
      targetPersona: 'researcher',
      sourceThreadId: 'thread-001',
      content: 'Investigate this task',
      hopCount: 1,
    });
    expect(taskRepo.findById).not.toHaveBeenCalled();
  });

  it('await_reply: true polls and returns result when state becomes completed', async () => {
    vi.useFakeTimers();

    const taskMapper = makeTaskMapper();
    const taskRepo = makeTaskRepo();
    const personaRepo = makePersonaRepo();
    (taskRepo.findById as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(ok(makeTaskRow({ state: 'working' })))
      .mockReturnValueOnce(
        ok(
          makeTaskRow({
            state: 'completed',
            result_payload: JSON.stringify({ text: 'Task complete' }),
            completed_at: 1020,
            updated_at: 1020,
          }),
        ),
      );

    const handler = new PersonaSendHandler({
      resolveCapabilities: allCaps,
      taskMapper,
      taskRepo,
      personaRepo,
      logger: makeLogger(),
      maxWaitMs: 100,
      pollIntervalMs: 10,
    });

    const resultPromise = handler.execute(makeArgs({ await_reply: true }), makeContext());
    await vi.advanceTimersByTimeAsync(20);
    const result = await resultPromise;

    expect(result.status).toBe('success');
    expect(result.result).toEqual({
      task_id: 'task-123',
      state: 'completed',
      result: 'Task complete',
    });
    expect(taskRepo.findById).toHaveBeenCalledTimes(2);
  });

  it('passes timeout_ms through to the sync wait budget', async () => {
    vi.useFakeTimers();

    const taskMapper = makeTaskMapper();
    const taskRepo = makeTaskRepo();
    const personaRepo = makePersonaRepo();
    (taskRepo.findById as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      ok(makeTaskRow({ state: 'working' })),
    );

    const handler = new PersonaSendHandler({
      resolveCapabilities: allCaps,
      taskMapper,
      taskRepo,
      personaRepo,
      logger: makeLogger(),
      maxWaitMs: 100,
      pollIntervalMs: 10,
    });

    const resultPromise = handler.execute(
      makeArgs({ await_reply: true, timeout_ms: 250 }),
      makeContext(),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(taskRepo.findById).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(150);
    const result = await resultPromise;

    expect(result.status).toBe('success');
    expect(result.result).toEqual({
      task_id: 'task-123',
      state: 'timeout',
      error: 'Timed out waiting for delegated persona reply. The delegated task may still complete asynchronously. Use persona_task_status with this task_id to fetch the final result later.',
    });
  });
});

describe('PersonaSendHandler — hop count propagation', () => {
  it('increments hop count from context.a2aHopCount when set', async () => {
    const taskMapper = makeTaskMapper();
    const taskRepo = makeTaskRepo();
    const personaRepo = makePersonaRepo();
    const handler = new PersonaSendHandler({ taskMapper, taskRepo, personaRepo, logger: makeLogger(), resolveCapabilities: allCaps });

    await handler.execute(makeArgs(), makeContext({ a2aHopCount: 0 }));

    expect(taskMapper.submitTask).toHaveBeenCalledWith(
      expect.objectContaining({ hopCount: 1 }),
    );
  });

  it('passes parentTaskId when context.a2aTaskId is set', async () => {
    const taskMapper = makeTaskMapper();
    const taskRepo = makeTaskRepo();
    const personaRepo = makePersonaRepo();
    const handler = new PersonaSendHandler({ taskMapper, taskRepo, personaRepo, logger: makeLogger(), resolveCapabilities: allCaps });

    await handler.execute(makeArgs(), makeContext({ a2aTaskId: 'parent-task-456' }));

    expect(taskMapper.submitTask).toHaveBeenCalledWith(
      expect.objectContaining({ parentTaskId: 'parent-task-456' }),
    );
  });
});

describe('PersonaSendHandler — timeout and errors', () => {
  it('await_reply: true returns timeout state if polling times out', async () => {
    vi.useFakeTimers();

    const taskMapper = makeTaskMapper();
    const taskRepo = makeTaskRepo();
    const personaRepo = makePersonaRepo();
    (taskRepo.findById as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      ok(makeTaskRow({ state: 'working' })),
    );

    const handler = new PersonaSendHandler({
      resolveCapabilities: allCaps,
      taskMapper,
      taskRepo,
      personaRepo,
      logger: makeLogger(),
      maxWaitMs: 100,
      pollIntervalMs: 10,
    });

    const resultPromise = handler.execute(makeArgs({ await_reply: true }), makeContext());
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result.status).toBe('success');
    expect(result.result).toEqual({
      task_id: 'task-123',
      state: 'timeout',
      error: 'Timed out waiting for delegated persona reply. The delegated task may still complete asynchronously. Use persona_task_status with this task_id to fetch the final result later.',
    });
  });

  it('unknown target persona (submitTask returns err) returns error result', async () => {
    const taskMapper = makeTaskMapper();
    const taskRepo = makeTaskRepo();
    const personaRepo = makePersonaRepo();
    (taskMapper.submitTask as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      err(new A2AError('Unknown target persona: ghost')),
    );

    const handler = new PersonaSendHandler({ taskMapper, taskRepo, personaRepo, logger: makeLogger(), resolveCapabilities: allCaps });

    const result = await handler.execute(makeArgs({ target_persona: 'ghost' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/Unknown target persona: ghost/);
  });

  it('empty message returns validation error and does not call submitTask', async () => {
    const taskMapper = makeTaskMapper();
    const taskRepo = makeTaskRepo();
    const personaRepo = makePersonaRepo();
    const handler = new PersonaSendHandler({ taskMapper, taskRepo, personaRepo, logger: makeLogger(), resolveCapabilities: allCaps });

    const result = await handler.execute(makeArgs({ message: '   ' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/message is required/);
    expect(taskMapper.submitTask).not.toHaveBeenCalled();
  });

  it('rejects invalid timeout_ms values', async () => {
    const taskMapper = makeTaskMapper();
    const taskRepo = makeTaskRepo();
    const personaRepo = makePersonaRepo();
    const handler = new PersonaSendHandler({ taskMapper, taskRepo, personaRepo, logger: makeLogger(), resolveCapabilities: allCaps });

    const result = await handler.execute(
      makeArgs({ await_reply: true, timeout_ms: 0 }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/timeout_ms must be a positive integer/);
    expect(taskMapper.submitTask).not.toHaveBeenCalled();
  });
});

const TIMEOUT_TEXT =
  'Timed out waiting for delegated persona reply. The delegated task may still complete asynchronously. Use persona_task_status with this task_id to fetch the final result later.';

describe('PersonaSendHandler — cancel_on_timeout', () => {
  function setup(rowSequence: A2ATaskRow[] | null = null) {
    vi.useFakeTimers();
    const taskMapper = makeTaskMapper();
    const taskRepo = makeTaskRepo();
    const findById = taskRepo.findById as unknown as ReturnType<typeof vi.fn>;
    findById.mockReturnValue(ok(makeTaskRow({ state: 'working' })));
    if (rowSequence) {
      for (const row of rowSequence) findById.mockReturnValueOnce(ok(row));
    }
    const handler = new PersonaSendHandler({
      resolveCapabilities: allCaps,
      taskMapper,
      taskRepo,
      personaRepo: makePersonaRepo(),
      logger: makeLogger(),
      maxWaitMs: 100,
      pollIntervalMs: 10,
    });
    return { taskMapper, taskRepo, handler };
  }

  it('cancels the task and returns canceled when the wait times out', async () => {
    const { taskMapper, handler } = setup();
    const p = handler.execute(makeArgs({ await_reply: true, cancel_on_timeout: true }), makeContext());
    await vi.advanceTimersByTimeAsync(100);
    const result = await p;

    expect(taskMapper.cancelTask).toHaveBeenCalledWith('task-123', 'await_reply timed out');
    expect(result.status).toBe('success');
    expect(result.result).toMatchObject({ task_id: 'task-123', state: 'canceled' });
    expect((result.result as { error: string }).error).toMatch(/canceled/);
  });

  it('returns the real terminal output when cancelTask reports it already finished', async () => {
    const { taskMapper, taskRepo, handler } = setup();
    (taskMapper.cancelTask as unknown as ReturnType<typeof vi.fn>).mockReturnValue(ok(false));
    const findById = taskRepo.findById as unknown as ReturnType<typeof vi.fn>;
    const p = handler.execute(makeArgs({ await_reply: true, cancel_on_timeout: true }), makeContext());
    await vi.advanceTimersByTimeAsync(95);
    findById.mockReturnValue(
      ok(makeTaskRow({ state: 'completed', result_payload: JSON.stringify({ text: 'late result' }) })),
    );
    await vi.advanceTimersByTimeAsync(10);
    const result = await p;

    expect(result.result).toEqual({ task_id: 'task-123', state: 'completed', result: 'late result' });
  });

  it('notes the cancel failure in the timeout output when cancelTask errors', async () => {
    const { taskMapper, handler } = setup();
    (taskMapper.cancelTask as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      err(new A2AError('db locked')),
    );
    const p = handler.execute(makeArgs({ await_reply: true, cancel_on_timeout: true }), makeContext());
    await vi.advanceTimersByTimeAsync(100);
    const result = await p;

    expect(result.status).toBe('success');
    expect(result.result).toMatchObject({ task_id: 'task-123', state: 'timeout' });
    expect((result.result as { error: string }).error).toContain(TIMEOUT_TEXT);
    expect((result.result as { error: string }).error).toMatch(/db locked/);
  });

  it('does not cancel by default', async () => {
    const { taskMapper, handler } = setup();
    const p = handler.execute(makeArgs({ await_reply: true }), makeContext());
    await vi.advanceTimersByTimeAsync(100);
    const result = await p;

    expect(taskMapper.cancelTask).not.toHaveBeenCalled();
    expect(result.result).toEqual({ task_id: 'task-123', state: 'timeout', error: TIMEOUT_TEXT });
  });

  it('does not cancel when the task completes before the timeout', async () => {
    const { taskMapper, handler } = setup([
      makeTaskRow({ state: 'completed', result_payload: JSON.stringify({ text: 'ok' }) }),
    ]);
    const result = await handler.execute(
      makeArgs({ await_reply: true, cancel_on_timeout: true }),
      makeContext(),
    );
    expect(taskMapper.cancelTask).not.toHaveBeenCalled();
    expect(result.result).toEqual({ task_id: 'task-123', state: 'completed', result: 'ok' });
  });

  it('rejects a non-boolean cancel_on_timeout before submitting', async () => {
    const taskMapper = makeTaskMapper();
    const handler = new PersonaSendHandler({
      resolveCapabilities: allCaps,
      taskMapper,
      taskRepo: makeTaskRepo(),
      personaRepo: makePersonaRepo(),
      logger: makeLogger(),
    });
    const result = await handler.execute(
      makeArgs({ await_reply: true, cancel_on_timeout: 'yes' as unknown as boolean }),
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/cancel_on_timeout must be a boolean/);
    expect(taskMapper.submitTask).not.toHaveBeenCalled();
  });

  it('includes the stored reason when the awaited task is already canceled', async () => {
    const { handler } = setup([makeTaskRow({ state: 'canceled', error_message: 'canceled by operator' })]);
    const result = await handler.execute(makeArgs({ await_reply: true }), makeContext());
    expect(result.result).toEqual({ task_id: 'task-123', state: 'canceled', error: 'canceled by operator' });
  });
});

describe('PersonaSendHandler — waitScope', () => {
  it('wraps only the polling, not submission, and passes the context', async () => {
    const order: string[] = [];
    const taskMapper = makeTaskMapper();
    (taskMapper.submitTask as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('submit');
      return ok({ taskId: 'task-123', state: 'submitted' });
    });
    const taskRepo = makeTaskRepo();
    (taskRepo.findById as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('poll');
      return ok(makeTaskRow({ state: 'completed', result_payload: JSON.stringify({ text: 'done' }) }));
    });
    const waitScope = vi.fn(async (fn: () => Promise<unknown>) => {
      order.push('scope-start');
      try {
        return await fn();
      } finally {
        order.push('scope-end');
      }
    });
    const handler = new PersonaSendHandler({
      resolveCapabilities: allCaps,
      taskMapper,
      taskRepo,
      personaRepo: makePersonaRepo(),
      logger: makeLogger(),
      waitScope: waitScope as never,
    });
    const ctx = makeContext();

    const result = await handler.execute(makeArgs({ await_reply: true }), ctx);

    expect(order).toEqual(['submit', 'scope-start', 'poll', 'scope-end']);
    expect(waitScope).toHaveBeenCalledWith(expect.any(Function), ctx);
    expect(result.result).toEqual({ task_id: 'task-123', state: 'completed', result: 'done' });
  });

  it('is not used for fire-and-forget sends', async () => {
    const waitScope = vi.fn();
    const handler = new PersonaSendHandler({
      resolveCapabilities: allCaps,
      taskMapper: makeTaskMapper(),
      taskRepo: makeTaskRepo(),
      personaRepo: makePersonaRepo(),
      logger: makeLogger(),
      waitScope: waitScope as never,
    });
    await handler.execute(makeArgs(), makeContext());
    expect(waitScope).not.toHaveBeenCalled();
  });
});

describe('PersonaSendHandler — persona.send scopes', () => {
  function build(caps: ResolvedCapabilities) {
    const taskMapper = makeTaskMapper();
    const resolveCapabilities = vi.fn().mockReturnValue(caps);
    const handler = new PersonaSendHandler({
      taskMapper,
      taskRepo: makeTaskRepo(),
      personaRepo: makePersonaRepo(),
      logger: makeLogger(),
      resolveCapabilities,
    });
    return { taskMapper, resolveCapabilities, handler };
  }

  it('allows a target named by a scoped label', async () => {
    const { taskMapper, handler, resolveCapabilities } = build({
      allow: ['persona.send:researcher'],
      requireApproval: [],
    });

    const result = await handler.execute(makeArgs({ target_persona: 'researcher' }), makeContext());

    expect(result.status).toBe('success');
    expect(taskMapper.submitTask).toHaveBeenCalledTimes(1);
    // Capabilities are resolved from the trusted context persona, never from args.
    expect(resolveCapabilities).toHaveBeenCalledWith('persona-001');
  });

  it('rejects a target outside the scoped labels before submitting, naming the allowed targets', async () => {
    const { taskMapper, handler } = build({
      allow: ['persona.send:researcher', 'persona.send:coder'],
      requireApproval: [],
    });

    const result = await handler.execute(makeArgs({ target_persona: 'admin' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toContain('"admin"');
    expect(result.error).toContain('Allowed targets: coder, researcher.');
    expect(taskMapper.submitTask).not.toHaveBeenCalled();
  });

  it('allows several scoped targets', async () => {
    const { taskMapper, handler } = build({
      allow: ['persona.send:researcher'],
      requireApproval: ['persona.send:coder'],
    });

    expect((await handler.execute(makeArgs({ target_persona: 'researcher' }), makeContext())).status).toBe('success');
    expect((await handler.execute(makeArgs({ target_persona: 'coder' }), makeContext())).status).toBe('success');
    expect(taskMapper.submitTask).toHaveBeenCalledTimes(2);
  });

  it('allows any target with persona.send:* and with an unscoped persona.send', async () => {
    for (const label of ['persona.send:*', 'persona.send']) {
      const { taskMapper, handler } = build({ allow: [label], requireApproval: [] });
      const result = await handler.execute(makeArgs({ target_persona: 'anyone' }), makeContext());
      expect(result.status).toBe('success');
      expect(taskMapper.submitTask).toHaveBeenCalledTimes(1);
    }
  });

  it('fails closed when the caller has no persona.send label', async () => {
    const { taskMapper, handler } = build({ allow: [], requireApproval: [] });

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toContain('Allowed targets: none.');
    expect(taskMapper.submitTask).not.toHaveBeenCalled();
  });

  it('uses the capabilities of the persona in the context on A2A hops', async () => {
    const { resolveCapabilities, handler } = build({ allow: ['persona.send:coder'], requireApproval: [] });

    const result = await handler.execute(
      makeArgs({ target_persona: 'researcher' }),
      makeContext({ personaId: 'delegated-persona', a2aHopCount: 1, a2aTaskId: 'parent-task' }),
    );

    expect(result.status).toBe('error');
    expect(resolveCapabilities).toHaveBeenCalledWith('delegated-persona');
  });
});
