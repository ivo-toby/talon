import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ok } from '../../../../src/core/types/result.js';
import { runMigrations } from '../../../../src/core/database/migrations/runner.js';
import { MessageRepository } from '../../../../src/core/database/repositories/message-repository.js';
import { QueueRepository } from '../../../../src/core/database/repositories/queue-repository.js';
import { ThreadRepository } from '../../../../src/core/database/repositories/thread-repository.js';
import { DurableVoiceBackendBridge } from '../../../../src/voice/voice-backend-bridge.js';
import { VoicePolicy } from '../../../../src/voice/voice-policy.js';
import {
  BrowserVoiceTransport,
  DurableVoiceSessionService,
} from '../../../../src/voice/voice-session-service.js';
import { DurableVoiceStore } from '../../../../src/voice/voice-store.js';
import type {
  LiveVoiceProvider,
  LiveVoiceSession,
  LiveVoiceSideband,
  LiveVoiceCommand,
  VoiceEventHandler,
  VoiceUnsubscribe,
} from '../../../../src/voice/voice-types.js';

class FakeSideband implements LiveVoiceSideband {
  readonly providerSessionId = 'provider-session-1';
  readonly commands: LiveVoiceCommand[] = [];

  send(command: LiveVoiceCommand) {
    this.commands.push(command);
    return Promise.resolve(ok(undefined));
  }

  onEvent(_handler: VoiceEventHandler<import('../../../../src/voice/voice-types.js').LiveVoiceEvent>): VoiceUnsubscribe {
    return () => undefined;
  }

  close(_graceful: boolean) {
    return Promise.resolve(ok(undefined));
  }
}

class FakeProvider implements LiveVoiceProvider {
  readonly name = 'openai-live';
  readonly sideband = new FakeSideband();
  createCount = 0;
  closeCount = 0;

  createSession(input: import('../../../../src/voice/voice-types.js').LiveVoiceSessionRequest) {
    this.createCount += 1;
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
    this.closeCount += 1;
    return Promise.resolve(ok(undefined));
  }
}

function createHarness() {
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
  const queue = new QueueRepository(db);
  const threads = new ThreadRepository(db);
  const messages = new MessageRepository(db);
  const store = new DurableVoiceStore(db, queue);
  const bridge = new DurableVoiceBackendBridge(store, queue, { now: () => 20 });
  const provider = new FakeProvider();
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
    transport: new BrowserVoiceTransport({ now: () => 20 }),
    backendBridge: bridge,
    policy,
    threadRepository: threads,
    messageRepository: messages,
    channelId: 'voice-channel',
    personaId: 'persona-1',
    modelName: 'voice-model',
    instructions: 'voice instructions',
    voiceName: 'marin',
    capturePolicy,
    currentPolicy: () => capturePolicy(),
  });
  return { db, messages, owner, provider, service };
}

describe('voice channel notifications', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('speaks through the existing live session without creating a delegation', async () => {
    const harness = createHarness();
    db = harness.db;
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(created.isOk()).toBe(true);
    const session = created._unsafeUnwrap().session;
    const events: string[] = [];
    harness.service.subscribe(harness.owner, session.id, (event) => {
      events.push(event.kind);
    });

    const notified = await harness.service.notifyThread({
      threadId: session.threadId,
      text: 'The scheduled result is ready.',
    });

    expect(notified._unsafeUnwrap()).toEqual({ sessionId: session.id, speechRequested: true });
    expect(harness.provider.sideband.commands).toEqual([
      expect.objectContaining({
        kind: 'instruction',
        delegationId: null,
        content: 'The scheduled result is ready.',
      }),
    ]);
    expect(events).toContain('notification');
    expect(harness.service.status(harness.owner, session.id)._unsafeUnwrap()?.delegations).toEqual([]);
  });

  it('retains normal outbound messages after hangup and never opens another provider session', async () => {
    const harness = createHarness();
    db = harness.db;
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    const session = created._unsafeUnwrap().session;
    const closed = await harness.service.closeSession(harness.owner, session.id, { reason: 'hangup' });
    expect(closed.isOk()).toBe(true);
    const commandCount = harness.provider.sideband.commands.length;
    const providerCreates = harness.provider.createCount;

    const retained = await harness.service.notifyThread({
      threadId: session.threadId,
      text: 'This is retained for the next authenticated visit.',
    });
    harness.messages.insert({
      id: 'message-1',
      thread_id: session.threadId,
      direction: 'outbound',
      content: JSON.stringify({ body: 'This is retained for the next authenticated visit.' }),
      idempotency_key: 'background:task-1:completed',
      provider_id: null,
      run_id: null,
    });

    expect(retained._unsafeUnwrap()).toEqual({ sessionId: session.id, speechRequested: false });
    expect(harness.provider.sideband.commands).toHaveLength(commandCount);
    expect(harness.provider.createCount).toBe(providerCreates);
    expect(harness.service.status(harness.owner, session.id)._unsafeUnwrap()?.notifications).toEqual([
      expect.objectContaining({ text: 'This is retained for the next authenticated visit.' }),
    ]);
    expect(harness.service.status({ ownerId: 'other-owner', loginRevision: 1 }, session.id)._unsafeUnwrap()).toBeNull();
  });

  it('rejects unbounded notification text', async () => {
    const harness = createHarness();
    db = harness.db;
    const created = await harness.service.createSession(harness.owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    const result = await harness.service.notifyThread({
      threadId: created._unsafeUnwrap().session.threadId,
      text: 'x'.repeat(16_001),
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('bounded delivery limit');
  });
});
