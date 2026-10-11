import { join } from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { ok } from 'neverthrow';

import { runMigrations } from '../../../../src/core/database/migrations/runner.js';
import { MessageRepository } from '../../../../src/core/database/repositories/message-repository.js';
import { QueueRepository } from '../../../../src/core/database/repositories/queue-repository.js';
import { ThreadRepository } from '../../../../src/core/database/repositories/thread-repository.js';
import { QueueManager } from '../../../../src/queue/queue-manager.js';
import { DurableVoiceBackendBridge } from '../../../../src/voice/voice-backend-bridge.js';
import { VoiceOutputSink } from '../../../../src/voice/voice-output-sink.js';
import { DurableVoiceStore } from '../../../../src/voice/voice-store.js';
import { VoicePolicy } from '../../../../src/voice/voice-policy.js';
import {
  OpenAiLiveVoiceSideband,
  type LiveWebSocket,
} from '../../../../src/voice/providers/openai-live-provider.js';
import {
  BrowserVoiceTransport,
  DurableVoiceSessionService,
} from '../../../../src/voice/voice-session-service.js';
import type {
  VoiceBackendRequest,
  VoiceDelegationRecord,
  LiveVoiceProvider,
  LiveVoiceSession,
  LiveVoiceSideband,
  VoiceContextSnapshot,
  VoiceEventHandler,
  VoiceUsageUpdate,
  VoiceSessionRecord,
  VoiceTransport,
  VoiceUnsubscribe,
} from '../../../../src/voice/voice-types.js';

class FakeSideband implements LiveVoiceSideband {
  readonly commands: string[] = [];
  readonly contexts = new Map<string, VoiceContextSnapshot>();
  readonly invalidContexts = new Set<string>();
  latestUsage: VoiceUsageUpdate | undefined;
  private handler: VoiceEventHandler<import('../../../../src/voice/voice-types.js').LiveVoiceEvent> | undefined;

  constructor(readonly providerSessionId = 'provider-session-1') {}

  contextForDelegation(providerDelegationId: string): VoiceContextSnapshot | null {
    if (this.invalidContexts.has(providerDelegationId)) return null;
    return this.contexts.get(providerDelegationId) ?? {
      version: 1,
      digest: 'context-digest-1',
      capturedAt: 10,
      text: 'Read the current status.',
      fragments: [],
      truncated: false,
    };
  }

  setContext(providerDelegationId: string, context: VoiceContextSnapshot): void {
    this.contexts.set(providerDelegationId, context);
    this.invalidContexts.delete(providerDelegationId);
  }

  invalidateContext(providerDelegationId: string): void {
    this.invalidContexts.add(providerDelegationId);
  }

  send(command: import('../../../../src/voice/voice-types.js').LiveVoiceCommand) {
    this.commands.push(command.content);
    return Promise.resolve(ok(undefined));
  }

  onEvent(handler: VoiceEventHandler<import('../../../../src/voice/voice-types.js').LiveVoiceEvent>): VoiceUnsubscribe {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }

  close(_graceful: boolean) {
    if (this.latestUsage) {
      this.handler?.({
        kind: 'session_closed',
        eventId: 'session-closed',
        sequence: 99,
        reason: 'client_close',
        usage: this.latestUsage,
        receivedAt: this.latestUsage.receivedAt,
      });
    }
    return Promise.resolve(ok(undefined));
  }

  emit(event: import('../../../../src/voice/voice-types.js').LiveVoiceEvent): void {
    this.handler?.(event);
  }
}

class FakeProvider implements LiveVoiceProvider {
  readonly name = 'openai-live';
  readonly sideband: FakeSideband;
  lastModelName: string | undefined;
  lastInstructions: string | undefined;

  constructor(providerSessionId = 'provider-session-1') {
    this.sideband = new FakeSideband(providerSessionId);
  }

  createSession(input: import('../../../../src/voice/voice-types.js').LiveVoiceSessionRequest) {
    this.lastModelName = input.modelName;
    this.lastInstructions = input.instructions;
    const session: LiveVoiceSession = {
      providerSessionId: this.sideband.providerSessionId,
      client: {
        transport: input.transport.type,
        sessionId: input.sessionId,
        providerSessionId: this.sideband.providerSessionId,
        answer: { type: input.transport.type, sdp: 'answer' },
        expiresAt: Date.now() + 60_000,
      },
    };
    return Promise.resolve(ok(session));
  }

  attachSideband(_session: LiveVoiceSession) {
    return Promise.resolve(ok(this.sideband));
  }

  closeSession(_providerSessionId: string) {
    return Promise.resolve(ok(undefined));
  }
}

class SocketSideband {
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

  close(): void {
    for (const handler of this.listeners.get('close') ?? []) handler(1000, Buffer.from('closed'));
  }

  receive(event: Record<string, unknown>): void {
    for (const handler of this.listeners.get('message') ?? []) {
      handler(Buffer.from(JSON.stringify(event)), false);
    }
  }
}

class SocketProvider implements LiveVoiceProvider {
  readonly name = 'openai-live';
  readonly socket = new SocketSideband();
  readonly sideband = new OpenAiLiveVoiceSideband(
    this.socket as unknown as LiveWebSocket,
    'provider-session-socket',
    {
      now: () => Date.now(),
      expiresAt: Date.now() + 60_000,
      closeTimeoutMs: 50,
      maxProviderEventBytes: 1_000_000,
      maxPendingCommands: 128,
      transcriptOptions: { maxFragments: 32, maxCharacters: 2_000, now: () => Date.now() },
    },
  );

  createSession(input: import('../../../../src/voice/voice-types.js').LiveVoiceSessionRequest) {
    return Promise.resolve(
      ok({
        providerSessionId: this.sideband.providerSessionId,
        client: {
          transport: input.transport.type,
          sessionId: input.sessionId,
          providerSessionId: this.sideband.providerSessionId,
          answer: { type: input.transport.type, sdp: 'answer' },
          expiresAt: Date.now() + 60_000,
        },
      } satisfies LiveVoiceSession),
    );
  }

  async attachSideband(_session: LiveVoiceSession) {
    const opened = await this.sideband.open();
    return opened.isErr() ? opened : ok(this.sideband);
  }

