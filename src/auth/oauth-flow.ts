/**
 * Interactive OAuth 2.0 + PKCE flow for HTTP MCP servers.
 *
 * Owned by `talonctl auth-mcp`, not by the daemon. Performs:
 *
 *   1. Protected-resource discovery (RFC 9728) → authorization-server
 *      metadata (RFC 8414). Either may be absent; we try both.
 *   2. Dynamic Client Registration (RFC 7591) when supported.
 *   3. PKCE-protected authorization code flow.
 *   4. Code → token exchange.
 *
 * Result is a `CachedTokens` bundle the caller writes through
 * `oauth-token-store.writeTokens()`.
 *
 * Two callback delivery modes:
 *   - **interactive** (default): we attempt to open the user's local
 *     browser. Suitable when the operator runs `talonctl auth-mcp` on
 *     their desktop.
 *   - **headless**: we print the authorization URL plus an SSH
 *     port-forward example. The operator pastes the URL into their
 *     local browser and the redirect comes back over the forwarded
 *     port. This is the realistic mode for production daemons running
 *     on remote servers.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { URL } from 'node:url';
import {
  addOAuthClientCredentials,
  isOAuthTokenEndpointAuthMethod,
  type OAuthClientCredentials,
} from './oauth-client-auth.js';
import {
  isHttpsUrlWithoutUserInfoOrFragment,
  isOAuthIssuerIdentifier,
} from './oauth-issuer.js';
import type { CachedTokens } from './oauth-token-store.js';

/** Subset of RFC 8414 metadata we actually consume. */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  /** Optional scope strings the server advertises. */
  scopes_supported?: string[];
  /** Code challenge methods the server accepts; we require S256. */
  code_challenge_methods_supported?: string[];
}

/** Subset of RFC 9728 protected-resource metadata we look at. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
}

export interface RunOAuthFlowOptions {
  /** MCP resource URL — used as the OAuth `resource` parameter and discovery root. */
  resourceUrl: string;
  /** Suggested client name used during DCR. Defaults to `Talon (<hostname>)`. */
  clientName?: string;
  /**
   * Localhost callback port. Must be reachable from the user's browser
   * (or via SSH forward in headless mode). Defaults to 8788.
  */
  callbackPort?: number;
  /** Address for the temporary callback listener; Docker mode uses 0.0.0.0. */
  callbackListenAddress?: '127.0.0.1' | '0.0.0.0';
  /** Existing OAuth registration; otherwise Dynamic Client Registration is used. */
  registeredClient?: OAuthClientCredentials;
  /**
   * Operator-pinned authorization-server issuer for a pre-registered client.
   * When present, discovery is performed only against this issuer.
   */
  expectedAuthorizationServerIssuer?: string;
  /** Optional least-privilege scopes selected by the operator. */
  scopes?: string[];
  /** Print Docker Desktop instructions instead of opening a browser or SSH tunnel. */
  dockerMode?: boolean;
  /**
   * Headless mode prints the authorization URL and waits without trying
   * to open a browser. The operator forwards the callback port
   * themselves (e.g. `ssh -L 8788:localhost:8788 server`).
   */
  headless?: boolean;
  /**
   * How long to wait for the callback. Defaults to 5 minutes.
   */
  timeoutMs?: number;
  /** Optional override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Where to print human-readable status. Defaults to `console.log`. */
  printLine?: (line: string) => void;
}

export interface RunOAuthFlowResult {
  tokens: CachedTokens;
  authorizationServer: AuthorizationServerMetadata;
}

/**
 * Drive the full OAuth dance and return a cached-token bundle.
 *
 * The caller is responsible for persisting the bundle via
 * `writeTokens(dataDir, tokenStoreId, result.tokens)`.
 */
