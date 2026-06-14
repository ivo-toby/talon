import { describe, it, expect, beforeEach } from 'vitest';
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

  it('returns the cached access token when it is well within expiry', async () => {
    const tokens = mkTokens({ expiresAt: 2_000_000_000_000 }); // far future
    await writeTokens(dataDir, 'glean/glean', tokens);
    const store = new OAuthTokenStore({ dataDir, now: () => 1_000_000_000_000 });
    const bearer = await store.materializeBearer('glean/glean');
    expect(bearer).toBe('access-original');
  });

  it('refreshes when the access token is within the refresh buffer', async () => {
    const now = 1_000_000;
    const tokens = mkTokens({ expiresAt: now + 1000 }); // 1s left — under default 60s buffer
    await writeTokens(dataDir, 'glean/glean', tokens);

    const fetchImpl = (async (_url: string, _init?: RequestInit) => {
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

  it('writeTokens followed by external read sees the new bundle (atomic via rename)', async () => {
    const tokens = mkTokens({ accessToken: 'first' });
    await writeTokens(dataDir, 'glean/glean', tokens);
    await writeTokens(dataDir, 'glean/glean', { ...tokens, accessToken: 'second' });
    const raw = readFileSync(join(dataDir, 'mcp-auth/glean/glean.json'), 'utf8');
    expect(JSON.parse(raw).accessToken).toBe('second');
  });
});
