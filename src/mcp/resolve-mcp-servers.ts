/**
 * Resolve dynamic auth on MCP server entries before they reach a
 * provider. Providers stay pure — they never inspect `auth`, never call
 * the token store, never know an Authorization header was added.
 *
 * One-pass transform on the canonical shape: take a
 * `Record<name, CanonicalMcpServer>`, for any HTTP/SSE entry with
 * `auth.kind === 'oauth2'` look up a fresh access token from the store,
 * merge `Authorization: Bearer <token>` into `headers`, and strip the
 * `auth` field. It also rejects header/stdio values that a provider could
 * expand as environment references a second time.
 *
 * Centralising the materialization here keeps token handling testable
 * in isolation and means new auth schemes land in one place, not
 * stamped across every provider serializer.
 */
import type {
  CanonicalMcpServer,
  CanonicalMcpHttpServer,
} from '../providers/provider-types.js';
import type { OAuthTokenStore } from '../auth/oauth-token-store.js';
import { isHttpsUrlWithoutUserInfoOrFragment } from '../auth/oauth-issuer.js';
import { hasProviderEnvironmentVariableReference } from '../core/config/environment.js';

export interface ResolveMcpServersOptions {
  /** Concrete token store the daemon hands in. */
  tokenStore: OAuthTokenStore;
}

/** Validate interpolation-sensitive values when OAuth resolution is unavailable. */
export function assertMcpServersSafeForProvider(
  servers: Record<string, CanonicalMcpServer>,
): void {
  for (const [name, server] of Object.entries(servers)) {
    if (server.transport === 'stdio') {
      assertNoProviderEnvironmentReferences(name, 'environment', server.env);
    } else if (server.transport !== 'sdk') {
      assertNoProviderEnvironmentReferences(name, 'header', server.headers);
    }
  }
}

/** Whether a provider run includes a remote MCP server with OAuth credentials. */
export function hasOAuthMcpAuth(servers: Record<string, CanonicalMcpServer>): boolean {
  return Object.values(servers).some(
    (server) => server.transport !== 'stdio'
      && server.transport !== 'sdk'
      && server.auth?.kind === 'oauth2',
  );
}

/**
 * Return a new map with auth resolved on HTTP entries. The input is
 * never mutated. Throws if any oauth2 entry has no cached tokens — the
 * caller (typically agent-runner) should surface that to the operator
 * with a "run talonctl auth-mcp …" pointer.
 */
export async function resolveMcpServers(
  servers: Record<string, CanonicalMcpServer>,
  options: ResolveMcpServersOptions,
): Promise<Record<string, CanonicalMcpServer>> {
  const resolved: Record<string, CanonicalMcpServer> = {};

  for (const [name, server] of Object.entries(servers)) {
    if (server.transport === 'stdio') {
      assertNoProviderEnvironmentReferences(name, 'environment', server.env);
      resolved[name] = server;
      continue;
    }
    if (server.transport === 'sdk') {
      resolved[name] = server;
      continue;
    }
    resolved[name] = await resolveHttp(server, name, options);
  }

  return resolved;
}

async function resolveHttp(
  server: CanonicalMcpHttpServer,
  name: string,
  options: ResolveMcpServersOptions,
): Promise<CanonicalMcpHttpServer> {
  if (!server.auth) {
    assertNoProviderEnvironmentReferences(name, 'header', server.headers);
    return server;
  }
  if (server.auth.kind === 'oauth2') {
    if (!isHttpsUrlWithoutUserInfoOrFragment(server.url)) {
      throw new Error(`OAuth MCP server "${name}" must use an HTTPS URL without user-info or fragments`);
    }
    const bearer = await options.tokenStore.materializeBearer(
      server.auth.tokenStore,
      {
        ...(server.auth.authorizationServerIssuer
          ? { authorizationServerIssuer: server.auth.authorizationServerIssuer }
          : {}),
        resource: server.url,
        scopes: server.auth.scopes ?? [],
      },
    );
    // Preserve caller-set Authorization by writing Bearer LAST; skills
    // that want a different scheme should not declare `auth` and set
    // their own header instead.
    const headers = {
      ...(server.headers ?? {}),
      Authorization: `Bearer ${bearer}`,
    };
    assertNoProviderEnvironmentReferences(name, 'header', headers);
    // Strip `auth` so providers never see a half-resolved entry.
    const { auth: _drop, ...rest } = server;
    void _drop;
    return { ...rest, headers };
  }
  throw new Error(`resolveMcpServers: unsupported auth.kind for server "${name}"`);
}

function assertNoProviderEnvironmentReferences(
  serverName: string,
  field: 'environment' | 'header',
  values: Record<string, string> | undefined,
): void {
  for (const [key, value] of Object.entries(values ?? {})) {
    if (hasProviderEnvironmentVariableReference(value)) {
      throw new Error(
        `MCP server "${serverName}" ${field} "${key}" contains provider-expandable environment-variable syntax; refusing to pass it to the provider`,
      );
    }
  }
}
