import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ToolResultRepository } from '../../../../../src/core/database/repositories/tool-result-repository.js';
import { RunRepository } from '../../../../../src/core/database/repositories/run-repository.js';
import { ThreadRepository } from '../../../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../../../src/core/database/repositories/persona-repository.js';
import { createTestDb, uuid } from './helpers.js';

describe('ToolResultRepository', () => {
  let db: Database.Database;
  let repo: ToolResultRepository;
  let runId: string;

  beforeEach(() => {
    db = createTestDb();
    repo = new ToolResultRepository(db);

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
    const threadId = uuid();
    threads.insert({
      id: threadId,
      channel_id: channelId,
      external_id: `ext-${uuid()}`,
      metadata: '{}',
    });

    const personas = new PersonaRepository(db);
    const personaId = uuid();
    personas.insert({
      id: personaId,
      name: `persona-${uuid()}`,
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      max_concurrent: null,
    });

    const runs = new RunRepository(db);
    runId = uuid();
    runs.insert({
      id: runId,
      thread_id: threadId,
      persona_id: personaId,
      provider_name: 'claude-code',
      sandbox_id: null,
      session_id: null,
      status: 'running',
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
    });
  });

  afterEach(() => {
    db.close();
  });

  function makeToolResult(overrides: Partial<Parameters<ToolResultRepository['insert']>[0]> = {}) {
    return {
      run_id: runId,
      request_id: uuid(),
      tool: 'http-proxy',
      result: '{"status":200}',
      status: 'success' as const,
      ...overrides,
    };
  }

  describe('insert', () => {
    it('inserts and returns the tool result', () => {
      const input = makeToolResult();
      const result = repo.insert(input);
      expect(result.isOk()).toBe(true);
      const row = result._unsafeUnwrap();
      expect(row.run_id).toBe(input.run_id);
      expect(row.request_id).toBe(input.request_id);
      expect(row.status).toBe('success');
    });

    it('returns err for duplicate (run_id, request_id) — PK violation', () => {
      const input = makeToolResult();
      repo.insert(input);
      const result = repo.insert(input);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DB_ERROR');
    });

    it('returns err for non-existent run_id (FK)', () => {
      expect(repo.insert(makeToolResult({ run_id: uuid() })).isErr()).toBe(true);
    });
  });

  describe('findByRunAndRequest', () => {
    it('finds an existing cached result', () => {
      const input = makeToolResult();
      repo.insert(input);
      const result = repo.findByRunAndRequest(input.run_id, input.request_id);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()?.request_id).toBe(input.request_id);
    });

    it('returns null when no result cached', () => {
      const result = repo.findByRunAndRequest(runId, uuid());
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('differentiates requests within the same run', () => {
      const req1 = uuid();
      const req2 = uuid();
      repo.insert(makeToolResult({ request_id: req1 }));
      repo.insert(makeToolResult({ request_id: req2 }));

      expect(repo.findByRunAndRequest(runId, req1)._unsafeUnwrap()?.request_id).toBe(req1);
      expect(repo.findByRunAndRequest(runId, req2)._unsafeUnwrap()?.request_id).toBe(req2);
    });
  });
});
