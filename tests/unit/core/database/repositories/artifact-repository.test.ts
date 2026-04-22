import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ArtifactRepository } from '../../../../../src/core/database/repositories/artifact-repository.js';
import { RunRepository } from '../../../../../src/core/database/repositories/run-repository.js';
import { ThreadRepository } from '../../../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../../../src/core/database/repositories/persona-repository.js';
import { createTestDb, uuid } from './helpers.js';

describe('ArtifactRepository', () => {
  let db: Database.Database;
  let repo: ArtifactRepository;
  let threadId: string;
  let runId: string;

  beforeEach(() => {
    db = createTestDb();
    repo = new ArtifactRepository(db);

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

  function makeArtifact(overrides: Partial<Parameters<ArtifactRepository['insert']>[0]> = {}) {
    return {
      id: uuid(),
      run_id: runId,
      thread_id: threadId,
      path: `output/${uuid()}.txt`,
      mime_type: 'text/plain',
      size: 1024,
      checksum: null,
      ...overrides,
    };
  }

  describe('insert', () => {
    it('inserts and returns the artifact', () => {
      const input = makeArtifact();
      const result = repo.insert(input);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().id).toBe(input.id);
    });

    it('returns err for non-existent run_id (FK)', () => {
      expect(repo.insert(makeArtifact({ run_id: uuid() })).isErr()).toBe(true);
    });
  });

  describe('findByRun', () => {
    it('returns artifacts for a run', () => {
      repo.insert(makeArtifact());
      repo.insert(makeArtifact());
      expect(repo.findByRun(runId)._unsafeUnwrap()).toHaveLength(2);
    });

    it('returns empty array for unknown run', () => {
      expect(repo.findByRun(uuid())._unsafeUnwrap()).toHaveLength(0);
    });
  });

  describe('findByThread', () => {
    it('returns artifacts for a thread', () => {
      repo.insert(makeArtifact());
      expect(repo.findByThread(threadId)._unsafeUnwrap()).toHaveLength(1);
    });

    it('returns empty array for unknown thread', () => {
      expect(repo.findByThread(uuid())._unsafeUnwrap()).toHaveLength(0);
    });
  });
});
