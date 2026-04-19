import { describe, it, expect, vi } from 'vitest';
import { ok } from 'neverthrow';

import { ContextAssembler, type ContextAssemblerDeps } from '../../../src/daemon/context-assembler.js';

const makeDeps = (overrides: Partial<ContextAssemblerDeps> = {}): ContextAssemblerDeps => ({
  messageRepo: {
    findLatestByThread: vi.fn().mockReturnValue(ok([])),
    findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
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
        findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
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
        findLatestByThread: vi.fn().mockReturnValue(ok([])),
        findLatestByThreadSince: vi.fn().mockReturnValue(ok([
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
    const findLatestByThreadSince = vi.fn().mockReturnValue(ok([]));
    const deps = makeDeps({
      messageRepo: { findLatestByThread, findLatestByThreadSince } as any,
    });

    const assembler = new ContextAssembler(deps);
    assembler.assemble('thread-1', 2);

    // recentMessageLimit=2, but no summary → assembler should use the
    // pre-summary cap (50) instead of the configured limit (2).
    expect(findLatestByThread).toHaveBeenCalledWith('thread-1', 50);
    expect(findLatestByThreadSince).not.toHaveBeenCalled();
  });

  it('filters Recent Messages to post-rotation only when a summary exists', () => {
    const findLatestByThread = vi.fn().mockReturnValue(ok([]));
    const findLatestByThreadSince = vi.fn().mockReturnValue(ok([
      { direction: 'inbound', content: JSON.stringify({ body: 'post-rotation msg' }) },
    ]));
    const deps = makeDeps({
      memoryRepo: {
        findByThread: vi.fn().mockReturnValue(ok([
          {
            id: 'sum-1',
            type: 'summary',
            content: 'Session summary.',
            created_at: 5000,
            metadata: JSON.stringify({ source: 'context-roller', rotatedThroughTs: 4500 }),
          },
        ])),
      } as any,
      messageRepo: { findLatestByThread, findLatestByThreadSince } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1', 5);

    // Summary exists → assembler should query post-rotation using the
    // metadata-stored snapshot timestamp (4500), NOT the summary's own
    // created_at (5000). The snapshot timestamp is the upper bound of
    // messages already summarized.
    expect(findLatestByThreadSince).toHaveBeenCalledWith('thread-1', 4500, 5);
    expect(findLatestByThread).not.toHaveBeenCalled();
    expect(result.recentMessageCount).toBe(1);
    expect(result.text).toContain('User: post-rotation msg');
  });

  it('falls back to created_at when metadata.rotatedThroughTs is absent (backwards compat)', () => {
    const findLatestByThreadSince = vi.fn().mockReturnValue(ok([]));
    const deps = makeDeps({
      memoryRepo: {
        findByThread: vi.fn().mockReturnValue(ok([
          {
            id: 'sum-1',
            type: 'summary',
            content: 'Legacy summary.',
            created_at: 5000,
            metadata: JSON.stringify({ source: 'context-roller' }),
          },
        ])),
      } as any,
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok([])),
        findLatestByThreadSince,
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    assembler.assemble('thread-1', 5);

    expect(findLatestByThreadSince).toHaveBeenCalledWith('thread-1', 5000, 5);
  });

  it('filters Recent Messages to post-rotation only when an observation exists (OM path)', () => {
    const findLatestByThreadSince = vi.fn().mockReturnValue(ok([]));
    const deps = makeDeps({
      memoryRepo: {
        findByThread: vi.fn().mockImplementation((_tid: string, type?: string) => {
          if (type === 'observation') {
            return ok([
              {
                id: 'obs-1',
                type: 'observation',
                content: 'Date: 2026-04-19\n- 🔴 10:00 user requested feature X',
                created_at: 7200,
                metadata: JSON.stringify({
                  source: 'context-roller-om',
                  rotatedThroughTs: 6800,
                }),
              },
            ]);
          }
          return ok([]);
        }),
      } as any,
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok([])),
        findLatestByThreadSince,
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1', 10);

    // Uses rotatedThroughTs (snapshot time), not the observation's created_at,
    // so messages that arrived during observer latency are retained.
    expect(findLatestByThreadSince).toHaveBeenCalledWith('thread-1', 6800, 10);
    expect(result.summaryFound).toBe(true);
    expect(result.recentMessageCount).toBe(0);
    expect(result.text).toContain('Observation Log');
    // Recent Messages section is absent when nothing came after rotation.
    expect(result.text).not.toContain('Recent Messages');
  });

  it('omits Current task / Next step hints when observation metadata has none', () => {
    const deps = makeDeps({
      memoryRepo: {
        findByThread: vi.fn().mockImplementation((_tid: string, type?: string) => {
          if (type === 'observation') {
            return ok([
              {
                id: 'obs-1',
                type: 'observation',
                content: 'Date: 2026-04-19\n- 🟢 10:00 greeting',
                created_at: 7000,
                metadata: JSON.stringify({ source: 'context-roller-om' }),
              },
            ]);
          }
          return ok([]);
        }),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1', 10);

    expect(result.text).not.toContain('Current task:');
    expect(result.text).not.toContain('Next step:');
  });

  it('handles non-JSON message content', () => {
    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok([
          { direction: 'inbound', content: 'plain text' },
        ])),
        findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1', 10);
    expect(result.recentMessageCount).toBe(1);
    expect(result.text).toContain('User: plain text');
  });
});
