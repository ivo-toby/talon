import type { AuditLogger } from '../../core/logging/audit-logger.js';
import type pino from 'pino';
import type {
  ClaimedLifecycleDelivery,
  LifecycleDeliveryRow,
} from '../../core/database/repositories/lifecycle-delivery-repository.js';
import type { LifecycleEventFanoutResult } from '../../core/database/repositories/index.js';
import type { LifecycleEventEnvelope } from '../contracts/index.js';
import type {
  LifecycleInterceptorEnvelope,
  LifecycleInterceptorTransform,
} from '../contracts/interceptor-contract.js';
import type { ResolvedLifecycleHandler } from '../handler-registry.js';
import type {
  ObservationInput,
  ObservabilityService,
  StartedObservationHandle,
} from '../../observability/langfuse/observability-types.js';
import { NoopObservabilityService } from '../../observability/langfuse/noop-observability.js';
import {
  NoopTraceEvidenceProvider,
  safeFindTraceEvidence,
  type TraceEvidence,
  type TraceEvidenceProvider,
} from '../trace-evidence-provider.js';

export interface LifecycleMetricLabels {
  readonly [key: string]: string | number | boolean;
}

export interface LifecycleMetricsRecorder {
  increment(name: string, labels?: LifecycleMetricLabels, value?: number): void;
  observe(name: string, value: number, labels?: LifecycleMetricLabels): void;
}

export class NoopLifecycleMetricsRecorder implements LifecycleMetricsRecorder {
  increment(_name: string, _labels?: LifecycleMetricLabels, _value?: number): void {}

  observe(_name: string, _value: number, _labels?: LifecycleMetricLabels): void {}
}

export class LoggerLifecycleMetricsRecorder implements LifecycleMetricsRecorder {
  constructor(private readonly logger: pino.Logger) {}

  increment(name: string, labels?: LifecycleMetricLabels, value = 1): void {
    this.record('increment', name, value, labels);
  }

  observe(name: string, value: number, labels?: LifecycleMetricLabels): void {
    this.record('observe', name, value, labels);
  }

  private record(
    kind: 'increment' | 'observe',
    name: string,
    value: number,
    labels?: LifecycleMetricLabels,
  ): void {
    this.logger.debug(
      {
        metric: {
          kind,
          name: boundedLabel(name),
          value,
          labels: labels ?? {},
        },
      },
      'lifecycle: metric recorded',
    );
  }
}

export interface LifecycleTelemetryClock {
  now(): number;
}

export interface LifecycleTelemetryOptions {
  readonly observability?: ObservabilityService;
  readonly metrics?: LifecycleMetricsRecorder;
  readonly auditLogger?: AuditLogger;
  readonly traceEvidenceProvider?: TraceEvidenceProvider;
  readonly langfuse?: Partial<LifecycleLangfuseTelemetryOptions>;
  readonly clock?: LifecycleTelemetryClock;
}

export interface LifecycleLangfuseTelemetryOptions {
  readonly publications: boolean;
  readonly publicationFailures: boolean;
  readonly handlerDeliveries: boolean;
}

export interface LifecycleDeliveryObservation {
  readonly traceparent?: string;
  readonly startedAt: number;
  readonly observation?: StartedObservationHandle;
  readonly evidence?: TraceEvidence;
}

export interface LifecyclePublicationObservation {
  readonly startedAt: number;
  readonly observation?: StartedObservationHandle;
}

const MAX_LABEL_LENGTH = 96;
const DEFAULT_LANGFUSE_TELEMETRY: LifecycleLangfuseTelemetryOptions = {
  publications: false,
  publicationFailures: true,
  handlerDeliveries: true,
};

function boundedLabel(value: unknown, fallback = 'unknown'): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return value.length > MAX_LABEL_LENGTH ? value.slice(0, MAX_LABEL_LENGTH) : value;
}

function boundedMetricNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function eventLabels(event: LifecycleEventEnvelope): LifecycleMetricLabels {
  return {
    event_type: boundedLabel(event.type),
    aggregate_type: boundedLabel(event.context.aggregate.type),
  };
}

function rowEventLabels(row: {
  readonly type: string;
  readonly aggregate_type: string;
}): LifecycleMetricLabels {
  return {
    event_type: boundedLabel(row.type),
    aggregate_type: boundedLabel(row.aggregate_type),
  };
}

function deliveryLabels(delivery: LifecycleDeliveryRow): LifecycleMetricLabels {
  return {
    handler_id: boundedLabel(delivery.handler_id),
    persona: boundedLabel(delivery.persona),
  };
}

