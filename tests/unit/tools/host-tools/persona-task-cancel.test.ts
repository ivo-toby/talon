import { describe, expect, it, vi } from 'vitest';
import { err, ok } from 'neverthrow';
import { PersonaTaskCancelHandler } from '../../../../src/tools/host-tools/persona-task-cancel.js';
import type { ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import type { A2ATaskMapper } from '../../../../src/a2a/a2a-task-mapper.js';
import type { A2ATaskStatus } from '../../../../src/a2a/a2a-types.js';
import type { PersonaRepository } from '../../../../src/core/database/repositories/persona-repository.js';
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

function makeStatus(overrides: Partial<A2ATaskStatus> = {}): A2ATaskStatus {
  return {
    taskId: 'task-123',
    state: 'working',
    sourcePersona: 'assistant',
    targetPersona: 'researcher',
    threadId: 'thread-001',
    submittedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function setup(opts: { status?: A2ATaskStatus | null; cancel?: boolean; callerName?: string } = {}) {
  const status = opts.status === undefined ? makeStatus() : opts.status;
  const getTaskStatus = vi.fn().mockReturnValue(ok(status));
  const cancelTask = vi.fn().mockReturnValue(ok(opts.cancel ?? true));
  const taskMapper = { getTaskStatus, cancelTask } as unknown as A2ATaskMapper;
  const personaRepo = {
    findById: vi.fn().mockReturnValue(ok({ id: 'persona-001', name: opts.callerName ?? 'assistant' })),
  } as unknown as PersonaRepository;
  const handler = new PersonaTaskCancelHandler({ taskMapper, personaRepo, logger: makeLogger() });
  return { handler, getTaskStatus, cancelTask, personaRepo };
}

describe('PersonaTaskCancelHandler', () => {
  it('has the persona.task_cancel manifest under the persona.send capability', () => {
    expect(PersonaTaskCancelHandler.manifest.name).toBe('persona.task_cancel');
    expect(PersonaTaskCancelHandler.manifest.capabilities).toEqual(['persona.send:*']);
    expect(PersonaTaskCancelHandler.manifest.executionLocation).toBe('host');
  });

  it('cancels a non-terminal task submitted by the caller in the current thread', async () => {
    const { handler, cancelTask } = setup();

    const result = await handler.execute({ task_id: 'task-123', reason: 'not needed' }, makeContext());

    expect(result.status).toBe('success');
    expect(result.tool).toBe('persona.task_cancel');
    expect(result.result).toEqual({ task_id: 'task-123', state: 'canceled', canceled: true });
    expect(cancelTask).toHaveBeenCalledWith('task-123', 'not needed');
  });

  it('uses a default reason naming the caller when none is given', async () => {
    const { handler, cancelTask } = setup();
    await handler.execute({ task_id: 'task-123' }, makeContext());
    expect(cancelTask).toHaveBeenCalledWith('task-123', 'canceled by assistant via persona_task_cancel');
  });

  it('reports canceled=false with the real state when the task is already terminal', async () => {
    const { handler, getTaskStatus } = setup({ cancel: false });
    getTaskStatus
      .mockReturnValueOnce(ok(makeStatus({ state: 'completed' })))
      .mockReturnValueOnce(ok(makeStatus({ state: 'completed' })));

    const result = await handler.execute({ task_id: 'task-123' }, makeContext());

    expect(result.status).toBe('success');
    expect(result.result).toEqual({ task_id: 'task-123', state: 'completed', canceled: false });
  });

  it('rejects a task from another thread without canceling', async () => {
    const { handler, cancelTask } = setup({ status: makeStatus({ threadId: 'other-thread' }) });

    const result = await handler.execute({ task_id: 'task-123' }, makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toContain('does not belong to the current thread');
    expect(cancelTask).not.toHaveBeenCalled();
  });

  it('rejects a task submitted by a different persona without canceling', async () => {
    const { handler, cancelTask } = setup({ status: makeStatus({ sourcePersona: 'someone-else' }) });

    const result = await handler.execute({ task_id: 'task-123' }, makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toContain('not submitted by this persona');
    expect(cancelTask).not.toHaveBeenCalled();
  });

  it('rejects an unknown task', async () => {
    const { handler, cancelTask } = setup({ status: null });
    const result = await handler.execute({ task_id: 'nope' }, makeContext());
    expect(result.status).toBe('error');
    expect(result.error).toContain('not found');
    expect(cancelTask).not.toHaveBeenCalled();
  });

  it('validates task_id and reason', async () => {
    const { handler, cancelTask } = setup();
    expect((await handler.execute({ task_id: '  ' }, makeContext())).status).toBe('error');
    expect((await handler.execute({ task_id: 'task-123', reason: 5 as unknown as string }, makeContext())).error)
      .toContain('reason must be a string');
    expect(cancelTask).not.toHaveBeenCalled();
  });

  it('fails when the calling persona cannot be resolved', async () => {
    const { handler, personaRepo, cancelTask } = setup();
    vi.mocked(personaRepo.findById).mockReturnValue(ok(null));
    const result = await handler.execute({ task_id: 'task-123' }, makeContext());
    expect(result.status).toBe('error');
    expect(cancelTask).not.toHaveBeenCalled();
  });

  it('surfaces a cancelTask failure as an error result', async () => {
    const { handler, cancelTask } = setup();
    cancelTask.mockReturnValue(err(new A2AError('db locked')));
    const result = await handler.execute({ task_id: 'task-123' }, makeContext());
    expect(result.status).toBe('error');
    expect(result.error).toContain('db locked');
  });
});
