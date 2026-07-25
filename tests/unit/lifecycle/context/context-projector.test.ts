import { describe, expect, it, vi } from 'vitest';
import { err, ok } from 'neverthrow';

import {
  formatContextObservationBlock,
  projectContextObservation,
  projectContextReduction,
  type ContextProjectionMemoryRepository,
} from '../../../../src/lifecycle/context/context-projector.js';

const makeRepo = (
  overrides: Partial<ContextProjectionMemoryRepository> = {},
): ContextProjectionMemoryRepository => ({
  findById: vi.fn().mockReturnValue(ok(null)),
  upsertByKey: vi.fn().mockReturnValue(ok({})),
  delete: vi.fn().mockReturnValue(ok(undefined)),
  runInTransaction: vi.fn().mockImplementation((fn: () => unknown) => {
    try {
      return ok(fn());
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }),
  ...overrides,
});

const makeStatefulRepo = (
  memory: Map<string, { content: string; metadata: string }>,
): ContextProjectionMemoryRepository => makeRepo({
  findById: vi.fn().mockImplementation((_threadId: string, key: string) =>
    ok(memory.get(key) ?? null),
  ),
  upsertByKey: vi.fn().mockImplementation((
    _threadId: string,
    key: string,
    fields: { content: string; metadata?: string },
  ) => {
    memory.set(key, {
      content: fields.content,
      metadata: fields.metadata ?? memory.get(key)?.metadata ?? '{}',
    });
    return ok({});
  }),
  delete: vi.fn().mockImplementation((_threadId: string, key: string) => {
    memory.delete(key);
    return ok(undefined);
  }),
});

describe('context projector', () => {
  const messages = [
    { direction: 'inbound' as const, content: JSON.stringify({ body: 'start task' }), created_at: 1_000 },
    { direction: 'outbound' as const, content: JSON.stringify({ body: 'working' }), created_at: 2_000 },
  ];

  it('formats observer observations deterministically', () => {
    expect(formatContextObservationBlock([
      { date: '2026-07-25', time: '10:00', priority: 'high', text: 'Important' },
      { date: '2026-07-25', time: '10:05', priority: 'low', text: 'Minor' },
      { date: '2026-07-26', time: '09:00', priority: 'medium', text: 'Follow-up' },
    ])).toBe(
      [
        'Date: 2026-07-25',
        '- 🔴 10:00 Important',
        '- 🟢 10:05 Minor',
        '',
        'Date: 2026-07-26',
        '- 🟡 09:00 Follow-up',
      ].join('\n'),
    );
  });

  it('projects observations, memory updates, and pre-roll with stable ids in one transaction', () => {
    const repo = makeRepo({
      findById: vi.fn().mockReturnValue(ok({ content: 'Existing', metadata: '{}' })),
    });

    const result = projectContextObservation({
      repo,
      threadId: 'thread-1',
      projectionId: 'delivery-1:handler-1',
      messages,
      rotatedThroughTs: 2_000,
      contextUsage: {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 75_000,
        rawMetricName: 'cache_read_input_tokens',
      },
      observerOutput: {
        observations: [
          { date: '2026-07-25', time: '10:00', priority: 'medium', text: 'Work continued.' },
        ],
        taskComplete: false,
        currentTask: 'Implement projector',
        suggestedContinuation: 'Finish tests',
        memoryUpdates: [
          { key: 'work:talon', value: 'New', mode: 'append', type: 'note' },
        ],
      },
    });

    expect(result.isOk()).toBe(true);
    expect(repo.runInTransaction).toHaveBeenCalledOnce();
    expect(repo.upsertByKey).toHaveBeenCalledWith(
      'thread-1',
      'context-observation:delivery-1:handler-1:2000',
      expect.objectContaining({
        type: 'observation',
        content: 'Date: 2026-07-25\n- 🟡 10:00 Work continued.',
      }),
    );
    expect(repo.upsertByKey).toHaveBeenCalledWith('thread-1', 'work:talon', expect.objectContaining({
      type: 'note',
      content: 'Existing\nNew',
    }));
    expect(repo.upsertByKey).toHaveBeenCalledWith(
      'thread-1',
      'pre-roll-tail',
      expect.objectContaining({
        type: 'pre-roll-tail',
        content: expect.stringContaining('Do NOT re-execute'),
      }),
    );
  });

  it('keeps replay idempotent by reusing the same projection key', () => {
    const repo = makeRepo();
    const input = {
      repo,
      threadId: 'thread-1',
      projectionId: 'event-1:handler-1',
      messages,
      rotatedThroughTs: 2_000,
      contextUsage: {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 75_000,
        rawMetricName: 'cache_read_input_tokens',
      },
      observerOutput: {
        observations: [
          { date: '2026-07-25', time: '10:00', priority: 'low', text: 'Replay-safe.' },
        ],
        taskComplete: true,
        memoryUpdates: [],
      },
    };

    const first = projectContextObservation(input);
    const second = projectContextObservation(input);

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    const observationKeys = (repo.upsertByKey as ReturnType<typeof vi.fn>).mock.calls
      .filter(([, key]) => key === 'context-observation:event-1:handler-1:2000');
    expect(observationKeys).toHaveLength(2);
  });

  it('does not append a named memory update twice when the same projection replays', () => {
    const memory = new Map<string, { content: string; metadata: string }>([
      ['work:talon', { content: 'Existing', metadata: '{}' }],
    ]);
    const repo = makeRepo({
      findById: vi.fn().mockImplementation((_threadId: string, key: string) =>
        ok(memory.get(key) ?? null),
      ),
      upsertByKey: vi.fn().mockImplementation((
        _threadId: string,
        key: string,
        fields: { content: string; metadata?: string },
      ) => {
        memory.set(key, {
          content: fields.content,
          metadata: fields.metadata ?? memory.get(key)?.metadata ?? '{}',
        });
        return ok({});
      }),
    });
    const input = {
      repo,
      threadId: 'thread-1',
      projectionId: 'event-1:handler-1',
      messages,
      rotatedThroughTs: 2_000,
      contextUsage: {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 75_000,
        rawMetricName: 'cache_read_input_tokens',
      },
      observerOutput: {
        observations: [
          { date: '2026-07-25', time: '10:00', priority: 'low', text: 'Replay-safe.' },
        ],
        taskComplete: true,
        memoryUpdates: [
          { key: 'work:talon', value: 'Appended once', mode: 'append', type: 'note' },
        ],
      },
    };

    const first = projectContextObservation(input);
    const second = projectContextObservation(input);

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    if (first.isOk()) expect(first.value.memoryUpdatesApplied).toBe(1);
    if (second.isOk()) expect(second.value.memoryUpdatesApplied).toBe(0);
    expect(memory.get('work:talon')?.content).toBe('Existing\nAppended once');
    const namedMemoryUpserts = (repo.upsertByKey as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, key]) => key === 'work:talon',
    );
    expect(namedMemoryUpserts).toHaveLength(1);
  });

  it('preserves previous append markers when a projection replaces then appends the same named memory', () => {
    const appliedAppendKey = 'contextProjectionAppliedAppends';
    const oldMarker = 'event-1:1000:append:0';
    const memory = new Map<string, { content: string; metadata: string }>([
      ['work:talon', {
        content: 'Existing\nOld append',
        metadata: JSON.stringify({ [appliedAppendKey]: [oldMarker] }),
      }],
    ]);
    const repo = makeStatefulRepo(memory);

    const replacement = projectContextObservation({
      repo,
      threadId: 'thread-1',
      projectionId: 'event-2',
      messages: [],
      rotatedThroughTs: 2_000,
      contextUsage: {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 75_000,
        rawMetricName: 'cache_read_input_tokens',
      },
      observerOutput: {
        observations: [
          { date: '2026-07-25', time: '10:00', priority: 'low', text: 'Replay-safe.' },
        ],
        taskComplete: true,
        memoryUpdates: [
          { key: 'work:talon', value: 'Fresh baseline', mode: 'replace', type: 'note' },
          { key: 'work:talon', value: 'New append', mode: 'append', type: 'note' },
        ],
      },
    });

    expect(replacement.isOk()).toBe(true);
    expect(memory.get('work:talon')?.content).toBe('Fresh baseline\nNew append');
    const metadata = JSON.parse(memory.get('work:talon')!.metadata);
    expect(metadata[appliedAppendKey]).toEqual([
      oldMarker,
      'event-2:2000:append:1',
    ]);

    const staleReplay = projectContextObservation({
      repo,
      threadId: 'thread-1',
      projectionId: 'event-1',
      messages: [],
      rotatedThroughTs: 1_000,
      contextUsage: {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 75_000,
        rawMetricName: 'cache_read_input_tokens',
      },
      observerOutput: {
        observations: [
          { date: '2026-07-25', time: '10:00', priority: 'low', text: 'Stale replay.' },
        ],
        taskComplete: true,
        memoryUpdates: [
          { key: 'work:talon', value: 'Old append', mode: 'append', type: 'note' },
        ],
      },
    });

    expect(staleReplay.isOk()).toBe(true);
    if (staleReplay.isOk()) expect(staleReplay.value.memoryUpdatesApplied).toBe(0);
    expect(memory.get('work:talon')?.content).toBe('Fresh baseline\nNew append');
  });

  it('returns an error and keeps the session boundary untouched when projection transaction fails', () => {
    const repo = makeRepo({
      upsertByKey: vi.fn().mockImplementation((_threadId: string, key: string) =>
        key === 'work:bad' ? err(new Error('write failed')) : ok({}),
      ),
    });

    const result = projectContextObservation({
      repo,
      threadId: 'thread-1',
      projectionId: 'delivery-1',
      messages,
      rotatedThroughTs: 2_000,
      contextUsage: {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 75_000,
        rawMetricName: 'cache_read_input_tokens',
      },
      observerOutput: {
        observations: [
          { date: '2026-07-25', time: '10:00', priority: 'low', text: 'Will roll back.' },
        ],
        taskComplete: true,
        memoryUpdates: [{ key: 'work:bad', value: 'bad', mode: 'replace', type: 'note' }],
      },
    });

    expect(result.isErr()).toBe(true);
  });

  it('rejects invalid observation timestamps before writing formatted log content', () => {
    const repo = makeRepo();

    const result = projectContextObservation({
      repo,
      threadId: 'thread-1',
      projectionId: 'delivery-1',
      messages,
      rotatedThroughTs: 2_000,
      contextUsage: {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 75_000,
        rawMetricName: 'cache_read_input_tokens',
      },
      observerOutput: {
        observations: [
          { date: '2026-07-25\0', time: '10:00', priority: 'low', text: 'Unsafe timestamp.' },
        ],
        taskComplete: true,
        memoryUpdates: [],
      },
    });

    expect(result.isErr()).toBe(true);
    expect(repo.runInTransaction).not.toHaveBeenCalled();
    expect(repo.upsertByKey).not.toHaveBeenCalled();
  });

  it('atomically replaces observations with a stable consolidated reducer result', () => {
    const repo = makeRepo();

    const result = projectContextReduction({
      repo,
      threadId: 'thread-1',
      projectionId: 'reducer-delivery-1',
      observations: [
        {
          id: 'obs-new',
          content: 'new',
          metadata: JSON.stringify({
            rotatedThroughTs: 9_500,
            taskComplete: false,
            currentTask: 'Continue implementation',
            suggestedContinuation: 'Finish reducer',
          }),
          created_at: 10_000,
        },
        {
          id: 'obs-old',
          content: 'old',
          metadata: JSON.stringify({ rotatedThroughTs: 4_500 }),
          created_at: 5_000,
        },
      ],
      reducerOutput: {
        consolidatedLog: 'Date: 2026-07-25\n- consolidated',
      },
    });

    expect(result.isOk()).toBe(true);
    expect(repo.runInTransaction).toHaveBeenCalledOnce();
    expect(repo.delete).toHaveBeenCalledWith('thread-1', 'obs-new');
    expect(repo.delete).toHaveBeenCalledWith('thread-1', 'obs-old');
    expect(repo.upsertByKey).toHaveBeenCalledWith(
      'thread-1',
      'context-reduction:reducer-delivery-1:9500',
      expect.objectContaining({
        type: 'observation',
        content: 'Date: 2026-07-25\n- consolidated',
      }),
    );
    const metadata = JSON.parse(
      (repo.upsertByKey as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2].metadata,
    );
    expect(metadata.rotatedThroughTs).toBe(9_500);
    expect(metadata.taskComplete).toBe(false);
    expect(metadata.currentTask).toBe('Continue implementation');
    expect(metadata.suggestedContinuation).toBe('Finish reducer');
  });

  it('does not recreate a reduced observation when the original projection replays', () => {
    const memory = new Map<string, { content: string; metadata: string }>();
    const repo = makeStatefulRepo(memory);
    const observationInput = {
      repo,
      threadId: 'thread-1',
      projectionId: 'delivery-1:handler-1',
      messages: [],
      rotatedThroughTs: 2_000,
      contextUsage: {
        ratio: 0.5,
        inputTokens: 100_000,
        rawMetric: 75_000,
        rawMetricName: 'cache_read_input_tokens',
      },
      observerOutput: {
        observations: [
          { date: '2026-07-25', time: '10:00', priority: 'medium', text: 'Work continued.' },
        ],
        taskComplete: true,
        memoryUpdates: [],
      },
    };
    const observationId = 'context-observation:delivery-1:handler-1:2000';

    const projected = projectContextObservation(observationInput);
    expect(projected.isOk()).toBe(true);
    expect(memory.get(observationId)?.content).toBe('Date: 2026-07-25\n- 🟡 10:00 Work continued.');

    const reduced = projectContextReduction({
      repo,
      threadId: 'thread-1',
      projectionId: 'reducer-delivery-1',
      observations: [
        {
          id: observationId,
          content: memory.get(observationId)!.content,
          metadata: memory.get(observationId)!.metadata,
          created_at: 3_000,
        },
      ],
      reducerOutput: {
        consolidatedLog: 'Date: 2026-07-25\n- consolidated',
      },
      createdAt: '2026-07-25T10:00:00.000Z',
    });

    expect(reduced.isOk()).toBe(true);
    const reductionId = 'context-reduction:reducer-delivery-1:2000';
    expect(memory.get(reductionId)?.content).toBe('Date: 2026-07-25\n- consolidated');
    expect(memory.get(observationId)?.content).toBe('');
    expect(JSON.parse(memory.get(observationId)!.metadata)).toEqual(expect.objectContaining({
      source: 'context-projector-reduced-observation-tombstone',
      reducedInto: reductionId,
      rotatedThroughTs: 2_000,
    }));

    const replay = projectContextObservation(observationInput);
    expect(replay.isOk()).toBe(true);
    if (replay.isOk()) {
      expect(replay.value.memoryUpdatesApplied).toBe(0);
      expect(replay.value.preRollSaved).toBe(false);
    }
    expect(memory.get(observationId)?.content).toBe('');
    expect(memory.get(reductionId)?.content).toBe('Date: 2026-07-25\n- consolidated');
  });
});
