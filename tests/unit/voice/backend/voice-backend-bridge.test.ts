import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { ok } from 'neverthrow';

import { runMigrations } from '../../../../src/core/database/migrations/runner.js';
import { QueueRepository } from '../../../../src/core/database/repositories/queue-repository.js';
import { DurableVoiceBackendBridge } from '../../../../src/voice/voice-backend-bridge.js';
import { DurableVoiceStore } from '../../../../src/voice/voice-store.js';
import { VoiceOutputSink } from '../../../../src/voice/voice-output-sink.js';
import type {
  VoiceBackendRequest,
  VoiceBackendResult,
  VoicePolicySnapshot,
  VoiceSessionRecord,
} from '../../../../src/voice/voice-types.js';

const policy: VoicePolicySnapshot = {
  generation: 3,
  ownerId: 'owner-1',
  personaId: 'persona-1',
  providerName: 'claude-code',
  modelName: 'claude-sonnet',
  voiceName: 'marin',
  capabilityNames: ['memory.access'],
  allowedToolNames: ['memory_access'],
  allowedMcpServerNames: [],
  nativeToolNames: [],
  requireApproval: false,
  loginRevision: 7,
  capturedAt: 100,
};

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
     VALUES ('channel-1', 'terminal', 'voice', '{}', 1, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO threads (id, channel_id, external_id, metadata, created_at, updated_at)
     VALUES ('thread-1', 'channel-1', 'voice-thread', '{}', 1, 1)`,
  ).run();
  return db;
}

function session(): VoiceSessionRecord {
  return {
    id: 'session-1',
    revision: 1,
    owner: { ownerId: 'owner-1', loginRevision: 7 },
    personaId: 'persona-1',
    threadId: 'thread-1',
    transport: 'webrtc',
    status: 'connected',
    providerSessionId: 'provider-session-1',
    createdAt: 100,
    startedAt: 110,
    deadlineAt: 10_000,
    policy,
    usage: { voiceCostStatus: 'estimated', backendCostStatus: 'unavailable' },
    finalization: { status: 'pending' },
  };
}

function request(
  id = 'delegation-1',
  providerId = `provider-${id}`,
  requestPolicy: VoicePolicySnapshot = policy,
): VoiceBackendRequest {
  return {
    sessionId: 'session-1',
    delegationId: id,
    providerDelegationId: providerId,
    threadId: 'thread-1',
    personaId: 'persona-1',
    context: {
      version: 1,
      digest: `digest-${id}`,
      capturedAt: 200,
      text: 'Read the current status.',
      fragments: [],
      truncated: false,
    },
    policy: requestPolicy,
    requestedAt: 200,
  };
}

function makeSetup(sessionPolicy: VoicePolicySnapshot = policy): {
  db: Database.Database;
  queue: QueueRepository;
  store: DurableVoiceStore;
  bridge: DurableVoiceBackendBridge;
} {
  const db = createDb();
  const queue = new QueueRepository(db);
  const store = new DurableVoiceStore(db, queue);
  const created = store.createSession({ ...session(), policy: sessionPolicy });
  if (created.isErr()) throw new Error(created.error.message);
  const bridge = new DurableVoiceBackendBridge(store, queue, { now: () => 300 });
  return { db, queue, store, bridge };
}

describe('DurableVoiceBackendBridge', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('atomically admits a voice delegation and preserves its provider identity', async () => {
    const setup = makeSetup();
    db = setup.db;

    const admitted = await setup.bridge.admit(request());

    expect(admitted.isOk()).toBe(true);
    const receipt = admitted._unsafeUnwrap();
    const queueRow = setup.queue.findById(receipt.queueItemId)._unsafeUnwrap();
    expect(queueRow?.type).toBe('collaboration');
    expect(queueRow?.max_attempts).toBe(1);
    expect(JSON.parse(queueRow?.payload ?? '{}')).toMatchObject({
      kind: 'voice_backend',
      delegationId: 'delegation-1',
      request: { providerDelegationId: 'provider-delegation-1' },
    });

    const projection = setup.store.readSession('session-1')._unsafeUnwrap();
    expect(projection?.delegations[0]).toMatchObject({
      id: 'delegation-1',
      providerDelegationId: 'provider-delegation-1',
      status: 'queued',
      queueItemId: receipt.queueItemId,
    });
  });

  it('returns the original admission for an identical duplicate event', async () => {
    const setup = makeSetup();
    db = setup.db;

    const first = await setup.bridge.admit(request());
    const duplicate = await setup.bridge.admit(request());

    expect(first.isOk()).toBe(true);
    expect(duplicate.isOk()).toBe(true);
    expect(duplicate._unsafeUnwrap()).toEqual(first._unsafeUnwrap());
    expect(setup.queue.findPending()._unsafeUnwrap()).toHaveLength(1);
  });

  it('rejects a request policy that differs from the session policy', async () => {
    const setup = makeSetup();
    db = setup.db;
    const changed = request();
    const changedRequest: VoiceBackendRequest = {
      ...changed,
      policy: { ...changed.policy, modelName: 'different-model' },
    };

    const admitted = await setup.bridge.admit(changedRequest);

    expect(admitted.isErr()).toBe(true);
    expect(setup.queue.findPending()._unsafeUnwrap()).toHaveLength(0);
  });

  it('loses the claim race without allowing generic queue execution', async () => {
    const setup = makeSetup();
    db = setup.db;
    const admitted = (await setup.bridge.admit(request()))._unsafeUnwrap();
    const queueRow = setup.queue.findById(admitted.queueItemId)._unsafeUnwrap();
    expect(queueRow).not.toBeNull();

    // A lifecycle transition or another worker may win before VoiceStore CAS.
    setup.queue.claimNext('thread-1');
    const claim = setup.bridge.claimQueueItem(queueRow!);

    expect(claim.isOk()).toBe(true);
    expect(claim._unsafeUnwrap()).toBeNull();
    expect(setup.store.findDelegation('delegation-1')._unsafeUnwrap()?.status).toBe('queued');
  });

  it('fails closed when native posture or owner revision changes', async () => {
    const callback = vi.fn(() => ok(undefined));
    const setup = makeSetup();
    db = setup.db;
    const bridge = new DurableVoiceBackendBridge(setup.store, setup.queue, {
      executionGate: callback,
    });
    const admitted = (await bridge.admit(request()))._unsafeUnwrap();
    const req = request();

    const rejected = await bridge.beforeProvider({
      request: req,
      owner: { ownerId: req.policy.ownerId, loginRevision: req.policy.loginRevision + 1 },
      providerName: req.policy.providerName,
      providerType: 'claude-code',
      modelName: req.policy.modelName,
      capabilityNames: req.policy.capabilityNames,
      allowedToolNames: req.policy.allowedToolNames,
      allowedMcpServerNames: req.policy.allowedMcpServerNames,
      nativeToolNames: ['shell'],
      nativeToolsDisabled: false,
      requireApproval: false,
    });

    expect(rejected.isErr()).toBe(true);
    expect(callback).not.toHaveBeenCalled();
    expect(admitted.delegationId).toBe('delegation-1');
  });

  it('rejects a changed native tool snapshot even when the disable flag is set', async () => {
    const callback = vi.fn(() => ok(undefined));
    const setup = makeSetup();
    db = setup.db;
    const bridge = new DurableVoiceBackendBridge(setup.store, setup.queue, {
      executionGate: callback,
    });
    const req = request();

    const rejected = await bridge.beforeProvider({
      request: req,
      owner: { ownerId: req.policy.ownerId, loginRevision: req.policy.loginRevision },
      providerName: req.policy.providerName,
      providerType: 'claude-code',
      modelName: req.policy.modelName,
      capabilityNames: req.policy.capabilityNames,
      allowedToolNames: req.policy.allowedToolNames,
      allowedMcpServerNames: req.policy.allowedMcpServerNames,
      nativeToolNames: ['WebSearch', 'WebFetch'],
      nativeToolsDisabled: true,
      requireApproval: false,
    });

    expect(rejected.isErr()).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it('accepts configured provider native tools when the admitted snapshot matches', async () => {
    const callback = vi.fn(() => ok(undefined));
    const nativePolicy: VoicePolicySnapshot = {
      ...policy,
      nativeToolNames: ['WebFetch', 'WebSearch'],
    };
    const setup = makeSetup(nativePolicy);
    db = setup.db;
    const bridge = new DurableVoiceBackendBridge(setup.store, setup.queue, {
      executionGate: callback,
    });
    const req = request('native-tools', 'provider-native-tools', nativePolicy);
    const admitted = await bridge.admit(req);
    expect(admitted.isOk()).toBe(true);

    const accepted = await bridge.beforeProvider({
      request: req,
      owner: { ownerId: req.policy.ownerId, loginRevision: req.policy.loginRevision },
      providerName: req.policy.providerName,
      providerType: 'claude-code',
      modelName: req.policy.modelName,
      capabilityNames: req.policy.capabilityNames,
      allowedToolNames: req.policy.allowedToolNames,
      allowedMcpServerNames: req.policy.allowedMcpServerNames,
      nativeToolNames: ['WebSearch', 'WebFetch'],
      nativeToolsDisabled: false,
      requireApproval: false,
    });

    expect(accepted.isOk()).toBe(true);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('persists output before publishing and keeps delivery separate', async () => {
    const setup = makeSetup();
    db = setup.db;
    const events: string[] = [];
    const bridge = new DurableVoiceBackendBridge(setup.store, setup.queue, {
      now: () => 300,
    });
    const sink = new VoiceOutputSink(
      setup.store,
      (result) => {
        events.push(result.kind);
        bridge.notifyResult(result);
      },
      { now: () => 301 },
    );
    await bridge.admit(request());
    const started = sink.executionStarted('delegation-1');
    const finished = sink.final('delegation-1', 'The service is healthy.');
    const progress = setup.store
      .readSession('session-1')
      ._unsafeUnwrap()!
      .outputs.find((output) => output.kind === 'progress');
    expect(progress).toBeDefined();
    const deliveryUpdate = setup.store.recordOutputLifecycle({
      delegationId: 'delegation-1',
      outputId: progress!.id,
      lifecycle: { ...progress!.lifecycle, delivery: 'acknowledged' },
    });
    const late = sink.unknown('delegation-1', 'LATE_UNKNOWN');

    expect(started.isOk()).toBe(true);
    expect(finished.isOk()).toBe(true);
    expect(deliveryUpdate.isOk()).toBe(true);
    expect(late.isOk()).toBe(true);
    expect(late._unsafeUnwrap()).toMatchObject({ kind: 'final', text: 'The service is healthy.' });
    expect(events).toEqual(['progress', 'final', 'final']);
    expect(bridge.result('delegation-1')._unsafeUnwrap()).toMatchObject({
      kind: 'final',
      text: 'The service is healthy.',
      execution: 'succeeded',
    });
  });

  it('keeps the newest running output authoritative after a late delivery update', async () => {
    const setup = makeSetup();
    db = setup.db;
    const published: Array<string | undefined> = [];
    const sink = new VoiceOutputSink(
      setup.store,
      (result) => {
        published.push(result.text);
      },
      { now: () => 301 },
    );
    await setup.bridge.admit(request());

    const started = sink.executionStarted('delegation-1');
    const firstProgress = sink.progress('delegation-1', 'Checking status.');
    const secondProgress = sink.progress('delegation-1', 'Still checking.');
    const outputs = setup.store
      .readSession('session-1')
      ._unsafeUnwrap()!
      .outputs.filter((output) => output.delegationId === 'delegation-1');
    const retainedFirstProgress = outputs.find((output) => output.text === 'Checking status.');

    expect(started.isOk()).toBe(true);
    expect(firstProgress.isOk()).toBe(true);
    expect(secondProgress.isOk()).toBe(true);
    expect(outputs.map((output) => output.createdAt)).toEqual([301, 301, 301]);
    expect(retainedFirstProgress).toBeDefined();

    const deliveryUpdate = setup.store.recordOutputLifecycle({
      delegationId: 'delegation-1',
      outputId: retainedFirstProgress!.id,
      lifecycle: { ...retainedFirstProgress!.lifecycle, delivery: 'acknowledged' },
    });
    const duplicate = sink.record(secondProgress._unsafeUnwrap());

    expect(deliveryUpdate.isOk()).toBe(true);
    expect(duplicate.isOk()).toBe(true);
    expect(duplicate._unsafeUnwrap()).toMatchObject({
      kind: 'progress',
      text: 'Still checking.',
      execution: 'running',
    });
    expect(published).toEqual([
      undefined,
      'Checking status.',
      'Still checking.',
      'Still checking.',
    ]);
  });

  it('publishes the accepted final result when a later bridge write is stale', async () => {
    const setup = makeSetup();
    db = setup.db;
    await setup.bridge.admit(request());
    const events: VoiceBackendResult['kind'][] = [];
    setup.bridge.onResult('delegation-1', (result) => {
      events.push(result.kind);
    });

    const lifecycle = {
      execution: 'succeeded' as const,
      delivery: 'pending' as const,
      providerAcknowledgement: 'not_sent' as const,
      playback: 'not_started' as const,
    };
    const final = setup.bridge.publish({
      delegationId: 'delegation-1',
      outputId: 'output-final',
      kind: 'final',
      text: 'done',
      execution: 'succeeded',
      output: lifecycle,
      occurredAt: 301,
    });
    const late = setup.bridge.publish({
      delegationId: 'delegation-1',
      outputId: 'output-unknown',
      kind: 'unknown',
      execution: 'unknown',
      output: {
        execution: 'unknown',
        delivery: 'unknown',
        providerAcknowledgement: 'unknown',
        playback: 'unknown',
      },
      errorCode: 'LATE_UNKNOWN',
      occurredAt: 302,
    });

    expect(final.isOk()).toBe(true);
    expect(late.isOk()).toBe(true);
    expect(late._unsafeUnwrap()).toMatchObject({
      outputId: 'output-final',
      kind: 'final',
      text: 'done',
      execution: 'succeeded',
    });
    expect(events).toEqual(['final', 'final']);
  });

  it('bounds retained output before persistence and publication', async () => {
    const setup = makeSetup();
    db = setup.db;
    const published: string[] = [];
    const sink = new VoiceOutputSink(
      setup.store,
      (result) => {
        published.push(result.text ?? '');
      },
      { maxOutputChars: 8 },
    );
    await setup.bridge.admit(request());

    const result = sink.final('delegation-1', '1234567890');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().text).toBe('12345678');
    expect(published).toEqual(['12345678']);
    expect(setup.bridge.result('delegation-1')._unsafeUnwrap()?.text).toBe('12345678');
  });
});