function durationSince(clock: LifecycleTelemetryClock, startedAt: number): number {
  return Math.max(0, Math.floor(clock.now() - startedAt));
}

function metadataNumber(
  metadata: LifecycleEventEnvelope['payload']['metadata'],
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = metadata[key];
    const numberValue = boundedMetricNumber(value);
    if (numberValue !== undefined) return numberValue;
  }
  return undefined;
}

function transformMetadata(
  transform: LifecycleInterceptorTransform | undefined,
): Record<string, unknown> {
  if (!transform) return {};
  switch (transform.hook) {
    case 'message.before_persist':
    case 'message.before_send':
      return { transformKind: 'message_content', contentLength: transform.content?.length ?? 0 };
    case 'run.before_execute':
      return {
        transformKind: 'run',
        fieldCount:
          Number(transform.provider !== undefined) +
          Number(transform.model !== undefined) +
          Number(transform.contextAdditions !== undefined),
      };
    case 'tool.before_execute':
      return {
        transformKind:
          transform.arguments !== undefined ? 'tool_arguments_replace' : 'tool_arguments_patch',
        fieldCount: Object.keys(transform.arguments ?? transform.argumentsPatch ?? {}).length,
      };
  }
}

export class LifecycleTelemetry {
  private readonly observability: ObservabilityService;
  private readonly metrics: LifecycleMetricsRecorder;
  private readonly traceEvidenceProvider: TraceEvidenceProvider;
  private readonly langfuse: LifecycleLangfuseTelemetryOptions;
  private readonly clock: LifecycleTelemetryClock;

  constructor(private readonly options: LifecycleTelemetryOptions = {}) {
    this.observability = options.observability ?? new NoopObservabilityService();
    this.metrics = options.metrics ?? new NoopLifecycleMetricsRecorder();
    this.traceEvidenceProvider = options.traceEvidenceProvider ?? new NoopTraceEvidenceProvider();
    this.langfuse = { ...DEFAULT_LANGFUSE_TELEMETRY, ...(options.langfuse ?? {}) };
    this.clock = options.clock ?? { now: (): number => Date.now() };
  }

  startPublication(event: LifecycleEventEnvelope): LifecyclePublicationObservation {
    const startedAt = this.clock.now();
    if (!this.langfuse.publications || !this.langfuse.publicationFailures) {
      return { startedAt };
    }
    return { startedAt, observation: this.startPublicationObservation(event) };
  }

  recordPublication(
    publication: LifecyclePublicationObservation,
    event: LifecycleEventEnvelope,
    result: LifecycleEventFanoutResult,
  ): void {
    const durationMs = durationSince(this.clock, publication.startedAt);
    this.safeMetric(() => {
      this.metrics.increment('lifecycle.publication.count', {
        ...eventLabels(event),
        outcome: 'success',
      });
      this.metrics.observe('lifecycle.publication.latency_ms', durationMs, eventLabels(event));
      this.metrics.observe(
        'lifecycle.publication.delivery_count',
        result.deliveries.length,
        eventLabels(event),
      );
      this.recordUsageMetrics(event);
    });
    this.safeAudit(() =>
      this.options.auditLogger?.logLifecycleDecision({
        action: 'lifecycle.decision',
        details: {
          operation: 'publication',
          outcome: 'success',
          eventId: event.eventId,
          eventType: event.type,
          correlationId: event.context.correlationId,
          aggregateType: event.context.aggregate.type,
          deliveryCount: result.deliveries.length,
          durationMs,
        },
      }),
    );
    const observation =
      publication.observation ??
      (this.langfuse.publications ? this.startPublicationObservation(event) : undefined);
    this.finishObservation(observation, {
      output: { deliveryCount: result.deliveries.length },
      metadata: { outcome: 'success', durationMs, deliveryCount: result.deliveries.length },
    });
  }

  recordPublicationFailure(
    publication: LifecyclePublicationObservation | undefined,
    event: LifecycleEventEnvelope | undefined,
    code: string,
  ): void {
    const labels = event
      ? eventLabels(event)
      : { event_type: 'unknown', aggregate_type: 'unknown' };
    const durationMs = publication ? durationSince(this.clock, publication.startedAt) : 0;
    this.safeMetric(() => {
      this.metrics.increment('lifecycle.publication.count', {
        ...labels,
        outcome: 'failure',
        code: boundedLabel(code),
      });
      if (publication) this.metrics.observe('lifecycle.publication.latency_ms', durationMs, labels);
    });
    this.safeAudit(() =>
      this.options.auditLogger?.logLifecycleDecision({
        action: 'lifecycle.decision',
        details: {
          operation: 'publication',
          outcome: 'failure',
          eventId: event?.eventId ?? null,
          eventType: event?.type ?? null,
          correlationId: event?.context.correlationId ?? null,
          code,
          durationMs,
        },
      }),
    );
    const observation = this.langfuse.publicationFailures
      ? (publication?.observation ?? (event ? this.startPublicationObservation(event) : undefined))
      : undefined;
    this.finishObservation(observation, {
      level: 'ERROR',
      statusMessage: code,
      metadata: { outcome: 'failure', code, durationMs },
    });
  }

