export type ProviderName = string;

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
