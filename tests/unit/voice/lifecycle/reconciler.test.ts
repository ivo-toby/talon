import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../../src/core/database/migrations/runner.js';
import { QueueRepository } from '../../../../src/core/database/repositories/queue-repository.js';
import { DurableVoiceBackendBridge } from '../../../../src/voice/voice-backend-bridge.js';
import { reconcileVoiceSessions } from '../../../../src/voice/voice-session-reconciler.js';
import { DurableVoiceStore } from '../../../../src/voice/voice-store.js';
import type {
  VoiceBackendRequest,
  VoicePolicySnapshot,
  VoiceSessionRecord,
} from '../../../../src/voice/voice-types.js';

const policy: VoicePolicySnapshot = {
  generation: 1,
  ownerId: 'owner-1',
  personaId: 'persona-1',
  providerName: 'agent-provider',
  modelName: 'voice-model',
  voiceName: 'marin',
  capabilityNames: [],
  allowedToolNames: [],
  allowedMcpServerNames: [],
  nativeToolNames: [],
  requireApproval: false,
  loginRevision: 1,
  capturedAt: 1,
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
     VALUES ('channel-1', 'voice', 'browser-voice', '{}', 1, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO threads (id, channel_id, external_id, metadata, created_at, updated_at)
     VALUES ('thread-1', 'channel-1', 'voice:session-1', '{}', 1, 1)`,
  ).run();
  return db;
}

function session(
  id: string,
  status: VoiceSessionRecord['status'] = 'connected',
  overrides: Partial<Pick<VoiceSessionRecord, 'usage' | 'finalization'>> = {},
): VoiceSessionRecord {
  return {
    id,
    revision: 0,
    owner: { ownerId: 'owner-1', loginRevision: 1 },
    personaId: 'persona-1',
    threadId: 'thread-1',
    transport: 'webrtc',
    status,
    providerSessionId: `provider-${id}`,
    createdAt: 1,
    startedAt: 2,
    deadlineAt: 10_000,
    policy,
    usage: overrides.usage ?? { voiceCostStatus: 'unavailable', backendCostStatus: 'unavailable' },
    finalization: overrides.finalization ?? { status: 'pending' },
  };
}

function request(sessionId: string, delegationId: string): VoiceBackendRequest {
  return {
    sessionId,
    delegationId,
    providerDelegationId: `provider-delegation-${delegationId}`,
    threadId: 'thread-1',
    personaId: 'persona-1',
    context: {
      version: 1,
      digest: `digest-${delegationId}`,
      capturedAt: 1,
      text: 'status',
      fragments: [],
      truncated: false,
    },
    policy,
    requestedAt: 1,
  };
}

describe('voice startup reconciliation', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('marks started work unknown and skips unclaimed work without replay', async () => {
    db = createDb();
    const queue = new QueueRepository(db);
    const store = new DurableVoiceStore(db, queue);
    const bridge = new DurableVoiceBackendBridge(store, queue, { now: () => 10 });
    expect(store.createSession(session('session-1')).isOk()).toBe(true);
    expect(store.createSession(session('session-2', 'closed')).isOk()).toBe(true);

    const running = await bridge.admit(request('session-1', 'delegation-running'));
    const pending = await bridge.admit(request('session-2', 'delegation-pending'));
    expect(running.isOk()).toBe(true);
    expect(pending.isOk()).toBe(false);
    const receipt = running._unsafeUnwrap();
    const row = queue.findById(receipt.queueItemId)._unsafeUnwrap();
    expect(row).toBeDefined();
    const claimed = bridge.claimQueueItem(row!);
    expect(claimed.isOk()).toBe(true);

    // Closed sessions can contain a pre-existing admission from before close.
    const admittedPending = store.createSession(session('session-3', 'connected'))._unsafeUnwrap();
    const third = await bridge.admit(request(admittedPending.id, 'delegation-pending-2'));
    expect(third.isOk()).toBe(true);
    const closed = store.updateSession({
      sessionId: admittedPending.id,
      expectedRevision: admittedPending.revision,
      patch: { status: 'closed', closedAt: 5 },
      updatedAt: 5,
    });
    expect(closed.isOk()).toBe(true);

    const report = reconcileVoiceSessions(store, { now: () => 10 });
    expect(report.isOk()).toBe(true);
    expect(report._unsafeUnwrap().unknownDelegations).toContain('delegation-running');
    expect(report._unsafeUnwrap().skippedDelegations).toContain('delegation-pending-2');
    expect(store.findDelegation('delegation-running')._unsafeUnwrap()?.execution).toBe('unknown');
    expect(store.findDelegation('delegation-pending-2')._unsafeUnwrap()?.status).toBe('skipped');

    const restarted = store.createSession(session('session-4', 'connected'))._unsafeUnwrap();
    const restartPending = await bridge.admit(request(restarted.id, 'delegation-pending-3'));
    expect(restartPending.isOk()).toBe(true);
    const restartReport = reconcileVoiceSessions(store, { now: () => 10 });
    expect(restartReport.isOk()).toBe(true);
    expect(restartReport._unsafeUnwrap().skippedDelegations).toContain('delegation-pending-3');
    expect(store.findSession('session-4')._unsafeUnwrap()?.status).toBe('expired');
  });

  it('estimates usage on restart and marks the missing provider finalization incomplete', () => {
    db = createDb();
    const queue = new QueueRepository(db);
    const store = new DurableVoiceStore(db, queue);
    expect(
      store.createSession(
        session('session-usage', 'connected', {
          usage: { voiceSeconds: 120, voiceCostStatus: 'unavailable', backendCostStatus: 'unavailable' },
        }),
      ).isOk(),
    ).toBe(true);

    const report = reconcileVoiceSessions(store, { now: () => 10, usdPerMinute: 0.05 });
    expect(report.isOk()).toBe(true);
    const recovered = store.findSession('session-usage')._unsafeUnwrap();
    expect(recovered?.status).toBe('expired');
    expect(recovered?.usage).toMatchObject({
      voiceSeconds: 120,
      voiceCostUsd: 0.1,
      voiceCostStatus: 'incomplete',
    });
    expect(recovered?.finalization).toEqual({
      status: 'incomplete',
      providerReason: 'daemon_restart',
    });
  });

  it('keeps cost unavailable without a rate while recording incomplete finalization', () => {
    db = createDb();
    const queue = new QueueRepository(db);
    const store = new DurableVoiceStore(db, queue);
    expect(
      store.createSession(
        session('session-no-rate', 'closed', {
          usage: { voiceSeconds: 60, voiceCostStatus: 'unavailable', backendCostStatus: 'unavailable' },
        }),
      ).isOk(),
    ).toBe(true);

    const report = reconcileVoiceSessions(store, { now: () => 10 });
    expect(report.isOk()).toBe(true);
    const recovered = store.findSession('session-no-rate')._unsafeUnwrap();
    expect(recovered?.status).toBe('closed');
    expect(recovered?.usage).toMatchObject({
      voiceSeconds: 60,
      voiceCostStatus: 'unavailable',
    });
    expect(recovered?.usage.voiceCostUsd).toBeUndefined();
    expect(recovered?.finalization).toEqual({ status: 'incomplete' });
  });

  it('preserves retained cost when the operator changes the rate', () => {
    db = createDb();
    const queue = new QueueRepository(db);
    const store = new DurableVoiceStore(db, queue);
    const backendUsage = {
      backendCostUsd: 1.25,
      backendCostStatus: 'estimated' as const,
    };
    expect(
      store.createSession(
        session('changed-finalized', 'closed', {
          usage: {
            voiceSeconds: 120,
            voiceCostUsd: 0.12,
            voiceCostStatus: 'estimated',
            ...backendUsage,
          },
          finalization: { status: 'confirmed', confirmedAt: 20 },
        }),
      ).isOk(),
    ).toBe(true);
    expect(
      store.createSession(
        session('changed-interrupted', 'connected', {
          usage: {
            voiceSeconds: 60,
            voiceCostUsd: 0.06,
            voiceCostStatus: 'estimated',
            ...backendUsage,
          },
        }),
      ).isOk(),
    ).toBe(true);

    const report = reconcileVoiceSessions(store, { now: () => 10, usdPerMinute: 0.6 });
    expect(report.isOk()).toBe(true);
    const finalized = store.findSession('changed-finalized')._unsafeUnwrap();
    expect(finalized?.usage).toMatchObject({
      voiceSeconds: 120,
      voiceCostUsd: 0.12,
      voiceCostStatus: 'estimated',
      ...backendUsage,
    });
    expect(finalized?.finalization.status).toBe('confirmed');
    const interrupted = store.findSession('changed-interrupted')._unsafeUnwrap();
    expect(interrupted?.status).toBe('expired');
    expect(interrupted?.usage).toMatchObject({
      voiceSeconds: 60,
      voiceCostUsd: 0.06,
      voiceCostStatus: 'incomplete',
      ...backendUsage,
    });
  });

  it('preserves retained cost when the current rate is unset', () => {
    db = createDb();
    const queue = new QueueRepository(db);
    const store = new DurableVoiceStore(db, queue);
    const backendUsage = {
      backendCostUsd: 1.25,
      backendCostStatus: 'estimated' as const,
    };
    expect(
      store.createSession(
        session('unset-finalized', 'closed', {
          usage: {
            voiceSeconds: 120,
            voiceCostUsd: 0.12,
            voiceCostStatus: 'estimated',
            ...backendUsage,
          },
          finalization: { status: 'confirmed', confirmedAt: 20 },
        }),
      ).isOk(),
    ).toBe(true);
    expect(
      store.createSession(
        session('unset-interrupted', 'connected', {
          usage: {
            voiceSeconds: 60,
            voiceCostUsd: 0.06,
            voiceCostStatus: 'estimated',
            ...backendUsage,
          },
        }),
      ).isOk(),
    ).toBe(true);

    const report = reconcileVoiceSessions(store, { now: () => 10 });
    expect(report.isOk()).toBe(true);
    const finalized = store.findSession('unset-finalized')._unsafeUnwrap();
    expect(finalized?.usage).toMatchObject({
      voiceSeconds: 120,
      voiceCostUsd: 0.12,
      voiceCostStatus: 'estimated',
      ...backendUsage,
    });
    expect(finalized?.finalization.status).toBe('confirmed');
    const interrupted = store.findSession('unset-interrupted')._unsafeUnwrap();
    expect(interrupted?.status).toBe('expired');
    expect(interrupted?.usage).toMatchObject({
      voiceSeconds: 60,
      voiceCostUsd: 0.06,
      voiceCostStatus: 'incomplete',
      ...backendUsage,
    });
  });
});
