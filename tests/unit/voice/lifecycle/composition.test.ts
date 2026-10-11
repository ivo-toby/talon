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
  VoiceSessionRecord,
  VoiceTransport,
  VoiceUnsubscribe,
} from '../../../../src/voice/voice-types.js';

class FakeSideband implements LiveVoiceSideband {
  readonly providerSessionId = 'provider-session-1';
  readonly commands: string[] = [];
  private handler: VoiceEventHandler<import('../../../../src/voice/voice-types.js').LiveVoiceEvent> | undefined;

  contextForDelegation(_providerDelegationId: string): VoiceContextSnapshot {
    return {
      version: 1,
      digest: 'context-digest-1',
      capturedAt: 10,
      text: 'Read the current status.',
      fragments: [],
      truncated: false,
    };
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
    return Promise.resolve(ok(undefined));
  }

  emit(event: import('../../../../src/voice/voice-types.js').LiveVoiceEvent): void {
    this.handler?.(event);
  }
}

class FakeProvider implements LiveVoiceProvider {
  readonly name = 'openai-live';
  readonly sideband = new FakeSideband();

  createSession(input: import('../../../../src/voice/voice-types.js').LiveVoiceSessionRequest) {
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
    release();
    await waitFor(() => provider.sideband.commands.includes('The retained result is safe.'));
    expect(service.status(owner, session.session.id)._unsafeUnwrap()?.status).toBe('closed');
    queueManager.stopProcessing();
  });
});
