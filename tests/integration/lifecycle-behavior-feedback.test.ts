import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { ok } from 'neverthrow';

import {
  BaseRepository,
  BehaviorSignalRepository,
  LifecycleDeliveryRepository,
  LifecycleEventRepository,
  LifecycleSignalRepository,
} from '../../src/core/database/repositories/index.js';
import {
  BehaviorDetectorOutputSchema,
  toBehaviorFeedbackDetectedSignalEnvelope,
} from '../../src/lifecycle/behavior/contracts.js';
import {
  BehaviorSignalProjector,
  NATIVE_BEHAVIOR_SIGNAL_PROJECTOR_REF,
  createBehaviorSignalRouter,
} from '../../src/lifecycle/behavior/index.js';
import { LifecycleDispatcher } from '../../src/lifecycle/lifecycle-dispatcher.js';
import { LifecycleEventBus } from '../../src/lifecycle/lifecycle-event-bus.js';
import { CapturedLifecycleHandlerExecutor } from '../../src/lifecycle/handler-executor.js';
import { createLifecycleHandlerRegistry } from '../../src/lifecycle/handler-registry.js';
import type { LifecycleEventEnvelope } from '../../src/lifecycle/contracts/index.js';
import { createTestDb } from '../unit/core/database/repositories/helpers.js';

