/**
 * Bounded, content-free observations for the server-side voice lifecycle.
 *
 * This facade deliberately has no effect on voice execution.  It records
 * transition times from one injected monotonic clock and sends best-effort
 * updates to the existing Langfuse service.  Missing context, exporter
 * failures, and saturation are represented as unknown/dropped observations.
 */

import { performance } from 'node:perf_hooks';
import type {
  ObservabilityService,
  StartedObservationHandle,
} from '../observability/langfuse/observability-types.js';
import { NoopObservabilityService } from '../observability/langfuse/noop-observability.js';
import {
  createVoiceObservationContext,
  startVoiceObservationSafely,
  type VoiceObservationContext,
} from '../observability/langfuse/voice-observation.js';

export const VOICE_TELEMETRY_MAX_CALLS = 64;
export const VOICE_TELEMETRY_MAX_MILESTONES_PER_CALL = 256;
export const VOICE_TELEMETRY_MAX_DELEGATIONS_PER_CALL = 128;
export const VOICE_TELEMETRY_MAX_OUTPUTS_PER_CALL = 256;
export const VOICE_TELEMETRY_MAX_ID_LENGTH = 256;
export const VOICE_TELEMETRY_MAX_SUMMARY_BYTES = 4096;
export const VOICE_TELEMETRY_COMPLETED_RETENTION_MS = 60_000;

const VOICE_TELEMETRY_STAGE_OBSERVATION_NAME = 'voice-lifecycle-stage';
const VOICE_TELEMETRY_SUMMARY_OBSERVATION_NAME = 'voice-lifecycle-summary';
const VOICE_TELEMETRY_EXPORT_KEYS = new Set([
  'voice',
  'redacted',
  'callId',
  'threadId',
  'personaId',
  'provider',
  'model',
  'stage',
  'status',
  'durationMs',
  'delegationId',
  'providerDelegationId',
  'queueItemId',
  'runId',
  'outputId',
  'knownDurationCount',
  'summary',
]);
const VOICE_TELEMETRY_EXPORT_ID_KEYS = new Set([
  'callId',
  'threadId',
  'personaId',
  'provider',
  'model',
  'delegationId',
  'providerDelegationId',
  'queueItemId',
  'runId',
  'outputId',
]);

export const VOICE_TELEMETRY_STATUSES = [
  'started',
  'accepted',
  'completed',
  'sent',
  'acknowledged',
  'closed',
  'incomplete',
  'failed',
  'rejected',
  'dropped',
  'unknown',
] as const;

export const VOICE_TELEMETRY_STAGES = [
  'call_created',
  'provider_setup_started',
  'provider_setup_completed',
  'transport_connected',
  'delegation_received',
  'delegation_published',
  'admission',
  'enqueue',
  'claim',
  'backend_provider_start',
  'result_verified',
  'output_offered',
  'provider_acknowledged',
  'call_closure',
] as const;

export type VoiceTelemetryStage = (typeof VOICE_TELEMETRY_STAGES)[number];

export type VoiceTelemetryStatus =
  (typeof VOICE_TELEMETRY_STATUSES)[number];

export interface VoiceTelemetryCallInput {
  readonly callId: string;
  readonly threadId?: string;
  readonly personaId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly transport?: string;
}

/** Technical correlation fields only.  Voice payloads are intentionally absent. */
export interface VoiceTelemetryMilestoneInput {
  readonly callId: string;
  readonly stage: VoiceTelemetryStage;
  readonly status?: VoiceTelemetryStatus;
  readonly delegationId?: string;
  readonly providerDelegationId?: string;
  readonly queueItemId?: string;
  readonly runId?: string;
  readonly outputId?: string;
}

export interface VoiceTelemetryEvent {
  readonly stage: VoiceTelemetryStage;
  readonly status: VoiceTelemetryStatus;
  readonly atMs: number;
  readonly durationMs?: number;
  readonly delegationId?: string;
  readonly providerDelegationId?: string;
  readonly queueItemId?: string;
  readonly runId?: string;
  readonly outputId?: string;
}

