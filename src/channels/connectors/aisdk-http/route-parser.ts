/**
 * Express-style route pattern parser for the aisdk-http channel.
 *
 * Converts patterns like "/agents/:agentId/stream" to a regex that captures
 * named path parameters.
 */

interface ParsedRoute {
  regex: RegExp;
  paramNames: string[];
}

/**
 * Pre-compile an Express-style route pattern to a regex + param name list.
 * Segments like :paramName are captured as groups.
 */
export function parseRoute(pattern: string): ParsedRoute {
  const paramNames: string[] = [];
  const regexStr = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
      paramNames.push(name);
      return '([^/]+)';
    });
  const regex = new RegExp(`^${regexStr}$`);
  return { regex, paramNames };
}

/**
 * Match a URL pathname against a route pattern.
 * Returns extracted param values, or null if no match.
 */
export function matchRoute(
  pattern: string,
  url: string,
): Record<string, string> | null {
  const pathname = url.split('?')[0] ?? url;
  const { regex, paramNames } = parseRoute(pattern);
  const match = regex.exec(pathname);
  if (!match) return null;
  const params: Record<string, string> = {};
  paramNames.forEach((name, i) => {
    params[name] = match[i + 1] ?? '';
  });
  return params;
}
