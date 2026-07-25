import { describe, expect, it } from 'vitest';

import {
  CONTEXT_OBSERVER_OUTPUT_CONTRACT,
  CONTEXT_REDUCER_OUTPUT_CONTRACT,
  ContextObserverInputSchema,
  ContextObserverOutputSchema,
  ContextReducerInputSchema,
  ContextReducerOutputSchema,
} from '../../../../src/lifecycle/context/context-contracts.js';

describe('context contracts', () => {
  it('accepts strict observer input and output contracts', () => {
    expect(ContextObserverInputSchema.parse({ transcript: '[turn 1, user]: hello' })).toEqual({
      transcript: '[turn 1, user]: hello',
    });

    const parsed = ContextObserverOutputSchema.parse({
      observations: [
        { date: '2026-07-25', time: '10:15', priority: 'high', text: 'User asked for context projection.' },
      ],
      taskComplete: false,
      currentTask: 'Context projection',
      suggestedContinuation: 'Continue wiring the projector.',
      memoryUpdates: [
        { key: 'work:talon', value: 'Context projector added.', mode: 'append' },
      ],
    });

    expect(parsed.contract).toBe(CONTEXT_OBSERVER_OUTPUT_CONTRACT);
    expect(parsed.taskComplete).toBe(false);
    expect(parsed.memoryUpdates).toHaveLength(1);
  });

  it('rejects malformed observer output instead of silently accepting it', () => {
    expect(() =>
      ContextObserverOutputSchema.parse({
        observations: [
          { date: '2026-07-25', time: '10:15', priority: 'urgent', text: 'bad priority' },
        ],
        memoryUpdates: [
          { key: '', value: 'missing key', mode: 'append' },
        ],
      }),
    ).toThrow();
  });

  it('rejects unsafe or malformed observation timestamps', () => {
    const validObservation = {
      date: '2026-07-25',
      time: '10:15',
      priority: 'high',
      text: 'Valid observation.',
    };

    for (const observation of [
      { ...validObservation, date: '2026-02-30' },
      { ...validObservation, date: '2026-07-25\0' },
      { ...validObservation, time: '24:00' },
      { ...validObservation, time: '10:\ud800' },
    ]) {
      expect(() =>
        ContextObserverOutputSchema.parse({
          observations: [observation],
          memoryUpdates: [],
        }),
      ).toThrow();
    }
  });

  it('rejects unexpected fields at context boundaries', () => {
    expect(() =>
      ContextObserverOutputSchema.parse({
        observations: [],
        taskComplete: true,
        repository: 'must-not-cross-boundary',
      }),
    ).toThrow();
  });

  it('accepts strict reducer input and output contracts', () => {
    expect(ContextReducerInputSchema.parse({ observationLog: 'Date: 2026-07-25\n- note' })).toEqual({
      observationLog: 'Date: 2026-07-25\n- note',
    });

    const parsed = ContextReducerOutputSchema.parse({
      consolidatedLog: 'Date: 2026-07-25\n- consolidated',
    });

    expect(parsed.contract).toBe(CONTEXT_REDUCER_OUTPUT_CONTRACT);
  });
});
