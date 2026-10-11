import { describe, expect, it, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { err, ok } from '../../../../src/core/types/result.js';
import { PolicyError } from '../../../../src/core/errors/error-types.js';
import {
  VoiceAuth,
  VOICE_CSRF_COOKIE,
  VOICE_SESSION_COOKIE,
} from '../../../../src/voice/voice-auth.js';
import {
  BrowserVoiceServer,
  type BrowserVoiceServerConfig,
} from '../../../../src/voice/transports/browser/browser-server.js';
import type {
  VoiceAsyncResult,
  VoiceClientSessionDescriptor,
  VoiceEventHandler,
  VoiceFinalizationState,
  VoiceOwnerContext,
  VoicePlaybackReport,
  VoiceSessionCloseRequest,
  VoiceSessionCreateRequest,
  VoiceSessionCreateResult,
  VoiceSessionRecord,
  VoiceSessionService,
  type VoiceSessionStatus,
  VoiceSessionStatusDto,
  VoiceStatusEventDto,
  VoiceUnsubscribe,
} from '../../../../src/voice/voice-types.js';

const ORIGIN = 'http://127.0.0.1';

class FakeVoiceSessionService implements VoiceSessionService {
  readonly closedReasons: string[] = [];
  readonly playbackReports: VoicePlaybackReport[] = [];
  private nextId = 1;
  private readonly sessions = new Map<string, { ownerId: string; record: VoiceSessionRecord }>();
  private readonly rejectedStatusRevisions = new Set<string>();
  private handler: VoiceEventHandler<VoiceStatusEventDto> | undefined;
  private createStartedResolve: (() => void) | undefined;
  private createGate: Promise<void> | undefined;

  async createSession(
    owner: VoiceOwnerContext,
    _input: VoiceSessionCreateRequest,
  ): VoiceAsyncResult<VoiceSessionCreateResult> {
    this.createStartedResolve?.();
    this.createStartedResolve = undefined;
    const gate = this.createGate;
    this.createGate = undefined;
    if (gate) await gate;
    const id = `session-${this.nextId++}`;
    const record = makeRecord(id, owner);
    this.sessions.set(id, { ownerId: owner.ownerId, record });
    return ok({ session: record, client: makeClient(id) });
  }

  status(owner: VoiceOwnerContext, sessionId: string) {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.ownerId !== owner.ownerId) return ok(null);
    if (
      this.rejectedStatusRevisions.has(sessionId) &&
      entry.record.owner.loginRevision === owner.loginRevision
    ) {
      return err(new PolicyError('voice login is no longer active'));
    }
    return ok(toStatus(entry.record));
  }

  async closeSession(owner: VoiceOwnerContext, sessionId: string, input: VoiceSessionCloseRequest) {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.ownerId !== owner.ownerId)
      return err(new PolicyError('session owner mismatch'));
    this.closedReasons.push(input.reason);
    const record = { ...entry.record, status: 'closed' as const, closedAt: Date.now() };
    this.sessions.set(sessionId, { ...entry, record });
    return ok({ session: record, pendingDelegation: false });
  }

  async receiveProviderEvent(): Promise<ReturnType<typeof ok<void>>> {
    return ok(undefined);
  }

  async reportPlayback(
    owner: VoiceOwnerContext,
    sessionId: string,
    report: VoicePlaybackReport,
  ): VoiceAsyncResult<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.ownerId !== owner.ownerId)
      return err(new PolicyError('session owner mismatch'));
    this.playbackReports.push(report);
    return ok(undefined);
  }

  subscribe(
    owner: VoiceOwnerContext,
    sessionId: string,
    handler: VoiceEventHandler<VoiceStatusEventDto>,
  ) {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.ownerId !== owner.ownerId)
      return err(new PolicyError('session owner mismatch'));
    this.handler = handler;
    const unsubscribe: VoiceUnsubscribe = () => {
      if (this.handler === handler) this.handler = undefined;
    };
    return ok(unsubscribe);
  }

  emit(event: VoiceStatusEventDto): void {
    void this.handler?.(event);
  }

  holdNextCreate(): { started: Promise<void>; release: () => void } {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let release!: () => void;
    this.createGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.createStartedResolve = resolveStarted;
    return { started, release };
  }

  markTerminal(
    sessionId: string,
    status: Extract<VoiceSessionStatus, 'closed' | 'expired' | 'failed'>,
  ): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Unknown session ${sessionId}`);
    this.sessions.set(sessionId, {
      ...entry,
      record: {
        ...entry.record,
        status,
        ...(status === 'closed' || status === 'expired' ? { closedAt: Date.now() } : {}),
      },
    });
  }

  rejectStoredStatusRevision(sessionId: string): void {
    this.rejectedStatusRevisions.add(sessionId);
  }
}

const activeServers: BrowserVoiceServer[] = [];

afterEach(async () => {
  for (const server of activeServers.splice(0)) await server.stop();
});

describe('BrowserVoiceServer', () => {
  it('enforces origin and csrf checks before creating an owned session', async () => {
    const service = new FakeVoiceSessionService();
    const server = await startServer(service, { maxRequestBytes: 1024 });
    const base = `http://127.0.0.1:${server.port}`;
    const page = await fetch(`${base}/voice/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Talon Voice');

    const wrongOrigin = await fetch(`${base}/voice/login`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: 'secret' }),
    });
    expect(wrongOrigin.status).toBe(403);

    const login = await fetch(`${base}/voice/login`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: 'secret' }),
    });
    expect(login.status).toBe(200);
    const cookies = getSetCookies(login);
    const sessionCookie = cookieValue(cookies, VOICE_SESSION_COOKIE);
    const csrf = cookieValue(cookies, VOICE_CSRF_COOKIE);
    expect(await login.text()).not.toContain('secret');

    const missingCsrf = await fetch(`${base}/voice/sessions`, {
      method: 'POST',
      headers: {
        cookie: `${VOICE_SESSION_COOKIE}=${sessionCookie}; ${VOICE_CSRF_COOKIE}=${csrf}`,
        origin: ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ transport: { type: 'webrtc', sdp: 'offer' } }),
    });
    expect(missingCsrf.status).toBe(403);

    const created = await fetch(`${base}/voice/sessions`, {
      method: 'POST',
      headers: {
        cookie: `${VOICE_SESSION_COOKIE}=${sessionCookie}; ${VOICE_CSRF_COOKIE}=${csrf}`,
        origin: ORIGIN,
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ transport: { type: 'webrtc', sdp: 'offer' } }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { session: VoiceSessionStatusDto };
    expect(createdBody.session.id).toBe('session-1');
    expect(createdBody).not.toHaveProperty('accessToken');

    const sameOriginRead = await fetch(`${base}/voice/sessions/session-1`, {
      headers: {
        cookie: `${VOICE_SESSION_COOKIE}=${sessionCookie}`,
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(sameOriginRead.status).toBe(200);

    const missingOriginMutation = await fetch(`${base}/voice/sessions/session-1/close`, {
      method: 'POST',
      headers: {
        cookie: `${VOICE_SESSION_COOKIE}=${sessionCookie}; ${VOICE_CSRF_COOKIE}=${csrf}`,
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ reason: 'hangup' }),
    });
    expect(missingOriginMutation.status).toBe(403);

    const guessed = await fetch(`${base}/voice/sessions/session-guess`, {
      headers: {
        cookie: `${VOICE_SESSION_COOKIE}=${sessionCookie}`,
        origin: ORIGIN,
      },
    });
    expect(guessed.status).toBe(404);

    const secondLogin = await loginAt(base);
    const secondCookies = getSetCookies(secondLogin);
    const secondSessionCookie = cookieValue(secondCookies, VOICE_SESSION_COOKIE);
    const sameOwnerRead = await fetch(`${base}/voice/sessions/session-1`, {
      headers: {
        cookie: `${VOICE_SESSION_COOKIE}=${secondSessionCookie}`,
        origin: ORIGIN,
      },
    });
    expect(sameOwnerRead.status).toBe(200);
    expect(service.closedReasons).toEqual([]);
  });

  it('denies retained reads to a different stable owner', async () => {
    const service = new FakeVoiceSessionService();
    const server = await startServer(service);
    const base = `http://127.0.0.1:${server.port}`;
    const login = await loginAt(base);
    const cookies = getSetCookies(login);
    const sessionCookie = cookieValue(cookies, VOICE_SESSION_COOKIE);
    const csrf = cookieValue(cookies, VOICE_CSRF_COOKIE);
    expect(
      (
        await createAt(
          base,
          `${VOICE_SESSION_COOKIE}=${sessionCookie}; ${VOICE_CSRF_COOKIE}=${csrf}`,
          csrf,
        )
      ).status,
    ).toBe(201);

    const otherAuth = new VoiceAuth({ accessToken: 'secret', ownerId: 'other-owner' });
    const otherServer = await startServer(service, {}, otherAuth);
    const otherBase = `http://127.0.0.1:${otherServer.port}`;
    const otherLogin = await loginAt(otherBase);
    const otherCookie = cookieValue(getSetCookies(otherLogin), VOICE_SESSION_COOKIE);
    const denied = await fetch(`${otherBase}/voice/sessions/session-1`, {
      headers: { cookie: `${VOICE_SESSION_COOKIE}=${otherCookie}`, origin: ORIGIN },
    });
    expect(denied.status).toBe(404);
  });

  it('lets a new login revision read closed retained status and stream', async () => {
    const service = new FakeVoiceSessionService();
    const server = await startServer(service);
    const base = `http://127.0.0.1:${server.port}`;
    const firstLogin = await loginAt(base);
    const firstCookies = getSetCookies(firstLogin);
    const firstSessionCookie = cookieValue(firstCookies, VOICE_SESSION_COOKIE);
    const firstCsrf = cookieValue(firstCookies, VOICE_CSRF_COOKIE);
    const firstCookieHeader =
      `${VOICE_SESSION_COOKIE}=${firstSessionCookie}; ` + `${VOICE_CSRF_COOKIE}=${firstCsrf}`;
    expect((await createAt(base, firstCookieHeader, firstCsrf)).status).toBe(201);
    service.markTerminal('session-1', 'closed');

    const secondLogin = await loginAt(base);
    const secondSessionCookie = cookieValue(getSetCookies(secondLogin), VOICE_SESSION_COOKIE);
    const secondCookieHeader = `${VOICE_SESSION_COOKIE}=${secondSessionCookie}`;
    const status = await fetch(`${base}/voice/sessions/session-1`, {
      headers: { cookie: secondCookieHeader, origin: ORIGIN },
    });
    expect(status.status).toBe(200);
    expect(((await status.json()) as { session: VoiceSessionStatusDto }).session.status).toBe(
      'closed',
    );

    const stream = await fetch(`${base}/voice/sessions/session-1/events`, {
      headers: { cookie: secondCookieHeader, origin: ORIGIN },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    if (!reader) throw new Error('stream body missing');
    const firstEvent = await reader.read();
    expect(new TextDecoder().decode(firstEvent.value)).toContain('"status":"closed"');
    await reader.cancel();
  });

  it('keeps close and playback bound to the original login revision', async () => {
    const service = new FakeVoiceSessionService();
    const server = await startServer(service);
    const base = `http://127.0.0.1:${server.port}`;
    const firstLogin = await loginAt(base);
    const firstCookies = getSetCookies(firstLogin);
    const firstSessionCookie = cookieValue(firstCookies, VOICE_SESSION_COOKIE);
    const firstCsrf = cookieValue(firstCookies, VOICE_CSRF_COOKIE);
    const firstCookieHeader =
      `${VOICE_SESSION_COOKIE}=${firstSessionCookie}; ` + `${VOICE_CSRF_COOKIE}=${firstCsrf}`;
    expect((await createAt(base, firstCookieHeader, firstCsrf)).status).toBe(201);

    const secondLogin = await loginAt(base);
    const secondCookies = getSetCookies(secondLogin);
    const secondSessionCookie = cookieValue(secondCookies, VOICE_SESSION_COOKIE);
    const secondCsrf = cookieValue(secondCookies, VOICE_CSRF_COOKIE);
    const secondCookieHeader =
      `${VOICE_SESSION_COOKIE}=${secondSessionCookie}; ` + `${VOICE_CSRF_COOKIE}=${secondCsrf}`;
    const close = await fetch(`${base}/voice/sessions/session-1/close`, {
      method: 'POST',
      headers: {
        cookie: secondCookieHeader,
        origin: ORIGIN,
        'content-type': 'application/json',
        'x-csrf-token': secondCsrf,
      },
      body: JSON.stringify({ reason: 'hangup' }),
    });
    expect(close.status).toBe(404);

    const playback = await fetch(`${base}/voice/sessions/session-1/playback`, {
      method: 'POST',
      headers: {
        cookie: secondCookieHeader,
        origin: ORIGIN,
        'content-type': 'application/json',
        'x-csrf-token': secondCsrf,
      },
      body: JSON.stringify({ outputId: 'output-1', status: 'played' }),
    });
    expect(playback.status).toBe(404);
    expect(service.closedReasons).toEqual([]);
    expect(service.playbackReports).toEqual([]);
  });

  it('allows proxy same-origin reads without a referrer', async () => {
    const service = new FakeVoiceSessionService();
    const publicOrigin = 'https://voice.example';
    const server = await startServer(service, { allowedOrigins: [publicOrigin] });
    const base = `http://127.0.0.1:${server.port}`;
    const login = await fetch(`${base}/voice/login`, {
      method: 'POST',
      headers: { origin: publicOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: 'secret' }),
    });
    expect(login.status).toBe(200);
    const cookies = getSetCookies(login);
    const sessionCookie = cookieValue(cookies, VOICE_SESSION_COOKIE);
    const csrf = cookieValue(cookies, VOICE_CSRF_COOKIE);
    const cookieHeader = `${VOICE_SESSION_COOKIE}=${sessionCookie}; ${VOICE_CSRF_COOKIE}=${csrf}`;
    const created = await fetch(`${base}/voice/sessions`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        origin: publicOrigin,
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ transport: { type: 'webrtc', sdp: 'offer' } }),
    });
    expect(created.status).toBe(201);

    const proxyHeaders = {
      cookie: cookieHeader,
      host: 'voice.example',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-proto': 'https',
    };
    const status = await fetch(`${base}/voice/sessions/session-1`, {
      headers: proxyHeaders,
    });
    expect(status.status).toBe(200);

    const stream = await fetch(`${base}/voice/sessions/session-1/events`, {
      headers: { ...proxyHeaders, accept: 'text/event-stream' },
    });
    expect(stream.status).toBe(200);
    await stream.body?.cancel();
  });

  it('limits request payloads and does not expose domain error details', async () => {
    const service = new FakeVoiceSessionService();
    const server = await startServer(service, { maxRequestBytes: 64 });
    const base = `http://127.0.0.1:${server.port}`;
    const login = await loginAt(base);
    const cookies = getSetCookies(login);
    const sessionCookie = cookieValue(cookies, VOICE_SESSION_COOKIE);
    const csrf = cookieValue(cookies, VOICE_CSRF_COOKIE);
    const huge = await fetch(`${base}/voice/sessions`, {
      method: 'POST',
      headers: {
        cookie: `${VOICE_SESSION_COOKIE}=${sessionCookie}; ${VOICE_CSRF_COOKIE}=${csrf}`,
        origin: ORIGIN,
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ transport: { type: 'webrtc', sdp: 'x'.repeat(200) } }),
    });
    expect(huge.status).toBe(413);

    const invalidToken = await fetch(`${base}/voice/login`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: 'wrong' }),
    });
    expect(invalidToken.status).toBe(401);
    const error = (await invalidToken.json()) as { error: { message: string; requestId: string } };
    expect(error.error.message).toBe('Authentication failed');
    expect(error.error.requestId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('streams redacted status events and revokes the cookie on logout', async () => {
    const service = new FakeVoiceSessionService();
    const server = await startServer(service, { heartbeatIntervalMs: 60_000 });
    const base = `http://127.0.0.1:${server.port}`;
    const login = await loginAt(base);
    const cookies = getSetCookies(login);
    const sessionCookie = cookieValue(cookies, VOICE_SESSION_COOKIE);
    const csrf = cookieValue(cookies, VOICE_CSRF_COOKIE);
    const cookieHeader = `${VOICE_SESSION_COOKIE}=${sessionCookie}; ${VOICE_CSRF_COOKIE}=${csrf}`;
    const created = await fetch(`${base}/voice/sessions`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        origin: ORIGIN,
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ transport: { type: 'webrtc', sdp: 'offer' } }),
    });
    expect(created.status).toBe(201);

    const stream = await fetch(`${base}/voice/sessions/session-1/events`, {
      headers: {
        accept: 'text/event-stream',
        cookie: cookieHeader,
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body?.getReader();
    if (!reader) throw new Error('stream body missing');
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: session');

    const logout = await fetch(`${base}/voice/logout`, {
      method: 'POST',
      headers: { cookie: cookieHeader, origin: ORIGIN, 'x-csrf-token': csrf },
    });
    expect(logout.status).toBe(200);
    expect(service.closedReasons).toContain('logout');
    expect((await reader.read()).done).toBe(true);

    const afterLogout = await fetch(`${base}/voice/sessions/session-1`, {
      headers: { cookie: cookieHeader, origin: ORIGIN },
    });
    expect(afterLogout.status).toBe(401);
  });

  it('closes a status stream when its login expires before delivery', async () => {
    let now = 1_000_000;
    const auth = new VoiceAuth({ accessToken: 'secret', sessionTtlMs: 1_000, now: () => now });
    const service = new FakeVoiceSessionService();
    const server = await startServer(service, { heartbeatIntervalMs: 60_000 }, auth);
    const base = `http://127.0.0.1:${server.port}`;
    const login = await loginAt(base);
    const cookies = getSetCookies(login);
    const sessionCookie = cookieValue(cookies, VOICE_SESSION_COOKIE);
    const csrf = cookieValue(cookies, VOICE_CSRF_COOKIE);
    const cookieHeader = `${VOICE_SESSION_COOKIE}=${sessionCookie}; ${VOICE_CSRF_COOKIE}=${csrf}`;
    const created = await createAt(base, cookieHeader, csrf);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { session: VoiceSessionStatusDto };

    const stream = await fetch(`${base}/voice/sessions/session-1/events`, {
      headers: { cookie: cookieHeader, origin: ORIGIN },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    if (!reader) throw new Error('stream body missing');
    expect((await reader.read()).done).toBe(false);

    now += 1_001;
    service.emit({
      kind: 'session',
      version: 2,
      session: createdBody.session,
      occurredAt: now,
    });
    expect((await reader.read()).done).toBe(true);
  });

  it('revalidates authentication after an incomplete create body', async () => {
    const service = new FakeVoiceSessionService();
    const server = await startServer(service);
    const base = `http://127.0.0.1:${server.port}`;
    const login = await loginAt(base);
    const cookies = getSetCookies(login);
    const sessionCookie = cookieValue(cookies, VOICE_SESSION_COOKIE);
    const csrf = cookieValue(cookies, VOICE_CSRF_COOKIE);
    const cookieHeader = `${VOICE_SESSION_COOKIE}=${sessionCookie}; ${VOICE_CSRF_COOKIE}=${csrf}`;
    const pending = createWithHeldBody(base, cookieHeader, csrf);
    await nextTurn();

    const logout = await fetch(`${base}/voice/logout`, {
      method: 'POST',
      headers: { cookie: cookieHeader, origin: ORIGIN, 'x-csrf-token': csrf },
    });
    expect(logout.status).toBe(200);

    pending.release();
    const result = await pending.response;
    expect(result.status).toBe(401);
    expect(service.closedReasons).toEqual([]);
  });

  it('rejects a close whose body completes after logout', async () => {
    const service = new FakeVoiceSessionService();
    const server = await startServer(service);
    const base = `http://127.0.0.1:${server.port}`;
    const login = await loginAt(base);
    const cookies = getSetCookies(login);
    const sessionCookie = cookieValue(cookies, VOICE_SESSION_COOKIE);
    const csrf = cookieValue(cookies, VOICE_CSRF_COOKIE);
    const cookieHeader = `${VOICE_SESSION_COOKIE}=${sessionCookie}; ${VOICE_CSRF_COOKIE}=${csrf}`;
    expect((await createAt(base, cookieHeader, csrf)).status).toBe(201);
    const pending = requestWithHeldJsonBody(
      base,
      '/voice/sessions/session-1/close',
      cookieHeader,
      csrf,
      { reason: 'hangup' },
    );
    await nextTurn();

    const logout = await fetch(`${base}/voice/logout`, {
      method: 'POST',
      headers: { cookie: cookieHeader, origin: ORIGIN, 'x-csrf-token': csrf },
    });
    expect(logout.status).toBe(200);

    pending.release();
    expect((await pending.response).status).toBe(401);
    expect(service.closedReasons).toEqual(['logout']);
  });

  it('rejects playback whose body completes after login expiry', async () => {
    let now = 2_000_000;
    const auth = new VoiceAuth({ accessToken: 'secret', sessionTtlMs: 1_000, now: () => now });
    const service = new FakeVoiceSessionService();
    const server = await startServer(service, {}, auth);
    const base = `http://127.0.0.1:${server.port}`;
    const login = await loginAt(base);
    const cookies = getSetCookies(login);
    const sessionCookie = cookieValue(cookies, VOICE_SESSION_COOKIE);
    const csrf = cookieValue(cookies, VOICE_CSRF_COOKIE);
    const cookieHeader = `${VOICE_SESSION_COOKIE}=${sessionCookie}; ${VOICE_CSRF_COOKIE}=${csrf}`;
    expect((await createAt(base, cookieHeader, csrf)).status).toBe(201);
    const pending = requestWithHeldJsonBody(
      base,
      '/voice/sessions/session-1/playback',
      cookieHeader,
      csrf,
      { outputId: 'output-1', status: 'played' },
    );
    await nextTurn();

    now += 1_001;
    pending.release();
    expect((await pending.response).status).toBe(401);
    expect(service.playbackReports).toEqual([]);
  });

  it('closes a session created after its login was revoked', async () => {
    const service = new FakeVoiceSessionService();
    const server = await startServer(service);
    const base = `http://127.0.0.1:${server.port}`;
    const login = await loginAt(base);
    const cookies = getSetCookies(login);
    const sessionCookie = cookieValue(cookies, VOICE_SESSION_COOKIE);
    const csrf = cookieValue(cookies, VOICE_CSRF_COOKIE);
    const cookieHeader = `${VOICE_SESSION_COOKIE}=${sessionCookie}; ${VOICE_CSRF_COOKIE}=${csrf}`;
    const gate = service.holdNextCreate();
    const createPromise = createAt(base, cookieHeader, csrf);
    await gate.started;

    const logout = await fetch(`${base}/voice/logout`, {
      method: 'POST',
      headers: { cookie: cookieHeader, origin: ORIGIN, 'x-csrf-token': csrf },
    });
    expect(logout.status).toBe(200);

    gate.release();
    const create = await createPromise;
    expect(create.status).toBe(401);
    expect(service.closedReasons).toContain('logout');
  });

  it('reconciles terminal service state before enforcing the session limit', async () => {
    const service = new FakeVoiceSessionService();
    const server = await startServer(service, { maxConcurrentSessions: 1 });
    const base = `http://127.0.0.1:${server.port}`;
    const login = await loginAt(base);
    const cookies = getSetCookies(login);
    const sessionCookie = cookieValue(cookies, VOICE_SESSION_COOKIE);
    const csrf = cookieValue(cookies, VOICE_CSRF_COOKIE);
    const cookieHeader = `${VOICE_SESSION_COOKIE}=${sessionCookie}; ${VOICE_CSRF_COOKIE}=${csrf}`;

    const first = await createAt(base, cookieHeader, csrf);
    expect(first.status).toBe(201);
    service.markTerminal('session-1', 'expired');

    const second = await createAt(base, cookieHeader, csrf);
    expect(second.status).toBe(201);
    expect(((await second.json()) as { session: VoiceSessionStatusDto }).session.id).toBe(
      'session-2',
    );
  });

  it('reconciles an expired session with the current login before a new call', async () => {
    let now = 3_000_000;
    const auth = new VoiceAuth({ accessToken: 'secret', sessionTtlMs: 1_000, now: () => now });
    const service = new FakeVoiceSessionService();
    const server = await startServer(service, { maxConcurrentSessions: 1 }, auth);
    const base = `http://127.0.0.1:${server.port}`;
    const firstLogin = await loginAt(base);
    const firstCookies = getSetCookies(firstLogin);
    const firstSessionCookie = cookieValue(firstCookies, VOICE_SESSION_COOKIE);
    const firstCsrf = cookieValue(firstCookies, VOICE_CSRF_COOKIE);
    const firstCookieHeader =
      `${VOICE_SESSION_COOKIE}=${firstSessionCookie}; ` + `${VOICE_CSRF_COOKIE}=${firstCsrf}`;
    expect((await createAt(base, firstCookieHeader, firstCsrf)).status).toBe(201);
    service.markTerminal('session-1', 'expired');
    service.rejectStoredStatusRevision('session-1');

    now += 1_001;
    const expiredStatus = await fetch(`${base}/voice/sessions/session-1`, {
      headers: { cookie: firstCookieHeader, origin: ORIGIN },
    });
    expect(expiredStatus.status).toBe(401);

    const secondLogin = await loginAt(base);
    const secondCookies = getSetCookies(secondLogin);
    const secondSessionCookie = cookieValue(secondCookies, VOICE_SESSION_COOKIE);
    const secondCsrf = cookieValue(secondCookies, VOICE_CSRF_COOKIE);
    const second = await createAt(
      base,
      `${VOICE_SESSION_COOKIE}=${secondSessionCookie}; ${VOICE_CSRF_COOKIE}=${secondCsrf}`,
      secondCsrf,
    );
    expect(second.status).toBe(201);
    expect(((await second.json()) as { session: VoiceSessionStatusDto }).session.id).toBe(
      'session-2',
    );
  });

  it('reconciles a terminal session after auth invalidation and relogin', async () => {
    const auth = new VoiceAuth({ accessToken: 'secret' });
    const service = new FakeVoiceSessionService();
    const server = await startServer(service, { maxConcurrentSessions: 1 }, auth);
    const base = `http://127.0.0.1:${server.port}`;
    const firstLogin = await loginAt(base);
    const firstCookies = getSetCookies(firstLogin);
    const firstSessionCookie = cookieValue(firstCookies, VOICE_SESSION_COOKIE);
    const firstCsrf = cookieValue(firstCookies, VOICE_CSRF_COOKIE);
    const firstCookieHeader =
      `${VOICE_SESSION_COOKIE}=${firstSessionCookie}; ` + `${VOICE_CSRF_COOKIE}=${firstCsrf}`;
    expect((await createAt(base, firstCookieHeader, firstCsrf)).status).toBe(201);
    service.markTerminal('session-1', 'closed');
    service.rejectStoredStatusRevision('session-1');

    const firstSession = auth
      .authenticate({ headers: { cookie: firstCookieHeader } })
      ._unsafeUnwrap();
    auth.revoke(firstSession);
    const revokedStatus = await fetch(`${base}/voice/sessions/session-1`, {
      headers: { cookie: firstCookieHeader, origin: ORIGIN },
    });
    expect(revokedStatus.status).toBe(401);

    const secondLogin = await loginAt(base);
    const secondCookies = getSetCookies(secondLogin);
    const secondSessionCookie = cookieValue(secondCookies, VOICE_SESSION_COOKIE);
    const secondCsrf = cookieValue(secondCookies, VOICE_CSRF_COOKIE);
    const second = await createAt(
      base,
      `${VOICE_SESSION_COOKIE}=${secondSessionCookie}; ${VOICE_CSRF_COOKIE}=${secondCsrf}`,
      secondCsrf,
    );
    expect(second.status).toBe(201);
    expect(((await second.json()) as { session: VoiceSessionStatusDto }).session.id).toBe(
      'session-2',
    );
  });

  it('keeps an active session reserved after a same-owner relogin', async () => {
    const service = new FakeVoiceSessionService();
    const server = await startServer(service, { maxConcurrentSessions: 1 });
    const base = `http://127.0.0.1:${server.port}`;
    const firstLogin = await loginAt(base);
    const firstCookies = getSetCookies(firstLogin);
    const firstSessionCookie = cookieValue(firstCookies, VOICE_SESSION_COOKIE);
    const firstCsrf = cookieValue(firstCookies, VOICE_CSRF_COOKIE);
    expect(
      (
        await createAt(
          base,
          `${VOICE_SESSION_COOKIE}=${firstSessionCookie}; ${VOICE_CSRF_COOKIE}=${firstCsrf}`,
          firstCsrf,
        )
      ).status,
    ).toBe(201);

    const secondLogin = await loginAt(base);
    const secondCookies = getSetCookies(secondLogin);
    const secondSessionCookie = cookieValue(secondCookies, VOICE_SESSION_COOKIE);
    const secondCsrf = cookieValue(secondCookies, VOICE_CSRF_COOKIE);
    const second = await createAt(
      base,
      `${VOICE_SESSION_COOKIE}=${secondSessionCookie}; ${VOICE_CSRF_COOKIE}=${secondCsrf}`,
      secondCsrf,
    );
    expect(second.status).toBe(429);
    expect((await second.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'SESSION_LIMIT' },
    });
  });
});

