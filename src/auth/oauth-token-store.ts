/**
 * OAuth 2.0 token cache for HTTP MCP servers.
 *
 * Each cache bundle is addressed by an opaque `tokenStoreId` — a
 * filesystem-safe identifier the skill-loader stamps into the canonical
 * MCP config (default `<skillName>/<serverName>`). The bundle lives at
 * `<dataDir>/mcp-auth/<tokenStoreId>.json` and is the single source of
 * truth for that server's tokens — there is no in-memory cache that
 * outlives a single materialization round.
 *
 * Lifecycle:
 *   1. `talonctl auth-mcp <skill>:<server>` writes the initial bundle
 *      after the interactive OAuth dance.
 *   2. The daemon's MCP-resolution layer calls `materializeBearer()`
 *      every time it builds an agent's MCP config for a run. If the
 *      access token is near expiry the helper refreshes in-place via
 *      the cached refresh_token + token_endpoint.
 *   3. Talon never starts an mcp-remote process. The HTTP MCP endpoint
 *      consumes the Bearer header itself; no stdio bridge in the loop.
 *
 * Concurrent materializations for the same id share a single refresh
 * promise so we don't burn the refresh_token by racing the IdP with
 * parallel exchanges.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  isEnvironmentVariableName,
  requireEnvironmentVariable,
} from '../core/config/environment.js';
import {
  addOAuthClientCredentials,
  type OAuthClientCredentials,
} from './oauth-client-auth.js';
import {
  isHttpsUrlWithoutUserInfoOrFragment,
  isOAuthIssuerIdentifier,
} from './oauth-issuer.js';
import type { OAuthTokenEndpointAuthMethod } from '../mcp/mcp-types.js';

/** Persisted shape of a cached OAuth token bundle. */
export interface CachedTokens {
  /** Bearer access token. Always required. */
  accessToken: string;
  /** OAuth refresh token. Optional — some IdPs do not issue one. */
  refreshToken?: string;
  /** Absolute Unix milliseconds when `accessToken` stops being valid. */
  expiresAt: number;
  /** Space-separated scope string from the most recent grant. */
  scope?: string;
  /** OAuth resource indicator originally authorized for this token bundle. */
  resource?: string;
  /** Exact scopes requested when the token bundle was authorized (empty means omitted). */
  requestedScopes?: string[];
  /** Token endpoint URL — required for refresh. Captured at auth time. */
  tokenEndpoint: string;
  /** Issuer established during OAuth discovery, when available. */
  authorizationServerIssuer?: string;
  /** Optional client metadata captured during dynamic registration. */
  clientId?: string;
  clientSecret?: string;
  /** Environment-variable references for a pre-registered OAuth client. */
  clientIdEnv?: string;
  clientSecretEnv?: string;
  /** Token endpoint authentication method used for this client. */
  tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
  /** ISO timestamp of the last refresh, for diagnostics only. */
  refreshedAt?: string;
}