export async function runOAuthFlow(
  options: RunOAuthFlowOptions,
): Promise<RunOAuthFlowResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const print = options.printLine ?? ((line): void => {
    process.stdout.write(`${line}\n`);
  });
  const callbackPort = options.callbackPort ?? 8788;
  const clientName = options.clientName ?? `Talon (${hostname()})`;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  if (!isHttpsUrlWithoutUserInfoOrFragment(options.resourceUrl)) {
    throw new Error('OAuth MCP resource URL must use HTTPS and contain no user-info or fragment');
  }

  const asMeta = await discoverAuthorizationServer(
    options.resourceUrl,
    fetchImpl,
    options.expectedAuthorizationServerIssuer,
  );
  if (
    asMeta.code_challenge_methods_supported
    && !asMeta.code_challenge_methods_supported.includes('S256')
  ) {
    throw new Error(
      `OAuth server at ${asMeta.issuer} does not advertise S256 PKCE support`,
    );
  }

  const redirectUri = `http://127.0.0.1:${callbackPort}/callback`;
  const client = options.registeredClient ?? await registerOrReuseClient(
    asMeta,
    redirectUri,
    clientName,
    fetchImpl,
  );

  const verifier = randomBase64Url(64);
  const challenge = sha256Base64Url(verifier);
  const state = randomBase64Url(16);
  const scope = options.scopes?.join(' ');

  const authUrl = new URL(asMeta.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', client.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('resource', options.resourceUrl);
  if (scope) authUrl.searchParams.set('scope', scope);

  const callbackPromise = waitForCallback({
    port: callbackPort,
    listenAddress: options.callbackListenAddress ?? '127.0.0.1',
    expectedState: state,
    timeoutMs,
  });

  if (options.dockerMode) {
    print('');
    print('=== Docker MCP OAuth ===');
    print(`Open the authorization URL in your host browser. The callback returns through 127.0.0.1:${callbackPort}, published by the Talon Docker starter.`);
    print('');
    print(`  ${authUrl.toString()}`);
    print('');
    print(`Waiting for callback on 127.0.0.1:${callbackPort} (timeout ${Math.round(timeoutMs / 1000)}s)…`);
    print('');
  } else if (options.headless) {
    print('');
    print('=== headless OAuth ===');
    print('On your local machine, run:');
    print(`  ssh -L ${callbackPort}:localhost:${callbackPort} <user@this-host>`);
    print('');
    print('Then open this URL in your local browser:');
    print(`  ${authUrl.toString()}`);
    print('');
    print(`Waiting for callback on 127.0.0.1:${callbackPort} (timeout ${Math.round(timeoutMs / 1000)}s)…`);
    print('');
  } else {
    print(`Opening browser to authorise. If it does not open, visit: ${authUrl.toString()}`);
    tryOpenBrowser(authUrl.toString());
  }

  const code = await callbackPromise;

  const tokens = await exchangeCodeForTokens({
    tokenEndpoint: asMeta.token_endpoint,
    code,
    redirectUri,
    client,
    codeVerifier: verifier,
    resource: options.resourceUrl,
    scopes: options.scopes,
    fetchImpl,
  });

  return {
    tokens: {
      ...tokens,
      tokenEndpoint: asMeta.token_endpoint,
      resource: options.resourceUrl,
      requestedScopes: options.scopes ?? [],
      authorizationServerIssuer: asMeta.issuer,
      ...client,
    },
    authorizationServer: asMeta,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function discoverAuthorizationServer(
  resourceUrl: string,
  fetchImpl: typeof fetch,
  expectedIssuer?: string,
): Promise<AuthorizationServerMetadata> {
  if (expectedIssuer) {
    if (!isOAuthIssuerIdentifier(expectedIssuer)) {
      throw new Error(
        'authorizationServerIssuer must be an HTTPS URL without user-info, query, or fragment',
      );
    }
    const pinnedMeta = await fetchAuthorizationServerMetadata(
      expectedIssuer,
      fetchImpl,
      expectedIssuer,
    );
    if (pinnedMeta) return pinnedMeta;
    throw new Error(
      `OAuth metadata for configured authorizationServerIssuer ${expectedIssuer} was not found`,
    );
  }

  // 1. RFC 9728 protected-resource metadata at the resource itself.
  const prMeta = await fetchProtectedResourceMetadata(resourceUrl, fetchImpl);
  if (prMeta?.authorization_servers && prMeta.authorization_servers.length > 0) {
    const asUrl = prMeta.authorization_servers[0];
    const asMeta = await fetchAuthorizationServerMetadata(asUrl, fetchImpl, asUrl);
    if (asMeta) return asMeta;
  }

  // 2. Fallback: try `.well-known/oauth-authorization-server` at the
  //    resource's base URL. Many MCP servers (including Glean) co-locate
  //    the AS metadata on the same origin as the resource.
  const baseAsMeta = await fetchAuthorizationServerMetadata(resourceUrl, fetchImpl);
  if (baseAsMeta) return baseAsMeta;

  throw new Error(
    `OAuth discovery failed for ${resourceUrl}: neither /.well-known/oauth-protected-resource nor /.well-known/oauth-authorization-server resolved a usable authorization server.`,
  );
}

async function fetchProtectedResourceMetadata(
  resourceUrl: string,
  fetchImpl: typeof fetch,
): Promise<ProtectedResourceMetadata | undefined> {
  const wellKnown = wellKnownUrl(resourceUrl, 'oauth-protected-resource');
  return fetchJson<ProtectedResourceMetadata>(wellKnown, fetchImpl);
}

async function fetchAuthorizationServerMetadata(
  baseUrl: string,
  fetchImpl: typeof fetch,
  expectedIssuer?: string,
): Promise<AuthorizationServerMetadata | undefined> {
  if (expectedIssuer && !isOAuthIssuerIdentifier(expectedIssuer)) {
    throw new Error('OAuth authorization server identifiers must use HTTPS without user-info, query, or fragments');
  }
  const wellKnown = wellKnownUrl(baseUrl, 'oauth-authorization-server');
  const meta = await fetchJson<unknown>(wellKnown, fetchImpl);
  if (!meta) return undefined;
  if (typeof meta !== 'object' || meta === null) {
    return undefined;
  }
  const candidate = meta as Partial<AuthorizationServerMetadata>;
  if (
    typeof candidate.authorization_endpoint !== 'string'
    || typeof candidate.token_endpoint !== 'string'
    || typeof candidate.issuer !== 'string'
  ) {
    return undefined;
  }
  if (expectedIssuer && candidate.issuer !== expectedIssuer) {
    throw new Error(
      `OAuth issuer mismatch: metadata for ${expectedIssuer} declared issuer ${candidate.issuer}`,
    );
  }
  if (!isOAuthIssuerIdentifier(candidate.issuer)) {
    throw new Error('OAuth metadata issuer must be an HTTPS URL without user-info, query, or fragment');
  }
  for (const endpoint of [
    candidate.authorization_endpoint,
    candidate.token_endpoint,
    ...(typeof candidate.registration_endpoint === 'string'
      ? [candidate.registration_endpoint]
      : []),
  ]) {
    if (!isHttpsUrlWithoutUserInfoOrFragment(endpoint)) {
      throw new Error(
        `OAuth metadata for ${candidate.issuer} must use HTTPS endpoints without user-info or fragments`,
      );
    }
  }
  return candidate as AuthorizationServerMetadata;
}

/**
 * RFC 8414 places `.well-known/` between the issuer origin and path.
 * Try that standards-based location first, then the origin-root form
 * for servers that publish one shared metadata document.
 */
function wellKnownUrl(input: string, suffix: string): string[] {
  const url = new URL(input);
  const origin = `${url.protocol}//${url.host}`;
  const candidates: string[] = [];
  const path = url.pathname.replace(/\/$/, '');
  if (path.length > 0) {
    candidates.push(`${origin}/.well-known/${suffix}${path}`);
  }
  candidates.push(`${origin}/.well-known/${suffix}`);
  return candidates;
}

async function fetchJson<T>(
  candidates: string[] | string,
  fetchImpl: typeof fetch,
): Promise<T | undefined> {
  const urls = Array.isArray(candidates) ? candidates : [candidates];
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      if (response.ok) {
        return (await response.json()) as T;
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Dynamic Client Registration
// ---------------------------------------------------------------------------

async function registerOrReuseClient(
  asMeta: AuthorizationServerMetadata,
  redirectUri: string,
  clientName: string,
  fetchImpl: typeof fetch,
): Promise<OAuthClientCredentials> {
  if (!asMeta.registration_endpoint) {
    throw new Error(
      `OAuth server at ${asMeta.issuer} does not advertise a registration_endpoint. Configure auth.clientIdEnv for a pre-registered client, then retry talonctl auth-mcp.`,
    );
  }

  const body = {
    redirect_uris: [redirectUri],
    client_name: clientName,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };

  let response: Response;
  try {
    response = await fetchImpl(asMeta.registration_endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new Error(
      `dynamic client registration failed: ${stringify(cause)}`,
    );
  }

  if (!response.ok) {
    const text = await safeText(response);
    throw new Error(
      `dynamic client registration returned ${response.status} from ${asMeta.registration_endpoint}: ${text}`,
    );
  }

  const payload = (await response.json()) as {
    client_id?: string;
    client_secret?: string;
    token_endpoint_auth_method?: unknown;
  };
  if (typeof payload.client_id !== 'string' || payload.client_id.length === 0) {
    throw new Error('dynamic client registration response missing client_id');
  }
  if (
    payload.token_endpoint_auth_method !== undefined
    && !isOAuthTokenEndpointAuthMethod(payload.token_endpoint_auth_method)
  ) {
    const unsupportedMethod = typeof payload.token_endpoint_auth_method === 'string'
      ? payload.token_endpoint_auth_method
      : JSON.stringify(payload.token_endpoint_auth_method);
    throw new Error(
      `dynamic client registration returned unsupported token_endpoint_auth_method: ${unsupportedMethod}`,
    );
  }
  const tokenEndpointAuthMethod = isOAuthTokenEndpointAuthMethod(payload.token_endpoint_auth_method)
    ? payload.token_endpoint_auth_method
    : typeof payload.client_secret === 'string'
      ? 'client_secret_basic'
      : 'none';
  // Some providers (including Atlassian) return an unused client_secret even
  // when they explicitly register the client as public. Never retain or send
  // that secret when the declared token endpoint method is `none`.
  const hasClientSecret = tokenEndpointAuthMethod !== 'none'
    && typeof payload.client_secret === 'string'
    && payload.client_secret.length > 0;
  if (tokenEndpointAuthMethod !== 'none' && !hasClientSecret) {
    throw new Error(
      `dynamic client registration method "${tokenEndpointAuthMethod}" requires a client_secret`,
    );
  }
  return {
    clientId: payload.client_id,
    ...(hasClientSecret ? { clientSecret: payload.client_secret } : {}),
    tokenEndpointAuthMethod,
  };
}

// ---------------------------------------------------------------------------
// Callback listener + browser open
// ---------------------------------------------------------------------------

interface WaitForCallbackOptions {
  port: number;
  listenAddress: '127.0.0.1' | '0.0.0.0';
  expectedState: string;
  timeoutMs: number;
}

async function waitForCallback(options: WaitForCallbackOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, code?: string): void => {
      if (settled) return;
      settled = true;
      server.close();
      clearTimeout(timer);
      if (err) reject(err);
      else if (code) resolve(code);
      else reject(new Error('callback completed without a code'));
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!req.url) {
        res.writeHead(400).end();
        return;
      }
      let url: URL;
      try {
        url = new URL(req.url, `http://127.0.0.1:${options.port}`);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Malformed OAuth callback URL — callback ignored.');
        return;
      }
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET' }).end();
        return;
      }
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      // Do not let a caller that cannot prove it knows the OAuth state
      // terminate the pending browser flow (for example from another
      // container on Docker's shared network).
      if (state !== options.expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('OAuth state mismatch — callback ignored.');
        return;
      }
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`OAuth error: ${error}\nYou can close this tab.`);
        finish(new Error(`OAuth callback returned error: ${error}`));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('OAuth callback missing code parameter.');
        finish(new Error('OAuth callback missing code'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Authorization received. You can close this tab.');
      finish(null, code);
    });

    server.on('error', (err) => finish(err));
    server.listen(options.port, options.listenAddress);

    const timer = setTimeout(
      () => finish(new Error(`OAuth callback timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );
  });
}

function tryOpenBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      // best-effort: print already happened
    });
    child.unref();
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Code → tokens
// ---------------------------------------------------------------------------

interface ExchangeOptions {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  client: OAuthClientCredentials;
  codeVerifier: string;
  resource: string;
  scopes?: string[];
  fetchImpl: typeof fetch;
}

async function exchangeCodeForTokens(
  options: ExchangeOptions,
): Promise<Omit<CachedTokens, 'tokenEndpoint' | 'clientId' | 'clientSecret' | 'tokenEndpointAuthMethod'>> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
    resource: options.resource,
  });
  const request = addOAuthClientCredentials(body, {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  }, options.client);

  let response: Response;
  try {
    response = await options.fetchImpl(options.tokenEndpoint, {
      method: 'POST',
      redirect: 'error',
      headers: request.headers,
      body: request.body.toString(),
    });
  } catch (cause) {
    throw new Error(
      `token exchange request failed: ${stringify(cause)}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `token exchange returned ${response.status} from ${options.tokenEndpoint}`,
    );
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: unknown;
  };
  if (
    typeof payload.access_token !== 'string'
    || payload.access_token.length === 0
    || typeof payload.expires_in !== 'number'
    || !Number.isFinite(payload.expires_in)
    || payload.expires_in <= 0
    || (payload.scope !== undefined && typeof payload.scope !== 'string')
    || (payload.token_type !== undefined
      && (typeof payload.token_type !== 'string' || payload.token_type.toLowerCase() !== 'bearer'))
  ) {
    throw new Error('token exchange response has missing or unsupported fields (Bearer access_token and positive expires_in required)');
  }
  const grantedScopes = payload.scope?.split(/\s+/u).filter(Boolean);
  const requestedScopes = new Set(options.scopes ?? []);
  if (grantedScopes?.some((scope) => !requestedScopes.has(scope)) && requestedScopes.size > 0) {
    throw new Error('token exchange granted scopes broader than the explicitly requested OAuth scopes');
  }
  return {
    accessToken: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
    ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
    ...(payload.scope !== undefined
      ? { scope: payload.scope }
      : (options.scopes && options.scopes.length > 0
        ? { scope: options.scopes.join(' ') }
        : {})),
    refreshedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function sha256Base64Url(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

function stringify(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '<unreadable body>';
  }
}
