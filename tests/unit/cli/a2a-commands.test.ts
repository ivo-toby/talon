import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { A2ATaskRepository } from '../../../src/core/database/repositories/a2a-task-repository.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { vi } from 'vitest';
import {
  a2aCancelCommand,
  cancelA2ATask,
  cancelA2ATaskViaDaemonOrDb,
  listA2ATasks,
  sendA2ATask,
} from '../../../src/cli/commands/a2a.js';
import { DaemonIpcServer } from '../../../src/ipc/daemon-ipc-server.js';
import type { DaemonCommand, DaemonResponse } from '../../../src/ipc/daemon-ipc.js';
import { defaultA2ALimits } from '../../../src/a2a/a2a-types.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedPersona(db: Database.Database, name: string): string {
  const personas = new PersonaRepository(db);
  const id = uuid();
  personas.insert({
    id,
    name,
    model: 'claude-sonnet-4-6',
    system_prompt_file: null,
    skills: '[]',
    capabilities: '{"allow":[],"requireApproval":[]}',
    mounts: '[]',
    max_concurrent: null,
  });
  return id;
}

function seedChannel(db: Database.Database, name = 'test-channel', type = 'terminal'): string {
  const channels = new ChannelRepository(db);
  const id = uuid();
  channels.insert({ id, type, name, config: '{}', credentials_ref: null, enabled: 1 });
  return id;
}

function seedThread(db: Database.Database, channelId: string, externalId = 'thread-1'): string {
  const threads = new ThreadRepository(db);
  const id = uuid();
  threads.insert({ id, channel_id: channelId, external_id: externalId, metadata: '{}' });
  return id;
}

