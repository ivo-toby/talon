import { describe, expect, it } from 'vitest';

import {
  BEHAVIOR_FEEDBACK_DETECTED_SIGNAL_TYPE,
  BEHAVIOR_SIGNAL_CONTRACT,
  BehaviorDetectorOutputSchema,
  BehaviorFeedbackDetectedSignalEnvelopeSchema,
  toBehaviorFeedbackDetectedSignalEnvelope,
} from '../../../src/lifecycle/behavior/contracts.js';
import type { LifecycleEventEnvelope } from '../../../src/lifecycle/contracts/index.js';

function event(overrides: Partial<LifecycleEventEnvelope> = {}): LifecycleEventEnvelope {
  return {
    version: 'v1',
    type: 'message.persisted.v1',
    eventId: 'event-1',
    occurredAt: '2026-07-25T12:00:00.000Z',
    context: {
      aggregate: { type: 'thread', id: 'thread-1' },
      correlationId: 'correlation-1',
      recursion: { depth: 0, maxDepth: 4 },
      provenance: { source: 'pipeline' },
    },
    payload: { references: [{ type: 'message', id: 'message-1' }], metadata: {} },
    ...overrides,
  };
}

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: 'explicit_correction',
    source: {
      kind: 'message',
      id: 'message-1',
      occurredAt: '2026-07-25T12:00:00.000Z',
      excerpt: 'Please stop being so verbose.',
    },
    supportingSources: [],
    sentiment: 'negative',
    candidateKind: 'style',
    confidence: 0.91,
    summary: 'User corrected the assistant for overly verbose responses.',
    proposedBehavior: 'Keep responses concise unless the user asks for detail.',
    ...overrides,
  };
}

describe('behavior signal contracts', () => {
  it('accepts strict talon.behavior.signal.v1 detector output and freezes it', () => {
    const parsed = BehaviorDetectorOutputSchema.parse({
      contract: BEHAVIOR_SIGNAL_CONTRACT,
      signals: [finding()],
    });

    expect(parsed.contract).toBe(BEHAVIOR_SIGNAL_CONTRACT);
    expect(parsed.signals).toHaveLength(1);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.signals[0])).toBe(true);
  });

  it('requires source, confidence, and proposed behavior', () => {
    for (const invalid of [
      { ...finding(), source: undefined },
      { ...finding(), confidence: 1.5 },
      { ...finding(), proposedBehavior: undefined },
      { ...finding(), extra: 'not allowed' },
    ]) {
      expect(() =>
        BehaviorDetectorOutputSchema.parse({
          contract: BEHAVIOR_SIGNAL_CONTRACT,
          signals: [invalid],
        }),
      ).toThrow();
    }
  });

  it('rejects malformed or overlong behavior text', () => {
    for (const proposedBehavior of [
      ' has leading whitespace',
      'contains\0nul',
      '\ud800',
      'x'.repeat(1025),
    ]) {
      expect(() =>
        BehaviorDetectorOutputSchema.parse({
          contract: BEHAVIOR_SIGNAL_CONTRACT,
          signals: [finding({ proposedBehavior })],
        }),
      ).toThrow();
    }
  });

  it('requires distinct supporting sources for inferred patterns', () => {
    expect(() =>
      BehaviorDetectorOutputSchema.parse({
        contract: BEHAVIOR_SIGNAL_CONTRACT,
        signals: [finding({ category: 'inferred_pattern', supportingSources: [] })],
      }),
    ).toThrow();

    const parsed = BehaviorDetectorOutputSchema.parse({
      contract: BEHAVIOR_SIGNAL_CONTRACT,
      signals: [
        finding({
          category: 'inferred_pattern',
          sentiment: 'neutral',
          supportingSources: [
            {
              kind: 'message',
              id: 'message-2',
              occurredAt: '2026-07-25T12:01:00.000Z',
            },
          ],
        }),
      ],
    });

    expect(parsed.signals[0].supportingSources).toHaveLength(1);
  });

  it('converts detector findings into causally linked lifecycle signal envelopes', () => {
    const parsed = BehaviorDetectorOutputSchema.parse({
      contract: BEHAVIOR_SIGNAL_CONTRACT,
      signals: [finding()],
    });

    const envelope = toBehaviorFeedbackDetectedSignalEnvelope(event(), parsed.signals[0], 0);

    expect(envelope.type).toBe(BEHAVIOR_FEEDBACK_DETECTED_SIGNAL_TYPE);
    expect(envelope.context.causationId).toBe('event-1');
    expect(envelope.context.recursion.depth).toBe(1);
    expect(envelope.payload.metadata.contract).toBe(BEHAVIOR_SIGNAL_CONTRACT);
    expect(envelope.payload.references).toEqual([{ type: 'message', id: 'message-1' }]);
    expect(envelope.payload.metadata.sourceId).toBe('message-1');
    expect(envelope.payload.metadata.sourceOccurredAt).toBe('2026-07-25T12:00:00.000Z');
    expect(envelope.payload.metadata.provenanceInputEventId).toBe('event-1');
    expect(envelope.payload.metadata.provenanceInputEventType).toBe('message.persisted.v1');
    expect(envelope.payload.metadata.proposedBehavior).toBe(
      'Keep responses concise unless the user asks for detail.',
    );
    expect(BehaviorFeedbackDetectedSignalEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('trusts tool_call references for tool failure behavior evidence', () => {
    const parsed = BehaviorDetectorOutputSchema.parse({
      contract: BEHAVIOR_SIGNAL_CONTRACT,
      signals: [
        finding({
          category: 'tool_failure',
          source: {
            kind: 'tool_call',
            id: 'tool-call-1',
            occurredAt: '2026-07-25T12:00:00.000Z',
            excerpt: 'Tool call failed.',
          },
          sentiment: 'negative',
          candidateKind: 'tooling',
          summary: 'A trusted lifecycle tool call failed.',
          proposedBehavior: 'Account for this tool failure pattern in future runs.',
        }),
      ],
    });
    const envelope = toBehaviorFeedbackDetectedSignalEnvelope(
      event({
        type: 'provider.tool.completed.v1',
        context: {
          aggregate: { type: 'tool_call', id: 'tool-call-1' },
          correlationId: 'run-1',
          recursion: { depth: 0, maxDepth: 4 },
          provenance: { source: 'tool' },
        },
        payload: {
          references: [
            { type: 'tool_call', id: 'tool-call-1' },
            { type: 'run', id: 'run-1' },
          ],
          metadata: { status: 'error' },
        },
      }),
      parsed.signals[0],
      0,
    );

    expect(envelope.payload.references).toEqual([{ type: 'tool_call', id: 'tool-call-1' }]);
    expect(envelope.payload.metadata.sourceKind).toBe('tool_call');
    expect(envelope.payload.metadata.sourceId).toBe('tool-call-1');
  });

  it('rejects detector source ids absent from trusted lifecycle references', () => {
    const parsed = BehaviorDetectorOutputSchema.parse({
      contract: BEHAVIOR_SIGNAL_CONTRACT,
      signals: [
        finding({
          source: { kind: 'message', id: 'forged-message-id' },
        }),
      ],
    });

    expect(() => toBehaviorFeedbackDetectedSignalEnvelope(event(), parsed.signals[0], 0)).toThrow(
      /not present in trusted lifecycle references/,
    );
  });
});
