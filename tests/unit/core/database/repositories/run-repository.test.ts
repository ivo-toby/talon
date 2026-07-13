import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { RunRepository } from '../../../../../src/core/database/repositories/run-repository.js';
import { ThreadRepository } from '../../../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../../../src/core/database/repositories/persona-repository.js';
import { QueueRepository } from '../../../../../src/core/database/repositories/queue-repository.js';
import { createTestDb, uuid } from './helpers.js';

describe('RunRepository', () => {
  let db: Database.Database;
  let repo: RunRepository;
  let threadId: string;
  let personaId: string;

  beforeEach(() => {
    db = createTestDb();
    repo = new RunRepository(db);

    const channels = new ChannelRepository(db);
    const channelId = uuid();
    channels.insert({
      id: channelId,
      type: 'telegram',
      name: `ch-${uuid()}`,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    const threads = new ThreadRepository(db);
    threadId = uuid();
    threads.insert({
      id: threadId,
      channel_id: channelId,
      external_id: `ext-${uuid()}`,
      metadata: '{}',
    });

    const personas = new PersonaRepository(db);
    personaId = uuid();
    personas.insert({
      id: personaId,
      name: `persona-${uuid()}`,
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });
  });

  afterEach(() => {
    db.close();
  });

  function makeRun(overrides: Partial<Parameters<RunRepository['insert']>[0]> = {}) {
    return {
      id: uuid(),
      thread_id: threadId,
      persona_id: personaId,
      provider_name: 'claude-code',
      model_name: 'claude-sonnet-4-6',
      reasoning_effort: null,
      sandbox_id: null,
      session_id: null,
      status: 'pending' as const,
      parent_run_id: null,
      queue_item_id: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      error: null,
      started_at: null,
      ended_at: null,
      ...overrides,
    };
  }

  function makeQueueItem(type: 'message' | 'schedule' | 'collaboration') {
    const queue = new QueueRepository(db);
    return queue
      .enqueue({
        id: uuid(),
        thread_id: threadId,
        message_id: null,
        type,
        payload: '{}',
        max_attempts: 3,
      })
      ._unsafeUnwrap();
  }

  describe('insert', () => {
    it('inserts and returns the run', () => {
      const input = makeRun();
      const result = repo.insert(input);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().id).toBe(input.id);
      expect(result._unsafeUnwrap().provider_name).toBe('claude-code');
      expect(result._unsafeUnwrap().status).toBe('pending');
    });

    it('stores reasoning_effort when provided', () => {
      const result = repo.insert(makeRun({ reasoning_effort: 'high' }));

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().reasoning_effort).toBe('high');
      expect(repo.findById(result._unsafeUnwrap().id)._unsafeUnwrap()?.reasoning_effort).toBe(
        'high',
      );
    });

    it('returns err for unknown thread_id (FK)', () => {
      expect(repo.insert(makeRun({ thread_id: uuid() })).isErr()).toBe(true);
    });
  });

  describe('findById', () => {
    it('finds by primary key', () => {
      const input = makeRun();
      repo.insert(input);
      expect(repo.findById(input.id)._unsafeUnwrap()?.id).toBe(input.id);
    });

    it('returns null for unknown id', () => {
      expect(repo.findById(uuid())._unsafeUnwrap()).toBeNull();
    });
  });

  describe('findByThread', () => {
    it('returns runs in descending order', () => {
      repo.insert(makeRun());
      repo.insert(makeRun());
      const rows = repo.findByThread(threadId)._unsafeUnwrap();
      expect(rows).toHaveLength(2);
      if (rows.length >= 2) {
        expect(rows[0].created_at).toBeGreaterThanOrEqual(rows[1].created_at);
      }
    });
  });

  describe('findByParent', () => {
    it('returns child runs for a parent run', () => {
      const parent = makeRun();
      repo.insert(parent);
      const child1 = makeRun({ parent_run_id: parent.id });
      const child2 = makeRun({ parent_run_id: parent.id });
      repo.insert(child1);
      repo.insert(child2);

      const children = repo.findByParent(parent.id)._unsafeUnwrap();
      expect(children).toHaveLength(2);
      expect(children.every((c) => c.parent_run_id === parent.id)).toBe(true);
    });

    it('returns empty array when no children', () => {
      const parent = makeRun();
      repo.insert(parent);
      expect(repo.findByParent(parent.id)._unsafeUnwrap()).toHaveLength(0);
    });
  });

  describe('getLatestProviderName', () => {
    it('returns the most recent provider_name for the thread', () => {
      const older = repo.insert(makeRun({ provider_name: 'claude-code' }))._unsafeUnwrap();
      const newer = repo.insert(makeRun({ provider_name: 'gemini-cli' }))._unsafeUnwrap();
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(100, older.id);
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(200, newer.id);

      const result = repo.getLatestProviderName(threadId);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('gemini-cli');
    });

    it('ignores affinity older than the provided lower bound', () => {
      const older = repo.insert(makeRun({ provider_name: 'claude-code' }))._unsafeUnwrap();
      const newer = repo.insert(makeRun({ provider_name: 'gemini-cli' }))._unsafeUnwrap();
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(100, older.id);
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(200, newer.id);

      const result = repo.getLatestProviderName(threadId, { sinceCreatedAt: 201 });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('can exclude collaboration runs from provider affinity lookup', () => {
      const messageQueue = makeQueueItem('message');
      const collaborationQueue = makeQueueItem('collaboration');
      const messageRun = repo
        .insert(
          makeRun({
            provider_name: 'claude-code',
            queue_item_id: messageQueue.id,
          }),
        )
        ._unsafeUnwrap();
      const collaborationRun = repo
        .insert(
          makeRun({
            provider_name: 'codex-cli',
            queue_item_id: collaborationQueue.id,
          }),
        )
        ._unsafeUnwrap();
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(100, messageRun.id);
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(200, collaborationRun.id);

      const result = repo.getLatestProviderName(threadId, { excludeCollaboration: true });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('claude-code');
    });
  });

  describe('getLatestSessionId', () => {
    it('returns the most recent session_id for a specific provider when requested', () => {
      repo.insert(
        makeRun({
          provider_name: 'claude-code',
          session_id: 'claude-session-1',
          status: 'completed',
        }),
      );
      repo.insert(
        makeRun({
          provider_name: 'codex-cli',
          session_id: 'codex-session-1',
          status: 'completed',
        }),
      );
      repo.insert(
        makeRun({
          provider_name: 'claude-code',
          session_id: 'claude-session-2',
          status: 'completed',
        }),
      );

      const result = repo.getLatestSessionId(threadId, 'codex-cli');

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('codex-session-1');
    });

    it('only returns a session_id for the requested model when modelName is supplied', () => {
      const older = repo
        .insert(
          makeRun({
            provider_name: 'ollama-mac',
            model_name: 'Qwen3.5-9B-OptiQ-4bit',
            session_id: 'old-model-session',
            status: 'completed',
          }),
        )
        ._unsafeUnwrap();
      const newer = repo
        .insert(
          makeRun({
            provider_name: 'ollama-mac',
            model_name: 'Qwen3-30B-A3B-Instruct-2507-4bit',
            session_id: 'new-model-session',
            status: 'completed',
          }),
        )
        ._unsafeUnwrap();
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(100, older.id);
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(200, newer.id);

      const oldModel = repo.getLatestSessionId(threadId, 'ollama-mac', {
        modelName: 'Qwen3.5-9B-OptiQ-4bit',
      });
      const missingModel = repo.getLatestSessionId(threadId, 'ollama-mac', {
        modelName: 'gemma-4-12B-it-4bit',
      });

      expect(oldModel.isOk()).toBe(true);
      expect(oldModel._unsafeUnwrap()).toBe('old-model-session');
      expect(missingModel.isOk()).toBe(true);
      expect(missingModel._unsafeUnwrap()).toBeNull();
    });

    it('only returns a session_id for the requested reasoning effort when supplied', () => {
      const noEffort = repo
        .insert(
          makeRun({
            provider_name: 'codex-cli',
            model_name: 'gpt-5.4',
            reasoning_effort: null,
            session_id: 'no-effort-session',
            status: 'completed',
          }),
        )
        ._unsafeUnwrap();
      const low = repo
        .insert(
          makeRun({
            provider_name: 'codex-cli',
            model_name: 'gpt-5.4',
            reasoning_effort: 'low',
            session_id: 'low-session',
            status: 'completed',
          }),
        )
        ._unsafeUnwrap();
      const high = repo
        .insert(
          makeRun({
            provider_name: 'codex-cli',
            model_name: 'gpt-5.4',
            reasoning_effort: 'high',
            session_id: 'high-session',
            status: 'completed',
          }),
        )
        ._unsafeUnwrap();
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(100, noEffort.id);
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(200, low.id);
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(300, high.id);

      const lowResult = repo.getLatestSessionId(threadId, 'codex-cli', {
        modelName: 'gpt-5.4',
        reasoningEffort: 'low',
      });
      const noEffortResult = repo.getLatestSessionId(threadId, 'codex-cli', {
        modelName: 'gpt-5.4',
        reasoningEffort: null,
      });

      expect(lowResult.isOk()).toBe(true);
      expect(lowResult._unsafeUnwrap()).toBe('low-session');
      expect(noEffortResult.isOk()).toBe(true);
      expect(noEffortResult._unsafeUnwrap()).toBe('no-effort-session');
    });

    it('ignores sessions older than the provided lower bound', () => {
      const older = repo
        .insert(
          makeRun({
            provider_name: 'claude-code',
            session_id: 'claude-session-1',
            status: 'completed',
          }),
        )
        ._unsafeUnwrap();
      const newer = repo
        .insert(
          makeRun({
            provider_name: 'claude-code',
            session_id: 'claude-session-2',
            status: 'completed',
          }),
        )
        ._unsafeUnwrap();
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(100, older.id);
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(200, newer.id);

      const result = repo.getLatestSessionId(threadId, 'claude-code', { sinceCreatedAt: 201 });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('can exclude collaboration runs from session lookup', () => {
      const messageQueue = makeQueueItem('message');
      const collaborationQueue = makeQueueItem('collaboration');
      const messageRun = repo
        .insert(
          makeRun({
            provider_name: 'claude-code',
            session_id: 'claude-session-1',
            status: 'completed',
            queue_item_id: messageQueue.id,
          }),
        )
        ._unsafeUnwrap();
      const collaborationRun = repo
        .insert(
          makeRun({
            provider_name: 'claude-code',
            session_id: 'claude-session-2',
            status: 'completed',
            queue_item_id: collaborationQueue.id,
          }),
        )
        ._unsafeUnwrap();
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(100, messageRun.id);
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(200, collaborationRun.id);

      const result = repo.getLatestSessionId(threadId, 'claude-code', {
        excludeCollaboration: true,
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('claude-session-1');
    });

    it('falls back to thread-wide lookup when provider is omitted', () => {
      repo.insert(
        makeRun({
          provider_name: 'claude-code',
          session_id: 'claude-session-1',
          status: 'completed',
        }),
      );
      repo.insert(
        makeRun({
          provider_name: 'codex-cli',
          session_id: 'codex-session-1',
          status: 'completed',
        }),
      );

      const result = repo.getLatestSessionId(threadId);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('codex-session-1');
    });
  });

  describe('findLatestByThread', () => {
    it('returns the most recent run row for the thread', () => {
      const older = repo
        .insert(makeRun({ provider_name: 'claude-code', status: 'completed' }))
        ._unsafeUnwrap();
      const newer = repo
        .insert(makeRun({ provider_name: 'codex-cli', status: 'failed' }))
        ._unsafeUnwrap();
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(100, older.id);
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(200, newer.id);

      const result = repo.findLatestByThread(threadId);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()?.id).toBe(newer.id);
      expect(result._unsafeUnwrap()?.provider_name).toBe('codex-cli');
    });

    it('can exclude collaboration runs when selecting the latest run', () => {
      const messageQueue = makeQueueItem('message');
      const collaborationQueue = makeQueueItem('collaboration');
      const messageRun = repo
        .insert(
          makeRun({
            provider_name: 'claude-code',
            status: 'completed',
            queue_item_id: messageQueue.id,
          }),
        )
        ._unsafeUnwrap();
      const collaborationRun = repo
        .insert(
          makeRun({
            provider_name: 'codex-cli',
            status: 'completed',
            queue_item_id: collaborationQueue.id,
          }),
        )
        ._unsafeUnwrap();
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(100, messageRun.id);
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(200, collaborationRun.id);

      const result = repo.findLatestByThread(threadId, { excludeCollaboration: true });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()?.id).toBe(messageRun.id);
      expect(result._unsafeUnwrap()?.provider_name).toBe('claude-code');
    });
  });

  describe('updateStatus', () => {
    it('updates status to running with started_at', () => {
      const input = makeRun();
      repo.insert(input);
      const now = Date.now();
      repo.updateStatus(input.id, 'running', { started_at: now });
      const row = repo.findById(input.id)._unsafeUnwrap();
      expect(row?.status).toBe('running');
      expect(row?.started_at).toBe(now);
    });

    it('updates status to completed with ended_at', () => {
      const input = makeRun();
      repo.insert(input);
      const now = Date.now();
      repo.updateStatus(input.id, 'completed', { ended_at: now });
      const row = repo.findById(input.id)._unsafeUnwrap();
      expect(row?.status).toBe('completed');
      expect(row?.ended_at).toBe(now);
    });

    it('returns null for unknown id', () => {
      expect(repo.updateStatus(uuid(), 'failed')._unsafeUnwrap()).toBeNull();
    });
  });

  describe('updateTokens', () => {
    it('updates token usage fields', () => {
      const input = makeRun();
      repo.insert(input);
      repo.updateTokens(input.id, {
        input_tokens: 100,
        output_tokens: 200,
        cost_usd: 0.005,
      });
      const row = repo.findById(input.id)._unsafeUnwrap();
      expect(row?.input_tokens).toBe(100);
      expect(row?.output_tokens).toBe(200);
      expect(row?.cost_usd).toBeCloseTo(0.005);
    });
  });
});
