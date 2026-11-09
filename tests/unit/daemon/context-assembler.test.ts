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

// ---------------------------------------------------------------------------
// Image-aware assembly (ADR-0002): live-first shared budgets, historical
// inventory + Finding projections, exposure-aware omission notices.
// ---------------------------------------------------------------------------

import {
  LIVE_IMAGE_SECTION_HEADER,
  orderLiveDescriptors,
  projectImageHistory,
  renderLiveImageDescriptors,
  type AssembleImageContext,
  type LiveImageDescriptorBlock,
} from '../../../src/daemon/context-assembler.js';
import type { ImageDescriptor } from '../../../src/images/image-types.js';
import type { Finding } from '../../../src/images/finding-types.js';

const HOUR = 3_600_000;
const BASE_TS = 1_700_000_000_000;

function makeImage(overrides: Partial<ImageDescriptor> & { imageId: string }): ImageDescriptor {
  return {
    threadId: 'thread-1',
    messageId: 'msg-1',
    ordinal: 0,
    receivedAt: BASE_TS,
    expiresAt: BASE_TS + HOUR,
    state: 'available',
    mimeType: 'image/png',
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> & { findingId: string }): Finding {
  return {
    threadId: 'thread-1',
    runId: 'run-1',
    imageIds: ['img-1'],
    question: 'What is in this image?',
    answer: 'A sunset over the harbour.',
    createdAt: BASE_TS,
    modelName: 'vision-model-1',
    ...overrides,
  };
}

const EMPTY_LIVE: LiveImageDescriptorBlock = {
  text: '',
  imageIds: [],
  selectedCount: 0,
  consumedChars: 0,
  omittedCount: 0,
};

function imageContext(
  overrides: Partial<AssembleImageContext> = {},
): AssembleImageContext {
  return {
    live: EMPTY_LIVE,
    inventoryDescriptors: [],
    findings: [],
    imageLookupExposed: false,
    ...overrides,
  };
}

describe('renderLiveImageDescriptors', () => {
  it('renders the live header and descriptor lines in source order', () => {
    const descriptors = [
      makeImage({ imageId: 'img-b', ordinal: 0 }),
      makeImage({ imageId: 'img-a', ordinal: 1, filename: 'second.png' }),
    ];

    const block = renderLiveImageDescriptors(descriptors, false);

    expect(block.text).toContain(LIVE_IMAGE_SECTION_HEADER);
    expect(block.imageIds).toEqual(['img-b', 'img-a']);
    expect(block.selectedCount).toBe(2);
    expect(block.omittedCount).toBe(0);
    const lineB = block.text.indexOf('img img-b state=available');
    const lineA = block.text.indexOf('img img-a state=available');
    expect(lineB).toBeGreaterThan(-1);
    expect(lineA).toBeGreaterThan(lineB);
    expect(block.text).toContain('file="second.png"');
    // consumedChars covers header + lines so history respects the shared budget.
    expect(block.consumedChars).toBe(block.text.length + 1);
  });

  it('returns an empty block when there are no descriptors', () => {
    const block = renderLiveImageDescriptors([], false);
    expect(block).toEqual({
      text: '',
      imageIds: [],
      selectedCount: 0,
      consumedChars: 0,
      omittedCount: 0,
    });
  });

  it('omits whole entries beyond the shared count budget with an exposure-aware notice', () => {
    const descriptors = Array.from({ length: 23 }, (_, i) =>
      makeImage({ imageId: `img-${String(i).padStart(2, '0')}`, ordinal: i }),
    );

    const exposed = renderLiveImageDescriptors(descriptors, true);
    expect(exposed.selectedCount).toBe(20);
    expect(exposed.omittedCount).toBe(3);
    expect(exposed.text).toContain(
      'Some images are omitted from this projection. Use image_lookup to see them.',
    );
    expect(exposed.text).not.toContain('img img-20 ');

    const neutral = renderLiveImageDescriptors(descriptors, false);
    expect(neutral.text).toContain('Some images are omitted from this projection.');
    expect(neutral.text).not.toContain('image_lookup');
  });

  it('filters foreign-thread and processing descriptors before ordering by ordinal', () => {
    const descriptors = [
      makeImage({ imageId: 'img-ord1', ordinal: 1 }),
      makeImage({ imageId: 'img-other', ordinal: 0, threadId: 'thread-2' }),
      makeImage({ imageId: 'img-proc', ordinal: 2, state: 'processing' }),
      makeImage({ imageId: 'img-ord0', ordinal: 0 }),
    ];

    const ordered = orderLiveDescriptors(descriptors, 'thread-1');

    expect(ordered.map((d) => d.imageId)).toEqual(['img-ord0', 'img-ord1']);
  });
});

describe('projectImageHistory', () => {
  it('projects inventory and findings framed as historical data', () => {
    const text = projectImageHistory({
      live: EMPTY_LIVE,
      inventoryDescriptors: [makeImage({ imageId: 'img-old' })],
      findings: [makeFinding({ findingId: 'find-1' })],
      imageLookupExposed: false,
    });

    expect(text).toContain('Images (historical data; state shown was current at projection time):');
    expect(text).toContain('Image inventory:');
    expect(text).toContain('img img-old state=available');
    expect(text).toContain('Findings (historical data):');
    expect(text).toContain('finding find-1');
    expect(text).toContain('A sunset over the harbour.');
  });

  it('returns empty text when there is nothing to project and nothing omitted', () => {
    const text = projectImageHistory({
      live: EMPTY_LIVE,
      inventoryDescriptors: [],
      findings: [],
      imageLookupExposed: true,
    });
    expect(text).toBe('');
  });

  it('excludes live Image IDs from the inventory projection', () => {
    const live: LiveImageDescriptorBlock = {
      text: 'x',
      imageIds: ['img-live'],
      selectedCount: 1,
      consumedChars: 120,
      omittedCount: 0,
    };

    const text = projectImageHistory({
      live,
      inventoryDescriptors: [
        makeImage({ imageId: 'img-live' }),
        makeImage({ imageId: 'img-old', receivedAt: BASE_TS - HOUR }),
      ],
      findings: [],
      imageLookupExposed: false,
    });

    expect(text).toContain('img img-old ');
    expect(text).not.toContain('img img-live ');
  });

  it('consumes the shared descriptor budget live-first', () => {
    // Live block already took 19 of the 20 shared descriptor slots; the
    // fresh inventory may only use the last one, and the overflow must be
    // signalled with an omission notice.
    const live: LiveImageDescriptorBlock = {
      text: 'x',
      imageIds: ['img-live'],
      selectedCount: 19,
      consumedChars: 500,
      omittedCount: 0,
    };
    const inventory = Array.from({ length: 4 }, (_, i) =>
      makeImage({ imageId: `img-inv-${i}`, receivedAt: BASE_TS + i * 1000 }),
    );

    const text = projectImageHistory({
      live,
      inventoryDescriptors: inventory,
      findings: [],
      imageLookupExposed: true,
    });

    // Newest-first fills the single remaining slot.
    expect(text).toContain('img img-inv-3 ');
    expect(text).not.toContain('img img-inv-0 ');
    expect(text).not.toContain('img img-inv-1 ');
    expect(text).not.toContain('img img-inv-2 ');
    expect(text).toContain('Use image_lookup to see them.');
  });

  it('selects inventory newest-first and keeps the descriptor section within 8000 chars', () => {
    const inventory = Array.from({ length: 30 }, (_, i) =>
      makeImage({
        imageId: `img-${String(i).padStart(2, '0')}`,
        receivedAt: BASE_TS + i * 1000,
        filename: 'f'.repeat(900),
      }),
    );

    const text = projectImageHistory({
      live: EMPTY_LIVE,
      inventoryDescriptors: inventory,
      findings: [],
      imageLookupExposed: true,
    });

    const imgLines = text.split('\n').filter((line) => line.startsWith('img '));
    expect(imgLines.length).toBeLessThanOrEqual(20);
    expect(text.length).toBeLessThanOrEqual(8000);
    // Newest receipt wins the selection.
    expect(text).toContain('img img-29 ');
  });

  it('caps Findings at ten, selects newest-first, presents chronologically', () => {
    const findings = Array.from({ length: 12 }, (_, i) =>
      makeFinding({
        findingId: `find-${String(i + 1).padStart(2, '0')}`,
        createdAt: BASE_TS + i * 1000,
      }),
    );

    const text = projectImageHistory({
      live: EMPTY_LIVE,
      inventoryDescriptors: [],
      findings,
      imageLookupExposed: true,
    });

    // Newest 10 selected: the two oldest are omitted.
    expect(text).not.toContain('find-01');
    expect(text).not.toContain('find-02');
    expect(text).toContain('find-03');
    expect(text).toContain('find-12');
    // Presented chronologically: earlier creations appear first.
    expect(text.indexOf('finding find-03')).toBeLessThan(text.indexOf('finding find-12'));
    expect(text).toContain(
      'Some findings are omitted from this projection. Use image_lookup to see them.',
    );
  });

  it('uses neutral omission notices when image_lookup is not exposed', () => {
    const findings = Array.from({ length: 12 }, (_, i) =>
      makeFinding({ findingId: `find-${i}`, createdAt: BASE_TS + i * 1000 }),
    );

    const text = projectImageHistory({
      live: EMPTY_LIVE,
      inventoryDescriptors: [],
      findings,
      imageLookupExposed: false,
    });

    expect(text).toContain('Some findings are omitted from this projection.');
    expect(text).not.toContain('image_lookup');
  });

  it('keeps the combined live + inventory aggregate within 8000 chars when the live block saturates (lookup exposed)', () => {
    // Review r1 P2-1 repro: nine live descriptors with long filenames fill
    // the shared aggregate; the history projection still emits its framing
    // and omission notice even though no entry fits. The live block must
    // reserve that fixed history-side text up front.
    const live = renderLiveImageDescriptors(
      Array.from({ length: 9 }, (_, i) =>
        makeImage({ imageId: `img-live-${i}`, ordinal: i, filename: 'l'.repeat(950) }),
      ),
      true,
    );

    const history = projectImageHistory({
      live,
      inventoryDescriptors: [makeImage({ imageId: 'img-old', receivedAt: BASE_TS - HOUR })],
      findings: [],
      imageLookupExposed: true,
    });

    expect(live.text.length).toBeGreaterThan(7000);
    expect(live.omittedCount).toBeGreaterThan(0);
    expect(history).toContain('Images (historical data; state shown was current at projection time):');
    expect(history).toContain('Some images are omitted from this projection. Use image_lookup to see them.');
    expect(live.consumedChars + history.length).toBeLessThanOrEqual(8000);
  });

  it('keeps the combined live + inventory aggregate within 8000 chars when the live block saturates (lookup not exposed)', () => {
    const live = renderLiveImageDescriptors(
      Array.from({ length: 9 }, (_, i) =>
        makeImage({ imageId: `img-live-${i}`, ordinal: i, filename: 'l'.repeat(950) }),
      ),
      false,
    );

    const history = projectImageHistory({
      live,
      inventoryDescriptors: [makeImage({ imageId: 'img-old', receivedAt: BASE_TS - HOUR })],
      findings: [],
      imageLookupExposed: false,
    });

    expect(live.text.length).toBeGreaterThan(7000);
    expect(live.omittedCount).toBeGreaterThan(0);
    expect(history).toContain('Some images are omitted from this projection.');
    expect(history).not.toContain('image_lookup');
    expect(live.consumedChars + history.length).toBeLessThanOrEqual(8000);
  });
});

describe('ContextAssembler image-aware assembly', () => {
  it('appends the bounded image projection to fresh-session context', () => {
    const deps = makeDeps({
      memoryRepo: {
        findByThread: vi.fn().mockReturnValue(ok([
          { id: 'sum-1', type: 'summary', content: 'Prior work.', created_at: 1000 },
        ])),
      } as any,
    });
    const assembler = new ContextAssembler(deps);

    const result = assembler.assemble('thread-1', 10, {
      images: imageContext({
        inventoryDescriptors: [makeImage({ imageId: 'img-hist' })],
        findings: [makeFinding({ findingId: 'find-hist' })],
      }),
    });

    expect(result.text).toContain('Prior work.');
    expect(result.text).toContain('Image inventory:');
    expect(result.text).toContain('img img-hist ');
    expect(result.text).toContain('finding find-hist');
    expect(result.charCount).toBe(result.text.length);
  });

  it('emits no image framing when no imageContext option is supplied', () => {
    const assembler = new ContextAssembler(makeDeps());
    const result = assembler.assemble('thread-1', 10);
    expect(result.text).not.toContain('Image inventory');
    expect(result.text).not.toContain('Findings (historical data');
  });

  it('surfaces the image section even when no summary or recent messages exist', () => {
    const assembler = new ContextAssembler(makeDeps());
    const result = assembler.assemble('thread-1', 10, {
      images: imageContext({
        inventoryDescriptors: [makeImage({ imageId: 'img-only' })],
      }),
    });
    expect(result.text).toContain('img img-only ');
    expect(result.recentMessageCount).toBe(0);
  });

  it('excludes current-message (live) images from the replayed inventory', () => {
    const live = renderLiveImageDescriptors(
      [makeImage({ imageId: 'img-current', messageId: 'msg-current' })],
      false,
    );
    const assembler = new ContextAssembler(makeDeps());

    const result = assembler.assemble('thread-1', 10, {
      excludeMessageId: 'msg-current',
      images: imageContext({
        live,
        inventoryDescriptors: [
          makeImage({ imageId: 'img-current', messageId: 'msg-current' }),
          makeImage({ imageId: 'img-earlier', messageId: 'msg-earlier' }),
        ],
      }),
    });

    expect(result.text).toContain('img img-earlier ');
    expect(result.text).not.toContain('img img-current ');
  });
});
