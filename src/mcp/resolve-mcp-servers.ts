/**
 * Resolve dynamic auth on MCP server entries before they reach a
 * provider. Providers stay pure — they never inspect `auth`, never call
 * the token store, never know an Authorization header was added.
 *
 * One-pass transform on the canonical shape: take a
 * `Record<name, CanonicalMcpServer>`, for any HTTP/SSE entry with
 * `auth.kind === 'oauth2'` look up a fresh access token from the store,
 * merge `Authorization: Bearer <token>` into `headers`, and strip the
 * `auth` field. stdio/sdk entries pass through unchanged.
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

export interface ResolveMcpServersOptions {
  /** Concrete token store the daemon hands in. */
  tokenStore: OAuthTokenStore;
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
    if (server.transport === 'stdio' || server.transport === 'sdk') {
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
    return server;
  }
  if (server.auth.kind === 'oauth2') {
    const bearer = await options.tokenStore.materializeBearer(server.auth.tokenStore);
    // Preserve caller-set Authorization by writing Bearer LAST; skills
    // that want a different scheme should not declare `auth` and set
    // their own header instead.
    const headers = {
      ...(server.headers ?? {}),
      Authorization: `Bearer ${bearer}`,
    };
    // Strip `auth` so providers never see a half-resolved entry.
    const { auth: _drop, ...rest } = server;
    void _drop;
    return { ...rest, headers };
  }
  throw new Error(`resolveMcpServers: unsupported auth.kind for server "${name}"`);
}
