import { describe, expect, it, vi } from 'vitest';
import { okResponse } from '../../../support/http-test-helpers.js';
import type {
  VoiceBrowserClient,
  VoiceBrowserClientOptions,
  VoiceEventSource,
  VoiceFetch,
  VoicePeerConnection,
} from '../../../../src/voice/web/voice-client.js';
import { VoiceBrowserClient as BrowserClient } from '../../../../src/voice/web/voice-client.js';
import type {
  VoiceDelegationStatusDto,
  VoiceOutputStatusDto,
  VoiceSessionStatusDto,
} from '../../../../src/voice/voice-types.js';

function okResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

class FakeEventSource implements VoiceEventSource {
  readonly listeners = new Map<string, (event: Event) => void>();
  readonly close = vi.fn();

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, value: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(value) }));
  }

  emitConnectionError(): void {
    this.listeners.get('error')?.(new Event('error'));
  }
}

interface FakePeer {
  readonly peer: VoicePeerConnection;
  readonly addTrack: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly setRemoteDescription: ReturnType<typeof vi.fn>;
  setConnectionState(state: RTCPeerConnectionState): void;
}

function makePeer(): FakePeer {
  let connectionState: RTCPeerConnectionState = 'new';
  let localDescription: RTCSessionDescription | null = null;
  const peer = {
    get connectionState() {
      return connectionState;
    },
    get localDescription() {
      return localDescription;
    },
    onconnectionstatechange: null,
    ontrack: null,
    addTrack: vi.fn(),
    createOffer: vi.fn(async () => ({ type: 'offer' as const, sdp: 'browser-offer-sdp' })),
    setLocalDescription: vi.fn(async (offer: RTCSessionDescriptionInit) => {
      localDescription = { type: 'offer', sdp: offer.sdp ?? '' } as RTCSessionDescription;
    }),
    setRemoteDescription: vi.fn(async () => {
      connectionState = 'connected';
    }),
    close: vi.fn(),
  } as unknown as VoicePeerConnection;

  return {
    peer,
    addTrack: (peer as unknown as { addTrack: ReturnType<typeof vi.fn> }).addTrack,
    close: (peer as unknown as { close: ReturnType<typeof vi.fn> }).close,
    setRemoteDescription: (peer as unknown as { setRemoteDescription: ReturnType<typeof vi.fn> })
      .setRemoteDescription,
    setConnectionState: (state: RTCPeerConnectionState): void => {
      connectionState = state;
      peer.onconnectionstatechange?.(new Event('connectionstatechange'));
    },
  };
}

