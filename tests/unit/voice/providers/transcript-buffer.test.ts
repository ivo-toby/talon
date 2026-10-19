import { describe, expect, it } from 'vitest';
import { TranscriptBuffer } from '../../../../src/voice/providers/transcript-buffer.js';
import type { VoiceTranscriptFragment } from '../../../../src/voice/voice-types.js';

function fragment(overrides: Partial<VoiceTranscriptFragment>): VoiceTranscriptFragment {
  return {
    id: 'fragment',
    role: 'user',
    kind: 'delta',
    sequence: 1,
    text: 'hello',
    receivedAt: 1,
    ...overrides,
  };
}

describe('TranscriptBuffer', () => {
  it('deduplicates fragments, applies corrections, and orders late fragments by timing', () => {
    const buffer = new TranscriptBuffer({ maxFragments: 8, maxCharacters: 100, now: () => 42 });

    expect(
      buffer.append(fragment({ id: 'late', sequence: 2, text: 'later', startMs: 200, endMs: 300 }))
        .outcome,
    ).toBe('added');
    expect(
      buffer.append(fragment({ id: 'late', sequence: 3, text: 'later', startMs: 200, endMs: 300 }))
        .outcome,
    ).toBe('duplicate');
    expect(
      buffer.append(fragment({ id: 'first', sequence: 4, text: 'first', startMs: 0, endMs: 100 }))
        .outcome,
    ).toBe('added');
    expect(
      buffer.append(
        fragment({
          id: 'first',
          kind: 'correction',
          sequence: 5,
          text: 'corrected',
          startMs: 0,
          endMs: 100,
        }),
      ).outcome,
    ).toBe('corrected');

    expect(buffer.fragments.map((item) => item.id)).toEqual(['first', 'late']);
    expect(buffer.captureAt(100).snapshot?.text).toContain('corrected');
    expect(buffer.captureAt(100).snapshot?.text).not.toContain('later');
  });

  it('assembles incremental deltas while ignoring a repeated delta payload', () => {
    const buffer = new TranscriptBuffer({ maxFragments: 8, maxCharacters: 100 });

    buffer.append(fragment({ id: 'item', text: 'hello', sequence: 1 }));
    expect(buffer.append(fragment({ id: 'item', text: ' world', sequence: 2 })).outcome).toBe(
      'added',
    );
    expect(buffer.append(fragment({ id: 'item', text: ' world', sequence: 3 })).outcome).toBe(
      'duplicate',
    );

    expect(buffer.fragments[0]?.text).toBe('hello world');
  });

  it('keeps fragment and character limits bounded and marks context as truncated', () => {
    const buffer = new TranscriptBuffer({ maxFragments: 2, maxCharacters: 10 });
    buffer.append(fragment({ id: 'one', sequence: 1, text: '123456' }));
    buffer.append(fragment({ id: 'two', sequence: 2, text: 'abcdef' }));
    buffer.append(fragment({ id: 'three', sequence: 3, text: 'uvwxyz' }));

    expect(buffer.size).toBeLessThanOrEqual(2);
    expect(buffer.characterCount).toBeLessThanOrEqual(10);
    expect(buffer.truncated).toBe(true);
    expect(buffer.snapshot().snapshot?.truncated).toBe(true);
  });

  it('marks untimed context uncertain so callers can ask for clarification', () => {
    const buffer = new TranscriptBuffer({ maxFragments: 4, maxCharacters: 100 });
    buffer.append(fragment({ id: 'untimed', text: 'ambiguous request' }));

    const context = buffer.captureAt(100);

    expect(context.snapshot?.text).toContain('ambiguous request');
    expect(context.uncertain).toBe(true);
    expect(context.reason).toBe('untimed_fragment');
  });

  it('does not make user context uncertain for late assistant speech', () => {
    const buffer = new TranscriptBuffer({ maxFragments: 8, maxCharacters: 100 });
    buffer.append(fragment({ id: 'user', text: 'stable request', startMs: 0, endMs: 100 }));
    buffer.append(
      fragment({
        id: 'assistant-untimed',
        role: 'assistant',
        text: 'progress update',
        sequence: 2,
      }),
    );
    buffer.append(
      fragment({
        id: 'assistant-boundary',
        role: 'assistant',
        text: 'notification speech',
        sequence: 3,
        startMs: 150,
        endMs: 250,
      }),
    );

    const context = buffer.captureAt(100);

    expect(context.uncertain).toBe(false);
    expect(context.snapshot?.text).toContain('progress update');
    expect(context.snapshot?.text).not.toContain('notification speech');
  });

  it('includes a complete atomic chunk that straddles the delegation offset', () => {
    const buffer = new TranscriptBuffer({ maxFragments: 8, maxCharacters: 100 });
    buffer.append(
      fragment({
        id: 'atomic-first',
        text: 'first chunk',
        startMs: 0,
        endMs: 100,
        timing: 'atomic_chunk',
      }),
    );
    buffer.append(
      fragment({
        id: 'atomic-later',
        text: 'later turn',
        sequence: 2,
        startMs: 200,
        endMs: 300,
        timing: 'atomic_chunk',
      }),
    );

    const context = buffer.captureAt(50);

    expect(context.uncertain).toBe(false);
    expect(context.reason).toBeUndefined();
    expect(context.snapshot?.text).toContain('first chunk');
    expect(context.snapshot?.text).not.toContain('later turn');
  });

  it('keeps an unmarked overlapping fragment unsafe and does not coalesce atomic chunks', () => {
    const buffer = new TranscriptBuffer({ maxFragments: 8, maxCharacters: 100 });
    buffer.append(
      fragment({
        id: 'legacy-overlap',
        text: 'legacy overlap',
        startMs: 0,
        endMs: 100,
      }),
    );
    buffer.append(
      fragment({
        id: 'atomic-one',
        text: 'one',
        sequence: 2,
        startMs: 0,
        endMs: 100,
        timing: 'atomic_chunk',
      }),
    );
    buffer.append(
      fragment({
        id: 'atomic-two',
        text: 'two',
        sequence: 3,
        startMs: 0,
        endMs: 100,
        timing: 'atomic_chunk',
      }),
    );

    const context = buffer.captureAt(50);

    expect(context.uncertain).toBe(true);
    expect(context.reason).toBe('boundary_fragment');
    expect(buffer.fragments.map((item) => item.id)).toEqual([
      'legacy-overlap',
      'atomic-one',
      'atomic-two',
    ]);
    expect(context.snapshot?.digest).toBeDefined();
    expect(context.snapshot?.text).toContain('one');
    expect(context.snapshot?.text).toContain('two');
  });

  it('includes timing semantics in equality, delta fingerprints, and context digests', () => {
    const buffer = new TranscriptBuffer({ maxFragments: 8, maxCharacters: 100 });
    buffer.append(
      fragment({
        id: 'same-id',
        text: 'same',
        startMs: 0,
        endMs: 100,
        timing: 'atomic_chunk',
      }),
    );
    expect(
      buffer.append(
        fragment({
          id: 'same-id',
          text: 'same',
          startMs: 0,
          endMs: 100,
          timing: 'atomic_chunk',
          sequence: 2,
        }),
      ).outcome,
    ).toBe('duplicate');

    const atomicDigest = buffer.captureAt(50).snapshot?.digest;
    const unmarked = new TranscriptBuffer({ maxFragments: 8, maxCharacters: 100 });
    unmarked.append(fragment({ id: 'same-id', text: 'same', startMs: 0, endMs: 100 }));
    const unmarkedDigest = unmarked.captureAt(50).snapshot?.digest;

    expect(atomicDigest).not.toBe(unmarkedDigest);
    expect(buffer.fragments).toHaveLength(1);
  });

  it('keeps a corrected atomic fragment fail-closed at a boundary', () => {
    const buffer = new TranscriptBuffer({ maxFragments: 8, maxCharacters: 100 });
    buffer.append(
      fragment({
        id: 'atomic-correction',
        text: 'original',
        startMs: 0,
        endMs: 100,
        timing: 'atomic_chunk',
      }),
    );
    const corrected = buffer.append(
      fragment({
        id: 'atomic-correction',
        text: 'corrected',
        sequence: 2,
        startMs: 0,
        endMs: 100,
        timing: 'atomic_chunk',
      }),
    );

    expect(corrected.outcome).toBe('corrected');
    expect(corrected.fragment.kind).toBe('correction');
    expect(buffer.captureAt(50)).toMatchObject({ uncertain: true, reason: 'boundary_fragment' });
  });
});
