/**
 * Recent-window observation for stateless providers, on a real migrated
 * SQLite DB with the real ContextRoller and ContextAssembler.
 *
 * The invariant under test: every message is either in the observation log
 * (observed) or in the assembler's recent window (shown verbatim), never in
 * neither.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ok, err } from 'neverthrow';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';
import { BaseRepository } from '../../../src/core/database/repositories/base-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { MemoryRepository } from '../../../src/core/database/repositories/memory-repository.js';
import { ContextRoller } from '../../../src/daemon/context-roller.js';
import { ContextAssembler } from '../../../src/daemon/context-assembler.js';

const N = 3;

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

function observerReturning(text: string) {
  return vi.fn().mockResolvedValue(
    ok({
      summary: 'observed',
      data: {
        observations: [{ date: '2026-11-28', time: '10:00', priority: 'high', text }],
        taskComplete: true,
        memoryUpdates: [],
      },
    }),
  );
}

describe('ContextRoller.observeRecentWindowOverflow', () => {
  let db: Database.Database;
  let messages: MessageRepository;
  let memory: MemoryRepository;
  let threadId: string;
  let sessionTracker: { rotateSession: ReturnType<typeof vi.fn> };
  let counter: number;

  function say(body: string, direction: 'inbound' | 'outbound' = 'inbound'): void {
    messages.insert({
      id: uuid(),
      thread_id: threadId,
      direction,
      content: JSON.stringify({ body }),
      idempotency_key: `k-${counter++}`,
      provider_id: null,
      run_id: null,
    });
  }

  function roller(observerRun: ReturnType<typeof vi.fn>): ContextRoller {
    return new ContextRoller({
      messageRepo: messages,
      memoryRepo: memory,
      sessionTracker: sessionTracker as any,
      summarizerRun: vi.fn(),
      resolveSummarizerRun: (name) => (name === 'session-observer' ? (observerRun as any) : null),
      resolveReflectorRun: () => null,
      logger: makeLogger(),
    });
  }

  /** Every message body, and what the stateless run is shown (window = 2N). */
  function visibility(): { observedText: string; windowText: string } {
    const assembled = new ContextAssembler({ messageRepo: messages, memoryRepo: memory }).assemble(
      threadId,
      N * 2,
    );
    const observedText = memory
      .findByThread(threadId, 'observation')
      ._unsafeUnwrap()
      .map((o) => o.content)
      .join('\n');
    const windowText = assembled.text.split('### Recent Messages')[1] ?? '';
    return { observedText, windowText };
  }

  beforeEach(() => {
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    messages = new MessageRepository(db);
    memory = new MemoryRepository(db);
    counter = 0;
    sessionTracker = { rotateSession: vi.fn() };
    const channelId = uuid();
    new ChannelRepository(db).insert({
      id: channelId,
      type: 'telegram',
      name: `ch-${channelId}`,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });
    threadId = uuid();
    new ThreadRepository(db).insert({
      id: threadId,
      channel_id: channelId,
      external_id: 'chat-1',
      metadata: '{}',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('does nothing while fewer than 2 × recentMessageCount messages are unobserved', async () => {
    for (let i = 1; i < N * 2; i++) say(`m${i}`);
    const observer = observerReturning('x');

    const result = await roller(observer).observeRecentWindowOverflow(threadId, 'p', {
      recentMessageCount: N,
    });

    expect(result.observed).toBe(false);
    expect(observer).not.toHaveBeenCalled();
  });

  it('observes all but the newest N, keeps the session and leaves the newest N verbatim', async () => {
    for (let i = 1; i <= N * 2; i++) say(`m${i}`, i % 2 === 0 ? 'outbound' : 'inbound');
    const observer = observerReturning('first batch');

    const result = await roller(observer).observeRecentWindowOverflow(threadId, 'p', {
      recentMessageCount: N,
    });

    expect(result.observed).toBe(true);
    expect(sessionTracker.rotateSession).not.toHaveBeenCalled();
    const transcript = (observer.mock.calls[0]![2] as { transcript: string }).transcript;
    for (const body of ['m1', 'm2', 'm3']) expect(transcript).toContain(body);
    for (const body of ['m4', 'm5', 'm6']) expect(transcript).not.toContain(body);

    const [observation] = memory.findByThread(threadId, 'observation')._unsafeUnwrap();
    const meta = JSON.parse(observation!.metadata) as Record<string, unknown>;
    expect(meta.trigger).toBe('recent_window');
    expect(meta.messageCount).toBe(N);
    expect(meta.contextUsage).toBeUndefined();

    const { windowText } = visibility();
    for (const body of ['m4', 'm5', 'm6']) expect(windowText).toContain(body);
    for (const body of ['m1', 'm2', 'm3']) expect(windowText).not.toContain(`: ${body}`);
  });

  it('never leaves a message outside both the observation log and the window', async () => {
    let observed = 0;
    const observer = vi
      .fn()
      .mockImplementation(async (_t: string, _p: string, input: { transcript: string }) => {
        observed += 1;
        // Echo the observed bodies so the test can see what was compressed.
        const bodies = [...input.transcript.matchAll(/\bm\d+\b/g)].map((m) => m[0]).join(' ');
        return ok({
          summary: 'observed',
          data: {
            observations: [{ date: '2026-11-28', time: '10:00', priority: 'high', text: bodies }],
            taskComplete: true,
          },
        });
      });
    const r = roller(observer);

    for (let i = 1; i <= 25; i++) {
      say(`m${i}`);
      await r.observeRecentWindowOverflow(threadId, 'p', { recentMessageCount: N });
      const { observedText, windowText } = visibility();
      for (let j = 1; j <= i; j++) {
        const inLog = new RegExp(`\\bm${j}\\b`).test(observedText);
        const inWindow = new RegExp(`: m${j}$`, 'm').test(windowText);
        expect(inLog || inWindow, `m${j} after ${i} messages`).toBe(true);
      }
    }
    // About one observer call per N messages, not one per message.
    expect(observed).toBeGreaterThanOrEqual(6);
    expect(observed).toBeLessThanOrEqual(8);
  });

  it('removes a stale pre-roll tail from an earlier threshold rotation', async () => {
    memory.upsertByKey(threadId, 'pre-roll-tail', {
      type: 'pre-roll-tail',
      content: '### Last messages before context rotation\n[turn 1, user]: ancient',
      metadata: '{}',
    });
    for (let i = 1; i <= N * 2; i++) say(`m${i}`);

    await roller(observerReturning('batch')).observeRecentWindowOverflow(threadId, 'p', {
      recentMessageCount: N,
    });

    expect(memory.findByThread(threadId, 'pre-roll-tail')._unsafeUnwrap()).toEqual([]);
  });

  it('persists nothing and keeps the window when the observer fails', async () => {
    for (let i = 1; i <= N * 2; i++) say(`m${i}`);
    const observer = vi.fn().mockResolvedValue(err(new Error('observer down')));

    const result = await roller(observer).observeRecentWindowOverflow(threadId, 'p', {
      recentMessageCount: N,
    });

    expect(result.observed).toBe(false);
    expect(memory.findByThread(threadId, 'observation')._unsafeUnwrap()).toEqual([]);
  });

  it('is disabled for recentMessageCount 0', async () => {
    for (let i = 1; i <= 4; i++) say(`m${i}`);
    const observer = observerReturning('x');

    const result = await roller(observer).observeRecentWindowOverflow(threadId, 'p', {
      recentMessageCount: 0,
    });

    expect(result.observed).toBe(false);
    expect(observer).not.toHaveBeenCalled();
  });
});
