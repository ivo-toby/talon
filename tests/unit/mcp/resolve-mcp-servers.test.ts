import { describe, it, expect, vi } from 'vitest';
import { resolveMcpServers } from '../../../src/mcp/resolve-mcp-servers.js';
import type { CanonicalMcpServer } from '../../../src/providers/provider-types.js';

function fakeTokenStore(bearer: string) {
  return {
    materializeBearer: async (id: string) => `${bearer}:${id}`,
  } as unknown as import('../../../src/auth/oauth-token-store.js').OAuthTokenStore;
}

describe('resolveMcpServers', () => {
  it('passes stdio entries through unchanged', async () => {
    const servers: Record<string, CanonicalMcpServer> = {
      filesystem: {
        transport: 'stdio',
        command: 'node',
        args: ['fs-server.js'],
        env: { FOO: 'bar' },
      },
    };
    const resolved = await resolveMcpServers(servers, {
      tokenStore: fakeTokenStore('NEVER'),
    });
    expect(resolved.filesystem).toEqual(servers.filesystem);
  });

  it('rejects provider-expandable placeholders in resolved stdio environment values', async () => {
    await expect(resolveMcpServers({
      localSearch: {
        transport: 'stdio',
        command: 'node',
        args: ['search.js'],
        env: { API_TOKEN: '${NESTED_SECRET}' },
      },
    }, {
      tokenStore: fakeTokenStore('unused'),
    })).rejects.toThrow(/environment "API_TOKEN" contains provider-expandable environment-variable syntax/i);
  });

  it('passes HTTP entries without auth through unchanged', async () => {
    const servers: Record<string, CanonicalMcpServer> = {
      github: {
        transport: 'http',
        url: 'https://api.github.com/mcp',
        headers: { 'X-API-Key': 'static' },
      },
    };
    const resolved = await resolveMcpServers(servers, {
      tokenStore: fakeTokenStore('NEVER'),
    });
    expect(resolved.github).toEqual(servers.github);
  });

  it('rejects provider-expandable placeholders in resolved HTTP headers', async () => {
    await expect(resolveMcpServers({
      github: {
        transport: 'http',
        url: 'https://api.github.com/mcp',
        headers: { Authorization: 'Bearer ${NESTED_SECRET}' },
      },
    }, {
      tokenStore: fakeTokenStore('unused'),
    })).rejects.toThrow(/header "Authorization" contains provider-expandable environment-variable syntax/i);
  });

  it('materializes Bearer header for HTTP+oauth2 entries and strips `auth`', async () => {
    const servers: Record<string, CanonicalMcpServer> = {
      glean: {
        transport: 'http',
        url: 'https://contentful-be.glean.com/mcp/default',
        auth: { kind: 'oauth2', tokenStore: 'glean/glean' },
      },
    };

    const resolved = await resolveMcpServers(servers, {
      tokenStore: fakeTokenStore('access'),
    });

    expect(resolved.glean).toEqual({
      transport: 'http',
      url: 'https://contentful-be.glean.com/mcp/default',
      headers: { Authorization: 'Bearer access:glean/glean' },
    });
    // Provider never sees the auth field.
    expect((resolved.glean as Record<string, unknown>).auth).toBeUndefined();
  });

  it('rejects OAuth bearer tokens that a provider could expand as an environment reference', async () => {
    const secretPlaceholder = '${DAEMON_SECRET}';
    await expect(resolveMcpServers({
      remote: {
        transport: 'http',
        url: 'https://search.example.com/mcp',
        auth: { kind: 'oauth2', tokenStore: 'search/remote' },
      },
    }, {
      tokenStore: {
        materializeBearer: vi.fn().mockResolvedValue(secretPlaceholder),
      } as unknown as import('../../../src/auth/oauth-token-store.js').OAuthTokenStore,
    })).rejects.toThrow(/header "Authorization" contains provider-expandable environment-variable syntax/i);
  });

  it('binds cached OAuth credentials to the configured issuer, resource URL, and scopes', async () => {
    const materializeBearer = vi.fn(async () => 'bound-access');
    await resolveMcpServers({
      privateSearch: {
        transport: 'http',
        url: 'https://search.example.com/mcp',
        auth: {
          kind: 'oauth2',
          tokenStore: 'search/privateSearch',
          authorizationServerIssuer: 'https://identity.example.com',
          scopes: ['search:read'],
        },
      },
    }, {
      tokenStore: { materializeBearer } as unknown as import('../../../src/auth/oauth-token-store.js').OAuthTokenStore,
    });

    expect(materializeBearer).toHaveBeenCalledWith('search/privateSearch', {
      authorizationServerIssuer: 'https://identity.example.com',
      resource: 'https://search.example.com/mcp',
      scopes: ['search:read'],
    });
  });

  it('refuses to send OAuth credentials to an insecure resource URL', async () => {
    const materializeBearer = vi.fn().mockResolvedValue('access');
    await expect(resolveMcpServers({
      insecure: {
        transport: 'http',
        url: 'http://example.com/mcp',
        auth: { kind: 'oauth2', tokenStore: 'insecure/server' },
      },
    }, {
      tokenStore: { materializeBearer } as unknown as import('../../../src/auth/oauth-token-store.js').OAuthTokenStore,
    })).rejects.toThrow(/must use an HTTPS URL/);
    expect(materializeBearer).not.toHaveBeenCalled();
  });

  it('merges Bearer alongside any caller-set headers and lets Bearer win on collision', async () => {
    const servers: Record<string, CanonicalMcpServer> = {
      glean: {
        transport: 'http',
        url: 'https://glean.example.com/mcp',
        headers: { 'X-Trace': 't1', Authorization: 'should-be-replaced' },
        auth: { kind: 'oauth2', tokenStore: 'glean/glean' },
      },
    };
    const resolved = await resolveMcpServers(servers, {
      tokenStore: fakeTokenStore('NEW'),
    });
    const out = resolved.glean as { headers: Record<string, string> };
    expect(out.headers['X-Trace']).toBe('t1');
    expect(out.headers.Authorization).toBe('Bearer NEW:glean/glean');
  });

  it('throws when an HTTP entry declares an unsupported auth kind', async () => {
    const servers: Record<string, CanonicalMcpServer> = {
      odd: {
        transport: 'http',
        url: 'https://example.com',
        // @ts-expect-error future kind not yet supported
        auth: { kind: 'mtls' },
      },
    };
    await expect(
      resolveMcpServers(servers, { tokenStore: fakeTokenStore('NEVER') }),
    ).rejects.toThrow(/unsupported auth.kind/);
  });
});
