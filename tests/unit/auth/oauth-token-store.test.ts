import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OAuthTokenStore,
  TokenStoreError,
  readTokens,
  tokenFilePath,
  writeTokens,
  type CachedTokens,
} from '../../../src/auth/oauth-token-store.js';

function mkTokens(overrides: Partial<CachedTokens> = {}): CachedTokens {
  return {
    accessToken: 'access-original',
    refreshToken: 'refresh-original',
    expiresAt: Date.now() + 60 * 60 * 1000,
    tokenEndpoint: 'https://idp.example.com/token',
    resource: 'https://idp.example.com/resource',
    requestedScopes: [],
    clientId: 'client-abc',
    ...overrides,
  };
}

describe('tokenFilePath', () => {
  it('resolves to <dataDir>/mcp-auth/<id>.json', () => {
    expect(tokenFilePath('/tmp/data', 'glean/glean')).toBe(
      '/tmp/data/mcp-auth/glean/glean.json',
    );
  });

  it('rejects absolute identifiers', () => {
    expect(() => tokenFilePath('/tmp/data', '/etc/passwd')).toThrow(/must be relative/);
    expect(() => tokenFilePath('/tmp/data', '/foo')).toThrow(/must be relative/);
  });

  it('rejects path-traversal that would escape the mcp-auth dir', () => {
    expect(() => tokenFilePath('/tmp/data', '../escape')).toThrow(/\.\./);
    expect(() => tokenFilePath('/tmp/data', '..//escape')).toThrow(/\.\./);
    // `glean/../escape` normalizes to `escape` and stays inside
    // mcp-auth/, so it isn't an escape per se — the assertion is that
    // we don't crash and the resolved file is still under mcp-auth.
    expect(tokenFilePath('/tmp/data', 'glean/../escape')).toBe(
      '/tmp/data/mcp-auth/escape.json',
    );
  });

  it('rejects empty identifiers', () => {
    expect(() => tokenFilePath('/tmp/data', '')).toThrow(/non-empty/);
    expect(() => tokenFilePath('/tmp/data', '   ')).toThrow(/non-empty/);
  });
});

describe('writeTokens / readTokens', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'talon-token-store-'));
  });

  it('round-trips a bundle on disk', async () => {
    const tokens = mkTokens();
    await writeTokens(dataDir, 'glean/glean', tokens);
    const read = await readTokens(dataDir, 'glean/glean');
    expect(read).toEqual(tokens);
  });

  it('returns undefined for missing files (not an error)', async () => {
    const read = await readTokens(dataDir, 'absent/absent');
    expect(read).toBeUndefined();
  });

  it('writes with restricted mode (operator-only readable)', async () => {
    const tokens = mkTokens();
    await writeTokens(dataDir, 'glean/glean', tokens);
    const { stat } = await import('node:fs/promises');
    const s = await stat(join(dataDir, 'mcp-auth/glean/glean.json'));
    // tmpfs/CI may not preserve mode exactly; assert no world bits at minimum.
    expect(s.mode & 0o077).toBe(0);
  });

  it('rejects malformed bundles with a clear error', async () => {
    const path = tokenFilePath(dataDir, 'broken/broken');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dataDir, 'mcp-auth/broken'), { recursive: true });
    writeFileSync(path, JSON.stringify({ notATokenBundle: true }));
    await expect(readTokens(dataDir, 'broken/broken')).rejects.toThrow(/malformed/);
  });
});