export interface VoiceTelemetryStageSummary {
  readonly count: number;
  readonly accepted: number;
  readonly dropped: number;
  readonly unknown: number;
  readonly knownDurationCount: number;
  readonly p50DurationMs?: number;
  readonly p95DurationMs?: number;
}

export interface VoiceTelemetrySummary {
  readonly callId: string;
  readonly threadId?: string;
  readonly personaId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly transport?: string;
  readonly status: 'active' | 'closed' | 'incomplete';
  readonly finalized: boolean;
  readonly milestoneCount: number;
  readonly delegationCount: number;
  readonly outputCount: number;
  readonly acceptedCount: number;
  readonly droppedCount: number;
  readonly unknownCount: number;
  readonly duplicateCount: number;
  readonly unassociatedCount: number;
  readonly stages: Readonly<Partial<Record<VoiceTelemetryStage, VoiceTelemetryStageSummary>>>;
}

export interface VoiceTelemetryOptions {
  readonly observability?: ObservabilityService;
  /** Must be monotonic.  The default uses the process monotonic clock. */
  readonly now?: () => number;
}

export interface VoiceTelemetryCallHandle {
  readonly callId: string;
  record(input: Omit<VoiceTelemetryMilestoneInput, 'callId'>): void;
  finish(status?: 'closed' | 'incomplete' | 'unknown'): void;
}

interface MutableStageSummary {
  count: number;
  accepted: number;
  dropped: number;
  unknown: number;
  durations: number[];
}

interface CallState {
  readonly input: VoiceTelemetryCallInput;
  readonly context: VoiceObservationContext;
  readonly span: StartedObservationHandle;
  readonly startedAt: number;
  readonly events: VoiceTelemetryEvent[];
  readonly seenKeys: Set<string>;
  readonly delegationKeys: Set<string>;
  readonly outputKeys: Set<string>;
  readonly stageTimes: Map<string, number>;
  readonly stages: Map<VoiceTelemetryStage, MutableStageSummary>;
  acceptedCount: number;
  droppedCount: number;
  unknownCount: number;
  duplicateCount: number;
  unassociatedCount: number;
  finalized: boolean;
  finalStatus: 'active' | 'closed' | 'incomplete';
  finishedAt?: number;
}

/**
 * Content-free lifecycle telemetry.  Every public operation is synchronous
 * and best effort so queue, provider, delivery, and close paths never wait
 * for an exporter or retry telemetry work.
 */
export class VoiceTelemetry {
  private readonly observability: ObservabilityService;
  private readonly now: () => number;
  private readonly calls = new Map<string, CallState>();
  private droppedCalls = 0;
  private unknownCalls = 0;

  constructor(options: VoiceTelemetryOptions = {}) {
    this.observability = options.observability ?? new NoopObservabilityService();
    this.now = options.now ?? ((): number => performance.now());
  }

  startCall(input: VoiceTelemetryCallInput): VoiceTelemetryCallHandle | undefined {
    this.pruneExpired();
    const callId = boundedId(input.callId);
    if (!callId) {
      this.droppedCalls += 1;
      return undefined;
    }
    const existing = this.calls.get(callId);
    if (existing) return this.handleFor(existing);
    if (this.calls.size >= VOICE_TELEMETRY_MAX_CALLS) {
      this.droppedCalls += 1;
      return undefined;
    }

    const normalized = normalizeCallInput(input, callId);
    const now = this.readClock();
    if (now === undefined) {
      this.droppedCalls += 1;
      return undefined;
    }
    const context = createVoiceObservationContext({
      callId,
      threadId: normalized.threadId,
      personaId: normalized.personaId,
      provider: normalized.provider,
      model: normalized.model,
    });
    const span = this.startSpan(context, normalized);
    const state: CallState = {
      input: normalized,
      context,
      span,
      startedAt: now,
      events: [],
      seenKeys: new Set(),
      delegationKeys: new Set(),
      outputKeys: new Set(),
      stageTimes: new Map(),
      stages: new Map(),
      acceptedCount: 0,
      droppedCount: 0,
      unknownCount: 0,
      duplicateCount: 0,
      unassociatedCount: 0,
      finalized: false,
      finalStatus: 'active',
    };
    this.calls.set(callId, state);
    this.record({ callId, stage: 'call_created', status: 'started' });
    return this.handleFor(state);
  }

