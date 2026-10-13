import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { LiveWebSocket } from '../../../../src/voice/providers/openai-live-provider.js';
import {
  DEFAULT_DELEGATION_CONTEXT_DEADLINE_MS,
  DEFAULT_DELEGATION_CONTEXT_WAIT_MS,
  OpenAiLiveVoiceProvider,
  OpenAiLiveVoiceSideband,
} from '../../../../src/voice/providers/openai-live-provider.js';
import type {
  LiveVoiceIncomingSessionRequest,
  LiveVoiceSessionRequest,
} from '../../../../src/voice/voice-types.js';

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

function incomingRequest(
  overrides: Partial<LiveVoiceIncomingSessionRequest> = {},
): LiveVoiceIncomingSessionRequest {
  return {
    sessionId: 'voice-sip-1',
    providerSessionId: 'provider-sip-1',
    modelName: 'gpt-live-1',
    voice: 'marin',
    admissionExpiresAt: Date.now() + 10_000,
    sessionExpiresAt: Date.now() + 900_000,
    instructions: 'Speak briefly and delegate substantive work.',
    delegationMode: 'client',
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
    vi.useFakeTimers({ now: 1_000 });
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
      now: () => Date.now(),
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
    vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_WAIT_MS);
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

    socket.receive({
      type: 'session.delegation.created',
      event_id: 'delegation-replay',
      delegation: { id: 'provider-delegation-1', target: 'client' },
      offset_ms: 100,
    });
    expect(sideband.contextForDelegation('provider-delegation-1')).toBeNull();
    expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(1);

    socket.receive({
      type: 'session.delegation.created',
      event_id: 'delegation-conflict',
      delegation: { id: 'provider-delegation-1', target: 'client' },
      offset_ms: 80,
    });
    expect(sideband.getContextForDelegation('provider-delegation-1')?.uncertain).toBe(true);
    expect(sideband.getContextForDelegation('provider-delegation-1')?.reason).toBe(
      'delegation_replay_conflict',
    );
    expect(sideband.contextForDelegation('provider-delegation-1')).toBeNull();
    expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(1);
    expect(
      events.filter((event) => event.kind === 'error' && event.code === 'INVALID_PROVIDER_EVENT'),
    ).toHaveLength(1);
    expect(events.some((event) => event.kind === 'delegation')).toBe(true);
    expect(events.some((event) => event.kind === 'provider_acknowledgement')).toBe(true);
    expect(
      events.some((event) => event.kind === 'error' && event.code === 'NON_MONOTONIC_USAGE'),
    ).toBe(true);
    expect(sideband.usage?.voiceSeconds).toBe(4);
    vi.useRealTimers();
  });

  it('does not guess when delegation context is missing and reports unknown acknowledgements', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const socket = new FakeSocket();
    const sideband = new OpenAiLiveVoiceSideband(
      socket as unknown as LiveWebSocket,
      'provider-session-3',
      {
        now: () => Date.now(),
        expiresAt: 20_000,
        closeTimeoutMs: 20,
        maxProviderEventBytes: 1_000,
        maxPendingCommands: 4,
        transcriptOptions: { maxFragments: 4, maxCharacters: 100, now: () => Date.now() },
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
    expect(events.some((event) => event.kind === 'delegation')).toBe(false);
    expect(
      events.some((event) => event.kind === 'error' && event.code === 'UNKNOWN_ACKNOWLEDGEMENT'),
    ).toBe(true);
    expect(
      events.some((event) => event.kind === 'error' && event.code === 'UNSUPPORTED_PROVIDER_EVENT'),
    ).toBe(false);

    try {
      vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_DEADLINE_MS);
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(1);
      socket.receive({
        type: 'session.input_transcript.completed',
        event_id: 'late-transcript',
        item_id: 'late-user',
        text: 'Too late',
        start_ms: 0,
        end_ms: 100,
      });
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(1);
      expect(sideband.contextForDelegation('provider-delegation-missing')).toBeNull();

      socket.receive({
        type: 'session.delegation.created',
        event_id: 'delegation-reused-after-timeout',
        delegation: { id: 'provider-delegation-reused', target: 'client' },
        offset_ms: 100,
      });
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(1);
      vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_WAIT_MS);
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(2);
      expect(sideband.contextForDelegation('provider-delegation-reused')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds an early delegation until a fresh timed user transcript arrives and admits once', async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const socket = new FakeSocket();
      const sideband = new OpenAiLiveVoiceSideband(
        socket as unknown as LiveWebSocket,
        'provider-session-early-delegation',
        {
          now: () => Date.now(),
          expiresAt: 20_000,
          closeTimeoutMs: 20,
          maxProviderEventBytes: 1_000,
          maxPendingCommands: 4,
          transcriptOptions: { maxFragments: 4, maxCharacters: 100, now: () => Date.now() },
        },
      );
      const events: Array<Record<string, unknown>> = [];
      sideband.onEvent((event) => events.push(event as unknown as Record<string, unknown>));
      const opened = sideband.open();
      socket.open();
      expect((await opened).isOk()).toBe(true);

      socket.receive({
        type: 'session.delegation.created',
        event_id: 'delegation-before-transcript',
        delegation: { id: 'provider-delegation-early', target: 'client' },
        offset_ms: 100,
      });
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(0);

      vi.advanceTimersByTime(500);
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(0);

      socket.receive({
        type: 'session.input_transcript.delta',
        event_id: 'user-first-delta',
        item_id: 'user-first',
        delta: 'Book',
        start_ms: 0,
        end_ms: 30,
      });
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(0);
      socket.receive({
        type: 'session.input_transcript.delta',
        event_id: 'user-second-delta',
        item_id: 'user-first',
        delta: ' Friday',
        start_ms: 0,
        end_ms: 100,
      });
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(0);
      vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_WAIT_MS);
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(1);
      expect(
        (
          events.find((event) => event.kind === 'delegation')?.proposal as {
            providerDelegationId: string;
          }
        ).providerDelegationId,
      ).toBe('provider-delegation-early');
      expect(sideband.contextForDelegation('provider-delegation-early')?.text).toContain(
        'Book Friday',
      );

      socket.receive({
        type: 'session.delegation.created',
        event_id: 'delegation-duplicate',
        delegation: { id: 'provider-delegation-early', target: 'client' },
        offset_ms: 100,
      });
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a first notice until a timed new user turn replaces historical context', async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const socket = new FakeSocket();
      const sideband = new OpenAiLiveVoiceSideband(
        socket as unknown as LiveWebSocket,
        'provider-session-historical-context',
        {
          now: () => Date.now(),
          expiresAt: 20_000,
          closeTimeoutMs: 20,
          maxProviderEventBytes: 1_000,
          maxPendingCommands: 4,
          transcriptOptions: { maxFragments: 8, maxCharacters: 200, now: () => Date.now() },
        },
      );
      const events: Array<Record<string, unknown>> = [];
      sideband.onEvent((event) => events.push(event as unknown as Record<string, unknown>));
      const opened = sideband.open();
      socket.open();
      expect((await opened).isOk()).toBe(true);

      socket.receive({
        type: 'session.input_transcript.completed',
        event_id: 'historical-user',
        item_id: 'historical-user',
        text: 'Hello there',
        start_ms: 0,
        end_ms: 100,
      });
      socket.receive({
        type: 'session.delegation.created',
        event_id: 'historical-delegation',
        delegation: { id: 'provider-delegation-historical', target: 'client' },
        offset_ms: 5_000,
      });
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(0);

      vi.advanceTimersByTime(500);
      socket.receive({
        type: 'session.input_transcript.completed',
        event_id: 'current-user',
        item_id: 'current-user',
        text: 'Read the current status.',
        start_ms: 4_500,
        end_ms: 5_000,
      });
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(0);

      vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_WAIT_MS);
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(1);
      expect(sideband.contextForDelegation('provider-delegation-historical')?.text).toContain(
        'Read the current status.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the full quiet interval when a first context changes near the absolute deadline', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const socket = new FakeSocket();
      const sideband = new OpenAiLiveVoiceSideband(
        socket as unknown as LiveWebSocket,
        'provider-session-near-expiry',
        {
          now: () => Date.now(),
          expiresAt: 20_000,
          closeTimeoutMs: 20,
          maxProviderEventBytes: 1_000,
          maxPendingCommands: 4,
          transcriptOptions: { maxFragments: 8, maxCharacters: 200, now: () => Date.now() },
        },
      );
      const events: Array<Record<string, unknown>> = [];
      sideband.onEvent((event) => events.push(event as unknown as Record<string, unknown>));
      const opened = sideband.open();
      socket.open();
      expect((await opened).isOk()).toBe(true);

      socket.receive({
        type: 'session.delegation.created',
        event_id: 'near-expiry-delegation',
        delegation: { id: 'provider-delegation-near-expiry', target: 'client' },
        offset_ms: 100,
      });
      vi.advanceTimersByTime(4_500);
      socket.receive({
        type: 'session.input_transcript.completed',
        event_id: 'near-expiry-correction',
        item_id: 'near-expiry-correction',
        text: 'Current request',
        start_ms: 0,
        end_ms: 100,
      });
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(0);

      vi.advanceTimersByTime(500);
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(1);
      expect(sideband.contextForDelegation('provider-delegation-near-expiry')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not admit safe context when a delayed absolute callback observes quiet after the deadline', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      let now = 0;
      const socket = new FakeSocket();
      const sideband = new OpenAiLiveVoiceSideband(
        socket as unknown as LiveWebSocket,
        'provider-session-delayed-absolute',
        {
          now: () => now,
          expiresAt: 20_000,
          closeTimeoutMs: 20,
          maxProviderEventBytes: 1_000,
          maxPendingCommands: 4,
          transcriptOptions: { maxFragments: 8, maxCharacters: 200, now: () => now },
        },
      );
      const events: Array<Record<string, unknown>> = [];
      sideband.onEvent((event) => events.push(event as unknown as Record<string, unknown>));
      const opened = sideband.open();
      socket.open();
      expect((await opened).isOk()).toBe(true);

      socket.receive({
        type: 'session.delegation.created',
        event_id: 'delayed-absolute-delegation',
        delegation: { id: 'provider-delegation-delayed-absolute', target: 'client' },
        offset_ms: 100,
      });
      vi.advanceTimersByTime(4_500);
      now = 4_500;
      socket.receive({
        type: 'session.input_transcript.completed',
        event_id: 'delayed-absolute-user',
        item_id: 'delayed-absolute-user',
        text: 'The request arrived before the hard deadline.',
        start_ms: 0,
        end_ms: 100,
      });

      // Hold the timer callback at the absolute deadline, then let both
      // callbacks run after the quiet deadline has crossed it.
      vi.advanceTimersByTime(500);
      now = 5_600;
      vi.advanceTimersByTime(500);

      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(1);
      expect(sideband.contextForDelegation('provider-delegation-delayed-absolute')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not preserve a first context for an equivalent late assistant callback after quiet crossed the deadline', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      let now = 0;
      const socket = new FakeSocket();
      const sideband = new OpenAiLiveVoiceSideband(
        socket as unknown as LiveWebSocket,
        'provider-session-late-assistant',
        {
          now: () => now,
          expiresAt: 20_000,
          closeTimeoutMs: 20,
          maxProviderEventBytes: 1_000,
          maxPendingCommands: 4,
          transcriptOptions: { maxFragments: 8, maxCharacters: 200, now: () => now },
        },
      );
      const events: Array<Record<string, unknown>> = [];
      sideband.onEvent((event) => events.push(event as unknown as Record<string, unknown>));
      const opened = sideband.open();
      socket.open();
      expect((await opened).isOk()).toBe(true);

      socket.receive({
        type: 'session.delegation.created',
        event_id: 'late-assistant-delegation',
        delegation: { id: 'provider-delegation-late-assistant', target: 'client' },
        offset_ms: 100,
      });
      vi.advanceTimersByTime(4_500);
      now = 4_500;
      socket.receive({
        type: 'session.input_transcript.completed',
        event_id: 'late-assistant-user',
        item_id: 'late-assistant-user',
        text: 'The request is complete.',
        start_ms: 0,
        end_ms: 100,
      });
      now = 5_600;
      socket.receive({
        type: 'session.output_transcript.delta',
        event_id: 'late-assistant-progress',
        item_id: 'late-assistant-progress',
        delta: 'Equivalent late progress.',
        start_ms: 200,
        end_ms: 300,
      });

      expect(sideband.contextForDelegation('provider-delegation-late-assistant')).toBeNull();
      vi.advanceTimersByTime(5_000);
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(1);
      expect(sideband.contextForDelegation('provider-delegation-late-assistant')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not admit context that arrives after the absolute cutoff before its timer callback', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      let now = 0;
      const socket = new FakeSocket();
      const sideband = new OpenAiLiveVoiceSideband(
        socket as unknown as LiveWebSocket,
        'provider-session-late-cutoff',
        {
          now: () => now,
          expiresAt: 20_000,
          closeTimeoutMs: 20,
          maxProviderEventBytes: 1_000,
          maxPendingCommands: 4,
          transcriptOptions: { maxFragments: 4, maxCharacters: 100, now: () => now },
        },
      );
      const events: Array<Record<string, unknown>> = [];
      sideband.onEvent((event) => events.push(event as unknown as Record<string, unknown>));
      const opened = sideband.open();
      socket.open();
      expect((await opened).isOk()).toBe(true);

      socket.receive({
        type: 'session.delegation.created',
        event_id: 'late-cutoff-delegation',
        delegation: { id: 'provider-delegation-late-cutoff', target: 'client' },
        offset_ms: 100,
      });
      now = DEFAULT_DELEGATION_CONTEXT_DEADLINE_MS + 50;
      socket.receive({
        type: 'session.input_transcript.completed',
        event_id: 'late-cutoff-transcript',
        item_id: 'late-cutoff-user',
        text: 'Arrived after the cutoff',
        start_ms: 0,
        end_ms: 100,
      });
      expect(sideband.contextForDelegation('provider-delegation-late-cutoff')).toBeNull();
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(0);

      vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_DEADLINE_MS);
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(1);
      expect(sideband.contextForDelegation('provider-delegation-late-cutoff')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a first notice after quiet expiry when its transcript arrives late', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const socket = new FakeSocket();
      const sideband = new OpenAiLiveVoiceSideband(
        socket as unknown as LiveWebSocket,
        'provider-session-late-settlement',
        {
          now: () => Date.now(),
          expiresAt: 20_000,
          closeTimeoutMs: 20,
          maxProviderEventBytes: 1_000,
          maxPendingCommands: 4,
          transcriptOptions: { maxFragments: 4, maxCharacters: 100, now: () => Date.now() },
        },
      );
      const events: Array<Record<string, unknown>> = [];
      sideband.onEvent((event) => events.push(event as unknown as Record<string, unknown>));
      const opened = sideband.open();
      socket.open();
      expect((await opened).isOk()).toBe(true);

      socket.receive({
        type: 'session.delegation.created',
        event_id: 'late-settlement-delegation',
        delegation: { id: 'provider-delegation-late-settlement', target: 'client' },
        offset_ms: 100,
      });
      vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_WAIT_MS + 50);
      socket.receive({
        type: 'session.input_transcript.delta',
        event_id: 'late-settlement-transcript-first',
        item_id: 'late-settlement-user',
        delta: 'Late but',
        start_ms: 0,
        end_ms: 50,
      });
      vi.advanceTimersByTime(100);
      socket.receive({
        type: 'session.input_transcript.delta',
        event_id: 'late-settlement-transcript-second',
        item_id: 'late-settlement-user',
        delta: ' valid request',
        start_ms: 0,
        end_ms: 100,
      });
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(0);

      vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_WAIT_MS - 1);
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(1);
      expect(sideband.contextForDelegation('provider-delegation-late-settlement')?.text).toContain(
        'Late but valid request',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a settled first context across an assistant-only callback at the cutoff', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      let now = 0;
      const socket = new FakeSocket();
      const sideband = new OpenAiLiveVoiceSideband(
        socket as unknown as LiveWebSocket,
        'provider-session-assistant-cutoff',
        {
          now: () => now,
          expiresAt: 20_000,
          closeTimeoutMs: 20,
          maxProviderEventBytes: 1_000,
          maxPendingCommands: 4,
          transcriptOptions: { maxFragments: 8, maxCharacters: 200, now: () => now },
        },
      );
      const events: Array<Record<string, unknown>> = [];
      sideband.onEvent((event) => events.push(event as unknown as Record<string, unknown>));
      const opened = sideband.open();
      socket.open();
      expect((await opened).isOk()).toBe(true);

      socket.receive({
        type: 'session.delegation.created',
        event_id: 'assistant-cutoff-delegation',
        delegation: { id: 'provider-delegation-assistant-cutoff', target: 'client' },
        offset_ms: 1_000,
      });
      vi.advanceTimersByTime(4_000);
      now = 4_000;
      socket.receive({
        type: 'session.input_transcript.completed',
        event_id: 'assistant-cutoff-user',
        item_id: 'assistant-cutoff-user',
        text: 'Settled request',
        start_ms: 0,
        end_ms: 100,
      });
      now = 5_000;
      socket.receive({
        type: 'session.output_transcript.delta',
        event_id: 'assistant-cutoff-progress',
        item_id: 'assistant-cutoff-progress',
        delta: 'Working on it.',
        start_ms: 200,
        end_ms: 300,
      });
      vi.advanceTimersByTime(1_000);

      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(1);
      expect(sideband.contextForDelegation('provider-delegation-assistant-cutoff')?.text).toContain(
        'Settled request',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps context diagnostics content-free and excludes provider identifiers', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const socket = new FakeSocket();
      const lines: string[] = [];
      const logger = pino({}, { write: (line: string): void => lines.push(line) });
      const sideband = new OpenAiLiveVoiceSideband(
        socket as unknown as LiveWebSocket,
        'provider-session-secret',
        {
          now: () => Date.now(),
          expiresAt: 20_000,
          closeTimeoutMs: 20,
          maxProviderEventBytes: 1_000,
          maxPendingCommands: 4,
          logger,
          transcriptOptions: { maxFragments: 4, maxCharacters: 100, now: () => Date.now() },
        },
      );
      const opened = sideband.open();
      socket.open();
      expect((await opened).isOk()).toBe(true);

      socket.receive({
        type: 'session.delegation.created',
        event_id: 'provider-event-secret',
        delegation: { id: 'provider-secret-id', target: 'client' },
        offset_ms: 100,
      });
      vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_DEADLINE_MS);
      await sideband.close(false);

      const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const logs = JSON.stringify(records);
      expect(logs).not.toContain('provider-session-secret');
      expect(logs).not.toContain('provider-secret-id');
      expect(logs).not.toContain('provider-event-secret');
      expect(logs).not.toContain('TOP_SECRET_REQUEST');
      expect(logs).toContain('absolute_expiry');
      expect(logs).toContain('sideband_lifetime');
      expect(records.some((record) => record.level === 30)).toBe(true);
      expect(records.some((record) => record.level === 40)).toBe(true);
      expect(new Set(records.map((record) => record.voiceCorrelationId))).toEqual(
        new Set([records[0]?.voiceCorrelationId]),
      );
      expect(records.find((record) => record.event === 'closed')).toMatchObject({
        availability: 'available',
        available: true,
        opened: true,
        finalized: false,
        closeRequested: true,
        observedDelegations: 1,
        observation: 'sideband_lifetime',
      });
      expect(records.find((record) => record.event === 'closed')?.observationDurationMs).toEqual(
        expect.any(Number),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps logger failures observational during first-context settlement', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const socket = new FakeSocket();
      const logger = {
        info: vi.fn(() => {
          throw new Error('diagnostic logger failed');
        }),
        warn: vi.fn(() => {
          throw new Error('diagnostic logger failed');
        }),
      };
      const sideband = new OpenAiLiveVoiceSideband(
        socket as unknown as LiveWebSocket,
        'provider-session-logger-failure',
        {
          now: () => Date.now(),
          expiresAt: 20_000,
          closeTimeoutMs: 20,
          maxProviderEventBytes: 1_000,
          maxPendingCommands: 4,
          logger: logger as never,
          transcriptOptions: { maxFragments: 4, maxCharacters: 100, now: () => Date.now() },
        },
      );
      const events: Array<Record<string, unknown>> = [];
      sideband.onEvent((event) => events.push(event as unknown as Record<string, unknown>));
      const opened = sideband.open();
      socket.open();
      expect((await opened).isOk()).toBe(true);
      socket.receive({
        type: 'session.input_transcript.completed',
        event_id: 'logger-failure-user',
        item_id: 'logger-failure-user',
        text: 'Keep this request.',
        start_ms: 0,
        end_ms: 100,
      });
      socket.receive({
        type: 'session.delegation.created',
        event_id: 'logger-failure-delegation',
        delegation: { id: 'provider-delegation-logger-failure', target: 'client' },
        offset_ms: 100,
      });
      vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_WAIT_MS);

      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(1);
      expect(sideband.contextForDelegation('provider-delegation-logger-failure')?.text).toContain(
        'Keep this request.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reuse a published user turn for a later delegation', async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const socket = new FakeSocket();
      const sideband = new OpenAiLiveVoiceSideband(
        socket as unknown as LiveWebSocket,
        'provider-session-later-delegation',
        {
          now: () => Date.now(),
          expiresAt: 20_000,
          closeTimeoutMs: 20,
          maxProviderEventBytes: 1_000,
          maxPendingCommands: 4,
          transcriptOptions: { maxFragments: 4, maxCharacters: 100, now: () => Date.now() },
        },
      );
      const events: Array<Record<string, unknown>> = [];
      sideband.onEvent((event) => events.push(event as unknown as Record<string, unknown>));
      const opened = sideband.open();
      socket.open();
      expect((await opened).isOk()).toBe(true);
      socket.receive({
        type: 'session.input_transcript.completed',
        event_id: 'user-1',
        item_id: 'user-1',
        text: 'First request',
        start_ms: 0,
        end_ms: 100,
      });
      socket.receive({
        type: 'session.delegation.created',
        event_id: 'delegation-1',
        delegation: { id: 'provider-delegation-1', target: 'client' },
        offset_ms: 100,
      });
      vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_WAIT_MS);
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(1);

      socket.receive({
        type: 'session.input_transcript.completed',
        event_id: 'user-2',
        item_id: 'user-2',
        text: 'Second request',
        start_ms: 100,
        end_ms: 200,
      });
      socket.receive({
        type: 'session.delegation.created',
        event_id: 'delegation-2',
        delegation: { id: 'provider-delegation-2', target: 'client' },
        offset_ms: 200,
      });
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(2);

      socket.receive({
        type: 'session.output_transcript.delta',
        event_id: 'assistant-only-after-reuse',
        item_id: 'assistant-only-after-reuse',
        delta: 'I am still working.',
        start_ms: 110,
        end_ms: 150,
      });
      socket.receive({
        type: 'session.delegation.created',
        event_id: 'delegation-3',
        delegation: { id: 'provider-delegation-3', target: 'client' },
        offset_ms: 100,
      });
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(2);

      vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_WAIT_MS);
      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(3);
      expect(sideband.contextForDelegation('provider-delegation-3')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an admitted request stable across late assistant speech and timing metadata', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const socket = new FakeSocket();
    const sideband = new OpenAiLiveVoiceSideband(
      socket as unknown as LiveWebSocket,
      'provider-session-assistant-late',
      {
        now: () => Date.now(),
        expiresAt: 20_000,
        closeTimeoutMs: 20,
        maxProviderEventBytes: 1_000,
        maxPendingCommands: 4,
        transcriptOptions: { maxFragments: 4, maxCharacters: 100, now: () => Date.now() },
      },
    );
    const opened = sideband.open();
    socket.open();
    expect((await opened).isOk()).toBe(true);
    socket.receive({
      type: 'session.input_transcript.delta',
      event_id: 'user-stable',
      item_id: 'user-stable',
      delta: 'Stable request',
      start_ms: 0,
      end_ms: 50,
    });
    socket.receive({
      type: 'session.delegation.created',
      event_id: 'delegation-stable',
      delegation: { id: 'provider-delegation-stable', target: 'client' },
      offset_ms: 100,
    });
    vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_WAIT_MS);
    const before = sideband.getContextForDelegation('provider-delegation-stable');
    expect(before?.uncertain).toBe(false);

    socket.receive({
      type: 'session.input_transcript.completed',
      event_id: 'user-stable-complete',
      item_id: 'user-stable',
      text: 'Stable request',
      start_ms: 0,
      end_ms: 100,
    });

    socket.receive({
      type: 'session.output_transcript.delta',
      event_id: 'assistant-progress',
      item_id: 'assistant-progress',
      delta: 'I am checking the request.',
    });
    socket.receive({
      type: 'session.output_transcript.completed',
      event_id: 'assistant-progress-complete',
      item_id: 'assistant-progress',
      text: 'I am checking the request.',
    });

    const after = sideband.getContextForDelegation('provider-delegation-stable');
    expect(after?.uncertain).toBe(false);
    expect(after?.snapshot).toBe(before?.snapshot);
    expect(sideband.contextForDelegation('provider-delegation-stable')).toBe(before?.snapshot);
    vi.useRealTimers();
  });

  it('retires a pending delegation when the sideband closes before the grace period', async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const socket = new FakeSocket();
      const sideband = new OpenAiLiveVoiceSideband(
        socket as unknown as LiveWebSocket,
        'provider-session-close-pending',
        {
          now: () => Date.now(),
          expiresAt: 20_000,
          closeTimeoutMs: 20,
          maxProviderEventBytes: 1_000,
          maxPendingCommands: 4,
          transcriptOptions: { maxFragments: 4, maxCharacters: 100, now: () => Date.now() },
        },
      );
      const events: Array<Record<string, unknown>> = [];
      sideband.onEvent((event) => events.push(event as unknown as Record<string, unknown>));
      const opened = sideband.open();
      socket.open();
      expect((await opened).isOk()).toBe(true);
      socket.receive({
        type: 'session.delegation.created',
        event_id: 'delegation-close-pending',
        delegation: { id: 'provider-delegation-close-pending', target: 'client' },
        offset_ms: 100,
      });
      socket.fail();
      await sideband.close(false);
      vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_WAIT_MS);

      expect(events.filter((event) => event.kind === 'delegation')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
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

  it('accepts and attaches an existing incoming SIP session without startup commands', async () => {
    const socket = new FakeSocket();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(null, { status: 200 });
    });
    const provider = new OpenAiLiveVoiceProvider({
      apiKey: 'test-key',
      fetch,
      webSocketFactory: () => socket as unknown as LiveWebSocket,
      defaultSessionLifetimeMs: 20_000,
    });

    const accepted = await provider.acceptIncomingSession!(incomingRequest());
    expect(accepted.isOk()).toBe(true);
    const acceptBody = JSON.parse(String(requests[0]?.init?.body)) as Record<string, any>;
    expect(requests[0]?.url).toBe(
      'https://api.openai.com/v1/live/sessions/provider-sip-1/accept',
    );
    expect(acceptBody).toEqual({
      session: {
        type: 'live',
        model: 'gpt-live-1',
        instructions: 'Speak briefly and delegate substantive work.',
        audio: { output: { voice: 'marin' } },
        delegation: { type: 'client' },
        store: false,
      },
    });
    expect(acceptBody.session.audio.format).toBeUndefined();

    const attached = provider.attachSideband(accepted._unsafeUnwrap());
    socket.open();
    expect((await attached).isOk()).toBe(true);
    expect(socket.sent).toHaveLength(0);

    const closing = provider.closeSession('provider-sip-1');
    await Promise.resolve();
    expect(requests[1]?.url).toBe(
      'https://api.openai.com/v1/live/sessions/provider-sip-1/hangup',
    );
    expect(requests[1]?.init?.body).toBeUndefined();
    expect(closing).toBeInstanceOf(Promise);
    socket.receive({
      type: 'session.closed',
      event_id: 'sip-closed-1',
      reason: 'remote_hangup',
      usage: { seconds: 7 },
    });
    expect((await closing).isOk()).toBe(true);
  });

  it('does not register an incoming session after an ambiguous accept response', async () => {
    const provider = new OpenAiLiveVoiceProvider({
      apiKey: 'test-key',
      fetch: vi.fn(async () => new Response('{"accepted":true}', { status: 200 })),
    });
    const result = await provider.acceptIncomingSession!(
      incomingRequest({
        sessionId: 'voice-sip-ambiguous',
        providerSessionId: 'provider-sip-ambiguous',
      }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe('invalid_response');
    const attached = await provider.attachSideband({
      providerSessionId: 'provider-sip-ambiguous',
      client: {
        transport: 'sip',
        sessionId: 'voice-sip-ambiguous',
        answer: { type: 'sip', reference: 'provider-sip-ambiguous' },
        expiresAt: Date.now() + 900_000,
      },
    });
    expect(attached.isErr()).toBe(true);
  });

  it('keeps incoming acceptance unowned for every ambiguous HTTP outcome without retrying', async () => {
    const cases: Array<{
      readonly name: string;
      readonly fetch: typeof fetch;
    }> = [
      {
        name: 'whitespace response',
        fetch: vi.fn(async () => new Response(' \n', { status: 200 })) as typeof fetch,
      },
      {
        name: 'response read failure',
        fetch: vi.fn(
          async () =>
            ({
              status: 200,
              ok: true,
              text: async () => {
                throw new Error('body read failed');
              },
            }) as Response,
        ) as typeof fetch,
      },
      {
        name: 'server failure',
        fetch: vi.fn(async () => new Response('upstream failure', { status: 503 })) as typeof fetch,
      },
    ];

    for (const [index, candidate] of cases.entries()) {
      const provider = new OpenAiLiveVoiceProvider({ apiKey: 'test-key', fetch: candidate.fetch });
      const result = await provider.acceptIncomingSession!(
        incomingRequest({
          sessionId: `voice-sip-ambiguous-${index}`,
          providerSessionId: `provider-sip-ambiguous-${index}`,
        }),
      );
      expect(result.isErr(), candidate.name).toBe(true);
      expect(candidate.fetch).toHaveBeenCalledTimes(1);
      const attached = await provider.attachSideband({
        providerSessionId: `provider-sip-ambiguous-${index}`,
        client: {
          transport: 'sip',
          sessionId: `voice-sip-ambiguous-${index}`,
          answer: { type: 'sip', reference: `provider-sip-ambiguous-${index}` },
          expiresAt: Date.now() + 900_000,
        },
      });
      expect(attached.isErr(), candidate.name).toBe(true);
    }
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