function makeStream(): { stream: MediaStream; track: MediaStreamTrack } {
  const track = {
    enabled: true,
    kind: 'audio',
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

function makeOutput(overrides: Partial<VoiceOutputStatusDto> = {}): VoiceOutputStatusDto {
  return {
    delegationId: 'delegation-1',
    id: 'output-1',
    kind: 'final',
    text: 'De taak is afgerond.',
    lifecycle: {
      execution: 'succeeded',
      delivery: 'acknowledged',
      providerAcknowledgement: 'acknowledged',
      playback: 'not_started',
    },
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function makeDelegation(
  overrides: Partial<VoiceDelegationStatusDto> = {},
): VoiceDelegationStatusDto {
  return {
    id: 'delegation-1',
    revision: 1,
    status: 'running',
    contextVersion: 1,
    execution: 'running',
    output: {
      execution: 'running',
      delivery: 'pending',
      providerAcknowledgement: 'sent',
      playback: 'not_started',
    },
    outputs: [makeOutput({ lifecycle: { ...makeOutput().lifecycle, execution: 'running' } })],
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function makeStatus(
  overrides: Partial<VoiceSessionStatusDto> = {},
): VoiceSessionStatusDto {
  return {
    id: 'session-1',
    status: 'connecting',
    transport: 'webrtc',
    createdAt: 100,
    startedAt: 100,
    deadlineAt: 10_000,
    delegations: [],
    usage: {
      voiceSeconds: 11,
      voiceCostUsd: 0.0123,
      voiceCostStatus: 'estimated',
      backendCostStatus: 'unavailable',
    },
    finalization: { status: 'pending' },
    ...overrides,
  };
}

function createResponse(session: VoiceSessionStatusDto = makeStatus()): Record<string, unknown> {
  return {
    session,
    client: {
      transport: 'webrtc',
      sessionId: session.id,
      providerSessionId: 'provider-session-1',
      answer: { type: 'answer', sdp: 'server-answer-sdp' },
      expiresAt: session.deadlineAt,
    },
  };
}

function makeClient(
  overrides: Partial<VoiceBrowserClientOptions> & {
    fetcher: VoiceFetch;
    source: FakeEventSource;
    peer: FakePeer;
  },
): VoiceBrowserClient {
  const { fetcher, source, peer, ...options } = overrides;
  return new BrowserClient({
    fetch: fetcher,
    eventSourceFactory: () => source,
    peerConnectionFactory: () => peer.peer,
    csrfToken: () => 'csrf-token',
    ...options,
  });
}

describe('VoiceBrowserClient', () => {
  it('logs in, sends a WebRTC offer with cookie-backed CSRF, and handles mute plus status events', async () => {
    const { stream, track } = makeStream();
    const peer = makePeer();
    const source = new FakeEventSource();
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const fetcher: VoiceFetch = vi.fn(async (input, init) => {
      requests.push({ input, init });
      if (input.endsWith('/login')) return okResponse({ authenticated: true, expiresAt: 10_000 });
      if (input.endsWith('/sessions')) return okResponse(createResponse());
      return new Response(null, { status: 204 });
    });
    const client = makeClient({
      fetcher,
      source,
      peer,
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    });

    await client.login('operator-token');
    await client.startCall();

    expect(requests[0]?.init?.credentials).toBe('include');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ accessToken: 'operator-token' });
    const createRequest = requests.find((request) => request.input.endsWith('/sessions'));
    expect(createRequest?.init?.headers).toEqual({
      'content-type': 'application/json',
      'x-csrf-token': 'csrf-token',
    });
    expect(JSON.parse(String(createRequest?.init?.body))).toEqual({
      transport: { type: 'webrtc', sdp: 'browser-offer-sdp' },
    });
    expect(client.state.phase).toBe('connected');

    peer.setConnectionState('connected');
    expect(client.state.phase).toBe('connected');
    expect(client.toggleMute()).toBe(true);
    expect(track.enabled).toBe(false);
    expect(client.toggleMute()).toBe(false);
    expect(track.enabled).toBe(true);

    source.emit('delegation', {
      kind: 'delegation',
      version: 1,
      delegation: makeDelegation(),
      occurredAt: 200,
    });
    expect(client.state.outputs[0]?.text).toBe('De taak is afgerond.');
    expect(client.state.pendingDelegation).toBe(true);
  });

  it('shows a microphone-denied error and releases the call without creating a session', async () => {
    const peer = makePeer();
    const source = new FakeEventSource();
    const fetcher: VoiceFetch = vi.fn(async (input) => {
      if (input.endsWith('/login')) return okResponse({ authenticated: true, expiresAt: 10_000 });
      return new Response(null, { status: 204 });
    });
    const client = makeClient({
      fetcher,
      source,
      peer,
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException('permission denied', 'NotAllowedError');
        }),
      },
    });

    await client.login('operator-token');
    await expect(client.startCall()).rejects.toMatchObject({ code: 'MICROPHONE_DENIED' });
    expect(client.state.phase).toBe('failed');
    expect(client.state.message).toContain('Microfoontoegang is geweigerd');
    expect(peer.close).not.toHaveBeenCalled();
  });

  it('hangs up the transport while retaining a result for a task that is still running', async () => {
    const { stream, track } = makeStream();
    const peer = makePeer();
    const source = new FakeEventSource();
    const closeStatus = makeStatus({
      status: 'closed',
      delegations: [makeDelegation()],
      closedAt: 300,
    });
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const fetcher: VoiceFetch = vi.fn(async (input, init) => {
      requests.push({ input, init });
      if (input.endsWith('/login')) return okResponse({ authenticated: true, expiresAt: 10_000 });
      if (input.endsWith('/sessions')) return okResponse(createResponse(makeStatus({ status: 'connected' })));
      if (input.endsWith('/close')) {
        return okResponse({ session: closeStatus, pendingDelegation: true });
      }
      return new Response(null, { status: 204 });
    });
    const client = makeClient({
      fetcher,
      source,
      peer,
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    });

    await client.login('operator-token');
    await client.startCall();
    source.emit('delegation', {
      kind: 'delegation',
      version: 1,
      delegation: makeDelegation(),
      occurredAt: 200,
    });
    await client.hangup();

    expect(requests.some((request) => request.input.endsWith('/sessions/session-1/close'))).toBe(true);
    expect(client.state.phase).toBe('closed');
    expect(client.state.pendingDelegation).toBe(true);
    expect(client.state.outputs[0]?.text).toBe('De taak is afgerond.');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(source.close).not.toHaveBeenCalled();

    source.emit('delegation', {
      kind: 'delegation',
      version: 2,
      delegation: makeDelegation({ status: 'completed', execution: 'succeeded' }),
      occurredAt: 400,
    });
    expect(client.state.pendingDelegation).toBe(false);
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('reports a status stream network loss while keeping the session available to hang up', async () => {
    const { stream } = makeStream();
    const peer = makePeer();
    const source = new FakeEventSource();
    const fetcher: VoiceFetch = vi.fn(async (input) => {
      if (input.endsWith('/login')) return okResponse({ authenticated: true, expiresAt: 10_000 });
      if (input.endsWith('/sessions')) return okResponse(createResponse());
      return new Response(null, { status: 204 });
    });
    const client = makeClient({
      fetcher,
      source,
      peer,
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    });

    await client.login('operator-token');
    await client.startCall();
    source.emitConnectionError();

    expect(client.state.phase).toBe('network_lost');
    expect(client.state.sessionId).toBe('session-1');
    expect(client.state.message).toContain('statusverbinding');
  });

  it('surfaces autoplay blocking and retries audio after an explicit user action', async () => {
    const { stream } = makeStream();
    const peer = makePeer();
    const source = new FakeEventSource();
    const audio = {
      srcObject: null,
      play: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error('autoplay blocked'))
        .mockResolvedValue(undefined),
      pause: vi.fn(),
    };
    const fetcher: VoiceFetch = vi.fn(async (input) => {
      if (input.endsWith('/login')) return okResponse({ authenticated: true, expiresAt: 10_000 });
      if (input.endsWith('/sessions')) {
        return okResponse(
          createResponse(makeStatus({ delegations: [makeDelegation({ status: 'completed' })] })),
        );
      }
      return new Response(null, { status: 204 });
    });
    const client = makeClient({
      fetcher,
      source,
      peer,
      audioElement: audio,
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    });

    await client.login('operator-token');
    await client.startCall();
    peer.peer.ontrack?.({ streams: [{} as MediaStream] } as RTCTrackEvent);
    await vi.waitFor(() => expect(client.state.audioBlocked).toBe(true));
    expect(client.state.message).toContain('Audio staat klaar');

    await client.resumeAudio();
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(client.state.audioBlocked).toBe(false);
  });
});
