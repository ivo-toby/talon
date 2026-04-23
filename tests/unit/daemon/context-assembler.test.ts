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
    expect(result.text).toContain('Prior-conversation state');
    expect(result.text).toContain('historical context');
    expect(result.text).toContain('Discussed deployment plans');
    expect(result.text).toContain('Using Docker');
    expect(result.charCount).toBe(result.text.length);
  });

  it('formats replayed turns with bracketed state tags, not role markers', () => {
    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok([
          { id: 'msg-a', direction: 'inbound', content: JSON.stringify({ body: 'how is the deploy going?' }) },
          { id: 'msg-b', direction: 'outbound', content: JSON.stringify({ body: 'All green, deployed 5 minutes ago.' }) },
        ])),
        findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1', 10);
    expect(result.summaryFound).toBe(false);
    expect(result.recentMessageCount).toBe(2);
    expect(result.text).toContain('Recent Messages');
    // Bracketed state tags instead of "User:" / "Assistant:" so the main
    // agent does not read replayed turns as live role markers.
    expect(result.text).toContain('[previous turn, user]: how is the deploy going?');
    expect(result.text).toContain('[previous turn, agent]: All green, deployed 5 minutes ago.');
    expect(result.text).not.toMatch(/^User: /m);
    expect(result.text).not.toMatch(/^Assistant: /m);
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
    expect(result.text).toContain('Prior-conversation state');
    expect(result.text).toContain('Previous session summary.');
    expect(result.text).toContain('Recent Messages');
    expect(result.text).toContain('[previous turn, user]: latest question');
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
    expect(result.text.match(/## Prior-conversation state/g)?.length).toBe(1);
  });

  it('replays observations within a char budget (bounded, not full history)', () => {
    // Each observation is ~15K chars. With a 20K-char replay budget, the
    // assembler includes the newest observation unconditionally, then can
    // fit at most one additional observation before the budget is
    // exhausted. Older observations are excluded. This keeps prompt size
    // flat across the thread lifetime (issue #197) while still preserving
    // recent history — e.g. across a reflector consolidation boundary.
    const big = (marker: string) => `Date: 2026-04-19\n- 🟢 10:00 ${marker}\n` + 'x'.repeat(15_000);
    const deps = makeDeps({
      memoryRepo: {
        findByThread: vi.fn().mockImplementation((_tid: string, type?: string) => {
          if (type === 'observation') {
            return ok([
              {
                id: 'obs-new',
                type: 'observation',
                content: big('newest-obs-marker'),
                created_at: 9000,
                metadata: JSON.stringify({ source: 'context-roller-om', taskComplete: true }),
              },
              {
                id: 'obs-consolidated',
                type: 'observation',
                content: big('consolidated-marker'),
                created_at: 6000,
                metadata: JSON.stringify({ source: 'context-roller-om-reflector', taskComplete: true }),
              },
              {
                id: 'obs-old',
                type: 'observation',
                content: big('oldest-marker'),
                created_at: 3000,
                metadata: JSON.stringify({ source: 'context-roller-om', taskComplete: true }),
              },
            ]);
          }
          return ok([]);
        }),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1', 10);
    // Newest is always included, so is guaranteed-present.
    expect(result.text).toContain('newest-obs-marker');
    // Budget exhausted after one more — oldest is excluded.
    expect(result.text).not.toContain('oldest-marker');
  });

  it('still surfaces consolidated history alongside newest rotation when they fit', () => {
    // Small observations — both fit within the replay budget. This is the
    // scenario just after a reflector consolidation + one subsequent
    // rotation. The agent should see BOTH the consolidated state and the
    // newest rotation delta, not just the newest.
    const deps = makeDeps({
      memoryRepo: {
        findByThread: vi.fn().mockImplementation((_tid: string, type?: string) => {
          if (type === 'observation') {
            return ok([
              {
                id: 'obs-new',
                type: 'observation',
                content: 'Date: 2026-04-19\n- 🟢 14:00 newest rotation delta',
                created_at: 9000,
                metadata: JSON.stringify({ source: 'context-roller-om', taskComplete: true }),
              },
              {
                id: 'obs-consolidated',
                type: 'observation',
                content: 'Date: 2026-04-18\n- 🔴 09:00 consolidated historical decisions',
                created_at: 6000,
                metadata: JSON.stringify({ source: 'context-roller-om-reflector', taskComplete: true }),
              },
            ]);
          }
          return ok([]);
        }),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1', 10);
    expect(result.text).toContain('newest rotation delta');
    expect(result.text).toContain('consolidated historical decisions');
    // Chronological order — older consolidated comes first, newest last.
    expect(result.text.indexOf('consolidated historical decisions'))
      .toBeLessThan(result.text.indexOf('newest rotation delta'));
  });

  it('suppresses currentTask/suggestedContinuation hints when newest observation is taskComplete', () => {
    const deps = makeDeps({
      memoryRepo: {
        findByThread: vi.fn().mockImplementation((_tid: string, type?: string) => {
          if (type === 'observation') {
            return ok([
              {
                id: 'obs-1',
                type: 'observation',
                content: 'Date: 2026-04-19\n- 🟢 10:00 completed task',
                created_at: 7000,
                metadata: JSON.stringify({
                  source: 'context-roller-om',
                  taskComplete: true,
                  // Even if hints are leaked into metadata, the assembler
                  // must suppress them when taskComplete is true.
                  currentTask: 'stale task leaked into metadata',
                  suggestedContinuation: 'stale next step leaked into metadata',
                }),
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
    expect(result.text).not.toContain('stale task leaked');
    expect(result.text).not.toContain('stale next step leaked');
  });

  it('surfaces hints when taskComplete is false', () => {
    const deps = makeDeps({
      memoryRepo: {
        findByThread: vi.fn().mockImplementation((_tid: string, type?: string) => {
          if (type === 'observation') {
            return ok([
              {
                id: 'obs-1',
                type: 'observation',
                content: 'Date: 2026-04-19\n- 🔴 10:00 in-progress',
                created_at: 7000,
                metadata: JSON.stringify({
                  source: 'context-roller-om',
                  taskComplete: false,
                  currentTask: 'writing tests',
                  suggestedContinuation: 'finish the assembler test',
                }),
              },
            ]);
          }
          return ok([]);
        }),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1', 10);
    expect(result.text).toContain('Current task:');
    expect(result.text).toContain('writing tests');
    expect(result.text).toContain('Next step:');
    expect(result.text).toContain('finish the assembler test');
  });

  it('legacy observations without taskComplete still surface hints (backwards compat)', () => {
    const deps = makeDeps({
      memoryRepo: {
        findByThread: vi.fn().mockImplementation((_tid: string, type?: string) => {
          if (type === 'observation') {
            return ok([
              {
                id: 'obs-legacy',
                type: 'observation',
                content: 'Date: 2026-04-19\n- 🔴 10:00 legacy',
                created_at: 7000,
                // No taskComplete field at all.
                metadata: JSON.stringify({
                  source: 'context-roller-om',
                  currentTask: 'legacy task',
                  suggestedContinuation: 'legacy next step',
                }),
              },
            ]);
          }
          return ok([]);
        }),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1', 10);
    expect(result.text).toContain('legacy task');
    expect(result.text).toContain('legacy next step');
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

    expect(findLatestByThreadSince).toHaveBeenCalledWith('thread-1', 4500, 5);
    expect(findLatestByThread).not.toHaveBeenCalled();
    expect(result.recentMessageCount).toBe(1);
    expect(result.text).toContain('[previous turn, user]: post-rotation msg');
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
                  taskComplete: true,
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

    expect(findLatestByThreadSince).toHaveBeenCalledWith('thread-1', 6800, 10);
    expect(result.summaryFound).toBe(true);
    expect(result.recentMessageCount).toBe(0);
    expect(result.text).toContain('Observation Log');
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

  it('handles non-JSON message content with bracketed tags', () => {
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
    expect(result.text).toContain('[previous turn, user]: plain text');
  });

  it('excludes the current inbound message from Recent Messages when excludeMessageId is provided', () => {
    // The message being processed is already passed to the provider as the
    // live prompt; echoing it in the system prompt as a `[previous turn, user]`
    // entry caused stateless providers to respond twice — once to the replay,
    // once to the prompt itself. The agent runner now passes the processed
    // message id so the assembler drops it.
    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok([
          { id: 'msg-prev', direction: 'inbound', content: JSON.stringify({ body: 'prior turn' }) },
          { id: 'msg-current', direction: 'inbound', content: JSON.stringify({ body: 'current question' }) },
        ])),
        findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1', 10, { excludeMessageId: 'msg-current' });

    expect(result.recentMessageCount).toBe(1);
    expect(result.text).toContain('[previous turn, user]: prior turn');
    expect(result.text).not.toContain('current question');
  });

  it('suppresses the Recent Messages block entirely when excluding the only message', () => {
    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok([
          { id: 'msg-current', direction: 'inbound', content: JSON.stringify({ body: 'only message' }) },
        ])),
        findLatestByThreadSince: vi.fn().mockReturnValue(ok([])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1', 10, { excludeMessageId: 'msg-current' });

    expect(result.recentMessageCount).toBe(0);
    expect(result.text).not.toContain('Recent Messages');
    expect(result.text).not.toContain('only message');
  });
});