  /** Record one allowlisted server transition. */
  record(input: VoiceTelemetryMilestoneInput): void {
    this.pruneExpired();
    const callId = boundedId(input.callId);
    if (!callId) {
      this.droppedCalls += 1;
      return;
    }
    const state = this.calls.get(callId);
    if (!state) {
      this.unknownCalls += 1;
      return;
    }
    if (!isVoiceTelemetryStage(input.stage) || (input.status !== undefined && !isVoiceTelemetryStatus(input.status))) {
      this.drop(state);
      return;
    }
    const now = this.readClock();
    if (now === undefined) {
      this.drop(state);
      return;
    }
    if (!this.identifiersAreValid(input)) {
      this.drop(state);
      return;
    }

    const key = eventKey(input);
    if (state.seenKeys.has(key)) {
      state.duplicateCount += 1;
      this.drop(state);
      return;
    }
    if (state.events.length >= VOICE_TELEMETRY_MAX_MILESTONES_PER_CALL) {
      this.drop(state);
      return;
    }

    const delegationKey = input.providerDelegationId ?? input.delegationId;
    if (delegationKey && !state.delegationKeys.has(delegationKey)) {
      if (state.delegationKeys.size >= VOICE_TELEMETRY_MAX_DELEGATIONS_PER_CALL) {
        this.drop(state);
        return;
      }
      state.delegationKeys.add(delegationKey);
    }
    if (input.outputId && !state.outputKeys.has(input.outputId)) {
      if (state.outputKeys.size >= VOICE_TELEMETRY_MAX_OUTPUTS_PER_CALL) {
        this.drop(state);
        return;
      }
      state.outputKeys.add(input.outputId);
    }

    const predecessor = predecessorStage(input.stage);
    const referenceKey = transitionReferenceKey(input);
    const previous = referenceKey ? state.stageTimes.get(referenceKey) : undefined;
    const durationMs = previous === undefined ? undefined : nonNegativeDuration(now - previous);
    if (predecessor !== undefined && durationMs === undefined) state.unassociatedCount += 1;
    const status = input.status ?? defaultStatus(input.stage);
    const event: VoiceTelemetryEvent = {
      stage: input.stage,
      status,
      atMs: now,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(input.delegationId ? { delegationId: input.delegationId } : {}),
      ...(input.providerDelegationId ? { providerDelegationId: input.providerDelegationId } : {}),
      ...(input.queueItemId ? { queueItemId: input.queueItemId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.outputId ? { outputId: input.outputId } : {}),
    };
    state.seenKeys.add(key);
    state.events.push(event);
    const currentKey = transitionKey(input);
    if (state.stageTimes.get(currentKey) === undefined) state.stageTimes.set(currentKey, now);
    this.updateStage(state, event);
    this.updateCounters(state, event.status);
    this.updateSpan(state, event);
    this.exportStage(state, event);
  }

  /** Alias for callers that prefer the term milestone. */
  recordMilestone(input: VoiceTelemetryMilestoneInput): void {
    this.record(input);
  }

  finishCall(callId: string, status: 'closed' | 'incomplete' | 'unknown' = 'closed'): void {
    const boundedCallId = boundedId(callId);
    if (!boundedCallId) return;
    const state = this.calls.get(boundedCallId);
    if (!state || state.finalized) return;
    this.record({ callId: boundedCallId, stage: 'call_closure', status });
    state.finalized = true;
    state.finalStatus = status === 'closed' ? 'closed' : 'incomplete';
    state.finishedAt = this.readClock() ?? state.startedAt;
    this.updateSpan(state, undefined, true);
    this.exportSummary(state);
    safeEnd(state.span);
  }

