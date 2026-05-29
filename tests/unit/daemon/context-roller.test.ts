import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from 'neverthrow';

import {
  ContextRoller,
  DEFAULT_MAX_OBSERVATION_CHARS,
  type ContextRollerDeps,
} from '../../../src/daemon/context-roller.js';

const mockSummarizerRun = vi.fn();

const makeDeps = (overrides: Partial<ContextRollerDeps> = {}): ContextRollerDeps => ({
  messageRepo: {
    findLatestByThread: vi.fn().mockReturnValue(ok([])),
    findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
  } as any,
  memoryRepo: {
    insert: vi.fn().mockReturnValue(ok({})),
    findById: vi.fn().mockReturnValue(ok(null)),
    findByThread: vi.fn().mockReturnValue(ok([])),
    upsertByKey: vi.fn().mockReturnValue(ok({})),
    delete: vi.fn().mockReturnValue(ok(undefined)),
    runInTransaction: vi.fn().mockImplementation((fn: () => unknown) => ok(fn())),
  } as any,
  sessionTracker: {
    rotateSession: vi.fn(),
  } as any,
  summarizerRun: mockSummarizerRun,
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any,
  thresholdRatio: 0.4,
  ...overrides,
});

describe('ContextRoller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when context usage is below threshold', async () => {
    const deps = makeDeps();
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.25,
      inputTokens: 50_000,
      rawMetric: 50_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.messageRepo.findLatestByThread).not.toHaveBeenCalled();
    expect(mockSummarizerRun).not.toHaveBeenCalled();
  });

  it('triggers rotation when context usage exceeds threshold', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'hello' }), created_at: 1000 },
      { direction: 'outbound', content: JSON.stringify({ body: 'hi there' }), created_at: 2000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'User said hello',
      data: {
        keyFacts: ['User greeted'],
        openThreads: [],
        summary: 'User said hello',
      },
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0 },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.45,
      inputTokens: 90_000,
      rawMetric: 90_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.messageRepo.findLatestByThread).toHaveBeenCalledWith('thread-1', 10000);
    expect(mockSummarizerRun).toHaveBeenCalled();
    expect(deps.memoryRepo.insert).toHaveBeenCalled();
    expect(deps.sessionTracker.rotateSession).toHaveBeenCalledWith('thread-1');
  });

  it('uses the configured summarizer name when a resolver is available', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'hello' }), created_at: 1000 },
    ];
    const alternateSummarizerRun = vi.fn().mockResolvedValueOnce(ok({
      summary: 'Greeting exchange',
      data: {
        keyFacts: ['User greeted'],
        openThreads: [],
        summary: 'Greeting exchange',
      },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
      resolveSummarizerRun: vi.fn().mockReturnValue(alternateSummarizerRun),
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate(
      'thread-1',
      'persona-1',
      {
        ratio: 0.45,
        inputTokens: 90_000,
        rawMetric: 90_000,
        rawMetricName: 'cache_read_input_tokens',
      },
      0.4,
      'custom-summarizer',
    );

    expect(deps.resolveSummarizerRun).toHaveBeenCalledWith('custom-summarizer');
    expect(alternateSummarizerRun).toHaveBeenCalledOnce();
    expect(mockSummarizerRun).not.toHaveBeenCalled();
  });

  it('does not fall back to the default summarizer when a named summarizer cannot be resolved', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'hello' }), created_at: 1000 },
    ];

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
      resolveSummarizerRun: vi.fn().mockReturnValue(null),
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate(
      'thread-1',
      'persona-1',
      {
        ratio: 0.45,
        inputTokens: 90_000,
        rawMetric: 90_000,
        rawMetricName: 'cache_read_input_tokens',
      },
      0.4,
      'missing-summarizer',
    );

    expect(deps.resolveSummarizerRun).toHaveBeenCalledWith('missing-summarizer');
    expect(mockSummarizerRun).not.toHaveBeenCalled();
    expect(deps.memoryRepo.insert).not.toHaveBeenCalled();
    expect(deps.sessionTracker.rotateSession).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        summarizer: 'missing-summarizer',
      }),
      expect.stringContaining('summarizer not available'),
    );
  });

  it('stores summary as memory item with type summary', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'hello' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Greeting exchange',
      data: {
        keyFacts: ['User name is Ivo'],
        openThreads: ['Deployment pending'],
        summary: 'Brief greeting',
      },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    const insertCalls = (deps.memoryRepo.insert as any).mock.calls;
    expect(insertCalls.length).toBeGreaterThanOrEqual(1);

    const summaryInsert = insertCalls[0][0];
    expect(summaryInsert.thread_id).toBe('thread-1');
    expect(summaryInsert.type).toBe('summary');
    expect(summaryInsert.content).toContain('Brief greeting');
    // No memoryUpdates present — keyFacts fall back into the summary blob
    expect(summaryInsert.content).toContain('User name is Ivo');
    expect(summaryInsert.content).toContain('Deployment pending');
  });

  it('does not clear session if summarizer fails', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'hello' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(
      err(new Error('API rate limit')),
    );

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.sessionTracker.rotateSession).not.toHaveBeenCalled();
  });

  it('handles empty message history gracefully', async () => {
    const deps = makeDeps();
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(mockSummarizerRun).not.toHaveBeenCalled();
    expect(deps.sessionTracker.rotateSession).not.toHaveBeenCalled();
  });

  it('does not clear session if memory insert fails', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'hello' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Summary',
      data: { keyFacts: [], openThreads: [], summary: 'Summary' },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
      memoryRepo: {
        insert: vi.fn().mockReturnValue(err(new Error('DB full'))),
        findById: vi.fn().mockReturnValue(ok(null)),
        upsertByKey: vi.fn().mockReturnValue(ok({})),
        delete: vi.fn().mockReturnValue(ok(undefined)),
        runInTransaction: vi.fn().mockImplementation((fn: () => unknown) => {
          try { return ok(fn()); } catch (e) { return err(e); }
        }),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.sessionTracker.rotateSession).not.toHaveBeenCalled();
  });

  it('handles non-JSON message content gracefully', async () => {
    const messages = [
      { direction: 'inbound', content: 'plain text message', created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Summary',
      data: { keyFacts: [], openThreads: [], summary: 'Summary' },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    // Should have called summarizer with the plain text content
    // New signature: summarizerRun(threadId, personaId, input)
    const callArgs = mockSummarizerRun.mock.calls[0][2];
    // Transcript uses bracketed turn-number format so downstream LLMs do
    // not mistake transcript lines for live prompt turns.
    expect(callArgs.transcript).toContain('user]: plain text message');
  });

  // ---------------------------------------------------------------------------
  // Threshold boundary conditions
  // ---------------------------------------------------------------------------

  it('does nothing when ratio is exactly zero', async () => {
    const deps = makeDeps();
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0,
      inputTokens: 0,
      rawMetric: 0,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.messageRepo.findLatestByThread).not.toHaveBeenCalled();
    expect(mockSummarizerRun).not.toHaveBeenCalled();
    expect(deps.sessionTracker.rotateSession).not.toHaveBeenCalled();
  });

  it('does nothing when ratio is just below threshold (0.399 vs 0.4)', async () => {
    const deps = makeDeps(); // thresholdRatio: 0.4
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.399,
      inputTokens: 79_800,
      rawMetric: 79_800,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.messageRepo.findLatestByThread).not.toHaveBeenCalled();
    expect(mockSummarizerRun).not.toHaveBeenCalled();
    expect(deps.sessionTracker.rotateSession).not.toHaveBeenCalled();
  });

  it('triggers rotation when ratio is exactly at threshold (0.4 === 0.4)', async () => {
    // The guard is `ratio < thresholdRatio`, so equal means it DOES trigger.
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'at threshold' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'At-threshold summary',
      data: { keyFacts: [], openThreads: [], summary: 'At-threshold summary' },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.4,
      inputTokens: 80_000,
      rawMetric: 80_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.messageRepo.findLatestByThread).toHaveBeenCalled();
    expect(mockSummarizerRun).toHaveBeenCalled();
    expect(deps.sessionTracker.rotateSession).toHaveBeenCalledWith('thread-1');
  });

  it('triggers rotation when ratio is 1.0 (fully exhausted context)', async () => {
    const messages = [
      { direction: 'outbound', content: JSON.stringify({ body: 'big response' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Exhausted context summary',
      data: { keyFacts: ['context full'], openThreads: [], summary: 'Exhausted context summary' },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 1.0,
      inputTokens: 200_000,
      rawMetric: 200_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.sessionTracker.rotateSession).toHaveBeenCalledWith('thread-1');
  });

  // ---------------------------------------------------------------------------
  // contextUsage edge cases
  // ---------------------------------------------------------------------------

  it('skips cacheReadTokens metadata when rawMetricName is not cache_read_input_tokens', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'test' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Summary',
      data: { keyFacts: [], openThreads: [], summary: 'Summary' },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'total_tokens', // not cache_read_input_tokens
    });

    const insertCall = (deps.memoryRepo.insert as any).mock.calls[0][0];
    const meta = JSON.parse(insertCall.metadata);
    expect(meta).not.toHaveProperty('cacheReadTokens');
    expect(meta.contextUsage.rawMetricName).toBe('total_tokens');
  });

  it('includes cacheReadTokens in metadata when rawMetricName is cache_read_input_tokens', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'test' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Summary',
      data: { keyFacts: [], openThreads: [], summary: 'Summary' },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 75_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    const insertCall = (deps.memoryRepo.insert as any).mock.calls[0][0];
    const meta = JSON.parse(insertCall.metadata);
    expect(meta.cacheReadTokens).toBe(75_000);
  });

  it('falls back to summary.summary when data.summary is absent', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'test' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      // data is present but has no summary field
      summary: 'Top-level fallback summary',
      data: { keyFacts: ['fact one'], openThreads: ['thread one'] },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    const insertCall = (deps.memoryRepo.insert as any).mock.calls[0][0];
    expect(insertCall.content).toContain('Top-level fallback summary');
    // No memoryUpdates present — keyFacts should fall back into the summary blob
    expect(insertCall.content).toContain('fact one');
    expect(insertCall.content).toContain('thread one');
  });

  it('falls back gracefully when data is undefined on the summary result', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'test' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Bare summary',
      // data is intentionally absent
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    const insertCall = (deps.memoryRepo.insert as any).mock.calls[0][0];
    expect(insertCall.content).toContain('Bare summary');
    expect(deps.sessionTracker.rotateSession).toHaveBeenCalledWith('thread-1');
  });

  it('contextUsage with zero rawMetric still stores correct metadata', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'test' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Summary',
      data: { keyFacts: [], openThreads: [], summary: 'Summary' },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 0,           // zero rawMetric
      rawMetricName: 'cache_read_input_tokens',
    });

    const insertCall = (deps.memoryRepo.insert as any).mock.calls[0][0];
    const meta = JSON.parse(insertCall.metadata);
    // cacheReadTokens is included but is 0 — the branch fires regardless of value
    expect(meta.cacheReadTokens).toBe(0);
    expect(meta.source).toBe('context-roller');
  });

  // ---------------------------------------------------------------------------
  // messageRepo error path
  // ---------------------------------------------------------------------------

  it('does not rotate when messageRepo returns an error', async () => {
    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(err(new Error('DB read failed'))),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(mockSummarizerRun).not.toHaveBeenCalled();
    expect(deps.sessionTracker.rotateSession).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-1' }),
      expect.stringContaining('failed to read messages'),
    );
  });

  // ---------------------------------------------------------------------------
  // memoryUpdates distribution
  // ---------------------------------------------------------------------------

  it('distributes memoryUpdates to named keys via upsertByKey', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'test' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Summary with updates',
      data: {
        keyFacts: ['User prefers dark mode'],
        openThreads: [],
        memoryUpdates: [
          { key: 'work:preferences', value: '2026-03-22 — Prefers dark mode', mode: 'replace' },
          { key: 'work:people', value: '2026-03-22 — Met with Sarah about API design', mode: 'append' },
        ],
        summary: 'Brief session',
      },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    // Replace mode: upsertByKey called directly
    expect(deps.memoryRepo.upsertByKey).toHaveBeenCalledWith('thread-1', 'work:preferences', {
      type: 'note',
      content: '2026-03-22 — Prefers dark mode',
    });

    // Append mode: findById called first, then upsertByKey with appended content
    expect(deps.memoryRepo.findById).toHaveBeenCalledWith('thread-1', 'work:people');
    expect(deps.memoryRepo.upsertByKey).toHaveBeenCalledWith('thread-1', 'work:people', {
      type: 'note',
      content: '2026-03-22 — Met with Sarah about API design',
    });

    // Summary blob should still be inserted
    expect(deps.memoryRepo.insert).toHaveBeenCalled();
    expect(deps.sessionTracker.rotateSession).toHaveBeenCalledWith('thread-1');
  });

  it('appends to existing memory entry when mode is append', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'test' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Summary',
      data: {
        keyFacts: [],
        openThreads: [],
        memoryUpdates: [
          { key: 'work:people', value: '2026-03-22 — New fact about Sarah', mode: 'append' },
        ],
        summary: 'Summary',
      },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
      memoryRepo: {
        insert: vi.fn().mockReturnValue(ok({})),
        findById: vi.fn().mockReturnValue(ok({ content: 'Existing content about Sarah' })),
        upsertByKey: vi.fn().mockReturnValue(ok({})),
        delete: vi.fn().mockReturnValue(ok(undefined)),
        runInTransaction: vi.fn().mockImplementation((fn: () => unknown) => ok(fn())),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.memoryRepo.upsertByKey).toHaveBeenCalledWith('thread-1', 'work:people', {
      type: 'note',
      content: 'Existing content about Sarah\n2026-03-22 — New fact about Sarah',
    });
  });

  it('skips memoryUpdates with empty key or value', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'test' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Summary',
      data: {
        keyFacts: [],
        openThreads: [],
        memoryUpdates: [
          { key: '', value: 'orphan value', mode: 'replace' },
          { key: 'work:valid', value: '', mode: 'replace' },
        ],
        summary: 'Summary',
      },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.memoryRepo.upsertByKey).not.toHaveBeenCalled();
  });

  it('rolls back entire transaction when a memory update fails', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'test' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Summary',
      data: {
        keyFacts: ['Important fact that must not be lost'],
        openThreads: ['Open thread'],
        memoryUpdates: [
          { key: 'work:test', value: '2026-03-22 — Some update', mode: 'replace' },
        ],
        summary: 'Summary',
      },
    }));

    const mockUpsert = vi.fn().mockReturnValue(err(new Error('DB write failed')));
    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
      memoryRepo: {
        insert: vi.fn().mockReturnValue(ok({})),
        findById: vi.fn().mockReturnValue(ok(null)),
        upsertByKey: mockUpsert,
        delete: vi.fn().mockReturnValue(ok(undefined)),
        // Simulate transaction: execute callback, but if it throws, return err
        runInTransaction: vi.fn().mockImplementation((fn: () => unknown) => {
          try { return ok(fn()); } catch (e) { return err(e); }
        }),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    // Transaction should have been called
    expect(deps.memoryRepo.runInTransaction).toHaveBeenCalled();

    // Session should NOT be rotated — transaction failed
    expect(deps.sessionTracker.rotateSession).not.toHaveBeenCalled();
  });

  it('aborts rotation when findById fails in append mode', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'test' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Summary',
      data: {
        keyFacts: [],
        openThreads: [],
        memoryUpdates: [
          { key: 'work:test', value: '2026-03-22 — appended', mode: 'append' },
        ],
        summary: 'Summary',
      },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
      memoryRepo: {
        insert: vi.fn().mockReturnValue(ok({})),
        findById: vi.fn().mockReturnValue(err(new Error('DB read failed'))),
        upsertByKey: vi.fn().mockReturnValue(ok({})),
        delete: vi.fn().mockReturnValue(ok(undefined)),
        runInTransaction: vi.fn().mockImplementation((fn: () => unknown) => ok(fn())),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    // Session should NOT be rotated — can't safely append without reading existing
    expect(deps.sessionTracker.rotateSession).not.toHaveBeenCalled();

    // Transaction should NOT have been called — preparation aborted first
    expect(deps.memoryRepo.runInTransaction).not.toHaveBeenCalled();
  });

  it('always includes keyFacts in summary as safety net even when memoryUpdates succeed', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'test' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Summary',
      data: {
        keyFacts: ['Fact stored via named key'],
        openThreads: [],
        memoryUpdates: [
          { key: 'work:test', value: '2026-03-22 — Some update', mode: 'replace' },
        ],
        summary: 'Summary',
      },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    // keyFacts are always included in summary as a safety net
    const insertCall = (deps.memoryRepo.insert as any).mock.calls[0][0];
    expect(insertCall.content).toContain('Fact stored via named key');
    expect(insertCall.content).toContain('Key facts:');
  });

  it('aborts rotation when findById fails in append mode (prevents silent truncation)', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'test' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Summary',
      data: {
        keyFacts: [],
        openThreads: [],
        memoryUpdates: [
          { key: 'work:people', value: '2026-03-22 — New fact', mode: 'append' },
        ],
        summary: 'Summary',
      },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
      memoryRepo: {
        insert: vi.fn().mockReturnValue(ok({})),
        findById: vi.fn().mockReturnValue(err(new Error('DB read error'))),
        upsertByKey: vi.fn().mockReturnValue(ok({})),
        delete: vi.fn().mockReturnValue(ok(undefined)),
        runInTransaction: vi.fn().mockImplementation((fn: () => unknown) => ok(fn())),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    // Should log error about findById failure blocking rotation
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'work:people' }),
      expect.stringContaining('findById failed'),
    );

    // Should NOT attempt upsert — rotation aborted during preparation
    expect(deps.memoryRepo.upsertByKey).not.toHaveBeenCalled();

    // Session should NOT be rotated
    expect(deps.sessionTracker.rotateSession).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // buildTranscript: budget truncation
  // ---------------------------------------------------------------------------

  it('truncates transcript when messages exceed the character budget', async () => {
    // Create enough messages to overflow MAX_TRANSCRIPT_CHARS (100_000)
    // Each message body is ~1_000 chars; 120 messages = ~120_000 chars
    const longBody = 'x'.repeat(1_000);
    const messages = Array.from({ length: 120 }, (_, i) => ({
      direction: i % 2 === 0 ? 'inbound' : 'outbound',
      content: JSON.stringify({ body: longBody }),
      created_at: i * 1_000,
    }));

    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Truncated summary',
      data: { keyFacts: [], openThreads: [], summary: 'Truncated summary' },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 200_000,
      rawMetric: 200_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(mockSummarizerRun).toHaveBeenCalled();
    const transcript: string = mockSummarizerRun.mock.calls[0][2].transcript;
    expect(transcript.length).toBeLessThanOrEqual(100_000);
    // Rotation still completes
    expect(deps.sessionTracker.rotateSession).toHaveBeenCalledWith('thread-1');
  });

  // ---------------------------------------------------------------------------
  // Observational memory (checkAndRotateOM) — taskComplete gating
  // ---------------------------------------------------------------------------

  describe('checkAndRotateOM', () => {
    const makeOmDeps = (observerRun: ReturnType<typeof vi.fn>, overrides: Partial<ContextRollerDeps> = {}) => {
      const messages = [
        { direction: 'inbound', content: JSON.stringify({ body: 'work on X' }), created_at: 1000 },
        { direction: 'outbound', content: JSON.stringify({ body: 'done' }), created_at: 2000 },
      ];
      return makeDeps({
        messageRepo: {
          findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
        } as any,
        resolveSummarizerRun: vi.fn().mockImplementation((name: string) => {
          if (name === 'session-observer') return observerRun;
          return null;
        }),
        ...overrides,
      });
    };

    it('prepends recent direct-conversation context for schedule threads', async () => {
      const now = Date.UTC(2026, 4, 28, 12, 0, 0);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
      const observerRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'Observations recorded',
        data: {
          observations: [
            { date: '2026-04-19', time: '10:00', priority: 'high', text: 'captured context' },
          ],
          taskComplete: true,
          memoryUpdates: [],
        },
      }));
      const scheduleMessages = [
        { direction: 'outbound', content: JSON.stringify({ body: 'scheduled follow-up' }), created_at: now - 1_000 },
      ];
      const conversationMessages = [
        { direction: 'inbound', content: JSON.stringify({ body: 'please follow up tomorrow' }), created_at: now - (2 * 60 * 60 * 1000) },
        { direction: 'outbound', content: JSON.stringify({ body: 'I will remind you' }), created_at: now - (60 * 60 * 1000) },
      ];
      const findLatestByThread = vi.fn().mockImplementation((threadId: string, limit: number) => {
        if (threadId === 'thread-1') {
          expect(limit).toBe(10000);
          return ok(scheduleMessages);
        }
        if (threadId === 'conversation-thread') {
          expect(limit).toBe(500);
          return ok(conversationMessages);
        }
        return ok([]);
      });
      const deps = makeDeps({
        messageRepo: { findLatestByThread } as any,
        threadRepo: {
          findByExternalId: vi.fn().mockReturnValue(ok({
            id: 'conversation-thread',
            channel_id: 'channel-1',
            external_id: 'chat-42',
            metadata: '{}',
            created_at: 0,
            updated_at: 0,
          })),
        } as any,
        resolveSummarizerRun: vi.fn().mockImplementation((name: string) => {
          if (name === 'session-observer') return observerRun;
          return null;
        }),
      });
      const roller = new ContextRoller(deps);

      try {
        await roller.checkAndRotateOM(
          'thread-1',
          'persona-1',
          {
            ratio: 0.5,
            inputTokens: 100_000,
            rawMetric: 100_000,
            rawMetricName: 'cache_read_input_tokens',
          },
          undefined,
          'session-observer',
          'session-reflector',
          DEFAULT_MAX_OBSERVATION_CHARS,
          JSON.stringify({ kind: 'schedule', originExternalId: 'chat-42' }),
          'channel-1',
        );
      } finally {
        nowSpy.mockRestore();
      }

      const transcript = observerRun.mock.calls[0][2].transcript as string;
      expect(transcript).toContain('[Direct conversation context last 48h]');
      expect(transcript).toContain('[Schedule thread history]');
      expect(transcript).toContain('please follow up tomorrow');
      expect(transcript).toContain('scheduled follow-up');
      expect(transcript.indexOf('[Direct conversation context last 48h]')).toBeLessThan(
        transcript.indexOf('[Schedule thread history]'),
      );
    });

    it('keeps the transcript unchanged when a schedule thread has no matching conversation thread', async () => {
      const observerRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'Observations recorded',
        data: {
          observations: [
            { date: '2026-04-19', time: '10:00', priority: 'high', text: 'captured context' },
          ],
          taskComplete: true,
          memoryUpdates: [],
        },
      }));
      const deps = makeOmDeps(observerRun, {
        threadRepo: {
          findByExternalId: vi.fn().mockReturnValue(ok(null)),
        } as any,
      });
      const roller = new ContextRoller(deps);

      await roller.checkAndRotateOM(
        'thread-1',
        'persona-1',
        {
          ratio: 0.5,
          inputTokens: 100_000,
          rawMetric: 100_000,
          rawMetricName: 'cache_read_input_tokens',
        },
        undefined,
        'session-observer',
        'session-reflector',
        DEFAULT_MAX_OBSERVATION_CHARS,
        JSON.stringify({ kind: 'schedule', originExternalId: 'chat-42' }),
        'channel-1',
      );

      const transcript = observerRun.mock.calls[0][2].transcript as string;
      expect(transcript).toBe('[turn 1, user]: work on X\n[turn 2, assistant]: done');
    });

    it('excludes conversation-thread messages older than 48h', async () => {
      const now = Date.UTC(2026, 4, 28, 12, 0, 0);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
      const observerRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'Observations recorded',
        data: {
          observations: [
            { date: '2026-04-19', time: '10:00', priority: 'high', text: 'captured context' },
          ],
          taskComplete: true,
          memoryUpdates: [],
        },
      }));
      const findLatestByThread = vi.fn().mockImplementation((threadId: string) => {
        if (threadId === 'thread-1') {
          return ok([
            { direction: 'outbound', content: JSON.stringify({ body: 'scheduled follow-up' }), created_at: now - 1_000 },
          ]);
        }
        if (threadId === 'conversation-thread') {
          return ok([
            { direction: 'inbound', content: JSON.stringify({ body: 'old human context' }), created_at: now - (49 * 60 * 60 * 1000) },
            { direction: 'inbound', content: JSON.stringify({ body: 'recent human context' }), created_at: now - (2 * 60 * 60 * 1000) },
          ]);
        }
        return ok([]);
      });
      const deps = makeDeps({
        messageRepo: { findLatestByThread } as any,
        threadRepo: {
          findByExternalId: vi.fn().mockReturnValue(ok({
            id: 'conversation-thread',
            channel_id: 'channel-1',
            external_id: 'chat-42',
            metadata: '{}',
            created_at: 0,
            updated_at: 0,
          })),
        } as any,
        resolveSummarizerRun: vi.fn().mockImplementation((name: string) => {
          if (name === 'session-observer') return observerRun;
          return null;
        }),
      });
      const roller = new ContextRoller(deps);

      try {
        await roller.checkAndRotateOM(
          'thread-1',
          'persona-1',
          {
            ratio: 0.5,
            inputTokens: 100_000,
            rawMetric: 100_000,
            rawMetricName: 'cache_read_input_tokens',
          },
          undefined,
          'session-observer',
          'session-reflector',
          DEFAULT_MAX_OBSERVATION_CHARS,
          JSON.stringify({ kind: 'schedule', originExternalId: 'chat-42' }),
          'channel-1',
        );
      } finally {
        nowSpy.mockRestore();
      }

      const transcript = observerRun.mock.calls[0][2].transcript as string;
      expect(transcript).toContain('recent human context');
      expect(transcript).not.toContain('old human context');
    });

    it('keeps the transcript unchanged for non-schedule threads', async () => {
      const observerRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'Observations recorded',
        data: {
          observations: [
            { date: '2026-04-19', time: '10:00', priority: 'high', text: 'captured context' },
          ],
          taskComplete: true,
          memoryUpdates: [],
        },
      }));
      const deps = makeOmDeps(observerRun, {
        threadRepo: {
          findByExternalId: vi.fn(),
        } as any,
      });
      const roller = new ContextRoller(deps);

      await roller.checkAndRotateOM(
        'thread-1',
        'persona-1',
        {
          ratio: 0.5,
          inputTokens: 100_000,
          rawMetric: 100_000,
          rawMetricName: 'cache_read_input_tokens',
        },
        undefined,
        'session-observer',
        'session-reflector',
        DEFAULT_MAX_OBSERVATION_CHARS,
        JSON.stringify({ kind: 'conversation', originExternalId: 'chat-42' }),
        'channel-1',
      );

      const transcript = observerRun.mock.calls[0][2].transcript as string;
      expect(transcript).toBe('[turn 1, user]: work on X\n[turn 2, assistant]: done');
      expect((deps.threadRepo as any).findByExternalId).not.toHaveBeenCalled();
    });

    it('keeps the transcript unchanged when threadRepo is unavailable', async () => {
      const observerRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'Observations recorded',
        data: {
          observations: [
            { date: '2026-04-19', time: '10:00', priority: 'high', text: 'captured context' },
          ],
          taskComplete: true,
          memoryUpdates: [],
        },
      }));
      const deps = makeOmDeps(observerRun);
      const roller = new ContextRoller(deps);

      await roller.checkAndRotateOM(
        'thread-1',
        'persona-1',
        {
          ratio: 0.5,
          inputTokens: 100_000,
          rawMetric: 100_000,
          rawMetricName: 'cache_read_input_tokens',
        },
        undefined,
        'session-observer',
        'session-reflector',
        DEFAULT_MAX_OBSERVATION_CHARS,
        JSON.stringify({ kind: 'schedule', originExternalId: 'chat-42' }),
        'channel-1',
      );

      const transcript = observerRun.mock.calls[0][2].transcript as string;
      expect(transcript).toBe('[turn 1, user]: work on X\n[turn 2, assistant]: done');
    });

    it('returns hasOpenThreads=false when observer flags taskComplete=true', async () => {
      const observerRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'Observations recorded',
        data: {
          observations: [
            { date: '2026-04-19', time: '10:00', priority: 'high', text: 'task X completed' },
          ],
          taskComplete: true,
          currentTask: '',
          suggestedContinuation: '',
          memoryUpdates: [],
        },
      }));
      const deps = makeOmDeps(observerRun);
      const roller = new ContextRoller(deps);

      const result = await roller.checkAndRotateOM('thread-1', 'persona-1', {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 100_000,
        rawMetricName: 'cache_read_input_tokens',
      });

      expect(result.rotated).toBe(true);
      expect(result.hasOpenThreads).toBe(false);
      expect(deps.sessionTracker.rotateSession).toHaveBeenCalledWith('thread-1');
    });

    it('returns hasOpenThreads=true only when taskComplete=false AND suggestedContinuation is non-empty', async () => {
      const observerRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'Observations recorded',
        data: {
          observations: [
            { date: '2026-04-19', time: '10:00', priority: 'high', text: 'started X' },
          ],
          taskComplete: false,
          currentTask: 'implementing X',
          suggestedContinuation: 'finish step 3 of X',
          memoryUpdates: [],
        },
      }));
      const deps = makeOmDeps(observerRun);
      const roller = new ContextRoller(deps);

      const result = await roller.checkAndRotateOM('thread-1', 'persona-1', {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 100_000,
        rawMetricName: 'cache_read_input_tokens',
      });

      expect(result.hasOpenThreads).toBe(true);
    });

    it('returns hasOpenThreads=false when taskComplete=false but suggestedContinuation is blank', async () => {
      const observerRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'Observations recorded',
        data: {
          observations: [
            { date: '2026-04-19', time: '10:00', priority: 'high', text: 'partial work' },
          ],
          taskComplete: false,
          currentTask: 'something',
          suggestedContinuation: '   ',
          memoryUpdates: [],
        },
      }));
      const deps = makeOmDeps(observerRun);
      const roller = new ContextRoller(deps);

      const result = await roller.checkAndRotateOM('thread-1', 'persona-1', {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 100_000,
        rawMetricName: 'cache_read_input_tokens',
      });

      expect(result.hasOpenThreads).toBe(false);
    });

    it('defaults to hasOpenThreads=false when observer omits taskComplete (safe default)', async () => {
      const observerRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'Observations recorded',
        data: {
          observations: [
            { date: '2026-04-19', time: '10:00', priority: 'high', text: 'work happened' },
          ],
          currentTask: 'something',
          suggestedContinuation: 'do next step',
          memoryUpdates: [],
        },
      }));
      const deps = makeOmDeps(observerRun);
      const roller = new ContextRoller(deps);

      const result = await roller.checkAndRotateOM('thread-1', 'persona-1', {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 100_000,
        rawMetricName: 'cache_read_input_tokens',
      });

      expect(result.hasOpenThreads).toBe(false);
    });

    it('does not persist currentTask/suggestedContinuation in observation metadata when taskComplete=true', async () => {
      const observerRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'Observations recorded',
        data: {
          observations: [
            { date: '2026-04-19', time: '10:00', priority: 'high', text: 'task X completed' },
          ],
          taskComplete: true,
          // Observer erroneously includes hints despite taskComplete=true.
          currentTask: 'leftover hint',
          suggestedContinuation: 'leftover next step',
          memoryUpdates: [],
        },
      }));
      const deps = makeOmDeps(observerRun);
      const roller = new ContextRoller(deps);

      await roller.checkAndRotateOM('thread-1', 'persona-1', {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 100_000,
        rawMetricName: 'cache_read_input_tokens',
      });

      const insertCall = (deps.memoryRepo.insert as any).mock.calls[0][0];
      const meta = JSON.parse(insertCall.metadata);
      expect(meta).not.toHaveProperty('currentTask');
      expect(meta).not.toHaveProperty('suggestedContinuation');
      // taskComplete itself is durably stored on every observation
      // (issue #197), so downstream consumers can reason about completion
      // state without re-running the observer.
      expect(meta.taskComplete).toBe(true);
    });

    it('durably persists taskComplete=false when observer flags incomplete work', async () => {
      const observerRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'Observations recorded',
        data: {
          observations: [
            { date: '2026-04-19', time: '10:00', priority: 'high', text: 'started X' },
          ],
          taskComplete: false,
          currentTask: 'implementing X',
          suggestedContinuation: 'finish step 3 of X',
          memoryUpdates: [],
        },
      }));
      const deps = makeOmDeps(observerRun);
      const roller = new ContextRoller(deps);

      await roller.checkAndRotateOM('thread-1', 'persona-1', {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 100_000,
        rawMetricName: 'cache_read_input_tokens',
      });

      const insertCall = (deps.memoryRepo.insert as any).mock.calls[0][0];
      const meta = JSON.parse(insertCall.metadata);
      expect(meta.taskComplete).toBe(false);
    });

    it('reflector carries forward taskComplete onto the consolidated observation', async () => {
      // Build a reflection-triggering scenario by seeding observations
      // whose combined content exceeds MAX_OBSERVATION_CHARS (40K). The
      // newest observation was flagged as incomplete; the consolidated row
      // must inherit that flag so ContextAssembler keeps surfacing hints
      // post-reflection.
      const fat = 'x'.repeat(25_000);
      const observations = [
        {
          id: 'obs-new',
          type: 'observation',
          content: fat,
          created_at: 9000,
          metadata: JSON.stringify({
            source: 'context-roller-om',
            taskComplete: false,
            currentTask: 'work in progress',
            suggestedContinuation: 'continue step 4',
            rotatedThroughTs: 8500,
          }),
        },
        {
          id: 'obs-old',
          type: 'observation',
          content: fat,
          created_at: 5000,
          metadata: JSON.stringify({
            source: 'context-roller-om',
            taskComplete: true,
            rotatedThroughTs: 4500,
          }),
        },
      ];

      const observerRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'noop',
        data: {
          observations: [
            { date: '2026-04-19', time: '12:00', priority: 'low', text: 'tick' },
          ],
          taskComplete: true,
          currentTask: '',
          suggestedContinuation: '',
          memoryUpdates: [],
        },
      }));
      const reflectorRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'Consolidated',
        data: { consolidatedLog: 'Date: 2026-04-19\n- 🔴 12:00 consolidated' },
      }));

      const insertedRecords: Array<{ metadata: string }> = [];
      const messages = [{ direction: 'inbound', content: JSON.stringify({ body: 'hi' }), created_at: 1_000 }];
      const deps = makeDeps({
        messageRepo: {
          findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok(messages)),
        } as any,
        resolveSummarizerRun: vi.fn().mockImplementation((name: string) => {
          if (name === 'session-observer') return observerRun;
          if (name === 'session-reflector') return reflectorRun;
          return null;
        }),
        memoryRepo: {
          insert: vi.fn().mockImplementation((row: any) => {
            insertedRecords.push({ metadata: row.metadata });
            return ok(row);
          }),
          findById: vi.fn().mockReturnValue(ok(null)),
          findByThread: vi.fn().mockImplementation((_tid: string, type?: string) => {
            if (type === 'observation') return ok(observations);
            return ok([]);
          }),
          upsertByKey: vi.fn().mockReturnValue(ok({})),
          delete: vi.fn().mockReturnValue(ok(undefined)),
          runInTransaction: vi.fn().mockImplementation((fn: () => unknown) => ok(fn())),
        } as any,
      });
      const roller = new ContextRoller(deps);

      await roller.checkAndRotateOM('thread-1', 'persona-1', {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 100_000,
        rawMetricName: 'cache_read_input_tokens',
      });

      const consolidated = insertedRecords
        .map((r) => JSON.parse(r.metadata))
        .find((m) => m.source === 'context-roller-om-reflector');
      expect(consolidated).toBeDefined();
      // Inherits the newest observation's incomplete flag.
      expect(consolidated.taskComplete).toBe(false);
      expect(consolidated.currentTask).toBe('work in progress');
      expect(consolidated.suggestedContinuation).toBe('continue step 4');
    });

    it('persists the transcript-snapshot timestamp as metadata.rotatedThroughTs', async () => {
      const messages = [
        { direction: 'inbound', content: JSON.stringify({ body: 'start' }), created_at: 1000 },
        { direction: 'outbound', content: JSON.stringify({ body: 'reply' }), created_at: 2000 },
        { direction: 'inbound', content: JSON.stringify({ body: 'follow-up' }), created_at: 3500 },
      ];
      const observerRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'Observations recorded',
        data: {
          observations: [
            { date: '2026-04-19', time: '10:00', priority: 'low', text: 'greeting' },
          ],
          taskComplete: true,
          currentTask: '',
          suggestedContinuation: '',
          memoryUpdates: [],
        },
      }));
      const deps = makeDeps({
        messageRepo: {
          findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
        } as any,
        resolveSummarizerRun: vi.fn().mockImplementation((name: string) => {
          if (name === 'session-observer') return observerRun;
          return null;
        }),
      });
      const roller = new ContextRoller(deps);

      await roller.checkAndRotateOM('thread-1', 'persona-1', {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 100_000,
        rawMetricName: 'cache_read_input_tokens',
      });

      const insertCall = (deps.memoryRepo.insert as any).mock.calls[0][0];
      const meta = JSON.parse(insertCall.metadata);
      // Snapshot timestamp is the newest message's created_at (3500),
      // NOT the observation's own write time (which happens later).
      expect(meta.rotatedThroughTs).toBe(3500);
    });

    it('reflector consolidation carries rotatedThroughTs and hints forward', async () => {
      // Two pre-existing observations, the newer one carries an incomplete
      // task with a suggested continuation. maybeReflect should consolidate
      // them and preserve: (a) the max rotatedThroughTs, (b) the newest's
      // currentTask/suggestedContinuation.
      const newerMeta = JSON.stringify({
        source: 'context-roller-om',
        rotatedThroughTs: 9500,
        currentTask: 'implementing X',
        suggestedContinuation: 'finish step 3',
      });
      const olderMeta = JSON.stringify({
        source: 'context-roller-om',
        rotatedThroughTs: 4500,
      });
      const longContent = 'x'.repeat(25_000);
      const observations = [
        {
          id: 'obs-new',
          type: 'observation',
          content: longContent,
          created_at: 10_000,
          metadata: newerMeta,
        },
        {
          id: 'obs-old',
          type: 'observation',
          content: longContent,
          created_at: 5_000,
          metadata: olderMeta,
        },
      ];

      const messages = [
        { direction: 'inbound', content: JSON.stringify({ body: 'hi' }), created_at: 1_000 },
      ];

      const reflectorRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'Consolidated',
        data: { consolidatedLog: 'Date: 2026-04-19\n- 🔴 10:00 consolidated line' },
      }));
      const observerRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'noop',
        data: {
          observations: [{ date: '2026-04-19', time: '11:00', priority: 'low', text: 'tick' }],
          taskComplete: true,
          currentTask: '',
          suggestedContinuation: '',
          memoryUpdates: [],
        },
      }));

      const insertedRecords: Array<{ id: string; metadata: string; type: string }> = [];
      const deps = makeDeps({
        messageRepo: {
          findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok(messages)),
        } as any,
        resolveSummarizerRun: vi.fn().mockImplementation((name: string) => {
          if (name === 'session-observer') return observerRun;
          if (name === 'session-reflector') return reflectorRun;
          return null;
        }),
        memoryRepo: {
          insert: vi.fn().mockImplementation((row: any) => {
            insertedRecords.push({ id: row.id, metadata: row.metadata, type: row.type });
            return ok(row);
          }),
          findById: vi.fn().mockReturnValue(ok(null)),
          findByThread: vi.fn().mockImplementation((_tid: string, type?: string) => {
            if (type === 'observation') return ok(observations);
            return ok([]);
          }),
          upsertByKey: vi.fn().mockReturnValue(ok({})),
          delete: vi.fn().mockReturnValue(ok(undefined)),
          runInTransaction: vi.fn().mockImplementation((fn: () => unknown) => ok(fn())),
        } as any,
      });
      const roller = new ContextRoller(deps);

      await roller.checkAndRotateOM('thread-1', 'persona-1', {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 100_000,
        rawMetricName: 'cache_read_input_tokens',
      });

      // Find the consolidated insert (the one with source=context-roller-om-reflector).
      const consolidated = insertedRecords
        .map((r) => ({ ...r, meta: JSON.parse(r.metadata) }))
        .find((r) => r.meta.source === 'context-roller-om-reflector');
      expect(consolidated).toBeDefined();
      expect(consolidated!.meta.rotatedThroughTs).toBe(9500);
      expect(consolidated!.meta.currentTask).toBe('implementing X');
      expect(consolidated!.meta.suggestedContinuation).toBe('finish step 3');
    });

    it('honors configurable reflectionThresholdChars when accumulated observations are short', async () => {
      // Two 5K-char observations total 10K chars + separator — under the 40K
      // default, so the reflector would not fire with defaults. With a 5K
      // override the threshold is crossed, so the reflector MUST run.
      const shortContent = 'x'.repeat(5_000);
      const observations = [
        {
          id: 'obs-1',
          type: 'observation',
          content: shortContent,
          created_at: 2_000,
          metadata: JSON.stringify({ source: 'context-roller-om', rotatedThroughTs: 1_500 }),
        },
        {
          id: 'obs-2',
          type: 'observation',
          content: shortContent,
          created_at: 1_000,
          metadata: JSON.stringify({ source: 'context-roller-om', rotatedThroughTs: 500 }),
        },
      ];

      const messages = [
        { direction: 'inbound', content: JSON.stringify({ body: 'hi' }), created_at: 1_000 },
      ];

      const reflectorRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'Consolidated',
        data: { consolidatedLog: 'Date: 2026-04-19\n- 🔴 10:00 consolidated' },
      }));
      const observerRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'noop',
        data: {
          observations: [{ date: '2026-04-19', time: '11:00', priority: 'low', text: 'tick' }],
          taskComplete: true,
          memoryUpdates: [],
        },
      }));

      const deps = makeDeps({
        messageRepo: {
          findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok(messages)),
        } as any,
        resolveSummarizerRun: vi.fn().mockImplementation((name: string) => {
          if (name === 'session-observer') return observerRun;
          if (name === 'session-reflector') return reflectorRun;
          return null;
        }),
        memoryRepo: {
          insert: vi.fn().mockReturnValue(ok({})),
          findById: vi.fn().mockReturnValue(ok(null)),
          findByThread: vi.fn().mockImplementation((_tid: string, type?: string) => {
            if (type === 'observation') return ok(observations);
            return ok([]);
          }),
          upsertByKey: vi.fn().mockReturnValue(ok({})),
          delete: vi.fn().mockReturnValue(ok(undefined)),
          runInTransaction: vi.fn().mockImplementation((fn: () => unknown) => ok(fn())),
        } as any,
      });
      const roller = new ContextRoller(deps);

      // First: default threshold (40K) — observations only total ~10K, so
      // reflector must NOT fire.
      await roller.checkAndRotateOM('thread-1', 'persona-1', {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 100_000,
        rawMetricName: 'cache_read_input_tokens',
      });
      expect(reflectorRun).not.toHaveBeenCalled();

      // Now lower the threshold to 5K — the same observations exceed it,
      // so the reflector MUST fire.
      const observerRun2 = vi.fn().mockResolvedValueOnce(ok({
        summary: 'noop',
        data: {
          observations: [{ date: '2026-04-19', time: '11:00', priority: 'low', text: 'tick' }],
          taskComplete: true,
          memoryUpdates: [],
        },
      }));
      (deps.resolveSummarizerRun as any).mockImplementation((name: string) => {
        if (name === 'session-observer') return observerRun2;
        if (name === 'session-reflector') return reflectorRun;
        return null;
      });

      await roller.checkAndRotateOM(
        'thread-1',
        'persona-1',
        {
          ratio: 0.5,
          inputTokens: 100_000,
          rawMetric: 100_000,
          rawMetricName: 'cache_read_input_tokens',
        },
        undefined,
        'session-observer',
        'session-reflector',
        5_000,
      );
      expect(reflectorRun).toHaveBeenCalledTimes(1);
    });

    it('persists currentTask/suggestedContinuation when taskComplete=false', async () => {
      const observerRun = vi.fn().mockResolvedValueOnce(ok({
        summary: 'Observations recorded',
        data: {
          observations: [
            { date: '2026-04-19', time: '10:00', priority: 'high', text: 'started X' },
          ],
          taskComplete: false,
          currentTask: 'implementing X',
          suggestedContinuation: 'finish step 3 of X',
          memoryUpdates: [],
        },
      }));
      const deps = makeOmDeps(observerRun);
      const roller = new ContextRoller(deps);

      await roller.checkAndRotateOM('thread-1', 'persona-1', {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 100_000,
        rawMetricName: 'cache_read_input_tokens',
      });

      const insertCall = (deps.memoryRepo.insert as any).mock.calls[0][0];
      const meta = JSON.parse(insertCall.metadata);
      expect(meta.currentTask).toBe('implementing X');
      expect(meta.suggestedContinuation).toBe('finish step 3 of X');
    });
  });

  describe('incremental transcript (no re-observation of already-observed messages)', () => {
    const highUsage = { ratio: 0.9, inputTokens: 90_000, rawMetric: 90_000, rawMetricName: 'cache_read_input_tokens' };

    const makeMsg = (id: string, ts: number, direction: 'inbound' | 'outbound' = 'outbound') => ({
      id, thread_id: 'thread-1', direction, content: JSON.stringify({ body: `msg ${id}` }),
      created_at: ts, updated_at: ts, channel_id: 'ch-1', persona_id: 'p-1',
      metadata: '{}', message_type: 'text', external_id: null,
    });

    const makeObservation = (rotatedThroughTs: number) => ({
      id: 'obs-1', thread_id: 'thread-1', type: 'observation' as const,
      content: 'Date: 2026-05-28\n- 🔴 09:00 some observation',
      metadata: JSON.stringify({ rotatedThroughTs }),
      created_at: rotatedThroughTs + 1000, updated_at: rotatedThroughTs + 1000,
      embedding_ref: null,
    });

    it('checkAndRotate: uses findLatestByThread on first roll (no prior summary)', async () => {
      const msgs = [makeMsg('m1', 1000), makeMsg('m2', 2000)];
      const deps = makeDeps({
        messageRepo: {
          findLatestByThread: vi.fn().mockReturnValue(ok(msgs)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
        } as any,
        memoryRepo: {
          insert: vi.fn().mockReturnValue(ok({})),
          findById: vi.fn().mockReturnValue(ok(null)),
          findByThread: vi.fn().mockReturnValue(ok([])), // no prior summary
          upsertByKey: vi.fn().mockReturnValue(ok({})),
          delete: vi.fn().mockReturnValue(ok(undefined)),
          runInTransaction: vi.fn().mockImplementation((fn: () => unknown) => ok(fn())),
        } as any,
      });
      deps.summarizerRun = vi.fn().mockResolvedValue(ok({ data: { summary: 'S' }, usage: null }));

      await (new ContextRoller(deps)).checkAndRotate('thread-1', 'persona-1', highUsage);

      expect(deps.messageRepo.findLatestByThread).toHaveBeenCalledWith('thread-1', 10_000);
      expect(deps.messageRepo.findLatestByThreadSince).not.toHaveBeenCalled();
    });

    it('checkAndRotateOM: uses findLatestByThread on first roll (no prior observations)', async () => {
      const msgs = [makeMsg('m1', 1000), makeMsg('m2', 2000)];
      const mockObserverRun = vi.fn().mockResolvedValue(ok({
        data: { observations: [{ date: '2026-05-29', time: '09:00', priority: 'low', text: 'x' }], taskComplete: true, currentTask: '', suggestedContinuation: '', memoryUpdates: [] },
        usage: null,
      }));
      const deps = makeDeps({
        messageRepo: {
          findLatestByThread: vi.fn().mockReturnValue(ok(msgs)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
        } as any,
        memoryRepo: {
          insert: vi.fn().mockReturnValue(ok({})),
          findById: vi.fn().mockReturnValue(ok(null)),
          findByThread: vi.fn().mockReturnValue(ok([])), // no prior observations
          upsertByKey: vi.fn().mockReturnValue(ok({})),
          delete: vi.fn().mockReturnValue(ok(undefined)),
          runInTransaction: vi.fn().mockImplementation((fn: () => unknown) => ok(fn())),
        } as any,
        resolveSummarizerRun: () => mockObserverRun,
      });

      await (new ContextRoller(deps)).checkAndRotateOM('thread-1', 'persona-1', highUsage);

      expect(deps.messageRepo.findLatestByThread).toHaveBeenCalledWith('thread-1', 10_000);
      expect(deps.messageRepo.findLatestByThreadSince).not.toHaveBeenCalled();
    });

    it('checkAndRotateOM: uses findLatestByThreadSince on subsequent roll with prior observation', async () => {
      const prevTs = 5000;
      const newMsgs = [makeMsg('m3', 6000), makeMsg('m4', 7000)];
      const mockObserverRun = vi.fn().mockResolvedValue(ok({
        data: { observations: [{ date: '2026-05-29', time: '09:00', priority: 'low', text: 'x' }], taskComplete: true, currentTask: '', suggestedContinuation: '', memoryUpdates: [] },
        usage: null,
      }));
      const deps = makeDeps({
        messageRepo: {
          findLatestByThread: vi.fn().mockReturnValue(ok([])),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
        } as any,
        memoryRepo: {
          insert: vi.fn().mockReturnValue(ok({})),
          findById: vi.fn().mockReturnValue(ok(null)),
          findByThread: vi.fn().mockReturnValue(ok([makeObservation(prevTs)])),
          upsertByKey: vi.fn().mockReturnValue(ok({})),
          delete: vi.fn().mockReturnValue(ok(undefined)),
          runInTransaction: vi.fn().mockImplementation((fn: () => unknown) => ok(fn())),
        } as any,
        resolveSummarizerRun: () => mockObserverRun,
      });

      await (new ContextRoller(deps)).checkAndRotateOM('thread-1', 'persona-1', highUsage);

      expect(deps.messageRepo.findLatestByThread).not.toHaveBeenCalled();
      expect(deps.messageRepo.findLatestByThreadSince).toHaveBeenCalledWith('thread-1', prevTs, 10_000);
    });

    it('checkAndRotateOM: falls back to findLatestByThread when prior observation metadata is malformed', async () => {
      const msgs = [makeMsg('m1', 1000), makeMsg('m2', 2000)];
      const badObservation = { ...makeObservation(5000), metadata: 'not-json' };
      const mockObserverRun = vi.fn().mockResolvedValue(ok({
        data: { observations: [{ date: '2026-05-29', time: '09:00', priority: 'low', text: 'x' }], taskComplete: true, currentTask: '', suggestedContinuation: '', memoryUpdates: [] },
        usage: null,
      }));
      const deps = makeDeps({
        messageRepo: {
          findLatestByThread: vi.fn().mockReturnValue(ok(msgs)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
        } as any,
        memoryRepo: {
          insert: vi.fn().mockReturnValue(ok({})),
          findById: vi.fn().mockReturnValue(ok(null)),
          findByThread: vi.fn().mockReturnValue(ok([badObservation])),
          upsertByKey: vi.fn().mockReturnValue(ok({})),
          delete: vi.fn().mockReturnValue(ok(undefined)),
          runInTransaction: vi.fn().mockImplementation((fn: () => unknown) => ok(fn())),
        } as any,
        resolveSummarizerRun: () => mockObserverRun,
      });

      await (new ContextRoller(deps)).checkAndRotateOM('thread-1', 'persona-1', highUsage);

      expect(deps.messageRepo.findLatestByThread).toHaveBeenCalledWith('thread-1', 10_000);
      expect(deps.messageRepo.findLatestByThreadSince).not.toHaveBeenCalled();
    });

    it('checkAndRotateOM: falls back to findLatestByThread when memoryRepo.findByThread errors', async () => {
      const msgs = [makeMsg('m1', 1000)];
      const mockObserverRun = vi.fn().mockResolvedValue(ok({
        data: { observations: [{ date: '2026-05-29', time: '09:00', priority: 'low', text: 'x' }], taskComplete: true, currentTask: '', suggestedContinuation: '', memoryUpdates: [] },
        usage: null,
      }));
      const deps = makeDeps({
        messageRepo: {
          findLatestByThread: vi.fn().mockReturnValue(ok(msgs)),
          findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
        } as any,
        memoryRepo: {
          insert: vi.fn().mockReturnValue(ok({})),
          findById: vi.fn().mockReturnValue(ok(null)),
          findByThread: vi.fn().mockReturnValue(err({ message: 'db error' })),
          upsertByKey: vi.fn().mockReturnValue(ok({})),
          delete: vi.fn().mockReturnValue(ok(undefined)),
          runInTransaction: vi.fn().mockImplementation((fn: () => unknown) => ok(fn())),
        } as any,
        resolveSummarizerRun: () => mockObserverRun,
      });

      await (new ContextRoller(deps)).checkAndRotateOM('thread-1', 'persona-1', highUsage);

      expect(deps.messageRepo.findLatestByThread).toHaveBeenCalledWith('thread-1', 10_000);
      expect(deps.messageRepo.findLatestByThreadSince).not.toHaveBeenCalled();
    });
  });
});
