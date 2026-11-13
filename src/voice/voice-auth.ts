/**
 * Cookie-backed authentication for the opt-in browser voice boundary.
 *
 * The configured access token is exchanged once for an opaque, short-lived
 * cookie.  The access token never leaves this module after login and is never
 * included in a response, log record, or browser-facing status object.
 */

import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { err, ok } from '../core/types/result.js';
import { TalonError } from '../core/errors/error-types.js';
import {
  VoiceAuthRepository,
  hashVoiceAuthToken,
  type VoiceAuthSessionRow,
} from '../core/database/repositories/voice-auth-repository.js';
import type {
  VoiceLoginRequest,
  VoiceLoginResponse,
  VoiceOwnerContext,
  VoiceResult,
} from './voice-types.js';

const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const REMEMBERED_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_LOGIN_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;
const DEFAULT_MAX_SESSIONS = 256;
const MAX_ACCESS_TOKEN_BYTES = 1024;
const MAX_REMOTE_KEY_BYTES = 256;

export const VOICE_SESSION_COOKIE = 'talon_voice_session';
export const VOICE_CSRF_COOKIE = 'talon_voice_csrf';
export const VOICE_CSRF_HEADER = 'x-csrf-token';

export type VoiceAuthFailureKind =
  | 'invalid_credentials'
  | 'invalid_request'
  | 'rate_limited'
  | 'missing_cookie'
  | 'expired_cookie'
  | 'invalid_cookie'
  | 'invalid_csrf'
  | 'storage_error';

/** Expected authentication failures are still represented by Talon results. */
export class VoiceAuthError extends TalonError {
  readonly code = 'VOICE_AUTH_ERROR' as const;
  readonly kind: VoiceAuthFailureKind;

  constructor(kind: VoiceAuthFailureKind, cause?: Error) {
    super('Voice authentication failed', cause);
    this.kind = kind;
  }
}

export interface VoiceAuthConfig {
  /** Access token configured by the operator; never sourced from a browser. */
  readonly accessToken: string;
  /** Stable owner identity used by VoiceSessionService. */
  readonly ownerId?: string;
  readonly sessionTtlMs?: number;
  readonly loginWindowMs?: number;
  readonly maxLoginAttempts?: number;
  readonly maxSessions?: number;
  readonly cookieName?: string;
  readonly csrfCookieName?: string;
  /** Override only when the deployment explicitly knows its transport. */
  readonly secureCookies?: boolean;
  readonly now?: () => number;
  /** Production bootstrap injects durable authority; standalone tests may omit it. */
  readonly repository?: VoiceAuthRepository;
}

export interface VoiceAuthSession {
  /** Opaque cookie value. It is internal and must never be serialized. */
  readonly cookieValue: string;
  readonly csrfToken: string;
  readonly owner: VoiceOwnerContext;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface VoiceAuthLoginResult {
  readonly session: VoiceAuthSession;
  readonly response: VoiceLoginResponse;
  readonly cookies: readonly string[];
}

export interface VoiceAuthLoginOptions {
  readonly remoteAddress?: string;
  readonly secure?: boolean;
}

interface RuntimeSessionMetadata {
  readonly id?: string;
  readonly sessionTokenHash?: string;
  readonly csrfTokenHash?: string;
}

interface LoginAttemptState {
  count: number;
  startedAt: number;
}

interface CookieOptions {
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
  readonly expiresAt: number;
}

/**
 * Browser login authority.
 *
 * This is deliberately separate from VoiceSessionService: authentication
 * revocation and CSRF state are HTTP concerns, while session ownership is a
 * service concern. Durable bootstrap hydrates active grants from SQLite;
 * standalone tests may omit the repository and use process-local state.
 */
export class VoiceAuth {
  private configuredAccessToken: string;
  private ownerId: string;
  private readonly sessionTtlMs: number;
  private readonly loginWindowMs: number;
  private readonly maxLoginAttempts: number;
  private readonly maxSessions: number;
  private readonly cookieName: string;
  private readonly csrfCookieName: string;
  private readonly secureCookiesOverride: boolean | undefined;
  private readonly now: () => number;
  private readonly repository: VoiceAuthRepository | undefined;

