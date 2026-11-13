import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../../../../src/core/database/connection.js';
import { runMigrations } from '../../../../../src/core/database/migrations/runner.js';
import {
  MAX_SIP_CALL_METADATA_BYTES,
  SIP_SAFE_RETENTION_MS,
  VoiceSipRepository,
  type SipReservationInput,
} from '../../../../../src/core/database/repositories/voice-sip-repository.js';
import {
  hashVoiceAuthToken,
  VoiceAuthRepository,
} from '../../../../../src/core/database/repositories/voice-auth-repository.js';
import type { SipVerifiedAuthorization } from '../../../../../src/voice/transports/sip/sip-authorization.js';

const migrationsDir = join(import.meta.dirname, '../../../../../src/core/database/migrations');
const require = createRequire(import.meta.url);

function authorization(id: string, nonce = `nonce-${id}-012345`): SipVerifiedAuthorization {
  return {
    version: 1,
    algorithm: 'Ed25519',
    issuer: 'operator-issuer',
    keyId: 'primary',
    audience: 'talon-incoming',
    subject: 'endpoint-1',
    nonce,
    callBinding: `binding-${id}`,
    issuedAt: 1_000,
    expiresAt: 1_060,
    proofHash: id.padEnd(64, '0').slice(0, 64),
    principal: { ownerId: 'owner-1', personaId: 'persona-1' },
  };
}

function input(
  id: string,
  overrides: Partial<SipReservationInput> = {},
): SipReservationInput {
  return {
    callId: `call-${id}`,
    providerSessionId: `session-${id}`,
    deliveryId: `delivery-${id}`,
    eventCreatedAt: 1_000,
    deliveryTimestamp: 1_000,
    now: 1_000,
    authorization: authorization(id),
    ...overrides,
  };
}

function fileDatabase(directory: string): Database.Database {
  const result = createDatabase(join(directory, 'voice-sip.sqlite'));
  if (result.isErr()) throw result.error;
  const migrated = runMigrations(result.value, migrationsDir);
  if (migrated.isErr()) throw migrated.error;
  return result.value;
}

