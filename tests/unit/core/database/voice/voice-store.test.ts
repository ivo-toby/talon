import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../../src/core/database/migrations/runner.js';
import { DurableVoiceStore } from '../../../../../src/voice/voice-store.js';
import type {
  VoiceBackendRequest,
  VoiceDelegationRecord,
  VoicePolicySnapshot,
  VoiceSessionRecord,
} from '../../../../../src/voice/voice-types.js';

function migrationsDir(): string {
  return join(import.meta.dirname, '../../../../../src/core/database/migrations');
}

function createDb(path = ':memory:'): Database.Database {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  const result = runMigrations(db, migrationsDir());
  if (result.isErr()) throw new Error(result.error.message);
  db.prepare(
    `INSERT OR IGNORE INTO channels (id, type, name, config, credentials_ref, enabled, created_at, updated_at)
     VALUES ('channel-1', 'terminal', 'voice-test', '{}', NULL, 1, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO threads (id, channel_id, external_id, metadata, created_at, updated_at)
     VALUES ('thread-1', 'channel-1', 'voice-thread', '{}', 1, 1)`,
  ).run();
  return db;
}

const policy: VoicePolicySnapshot = {
  generation: 1,
  ownerId: 'owner-1',
  personaId: 'persona-1',
  providerName: 'live',
  modelName: 'gpt-live-1',
  voiceName: 'marin',
  capabilityNames: ['voice'],
  allowedToolNames: ['status'],
  allowedMcpServerNames: [],
  nativeToolNames: [],
  requireApproval: false,
  loginRevision: 4,
  capturedAt: 100,
};

function makeSession(overrides: Partial<VoiceSessionRecord> = {}): VoiceSessionRecord {
  return {
    id: 'session-1',
    revision: 1,
    owner: { ownerId: 'owner-1', loginRevision: 4 },
    personaId: 'persona-1',
    threadId: 'thread-1',
    transport: 'webrtc',
    status: 'connected',
    providerSessionId: 'provider-session-1',
    createdAt: 100,
    startedAt: 110,
    deadlineAt: 10_000,
    policy,
    usage: {
      voiceCostStatus: 'estimated',
      backendCostStatus: 'unavailable',
    },
    finalization: { status: 'pending' },
    ...overrides,
  };
}

function makeRequest(overrides: Partial<VoiceBackendRequest> = {}): VoiceBackendRequest {
  return {
    sessionId: 'session-1',
    delegationId: 'delegation-1',
    providerDelegationId: 'provider-delegation-1',
    threadId: 'thread-1',
    personaId: 'persona-1',
    context: {
      version: 2,
      digest: 'context-digest-1',
      capturedAt: 200,
      text: 'status of the service',
      fragments: [],
      truncated: false,
    },
    policy,
    requestedAt: 200,
    ...overrides,
  };
}

function makeDelegation(overrides: Partial<VoiceDelegationRecord> = {}): VoiceDelegationRecord {
  const request = makeRequest(overrides.request);
  return {
    id: request.delegationId,
    sessionId: request.sessionId,
    providerDelegationId: request.providerDelegationId,
    revision: 1,
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
    createdAt: 200,
    ...overrides,
  };
}

function admission(delegation = makeDelegation(), queueItemId = 'queue-1') {
  return {
    delegation,
    queue: {
      queueItemId,
      threadId: delegation.request.threadId,
      delegationId: delegation.id,
      request: delegation.request,
      maxAttempts: 1 as const,
    },
  };
}

