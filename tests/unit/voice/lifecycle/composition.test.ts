import { join } from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { ok } from 'neverthrow';

import { runMigrations } from '../../../../src/core/database/migrations/runner.js';
import { QueueRepository } from '../../../../src/core/database/repositories/queue-repository.js';
import { ThreadRepository } from '../../../../src/core/database/repositories/thread-repository.js';
import { QueueManager } from '../../../../src/queue/queue-manager.js';
import { DurableVoiceBackendBridge } from '../../../../src/voice/voice-backend-bridge.js';
import { VoiceOutputSink } from '../../../../src/voice/voice-output-sink.js';
import { DurableVoiceStore } from '../../../../src/voice/voice-store.js';
import { VoicePolicy } from '../../../../src/voice/voice-policy.js';
import {
  BrowserVoiceTransport,
  DurableVoiceSessionService,
} from '../../../../src/voice/voice-session-service.js';
import type {
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
  readonly providerSessionId = 'provider-session-1';
  readonly commands: string[] = [];
  readonly contexts = new Map<string, VoiceContextSnapshot>();
  readonly invalidContexts = new Set<string>();
  latestUsage: VoiceUsageUpdate | undefined;
  private handler: VoiceEventHandler<import('../../../../src/voice/voice-types.js').LiveVoiceEvent> | undefined;

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
  readonly sideband = new FakeSideband();
  lastModelName: string | undefined;

  createSession(input: import('../../../../src/voice/voice-types.js').LiveVoiceSessionRequest) {
    this.lastModelName = input.modelName;
    const session: LiveVoiceSession = {
      providerSessionId: 'provider-session-1',
      client: {
        transport: input.transport.type,
        sessionId: input.sessionId,
        providerSessionId: 'provider-session-1',
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

function createHarness(options: {
  owner?: { ownerId: string; loginRevision: number };
  backendModel?: string;
  liveModel?: string;
  isOwnerActive?: (owner: { ownerId: string; loginRevision: number }) => boolean;
} = {}) {
  const harnessDb = createDb();
  const queueRepository = new QueueRepository(harnessDb);
  const threadRepository = new ThreadRepository(harnessDb);
  const store = new DurableVoiceStore(harnessDb, queueRepository);
  const bridge = new DurableVoiceBackendBridge(store, queueRepository, { now: () => 20 });
  const provider = new FakeProvider();
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
    channelId: 'voice-channel',
    personaId: 'persona-1',
    modelName: backendModel,
    liveModelName: options.liveModel,
    instructions: 'voice instructions',
    voiceName: 'marin',
    capturePolicy,
    currentPolicy: () => capturePolicy(),
    isOwnerActive: options.isOwnerActive,
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
    store,
    bridge,
    provider,
    service,
    sink,
    queueManager,
    owner,
  };
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

    harness.provider.sideband.invalidateContext('provider-transcript-correction');
    const corrected = await harness.service.receiveProviderEvent({
      sessionId,
      providerSessionId: 'provider-session-1',
      event: {
        kind: 'transcript',
        eventId: 'event-transcript-correction-result',
        sequence: 2,
        fragment: {
          id: 'utterance-1',
          role: 'user',
          kind: 'correction',
          sequence: 2,
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
