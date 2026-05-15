/**
 * MCP (Model Context Protocol) domain types.
 *
 * Defines the configuration and runtime types for MCP servers that personas
 * may access via the host-mediated proxy. All tool calls from sandboxes are
 * routed through the McpProxy, which enforces persona allowlists and rate
 * limits before forwarding to the backing MCP server.
 */

// ---------------------------------------------------------------------------
// Server configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a single MCP server that talond can connect to.
 *
 * Supports both local stdio-launched servers and remote SSE/HTTP transports.
 * Credentials are kept in the host process and never forwarded to sandbox
 * agent containers.
 */
export interface McpServerConfig {
  /** Unique logical name for this MCP server (e.g. `filesystem`, `github`). */
  name: string;

  /**
   * Transport type.
   * - `stdio` — launch a local process and communicate over stdin/stdout.
   * - `sse`   — connect to a remote server via Server-Sent Events.
   * - `http`  — connect to a remote server via HTTP streaming (MCP HTTP transport).
   */
  transport: 'stdio' | 'sse' | 'http';

  // --- stdio fields (required when transport === 'stdio') ------------------

  /** Executable to launch (e.g. `npx`, `/usr/local/bin/my-mcp`). */
  command?: string;
  /** Arguments passed to the process. */
  args?: string[];

  // --- remote fields (required when transport === 'sse' | 'http') ----------

  /** Base URL for SSE or HTTP transport. */
  url?: string;

  /** Custom headers sent with HTTP/SSE transport requests (e.g. Authorization). */
  headers?: Record<string, string>;

  /**
   * Dynamic auth resolved by `resolveMcpServers()` before the server entry
   * reaches a provider. The resolver materializes the credential into a
   * header on `headers` and strips this field, so providers never see it.
   */
  auth?: McpAuthConfig;

  // --- common optional fields -----------------------------------------------

  /**
   * Extra environment variables injected into the stdio child process.
   * Used to pass API keys; values are never written to disk in containers.
   */
  env?: Record<string, string>;

  /**
   * Glob / regex patterns that restrict which MCP tools this server exposes
   * to sandboxed agents. If omitted, all tools are allowed.
   *
   * Patterns are matched against the bare tool name using `micromatch`-style
   * glob syntax (e.g. `read_file`, `git_*`, `!dangerous_*`).
   */
  allowedTools?: string[];

  /**
   * Credential scope identifier.
   * Used to look up secrets from the host credential store (future task).
   * Kept here so configs can declare their credential requirements upfront.
   */
  credentialScope?: string;

  /**
   * Rate limit configuration for this server.
   * Defaults to 60 tokens per minute if not specified.
   */
  rateLimit?: McpRateLimitConfig;
}

// ---------------------------------------------------------------------------
// Auth configuration (dynamic, resolved per run)
// ---------------------------------------------------------------------------

/**
 * Auth specifications recognised by `resolveMcpServers()`. Keep the
 * discriminator on `kind` so future schemes (`basic`, `mtls`, …) land
 * without breaking existing entries.
 */
export type McpAuthConfig = McpOAuth2AuthConfig;

export interface McpOAuth2AuthConfig {
  kind: 'oauth2';
  /**
   * Opaque, filesystem-safe identifier for the cached token bundle.
   * Resolves to `<dataDir>/mcp-auth/<tokenStore>.json`. Skill-loader
   * defaults this to `<skill>/<server>` when the skill author omits it,
   * so the on-disk layout follows the same shape the CLI uses
   * (`talonctl auth-mcp <skill>:<server>`).
   */
  tokenStore: string;
}

// ---------------------------------------------------------------------------
// Rate limit configuration
// ---------------------------------------------------------------------------

/**
 * Token-bucket rate limit settings for an MCP server.
 */
export interface McpRateLimitConfig {
  /** Maximum calls allowed per minute. Defaults to 60. */
  callsPerMinute: number;
}

// ---------------------------------------------------------------------------
// Tool call / result
// ---------------------------------------------------------------------------

/**
 * A request from a sandbox agent to invoke an MCP tool on a named server.
 *
 * Passed to {@link McpProxy.handleToolCall} after being received over IPC.
 */
export interface McpToolCall {
  /** Correlates this call to the sandbox IPC request for response routing. */
  requestId: string;
  /** The logical MCP server name (must match an entry in the registry). */
  serverName: string;
  /** The MCP tool name to invoke on that server. */
  toolName: string;
  /** Arguments to forward to the MCP tool. Opaque object; shape is tool-specific. */
  args: Record<string, unknown>;
}

/**
 * The result returned from an MCP tool invocation.
 *
 * On success the `content` field carries the raw MCP response. On error the
 * McpProxy returns an `Err(McpError)` rather than populating this type.
 */
export interface McpToolResult {
  /** Echoes the originating {@link McpToolCall.requestId}. */
  requestId: string;
  /** The server that handled this call. */
  serverName: string;
  /** The tool that was invoked. */
  toolName: string;
  /** Raw result content from the MCP server. Shape is tool-specific. */
  content: unknown;
  /** Duration of the forwarded call in milliseconds (for observability). */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Server lifecycle status
// ---------------------------------------------------------------------------

/**
 * Runtime lifecycle state of a registered MCP server.
 *
 * Transitions:
 *   stopped -> starting -> running
 *   running  -> stopping -> stopped
 *   starting -> error
 *   running  -> error
 */
export type McpServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

// ---------------------------------------------------------------------------
// Registry entry
// ---------------------------------------------------------------------------

/**
 * An entry in the {@link McpRegistry} combining static config with runtime state.
 */
export interface McpServerEntry {
  /** Static configuration for this server. */
  config: McpServerConfig;
  /** Current lifecycle state. */
  status: McpServerStatus;
  /** Human-readable description of the last error, if status is `error`. */
  lastError?: string;
}