  startDelivery(claim: ClaimedLifecycleDelivery, handlerId: string): LifecycleDeliveryObservation {
    const startedAt = this.clock.now();
    let evidence: TraceEvidence | undefined;
    let traceparent: string | undefined;
    this.safeMetric(() => {
      this.metrics.increment('lifecycle.delivery.claim.count', {
        ...rowEventLabels(claim.event),
        ...deliveryLabels(claim.delivery),
      });
      this.metrics.observe(
        'lifecycle.delivery.lag_ms',
        Math.max(0, startedAt - claim.event.created_at),
        {
          ...rowEventLabels(claim.event),
          ...deliveryLabels(claim.delivery),
        },
      );
    });
    const evidenceResult = safeFindTraceEvidence(this.traceEvidenceProvider, {
      eventId: claim.event.event_id,
      correlationId: claim.event.correlation_id,
      aggregateType: claim.event.aggregate_type,
      aggregateId: claim.event.aggregate_id,
    });
    if (evidenceResult.isOk() && evidenceResult.value) {
      evidence = evidenceResult.value;
      traceparent = evidence.traceparent;
    } else if (evidenceResult.isErr()) {
      this.safeMetric(() =>
        this.metrics.increment('lifecycle.trace_evidence.count', {
          outcome: 'failure',
          code: 'provider_error',
        }),
      );
    }

    if (!this.langfuse.handlerDeliveries) {
      return {
        startedAt,
        ...(traceparent ? { traceparent } : {}),
        ...(evidence ? { evidence } : {}),
      };
    }

    try {
      const observationInput: ObservationInput = {
        type: 'tool',
        name: 'lifecycle.handler',
        input: {
          eventId: claim.event.event_id,
          eventType: claim.event.type,
          handlerId,
        },
        metadata: {
          eventId: claim.event.event_id,
          eventType: claim.event.type,
          handlerId,
          persona: claim.delivery.persona,
          correlationId: claim.event.correlation_id,
          aggregateType: claim.event.aggregate_type,
          aggregateId: claim.event.aggregate_id,
          attempts: claim.delivery.attempts,
          traceEvidenceSource: evidence?.source ?? null,
        },
        trace: {
          name: 'lifecycle.handler',
          sessionId: claim.event.aggregate_id,
          metadata: {
            eventId: claim.event.event_id,
            eventType: claim.event.type,
            handlerId,
            correlationId: claim.event.correlation_id,
          },
          tags: ['lifecycle', 'handler'],
        },
      };
      const observation = this.observability.startWithTraceparent(
        traceparent ?? null,
        observationInput,
      );
      return {
        startedAt,
        traceparent: observation.getTraceparent() ?? traceparent,
        observation,
        ...(evidence ? { evidence } : {}),
      };
    } catch {
      return {
        startedAt,
        ...(traceparent ? { traceparent } : {}),
        ...(evidence ? { evidence } : {}),
      };
    }
  }

  recordDeliverySuccess(
    lifecycle: LifecycleDeliveryObservation,
    claim: ClaimedLifecycleDelivery,
    signalCount: number,
  ): void {
    const durationMs = durationSince(this.clock, lifecycle.startedAt);
    this.safeMetric(() => {
      this.metrics.increment('lifecycle.delivery.count', {
        ...rowEventLabels(claim.event),
        ...deliveryLabels(claim.delivery),
        outcome: 'success',
      });
      this.metrics.observe('lifecycle.delivery.latency_ms', durationMs, {
        ...rowEventLabels(claim.event),
        ...deliveryLabels(claim.delivery),
        outcome: 'success',
      });
    });
    this.safeAudit(() =>
      this.options.auditLogger?.logLifecycleDecision({
        action: 'lifecycle.decision',
        details: {
          operation: 'handler_delivery',
          outcome: 'success',
          eventId: claim.event.event_id,
          eventType: claim.event.type,
          handlerId: claim.delivery.handler_id,
          correlationId: claim.event.correlation_id,
          signalCount,
          durationMs,
        },
      }),
    );
    this.finishObservation(lifecycle.observation, {
      output: { signalCount },
      metadata: { outcome: 'success', durationMs, signalCount },
    });
  }