describe('DurableVoiceStore', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('persists sessions, rejects conflicting identity, and enforces provider session uniqueness', () => {
    db = createDb();
    const store = new DurableVoiceStore(db);
    const session = makeSession();

    expect(store.createSession(session).isOk()).toBe(true);
    expect(store.createSession(session).isOk()).toBe(true);
    expect(store.createSession({ ...session, personaId: 'other-persona' }).isErr()).toBe(true);
    expect(store.createSession({ ...session, id: 'session-2' }).isErr()).toBe(true);

    const projection = store.readSession(session.id);
    expect(projection.isOk()).toBe(true);
    expect(projection._unsafeUnwrap().session.providerSessionId).toBe('provider-session-1');
  });

  it('rolls back a reservation when queue admission conflicts', () => {
    db = createDb();
    const store = new DurableVoiceStore(db);
    store.createSession(makeSession());
    db.prepare(
      `INSERT INTO queue_items
        (id, thread_id, message_id, type, status, attempts, max_attempts, payload, created_at, updated_at)
       VALUES (?, ?, NULL, 'message', 'pending', 0, 3, ?, 1, 1)`,
    ).run('queue-1', 'thread-1', '{}');

    const result = store.admitDelegation(admission());
    expect(result.isErr()).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM voice_delegations').get()).toEqual({ count: 0 });
  });

  it('deduplicates provider events and rejects a reused provider delegation id with new context', () => {
    db = createDb();
    const store = new DurableVoiceStore(db);
    store.createSession(makeSession());
    const first = admission();
    expect(store.admitDelegation(first).isOk()).toBe(true);
    expect(store.admitDelegation(first).isOk()).toBe(true);

    const changed = makeDelegation({
      request: makeRequest({
        context: {
          ...makeRequest().context,
          digest: 'different-digest',
          text: 'different request',
        },
      }),
    });
    expect(store.admitDelegation(admission(changed, 'queue-2')).isErr()).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM voice_delegations').get()).toEqual({ count: 1 });
  });

  it('claims pending work atomically and prevents superseding after the claim', () => {
    db = createDb();
    const store = new DurableVoiceStore(db);
    store.createSession(makeSession());
    const item = admission();
    store.admitDelegation(item);

    const claimed = store.claimDelegation({
      delegationId: 'delegation-1',
      expectedRevision: 2,
      queueItemId: 'queue-1',
      claimedAt: 300,
    });
    expect(claimed.isOk()).toBe(true);
    expect(claimed._unsafeUnwrap().outcome).toBe('claimed');
    const superseded = store.supersedeDelegation({
      originalDelegationId: 'delegation-1',
      expectedRevision: 3,
      replacement: makeDelegation({
        id: 'delegation-2',
        providerDelegationId: 'provider-delegation-2',
        request: makeRequest({ delegationId: 'delegation-2', providerDelegationId: 'provider-delegation-2' }),
      }),
      supersededAt: 400,
    });
    expect(superseded.isOk()).toBe(true);
    expect(superseded._unsafeUnwrap().outcome).toBe('not_replaceable');
    expect(superseded._unsafeUnwrap()).toMatchObject({ reason: 'claimed' });
  });

  it('supersedes queued work with a new id and leaves the original digest unchanged', () => {
    db = createDb();
    const store = new DurableVoiceStore(db);
    store.createSession(makeSession());
    const original = makeDelegation();
    store.admitDelegation(admission(original));
    const before = store.findDelegation(original.id)._unsafeUnwrap()!;
    const replacement = makeDelegation({
      id: 'delegation-2',
      providerDelegationId: 'provider-delegation-2',
      request: makeRequest({ delegationId: 'delegation-2', providerDelegationId: 'provider-delegation-2' }),
      supersedesDelegationId: original.id,
    });

    const result = store.supersedeDelegation({
      originalDelegationId: original.id,
      expectedRevision: 2,
      replacement,
      supersededAt: 500,
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().outcome).toBe('superseded');
    const after = store.findDelegation(original.id)._unsafeUnwrap()!;
    expect(after.contextDigest).toBe(before.contextDigest);
    expect(after.id).toBe(original.id);
    expect(store.findDelegation(replacement.id)._unsafeUnwrap()!.id).toBe(replacement.id);
    expect(store.claimDelegation({
      delegationId: original.id,
      expectedRevision: 3,
      queueItemId: 'queue-1',
      claimedAt: 600,
    })._unsafeUnwrap().outcome).toBe('lost');
  });

  it('keeps execution and delivery lifecycle separate and retains results after reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talon-voice-'));
    const path = join(dir, 'voice.sqlite');
    try {
      db = createDb(path);
      const store = new DurableVoiceStore(db);
      store.createSession(makeSession());
      store.admitDelegation(admission());
      const result = store.recordBackendResult({
        delegationId: 'delegation-1',
        outputId: 'output-1',
        kind: 'final',
        text: 'Service is healthy.',
        execution: 'succeeded',
        output: {
          execution: 'succeeded',
          delivery: 'pending',
          providerAcknowledgement: 'acknowledged',
          playback: 'not_started',
        },
        occurredAt: 700,
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().status).toBe('completed');
      expect(result._unsafeUnwrap().output.delivery).toBe('pending');
      expect(store.recordBackendResult({
        delegationId: 'delegation-1',
        outputId: 'output-1',
        kind: 'final',
        text: 'Service is healthy.',
        execution: 'succeeded',
        output: {
          execution: 'succeeded',
          delivery: 'pending',
          providerAcknowledgement: 'acknowledged',
          playback: 'not_started',
        },
        occurredAt: 701,
      })._unsafeUnwrap().revision).toBe(result._unsafeUnwrap().revision);
      db.close();
      db = createDb(path);
      const reopened = new DurableVoiceStore(db);
      const projection = reopened.readSession('session-1')._unsafeUnwrap()!;
      expect(projection.delegations[0]?.status).toBe('completed');
      expect(projection.outputs[0]?.text).toBe('Service is healthy.');
      reopened.recordOutputLifecycle({
        delegationId: 'delegation-1',
        outputId: 'output-1',
        lifecycle: {
          execution: 'succeeded',
          delivery: 'acknowledged',
          providerAcknowledgement: 'acknowledged',
          playback: 'played',
        },
      });
      expect(reopened.readSession('session-1')._unsafeUnwrap()!.outputs[0]?.lifecycle.playback).toBe('played');
    } finally {
      db?.close();
      db = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
