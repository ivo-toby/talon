import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveWebSocket } from '../../../src/voice/providers/openai-live-provider.js';
import {
  DEFAULT_DELEGATION_CONTEXT_WAIT_MS,
  OpenAiLiveVoiceSideband,
} from '../../../src/voice/providers/openai-live-provider.js';
import { DurableVoiceSessionService } from '../../../src/voice/voice-session-service.js';
import type { VoiceDelegationRecord, VoiceSessionRecord } from '../../../src/voice/voice-types.js';

class FakeSocket {
  readonly readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, handler: (...args: unknown[]) => void): this {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
    return this;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {}

  receive(event: Record<string, unknown>): void {
    for (const handler of this.listeners.get('message') ?? []) {
      handler(Buffer.from(JSON.stringify(event)), false);
    }
  }
}

function createSideband(socket: FakeSocket): OpenAiLiveVoiceSideband {
  return new OpenAiLiveVoiceSideband(socket as unknown as LiveWebSocket, 'provider-session', {
    now: () => Date.now(),
    expiresAt: 999_999,
    closeTimeoutMs: 50,
    maxProviderEventBytes: 1_000_000,
    maxPendingCommands: 128,
    transcriptOptions: { maxFragments: 32, maxCharacters: 2_000, now: () => Date.now() },
  });
}

function createService(
  sideband: OpenAiLiveVoiceSideband,
  contextDigest: string,
): {
  readonly service: DurableVoiceSessionService;
  readonly runtime: TestRuntime;
  readonly authority: { active: boolean };
} {
  const sessionId = 'voice-session';
  const owner = { ownerId: 'voice-owner', loginRevision: 1 };
  const delegation: TestDelegation = {
    id: 'internal-delegation',
    sessionId,
    providerDelegationId: 'provider-delegation',
    status: 'running',
    contextDigest,
    request: { threadId: 'voice-thread' },
    output: {
      execution: 'running',
      delivery: 'not_requested',
      providerAcknowledgement: 'not_sent',
      playback: 'not_started',
    },
  };
  const session: TestSession = {
    id: sessionId,
    threadId: delegation.request.threadId,
    owner,
    status: 'connected',
    deadlineAt: 99_999,
  };
  const projection: TestProjection = {
    session,
    delegations: [delegation],
    outputs: [],
  };
  const authority = { active: true };
  const runtime: TestRuntime = {
    sideband,
    providerSessionId: 'provider-session',
    authority: 'browser' as const,
    contextDiagnosticCorrelationId: 'test-correlation',
    unsubscribeProvider: () => undefined,
    unsubscribeTransport: () => undefined,
    eventChain: Promise.resolve(),
    closing: false,
    listeners: new Set(),
    resultUnsubscribes: new Map(),
    handledOutputIds: new Set<string>(),
    staleDelegationIds: new Set<string>(),
    staleNoticeSent: new Set<string>(),
  };
  const service = Object.create(DurableVoiceSessionService.prototype) as {
    handleTranscriptEvent: (
      sessionId: string,
      runtime: typeof runtime,
      event: unknown,
    ) => Promise<unknown>;
    options: {
      readonly store: {
        readSession: () => { isErr: () => boolean; value: TestProjection };
        findSession: () => { isErr: () => boolean; value: TestSession };
      };
      readonly isOwnerActive: () => boolean;
    };
    maxContextChars: number;
    now: () => number;
    runtimes: Map<string, TestRuntime>;
  };
  service.options = {
    store: {
      readSession: () => ({
        isErr: () => false,
        value: projection,
      }),
      findSession: () => ({ isErr: () => false, value: session }),
    },
    isOwnerActive: () => authority.active,
  };
  service.maxContextChars = 32_000;
  service.now = () => 12_345;
  service.runtimes = new Map([[sessionId, runtime]]);
  return {
    service: service as unknown as DurableVoiceSessionService,
    runtime,
    authority,
  };
}

type TestSession = Pick<VoiceSessionRecord, 'id' | 'threadId' | 'owner' | 'status' | 'deadlineAt'>;

