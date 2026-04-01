import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { listThreads } from '../../../src/cli/commands/list-threads.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { RunRepository } from '../../../src/core/database/repositories/run-repository.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

describe('listThreads()', () => {
  let db: Database.Database;
  let channelId: string;
  let personaId: string;

  beforeEach(() => {
    db = createTestDb();

    const channels = new ChannelRepository(db);
    channelId = uuid();
    channels.insert({
      id: channelId,
      type: 'telegram',
      name: 'tg',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    const personas = new PersonaRepository(db);
    personaId = uuid();
    personas.insert({
      id: personaId,
      name: 'assistant',
      model: 'gpt-5.4',
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

  it('returns channel threads with latest provider and status', () => {
    const threads = new ThreadRepository(db);
    const alpha = threads.insert({
      id: uuid(),
      channel_id: channelId,
      external_id: 'chat-1',
      metadata: '{}',
    })._unsafeUnwrap();
    const beta = threads.insert({
      id: uuid(),
      channel_id: channelId,
      external_id: 'chat-2',
      metadata: '{}',
    })._unsafeUnwrap();

    const runs = new RunRepository(db);
    const alphaRun = runs.insert({
      id: uuid(),
      thread_id: alpha.id,
      persona_id: personaId,
      provider_name: 'claude-code',
      sandbox_id: null,
      session_id: null,
      status: 'completed',
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
    })._unsafeUnwrap();
    const betaRun = runs.insert({
      id: uuid(),
      thread_id: beta.id,
      persona_id: personaId,
      provider_name: 'codex-cli',
      sandbox_id: null,
      session_id: null,
      status: 'failed',
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
    })._unsafeUnwrap();
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(100, alphaRun.id);
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(200, betaRun.id);

    const result = listThreads({ channel: 'tg', db });

    expect(result).toEqual([
      {
        threadId: beta.id,
        externalId: 'chat-2',
        lastProviderName: 'codex-cli',
        lastRunStatus: 'failed',
        lastActivityAt: 200,
      },
      {
        threadId: alpha.id,
        externalId: 'chat-1',
        lastProviderName: 'claude-code',
        lastRunStatus: 'completed',
        lastActivityAt: 100,
      },
    ]);
  });

  it('throws when the channel does not exist in the database', () => {
    expect(() => listThreads({ channel: 'missing', db })).toThrow('Unknown channel: "missing"');
  });
});
