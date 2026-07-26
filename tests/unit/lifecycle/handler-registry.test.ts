import { describe, expect, it } from 'vitest';

import {
  LIFECYCLE_ADVISORY_INTERCEPTOR_OUTPUT_CONTRACT,
  LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT,
  LIFECYCLE_EVENT_INPUT_CONTRACT,
  LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT,
  LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
  LIFECYCLE_SIGNAL_INPUT_CONTRACT,
  LifecycleEventEnvelopeSchema,
  LifecycleEventSubscriptionContractSchema,
  LifecycleFilterContractSchema,
  LifecycleConfigSchema,
  LifecycleHandlerContractSchema,
  LifecycleInterceptorEnvelopeSchema,
  LifecycleInterceptorResultSchema,
  LifecycleInterceptorTransformSchema,
  LifecycleHandlerResultSchema,
  parseLifecycleHandlerResult,
  resolveLifecycleHandlerContract,
  LifecycleSignalEnvelopeSchema,
  LifecycleSignalSubscriptionContractSchema,
  LifecycleInterceptorSubscriptionContractSchema,
  LifecycleRuntimeNameSchema,
  PersonaLifecycleConfigSchema,
} from '../../../src/lifecycle/contracts/index.js';
import {
  createLifecycleHandlerRegistry,
  type LifecycleLoadedSubagentRegistration,
  type LifecycleNativeImplementationRegistration,
  type LifecycleRegistryInput,
} from '../../../src/lifecycle/handler-registry.js';

function nativeRegistration(
  ref: string,
  overrides: Partial<LifecycleNativeImplementationRegistration> = {},
): LifecycleNativeImplementationRegistration {
  const mode = overrides.mode ?? 'event';
  const interceptorSafety =
    mode === 'interceptor' ? (overrides.interceptorSafety ?? 'advisory') : undefined;
  const inputContract =
    overrides.inputContract ??
    (mode === 'event'
      ? LIFECYCLE_EVENT_INPUT_CONTRACT
      : mode === 'signal'
        ? LIFECYCLE_SIGNAL_INPUT_CONTRACT
        : LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT);
  const outputContract =
    overrides.outputContract ??
    (mode === 'interceptor'
      ? interceptorSafety === 'enforcing'
        ? LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT
        : LIFECYCLE_ADVISORY_INTERCEPTOR_OUTPUT_CONTRACT
      : LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT);

  return {
    ref,
    implementationVersion: overrides.implementationVersion ?? '1.0.0',
    mode,
    inputContract,
    outputContract,
    ...(interceptorSafety ? { interceptorSafety } : {}),
  };
}

function loadedSubagentRegistration(
  ref: string,
  overrides: Partial<LifecycleLoadedSubagentRegistration> = {},
): LifecycleLoadedSubagentRegistration {
  return {
    ...nativeRegistration(ref, overrides),
    ...overrides,
  };
}

function makeRegistryInput(): LifecycleRegistryInput {
  return {
    lifecycle: {
      enabled: true,
      handlers: [
        {
          version: 'v1',
          id: 'context-projector',
          mode: 'event',
          inputContract: LIFECYCLE_EVENT_INPUT_CONTRACT,
          outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
          runtime: {
            kind: 'native',
            ref: 'context-projector',
            implementationVersion: '1.0.0',
          },
          failurePolicy: {
            version: 'v1',
            mode: 'preserve_session',
          },
        },
        {
          version: 'v1',
          id: 'audit-log',
          mode: 'event',
          inputContract: LIFECYCLE_EVENT_INPUT_CONTRACT,
          outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
          runtime: {
            kind: 'native',
            ref: 'audit-log',
            implementationVersion: '1.0.0',
          },
          budget: {
            version: 'v1',
            timeoutMs: 2_000,
          },
          failurePolicy: {
            version: 'v1',
            mode: 'dead_letter',
          },
        },
      ],
    },
    channels: [{ name: 'terminal' }, { name: 'slack' }],
    nativeImplementationCatalog: [
      nativeRegistration('context-projector'),
      nativeRegistration('audit-log'),
      nativeRegistration('signal-audit', { mode: 'signal' }),
      nativeRegistration('native-interceptor', { mode: 'interceptor' }),
    ],
    personas: [
      {
        name: 'assistant',
        lifecycle: {
          subscriptions: [
            {
              version: 'v1',
              handler: 'audit-log',
              priority: 10,
              subscription: {
                version: 'v1',
                kind: 'event',
                events: [{ version: 'v1', type: 'message.persisted.v1' }],
                filter: {
                  version: 'v1',
                  channels: ['terminal'],
                  messageSources: ['inbound'],
                },
              },
              budget: {
                version: 'v1',
                timeoutMs: 3_500,
              },
            },
            {
              version: 'v1',
              handler: 'context-projector',
              priority: 100,
              subscription: {
                version: 'v1',
                kind: 'event',
                events: [{ version: 'v1', type: 'message.persisted.v1' }],
              },
            },
          ],
        },
      },
      { name: 'observer' },
    ],
  };
}

function makeEventEnvelope(): Record<string, unknown> {
  return {
    version: 'v1',
    type: 'message.persisted.v1',
    eventId: 'event-1',
    occurredAt: '2026-07-15T19:00:00.000Z',
    context: {
      aggregate: { type: 'thread', id: 'thread-1' },
      correlationId: 'correlation-1',
      recursion: { depth: 0, maxDepth: 1 },
      provenance: { source: 'message-pipeline', sourceEventIds: [], sourceReferences: [] },
    },
    payload: {
      references: [{ type: 'message', id: 'message-1' }],
      metadata: { source: 'inbound' },
    },
  };
}

interface CausalInvocation {
  readonly version: 'v1';
  readonly eventId?: string;
  readonly signalId?: string;
  readonly interceptionId?: string;
  readonly context: {
    readonly aggregate: { readonly type: string; readonly id: string };
    readonly correlationId: string;
    readonly recursion: { readonly depth: number; readonly maxDepth: number };
    readonly provenance: {
      readonly source: string;
      readonly sourceEventIds: string[];
      readonly sourceReferences: Array<{ type: string; id: string }>;
    };
  };
}

interface DerivedSignal {
  version: 'v1';
  type: 'context.rotate.requested.v1';
  signalId: string;
  occurredAt: string;
  context: {
    aggregate: { type: string; id: string };
    correlationId: string;
    causationId?: string;
    recursion: { depth: number; maxDepth: number };
    provenance: {
      source: string;
      sourceEventIds: string[];
      sourceReferences: Array<{ type: string; id: string }>;
    };
  };
  payload: { references: never[]; metadata: Record<string, unknown> };
}

function makeCausallyDerivedSignal(
  invocation: CausalInvocation,
  metadata: Record<string, unknown> = {},
): DerivedSignal {
  const causationId = invocation.eventId ?? invocation.signalId ?? invocation.interceptionId;
  return {
    version: 'v1',
    type: 'context.rotate.requested.v1',
    signalId: 'derived-signal-1',
    occurredAt: '2026-07-15T19:00:01.000Z',
    context: {
      aggregate: { ...invocation.context.aggregate },
      correlationId: invocation.context.correlationId,
      causationId,
      recursion: {
        depth: invocation.context.recursion.depth + 1,
        maxDepth: invocation.context.recursion.maxDepth,
      },
      provenance: {
        source: invocation.context.provenance.source,
        sourceEventIds: [...invocation.context.provenance.sourceEventIds],
        sourceReferences: [...invocation.context.provenance.sourceReferences],
      },
    },
    payload: { references: [], metadata },
  };
}