async function startServer(
  service: FakeVoiceSessionService,
  overrides: Partial<BrowserVoiceServerConfig> = {},
  auth?: VoiceAuth,
): Promise<BrowserVoiceServer> {
  const config = {
    accessToken: 'secret',
    allowedOrigins: [ORIGIN],
    ...overrides,
  };
  const server = auth
    ? new BrowserVoiceServer(config, { sessionService: service, auth })
    : new BrowserVoiceServer(config, service);
  activeServers.push(server);
  await server.start();
  return server;
}

async function loginAt(base: string): Promise<Response> {
  return fetch(`${base}/voice/login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ accessToken: 'secret' }),
  });
}

function getSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return (
    headers.getSetCookie?.() ?? response.headers.get('set-cookie')?.split(/, (?=[^;]+=)/u) ?? []
  );
}

function cookieValue(cookies: readonly string[], name: string): string {
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Cookie ${name} missing`);
  const value = cookie.slice(name.length + 1).split(';', 1)[0];
  return value;
}

function createAt(base: string, cookieHeader: string, csrf: string): Promise<Response> {
  return fetch(`${base}/voice/sessions`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      origin: ORIGIN,
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    },
    body: JSON.stringify({ transport: { type: 'webrtc', sdp: 'offer' } }),
  });
}

