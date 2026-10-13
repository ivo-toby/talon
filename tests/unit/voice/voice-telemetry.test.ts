import { describe, expect, it, vi } from 'vitest';
import type {
  ObservationHandle,
  ObservationInput,
  ObservabilityService,
  StartedObservationHandle,
} from '../../../src/observability/langfuse/observability-types.js';
import {
  VOICE_TELEMETRY_MAX_DELEGATIONS_PER_CALL,
  VOICE_TELEMETRY_MAX_ID_LENGTH,
  VOICE_TELEMETRY_MAX_MILESTONES_PER_CALL,
  VOICE_TELEMETRY_MAX_OUTPUTS_PER_CALL,
  VoiceTelemetry,
  type VoiceTelemetryStage,
  type VoiceTelemetryStatus,
} from '../../../src/voice/voice-telemetry.js';

function fakeObservability(): {
  service: ObservabilityService;
  handle: StartedObservationHandle;
  starts: ObservationInput[];
} {
  const starts: ObservationInput[] = [];
  let firstHandle = true;
  const rootObservation: ObservationHandle = {
    update: vi.fn(),
    getTraceparent: vi.fn(() => null),
  };
  const handle: StartedObservationHandle = {
    ...rootObservation,
    end: vi.fn(),
  };
  const createHandle = (input: ObservationInput): StartedObservationHandle => {
    starts.push(input);
    if (firstHandle) {
      firstHandle = false;
      return handle;
    }
    const observation: ObservationHandle = {
      update: vi.fn(),
      getTraceparent: vi.fn(() => null),
    };
    const handle: StartedObservationHandle = {
      ...observation,
      end: vi.fn(),
    };
    return handle;
  };
  return {
    handle,
    starts,
    service: {
      start: vi.fn((input: ObservationInput) => createHandle(input)),
      startWithTraceparent: vi.fn(
        (_traceparent: string | null | undefined, input: ObservationInput) => createHandle(input),
      ),
      observe: vi.fn(async <T>(_input: never, callback: (value: ObservationHandle) => T) =>
        callback(rootObservation)),
      observeWithTraceparent: vi.fn(
        async <T>(
          _traceparent: string | null | undefined,
          _input: never,
          callback: (value: ObservationHandle) => T,
        ) => callback(rootObservation),
      ),
      shutdown: vi.fn(async () => undefined),
    } as unknown as ObservabilityService,
  };
}

