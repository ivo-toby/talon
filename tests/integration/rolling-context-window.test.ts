/**
 * Integration test for the rolling context window.
 *
 * Uses a real SQLite database with actual repositories to verify:
 * 1. ContextRoller triggers summarization and stores a memory item
 * 2. ContextAssembler picks up the stored summary and formats it
 * 3. The full cycle: messages → threshold exceeded → summary stored →
 *    fresh session gets injected context
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ok } from 'neverthrow';
import { randomUUID } from 'node:crypto';

import { MessageRepository } from '../../src/core/database/repositories/message-repository.js';
import { MemoryRepository } from '../../src/core/database/repositories/memory-repository.js';
import { ContextRoller } from '../../src/daemon/context-roller.js';
import { ContextAssembler } from '../../src/daemon/context-assembler.js';
import { SessionTracker } from '../../src/sandbox/session-tracker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Minimal schema for messages and memory_items
  db.exec(`
    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL UNIQUE,
      config TEXT NOT NULL DEFAULT '{}',
      credentials_ref TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
    );

    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id),
      external_id TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id),
      direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
      content TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      provider_id TEXT,
      run_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
    );

    CREATE TABLE memory_items (
      id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('fact','summary','note','embedding_ref')),
      content TEXT NOT NULL,
      embedding_ref TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000),
      PRIMARY KEY (thread_id, id)
    );
  `);

  return db;
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Rolling context window integration', () => {
  let db: Database.Database;
  let messageRepo: MessageRepository;
  let memoryRepo: MemoryRepository;
  let sessionTracker: SessionTracker;
  const threadId = 'thread-integration';
  const personaId = 'persona-1';

  beforeEach(() => {
    db = createTestDb();
    messageRepo = new MessageRepository(db);
    memoryRepo = new MemoryRepository(db);
    sessionTracker = new SessionTracker();
    vi.clearAllMocks();

    // Seed channel and thread for FK constraints
    const channelId = randomUUID();
    db.prepare('INSERT INTO channels (id, type, name) VALUES (?, ?, ?)').run(channelId, 'terminal', 'test-channel');
    db.prepare('INSERT INTO threads (id, channel_id, external_id) VALUES (?, ?, ?)').run(threadId, channelId, 'ext-1');
  });

  afterEach(() => {
    db.close();
  });

  it('full cycle: messages → roller triggers → summary stored → assembler injects context', async () => {
    // 1. Seed conversation messages
    const messages = [
      { dir: 'inbound', body: 'Can you help me deploy to production?' },
      { dir: 'outbound', body: 'Sure! I will run the deployment pipeline now.' },
      { dir: 'inbound', body: 'Use the staging config first.' },
      { dir: 'outbound', body: 'Got it. Running with staging config. Build succeeded.' },
      { dir: 'inbound', body: 'Great, now promote to production.' },
      { dir: 'outbound', body: 'Production deployment complete. All health checks passing.' },
    ];

    for (let i = 0; i < messages.length; i++) {
      messageRepo.insert({
        id: `msg-${i}`,
        thread_id: threadId,
        direction: messages[i].dir as 'inbound' | 'outbound',
        content: JSON.stringify({ body: messages[i].body }),
        idempotency_key: `key-${i}`,
        provider_id: null,
        run_id: null,
      });
    }

    // Set an active session that should be cleared
    sessionTracker.setSessionId(threadId, 'old-session-123');
    expect(sessionTracker.getSessionId(threadId)).toBe('old-session-123');

    // 2. Create ContextRoller with mock summarizer
    const mockSummarizerRun = vi.fn().mockResolvedValue(ok({
      summary: 'User deployed to production via staging.',
      data: {
        keyFacts: [
          'Deployment pipeline used staging config first',
          'Production deployment succeeded with passing health checks',
        ],
        openThreads: [],
        summary: 'User requested a production deployment. Staged first, then promoted. All health checks passing.',
      },
    }));

    const roller = new ContextRoller({
      messageRepo,
      memoryRepo,
      sessionTracker,
      summarizerRun: mockSummarizerRun,
      logger: mockLogger,
      thresholdRatio: 0.4,
    });

    // 3. Trigger rotation (simulate 90K tokens)
    await roller.checkAndRotate(threadId, personaId, {
      ratio: 0.45,
      inputTokens: 90_000,
      rawMetric: 90_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    // 4. Verify: session was cleared
    expect(sessionTracker.getSessionId(threadId)).toBeUndefined();
    expect(sessionTracker.wasRotated(threadId)).toBe(true);

    // 5. Verify: summarizer was called with reconstructed transcript
    expect(mockSummarizerRun).toHaveBeenCalledOnce();
    const summarizerInput = mockSummarizerRun.mock.calls[0][2];
    expect(summarizerInput.transcript).toContain('User: Can you help me deploy');
    expect(summarizerInput.transcript).toContain('Assistant: Production deployment complete');

    // 6. Verify: summary stored as memory item
    const memories = memoryRepo.findByThread(threadId, 'summary');
    expect(memories.isOk()).toBe(true);
    const summaryItems = memories._unsafeUnwrap();
    expect(summaryItems).toHaveLength(1);
    expect(summaryItems[0].type).toBe('summary');
    expect(summaryItems[0].content).toContain('production deployment');
    expect(summaryItems[0].content).toContain('Staged first, then promoted');

    // Verify metadata
    const metadata = JSON.parse(summaryItems[0].metadata);
    expect(metadata.source).toBe('context-roller');
    expect(metadata.messageCount).toBe(6);
    expect(typeof metadata.rotatedThroughTs).toBe('number');
    expect(metadata.rotatedThroughTs).toBeGreaterThan(0);
    expect(metadata.contextUsage).toEqual({
      ratio: 0.45,
      inputTokens: 90_000,
      rawMetric: 90_000,
      rawMetricName: 'cache_read_input_tokens',
    });
    expect(metadata.cacheReadTokens).toBe(90_000);

    // 7. Now test ContextAssembler picks up the stored summary
    const assembler = new ContextAssembler({
      messageRepo,
      memoryRepo,
    });

    const context = assembler.assemble(threadId, 10);

    // Should contain the summary
    expect(context.text).toContain('Previous Context');
    expect(context.text).toContain('read-only summary');
    expect(context.text).toContain('production deployment');
    expect(context.text).toContain('staging config');

    // Recent Messages is scoped to post-rotation messages. All transcript
    // messages in this scenario were created BEFORE the summary, so they
    // should NOT be replayed verbatim — the summary is the compressed
    // representation of that history. Replaying pre-rotation turns would
    // make the agent re-read the user's original instruction and redo the
    // work (issue fixed on fix/om-resuming-fail).
    expect(context.text).not.toContain('Recent Messages');
    expect(context.text).not.toContain('User: Can you help me deploy');
    expect(context.text).not.toContain('Assistant: Production deployment complete');
  });

  it('roller does not trigger below threshold', async () => {
    const mockSummarizerRun = vi.fn();

    const roller = new ContextRoller({
      messageRepo,
      memoryRepo,
      sessionTracker,
      summarizerRun: mockSummarizerRun,
      logger: mockLogger,
      thresholdRatio: 0.4,
    });

    sessionTracker.setSessionId(threadId, 'active-session');

    await roller.checkAndRotate(threadId, personaId, {
      ratio: 0.25,
      inputTokens: 50_000,
      rawMetric: 50_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    // Session should be untouched
    expect(sessionTracker.getSessionId(threadId)).toBe('active-session');
    expect(mockSummarizerRun).not.toHaveBeenCalled();
  });

  it('assembler returns empty string for thread with no history', () => {
    const assembler = new ContextAssembler({
      messageRepo,
      memoryRepo,
    });

    const context = assembler.assemble('nonexistent-thread', 10);
    expect(context).toEqual({
      text: '',
      summaryFound: false,
      recentMessageCount: 0,
      charCount: 0,
    });
  });

  it('assembler returns only recent messages when no summary exists', () => {
    // Insert a couple of messages but no summary
    messageRepo.insert({
      id: 'msg-a',
      thread_id: threadId,
      direction: 'inbound',
      content: JSON.stringify({ body: 'first message' }),
      idempotency_key: 'key-a',
      provider_id: null,
      run_id: null,
    });
    messageRepo.insert({
      id: 'msg-b',
      thread_id: threadId,
      direction: 'outbound',
      content: JSON.stringify({ body: 'first reply' }),
      idempotency_key: 'key-b',
      provider_id: null,
      run_id: null,
    });

    const assembler = new ContextAssembler({
      messageRepo,
      memoryRepo,
    });

    const context = assembler.assemble(threadId, 10);
    expect(context.text).toContain('Recent Messages');
    expect(context.text).toContain('User: first message');
    expect(context.text).toContain('Assistant: first reply');
    // No summary section content beyond the header
    expect(context.text).not.toContain('Key facts');
  });

  it('roller preserves session when summarizer fails', async () => {
    messageRepo.insert({
      id: 'msg-fail',
      thread_id: threadId,
      direction: 'inbound',
      content: JSON.stringify({ body: 'test message' }),
      idempotency_key: 'key-fail',
      provider_id: null,
      run_id: null,
    });

    sessionTracker.setSessionId(threadId, 'keep-this-session');

    const mockSummarizerRun = vi.fn().mockResolvedValue(
      (await import('neverthrow')).err(new Error('API timeout')),
    );

    const roller = new ContextRoller({
      messageRepo,
      memoryRepo,
      sessionTracker,
      summarizerRun: mockSummarizerRun,
      logger: mockLogger,
      thresholdRatio: 0.4,
    });

    await roller.checkAndRotate(threadId, personaId, {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    // Session must be preserved
    expect(sessionTracker.getSessionId(threadId)).toBe('keep-this-session');

    // No summary stored
    const memories = memoryRepo.findByThread(threadId, 'summary');
    expect(memories._unsafeUnwrap()).toHaveLength(0);
  });
});