  private readonly sessions = new Map<string, VoiceAuthSession>();
  private readonly sessionsByRevision = new Map<string, VoiceAuthSession>();
  private readonly metadata = new WeakMap<VoiceAuthSession, RuntimeSessionMetadata>();
  private readonly attempts = new Map<string, LoginAttemptState>();
  private loginRevision = 0;
  private initializationError: VoiceAuthError | undefined;
  private hydratedSessions: VoiceAuthSession[] = [];

  constructor(config: VoiceAuthConfig) {
    if (config.accessToken.length === 0) {
      throw new Error('VoiceAuth requires a non-empty access token');
    }
    if (config.sessionTtlMs !== undefined && config.sessionTtlMs <= 0) {
      throw new Error('VoiceAuth sessionTtlMs must be positive');
    }
    if (config.loginWindowMs !== undefined && config.loginWindowMs <= 0) {
      throw new Error('VoiceAuth loginWindowMs must be positive');
    }
    if (config.maxLoginAttempts !== undefined && config.maxLoginAttempts <= 0) {
      throw new Error('VoiceAuth maxLoginAttempts must be positive');
    }
    if (config.maxSessions !== undefined && config.maxSessions <= 0) {
      throw new Error('VoiceAuth maxSessions must be positive');
    }

    this.configuredAccessToken = config.accessToken;
    this.ownerId = config.ownerId ?? 'voice-owner';
    this.sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.loginWindowMs = config.loginWindowMs ?? DEFAULT_LOGIN_WINDOW_MS;
    this.maxLoginAttempts = config.maxLoginAttempts ?? DEFAULT_MAX_LOGIN_ATTEMPTS;
    this.maxSessions = config.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.cookieName = config.cookieName ?? VOICE_SESSION_COOKIE;
    this.csrfCookieName = config.csrfCookieName ?? VOICE_CSRF_COOKIE;
    this.secureCookiesOverride = config.secureCookies;
    this.now = config.now ?? Date.now;
    this.repository = config.repository;

    if (this.repository) {
      const binding = this.repository.bindCredential(
        this.ownerId,
        this.configuredAccessToken,
        this.now(),
      );
      if (binding.isErr()) {
        this.initializationError = this.storageError(binding.error);
      } else {
        const active = this.repository.listActive(this.now(), this.ownerId);
        if (active.isErr()) {
          this.initializationError = this.storageError(active.error);
        } else {
          this.hydratedSessions = active.value.map((row) => this.sessionFromRow(row));
        }
      }
    }
  }

  get sessionCookieName(): string {
    return this.cookieName;
  }

  get csrfCookieNameValue(): string {
    return this.csrfCookieName;
  }

  /** Bootstrap uses this to fail closed before constructing the daemon context. */
  get initializationResult(): VoiceResult<void> {
    return this.initializationError ? err(this.initializationError) : ok(undefined);
  }

  /** Current stable owner identity, used when auth config is rebound on reload. */
  get configuredOwnerId(): string {
    return this.ownerId;
  }

  /** Fail closed when a reload cannot durably rotate or revoke authority. */
  disable(): void {
    this.initializationError = new VoiceAuthError('storage_error');
    this.clearRuntimeSessions();
  }

  /** Consume durable rows discovered during construction. */
  protected takeHydratedSessions(): readonly VoiceAuthSession[] {
    const sessions = this.hydratedSessions;
    this.hydratedSessions = [];
    for (const session of sessions) this.rememberRuntimeSession(session);
    return sessions;
  }

  /** IndexedVoiceAuth observes canonical runtime registrations. */
  protected onRuntimeSessionRegistered(_session: VoiceAuthSession): void {
    // The base HTTP authority does not need an owner/revision index.
  }

