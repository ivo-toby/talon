import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { BackgroundTaskRepository } from '../../../../../src/core/database/repositories/background-task-repository.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE background_tasks (
      id              TEXT PRIMARY KEY,
      persona_id      TEXT NOT NULL,
      provider_name   TEXT NOT NULL,
      thread_id       TEXT NOT NULL,
      channel_id      TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      working_dir     TEXT,
      status          TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'completed', 'failed', 'timed_out', 'cancelled')),
      output          TEXT,
      error           TEXT,
      pid             INTEGER,
      created_at      INTEGER NOT NULL,
      started_at      INTEGER NOT NULL,
      completed_at        INTEGER,
      timeout_minutes     INTEGER NOT NULL DEFAULT 30,
      parent_traceparent  TEXT,
      sandbox_enabled     INTEGER NOT NULL DEFAULT 0,
      primary_execution_env_id TEXT
    );

    CREATE INDEX idx_background_tasks_status ON background_tasks(status);
    CREATE INDEX idx_background_tasks_thread_created ON background_tasks(thread_id, created_at DESC);
  `);
  return db;
}

describe('BackgroundTaskRepository', () => {
  let db: Database.Database;
  let repo: BackgroundTaskRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new BackgroundTaskRepository(db);
  });

  const baseInput = {
    id: 'task-1',
    personaId: 'persona-1',
    providerName: 'claude-code',
    threadId: 'thread-1',
    channelId: 'channel-1',
    prompt: 'Refactor the auth module',
    workingDirectory: '/workspace/repo',
    status: 'running' as const,
    output: null,
    error: null,
    pid: null,
    timeoutMinutes: 30,
    sandboxEnabled: false,
    primaryExecutionEnvId: null,
  };

  it('creates a task with timestamps', () => {
    const result = repo.create(baseInput);
    expect(result.isOk()).toBe(true);

    const task = result._unsafeUnwrap();
    expect(task.id).toBe('task-1');
    expect(task.status).toBe('running');
    expect(task.providerName).toBe('claude-code');
    expect(task.createdAt).toBeGreaterThan(0);
    expect(task.startedAt).toBeGreaterThan(0);
    expect(task.completedAt).toBeNull();
    expect(task.sandboxEnabled).toBe(false);
    expect(task.primaryExecutionEnvId).toBeNull();
  });

  it('persists sandbox metadata for a task', () => {
    repo.create({
      ...baseInput,
      id: 'task-sandboxed',
      sandboxEnabled: true,
      primaryExecutionEnvId: 'env-123',
    });

    const task = repo.findById('task-sandboxed')._unsafeUnwrap();
    expect(task?.sandboxEnabled).toBe(true);
    expect(task?.primaryExecutionEnvId).toBe('env-123');
  });

  it('updates the pid for a running task', () => {
    repo.create(baseInput);

    const result = repo.updatePid('task-1', 4242);
    expect(result.isOk()).toBe(true);

    const task = repo.findById('task-1')._unsafeUnwrap();
    expect(task?.pid).toBe(4242);
  });

  it('updates a task to completed and sets completedAt', () => {
    repo.create(baseInput);

    const result = repo.updateStatus('task-1', 'completed', 'done', undefined);
    expect(result.isOk()).toBe(true);

    const task = repo.findById('task-1')._unsafeUnwrap();
    expect(task?.status).toBe('completed');
    expect(task?.output).toBe('done');
    expect(task?.completedAt).toBeGreaterThan(0);
  });

  it('updates a task to failed with an error', () => {
    repo.create(baseInput);

    repo.updateStatus('task-1', 'failed', undefined, 'process crashed');

    const task = repo.findById('task-1')._unsafeUnwrap();
    expect(task?.status).toBe('failed');
    expect(task?.error).toBe('process crashed');
  });

  it('finds only active tasks', () => {
    repo.create(baseInput);
    repo.create({ ...baseInput, id: 'task-2', threadId: 'thread-2' });
    repo.create({ ...baseInput, id: 'task-3', threadId: 'thread-3' });
    repo.updateStatus('task-2', 'completed', 'done');

    const result = repo.findActive();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().map((task) => task.id).sort()).toEqual(['task-1', 'task-3']);
  });

  it('returns recent tasks for a thread with a limit', () => {
    repo.create(baseInput);
    repo.create({ ...baseInput, id: 'task-2' });
    repo.create({ ...baseInput, id: 'task-3', threadId: 'thread-2' });

    const result = repo.findByThread('thread-1', 1);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
  });

  it('counts active tasks', () => {
    repo.create(baseInput);
    repo.create({ ...baseInput, id: 'task-2' });
    repo.create({ ...baseInput, id: 'task-3' });
    repo.updateStatus('task-3', 'cancelled', undefined, 'cancelled');

    const result = repo.countActive();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(2);
  });
});