type TestDelegation = Pick<
  VoiceDelegationRecord,
  'id' | 'sessionId' | 'providerDelegationId' | 'status' | 'contextDigest' | 'output'
> & {
  readonly request: { readonly threadId: string };
};

interface TestProjection {
  readonly session: TestSession;
  readonly delegations: readonly TestDelegation[];
  readonly outputs: readonly [];
}

interface TestRuntime {
  readonly sideband: OpenAiLiveVoiceSideband;
  readonly providerSessionId: string;
  readonly authority: 'browser';
  readonly contextDiagnosticCorrelationId: string;
  readonly unsubscribeProvider: () => void;
  readonly unsubscribeTransport: () => void;
  readonly eventChain: Promise<void>;
  readonly closing: boolean;
  readonly listeners: Set<unknown>;
  readonly resultUnsubscribes: Map<string, unknown>;
  readonly handledOutputIds: Set<string>;
  readonly staleDelegationIds: Set<string>;
  readonly staleNoticeSent: Set<string>;
}

async function handleTranscript(
  service: DurableVoiceSessionService,
  runtime: {
    readonly sideband: OpenAiLiveVoiceSideband;
    readonly staleDelegationIds: Set<string>;
    readonly staleNoticeSent: Set<string>;
  },
): Promise<void> {
  await (
    service as unknown as {
      handleTranscriptEvent: (
        sessionId: string,
        runtime: typeof runtime,
        event: unknown,
      ) => Promise<unknown>;
    }
  ).handleTranscriptEvent('voice-session', runtime, {});
}

function receiveUserRequest(socket: FakeSocket): void {
  socket.receive({
    type: 'session.input_transcript.completed',
    event_id: 'user-completed',
    item_id: 'user-request',
    text: 'Vraag om informatie',
    start_ms: 100,
    end_ms: 200,
  });
}