  /** IndexedVoiceAuth observes canonical runtime removals. */
  protected onRuntimeSessionRevoked(_session: VoiceAuthSession): void {
    // The base HTTP authority does not need an owner/revision index.
  }

  /** Exchange the configured access token for a browser session. */
  login(
    input: string | VoiceLoginRequest,
    options: VoiceAuthLoginOptions = {},
  ): VoiceResult<VoiceAuthLoginResult> {
    const accessToken = typeof input === 'string' ? input : input.accessToken;
    const rememberMe = typeof input === 'string' ? false : input.rememberMe;
    if (rememberMe !== undefined && typeof rememberMe !== 'boolean') {
      return err(new VoiceAuthError('invalid_request'));
    }
    const ready = this.ready();
    if (ready) return err(ready);
    const remoteKey = this.remoteKey(options.remoteAddress);
    const now = this.now();

    if (this.isRateLimited(remoteKey, now)) {
      return err(new VoiceAuthError('rate_limited'));
    }

    const credentialsValid = this.verifyConfiguredCredential(accessToken);
    if (credentialsValid.isErr()) return err(credentialsValid.error);
    if (!credentialsValid.value) {
      this.recordFailure(remoteKey, now);
      return err(new VoiceAuthError('invalid_credentials'));
    }

    const cookieValue = randomToken();
    const csrfToken = randomToken();
    const createdAt = now;
    const expiresAt = now + (rememberMe === true ? REMEMBERED_SESSION_TTL_MS : this.sessionTtlMs);
    this.attempts.delete(remoteKey);

    let session: VoiceAuthSession;
    if (this.repository) {
      const pruned = this.repository.pruneExpired(now);
      if (pruned.isErr()) return err(this.storageError(pruned.error));
    }

    const runtimePruned = this.pruneRuntimeSessions();
    if (runtimePruned.isErr()) return err(runtimePruned.error);

    if (this.repository) {
      const count = this.repository.countActive(now);
      if (count.isErr()) return err(this.storageError(count.error));
      if (count.value >= this.maxSessions) return err(new VoiceAuthError('rate_limited'));
      const persisted = this.repository.createSession({
        id: randomBytes(16).toString('hex'),
        sessionTokenHash: hashVoiceAuthToken(cookieValue),
        csrfTokenHash: hashVoiceAuthToken(csrfToken),
        ownerId: this.ownerId,
        createdAt,
        expiresAt,
      });
      if (persisted.isErr()) return err(this.storageError(persisted.error));
      session = this.sessionFromRow(persisted.value, cookieValue, csrfToken);
    } else {
      if (this.sessions.size >= this.maxSessions) {
        return err(new VoiceAuthError('rate_limited'));
      }
      session = {
        cookieValue,
        csrfToken,
        owner: {
          ownerId: this.ownerId,
          loginRevision: ++this.loginRevision,
        },
        createdAt,
        expiresAt,
      };
    }

    this.rememberRuntimeSession(session);
    const secure = options.secure ?? this.secureCookiesOverride ?? false;
    return ok({
      session,
      response: { authenticated: true, expiresAt },
      cookies: this.buildLoginCookies(session, secure),
    });
  }

