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
import type { A2AAgentCard } from '../../../src/a2a/a2a-types.js';
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
});