describe('VoiceSipRepository', () => {
  let databases: Database.Database[] = [];
  let directories: string[] = [];

  afterEach(() => {
    for (const db of databases) {
      if (db.open) db.close();
    }
    databases = [];
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    directories = [];
  });

  it('atomically reserves the grant, decision, and receipt and survives reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'talon-sip-repository-'));
    directories.push(directory);
    const db = fileDatabase(directory);
    databases.push(db);
    const repository = new VoiceSipRepository(db);
    const reserved = repository.reserve(input('one'));
    expect(reserved.isOk()).toBe(true);
    expect(repository.counts()._unsafeUnwrap()).toEqual({ decisions: 1, receipts: 1, grants: 1 });

    const duplicateDelivery = repository.reserve(
      input('different-call', {
        deliveryId: 'delivery-one',
        providerSessionId: 'session-different',
      }),
    );
    expect(duplicateDelivery._unsafeUnwrap().outcome).toBe('duplicate_delivery');
    const duplicateSession = repository.reserve(
      input('different-delivery', {
        deliveryId: 'delivery-two',
        providerSessionId: 'session-one',
      }),
    );
    expect(duplicateSession._unsafeUnwrap().outcome).toBe('duplicate_session');

    db.close();
    const reopened = fileDatabase(directory);
    databases.push(reopened);
    const reopenedRepository = new VoiceSipRepository(reopened);
    const persisted = reopenedRepository.findByCallId('call-one')._unsafeUnwrap();
    expect(persisted?.decision.state).toBe('reserved');
    expect(persisted?.grant.proof_hash).toHaveLength(64);
    expect(reopenedRepository.counts()._unsafeUnwrap()).toEqual({ decisions: 1, receipts: 1, grants: 1 });
  });

  it('writes the attempt marker before outcome and never retries an unknown attempt', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const migrated = runMigrations(db, migrationsDir);
    expect(migrated.isOk()).toBe(true);
    databases.push(db);
    const repository = new VoiceSipRepository(db);
    repository.reserve(input('attempt'));
    const started = repository.markAttempt('call-attempt', 1_001)._unsafeUnwrap();
    expect(started?.started).toBe(true);
    expect(started?.reservation.attemptMarker).toBeTruthy();
    const unknown = repository.recordOutcome('call-attempt', 'unknown', 1_002)._unsafeUnwrap();
    expect(unknown?.decision.state).toBe('unknown');
    expect(repository.markAttempt('call-attempt', 1_003)._unsafeUnwrap()?.started).toBe(false);
    expect(repository.recordOutcome('call-attempt', 'accepted', 1_004)._unsafeUnwrap()?.decision.state).toBe('unknown');
  });

  it('checks retained authority before attempting and permits an accepted call to close after expiry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'talon-sip-authority-'));
    directories.push(directory);
    const db = fileDatabase(directory);
    databases.push(db);
    const repository = new VoiceSipRepository(db);

    repository.reserve(input('expired'));
    const expired = repository.markAttempt('call-expired', 2_000_000)._unsafeUnwrap();
    expect(expired?.started).toBe(false);
    expect(expired?.reason).toBe('authority_expired');
    expect(expired?.reservation.decision.state).toBe('reserved');

    repository.reserve(input('revoked'));
    expect(repository.revokeGrant('call-revoked', 1_001)._unsafeUnwrap()).toBe(true);
    const revoked = repository.markAttempt('call-revoked', 1_002)._unsafeUnwrap();
    expect(revoked?.started).toBe(false);
    expect(revoked?.reason).toBe('authority_revoked');
    expect(revoked?.reservation.decision.state).toBe('reserved');

    repository.reserve(input('accepted-long'));
    expect(repository.markAttempt('call-accepted-long', 1_001)._unsafeUnwrap()?.started).toBe(true);
    expect(repository.recordOutcome('call-accepted-long', 'accepted', 1_002)._unsafeUnwrap()?.decision.state).toBe('accepted');
    expect(repository.recordOutcome('call-accepted-long', 'closed', 2_000_000)._unsafeUnwrap()?.decision.state).toBe('closed');
  });

  it('rolls back receipt and attempt failures, including the shared revision allocation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'talon-sip-rollback-'));
    directories.push(directory);
    const db = fileDatabase(directory);
    databases.push(db);
    const repository = new VoiceSipRepository(db);
    db.exec(`
      CREATE TRIGGER fail_sip_receipt_insert
      BEFORE INSERT ON voice_sip_delivery_receipts
      BEGIN
        SELECT RAISE(ABORT, 'forced receipt failure');
      END;
    `);
    db.exec('BEGIN');
    const failedReserve = repository.reserve(input('receipt-failure'));
    expect(failedReserve.isErr()).toBe(true);
    expect(repository.counts()._unsafeUnwrap()).toEqual({ decisions: 0, receipts: 0, grants: 0 });
    expect(db.prepare('SELECT next_revision FROM voice_auth_revision_allocator WHERE id = 1').get()).toEqual({
      next_revision: 1,
    });
    db.exec('COMMIT');
    db.exec('DROP TRIGGER fail_sip_receipt_insert');

    expect(repository.reserve(input('after-rollback'))._unsafeUnwrap().outcome).toBe('reserved');
    expect(repository.findByCallId('call-after-rollback')._unsafeUnwrap()?.grant.revision).toBe(1);

    db.exec(`
      CREATE TRIGGER fail_sip_receipt_update
      BEFORE UPDATE OF state ON voice_sip_delivery_receipts
      WHEN NEW.state = 'attempted'
      BEGIN
        SELECT RAISE(ABORT, 'forced receipt update failure');
      END;
    `);
    const failedAttempt = repository.markAttempt('call-after-rollback', 1_001);
    expect(failedAttempt.isErr()).toBe(true);
    expect(repository.findByCallId('call-after-rollback')._unsafeUnwrap()).toMatchObject({
      decision: { state: 'reserved', attempt_marker: null },
      receipt: { state: 'reserved' },
    });
    db.exec('DROP TRIGGER fail_sip_receipt_update');
  });

  it('reopens an interrupted attempt and preserves its unknown tombstone', () => {
    const directory = mkdtempSync(join(tmpdir(), 'talon-sip-reopen-'));
    directories.push(directory);
    const db = fileDatabase(directory);
    databases.push(db);
    const repository = new VoiceSipRepository(db);
    repository.reserve(input('reopen-unknown'));
    expect(repository.markAttempt('call-reopen-unknown', 1_001)._unsafeUnwrap()?.started).toBe(true);
    db.close();
    const reopened = fileDatabase(directory);
    databases.push(reopened);
    const reopenedRepository = new VoiceSipRepository(reopened);
    expect(reopenedRepository.reconcileInterruptedAttempts(2_000)._unsafeUnwrap()).toBe(1);
    expect(reopenedRepository.findByCallId('call-reopen-unknown')._unsafeUnwrap()?.decision.state).toBe('unknown');
    expect(reopenedRepository.markAttempt('call-reopen-unknown', 2_001)._unsafeUnwrap()?.started).toBe(false);
    expect(reopenedRepository.counts()._unsafeUnwrap()).toEqual({ decisions: 1, receipts: 1, grants: 1 });
  });

  it('rejects variable-budget overflow and nonce reuse without partial rows', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrationsDir);
    databases.push(db);
    const repository = new VoiceSipRepository(db);
    const oversized = repository.reserve(
      input('oversized', { callMetadata: { value: 'x'.repeat(MAX_SIP_CALL_METADATA_BYTES) } }),
    );
    expect(oversized._unsafeUnwrap()).toMatchObject({ outcome: 'denied', reason: 'metadata_limit' });
    expect(repository.counts()._unsafeUnwrap()).toEqual({ decisions: 0, receipts: 0, grants: 0 });

    expect(repository.reserve(input('first')).isOk()).toBe(true);
    const reused = repository.reserve(
      input('second', { authorization: authorization('second', authorization('first').nonce) }),
    );
    expect(reused._unsafeUnwrap()).toMatchObject({ outcome: 'denied', reason: 'authority_reuse' });
    expect(repository.counts()._unsafeUnwrap()).toEqual({ decisions: 1, receipts: 1, grants: 1 });
  });

  it('allocates a revision above browser auth without collision', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrationsDir);
    databases.push(db);
    const sip = new VoiceSipRepository(db);
    expect(sip.reserve(input('revision-one')).isOk()).toBe(true);
    const auth = new VoiceAuthRepository(db);
    auth.bindCredential('owner-1', 'secret', 1_000);
    const session = auth.createSession({
      id: 'browser-session',
      sessionTokenHash: hashVoiceAuthToken('cookie'),
      csrfTokenHash: hashVoiceAuthToken('csrf'),
      ownerId: 'owner-1',
      createdAt: 1_000,
      expiresAt: 2_000,
    })._unsafeUnwrap();
    expect(session.login_revision).toBe(2);
  });

  it('retains accepted calls until explicit close and prunes mixed file-backed families after reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'talon-sip-prune-'));
    directories.push(directory);
    const db = fileDatabase(directory);
    databases.push(db);
    const old = Date.now() - SIP_SAFE_RETENTION_MS - 1_000;
    const oldSeconds = Math.floor(old / 1_000);
    const oldAuthorization = (id: string): SipVerifiedAuthorization => ({
      ...authorization(id),
      issuedAt: oldSeconds - 60,
      expiresAt: oldSeconds + 60,
    });
    const repository = new VoiceSipRepository(db);
    repository.reserve(input('safe-rejected', {
      now: old,
      eventCreatedAt: oldSeconds,
      deliveryTimestamp: oldSeconds,
      authorization: oldAuthorization('safe-rejected'),
    }));
    repository.markAttempt('call-safe-rejected', old);
    repository.recordOutcome('call-safe-rejected', 'rejected', old);
    repository.reserve(input('safe-closed', {
      now: old,
      eventCreatedAt: oldSeconds,
      deliveryTimestamp: oldSeconds,
      authorization: oldAuthorization('safe-closed'),
    }));
    repository.markAttempt('call-safe-closed', old);
    repository.recordOutcome('call-safe-closed', 'accepted', old);
    repository.recordOutcome('call-safe-closed', 'closed', old + 1);
    repository.reserve(input('accepted', {
      now: old,
      eventCreatedAt: oldSeconds,
      deliveryTimestamp: oldSeconds,
      authorization: oldAuthorization('accepted'),
    }));
    repository.markAttempt('call-accepted', old);
    repository.recordOutcome('call-accepted', 'accepted', old);
    repository.reserve(input('unknown', {
      now: old,
      eventCreatedAt: oldSeconds,
      deliveryTimestamp: oldSeconds,
      authorization: oldAuthorization('unknown'),
    }));
    repository.markAttempt('call-unknown', old);
    repository.recordOutcome('call-unknown', 'unknown', old);
    repository.reserve(input('pending', {
      now: old,
      eventCreatedAt: oldSeconds,
      deliveryTimestamp: oldSeconds,
      authorization: oldAuthorization('pending'),
    }));
    db.prepare('UPDATE voice_sip_authority_grants SET expires_at = ?').run(oldSeconds - 1);

    db.close();
    const reopened = fileDatabase(directory);
    databases.push(reopened);
    const reopenedRepository = new VoiceSipRepository(reopened);
    const pruneAt = old + SIP_SAFE_RETENTION_MS + 1;
    expect(reopenedRepository.findByCallId('call-accepted')._unsafeUnwrap()?.decision.state).toBe('accepted');
    expect(reopenedRepository.findByCallId('call-accepted')._unsafeUnwrap()?.decision.terminal_at).toBeNull();
    const pruned = reopenedRepository.pruneSafe(pruneAt);
    expect(pruned._unsafeUnwrap()).toBe(6);
    expect(reopenedRepository.findByCallId('call-safe-rejected')._unsafeUnwrap()).toBeNull();
    expect(reopenedRepository.findByCallId('call-safe-closed')._unsafeUnwrap()).toBeNull();
    expect(reopenedRepository.findByCallId('call-accepted')._unsafeUnwrap()?.decision.state).toBe('accepted');
    expect(reopenedRepository.findByCallId('call-unknown')._unsafeUnwrap()?.decision.state).toBe('unknown');
    expect(reopenedRepository.findByCallId('call-pending')._unsafeUnwrap()?.decision.state).toBe('reserved');
    expect(reopenedRepository.counts()._unsafeUnwrap()).toEqual({ decisions: 3, receipts: 3, grants: 3 });

    expect(reopenedRepository.recordOutcome('call-accepted', 'closed', pruneAt)._unsafeUnwrap()?.decision.state).toBe('closed');
    const closedPruned = reopenedRepository.pruneSafe(pruneAt + SIP_SAFE_RETENTION_MS + 1);
    expect(closedPruned._unsafeUnwrap()).toBe(3);
    expect(reopenedRepository.findByCallId('call-accepted')._unsafeUnwrap()).toBeNull();
    expect(reopenedRepository.findByCallId('call-unknown')._unsafeUnwrap()?.decision.state).toBe('unknown');
    expect(reopenedRepository.findByCallId('call-pending')._unsafeUnwrap()?.decision.state).toBe('reserved');
  });

  it('uses Unix seconds for event age and grant expiry cleanup gates', () => {
    const directory = mkdtempSync(join(tmpdir(), 'talon-sip-prune-units-'));
    directories.push(directory);
    const pruneAtMs = Date.now();
    const oldMs = pruneAtMs - SIP_SAFE_RETENTION_MS - 1_000;
    const oldSeconds = Math.floor(oldMs / 1_000);
    const cutoffEventSeconds = Math.floor((pruneAtMs - SIP_SAFE_RETENTION_MS) / 1_000);
    const pruneAtSeconds = Math.floor(pruneAtMs / 1_000);
    const db = fileDatabase(directory);
    databases.push(db);
    const repository = new VoiceSipRepository(db);
    const reserveRejected = (id: string, eventCreatedAt: number, grantExpiresAt: number): void => {
      repository.reserve(
        input(id, {
          now: oldMs,
          eventCreatedAt,
          deliveryTimestamp: oldSeconds,
          authorization: {
            ...authorization(id),
            issuedAt: oldSeconds - 60,
            expiresAt: oldSeconds + 60,
          },
        }),
      );
      expect(repository.markAttempt(`call-${id}`, oldMs)._unsafeUnwrap()?.started).toBe(true);
      repository.recordOutcome(`call-${id}`, 'rejected', oldMs);
      db.prepare('UPDATE voice_sip_authority_grants SET expires_at = ? WHERE call_id = ?').run(
        grantExpiresAt,
        `call-${id}`,
      );
    };

    reserveRejected('old-safe', oldSeconds, oldSeconds - 1);
    reserveRejected('future-event', cutoffEventSeconds + 30, oldSeconds - 1);
    reserveRejected('future-grant', oldSeconds, pruneAtSeconds + 30);

    db.close();
    const reopened = fileDatabase(directory);
    databases.push(reopened);
    const reopenedRepository = new VoiceSipRepository(reopened);
    expect(reopenedRepository.pruneSafe(pruneAtMs)._unsafeUnwrap()).toBe(3);
    expect(reopenedRepository.findByCallId('call-old-safe')._unsafeUnwrap()).toBeNull();
    expect(reopenedRepository.findByCallId('call-future-event')._unsafeUnwrap()).not.toBeNull();
    expect(reopenedRepository.findByCallId('call-future-grant')._unsafeUnwrap()).not.toBeNull();
    expect(reopenedRepository.counts()._unsafeUnwrap()).toEqual({ decisions: 2, receipts: 2, grants: 2 });

    const later = pruneAtMs + 31_000;
    expect(reopenedRepository.pruneSafe(later)._unsafeUnwrap()).toBe(6);
    expect(reopenedRepository.counts()._unsafeUnwrap()).toEqual({ decisions: 0, receipts: 0, grants: 0 });
  });

  it('bounds mixed safe cleanup to 100 rows after reopening the file database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'talon-sip-prune-cap-'));
    directories.push(directory);
    const db = fileDatabase(directory);
    databases.push(db);
    const old = Date.now() - SIP_SAFE_RETENTION_MS - 1_000;
    const oldSeconds = Math.floor(old / 1_000);
    const oldAuthorization = (id: string): SipVerifiedAuthorization => ({
      ...authorization(id),
      issuedAt: oldSeconds - 60,
      expiresAt: oldSeconds + 60,
    });
    const repository = new VoiceSipRepository(db);
    for (let index = 0; index < 34; index += 1) {
      const id = `safe-${index}`;
      repository.reserve(input(id, {
        now: old,
        eventCreatedAt: oldSeconds,
        deliveryTimestamp: oldSeconds,
        authorization: oldAuthorization(id),
      }));
      repository.markAttempt(`call-${id}`, old);
      repository.recordOutcome(`call-${id}`, 'rejected', old + index);
    }
    repository.reserve(input('mixed-unknown', {
      now: old,
      eventCreatedAt: oldSeconds,
      deliveryTimestamp: oldSeconds,
      authorization: oldAuthorization('mixed-unknown'),
    }));
    repository.markAttempt('call-mixed-unknown', old);
    repository.recordOutcome('call-mixed-unknown', 'unknown', old);
    repository.reserve(input('mixed-pending', {
      now: old,
      eventCreatedAt: oldSeconds,
      deliveryTimestamp: oldSeconds,
      authorization: oldAuthorization('mixed-pending'),
    }));
    db.prepare('UPDATE voice_sip_authority_grants SET expires_at = ?').run(oldSeconds - 1);

    db.close();
    const reopened = fileDatabase(directory);
    databases.push(reopened);
    const reopenedRepository = new VoiceSipRepository(reopened);
    const pruned = reopenedRepository.pruneSafe(old + SIP_SAFE_RETENTION_MS + 100);
    expect(pruned._unsafeUnwrap()).toBe(99);
    expect(reopenedRepository.findByCallId('call-safe-0')._unsafeUnwrap()).toBeNull();
    expect(reopenedRepository.findByCallId('call-safe-33')._unsafeUnwrap()?.decision.state).toBe('rejected');
    expect(reopenedRepository.findByCallId('call-mixed-unknown')._unsafeUnwrap()?.decision.state).toBe('unknown');
    expect(reopenedRepository.findByCallId('call-mixed-pending')._unsafeUnwrap()?.decision.state).toBe('reserved');
    expect(reopenedRepository.counts()._unsafeUnwrap()).toEqual({ decisions: 3, receipts: 3, grants: 3 });
  });

  it('denies new admission at 50,000 retained receipts while resolving duplicates safely', () => {
    const directory = mkdtempSync(join(tmpdir(), 'talon-sip-receipt-cap-'));
    directories.push(directory);
    const db = fileDatabase(directory);
    databases.push(db);
    const repository = new VoiceSipRepository(db);
    repository.reserve(input('receipt-base'));
    const insertReceipt = db.prepare(
      `INSERT INTO voice_sip_delivery_receipts
         (delivery_id, call_id, provider_session_id, state, event_created_at,
          delivery_timestamp, created_at, updated_at, metadata_json)
       VALUES (?, 'call-receipt-base', 'session-receipt-base', 'unknown', 1, 1, 1, 1, '{}')`,
    );
    const fill = db.transaction(() => {
      for (let index = 0; index < 49_999; index += 1) {
        insertReceipt.run(`receipt-fill-${index}`);
      }
    });
    fill();
    expect(repository.counts()._unsafeUnwrap()).toEqual({ decisions: 1, receipts: 50_000, grants: 1 });
    db.close();
    const reopened = fileDatabase(directory);
    databases.push(reopened);
    const reopenedRepository = new VoiceSipRepository(reopened);

    const denied = reopenedRepository.reserve(input('receipt-cap-new'));
    expect(denied._unsafeUnwrap()).toMatchObject({ outcome: 'denied', reason: 'capacity' });
    const duplicateDelivery = reopenedRepository.reserve(
      input('receipt-duplicate', {
        deliveryId: 'delivery-receipt-base',
        providerSessionId: 'session-new-at-cap',
      }),
    );
    expect(duplicateDelivery._unsafeUnwrap().outcome).toBe('duplicate_delivery');
    const duplicateSession = reopenedRepository.reserve(
      input('session-duplicate', {
        deliveryId: 'delivery-session-duplicate-at-cap',
        providerSessionId: 'session-receipt-base',
      }),
    );
    expect(duplicateSession._unsafeUnwrap().outcome).toBe('duplicate_session');
    expect(reopenedRepository.counts()._unsafeUnwrap()).toEqual({ decisions: 1, receipts: 50_000, grants: 1 });
  });

  it('serializes final-slot admission across two SQLite connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'talon-sip-cap-'));
    directories.push(directory);
    const firstDb = fileDatabase(directory);
    const secondResult = createDatabase(join(directory, 'voice-sip.sqlite'));
    if (secondResult.isErr()) throw secondResult.error;
    const secondDb = secondResult.value;
    databases.push(firstDb, secondDb);
    const fill = firstDb.transaction(() => {
      const decision = firstDb.prepare(
        `INSERT INTO voice_sip_call_decisions
           (call_id, provider_session_id, state, grant_revision, event_created_at,
            created_at, updated_at, metadata_json)
         VALUES (?, ?, 'unknown', ?, 1, 1, 1, '{}')`,
      );
      const grant = firstDb.prepare(
        `INSERT INTO voice_sip_authority_grants
           (revision, call_id, provider_session_id, issuer, key_id, audience, subject,
            owner_id, persona_id, nonce, call_binding, proof_hash, issued_at, expires_at,
            metadata_json, created_at)
         VALUES (?, ?, ?, 'issuer', 'key', 'audience', 'subject', 'owner', 'persona', ?,
                 'binding', ?, 1, 1, '{}', 1)`,
      );
      const receipt = firstDb.prepare(
        `INSERT INTO voice_sip_delivery_receipts
           (delivery_id, call_id, provider_session_id, state, event_created_at,
            delivery_timestamp, created_at, updated_at, metadata_json)
         VALUES (?, ?, ?, 'unknown', 1, 1, 1, 1, '{}')`,
      );
      for (let index = 0; index < 9_999; index += 1) {
        const id = `fill-${index}`;
        decision.run(id, `fill-session-${index}`, index + 1);
        grant.run(index + 1, id, `fill-session-${index}`, `nonce-fill-${index}`, `proof-${index}`.padEnd(64, '0'));
        receipt.run(`fill-delivery-${index}`, id, `fill-session-${index}`);
      }
    });
    fill();
    const first = new VoiceSipRepository(firstDb).reserve(input('final-first'));
    const second = new VoiceSipRepository(secondDb).reserve(input('final-second'));
    expect([first._unsafeUnwrap().outcome, second._unsafeUnwrap().outcome].sort()).toEqual([
      'denied',
      'reserved',
    ]);
    expect(new VoiceSipRepository(firstDb).counts()._unsafeUnwrap()).toEqual({
      decisions: 10_000,
      receipts: 10_000,
      grants: 10_000,
    });
  }, 15_000);

  it('races overlapping SQLite connections at the final slot', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'talon-sip-overlap-'));
    directories.push(directory);
    const db = fileDatabase(directory);
    databases.push(db);
    const fill = db.transaction(() => {
      const decision = db.prepare(
        `INSERT INTO voice_sip_call_decisions
           (call_id, provider_session_id, state, grant_revision, event_created_at,
            created_at, updated_at, metadata_json)
         VALUES (?, ?, 'unknown', ?, 1, 1, 1, '{}')`,
      );
      const grant = db.prepare(
        `INSERT INTO voice_sip_authority_grants
           (revision, call_id, provider_session_id, issuer, key_id, audience, subject,
            owner_id, persona_id, nonce, call_binding, proof_hash, issued_at, expires_at,
            metadata_json, created_at)
         VALUES (?, ?, ?, 'issuer', 'key', 'audience', 'subject', 'owner', 'persona', ?,
                 'binding', ?, 1, 1, '{}', 1)`,
      );
      const receipt = db.prepare(
        `INSERT INTO voice_sip_delivery_receipts
           (delivery_id, call_id, provider_session_id, state, event_created_at,
            delivery_timestamp, created_at, updated_at, metadata_json)
         VALUES (?, ?, ?, 'unknown', 1, 1, 1, 1, '{}')`,
      );
      for (let index = 0; index < 9_999; index += 1) {
        const id = `overlap-fill-${index}`;
        decision.run(id, `overlap-session-${index}`, index + 1);
        grant.run(index + 1, id, `overlap-session-${index}`, `overlap-nonce-${index}`, `overlap-proof-${index}`.padEnd(64, '0'));
        receipt.run(`overlap-delivery-${index}`, id, `overlap-session-${index}`);
      }
    });
    fill();
    db.close();

    const repositoryModule = fileURLToPath(new URL(
      '../../../../../src/core/database/repositories/voice-sip-repository.ts',
      import.meta.url,
    ));
    const betterSqliteModule = require.resolve('better-sqlite3');
    const tsxLoader = fileURLToPath(new URL('../../../../../node_modules/tsx/dist/loader.cjs', import.meta.url));
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require(${JSON.stringify(betterSqliteModule)});
      (async () => {
        const { VoiceSipRepository } = require(${JSON.stringify(repositoryModule)});
        const database = new Database(workerData.databasePath);
        database.pragma('busy_timeout = 5000');
        const repository = new VoiceSipRepository(database);
        parentPort.postMessage({ kind: 'ready' });
        parentPort.once('message', ({ startAt }) => {
          const delay = Math.max(0, startAt - Date.now());
          if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
          const result = repository.reserve({
            callId: 'overlap-call-' + workerData.id,
            providerSessionId: 'overlap-provider-' + workerData.id,
            deliveryId: 'overlap-delivery-new-' + workerData.id,
            eventCreatedAt: 1,
            deliveryTimestamp: 1,
            now: 1,
            authorization: {
              version: 1,
              algorithm: 'Ed25519',
              issuer: 'issuer',
              keyId: 'key',
              audience: 'audience',
              subject: 'subject',
              nonce: 'overlap-new-nonce-' + workerData.id,
              callBinding: 'binding-' + workerData.id,
              issuedAt: 1,
              expiresAt: 60,
              proofHash: ('overlap-new-proof-' + workerData.id).padEnd(64, '0'),
              principal: { ownerId: 'owner', personaId: 'persona' },
            },
          });
          parentPort.postMessage({ kind: 'result', outcome: result.isOk() ? result.value.outcome : 'error' });
          database.close();
        });
      })().catch((error) => parentPort.postMessage({ kind: 'error', message: String(error) }));
    `;
    const workers = ['one', 'two'].map(
      (id) =>
        new Worker(workerSource, {
          eval: true,
          execArgv: ['--require', tsxLoader],
          workerData: { databasePath: join(directory, 'voice-sip.sqlite'), id },
        }),
    );
    const ready = workers.map(
      (worker) =>
        new Promise<void>((resolve, reject) => {
          worker.once('message', (message: { kind: string; message?: string }) => {
            if (message.kind === 'ready') resolve();
            else reject(new Error(message.message ?? 'race worker failed before ready'));
          });
          worker.once('error', reject);
        }),
    );
    await Promise.all(ready);
    const results = workers.map(
      (worker) =>
        new Promise<string>((resolve, reject) => {
          worker.once('message', (message: { kind: string; outcome?: string; message?: string }) => {
            if (message.kind === 'result' && message.outcome) resolve(message.outcome);
            else reject(new Error(message.message ?? 'race worker failed during reserve'));
          });
          worker.once('error', reject);
        }),
    );
    const startAt = Date.now() + 100;
    workers.forEach((worker) => worker.postMessage({ startAt }));
    const outcomes = await Promise.all(results);
    await Promise.all(workers.map((worker) => worker.terminate()));
    expect(outcomes.sort()).toEqual(['denied', 'reserved']);

    const reopened = fileDatabase(directory);
    databases.push(reopened);
    expect(new VoiceSipRepository(reopened).counts()._unsafeUnwrap()).toEqual({
      decisions: 10_000,
      receipts: 10_000,
      grants: 10_000,
    });
  }, 30_000);
});
