/**
 * `talonctl auth-mcp <skill>:<server>` — one-time interactive OAuth
 * dance for HTTP MCP servers.
 *
 * Looks up `skills/<skill>/mcp/<server>.json`, reads the configured URL
 * and tokenStore id (defaulting to `<skill>/<server>`), drives the
 * OAuth flow (RFC 9728 discovery → DCR → PKCE → token exchange), and
 * persists the resulting bundle at
 * `<dataDir>/mcp-auth/<tokenStore>.json`. The daemon picks the cache
 * up on the next agent run via `resolveMcpServers()` — no daemon
 * restart required.
 *
 * Two modes:
 *   - default: opens the local browser. Use when running talonctl on
 *     the same desktop as the operator.
 *   - `--headless`: prints the authorization URL and the SSH
 *     port-forward command. Use when running talonctl on the daemon's
 *     server over SSH.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runOAuthFlow } from '../../auth/oauth-flow.js';
import { writeTokens, type CachedTokens } from '../../auth/oauth-token-store.js';

export interface AuthMcpOptions {
  /** Selector in `<skill>:<server>` form. */
  selector: string;
  /** Root data dir; tokens land under `<dataDir>/mcp-auth/`. */
  dataDir: string;
  /** Skills root (`skills/`). */
  skillsDir: string;
  /** Local callback port. Default 8788. */
  callbackPort?: number;
  /** Headless mode (no browser open). */
  headless?: boolean;
  /** Where to print human-readable progress. */
  printLine?: (line: string) => void;
}

export interface AuthMcpResult {
  /** Resolved tokenStore identifier (e.g. `glean/glean`). */
  tokenStoreId: string;
  /** Path of the token bundle written to disk. */
  tokenFilePath: string;
  /** Expiry of the access token just obtained (Unix ms). */
  expiresAt: number;
}

/**
 * Pure entry point — no console output, returns the result. The CLI
 * wrapper in `cli/index.ts` handles config loading + exit codes.
 */
export async function authMcp(options: AuthMcpOptions): Promise<AuthMcpResult> {
  const { skill, server } = parseSelector(options.selector);
  const skillDir = join(options.skillsDir, skill);
  const mcpFile = join(skillDir, 'mcp', `${server}.json`);

  let raw: string;
  try {
    raw = await readFile(mcpFile, 'utf8');
  } catch (cause) {
    throw new AuthMcpError(
      `MCP server definition not found at ${mcpFile}. Check that the skill name is "${skill}" and the file is named "${server}.json".`,
      cause,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new AuthMcpError(`failed to parse ${mcpFile} as JSON`, cause);
  }

  const serverDef = parsed as {
    config?: {
      transport?: string;
      url?: string;
      auth?: { kind?: string; tokenStore?: string };
    };
  };
  const cfg = serverDef.config ?? {};
  if (cfg.transport !== 'http' && cfg.transport !== 'sse') {
    throw new AuthMcpError(
      `${mcpFile}: auth-mcp only supports HTTP/SSE MCP servers; got transport "${cfg.transport ?? '<missing>'}".`,
    );
  }
  if (typeof cfg.url !== 'string' || cfg.url.length === 0) {
    throw new AuthMcpError(`${mcpFile}: HTTP MCP entry is missing a "url" field.`);
  }
  if (cfg.auth?.kind !== 'oauth2') {
    throw new AuthMcpError(
      `${mcpFile}: entry has no "auth.kind: oauth2" — add it to enable OAuth-managed credentials.`,
    );
  }
  const tokenStoreId =
    typeof cfg.auth.tokenStore === 'string' && cfg.auth.tokenStore.length > 0
      ? cfg.auth.tokenStore
      : `${skill}/${server}`;

  const print = options.printLine ?? ((line) => process.stdout.write(`${line}\n`));
  print(`auth-mcp: ${skill}:${server}`);
  print(`  resource: ${cfg.url}`);
  print(`  tokenStore: ${tokenStoreId}`);

  const { tokens } = await runOAuthFlow({
    resourceUrl: cfg.url,
    callbackPort: options.callbackPort,
    headless: options.headless,
    printLine: print,
  });

  const bundle: CachedTokens = tokens;
  await writeTokens(options.dataDir, tokenStoreId, bundle);

  const filePath = resolve(options.dataDir, 'mcp-auth', `${tokenStoreId}.json`);
  print('');
  print('auth-mcp: success');
  print(`  wrote ${filePath}`);
  print(`  expires_at: ${new Date(bundle.expiresAt).toISOString()}`);
  return { tokenStoreId, tokenFilePath: filePath, expiresAt: bundle.expiresAt };
}

export class AuthMcpError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'AuthMcpError';
  }
}

function parseSelector(selector: string): { skill: string; server: string } {
  const trimmed = selector.trim();
  const colon = trimmed.indexOf(':');
  if (colon <= 0 || colon === trimmed.length - 1) {
    throw new AuthMcpError(
      `invalid selector "${selector}". Expected "<skill>:<server>", e.g. "glean:glean".`,
    );
  }
  return {
    skill: trimmed.slice(0, colon),
    server: trimmed.slice(colon + 1),
  };
}