function createWithHeldBody(
  base: string,
  cookieHeader: string,
  csrf: string,
): { response: Promise<{ status: number; body: string }>; release: () => void } {
  return requestWithHeldJsonBody(base, '/voice/sessions', cookieHeader, csrf, {
    transport: { type: 'webrtc', sdp: 'offer' },
  });
}

function requestWithHeldJsonBody(
  base: string,
  path: string,
  cookieHeader: string,
  csrf: string,
  body: unknown,
): { response: Promise<{ status: number; body: string }>; release: () => void } {
  const payload = JSON.stringify(body);
  const prefixLength = Math.max(1, Math.floor(payload.length / 2));
  const prefix = payload.slice(0, prefixLength);
  const suffix = payload.slice(prefixLength);
  let resolveResponse!: (value: { status: number; body: string }) => void;
  let rejectResponse!: (cause: unknown) => void;
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const request = httpRequest(
    new URL(path, base),
    {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        origin: ORIGIN,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-csrf-token': csrf,
      },
    },
    (incoming) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => {
        body += chunk;
      });
      incoming.on('end', () => {
        resolveResponse({ status: incoming.statusCode ?? 0, body });
      });
    },
  );
  request.once('error', rejectResponse);
  request.flushHeaders();
  request.write(prefix);
  return { response, release: () => request.end(suffix) };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeClient(sessionId: string): VoiceClientSessionDescriptor {
  return {
    transport: 'webrtc',
    sessionId,
    providerSessionId: `provider-${sessionId}`,
    answer: { type: 'webrtc', sdp: 'answer' },
    expiresAt: Date.now() + 60_000,
  };
}