export interface TokenStoreOptions {
  /** Root data directory; tokens live under `<dataDir>/mcp-auth/`. */
  dataDir: string;
  /**
   * Refresh access tokens that expire within this many milliseconds.
   * Default 60 s leaves a comfortable margin for clock skew + network
   * latency without thrashing refresh.
   */
  refreshBufferMs?: number;
  /** Injected fetch for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface OAuthTokenExpectations {
  authorizationServerIssuer?: string;
  resource: string;
  scopes: string[];
}

/**
 * Resolve a `tokenStoreId` to an absolute cache file path. Rejects
 * absolute paths and any segment that contains `..` so a malicious or
 * misconfigured skill cannot escape `<dataDir>/mcp-auth/`.
 *
 * Exported so the CLI and the daemon agree on exactly one location.
 */
export function tokenFilePath(dataDir: string, tokenStoreId: string): string {
  const id = tokenStoreId.trim();
  if (id.length === 0) {
    throw new TokenStoreError('tokenStoreId must be non-empty');
  }
  if (isAbsolute(id) || id.startsWith(sep) || id.startsWith('/')) {
    throw new TokenStoreError(
      `tokenStoreId must be relative, got "${tokenStoreId}"`,
    );
  }
  const normalized = normalize(id);
  if (normalized.split(/[\\/]/).includes('..')) {
    throw new TokenStoreError(
      `tokenStoreId may not contain ".." segments, got "${tokenStoreId}"`,
    );
  }
  return join(dataDir, 'mcp-auth', `${normalized}.json`);
}

/**
 * Atomically write a token bundle to disk. Creates parents with 0700
 * permissions and uses temp-file + rename to avoid partial reads while
 * a refresh is in flight.
 */
export async function writeTokens(
  dataDir: string,
  tokenStoreId: string,
  tokens: CachedTokens,
): Promise<void> {
  const path = tokenFilePath(dataDir, tokenStoreId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(tokens, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Read a token bundle from disk. Returns `undefined` when the file is
 * missing — callers should map that to a clear "run talonctl auth-mcp"
 * error rather than auto-initiating the OAuth dance from the daemon.
 */
export async function readTokens(
  dataDir: string,
  tokenStoreId: string,
): Promise<CachedTokens | undefined> {
  const path = tokenFilePath(dataDir, tokenStoreId);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    if (isNoEnt(cause)) return undefined;
    throw new TokenStoreError(`failed to read ${path}: ${stringify(cause)}`, cause);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new TokenStoreError(`invalid JSON in ${path}: ${stringify(cause)}`, cause);
  }

  if (!isCachedTokens(parsed)) {
    throw new TokenStoreError(`malformed token bundle in ${path}`);
  }
  return parsed;
}

export class TokenStoreError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TokenStoreError';
  }
}

/**
 * OAuthTokenStore — thin wrapper around the on-disk cache that knows how
 * to refresh expiring tokens via the cached `tokenEndpoint`.
 *
 * Instances are cheap to construct; the daemon makes one per process.
 */
export class OAuthTokenStore {
  private readonly dataDir: string;
  private readonly refreshBufferMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /**
   * Per-tokenStoreId in-flight refresh promise. Concurrent
   * `materializeBearer()` calls coalesce so we never fire two parallel
   * refresh_token exchanges (which would burn the refresh token).
   */
  private readonly inflight = new Map<string, Promise<CachedTokens>>();