  getSummary(callId: string): VoiceTelemetrySummary | undefined {
    this.pruneExpired();
    const boundedCallId = boundedId(callId);
    if (!boundedCallId) return undefined;
    const state = this.calls.get(boundedCallId);
    return state ? summaryFor(state) : undefined;
  }

  getEvents(callId: string): readonly VoiceTelemetryEvent[] {
    const boundedCallId = boundedId(callId);
    if (!boundedCallId) return [];
    return [...(this.calls.get(boundedCallId)?.events ?? [])];
  }

  /** Snapshot global bounded counters for diagnostics and offline tests. */
  counters(): { readonly calls: number; readonly droppedCalls: number; readonly unknownCalls: number } {
    return {
      calls: this.calls.size,
      droppedCalls: this.droppedCalls,
      unknownCalls: this.unknownCalls,
    };
  }

  /** Release all retained spans/handles.  This never awaits exporter work. */
  shutdown(): void {
    for (const state of this.calls.values()) safeEnd(state.span);
    this.calls.clear();
  }

  private handleFor(state: CallState): VoiceTelemetryCallHandle {
    return {
      callId: state.input.callId,
      record: (input): void => this.record({ ...input, callId: state.input.callId }),
      finish: (status = 'closed'): void => this.finishCall(state.input.callId, status),
    };
  }

  private startSpan(
    context: VoiceObservationContext,
    input: VoiceTelemetryCallInput,
  ): StartedObservationHandle {
    return startVoiceObservationSafely(
      this.observability,
      null,
      {
        type: 'agent',
        name: 'voice-lifecycle',
        metadata: { status: 'started', count: 0 },
        trace: {
          sessionId: input.threadId,
          tags: ['voice', ...(input.transport ? [`transport:${input.transport}`] : [])],
        },
      },
      context,
    );
  }

  private updateSpan(state: CallState, event?: VoiceTelemetryEvent, final = false): void {
    const metadata: Record<string, unknown> = {
      status: final ? state.finalStatus : (event ? spanStatus(event.status) : 'unknown'),
      count: state.events.length,
      ...(event?.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event?.delegationId ? { delegationId: event.delegationId } : {}),
      ...(event?.queueItemId ? { queueItemId: event.queueItemId } : {}),
      ...(event?.runId ? { runId: event.runId } : {}),
      ...(event?.outputId ? { outputId: event.outputId } : {}),
    };
    try {
      state.span.update({ metadata });
    } catch {
      // Existing safe observation wrappers already isolate exporter failures.
    }
  }

  /**
   * Export one bounded lifecycle observation.  This intentionally uses the
   * facade's fixed technical allowlist instead of the generic voice sanitizer:
   * lifecycle stage names and aggregate fields are not user content, while the
   * generic sanitizer must keep its narrower descendant vocabulary.
   */
  private exportStage(state: CallState, event: VoiceTelemetryEvent): void {
    const stage = state.stages.get(event.stage);
    const metadata = this.exportMetadata(state, {
      stage: event.stage,
      status: event.status,
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.delegationId ? { delegationId: event.delegationId } : {}),
      ...(event.providerDelegationId ? { providerDelegationId: event.providerDelegationId } : {}),
      ...(event.queueItemId ? { queueItemId: event.queueItemId } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
      ...(event.outputId ? { outputId: event.outputId } : {}),
      ...(stage ? { knownDurationCount: stage.durations.length } : {}),
    });
    if (!metadata || !this.exportObservation(state, VOICE_TELEMETRY_STAGE_OBSERVATION_NAME, metadata)) {
      this.drop(state);
    }
  }

  private exportSummary(state: CallState): void {
    const metadata = this.exportMetadata(state, {
      stage: 'call_closure',
      status: state.finalStatus,
    });
    if (!metadata || !this.exportObservation(state, VOICE_TELEMETRY_SUMMARY_OBSERVATION_NAME, metadata)) {
      this.drop(state);
    }
  }

