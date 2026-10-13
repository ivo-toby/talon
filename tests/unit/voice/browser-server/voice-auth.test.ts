import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../core/database/repositories/helpers.js';
import { VoiceAuthRepository } from '../../../../src/core/database/repositories/voice-auth-repository.js';
import {
  VOICE_CSRF_COOKIE,
  VOICE_CSRF_HEADER,
  VOICE_SESSION_COOKIE,
  VoiceAuth,
} from '../../../../src/voice/voice-auth.js';
import { IndexedVoiceAuth } from '../../../../src/voice/voice-session-service.js';

let db: ReturnType<typeof createTestDb> | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function cookieValue(setCookie: string, name: string): string {
  const match = new RegExp(`^${name}=([^;]+)`).exec(setCookie);
  if (!match) throw new Error(`Cookie ${name} not found`);
  return match[1];
}

describe('VoiceAuth', () => {
  it('exchanges the configured token for strict cookies and an owner context', () => {
    let now = 1_000;
    const auth = new VoiceAuth({
      accessToken: 'configured-secret',
      ownerId: 'ivo',
      sessionTtlMs: 5_000,
      now: () => now,
    });

    const login = auth.login({ accessToken: 'configured-secret' }, { secure: true });
    expect(login.isOk()).toBe(true);
    if (login.isErr()) return;

    expect(login.value.response).toEqual({ authenticated: true, expiresAt: 6_000 });
    expect(login.value.session.owner).toEqual({ ownerId: 'ivo', loginRevision: 1 });
    expect(login.value.cookies[0]).toContain(`${VOICE_SESSION_COOKIE}=`);
    expect(login.value.cookies[0]).toContain('HttpOnly');
    expect(login.value.cookies[0]).toContain('Secure');
    expect(login.value.cookies[0]).toContain('SameSite=Strict');
    expect(login.value.cookies[1]).toContain(`${VOICE_CSRF_COOKIE}=`);
    expect(login.value.cookies[1]).not.toContain('HttpOnly');

    const sessionCookie = cookieValue(login.value.cookies[0], VOICE_SESSION_COOKIE);
    const csrfCookie = cookieValue(login.value.cookies[1], VOICE_CSRF_COOKIE);
    const request = {
      headers: {
        cookie: `${VOICE_SESSION_COOKIE}=${sessionCookie}; ${VOICE_CSRF_COOKIE}=${csrfCookie}`,
        [VOICE_CSRF_HEADER]: csrfCookie,
      },
    };
    const authenticated = auth.authenticate(request);
    expect(authenticated.isOk()).toBe(true);
    expect(auth.verifyCsrf(request, login.value.session).isOk()).toBe(true);

    now = 6_001;
    expect(auth.authenticate(request).isErr()).toBe(true);
    expect(auth.verifyCsrf(request, login.value.session).isErr()).toBe(true);
  });

  it('rejects invalid csrf tokens and throttles repeated invalid logins', () => {
    const auth = new VoiceAuth({
      accessToken: 'secret',
      maxLoginAttempts: 2,
      loginWindowMs: 10_000,
    });
    expect(auth.login('wrong', { remoteAddress: '127.0.0.1' }).isErr()).toBe(true);
    expect(auth.login('wrong', { remoteAddress: '127.0.0.1' }).isErr()).toBe(true);
    const limited = auth.login('secret', { remoteAddress: '127.0.0.1' });
    expect(limited.isErr()).toBe(true);
    if (limited.isOk()) return;
    expect(limited.error.kind).toBe('rate_limited');

    const login = auth.login('secret', { remoteAddress: 'other' });
    expect(login.isOk()).toBe(true);
    if (login.isErr()) return;
    const sessionCookie = cookieValue(login.value.cookies[0], VOICE_SESSION_COOKIE);
    const request = {
      headers: {
        cookie: `${VOICE_SESSION_COOKIE}=${sessionCookie}`,
        [VOICE_CSRF_HEADER]: 'wrong',
      },
    };
    expect(auth.verifyCsrf(request, login.value.session).isErr()).toBe(true);
  });

  it('revokes cookies and emits deletion headers', () => {
    const auth = new VoiceAuth({ accessToken: 'secret' });
    const login = auth.login('secret');
    expect(login.isOk()).toBe(true);
    if (login.isErr()) return;

    auth.revoke(login.value.session);
    const request = { headers: { cookie: login.value.cookies[0].split(';', 1)[0] } };
    expect(auth.authenticate(request).isErr()).toBe(true);
    const clear = auth.clearCookieHeaders(false);
    expect(clear[0]).toContain(`${VOICE_SESSION_COOKIE}=;`);
    expect(clear[0]).toContain('Max-Age=0');
    expect(clear[1]).toContain(`${VOICE_CSRF_COOKIE}=;`);
  });

  it('uses fixed session durations and restores durable authority after reconstruction', () => {
    db = createTestDb();
    const repository = new VoiceAuthRepository(db);
    let now = 1_000;
    const first = new IndexedVoiceAuth({
      accessToken: 'configured-secret',
      ownerId: 'owner-1',
      repository,
      now: () => now,
    });

    const short = first.login({ accessToken: 'configured-secret' })._unsafeUnwrap();
    expect(short.response.expiresAt).toBe(now + 15 * 60 * 1000);
    const remembered = first
      .login({ accessToken: 'configured-secret', rememberMe: true })
      ._unsafeUnwrap();
    expect(remembered.response.expiresAt).toBe(now + 365 * 24 * 60 * 60 * 1000);
    expect(remembered.cookies[0]).toContain('Max-Age=31536000');

    const sessionCookie = cookieValue(remembered.cookies[0], VOICE_SESSION_COOKIE);
    const csrfCookie = cookieValue(remembered.cookies[1], VOICE_CSRF_COOKIE);
    const request = {
      headers: {
        cookie: `${VOICE_SESSION_COOKIE}=${sessionCookie}; ${VOICE_CSRF_COOKIE}=${csrfCookie}`,
        [VOICE_CSRF_HEADER]: csrfCookie,
      },
    };
    const rememberedExpiresAt = remembered.response.expiresAt;
    now = 2_000;
    const reconstructed = new IndexedVoiceAuth({
      accessToken: 'configured-secret',
      ownerId: 'owner-1',
      repository,
      now: () => now,
    });
    const restored = reconstructed.authenticate(request);
    expect(restored.isOk()).toBe(true);
    if (restored.isErr()) return;
    expect(restored.value.expiresAt).toBe(rememberedExpiresAt);
    expect(reconstructed.verifyCsrf(request, restored.value).isOk()).toBe(true);
    expect(reconstructed.resolve(restored.value.owner)).toBe(restored.value);

    const shortCookie = cookieValue(short.cookies[0], VOICE_SESSION_COOKIE);
    expect(
      reconstructed.authenticate({
        headers: { cookie: `${VOICE_SESSION_COOKIE}=${shortCookie}` },
      }).isOk(),
    ).toBe(true);

    const other = reconstructed.login({ accessToken: 'configured-secret' })._unsafeUnwrap();
    const otherCsrf = cookieValue(other.cookies[1], VOICE_CSRF_COOKIE);
    expect(
      reconstructed.verifyCsrf(
        {
          headers: {
            cookie: `${VOICE_SESSION_COOKIE}=${sessionCookie}; ${VOICE_CSRF_COOKIE}=${otherCsrf}`,
            [VOICE_CSRF_HEADER]: otherCsrf,
          },
        },
        restored.value,
      ).isErr(),
    ).toBe(true);

    expect(first.invalidateRuntime().isOk()).toBe(true);
    expect(reconstructed.authenticate(request).isErr()).toBe(true);
  });

  it('enforces the active-session cap without evicting a live grant', () => {
    db = createTestDb();
    const repository = new VoiceAuthRepository(db);
    let now = 1_000;
    const auth = new IndexedVoiceAuth({
      accessToken: 'configured-secret',
      ownerId: 'owner-1',
      repository,
      maxSessions: 1,
      sessionTtlMs: 100,
      now: () => now,
    });
    const first = auth.login('configured-secret')._unsafeUnwrap();
    expect(auth.login('configured-secret').isErr()).toBe(true);
    expect(auth.authenticate({ headers: { cookie: first.cookies[0] } }).isOk()).toBe(true);
    now = 1_101;
    expect(auth.login('configured-secret').isOk()).toBe(true);
  });

  it('rotates durable credentials without leaving the previous key usable', () => {
    db = createTestDb();
    const repository = new VoiceAuthRepository(db);
    const auth = new IndexedVoiceAuth({
      accessToken: 'old-secret',
      ownerId: 'owner-1',
      repository,
    });
    const oldLogin = auth.login('old-secret')._unsafeUnwrap();
    expect(auth.rebind('new-secret').isOk()).toBe(true);
    expect(auth.login('old-secret').isErr()).toBe(true);
    expect(auth.login('new-secret').isOk()).toBe(true);
    expect(auth.rebind('old-secret').isOk()).toBe(true);
    expect(auth.login('new-secret').isErr()).toBe(true);
    expect(auth.login('old-secret').isOk()).toBe(true);
    expect(
      auth.authenticate({ headers: { cookie: oldLogin.cookies[0] } }).isErr(),
    ).toBe(true);
  });

  it('returns typed storage failures when the durable authority becomes unavailable', () => {
    db = createTestDb();
    const repository = new VoiceAuthRepository(db);
    const auth = new IndexedVoiceAuth({
      accessToken: 'configured-secret',
      ownerId: 'owner-1',
      repository,
    });
    const login = auth.login('configured-secret')._unsafeUnwrap();
    const sessionCookie = cookieValue(login.cookies[0], VOICE_SESSION_COOKIE);
    const csrfCookie = cookieValue(login.cookies[1], VOICE_CSRF_COOKIE);
    const request = {
      headers: {
        cookie: `${VOICE_SESSION_COOKIE}=${sessionCookie}; ${VOICE_CSRF_COOKIE}=${csrfCookie}`,
        [VOICE_CSRF_HEADER]: csrfCookie,
      },
    };

    db.close();
    const failedCreate = repository.createSession({
      id: 'storage-failure-session',
      sessionTokenHash: 'session-hash',
      csrfTokenHash: 'csrf-hash',
      ownerId: 'owner-1',
      createdAt: 1,
      expiresAt: 2,
    });
    expect(failedCreate.isErr()).toBe(true);
    db = undefined;

    const failedLogin = auth.login('configured-secret');
    expect(failedLogin.isErr()).toBe(true);
    if (failedLogin.isErr()) expect(failedLogin.error.kind).toBe('storage_error');

    const failedAuthenticate = auth.authenticate(request);
    expect(failedAuthenticate.isErr()).toBe(true);
    if (failedAuthenticate.isErr()) expect(failedAuthenticate.error.kind).toBe('storage_error');

    const failedActive = auth.isActiveResult(login.session);
    expect(failedActive.isErr()).toBe(true);
    if (failedActive.isErr()) expect(failedActive.error.kind).toBe('storage_error');

    const failedCsrf = auth.verifyCsrf(request, login.session);
    expect(failedCsrf.isErr()).toBe(true);
    if (failedCsrf.isErr()) expect(failedCsrf.error.kind).toBe('storage_error');

    const failedRevoke = auth.revoke(login.session);
    expect(failedRevoke.isErr()).toBe(true);
    if (failedRevoke.isErr()) expect(failedRevoke.error.kind).toBe('storage_error');

    const failedInvalidate = auth.invalidateRuntime();
    expect(failedInvalidate.isErr()).toBe(true);
    if (failedInvalidate.isErr()) expect(failedInvalidate.error.kind).toBe('storage_error');
  });
});