describe('voice transcript stability', () => {
  beforeEach(() => vi.useFakeTimers({ now: 12_345 }));
  afterEach(() => vi.useRealTimers());

  it('does not interrupt an admitted request for equivalent assistant completion metadata', async () => {
    const socket = new FakeSocket();
    const sideband = createSideband(socket);
    expect((await sideband.open()).isOk()).toBe(true);
    receiveUserRequest(socket);
    socket.receive({
      type: 'session.output_transcript.delta',
      event_id: 'assistant-delta',
      item_id: 'assistant-output',
      delta: 'Ik zoek het op',
      start_ms: 250,
      end_ms: 400,
    });
    socket.receive({
      type: 'session.delegation.created',
      event_id: 'delegation-created',
      delegation: { id: 'provider-delegation', target: 'client' },
      offset_ms: 500,
    });
    vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_WAIT_MS);

    const before = sideband.getContextForDelegation('provider-delegation');
    expect(before?.uncertain).toBe(false);
    const serviceState = createService(sideband, before?.snapshot?.digest ?? '');

    socket.receive({
      type: 'session.output_transcript.completed',
      event_id: 'assistant-completed',
      item_id: 'assistant-output',
      text: 'Ik zoek het op',
      start_ms: 250,
      end_ms: 400,
    });
    const after = sideband.getContextForDelegation('provider-delegation');
    expect(after?.uncertain).toBe(false);
    expect(after?.snapshot).toBe(before?.snapshot);
    expect(after?.snapshot?.digest).toBe(before?.snapshot?.digest);

    await handleTranscript(serviceState.service, serviceState.runtime);

    expect(serviceState.runtime.staleDelegationIds).toHaveLength(0);
    expect(socket.sent).toHaveLength(0);

    socket.receive({
      type: 'session.output_transcript.delta',
      event_id: 'assistant-after-delegation',
      item_id: 'later-output',
      delta: 'Hier is het antwoord',
      start_ms: 600,
      end_ms: 800,
    });
    await handleTranscript(serviceState.service, serviceState.runtime);
    expect(serviceState.runtime.staleDelegationIds).toHaveLength(0);
    expect(socket.sent).toHaveLength(0);
  });

  it('still blocks and interrupts delivery after a real user correction', async () => {
    const socket = new FakeSocket();
    const sideband = createSideband(socket);
    expect((await sideband.open()).isOk()).toBe(true);
    receiveUserRequest(socket);
    socket.receive({
      type: 'session.delegation.created',
      event_id: 'delegation-created',
      delegation: { id: 'provider-delegation', target: 'client' },
      offset_ms: 500,
    });
    vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_WAIT_MS);
    const before = sideband.getContextForDelegation('provider-delegation');
    const serviceState = createService(sideband, before?.snapshot?.digest ?? '');

    socket.receive({
      type: 'session.input_transcript.correction',
      event_id: 'user-correction',
      item_id: 'user-request',
      text: 'Vraag om iets anders',
      start_ms: 100,
      end_ms: 200,
    });
    expect(sideband.contextForDelegation('provider-delegation')).toBeNull();

    await handleTranscript(serviceState.service, serviceState.runtime);

    expect(serviceState.runtime.staleDelegationIds).toEqual(new Set(['internal-delegation']));
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({
      type: 'session.instructions.append',
      delegation_id: 'provider-delegation',
    });
    expect(socket.sent[0]?.content).toContain('corrected request');
  });

  it('marks a correction stale without speaking after authority becomes inactive', async () => {
    const socket = new FakeSocket();
    const sideband = createSideband(socket);
    expect((await sideband.open()).isOk()).toBe(true);
    receiveUserRequest(socket);
    socket.receive({
      type: 'session.delegation.created',
      event_id: 'delegation-created',
      delegation: { id: 'provider-delegation', target: 'client' },
      offset_ms: 500,
    });
    vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_WAIT_MS);
    const before = sideband.getContextForDelegation('provider-delegation');
    const serviceState = createService(sideband, before?.snapshot?.digest ?? '');
    serviceState.authority.active = false;

    socket.receive({
      type: 'session.input_transcript.correction',
      event_id: 'user-correction',
      item_id: 'user-request',
      text: 'Vraag om iets anders',
      start_ms: 100,
      end_ms: 200,
    });
    await handleTranscript(serviceState.service, serviceState.runtime);

    expect(serviceState.runtime.staleDelegationIds).toEqual(new Set(['internal-delegation']));
    expect(serviceState.runtime.staleNoticeSent).toHaveLength(0);
    expect(socket.sent).toHaveLength(0);
  });

  it('does not treat late assistant progress or notification speech as a user correction', async () => {
    const socket = new FakeSocket();
    const sideband = createSideband(socket);
    expect((await sideband.open()).isOk()).toBe(true);
    receiveUserRequest(socket);
    socket.receive({
      type: 'session.delegation.created',
      event_id: 'delegation-created',
      delegation: { id: 'provider-delegation', target: 'client' },
      offset_ms: 500,
    });
    vi.advanceTimersByTime(DEFAULT_DELEGATION_CONTEXT_WAIT_MS);
    const before = sideband.getContextForDelegation('provider-delegation');
    const serviceState = createService(sideband, before?.snapshot?.digest ?? '');

    socket.receive({
      type: 'session.output_transcript.delta',
      event_id: 'assistant-progress',
      item_id: 'assistant-progress',
      delta: 'Ik kijk het na',
    });
    socket.receive({
      type: 'session.output_transcript.completed',
      event_id: 'assistant-progress-complete',
      item_id: 'assistant-progress',
      text: 'Ik kijk het na',
    });
    socket.receive({
      type: 'session.output_transcript.delta',
      event_id: 'assistant-notification',
      item_id: 'assistant-notification',
      delta: 'De achtergrondtaak is klaar.',
      start_ms: 700,
      end_ms: 800,
    });

    expect(sideband.contextForDelegation('provider-delegation')).toBe(before?.snapshot);
    await handleTranscript(serviceState.service, serviceState.runtime);

    expect(serviceState.runtime.staleDelegationIds).toHaveLength(0);
    expect(socket.sent).toHaveLength(0);
  });
});
