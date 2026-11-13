/**
 * Unit tests for A2ATaskMapper — validates A2A task submission,
 * persona lookup, persistence, and queue enqueue.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { ok, err } from 'neverthrow';
import pino from 'pino';
import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { A2ATaskRepository } from '../../../src/core/database/repositories/a2a-task-repository.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { A2ATaskMapper } from '../../../src/a2a/a2a-task-mapper.js';
import { defaultA2ALimits, type A2AAgentCard } from '../../../src/a2a/a2a-types.js';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function migrationsDir(): string {
  return join(import.meta.dirname, '../../../src/core/database/migrations');
}

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const result = runMigrations(db, migrationsDir());
  if (result.isErr()) throw new Error(`Migration failed: ${result.error.message}`);
  return db;
}

function createTestLogger() {
  return pino({ level: 'silent' });
}

function seedChannel(db: Database.Database): string {
  const channels = new ChannelRepository(db);
  const id = uuidv4();
  channels.insert({ id, type: 'terminal', name: `ch-${id}`, config: '{}', credentials_ref: null, enabled: 1 });
  return id;
}

function seedThread(db: Database.Database, channelId: string): string {
  const threads = new ThreadRepository(db);
  const id = uuidv4();
  threads.insert({ id, channel_id: channelId, external_id: `ext-${id}`, metadata: '{}' });
  return id;
}

function seedPersona(db: Database.Database, name: string): string {
  const personas = new PersonaRepository(db);
  const id = uuidv4();
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

function makeCard(personaName: string): A2AAgentCard {
  return {
    id: personaName,
    name: personaName,
    description: `Talon persona: ${personaName}`,
    url: `/a2a/agents/${personaName}`,
    version: '0.1.0',
    skills: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    metadata: {
      personaName,
      model: 'claude-sonnet-4-6',
      skills: [],
      capabilities: { allow: [], requireApproval: [] },
      internalOnly: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('A2ATaskMapper', () => {
  let db: Database.Database;
  let taskRepo: A2ATaskRepository;
  let queueRepo: QueueRepository;
  let threadRepo: ThreadRepository;
  let personaRepo: PersonaRepository;
  let mapper: A2ATaskMapper;
  let threadId: string;
  let targetPersonaId: string;
  let registry: Map<string, A2AAgentCard>;

  beforeEach(() => {
    db = createTestDb();
    taskRepo = new A2ATaskRepository(db);
    queueRepo = new QueueRepository(db);
    threadRepo = new ThreadRepository(db);
    personaRepo = new PersonaRepository(db);

    const channelId = seedChannel(db);
    threadId = seedThread(db, channelId);
    targetPersonaId = seedPersona(db, 'software-engineer');
    seedPersona(db, 'assistant');

    registry = new Map([
      ['software-engineer', makeCard('software-engineer')],
      ['assistant', makeCard('assistant')],
    ]);

    mapper = new A2ATaskMapper(taskRepo, queueRepo, threadRepo, personaRepo, registry, createTestLogger());
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // submitTask
  // -------------------------------------------------------------------------

  describe('submitTask', () => {
    it('returns a task status with state=submitted on success', async () => {
      const result = mapper.submitTask({
        sourcePersona: 'assistant',
        targetPersona: 'software-engineer',
        sourceThreadId: threadId,
        content: 'Review the PR',
        hopCount: 0,
      });

      expect(result.isOk()).toBe(true);
      const status = result._unsafeUnwrap();
      expect(status.state).toBe('submitted');
      expect(status.sourcePersona).toBe('assistant');
      expect(status.targetPersona).toBe('software-engineer');
      expect(status.threadId).toBe(threadId);
    });

    it('creates a collaboration queue item', async () => {
      const result = mapper.submitTask({
        sourcePersona: 'assistant',
        targetPersona: 'software-engineer',
        sourceThreadId: threadId,
        content: 'Review the PR',
        hopCount: 0,
      });

      expect(result.isOk()).toBe(true);
      const status = result._unsafeUnwrap();
      expect(status.queueItemId).toBeDefined();

      const queueRow = queueRepo.findById(status.queueItemId!);
      expect(queueRow.isOk()).toBe(true);
      const item = queueRow._unsafeUnwrap();
      expect(item).toBeDefined();
      expect(item!.type).toBe('collaboration');
    });

    it('stores an a2a_tasks row', async () => {
      const result = mapper.submitTask({
        sourcePersona: 'assistant',
        targetPersona: 'software-engineer',
        sourceThreadId: threadId,
        content: 'Review the PR',
        hopCount: 0,
      });

      const status = result._unsafeUnwrap();
      const taskRow = taskRepo.findById(status.taskId);
      expect(taskRow.isOk()).toBe(true);
      expect(taskRow._unsafeUnwrap()?.state).toBe('submitted');
    });

    it('includes personaId in queue payload', async () => {
      const result = mapper.submitTask({
        sourcePersona: 'assistant',
        targetPersona: 'software-engineer',
        sourceThreadId: threadId,
        content: 'Review the PR',
        hopCount: 0,
      });

      const status = result._unsafeUnwrap();
      const queueRow = queueRepo.findById(status.queueItemId!)._unsafeUnwrap();
      const payload = JSON.parse(queueRow!.payload as unknown as string) as { personaId: string; kind: string };
      expect(payload.kind).toBe('a2a_task');
      expect(payload.personaId).toBe(targetPersonaId);
    });

    it('returns an error for an unknown target persona', async () => {
      const result = mapper.submitTask({
        sourcePersona: 'assistant',
        targetPersona: 'unknown-persona',
        sourceThreadId: threadId,
        content: 'Hello',
        hopCount: 0,
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toMatch(/unknown-persona/);
    });

    it('returns an error for an unknown source thread', async () => {
      const result = mapper.submitTask({
        sourcePersona: 'assistant',
        targetPersona: 'software-engineer',
        sourceThreadId: 'nonexistent-thread',
        content: 'Hello',
        hopCount: 0,
      });

      expect(result.isErr()).toBe(true);
    });

    it('rejects tasks that exceed maxHops', async () => {
      const result = mapper.submitTask({
        sourcePersona: 'assistant',
        targetPersona: 'software-engineer',
        sourceThreadId: threadId,
        content: 'Hello',
        hopCount: 5,
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toMatch(/hop/i);
    });

    it('rejects empty content', async () => {
      const result = mapper.submitTask({
        sourcePersona: 'assistant',
        targetPersona: 'software-engineer',
        sourceThreadId: threadId,
        content: '   ',
        hopCount: 0,
      });

      expect(result.isErr()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // configurable limits
  // -------------------------------------------------------------------------

  describe('configurable limits', () => {
    it('honors a custom maxHops from limits', () => {
      const strict = new A2ATaskMapper(
        taskRepo,
        queueRepo,
        threadRepo,
        personaRepo,
        registry,
        createTestLogger(),
        { ...defaultA2ALimits(), maxHops: 2 },
      );

      const ok = strict.submitTask({
        sourcePersona: 'assistant',
        targetPersona: 'software-engineer',
        sourceThreadId: threadId,
        content: 'Within bounds',
        hopCount: 1,
      });
      expect(ok.isOk()).toBe(true);

      const rejected = strict.submitTask({
        sourcePersona: 'assistant',
        targetPersona: 'software-engineer',
        sourceThreadId: threadId,
        content: 'Past bounds',
        hopCount: 2,
      });
      expect(rejected.isErr()).toBe(true);
      expect(rejected._unsafeUnwrapErr().message).toMatch(/maximum allowed hops \(2\)/);
    });

    it('queues tasks past maxConcurrentPerTarget up to maxQueuedPerTarget', () => {
      const limited = new A2ATaskMapper(
        taskRepo,
        queueRepo,
        threadRepo,
        personaRepo,
        registry,
        createTestLogger(),
        { ...defaultA2ALimits(), maxConcurrentPerTarget: 1, maxQueuedPerTarget: 3 },
      );

      for (let i = 0; i < 3; i++) {
        const r = limited.submitTask({
          sourcePersona: 'assistant',
          targetPersona: 'software-engineer',
          sourceThreadId: threadId,
          content: `Task ${i}`,
          hopCount: 0,
        });
        expect(r.isOk()).toBe(true);
        expect(r._unsafeUnwrap().state).toBe('submitted');
      }

      const fourth = limited.submitTask({
        sourcePersona: 'assistant',
        targetPersona: 'software-engineer',
        sourceThreadId: threadId,
        content: 'Over the backlog',
        hopCount: 0,
      });
      expect(fourth.isErr()).toBe(true);
      expect(fourth._unsafeUnwrapErr().message).toMatch(/Max queued: 3/);
    });

    it('defaults maxAttempts to 1', () => {
      expect(defaultA2ALimits().maxAttempts).toBe(1);
      const status = mapper
        .submitTask({
          sourcePersona: 'assistant',
          targetPersona: 'software-engineer',
          sourceThreadId: threadId,
          content: 'Default attempts',
          hopCount: 0,
        })
        ._unsafeUnwrap();
      expect(queueRepo.findById(status.queueItemId!)._unsafeUnwrap()?.max_attempts).toBe(1);
    });

    it('propagates maxAttempts into queue items', () => {
      const relaxed = new A2ATaskMapper(
        taskRepo,
        queueRepo,
        threadRepo,
        personaRepo,
        registry,
        createTestLogger(),
        { ...defaultA2ALimits(), maxAttempts: 7 },
      );

      const result = relaxed.submitTask({
        sourcePersona: 'assistant',
        targetPersona: 'software-engineer',
        sourceThreadId: threadId,
        content: 'Retry-policy check',
        hopCount: 0,
      });
      expect(result.isOk()).toBe(true);

      const status = result._unsafeUnwrap();
      const queueRow = queueRepo.findById(status.queueItemId!)._unsafeUnwrap();
      expect(queueRow?.max_attempts).toBe(7);
    });
  });

  // -------------------------------------------------------------------------
  // getTaskStatus
  // -------------------------------------------------------------------------

  describe('getTaskStatus', () => {
    it('returns the status for a submitted task', async () => {
      const submitResult = mapper.submitTask({
        sourcePersona: 'assistant',
        targetPersona: 'software-engineer',
        sourceThreadId: threadId,
        content: 'Review the PR',
        hopCount: 0,
      });
      const { taskId } = submitResult._unsafeUnwrap();

      const statusResult = mapper.getTaskStatus(taskId);
      expect(statusResult.isOk()).toBe(true);
      expect(statusResult._unsafeUnwrap()?.state).toBe('submitted');
    });

    it('returns null for unknown task ID', () => {
      const result = mapper.getTaskStatus('nonexistent-task-id');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // delegation cycles
  // -------------------------------------------------------------------------

  describe('delegation cycle detection', () => {
    const submit = (source: string, target: string, parentTaskId?: string) =>
      mapper.submitTask({
        sourcePersona: source,
        targetPersona: target,
        sourceThreadId: threadId,
        content: 'delegate',
        hopCount: 0,
        parentTaskId,
      });

    it('rejects a delegation back to a persona running an ancestor task', () => {
      const a = submit('assistant', 'software-engineer')._unsafeUnwrap();
      // software-engineer (running task a) delegates to assistant: fine.
      const b = submit('software-engineer', 'assistant', a.taskId)._unsafeUnwrap();
      // assistant (running task b) delegates back to software-engineer, whose
      // slot is held by ancestor a -> deadlock.
      const c = submit('assistant', 'software-engineer', b.taskId);
      expect(c.isErr()).toBe(true);
      expect(c._unsafeUnwrapErr().message).toMatch(/delegation cycle/);
    });

    it('allows the delegation once the ancestor is terminal', () => {
      const a = submit('assistant', 'software-engineer')._unsafeUnwrap();
      const b = submit('software-engineer', 'assistant', a.taskId)._unsafeUnwrap();
      taskRepo.markCompleted(a.taskId, 'done');
      expect(submit('assistant', 'software-engineer', b.taskId).isOk()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // cancelTask
  // -------------------------------------------------------------------------

  describe('cancelTask', () => {
    const submitOne = () =>
      mapper
        .submitTask({
          sourcePersona: 'assistant',
          targetPersona: 'software-engineer',
          sourceThreadId: threadId,
          content: 'cancel me',
          hopCount: 0,
        })
        ._unsafeUnwrap();

    it('cancels the task, its pending queue item, and invokes the abort hook', () => {
      const hook = vi.fn();
      mapper.setAbortHook(hook);
      const task = submitOne();

      expect(mapper.cancelTask(task.taskId, 'user requested')._unsafeUnwrap()).toBe(true);

      const row = taskRepo.findById(task.taskId)._unsafeUnwrap()!;
      expect(row.state).toBe('canceled');
      expect(row.error_code).toBe('CANCELED');
      expect(row.error_message).toBe('user requested');
      expect(row.completed_at).not.toBeNull();
      const item = queueRepo.findById(task.queueItemId!)._unsafeUnwrap()!;
      expect(item.status).toBe('completed');
      expect(item.error).toBe('canceled');
      expect(hook).toHaveBeenCalledWith(task.taskId);
    });

    it('is idempotent and returns false for terminal or unknown tasks', () => {
      const hook = vi.fn();
      mapper.setAbortHook(hook);
      const task = submitOne();
      expect(mapper.cancelTask(task.taskId, 'x')._unsafeUnwrap()).toBe(true);
      expect(mapper.cancelTask(task.taskId, 'again')._unsafeUnwrap()).toBe(false);
      expect(mapper.cancelTask('missing', 'x')._unsafeUnwrap()).toBe(false);
      expect(hook).toHaveBeenCalledTimes(1);
      expect(taskRepo.findById(task.taskId)._unsafeUnwrap()!.error_message).toBe('x');
    });

    it('does not cancel a completed task', () => {
      const task = submitOne();
      taskRepo.markCompleted(task.taskId, 'ok');
      expect(mapper.cancelTask(task.taskId, 'late')._unsafeUnwrap()).toBe(false);
      expect(taskRepo.findById(task.taskId)._unsafeUnwrap()!.state).toBe('completed');
    });
  });

  // -------------------------------------------------------------------------
  // reapStaleTasks
  // -------------------------------------------------------------------------

  describe('reapStaleTasks', () => {
    const submitOne = () =>
      mapper
        .submitTask({
          sourcePersona: 'assistant',
          targetPersona: 'software-engineer',
          sourceThreadId: threadId,
          content: 'reap me',
          hopCount: 0,
        })
        ._unsafeUnwrap();

    it('leaves healthy tasks with live queue items alone', () => {
      const task = submitOne();
      const reaped = mapper.reapStaleTasks(Date.now() + 5 * 60_000)._unsafeUnwrap();
      expect(reaped).toEqual([]);
      expect(taskRepo.findById(task.taskId)._unsafeUnwrap()!.state).toBe('submitted');
    });

    it('fails orphaned tasks whose queue item was purged (after the grace period)', () => {
      const task = submitOne();
      queueRepo.purge(['pending']);
      // Within grace: untouched.
      expect(mapper.reapStaleTasks(Date.now())._unsafeUnwrap()).toEqual([]);
      const reaped = mapper.reapStaleTasks(Date.now() + 61_000)._unsafeUnwrap();
      expect(reaped).toEqual([task.taskId]);
      const row = taskRepo.findById(task.taskId)._unsafeUnwrap()!;
      expect(row.state).toBe('failed');
      expect(row.error_code).toBe('ORPHANED');
    });

    it('fails tasks whose queue item is completed or dead-lettered', () => {
      const t1 = submitOne();
      const t2 = submitOne();
      queueRepo.complete(t1.queueItemId!);
      queueRepo.markDeadLetter(t2.queueItemId!, 'dead');
      const reaped = mapper.reapStaleTasks(Date.now() + 61_000)._unsafeUnwrap();
      expect(reaped.sort()).toEqual([t1.taskId, t2.taskId].sort());
    });

    it('cancels tasks older than the TTL even with a live queue item', () => {
      const task = submitOne();
      const reaped = mapper.reapStaleTasks(Date.now() + 61 * 60_000)._unsafeUnwrap();
      expect(reaped).toEqual([task.taskId]);
      const row = taskRepo.findById(task.taskId)._unsafeUnwrap()!;
      expect(row.state).toBe('canceled');
      expect(row.error_message).toBe('ttl expired');
      expect(queueRepo.findById(task.queueItemId!)._unsafeUnwrap()!.status).toBe('completed');
    });

    it('ignores terminal tasks', () => {
      const task = submitOne();
      taskRepo.markCompleted(task.taskId, 'done');
      expect(mapper.reapStaleTasks(Date.now() + 10 * 60 * 60_000)._unsafeUnwrap()).toEqual([]);
    });
  });
});