describe('OAuthTokenStore.materializeBearer', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'talon-token-store-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the cached access token when it is well within expiry', async () => {
    const tokens = mkTokens({ expiresAt: 2_000_000_000_000 }); // far future
    await writeTokens(dataDir, 'glean/glean', tokens);
    const store = new OAuthTokenStore({ dataDir, now: () => 1_000_000_000_000 });
    const bearer = await store.materializeBearer('glean/glean');
    expect(bearer).toBe('access-original');
  });

  it('refreshes when the access token is within the refresh buffer', async () => {
    const now = 1_000_000;
    const resource = 'https://search.example.com/mcp';
    const tokens = mkTokens({ resource, expiresAt: now + 1000 }); // 1s left — under default 60s buffer
    await writeTokens(dataDir, 'glean/glean', tokens);

    let requestBody = '';
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requestBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({ access_token: 'access-NEW', refresh_token: 'refresh-NEW', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const store = new OAuthTokenStore({ dataDir, now: () => now, fetchImpl });
    const bearer = await store.materializeBearer('glean/glean');
    expect(bearer).toBe('access-NEW');

    // Persisted refreshed bundle so the next run picks it up.
    const persisted = await readTokens(dataDir, 'glean/glean');
    expect(persisted?.accessToken).toBe('access-NEW');
    expect(persisted?.refreshToken).toBe('refresh-NEW');
    expect(persisted?.expiresAt).toBe(now + 3600 * 1000);
    expect(new URLSearchParams(requestBody).get('resource')).toBe(resource);
    expect(persisted?.resource).toBe(resource);
  });

  it('refreshes a pre-registered client without persisting its credentials', async () => {
    const now = 1_000_000;
    const clientId = 'pre-registered-client';
    const clientSecret = 'pre-registered-secret';
    vi.stubEnv('MCP_REFRESH_CLIENT_ID', clientId);
    vi.stubEnv('MCP_REFRESH_CLIENT_SECRET', clientSecret);
    const tokens = mkTokens({
      clientId: undefined,
      clientSecret: undefined,
      authorizationServerIssuer: 'https://identity.example.com',
      clientIdEnv: 'MCP_REFRESH_CLIENT_ID',
      clientSecretEnv: 'MCP_REFRESH_CLIENT_SECRET',
      expiresAt: now + 1000,
    });
    await writeTokens(dataDir, 'private/private', tokens);

    let requestInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requestInit = init;
      return new Response(
        JSON.stringify({ access_token: 'access-NEW', refresh_token: 'refresh-NEW', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const store = new OAuthTokenStore({ dataDir, now: () => now, fetchImpl });
    expect(await store.materializeBearer('private/private')).toBe('access-NEW');

    const headers = requestInit?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /u);
    expect(requestInit?.body).not.toContain(clientId);
    expect(requestInit?.body).not.toContain(clientSecret);
    const persisted = await readTokens(dataDir, 'private/private');
    expect(persisted?.clientIdEnv).toBe('MCP_REFRESH_CLIENT_ID');
    expect(persisted?.clientSecretEnv).toBe('MCP_REFRESH_CLIENT_SECRET');
    expect(persisted?.clientId).toBeUndefined();
    expect(persisted?.clientSecret).toBeUndefined();
    expect(persisted?.authorizationServerIssuer).toBe('https://identity.example.com');
  });

  it('checks the pinned issuer before sending a refresh token', async () => {
    const now = 1_000_000;
    const tokens = mkTokens({
      authorizationServerIssuer: 'https://old-identity.example.com',
      expiresAt: now - 1000,
    });
    await writeTokens(dataDir, 'glean/glean', tokens);
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 })) as typeof fetch;
    const store = new OAuthTokenStore({ dataDir, now: () => now, fetchImpl });

    await expect(
      store.materializeBearer('glean/glean', {
        authorizationServerIssuer: 'https://identity.example.com',
        resource: tokens.resource!,
        scopes: [],
      }),
    ).rejects.toThrow(/do not match authorizationServerIssuer/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a cached token when its MCP resource does not match the configured URL', async () => {
    const tokens = mkTokens({ expiresAt: Date.now() + 60_000 });
    await writeTokens(dataDir, 'shared/shared', tokens);
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 })) as typeof fetch;
    const store = new OAuthTokenStore({ dataDir, fetchImpl });

    await expect(store.materializeBearer('shared/shared', {
      resource: 'https://attacker.example/mcp',
      scopes: [],
    })).rejects.toThrow(/different MCP resource/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects cached grants after scope changes or when grants exceed the current allowlist', async () => {
    const tokens = mkTokens({
      scope: 'search:read search:write admin',
      requestedScopes: ['search:read', 'search:write'],
      expiresAt: Date.now() + 60_000,
    });
    await writeTokens(dataDir, 'shared/shared', tokens);
    const store = new OAuthTokenStore({ dataDir });

    await expect(store.materializeBearer('shared/shared', {
      resource: tokens.resource!,
      scopes: ['search:read'],
    })).rejects.toThrow(/different requested scopes/);
    await expect(store.materializeBearer('shared/shared', {
      resource: tokens.resource!,
      scopes: ['search:read', 'search:write'],
    })).rejects.toThrow(/outside the current MCP configuration/);
  });

  it('does not persist refreshed tokens that broaden the configured scopes', async () => {
    const now = 1_000_000;
    const tokens = mkTokens({
      scope: 'search:read',
      requestedScopes: ['search:read'],
      expiresAt: now + 1000,
    });
    await writeTokens(dataDir, 'scoped/scoped', tokens);
    const fetchImpl = (async () => new Response(
      JSON.stringify({ access_token: 'too-broad', scope: 'search:read admin', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
    const store = new OAuthTokenStore({ dataDir, now: () => now, fetchImpl });

    await expect(store.materializeBearer('scoped/scoped', {
      resource: tokens.resource!,
      scopes: ['search:read'],
    })).rejects.toThrow(/outside the current MCP configuration/);
    expect((await readTokens(dataDir, 'scoped/scoped'))?.accessToken).toBe('access-original');
  });

  it('preserves the original refresh_token when IdP omits it', async () => {
    const now = 1_000_000;
    const tokens = mkTokens({ expiresAt: now + 1000 });
    await writeTokens(dataDir, 'glean/glean', tokens);

    const fetchImpl = (async () => {
      return new Response(
        // Note: no refresh_token in response
        JSON.stringify({ access_token: 'access-NEW', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const store = new OAuthTokenStore({ dataDir, now: () => now, fetchImpl });
    await store.materializeBearer('glean/glean');
    const persisted = await readTokens(dataDir, 'glean/glean');
    expect(persisted?.refreshToken).toBe('refresh-original');
  });

  it('throws TokenStoreError with a helpful message when no bundle exists', async () => {
    const store = new OAuthTokenStore({ dataDir });
    await expect(store.materializeBearer('absent/absent')).rejects.toThrow(
      /no cached tokens.*talonctl auth-mcp/,
    );
  });

  it('throws when the cached token is expired and there is no refresh_token', async () => {
    const now = 1_000_000;
    const tokens = mkTokens({ expiresAt: now - 1000, refreshToken: undefined });
    await writeTokens(dataDir, 'glean/glean', tokens);
    const store = new OAuthTokenStore({ dataDir, now: () => now });
    await expect(store.materializeBearer('glean/glean')).rejects.toThrow(
      /expired and no refresh_token/,
    );
  });

  it('coalesces concurrent materializations so refresh runs only once', async () => {
    const now = 1_000_000;
    const tokens = mkTokens({ expiresAt: now + 1000 });
    await writeTokens(dataDir, 'glean/glean', tokens);

    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      // Simulate latency so parallel callers pile up.
      await new Promise((r) => setTimeout(r, 10));
      return new Response(
        JSON.stringify({ access_token: 'access-NEW', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const store = new OAuthTokenStore({ dataDir, now: () => now, fetchImpl });
    const [a, b, c] = await Promise.all([
      store.materializeBearer('glean/glean'),
      store.materializeBearer('glean/glean'),
      store.materializeBearer('glean/glean'),
    ]);
    expect(a).toBe('access-NEW');
    expect(b).toBe('access-NEW');
    expect(c).toBe('access-NEW');
    expect(calls).toBe(1);
  });

  it('surfaces a TokenStoreError when the IdP rejects the refresh', async () => {
    const now = 1_000_000;
    const tokens = mkTokens({ expiresAt: now + 1000 });
    await writeTokens(dataDir, 'glean/glean', tokens);

    const fetchImpl = (async () => {
      return new Response('invalid_grant', { status: 400 });
    }) as typeof fetch;

    const store = new OAuthTokenStore({ dataDir, now: () => now, fetchImpl });
    await expect(store.materializeBearer('glean/glean')).rejects.toBeInstanceOf(TokenStoreError);
  });

  it('rejects a refreshed non-Bearer access token', async () => {
    const now = 1_000_000;
    await writeTokens(dataDir, 'glean/glean', mkTokens({ expiresAt: now + 1000 }));
    const fetchImpl = (async () => new Response(
      JSON.stringify({ access_token: 'access-NEW', token_type: 'DPoP', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
    const store = new OAuthTokenStore({ dataDir, now: () => now, fetchImpl });

    await expect(store.materializeBearer('glean/glean')).rejects.toThrow(/missing required fields/);
  });

  it('writeTokens followed by external read sees the new bundle (atomic via rename)', async () => {
    const tokens = mkTokens({ accessToken: 'first' });
    await writeTokens(dataDir, 'glean/glean', tokens);
    await writeTokens(dataDir, 'glean/glean', { ...tokens, accessToken: 'second' });
    const raw = readFileSync(join(dataDir, 'mcp-auth/glean/glean.json'), 'utf8');
    expect(JSON.parse(raw).accessToken).toBe('second');
  });
});