  recordDeliveryFailure(input: {
    readonly lifecycle: LifecycleDeliveryObservation;
    readonly claim: ClaimedLifecycleDelivery;
    readonly code: string;
    readonly retryable: boolean;
    readonly status: 'failed' | 'dead_letter' | 'completed' | 'lost';
  }): void {
    const durationMs = durationSince(this.clock, input.lifecycle.startedAt);
    const outcome =
      input.status === 'dead_letter'
        ? 'dead_letter'
        : input.status === 'failed'
          ? 'retry'
          : input.status === 'completed'
            ? 'preserve_session'
            : 'lost';
    this.safeMetric(() => {
      this.metrics.increment('lifecycle.delivery.count', {
        ...rowEventLabels(input.claim.event),
        ...deliveryLabels(input.claim.delivery),
        outcome,
        code: boundedLabel(input.code),
      });
      this.metrics.observe('lifecycle.delivery.latency_ms', durationMs, {
        ...rowEventLabels(input.claim.event),
        ...deliveryLabels(input.claim.delivery),
        outcome,
      });
      if (outcome === 'retry') {
        this.metrics.increment('lifecycle.delivery.retry.count', {
          handler_id: boundedLabel(input.claim.delivery.handler_id),
          code: boundedLabel(input.code),
        });
      }
      if (outcome === 'dead_letter') {
        this.metrics.increment('lifecycle.delivery.dead_letter.count', {
          handler_id: boundedLabel(input.claim.delivery.handler_id),
          code: boundedLabel(input.code),
        });
      }
      if (input.code === 'handler-timeout') {
        this.metrics.increment('lifecycle.delivery.timeout.count', {
          handler_id: boundedLabel(input.claim.delivery.handler_id),
        });
      }
    });
    this.safeAudit(() =>
      this.options.auditLogger?.logLifecycleDecision({
        action: 'lifecycle.decision',
        details: {
          operation: 'handler_delivery',
          outcome,
          eventId: input.claim.event.event_id,
          eventType: input.claim.event.type,
          handlerId: input.claim.delivery.handler_id,
          correlationId: input.claim.event.correlation_id,
          code: input.code,
          retryable: input.retryable,
          status: input.status,
          durationMs,
        },
      }),
    );
    this.finishObservation(input.lifecycle.observation, {
      level: input.status === 'failed' ? undefined : 'ERROR',
      statusMessage: input.code,
      metadata: {
        outcome,
        code: input.code,
        retryable: input.retryable,
        status: input.status,
        durationMs,
      },
    });
  }

  recordSignalHandoff(input: {
    readonly lifecycle: LifecycleDeliveryObservation;
    readonly claim: ClaimedLifecycleDelivery;
    readonly outcome: 'success' | 'failure';
    readonly signalCount: number;
    readonly code?: string;
  }): void {
    const durationMs = durationSince(this.clock, input.lifecycle.startedAt);
    this.safeMetric(() => {
      this.metrics.increment('lifecycle.signal_handoff.count', {
        ...rowEventLabels(input.claim.event),
        ...deliveryLabels(input.claim.delivery),
        outcome: input.outcome,
        ...(input.code ? { code: boundedLabel(input.code) } : {}),
      });
      this.metrics.observe('lifecycle.signal_handoff.latency_ms', durationMs, {
        ...rowEventLabels(input.claim.event),
        ...deliveryLabels(input.claim.delivery),
        outcome: input.outcome,
      });
    });
    this.safeAudit(() =>
      this.options.auditLogger?.logLifecycleDecision({
        action: 'lifecycle.decision',
        details: {
          operation: 'signal_handoff',
          outcome: input.outcome,
          eventId: input.claim.event.event_id,
          eventType: input.claim.event.type,
          handlerId: input.claim.delivery.handler_id,
          persona: input.claim.delivery.persona,
          correlationId: input.claim.event.correlation_id,
          signalCount: input.signalCount,
          durationMs,
          ...(input.code ? { code: input.code } : {}),
        },
      }),
    );
  }

  recordCircuitOpened(handlerId: string, openUntil: number): void {
    this.safeMetric(() =>
      this.metrics.increment('lifecycle.delivery.circuit.count', {
        handler_id: boundedLabel(handlerId),
        outcome: 'open',
      }),
    );
    this.safeAudit(() =>
      this.options.auditLogger?.logLifecycleDisablement({
        action: 'lifecycle.disablement',
        details: { operation: 'handler_circuit', handlerId, outcome: 'open', openUntil },
      }),
    );
  }

