import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  resetProviderAffinity,
  formatResetProviderAffinityWarning,
} from '../../../src/cli/commands/reset-provider-affinity.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { RunRepository } from '../../../src/core/database/repositories/run-repository.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

describe('resetProviderAffinity()', () => {
  let db: Database.Database;
  let channelId: string;
  let threadId: string;
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

    const threads = new ThreadRepository(db);
    threadId = uuid();
    threads.insert({
      id: threadId,
      channel_id: channelId,
      external_id: 'chat-123',
      metadata: '{"existing":true}',
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
      max_concurrent: null,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('writes the reset marker after confirmation', async () => {
    const runs = new RunRepository(db);
    const run = runs.insert({
      id: uuid(),
      thread_id: threadId,
      persona_id: personaId,
      provider_name: 'claude-code',
      sandbox_id: null,
      session_id: 'session-1',
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
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(100, run.id);

    const result = await resetProviderAffinity({
      channel: 'tg',
      externalId: 'chat-123',
      db,
      now: () => 999,
      confirm: vi.fn().mockResolvedValue(true),
    });

    expect(result.aborted).toBe(false);
    expect(result.resetAt).toBe(999);
    const updated = new ThreadRepository(db).findById(threadId)._unsafeUnwrap();
    expect(updated?.metadata).toBe('{"existing":true,"providerAffinityResetAt":999}');
  });

  it('aborts without modifying metadata when confirmation is declined', async () => {
    const result = await resetProviderAffinity({
      channel: 'tg',
      externalId: 'chat-123',
      db,
      now: () => 999,
      confirm: vi.fn().mockResolvedValue(false),
    });

    expect(result.aborted).toBe(true);
    const updated = new ThreadRepository(db).findById(threadId)._unsafeUnwrap();
    expect(updated?.metadata).toBe('{"existing":true}');
  });

  it('throws for unknown channel or thread', async () => {
    await expect(resetProviderAffinity({
      channel: 'missing',
      externalId: 'chat-123',
      db,
    })).rejects.toThrow('Unknown channel: "missing"');

    await expect(resetProviderAffinity({
      channel: 'tg',
      externalId: 'missing',
      db,
    })).rejects.toThrow('Unknown thread for channel "tg" and external ID "missing"');
  });

  it('formats a warning message that references list-threads discovery', () => {
    const warning = formatResetProviderAffinityWarning({
      channel: 'tg',
      externalId: 'chat-123',
      threadId,
      lastProviderName: 'claude-code',
      lastRunStatus: 'completed',
      lastActivityAt: 100,
    });

    expect(warning).toContain('Reset provider affinity for channel "tg" thread "chat-123"');
    expect(warning).toContain('This keeps run history intact');
    expect(warning).toContain('list-threads');
  });

  it('builds the preview from non-collaboration thread history', async () => {
    const queue = db.prepare(`
      INSERT INTO queue_items
        (id, thread_id, message_id, type, status, attempts, max_attempts, next_retry_at, error, payload, claimed_at, created_at, updated_at)
      VALUES
        (?, ?, NULL, ?, 'completed', 0, 3, NULL, NULL, '{}', NULL, ?, ?)
    `);
    const messageQueueId = uuid();
    const collaborationQueueId = uuid();
    queue.run(messageQueueId, threadId, 'message', 10, 10);
    queue.run(collaborationQueueId, threadId, 'collaboration', 20, 20);

    const runs = new RunRepository(db);
    const messageRun = runs.insert({
      id: uuid(),
      thread_id: threadId,
      persona_id: personaId,
      provider_name: 'claude-code',
      sandbox_id: null,
      session_id: null,
      status: 'completed',
      parent_run_id: null,
      queue_item_id: messageQueueId,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      error: null,
      started_at: null,
      ended_at: null,
    })._unsafeUnwrap();
    const collaborationRun = runs.insert({
      id: uuid(),
      thread_id: threadId,
      persona_id: personaId,
      provider_name: 'codex-cli',
      sandbox_id: null,
      session_id: null,
      status: 'failed',
      parent_run_id: null,
      queue_item_id: collaborationQueueId,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      error: null,
      started_at: null,
      ended_at: null,
    })._unsafeUnwrap();
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(100, messageRun.id);
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(200, collaborationRun.id);

    const result = await resetProviderAffinity({
      channel: 'tg',
      externalId: 'chat-123',
      db,
      now: () => 999,
      confirm: vi.fn().mockResolvedValue(false),
    });

    expect(result.aborted).toBe(true);
    expect(result.lastProviderName).toBe('claude-code');
    expect(result.lastRunStatus).toBe('completed');
    expect(result.lastActivityAt).toBe(100);
  });
});