  private exportMetadata(
    state: CallState,
    fields: Record<string, string | number>,
  ): Record<string, string | number | boolean> | undefined {
    const base: Record<string, string | number | boolean> = {
      voice: true,
      redacted: true,
      callId: state.input.callId,
      ...(state.input.threadId ? { threadId: state.input.threadId } : {}),
      ...(state.input.personaId ? { personaId: state.input.personaId } : {}),
      ...(state.input.provider ? { provider: state.input.provider } : {}),
      ...(state.input.model ? { model: state.input.model } : {}),
      ...fields,
    };
    const summary = JSON.stringify(summaryFor(state));
    const withSummary = { ...base, summary };
    if (serializedBytes(withSummary) <= VOICE_TELEMETRY_MAX_SUMMARY_BYTES) {
      return withSummary;
    }

    const compact = JSON.stringify(compactSummary(state));
    const compactWithSummary = { ...base, summary: compact };
    if (serializedBytes(compactWithSummary) <= VOICE_TELEMETRY_MAX_SUMMARY_BYTES) {
      return compactWithSummary;
    }

    const minimal = { ...base, summary: JSON.stringify({ status: state.finalStatus, unknown: true }) };
    return serializedBytes(minimal) <= VOICE_TELEMETRY_MAX_SUMMARY_BYTES ? minimal : undefined;
  }

  private exportObservation(
    state: CallState,
    name:
      | typeof VOICE_TELEMETRY_STAGE_OBSERVATION_NAME
      | typeof VOICE_TELEMETRY_SUMMARY_OBSERVATION_NAME,
    metadata: Record<string, string | number | boolean>,
  ): boolean {
    if (!validExportMetadata(metadata)) return false;
    let observation: StartedObservationHandle;
    try {
      observation = this.observability.startWithTraceparent(state.span.getTraceparent(), {
        type: 'agent',
        name,
        input: '[voice lifecycle redacted]',
        metadata,
        trace: {
          ...(state.input.threadId ? { sessionId: state.input.threadId } : {}),
          tags: ['voice', 'server'],
        },
      });
    } catch {
      return false;
    }
    try {
      observation.end();
      return true;
    } catch {
      return false;
    }
  }

  private updateStage(state: CallState, event: VoiceTelemetryEvent): void {
    let summary = state.stages.get(event.stage);
    if (!summary) {
      summary = { count: 0, accepted: 0, dropped: 0, unknown: 0, durations: [] };
      state.stages.set(event.stage, summary);
    }
    summary.count += 1;
    if (isAcceptedStatus(event.status)) summary.accepted += 1;
    if (event.status === 'dropped') summary.dropped += 1;
    if (event.status === 'unknown') summary.unknown += 1;
    if (event.durationMs !== undefined) summary.durations.push(event.durationMs);
  }

  private updateCounters(state: CallState, status: VoiceTelemetryStatus): void {
    if (isAcceptedStatus(status)) state.acceptedCount += 1;
    if (status === 'dropped') state.droppedCount += 1;
    if (status === 'unknown') state.unknownCount += 1;
  }

  private identifiersAreValid(input: VoiceTelemetryMilestoneInput): boolean {
    return [
      input.callId,
      input.delegationId,
      input.providerDelegationId,
      input.queueItemId,
      input.runId,
      input.outputId,
    ].every((value) => value === undefined || boundedId(value) !== undefined);
  }

  private drop(state: CallState): void {
    state.droppedCount += 1;
  }

