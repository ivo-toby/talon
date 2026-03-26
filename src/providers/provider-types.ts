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
  usage?: AgentUsage;
}

export interface ProviderSpawnInput {
  prompt: string;
  systemPrompt: string;
  mcpServers: Record<string, CanonicalMcpServer>;
  cwd: string;
  timeoutMs: number;
}

export interface PreparedProviderInvocation {
  command: string;
  args: string[];
  stdin: string;
  env?: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  cleanupPaths: string[];
}
