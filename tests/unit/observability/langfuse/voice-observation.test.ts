import { describe, expect, it, vi } from 'vitest';
import {
  createVoiceSafeLogger,
  createVoiceObservationContext,
  observeVoiceSafely,
  sanitizeVoiceObservationInput,
  sanitizeVoiceObservationMetadata,
  startVoiceObservationSafely,
  type VoiceObservationContext,
} from '../../../../src/observability/langfuse/voice-observation.js';
import type {
  ObservationHandle,
  ObservabilityService,
  StartedObservationHandle,
} from '../../../../src/observability/langfuse/observability-types.js';

const context = createVoiceObservationContext({
  callId: 'call-1',
  delegationId: 'delegation-1',
  queueItemId: 'queue-1',
  runId: 'run-1',
  threadId: 'thread-1',
  personaId: 'persona-1',
  provider: 'claude-code',
  model: 'claude-sonnet',
});

function makeHandle(): StartedObservationHandle {
  return {
    update: vi.fn(),
    getTraceparent: vi
      .fn()
      .mockReturnValue('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'),
    end: vi.fn(),
  };
}

function makeService(overrides: Partial<ObservabilityService> = {}): ObservabilityService {
  const handle = makeHandle();
  return {
    start: vi.fn(() => handle),
    startWithTraceparent: vi.fn(() => handle),
    observe: vi.fn(async (_input, callback) => await callback(handle)),
    observeWithTraceparent: vi.fn(async (_traceparent, _input, callback) => await callback(handle)),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('voice observation privacy boundary', () => {
  it('keeps the voice marker trusted and drops invalid or oversized identifiers', () => {
    const oversized = 'x'.repeat(257);
    const value = createVoiceObservationContext({ callId: oversized, runId: 'run-1' });

    expect(value).toEqual({ kind: 'voice', redacted: true, runId: 'run-1' });
    expect(Object.isFrozen(value)).toBe(true);
  });

  it('sanitizes content and ignores forged or unknown metadata', () => {
    const metadata = sanitizeVoiceObservationMetadata(context, {
      voice: false,
      redacted: false,
      runId: 'forged-run',
      provider: 'forged-provider',
      messageType: 'tool_use',
      toolName: 'safe-but-unknown-tool',
      serverName: 'safe-but-unknown-server',
      secret: 'transcript and tool arguments',
    });
    const input = sanitizeVoiceObservationInput(
      {
        type: 'tool',
        name: 'channel.send',
        input: { transcript: 'private transcript', secret: 'tool argument' },
        output: 'private output',
        metadata: { outputId: 'output-1' },
        trace: {
          input: 'private prompt',
          output: 'private output',
        },
        modelParameters: { secret: 'private model parameter' },
        usageDetails: { secret: 1 },
        costDetails: { secret: 2 },
      },
      context,
    );

    expect(metadata).toEqual(
      expect.objectContaining({
        voice: true,
        redacted: true,
        runId: 'run-1',
        provider: 'claude-code',
        messageType: 'tool_use',
        toolName: 'voice-tool',
        serverName: 'voice-server',
      }),
    );
    expect(metadata).not.toHaveProperty('secret');
    expect(input).toEqual(
      expect.objectContaining({
        name: 'voice-tool',
        input: '[voice tool input redacted]',
        output: '[voice tool output redacted]',
        metadata: expect.objectContaining({ callId: 'call-1' }),
        trace: expect.objectContaining({
          input: '[voice tool input redacted]',
          output: '[voice tool output redacted]',
        }),
      }),
    );
    expect(input?.modelParameters).toBeUndefined();
    expect(input?.usageDetails).toBeUndefined();
    expect(input?.costDetails).toBeUndefined();
    expect(JSON.stringify(input)).not.toContain('private');
  });

  it('runs the callback once when observation setup fails', async () => {
    const callback = vi.fn().mockResolvedValue('result');
    const service = makeService({
      observe: vi.fn().mockRejectedValue(new Error('exporter setup failed')),
    });

    await expect(
      observeVoiceSafely({
        service,
        input: { type: 'agent', name: 'voice-run', input: { secret: 'content' } },
        context,
        callback,
      }),
    ).resolves.toBe('result');
    expect(callback).toHaveBeenCalledOnce();
  });

  it('drops oversized telemetry without changing execution', async () => {
    const callback = vi.fn().mockResolvedValue('result');
    const service = makeService();
    const largeContext = createVoiceObservationContext({
      callId: 'c'.repeat(256),
      delegationId: 'd'.repeat(256),
      queueItemId: 'q'.repeat(256),
      runId: 'r'.repeat(256),
      threadId: 't'.repeat(256),
      personaId: 'p'.repeat(256),
      provider: 'v'.repeat(256),
      model: 'm'.repeat(256),
    });

    await expect(
      observeVoiceSafely({
        service,
        input: {
          type: 'tool',
          name: 'voice-tool',
          metadata: {
            serverName: 'x'.repeat(256),
            toolName: 'x'.repeat(256),
            resultSessionId: 'x'.repeat(256),
            resumeSessionId: 'x'.repeat(256),
            outputId: 'x'.repeat(256),
            messageType: 'x'.repeat(64),
            subtype: 'x'.repeat(64),
            status: 'x'.repeat(64),
            errorCategory: 'x'.repeat(64),
          },
        },
        context: largeContext,
        callback,
      }),
    ).resolves.toBe('result');
    expect(callback).toHaveBeenCalledOnce();
    expect(service.observe).not.toHaveBeenCalled();
  });

  it('preserves the callback result when observer cleanup fails', async () => {
    const callback = vi.fn().mockResolvedValue({ ok: true });
    const service = makeService({
      observe: vi.fn(async (_input, fn) => {
        await fn({
          update: vi.fn(),
          getTraceparent: vi.fn().mockReturnValue(null),
        });
        throw new Error('exporter cleanup failed');
      }),
    });

    await expect(
      observeVoiceSafely({
        service,
        input: { type: 'agent', name: 'voice-run' },
        context,
        callback,
      }),
    ).resolves.toEqual({ ok: true });
    expect(callback).toHaveBeenCalledOnce();
  });

  it('does not execute the callback twice when an observer invokes it twice', async () => {
    const callback = vi.fn().mockResolvedValue('result');
    const service = makeService({
      observe: vi.fn(async (_input, fn) => {
        await Promise.all([fn(makeHandle()), fn(makeHandle())]);
      }),
    });

    await expect(
      observeVoiceSafely({
        service,
        input: { type: 'agent', name: 'voice-run' },
        context,
        callback,
      }),
    ).resolves.toBe('result');
    expect(callback).toHaveBeenCalledOnce();
  });

  it('preserves the real callback error without passing it to the observer', async () => {
    const sentinel = 'transcript secret from provider exception';
    const observed: unknown[] = [];
    const service = makeService({
      observe: vi.fn(async (input, fn) => {
        observed.push(input);
        const handle: ObservationHandle = {
          update: (update) => observed.push(update),
          getTraceparent: () => null,
        };
        await fn(handle);
      }),
    });
    const callback = vi.fn().mockRejectedValue(new Error(sentinel));

    await expect(
      observeVoiceSafely({
        service,
        input: { type: 'agent', name: 'voice-run', input: { secret: sentinel } },
        context,
        callback,
      }),
    ).rejects.toThrow(sentinel);
    expect(callback).toHaveBeenCalledOnce();
    expect(JSON.stringify(observed)).not.toContain(sentinel);
  });

  it('makes manual span cleanup best effort and content-free', () => {
    const handle = makeHandle();
    vi.mocked(handle.update).mockImplementation(() => {
      throw new Error('update failed');
    });
    vi.mocked(handle.end).mockImplementation(() => {
      throw new Error('end failed');
    });
    const service = makeService({ startWithTraceparent: vi.fn(() => handle) });
    const observation = startVoiceObservationSafely(
      service,
      'forged-parent',
      { type: 'tool', name: 'voice-tool', input: { secret: 'tool argument' } },
      context,
    );

    expect(() => {
      observation.update({ output: { secret: 'tool result' } });
      observation.end();
    }).not.toThrow();
    expect(handle.update).toHaveBeenCalledWith(
      expect.objectContaining({ output: '[voice tool output redacted]' }),
    );
  });

  it('swallows underlying logger failures without exposing voice diagnostics', () => {
    const throwingLogger = {
      debug: () => { throw new Error('debug failed'); },
      info: () => { throw new Error('info failed'); },
      warn: () => { throw new Error('warn failed'); },
      error: () => { throw new Error('error failed'); },
      fatal: () => { throw new Error('fatal failed'); },
      trace: () => { throw new Error('trace failed'); },
      child: vi.fn(),
    } as any;
    const safeLogger = createVoiceSafeLogger(throwingLogger);

    expect(() => {
      safeLogger.debug({ secret: 'transcript' }, 'raw debug');
      safeLogger.info({ secret: 'prompt' }, 'raw info');
      safeLogger.warn({ secret: 'error' }, 'raw warning');
      safeLogger.error({ secret: 'exception' }, 'raw error');
      safeLogger.fatal({ secret: 'result' }, 'raw fatal');
      safeLogger.trace({ secret: 'tool' }, 'raw trace');
    }).not.toThrow();
  });
});