function insertTask(
  db: Database.Database,
  overrides: { source?: string; target?: string; state?: string; threadId?: string } = {},
): string {
  const channelId = seedChannel(db, `ch-${uuid()}`);
  const threadId = overrides.threadId ?? seedThread(db, channelId, uuid());

  const taskId = uuid();
  db.prepare(`
    INSERT INTO a2a_tasks
      (id, source_persona, target_persona, thread_id, state,
       request_payload, hop_count, parent_task_id, submitted_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    overrides.source ?? 'src-persona',
    overrides.target ?? 'tgt-persona',
    threadId,
    overrides.state ?? 'submitted',
    JSON.stringify({ content: 'test message' }),
    0,
    null,
    Date.now(),
    Date.now(),
  );
  return taskId;
}

// ---------------------------------------------------------------------------
// listA2ATasks()
// ---------------------------------------------------------------------------

describe('listA2ATasks()', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty array when no tasks exist', () => {
    const result = listA2ATasks({ db });
    expect(result).toEqual([]);
  });

  it('returns tasks with all expected fields', () => {
    const taskId = insertTask(db, { source: 'agent-a', target: 'agent-b', state: 'working' });

    const result = listA2ATasks({ db });
    expect(result).toHaveLength(1);

    const task = result[0];
    expect(task.taskId).toBe(taskId);
    expect(task.taskIdShort).toBe(taskId.slice(0, 8));
    expect(task.sourcePersona).toBe('agent-a');
    expect(task.targetPersona).toBe('agent-b');
    expect(task.state).toBe('working');
    expect(task.submittedAt).toBeTruthy();
    expect(task.updatedAt).toBeTruthy();
  });

  it('filters by status', () => {
    insertTask(db, { state: 'submitted' });
    insertTask(db, { state: 'working' });
    insertTask(db, { state: 'completed' });

    const working = listA2ATasks({ db, status: 'working' });
    expect(working).toHaveLength(1);
    expect(working[0].state).toBe('working');

    const submitted = listA2ATasks({ db, status: 'submitted' });
    expect(submitted).toHaveLength(1);
    expect(submitted[0].state).toBe('submitted');
  });

  it('filters by target persona', () => {
    insertTask(db, { target: 'persona-x' });
    insertTask(db, { target: 'persona-y' });
    insertTask(db, { target: 'persona-x' });

    const result = listA2ATasks({ db, targetPersona: 'persona-x' });
    expect(result).toHaveLength(2);
    expect(result.every((t) => t.targetPersona === 'persona-x')).toBe(true);
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      insertTask(db);
    }
    const result = listA2ATasks({ db, limit: 3 });
    expect(result).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// sendA2ATask()
// ---------------------------------------------------------------------------

describe('sendA2ATask()', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('creates an A2A task and returns taskId and state', () => {
    seedPersona(db, 'target-bot');

    const result = sendA2ATask({ db, targetPersona: 'target-bot', message: 'Hello from CLI' });

    expect(result.taskId).toBeDefined();
    expect(result.state).toBe('submitted');
    expect(result.targetPersona).toBe('target-bot');
    expect(result.sourcePersona).toBe('cli');

    // Verify persisted in DB
    const repo = new A2ATaskRepository(db);
    const row = repo.findById(result.taskId)._unsafeUnwrap();
    expect(row).not.toBeNull();
    expect(row!.target_persona).toBe('target-bot');
    expect(row!.source_persona).toBe('cli');
    expect(row!.state).toBe('submitted');
  });

  it('respects --source flag', () => {
    seedPersona(db, 'target-bot');
    const result = sendA2ATask({ db, targetPersona: 'target-bot', message: 'Hi', sourcePersona: 'my-source' });
    expect(result.sourcePersona).toBe('my-source');
  });

  it('throws for unknown target persona', () => {
    expect(() => sendA2ATask({ db, targetPersona: 'nonexistent-bot', message: 'Hello' }))
      .toThrow(/Unknown target persona/);
  });

  it('queues a second task for a busy target instead of rejecting it', () => {
    seedPersona(db, 'busy-bot');

    const first = sendA2ATask({ db, targetPersona: 'busy-bot', message: 'First task' });
    const second = sendA2ATask({ db, targetPersona: 'busy-bot', message: 'Second task' });

    expect(second.state).toBe('submitted');
    expect(second.taskId).not.toBe(first.taskId);
  });

  it('rejects once the queued backlog for the target is full', () => {
    seedPersona(db, 'busy-bot');
    const limits = { ...defaultA2ALimits(), maxQueuedPerTarget: 1 };

    sendA2ATask({ db, targetPersona: 'busy-bot', message: 'First task', limits });
    expect(() =>
      sendA2ATask({ db, targetPersona: 'busy-bot', message: 'Second task', limits }),
    ).toThrow(/queued task/);
  });
});

// ---------------------------------------------------------------------------
// cancelA2ATask() — direct DB
// ---------------------------------------------------------------------------

describe('cancelA2ATask()', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('cancels a submitted task and its pending queue item, recording the reason', () => {
    seedPersona(db, 'cancel-bot');
    const sent = sendA2ATask({ db, targetPersona: 'cancel-bot', message: 'Do it' });

    const result = cancelA2ATask({ db, taskId: sent.taskId, reason: 'no longer needed' });

    expect(result).toEqual({ taskId: sent.taskId, found: true, canceled: true, state: 'canceled' });
    const row = db.prepare('SELECT state, error_message, queue_item_id FROM a2a_tasks WHERE id = ?').get(sent.taskId) as {
      state: string;
      error_message: string;
      queue_item_id: string;
    };
    expect(row.state).toBe('canceled');
    expect(row.error_message).toBe('no longer needed');
    const queue = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(row.queue_item_id) as { status: string };
    expect(queue.status).not.toBe('pending');
  });

  it('uses a default reason when none is given', () => {
    const taskId = insertTask(db, { state: 'working' });
    cancelA2ATask({ db, taskId });
    const row = db.prepare('SELECT error_message FROM a2a_tasks WHERE id = ?').get(taskId) as { error_message: string };
    expect(row.error_message).toBe('canceled via talonctl');
  });

  it('reports an already-terminal task as not canceled, with its real state, and leaves it untouched', () => {
    const taskId = insertTask(db, { state: 'completed' });

    const result = cancelA2ATask({ db, taskId });

    expect(result).toEqual({ taskId, found: true, canceled: false, state: 'completed' });
    const row = db.prepare('SELECT state FROM a2a_tasks WHERE id = ?').get(taskId) as { state: string };
    expect(row.state).toBe('completed');
  });

  it('reports an unknown task as not found', () => {
    expect(cancelA2ATask({ db, taskId: 'missing' })).toEqual({ taskId: 'missing', found: false, canceled: false });
  });
});

// ---------------------------------------------------------------------------
// cancelA2ATaskViaDaemonOrDb() / a2aCancelCommand() — IPC first, DB fallback
// ---------------------------------------------------------------------------

describe('cancelA2ATaskViaDaemonOrDb()', () => {
  let tmpDir: string;
  let db: Database.Database;
  let server: DaemonIpcServer | null = null;

  const openDatabase = () => {
    let closed = false;
    const wrapped = new Proxy(db, {
      get(target, prop) {
        if (prop === 'close') return () => { closed = true; void closed; };
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    return { db: wrapped, a2aLimits: defaultA2ALimits() };
  };

  function startFakeDaemon(handler: (command: DaemonCommand) => DaemonResponse | Partial<DaemonResponse>) {
    server = new DaemonIpcServer({
      inputDir: path.join(tmpDir, 'input'),
      outputDir: path.join(tmpDir, 'output'),
      errorsDir: path.join(tmpDir, 'errors'),
      logger: pino({ level: 'silent' }),
      pollIntervalMs: 20,
      commandHandler: async (command) => ({
        id: '22222222-2222-4222-8222-222222222222',
        commandId: command.id,
        success: true,
        ...handler(command),
      }),
    });
    server.start();
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-cancel-test-'));
    db = createTestDb();
  });

  afterEach(async () => {
    server?.stop();
    server = null;
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('prefers the daemon: sends a2a-cancel with the task id and reason and uses its answer', async () => {
    let received: DaemonCommand | null = null;
    startFakeDaemon((command) => {
      received = command;
      return { data: { taskId: 't-1', found: true, canceled: true, state: 'canceled' } };
    });
    const open = vi.fn(openDatabase);

    const result = await cancelA2ATaskViaDaemonOrDb({
      taskId: 't-1',
      reason: 'because',
      ipcDir: tmpDir,
      timeoutMs: 3000,
      openDatabase: open,
    });

    expect(result).toEqual({ taskId: 't-1', found: true, canceled: true, state: 'canceled', via: 'daemon' });
    expect(received).toMatchObject({ command: 'a2a-cancel', payload: { taskId: 't-1', reason: 'because' } });
    expect(open).not.toHaveBeenCalled();
  });

  it('relays the daemon\'s already-terminal and not-found answers', async () => {
    startFakeDaemon((command) =>
      command.payload?.taskId === 'gone'
        ? { data: { taskId: 'gone', found: false, canceled: false } }
        : { data: { taskId: 'done', found: true, canceled: false, state: 'failed' } },
    );

    const done = await cancelA2ATaskViaDaemonOrDb({ taskId: 'done', ipcDir: tmpDir, timeoutMs: 3000, openDatabase });
    expect(done).toMatchObject({ found: true, canceled: false, state: 'failed', via: 'daemon' });

    const gone = await cancelA2ATaskViaDaemonOrDb({ taskId: 'gone', ipcDir: tmpDir, timeoutMs: 3000, openDatabase });
    expect(gone).toMatchObject({ found: false, canceled: false, via: 'daemon' });
  });

  it('throws the daemon error when the daemon answers with a failure (no DB fallback)', async () => {
    startFakeDaemon(() => ({ success: false, error: 'A2A is not available in this daemon' }));
    const open = vi.fn(openDatabase);

    await expect(
      cancelA2ATaskViaDaemonOrDb({ taskId: 't', ipcDir: tmpDir, timeoutMs: 3000, openDatabase: open }),
    ).rejects.toThrow('A2A is not available');
    expect(open).not.toHaveBeenCalled();
  });

  it('falls back to a direct DB cancel when no daemon answers, and removes its stale command file', async () => {
    const taskId = insertTask(db, { state: 'working' });

    const result = await cancelA2ATaskViaDaemonOrDb({
      taskId,
      reason: 'cli',
      ipcDir: tmpDir,
      timeoutMs: 150,
      openDatabase,
    });

    expect(result).toEqual({ taskId, found: true, canceled: true, state: 'canceled', via: 'database' });
    const row = db.prepare('SELECT state, error_message FROM a2a_tasks WHERE id = ?').get(taskId) as {
      state: string;
      error_message: string;
    };
    expect(row).toEqual({ state: 'canceled', error_message: 'cli' });
    expect(await fs.readdir(path.join(tmpDir, 'input'))).toEqual([]);
  });

  it('fallback reports not found for an unknown task', async () => {
    const result = await cancelA2ATaskViaDaemonOrDb({ taskId: 'missing', ipcDir: tmpDir, timeoutMs: 100, openDatabase });
    expect(result).toMatchObject({ found: false, canceled: false, via: 'database' });
  });
});

describe('a2aCancelCommand() output and exit codes', () => {
  let tmpDir: string;
  let server: DaemonIpcServer | null = null;
  let logs: string[];
  let errors: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;

  async function run(data: Record<string, unknown>) {
    server = new DaemonIpcServer({
      inputDir: path.join(tmpDir, 'input'),
      outputDir: path.join(tmpDir, 'output'),
      errorsDir: path.join(tmpDir, 'errors'),
      logger: pino({ level: 'silent' }),
      pollIntervalMs: 20,
      commandHandler: async (command) => ({
        id: '33333333-3333-4333-8333-333333333333',
        commandId: command.id,
        success: true,
        data,
      }),
    });
    server.start();
    await a2aCancelCommand({ taskId: 'task-9', ipcDir: tmpDir, timeoutMs: 3000 });
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-cancel-cmd-'));
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(async () => {
    server?.stop();
    server = null;
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('prints canceled and exits 0', async () => {
    await run({ taskId: 'task-9', found: true, canceled: true, state: 'canceled' });
    expect(logs.join('\n')).toContain('Task task-9 canceled.');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prints already <state> and exits 0 for a finished task', async () => {
    await run({ taskId: 'task-9', found: true, canceled: false, state: 'completed' });
    expect(logs.join('\n')).toContain('already completed');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prints not found and exits 1', async () => {
    await run({ taskId: 'task-9', found: false, canceled: false });
    expect(errors.join('\n')).toContain('A2A task not found: task-9');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