  recordInterceptorDecision(input: {
    readonly handler?: ResolvedLifecycleHandler;
    readonly envelope: LifecycleInterceptorEnvelope;
    readonly decision: string;
    readonly reason: string;
    readonly durationMs: number;
    readonly transform?: LifecycleInterceptorTransform;
  }): void {
    this.safeMetric(() => {
      this.metrics.increment('lifecycle.interceptor.decision.count', {
        hook: boundedLabel(input.envelope.hook),
        handler_id: boundedLabel(input.handler?.identity.handlerId ?? 'lifecycle-engine'),
        decision: boundedLabel(input.decision),
        reason: boundedLabel(input.reason),
      });
      this.metrics.observe('lifecycle.interceptor.latency_ms', Math.floor(input.durationMs), {
        hook: boundedLabel(input.envelope.hook),
        handler_id: boundedLabel(input.handler?.identity.handlerId ?? 'lifecycle-engine'),
      });
    });
    this.safeAudit(() =>
      this.options.auditLogger?.logLifecycleDecision({
        action: 'lifecycle.decision',
        details: {
          operation: 'interceptor',
          handlerId: input.handler?.identity.handlerId ?? 'lifecycle-engine',
          implementationRef: input.handler?.identity.implementationRef ?? null,
          implementationVersion: input.handler?.identity.implementationVersion ?? null,
          hook: input.envelope.hook,
          correlationId: input.envelope.context.correlationId,
          decision: input.decision,
          reason: input.reason,
          durationMs: Math.floor(input.durationMs),
          ...transformMetadata(input.transform),
        },
      }),
    );
  }

  private startPublicationObservation(
    event: LifecycleEventEnvelope,
  ): StartedObservationHandle | undefined {
    try {
      return this.observability.startWithTraceparent(null, {
        type: 'tool',
        name: 'lifecycle.publish',
        input: {
          eventId: event.eventId,
          eventType: event.type,
          aggregateType: event.context.aggregate.type,
        },
        metadata: {
          eventId: event.eventId,
          eventType: event.type,
          correlationId: event.context.correlationId,
          aggregateType: event.context.aggregate.type,
          aggregateId: event.context.aggregate.id,
          causationId: event.context.causationId ?? null,
        },
        trace: {
          name: 'lifecycle.publish',
          sessionId: event.context.aggregate.id,
          metadata: {
            eventId: event.eventId,
            eventType: event.type,
            correlationId: event.context.correlationId,
          },
          tags: ['lifecycle', 'publication'],
        },
      });
    } catch {
      return undefined;
    }
  }

  private recordUsageMetrics(event: LifecycleEventEnvelope): void {
    const metadata = event.payload.metadata;
    const labels = eventLabels(event);
    const inputTokens = metadataNumber(metadata, ['inputTokens', 'input_tokens']);
    const outputTokens = metadataNumber(metadata, ['outputTokens', 'output_tokens']);
    const cacheReadTokens = metadataNumber(metadata, [
      'cacheReadTokens',
      'cache_read_tokens',
      'cache_read_input_tokens',
    ]);
    const cacheWriteTokens = metadataNumber(metadata, [
      'cacheWriteTokens',
      'cache_write_tokens',
      'cache_creation_input_tokens',
    ]);
    const totalCostUsd = metadataNumber(metadata, ['totalCostUsd', 'costUsd', 'cost_usd']);
    if (inputTokens !== undefined)
      this.metrics.observe('lifecycle.tokens.input', inputTokens, labels);
    if (outputTokens !== undefined)
      this.metrics.observe('lifecycle.tokens.output', outputTokens, labels);
    if (cacheReadTokens !== undefined)
      this.metrics.observe('lifecycle.tokens.cache_read', cacheReadTokens, labels);
    if (cacheWriteTokens !== undefined)
      this.metrics.observe('lifecycle.tokens.cache_write', cacheWriteTokens, labels);
    if (totalCostUsd !== undefined)
      this.metrics.observe('lifecycle.cost.usd', totalCostUsd, labels);
  }

  private finishObservation(
    observation: StartedObservationHandle | undefined,
    update: Parameters<StartedObservationHandle['update']>[0],
  ): void {
    if (!observation) return;
    try {
      observation.update(update);
      observation.end();
    } catch {
      // Observability outages must not change lifecycle side effects.
    }
  }

  private safeMetric(fn: () => void): void {
    try {
      fn();
    } catch {
      // Metrics are advisory and must not affect lifecycle durability.
    }
  }

  private safeAudit(fn: () => void): void {
    try {
      fn();
    } catch {
      // Audit sink failures are contained by design at lifecycle telemetry call sites.
    }
  }
}

export const noopLifecycleTelemetry = new LifecycleTelemetry();
