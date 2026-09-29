import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type AddressInfo } from 'node:net';
import { runOAuthFlow } from '../../../src/auth/oauth-flow.js';

const authorizationServerMetadata = {
  issuer: 'https://identity.example.com',
  authorization_endpoint: 'https://identity.example.com/authorize',
  token_endpoint: 'https://identity.example.com/token',
  scopes_supported: ['read:docs', 'write:docs'],
};

describe('runOAuthFlow()', () => {
  const activeFlows: Array<Promise<unknown>> = [];

  afterEach(async () => {
    await Promise.allSettled(activeFlows.splice(0));
  });

  it('uses a pre-registered client and completes the Docker callback through the IPv4 loopback', async () => {
    const callbackPort = await findAvailablePort();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let authorizationUrl: URL | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes('oauth-protected-resource')) return new Response(null, { status: 404 });
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return jsonResponse(authorizationServerMetadata);
      }
      if (url === authorizationServerMetadata.token_endpoint) {
        return jsonResponse({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const flow = runOAuthFlow({
      resourceUrl: 'https://search.example.com/mcp',
      callbackPort,
      callbackListenAddress: '0.0.0.0',
      dockerMode: true,
      timeoutMs: 3000,
      fetchImpl,
      expectedAuthorizationServerIssuer: 'https://identity.example.com',
      registeredClient: {
        clientId: 'registered-client',
        clientSecret: 'client-secret',
        tokenEndpointAuthMethod: 'client_secret_basic',
      },
      printLine: (line) => {
        const candidate = line.trim();
        if (candidate.startsWith('https://identity.example.com/authorize?')) {
          authorizationUrl = new URL(candidate);
        }
      },
    });
    activeFlows.push(flow);

    await vi.waitFor(() => expect(authorizationUrl).toBeDefined());
    expect(authorizationUrl?.searchParams.get('client_id')).toBe('registered-client');
    expect(authorizationUrl?.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${callbackPort}/callback`);
    expect(authorizationUrl?.searchParams.get('scope')).toBeNull();
    const state = authorizationUrl?.searchParams.get('state');
    expect(state).toBeTruthy();
    if (!state) throw new Error('authorization URL did not contain OAuth state');

    const rejectedCallback = await retryCallback(
      `http://127.0.0.1:${callbackPort}/callback?error=access_denied&state=attacker-state`,
    );
    expect(rejectedCallback.status).toBe(400);

    const callbackResponse = await retryCallback(
      `http://127.0.0.1:${callbackPort}/callback?code=auth-code&state=${state}`,
    );
    expect(callbackResponse.status).toBe(200);
    const result = await flow;

    const tokenRequest = requests.find((request) => request.url === authorizationServerMetadata.token_endpoint);
    expect(tokenRequest?.init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('registered-client:client-secret').toString('base64')}`,
    });
    expect(String(tokenRequest?.init?.body)).not.toContain('client_secret=');
    expect(String(tokenRequest?.init?.body)).not.toContain('client_id=');
    expect(requests.some((request) => request.url === 'https://identity.example.com/register')).toBe(false);
    expect(result.tokens).toMatchObject({
      accessToken: 'access-token',
      resource: 'https://search.example.com/mcp',
      clientId: 'registered-client',
      clientSecret: 'client-secret',
      tokenEndpointAuthMethod: 'client_secret_basic',
      authorizationServerIssuer: 'https://identity.example.com',
    });
  }, 8000);

  it('rejects authorization metadata that does not match the pinned issuer', async () => {
    const fetchImpl = (async () => jsonResponse({
      ...authorizationServerMetadata,
      issuer: 'https://attacker.example.net',
    })) as typeof fetch;

    await expect(runOAuthFlow({
      resourceUrl: 'https://search.example.com/mcp',
      expectedAuthorizationServerIssuer: 'https://identity.example.com',
      registeredClient: {
        clientId: 'registered-client',
        clientSecret: 'client-secret',
        tokenEndpointAuthMethod: 'client_secret_basic',
      },
      fetchImpl,
      printLine: vi.fn(),
    })).rejects.toThrow(/OAuth issuer mismatch/);
  });

  it('uses RFC 7591 client_secret_basic default when DCR omits the auth method', async () => {
    const callbackPort = await findAvailablePort();
    let authorizationUrl: URL | undefined;
    let tokenRequest: RequestInit | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth-protected-resource')) return new Response(null, { status: 404 });
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return jsonResponse({
          ...authorizationServerMetadata,
          registration_endpoint: 'https://identity.example.com/register',
        });
      }
      if (url === 'https://identity.example.com/register') {
        return jsonResponse({ client_id: 'dcr-client', client_secret: 'dcr-secret' });
      }
      if (url === authorizationServerMetadata.token_endpoint) {
        tokenRequest = init;
        return jsonResponse({ access_token: 'access-token', expires_in: 3600 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const flow = runOAuthFlow({
      resourceUrl: 'https://search.example.com/mcp',
      callbackPort,
      headless: true,
      scopes: ['read:docs'],
      timeoutMs: 3000,
      fetchImpl,
      printLine: (line) => {
        const candidate = line.trim();
        if (candidate.startsWith('https://identity.example.com/authorize?')) {
          authorizationUrl = new URL(candidate);
        }
      },
    });
    activeFlows.push(flow);
    await vi.waitFor(() => expect(authorizationUrl).toBeDefined());
    const state = authorizationUrl?.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(authorizationUrl?.searchParams.get('scope')).toBe('read:docs');
    const callbackResponse = await retryCallback(
      `http://127.0.0.1:${callbackPort}/callback?code=auth-code&state=${state}`,
    );
    expect(callbackResponse.status).toBe(200);
    const result = await flow;

    expect(tokenRequest?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('dcr-client:dcr-secret').toString('base64')}`,
    });
    expect(tokenRequest?.redirect).toBe('error');
    expect(String(tokenRequest?.body)).not.toContain('dcr-secret');
    expect(result.tokens).toMatchObject({
      scope: 'read:docs',
      requestedScopes: ['read:docs'],
    });
  }, 8000);

  it('ignores an extraneous client secret when DCR declares no token endpoint auth', async () => {
    const callbackPort = await findAvailablePort();
    let authorizationUrl: URL | undefined;
    let tokenRequest: RequestInit | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth-protected-resource')) return new Response(null, { status: 404 });
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return jsonResponse({
          ...authorizationServerMetadata,
          registration_endpoint: 'https://identity.example.com/register',
        });
      }
      if (url === 'https://identity.example.com/register') {
        return jsonResponse({
          client_id: 'dcr-public-client',
          client_secret: 'unexpected-secret',
          token_endpoint_auth_method: 'none',
        });
      }
      if (url === authorizationServerMetadata.token_endpoint) {
        tokenRequest = init;
        return jsonResponse({ access_token: 'access-token', expires_in: 3600 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const flow = runOAuthFlow({
      resourceUrl: 'https://search.example.com/mcp',
      callbackPort,
      headless: true,
      timeoutMs: 3000,
      fetchImpl,
      printLine: (line) => {
        const candidate = line.trim();
        if (candidate.startsWith('https://identity.example.com/authorize?')) {
          authorizationUrl = new URL(candidate);
        }
      },
    });
    activeFlows.push(flow);

    await vi.waitFor(() => expect(authorizationUrl).toBeDefined());
    const state = authorizationUrl?.searchParams.get('state');
    expect(state).toBeTruthy();
    const callbackResponse = await retryCallback(
      `http://127.0.0.1:${callbackPort}/callback?code=auth-code&state=${state}`,
    );
    expect(callbackResponse.status).toBe(200);
    const result = await flow;

    expect(tokenRequest?.headers).not.toHaveProperty('Authorization');
    expect(String(tokenRequest?.body)).toContain('client_id=dcr-public-client');
    expect(String(tokenRequest?.body)).not.toContain('client_secret=');
    expect(result.tokens).toMatchObject({
      clientId: 'dcr-public-client',
      tokenEndpointAuthMethod: 'none',
    });
    expect(result.tokens.clientSecret).toBeUndefined();
  }, 8000);

  it('rejects non-HTTPS OAuth endpoints before starting the authorization flow', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return jsonResponse({
          ...authorizationServerMetadata,
          token_endpoint: 'http://identity.example.com/token',
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const printLine = vi.fn();

    await expect(runOAuthFlow({
      resourceUrl: 'https://search.example.com/mcp',
      fetchImpl,
      printLine,
    })).rejects.toThrow(/must use HTTPS endpoints/);
    expect(printLine).not.toHaveBeenCalled();
  });

  it('rejects a non-HTTPS OAuth resource before discovery', async () => {
    const fetchImpl = vi.fn() as typeof fetch;
    await expect(runOAuthFlow({
      resourceUrl: 'http://search.example.com/mcp',
      fetchImpl,
      printLine: vi.fn(),
    })).rejects.toThrow(/resource URL must use HTTPS/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects insecure authorization-server issuers before fetching their metadata', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('oauth-protected-resource')) {
        return jsonResponse({
          resource: 'https://search.example.com/mcp',
          authorization_servers: ['http://127.0.0.1:8080'],
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    await expect(runOAuthFlow({
      resourceUrl: 'https://search.example.com/mcp',
      fetchImpl,
      printLine: vi.fn(),
    })).rejects.toThrow(/authorization server identifiers must use HTTPS/);
    expect(requestedUrls.some((url) => url.startsWith('http://127.0.0.1'))).toBe(false);
  });

  it('rejects a token response that is not a Bearer token', async () => {
    const callbackPort = await findAvailablePort();
    let authorizationUrl: URL | undefined;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('oauth-protected-resource')) return new Response(null, { status: 404 });
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return jsonResponse(authorizationServerMetadata);
      }
      if (url === authorizationServerMetadata.token_endpoint) {
        return jsonResponse({ access_token: 'access-token', token_type: 'DPoP', expires_in: 3600 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    let flowError: unknown;
    const flow = runOAuthFlow({
      resourceUrl: 'https://search.example.com/mcp',
      callbackPort,
      headless: true,
      registeredClient: {
        clientId: 'registered-client',
        tokenEndpointAuthMethod: 'none',
      },
      timeoutMs: 3000,
      fetchImpl,
      printLine: (line) => {
        const candidate = line.trim();
        if (candidate.startsWith('https://identity.example.com/authorize?')) {
          authorizationUrl = new URL(candidate);
        }
      },
    });
    const settledFlow = flow.catch((cause: unknown) => {
      flowError = cause;
    });
    activeFlows.push(settledFlow);

    await vi.waitFor(() => expect(authorizationUrl).toBeDefined());
    const state = authorizationUrl?.searchParams.get('state');
    const callbackResponse = await retryCallback(
      `http://127.0.0.1:${callbackPort}/callback?code=auth-code&state=${state}`,
    );
    expect(callbackResponse.status).toBe(200);
    await settledFlow;
    expect(flowError).toBeInstanceOf(Error);
    expect((flowError as Error).message).toMatch(/unsupported fields.*Bearer/);
  }, 8000);

  it('rejects a token response broader than the explicitly requested scopes', async () => {
    const callbackPort = await findAvailablePort();
    let authorizationUrl: URL | undefined;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('oauth-protected-resource')) return new Response(null, { status: 404 });
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return jsonResponse(authorizationServerMetadata);
      }
      if (url === 'https://identity.example.com/register') {
        return jsonResponse({ client_id: 'dcr-client' });
      }
      if (url === authorizationServerMetadata.token_endpoint) {
        return jsonResponse({
          access_token: 'access-token',
          expires_in: 3600,
          scope: 'read:docs admin',
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    let flowError: unknown;
    const flow = runOAuthFlow({
      resourceUrl: 'https://search.example.com/mcp',
      callbackPort,
      headless: true,
      scopes: ['read:docs'],
      registeredClient: {
        clientId: 'registered-client',
        tokenEndpointAuthMethod: 'none',
      },
      timeoutMs: 3000,
      fetchImpl,
      printLine: (line) => {
        const candidate = line.trim();
        if (candidate.startsWith('https://identity.example.com/authorize?')) {
          authorizationUrl = new URL(candidate);
        }
      },
    });
    const settledFlow = flow.catch((cause: unknown) => {
      flowError = cause;
    });
    activeFlows.push(settledFlow);

    await vi.waitFor(() => expect(authorizationUrl).toBeDefined());
    const state = authorizationUrl?.searchParams.get('state');
    const callbackResponse = await retryCallback(
      `http://127.0.0.1:${callbackPort}/callback?code=auth-code&state=${state}`,
    );
    expect(callbackResponse.status).toBe(200);
    await settledFlow;
    expect(flowError).toBeInstanceOf(Error);
    expect((flowError as Error).message).toMatch(/granted scopes broader/);
  }, 8000);

  it('explains how to use a pre-registered client when DCR is unavailable', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('oauth-protected-resource')) return new Response(null, { status: 404 });
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return jsonResponse(authorizationServerMetadata);
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    await expect(runOAuthFlow({
      resourceUrl: 'https://search.example.com/mcp',
      fetchImpl,
      printLine: vi.fn(),
    })).rejects.toThrow(/configure auth\.clientIdEnv/i);
  });
});

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function retryCallback(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      return await fetch(url);
    } catch (cause) {
      lastError = cause;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