describe('LifecycleHandlerRegistry', () => {
  it('validates bounded runtime envelopes and the complete interceptor outcome union', () => {
    const context = {
      aggregate: { type: 'thread', id: 'thread-1' },
      correlationId: 'correlation-1',
      causationId: 'event-0',
      recursion: { depth: 1, maxDepth: 4 },
      provenance: { source: 'message-pipeline', sourceEventIds: ['event-0'], sourceReferences: [] },
    };

    expect(
      LifecycleEventEnvelopeSchema.safeParse({
        version: 'v1',
        type: 'message.persisted.v1',
        eventId: 'event-1',
        occurredAt: '2026-07-15T19:00:00.000Z',
        context,
        payload: {
          references: [{ type: 'message', id: 'message-1' }],
          metadata: { source: 'inbound' },
        },
      }).success,
    ).toBe(true);
    expect(
      LifecycleSignalEnvelopeSchema.safeParse({
        version: 'v1',
        type: 'behavior.feedback.detected.v1',
        signalId: 'signal-1',
        occurredAt: '2026-07-15T19:00:00.000Z',
        context,
        payload: { references: [], metadata: {} },
      }).success,
    ).toBe(true);
    expect(
      LifecycleEventEnvelopeSchema.safeParse({
        version: 'v1',
        type: 'unregistered.event.v1',
        eventId: 'event-1',
        occurredAt: '2026-07-15T19:00:00.000Z',
        context,
        payload: { references: [], metadata: {} },
      }).success,
    ).toBe(false);
    expect(
      LifecycleEventEnvelopeSchema.safeParse({
        version: 'v1',
        type: 'message.persisted.v1',
        eventId: 'event-1',
        occurredAt: '2026-07-15T19:00:00.000Z',
        context: { ...context, recursion: { depth: 5, maxDepth: 4 } },
        payload: { references: [], metadata: {} },
      }).success,
    ).toBe(false);
    expect(
      LifecycleEventEnvelopeSchema.safeParse({
        version: 'v1',
        type: 'message.persisted.v1',
        eventId: ' event-1 ',
        occurredAt: '2026-07-15T19:00:00.000Z',
        context,
        payload: { references: [], metadata: {} },
      }).success,
    ).toBe(false);
    expect(
      LifecycleEventEnvelopeSchema.safeParse({
        version: 'v1',
        type: 'message.persisted.v1',
        eventId: 'x'.repeat(257),
        occurredAt: '2026-07-15T19:00:00.000Z',
        context,
        payload: { references: [], metadata: {} },
      }).success,
    ).toBe(false);
    expect(
      LifecycleEventEnvelopeSchema.safeParse({
        version: 'v1',
        type: 'message.persisted.v1',
        eventId: 'event-1',
        occurredAt: '2026-07-15T19:00:00.000Z',
        context,
        payload: { references: [], metadata: { a: true, ' a ': false } },
      }).success,
    ).toBe(false);
    expect(
      LifecycleEventEnvelopeSchema.safeParse({
        version: 'v1',
        type: 'message.persisted.v1',
        eventId: 'event-1',
        occurredAt: '2026-07-15T19:00:00.000Z',
        context,
        payload: { references: [], metadata: { ' prefixed': true } },
      }).success,
    ).toBe(false);
    expect(
      LifecycleEventEnvelopeSchema.safeParse({
        version: 'v1',
        type: 'message.persisted.v1',
        eventId: 'event-1',
        occurredAt: '2026-07-15T19:00:00.000Z',
        context,
        payload: { references: [], metadata: { 'suffixed ': true } },
      }).success,
    ).toBe(false);
    expect(
      LifecycleEventEnvelopeSchema.safeParse({
        version: 'v1',
        type: 'message.persisted.v1',
        eventId: 'event-1',
        occurredAt: '2026-07-15T19:00:00.000Z',
        context,
        payload: { references: [], metadata: { title: 'x'.repeat(1_025) } },
      }).success,
    ).toBe(false);
    expect(
      LifecycleEventEnvelopeSchema.safeParse({
        version: 'v1',
        type: 'message.persisted.v1',
        eventId: 'event-1',
        occurredAt: '2026-07-15T19:00:00.000Z',
        context,
        payload: { references: [], metadata: { title: 'contains\0nul' } },
      }).success,
    ).toBe(false);
    expect(
      LifecycleEventEnvelopeSchema.safeParse({
        version: 'v1',
        type: 'message.persisted.v1',
        eventId: 'event-1',
        occurredAt: '2026-07-15T19:00:00.000Z',
        context,
        payload: { references: [], metadata: { title: '\ud800' } },
      }).success,
    ).toBe(false);
    expect(
      LifecycleEventEnvelopeSchema.safeParse({
        version: 'v1',
        type: 'message.persisted.v1',
        eventId: 'event-1',
        occurredAt: '2026-07-15T19:00:00.000Z',
        context,
        payload: { references: [], metadata: { A: true, Ａ: false } },
      }).success,
    ).toBe(false);
    expect(
      LifecycleEventEnvelopeSchema.safeParse({
        version: 'v1',
        type: 'message.persisted.v1',
        eventId: 'event-1',
        occurredAt: '2026-07-15T19:00:00.000Z',
        context: { ...context, aggregate: { type: 'a'.repeat(129), id: 'thread-1' } },
        payload: { references: [], metadata: {} },
      }).success,
    ).toBe(false);
    expect(
      LifecycleHandlerContractSchema.safeParse({
        version: 'v1',
        id: 'a'.repeat(129),
        mode: 'event',
        inputContract: LIFECYCLE_EVENT_INPUT_CONTRACT,
        outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
        runtime: { kind: 'native', ref: 'context-projector', implementationVersion: '1.0.0' },
      }).success,
    ).toBe(false);
    expect(LifecycleRuntimeNameSchema.safeParse(`runtime\u0085name`).success).toBe(false);
    expect(
      LifecycleHandlerContractSchema.safeParse({
        version: 'v1',
        id: 'event-with-interceptor-safety',
        mode: 'event',
        interceptorSafety: 'advisory',
        inputContract: LIFECYCLE_EVENT_INPUT_CONTRACT,
        outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
        runtime: { kind: 'native', ref: 'context-projector', implementationVersion: '1.0.0' },
      }).success,
    ).toBe(false);
    expect(
      LifecycleHandlerContractSchema.safeParse({
        version: 'v1',
        id: 'subagent-enforcer',
        mode: 'interceptor',
        interceptorSafety: 'enforcing',
        inputContract: LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT,
        outputContract: LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT,
        runtime: { kind: 'subagent', ref: 'review-agent', implementationVersion: '1.0.0' },
      }).success,
    ).toBe(false);
    expect(
      LifecycleInterceptorEnvelopeSchema.safeParse({
        version: 'v1',
        interceptionId: 'intercept-1',
        context,
        hook: 'tool.before_execute',
        input: {
          toolCallId: 'tool-1',
          toolName: 'calendar-create',
          arguments: { duration: 30, 'all-day': false },
        },
      }).success,
    ).toBe(true);

    let accessorInvoked = false;
    const accessorArguments: Record<string, unknown> = {};
    Object.defineProperty(accessorArguments, 'secret', {
      enumerable: true,
      get: () => {
        accessorInvoked = true;
        return 'must-not-run';
      },
    });
    expect(
      LifecycleInterceptorTransformSchema.safeParse({
        hook: 'tool.before_execute',
        arguments: accessorArguments,
      }).success,
    ).toBe(false);
    expect(accessorInvoked).toBe(false);

    const symbolArguments = { safe: true };
    Object.defineProperty(symbolArguments, Symbol('hidden'), { value: true, enumerable: true });
    expect(
      LifecycleInterceptorTransformSchema.safeParse({
        hook: 'tool.before_execute',
        arguments: symbolArguments,
      }).success,
    ).toBe(false);

    const mutableArguments = { nested: { before: true } };
    const parsedArguments = LifecycleInterceptorEnvelopeSchema.parse({
      version: 'v1',
      interceptionId: 'intercept-detached-tool',
      context,
      hook: 'tool.before_execute',
      input: {
        toolCallId: 'tool-detached',
        toolName: 'calendar-create',
        arguments: mutableArguments,
      },
    });
    mutableArguments.nested.before = false;
    expect(parsedArguments.input.arguments).toEqual({ nested: { before: true } });
    expect(parsedArguments.input.arguments).not.toBe(mutableArguments);

    const mutableContextAdditions = { trace: { enabled: true } };
    const parsedContextAdditions = LifecycleInterceptorTransformSchema.parse({
      hook: 'run.before_execute',
      contextAdditions: mutableContextAdditions,
    });
    mutableContextAdditions.trace.enabled = false;
    expect(parsedContextAdditions.contextAdditions).toEqual({ trace: { enabled: true } });
    expect(parsedContextAdditions.contextAdditions).not.toBe(mutableContextAdditions);
    expect(
      LifecycleInterceptorEnvelopeSchema.safeParse({
        version: 'v1',
        interceptionId: 'intercept-1',
        context,
        hook: 'tool.before_execute',
        input: {
          toolCallId: 'tool-1',
          toolName: 'net_http.request',
          arguments: {
            headers: { Authorization: 'Bearer token', 'x-request-id': 'request-1' },
            db_query: { params: [{ id: 1 }, { id: 2 }] },
            subagent_invoke: { input: { task: 'summarize', options: { concise: true } } },
            execution_environment: { resources: { cpus: 2, memoryMb: 4096 } },
          },
        },
      }).success,
    ).toBe(true);
    const deeplyNestedArguments = Array.from({ length: 7 }).reduce<unknown>(
      (value) => ({ nested: value }),
      'value',
    );
    expect(
      LifecycleInterceptorEnvelopeSchema.safeParse({
        version: 'v1',
        interceptionId: 'intercept-1',
        context,
        hook: 'tool.before_execute',
        input: {
          toolCallId: 'tool-1',
          toolName: 'net_http.request',
          arguments: { payload: deeplyNestedArguments },
        },
      }).success,
    ).toBe(false);
    expect(
      LifecycleInterceptorEnvelopeSchema.safeParse({
        version: 'v1',
        interceptionId: 'intercept-1',
        context,
        hook: 'tool.before_execute',
        input: {
          toolCallId: 'tool-1',
          toolName: 'net_http.request',
          arguments: { headers: { Authorization: 'x'.repeat(4_097) } },
        },
      }).success,
    ).toBe(false);

    const validInterceptorInputs = [
      {
        hook: 'message.before_persist',
        input: { messageId: 'message-1', content: 'hello', source: 'inbound' },
      },
      {
        hook: 'run.before_execute',
        input: { runId: 'run-1', provider: 'codex', model: 'gpt-5', persona: 'assistant' },
      },
      {
        hook: 'tool.before_execute',
        input: {
          toolCallId: 'tool-1',
          toolName: 'calendar-create',
          arguments: { duration: 30 },
        },
      },
      {
        hook: 'message.before_send',
        input: {
          messageId: 'message-1',
          content: 'hello',
          source: 'outbound',
          recipientId: 'recipient-1',
        },
      },
    ] as const;
    for (const interceptor of validInterceptorInputs) {
      expect(
        LifecycleInterceptorEnvelopeSchema.safeParse({
          version: 'v1',
          interceptionId: 'intercept-1',
          context,
          ...interceptor,
        }).success,
      ).toBe(true);
    }
    for (const interceptor of validInterceptorInputs) {
      const mismatchedInput = validInterceptorInputs.find(
        (candidate) => candidate.hook !== interceptor.hook,
      )!.input;
      expect(
        LifecycleInterceptorEnvelopeSchema.safeParse({
          version: 'v1',
          interceptionId: 'intercept-1',
          context,
          hook: interceptor.hook,
          input: mismatchedInput,
        }).success,
      ).toBe(false);
    }

    const ownerName = ` ${'owner-name-'.repeat(13)}x `;
    expect(ownerName.length).toBeGreaterThan(128);
    expect(
      LifecycleInterceptorEnvelopeSchema.safeParse({
        version: 'v1',
        interceptionId: 'intercept-owner-name',
        context,
        hook: 'message.before_persist',
        input: {
          messageId: 'message-owner-name',
          content: 'hello',
          source: 'inbound',
          channel: ownerName,
          persona: ownerName,
        },
      }).success,
    ).toBe(true);
    expect(
      LifecycleInterceptorEnvelopeSchema.safeParse({
        version: 'v1',
        interceptionId: 'intercept-owner-name-run',
        context,
        hook: 'run.before_execute',
        input: { runId: 'run-owner-name', provider: 'codex', model: 'gpt-5', persona: ownerName },
      }).success,
    ).toBe(true);
    expect(
      LifecycleInterceptorEnvelopeSchema.safeParse({
        version: 'v1',
        interceptionId: 'intercept-runtime-name',
        context,
        hook: 'run.before_execute',
        input: {
          runId: 'run-runtime-name',
          provider: ownerName,
          model: 'gpt-5',
          persona: 'assistant',
        },
      }).success,
    ).toBe(false);
    expect(
      LifecycleInterceptorEnvelopeSchema.safeParse({
        version: 'v1',
        interceptionId: 'intercept-tool-name',
        context,
        hook: 'tool.before_execute',
        input: { toolCallId: 'tool-runtime-name', toolName: ownerName, arguments: {} },
      }).success,
    ).toBe(false);

    for (const result of [
      { outcome: 'allow', signals: [] },
      { outcome: 'deny', reason: 'policy denied', signals: [] },
      {
        outcome: 'require_approval',
        reason: 'approval needed',
        approvalKey: 'approval-1',
        signals: [],
      },
      {
        outcome: 'transform',
        transform: { hook: 'message.before_persist', content: 'redacted' },
        signals: [],
      },
      {
        outcome: 'error',
        code: 'timeout',
        message: 'handler timed out',
        retryable: true,
        signals: [],
      },
    ]) {
      expect(LifecycleInterceptorResultSchema.safeParse(result).success).toBe(true);
    }

    for (const transform of [
      { hook: 'message.before_persist', content: 'redacted' },
      { hook: 'message.before_send', content: 'redacted' },
      {
        hook: 'run.before_execute',
        contextAdditions: { executionEnvironment: { resources: { memoryMb: 4096 } } },
      },
      { hook: 'tool.before_execute', arguments: { duration: 30 } },
      {
        hook: 'tool.before_execute',
        argumentsPatch: { headers: { 'x-trace': 'trace-1' } },
      },
    ]) {
      expect(LifecycleInterceptorTransformSchema.safeParse(transform).success).toBe(true);
    }
    expect(
      LifecycleInterceptorTransformSchema.safeParse({
        hook: 'run.before_execute',
        contextAdditions: {},
      }).success,
    ).toBe(false);
    expect(
      LifecycleInterceptorTransformSchema.safeParse({
        hook: 'tool.before_execute',
        argumentsPatch: {},
      }).success,
    ).toBe(false);
    expect(
      LifecycleInterceptorTransformSchema.safeParse({
        hook: 'tool.before_execute',
        argumentsPatch: { trace: true },
      }).success,
    ).toBe(true);
    expect(
      LifecycleInterceptorTransformSchema.safeParse({
        hook: 'tool.before_execute',
        arguments: {},
      }).success,
    ).toBe(true);
    expect(
      LifecycleInterceptorTransformSchema.safeParse({
        hook: 'tool.before_execute',
        content: 'redacted',
      }).success,
    ).toBe(false);
    const validNestedToolArguments = {
      request: {
        headers: { authorization: 'Bearer redacted', 'x-trace': 'trace-1' },
        payload: [{ role: 'user', content: 'nested real tool arguments' }],
      },
    };
    expect(
      LifecycleInterceptorEnvelopeSchema.safeParse({
        version: 'v1',
        interceptionId: 'intercept-nested-tool',
        context,
        hook: 'tool.before_execute',
        input: {
          toolCallId: 'tool-nested',
          toolName: 'Tool.Http:Send',
          arguments: validNestedToolArguments,
        },
      }).success,
    ).toBe(true);

    const multibyteStringAtCharacterLimit = '😀'.repeat(2_048);
    expect(multibyteStringAtCharacterLimit).toHaveLength(4_096);

    const multibyteUnderByteLimit = Array.from(
      { length: 3 },
      () => multibyteStringAtCharacterLimit,
    );
    expect(
      LifecycleInterceptorTransformSchema.safeParse({
        hook: 'tool.before_execute',
        arguments: { multibyteUnderByteLimit },
      }).success,
    ).toBe(true);

    const multibyteOverByteLimit = Array.from({ length: 4 }, () => multibyteStringAtCharacterLimit);
    expect(
      new TextEncoder().encode(JSON.stringify({ multibyteOverByteLimit })).byteLength,
    ).toBeGreaterThan(32_768);
    expect(
      LifecycleInterceptorTransformSchema.safeParse({
        hook: 'tool.before_execute',
        arguments: { multibyteOverByteLimit },
      }).success,
    ).toBe(false);

    let veryDeepObject: Record<string, unknown> = {};
    for (let index = 0; index < 10_000; index += 1) {
      veryDeepObject = { nested: veryDeepObject };
    }
    expect(() =>
      LifecycleInterceptorTransformSchema.safeParse({
        hook: 'tool.before_execute',
        arguments: veryDeepObject,
      }),
    ).not.toThrow();
    expect(
      LifecycleInterceptorTransformSchema.safeParse({
        hook: 'tool.before_execute',
        arguments: veryDeepObject,
      }).success,
    ).toBe(false);

    const cyclicArguments: Record<string, unknown> = {};
    cyclicArguments.self = cyclicArguments;
    expect(() =>
      LifecycleInterceptorTransformSchema.safeParse({
        hook: 'tool.before_execute',
        arguments: cyclicArguments,
      }),
    ).not.toThrow();
    expect(
      LifecycleInterceptorTransformSchema.safeParse({
        hook: 'tool.before_execute',
        arguments: cyclicArguments,
      }).success,
    ).toBe(false);
    for (const transform of [
      { hook: 'message.before_send' },
      { hook: 'run.before_execute' },
      { hook: 'tool.before_execute' },
      { hook: 'tool.before_execute', arguments: {}, argumentsPatch: {} },
    ]) {
      expect(LifecycleInterceptorTransformSchema.safeParse(transform).success).toBe(false);
    }
    const enforcingHandler = LifecycleHandlerContractSchema.parse({
      version: 'v1',
      id: 'native-enforcer',
      mode: 'interceptor',
      interceptorSafety: 'enforcing',
      inputContract: LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT,
      outputContract: LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT,
      runtime: { kind: 'native', ref: 'Native.Enforcer/V2', implementationVersion: '1.0.0' },
    });
    const toolInvocation = {
      version: 'v1' as const,
      interceptionId: 'intercept-1',
      context,
      hook: 'tool.before_execute' as const,
      input: { toolCallId: 'tool-1', toolName: 'Tool.Http:Send', arguments: {} },
    };
    expect(
      parseLifecycleHandlerResult(enforcingHandler, toolInvocation, {
        outcome: 'success',
        outputContract: LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT,
        result: {
          outcome: 'transform',
          transform: { hook: 'message.before_send', content: 'redacted' },
          signals: [],
        },
      }).success,
    ).toBe(false);
    const hookHidingToolInvocation = new Proxy(toolInvocation, {
      get: (target, property, receiver) =>
        property === 'hook' ? 'tool.before_execute' : Reflect.get(target, property, receiver),
      has: (target, property) => (property === 'hook' ? false : Reflect.has(target, property)),
    });
    expect(
      parseLifecycleHandlerResult(enforcingHandler, hookHidingToolInvocation, {
        outcome: 'success',
        outputContract: LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT,
        result: {
          outcome: 'transform',
          transform: { hook: 'message.before_send', content: 'redacted' },
          signals: [],
        },
      }).success,
    ).toBe(false);
    expect(
      parseLifecycleHandlerResult(enforcingHandler, hookHidingToolInvocation, {
        outcome: 'success',
        outputContract: LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT,
        result: {
          outcome: 'transform',
          transform: {
            hook: 'tool.before_execute',
            argumentsPatch: { trace: true },
          },
          signals: [],
        },
      }).success,
    ).toBe(true);
    expect(
      parseLifecycleHandlerResult(enforcingHandler, toolInvocation, {
        outcome: 'success',
        outputContract: LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT,
        result: { outcome: 'allow', signals: [] },
      }).success,
    ).toBe(true);
    const mismatchedModeHandler = {
      ...enforcingHandler,
      mode: 'event',
    } as typeof enforcingHandler;
    expect(
      parseLifecycleHandlerResult(mismatchedModeHandler, toolInvocation, {
        outcome: 'success',
        outputContract: LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT,
        result: { outcome: 'deny', reason: 'must not parse', signals: [] },
      }).success,
    ).toBe(false);
    const mismatchedSafetyHandler = {
      ...enforcingHandler,
      interceptorSafety: 'advisory',
    };
    expect(
      parseLifecycleHandlerResult(mismatchedSafetyHandler, toolInvocation, {
        outcome: 'success',
        outputContract: LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT,
        result: { outcome: 'deny', reason: 'must not parse', signals: [] },
      }).success,
    ).toBe(false);
    const enforcingSubagentHandler = {
      ...enforcingHandler,
      runtime: { ...enforcingHandler.runtime, kind: 'subagent' as const },
    };
    expect(
      parseLifecycleHandlerResult(enforcingSubagentHandler, toolInvocation, {
        outcome: 'success',
        outputContract: LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT,
        result: { outcome: 'deny', reason: 'must not parse', signals: [] },
      }).success,
    ).toBe(false);
    expect(() =>
      LifecycleHandlerResultSchema.safeParse({
        outcome: 'success',
        outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
        signals: [],
      }),
    ).not.toThrow();
  });

  it('accepts only causally derived signals from event, signal, and interceptor invocations', () => {
    const context = {
      aggregate: { type: 'thread', id: 'thread-causal' },
      correlationId: 'correlation-causal',
      recursion: { depth: 0, maxDepth: 2 },
      provenance: { source: 'message-pipeline', sourceEventIds: [], sourceReferences: [] },
    };
    const eventInput = {
      version: 'v1' as const,
      type: 'message.persisted.v1' as const,
      eventId: 'event-causal',
      occurredAt: '2026-07-15T19:00:00.000Z',
      context,
      payload: { references: [], metadata: {} },
    };
    const signalInput = {
      version: 'v1' as const,
      type: 'behavior.feedback.detected.v1' as const,
      signalId: 'signal-causal',
      occurredAt: '2026-07-15T19:00:00.000Z',
      context: { ...context, recursion: { depth: 1, maxDepth: 3 } },
      payload: { references: [], metadata: {} },
    };
    const interceptorInput = {
      version: 'v1' as const,
      interceptionId: 'interception-causal',
      context,
      hook: 'message.before_persist' as const,
      input: { messageId: 'message-causal', content: 'hello', source: 'inbound' as const },
    };
    const eventHandler = makeRegistryInput().lifecycle!.handlers[0]!;
    const signalHandler = LifecycleHandlerContractSchema.parse({
      version: 'v1',
      id: 'signal-projector',
      mode: 'signal',
      inputContract: LIFECYCLE_SIGNAL_INPUT_CONTRACT,
      outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
      runtime: { kind: 'native', ref: 'signal-projector', implementationVersion: '1.0.0' },
    });
    const interceptorHandler = LifecycleHandlerContractSchema.parse({
      version: 'v1',
      id: 'interceptor-advisor',
      mode: 'interceptor',
      inputContract: LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT,
      outputContract: LIFECYCLE_ADVISORY_INTERCEPTOR_OUTPUT_CONTRACT,
      runtime: { kind: 'native', ref: 'interceptor-advisor', implementationVersion: '1.0.0' },
    });
    const eventSignal = makeCausallyDerivedSignal(eventInput);

    expect(
      parseLifecycleHandlerResult(eventHandler, eventInput, {
        outcome: 'success',
        outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
        signals: [eventSignal],
      }).success,
    ).toBe(true);
    expect(
      parseLifecycleHandlerResult(signalHandler, signalInput, {
        outcome: 'success',
        outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
        signals: [makeCausallyDerivedSignal(signalInput)],
      }).success,
    ).toBe(true);
    expect(
      parseLifecycleHandlerResult(interceptorHandler, interceptorInput, {
        outcome: 'success',
        outputContract: LIFECYCLE_ADVISORY_INTERCEPTOR_OUTPUT_CONTRACT,
        result: { outcome: 'advisory', signals: [makeCausallyDerivedSignal(interceptorInput)] },
      }).success,
    ).toBe(true);

    const forgedContexts = [
      { ...eventSignal.context, aggregate: { type: 'thread', id: 'other-thread' } },
      { ...eventSignal.context, correlationId: 'other-correlation' },
      { ...eventSignal.context, causationId: 'forged-causation' },
      { ...eventSignal.context, causationId: undefined },
      {
        ...eventSignal.context,
        recursion: { depth: 1, maxDepth: eventSignal.context.recursion.maxDepth + 1 },
      },
      {
        ...eventSignal.context,
        recursion: { depth: 0, maxDepth: eventSignal.context.recursion.maxDepth },
      },
    ];
    for (const forgedContext of forgedContexts) {
      expect(
        parseLifecycleHandlerResult(eventHandler, eventInput, {
          outcome: 'success',
          outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
          signals: [{ ...eventSignal, context: forgedContext }],
        }).success,
      ).toBe(false);
    }

    const recursionBoundaryInput = {
      ...eventInput,
      eventId: 'event-recursion-boundary',
      context: { ...context, recursion: { depth: 2, maxDepth: 2 } },
    };
    const boundarySignal = makeCausallyDerivedSignal(recursionBoundaryInput);
    boundarySignal.context = {
      ...boundarySignal.context,
      recursion: { depth: 2, maxDepth: 2 },
    };
    expect(
      parseLifecycleHandlerResult(eventHandler, recursionBoundaryInput, {
        outcome: 'success',
        outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
        signals: [boundarySignal],
      }).success,
    ).toBe(false);
  });

  it('defaults omitted metadata in causally valid enforcing interceptor signals', () => {
    const context = {
      aggregate: { type: 'thread', id: 'thread-omitted-metadata' },
      correlationId: 'correlation-omitted-metadata',
      recursion: { depth: 0, maxDepth: 2 },
      provenance: { source: 'message-pipeline', sourceEventIds: [], sourceReferences: [] },
    };
    const input = {
      version: 'v1' as const,
      interceptionId: 'interception-omitted-metadata',
      context,
      hook: 'tool.before_execute' as const,
      input: { toolCallId: 'tool-omitted-metadata', toolName: 'Tool.Http:Send', arguments: {} },
    };
    const handler = LifecycleHandlerContractSchema.parse({
      version: 'v1',
      id: 'enforcer-omitted-metadata',
      mode: 'interceptor',
      interceptorSafety: 'enforcing',
      inputContract: LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT,
      outputContract: LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT,
      runtime: { kind: 'native', ref: 'enforcer-omitted-metadata', implementationVersion: '1.0.0' },
    });
    const signal = makeCausallyDerivedSignal(input);
    delete (signal.payload as { metadata?: unknown }).metadata;

    const parsed = parseLifecycleHandlerResult(handler, input, {
      outcome: 'success',
      outputContract: LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT,
      result: { outcome: 'allow', signals: [signal] },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.outcome !== 'error') {
      expect(parsed.data.result.signals[0]?.payload.metadata).toEqual({});
    }
  });

  it('materializes ordinary handler signal metadata without executing hostile accessors', () => {
    const handler = makeRegistryInput().lifecycle!.handlers[0]!;
    const input = makeEventEnvelope();
    const parse = (metadata: unknown) =>
      parseLifecycleHandlerResult(handler, input, {
        outcome: 'success',
        outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
        signals: [makeCausallyDerivedSignal(input, metadata as Record<string, unknown>)],
      });

    const accepted = parse({
      'customer.custom': 'retained',
      outcome: true,
      entries: 3,
      metadata: null,
    });
    expect(accepted.success).toBe(true);
    if (accepted.success && accepted.data.outcome !== 'error') {
      expect(accepted.data.signals[0]?.payload.metadata).toEqual({
        'customer.custom': 'retained',
        outcome: true,
        entries: 3,
        metadata: null,
      });
    }

    const protoMetadata = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(protoMetadata, '__proto__', {
      configurable: true,
      enumerable: true,
      value: 'retained',
      writable: true,
    });
    const protoAccepted = parse(protoMetadata);
    expect(protoAccepted.success).toBe(true);
    if (protoAccepted.success && protoAccepted.data.outcome !== 'error') {
      const metadata = protoAccepted.data.signals[0]!.payload.metadata;
      expect(Object.getPrototypeOf(metadata)).toBeNull();
      expect(metadata.__proto__).toBe('retained');
    }

    expect(parse({ A: 1, Ａ: 2 }).success).toBe(false);
    expect(parse({ A: 1, Ａ: 2 }).success).toBe(false);

    let accessorCalls = 0;
    const accessorEntry = {};
    Object.defineProperty(accessorEntry, 'never-read', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return 'never-read';
      },
    });
    expect(parse(accessorEntry).success).toBe(false);
    expect(accessorCalls).toBe(0);

    let proxyTraps = 0;
    const metadataProxy = new Proxy(
      {},
      {
        get() {
          proxyTraps += 1;
          throw new Error('proxy trap');
        },
        getOwnPropertyDescriptor() {
          proxyTraps += 1;
          throw new Error('proxy trap');
        },
      },
    );
    expect(parse(metadataProxy).success).toBe(false);
    expect(proxyTraps).toBe(0);

    let unknownGetterCalls = 0;
    const boundedMetadata: Record<string, unknown> = {};
    const ordinaryRecord: Record<string, unknown> = {};
    for (let index = 0; index < 4_096; index += 1) {
      Object.defineProperty(boundedMetadata, `unknown-${index}`, {
        enumerable: true,
        get() {
          unknownGetterCalls += 1;
          throw new Error('unknown metadata must not be read');
        },
      });
      Object.defineProperty(ordinaryRecord, `unknown-${index}`, {
        enumerable: true,
        get() {
          unknownGetterCalls += 1;
          throw new Error('ordinary metadata must not be enumerated');
        },
      });
    }
    expect(parse(boundedMetadata).success).toBe(false);
    expect(parse(ordinaryRecord).success).toBe(false);
    expect(unknownGetterCalls).toBe(0);
  });

  it('strictly rejects unknown handler-output fields without executing their accessors', () => {
    const handler = makeRegistryInput().lifecycle!.handlers[0]!;
    const input = makeEventEnvelope();
    const output = {
      outcome: 'success' as const,
      outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
      signals: [makeCausallyDerivedSignal(input)],
    };
    let topLevelGetterCalls = 0;
    Object.defineProperty(output, 'unexpected', {
      enumerable: true,
      get() {
        topLevelGetterCalls += 1;
        throw new Error('unknown top-level output field must not be read');
      },
    });

    expect(parseLifecycleHandlerResult(handler, input, output).success).toBe(false);
    expect(topLevelGetterCalls).toBe(0);

    const nestedOutput = {
      outcome: 'success' as const,
      outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
      signals: [makeCausallyDerivedSignal(input)],
    };
    let nestedGetterCalls = 0;
    Object.defineProperty(nestedOutput.signals[0]!.context, 'unexpected', {
      enumerable: true,
      get() {
        nestedGetterCalls += 1;
        throw new Error('unknown nested output field must not be read');
      },
    });

    expect(parseLifecycleHandlerResult(handler, input, nestedOutput).success).toBe(false);
    expect(nestedGetterCalls).toBe(0);
  });

  it('resolves explicitly attached event handlers in deterministic priority order', () => {
    const result = createLifecycleHandlerRegistry(makeRegistryInput());

    expect(result.isOk()).toBe(true);
    const registry = result._unsafeUnwrap();
    const handlers = registry.resolveEventHandlers({
      persona: 'assistant',
      eventType: 'message.persisted.v1',
      channel: 'terminal',
      messageSource: 'inbound',
    });

    expect(handlers.map((handler) => handler.handler.id)).toEqual([
      'context-projector',
      'audit-log',
    ]);
    expect(handlers[0]?.identity).toEqual({
      version: 'v1',
      handlerId: 'context-projector',
      runtimeKind: 'native',
      implementationRef: 'context-projector',
      implementationVersion: '1.0.0',
      mode: 'event',
      inputContract: LIFECYCLE_EVENT_INPUT_CONTRACT,
      outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
    });
    expect(handlers[1]?.budget).toEqual({
      version: 'v1',
      timeoutMs: 3_500,
    });
  });

  it('does not resolve handlers when filters do not match', () => {
    const result = createLifecycleHandlerRegistry(makeRegistryInput());

    expect(result.isOk()).toBe(true);
    const registry = result._unsafeUnwrap();
    const handlers = registry.resolveEventHandlers({
      persona: 'assistant',
      eventType: 'message.persisted.v1',
      channel: 'slack',
      messageSource: 'inbound',
    });

    expect(handlers.map((handler) => handler.handler.id)).toEqual(['context-projector']);
  });

  it('accepts the full persona and channel owner-name domain with exact matching', () => {
    const ownerName = ` ${'owner-name-'.repeat(13)}x `;
    const input = makeRegistryInput();
    input.personas[0]!.name = ownerName;
    input.channels![0]!.name = ownerName;
    const subscription = input.personas[0]!.lifecycle!.subscriptions[0]!.subscription;
    if (subscription.kind === 'event') {
      subscription.filter = {
        version: 'v1',
        personas: [ownerName],
        channels: [ownerName],
        messageSources: ['inbound'],
      };
    }

    const registry = createLifecycleHandlerRegistry(input)._unsafeUnwrap();
    expect(
      registry
        .resolveEventHandlers({
          persona: ownerName,
          eventType: 'message.persisted.v1',
          channel: ownerName,
          messageSource: 'inbound',
        })
        .map((handler) => handler.handler.id),
    ).toEqual(['context-projector', 'audit-log']);
    expect(
      registry
        .resolveEventHandlers({
          persona: ownerName,
          eventType: 'message.persisted.v1',
          channel: ownerName.trim(),
          messageSource: 'inbound',
        })
        .map((handler) => handler.handler.id),
    ).toEqual(['context-projector']);
  });

  it('rejects oversized durable persona owners only when lifecycle is enabled', () => {
    const oversizedOwner = '😀'.repeat(257);
    const input = makeRegistryInput();
    input.personas[0]!.name = oversizedOwner;

    const enabled = createLifecycleHandlerRegistry(input);
    expect(enabled.isErr()).toBe(true);
    expect(enabled._unsafeUnwrapErr().message).toMatch(/256 Unicode scalars and 1024 UTF-8 bytes/i);

    expect(createLifecycleHandlerRegistry({ personas: [{ name: oversizedOwner }] }).isOk()).toBe(
      true,
    );
    expect(
      createLifecycleHandlerRegistry({
        lifecycle: { enabled: false, handlers: [] },
        personas: [{ name: oversizedOwner }],
      }).isOk(),
    ).toBe(true);
  });

  it('returns an empty registry when lifecycle is omitted entirely', () => {
    const result = createLifecycleHandlerRegistry({
      personas: [{ name: 'assistant' }],
    });

    expect(result.isOk()).toBe(true);
    const registry = result._unsafeUnwrap();
    expect(registry.isEnabled()).toBe(false);
    expect(
      registry.resolveEventHandlers({
        persona: 'assistant',
        eventType: 'message.persisted.v1',
      }),
    ).toEqual([]);
  });

  it('does not resolve attached handlers when lifecycle is explicitly disabled', () => {
    const input = makeRegistryInput();
    if (input.lifecycle) {
      input.lifecycle.enabled = false;
      input.lifecycle.handlers[0]!.runtime.ref = 'not-bootstrapped';
      input.lifecycle.handlers.push({
        ...input.lifecycle.handlers[1]!,
        id: 'unloaded-subagent',
        runtime: { kind: 'subagent', ref: 'unloaded-subagent', implementationVersion: '1.0.0' },
      });
    }
    input.nativeImplementationCatalog = [];
    input.loadedSubagentCatalog = [];

    const result = createLifecycleHandlerRegistry(input);

    expect(result.isOk()).toBe(true);
    const registry = result._unsafeUnwrap();
    expect(
      registry.resolveEventHandlers({
        persona: 'assistant',
        eventType: 'message.persisted.v1',
        channel: 'terminal',
        messageSource: 'inbound',
      }),
    ).toEqual([]);

    input.lifecycle!.handlers[0]!.inputContract = 'talon.lifecycle.unknown.input.v1';
    expect(createLifecycleHandlerRegistry(input).isErr()).toBe(true);
  });

  it('rejects duplicate handler ids', () => {
    const input = makeRegistryInput();
    input.lifecycle?.handlers.push({
      version: 'v1',
      id: 'audit-log',
      mode: 'signal',
      inputContract: LIFECYCLE_SIGNAL_INPUT_CONTRACT,
      outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
      runtime: {
        kind: 'native',
        ref: 'signal-audit',
        implementationVersion: '1.0.0',
      },
    });

    const result = createLifecycleHandlerRegistry(input);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(
      /duplicate lifecycle handler id "audit-log"/i,
    );
  });

  it('rejects duplicate persona and channel names before name-keyed resolution', () => {
    const enforcingHandler = {
      version: 'v1' as const,
      id: 'native-enforcer',
      mode: 'interceptor' as const,
      interceptorSafety: 'enforcing' as const,
      inputContract: LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT,
      outputContract: LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT,
      runtime: { kind: 'native' as const, ref: 'native-enforcer', implementationVersion: '1.0.0' },
    };
    const duplicatePersona = createLifecycleHandlerRegistry({
      lifecycle: { enabled: true, handlers: [enforcingHandler] },
      nativeImplementationCatalog: [
        nativeRegistration('native-enforcer', {
          mode: 'interceptor',
          interceptorSafety: 'enforcing',
        }),
      ],
      personas: [
        {
          name: 'assistant',
          lifecycle: {
            subscriptions: [
              {
                version: 'v1',
                handler: 'native-enforcer',
                subscription: {
                  version: 'v1',
                  kind: 'interceptor',
                  interceptors: [{ version: 'v1', hook: 'tool.before_execute' }],
                },
              },
            ],
          },
        },
        { name: 'assistant' },
      ],
    });
    expect(duplicatePersona.isErr()).toBe(true);
    expect(duplicatePersona._unsafeUnwrapErr().message).toMatch(
      /duplicate persona name "assistant"/i,
    );

    const duplicateChannel = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      channels: [{ name: 'terminal' }, { name: 'terminal' }],
    });
    expect(duplicateChannel.isErr()).toBe(true);
    expect(duplicateChannel._unsafeUnwrapErr().message).toMatch(
      /duplicate channel name "terminal"/i,
    );
  });

  it('rejects persona subscriptions that reference missing handlers', () => {
    const input = makeRegistryInput();
    input.personas[0].lifecycle?.subscriptions.push({
      version: 'v1',
      handler: 'missing-handler',
      subscription: {
        version: 'v1',
        kind: 'event',
        events: [{ version: 'v1', type: 'message.persisted.v1' }],
      },
    });

    const result = createLifecycleHandlerRegistry(input);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(
      /references unknown lifecycle handler "missing-handler"/i,
    );
  });

  it('rejects incompatible subscription kinds for a handler mode', () => {
    const input = makeRegistryInput();
    input.personas[0].lifecycle = {
      subscriptions: [
        {
          version: 'v1',
          handler: 'audit-log',
          subscription: {
            version: 'v1',
            kind: 'signal',
            signals: [{ version: 'v1', type: 'context.rotate.requested.v1' }],
          },
        },
      ],
    };

    const result = createLifecycleHandlerRegistry(input);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(
      /handler "audit-log" has mode "event" but subscription kind is "signal"/i,
    );
  });

  it('allows a native advisory interceptor to fail open explicitly', () => {
    const input = makeRegistryInput();
    input.lifecycle?.handlers.push({
      version: 'v1',
      id: 'native-interceptor',
      mode: 'interceptor',
      inputContract: LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT,
      outputContract: LIFECYCLE_ADVISORY_INTERCEPTOR_OUTPUT_CONTRACT,
      interceptorSafety: 'advisory',
      runtime: {
        kind: 'native',
        ref: 'native-interceptor',
        implementationVersion: '1.0.0',
      },
      failurePolicy: {
        version: 'v1',
        mode: 'fail_open',
      },
    });
    input.personas[0].lifecycle = {
      subscriptions: [
        {
          version: 'v1',
          handler: 'native-interceptor',
          subscription: {
            version: 'v1',
            kind: 'interceptor',
            interceptors: [{ version: 'v1', hook: 'message.before_persist' }],
          },
        },
      ],
    };

    const result = createLifecycleHandlerRegistry(input);

    expect(result.isOk()).toBe(true);
  });

  it('orders equal-priority handlers by stable identifier, independent of locale', () => {
    const input = makeRegistryInput();
    input.lifecycle?.handlers.push({
      version: 'v1',
      id: 'alpha-handler',
      mode: 'event',
      inputContract: LIFECYCLE_EVENT_INPUT_CONTRACT,
      outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
      runtime: { kind: 'native', ref: 'audit-log', implementationVersion: '1.0.0' },
    });
    input.personas[0].lifecycle?.subscriptions.push({
      version: 'v1',
      handler: 'alpha-handler',
      priority: 10,
      subscription: {
        version: 'v1',
        kind: 'event',
        events: [{ version: 'v1', type: 'message.persisted.v1' }],
      },
    });

    const result = createLifecycleHandlerRegistry(input);

    expect(result.isOk()).toBe(true);
    expect(
      result
        ._unsafeUnwrap()
        .resolveEventHandlers({
          persona: 'assistant',
          eventType: 'message.persisted.v1',
          channel: 'terminal',
          messageSource: 'inbound',
        })
        .map((handler) => handler.handler.id),
    ).toEqual(['context-projector', 'alpha-handler', 'audit-log']);
  });

  it('resolves signal and interceptor subscriptions and applies attachment policy overrides', () => {
    const input = makeRegistryInput();
    input.nativeImplementationCatalog = [
      ...(input.nativeImplementationCatalog ?? []),
      nativeRegistration('signal-handler', { mode: 'signal' }),
    ];
    input.lifecycle?.handlers.push(
      {
        version: 'v1',
        id: 'signal-handler',
        mode: 'signal',
        inputContract: LIFECYCLE_SIGNAL_INPUT_CONTRACT,
        outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
        runtime: { kind: 'native', ref: 'signal-handler', implementationVersion: '1.0.0' },
      },
      {
        version: 'v1',
        id: 'native-interceptor',
        mode: 'interceptor',
        interceptorSafety: 'advisory',
        inputContract: LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT,
        outputContract: LIFECYCLE_ADVISORY_INTERCEPTOR_OUTPUT_CONTRACT,
        runtime: { kind: 'native', ref: 'native-interceptor', implementationVersion: '1.0.0' },
        failurePolicy: { version: 'v1', mode: 'fail_open' },
      },
    );
    input.personas[0].lifecycle?.subscriptions.push(
      {
        version: 'v1',
        handler: 'signal-handler',
        subscription: {
          version: 'v1',
          kind: 'signal',
          signals: [{ version: 'v1', type: 'behavior.feedback.detected.v1' }],
        },
      },
      {
        version: 'v1',
        handler: 'native-interceptor',
        failurePolicy: { version: 'v1', mode: 'fail_open' },
        subscription: {
          version: 'v1',
          kind: 'interceptor',
          interceptors: [{ version: 'v1', hook: 'tool.before_execute' }],
        },
      },
    );

    const result = createLifecycleHandlerRegistry(input);

    expect(result.isOk()).toBe(true);
    const registry = result._unsafeUnwrap();
    expect(
      registry.resolveSignalHandlers({
        persona: 'assistant',
        signalType: 'behavior.feedback.detected.v1',
      }),
    ).toHaveLength(1);
    expect(
      registry.resolveInterceptorHandlers({ persona: 'assistant', hook: 'tool.before_execute' })[0]
        ?.failurePolicy.mode,
    ).toBe('fail_open');
  });

  it('default-denies unknown contracts and unresolved implementation references', () => {
    const input = makeRegistryInput();
    input.lifecycle!.handlers[0]!.runtime.ref = 'missing-native';

    const result = createLifecycleHandlerRegistry(input);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(/not in the bootstrap catalog/i);
    const subagentResult = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      lifecycle: {
        ...makeRegistryInput().lifecycle!,
        handlers: [
          {
            ...makeRegistryInput().lifecycle!.handlers[0]!,
            runtime: { kind: 'subagent', ref: 'missing-subagent', implementationVersion: '1.0.0' },
          },
        ],
      },
    });
    expect(subagentResult.isErr()).toBe(true);
    expect(subagentResult._unsafeUnwrapErr().message).toMatch(/loaded subagent catalog/i);
  });

  it('requires a native handler to exactly match bootstrap-owned authority', () => {
    const input = makeRegistryInput();
    input.lifecycle!.handlers[1] = {
      ...input.lifecycle!.handlers[1]!,
      mode: 'interceptor',
      interceptorSafety: 'enforcing',
      inputContract: LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT,
      outputContract: LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT,
      failurePolicy: { version: 'v1', mode: 'fail_closed' },
    };

    const result = createLifecycleHandlerRegistry(input);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(
      /must exactly match an authoritative bootstrap capability/i,
    );
  });

  it('supports distinct native capabilities for one authoritative ref', () => {
    const input = makeRegistryInput();
    input.nativeImplementationCatalog = [
      ...(input.nativeImplementationCatalog ?? []),
      nativeRegistration('multi-capability'),
      nativeRegistration('multi-capability', { mode: 'signal' }),
    ];
    input.lifecycle!.handlers.push({
      version: 'v1',
      id: 'multi-capability-signal',
      mode: 'signal',
      inputContract: LIFECYCLE_SIGNAL_INPUT_CONTRACT,
      outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
      runtime: { kind: 'native', ref: 'multi-capability', implementationVersion: '1.0.0' },
    });
    input.personas[0].lifecycle!.subscriptions.push({
      version: 'v1',
      handler: 'multi-capability-signal',
      subscription: {
        version: 'v1',
        kind: 'signal',
        signals: [{ version: 'v1', type: 'behavior.feedback.detected.v1' }],
      },
    });

    const result = createLifecycleHandlerRegistry(input);

    expect(result.isOk()).toBe(true);
    expect(
      result._unsafeUnwrap().resolveSignalHandlers({
        persona: 'assistant',
        signalType: 'behavior.feedback.detected.v1',
      })[0]?.identity,
    ).toMatchObject({
      implementationRef: 'multi-capability',
      implementationVersion: '1.0.0',
      mode: 'signal',
      inputContract: LIFECYCLE_SIGNAL_INPUT_CONTRACT,
    });

    const conflictingVersion = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      nativeImplementationCatalog: [
        nativeRegistration('conflicting-capability'),
        nativeRegistration('conflicting-capability', { implementationVersion: '2.0.0' }),
      ],
    });
    expect(conflictingVersion.isErr()).toBe(true);
    expect(conflictingVersion._unsafeUnwrapErr().message).toMatch(
      /conflicts with an authoritative implementation version/i,
    );

    const duplicateCapability = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      nativeImplementationCatalog: [
        nativeRegistration('duplicate-capability'),
        nativeRegistration('duplicate-capability'),
      ],
    });
    expect(duplicateCapability.isErr()).toBe(true);
    expect(duplicateCapability._unsafeUnwrapErr().message).toMatch(
      /duplicate lifecycle runtime capability/i,
    );
  });

  it('materializes iterable catalogs before snapshotting and returns Result errors', () => {
    const input = makeRegistryInput();
    const nativeCatalog = input.nativeImplementationCatalog!;
    input.nativeImplementationCatalog = (function* registrations() {
      yield* nativeCatalog;
    })();
    input.loadedSubagentCatalog = (function* subagents() {
      yield loadedSubagentRegistration('review-agent');
    })();

    expect(createLifecycleHandlerRegistry(input).isOk()).toBe(true);
    expect(
      createLifecycleHandlerRegistry({
        ...makeRegistryInput(),
        nativeImplementationCatalog: [
          null,
        ] as unknown as Iterable<LifecycleNativeImplementationRegistration>,
      }).isErr(),
    ).toBe(true);

    let accessorInvoked = false;
    const accessorRegistration: Record<string, unknown> = {
      implementationVersion: '1.0.0',
      mode: 'event',
      inputContract: LIFECYCLE_EVENT_INPUT_CONTRACT,
      outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
    };
    Object.defineProperty(accessorRegistration, 'ref', {
      enumerable: true,
      get: () => {
        accessorInvoked = true;
        return 'context-projector';
      },
    });
    const accessorResult = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      nativeImplementationCatalog: [
        accessorRegistration as unknown as LifecycleNativeImplementationRegistration,
      ],
    });
    expect(accessorResult.isErr()).toBe(true);
    expect(accessorResult._unsafeUnwrapErr().message).toMatch(/strict data record/i);
    expect(accessorInvoked).toBe(false);

    const proxyResult = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      nativeImplementationCatalog: [new Proxy(nativeRegistration('context-projector'), {})],
    });
    expect(proxyResult.isErr()).toBe(true);
    expect(proxyResult._unsafeUnwrapErr().message).toMatch(/strict data record/i);

    let topLevelCatalogGetterInvoked = false;
    const topLevelAccessorInput = makeRegistryInput();
    Object.defineProperty(topLevelAccessorInput, 'nativeImplementationCatalog', {
      enumerable: true,
      get: () => {
        topLevelCatalogGetterInvoked = true;
        return input.nativeImplementationCatalog;
      },
    });
    const topLevelAccessorResult = createLifecycleHandlerRegistry(topLevelAccessorInput);
    expect(topLevelAccessorResult.isErr()).toBe(true);
    expect(topLevelAccessorResult._unsafeUnwrapErr().message).toMatch(/plain data record/i);
    expect(topLevelCatalogGetterInvoked).toBe(false);

    let iteratorGetterInvoked = false;
    const iteratorAccessorCatalog: Record<PropertyKey, unknown> = {};
    Object.defineProperty(iteratorAccessorCatalog, Symbol.iterator, {
      enumerable: true,
      get: () => {
        iteratorGetterInvoked = true;
        return function* registrations(): Generator<LifecycleNativeImplementationRegistration> {
          yield nativeRegistration('context-projector');
        };
      },
    });
    const iteratorAccessorResult = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      nativeImplementationCatalog:
        iteratorAccessorCatalog as unknown as Iterable<LifecycleNativeImplementationRegistration>,
    });
    expect(iteratorAccessorResult.isErr()).toBe(true);
    expect(iteratorGetterInvoked).toBe(false);

    let proxyCatalogTrapInvoked = false;
    const proxyCatalog = new Proxy([nativeRegistration('context-projector')], {
      get: () => {
        proxyCatalogTrapInvoked = true;
        throw new Error('must not read proxy catalog');
      },
    });
    const proxyCatalogResult = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      nativeImplementationCatalog: proxyCatalog,
    });
    expect(proxyCatalogResult.isErr()).toBe(true);
    expect(proxyCatalogTrapInvoked).toBe(false);

    let stepDoneGetterInvoked = false;
    let stepIteratorClosed = false;
    const accessorStep: Record<string, unknown> = {
      value: nativeRegistration('context-projector'),
    };
    Object.defineProperty(accessorStep, 'done', {
      enumerable: true,
      get: () => {
        stepDoneGetterInvoked = true;
        return false;
      },
    });
    const accessorStepIterator = {
      next: () => accessorStep,
      return: () => {
        stepIteratorClosed = true;
        return { done: true, value: undefined };
      },
    };
    const accessorStepCatalog = {
      [Symbol.iterator]: () => accessorStepIterator,
    };
    const accessorStepResult = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      nativeImplementationCatalog:
        accessorStepCatalog as unknown as Iterable<LifecycleNativeImplementationRegistration>,
    });
    expect(accessorStepResult.isErr()).toBe(true);
    expect(stepDoneGetterInvoked).toBe(false);
    expect(stepIteratorClosed).toBe(true);

    let factoryApplyTraps = 0;
    const factoryCallableProxy = new Proxy(
      function iteratorFactory(): Iterator<LifecycleNativeImplementationRegistration> {
        return { next: () => ({ done: true, value: undefined }) };
      },
      {
        apply: () => {
          factoryApplyTraps += 1;
          throw new Error('must not apply proxy factory');
        },
      },
    );
    const factoryProxyResult = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      nativeImplementationCatalog: {
        [Symbol.iterator]: factoryCallableProxy,
      } as Iterable<LifecycleNativeImplementationRegistration>,
    });
    expect(factoryProxyResult.isErr()).toBe(true);
    expect(factoryApplyTraps).toBe(0);

    let nextApplyTraps = 0;
    const nextCallableProxy = new Proxy(
      function next(): IteratorResult<LifecycleNativeImplementationRegistration> {
        return { done: true, value: undefined };
      },
      {
        apply: () => {
          nextApplyTraps += 1;
          throw new Error('must not apply proxy next');
        },
      },
    );
    const nextProxyResult = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      nativeImplementationCatalog: {
        [Symbol.iterator]: () => ({ next: nextCallableProxy }),
      } as Iterable<LifecycleNativeImplementationRegistration>,
    });
    expect(nextProxyResult.isErr()).toBe(true);
    expect(nextApplyTraps).toBe(0);

    let returnApplyTraps = 0;
    const returnCallableProxy = new Proxy(
      function close(): IteratorResult<LifecycleNativeImplementationRegistration> {
        return { done: true, value: undefined };
      },
      {
        apply: () => {
          returnApplyTraps += 1;
          throw new Error('must not apply proxy return');
        },
      },
    );
    const returnProxyResult = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      nativeImplementationCatalog: {
        [Symbol.iterator]: () => ({
          next: () => ({ done: false, value: null }),
          return: returnCallableProxy,
        }),
      } as Iterable<LifecycleNativeImplementationRegistration>,
    });
    expect(returnProxyResult.isErr()).toBe(true);
    expect(returnApplyTraps).toBe(0);

    let malformedDoneIteratorClosed = false;
    const malformedDoneResult = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      nativeImplementationCatalog: {
        [Symbol.iterator]: () => ({
          next: () => ({ done: 1, value: nativeRegistration('context-projector') }),
          return: () => {
            malformedDoneIteratorClosed = true;
            return { done: true, value: undefined };
          },
        }),
      } as Iterable<LifecycleNativeImplementationRegistration>,
    });
    expect(malformedDoneResult.isErr()).toBe(true);
    expect(malformedDoneIteratorClosed).toBe(true);

    let oversizedClosed = false;
    function* oversizedCatalog(): Generator<LifecycleNativeImplementationRegistration> {
      try {
        for (let index = 0; index <= 256; index += 1) {
          yield nativeRegistration(`native-${index}`);
        }
      } finally {
        oversizedClosed = true;
      }
    }
    const oversizedResult = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      nativeImplementationCatalog: oversizedCatalog(),
    });
    expect(oversizedResult.isErr()).toBe(true);
    expect(oversizedResult._unsafeUnwrapErr().message).toMatch(/at most 256 registrations/i);
    expect(oversizedClosed).toBe(true);

    let infiniteClosed = false;
    function* infiniteLoadedCatalog(): Generator<LifecycleLoadedSubagentRegistration> {
      try {
        let index = 0;
        while (true) {
          yield loadedSubagentRegistration(`loaded-${index++}`);
        }
      } finally {
        infiniteClosed = true;
      }
    }
    const infiniteResult = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      loadedSubagentCatalog: infiniteLoadedCatalog(),
    });
    expect(infiniteResult.isErr()).toBe(true);
    expect(infiniteResult._unsafeUnwrapErr().message).toMatch(/at most 256 registrations/i);
    expect(infiniteClosed).toBe(true);
  });

  it('materializes iterator steps through safe prototype data descriptors', () => {
    const terminalStep = Object.create({ done: true }) as Record<string, unknown>;
    Object.defineProperty(terminalStep, 'value', {
      enumerable: true,
      value: nativeRegistration('context-projector'),
    });
    const inheritedDoneResult = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      nativeImplementationCatalog: {
        [Symbol.iterator]: () => ({ next: () => terminalStep }),
      } as Iterable<LifecycleNativeImplementationRegistration>,
    });
    expect(inheritedDoneResult.isErr()).toBe(true);
    expect(inheritedDoneResult._unsafeUnwrapErr().message).toMatch(/bootstrap catalog/i);

    let inheritedAccessorInvoked = false;
    let inheritedAccessorIteratorClosed = false;
    const inheritedAccessorPrototype: Record<string, unknown> = {};
    Object.defineProperty(inheritedAccessorPrototype, 'done', {
      enumerable: true,
      get: () => {
        inheritedAccessorInvoked = true;
        return false;
      },
    });
    const inheritedAccessorResult = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      nativeImplementationCatalog: {
        [Symbol.iterator]: () => ({
          next: () => Object.create(inheritedAccessorPrototype),
          return: () => {
            inheritedAccessorIteratorClosed = true;
            return { done: true, value: undefined };
          },
        }),
      } as Iterable<LifecycleNativeImplementationRegistration>,
    });
    expect(inheritedAccessorResult.isErr()).toBe(true);
    expect(inheritedAccessorResult._unsafeUnwrapErr().message).toMatch(/invalid step/i);
    expect(inheritedAccessorInvoked).toBe(false);
    expect(inheritedAccessorIteratorClosed).toBe(true);

    let prototypeProxyTrapInvoked = false;
    let prototypeProxyIteratorClosed = false;
    const prototypeProxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          prototypeProxyTrapInvoked = true;
          throw new Error('must not inspect proxy prototype');
        },
        getPrototypeOf: () => {
          prototypeProxyTrapInvoked = true;
          throw new Error('must not traverse proxy prototype');
        },
      },
    );
    const proxyPrototypeStep = Object.create(prototypeProxy) as Record<string, unknown>;
    Object.defineProperty(proxyPrototypeStep, 'value', {
      enumerable: true,
      value: nativeRegistration('context-projector'),
    });
    const proxyPrototypeResult = createLifecycleHandlerRegistry({
      ...makeRegistryInput(),
      nativeImplementationCatalog: {
        [Symbol.iterator]: () => ({
          next: () => proxyPrototypeStep,
          return: () => {
            prototypeProxyIteratorClosed = true;
            return { done: true, value: undefined };
          },
        }),
      } as Iterable<LifecycleNativeImplementationRegistration>,
    });
    expect(proxyPrototypeResult.isErr()).toBe(true);
    expect(proxyPrototypeResult._unsafeUnwrapErr().message).toMatch(/invalid step/i);
    expect(prototypeProxyTrapInvoked).toBe(false);
    expect(prototypeProxyIteratorClosed).toBe(true);
  });

  it('bounds lifecycle handler, attachment, and subscription target lists', () => {
    const input = makeRegistryInput();
    const handler = input.lifecycle!.handlers[0]!;
    const attachment = input.personas[0].lifecycle!.subscriptions[0]!;
    const eventTarget = { version: 'v1' as const, type: 'message.persisted.v1' as const };
    const signalTarget = {
      version: 'v1' as const,
      type: 'behavior.feedback.detected.v1' as const,
    };
    const interceptorTarget = { version: 'v1' as const, hook: 'run.before_execute' as const };
    const overLimit = <T>(value: T): T[] => Array.from({ length: 33 }, () => value);

    expect(
      LifecycleConfigSchema.safeParse({ enabled: true, handlers: overLimit(handler) }).success,
    ).toBe(false);
    expect(
      PersonaLifecycleConfigSchema.safeParse({ subscriptions: overLimit(attachment) }).success,
    ).toBe(false);
    expect(
      LifecycleEventSubscriptionContractSchema.safeParse({
        version: 'v1',
        kind: 'event',
        events: overLimit(eventTarget),
      }).success,
    ).toBe(false);
    expect(
      LifecycleSignalSubscriptionContractSchema.safeParse({
        version: 'v1',
        kind: 'signal',
        signals: overLimit(signalTarget),
      }).success,
    ).toBe(false);
    expect(
      LifecycleInterceptorSubscriptionContractSchema.safeParse({
        version: 'v1',
        kind: 'interceptor',
        interceptors: overLimit(interceptorTarget),
      }).success,
    ).toBe(false);
  });

  it('structurally validates direct lifecycle registry configuration before construction', () => {
    const v2Handler = {
      ...makeRegistryInput(),
      lifecycle: {
        enabled: true,
        handlers: [{ ...makeRegistryInput().lifecycle!.handlers[0]!, version: 'v2' }],
      },
    } as unknown as LifecycleRegistryInput;
    const malformedHandler = {
      ...makeRegistryInput(),
      lifecycle: {
        enabled: true,
        handlers: [
          {
            version: 'v1',
            id: 'missing-runtime',
            mode: 'event',
            inputContract: LIFECYCLE_EVENT_INPUT_CONTRACT,
            outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
          },
        ],
      },
    } as unknown as LifecycleRegistryInput;

    for (const input of [v2Handler, malformedHandler]) {
      expect(() => createLifecycleHandlerRegistry(input)).not.toThrow();
      const result = createLifecycleHandlerRegistry(input);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toMatch(
        /invalid lifecycle registry configuration/i,
      );
    }
  });

  it('keeps contract definitions immutable at the resolution boundary', () => {
    const definition = resolveLifecycleHandlerContract(
      LIFECYCLE_EVENT_INPUT_CONTRACT,
      LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
    )!;

    expect(Object.isFrozen(definition)).toBe(true);
    expect(() => {
      Object.assign(definition, { mode: 'interceptor' });
    }).toThrow();
    expect(() => {
      Object.assign(definition, {
        parseInput: () => ({ success: true }),
        acceptsOutput: () => true,
      });
    }).toThrow();
    expect(Object.isFrozen(definition.parseInput)).toBe(true);
    expect(() => {
      Object.assign(definition.parseInput, { compromised: true });
    }).toThrow();
    expect(
      resolveLifecycleHandlerContract(
        LIFECYCLE_EVENT_INPUT_CONTRACT,
        LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
      )!.mode,
    ).toBe('event');
    expect(
      resolveLifecycleHandlerContract(
        LIFECYCLE_EVENT_INPUT_CONTRACT,
        LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
      )!.parseInput({ malformed: true }).success,
    ).toBe(false);
  });

  it('bounds every lifecycle filter collection to 32 values', () => {
    const overLimit = (value: string): string[] => Array.from({ length: 33 }, () => value);
    expect(
      LifecycleFilterContractSchema.safeParse({
        version: 'v1',
        itemOrigins: overLimit('channel'),
      }).success,
    ).toBe(false);
    expect(
      LifecycleFilterContractSchema.safeParse({
        version: 'v1',
        itemTypes: overLimit('message'),
      }).success,
    ).toBe(false);
    expect(
      LifecycleFilterContractSchema.safeParse({
        version: 'v1',
        messageSources: overLimit('inbound'),
      }).success,
    ).toBe(false);
    expect(
      LifecycleFilterContractSchema.safeParse({
        version: 'v1',
        scheduleSources: overLimit('cron'),
      }).success,
    ).toBe(false);
  });

  it('returns failures for hostile top-level proxies and snapshots parsed input deeply', () => {
    const contract = resolveLifecycleHandlerContract(
      LIFECYCLE_EVENT_INPUT_CONTRACT,
      LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
    )!;
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('hostile get');
        },
        ownKeys: () => {
          throw new Error('hostile ownKeys');
        },
      },
    );

    expect(() => contract.parseInput(hostile)).not.toThrow();
    expect(contract.parseInput(hostile).success).toBe(false);
    expect(() => contract.acceptsOutput(hostile)).not.toThrow();
    expect(contract.acceptsOutput(hostile)).toBe(false);

    const handler = makeRegistryInput().lifecycle!.handlers[0]!;
    const input = makeEventEnvelope();
    expect(() => parseLifecycleHandlerResult(hostile, input, hostile)).not.toThrow();
    expect(parseLifecycleHandlerResult(hostile, input, hostile).success).toBe(false);
    expect(() => parseLifecycleHandlerResult(handler, input, hostile)).not.toThrow();
    expect(parseLifecycleHandlerResult(handler, input, hostile).success).toBe(false);

    const parsed = contract.parseInput(input);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    const snapshot = parsed.data as {
      context: { aggregate: { id: string } };
      payload: { references: Array<{ id: string }>; metadata: { source: string } };
    };
    const original = input as {
      context: { aggregate: { id: string } };
      payload: { references: Array<{ id: string }>; metadata: { source: string } };
    };
    original.context.aggregate.id = 'changed-after-parse';
    original.payload.references[0]!.id = 'changed-reference';
    original.payload.metadata.source = 'outbound';

    expect(snapshot.context.aggregate.id).toBe('thread-1');
    expect(snapshot.payload.references[0]!.id).toBe('message-1');
    expect(snapshot.payload.metadata.source).toBe('inbound');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.context)).toBe(true);
    expect(Object.isFrozen(snapshot.payload.references)).toBe(true);
    expect(() => {
      snapshot.context.aggregate.id = 'mutate-snapshot';
    }).toThrow();
  });

  it('rejects syntactically valid but unsupported contract pairs', () => {
    const input = makeRegistryInput();
    input.lifecycle!.handlers[0]!.inputContract = 'talon.lifecycle.unrecognized.input.v1';

    const result = createLifecycleHandlerRegistry(input);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(/not a supported event contract pair/i);
  });

  it('uses only bootstrap and loader-owned capability catalogs as runtime authority', () => {
    const nativeInput = makeRegistryInput() as LifecycleRegistryInput & {
      lifecycle: NonNullable<LifecycleRegistryInput['lifecycle']> & {
        trustedNativeImplementations?: string[];
      };
    };
    nativeInput.lifecycle.handlers[0]!.runtime.ref = 'yaml-self-authorized';
    nativeInput.lifecycle.trustedNativeImplementations = ['yaml-self-authorized'];

    expect(createLifecycleHandlerRegistry(nativeInput).isErr()).toBe(true);

    const subagentHandler = {
      ...makeRegistryInput().lifecycle!.handlers[0]!,
      id: 'manifest-only-agent',
      runtime: {
        kind: 'subagent' as const,
        ref: 'manifest-only-agent',
        implementationVersion: '1.0.0',
      },
    };
    const manifestLoaded = createLifecycleHandlerRegistry({
      lifecycle: { enabled: true, handlers: [subagentHandler] },
      personas: [{ name: 'assistant' }],
      loadedSubagentCatalog: [loadedSubagentRegistration('manifest-only-agent')],
    });
    expect(manifestLoaded.isOk()).toBe(true);
    expect(manifestLoaded._unsafeUnwrap().getHandler('manifest-only-agent')?.runtime).toEqual({
      kind: 'subagent',
      ref: 'manifest-only-agent',
      implementationVersion: '1.0.0',
    });

    const yamlVersionClaim = createLifecycleHandlerRegistry({
      lifecycle: {
        enabled: true,
        handlers: [
          {
            ...subagentHandler,
            runtime: {
              ...subagentHandler.runtime,
              implementationVersion: 'yaml-claimed-version',
            },
          },
        ],
      },
      personas: [{ name: 'assistant' }],
      loadedSubagentCatalog: [loadedSubagentRegistration('manifest-only-agent')],
    });
    expect(yamlVersionClaim.isErr()).toBe(true);
    expect(yamlVersionClaim._unsafeUnwrapErr().message).toMatch(/manifest version/i);

    const overrideOnly = createLifecycleHandlerRegistry({
      lifecycle: { enabled: true, handlers: [subagentHandler] },
      personas: [{ name: 'assistant' }],
      // A bootstrap caller may carry model overrides, but this registry only
      // accepts loader-provided capabilities in loadedSubagentCatalog.
      subagentOverrides: { 'manifest-only-agent': 'some-model' },
    } as LifecycleRegistryInput);
    expect(overrideOnly.isErr()).toBe(true);
    expect(overrideOnly._unsafeUnwrapErr().message).toMatch(/loaded subagent catalog/i);
  });

  it('rejects sub-agent lifecycle interceptors during registry validation', () => {
    const input = makeRegistryInput();
    input.lifecycle!.handlers.push({
      version: 'v1',
      id: 'subagent-advisor',
      mode: 'interceptor',
      inputContract: LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT,
      outputContract: LIFECYCLE_ADVISORY_INTERCEPTOR_OUTPUT_CONTRACT,
      runtime: { kind: 'subagent', ref: 'review-agent', implementationVersion: '1.0.0' },
    });
    input.loadedSubagentCatalog = [
      loadedSubagentRegistration('review-agent', { mode: 'interceptor' }),
    ];
    const result = createLifecycleHandlerRegistry(input);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(
      /lifecycle interceptors must use a native implementation/i,
    );
  });

  it('rejects unsupported sub-agent interceptors and advisory blocking policies with canonical diagnostics', () => {
    const enforcingSubagent = makeRegistryInput();
    enforcingSubagent.lifecycle!.handlers.push({
      version: 'v1',
      id: 'subagent-enforcer',
      mode: 'interceptor',
      interceptorSafety: 'enforcing',
      inputContract: LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT,
      outputContract: LIFECYCLE_ENFORCING_INTERCEPTOR_OUTPUT_CONTRACT,
      runtime: { kind: 'subagent', ref: 'review-agent', implementationVersion: '1.0.0' },
    });
    enforcingSubagent.loadedSubagentCatalog = [
      loadedSubagentRegistration('review-agent', { mode: 'interceptor' }),
    ];
    const enforcingResult = createLifecycleHandlerRegistry(enforcingSubagent);
    expect(enforcingResult.isErr()).toBe(true);
    const enforcingMessage = enforcingResult._unsafeUnwrapErr().message;
    expect(enforcingMessage).toMatch(/interceptors must use a native implementation/i);
    expect(enforcingMessage).not.toMatch(/output contract.*incompatible/i);

    const handlerPolicy = makeRegistryInput();
    handlerPolicy.lifecycle!.handlers.push({
      version: 'v1',
      id: 'native-advisor',
      mode: 'interceptor',
      interceptorSafety: 'advisory',
      inputContract: LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT,
      outputContract: LIFECYCLE_ADVISORY_INTERCEPTOR_OUTPUT_CONTRACT,
      runtime: { kind: 'native', ref: 'native-interceptor', implementationVersion: '1.0.0' },
      failurePolicy: { version: 'v1', mode: 'fail_closed' },
    });
    const handlerPolicyResult = createLifecycleHandlerRegistry(handlerPolicy);
    expect(handlerPolicyResult.isErr()).toBe(true);
    expect(handlerPolicyResult._unsafeUnwrapErr().message).toMatch(
      /advisory interceptors must use fail_open/i,
    );

    const attachmentPolicy = makeRegistryInput();
    attachmentPolicy.lifecycle!.handlers.push({
      version: 'v1',
      id: 'native-advisor',
      mode: 'interceptor',
      interceptorSafety: 'advisory',
      inputContract: LIFECYCLE_INTERCEPTOR_INPUT_CONTRACT,
      outputContract: LIFECYCLE_ADVISORY_INTERCEPTOR_OUTPUT_CONTRACT,
      runtime: { kind: 'native', ref: 'native-interceptor', implementationVersion: '1.0.0' },
    });
    attachmentPolicy.personas[0].lifecycle!.subscriptions.push({
      version: 'v1',
      handler: 'native-advisor',
      failurePolicy: { version: 'v1', mode: 'fail_closed' },
      subscription: {
        version: 'v1',
        kind: 'interceptor',
        interceptors: [{ version: 'v1', hook: 'run.before_execute' }],
      },
    });
    const attachmentPolicyResult = createLifecycleHandlerRegistry(attachmentPolicy);
    expect(attachmentPolicyResult.isErr()).toBe(true);
    expect(attachmentPolicyResult._unsafeUnwrapErr().message).toMatch(
      /advisory interceptors must use fail_open/i,
    );
  });

  it('does not expose mutable registry state and ties result parsing to handler output contracts', () => {
    const input = makeRegistryInput();
    const registry = createLifecycleHandlerRegistry(input)._unsafeUnwrap();
    input.lifecycle!.handlers[0]!.id = 'mutated-input';
    input.lifecycle!.handlers[0]!.runtime.ref = 'mutated-input-runtime';
    const inputSubscription = input.personas[0].lifecycle!.subscriptions[0]!.subscription;
    if (inputSubscription.kind === 'event') {
      inputSubscription.events[0]!.type = 'message.sent.v1';
    }

    const listed = registry.listHandlers();
    listed[0]!.id = 'mutated-output';
    expect(registry.getHandler('context-projector')?.id).toBe('context-projector');
    expect(registry.getHandler('context-projector')?.runtime.ref).toBe('context-projector');
    expect(registry.listHandlers().map((handler) => handler.id)).not.toContain('mutated-output');
    expect(
      registry
        .resolveEventHandlers({
          persona: 'assistant',
          eventType: 'message.persisted.v1',
          channel: 'terminal',
          messageSource: 'inbound',
        })
        .map((handler) => handler.handler.id),
    ).toEqual(['context-projector', 'audit-log']);

    const listedPersonaHandlers = registry.listPersonaHandlers('assistant');
    listedPersonaHandlers[0]!.handler.runtime.ref = 'mutated-persona-runtime';
    const listedSubscription = listedPersonaHandlers[0]!.subscription;
    if (listedSubscription.kind === 'event') {
      listedSubscription.events[0]!.type = 'message.sent.v1';
    }
    const resolvedHandlers = registry.resolveEventHandlers({
      persona: 'assistant',
      eventType: 'message.persisted.v1',
      channel: 'terminal',
      messageSource: 'inbound',
    });
    resolvedHandlers[0]!.handler.runtime.ref = 'mutated-resolved-runtime';
    resolvedHandlers[0]!.identity.implementationRef = 'mutated-resolved-identity';
    expect(registry.listPersonaHandlers('assistant')[0]!.handler.runtime.ref).toBe(
      'context-projector',
    );
    expect(
      registry
        .resolveEventHandlers({
          persona: 'assistant',
          eventType: 'message.persisted.v1',
          channel: 'terminal',
          messageSource: 'inbound',
        })
        .map((handler) => handler.identity.implementationRef),
    ).toEqual(['context-projector', 'audit-log']);

    const handler = registry.getHandler('context-projector')!;
    expect(
      parseLifecycleHandlerResult(
        handler,
        {
          version: 'v1',
          type: 'message.persisted.v1',
          eventId: 'event-1',
          occurredAt: '2026-07-15T19:00:00.000Z',
          context: {
            aggregate: { type: 'thread', id: 'thread-1' },
            correlationId: 'correlation-1',
            recursion: { depth: 0, maxDepth: 1 },
            provenance: { source: 'message-pipeline', sourceEventIds: [], sourceReferences: [] },
          },
          payload: { references: [], metadata: {} },
        },
        {
          outcome: 'success',
          outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
          signals: [],
        },
      ).success,
    ).toBe(true);
    expect(
      parseLifecycleHandlerResult(
        handler,
        {
          version: 'v1',
          type: 'message.persisted.v1',
          eventId: 'event-1',
          occurredAt: '2026-07-15T19:00:00.000Z',
          context: {
            aggregate: { type: 'thread', id: 'thread-1' },
            correlationId: 'correlation-1',
            recursion: { depth: 0, maxDepth: 1 },
            provenance: { source: 'message-pipeline', sourceEventIds: [], sourceReferences: [] },
          },
          payload: { references: [], metadata: {} },
        },
        {
          outcome: 'success',
          outputContract: LIFECYCLE_ADVISORY_INTERCEPTOR_OUTPUT_CONTRACT,
          result: { outcome: 'advisory', signals: [] },
        },
      ).success,
    ).toBe(false);
  });
});
