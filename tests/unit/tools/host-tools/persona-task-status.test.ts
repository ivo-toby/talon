import { afterEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from 'neverthrow';
import { PersonaTaskStatusHandler } from '../../../../src/tools/host-tools/persona-task-status.js';
import type { ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import type { A2ATaskMapper } from '../../../../src/a2a/a2a-task-mapper.js';
import type { A2ATaskStatus } from '../../../../src/a2a/a2a-types.js';
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

function makeTaskStatus(overrides: Partial<A2ATaskStatus> = {}): A2ATaskStatus {
  return {
    taskId: 'task-123',
    state: 'submitted',
    sourcePersona: 'assistant',
    targetPersona: 'work-context-manager',
    threadId: 'thread-001',
    queueItemId: 'queue-123',
    submittedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeTaskMapper(): A2ATaskMapper {
  return {
    getTaskStatus: vi.fn().mockReturnValue(ok(makeTaskStatus())),
  } as unknown as A2ATaskMapper;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PersonaTaskStatusHandler', () => {
  it('returns the current task status', async () => {
    const taskMapper = makeTaskMapper();
    const handler = new PersonaTaskStatusHandler({ taskMapper, logger: makeLogger() });

    const result = await handler.execute({ task_id: 'task-123' }, makeContext());

    expect(result.status).toBe('success');
    expect(result.result).toEqual({
      task_id: 'task-123',
      state: 'submitted',
      source_persona: 'assistant',
      target_persona: 'work-context-manager',
    });
  });

  it('polls until terminal when wait_ms is provided', async () => {
    vi.useFakeTimers();

    const taskMapper = makeTaskMapper();
    (taskMapper.getTaskStatus as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(ok(makeTaskStatus({ state: 'working' })))
      .mockReturnValueOnce(ok(makeTaskStatus({
        state: 'completed',
        completedAt: 1200,
        result: { text: 'Finished work' },
      })));
    const handler = new PersonaTaskStatusHandler({
      taskMapper,
      logger: makeLogger(),
      pollIntervalMs: 10,
    });

    const resultPromise = handler.execute({ task_id: 'task-123', wait_ms: 50 }, makeContext());
    await vi.advanceTimersByTimeAsync(20);
    const result = await resultPromise;

    expect(result.status).toBe('success');
    expect(result.result).toEqual({
      task_id: 'task-123',
      state: 'completed',
      source_persona: 'assistant',
      target_persona: 'work-context-manager',
      completed_at: 1200,
      result: 'Finished work',
    });
  });

  it('returns the latest status plus timeout note when wait_ms expires', async () => {
    vi.useFakeTimers();

    const taskMapper = makeTaskMapper();
    (taskMapper.getTaskStatus as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      ok(makeTaskStatus({ state: 'working' })),
    );
    const handler = new PersonaTaskStatusHandler({
      taskMapper,
      logger: makeLogger(),
      pollIntervalMs: 10,
    });

    const resultPromise = handler.execute({ task_id: 'task-123', wait_ms: 30 }, makeContext());
    await vi.advanceTimersByTimeAsync(30);
    const result = await resultPromise;

    expect(result.status).toBe('success');
    expect(result.result).toEqual({
      task_id: 'task-123',
      state: 'working',
      source_persona: 'assistant',
      target_persona: 'work-context-manager',
      error: 'Timed out waiting for delegated task to reach a terminal state.',
    });
  });

  it('rejects tasks from another thread', async () => {
    const taskMapper = makeTaskMapper();
    (taskMapper.getTaskStatus as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      ok(makeTaskStatus({ threadId: 'thread-other' })),
    );
    const handler = new PersonaTaskStatusHandler({ taskMapper, logger: makeLogger() });

    const result = await handler.execute({ task_id: 'task-123' }, makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/does not belong to the current thread/);
  });

  it('surfaces missing task and mapper failures', async () => {
    const taskMapper = makeTaskMapper();
    (taskMapper.getTaskStatus as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(ok(null))
      .mockReturnValueOnce(err(new A2AError('db unavailable')));
    const handler = new PersonaTaskStatusHandler({ taskMapper, logger: makeLogger() });

    const missing = await handler.execute({ task_id: 'task-123' }, makeContext());
    const failed = await handler.execute({ task_id: 'task-123' }, makeContext());

    expect(missing.status).toBe('error');
    expect(missing.error).toMatch(/task task-123 not found/);
    expect(failed.status).toBe('error');
    expect(failed.error).toMatch(/failed to load task task-123/);
  });
});
