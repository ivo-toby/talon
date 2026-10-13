import { describe, expect, it, vi } from 'vitest';
import type {
  ObservationHandle,
  ObservationInput,
  ObservabilityService,
  StartedObservationHandle,
} from '../../../src/observability/langfuse/observability-types.js';
import { VoiceTelemetry } from '../../../src/voice/voice-telemetry.js';

describe('voice server lifecycle observability', () => {
  it('keeps one content-free call correlation while execution remains synchronous', () => {
    const updates: unknown[] = [];
    const starts: ObservationInput[] = [];
    const handles: StartedObservationHandle[] = [];
    const rootHandle: StartedObservationHandle = {
      update: (value): void => updates.push(value),
      getTraceparent: (): string | null => null,
      end: vi.fn(),
    };
    const startHandle = (input: ObservationInput): StartedObservationHandle => {
      starts.push(input);
      if (handles.length === 0) {
        handles.push(rootHandle);
        return rootHandle;
      }
      const handle: StartedObservationHandle = {
        update: vi.fn(),
        getTraceparent: (): string | null => null,
        end: vi.fn(),
      };
      handles.push(handle);
      return handle;
    };
    const service: ObservabilityService = {
      start: vi.fn((input: ObservationInput) => startHandle(input)),
      startWithTraceparent: vi.fn(
        (_traceparent: string | null | undefined, input: ObservationInput) => startHandle(input),
      ),
      observe: vi.fn(async <T>(_input: never, callback: (value: ObservationHandle) => T) =>
        callback(rootHandle)),
      observeWithTraceparent: vi.fn(
        async <T>(
          _traceparent: string | null | undefined,
          _input: never,
          callback: (value: ObservationHandle) => T,
        ) => callback(rootHandle),
      ),
      shutdown: vi.fn(async () => undefined),
    } as unknown as ObservabilityService;
    let now = 10;
    const telemetry = new VoiceTelemetry({ observability: service, now: () => now });

    telemetry.startCall({ callId: 'call-1', threadId: 'thread-1' });
    now = 15;
    telemetry.record({
      callId: 'call-1',
      stage: 'result_verified',
      status: 'completed',
      delegationId: 'delegation-1',
      providerDelegationId: 'provider-1',
      outputId: 'output-1',
    });
    telemetry.recordBrowserTelemetry({
      callId: 'call-1',
      samples: [{ category: 'audio', status: 'play_rejected', durationMs: 3.5 }],
    });
    telemetry.finishCall('call-1');

    expect(service.startWithTraceparent).toHaveBeenCalledTimes(6);
    expect(rootHandle.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(updates)).not.toContain('private transcript');
    expect(JSON.stringify(updates)).not.toContain('api-key');
    const stageExports = starts.filter((input) => input.name === 'voice-lifecycle-stage');
    expect(stageExports.map((input) => input.metadata?.stage)).toEqual([
      'call_created',
      'result_verified',
      'call_closure',
    ]);
    expect(stageExports[1]?.metadata).toEqual(
      expect.objectContaining({
        stage: 'result_verified',
        status: 'completed',
        outputId: 'output-1',
      }),
    );
    expect(starts.find((input) => input.name === 'voice-browser-metric')?.metadata).toEqual(
      expect.objectContaining({
        browser: true,
        browserCategory: 'audio',
        browserStatus: 'play_rejected',
        durationMs: 3.5,
      }),
    );
    expect(starts.find((input) => input.name === 'voice-lifecycle-summary')?.metadata?.summary).toContain(
      'p50DurationMs',
    );
    expect(handles.every((handle) => vi.mocked(handle.end).mock.calls.length === 1)).toBe(true);
    expect(telemetry.getSummary('call-1')).toEqual(
      expect.objectContaining({
        callId: 'call-1',
        threadId: 'thread-1',
        finalized: true,
        unknownCount: 0,
        unassociatedCount: 1,
      }),
    );
  });
});
