import { describe, expect, it, vi } from 'vitest';
import { ok } from '../../../src/core/types/result.js';
import {
  createConfiguredVoiceAdapters,
  createVoiceAdapterSelection,
  VoiceCallAdmission,
} from '../../../src/voice/voice-adapters.js';
import {
  createVoiceAuthorization,
  resolveExactVoiceGrant,
  revokeExactVoiceGrant,
  type VoiceGrant,
} from '../../../src/voice/voice-authorization.js';
import type {
  LiveVoiceProvider,
  VoiceAudioStreamTransportOffer,
  VoiceCapabilityMap,
  VoiceTransport,
  VoiceTransportOffer,
} from '../../../src/voice/voice-types.js';

function fakeTransport(kind: string, capabilities: VoiceCapabilityMap): VoiceTransport {
  return {
    kind,
    capabilities,
    open: vi.fn(async (input) =>
      ok({
        sessionId: input.sessionId,
        transportSessionId: `${kind}:session`,
        kind,
        status: 'connected' as const,
      }),
    ),
    status: vi.fn(() => ok('connected' as const)),
    onEvent: vi.fn(() => (): void => undefined),
    close: vi.fn(async () => ok(undefined)),
  };
}

function fakeEngine(name: string, capabilities: VoiceCapabilityMap): LiveVoiceProvider {
  return {
    name,
    capabilities,
    createSession: vi.fn(async () => {
      throw new Error('unused in adapter seam test');
    }),
    attachSideband: vi.fn(async () => {
      throw new Error('unused in adapter seam test');
    }),
    closeSession: vi.fn(async () => ok(undefined)),
  };
}

const supportedCapabilities: VoiceCapabilityMap = {
  audio_streaming: 'supported',
  interruptions: 'supported',
  delegation: 'supported',
  transcript_stability: 'supported',
  usage_reporting: 'supported',
};

describe('voice adapter seam', () => {
  it('selects two trusted transport and engine pairs, including a no-SDP audio stream', () => {
    const createBrowser = vi.fn(() => fakeTransport('webrtc', supportedCapabilities));
    const createStream = vi.fn(() => fakeTransport('audio_stream', supportedCapabilities));
    const createLive = vi.fn(() => fakeEngine('live', supportedCapabilities));
    const createLocal = vi.fn(() => fakeEngine('local', supportedCapabilities));
    const browserSelection = createConfiguredVoiceAdapters({
      transports: [{ name: 'webrtc', capabilities: supportedCapabilities, create: createBrowser }],
      engines: [{ name: 'live', capabilities: supportedCapabilities, create: createLive }],
      transportName: 'webrtc',
      engineName: 'live',
    });
    const streamSelection = createConfiguredVoiceAdapters({
      transports: [
        { name: 'audio_stream', capabilities: supportedCapabilities, create: createStream },
      ],
      engines: [{ name: 'local', capabilities: supportedCapabilities, create: createLocal }],
      transportName: 'audio_stream',
      engineName: 'local',
    });
    expect(browserSelection.isOk()).toBe(true);
    expect(streamSelection.isOk()).toBe(true);
    expect(createBrowser).toHaveBeenCalledOnce();
    expect(createStream).toHaveBeenCalledOnce();
    expect(createLive).toHaveBeenCalledOnce();
    expect(createLocal).toHaveBeenCalledOnce();

    const offer: VoiceTransportOffer = {
      type: 'audio_stream',
      format: { codec: 'pcm16', sampleRateHz: 24_000, channels: 1 },
    } satisfies VoiceAudioStreamTransportOffer;
    expect(offer).toEqual({
      type: 'audio_stream',
      format: { codec: 'pcm16', sampleRateHz: 24_000, channels: 1 },
    });
  });

  it('denies unsupported or unknown capabilities before constructing a provider', () => {
    const createTransport = vi.fn(() => fakeTransport('webrtc', supportedCapabilities));
    const createEngine = vi.fn(() => fakeEngine('paid-live', supportedCapabilities));
    const unsupported = createConfiguredVoiceAdapters({
      transports: [
        {
          name: 'webrtc',
          capabilities: { ...supportedCapabilities, interruptions: 'unsupported' },
          create: createTransport,
        },
      ],
      engines: [{ name: 'paid-live', capabilities: supportedCapabilities, create: createEngine }],
      transportName: 'webrtc',
      engineName: 'paid-live',
    });
    expect(unsupported.isErr()).toBe(true);
    expect(createTransport).not.toHaveBeenCalled();
    expect(createEngine).not.toHaveBeenCalled();

    const unknown = createVoiceAdapterSelection({
      transport: fakeTransport('webrtc', supportedCapabilities),
      engine: fakeEngine('unknown-engine', {}),
    });
    expect(unknown.isErr()).toBe(true);
  });

  it('requires an exact active grant and revokes only that grant', () => {
    const current = {
      ownerId: 'operator-1',
      loginRevision: 7,
    };
    let active: VoiceGrant | undefined = {
      owner: current,
      grantRevision: current.loginRevision,
      transport: 'browser',
    };
    const source = {
      resolve: vi.fn(() => ok(active)),
      revoke: vi.fn(() => {
        active = undefined;
        return ok(undefined);
      }),
    };
    const authorization = createVoiceAuthorization(source);

    expect(resolveExactVoiceGrant(authorization, current).isOk()).toBe(true);
    expect(
      resolveExactVoiceGrant(authorization, { ownerId: current.ownerId, loginRevision: 8 }).isErr(),
    ).toBe(true);
    expect(authorization.revoke({ ownerId: current.ownerId, loginRevision: 8 }).isErr()).toBe(true);
    expect(revokeExactVoiceGrant(authorization, current).isOk()).toBe(true);
    expect(source.revoke).toHaveBeenCalledWith(current);
    expect(resolveExactVoiceGrant(authorization, current).isErr()).toBe(true);
  });

  it('counts pending setup reservations and releases the slot after setup ends', () => {
    const admission = new VoiceCallAdmission(1);
    const first = admission.reserve('operator-1');
    expect(first.isOk()).toBe(true);
    if (first.isErr()) return;

    const pending = admission.reserve('operator-2');
    expect(pending.isErr()).toBe(true);
    expect(admission.size).toBe(1);

    expect(first.value.bind('session-1').isOk()).toBe(true);
    expect(admission.hasSession('session-1')).toBe(true);
    first.value.release();

    const next = admission.reserve('operator-2');
    expect(next.isOk()).toBe(true);
    expect(admission.size).toBe(1);
  });

  it('applies the configured creation budget per owner across transports', () => {
    let now = 1_000;
    const admission = new VoiceCallAdmission(2, {
      maxSessionCreations: 1,
      sessionCreationWindowMs: 100,
      now: () => now,
    });

    const first = admission.reserve('operator-1');
    expect(first.isOk()).toBe(true);
    if (first.isErr()) return;
    first.value.release();
    expect(admission.reserve('operator-1').isErr()).toBe(true);
    expect(admission.reserve('operator-2').isOk()).toBe(true);

    now = 1_101;
    expect(admission.reserve('operator-1').isOk()).toBe(true);
  });
});