  /** Resolve and validate the opaque session cookie on an HTTP request. */
  authenticate(request: Pick<IncomingMessage, 'headers'>): VoiceResult<VoiceAuthSession> {
    const ready = this.ready();
    if (ready) return err(ready);
    const cookieValue = readCookie(request.headers, this.cookieName);
    if (cookieValue === null) {
      return err(new VoiceAuthError('missing_cookie'));
    }

    if (this.repository) {
      const persisted = this.repository.findActiveByTokenHash(
        hashVoiceAuthToken(cookieValue),
        this.now(),
      );
      if (persisted.isErr()) return err(this.storageError(persisted.error));
      if (!persisted.value) {
        const stale = this.sessions.get(cookieValue);
        if (stale) this.forgetRuntimeSession(stale);
        return err(new VoiceAuthError('invalid_cookie'));
      }
      const key = this.revisionKey(persisted.value.owner_id, persisted.value.login_revision);
      const existing = this.sessionsByRevision.get(key);
      const session =
        existing && existing.cookieValue === cookieValue
          ? existing
          : this.sessionFromRow(persisted.value, cookieValue);
      this.rememberRuntimeSession(session);
      const active = this.isActiveResult(session);
      if (active.isErr()) return err(active.error);
      if (!active.value) return err(new VoiceAuthError('expired_cookie'));
      return ok(session);
    }

    const session = this.sessions.get(cookieValue);
    if (!session) {
      return err(new VoiceAuthError('invalid_cookie'));
    }

    const active = this.isActiveResult(session);
    if (active.isErr()) return err(active.error);
    if (!active.value) {
      return err(new VoiceAuthError('expired_cookie'));
    }

    return ok(session);
  }

  /** Check that an earlier authentication result is still live. */
  isActive(session: VoiceAuthSession): boolean {
    const result = this.isActiveResult(session);
    return result.isOk() && result.value;
  }

  /** Durable form of {@link isActive}; storage failures remain typed. */
  isActiveResult(session: VoiceAuthSession): VoiceResult<boolean> {
    const ready = this.ready();
    if (ready) return err(ready);
    if (this.repository) {
      const metadata = this.metadata.get(session);
      if (!metadata?.id) return ok(false);
      const current = this.repository.findActiveByOwnerRevision(
        session.owner.ownerId,
        session.owner.loginRevision,
        this.now(),
      );
      if (current.isErr()) return err(this.storageError(current.error));
      const active = current.value?.id === metadata.id;
      if (!active) this.forgetRuntimeSession(session);
      return ok(active);
    }
    const current = this.sessions.get(session.cookieValue);
    if (current !== session) return ok(false);
    if (session.expiresAt <= this.now()) {
      this.forgetRuntimeSession(session);
      return ok(false);
    }
    return ok(true);
  }

  /** Require the double-submit CSRF cookie and header to match this session. */
  verifyCsrf(
    request: Pick<IncomingMessage, 'headers'>,
    session: VoiceAuthSession,
  ): VoiceResult<void> {
    const ready = this.ready();
    if (ready) return err(ready);
    const cookieToken = readCookie(request.headers, this.csrfCookieName);
    const headerToken = readHeader(request.headers, VOICE_CSRF_HEADER);
    if (cookieToken === null || headerToken === null) {
      return err(new VoiceAuthError('invalid_csrf'));
    }
    if (this.repository) {
      const metadata = this.metadata.get(session);
      if (!metadata?.id) return err(new VoiceAuthError('invalid_csrf'));
      const verified = this.repository.verifyCsrf(
        metadata.id,
        session.owner.ownerId,
        session.owner.loginRevision,
        hashVoiceAuthToken(cookieToken),
        hashVoiceAuthToken(headerToken),
        this.now(),
      );
      if (verified.isErr()) return err(this.storageError(verified.error));
      if (!verified.value) {
        const active = this.isActiveResult(session);
        if (active.isErr()) return err(active.error);
        return err(
          active.value ? new VoiceAuthError('invalid_csrf') : new VoiceAuthError('expired_cookie'),
        );
      }
      return ok(undefined);
    }
    if (session.expiresAt <= this.now()) return err(new VoiceAuthError('expired_cookie'));
    if (
      !this.constantTimeEquals(cookieToken, session.csrfToken) ||
      !this.constantTimeEquals(headerToken, session.csrfToken)
    ) {
      return err(new VoiceAuthError('invalid_csrf'));
    }
    return ok(undefined);
  }

