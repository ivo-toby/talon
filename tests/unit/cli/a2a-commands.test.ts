import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { A2ATaskRepository } from '../../../src/core/database/repositories/a2a-task-repository.js';
import { listA2ATasks, sendA2ATask } from '../../../src/cli/commands/a2a.js';
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

  it('throws when target persona already has an active task', () => {
    seedPersona(db, 'busy-bot');

    // First task succeeds
    sendA2ATask({ db, targetPersona: 'busy-bot', message: 'First task' });

    // Second should be rejected
    expect(() => sendA2ATask({ db, targetPersona: 'busy-bot', message: 'Second task' }))
      .toThrow(/already has .* active task/);
  });
});