describe('VoiceTelemetry', () => {
  it('records separate receipt/publication stages and monotonic comparable durations', () => {
    let now = 100;
    const { service, handle, starts } = fakeObservability();
    const telemetry = new VoiceTelemetry({ observability: service, now: () => now });

    telemetry.startCall({
      callId: 'call-1',
      threadId: 'thread-1',
      personaId: 'persona-1',
      provider: 'openai-live',
      model: 'gpt-live-1',
    });
    now = 120;
    telemetry.record({
      callId: 'call-1',
      stage: 'delegation_received',
      providerDelegationId: 'provider-delegation-1',
    });
    now = 180;
    telemetry.record({
      callId: 'call-1',
      stage: 'delegation_published',
      providerDelegationId: 'provider-delegation-1',
    });
    now = 220;
    telemetry.record({
      callId: 'call-1',
      stage: 'admission',
      delegationId: 'delegation-1',
      providerDelegationId: 'provider-delegation-1',
      queueItemId: 'queue-1',
    });
    telemetry.finishCall('call-1');

    const summary = telemetry.getSummary('call-1');
    expect(summary?.stages.delegation_published?.p50DurationMs).toBe(60);
    expect(summary?.stages.admission?.p50DurationMs).toBe(40);
    expect(summary?.stages.delegation_received?.knownDurationCount).toBe(0);
    expect(telemetry.getEvents('call-1').map((event) => event.stage)).toEqual([
      'call_created',
      'delegation_received',
      'delegation_published',
      'admission',
      'call_closure',
    ]);
    const exported = JSON.stringify(handle.update.mock.calls);
    expect(exported).not.toContain('transcript');
    expect(exported).not.toContain('credential');
    const stageExports = starts.filter((input) => input.name === 'voice-lifecycle-stage');
    expect(stageExports.map((input) => input.metadata?.stage)).toEqual([
      'call_created',
      'delegation_received',
      'delegation_published',
      'admission',
      'call_closure',
    ]);
    const publicationExport = stageExports.find(
      (input) => input.metadata?.stage === 'delegation_published',
    );
    expect(publicationExport?.metadata?.durationMs).toBe(60);
    const summaryExport = starts.find((input) => input.name === 'voice-lifecycle-summary');
    expect(summaryExport?.metadata?.summary).toContain('p50DurationMs');
    expect(Buffer.byteLength(JSON.stringify(summaryExport?.metadata ?? {}), 'utf8')).toBeLessThanOrEqual(
      4096,
    );
  });

  it('keeps late results correlated during retention and makes restarted context unknown', () => {
    let now = 0;
    const { service, starts } = fakeObservability();
    const telemetry = new VoiceTelemetry({ observability: service, now: () => now });
    telemetry.startCall({ callId: 'call-1', threadId: 'thread-1' });
    telemetry.finishCall('call-1');

    now = 10;
    telemetry.record({
      callId: 'call-1',
      stage: 'result_verified',
      status: 'completed',
      delegationId: 'delegation-late',
      providerDelegationId: 'provider-late',
      outputId: 'output-late',
    });
    expect(telemetry.getSummary('call-1')?.outputCount).toBe(1);
    expect(telemetry.getSummary('call-1')?.unknownCount).toBe(0);
    expect(telemetry.getSummary('call-1')?.unassociatedCount).toBe(1);
    expect(telemetry.getSummary('call-1')?.stages.result_verified?.knownDurationCount).toBe(0);
    expect(telemetry.getEvents('call-1').at(-1)?.outputId).toBe('output-late');
    const lateExport = starts
      .filter((input) => input.name === 'voice-lifecycle-stage')
      .at(-1);
    expect(lateExport?.metadata).toEqual(
      expect.objectContaining({
        stage: 'result_verified',
        outputId: 'output-late',
        status: 'completed',
      }),
    );

    const restarted = new VoiceTelemetry({ now: () => now });
    restarted.record({ callId: 'call-1', stage: 'result_verified', delegationId: 'missing' });
    expect(restarted.getSummary('call-1')).toBeUndefined();
    expect(restarted.counters().unknownCalls).toBe(1);
  });

  it('correlates output offers and acknowledgements by output ID within one delegation', () => {
    let now = 0;
    const telemetry = new VoiceTelemetry({ now: () => now });
    telemetry.startCall({ callId: 'call-1' });
    telemetry.record({
      callId: 'call-1',
      stage: 'backend_provider_start',
      delegationId: 'delegation-1',
      providerDelegationId: 'provider-1',
    });

    now = 10;
    telemetry.record({
      callId: 'call-1',
      stage: 'result_verified',
      status: 'completed',
      delegationId: 'delegation-1',
      providerDelegationId: 'provider-1',
      outputId: 'output-1',
    });
    telemetry.record({
      callId: 'call-1',
      stage: 'output_offered',
      delegationId: 'delegation-1',
      providerDelegationId: 'provider-1',
      outputId: 'output-1',
    });
    now = 15;
    telemetry.record({
      callId: 'call-1',
      stage: 'provider_acknowledged',
      delegationId: 'delegation-1',
      providerDelegationId: 'provider-1',
      outputId: 'output-1',
    });

    now = 100;
    telemetry.record({
      callId: 'call-1',
      stage: 'result_verified',
      status: 'completed',
      delegationId: 'delegation-1',
      providerDelegationId: 'provider-1',
      outputId: 'output-2',
    });
    telemetry.record({
      callId: 'call-1',
      stage: 'output_offered',
      delegationId: 'delegation-1',
      providerDelegationId: 'provider-1',
      outputId: 'output-2',
    });
    now = 105;
    telemetry.record({
      callId: 'call-1',
      stage: 'provider_acknowledged',
      delegationId: 'delegation-1',
      providerDelegationId: 'provider-1',
      outputId: 'output-2',
    });

    expect(
      telemetry
        .getEvents('call-1')
        .filter((event) => event.stage === 'provider_acknowledged')
        .map((event) => event.durationMs),
    ).toEqual([5, 5]);
  });

  it('drops duplicate and capped entries without affecting the runtime path', () => {
    let now = 0;
    const telemetry = new VoiceTelemetry({ now: () => now });
    telemetry.startCall({ callId: 'call-1' });
    telemetry.record({ callId: 'call-1', stage: 'delegation_received', providerDelegationId: 'p-1' });
    telemetry.record({ callId: 'call-1', stage: 'delegation_received', providerDelegationId: 'p-1' });
    for (let index = 2; index <= VOICE_TELEMETRY_MAX_DELEGATIONS_PER_CALL + 1; index += 1) {
      telemetry.record({
        callId: 'call-1',
        stage: 'delegation_received',
        providerDelegationId: `p-${index}`,
      });
      now += 1;
    }
    for (let index = 1; index <= VOICE_TELEMETRY_MAX_OUTPUTS_PER_CALL + 1; index += 1) {
      telemetry.record({
        callId: 'call-1',
        stage: 'output_offered',
        delegationId: `d-${index}`,
        providerDelegationId: `p-output-${index}`,
        outputId: `o-${index}`,
      });
    }
    for (let index = 0; index < VOICE_TELEMETRY_MAX_MILESTONES_PER_CALL + 5; index += 1) {
      telemetry.record({
        callId: 'call-1',
        stage: 'claim',
        delegationId: `claim-${index}`,
        providerDelegationId: `claim-provider-${index}`,
        queueItemId: `queue-${index}`,
      });
    }

    const summary = telemetry.getSummary('call-1');
    expect(summary?.duplicateCount).toBe(1);
    expect(summary?.droppedCount).toBeGreaterThan(0);
    expect(telemetry.getEvents('call-1').length).toBeLessThanOrEqual(
      VOICE_TELEMETRY_MAX_MILESTONES_PER_CALL,
    );
    expect(JSON.stringify(summary).length).toBeLessThanOrEqual(4096);
  });

  it('survives observation setup and update failures without throwing', () => {
    const service = fakeObservability().service;
    vi.mocked(service.startWithTraceparent).mockImplementation(() => {
      throw new Error('exporter failed');
    });
    const telemetry = new VoiceTelemetry({ observability: service });

    expect(() => {
      telemetry.startCall({ callId: 'call-1' });
      telemetry.record({ callId: 'call-1', stage: 'provider_setup_started' });
      telemetry.finishCall('call-1', 'incomplete');
    }).not.toThrow();
    expect(telemetry.getSummary('call-1')?.status).toBe('incomplete');
  });

  it('drops a UTF-8-overbound export without sending unbounded metadata', () => {
    const { service, starts } = fakeObservability();
    const id = 'é'.repeat(VOICE_TELEMETRY_MAX_ID_LENGTH);
    const telemetry = new VoiceTelemetry({ observability: service });
    telemetry.startCall({
      callId: id,
      threadId: id,
      personaId: id,
      provider: id,
      model: id,
    });
    telemetry.record({
      callId: id,
      stage: 'result_verified',
      status: 'completed',
      delegationId: id,
      providerDelegationId: id,
      queueItemId: id,
      runId: id,
      outputId: id,
    });

    const stageExports = starts.filter((input) => input.name === 'voice-lifecycle-stage');
    expect(stageExports.some((input) => input.metadata?.stage === 'result_verified')).toBe(false);
    expect(telemetry.getSummary(id)?.droppedCount).toBeGreaterThan(0);
  });

  it('rejects runtime-invalid stages and statuses before export', () => {
    const { service, starts } = fakeObservability();
    const telemetry = new VoiceTelemetry({ observability: service });
    telemetry.startCall({ callId: 'call-1' });

    telemetry.record({
      callId: 'call-1',
      stage: 'not-a-stage' as VoiceTelemetryStage,
      status: 'not-a-status' as VoiceTelemetryStatus,
    });

    expect(telemetry.getEvents('call-1')).toHaveLength(1);
    expect(telemetry.getSummary('call-1')?.droppedCount).toBe(1);
    expect(starts.some((input) => input.metadata?.stage === 'not-a-stage')).toBe(false);
  });
});
