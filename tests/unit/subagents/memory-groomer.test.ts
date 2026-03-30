import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from 'neverthrow';
import { DbError } from '../../../src/core/errors/index.js';
import type { MemoryItemRow } from '../../../src/core/database/repositories/memory-repository.js';

const generateObjectMock = vi.fn();

vi.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));

import { run } from '../../../src/subagents/default/memory-groomer/index.js';

const makeMemoryItem = (overrides: Partial<MemoryItemRow> = {}): MemoryItemRow => ({
  id: 'mem-1',
  thread_id: 'thread-1',
  type: 'fact',
  content: 'User prefers dark mode',
  embedding_ref: null,
  metadata: '{}',
  created_at: 1700000000000,
  updated_at: 1700000000000,
  ...overrides,
});

const makeCtx = (memoryOverrides: Record<string, unknown> = {}) => ({
  threadId: 'thread-1',
  personaId: 'persona-1',
  systemPrompt: 'You are a memory grooming agent.',
  model: {} as any,
  maxOutputTokens: 8192,
  rootPaths: [],
  services: {
    memory: {
      findByThread: vi.fn().mockReturnValue(ok([])),
      delete: vi.fn().mockReturnValue(ok(undefined)),
      insert: vi.fn().mockReturnValue(ok(makeMemoryItem())),
      ...memoryOverrides,
    } as any,
    schedules: {} as any,
    personas: {} as any,
    channels: {} as any,
    threads: {} as any,
    messages: {} as any,
    runs: {} as any,
    queue: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  },
});