  constructor(options: TokenStoreOptions) {
    this.dataDir = options.dataDir;
    this.refreshBufferMs = options.refreshBufferMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  /**
   * Return a usable access token for `tokenStoreId`. Throws if no token
   * bundle exists, the bundle lacks refresh material when needed, or
   * the IdP rejects the refresh.
   */
  async materializeBearer(
    tokenStoreId: string,
    expectations?: OAuthTokenExpectations,
  ): Promise<string> {
    const tokens = await this.loadFresh(tokenStoreId, expectations);
    return tokens.accessToken;
  }

  private async loadFresh(
    tokenStoreId: string,
    expectations?: OAuthTokenExpectations,
  ): Promise<CachedTokens> {
    const existing = this.inflight.get(tokenStoreId);
    if (existing) {
      const tokens = await existing;
      this.assertExpectedAuthorizationContext(tokenStoreId, tokens, expectations);
      return tokens;
    }

    const pending = (async (): Promise<CachedTokens> => {
      const tokens = await readTokens(this.dataDir, tokenStoreId);
      if (!tokens) {
        throw new TokenStoreError(
          `no cached tokens for "${tokenStoreId}". Run \`talonctl auth-mcp\` to authorise this MCP server.`,
        );
      }
      this.assertExpectedAuthorizationContext(tokenStoreId, tokens, expectations);

      if (tokens.expiresAt - this.now() > this.refreshBufferMs) {
        return tokens;
      }
      if (!tokens.refreshToken) {
        throw new TokenStoreError(
          `access token for "${tokenStoreId}" is expired and no refresh_token is cached. Re-run \`talonctl auth-mcp\`.`,
        );
      }
      const refreshed = await this.exchangeRefresh(tokens);
      this.assertExpectedAuthorizationContext(tokenStoreId, refreshed, expectations);
      await writeTokens(this.dataDir, tokenStoreId, refreshed);
      return refreshed;
    })();

    this.inflight.set(tokenStoreId, pending);
    try {
      return await pending;
    } finally {
      this.inflight.delete(tokenStoreId);
    }
  }

  private assertExpectedAuthorizationContext(
    tokenStoreId: string,
    tokens: CachedTokens,
    expectations?: OAuthTokenExpectations,
  ): void {
    if (!expectations) return;
    if (
      expectations.authorizationServerIssuer
      && tokens.authorizationServerIssuer !== expectations.authorizationServerIssuer
    ) {
      throw new TokenStoreError(
        `cached tokens for "${tokenStoreId}" do not match authorizationServerIssuer ${expectations.authorizationServerIssuer}. Re-run \`talonctl auth-mcp\`.`,
      );
    }
    if (tokens.resource !== expectations.resource) {
      throw new TokenStoreError(
        `cached tokens for "${tokenStoreId}" were authorized for a different MCP resource. Re-run \`talonctl auth-mcp\`.`,
      );
    }
    if (!sameScopes(tokens.requestedScopes, expectations.scopes)) {
      throw new TokenStoreError(
        `cached tokens for "${tokenStoreId}" were authorized with different requested scopes. Re-run \`talonctl auth-mcp\`.`,
      );
    }
    if (expectations.scopes.length > 0) {
      const allowedScopes = new Set(expectations.scopes);
      const grantedScopes = tokens.scope?.split(/\s+/u).filter(Boolean) ?? [];
      if (grantedScopes.some((scope) => !allowedScopes.has(scope))) {
        throw new TokenStoreError(
          `cached tokens for "${tokenStoreId}" include scopes outside the current MCP configuration. Re-run \`talonctl auth-mcp\`.`,
        );
      }
    }
  }

  /**
   * Standard RFC 6749 §6 refresh_token exchange. Returns a new bundle,
   * preserving the original refresh_token when the IdP did not rotate
   * it.
   */
  private async exchangeRefresh(tokens: CachedTokens): Promise<CachedTokens> {
    if (!tokens.refreshToken) {
      throw new TokenStoreError('exchangeRefresh: no refresh_token available');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    });
    if (tokens.resource) body.set('resource', tokens.resource);
    let request: { body: URLSearchParams; headers: Record<string, string> } = {
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    };
    const client = resolveStoredClientCredentials(tokens);
    if (client) {
      request = addOAuthClientCredentials(body, request.headers, client);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(tokens.tokenEndpoint, {
        method: 'POST',
        redirect: 'error',
        headers: request.headers,
        body: request.body.toString(),
      });
    } catch (cause) {
      throw new TokenStoreError(
        `refresh request to ${tokens.tokenEndpoint} failed: ${stringify(cause)}`,
        cause,
      );
    }

    if (!response.ok) {
      throw new TokenStoreError(
        `refresh returned ${response.status} from ${tokens.tokenEndpoint}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new TokenStoreError(`refresh response not JSON: ${stringify(cause)}`, cause);
    }

    if (!isTokenResponse(payload)) {
      throw new TokenStoreError(
        'refresh response missing required fields (access_token, expires_in)',
      );
    }

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? tokens.refreshToken,
      expiresAt: this.now() + payload.expires_in * 1000,
      scope: payload.scope ?? tokens.scope,
      tokenEndpoint: tokens.tokenEndpoint,
      ...(tokens.resource ? { resource: tokens.resource } : {}),
      ...(tokens.requestedScopes ? { requestedScopes: tokens.requestedScopes } : {}),
      ...(tokens.authorizationServerIssuer
        ? { authorizationServerIssuer: tokens.authorizationServerIssuer }
        : {}),
      ...(tokens.clientId ? { clientId: tokens.clientId } : {}),
      ...(tokens.clientSecret ? { clientSecret: tokens.clientSecret } : {}),
      ...(tokens.clientIdEnv ? { clientIdEnv: tokens.clientIdEnv } : {}),
      ...(tokens.clientSecretEnv ? { clientSecretEnv: tokens.clientSecretEnv } : {}),
      ...(tokens.tokenEndpointAuthMethod
        ? { tokenEndpointAuthMethod: tokens.tokenEndpointAuthMethod }
        : {}),
      refreshedAt: new Date(this.now()).toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isCachedTokens(value: unknown): value is CachedTokens {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const hasClientId =
    (typeof v.clientId === 'string' && v.clientId.length > 0)
    || (typeof v.clientIdEnv === 'string' && isEnvironmentVariableName(v.clientIdEnv));
  const hasClientSecret =
    (typeof v.clientSecret === 'string' && v.clientSecret.length > 0)
    || (typeof v.clientSecretEnv === 'string' && isEnvironmentVariableName(v.clientSecretEnv));
  const hasValidClientAuthMethod =
    v.tokenEndpointAuthMethod === undefined
    || v.tokenEndpointAuthMethod === 'none'
    || v.tokenEndpointAuthMethod === 'client_secret_post'
    || v.tokenEndpointAuthMethod === 'client_secret_basic';
  const clientAuthIsConsistent =
    hasValidClientAuthMethod
    && (hasClientId || (!hasClientSecret && v.tokenEndpointAuthMethod === undefined))
    && (v.tokenEndpointAuthMethod !== 'none' || !hasClientSecret)
    && (
      v.tokenEndpointAuthMethod === undefined
      || v.tokenEndpointAuthMethod === 'none'
      || hasClientSecret
    );
  return (
    typeof v.accessToken === 'string'
    && typeof v.expiresAt === 'number'
    && typeof v.tokenEndpoint === 'string'
    && isHttpsUrlWithoutUserInfoOrFragment(v.tokenEndpoint)
    && (
      v.resource === undefined
      || (typeof v.resource === 'string' && isHttpsUrlWithoutUserInfoOrFragment(v.resource))
    )
    && (
      v.requestedScopes === undefined
      || (Array.isArray(v.requestedScopes)
        && v.requestedScopes.every((scope) => typeof scope === 'string' && scope.trim().length > 0))
    )
    && (
      v.authorizationServerIssuer === undefined
      || (typeof v.authorizationServerIssuer === 'string'
        && isOAuthIssuerIdentifier(v.authorizationServerIssuer))
    )
    && (v.clientId === undefined || (typeof v.clientId === 'string' && v.clientId.length > 0))
    && (v.clientSecret === undefined || (typeof v.clientSecret === 'string' && v.clientSecret.length > 0))
    && (v.clientIdEnv === undefined || (typeof v.clientIdEnv === 'string' && isEnvironmentVariableName(v.clientIdEnv)))
    && (v.clientSecretEnv === undefined || (typeof v.clientSecretEnv === 'string' && isEnvironmentVariableName(v.clientSecretEnv)))
    && clientAuthIsConsistent
  );
}

function resolveStoredClientCredentials(tokens: CachedTokens): OAuthClientCredentials | undefined {
  if (!tokens.clientId && !tokens.clientIdEnv) return undefined;

  try {
    const clientId = tokens.clientIdEnv
      ? requireEnvironmentVariable(tokens.clientIdEnv, 'MCP OAuth client')
      : tokens.clientId;
    if (!clientId) {
      throw new Error('MCP OAuth client id is missing');
    }
    const clientSecret = tokens.clientSecretEnv
      ? requireEnvironmentVariable(tokens.clientSecretEnv, 'MCP OAuth client')
      : tokens.clientSecret;
    return {
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      tokenEndpointAuthMethod: tokens.tokenEndpointAuthMethod
        ?? (clientSecret
          ? (tokens.clientIdEnv ? 'client_secret_basic' : 'client_secret_post')
          : 'none'),
    };
  } catch (cause) {
    throw new TokenStoreError((cause as Error).message, cause);
  }
}

function sameScopes(left: string[] | undefined, right: string[]): boolean {
  if (!left) return false;
  const leftSet = [...new Set(left)].sort();
  const rightSet = [...new Set(right)].sort();
  return leftSet.length === rightSet.length
    && leftSet.every((scope, index) => scope === rightSet[index]);
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

function isTokenResponse(value: unknown): value is TokenResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.access_token === 'string'
    && v.access_token.length > 0
    && typeof v.expires_in === 'number'
    && Number.isFinite(v.expires_in)
    && v.expires_in > 0
    && (
      v.token_type === undefined
      || (typeof v.token_type === 'string' && v.token_type.toLowerCase() === 'bearer')
    )
    && (v.scope === undefined || typeof v.scope === 'string');
}

function isNoEnt(value: unknown): boolean {
  return (
    typeof value === 'object'
    && value !== null
    && (value as { code?: string }).code === 'ENOENT'
  );
}

function stringify(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}
