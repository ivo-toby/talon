export type ProviderName = string;

import type { ReasoningEffort } from '../core/config/config-types.js';

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalCostUsd?: number;
}

export type ContextMetricName =
  | 'input_tokens'
  | 'cache_read_input_tokens'
  | 'cache_creation_input_tokens'
  | 'cache_total_input_tokens';

export interface ContextUsage {
  inputTokens: number;
  metrics: Partial<Record<ContextMetricName, number>>;
}

export interface ResolvedContextUsage {
  ratio: number;
  inputTokens: number;
  rawMetric: number;
  rawMetricName: string;
}

export interface CanonicalMcpStdioServer {
  transport: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface CanonicalMcpHttpServer {
  transport: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
  /**
   * Optional dynamic auth resolved by `resolveMcpServers()` before the
   * server entry is handed to a provider. Once resolved, the materialized
   * credential is merged into `headers` and `auth` is stripped — providers
   * never see this field. Stays simple so adding new auth kinds doesn't
   * require touching every provider.
   */
  auth?: McpAuthSpec;
}

/**
 * Auth specifications recognised by `resolveMcpServers()`. Keep the
 * discriminator on `kind` so future schemes (e.g. `basic`, `mtls`) can
 * be added without breaking existing entries.
 */
export type McpAuthSpec = McpOAuth2AuthSpec;

export interface McpOAuth2AuthSpec {
  kind: 'oauth2';
  /**
   * Identifier for the cached token bundle, scoped per skill at runtime.
   * Resolves to `data/mcp-auth/<skill>/<tokenStore>.json`. The cache is
   * written by `talonctl auth-mcp` and refreshed in-place by the daemon's
   * token store helper when the access token nears expiry.
   */
  tokenStore: string;
}

export interface CanonicalMcpSdkServer {
  transport: 'sdk';
  /** Live McpServer instance from @modelcontextprotocol/sdk - not serializable. */
  instance: unknown;
}

export type CanonicalMcpServer =
  | CanonicalMcpStdioServer
  | CanonicalMcpHttpServer
  | CanonicalMcpSdkServer;

export interface ProviderResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
  /**
   * Cumulative token usage for the whole run — what the user was billed
   * for. Use this for telemetry and `runs` table accounting.
   */
  usage?: AgentUsage;
  /**
   * Per-step token usage from the FINAL model turn, when the provider can
   * report it. For multi-turn agent loops this is the prompt size of the
   * last model call rather than the sum across all tool-call iterations.
   * Use this for context-rotation gating; falls back to `usage` when
   * absent.
   */
  lastStepUsage?: AgentUsage;
}

export interface ProviderSpawnInput {
  prompt: string;
  systemPrompt: string;
  mcpServers: Record<string, CanonicalMcpServer>;
  cwd: string;
  timeoutMs: number;
  traceparent?: string;
  /** Optional model override (e.g. "claude-opus-4-6"). Provider-specific — ignored when not applicable. */
  model?: string;
  /** Optional persona-level OpenAI/Codex reasoning effort. Provider-specific. */
  reasoningEffort?: ReasoningEffort;
}

export interface PreparedProviderInvocation {
  command: string;
  args: string[];
  stdin: string;
  env?: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  cleanupPaths: string[];
  resultFiles?: PreparedProviderResultFiles;
}

export interface PreparedProviderResultFiles {
  lastMessagePath?: string;
}
