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
    const handler = new PersonaSendHandler({ taskMapper, taskRepo, personaRepo, logger: makeLogger() });

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
    const handler = new PersonaSendHandler({ taskMapper, taskRepo, personaRepo, logger: makeLogger() });

    await handler.execute(makeArgs(), makeContext({ a2aHopCount: 0 }));

    expect(taskMapper.submitTask).toHaveBeenCalledWith(
      expect.objectContaining({ hopCount: 1 }),
    );
  });

  it('passes parentTaskId when context.a2aTaskId is set', async () => {
    const taskMapper = makeTaskMapper();
    const taskRepo = makeTaskRepo();
    const personaRepo = makePersonaRepo();
    const handler = new PersonaSendHandler({ taskMapper, taskRepo, personaRepo, logger: makeLogger() });

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

    const handler = new PersonaSendHandler({ taskMapper, taskRepo, personaRepo, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ target_persona: 'ghost' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/Unknown target persona: ghost/);
  });

  it('empty message returns validation error and does not call submitTask', async () => {
    const taskMapper = makeTaskMapper();
    const taskRepo = makeTaskRepo();
    const personaRepo = makePersonaRepo();
    const handler = new PersonaSendHandler({ taskMapper, taskRepo, personaRepo, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ message: '   ' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/message is required/);
    expect(taskMapper.submitTask).not.toHaveBeenCalled();
  });

  it('rejects invalid timeout_ms values', async () => {
    const taskMapper = makeTaskMapper();
    const taskRepo = makeTaskRepo();
    const personaRepo = makePersonaRepo();
    const handler = new PersonaSendHandler({ taskMapper, taskRepo, personaRepo, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ await_reply: true, timeout_ms: 0 }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/timeout_ms must be a positive integer/);
    expect(taskMapper.submitTask).not.toHaveBeenCalled();
  });
});