  /** Revoke one authenticated browser session. */
  revoke(session: VoiceAuthSession): VoiceResult<void> {
    const ready = this.ready();
    if (ready) return err(ready);
    if (this.repository) {
      const metadata = this.metadata.get(session);
      if (!metadata?.id) return ok(undefined);
      const revoked = this.repository.revokeSession(metadata.id, this.now());
      if (revoked.isErr()) return err(this.storageError(revoked.error));
    }
    this.forgetRuntimeSession(session);
    return ok(undefined);
  }

  /** Revoke all grants, including rows not yet hydrated into this process. */
  invalidateRuntime(): VoiceResult<void> {
    const ready = this.repository ? undefined : this.initializationError;
    if (ready) return err(ready);
    if (this.repository) {
      const revoked = this.repository.revokeAll(this.now());
      if (revoked.isErr()) {
        this.initializationError = this.storageError(revoked.error);
        return err(this.initializationError);
      }
    }
    this.clearRuntimeSessions();
    return ok(undefined);
  }

  /** Atomically bind a new effective credential/owner during daemon reload. */
  rebind(accessToken: string, ownerId = this.ownerId): VoiceResult<void> {
    if (accessToken.length === 0 || ownerId.length === 0) {
      return err(new VoiceAuthError('invalid_request'));
    }
    if (this.repository) {
      const bound = this.repository.bindCredential(ownerId, accessToken, this.now());
      if (bound.isErr()) {
        this.initializationError = this.storageError(bound.error);
        return err(this.initializationError);
      }
      if (
        bound.value.changed ||
        ownerId !== this.ownerId ||
        accessToken !== this.configuredAccessToken
      ) {
        this.clearRuntimeSessions();
        const active = this.repository.listActive(this.now(), ownerId);
        if (active.isErr()) {
          this.initializationError = this.storageError(active.error);
          return err(this.initializationError);
        }
        for (const row of active.value) this.rememberRuntimeSession(this.sessionFromRow(row));
      }
    } else if (accessToken !== this.configuredAccessToken || ownerId !== this.ownerId) {
      this.clearRuntimeSessions();
    }
    this.configuredAccessToken = accessToken;
    this.ownerId = ownerId;
    this.initializationError = undefined;
    return ok(undefined);
  }

  /** Return deletion headers for both authentication cookies. */
  clearCookieHeaders(secure: boolean): readonly string[] {
    const options: CookieOptions = {
      httpOnly: true,
      secure,
      maxAgeSeconds: 0,
      expiresAt: 0,
    };
    return [
      serializeCookie(this.cookieName, '', options),
      serializeCookie(this.csrfCookieName, '', { ...options, httpOnly: false }),
    ];
  }

  /** Return login cookie headers without exposing their values to callers. */
  buildLoginCookies(session: VoiceAuthSession, secure: boolean): readonly string[] {
    const maxAgeSeconds = Math.max(1, Math.ceil((session.expiresAt - session.createdAt) / 1000));
    const options: CookieOptions = {
      httpOnly: true,
      secure,
      maxAgeSeconds,
      expiresAt: session.expiresAt,
    };
    return [
      serializeCookie(this.cookieName, session.cookieValue, options),
      serializeCookie(this.csrfCookieName, session.csrfToken, { ...options, httpOnly: false }),
    ];
  }

  private ready(): VoiceAuthError | undefined {
    return this.initializationError;
  }

  private verifyConfiguredCredential(accessToken: string): VoiceResult<boolean> {
    if (this.repository) {
      const verified = this.repository.verifyCredential(this.ownerId, accessToken);
      return verified.mapErr((cause) => this.storageError(cause));
    }
    return ok(this.constantTimeEquals(accessToken, this.configuredAccessToken));
  }

