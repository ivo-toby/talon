import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../repositories/helpers.js';
import {
  hashVoiceAuthToken,
  VoiceAuthRepository,
} from '../../../../../src/core/database/repositories/voice-auth-repository.js';

describe('VoiceAuthRepository', () => {
  let db: ReturnType<typeof createTestDb> | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('stores only salted credential and session hashes and revokes on credential rotation', () => {
    db = createTestDb();
    const repository = new VoiceAuthRepository(db);

    expect(repository.bindCredential('owner-1', 'configured-secret', 100).isOk()).toBe(true);
    expect(repository.verifyCredential('owner-1', 'configured-secret')._unsafeUnwrap()).toBe(true);
    expect(repository.verifyCredential('owner-1', 'wrong')._unsafeUnwrap()).toBe(false);

    const session = repository
      .createSession({
        id: 'auth-session-1',
        sessionTokenHash: hashVoiceAuthToken('cookie-secret'),
        csrfTokenHash: hashVoiceAuthToken('csrf-secret'),
        ownerId: 'owner-1',
        createdAt: 100,
        expiresAt: 10_000,
      })
      ._unsafeUnwrap();
    expect(session.login_revision).toBe(1);

    const binding = db.prepare('SELECT * FROM voice_auth_binding').get();
    const persistedSession = db.prepare('SELECT * FROM voice_auth_sessions').get();
    expect(JSON.stringify(binding)).not.toContain('configured-secret');
    expect(JSON.stringify(persistedSession)).not.toContain('cookie-secret');
    expect(JSON.stringify(persistedSession)).not.toContain('csrf-secret');

    const rotated = repository.bindCredential('owner-1', 'rotated-secret', 200);
    expect(rotated.isOk()).toBe(true);
    expect(rotated._unsafeUnwrap().changed).toBe(true);
    expect(
      repository.findActiveByTokenHash(hashVoiceAuthToken('cookie-secret'), 201)._unsafeUnwrap(),
    ).toBeNull();
    expect(repository.verifyCredential('owner-1', 'configured-secret')._unsafeUnwrap()).toBe(false);
    expect(repository.verifyCredential('owner-1', 'rotated-secret')._unsafeUnwrap()).toBe(true);
  });

  it('allocates a revision above historical voice sessions and prunes only expired grants', () => {
    db = createTestDb();
    const repository = new VoiceAuthRepository(db);
    repository.bindCredential('owner-1', 'secret', 100);

    db.prepare('UPDATE voice_auth_revision_allocator SET next_revision = 1').run();
    db.prepare(
      `INSERT INTO voice_sessions
        (id, revision, owner_id, login_revision, persona_id, thread_id, transport, status,
         created_at, deadline_at, policy_json, usage_json, finalization_json,
         record_digest, updated_at)
       VALUES ('historical-voice', 1, 'owner-1', 17, 'persona-1', 'thread-1', 'webrtc',
               'closed', 1, 2, '{}', '{}', '{}', 'digest', 2)`,
    ).run();

    const session = repository
      .createSession({
        id: 'auth-session-2',
        sessionTokenHash: hashVoiceAuthToken('cookie-2'),
        csrfTokenHash: hashVoiceAuthToken('csrf-2'),
        ownerId: 'owner-1',
        createdAt: 100,
        expiresAt: 10_000,
      })
      ._unsafeUnwrap();
    expect(session.login_revision).toBe(18);

    repository
      .createSession({
        id: 'auth-session-expired',
        sessionTokenHash: hashVoiceAuthToken('cookie-expired'),
        csrfTokenHash: hashVoiceAuthToken('csrf-expired'),
        ownerId: 'owner-1',
        createdAt: 100,
        expiresAt: 150,
      })
      ._unsafeUnwrap();
    expect(repository.countActive(151)._unsafeUnwrap()).toBe(1);
    expect(repository.pruneExpired(151)._unsafeUnwrap()).toBe(1);
    expect(repository.countActive(151)._unsafeUnwrap()).toBe(1);

    const next = repository
      .createSession({
        id: 'auth-session-3',
        sessionTokenHash: hashVoiceAuthToken('cookie-3'),
        csrfTokenHash: hashVoiceAuthToken('csrf-3'),
        ownerId: 'owner-1',
        createdAt: 200,
        expiresAt: 10_000,
      })
      ._unsafeUnwrap();
    expect(next.login_revision).toBe(20);
  });

  it('requires both csrf values for the same active revision and rejects revoked rows', () => {
    db = createTestDb();
    const repository = new VoiceAuthRepository(db);
    repository.bindCredential('owner-1', 'secret', 100);
    const session = repository
      .createSession({
        id: 'auth-session-csrf',
        sessionTokenHash: hashVoiceAuthToken('cookie-csrf'),
        csrfTokenHash: hashVoiceAuthToken('csrf-csrf'),
        ownerId: 'owner-1',
        createdAt: 100,
        expiresAt: 10_000,
      })
      ._unsafeUnwrap();

    expect(
      repository
        .verifyCsrf(
          session.id,
          session.owner_id,
          session.login_revision,
          hashVoiceAuthToken('csrf-csrf'),
          hashVoiceAuthToken('csrf-csrf'),
          101,
        )
        ._unsafeUnwrap(),
    ).toBe(true);
    expect(
      repository
        .verifyCsrf(
          session.id,
          session.owner_id,
          session.login_revision,
          hashVoiceAuthToken('csrf-csrf'),
          hashVoiceAuthToken('wrong-csrf'),
          101,
        )
        ._unsafeUnwrap(),
    ).toBe(false);

    expect(repository.revokeSession(session.id, 102).isOk()).toBe(true);
    expect(
      repository
        .verifyCsrf(
          session.id,
          session.owner_id,
          session.login_revision,
          hashVoiceAuthToken('csrf-csrf'),
          hashVoiceAuthToken('csrf-csrf'),
          103,
        )
        ._unsafeUnwrap(),
    ).toBe(false);
  });
});
