import { describe, expect, it, afterEach } from 'vitest';
import { err, ok } from '../../../../src/core/types/result.js';
import { PolicyError } from '../../../../src/core/errors/error-types.js';
import { VOICE_CSRF_COOKIE, VOICE_SESSION_COOKIE } from '../../../../src/voice/voice-auth.js';
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
  VoiceSessionStatusDto,
  VoiceStatusEventDto,
  VoiceUnsubscribe,
} from '../../../../src/voice/voice-types.js';

const ORIGIN = 'http://127.0.0.1';

class FakeVoiceSessionService implements VoiceSessionService {
  readonly closedReasons: string[] = [];
  private nextId = 1;
  private readonly sessions = new Map<string, { ownerId: string; record: VoiceSessionRecord }>();
  private handler: VoiceEventHandler<VoiceStatusEventDto> | undefined;

  async createSession(
    owner: VoiceOwnerContext,
    _input: VoiceSessionCreateRequest,
  ): VoiceAsyncResult<VoiceSessionCreateResult> {
    const id = `session-${this.nextId++}`;
    const record = makeRecord(id, owner);
    this.sessions.set(id, { ownerId: owner.ownerId, record });
    return ok({ session: record, client: makeClient(id) });
  }

  status(owner: VoiceOwnerContext, sessionId: string) {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.ownerId !== owner.ownerId) return ok(null);
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
    _report: VoicePlaybackReport,
  ): VoiceAsyncResult<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.ownerId !== owner.ownerId)
      return err(new PolicyError('session owner mismatch'));
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
    const swappedOwner = await fetch(`${base}/voice/sessions/session-1`, {
      headers: {
        cookie: `${VOICE_SESSION_COOKIE}=${secondSessionCookie}`,
        origin: ORIGIN,
      },
    });
    expect(swappedOwner.status).toBe(404);
    expect(service.closedReasons).toEqual([]);
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
      headers: { cookie: cookieHeader, origin: ORIGIN },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body?.getReader();
    if (!reader) throw new Error('stream body missing');
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: session');
    await reader.cancel();

    const logout = await fetch(`${base}/voice/logout`, {
      method: 'POST',
      headers: { cookie: cookieHeader, origin: ORIGIN, 'x-csrf-token': csrf },
    });
    expect(logout.status).toBe(200);
    expect(service.closedReasons).toContain('logout');

    const afterLogout = await fetch(`${base}/voice/sessions/session-1`, {
      headers: { cookie: cookieHeader, origin: ORIGIN },
    });
    expect(afterLogout.status).toBe(401);
  });
});

async function startServer(
  service: FakeVoiceSessionService,
  overrides: Partial<BrowserVoiceServerConfig> = {},
): Promise<BrowserVoiceServer> {
  const server = new BrowserVoiceServer(
    {
      accessToken: 'secret',
      allowedOrigins: [ORIGIN],
      ...overrides,
    },
    service,
  );
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
