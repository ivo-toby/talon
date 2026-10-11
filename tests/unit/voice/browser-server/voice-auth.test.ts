import { describe, expect, it } from 'vitest';
import {
  VOICE_CSRF_COOKIE,
  VOICE_CSRF_HEADER,
  VOICE_SESSION_COOKIE,
  VoiceAuth,
} from '../../../../src/voice/voice-auth.js';

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
});
