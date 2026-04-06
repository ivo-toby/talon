import { describe, it, expect, vi } from 'vitest';
import { ok } from 'neverthrow';

import { ContextAssembler, type ContextAssemblerDeps } from '../../../src/daemon/context-assembler.js';

const makeDeps = (overrides: Partial<ContextAssemblerDeps> = {}): ContextAssemblerDeps => ({
  messageRepo: {
    findLatestByThread: vi.fn().mockReturnValue(ok([])),
  } as any,
  memoryRepo: {
    findByThread: vi.fn().mockReturnValue(ok([])),
  } as any,
  ...overrides,
});

describe('ContextAssembler', () => {
  it('returns empty metadata when no summary and no recent messages', () => {
    const assembler = new ContextAssembler(makeDeps());
    const result = assembler.assemble('thread-1', 10);
    expect(result).toEqual({
      text: '',
      summaryFound: false,
      recentMessageCount: 0,
      charCount: 0,
    });
  });

  it('includes session summary when available', () => {
    const deps = makeDeps({
      memoryRepo: {
        findByThread: vi.fn().mockReturnValue(ok([
          {
            id: 'sum-1',
            thread_id: 'thread-1',
            type: 'summary',
            content: 'Discussed deployment plans.\n\nKey facts:\n- Using Docker\n\nOpen threads:\n- CI pipeline',
            created_at: 1000,
          },
        ])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1', 10);
    expect(result.summaryFound).toBe(true);
    expect(result.recentMessageCount).toBe(0);
    expect(result.text).toContain('Previous Context');
    expect(result.text).toContain('read-only summary');
    expect(result.text).toContain('Discussed deployment plans');
    expect(result.text).toContain('Using Docker');
    expect(result.charCount).toBe(result.text.length);
  });

  it('includes recent messages when available', () => {
    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok([
          { direction: 'inbound', content: JSON.stringify({ body: 'how is the deploy going?' }) },
          { direction: 'outbound', content: JSON.stringify({ body: 'All green, deployed 5 minutes ago.' }) },
        ])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1', 10);
    expect(result.summaryFound).toBe(false);
    expect(result.recentMessageCount).toBe(2);
    expect(result.text).toContain('Recent Messages');
    expect(result.text).toContain('User: how is the deploy going?');
    expect(result.text).toContain('Assistant: All green, deployed 5 minutes ago.');
    expect(result.charCount).toBe(result.text.length);
  });

  it('includes both summary and recent messages', () => {
    const deps = makeDeps({
      memoryRepo: {
        findByThread: vi.fn().mockReturnValue(ok([
          { id: 'sum-1', type: 'summary', content: 'Previous session summary.', created_at: 1000 },
        ])),
      } as any,
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok([
          { direction: 'inbound', content: JSON.stringify({ body: 'latest question' }) },
        ])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1', 10);
    expect(result.summaryFound).toBe(true);
    expect(result.recentMessageCount).toBe(1);
    expect(result.text).toContain('Previous Context');
    expect(result.text).toContain('Previous session summary.');
    expect(result.text).toContain('Recent Messages');
    expect(result.text).toContain('User: latest question');
  });

  it('uses only the most recent summary', () => {
    const deps = makeDeps({
      memoryRepo: {
        findByThread: vi.fn().mockReturnValue(ok([
          { id: 'sum-new', type: 'summary', content: 'New summary.', created_at: 2000 },
          { id: 'sum-old', type: 'summary', content: 'Old summary.', created_at: 1000 },
        ])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1', 10);
    expect(result.text).toContain('New summary.');
    // Should only include one Previous Context section
    expect(result.text.match(/## Previous Context/g)?.length).toBe(1);
  });

  it('fetches ALL messages when no summary exists (context grows toward rotation threshold)', () => {
    const findLatestByThread = vi.fn().mockReturnValue(ok([
      { direction: 'inbound', content: JSON.stringify({ body: 'msg 1' }) },
      { direction: 'outbound', content: JSON.stringify({ body: 'reply 1' }) },
      { direction: 'inbound', content: JSON.stringify({ body: 'msg 2' }) },
    ]));
    const deps = makeDeps({
      messageRepo: { findLatestByThread } as any,
    });

    const assembler = new ContextAssembler(deps);
    assembler.assemble('thread-1', 2);

    // recentMessageLimit=2, but no summary → assembler should request
    // all messages (Number.MAX_SAFE_INTEGER), not just the last 2.
    expect(findLatestByThread).toHaveBeenCalledWith('thread-1', Number.MAX_SAFE_INTEGER);
  });

  it('caps messages to recentMessageLimit when a summary exists (post-rotation)', () => {
    const findLatestByThread = vi.fn().mockReturnValue(ok([
      { direction: 'inbound', content: JSON.stringify({ body: 'recent msg' }) },
    ]));
    const deps = makeDeps({
      memoryRepo: {
        findByThread: vi.fn().mockReturnValue(ok([
          { id: 'sum-1', type: 'summary', content: 'Session summary.', created_at: 1000 },
        ])),
      } as any,
      messageRepo: { findLatestByThread } as any,
    });

    const assembler = new ContextAssembler(deps);
    assembler.assemble('thread-1', 5);

    // Summary exists → assembler should cap at the configured limit.
    expect(findLatestByThread).toHaveBeenCalledWith('thread-1', 5);
  });

  it('handles non-JSON message content', () => {
    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok([
          { direction: 'inbound', content: 'plain text' },
        ])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1', 10);
    expect(result.recentMessageCount).toBe(1);
    expect(result.text).toContain('User: plain text');
  });
});
