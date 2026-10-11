/**
 * Loopback HTTP adapter for the browser voice boundary.
 *
 * The adapter owns HTTP authentication, request validation, redacted errors,
 * and the browser-facing status stream.  VoiceSessionService remains the
 * authority for session state and is injected so this server has no provider
 * dependency.
 */

import { promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';
import pino, { type Logger } from 'pino';
import {
  VoiceAuth,
  VoiceAuthError,
  type VoiceAuthConfig,
  type VoiceAuthSession,
} from '../../voice-auth.js';
import type {
  VoiceCloseReason,
  VoiceCreateSessionHttpRequest,
  VoiceErrorHttpResponse,
  VoiceOwnerContext,
  VoiceSessionCreateResult,
  VoiceSessionRecord,
  VoiceSessionService,
  VoiceSessionStatusDto,
  VoiceStatusEventDto,
} from '../../voice-types.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const DEFAULT_MAX_SDP_BYTES = 64 * 1024;
const DEFAULT_MAX_CONCURRENT_SESSIONS = 1;
const DEFAULT_CREATION_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_SESSION_CREATIONS = 5;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 1000;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_OUTPUT_ID_LENGTH = 256;
const VOICE_PREFIX = '/voice';

const DEFAULT_ALLOWED_ORIGINS = new Set([
  'http://localhost',
  'https://localhost',
  'http://127.0.0.1',
  'https://127.0.0.1',
  'http://[::1]',
  'https://[::1]',
]);

const DEFAULT_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Talon Voice</title></head>
  <body><main><h1>Talon Voice</h1><p>Voice is enabled on this Talon instance.</p></main></body>
</html>
`;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const CLOSE_REASONS: readonly VoiceCloseReason[] = [
  'hangup',
  'logout',
  'deadline',
  'shutdown',
  'transport_failure',
];

const PLAYBACK_STATUSES = ['started', 'played', 'interrupted'] as const;

export interface BrowserVoiceServerConfig extends Omit<VoiceAuthConfig, 'accessToken'> {
  /** Required unless an already configured `auth` dependency is injected. */
  readonly accessToken?: string;
  readonly host?: string;
  readonly port?: number;
  /** Directory containing browser assets. The directory is never user-selected. */
  readonly staticDirectory?: string;
  readonly allowedOrigins?: readonly string[];
  readonly allowedTransportTypes?: readonly string[];
  readonly maxRequestBytes?: number;
  readonly maxSdpBytes?: number;
  readonly maxConcurrentSessions?: number;
  readonly maxSessionCreations?: number;
  readonly sessionCreationWindowMs?: number;
  readonly heartbeatIntervalMs?: number;
}

export interface BrowserVoiceServerDependencies {
  readonly sessionService: VoiceSessionService;
  readonly auth?: VoiceAuth;
  readonly logger?: Logger;
}

interface CreationState {
  count: number;
  startedAt: number;
}

interface StatusStream {
  readonly response: ServerResponse;
  readonly request: IncomingMessage;
  readonly sessionId: string;
  unsubscribe?: () => void;
  heartbeat?: NodeJS.Timeout;
  closed: boolean;
}

interface HttpFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

class RequestFailure extends Error {
  constructor(readonly failure: HttpFailure) {
    super(failure.message);
    this.name = 'RequestFailure';
  }
}

/**
 * Authenticated browser voice HTTP server.
 *
 * The listener defaults to loopback.  A reverse proxy may terminate HTTPS
 * before forwarding to this server; it can be represented with
 * `secureCookies` or `x-forwarded-proto: https`.
 */
export class BrowserVoiceServer {
  private readonly config: BrowserVoiceServerConfig;
  private readonly sessionService: VoiceSessionService;
  private readonly auth: VoiceAuth;
  private readonly logger: Logger;
  private readonly staticDirectory: string | undefined;
  private readonly allowedOrigins: readonly string[] | undefined;
  private readonly allowedTransportTypes: readonly string[];
  private readonly maxRequestBytes: number;
  private readonly maxSdpBytes: number;
  private readonly streams = new Set<StatusStream>();
  private readonly activeSessionIds = new Set<string>();
  private creatingSessions = 0;
  private readonly sessionsByAuthCookie = new Map<string, Set<string>>();
  private readonly sessionOwners = new Map<string, VoiceOwnerContext>();
  private readonly creationStates = new Map<string, CreationState>();

  private server: Server | null = null;
  private startPromise: Promise<number> | null = null;

  constructor(
    config: BrowserVoiceServerConfig,
    sessionService: VoiceSessionService,
    logger?: Logger,
  );
  constructor(config: BrowserVoiceServerConfig, dependencies: BrowserVoiceServerDependencies);
  constructor(
    config: BrowserVoiceServerConfig,
    sessionServiceOrDependencies: VoiceSessionService | BrowserVoiceServerDependencies,
    logger?: Logger,
  ) {
    this.config = config;
    if (isDependencies(sessionServiceOrDependencies)) {
      this.sessionService = sessionServiceOrDependencies.sessionService;
      this.auth = sessionServiceOrDependencies.auth ?? new VoiceAuth(requireAccessToken(config));
      this.logger = sessionServiceOrDependencies.logger ?? logger ?? silentLogger();
    } else {
      this.sessionService = sessionServiceOrDependencies;
      this.auth = new VoiceAuth(requireAccessToken(config));
      this.logger = logger ?? silentLogger();
    }

    this.staticDirectory = config.staticDirectory;
    this.allowedOrigins = config.allowedOrigins;
    this.allowedTransportTypes = config.allowedTransportTypes ?? ['webrtc'];
    this.maxRequestBytes = config.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.maxSdpBytes = config.maxSdpBytes ?? DEFAULT_MAX_SDP_BYTES;
    validatePositiveLimit(config.maxRequestBytes, 'maxRequestBytes');
    validatePositiveLimit(config.maxSdpBytes, 'maxSdpBytes');
    validatePositiveLimit(config.maxConcurrentSessions, 'maxConcurrentSessions');
    validatePositiveLimit(config.maxSessionCreations, 'maxSessionCreations');
    validatePositiveLimit(config.sessionCreationWindowMs, 'sessionCreationWindowMs');
    validatePositiveLimit(config.heartbeatIntervalMs, 'heartbeatIntervalMs');
    if (this.allowedTransportTypes.length === 0) {
      throw new Error('BrowserVoiceServer requires at least one transport type');
    }
  }

  /** Actual port after the listener has started; zero means not listening. */
  get port(): number {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : 0;
  }

  /** Start on a loopback interface and return the bound port. */
  start(
    host = this.config.host ?? DEFAULT_HOST,
    port = this.config.port ?? DEFAULT_PORT,
  ): Promise<number> {
    assertLoopbackHost(host);
    if (this.server) return Promise.resolve(this.port);
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise<number>((resolveStart, rejectStart) => {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response).catch((cause: unknown) => {
          this.handleUnexpectedError(response, cause);
        });
      });
      this.server = server;

      const onError = (cause: Error): void => {
        this.server = null;
        this.startPromise = null;
        rejectStart(cause);
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        server.on('error', (cause: Error) => {
          this.logger.error({ err: cause.name }, 'browser voice server error');
        });
        this.logger.info({ host, port: this.port }, 'browser voice server started');
        resolveStart(this.port);
      });
    });

    return this.startPromise;
  }

  /** Stop the transient listener and all status streams. */
  stop(): Promise<void> {
    if (!this.server) return Promise.resolve();
    const server = this.server;
    this.server = null;
    this.startPromise = null;
    for (const stream of [...this.streams]) this.closeStream(stream);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();

    return new Promise<void>((resolveStop, rejectStop) => {
      server.close((cause) => {
        if (cause) rejectStop(cause);
        else resolveStop();
      });
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    applySecurityHeaders(response, requestId);

    let url: URL;
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    } catch {
      this.writeError(response, requestId, {
        status: 400,
        code: 'INVALID_REQUEST',
        message: 'Invalid request',
      });
      return;
    }

    if (request.method === 'OPTIONS') {
      this.handleOptions(request, response, requestId);
      return;
    }

    if (isStaticPath(url.pathname) && request.method === 'GET') {
      await this.serveAsset(url.pathname, response);
      return;
    }

    if (!url.pathname.startsWith(`${VOICE_PREFIX}/`)) {
      this.writeError(response, requestId, {
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      return;
    }

    if (!this.isAllowedOrigin(request)) {
      this.writeError(response, requestId, {
        status: 403,
        code: 'ORIGIN_DENIED',
        message: 'Request origin is not allowed',
      });
      return;
    }
    applyCorsHeaders(response, request.headers.origin);

    const route = url.pathname.slice(VOICE_PREFIX.length);
    if ((route === '/login' || route === '/auth/login') && request.method === 'POST') {
      await this.handleLogin(request, response, requestId);
      return;
    }
    if ((route === '/logout' || route === '/auth/logout') && request.method === 'POST') {
      await this.handleLogout(request, response, requestId);
      return;
    }
    if (route === '/healthz' && request.method === 'GET') {
      this.writeJson(response, 200, { ok: true });
      return;
    }
    if (route === '/sessions' && request.method === 'POST') {
      await this.handleCreateSession(request, response, requestId);
      return;
    }

    const sessionRoute = parseSessionRoute(route);
    if (!sessionRoute) {
      this.writeError(response, requestId, {
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      return;
    }

    if (sessionRoute.action === 'status' && request.method === 'GET') {
      this.handleStatus(request, response, requestId, sessionRoute.sessionId);
      return;
    }
    if (sessionRoute.action === 'stream' && request.method === 'GET') {
      this.handleStream(request, response, requestId, sessionRoute.sessionId);
      return;
    }
    if (sessionRoute.action === 'close' && request.method === 'POST') {
      await this.handleClose(request, response, requestId, sessionRoute.sessionId);
      return;
    }
    if (sessionRoute.action === 'playback' && request.method === 'POST') {
      await this.handlePlayback(request, response, requestId, sessionRoute.sessionId);
      return;
    }

    this.writeError(response, requestId, { status: 404, code: 'NOT_FOUND', message: 'Not found' });
  }

  private handleOptions(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
  ): void {
    if (!this.isAllowedOrigin(request)) {
      this.writeError(response, requestId, {
        status: 403,
        code: 'ORIGIN_DENIED',
        message: 'Request origin is not allowed',
      });
      return;
    }
    applyCorsHeaders(response, request.headers.origin);
    response.writeHead(204);
    response.end();
  }

  private async handleLogin(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(request, this.maxRequestBytes);
    } catch (cause) {
      this.writeRequestFailure(response, requestId, cause);
      return;
    }
    const accessToken = readStringProperty(body, 'accessToken');
    if (accessToken === null || Buffer.byteLength(accessToken, 'utf8') > 1024) {
      this.writeError(response, requestId, {
        status: 400,
        code: 'INVALID_REQUEST',
        message: 'Invalid request',
      });
      return;
    }

    const result = this.auth.login(accessToken, {
      remoteAddress: request.socket.remoteAddress,
      secure: this.isSecureRequest(request),
    });
    if (result.isErr()) {
      const status =
        result.error instanceof VoiceAuthError && result.error.kind === 'rate_limited' ? 429 : 401;
      this.writeError(response, requestId, {
        status,
        code: status === 429 ? 'RATE_LIMITED' : 'UNAUTHORIZED',
        message: status === 429 ? 'Too many login attempts' : 'Authentication failed',
      });
      return;
    }

    applyCorsHeaders(response, request.headers.origin);
    response.setHeader('set-cookie', result.value.cookies);
    this.writeJson(response, 200, result.value.response);
  }

  private async handleLogout(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
  ): Promise<void> {
    const authenticated = this.authenticate(request, response, requestId, true);
    if (!authenticated) return;

    const sessionIds = this.sessionsByAuthCookie.get(authenticated.cookieValue);
    if (sessionIds) {
      for (const sessionId of [...sessionIds]) {
        try {
          await this.sessionService.closeSession(authenticated.owner, sessionId, {
            reason: 'logout',
          });
        } catch {
          // Revocation is still required when cleanup is unavailable. The
          // server must never keep an authentication cookie alive on a
          // best-effort cleanup failure.
        }
        this.activeSessionIds.delete(sessionId);
      }
      this.sessionsByAuthCookie.delete(authenticated.cookieValue);
    }
    this.auth.revoke(authenticated);
    response.setHeader('set-cookie', this.auth.clearCookieHeaders(this.isSecureRequest(request)));
    this.writeJson(response, 200, { loggedOut: true });
  }

  private async handleCreateSession(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
  ): Promise<void> {
    const authenticated = this.authenticate(request, response, requestId, true);
    if (!authenticated) return;
    const maxConcurrentSessions =
      this.config.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
    if (this.activeSessionIds.size + this.creatingSessions >= maxConcurrentSessions) {
      this.writeError(response, requestId, {
        status: 429,
        code: 'SESSION_LIMIT',
        message: 'A voice session is already active',
      });
      return;
    }
    this.creatingSessions += 1;
    try {
      if (!this.consumeCreation(authenticated.owner.ownerId)) {
        this.writeError(response, requestId, {
          status: 429,
          code: 'RATE_LIMITED',
          message: 'Too many session creations',
        });
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(request, this.maxRequestBytes);
      } catch (cause) {
        this.writeRequestFailure(response, requestId, cause);
        return;
      }
      const parsed = this.parseCreateRequest(body);
      if (parsed instanceof RequestFailure) {
        this.writeError(response, requestId, parsed.failure);
        return;
      }

      let result: Awaited<ReturnType<VoiceSessionService['createSession']>>;
      try {
        result = await this.sessionService.createSession(authenticated.owner, parsed);
      } catch {
        this.writeError(response, requestId, {
          status: 500,
          code: 'VOICE_ERROR',
          message: 'Voice request failed',
        });
        return;
      }
      if (result.isErr()) {
        this.writeDomainError(response, requestId, result.error);
        return;
      }

      const sessionId = result.value.session.id;
      this.activeSessionIds.add(sessionId);
      this.sessionOwners.set(sessionId, authenticated.owner);
      let owned = this.sessionsByAuthCookie.get(authenticated.cookieValue);
      if (!owned) {
        owned = new Set<string>();
        this.sessionsByAuthCookie.set(authenticated.cookieValue, owned);
      }
      owned.add(sessionId);
      const status = this.statusFromCreateResult(authenticated, result.value);
      applyCorsHeaders(response, request.headers.origin);
      this.writeJson(response, 201, {
        session: status,
        client: result.value.client,
      });
    } finally {
      this.creatingSessions -= 1;
    }
  }

  private handleStatus(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    sessionId: string,
  ): void {
    const authenticated = this.authenticate(request, response, requestId, false);
    if (!authenticated) return;
    const status = this.readStatus(authenticated, sessionId);
    if (status === null) {
      this.writeError(response, requestId, {
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      return;
    }
    if (status instanceof RequestFailure) {
      this.writeError(response, requestId, status.failure);
      return;
    }
    applyCorsHeaders(response, request.headers.origin);
    this.writeJson(response, 200, { session: status });
  }

  private async handleClose(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    sessionId: string,
  ): Promise<void> {
    const authenticated = this.authenticate(request, response, requestId, true);
    if (!authenticated) return;
    if (!isPlausibleSessionId(sessionId)) {
      this.writeError(response, requestId, {
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      return;
    }
    if (!this.ownerMatches(sessionId, authenticated.owner)) {
      this.writeError(response, requestId, {
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(request, this.maxRequestBytes);
    } catch (cause) {
      this.writeRequestFailure(response, requestId, cause);
      return;
    }
    const reason = readStringProperty(body, 'reason');
    if (reason === null || !CLOSE_REASONS.includes(reason as VoiceCloseReason)) {
      this.writeError(response, requestId, {
        status: 400,
        code: 'INVALID_REQUEST',
        message: 'Invalid request',
      });
      return;
    }

    let result: Awaited<ReturnType<VoiceSessionService['closeSession']>>;
    try {
      result = await this.sessionService.closeSession(authenticated.owner, sessionId, {
        reason: reason as VoiceCloseReason,
      });
    } catch {
      this.writeError(response, requestId, {
        status: 500,
        code: 'VOICE_ERROR',
        message: 'Voice request failed',
      });
      return;
    }
    if (result.isErr()) {
      this.writeDomainError(response, requestId, result.error);
      return;
    }

    this.activeSessionIds.delete(sessionId);
    this.sessionsByAuthCookie.get(authenticated.cookieValue)?.delete(sessionId);
    const status = this.statusAfterMutation(authenticated, sessionId, result.value.session);
    applyCorsHeaders(response, request.headers.origin);
    this.writeJson(response, 200, {
      session: status,
      pendingDelegation: result.value.pendingDelegation,
    });
  }

  private async handlePlayback(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    sessionId: string,
  ): Promise<void> {
    const authenticated = this.authenticate(request, response, requestId, true);
    if (!authenticated) return;
    if (!isPlausibleSessionId(sessionId)) {
      this.writeError(response, requestId, {
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      return;
    }
    if (!this.ownerMatches(sessionId, authenticated.owner)) {
      this.writeError(response, requestId, {
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(request, this.maxRequestBytes);
    } catch (cause) {
      this.writeRequestFailure(response, requestId, cause);
      return;
    }
    const outputId = readStringProperty(body, 'outputId');
    const playbackStatus = readStringProperty(body, 'status');
    if (
      outputId === null ||
      outputId.length > MAX_OUTPUT_ID_LENGTH ||
      playbackStatus === null ||
      !PLAYBACK_STATUSES.includes(playbackStatus as (typeof PLAYBACK_STATUSES)[number])
    ) {
      this.writeError(response, requestId, {
        status: 400,
        code: 'INVALID_REQUEST',
        message: 'Invalid request',
      });
      return;
    }

    let result: Awaited<ReturnType<VoiceSessionService['reportPlayback']>>;
    try {
      result = await this.sessionService.reportPlayback(authenticated.owner, sessionId, {
        outputId,
        status: playbackStatus as 'started' | 'played' | 'interrupted',
        reportedAt: Date.now(),
      });
    } catch {
      this.writeError(response, requestId, {
        status: 500,
        code: 'VOICE_ERROR',
        message: 'Voice request failed',
      });
      return;
    }
    if (result.isErr()) {
      this.writeDomainError(response, requestId, result.error);
      return;
    }
    applyCorsHeaders(response, request.headers.origin);
    response.writeHead(204);
    response.end();
  }

  private handleStream(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    sessionId: string,
  ): void {
    const authenticated = this.authenticate(request, response, requestId, false);
    if (!authenticated) return;
    if (!isPlausibleSessionId(sessionId)) {
      this.writeError(response, requestId, {
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      return;
    }
    if (!this.ownerMatches(sessionId, authenticated.owner)) {
      this.writeError(response, requestId, {
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      return;
    }

    const status = this.readStatus(authenticated, sessionId);
    if (status === null) {
      this.writeError(response, requestId, {
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      return;
    }
    if (status instanceof RequestFailure) {
      this.writeError(response, requestId, status.failure);
      return;
    }

    const streamHolder: { current?: StatusStream } = {};
    const subscribed = this.sessionService.subscribe(authenticated.owner, sessionId, (event) => {
      if (streamHolder.current) this.writeStatusEvent(streamHolder.current, event);
    });
    if (subscribed.isErr()) {
      this.writeDomainError(response, requestId, subscribed.error);
      return;
    }

    const stream: StatusStream = {
      request,
      response,
      sessionId,
      unsubscribe: subscribed.value,
      closed: false,
    };
    streamHolder.current = stream;
    this.streams.add(stream);
    applyCorsHeaders(response, request.headers.origin);
    response.writeHead(200, {
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    });
    this.writeStatusEvent(stream, {
      kind: 'session',
      version: 0,
      session: status,
      occurredAt: Date.now(),
    });
    stream.heartbeat = setInterval(() => {
      if (!stream.closed && !response.writableEnded) response.write(': keep-alive\n\n');
    }, this.config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
    request.once('aborted', () => this.closeStream(stream));
    response.once('close', () => this.closeStream(stream));
  }

  private authenticate(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    requireCsrf: boolean,
  ): VoiceAuthSession | null {
    const result = this.auth.authenticate(request);
    if (result.isErr()) {
      this.writeError(response, requestId, {
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
      return null;
    }
    if (requireCsrf) {
      const csrfResult = this.auth.verifyCsrf(request, result.value);
      if (csrfResult.isErr()) {
        this.writeError(response, requestId, {
          status: 403,
          code: 'CSRF_DENIED',
          message: 'CSRF validation failed',
        });
        return null;
      }
    }
    return result.value;
  }

  private readStatus(
    owner: VoiceAuthSession,
    sessionId: string,
  ): VoiceSessionStatusDto | RequestFailure | null {
    if (!isPlausibleSessionId(sessionId)) return null;
    if (!this.ownerMatches(sessionId, owner.owner)) return null;
    try {
      const result = this.sessionService.status(owner.owner, sessionId);
      if (result.isErr()) {
        return new RequestFailure({ status: 404, code: 'NOT_FOUND', message: 'Not found' });
      }
      return result.value;
    } catch {
      return new RequestFailure({
        status: 500,
        code: 'VOICE_ERROR',
        message: 'Voice request failed',
      });
    }
  }

  private ownerMatches(sessionId: string, owner: VoiceOwnerContext): boolean {
    const boundOwner = this.sessionOwners.get(sessionId);
    return (
      boundOwner === undefined ||
      (boundOwner.ownerId === owner.ownerId && boundOwner.loginRevision === owner.loginRevision)
    );
  }

  private statusAfterMutation(
    owner: VoiceAuthSession,
    sessionId: string,
    fallback: VoiceSessionRecord,
  ): VoiceSessionStatusDto {
    const status = this.readStatus(owner, sessionId);
    if (status !== null && !(status instanceof RequestFailure)) return status;
    return sessionRecordToStatus(fallback);
  }

  private statusFromCreateResult(
    owner: VoiceAuthSession,
    result: VoiceSessionCreateResult,
  ): VoiceSessionStatusDto {
    const status = this.readStatus(owner, result.session.id);
    if (status !== null && !(status instanceof RequestFailure)) return status;
    return sessionRecordToStatus(result.session);
  }

  private parseCreateRequest(body: unknown): VoiceCreateSessionHttpRequest | RequestFailure {
    if (!isRecord(body) || !isRecord(body.transport)) {
      return new RequestFailure({
        status: 400,
        code: 'INVALID_REQUEST',
        message: 'Invalid request',
      });
    }
    const type = readStringProperty(body.transport, 'type');
    const sdp = readStringProperty(body.transport, 'sdp');
    if (
      type === null ||
      sdp === null ||
      type.length === 0 ||
      type.length > 64 ||
      !this.allowedTransportTypes.includes(type)
    ) {
      return new RequestFailure({
        status: 400,
        code: 'INVALID_REQUEST',
        message: 'Invalid request',
      });
    }
    if (Buffer.byteLength(sdp, 'utf8') > this.maxSdpBytes) {
      return new RequestFailure({
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Payload too large',
      });
    }
    return { transport: { type, sdp } };
  }

  private consumeCreation(ownerId: string): boolean {
    const now = Date.now();
    const windowMs = this.config.sessionCreationWindowMs ?? DEFAULT_CREATION_WINDOW_MS;
    const max = this.config.maxSessionCreations ?? DEFAULT_MAX_SESSION_CREATIONS;
    const current = this.creationStates.get(ownerId);
    if (!current || now - current.startedAt >= windowMs) {
      this.creationStates.set(ownerId, { count: 1, startedAt: now });
      return true;
    }
    if (current.count >= max) return false;
    current.count += 1;
    return true;
  }

  private isAllowedOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') return false;
    if (this.allowedOrigins) return this.allowedOrigins.includes(origin);
    if (DEFAULT_ALLOWED_ORIGINS.has(origin)) return true;
    const host = request.headers.host;
    if (!host) return false;
    try {
      const originUrl = new URL(origin);
      const hostUrl = new URL(`${originUrl.protocol}//${host}`);
      return isLoopbackHostname(hostUrl.hostname) && originUrl.origin === hostUrl.origin;
    } catch {
      return false;
    }
  }

  private isSecureRequest(request: IncomingMessage): boolean {
    if (this.config.secureCookies !== undefined) return this.config.secureCookies;
    const forwarded = request.headers['x-forwarded-proto'];
    const protocol = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const socketWithTls = request.socket as typeof request.socket & {
      readonly encrypted?: boolean;
    };
    return (
      protocol?.split(',')[0]?.trim().toLowerCase() === 'https' || socketWithTls.encrypted === true
    );
  }

  private async serveAsset(pathname: string, response: ServerResponse): Promise<void> {
    if (pathname === '/' || pathname === '/voice' || pathname === '/voice/') {
      if (!this.staticDirectory) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(DEFAULT_INDEX_HTML);
        return;
      }
      await this.serveFile(resolve(this.staticDirectory, 'index.html'), response);
      return;
    }

    if (!pathname.startsWith('/voice/')) {
      this.writeError(response, randomUUID(), {
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      return;
    }
    if (!this.staticDirectory) {
      this.writeError(response, randomUUID(), {
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname.slice('/voice/'.length));
    } catch {
      this.writeError(response, randomUUID(), {
        status: 400,
        code: 'INVALID_REQUEST',
        message: 'Invalid request',
      });
      return;
    }
    if (decoded.includes('\0')) {
      this.writeError(response, randomUUID(), {
        status: 400,
        code: 'INVALID_REQUEST',
        message: 'Invalid request',
      });
      return;
    }
    const root = resolve(this.staticDirectory);
    const file = resolve(root, decoded);
    const fileRelative = relative(root, file);
    if (fileRelative.startsWith('..') || fileRelative.includes(`..${'/'}`) || fileRelative === '') {
      this.writeError(response, randomUUID(), {
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      return;
    }
    try {
      const [rootReal, fileReal] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
      const realRelative = relative(rootReal, fileReal);
      if (
        realRelative.startsWith('..') ||
        realRelative.includes(`..${'/'}`) ||
        realRelative === ''
      ) {
        this.writeError(response, randomUUID(), {
          status: 404,
          code: 'NOT_FOUND',
          message: 'Not found',
        });
        return;
      }
      await this.serveFile(fileReal, response);
    } catch {
      response.writeHead(404).end('Not Found');
    }
  }

  private async serveFile(file: string, response: ServerResponse): Promise<void> {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) {
        response.writeHead(404).end('Not Found');
        return;
      }
      const body = await fs.readFile(file);
      const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
      response.writeHead(200, {
        'cache-control': 'no-cache',
        'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('Not Found');
    }
  }

  private closeStream(stream: StatusStream): void {
    if (stream.closed) return;
    stream.closed = true;
    if (stream.heartbeat) clearInterval(stream.heartbeat);
    stream.unsubscribe?.();
    this.streams.delete(stream);
    if (!stream.response.writableEnded) stream.response.end();
  }

  private writeStatusEvent(stream: StatusStream, event: VoiceStatusEventDto): void {
    if (stream.closed || stream.response.writableEnded) return;
    const id = String(event.version);
    stream.response.write(`event: ${event.kind}\nid: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  private writeRequestFailure(response: ServerResponse, requestId: string, cause: unknown): void {
    if (cause instanceof RequestFailure) {
      this.writeError(response, requestId, cause.failure);
    } else {
      this.writeError(response, requestId, {
        status: 400,
        code: 'INVALID_REQUEST',
        message: 'Invalid request',
      });
    }
  }

  private writeDomainError(response: ServerResponse, requestId: string, _error: unknown): void {
    this.writeError(response, requestId, {
      status: 500,
      code: 'VOICE_ERROR',
      message: 'Voice request failed',
    });
  }

  private handleUnexpectedError(response: ServerResponse, cause: unknown): void {
    this.logger.error(
      { err: cause instanceof Error ? cause.name : 'unknown error' },
      'browser voice request failed',
    );
    if (!response.headersSent) {
      this.writeError(response, randomUUID(), {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
    } else if (!response.writableEnded) {
      response.end();
    }
  }

  private writeJson(response: ServerResponse, status: number, body: unknown): void {
    applyCorsHeaders(response, undefined);
    if (response.writableEnded) return;
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  }

  private writeError(response: ServerResponse, requestId: string, failure: HttpFailure): void {
    if (response.writableEnded) return;
    const body: VoiceErrorHttpResponse = {
      error: {
        code: failure.code,
        message: failure.message,
        requestId,
      },
    };
    response.setHeader('x-request-id', requestId);
    response.writeHead(failure.status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  }
}

export function createBrowserVoiceServer(
  config: BrowserVoiceServerConfig,
  sessionService: VoiceSessionService,
  logger?: Logger,
): BrowserVoiceServer {
  return new BrowserVoiceServer(config, sessionService, logger);
}

function isDependencies(
  value: VoiceSessionService | BrowserVoiceServerDependencies,
): value is BrowserVoiceServerDependencies {
  return 'sessionService' in value;
}

function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

function requireAccessToken(config: BrowserVoiceServerConfig): VoiceAuthConfig {
  if (config.accessToken === undefined || config.accessToken.length === 0) {
    throw new Error('BrowserVoiceServer requires accessToken when auth is not injected');
  }
  return { ...config, accessToken: config.accessToken };
}

function validatePositiveLimit(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`BrowserVoiceServer ${name} must be a positive integer`);
  }
}

function assertLoopbackHost(host: string): void {
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error('BrowserVoiceServer only binds to loopback hosts');
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function applySecurityHeaders(response: ServerResponse, requestId: string): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('x-request-id', requestId);
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  );
}

function applyCorsHeaders(response: ServerResponse, origin: string | undefined): void {
  if (origin) response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-credentials', 'true');
  response.setHeader('access-control-allow-headers', 'content-type, x-csrf-token');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('vary', 'Origin');
}

function isStaticPath(pathname: string): boolean {
  if (pathname === '/' || pathname === '/voice' || pathname === '/voice/') return true;
  if (!pathname.startsWith('/voice/')) return false;
  const route = pathname.slice('/voice'.length);
  return !(
    route === '/healthz' ||
    route === '/login' ||
    route === '/logout' ||
    route === '/auth/login' ||
    route === '/auth/logout' ||
    route === '/sessions' ||
    route.startsWith('/sessions/')
  );
}

function parseSessionRoute(
  route: string,
): {
  readonly action: 'status' | 'stream' | 'close' | 'playback';
  readonly sessionId: string;
} | null {
  const match =
    /^\/sessions\/([^/]+)(?:\/(events|stream|status|status-stream|close|playback))?$/.exec(route);
  if (!match) return null;
  const action: 'status' | 'stream' | 'close' | 'playback' =
    match[2] === undefined ||
    match[2] === 'events' ||
    match[2] === 'stream' ||
    match[2] === 'status' ||
    match[2] === 'status-stream'
      ? match[2] === undefined
        ? 'status'
        : 'stream'
      : (match[2] as 'close' | 'playback');
  return { action, sessionId: decodePathSegment(match[1]) };
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

function isPlausibleSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    sessionId.length <= MAX_SESSION_ID_LENGTH &&
    !sessionId.includes('\0') &&
    !sessionId.includes('\r') &&
    !sessionId.includes('\n')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringProperty(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const property = value[key];
  return typeof property === 'string' ? property : null;
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentLength = request.headers['content-length'];
  if (typeof contentLength === 'string') {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new RequestFailure({
        status: 400,
        code: 'INVALID_REQUEST',
        message: 'Invalid request',
      });
    }
    if (parsedLength > maxBytes) {
      request.resume();
      throw new RequestFailure({
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Payload too large',
      });
    }
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    received += bytes.length;
    if (received > maxBytes) {
      request.resume();
      throw new RequestFailure({
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Payload too large',
      });
    }
    chunks.push(bytes);
  }
  if (chunks.length === 0) {
    throw new RequestFailure({ status: 400, code: 'INVALID_REQUEST', message: 'Invalid request' });
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RequestFailure({ status: 400, code: 'INVALID_REQUEST', message: 'Invalid request' });
  }
}

function sessionRecordToStatus(record: VoiceSessionRecord): VoiceSessionStatusDto {
  return {
    id: record.id,
    status: record.status,
    transport: record.transport,
    createdAt: record.createdAt,
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    deadlineAt: record.deadlineAt,
    ...(record.closedAt === undefined ? {} : { closedAt: record.closedAt }),
    delegations: [],
    usage: record.usage,
    finalization: record.finalization,
  };
}
