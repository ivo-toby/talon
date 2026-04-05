/**
 * Integration test — A2A task flow.
 *
 * Tests the full submission path: server → mapper → queue + db persistence.
 * AgentRunner execution is NOT tested here (would require full DaemonContext mock).
 * This test validates:
 *   - A2A server accepts task submissions via fetch()
 *   - A2A task record is created in submitted state
 *   - Collaboration queue item is created with correct payload
 *   - Task status is queryable via the server
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { A2ATaskRepository } from '../../../src/core/database/repositories/a2a-task-repository.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { A2ATaskMapper } from '../../../src/a2a/a2a-task-mapper.js';
import { A2AServer } from '../../../src/a2a/a2a-server.js';
import { buildAgentCardRegistry } from '../../../src/a2a/persona-agent-card.js';
import type { LoadedPersona } from '../../../src/personas/persona-types.js';

// ---------------------------------------------------------------------------
// Helpers
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

function makePersona(name: string, db: Database.Database): { loaded: LoadedPersona; id: string } {
  const personas = new PersonaRepository(db);
  const id = uuidv4();
  personas.insert({
    id,
    name,
    model: 'claude-sonnet-4-6',
    system_prompt_file: null,
    skills: '["code-review"]',
    capabilities: '{"allow":["read-repo"],"requireApproval":[]}',
    max_concurrent: null,
  });

  const loaded: LoadedPersona = {
    config: {
      name,
      model: 'claude-sonnet-4-6',
      systemPromptFile: undefined,
      skills: ['code-review'],
      subagents: [],
      capabilities: { allow: ['read-repo'], requireApproval: [] },
      maxConcurrent: undefined,
      provider: undefined,
    },
    description: `Talon persona: ${name}`,
    systemPromptContent: undefined,
    personalityContent: undefined,
    taskPromptPaths: undefined,
    resolvedCapabilities: { allow: ['read-repo'], requireApproval: [] },
  };

  return { loaded, id };
}

function seedThread(db: Database.Database): string {
  const channels = new ChannelRepository(db);
  const threads = new ThreadRepository(db);

  const channelId = uuidv4();
  channels.insert({
    id: channelId,
    type: 'terminal',
    name: `ch-${channelId}`,
    config: '{}',
    credentials_ref: null,
    enabled: 1,
  });

  const threadId = uuidv4();
  threads.insert({
    id: threadId,
    channel_id: channelId,
    external_id: `ext-${threadId}`,
    metadata: '{}',
  });

  return threadId;
}

function makeJsonRpcRequest(targetPersona: string, text: string, sourcePersona: string, threadId: string) {
  return {
    jsonrpc: '2.0',
    id: '1',
    method: 'tasks/send',
    params: {
      message: {
        role: 'user',
        parts: [{ kind: 'text', text }],
      },
      metadata: {
        sourcePersona,
        sourceThreadId: threadId,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('A2A Task Flow Integration', () => {
  let db: Database.Database;
  let taskRepo: A2ATaskRepository;
  let queueRepo: QueueRepository;
  let server: A2AServer;
  let mapper: A2ATaskMapper;
  let threadId: string;

  beforeEach(() => {
    db = createTestDb();
    taskRepo = new A2ATaskRepository(db);
    queueRepo = new QueueRepository(db);

    const { loaded: assistantPersona } = makePersona('assistant', db);
    const { loaded: engineerPersona } = makePersona('software-engineer', db);

    threadId = seedThread(db);

    const cardRegistry = buildAgentCardRegistry([assistantPersona, engineerPersona]);

    mapper = new A2ATaskMapper(
      taskRepo,
      queueRepo,
      new ThreadRepository(db),
      new PersonaRepository(db),
      cardRegistry,
      pino({ level: 'silent' }),
    );

    server = new A2AServer(cardRegistry, mapper, pino({ level: 'silent' }));
  });

  afterEach(() => {
    db.close();
  });

  it('creates a task record in submitted state after server submission', async () => {
    const res = await server.fetch(
      new Request('http://talon.internal/a2a/agents/software-engineer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(makeJsonRpcRequest('software-engineer', 'Review PR #42', 'assistant', threadId)),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { result?: { id: string; status: { state: string } } };
    expect(body.result?.status?.state).toBe('submitted');

    const taskId = body.result?.id;
    expect(taskId).toBeDefined();

    const taskRow = taskRepo.findById(taskId!)._unsafeUnwrap();
    expect(taskRow).not.toBeNull();
    expect(taskRow!.state).toBe('submitted');
    expect(taskRow!.source_persona).toBe('assistant');
    expect(taskRow!.target_persona).toBe('software-engineer');
    expect(taskRow!.thread_id).toBe(threadId);
  });

  it('creates a collaboration queue item with A2A task payload', async () => {
    const res = await server.fetch(
      new Request('http://talon.internal/a2a/agents/software-engineer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(makeJsonRpcRequest('software-engineer', 'Review PR #42', 'assistant', threadId)),
      }),
    );

    const body = await res.json() as { result?: { id: string; status: { queueItemId: string } } };
    const queueItemId = body.result?.status?.queueItemId;
    expect(queueItemId).toBeDefined();

    const queueRow = queueRepo.findById(queueItemId!)._unsafeUnwrap();
    expect(queueRow).not.toBeNull();
    expect(queueRow!.type).toBe('collaboration');

    const payload = JSON.parse(queueRow!.payload as unknown as string) as { kind: string; content: string };
    expect(payload.kind).toBe('a2a_task');
    expect(payload.content).toBe('Review PR #42');
  });

  it('returns task status via tasks/get', async () => {
    // Submit first
    const submitRes = await server.fetch(
      new Request('http://talon.internal/a2a/agents/software-engineer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(makeJsonRpcRequest('software-engineer', 'Review PR #42', 'assistant', threadId)),
      }),
    );
    const submitBody = await submitRes.json() as { result?: { id: string } };
    const taskId = submitBody.result?.id;
    expect(taskId).toBeDefined();

    // Query status
    const statusRes = await server.fetch(
      new Request('http://talon.internal/a2a/agents/software-engineer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: '2',
          method: 'tasks/get',
          params: { id: taskId },
        }),
      }),
    );

    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json() as { result?: { status: { state: string } } };
    expect(statusBody.result?.status?.state).toBe('submitted');
  });

  it('returns all agent cards from /.well-known/agent-card.json', async () => {
    const res = await server.fetch(
      new Request('http://talon.internal/.well-known/agent-card.json'),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { agents: Array<{ id: string }> };
    expect(body.agents).toHaveLength(2);
    const ids = body.agents.map((a) => a.id);
    expect(ids).toContain('assistant');
    expect(ids).toContain('software-engineer');
  });

  it('hop count enforcement prevents loops', async () => {
    const res = await server.fetch(
      new Request('http://talon.internal/a2a/agents/software-engineer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          method: 'tasks/send',
          params: {
            message: { role: 'user', parts: [{ kind: 'text', text: 'Hello' }] },
            metadata: {
              sourcePersona: 'assistant',
              sourceThreadId: threadId,
              hopCount: 10, // exceeds MAX_HOPS
            },
          },
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { error?: { message: string } };
    expect(body.error).toBeDefined();
    expect(body.error?.message).toMatch(/hop/i);
  });
});
