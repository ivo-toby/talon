import type { AgentProvider } from './provider.js';
import type { CanonicalMcpServer } from './provider-types.js';

interface WarnLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Names of the MCP servers whose `allowedTools` the provider would ignore,
 * i.e. servers that declare a list while the provider does not enforce it.
 */
export function findMcpServersWithIgnoredAllowedTools(
  provider: Pick<AgentProvider, 'enforcesMcpAllowedTools'>,
  mcpServers: Record<string, CanonicalMcpServer>,
): string[] {
  if (provider.enforcesMcpAllowedTools) return [];
  return Object.entries(mcpServers)
    .filter(([, server]) => server.transport !== 'sdk' && server.allowedTools !== undefined)
    .map(([name]) => name);
}

/**
 * Logs a warning when a run hands MCP servers with `allowedTools` to a
 * provider that ignores the field, so the operator learns that those
 * servers expose every tool on this provider. Returns the affected names.
 */
export function warnIfMcpAllowedToolsIgnored(
  provider: Pick<AgentProvider, 'name' | 'enforcesMcpAllowedTools'>,
  mcpServers: Record<string, CanonicalMcpServer>,
  logger: WarnLogger,
  fields: Record<string, unknown> = {},
): string[] {
  const ignored = findMcpServersWithIgnoredAllowedTools(provider, mcpServers);
  if (ignored.length > 0) {
    logger.warn(
      { ...fields, provider: provider.name, mcpServers: ignored },
      'provider does not enforce MCP allowedTools; these servers expose all their tools',
    );
  }
  return ignored;
}