  private readClock(): number | undefined {
    try {
      const value = this.now();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private pruneExpired(): void {
    const now = this.readClock();
    if (now === undefined) return;
    for (const [callId, state] of this.calls) {
      if (
        state.finalized &&
        state.finishedAt !== undefined &&
        now - state.finishedAt >= VOICE_TELEMETRY_COMPLETED_RETENTION_MS
      ) {
        safeEnd(state.span);
        this.calls.delete(callId);
      }
    }
  }
}

function boundedId(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= VOICE_TELEMETRY_MAX_ID_LENGTH
    ? value
    : undefined;
}

function normalizeCallInput(input: VoiceTelemetryCallInput, callId: string): VoiceTelemetryCallInput {
  return {
    callId,
    ...(boundedId(input.threadId) ? { threadId: input.threadId } : {}),
    ...(boundedId(input.personaId) ? { personaId: input.personaId } : {}),
    ...(boundedId(input.provider) ? { provider: input.provider } : {}),
    ...(boundedId(input.model) ? { model: input.model } : {}),
    ...(boundedId(input.transport) ? { transport: input.transport } : {}),
  };
}

function eventKey(input: VoiceTelemetryMilestoneInput): string {
  return [
    input.stage,
    input.delegationId ?? '',
    input.providerDelegationId ?? '',
    input.queueItemId ?? '',
    input.runId ?? '',
    input.outputId ?? '',
  ].join('\u0000');
}

function transitionReferenceKey(input: VoiceTelemetryMilestoneInput): string | undefined {
  const predecessor = predecessorStage(input.stage);
  const identity = predecessor && outputTransitionStage(predecessor) && input.outputId
    ? input.outputId
    : transitionIdentity(input);
  return predecessor && identity ? `${identity}\u0000${predecessor}` : undefined;
}

function transitionKey(input: VoiceTelemetryMilestoneInput): string {
  const identity = outputTransitionStage(input.stage) && input.outputId
    ? input.outputId
    : transitionIdentity(input);
  return `${identity ?? input.callId}\u0000${input.stage}`;
}

function outputTransitionStage(stage: VoiceTelemetryStage): boolean {
  return (
    stage === 'result_verified' ||
    stage === 'output_offered' ||
    stage === 'provider_acknowledged'
  );
}

function transitionIdentity(input: VoiceTelemetryMilestoneInput): string | undefined {
  return input.providerDelegationId ?? input.delegationId ?? input.callId;
}

function predecessorStage(stage: VoiceTelemetryStage): VoiceTelemetryStage | undefined {
  switch (stage) {
    case 'provider_setup_completed':
      return 'provider_setup_started';
    case 'delegation_published':
      return 'delegation_received';
    case 'transport_connected':
      return 'provider_setup_completed';
    case 'admission':
      return 'delegation_published';
    case 'enqueue':
      return 'admission';
    case 'claim':
      return 'enqueue';
    case 'backend_provider_start':
      return 'claim';
    case 'result_verified':
      return 'backend_provider_start';
    case 'output_offered':
      return 'result_verified';
    case 'provider_acknowledged':
      return 'output_offered';
    case 'call_closure':
      return 'call_created';
    default:
      return undefined;
  }
}

function defaultStatus(stage: VoiceTelemetryStage): VoiceTelemetryStatus {
  if (stage === 'call_created' || stage === 'provider_setup_started' || stage === 'backend_provider_start') {
    return 'started';
  }
  if (stage === 'call_closure') return 'closed';
  if (stage === 'provider_acknowledged') return 'acknowledged';
  if (stage === 'output_offered') return 'sent';
  return 'accepted';
}

function isVoiceTelemetryStage(value: unknown): value is VoiceTelemetryStage {
  return typeof value === 'string' && VOICE_TELEMETRY_STAGES.includes(value as VoiceTelemetryStage);
}

function isVoiceTelemetryStatus(value: unknown): value is VoiceTelemetryStatus {
  return typeof value === 'string' && VOICE_TELEMETRY_STATUSES.includes(value as VoiceTelemetryStatus);
}

function isAcceptedStatus(status: VoiceTelemetryStatus): boolean {
  return (
    status === 'started' ||
    status === 'accepted' ||
    status === 'completed' ||
    status === 'sent' ||
    status === 'acknowledged' ||
    status === 'closed'
  );
}

function spanStatus(status: VoiceTelemetryStatus): 'completed' | 'failed' | 'unknown' | 'cancelled' {
  if (status === 'failed' || status === 'rejected' || status === 'dropped') return 'failed';
  if (status === 'unknown' || status === 'incomplete') return 'unknown';
  if (status === 'closed') return 'completed';
  return 'completed';
}

function nonNegativeDuration(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function updatePercentile(values: readonly number[], percentile: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index];
}

function summaryFor(state: CallState): VoiceTelemetrySummary {
  const stages: Partial<Record<VoiceTelemetryStage, VoiceTelemetryStageSummary>> = {};
  for (const [stage, value] of state.stages) {
    const p50 = updatePercentile(value.durations, 0.5);
    const p95 = updatePercentile(value.durations, 0.95);
    stages[stage] = {
      count: value.count,
      accepted: value.accepted,
      dropped: value.dropped,
      unknown: value.unknown,
      knownDurationCount: value.durations.length,
      ...(p50 !== undefined ? { p50DurationMs: p50 } : {}),
      ...(p95 !== undefined ? { p95DurationMs: p95 } : {}),
    };
  }
  const summary: VoiceTelemetrySummary = {
    callId: state.input.callId,
    ...(state.input.threadId ? { threadId: state.input.threadId } : {}),
    ...(state.input.personaId ? { personaId: state.input.personaId } : {}),
    ...(state.input.provider ? { provider: state.input.provider } : {}),
    ...(state.input.model ? { model: state.input.model } : {}),
    ...(state.input.transport ? { transport: state.input.transport } : {}),
    status: state.finalStatus,
    finalized: state.finalized,
    milestoneCount: state.events.length,
    delegationCount: state.delegationKeys.size,
    outputCount: state.outputKeys.size,
    acceptedCount: state.acceptedCount,
    droppedCount: state.droppedCount,
    unknownCount: state.unknownCount,
    duplicateCount: state.duplicateCount,
    unassociatedCount: state.unassociatedCount,
    stages,
  };
  return boundedSummary(summary);
}

function compactSummary(state: CallState): VoiceTelemetrySummary {
  const summary = summaryFor(state);
  return { ...summary, stages: {} };
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function validExportMetadata(
  metadata: Record<string, string | number | boolean>,
): boolean {
  if (serializedBytes(metadata) > VOICE_TELEMETRY_MAX_SUMMARY_BYTES) return false;
  for (const [key, value] of Object.entries(metadata)) {
    if (!VOICE_TELEMETRY_EXPORT_KEYS.has(key)) return false;
    if (typeof value === 'number' && !Number.isFinite(value)) return false;
    if (
      (key === 'durationMs' || key === 'knownDurationCount') &&
      (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    ) {
      return false;
    }
    if ((key === 'voice' || key === 'redacted') && value !== true) return false;
    if (VOICE_TELEMETRY_EXPORT_ID_KEYS.has(key)) {
      if (typeof value !== 'string' || boundedId(value) === undefined) return false;
    }
    if (
      key === 'stage' &&
      (typeof value !== 'string' ||
        !VOICE_TELEMETRY_STAGES.includes(value as VoiceTelemetryStage))
    ) {
      return false;
    }
    if (
      key === 'status' &&
      (typeof value !== 'string' ||
        !VOICE_TELEMETRY_STATUSES.includes(value as VoiceTelemetryStatus))
    ) {
      return false;
    }
    if (
      key === 'summary' &&
      (typeof value !== 'string' || serializedBytes(value) > VOICE_TELEMETRY_MAX_SUMMARY_BYTES)
    ) {
      return false;
    }
  }
  return true;
}

function boundedSummary(summary: VoiceTelemetrySummary): VoiceTelemetrySummary {
  try {
    if (Buffer.byteLength(JSON.stringify(summary), 'utf8') <= VOICE_TELEMETRY_MAX_SUMMARY_BYTES) {
      return summary;
    }
  } catch {
    // Fall through to the compact representation.
  }
  return {
    callId: summary.callId,
    status: summary.status,
    finalized: summary.finalized,
    milestoneCount: summary.milestoneCount,
    delegationCount: summary.delegationCount,
    outputCount: summary.outputCount,
    acceptedCount: summary.acceptedCount,
    droppedCount: summary.droppedCount,
    unknownCount: summary.unknownCount,
    duplicateCount: summary.duplicateCount,
    unassociatedCount: summary.unassociatedCount,
    stages: {},
  };
}

function safeEnd(span: StartedObservationHandle): void {
  try {
    span.end();
  } catch {
    // Exporter failures cannot affect lifecycle cleanup.
  }
}
