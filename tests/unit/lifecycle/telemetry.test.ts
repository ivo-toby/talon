import { describe, expect, it, vi } from 'vitest';
import { ok } from 'neverthrow';
import pino from 'pino';

import { AuditLogger, type AuditEntry } from '../../../src/core/logging/audit-logger.js';
import type {
  LifecycleDeliveryRow,
  ClaimedLifecycleDelivery,
} from '../../../src/core/database/repositories/lifecycle-delivery-repository.js';
import type { LifecycleEventFanoutResult } from '../../../src/core/database/repositories/index.js';
import type { LifecycleEventEnvelope } from '../../../src/lifecycle/contracts/index.js';
import {
  LoggerLifecycleMetricsRecorder,
  LifecycleTelemetry,
  type LifecycleMetricsRecorder,
} from '../../../src/lifecycle/telemetry/index.js';
import {
  NoopTraceEvidenceProvider,
  normalizeTraceEvidence,
  safeFindTraceEvidence,
  type TraceEvidenceProvider,
} from '../../../src/lifecycle/trace-evidence-provider.js';
import type {
  ObservationHandle,
  ObservationInput,
  ObservationUpdate,
  ObservabilityService,
  StartedObservationHandle,
} from '../../../src/observability/langfuse/observability-types.js';

const VALID_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const CHILD_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01';

class CapturingMetrics implements LifecycleMetricsRecorder {
  readonly increments: Array<{ name: string; labels?: Record<string, unknown>; value?: number }> =
    [];
  readonly observations: Array<{ name: string; value: number; labels?: Record<string, unknown> }> =
    [];

  increment(name: string, labels?: Record<string, unknown>, value?: number): void {
    this.increments.push({ name, labels, value });
  }

  observe(name: string, value: number, labels?: Record<string, unknown>): void {
    this.observations.push({ name, value, labels });
  }
}

class CapturingObservability implements ObservabilityService {
  readonly starts: Array<{ traceparent: string | null | undefined; input: ObservationInput }> = [];
  readonly updates: ObservationUpdate[] = [];
  ended = 0;

  start(input: ObservationInput): StartedObservationHandle {
    return this.startWithTraceparent(null, input);
  }

  startWithTraceparent(
    traceparent: string | null | undefined,
    input: ObservationInput,
  ): StartedObservationHandle {
    this.starts.push({ traceparent, input });
    return {
      update: (update) => this.updates.push(update),
      getTraceparent: () => CHILD_TRACEPARENT,
      end: () => {
        this.ended += 1;
      },
    };
  }

  async observe<T>(
    input: ObservationInput,
    fn: (observation: ObservationHandle) => Promise<T> | T,
  ): Promise<T> {
    return await this.observeWithTraceparent(null, input, fn);
  }

  async observeWithTraceparent<T>(
    traceparent: string | null | undefined,
    input: ObservationInput,
    fn: (observation: ObservationHandle) => Promise<T> | T,
  ): Promise<T> {
    const handle = this.startWithTraceparent(traceparent, input);
    return await fn(handle);
  }

  async shutdown(): Promise<void> {}
}

function auditLogger(): { audit: AuditLogger; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    audit: new AuditLogger(pino({ level: 'silent' }), { append: (entry) => entries.push(entry) }),
    entries,
  };
}

function event(overrides: Partial<LifecycleEventEnvelope> = {}): LifecycleEventEnvelope {
  return {
    version: 'v1',
    eventId: 'event-1',
    type: 'run.completed.v1',
    occurredAt: '2026-07-25T12:00:00.000Z',
    context: {
      aggregate: { type: 'run', id: 'run-1' },
      correlationId: 'queue-item-1',
      recursion: { depth: 0, maxDepth: 8 },
      provenance: { source: 'test' },
    },
    payload: {
      references: [{ type: 'run', id: 'run-1' }],
      metadata: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 2,
        totalCostUsd: 0.01,
      },
    },
    ...overrides,
  };
}

function claim(overrides: Partial<LifecycleDeliveryRow> = {}): ClaimedLifecycleDelivery {
  return {
    delivery: {
      event_id: 'event-1',
      handler_id: 'handler-1',
      persona: 'assistant',
      priority: 0,
      handler_identity: '{}',
      failure_policy: '{}',
      status: 'claimed',
      attempts: 1,
      max_attempts: 2,
      next_retry_at: null,
      claim_token: 'claim-1',
      claim_expires_at: 2_000,
      last_error: null,
      completed_at: null,
      created_at: 900,
      updated_at: 900,
      ...overrides,
    },
    event: {
      event_sequence: 1,
      event_id: 'event-1',
      version: 'v1',
      type: 'run.completed.v1',
      aggregate_type: 'run',
      aggregate_id: 'run-1',
      correlation_id: 'queue-item-1',
      causation_id: null,
      recursion_depth: 0,
      recursion_max_depth: 8,
      provenance: '{}',
      payload: '{}',
      occurred_at: '2026-07-25T12:00:00.000Z',
      created_at: 750,
    },
  };
}