describe('memory-groomer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early with success when no memories exist', async () => {
    const ctx = makeCtx();
    const result = await run(ctx, {});

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.summary).toContain('No memory items');
    expect(value.data).toEqual({ pruned: 0, consolidated: 0, kept: 0 });
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it('returns error when memory read fails', async () => {
    const ctx = makeCtx({
      findByThread: vi.fn().mockReturnValue(err(new DbError('DB connection lost'))),
    });
    const result = await run(ctx, {});

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Failed to read memory items');
  });

  it('handles model returning no actions', async () => {
    const items = [makeMemoryItem()];
    const ctx = makeCtx({
      findByThread: vi.fn().mockReturnValue(ok(items)),
    });

    generateObjectMock.mockResolvedValueOnce({
      object: { actions: [] },
      usage: { inputTokens: 200, outputTokens: 50 },
    });

    const result = await run(ctx, {});
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.summary).toContain('No changes recommended');
    expect(value.data).toEqual({ pruned: 0, consolidated: 0, kept: 0 });
  });

  it('executes prune and consolidate actions correctly', async () => {
    const items = [
      makeMemoryItem({ id: 'mem-1', content: 'User likes dark mode' }),
      makeMemoryItem({ id: 'mem-2', content: 'User prefers dark theme' }),
      makeMemoryItem({ id: 'mem-3', content: 'Old stale fact about a removed feature' }),
    ];

    const ctx = makeCtx({
      findByThread: vi.fn().mockReturnValue(ok(items)),
    });

    generateObjectMock.mockResolvedValueOnce({
      object: {
        actions: [
          {
            type: 'consolidate',
            ids: ['mem-1', 'mem-2'],
            reason: 'Both entries describe the same dark mode preference',
            mergedContent: 'User prefers dark mode/dark theme for the UI',
          },
          {
            type: 'prune',
            ids: ['mem-3'],
            reason: 'Feature no longer exists',
          },
        ],
      },
      usage: { inputTokens: 400, outputTokens: 150 },
    });

    const result = await run(ctx, {});
    expect(result.isOk()).toBe(true);

    const value = result._unsafeUnwrap();
    expect(value.data!.pruned).toBe(1);
    expect(value.data!.consolidated).toBe(1);

    // Verify insert was called BEFORE deletes for consolidation (insert-first safety).
    expect(ctx.services.memory.insert).toHaveBeenCalledTimes(1);
    const insertArg = ctx.services.memory.insert.mock.calls[0][0];
    expect(insertArg.content).toBe('User prefers dark mode/dark theme for the UI');
    expect(insertArg.thread_id).toBe('thread-1');
    expect(insertArg.type).toBe('fact');

    // Verify delete was called for consolidate (mem-1, mem-2) + prune (mem-3) = 3 deletes
    expect(ctx.services.memory.delete).toHaveBeenCalledTimes(3);
    expect(ctx.services.memory.delete).toHaveBeenCalledWith('thread-1', 'mem-1');
    expect(ctx.services.memory.delete).toHaveBeenCalledWith('thread-1', 'mem-2');
    expect(ctx.services.memory.delete).toHaveBeenCalledWith('thread-1', 'mem-3');

    // Verify insert happened before any consolidation deletes (insert-first pattern).
    const insertOrder = ctx.services.memory.insert.mock.invocationCallOrder[0];
    const firstConsolidateDeleteOrder = ctx.services.memory.delete.mock.invocationCallOrder[0];
    expect(insertOrder).toBeLessThan(firstConsolidateDeleteOrder);

    // Verify usage
    expect(value.usage!.inputTokens).toBe(400);
    expect(value.usage!.outputTokens).toBe(150);
  });

  it('handles keep actions without making any repo calls', async () => {
    const items = [makeMemoryItem({ id: 'mem-1', content: 'Important fact' })];

    const ctx = makeCtx({
      findByThread: vi.fn().mockReturnValue(ok(items)),
    });

    generateObjectMock.mockResolvedValueOnce({
      object: {
        actions: [
          {
            type: 'keep',
            ids: ['mem-1'],
            reason: 'Still relevant',
          },
        ],
      },
      usage: { inputTokens: 200, outputTokens: 50 },
    });

    const result = await run(ctx, {});
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.data!.kept).toBe(1);
    expect(value.data!.pruned).toBe(0);
    expect(value.data!.consolidated).toBe(0);
    expect(ctx.services.memory.delete).not.toHaveBeenCalled();
    expect(ctx.services.memory.insert).not.toHaveBeenCalled();
  });

  it('skips consolidation when insert fails (no data loss)', async () => {
    const items = [
      makeMemoryItem({ id: 'mem-1', content: 'Fact A' }),
      makeMemoryItem({ id: 'mem-2', content: 'Fact A duplicate' }),
    ];
    const ctx = makeCtx({
      findByThread: vi.fn().mockReturnValue(ok(items)),
      insert: vi.fn().mockReturnValue(err(new DbError('UNIQUE constraint failed'))),
    });

    generateObjectMock.mockResolvedValueOnce({
      object: {
        actions: [
          {
            type: 'consolidate',
            ids: ['mem-1', 'mem-2'],
            reason: 'Duplicates',
            mergedContent: 'Fact A',
          },
        ],
      },
      usage: { inputTokens: 200, outputTokens: 50 },
    });

    const result = await run(ctx, {});
    expect(result.isOk()).toBe(true);
    // No deletes should happen since insert failed.
    expect(ctx.services.memory.delete).not.toHaveBeenCalled();
    expect(result._unsafeUnwrap().data!.consolidated).toBe(0);
  });

  it('skips actions referencing unknown memory IDs', async () => {
    const items = [makeMemoryItem({ id: 'mem-1' })];
    const ctx = makeCtx({
      findByThread: vi.fn().mockReturnValue(ok(items)),
    });

    generateObjectMock.mockResolvedValueOnce({
      object: {
        actions: [
          { type: 'prune', ids: ['hallucinated-id'], reason: 'does not exist' },
          { type: 'keep', ids: ['mem-1'], reason: 'still valid' },
        ],
      },
      usage: { inputTokens: 200, outputTokens: 50 },
    });

    const result = await run(ctx, {});
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().data!.kept).toBe(1);
    expect(result._unsafeUnwrap().data!.pruned).toBe(0);
    // The hallucinated prune should be skipped, no delete calls.
    expect(ctx.services.memory.delete).not.toHaveBeenCalled();
  });

  it('returns error when model call throws', async () => {
    const items = [makeMemoryItem()];
    const ctx = makeCtx({
      findByThread: vi.fn().mockReturnValue(ok(items)),
    });

    generateObjectMock.mockRejectedValueOnce(new Error('API rate limit exceeded'));

    const result = await run(ctx, {});
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Memory grooming failed');
    expect(result._unsafeUnwrapErr().message).toContain('API rate limit exceeded');
  });

  it('filters items by periodMs when provided', async () => {
    const now = Date.now();
    const items = [
      makeMemoryItem({ id: 'mem-old', content: 'Old item', created_at: now - 200_000 }),
      makeMemoryItem({ id: 'mem-new', content: 'New item', created_at: now - 10_000 }),
    ];
    const ctx = makeCtx({
      findByThread: vi.fn().mockReturnValue(ok(items)),
    });

    generateObjectMock.mockResolvedValueOnce({
      object: {
        actions: [
          { type: 'keep', ids: ['mem-new'], reason: 'Recent' },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 30 },
    });

    // Only review items from the last 60 seconds
    const result = await run(ctx, { periodMs: 60_000 });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().data!.kept).toBe(1);
  });

  it('skips consolidate action when mergedContent is missing', async () => {
    const items = [
      makeMemoryItem({ id: 'mem-1', content: 'Fact A' }),
      makeMemoryItem({ id: 'mem-2', content: 'Fact B' }),
    ];
    const ctx = makeCtx({
      findByThread: vi.fn().mockReturnValue(ok(items)),
    });

    generateObjectMock.mockResolvedValueOnce({
      object: {
        actions: [
          {
            type: 'consolidate',
            ids: ['mem-1', 'mem-2'],
            reason: 'Should be merged but mergedContent is absent',
            // mergedContent intentionally omitted
          },
        ],
      },
      usage: { inputTokens: 200, outputTokens: 50 },
    });

    const result = await run(ctx, {});
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    // Action must be skipped — no inserts, no deletes, 0 consolidated
    expect(value.data!.consolidated).toBe(0);
    expect(ctx.services.memory.insert).not.toHaveBeenCalled();
    expect(ctx.services.memory.delete).not.toHaveBeenCalled();
    // Warn should have been logged
    expect(ctx.services.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: expect.anything() }),
      expect.stringContaining('mergedContent'),
    );
  });

  it('reviews all items when periodMs is 0', async () => {
    const items = [makeMemoryItem({ id: 'mem-1' })];
    const ctx = makeCtx({
      findByThread: vi.fn().mockReturnValue(ok(items)),
    });

    generateObjectMock.mockResolvedValueOnce({
      object: { actions: [{ type: 'keep', ids: ['mem-1'], reason: 'good' }] },
      usage: { inputTokens: 100, outputTokens: 30 },
    });

    const result = await run(ctx, { periodMs: 0 });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().data!.kept).toBe(1);
  });
});
