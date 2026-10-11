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
import type {
  VoiceLoginRequest,
  VoiceLoginResponse,
  VoiceOwnerContext,
  VoiceResult,
} from './voice-types.js';

const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
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
  | 'rate_limited'
  | 'missing_cookie'
  | 'expired_cookie'
  | 'invalid_cookie'
  | 'invalid_csrf';

/** Expected authentication failures are still represented by Talon results. */
export class VoiceAuthError extends TalonError {
  readonly code = 'VOICE_AUTH_ERROR' as const;
  readonly kind: VoiceAuthFailureKind;

  constructor(kind: VoiceAuthFailureKind) {
    super('Voice authentication failed');
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
 * In-memory browser login authority.
 *
 * This is deliberately separate from VoiceSessionService: authentication
 * revocation and CSRF state are HTTP concerns, while session ownership is a
 * service concern.  A daemon restart invalidates these cookies by design.
 */
export class VoiceAuth {
  private readonly configuredAccessToken: string;
  private readonly ownerId: string;
  private readonly sessionTtlMs: number;
  private readonly loginWindowMs: number;
  private readonly maxLoginAttempts: number;
  private readonly maxSessions: number;
  private readonly cookieName: string;
  private readonly csrfCookieName: string;
  private readonly secureCookiesOverride: boolean | undefined;
  private readonly now: () => number;

  private readonly sessions = new Map<string, VoiceAuthSession>();
  private readonly attempts = new Map<string, LoginAttemptState>();
  private loginRevision = 0;

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
  }

  get sessionCookieName(): string {
    return this.cookieName;
  }

  get csrfCookieNameValue(): string {
    return this.csrfCookieName;
  }

  /** Exchange the configured access token for a browser session. */
  login(
    input: string | VoiceLoginRequest,
    options: VoiceAuthLoginOptions = {},
  ): VoiceResult<VoiceAuthLoginResult> {
    const accessToken = typeof input === 'string' ? input : input.accessToken;
    const remoteKey = this.remoteKey(options.remoteAddress);
    const now = this.now();

    if (this.isRateLimited(remoteKey, now)) {
      return err(new VoiceAuthError('rate_limited'));
    }

    if (!this.constantTimeEquals(accessToken, this.configuredAccessToken)) {
      this.recordFailure(remoteKey, now);
      return err(new VoiceAuthError('invalid_credentials'));
    }

    this.attempts.delete(remoteKey);
    this.removeExpiredSessions(now);
    if (this.sessions.size >= this.maxSessions) {
      return err(new VoiceAuthError('rate_limited'));
    }

    const cookieValue = randomToken();
    const csrfToken = randomToken();
    const createdAt = now;
    const expiresAt = now + this.sessionTtlMs;
    const session: VoiceAuthSession = {
      cookieValue,
      csrfToken,
      owner: {
        ownerId: this.ownerId,
        loginRevision: ++this.loginRevision,
      },
      createdAt,
      expiresAt,
    };

    this.sessions.set(cookieValue, session);
    const secure = options.secure ?? this.secureCookiesOverride ?? false;
    return ok({
      session,
      response: { authenticated: true, expiresAt },
      cookies: this.buildLoginCookies(session, secure),
    });
  }

  /** Resolve and validate the opaque session cookie on an HTTP request. */
  authenticate(request: Pick<IncomingMessage, 'headers'>): VoiceResult<VoiceAuthSession> {
    const cookieValue = readCookie(request.headers, this.cookieName);
    if (cookieValue === null) {
      return err(new VoiceAuthError('missing_cookie'));
    }

    const session = this.sessions.get(cookieValue);
    if (!session) {
      return err(new VoiceAuthError('invalid_cookie'));
    }

    if (session.expiresAt <= this.now()) {
      this.sessions.delete(cookieValue);
      return err(new VoiceAuthError('expired_cookie'));
    }

    return ok(session);
  }

  /** Require the double-submit CSRF cookie and header to match this session. */
  verifyCsrf(
    request: Pick<IncomingMessage, 'headers'>,
    session: VoiceAuthSession,
  ): VoiceResult<void> {
    if (session.expiresAt <= this.now()) {
      return err(new VoiceAuthError('expired_cookie'));
    }
    const cookieToken = readCookie(request.headers, this.csrfCookieName);
    const headerToken = readHeader(request.headers, VOICE_CSRF_HEADER);
    if (
      cookieToken === null ||
      headerToken === null ||
      !this.constantTimeEquals(cookieToken, session.csrfToken) ||
      !this.constantTimeEquals(headerToken, session.csrfToken)
    ) {
      return err(new VoiceAuthError('invalid_csrf'));
    }
    return ok(undefined);
  }

  /** Revoke one authenticated browser session. */
  revoke(session: VoiceAuthSession): void {
    this.sessions.delete(session.cookieValue);
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

  private removeExpiredSessions(now: number): void {
    for (const [cookieValue, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(cookieValue);
    }
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