  closeSession(_providerSessionId: string) {
    return Promise.resolve(ok(undefined));
  }
}

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const migrations = runMigrations(
    db,
    join(import.meta.dirname, '../../../../src/core/database/migrations'),
  );
  if (migrations.isErr()) throw new Error(migrations.error.message);
  db.prepare(
    `INSERT INTO channels (id, type, name, config, enabled, created_at, updated_at)
     VALUES ('voice-channel', 'voice', 'browser-voice', '{}', 1, 1, 1)`,
  ).run();
  return db;
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('timed out waiting for voice queue composition'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function context(version: number, digest: string, text: string): VoiceContextSnapshot {
  return {
    version,
    digest,
    capturedAt: version,
    text,
    fragments: [],
    truncated: false,
  };
}

interface HarnessOptions {
  database?: Database.Database;
  providerSessionId?: string;
  provider?: LiveVoiceProvider;
  owner?: { ownerId: string; loginRevision: number };
  backendModel?: string;
  liveModel?: string;
  usdPerMinute?: number;
  isOwnerActive?: (owner: { ownerId: string; loginRevision: number }) => boolean;
}

interface VoiceHarnessBase {
  readonly db: Database.Database;
  readonly messages: MessageRepository;
  readonly store: DurableVoiceStore;
  readonly bridge: DurableVoiceBackendBridge;
  readonly service: DurableVoiceSessionService;
  readonly sink: VoiceOutputSink;
  readonly queueManager: QueueManager;
  readonly owner: { ownerId: string; loginRevision: number };
}

interface FakeVoiceHarness extends VoiceHarnessBase {
  readonly provider: FakeProvider;
}

interface ProviderVoiceHarness extends VoiceHarnessBase {
  readonly provider: LiveVoiceProvider;
}

function createHarness(options?: Omit<HarnessOptions, 'provider'>): FakeVoiceHarness;
function createHarness(options: HarnessOptions & { provider: LiveVoiceProvider }): ProviderVoiceHarness;
function createHarness(options: HarnessOptions = {}): FakeVoiceHarness | ProviderVoiceHarness {
  const harnessDb = options.database ?? createDb();
  const queueRepository = new QueueRepository(harnessDb);
  const threadRepository = new ThreadRepository(harnessDb);
  const messageRepository = new MessageRepository(harnessDb);
  const store = new DurableVoiceStore(harnessDb, queueRepository);
  const bridge = new DurableVoiceBackendBridge(store, queueRepository, { now: () => 20 });
  const provider = options.provider ?? new FakeProvider(options.providerSessionId);
  const transport: VoiceTransport = new BrowserVoiceTransport({ now: () => 20 });
  const policy = new VoicePolicy({
    providerTypes: new Map([['agent-provider', 'openai-compatible']]),
  });
  const owner = options.owner ?? { ownerId: 'owner-1', loginRevision: 1 };
  const backendModel = options.backendModel ?? 'voice-model';
  const capturePolicy = () =>
    policy.capture({
      generation: 1,
      ownerId: owner.ownerId,
      personaId: 'persona-1',
      providerName: 'agent-provider',
      modelName: backendModel,
      voiceName: 'marin',
      capabilityNames: [],
      allowedToolNames: [],
      allowedMcpServerNames: [],
      nativeToolNames: [],
      requireApproval: false,
      loginRevision: owner.loginRevision,
    });
  const service = new DurableVoiceSessionService({
    store,
    provider,
    transport,
    backendBridge: bridge,
    policy,
    threadRepository,
    messageRepository,
    channelId: 'voice-channel',
    personaId: 'persona-1',
    modelName: backendModel,
    liveModelName: options.liveModel,
    instructions: 'voice instructions',
    voiceName: 'marin',
    capturePolicy,
    currentPolicy: () => capturePolicy(),
    isOwnerActive: options.isOwnerActive,
    usdPerMinute: options.usdPerMinute,
  });
  const sink = new VoiceOutputSink(store, (result) => bridge.notifyResult(result));
  const queueManager = new QueueManager(
    queueRepository,
    threadRepository,
    { maxAttempts: 1, backoffBaseMs: 1, backoffMaxMs: 1, concurrencyLimit: 1 },
    pino({ level: 'silent' }),
    bridge.claimQueueItem.bind(bridge),
  );
  return {
    db: harnessDb,
    messages: messageRepository,
    store,
    bridge,
    provider,
    service,
    sink,
    queueManager,
    owner,
  } as FakeVoiceHarness | ProviderVoiceHarness;
}

describe('browser voice lifecycle composition', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('connects provider events to durable queue execution and retained status', async () => {
    db = createDb();
    const queueRepository = new QueueRepository(db);
    const threadRepository = new ThreadRepository(db);
    const store = new DurableVoiceStore(db, queueRepository);
    const bridge = new DurableVoiceBackendBridge(store, queueRepository, { now: () => 20 });
    const provider = new FakeProvider();
    const transport: VoiceTransport = new BrowserVoiceTransport({ now: () => 20 });
    const policy = new VoicePolicy({
      providerTypes: new Map([['agent-provider', 'openai-compatible']]),
    });
    const owner = { ownerId: 'owner-1', loginRevision: 1 };
    const capturePolicy = () =>
      policy.capture({
        generation: 1,
        ownerId: owner.ownerId,
        personaId: 'persona-1',
        providerName: 'agent-provider',
        modelName: 'voice-model',
        voiceName: 'marin',
        capabilityNames: [],
        allowedToolNames: [],
        allowedMcpServerNames: [],
        nativeToolNames: [],
        requireApproval: false,
        loginRevision: owner.loginRevision,
      });
    const service = new DurableVoiceSessionService({
      store,
      provider,
      transport,
      backendBridge: bridge,
      policy,
      threadRepository,
      channelId: 'voice-channel',
      personaId: 'persona-1',
      modelName: 'voice-model',
      instructions: 'voice instructions',
      voiceName: 'marin',
      capturePolicy,
      currentPolicy: () => capturePolicy(),
    });
    const sink = new VoiceOutputSink(store, (result) => bridge.notifyResult(result));
    const queueManager = new QueueManager(
      queueRepository,
      threadRepository,
      { maxAttempts: 1, backoffBaseMs: 1, backoffMaxMs: 1, concurrencyLimit: 1 },
      pino({ level: 'silent' }),
      bridge.claimQueueItem.bind(bridge),
    );

    const created = await service.createSession(owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const session = created._unsafeUnwrap();
    provider.sideband.emit({
      kind: 'delegation',
      eventId: 'event-1',
      sequence: 1,
      proposal: { providerDelegationId: 'provider-delegation-1', offsetMs: 0, receivedAt: 30 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    queueManager.startProcessing(async (item) => {
      const payload = item.payload as { request?: { delegationId?: string } };
      const delegationId = payload.request?.delegationId;
      if (!delegationId) return ok(undefined);
      const result = sink.final(delegationId, 'The current status is healthy.', 40);
      if (result.isErr()) throw result.error;
      return ok(undefined);
    });
    await waitFor(() => {
      const projection = store.readSession(session.session.id);
      return projection.isOk() && projection.value?.delegations[0]?.execution === 'succeeded';
    });
    queueManager.stopProcessing();

    const projection = store.readSession(session.session.id)._unsafeUnwrap();
    expect(projection?.delegations[0]).toMatchObject({
      providerDelegationId: 'provider-delegation-1',
      execution: 'succeeded',
    });
    expect(provider.sideband.commands).toContain('The current status is healthy.');

    const closed = await service.closeSession(owner, session.session.id, { reason: 'hangup' });
    expect(closed.isOk()).toBe(true);
    expect(service.status(owner, session.session.id)._unsafeUnwrap()?.status).toBe('closed');
  });

  it('queues one real sideband delegation when it arrives before the first transcript', async () => {
    db = createDb();
    const provider = new SocketProvider();
    const harness = createHarness({ provider });
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const session = created._unsafeUnwrap();

    harness.queueManager.startProcessing(async (item) => {
      const payload = item.payload as { request?: { delegationId?: string } };
      const delegationId = payload.request?.delegationId;
      if (!delegationId) return ok(undefined);
      const result = harness.sink.final(delegationId, 'The real queued result is safe.', 40);
      if (result.isErr()) throw result.error;
      return ok(undefined);
    });
    provider.socket.receive({
      type: 'session.delegation.created',
      event_id: 'socket-delegation-before-transcript',
      delegation: { id: 'socket-provider-delegation', target: 'client' },
      offset_ms: 100,
    });
    provider.socket.receive({
      type: 'session.input_transcript.delta',
      event_id: 'socket-user-first',
      item_id: 'socket-user-first',
      delta: 'Read the current status.',
      start_ms: 0,
      end_ms: 100,
    });
    provider.socket.receive({
      type: 'session.output_transcript.delta',
      event_id: 'socket-progress',
      item_id: 'socket-progress',
      delta: 'I am checking the current status.',
      start_ms: 110,
      end_ms: 140,
    });
    provider.socket.receive({
      type: 'session.output_transcript.completed',
      event_id: 'socket-progress-complete',
      item_id: 'socket-progress',
      text: 'I am checking the current status.',
      start_ms: 110,
      end_ms: 140,
    });

    await waitFor(() => {
      const projection = harness.store.readSession(session.session.id);
      return projection.isOk() && projection.value?.delegations[0]?.execution === 'succeeded';
    });
    harness.queueManager.stopProcessing();

    const projection = harness.store.readSession(session.session.id)._unsafeUnwrap();
    expect(projection?.delegations).toHaveLength(1);
    expect(projection?.delegations[0]).toMatchObject({
      providerDelegationId: 'socket-provider-delegation',
      execution: 'succeeded',
    });
    expect(provider.socket.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'session.commentary.append',
          content: 'The real queued result is safe.',
        }),
      ]),
    );
    provider.socket.receive({
      type: 'session.output_transcript.delta',
      event_id: 'socket-notification',
      item_id: 'socket-notification',
      delta: 'The background result is ready.',
      start_ms: 150,
      end_ms: 180,
    });
    provider.socket.receive({
      type: 'session.output_transcript.completed',
      event_id: 'socket-notification-complete',
      item_id: 'socket-notification',
      text: 'The background result is ready.',
      start_ms: 150,
      end_ms: 180,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      provider.socket.sent.some((command) => command.type === 'session.instructions.append'),
    ).toBe(false);

    const closed = await harness.service.closeSession(harness.owner, session.session.id, {
      reason: 'transport_failure',
    });
    expect(closed.isOk()).toBe(true);
  });

  it('clarifies an overlapping first notice that reuses the admitted user turn', async () => {
    db = createDb();
    const provider = new SocketProvider();
    const harness = createHarness({ provider });
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const session = created._unsafeUnwrap();
    const handledDelegations: string[] = [];

    harness.queueManager.startProcessing(async (item) => {
      const payload = item.payload as { request?: { delegationId?: string } };
      const delegationId = payload.request?.delegationId;
      if (!delegationId) return ok(undefined);
      handledDelegations.push(delegationId);
      const result = harness.sink.final(delegationId, 'The overlapping result is safe.', 40);
      if (result.isErr()) throw result.error;
      return ok(undefined);
    });
    provider.socket.receive({
      type: 'session.input_transcript.completed',
      event_id: 'socket-overlap-user',
      item_id: 'socket-overlap-user',
      text: 'Perform one action.',
      start_ms: 0,
      end_ms: 100,
    });
    provider.socket.receive({
      type: 'session.delegation.created',
      event_id: 'socket-overlap-delegation-1',
      delegation: { id: 'socket-overlap-provider-1', target: 'client' },
      offset_ms: 100,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    provider.socket.receive({
      type: 'session.delegation.created',
      event_id: 'socket-overlap-delegation-2',
      delegation: { id: 'socket-overlap-provider-2', target: 'client' },
      offset_ms: 100,
    });

    await waitFor(() => {
      const projection = harness.store.readSession(session.session.id);
      return projection.isOk() && projection.value?.delegations[0]?.execution === 'succeeded';
    });
    await waitFor(() =>
      provider.socket.sent.some((command) => command.type === 'session.instructions.append'),
    );
    harness.queueManager.stopProcessing();

    const projection = harness.store.readSession(session.session.id)._unsafeUnwrap();
    expect(handledDelegations).toHaveLength(1);
    expect(projection?.delegations).toHaveLength(1);
    expect(projection?.delegations[0]).toMatchObject({
      providerDelegationId: 'socket-overlap-provider-1',
      execution: 'succeeded',
    });
    expect(
      provider.socket.sent.filter((command) => command.type === 'session.instructions.append'),
    ).toHaveLength(1);

    const closed = await harness.service.closeSession(harness.owner, session.session.id, {
      reason: 'transport_failure',
    });
    expect(closed.isOk()).toBe(true);
  });

  it('keeps a claimed result listener alive after hangup', async () => {
    db = createDb();
    const queueRepository = new QueueRepository(db);
    const threadRepository = new ThreadRepository(db);
    const store = new DurableVoiceStore(db, queueRepository);
    const bridge = new DurableVoiceBackendBridge(store, queueRepository, { now: () => 20 });
    const provider = new FakeProvider();
    const transport: VoiceTransport = new BrowserVoiceTransport({ now: () => 20 });
    const policy = new VoicePolicy({
      providerTypes: new Map([['agent-provider', 'openai-compatible']]),
    });
    const owner = { ownerId: 'owner-1', loginRevision: 1 };
    const capturePolicy = () =>
      policy.capture({
        generation: 1,
        ownerId: owner.ownerId,
        personaId: 'persona-1',
        providerName: 'agent-provider',
        modelName: 'voice-model',
        voiceName: 'marin',
        capabilityNames: [],
        allowedToolNames: [],
        allowedMcpServerNames: [],
        nativeToolNames: [],
        requireApproval: false,
        loginRevision: owner.loginRevision,
      });
    const service = new DurableVoiceSessionService({
      store,
      provider,
      transport,
      backendBridge: bridge,
      policy,
      threadRepository,
      channelId: 'voice-channel',
      personaId: 'persona-1',
      modelName: 'voice-model',
      instructions: 'voice instructions',
      voiceName: 'marin',
      capturePolicy,
      currentPolicy: () => capturePolicy(),
    });
    const sink = new VoiceOutputSink(store, (result) => bridge.notifyResult(result));
    const queueManager = new QueueManager(
      queueRepository,
      threadRepository,
      { maxAttempts: 1, backoffBaseMs: 1, backoffMaxMs: 1, concurrencyLimit: 1 },
      pino({ level: 'silent' }),
      bridge.claimQueueItem.bind(bridge),
    );
    const created = await service.createSession(owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const session = created._unsafeUnwrap();
    let release!: () => void;
    const claimed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimedResolve!: () => void;
    const hasClaimed = new Promise<void>((resolve) => {
      claimedResolve = resolve;
    });
    queueManager.startProcessing(async (item) => {
      const payload = item.payload as { request?: { delegationId?: string } };
      if (!payload.request?.delegationId) return ok(undefined);
      claimedResolve();
      await claimed;
      const result = sink.final(payload.request.delegationId, 'The retained result is safe.', 40);
      if (result.isErr()) throw result.error;
      return ok(undefined);
    });

    provider.sideband.emit({
      kind: 'delegation',
      eventId: 'event-hangup',
      sequence: 1,
      proposal: { providerDelegationId: 'provider-delegation-hangup', offsetMs: 0, receivedAt: 30 },
    });
    await hasClaimed;
    const closed = await service.closeSession(owner, session.session.id, { reason: 'hangup' });
    expect(closed.isOk()).toBe(true);
    expect(closed._unsafeUnwrap().pendingDelegation).toBe(true);
    const retainedEvents: string[] = [];
    const subscription = service.subscribe(owner, session.session.id, (event) => {
      retainedEvents.push(event.kind);
    });
    expect(subscription.isOk()).toBe(true);
    await waitFor(() => retainedEvents.includes('session'));
    release();
    await waitFor(() => provider.sideband.commands.includes('The retained result is safe.'));
    await waitFor(() => retainedEvents.includes('delegation'));
    expect(service.status(owner, session.session.id)._unsafeUnwrap()?.status).toBe('closed');
    subscription._unsafeUnwrap()();
    queueManager.stopProcessing();
  });

  it('passes the configured GPT-Live model while preserving the backend policy model', async () => {
    const harness = createHarness({ backendModel: 'gpt-5.4', liveModel: 'gpt-live-1' });
    db = harness.db;
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    expect(harness.provider.lastModelName).toBe('gpt-live-1');
    expect(created._unsafeUnwrap().session.policy.modelName).toBe('gpt-5.4');
    await harness.service.closeSession(harness.owner, created._unsafeUnwrap().session.id, { reason: 'hangup' });
  });

  it('reuses owner and persona history after service reconstruction while isolating another owner', async () => {
    const first = createHarness();
    db = first.db;
    const firstCreated = await first.service.createSession(first.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(firstCreated.isOk()).toBe(true);
    const firstSession = firstCreated._unsafeUnwrap().session;

    first.provider.sideband.emit({
      kind: 'transcript',
      eventId: 'transcript-fact-user',
      sequence: 1,
      fragment: {
        id: 'fact-user',
        role: 'user',
        kind: 'completed',
        sequence: 1,
        text: 'My cat is called Nori.',
        receivedAt: 30,
      },
    });
    first.provider.sideband.emit({
      kind: 'transcript',
      eventId: 'transcript-fact-assistant',
      sequence: 2,
      fragment: {
        id: 'fact-assistant',
        role: 'assistant',
        kind: 'completed',
        sequence: 2,
        text: 'I will remember that.',
        receivedAt: 31,
      },
    });
    await waitFor(
      () =>
        first.messages.findLatestByThread(firstSession.threadId, 10)._unsafeUnwrap().length === 2,
    );
    const firstRows = first.messages.findLatestByThread(firstSession.threadId, 10)._unsafeUnwrap();
    expect(firstRows.map((row) => JSON.parse(row.content).body)).toEqual([
      'My cat is called Nori.',
      'I will remember that.',
    ]);
    const originalUserRow = firstRows[0];
    first.provider.sideband.emit({
      kind: 'transcript',
      eventId: 'transcript-fact-correction',
      sequence: 3,
      fragment: {
        id: 'fact-user',
        role: 'user',
        kind: 'correction',
        sequence: 3,
        text: 'My cat is called Nori and likes naps.',
        receivedAt: 32,
      },
    });
    await waitFor(() => {
      const rows = first.messages.findLatestByThread(firstSession.threadId, 10)._unsafeUnwrap();
      return (
        rows[0]?.id === originalUserRow?.id &&
        JSON.parse(rows[0].content).body === 'My cat is called Nori and likes naps.'
      );
    });
    const correctedRows = first.messages
      .findLatestByThread(firstSession.threadId, 10)
      ._unsafeUnwrap();
    expect(correctedRows).toHaveLength(2);
    expect(correctedRows.map((row) => row.id)).toEqual(firstRows.map((row) => row.id));

    const closed = await first.service.closeSession(first.owner, firstSession.id, {
      reason: 'hangup',
    });
    expect(closed.isOk()).toBe(true);

    const reconstructed = createHarness({
      database: first.db,
      providerSessionId: 'provider-session-2',
    });
    const secondCreated = await reconstructed.service.createSession(reconstructed.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(secondCreated.isOk()).toBe(true);
    const secondSession = secondCreated._unsafeUnwrap().session;
    expect(secondSession.threadId).toBe(firstSession.threadId);
    expect(secondSession.id).not.toBe(firstSession.id);
    expect(reconstructed.provider.lastInstructions).toContain(
      'My cat is called Nori and likes naps.',
    );
    expect(reconstructed.provider.lastInstructions).toContain('I will remember that.');
    expect(reconstructed.provider.lastInstructions).toContain('<voice-history>');

    const secondClosed = await reconstructed.service.closeSession(
      reconstructed.owner,
      secondSession.id,
      { reason: 'hangup' },
    );
    expect(secondClosed.isOk()).toBe(true);

    const otherOwner = createHarness({
      database: first.db,
      providerSessionId: 'provider-session-3',
      owner: { ownerId: 'owner-2', loginRevision: 1 },
    });
    const isolatedCreated = await otherOwner.service.createSession(otherOwner.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(isolatedCreated.isOk()).toBe(true);
    expect(isolatedCreated._unsafeUnwrap().session.threadId).not.toBe(firstSession.threadId);
    expect(otherOwner.provider.lastInstructions).not.toContain('My cat is called Nori.');
    await otherOwner.service.closeSession(
      otherOwner.owner,
      isolatedCreated._unsafeUnwrap().session.id,
      { reason: 'hangup' },
    );
  });

  it('scopes durable history recovery to the requested thread before the result bound', async () => {
    const harness = createHarness();
    db = harness.db;
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const targetSession = created._unsafeUnwrap().session;
    expect((await harness.service.closeSession(harness.owner, targetSession.id, { reason: 'hangup' })).isOk()).toBe(true);

    const recordResult = (session: VoiceSessionRecord, index: number, occurredAt: number) => {
      const delegationId = `history-delegation-${index}`;
      const providerDelegationId = `history-provider-delegation-${index}`;
      const queueItemId = `history-queue-${index}`;
      const request: VoiceBackendRequest = {
        sessionId: session.id,
        delegationId,
        providerDelegationId,
        threadId: session.threadId,
        personaId: session.personaId,
        context: context(index + 1, `history-digest-${index}`, `History request ${index}.`),
        policy: session.policy,
        requestedAt: occurredAt,
      };
      const delegation: VoiceDelegationRecord = {
        id: delegationId,
        sessionId: session.id,
        providerDelegationId,
        revision: 0,
        contextVersion: request.context.version,
        contextDigest: request.context.digest,
        request,
        status: 'admitted',
        execution: 'not_started',
        output: {
          execution: 'not_started',
          delivery: 'not_requested',
          providerAcknowledgement: 'not_sent',
          playback: 'not_started',
        },
        queueItemId,
        createdAt: occurredAt,
      };
      const admitted = harness.store.admitDelegation({
        delegation,
        queue: { queueItemId, threadId: session.threadId, delegationId, request, maxAttempts: 1 },
      });
      expect(admitted.isOk()).toBe(true);
      const recorded = harness.store.recordBackendResult({
        delegationId,
        outputId: `history-output-${index}`,
        kind: 'final',
        text: `Durable history result ${index}.`,
        execution: 'succeeded',
        output: {
          execution: 'succeeded',
          delivery: 'sent',
          providerAcknowledgement: 'acknowledged',
          playback: 'played',
        },
        occurredAt,
      });
      expect(recorded.isOk()).toBe(true);
    };

    recordResult(targetSession, 0, 10);
    const threadRepository = new ThreadRepository(harness.db);
    for (let index = 1; index <= 201; index += 1) {
      const threadId = `history-unrelated-thread-${index}`;
      const insertedThread = threadRepository.insert({
        id: threadId,
        channel_id: 'voice-channel',
        external_id: `history-unrelated-external-${index}`,
        metadata: '{}',
      });
      expect(insertedThread.isOk()).toBe(true);
      const unrelatedSession: VoiceSessionRecord = {
        ...targetSession,
        id: `history-unrelated-session-${index}`,
        owner: { ownerId: `history-unrelated-owner-${index}`, loginRevision: 1 },
        threadId,
        providerSessionId: undefined,
        createdAt: targetSession.createdAt + index,
        closedAt: (targetSession.closedAt ?? targetSession.createdAt) + index,
        policy: { ...targetSession.policy, ownerId: `history-unrelated-owner-${index}` },
      };
      const insertedSession = harness.store.createSession(unrelatedSession);
      expect(insertedSession.isOk()).toBe(true);
      recordResult(unrelatedSession, index, 10 + index);
    }

    const filtered = harness.store.listSessions({ threadId: targetSession.threadId });
    expect(filtered.isOk()).toBe(true);
    expect(filtered._unsafeUnwrap().map((projection) => projection.session.id)).toEqual([
      targetSession.id,
    ]);

    const reconstructed = createHarness({
      database: harness.db,
      providerSessionId: 'provider-session-reconstructed',
    });
    const reopened = await reconstructed.service.createSession(reconstructed.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(reopened.isOk()).toBe(true);
    expect(reconstructed.provider.lastInstructions).toContain('Durable history result 0.');
    expect(reconstructed.provider.lastInstructions).not.toContain('Durable history result 1.');
    await reconstructed.service.closeSession(
      reconstructed.owner,
      reopened._unsafeUnwrap().session.id,
      { reason: 'hangup' },
    );
  });

  it('supersedes stale queued context before claim and executes only the replacement', async () => {
    const harness = createHarness();
    db = harness.db;
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const sessionId = created._unsafeUnwrap().session.id;
    harness.provider.sideband.setContext(
      'provider-original',
      context(1, 'digest-original', 'Do the original request.'),
    );
    const originalResult = await harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'delegation',
        eventId: 'event-original',
        sequence: 1,
        proposal: { providerDelegationId: 'provider-original', offsetMs: 0, receivedAt: 30 },
      },
    });
    harness.provider.sideband.setContext(
      'provider-correction',
      context(2, 'digest-correction', 'Do the corrected request.'),
    );
    const correctionResult = await harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'delegation',
        eventId: 'event-correction',
        sequence: 2,
        proposal: { providerDelegationId: 'provider-correction', offsetMs: 0, receivedAt: 40 },
      },
    });
    if (originalResult.isErr()) throw new Error(originalResult.error.message);
    if (correctionResult.isErr()) throw new Error(correctionResult.error.message);

    const beforeClaim = harness.store.readSession(sessionId)._unsafeUnwrap();
    expect(beforeClaim?.delegations).toHaveLength(2);
    expect(beforeClaim?.delegations[0]).toMatchObject({
      providerDelegationId: 'provider-original',
      status: 'superseded',
      contextDigest: 'digest-original',
    });
    expect(beforeClaim?.delegations[1]).toMatchObject({
      providerDelegationId: 'provider-correction',
      status: 'queued',
      contextDigest: 'digest-correction',
      supersedesDelegationId: beforeClaim?.delegations[0]?.id,
    });

    const executedProviders: string[] = [];
    harness.queueManager.startProcessing(async (item) => {
      const payload = item.payload as {
        request?: { delegationId?: string; providerDelegationId?: string };
      };
      const request = payload.request;
      if (!request?.delegationId || !request.providerDelegationId) return ok(undefined);
      executedProviders.push(request.providerDelegationId);
      const result = harness.sink.final(request.delegationId, 'The corrected request is complete.', 50);
      if (result.isErr()) throw result.error;
      return ok(undefined);
    });
    await waitFor(() => {
      const projection = harness.store.readSession(sessionId);
      return projection.isOk() && projection.value?.delegations[1]?.execution === 'succeeded';
    });
    harness.queueManager.stopProcessing();
    expect(executedProviders).toEqual(['provider-correction']);
    await harness.service.closeSession(harness.owner, sessionId, { reason: 'hangup' });
  });

  it('skips queued work when a normalized transcript correction invalidates its context', async () => {
    const harness = createHarness();
    db = harness.db;
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const sessionId = created._unsafeUnwrap().session.id;
    harness.provider.sideband.setContext(
      'provider-transcript-correction',
      context(1, 'digest-before-correction', 'Book Friday.'),
    );
    const admitted = await harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'delegation',
        eventId: 'event-transcript-correction',
        sequence: 1,
        proposal: {
          providerDelegationId: 'provider-transcript-correction',
          offsetMs: 0,
          receivedAt: 30,
        },
      },
    });
    expect(admitted.isOk()).toBe(true);

    harness.provider.sideband.setContext(
      'provider-transcript-correction',
      context(2, 'digest-before-correction', 'Book Friday.'),
    );
    const laterFragment = await harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'transcript',
        eventId: 'event-later-fragment',
        sequence: 2,
        fragment: {
          id: 'assistant-1',
          role: 'assistant',
          kind: 'completed',
          sequence: 2,
          text: 'A later response outside the captured request.',
          startMs: 200,
          endMs: 300,
          receivedAt: 35,
        },
      },
    });
    expect(laterFragment.isOk()).toBe(true);
    const retainedBeforeCorrection = harness.store.readSession(sessionId)._unsafeUnwrap();
    expect(retainedBeforeCorrection?.delegations[0]?.status).toBe('queued');

    harness.provider.sideband.invalidateContext('provider-transcript-correction');
    const corrected = await harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'transcript',
        eventId: 'event-transcript-correction-result',
        sequence: 3,
        fragment: {
          id: 'utterance-1',
          role: 'user',
          kind: 'correction',
          sequence: 3,
          text: 'No Thursday.',
          receivedAt: 40,
        },
      },
    });
    expect(corrected.isOk()).toBe(true);
    expect(harness.provider.sideband.commands).toContain(
      'The transcript changed before that request could start. Please repeat it.',
    );

    const projection = harness.store.readSession(sessionId)._unsafeUnwrap();
    expect(projection?.session.activeDelegationId).toBeUndefined();
    expect(projection?.delegations).toHaveLength(1);
    expect(projection?.delegations[0]).toMatchObject({
      providerDelegationId: 'provider-transcript-correction',
      status: 'skipped',
      execution: 'skipped',
      contextDigest: 'digest-before-correction',
    });
    expect(harness.db.prepare('SELECT status FROM queue_items').get()).toMatchObject({ status: 'completed' });
    await harness.service.closeSession(harness.owner, sessionId, { reason: 'hangup' });
  });

  it('closes a revoked session before admitting durable voice work', async () => {
    let active = true;
    const harness = createHarness({ isOwnerActive: () => active });
    db = harness.db;
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const sessionId = created._unsafeUnwrap().session.id;
    active = false;
    await harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'delegation',
        eventId: 'event-revoked',
        sequence: 1,
        proposal: { providerDelegationId: 'provider-revoked', offsetMs: 0, receivedAt: 30 },
      },
    });
    const projection = harness.store.readSession(sessionId)._unsafeUnwrap();
    expect(projection?.session.status).toBe('closed');
    expect(projection?.delegations).toHaveLength(0);
    expect(harness.db.prepare('SELECT COUNT(*) AS count FROM queue_items').get()).toMatchObject({ count: 0 });
  });

  it('maps provider acknowledgements to the internal delegation record', async () => {
    const harness = createHarness();
    db = harness.db;
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const sessionId = created._unsafeUnwrap().session.id;
    await harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'delegation',
        eventId: 'event-ack',
        sequence: 1,
        proposal: { providerDelegationId: 'provider-ack', offsetMs: 0, receivedAt: 30 },
      },
    });
    const beforeResult = harness.store.readSession(sessionId)._unsafeUnwrap();
    const delegationId = beforeResult?.delegations[0]?.id;
    expect(delegationId).toBeDefined();
    const final = harness.sink.final(delegationId!, 'Acknowledged result.', 40)._unsafeUnwrap();
    await waitFor(() => harness.provider.sideband.commands.includes('Acknowledged result.'));
    await harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'provider_acknowledgement',
        eventId: 'event-provider-ack',
        sequence: 2,
        delegationId: 'provider-ack',
        outputId: final.outputId,
        receivedAt: 50,
      },
    });
    const projection = harness.store.readSession(sessionId)._unsafeUnwrap();
    expect(projection?.outputs.find((output) => output.id === final.outputId)?.lifecycle.providerAcknowledgement).toBe(
      'acknowledged',
    );
    await harness.service.closeSession(harness.owner, sessionId, { reason: 'hangup' });
  });

  it('retains final cumulative usage received while closing the provider session', async () => {
    const harness = createHarness();
    db = harness.db;
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const sessionId = created._unsafeUnwrap().session.id;
    await harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'usage',
        eventId: 'usage-periodic',
        sequence: 1,
        update: { voiceSeconds: 10, receivedAt: 30, final: false },
      },
    });
    harness.provider.sideband.latestUsage = { voiceSeconds: 40, receivedAt: 50, final: true };
    const closed = await harness.service.closeSession(harness.owner, sessionId, { reason: 'hangup' });
    expect(closed.isOk()).toBe(true);
    const projection = harness.store.readSession(sessionId)._unsafeUnwrap();
    expect(projection?.session.usage.voiceSeconds).toBe(40);
    expect(projection?.session.finalization.status).toBe('confirmed');
  });

  it('estimates cumulative voice cost once and keeps finalization separate from billing status', async () => {
    const harness = createHarness({ usdPerMinute: 0.06 });
    db = harness.db;
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const sessionId = created._unsafeUnwrap().session.id;
    const usage = (voiceSeconds: number, final: boolean, eventId: string) =>
      harness.service.receiveProviderEvent({
        sessionId,
        providerSessionId: 'provider-session-1',
        event: {
          kind: 'usage',
          eventId,
          sequence: voiceSeconds,
          update: { voiceSeconds, receivedAt: voiceSeconds, final },
        },
      });

    await usage(30, false, 'usage-30');
    await usage(30, false, 'usage-30-duplicate');
    const beforeClose = harness.store.readSession(sessionId)._unsafeUnwrap();
    expect(beforeClose?.session.usage).toMatchObject({
      voiceSeconds: 30,
      voiceCostUsd: 0.03,
      voiceCostStatus: 'estimated',
    });

    harness.provider.sideband.latestUsage = { voiceSeconds: 60, receivedAt: 60, final: true };
    const closed = await harness.service.closeSession(harness.owner, sessionId, { reason: 'hangup' });
    expect(closed.isOk()).toBe(true);
    const afterClose = harness.store.readSession(sessionId)._unsafeUnwrap();
    expect(afterClose?.session.usage).toMatchObject({
      voiceSeconds: 60,
      voiceCostUsd: 0.06,
      voiceCostStatus: 'estimated',
    });
    expect(afterClose?.session.finalization.status).toBe('confirmed');
  });

  it('marks a known-rate estimate incomplete when provider finalization is missing', async () => {
    const harness = createHarness({ usdPerMinute: 0.06 });
    db = harness.db;
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const sessionId = created._unsafeUnwrap().session.id;
    await harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'usage',
        eventId: 'usage-incomplete',
        sequence: 1,
        update: { voiceSeconds: 30, receivedAt: 30, final: false },
      },
    });

    const closed = await harness.service.closeSession(harness.owner, sessionId, { reason: 'hangup' });
    expect(closed.isOk()).toBe(true);
    const projection = harness.store.readSession(sessionId)._unsafeUnwrap();
    expect(projection?.session.usage).toMatchObject({
      voiceSeconds: 30,
      voiceCostUsd: 0.03,
      voiceCostStatus: 'incomplete',
    });
    expect(projection?.session.finalization).toEqual({ status: 'incomplete' });
  });

  it('keeps cost unavailable without a rate while retaining provider finalization', async () => {
    const harness = createHarness();
    db = harness.db;
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const sessionId = created._unsafeUnwrap().session.id;
    await harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'usage',
        eventId: 'usage-no-rate',
        sequence: 1,
        update: { voiceSeconds: 60, receivedAt: 60, final: false },
      },
    });
    harness.provider.sideband.latestUsage = { voiceSeconds: 60, receivedAt: 60, final: true };

    const closed = await harness.service.closeSession(harness.owner, sessionId, { reason: 'hangup' });
    expect(closed.isOk()).toBe(true);
    const projection = harness.store.readSession(sessionId)._unsafeUnwrap();
    expect(projection?.session.usage).toMatchObject({
      voiceSeconds: 60,
      voiceCostStatus: 'unavailable',
    });
    expect(projection?.session.usage.voiceCostUsd).toBeUndefined();
    expect(projection?.session.finalization.status).toBe('confirmed');
  });

  it('does not persist an infinite estimate when the rate-times-duration product overflows', async () => {
    const harness = createHarness({ usdPerMinute: Number.MAX_VALUE });
    db = harness.db;
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const sessionId = created._unsafeUnwrap().session.id;
    await harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'usage',
        eventId: 'usage-overflow',
        sequence: 1,
        update: { voiceSeconds: Number.MAX_VALUE, receivedAt: 1, final: false },
      },
    });

    const projection = harness.store.readSession(sessionId)._unsafeUnwrap();
    expect(projection?.session.usage.voiceSeconds).toBe(Number.MAX_VALUE);
    expect(projection?.session.usage.voiceCostUsd).toBeUndefined();
    expect(projection?.session.usage.voiceCostStatus).toBe('unavailable');
    await harness.service.closeSession(harness.owner, sessionId, { reason: 'hangup' });
  });

  it('retains but does not speak a running result after a transcript correction', async () => {
    const harness = createHarness();
    db = harness.db;
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const sessionId = created._unsafeUnwrap().session.id;
    const providerDelegationId = 'provider-running-correction';
    harness.provider.sideband.setContext(
      providerDelegationId,
      context(1, 'digest-book-friday', 'Book Friday.'),
    );
    const admitted = await harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'delegation',
        eventId: 'event-running-correction',
        sequence: 1,
        proposal: { providerDelegationId, offsetMs: 0, receivedAt: 30 },
      },
    });
    expect(admitted.isOk()).toBe(true);
    const admittedProjection = harness.store.readSession(sessionId)._unsafeUnwrap();
    const delegationId = admittedProjection?.delegations[0]?.id;
    expect(delegationId).toBeDefined();

    let release!: () => void;
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executionStartedResolve!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      executionStartedResolve = resolve;
    });
    harness.queueManager.startProcessing(async (item) => {
      const payload = item.payload as { request?: { delegationId?: string } };
      if (payload.request?.delegationId !== delegationId) return ok(undefined);
      const started = harness.sink.executionStarted(delegationId, 40);
      if (started.isErr()) throw started.error;
      executionStartedResolve();
      await running;
      const final = harness.sink.final(delegationId, 'Booked Friday', 80);
      if (final.isErr()) throw final.error;
      return ok(undefined);
    });
    await executionStarted;
    await waitFor(() => {
      const projection = harness.store.readSession(sessionId);
      return projection.isOk() && projection.value?.delegations[0]?.execution === 'running';
    });

    harness.provider.sideband.setContext(
      providerDelegationId,
      context(2, 'digest-book-friday', 'Book Friday.'),
    );
    const laterFragment = await harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'transcript',
        eventId: 'event-running-later-fragment',
        sequence: 2,
        fragment: {
          id: 'assistant-later',
          role: 'assistant',
          kind: 'completed',
          sequence: 2,
          text: 'A later response outside the captured request.',
          startMs: 200,
          endMs: 300,
          receivedAt: 45,
        },
      },
    });
    expect(laterFragment.isOk()).toBe(true);
    expect(harness.provider.sideband.commands).not.toContain(
      'The earlier request is already running. Its result will be retained, but it will not answer your correction. Please repeat the corrected request.',
    );

    harness.provider.sideband.invalidateContext(providerDelegationId);
    const correction = harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'transcript',
        eventId: 'event-running-correction-result',
        sequence: 3,
        fragment: {
          id: 'utterance-correction',
          role: 'user',
          kind: 'correction',
          sequence: 3,
          text: 'No Thursday.',
          receivedAt: 50,
        },
      },
    });
    const correctionResult = await correction;
    expect(correctionResult.isOk()).toBe(true);
    expect(harness.provider.sideband.commands).toContain(
      'The earlier request is already running. Its result will be retained, but it will not answer your correction. Please repeat the corrected request.',
    );
    release();

    await waitFor(() => {
      const projection = harness.store.readSession(sessionId);
      return projection.isOk() && projection.value?.delegations[0]?.execution === 'succeeded';
    });
    await waitFor(() => harness.provider.sideband.commands.every((command) => command !== 'Booked Friday'));
    const afterFinal = harness.store.readSession(sessionId)._unsafeUnwrap();
    const finalOutput = afterFinal?.outputs.find((output) => output.text === 'Booked Friday');
    expect(afterFinal?.delegations[0]).toMatchObject({
      status: 'completed',
      execution: 'succeeded',
    });
    expect(finalOutput?.lifecycle).toMatchObject({
      execution: 'succeeded',
      delivery: 'not_requested',
    });

    const commandCount = harness.provider.sideband.commands.length;
    const duplicate = harness.sink.final(delegationId, 'Booked Friday', 90);
    expect(duplicate.isOk()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.provider.sideband.commands).toHaveLength(commandCount);

    harness.queueManager.stopProcessing();
    const closed = await harness.service.closeSession(harness.owner, sessionId, { reason: 'hangup' });
    expect(closed.isOk()).toBe(true);
    expect(harness.service.status(harness.owner, sessionId)._unsafeUnwrap()?.delegations[0]?.outputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: 'Booked Friday' })]),
    );
  });

  it('speaks a result when later transcript leaves the captured digest unchanged while running', async () => {
    const harness = createHarness();
    db = harness.db;
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const sessionId = created._unsafeUnwrap().session.id;
    const providerDelegationId = 'provider-running-later-fragment';
    harness.provider.sideband.setContext(
      providerDelegationId,
      context(1, 'digest-stable', 'Book Friday.'),
    );
    const admitted = await harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'delegation',
        eventId: 'event-running-later-delegation',
        sequence: 1,
        proposal: { providerDelegationId, offsetMs: 0, receivedAt: 30 },
      },
    });
    expect(admitted.isOk()).toBe(true);
    const admittedProjection = harness.store.readSession(sessionId)._unsafeUnwrap();
    const delegationId = admittedProjection?.delegations[0]?.id;
    expect(delegationId).toBeDefined();

    let release!: () => void;
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executionStartedResolve!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      executionStartedResolve = resolve;
    });
    harness.queueManager.startProcessing(async (item) => {
      const payload = item.payload as { request?: { delegationId?: string } };
      if (payload.request?.delegationId !== delegationId) return ok(undefined);
      const started = harness.sink.executionStarted(delegationId, 40);
      if (started.isErr()) throw started.error;
      executionStartedResolve();
      await running;
      const final = harness.sink.final(delegationId, 'Booked Friday', 80);
      if (final.isErr()) throw final.error;
      return ok(undefined);
    });
    await executionStarted;
    harness.provider.sideband.setContext(
      providerDelegationId,
      context(2, 'digest-stable', 'Book Friday.'),
    );
    const laterFragment = await harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'transcript',
        eventId: 'event-running-later-fragment-only',
        sequence: 2,
        fragment: {
          id: 'assistant-later-only',
          role: 'assistant',
          kind: 'completed',
          sequence: 2,
          text: 'A later response outside the captured request.',
          startMs: 200,
          endMs: 300,
          receivedAt: 45,
        },
      },
    });
    expect(laterFragment.isOk()).toBe(true);
    release();
    await waitFor(() => harness.provider.sideband.commands.includes('Booked Friday'));
    const projection = harness.store.readSession(sessionId)._unsafeUnwrap();
    expect(projection?.delegations[0]).toMatchObject({
      status: 'completed',
      execution: 'succeeded',
    });
    expect(harness.provider.sideband.commands).not.toContain(
      'The earlier request is already running. Its result will be retained, but it will not answer your correction. Please repeat the corrected request.',
    );
    harness.queueManager.stopProcessing();
    await harness.service.closeSession(harness.owner, sessionId, { reason: 'hangup' });
  });

  it('allows a current login revision to read retained status while mutations stay exact-owner', async () => {
    let activeRevision = 1;
    const harness = createHarness({
      isOwnerActive: (owner) => owner.loginRevision === activeRevision,
    });
    db = harness.db;
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const sessionId = created._unsafeUnwrap().session.id;
    await harness.service.closeSession(harness.owner, sessionId, { reason: 'hangup' });
    activeRevision = 2;
    const currentOwner = { ownerId: 'owner-1', loginRevision: 2 };
    expect(harness.service.status(currentOwner, sessionId).isOk()).toBe(true);
    expect((await harness.service.closeSession(currentOwner, sessionId, { reason: 'hangup' })).isErr()).toBe(true);
    const events: Array<{ kind: string; session?: { status: string } }> = [];
    const subscription = harness.service.subscribe(currentOwner, sessionId, (event) => {
      events.push({ kind: event.kind, ...(event.kind === 'session' ? { session: event.session } : {}) });
    });
    expect(subscription.isOk()).toBe(true);
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ kind: 'session', session: expect.objectContaining({ status: 'closed' }) });
    subscription._unsafeUnwrap()();
  });
});
