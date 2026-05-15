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
  const print = options.printLine ?? ((line) => process.stdout.write(`${line}\n`));
  const callbackPort = options.callbackPort ?? 8788;
  const clientName = options.clientName ?? `Talon (${hostname()})`;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

  const asMeta = await discoverAuthorizationServer(options.resourceUrl, fetchImpl);
  if (
    asMeta.code_challenge_methods_supported
    && !asMeta.code_challenge_methods_supported.includes('S256')
  ) {
    throw new Error(
      `OAuth server at ${asMeta.issuer} does not advertise S256 PKCE support`,
    );
  }

  const redirectUri = `http://localhost:${callbackPort}/callback`;
  const { clientId, clientSecret } = await registerOrReuseClient(
    asMeta,
    redirectUri,
    clientName,
    fetchImpl,
  );

  const verifier = randomBase64Url(64);
  const challenge = sha256Base64Url(verifier);
  const state = randomBase64Url(16);
  const scope = options.headless
    ? asMeta.scopes_supported?.join(' ')
    : asMeta.scopes_supported?.join(' ');

  const authUrl = new URL(asMeta.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('resource', options.resourceUrl);
  if (scope) authUrl.searchParams.set('scope', scope);

  const callbackPromise = waitForCallback({
    port: callbackPort,
    expectedState: state,
    timeoutMs,
  });

  if (options.headless) {
    print('');
    print('=== headless OAuth ===');
    print('On your local machine, run:');
    print(`  ssh -L ${callbackPort}:localhost:${callbackPort} <user@this-host>`);
    print('');
    print('Then open this URL in your local browser:');
    print(`  ${authUrl.toString()}`);
    print('');
    print(`Waiting for callback on localhost:${callbackPort} (timeout ${Math.round(timeoutMs / 1000)}s)…`);
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
    clientId,
    clientSecret,
    codeVerifier: verifier,
    resource: options.resourceUrl,
    fetchImpl,
  });

  return {
    tokens: {
      ...tokens,
      tokenEndpoint: asMeta.token_endpoint,
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
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
): Promise<AuthorizationServerMetadata> {
  // 1. RFC 9728 protected-resource metadata at the resource itself.
  const prMeta = await fetchProtectedResourceMetadata(resourceUrl, fetchImpl);
  if (prMeta?.authorization_servers && prMeta.authorization_servers.length > 0) {
    const asUrl = prMeta.authorization_servers[0];
    const asMeta = await fetchAuthorizationServerMetadata(asUrl, fetchImpl);
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
): Promise<AuthorizationServerMetadata | undefined> {
  const wellKnown = wellKnownUrl(baseUrl, 'oauth-authorization-server');
  const meta = await fetchJson<AuthorizationServerMetadata>(wellKnown, fetchImpl);
  if (!meta) return undefined;
  if (typeof meta.authorization_endpoint !== 'string' || typeof meta.token_endpoint !== 'string') {
    return undefined;
  }
  return meta;
}

/**
 * RFC 8414 places `.well-known/` at the origin root. We try that first
 * and fall back to a path-prefixed location so older non-conforming
 * servers still work.
 */
function wellKnownUrl(input: string, suffix: string): string[] {
  const url = new URL(input);
  const origin = `${url.protocol}//${url.host}`;
  const candidates = [`${origin}/.well-known/${suffix}`];
  const path = url.pathname.replace(/\/$/, '');
  if (path.length > 0) {
    candidates.push(`${origin}/.well-known/${suffix}${path}`);
  }
  return candidates as unknown as string[];
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
): Promise<{ clientId: string; clientSecret?: string }> {
  if (!asMeta.registration_endpoint) {
    throw new Error(
      `OAuth server at ${asMeta.issuer} does not advertise a registration_endpoint; cannot complete dynamic client registration. Pre-register a client and add its ID to the skill config manually.`,
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

  const payload = (await response.json()) as { client_id?: string; client_secret?: string };
  if (typeof payload.client_id !== 'string') {
    throw new Error('dynamic client registration response missing client_id');
  }
  return {
    clientId: payload.client_id,
    ...(typeof payload.client_secret === 'string' ? { clientSecret: payload.client_secret } : {}),
  };
}

// ---------------------------------------------------------------------------
// Callback listener + browser open
// ---------------------------------------------------------------------------

interface WaitForCallbackOptions {
  port: number;
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
      const url = new URL(req.url, `http://localhost:${options.port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`OAuth error: ${error}\nYou can close this tab.`);
        finish(new Error(`OAuth callback returned error: ${error}`));
        return;
      }
      if (state !== options.expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('OAuth state mismatch — possible CSRF. Aborted.');
        finish(new Error('OAuth state mismatch'));
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
    server.listen(options.port, '127.0.0.1');

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
  clientId: string;
  clientSecret?: string;
  codeVerifier: string;
  resource: string;
  fetchImpl: typeof fetch;
}

async function exchangeCodeForTokens(
  options: ExchangeOptions,
): Promise<Omit<CachedTokens, 'tokenEndpoint' | 'clientId' | 'clientSecret'>> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: options.codeVerifier,
    resource: options.resource,
  });
  if (options.clientSecret) body.set('client_secret', options.clientSecret);

  let response: Response;
  try {
    response = await options.fetchImpl(options.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (cause) {
    throw new Error(
      `token exchange request failed: ${stringify(cause)}`,
    );
  }

  if (!response.ok) {
    const text = await safeText(response);
    throw new Error(
      `token exchange returned ${response.status} from ${options.tokenEndpoint}: ${text}`,
    );
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (typeof payload.access_token !== 'string' || typeof payload.expires_in !== 'number') {
    throw new Error('token exchange response missing access_token or expires_in');
  }
  return {
    accessToken: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
    ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
    ...(payload.scope ? { scope: payload.scope } : {}),
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
