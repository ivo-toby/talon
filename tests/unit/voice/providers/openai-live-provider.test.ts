import { describe, expect, it, vi } from 'vitest';
import type { LiveWebSocket } from '../../../../src/voice/providers/openai-live-provider.js';
import {
  OpenAiLiveVoiceProvider,
  OpenAiLiveVoiceSideband,
} from '../../../../src/voice/providers/openai-live-provider.js';
import type { LiveVoiceSessionRequest } from '../../../../src/voice/voice-types.js';

class FakeSocket {
  readyState = 0;
  terminated = false;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, handler: (...args: unknown[]) => void): this {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
    return this;
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', 1000, Buffer.from('closed'));
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit('close', 1000, Buffer.from('terminated'));
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  receive(event: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(event)), false);
  }

  fail(): void {
    this.emit('error', new Error('fake socket failure'));
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const handler of this.listeners.get(event) ?? []) handler(...args);
  }
}

function request(overrides: Partial<LiveVoiceSessionRequest> = {}): LiveVoiceSessionRequest {
  return {
    sessionId: 'voice-session-1',
    ownerId: 'operator-1',
    modelName: 'gpt-live-1',
    instructions: 'Speak briefly and wait for the operator.',
    delegationMode: 'client',
    transport: { type: 'webrtc', sdp: 'v=0\r\n' },
    audio: { output: { voice: 'marin' } },
    ...overrides,
  };
}