function makeRecord(id: string, owner: VoiceOwnerContext): VoiceSessionRecord {
  const finalization: VoiceFinalizationState = { status: 'pending' };
  return {
    id,
    revision: 1,
    owner,
    personaId: 'voice',
    threadId: `thread-${id}`,
    transport: 'webrtc',
    status: 'connected',
    providerSessionId: `provider-${id}`,
    createdAt: Date.now(),
    startedAt: Date.now(),
    deadlineAt: Date.now() + 60_000,
    policy: {
      generation: 1,
      ownerId: owner.ownerId,
      personaId: 'voice',
      providerName: 'fake',
      modelName: 'fake',
      voiceName: 'marin',
      capabilityNames: [],
      allowedToolNames: [],
      allowedMcpServerNames: [],
      nativeToolNames: [],
      requireApproval: false,
      loginRevision: owner.loginRevision,
      capturedAt: Date.now(),
    },
    usage: { voiceCostStatus: 'unavailable', backendCostStatus: 'unavailable' },
    finalization,
  };
}

function toStatus(record: VoiceSessionRecord): VoiceSessionStatusDto {
  return {
    id: record.id,
    status: record.status,
    transport: record.transport,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    deadlineAt: record.deadlineAt,
    closedAt: record.closedAt,
    delegations: [],
    usage: record.usage,
    finalization: record.finalization,
  };
}