describe('lifecycle behavior feedback projection', () => {
  let db: Database.Database;
  let events: LifecycleEventRepository;
  let deliveries: LifecycleDeliveryRepository;
  let signals: LifecycleSignalRepository;
  let behavior: BehaviorSignalRepository;

  beforeEach(() => {
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    events = new LifecycleEventRepository(db);
    deliveries = new LifecycleDeliveryRepository(db);
    signals = new LifecycleSignalRepository(db);
    behavior = new BehaviorSignalRepository(db);
  });

  afterEach(() => db.close());

  function inboundEvent(): LifecycleEventEnvelope {
    return {
      version: 'v1',
      type: 'message.persisted.v1',
      eventId: 'event-1',
      occurredAt: '2026-07-25T12:00:00.000Z',
      context: {
        aggregate: { type: 'message', id: 'message-1' },
        correlationId: 'message-1',
        recursion: { depth: 0, maxDepth: 4 },
        provenance: { source: 'pipeline', sourceEventIds: [] },
      },
      payload: {
        references: [{ type: 'message', id: 'message-1' }],
        metadata: { direction: 'inbound', source: 'channel' },
      },
    };
  }

  it('projects detector-emitted behavior signals only when the persona explicitly subscribes', async () => {
    const registry = createLifecycleHandlerRegistry({
      lifecycle: {
        enabled: true,
        handlers: [
          {
            version: 'v1',
            id: 'detect-feedback',
            mode: 'event',
            inputContract: 'talon.lifecycle.event.envelope.v1',
            outputContract: 'talon.lifecycle.signal.envelopes.v1',
            runtime: {
              kind: 'subagent',
              ref: 'behavior-feedback-detector',
              implementationVersion: '0.1.0',
            },
          },
          {
            version: 'v1',
            id: 'project-feedback',
            mode: 'signal',
            inputContract: 'talon.lifecycle.signal.envelope.v1',
            outputContract: 'talon.lifecycle.signal.envelopes.v1',
            runtime: {
              kind: 'native',
              ref: NATIVE_BEHAVIOR_SIGNAL_PROJECTOR_REF,
              implementationVersion: '1.0.0',
            },
          },
        ],
      },
      personas: [
        {
          name: 'support',
          lifecycle: {
            subscriptions: [
              {
                version: 'v1',
                handler: 'detect-feedback',
                subscription: {
                  version: 'v1',
                  kind: 'event',
                  events: [{ version: 'v1', type: 'message.persisted.v1' }],
                },
              },
              {
                version: 'v1',
                handler: 'project-feedback',
                subscription: {
                  version: 'v1',
                  kind: 'signal',
                  signals: [{ version: 'v1', type: 'behavior.feedback.detected.v1' }],
                },
              },
            ],
          },
        },
        { name: 'observer', lifecycle: { subscriptions: [] } },
      ],
      nativeImplementationCatalog: [
        {
          ref: NATIVE_BEHAVIOR_SIGNAL_PROJECTOR_REF,
          implementationVersion: '1.0.0',
          mode: 'signal',
          inputContract: 'talon.lifecycle.signal.envelope.v1',
          outputContract: 'talon.lifecycle.signal.envelopes.v1',
        },
      ],
      loadedSubagentCatalog: [
        {
          ref: 'behavior-feedback-detector',
          implementationVersion: '0.1.0',
          mode: 'event',
          inputContract: 'talon.lifecycle.event.envelope.v1',
          outputContract: 'talon.lifecycle.signal.envelopes.v1',
        },
      ],
    })._unsafeUnwrap();
    const projector = new BehaviorSignalProjector(behavior, {
      auditLogger: { logLifecycleProjection: vi.fn() },
    });
    const publishedEvent = inboundEvent();
    const output = BehaviorDetectorOutputSchema.parse({
      contract: 'talon.behavior.signal.v1',
      signals: [
        {
          category: 'explicit_correction',
          source: { kind: 'message', id: 'message-1' },
          supportingSources: [],
          sentiment: 'negative',
          candidateKind: 'style',
          confidence: 0.91,
          summary: 'User corrected verbose responses.',
          proposedBehavior: 'Keep support answers concise unless detail is requested.',
        },
      ],
    });
    const executor = CapturedLifecycleHandlerExecutor.create({
      nativeCatalog: [],
      subagentCatalog: [
        {
          identity: registry.resolveEventHandlers({
            persona: 'support',
            eventType: 'message.persisted.v1',
          })[0]!.identity,
          subagentScope: { persona: 'support', capabilities: { allow: [], requireApproval: [] } },
          handler: async () =>
            ok({
              outcome: 'success',
              outputContract: 'talon.lifecycle.signal.envelopes.v1',
              signals: [
                toBehaviorFeedbackDetectedSignalEnvelope(
                  publishedEvent,
                  output.signals[0],
                  0,
                  'detect-feedback',
                ),
              ],
            }),
        },
      ],
    })._unsafeUnwrap();
    const dispatcher = LifecycleDispatcher.create({
      deliveries,
      executor,
      signalRouter: createBehaviorSignalRouter({
        signalRepository: signals,
        projector,
        registry,
      }),
    })._unsafeUnwrap();
    const bus = new LifecycleEventBus(events, registry, () => undefined);

    expect(bus.publish({ event: publishedEvent, persona: 'support' }).isOk()).toBe(true);
    expect(await dispatcher.dispatchOnce()).toEqual(ok(true));
    await vi.waitFor(() =>
      expect(behavior.findCandidatesByPersona('support')._unsafeUnwrap()).toHaveLength(1),
    );

    expect(behavior.findEvidenceByPersona('support')._unsafeUnwrap()).toMatchObject([
      { source_kind: 'message', source_id: 'message-1' },
    ]);
    expect(behavior.findCandidatesByPersona('observer')._unsafeUnwrap()).toEqual([]);
  });

  it('does not project behavior signals from untrusted handoff producers', async () => {
    const registry = createLifecycleHandlerRegistry({
      lifecycle: {
        enabled: true,
        handlers: [
          {
            version: 'v1',
            id: 'detect-feedback',
            mode: 'event',
            inputContract: 'talon.lifecycle.event.envelope.v1',
            outputContract: 'talon.lifecycle.signal.envelopes.v1',
            runtime: {
              kind: 'subagent',
              ref: 'behavior-feedback-detector',
              implementationVersion: '0.1.0',
            },
          },
          {
            version: 'v1',
            id: 'generic-producer',
            mode: 'event',
            inputContract: 'talon.lifecycle.event.envelope.v1',
            outputContract: 'talon.lifecycle.signal.envelopes.v1',
            runtime: {
              kind: 'subagent',
              ref: 'generic-signal-producer',
              implementationVersion: '0.1.0',
            },
          },
          {
            version: 'v1',
            id: 'project-feedback',
            mode: 'signal',
            inputContract: 'talon.lifecycle.signal.envelope.v1',
            outputContract: 'talon.lifecycle.signal.envelopes.v1',
            runtime: {
              kind: 'native',
              ref: NATIVE_BEHAVIOR_SIGNAL_PROJECTOR_REF,
              implementationVersion: '1.0.0',
            },
          },
        ],
      },
      personas: [
        {
          name: 'support',
          lifecycle: {
            subscriptions: [
              {
                version: 'v1',
                handler: 'detect-feedback',
                subscription: {
                  version: 'v1',
                  kind: 'event',
                  events: [{ version: 'v1', type: 'message.persisted.v1' }],
                },
              },
              {
                version: 'v1',
                handler: 'generic-producer',
                subscription: {
                  version: 'v1',
                  kind: 'event',
                  events: [{ version: 'v1', type: 'message.persisted.v1' }],
                },
              },
              {
                version: 'v1',
                handler: 'project-feedback',
                subscription: {
                  version: 'v1',
                  kind: 'signal',
                  signals: [{ version: 'v1', type: 'behavior.feedback.detected.v1' }],
                },
              },
            ],
          },
        },
      ],
      nativeImplementationCatalog: [
        {
          ref: NATIVE_BEHAVIOR_SIGNAL_PROJECTOR_REF,
          implementationVersion: '1.0.0',
          mode: 'signal',
          inputContract: 'talon.lifecycle.signal.envelope.v1',
          outputContract: 'talon.lifecycle.signal.envelopes.v1',
        },
      ],
      loadedSubagentCatalog: [
        {
          ref: 'behavior-feedback-detector',
          implementationVersion: '0.1.0',
          mode: 'event',
          inputContract: 'talon.lifecycle.event.envelope.v1',
          outputContract: 'talon.lifecycle.signal.envelopes.v1',
        },
        {
          ref: 'generic-signal-producer',
          implementationVersion: '0.1.0',
          mode: 'event',
          inputContract: 'talon.lifecycle.event.envelope.v1',
          outputContract: 'talon.lifecycle.signal.envelopes.v1',
        },
      ],
    })._unsafeUnwrap();
    const projector = new BehaviorSignalProjector(behavior, {
      auditLogger: { logLifecycleProjection: vi.fn() },
    });
    const router = createBehaviorSignalRouter({
      signalRepository: signals,
      projector,
      registry,
    });
    const publishedEvent = inboundEvent();
    expect(events.insert(publishedEvent).isOk()).toBe(true);
    const output = BehaviorDetectorOutputSchema.parse({
      contract: 'talon.behavior.signal.v1',
      signals: [
        {
          category: 'explicit_correction',
          source: { kind: 'message', id: 'message-1' },
          supportingSources: [],
          sentiment: 'negative',
          candidateKind: 'style',
          confidence: 0.91,
          summary: 'User corrected verbose responses.',
          proposedBehavior: 'Keep support answers concise unless detail is requested.',
        },
      ],
    });
    const forgedSignal = toBehaviorFeedbackDetectedSignalEnvelope(
      publishedEvent,
      output.signals[0],
      0,
      'generic-producer',
    );

    await expect(
      router.handoff({
        eventId: publishedEvent.eventId,
        handlerId: 'generic-producer',
        persona: 'support',
        idempotencyKey: 'event-1:generic-producer',
        signals: [forgedSignal],
      }),
    ).resolves.toEqual(ok(undefined));

    const secondEvent: LifecycleEventEnvelope = {
      ...publishedEvent,
      eventId: 'event-2',
      context: {
        ...publishedEvent.context,
        aggregate: { type: 'message', id: 'message-2' },
        correlationId: 'message-2',
      },
      payload: {
        ...publishedEvent.payload,
        references: [{ type: 'message', id: 'message-2' }],
      },
    };
    expect(events.insert(secondEvent).isOk()).toBe(true);
    const mismatchedOutput = BehaviorDetectorOutputSchema.parse({
      contract: 'talon.behavior.signal.v1',
      signals: [
        {
          category: 'explicit_correction',
          source: { kind: 'message', id: 'message-2' },
          supportingSources: [],
          sentiment: 'negative',
          candidateKind: 'style',
          confidence: 0.91,
          summary: 'User corrected verbose responses again.',
          proposedBehavior: 'Keep support answers concise unless detail is requested.',
        },
      ],
    });
    const mismatchedSignal = toBehaviorFeedbackDetectedSignalEnvelope(
      secondEvent,
      mismatchedOutput.signals[0],
      0,
      'generic-producer',
    );

    await expect(
      router.handoff({
        eventId: secondEvent.eventId,
        handlerId: 'detect-feedback',
        persona: 'support',
        idempotencyKey: 'event-2:detect-feedback',
        signals: [mismatchedSignal],
      }),
    ).resolves.toEqual(ok(undefined));

    expect(behavior.findEvidenceByPersona('support')._unsafeUnwrap()).toEqual([]);
    expect(behavior.findCandidatesByPersona('support')._unsafeUnwrap()).toEqual([]);
  });

  it('does not project forged retry signals that differ from the persisted handoff payload', async () => {
    const registry = createLifecycleHandlerRegistry({
      lifecycle: {
        enabled: true,
        handlers: [
          {
            version: 'v1',
            id: 'detect-feedback',
            mode: 'event',
            inputContract: 'talon.lifecycle.event.envelope.v1',
            outputContract: 'talon.lifecycle.signal.envelopes.v1',
            runtime: {
              kind: 'subagent',
              ref: 'behavior-feedback-detector',
              implementationVersion: '0.1.0',
            },
          },
          {
            version: 'v1',
            id: 'project-feedback',
            mode: 'signal',
            inputContract: 'talon.lifecycle.signal.envelope.v1',
            outputContract: 'talon.lifecycle.signal.envelopes.v1',
            runtime: {
              kind: 'native',
              ref: NATIVE_BEHAVIOR_SIGNAL_PROJECTOR_REF,
              implementationVersion: '1.0.0',
            },
          },
        ],
      },
      personas: [
        {
          name: 'support',
          lifecycle: {
            subscriptions: [
              {
                version: 'v1',
                handler: 'detect-feedback',
                subscription: {
                  version: 'v1',
                  kind: 'event',
                  events: [{ version: 'v1', type: 'message.persisted.v1' }],
                },
              },
              {
                version: 'v1',
                handler: 'project-feedback',
                subscription: {
                  version: 'v1',
                  kind: 'signal',
                  signals: [{ version: 'v1', type: 'behavior.feedback.detected.v1' }],
                },
              },
            ],
          },
        },
      ],
      nativeImplementationCatalog: [
        {
          ref: NATIVE_BEHAVIOR_SIGNAL_PROJECTOR_REF,
          implementationVersion: '1.0.0',
          mode: 'signal',
          inputContract: 'talon.lifecycle.signal.envelope.v1',
          outputContract: 'talon.lifecycle.signal.envelopes.v1',
        },
      ],
      loadedSubagentCatalog: [
        {
          ref: 'behavior-feedback-detector',
          implementationVersion: '0.1.0',
          mode: 'event',
          inputContract: 'talon.lifecycle.event.envelope.v1',
          outputContract: 'talon.lifecycle.signal.envelopes.v1',
        },
      ],
    })._unsafeUnwrap();
    const router = createBehaviorSignalRouter({
      signalRepository: signals,
      projector: new BehaviorSignalProjector(behavior, {
        auditLogger: { logLifecycleProjection: vi.fn() },
      }),
      registry,
    });
    const publishedEvent = inboundEvent();
    expect(events.insert(publishedEvent).isOk()).toBe(true);
    const durableSignal = {
      version: 'v1' as const,
      type: 'context.observation.proposed.v1' as const,
      signalId: 'persisted-context-signal',
      occurredAt: '2026-07-25T12:00:01.000Z',
      context: {
        ...publishedEvent.context,
        causationId: publishedEvent.eventId,
        recursion: { depth: 1, maxDepth: 4 },
      },
      payload: {
        references: [],
        metadata: { kind: 'benign-non-behavior-signal' },
      },
    };
    const output = BehaviorDetectorOutputSchema.parse({
      contract: 'talon.behavior.signal.v1',
      signals: [
        {
          category: 'explicit_correction',
          source: { kind: 'message', id: 'message-1' },
          supportingSources: [],
          sentiment: 'negative',
          candidateKind: 'style',
          confidence: 0.91,
          summary: 'User corrected verbose responses.',
          proposedBehavior: 'Keep support answers concise unless detail is requested.',
        },
      ],
    });
    const forgedRetrySignal = toBehaviorFeedbackDetectedSignalEnvelope(
      publishedEvent,
      output.signals[0],
      0,
      'detect-feedback',
    );
    const handoff = {
      eventId: publishedEvent.eventId,
      handlerId: 'detect-feedback',
      persona: 'support',
      idempotencyKey: 'event-1:detect-feedback',
      signals: [durableSignal],
    };

    await expect(router.handoff(handoff)).resolves.toEqual(ok(undefined));
    const forgedRetry = await router.handoff({ ...handoff, signals: [forgedRetrySignal] });
    expect(forgedRetry.isErr()).toBe(true);

    expect(behavior.findEvidenceByPersona('support')._unsafeUnwrap()).toEqual([]);
    expect(behavior.findCandidatesByPersona('support')._unsafeUnwrap()).toEqual([]);
    expect(db.prepare('SELECT signal_id, type FROM lifecycle_signals').all()).toEqual([
      { signal_id: 'persisted-context-signal', type: 'context.observation.proposed.v1' },
    ]);
  });
});