  private sessionFromRow(
    row: VoiceAuthSessionRow,
    cookieValue = '',
    csrfToken = '',
  ): VoiceAuthSession {
    const session: VoiceAuthSession = {
      cookieValue,
      csrfToken,
      owner: { ownerId: row.owner_id, loginRevision: row.login_revision },
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
    this.metadata.set(session, {
      id: row.id,
      sessionTokenHash: row.session_token_hash,
      csrfTokenHash: row.csrf_token_hash,
    });
    return session;
  }

  private rememberRuntimeSession(session: VoiceAuthSession): void {
    const key = this.revisionKey(session.owner.ownerId, session.owner.loginRevision);
    const previous = this.sessionsByRevision.get(key);
    if (previous && previous !== session && previous.cookieValue !== '') {
      this.sessions.delete(previous.cookieValue);
    }
    this.sessionsByRevision.set(key, session);
    if (session.cookieValue !== '') this.sessions.set(session.cookieValue, session);
    this.onRuntimeSessionRegistered(session);
  }

  private forgetRuntimeSession(session: VoiceAuthSession): void {
    if (session.cookieValue !== '') this.sessions.delete(session.cookieValue);
    const key = this.revisionKey(session.owner.ownerId, session.owner.loginRevision);
    if (this.sessionsByRevision.get(key) === session) this.sessionsByRevision.delete(key);
    this.onRuntimeSessionRevoked(session);
  }

  private clearRuntimeSessions(): void {
    for (const session of this.sessionsByRevision.values()) {
      this.onRuntimeSessionRevoked(session);
    }
    this.sessions.clear();
    this.sessionsByRevision.clear();
  }

  private revisionKey(ownerId: string, loginRevision: number): string {
    return `${ownerId}\u0000${loginRevision}`;
  }

  private storageError(cause: Error): VoiceAuthError {
    return new VoiceAuthError('storage_error', cause);
  }

  private isRateLimited(remoteKey: string, now: number): boolean {
    const state = this.attempts.get(remoteKey);
    if (!state) return false;
    if (now - state.startedAt >= this.loginWindowMs) {
      this.attempts.delete(remoteKey);
      return false;
    }
    return state.count >= this.maxLoginAttempts;
  }

  private recordFailure(remoteKey: string, now: number): void {
    const current = this.attempts.get(remoteKey);
    if (!current || now - current.startedAt >= this.loginWindowMs) {
      this.attempts.set(remoteKey, { count: 1, startedAt: now });
    } else {
      current.count += 1;
    }

    // A bounded map prevents unauthenticated traffic from becoming a memory
    // leak. The oldest entry is safe to forget because it only affects retry
    // throttling, never authorization.
    if (this.attempts.size > 1024) {
      const oldestKey = this.attempts.keys().next().value;
      if (oldestKey !== undefined) this.attempts.delete(oldestKey);
    }
  }

  /** Drop runtime sessions whose durable authority is no longer active. */
  protected pruneRuntimeSessions(): VoiceResult<void> {
    const sessions = new Set<VoiceAuthSession>([
      ...this.sessions.values(),
      ...this.sessionsByRevision.values(),
    ]);
    for (const session of sessions) {
      const active = this.isActiveResult(session);
      if (active.isErr()) return err(active.error);
    }
    return ok(undefined);
  }

  private remoteKey(remoteAddress: string | undefined): string {
    const value = remoteAddress ?? 'unknown';
    return value.length > MAX_REMOTE_KEY_BYTES ? value.slice(0, MAX_REMOTE_KEY_BYTES) : value;
  }

  private constantTimeEquals(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    if (leftBytes.length > MAX_ACCESS_TOKEN_BYTES || rightBytes.length > MAX_ACCESS_TOKEN_BYTES) {
      return false;
    }
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  }
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function readHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function readCookie(headers: IncomingHttpHeaders, name: string): string | null {
  const header = readHeader(headers, 'cookie');
  if (header === null) return null;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const cookieName = pair.slice(0, separator).trim();
    if (cookieName !== name) continue;
    const value = pair.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${options.maxAgeSeconds}`,
    `Expires=${new Date(options.expiresAt).toUTCString()}`,
  ];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
