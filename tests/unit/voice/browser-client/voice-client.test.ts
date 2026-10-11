import { describe, expect, it, vi } from 'vitest';
import { okResponse } from '../../../support/http-test-helpers.js';
import type {
  VoiceBrowserClient,
  VoiceBrowserClientOptions,
  VoiceEventSource,
  VoiceSessionStorage,
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
  readonly createDataChannel: ReturnType<typeof vi.fn>;
  emitProviderEvent(value: unknown): void;
  setIceGatheringState(state: RTCIceGatheringState): void;
  setConnectionState(state: RTCPeerConnectionState): void;
}

function makePeer(initialIceGatheringState: RTCIceGatheringState = 'complete'): FakePeer {
  let connectionState: RTCPeerConnectionState = 'new';
  let iceGatheringState = initialIceGatheringState;
  const dataChannelListeners = new Map<string, (event: MessageEvent) => void>();
  let localDescription: RTCSessionDescription | null = null;
  const peer = {
    get connectionState() {
      return connectionState;
    },
    get localDescription() {
      return localDescription;
    },
    get iceGatheringState() {
      return iceGatheringState;
    },
    onconnectionstatechange: null,
    onicegatheringstatechange: null,
    ontrack: null,
    addTrack: vi.fn(),
    createDataChannel: vi.fn(() => ({
      addEventListener: (type: string, listener: (event: MessageEvent) => void): void => {
        dataChannelListeners.set(type, listener);
      },
    }) as unknown as RTCDataChannel),
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
    createDataChannel: (peer as unknown as { createDataChannel: ReturnType<typeof vi.fn> }).createDataChannel,
    emitProviderEvent: (value: unknown): void => {
      dataChannelListeners.get('message')?.(new MessageEvent('message', { data: JSON.stringify(value) }));
    },
    setIceGatheringState: (state: RTCIceGatheringState): void => {
      iceGatheringState = state;
      peer.onicegatheringstatechange?.(new Event('icegatheringstatechange'));
    },
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function makeStorage(initial: string | null = null): VoiceSessionStorage & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  if (initial) values.set('talon.voice.session-id', initial);
  return {
    values,
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
    removeItem: (key: string): void => {
      values.delete(key);
    },
  };
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
      answer: { type: 'webrtc', sdp: 'server-answer-sdp' },
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
    expect(peer.createDataChannel).toHaveBeenCalledWith('oai-events');
    expect(client.state.phase).toBe('connecting');

    source.emit('session', {
      kind: 'session',
      version: 1,
      session: makeStatus({ status: 'connected' }),
      occurredAt: 150,
    });
    peer.emitProviderEvent({ type: 'session.started', session: { id: 'provider-session-1' } });
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

  it('waits for complete ICE gathering before sending the offer', async () => {
    const { stream } = makeStream();
    const peer = makePeer('gathering');
    const source = new FakeEventSource();
    const requests: string[] = [];
    const fetcher: VoiceFetch = vi.fn(async (input) => {
      requests.push(input);
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
    const start = client.startCall();
    await vi.waitFor(() => expect(peer.peer.createOffer).toHaveBeenCalled());
    expect(requests.some((input) => input.endsWith('/sessions'))).toBe(false);

    peer.setIceGatheringState('complete');
    await start;
    expect(requests.some((input) => input.endsWith('/sessions'))).toBe(true);
  });

  it.each(['dispose', 'hangup', 'logout'] as const)(
    'stops a microphone stream that arrives after %s',
    async (action) => {
      const { stream, track } = makeStream();
      const peer = makePeer();
      const source = new FakeEventSource();
      const microphone = deferred<MediaStream>();
      const fetcher: VoiceFetch = vi.fn(async (input) => {
        if (input.endsWith('/login')) return okResponse({ authenticated: true, expiresAt: 10_000 });
        return new Response(null, { status: 204 });
      });
      const client = makeClient({
        fetcher,
        source,
        peer,
        mediaDevices: { getUserMedia: vi.fn(() => microphone.promise) },
      });

      await client.login('operator-token');
      const start = client.startCall();
      await vi.waitFor(() => expect(client.state.phase).toBe('requesting_microphone'));
      if (action === 'dispose') client.dispose();
      else await client[action]();
      microphone.resolve(stream);
      await start;

      expect(track.stop).toHaveBeenCalledOnce();
      expect(peer.close).not.toHaveBeenCalled();
      expect(client.state.activeSessionId).toBeNull();
    },
  );

  it.each(['dispose', 'hangup', 'logout'] as const)(
    'closes a session returned after %s invalidates startup',
    async (action) => {
      const { stream, track } = makeStream();
      const peer = makePeer();
      const source = new FakeEventSource();
      const create = deferred<Response>();
      const requests: string[] = [];
      const fetcher: VoiceFetch = vi.fn(async (input) => {
        requests.push(input);
        if (input.endsWith('/login')) return okResponse({ authenticated: true, expiresAt: 10_000 });
        if (input.endsWith('/sessions')) return create.promise;
        if (input.endsWith('/close')) {
          return okResponse({ session: makeStatus({ status: 'closed' }), pendingDelegation: false });
        }
        if (input.endsWith('/logout')) return okResponse({ loggedOut: true });
        return new Response(null, { status: 204 });
      });
      const client = makeClient({
        fetcher,
        source,
        peer,
        mediaDevices: { getUserMedia: vi.fn(async () => stream) },
      });

      await client.login('operator-token');
      const start = client.startCall();
      await vi.waitFor(() => expect(requests.some((input) => input.endsWith('/sessions'))).toBe(true));
      if (action === 'dispose') client.dispose();
      else await client[action]();
      create.resolve(okResponse(createResponse()));
      await start;

      expect(requests.some((input) => input.endsWith('/sessions/session-1/close'))).toBe(true);
      expect(track.stop).toHaveBeenCalledOnce();
      expect(peer.close).toHaveBeenCalledOnce();
      expect(client.state.activeSessionId).toBeNull();
    },
  );

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

  it('keeps retained results separate so a new call can start', async () => {
    const first = makeStream();
    const second = makeStream();
    const firstPeer = makePeer();
    const secondPeer = makePeer();
    const source = new FakeEventSource();
    let createCount = 0;
    const storage = makeStorage();
    const fetcher: VoiceFetch = vi.fn(async (input) => {
      if (input.endsWith('/login')) return okResponse({ authenticated: true, expiresAt: 10_000 });
      if (input.endsWith('/sessions')) {
        createCount += 1;
        return okResponse(createResponse(makeStatus({ id: `session-${createCount}` })));
      }
      if (input.endsWith('/close')) {
        return okResponse({
          session: makeStatus({ id: 'session-1', status: 'closed', closedAt: 300 }),
          pendingDelegation: false,
        });
      }
      return new Response(null, { status: 204 });
    });
    const client = makeClient({
      fetcher,
      source,
      peer: firstPeer,
      sessionStorage: storage,
      peerConnectionFactory: vi.fn(() => (createCount === 0 ? firstPeer.peer : secondPeer.peer)),
      mediaDevices: {
        getUserMedia: vi.fn(async () => (createCount === 0 ? first.stream : second.stream)),
      },
    });

    await client.login('operator-token');
    await client.startCall();
    await client.hangup();
    expect(client.state.activeSessionId).toBeNull();
    expect(client.state.retainedSessionId).toBe('session-1');
    expect(storage.values.get('talon.voice.session-id')).toBe('session-1');

    await client.startCall();
    expect(client.state.activeSessionId).toBe('session-2');
    expect(client.state.retainedSessionId).toBeNull();
    expect(client.state.outputs).toHaveLength(0);
    expect(storage.values.get('talon.voice.session-id')).toBe('session-2');
  });

  it('restores retained results through the authenticated cookie without replaying a call', async () => {
    const storage = makeStorage('session-1');
    const status = makeStatus({
      id: 'session-1',
      status: 'closed',
      delegations: [makeDelegation({ status: 'completed', execution: 'succeeded' })],
    });
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const source = new FakeEventSource();
    const peer = makePeer();
    const fetcher: VoiceFetch = vi.fn(async (input, init) => {
      requests.push({ input, init });
      if (input.endsWith('/sessions/session-1')) return okResponse({ session: status });
      return new Response(null, { status: 204 });
    });
    const client = makeClient({ fetcher, source, peer, sessionStorage: storage });

    await client.restore();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toContain('/sessions/session-1');
    expect(requests[0]?.init?.method).toBe('GET');
    expect(requests[0]?.init?.credentials).toBe('include');
    expect(client.state.authenticated).toBe(true);
    expect(client.state.retainedSessionId).toBe('session-1');
    expect(client.state.outputs[0]?.text).toBe('De taak is afgerond.');
    expect(client.state.phase).toBe('closed');
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
    expect(client.state.activeSessionId).toBe('session-1');
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
    expect(requestsFor(fetcher).some((input) => input.endsWith('/playback'))).toBe(false);
  });
});

function requestsFor(fetcher: VoiceFetch): string[] {
  return (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => String(input));
}