function response(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OpenAiLiveVoiceProvider', () => {
  it('creates an explicit GPT-Live WebRTC session with Marin and no owner data', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return response({
        session: { id: 'provider-session-1' },
        transport: { type: 'webrtc', sdp: 'answer' },
      });
    });
    const provider = new OpenAiLiveVoiceProvider({ apiKey: 'test-key', fetch });

    const result = await provider.createSession(request());

    expect(result.isOk()).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.openai.com/v1/live/sessions');
    expect(requests[0].url).not.toContain('realtime');
    const body = JSON.parse(String(requests[0].init?.body)) as Record<string, any>;
    expect(body.session.audio.output.voice).toBe('marin');
    expect(body.session.delegation).toEqual({ type: 'client' });
    expect(body.session.store).toBe(false);
    expect(body.session.ownerId).toBeUndefined();
    expect(body.session.instructions).toBe(request().instructions);
  });

  it('normalizes transcript, correction, delegation, cumulative usage, and acknowledgements', async () => {
    const socket = new FakeSocket();
    let sidebandUrl = '';
    const fetch = vi.fn(async () =>
      response({ session: { id: 'provider-session-2' }, transport: { sdp: 'answer' } }),
    );
    const provider = new OpenAiLiveVoiceProvider({
      apiKey: 'test-key',
      fetch,
      webSocketFactory: (url) => {
        sidebandUrl = url;
        return socket as unknown as LiveWebSocket;
      },
      now: () => 1_000,
    });
    const created = await provider.createSession(request({ sessionId: 'voice-session-2' }));
    const session = created._unsafeUnwrap();
    const attachedPromise = provider.attachSideband(session);
    socket.open();
    const attached = await attachedPromise;
    const sideband = attached._unsafeUnwrap() as OpenAiLiveVoiceSideband;
    expect(sidebandUrl).toBe('wss://api.openai.com/v1/live/sessions/provider-session-2/attach');
    const events: Array<Record<string, unknown>> = [];
    sideband.onEvent((event) => events.push(event as unknown as Record<string, unknown>));

    socket.receive({
      type: 'session.input_transcript.delta',
      event_id: 'transcript-1',
      item_id: 'utterance-1',
      delta: 'Book Friday',
      start_ms: 0,
      end_ms: 100,
    });
    socket.receive({
      type: 'session.delegation.created',
      event_id: 'delegation-1',
      delegation: { id: 'provider-delegation-1', target: 'client' },
      offset_ms: 100,
    });
    socket.receive({
      type: 'session.input_transcript.delta',
      event_id: 'transcript-1',
      item_id: 'utterance-1',
      delta: 'duplicate',
      start_ms: 0,
      end_ms: 100,
    });
    socket.receive({
      type: 'session.input_transcript.correction',
      event_id: 'transcript-2',
      item_id: 'utterance-1',
      text: 'No Thursday',
      start_ms: 0,
      end_ms: 80,
    });

    const command = await sideband.send({
      kind: 'commentary',
      delegationId: 'provider-delegation-1',
      content: 'I received the request.',
      outputId: 'output-1',
    });
    expect(command.isOk()).toBe(true);
    const sent = JSON.parse(socket.sent[0]) as { event_id: string };
    socket.receive({
      type: 'session.commentary.appended',
      event_id: 'ack-1',
      client_event_id: sent.event_id,
    });
    socket.receive({
      type: 'session.usage.updated',
      event_id: 'usage-1',
      usage: { seconds: 4 },
    });
    socket.receive({
      type: 'session.usage.updated',
      event_id: 'usage-2',
      usage: { seconds: 2 },
    });

    const transcriptEvents = events.filter((event) => event.kind === 'transcript');
    expect(transcriptEvents).toHaveLength(2);
    expect((transcriptEvents[1].fragment as { kind: string }).kind).toBe('correction');
    const delegationContext = sideband.getContextForDelegation('provider-delegation-1');
    expect(delegationContext?.snapshot?.text).toContain('No Thursday');
    expect(delegationContext?.snapshot?.version).toBe(2);
    expect(delegationContext?.uncertain).toBe(true);
    expect(delegationContext?.reason).toBe('transcript_changed');
    expect(sideband.contextForDelegation('provider-delegation-1')).toBeNull();

    socket.receive({
      type: 'session.output_transcript.delta',
      event_id: 'assistant-after-delegation',
      item_id: 'assistant-1',
      delta: 'The later answer is unrelated to the request.',
      start_ms: 200,
      end_ms: 300,
    });
    expect(sideband.getContextForDelegation('provider-delegation-1')?.uncertain).toBe(true);
    expect(sideband.getContextForDelegation('provider-delegation-1')?.reason).toBe(
      'transcript_changed',
    );
    expect(sideband.contextForDelegation('provider-delegation-1')).toBeNull();
    expect(events.some((event) => event.kind === 'delegation')).toBe(true);
    expect(events.some((event) => event.kind === 'provider_acknowledgement')).toBe(true);
    expect(
      events.some((event) => event.kind === 'error' && event.code === 'NON_MONOTONIC_USAGE'),
    ).toBe(true);
    expect(sideband.usage?.voiceSeconds).toBe(4);
  });

  it('does not guess when delegation context is missing and reports unknown acknowledgements', async () => {
    const socket = new FakeSocket();
    const sideband = new OpenAiLiveVoiceSideband(
      socket as unknown as LiveWebSocket,
      'provider-session-3',
      {
        now: () => 1_000,
        expiresAt: 2_000,
        closeTimeoutMs: 20,
        maxProviderEventBytes: 1_000,
        maxPendingCommands: 4,
        transcriptOptions: { maxFragments: 4, maxCharacters: 100, now: () => 1_000 },
      },
    );
    const events: Array<Record<string, unknown>> = [];
    sideband.onEvent((event) => events.push(event as unknown as Record<string, unknown>));
    const opened = sideband.open();
    socket.open();
    expect((await opened).isOk()).toBe(true);

    const status = await sideband.send({
      kind: 'thinking',
      delegationId: null,
      content: 'Session status update.',
      outputId: 'output-status',
    });
    expect(status.isOk()).toBe(true);
    expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({
      type: 'session.thinking.append',
      delegation_id: null,
    });

    socket.receive({
      type: 'session.delegation.created',
      event_id: 'delegation-missing-context',
      delegation: { id: 'provider-delegation-missing', target: 'client' },
      offset_ms: 500,
    });
    socket.receive({
      type: 'session.commentary.appended',
      event_id: 'ack-unknown',
      client_event_id: 'missing',
    });
    socket.receive({ type: 'session.input_audio.append', audio: 'reflected-audio' });

    expect(sideband.contextForDelegation('provider-delegation-missing')).toBeNull();
    expect(events.some((event) => event.kind === 'delegation')).toBe(true);
    expect(
      events.some((event) => event.kind === 'error' && event.code === 'UNKNOWN_ACKNOWLEDGEMENT'),
    ).toBe(true);
    expect(
      events.some((event) => event.kind === 'error' && event.code === 'UNSUPPORTED_PROVIDER_EVENT'),
    ).toBe(false);
  });

  it('rejects sideband attachment after the provider session deadline', async () => {
    let now = 1_000;
    const provider = new OpenAiLiveVoiceProvider({
      apiKey: 'test-key',
      now: () => now,
      defaultSessionLifetimeMs: 10,
      fetch: vi.fn(async () =>
        response({ session: { id: 'provider-session-expired' }, transport: { sdp: 'answer' } }),
      ),
    });
    const created = await provider.createSession(request({ sessionId: 'voice-session-expired' }));
    const session = created._unsafeUnwrap();
    now = 1_010;

    const result = await provider.attachSideband(session);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe('session_expired');
  });

  it('accepts a successful empty hangup response', async () => {
    let requestCount = 0;
    const provider = new OpenAiLiveVoiceProvider({
      apiKey: 'test-key',
      fetch: vi.fn(async () => {
        requestCount += 1;
        if (requestCount === 1)
          return response({
            session: { id: 'provider-session-hangup' },
            transport: { sdp: 'answer' },
          });
        return new Response(null, { status: 200 });
      }),
    });
    const created = await provider.createSession(request({ sessionId: 'voice-session-hangup' }));

    const result = await provider.closeSession(created._unsafeUnwrap().providerSessionId);

    expect(result.isOk()).toBe(true);
    expect(requestCount).toBe(2);
  });

  it('returns an incomplete finalization error when close deadline expires', async () => {
    const socket = new FakeSocket();
    const sideband = new OpenAiLiveVoiceSideband(
      socket as unknown as LiveWebSocket,
      'provider-session-4',
      {
        now: () => 1_000,
        expiresAt: 2_000,
        closeTimeoutMs: 5,
        maxProviderEventBytes: 1_000,
        maxPendingCommands: 4,
        transcriptOptions: { maxFragments: 4, maxCharacters: 100, now: () => 1_000 },
      },
    );
    const opened = sideband.open();
    socket.open();
    expect((await opened).isOk()).toBe(true);

    const closing = sideband.close(true);
    await Promise.resolve();
    socket.readyState = 2;
    const result = await closing;

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe('finalization_incomplete');
    expect(sideband.finalizationStatus).toBe('incomplete');
    expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({ type: 'session.close' });
    expect(socket.terminated).toBe(true);
  });

  it('force closes when an expired session rejects the close command', async () => {
    let now = 1_000;
    const socket = new FakeSocket();
    const sideband = new OpenAiLiveVoiceSideband(
      socket as unknown as LiveWebSocket,
      'provider-session-expired-close',
      {
        now: () => now,
        expiresAt: 2_000,
        closeTimeoutMs: 100,
        maxProviderEventBytes: 1_000,
        maxPendingCommands: 4,
        transcriptOptions: { maxFragments: 4, maxCharacters: 100, now: () => now },
      },
    );
    const opened = sideband.open();
    socket.open();
    expect((await opened).isOk()).toBe(true);
    now = 2_000;

    const result = await sideband.close(true);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe('session_expired');
    expect(sideband.finalizationStatus).toBe('incomplete');
    expect(socket.terminated).toBe(true);
  });

  it('confirms graceful close and retains final cumulative usage', async () => {
    const socket = new FakeSocket();
    const sideband = new OpenAiLiveVoiceSideband(
      socket as unknown as LiveWebSocket,
      'provider-session-6',
      {
        now: () => 1_000,
        expiresAt: 2_000,
        closeTimeoutMs: 20,
        maxProviderEventBytes: 1_000,
        maxPendingCommands: 4,
        transcriptOptions: { maxFragments: 4, maxCharacters: 100, now: () => 1_000 },
      },
    );
    const opened = sideband.open();
    socket.open();
    expect((await opened).isOk()).toBe(true);

    const closing = sideband.close(true);
    socket.receive({
      type: 'session.closed',
      event_id: 'closed-1',
      reason: 'close_requested',
      usage: { seconds: 3 },
    });

    const result = await closing;
    expect(result.isOk()).toBe(true);
    expect(sideband.finalizationStatus).toBe('confirmed');
    expect(sideband.usage).toMatchObject({ voiceSeconds: 3, final: true });
  });

  it('times out a sideband that never opens', async () => {
    const socket = new FakeSocket();
    const sideband = new OpenAiLiveVoiceSideband(
      socket as unknown as LiveWebSocket,
      'provider-session-5',
      {
        now: () => 1_000,
        expiresAt: 2_000,
        openTimeoutMs: 1,
        closeTimeoutMs: 20,
        maxProviderEventBytes: 1_000,
        maxPendingCommands: 4,
        transcriptOptions: { maxFragments: 4, maxCharacters: 100, now: () => 1_000 },
      },
    );

    const result = await sideband.open();

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe('timeout');
  });
});
