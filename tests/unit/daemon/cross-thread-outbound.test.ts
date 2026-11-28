/**
 * Cross-thread outbound notices, end to end on a real (migrated) SQLite DB:
 * a scheduled run sends into a live conversation with the real
 * ChannelSendHandler / ChannelBroadcastHandler, and the next resumed run on
 * that conversation derives the unseen outbounds from the database.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from 'neverthrow';
import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { BaseRepository } from '../../../src/core/database/repositories/base-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { BindingRepository } from '../../../src/core/database/repositories/binding-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { MessageRefRepository } from '../../../src/core/database/repositories/message-ref-repository.js';
import { RunRepository } from '../../../src/core/database/repositories/run-repository.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { ChannelSendHandler } from '../../../src/tools/host-tools/channel-send.js';
import { ChannelBroadcastHandler } from '../../../src/tools/host-tools/channel-broadcast.js';
import { SessionTracker } from '../../../src/sandbox/session-tracker.js';
import {
  loadPendingCrossThreadOutbound,
  formatNoticeTime,
} from '../../../src/daemon/cross-thread-outbound.js';
import type { ChannelRegistry } from '../../../src/channels/channel-registry.js';

const MIGRATIONS = join(import.meta.dirname, '../../../src/core/database/migrations');
const PROVIDER = 'claude-code';
const MODEL = 'claude-sonnet-4-20250514';
const SESSION = 'live-session';

function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  const migrated = runMigrations(db, MIGRATIONS);
  if (migrated.isErr()) throw new Error(migrated.error.message);
  return db;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

function makeRepos(db: Database.Database) {
  return {
    channel: new ChannelRepository(db),
    persona: new PersonaRepository(db),
    thread: new ThreadRepository(db),
    binding: new BindingRepository(db),
    message: new MessageRepository(db),
    messageRef: new MessageRefRepository(db),
    run: new RunRepository(db),
    queue: new QueueRepository(db),
  };
}

type Repos = ReturnType<typeof makeRepos>;

describe('cross-thread outbound notices', () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;
  let repos: Repos;
  let nextExternalId: number;

  const ids = {
    channel: 'chan-1',
    persona: 'persona-1',
    live: 'live-thread',
    schedule: 'schedule-thread',
  };

  function registry(): ChannelRegistry {
    const connector = {
      type: 'telegram',
      name: 'telegram-main',
      send: vi.fn(async () => ok({ externalMessageId: String(nextExternalId++) })),
      format: vi.fn((s: string) => s),
    };
    return { get: vi.fn().mockReturnValue(connector) } as unknown as ChannelRegistry;
  }

  function sendHandler(r: Repos = repos): ChannelSendHandler {
    return new ChannelSendHandler({
      channelRegistry: registry(),
      threadRepository: r.thread,
      channelRepository: r.channel,
      messageRepository: r.message,
      bindingRepository: r.binding,
      messageRefRepository: r.messageRef,
      logger: makeLogger(),
    });
  }

  /** Inserts a run row; completes it unless told otherwise. */
  function run(
    threadId: string,
    opts: {
      sessionId?: string | null;
      status?: 'completed' | 'failed' | 'running';
      queueType?: 'message' | 'schedule' | 'collaboration';
    } = {},
  ): { id: string; createdAt: number } {
    const id = `run-${Math.random().toString(36).slice(2)}`;
    let queueItemId: string | null = null;
    if (opts.queueType) {
      queueItemId = `qi-${id}`;
      repos.queue.enqueue({
        id: queueItemId,
        thread_id: threadId,
        message_id: null,
        type: opts.queueType,
        payload: '{}',
        max_attempts: 1,
      });
    }
    const inserted = repos.run.insert({
      id,
      thread_id: threadId,
      persona_id: ids.persona,
      provider_name: PROVIDER,
      model_name: MODEL,
      sandbox_id: null,
      session_id: opts.sessionId === undefined ? SESSION : opts.sessionId,
      status: 'running',
      parent_run_id: null,
      queue_item_id: queueItemId,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      error: null,
      started_at: Date.now(),
      ended_at: null,
    });
    if (inserted.isErr()) throw inserted.error;
    const status = opts.status ?? 'completed';
    if (status !== 'running') repos.run.updateStatus(id, status, { ended_at: Date.now() });
    return { id, createdAt: inserted.value.created_at };
  }

  async function scheduledSend(content: string, r: Repos = repos): Promise<void> {
    const scheduleRun = run(ids.schedule, { sessionId: null, queueType: 'schedule' });
    const result = await sendHandler(r).execute(
      { channelId: 'telegram-main', content },
      { runId: scheduleRun.id, threadId: ids.schedule, personaId: ids.persona, requestId: content },
    );
    expect(result.status).toBe('success');
  }

  /** What the next resumed run on the live thread is shown. */
  function nextResumedRun(
    r: Repos = repos,
    limits?: Parameters<typeof loadPendingCrossThreadOutbound>[1]['limits'],
  ) {
    const current = run(ids.live, { status: 'running' });
    const pending = loadPendingCrossThreadOutbound(
      { messageRepository: r.message, runRepository: r.run },
      {
        threadId: ids.live,
        sessionId: SESSION,
        currentRunCreatedAt: current.createdAt,
        ...(limits ? { limits } : {}),
      },
    )._unsafeUnwrap();
    return { current, pending };
  }

  beforeEach(() => {
    BaseRepository.__resetMonotonicClockForTests();
    nextExternalId = 4521;
    dir = mkdtempSync(join(tmpdir(), 'talon-xthread-'));
    dbPath = join(dir, 'test.sqlite');
    db = openDb(dbPath);
    repos = makeRepos(db);
    repos.channel.insert({
      id: ids.channel,
      type: 'telegram',
      name: 'telegram-main',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });
    repos.persona.insert({
      id: ids.persona,
      name: 'assistant',
      model: MODEL,
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });
    repos.thread.insert({
      id: ids.live,
      channel_id: ids.channel,
      external_id: 'chat-42',
      metadata: '{}',
    });
    repos.thread.insert({
      id: ids.schedule,
      channel_id: ids.channel,
      external_id: 'schedule:assistant:telegram-main:chat-42',
      metadata: JSON.stringify({ kind: 'schedule', originExternalId: 'chat-42' }),
    });
    repos.binding.insert({
      id: 'binding-1',
      channel_id: ids.channel,
      thread_id: null,
      persona_id: ids.persona,
      is_default: 1,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the recipient session after a cross-thread channel.send', async () => {
    run(ids.live);
    const tracker = new SessionTracker();
    tracker.setSessionId(ids.live, SESSION, PROVIDER, MODEL);

    await scheduledSend('What is on your plate today?');

    expect(tracker.getSessionId(ids.live, PROVIDER, MODEL)).toBe(SESSION);
    expect(tracker.wasRotated(ids.live)).toBe(false);
    expect(
      repos.run
        .getLatestSessionId(ids.live, PROVIDER, { excludeCollaboration: true })
        ._unsafeUnwrap(),
    ).toBe(SESSION);
  });

  it('shows the outbound on the next resumed run, exactly once', async () => {
    run(ids.live);
    await scheduledSend('What is on your plate today?');

    const first = nextResumedRun();
    expect(first.pending.omitted).toBe(0);
    expect(first.pending.rendered).toHaveLength(1);
    const sentAt = db
      .prepare("SELECT created_at FROM messages WHERE thread_id = ? AND direction = 'outbound'")
      .get(ids.live) as { created_at: number };
    expect(first.pending.rendered[0]).toBe(
      `[You sent this message to this chat at ${formatNoticeTime(sentAt.created_at)}, ` +
        'from a scheduled task (id 4521)]\nWhat is on your plate today?',
    );
    repos.run.updateStatus(first.current.id, 'completed', { ended_at: Date.now() });

    expect(nextResumedRun().pending.rendered).toEqual([]);
  });

  it('delivers several queued outbounds (send and broadcast) in order, once', async () => {
    run(ids.live);
    await scheduledSend('first');
    await scheduledSend('second');
    // Broadcast reaches thread-scoped bindings only.
    repos.binding.insert({
      id: 'binding-live',
      channel_id: ids.channel,
      thread_id: ids.live,
      persona_id: ids.persona,
      is_default: 0,
    });
    const broadcastRun = run(ids.schedule, { sessionId: null, queueType: 'schedule' });
    const broadcast = await new ChannelBroadcastHandler({
      channelRegistry: registry(),
      bindingRepository: repos.binding,
      channelRepository: repos.channel,
      threadRepository: repos.thread,
      messageRepository: repos.message,
      logger: makeLogger(),
    }).execute(
      { content: 'third' },
      { runId: broadcastRun.id, threadId: ids.schedule, personaId: ids.persona, requestId: 'b' },
    );
    expect(broadcast.status).toBe('success');

    const next = nextResumedRun();
    expect(next.pending.rendered.map((n) => n.split('\n')[1])).toEqual([
      'first',
      'second',
      'third',
    ]);
    repos.run.updateStatus(next.current.id, 'completed', { ended_at: Date.now() });
    expect(nextResumedRun().pending.rendered).toEqual([]);
  });

  it('survives a daemon restart between the send and the reply', async () => {
    run(ids.live);
    await scheduledSend('What is on your plate today?');
    db.close();

    // "Restart": new connection, new repositories, empty in-memory tracker.
    BaseRepository.__resetMonotonicClockForTests();
    db = openDb(dbPath);
    BaseRepository.seedMonotonicClockFromDb(db);
    repos = makeRepos(db);
    const tracker = new SessionTracker();
    expect(tracker.getSessionId(ids.live, PROVIDER, MODEL)).toBeUndefined();
    // The DB fallback is not blocked, so the session is restored ...
    expect(tracker.wasRotated(ids.live)).toBe(false);
    expect(
      repos.run
        .getLatestSessionId(ids.live, PROVIDER, { excludeCollaboration: true })
        ._unsafeUnwrap(),
    ).toBe(SESSION);
    // ... and the outbound is still shown.
    const next = nextResumedRun();
    expect(next.pending.rendered).toHaveLength(1);
    expect(next.pending.rendered[0]).toContain('What is on your plate today?');
  });

  it('does not let a failed run, an A2A run or another session consume the window', async () => {
    run(ids.live);
    await scheduledSend('still pending');
    run(ids.live, { status: 'failed' });
    run(ids.live, { sessionId: null, queueType: 'collaboration' });
    run(ids.live, { sessionId: 'voice-call-session' });

    const next = nextResumedRun();
    expect(next.pending.rendered).toHaveLength(1);
    expect(next.pending.rendered[0]).toContain('still pending');
  });

  it('ignores the thread’s own outbounds and labels background-task sends', () => {
    const own = run(ids.live);
    repos.message.insert({
      id: 'own-reply',
      thread_id: ids.live,
      direction: 'outbound',
      content: JSON.stringify({ body: 'own reply' }),
      idempotency_key: 'own',
      provider_id: null,
      run_id: own.id,
    });
    repos.message.insert({
      id: 'bg-msg',
      thread_id: ids.live,
      direction: 'outbound',
      content: JSON.stringify({ body: 'research done' }),
      idempotency_key: 'bg',
      provider_id: null,
      run_id: 'background-task-without-run-row',
    });

    const next = nextResumedRun();
    expect(next.pending.rendered).toHaveLength(1);
    expect(next.pending.rendered[0]).toMatch(/from a background task\]\nresearch done$/);
  });

  it('keeps the newest notices within the budget and counts the rest as omitted', async () => {
    run(ids.live);
    for (const body of ['one', 'two', 'three']) await scheduledSend(body);

    const byCount = nextResumedRun(repos, { maxNotices: 2 });
    expect(byCount.pending.omitted).toBe(1);
    expect(byCount.pending.rendered.map((n) => n.split('\n')[1])).toEqual(['two', 'three']);

    const tight = loadPendingCrossThreadOutbound(
      { messageRepository: repos.message, runRepository: repos.run },
      {
        threadId: ids.live,
        sessionId: SESSION,
        currentRunCreatedAt: byCount.current.createdAt,
        limits: { maxTotalChars: 200 },
      },
    )._unsafeUnwrap();
    expect(tight.rendered).toHaveLength(1);
    expect(tight.omitted).toBe(2);
    expect(tight.rendered[0]).toMatch(/\nthree$/);
    expect(tight.charCount).toBeLessThanOrEqual(200);
  });

  it('shows nothing when the thread has no completed run to anchor on', async () => {
    await scheduledSend('orphan');
    expect(nextResumedRun().pending.rendered).toEqual([]);
  });
});
