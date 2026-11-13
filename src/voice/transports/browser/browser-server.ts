/**
 * HTTP adapter for the browser voice boundary.
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
import {
  VOICE_BROWSER_TELEMETRY_CATEGORIES,
  VOICE_BROWSER_TELEMETRY_STATUSES,
  type VoiceBrowserTelemetryRequest,
  type VoiceBrowserTelemetrySample,
} from '../../voice-types.js';
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
import type {
  VoiceBrowserTelemetryResult,
  VoiceTelemetry,
} from '../../voice-telemetry.js';
import { VoiceCreationRateLimitError } from '../../voice-adapters.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const DEFAULT_MAX_SDP_BYTES = 64 * 1024;
const DEFAULT_MAX_CONCURRENT_SESSIONS = 1;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 1000;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_OUTPUT_ID_LENGTH = 256;
const MAX_TELEMETRY_REQUEST_BYTES = 16 * 1024;
const MAX_TELEMETRY_SAMPLES_PER_BATCH = 16;
const MAX_TELEMETRY_SAMPLES_PER_CALL = 256;
const MAX_TELEMETRY_BATCHES_PER_MINUTE = 6;
const MAX_TELEMETRY_RATE_KEYS = 256;
const MAX_TELEMETRY_DURATION_MS = 86_400_000;
const MAX_TELEMETRY_COUNT = 256;
const TELEMETRY_RATE_WINDOW_MS = 60 * 1000;
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
  '.png': 'image/png',
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

const TERMINAL_SESSION_STATUSES: ReadonlySet<VoiceSessionStatusDto['status']> = new Set([
  'closed',
  'expired',
  'failed',
]);

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
  readonly telemetry?: VoiceTelemetry;
  readonly logger?: Logger;
}

interface TelemetryRateState {
  readonly owner: VoiceOwnerContext;
  readonly sessionId: string;
  windowStartedAt: number;
  acceptedBatches: number;
  acceptedSamples: number;
}

interface StatusStream {
  readonly response: ServerResponse;
  readonly request: IncomingMessage;
  readonly sessionId: string;
  readonly authSession: VoiceAuthSession;
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
  private readonly telemetry: VoiceTelemetry | undefined;
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
  private readonly telemetryRates = new Map<string, TelemetryRateState>();

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
      this.telemetry = sessionServiceOrDependencies.telemetry;
      this.logger = sessionServiceOrDependencies.logger ?? logger ?? silentLogger();
    } else {
      this.sessionService = sessionServiceOrDependencies;
      this.auth = new VoiceAuth(requireAccessToken(config));
      this.telemetry = undefined;
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

  /** Start on the configured interface and return the bound port. */
  start(
    host = this.config.host ?? DEFAULT_HOST,
    port = this.config.port ?? DEFAULT_PORT,
  ): Promise<number> {
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

    const route = url.pathname.slice(VOICE_PREFIX.length);
    const sessionRoute = parseSessionRoute(route);
    const sameOriginRead =
      request.method === 'GET' &&
      (route === '/healthz' ||
        route === '/auth/session' ||
        sessionRoute?.action === 'status' ||
        sessionRoute?.action === 'stream');
    if (!this.isAllowedOrigin(request, sameOriginRead)) {
      this.writeError(response, requestId, {
        status: 403,
        code: 'ORIGIN_DENIED',
        message: 'Request origin is not allowed',
      });
      return;
    }
    applyCorsHeaders(response, request.headers.origin);

    if ((route === '/login' || route === '/auth/login') && request.method === 'POST') {
      await this.handleLogin(request, response, requestId);
      return;
    }
    if ((route === '/logout' || route === '/auth/logout') && request.method === 'POST') {
      await this.handleLogout(request, response, requestId);
      return;
    }
    if (route === '/auth/session' && request.method === 'GET') {
      this.handleAuthSession(request, response, requestId);
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
    if (sessionRoute.action === 'telemetry' && request.method === 'POST') {
      await this.handleTelemetry(request, response, requestId, sessionRoute.sessionId);
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
    const rememberMe = readOptionalBooleanProperty(body, 'rememberMe');
    if (rememberMe === INVALID_BOOLEAN) {
      this.writeError(response, requestId, {
        status: 400,
        code: 'INVALID_REQUEST',
        message: 'Invalid request',
      });
      return;
    }

    const result = this.auth.login(
      rememberMe === undefined ? { accessToken } : { accessToken, rememberMe },
      {
        remoteAddress: request.socket.remoteAddress,
        secure: this.isSecureRequest(request),
      },
    );
    if (result.isErr()) {
      const status = authFailureStatus(result.error, 401);
      this.writeError(response, requestId, {
        status,
        code:
          status === 429
            ? 'RATE_LIMITED'
            : status === 400
              ? 'INVALID_REQUEST'
              : status === 500
                ? 'VOICE_ERROR'
                : 'UNAUTHORIZED',
        message:
          status === 429
            ? 'Too many login attempts'
            : status === 400
              ? 'Invalid request'
              : status === 500
                ? 'Voice request failed'
                : 'Authentication failed',
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

    const revoked = this.auth.revoke(authenticated);
    if (revoked.isErr()) {
      this.writeAuthFailure(response, requestId, revoked.error);
      return;
    }
    this.closeStreamsForAuth(authenticated);
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
        this.forgetActiveSession(sessionId);
      }
      this.sessionsByAuthCookie.delete(authenticated.cookieValue);
    }
    response.setHeader('set-cookie', this.auth.clearCookieHeaders(this.isSecureRequest(request)));
    this.writeJson(response, 200, { loggedOut: true });
  }

  private handleAuthSession(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
  ): void {
    const authenticated = this.authenticate(request, response, requestId, false);
    if (!authenticated) return;
    applyCorsHeaders(response, request.headers.origin);
    this.writeJson(response, 200, {
      authenticated: true,
      expiresAt: authenticated.expiresAt,
    });
  }

  private async handleCreateSession(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
  ): Promise<void> {
    const authenticated = this.authenticate(request, response, requestId, true);
    if (!authenticated) return;
    this.reconcileTerminalSessions(authenticated.owner);
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
      let body: unknown;
      try {
        body = await readJsonBody(request, this.maxRequestBytes);
      } catch (cause) {
        this.writeRequestFailure(response, requestId, cause);
        return;
      }
      if (!this.auth.isActive(authenticated)) {
        this.writeError(response, requestId, {
          status: 401,
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
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
      if (!this.auth.isActive(authenticated)) {
        try {
          await this.sessionService.closeSession(authenticated.owner, sessionId, {
            reason: 'logout',
          });
        } catch {
          // The login is already revoked. Cleanup is best effort and the
          // session is intentionally never admitted to browser state.
        }
        this.writeError(response, requestId, {
          status: 401,
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
        return;
      }
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
    if (!this.auth.isActive(authenticated)) {
      this.writeError(response, requestId, {
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
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

    this.forgetActiveSession(sessionId);
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
    if (!this.auth.isActive(authenticated)) {
      this.writeError(response, requestId, {
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
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

  private async handleTelemetry(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    sessionId: string,
  ): Promise<void> {
    const authenticated = this.authenticate(request, response, requestId, true);
    if (!authenticated) return;
    if (!isPlausibleSessionId(sessionId) || !this.ownerMatchesExact(sessionId, authenticated.owner)) {
      this.writeError(response, requestId, {
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request, Math.min(this.maxRequestBytes, MAX_TELEMETRY_REQUEST_BYTES));
    } catch (cause) {
      this.writeRequestFailure(response, requestId, cause);
      return;
    }
    if (!this.auth.isActive(authenticated)) {
      this.writeError(response, requestId, {
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
      return;
    }
    const parsed = parseTelemetryRequest(body, sessionId);
    if (parsed instanceof RequestFailure) {
      this.writeError(response, requestId, parsed.failure);
      return;
    }
    const outputIds = parsed.samples
      .map((sample) => sample.outputId)
      .filter((outputId): outputId is string => outputId !== undefined);
    if (outputIds.length > 0 && !this.sessionHasOutputs(authenticated.owner, sessionId, outputIds)) {
      this.writeError(response, requestId, {
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      return;
    }
    const rateKey = `${authenticated.owner.ownerId}\u0000${authenticated.owner.loginRevision}\u0000${sessionId}`;
    const rate = this.consumeTelemetryRate(
      rateKey,
      authenticated.owner,
      sessionId,
      parsed.samples.length,
    );
    if (!rate) {
      this.writeError(response, requestId, {
        status: 429,
        code: 'RATE_LIMITED',
        message: 'Too many telemetry samples',
      });
      return;
    }
    let telemetryResult: VoiceBrowserTelemetryResult | undefined;
    try {
      telemetryResult = this.telemetry?.recordBrowserTelemetry(parsed);
    } catch {
      this.writeError(response, requestId, {
        status: 503,
        code: 'VOICE_ERROR',
        message: 'Voice request failed',
      });
      return;
    }
    if (telemetryResult?.droppedCount) {
      this.writeError(response, requestId, {
        status: 503,
        code: 'VOICE_ERROR',
        message: 'Voice request failed',
      });
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
    if (!this.ownerCanRead(sessionId, authenticated.owner)) {
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
      authSession: authenticated,
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
      if (stream.closed || response.writableEnded) return;
      if (!this.auth.isActive(stream.authSession)) {
        this.closeStream(stream);
        return;
      }
      response.write(': keep-alive\n\n');
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
      this.writeAuthFailure(response, requestId, result.error);
      return null;
    }
    if (requireCsrf) {
      const csrfResult = this.auth.verifyCsrf(request, result.value);
      if (csrfResult.isErr()) {
        this.writeAuthFailure(response, requestId, csrfResult.error);
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
    if (!this.ownerCanRead(sessionId, owner.owner)) return null;
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

  private ownerMatchesExact(sessionId: string, owner: VoiceOwnerContext): boolean {
    const boundOwner = this.sessionOwners.get(sessionId);
    return (
      boundOwner !== undefined &&
      boundOwner.ownerId === owner.ownerId &&
      boundOwner.loginRevision === owner.loginRevision
    );
  }

  private sessionHasOutputs(
    owner: VoiceOwnerContext,
    sessionId: string,
    outputIds: readonly string[],
  ): boolean {
    try {
      const result = this.sessionService.status(owner, sessionId);
      if (result.isErr() || !result.value) return false;
      const outputs = new Set<string>();
      for (const delegation of result.value.delegations) {
        for (const output of delegation.outputs) outputs.add(output.id);
      }
      if (result.value.activeDelegation) {
        for (const output of result.value.activeDelegation.outputs) outputs.add(output.id);
      }
      return outputIds.every((outputId) => outputs.has(outputId));
    } catch {
      return false;
    }
  }

  private consumeTelemetryRate(
    key: string,
    owner: VoiceOwnerContext,
    sessionId: string,
    sampleCount: number,
  ): boolean {
    const now = Date.now();
    let state = this.telemetryRates.get(key);
    if (!state) {
      if (this.telemetryRates.size >= MAX_TELEMETRY_RATE_KEYS) {
        this.pruneTelemetryRates();
        if (this.telemetryRates.size >= MAX_TELEMETRY_RATE_KEYS) return false;
      }
      state = {
        owner,
        sessionId,
        windowStartedAt: now,
        acceptedBatches: 0,
        acceptedSamples: 0,
      };
      this.telemetryRates.set(key, state);
    } else if (now - state.windowStartedAt >= TELEMETRY_RATE_WINDOW_MS) {
      state.windowStartedAt = now;
      state.acceptedBatches = 0;
    }
    if (
      state.acceptedBatches >= MAX_TELEMETRY_BATCHES_PER_MINUTE ||
      state.acceptedSamples + sampleCount > MAX_TELEMETRY_SAMPLES_PER_CALL
    ) {
      return false;
    }
    state.acceptedBatches += 1;
    state.acceptedSamples += sampleCount;
    return true;
  }

  private pruneTelemetryRates(): void {
    for (const [key, state] of this.telemetryRates) {
      const boundOwner = this.sessionOwners.get(state.sessionId);
      if (
        !boundOwner ||
        boundOwner.ownerId !== state.owner.ownerId ||
        boundOwner.loginRevision !== state.owner.loginRevision
      ) {
        this.telemetryRates.delete(key);
        continue;
      }
      try {
        const result = this.sessionService.status(state.owner, state.sessionId);
        if (
          result.isOk() &&
          (result.value === null || TERMINAL_SESSION_STATUSES.has(result.value.status))
        ) {
          this.telemetryRates.delete(key);
        }
      } catch {
        // Preserve the bounded key when authoritative status is unavailable.
      }
    }
  }

  private ownerCanRead(sessionId: string, owner: VoiceOwnerContext): boolean {
    const boundOwner = this.sessionOwners.get(sessionId);
    return boundOwner === undefined || boundOwner.ownerId === owner.ownerId;
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
    if (
      type === null ||
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
    if (type === 'webrtc') {
      const sdp = readStringProperty(body.transport, 'sdp');
      if (sdp === null || sdp.length === 0) {
        return new RequestFailure({ status: 400, code: 'INVALID_REQUEST', message: 'Invalid request' });
      }
      if (Buffer.byteLength(sdp, 'utf8') > this.maxSdpBytes) {
        return new RequestFailure({
          status: 413,
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Payload too large',
        });
      }
      return { transport: { type: 'webrtc', sdp } };
    }
    // A browser body cannot attest that a SIP reference was verified. SIP
    // ingress must construct that descriptor after its own authority checks.
    if (type === 'sip') {
      return new RequestFailure({ status: 400, code: 'INVALID_REQUEST', message: 'Invalid request' });
    }
    if (type === 'audio_stream' && isRecord(body.transport.format)) {
      const codec = readStringProperty(body.transport.format, 'codec');
      const sampleRateHz = body.transport.format.sampleRateHz;
      const channels = body.transport.format.channels;
      if (
        codec !== null &&
        codec.length > 0 &&
        codec.length <= 64 &&
        typeof sampleRateHz === 'number' &&
        Number.isSafeInteger(sampleRateHz) &&
        sampleRateHz > 0 &&
        typeof channels === 'number' &&
        Number.isSafeInteger(channels) &&
        channels > 0
      ) {
        return {
          transport: {
            type: 'audio_stream',
            format: { codec, sampleRateHz, channels },
          },
        };
      }
    }
    return new RequestFailure({ status: 400, code: 'INVALID_REQUEST', message: 'Invalid request' });
  }

  private reconcileTerminalSessions(currentOwner: VoiceOwnerContext): void {
    for (const sessionId of this.activeSessionIds) {
      const owner = this.sessionOwners.get(sessionId);
      if (!owner || owner.ownerId !== currentOwner.ownerId) continue;
      try {
        const result = this.sessionService.status(currentOwner, sessionId);
        if (
          result.isOk() &&
          (result.value === null || TERMINAL_SESSION_STATUSES.has(result.value.status))
        ) {
          this.forgetActiveSession(sessionId);
        }
      } catch {
        // Keep the reservation when authoritative status cannot be read.
      }
    }
  }

  private forgetActiveSession(sessionId: string): void {
    this.activeSessionIds.delete(sessionId);
    for (const [cookieValue, sessionIds] of this.sessionsByAuthCookie) {
      sessionIds.delete(sessionId);
      if (sessionIds.size === 0) this.sessionsByAuthCookie.delete(cookieValue);
    }
  }

  private closeStreamsForAuth(authenticated: VoiceAuthSession): void {
    for (const stream of [...this.streams]) {
      if (stream.authSession === authenticated) this.closeStream(stream);
    }
  }

  private isAllowedOrigin(request: IncomingMessage, sameOriginRead = false): boolean {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') {
      return sameOriginRead && this.isVerifiedSameOriginRead(request);
    }
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

  private isVerifiedSameOriginRead(request: IncomingMessage): boolean {
    const host = request.headers.host;
    if (!host) return false;
    let hostUrl: URL;
    try {
      hostUrl = new URL(`${this.requestProtocol(request)}//${host}`);
    } catch {
      return false;
    }

    const fetchSite = request.headers['sec-fetch-site'];
    const trustedFetchSite =
      typeof fetchSite === 'string' &&
      (fetchSite.toLowerCase() === 'same-origin' || fetchSite.toLowerCase() === 'none');
    if (typeof fetchSite === 'string') {
      const normalizedFetchSite = fetchSite.toLowerCase();
      if (normalizedFetchSite !== 'same-origin' && normalizedFetchSite !== 'none') {
        return false;
      }
    }

    const referer = request.headers.referer;
    if (typeof referer !== 'string') {
      return (
        isLoopbackHostname(hostUrl.hostname) ||
        (trustedFetchSite &&
          this.allowedOrigins?.some((origin) => origin === hostUrl.origin) === true)
      );
    }
    try {
      const refererUrl = new URL(referer);
      return (
        refererUrl.origin === hostUrl.origin &&
        (isLoopbackHostname(hostUrl.hostname) ||
          this.allowedOrigins?.some((origin) => origin === hostUrl.origin) === true)
      );
    } catch {
      return false;
    }
  }

  private requestProtocol(request: IncomingMessage): 'http:' | 'https:' {
    const forwarded = request.headers['x-forwarded-proto'];
    const protocol = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (protocol?.split(',')[0]?.trim().toLowerCase() === 'https') return 'https:';
    const socketWithTls = request.socket as typeof request.socket & {
      readonly encrypted?: boolean;
    };
    return socketWithTls.encrypted === true ? 'https:' : 'http:';
  }

  private isSecureRequest(request: IncomingMessage): boolean {
    if (this.config.secureCookies !== undefined) return this.config.secureCookies;
    return this.requestProtocol(request) === 'https:';
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
    if (!this.auth.isActive(stream.authSession)) {
      this.closeStream(stream);
      return;
    }
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

  private writeAuthFailure(response: ServerResponse, requestId: string, error: unknown): void {
    const status = authFailureStatus(error, 401);
    this.writeError(response, requestId, {
      status,
      code: status === 500 ? 'VOICE_ERROR' : status === 403 ? 'CSRF_DENIED' : 'UNAUTHORIZED',
      message:
        status === 500
          ? 'Voice request failed'
          : status === 403
            ? 'CSRF validation failed'
            : 'Authentication required',
    });
  }

  private writeDomainError(response: ServerResponse, requestId: string, error: unknown): void {
    if (error instanceof VoiceCreationRateLimitError) {
      this.writeError(response, requestId, {
        status: 429,
        code: 'RATE_LIMITED',
        message: 'Too many session creations',
      });
      return;
    }
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
    route === '/auth/session' ||
    route === '/sessions' ||
    route.startsWith('/sessions/')
  );
}

function parseSessionRoute(route: string): {
  readonly action: 'status' | 'stream' | 'close' | 'playback' | 'telemetry';
  readonly sessionId: string;
} | null {
  const match =
    /^\/sessions\/([^/]+)(?:\/(events|stream|status|status-stream|close|playback|telemetry))?$/.exec(route);
  if (!match) return null;
  const action: 'status' | 'stream' | 'close' | 'playback' | 'telemetry' =
    match[2] === undefined ||
    match[2] === 'events' ||
    match[2] === 'stream' ||
    match[2] === 'status' ||
    match[2] === 'status-stream'
      ? match[2] === undefined
        ? 'status'
        : 'stream'
      : (match[2] as 'close' | 'playback' | 'telemetry');
  return { action, sessionId: decodePathSegment(match[1]) };
}

function parseTelemetryRequest(
  body: unknown,
  sessionId: string,
): VoiceBrowserTelemetryRequest | RequestFailure {
  if (!isRecord(body) || !hasOnlyKeys(body, ['callId', 'samples']) || !Array.isArray(body.samples)) {
    return invalidTelemetryRequest();
  }
  if (body.callId !== undefined && (typeof body.callId !== 'string' || body.callId !== sessionId)) {
    return invalidTelemetryRequest();
  }
  if (body.samples.length === 0 || body.samples.length > MAX_TELEMETRY_SAMPLES_PER_BATCH) {
    return invalidTelemetryRequest();
  }
  const samples: VoiceBrowserTelemetrySample[] = [];
  for (const value of body.samples) {
    if (!isRecord(value) || !hasOnlyKeys(value, ['category', 'status', 'durationMs', 'count', 'outputId'])) {
      return invalidTelemetryRequest();
    }
    if (
      typeof value.category !== 'string' ||
      !VOICE_BROWSER_TELEMETRY_CATEGORIES.includes(
        value.category as (typeof VOICE_BROWSER_TELEMETRY_CATEGORIES)[number],
      ) ||
      typeof value.status !== 'string' ||
      !VOICE_BROWSER_TELEMETRY_STATUSES.includes(
        value.status as (typeof VOICE_BROWSER_TELEMETRY_STATUSES)[number],
      ) ||
      !isValidTelemetryPair(value.category, value.status)
    ) {
      return invalidTelemetryRequest();
    }
    if (
      value.durationMs !== undefined &&
      (typeof value.durationMs !== 'number' ||
        !Number.isFinite(value.durationMs) ||
        value.durationMs < 0 ||
        value.durationMs > MAX_TELEMETRY_DURATION_MS)
    ) {
      return invalidTelemetryRequest();
    }
    if (
      value.count !== undefined &&
      (typeof value.count !== 'number' ||
        !Number.isSafeInteger(value.count) ||
        value.count < 0 ||
        value.count > MAX_TELEMETRY_COUNT)
    ) {
      return invalidTelemetryRequest();
    }
    if (
      value.outputId !== undefined &&
      (typeof value.outputId !== 'string' || !isBoundedTelemetryId(value.outputId))
    ) {
      return invalidTelemetryRequest();
    }
    samples.push({
      category: value.category as VoiceBrowserTelemetrySample['category'],
      status: value.status as VoiceBrowserTelemetrySample['status'],
      ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
      ...(value.count === undefined ? {} : { count: value.count }),
      ...(value.outputId === undefined ? {} : { outputId: value.outputId }),
    });
  }
  return { callId: sessionId, samples };
}

function invalidTelemetryRequest(): RequestFailure {
  return new RequestFailure({ status: 400, code: 'INVALID_REQUEST', message: 'Invalid request' });
}

function isValidTelemetryPair(category: string, status: string): boolean {
  if (category === 'rtc') {
    return ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed', 'unknown'].includes(status);
  }
  if (category === 'audio') return ['play_resolved', 'play_rejected', 'unknown'].includes(status);
  if (category === 'visibility') return ['visible', 'hidden', 'unknown'].includes(status);
  return category === 'interruption' && ['interrupted', 'resumed', 'unknown'].includes(status);
}

function isBoundedTelemetryId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_OUTPUT_ID_LENGTH && !/[\0\r\n]/u.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
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

const INVALID_BOOLEAN = Symbol('invalid boolean');

function readOptionalBooleanProperty(
  value: unknown,
  key: string,
): boolean | undefined | typeof INVALID_BOOLEAN {
  if (!isRecord(value)) return INVALID_BOOLEAN;
  const property = value[key];
  if (property === undefined) return undefined;
  return typeof property === 'boolean' ? property : INVALID_BOOLEAN;
}

function authFailureStatus(error: unknown, fallback: number): number {
  if (!(error instanceof VoiceAuthError)) return fallback;
  switch (error.kind) {
    case 'invalid_request':
      return 400;
    case 'invalid_csrf':
      return 403;
    case 'rate_limited':
      return 429;
    case 'storage_error':
      return 500;
    default:
      return fallback;
  }
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