describe('LifecycleTelemetry', () => {
  it('records production metric samples through the structured logger recorder', () => {
    const logger = { debug: vi.fn() };
    const recorder = new LoggerLifecycleMetricsRecorder(logger as any);

    recorder.increment('lifecycle.delivery.count', { outcome: 'success' });
    recorder.observe('lifecycle.delivery.latency_ms', 42, { handler_id: 'handler-1' });

    expect(logger.debug).toHaveBeenCalledWith(
      {
        metric: {
          kind: 'increment',
          name: 'lifecycle.delivery.count',
          value: 1,
          labels: { outcome: 'success' },
        },
      },
      'lifecycle: metric recorded',
    );
    expect(logger.debug).toHaveBeenCalledWith(
      {
        metric: {
          kind: 'observe',
          name: 'lifecycle.delivery.latency_ms',
          value: 42,
          labels: { handler_id: 'handler-1' },
        },
      },
      'lifecycle: metric recorded',
    );
  });

  it('records publication metrics, usage/cost metrics, and audit without a Langfuse publication span by default', () => {
    const metrics = new CapturingMetrics();
    const observability = new CapturingObservability();
    const audit = auditLogger();
    const subject = new LifecycleTelemetry({
      metrics,
      observability,
      auditLogger: audit.audit,
      clock: { now: () => 1_000 },
    });
    const lifecycleEvent = event();
    const publication = subject.startPublication(lifecycleEvent);

    subject.recordPublication(publication, lifecycleEvent, {
      event: { event_id: 'event-1' },
      deliveries: [{ handler_id: 'handler-1' }],
    } as LifecycleEventFanoutResult);

    expect(metrics.increments).toContainEqual(
      expect.objectContaining({
        name: 'lifecycle.publication.count',
        labels: expect.objectContaining({ outcome: 'success', event_type: 'run.completed.v1' }),
      }),
    );
    expect(metrics.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'lifecycle.publication.latency_ms', value: 0 }),
        expect.objectContaining({ name: 'lifecycle.publication.delivery_count', value: 1 }),
        expect.objectContaining({ name: 'lifecycle.tokens.input', value: 10 }),
        expect.objectContaining({ name: 'lifecycle.tokens.output', value: 5 }),
        expect.objectContaining({ name: 'lifecycle.tokens.cache_write', value: 2 }),
        expect.objectContaining({ name: 'lifecycle.cost.usd', value: 0.01 }),
      ]),
    );
    expect(observability.starts).toHaveLength(0);
    expect(observability.ended).toBe(0);
    expect(audit.entries[0]?.details).toMatchObject({
      operation: 'publication',
      outcome: 'success',
      eventId: 'event-1',
      deliveryCount: 1,
    });
  });

  it('records Langfuse publication spans when explicitly enabled', () => {
    const metrics = new CapturingMetrics();
    const observability = new CapturingObservability();
    const subject = new LifecycleTelemetry({
      metrics,
      observability,
      langfuse: { publications: true },
      clock: { now: () => 1_000 },
    });
    const lifecycleEvent = event();
    const publication = subject.startPublication(lifecycleEvent);

    subject.recordPublication(publication, lifecycleEvent, {
      event: { event_id: 'event-1' },
      deliveries: [],
    } as LifecycleEventFanoutResult);

    expect(observability.starts[0]?.input.name).toBe('lifecycle.publish');
    expect(observability.updates[0]?.metadata).toMatchObject({
      outcome: 'success',
      deliveryCount: 0,
    });
    expect(observability.ended).toBe(1);
  });

  it('records success publication spans when failure publication spans are disabled', () => {
    const observability = new CapturingObservability();
    const subject = new LifecycleTelemetry({
      observability,
      langfuse: { publications: true, publicationFailures: false },
      clock: { now: () => 1_000 },
    });
    const lifecycleEvent = event();
    const publication = subject.startPublication(lifecycleEvent);

    expect(observability.starts).toHaveLength(0);

    subject.recordPublication(publication, lifecycleEvent, {
      event: { event_id: 'event-1' },
      deliveries: [],
    } as LifecycleEventFanoutResult);

    expect(observability.starts[0]?.input.name).toBe('lifecycle.publish');
    expect(observability.updates[0]?.metadata).toMatchObject({
      outcome: 'success',
      deliveryCount: 0,
    });
    expect(observability.ended).toBe(1);
  });

  it('records Langfuse publication failure spans even when success publication spans are disabled', () => {
    const observability = new CapturingObservability();
    const audit = auditLogger();
    const subject = new LifecycleTelemetry({
      observability,
      auditLogger: audit.audit,
      clock: { now: () => 1_250 },
    });
    const lifecycleEvent = event();
    const publication = subject.startPublication(lifecycleEvent);

    subject.recordPublicationFailure(publication, lifecycleEvent, 'insert_failed');

    expect(observability.starts[0]?.input.name).toBe('lifecycle.publish');
    expect(observability.updates[0]).toMatchObject({
      level: 'ERROR',
      statusMessage: 'insert_failed',
      metadata: { outcome: 'failure', code: 'insert_failed', durationMs: 0 },
    });
    expect(observability.ended).toBe(1);
    expect(audit.entries[0]?.details).toMatchObject({
      operation: 'publication',
      outcome: 'failure',
      code: 'insert_failed',
    });
  });

  it('suppresses failure publication spans when failure publication spans are disabled', () => {
    const observability = new CapturingObservability();
    const subject = new LifecycleTelemetry({
      observability,
      langfuse: { publications: true, publicationFailures: false },
      clock: { now: () => 1_250 },
    });
    const lifecycleEvent = event();
    const publication = subject.startPublication(lifecycleEvent);

    subject.recordPublicationFailure(publication, lifecycleEvent, 'insert_failed');

    expect(observability.starts).toHaveLength(0);
    expect(observability.ended).toBe(0);
  });

  it('correlates handler delivery with trace evidence and records timeout dead-letter metrics', () => {
    const metrics = new CapturingMetrics();
    const observability = new CapturingObservability();
    const audit = auditLogger();
    const traceEvidenceProvider: TraceEvidenceProvider = {
      findEvidence: vi.fn(() =>
        ok({
          source: 'issue-70',
          traceparent: VALID_TRACEPARENT,
          metadata: { sourceRun: 'run-1' },
        }),
      ),
    };
    const subject = new LifecycleTelemetry({
      metrics,
      observability,
      auditLogger: audit.audit,
      traceEvidenceProvider,
      clock: { now: () => 1_000 },
    });
    const claimed = claim();

    const delivery = subject.startDelivery(claimed, 'handler-1');
    subject.recordDeliveryFailure({
      lifecycle: delivery,
      claim: claimed,
      code: 'handler-timeout',
      retryable: false,
      status: 'dead_letter',
    });

    expect(delivery.traceparent).toBe(CHILD_TRACEPARENT);
    expect(observability.starts[0]?.traceparent).toBe(VALID_TRACEPARENT);
    expect(metrics.observations).toContainEqual(
      expect.objectContaining({ name: 'lifecycle.delivery.lag_ms', value: 250 }),
    );
    expect(metrics.increments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'lifecycle.delivery.dead_letter.count',
          labels: expect.objectContaining({ code: 'handler-timeout' }),
        }),
        expect.objectContaining({ name: 'lifecycle.delivery.timeout.count' }),
      ]),
    );
    expect(audit.entries[0]?.details).toMatchObject({
      operation: 'handler_delivery',
      outcome: 'dead_letter',
      status: 'dead_letter',
      code: 'handler-timeout',
    });
  });

  it('keeps handler trace evidence but suppresses Langfuse handler spans when disabled', () => {
    const metrics = new CapturingMetrics();
    const observability = new CapturingObservability();
    const traceEvidenceProvider: TraceEvidenceProvider = {
      findEvidence: vi.fn(() =>
        ok({
          source: 'issue-70',
          traceparent: VALID_TRACEPARENT,
          metadata: { sourceRun: 'run-1' },
        }),
      ),
    };
    const subject = new LifecycleTelemetry({
      metrics,
      observability,
      traceEvidenceProvider,
      langfuse: { handlerDeliveries: false },
      clock: { now: () => 1_000 },
    });

    const delivery = subject.startDelivery(claim(), 'handler-1');

    expect(delivery.traceparent).toBe(VALID_TRACEPARENT);
    expect(observability.starts).toHaveLength(0);
    expect(metrics.observations).toContainEqual(
      expect.objectContaining({ name: 'lifecycle.delivery.lag_ms', value: 250 }),
    );
  });

  it('preserves lost delivery status in metrics, audit, and observations', () => {
    const metrics = new CapturingMetrics();
    const observability = new CapturingObservability();
    const audit = auditLogger();
    const subject = new LifecycleTelemetry({
      metrics,
      observability,
      auditLogger: audit.audit,
      clock: { now: () => 1_250 },
    });
    const claimed = claim();

    const delivery = subject.startDelivery(claimed, 'handler-1');
    subject.recordDeliveryFailure({
      lifecycle: delivery,
      claim: claimed,
      code: 'signal-handoff-completion-lost',
      retryable: true,
      status: 'lost',
    });

    expect(metrics.increments).toContainEqual(
      expect.objectContaining({
        name: 'lifecycle.delivery.count',
        labels: expect.objectContaining({
          outcome: 'lost',
          code: 'signal-handoff-completion-lost',
        }),
      }),
    );
    expect(audit.entries[0]?.details).toMatchObject({
      operation: 'handler_delivery',
      outcome: 'lost',
      status: 'lost',
      code: 'signal-handoff-completion-lost',
    });
    expect(observability.updates[0]?.metadata).toMatchObject({
      outcome: 'lost',
      status: 'lost',
      code: 'signal-handoff-completion-lost',
    });
  });

  it('records interceptor decision metrics and audit without retaining intercepted payloads', () => {
    const metrics = new CapturingMetrics();
    const audit = auditLogger();
    const subject = new LifecycleTelemetry({
      metrics,
      auditLogger: audit.audit,
      clock: { now: () => 1_000 },
    });

    subject.recordInterceptorDecision({
      envelope: {
        version: 'v1',
        interceptionId: 'interception-1',
        hook: 'tool.before_execute',
        context: {
          aggregate: { type: 'thread', id: 'thread-1' },
          correlationId: 'correlation-1',
          recursion: { depth: 0, maxDepth: 8 },
          provenance: { source: 'test' },
        },
        input: { toolCallId: 'tool-1', toolName: 'web', arguments: { apiKey: 'secret' } },
      },
      decision: 'deny',
      reason: 'handler_deny',
      durationMs: 12.8,
    });

    expect(metrics.increments).toContainEqual(
      expect.objectContaining({
        name: 'lifecycle.interceptor.decision.count',
        labels: expect.objectContaining({ decision: 'deny', hook: 'tool.before_execute' }),
      }),
    );
    expect(audit.entries[0]?.details).toMatchObject({
      operation: 'interceptor',
      decision: 'deny',
      correlationId: 'correlation-1',
    });
    expect(JSON.stringify(audit.entries[0]?.details)).not.toContain('secret');
  });

  it('records bounded signal handoff metrics and audit without retaining signal payloads', () => {
    const metrics = new CapturingMetrics();
    const audit = auditLogger();
    const subject = new LifecycleTelemetry({
      metrics,
      auditLogger: audit.audit,
      clock: { now: () => 1_250 },
    });

    subject.recordSignalHandoff({
      lifecycle: { startedAt: 1_000 },
      claim: claim(),
      outcome: 'failure',
      signalCount: 2,
      code: 'signal-handoff-failed',
    });

    expect(metrics.increments).toContainEqual(
      expect.objectContaining({
        name: 'lifecycle.signal_handoff.count',
        labels: expect.objectContaining({
          outcome: 'failure',
          code: 'signal-handoff-failed',
          handler_id: 'handler-1',
        }),
      }),
    );
    expect(metrics.observations).toContainEqual(
      expect.objectContaining({ name: 'lifecycle.signal_handoff.latency_ms', value: 250 }),
    );
    expect(audit.entries[0]?.details).toMatchObject({
      operation: 'signal_handoff',
      outcome: 'failure',
      code: 'signal-handoff-failed',
      eventId: 'event-1',
      handlerId: 'handler-1',
      signalCount: 2,
    });
    expect(JSON.stringify(audit.entries[0]?.details)).not.toContain('signal-secret');
  });
});

describe('TraceEvidenceProvider seam', () => {
  it('defaults to no evidence', () => {
    const provider = new NoopTraceEvidenceProvider();

    expect(provider.findEvidence({ correlationId: 'correlation-1' })._unsafeUnwrap()).toBeNull();
  });

  it('normalizes bounded evidence and rejects unbounded provider output', () => {
    expect(
      normalizeTraceEvidence({
        source: 'issue-70',
        traceparent: VALID_TRACEPARENT,
        references: [{ type: 'run', id: 'run-1' }],
        metadata: { safe: true },
      }),
    ).toEqual({
      source: 'issue-70',
      traceparent: VALID_TRACEPARENT,
      references: [{ type: 'run', id: 'run-1' }],
      metadata: { safe: true },
    });
    expect(
      normalizeTraceEvidence({
        source: 'issue-70',
        traceparent: 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      }),
    ).toEqual({ source: 'issue-70' });

    const provider: TraceEvidenceProvider = {
      findEvidence: () => ok({ source: 'issue-70', metadata: { tooLarge: 'x'.repeat(300) } }),
    };

    expect(
      safeFindTraceEvidence(provider, { correlationId: 'correlation-1' })._unsafeUnwrap(),
    ).toBeNull();
  });
});
