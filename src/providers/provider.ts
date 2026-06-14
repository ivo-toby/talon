import type { Result } from 'neverthrow';
import type { BackgroundAgentError } from '../core/errors/error-types.js';
import type {
  AgentUsage,
  CanonicalMcpServer,
  ContextUsage,
  PreparedProviderInvocation,
  PreparedProviderResultFiles,
  ProviderName,
  ProviderResult,
  ProviderSpawnInput,
} from './provider-types.js';

export interface AgentRunInput {
  threadId: string;
  prompt: string;
  systemPrompt: string;
  mcpServers: Record<string, CanonicalMcpServer>;
  cwd: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  sessionId?: string;
}

export interface AgentRunResult {
  output: string;
  sessionId?: string;
  /**
   * Cumulative token usage for the whole run — used for telemetry and
   * `runs` table accounting (what the user was billed for).
   */
  usage: AgentUsage;
  /**
   * Per-step usage from the FINAL model turn, when the provider can report
   * it. For multi-turn agent loops this is the prompt size of the last
   * model call rather than the sum across all tool-call iterations. Use
   * for context-rotation gating; falls back to `usage` when absent.
   */
  lastStepUsage?: AgentUsage;
  isError: boolean;
}

export type AgentStreamEvent =
  | { type: 'text'; content: string }
  | {
      type: 'tool_event';
      messageType: string;
      tool?: string;
      toolUseId?: string;
      input?: unknown;
      output?: unknown;
      isError?: boolean;
      subtype?: string;
      serverName?: string;
      /**
       * Tool-output excerpting telemetry (openai-compatible provider, stage
       * 1 — specs/2026-04-20-tool-output-excerpting-stage1.md). Set when the
       * tool result was truncated before entering the agent's message
       * history so downstream observability can count truncation rate and
       * see the original payload size without having to retain the full
       * blob.
       */
      truncated?: boolean;
      originalChars?: number;
      excerptChars?: number;
    }
  | { type: 'result'; result: AgentRunResult }
  | { type: 'error'; message: string };

export interface SDKExecutionStrategy {
  readonly type: 'sdk';
  readonly supportsSessionResumption: true;
  run(input: AgentRunInput): AsyncIterable<AgentStreamEvent>;
}

export interface StatelessSDKExecutionStrategy {
  readonly type: 'sdk';
  readonly supportsSessionResumption: false;
  run(input: AgentRunInput): AsyncIterable<AgentStreamEvent>;
}

export interface CLIExecutionStrategy {
  readonly type: 'cli';
  readonly supportsSessionResumption: true;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export interface StatelessCLIExecutionStrategy {
  readonly type: 'cli';
  readonly supportsSessionResumption: false;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export type ExecutionStrategy =
  | SDKExecutionStrategy
  | StatelessSDKExecutionStrategy
  | CLIExecutionStrategy
  | StatelessCLIExecutionStrategy;

/**
 * How a provider receives the `skill_load` tool.
 *
 * - `in-process`: the agent-runner constructs the skill-loader server via
 *   `@anthropic-ai/claude-agent-sdk`'s `createSdkMcpServer` and hands it to
 *   the provider as a `transport: 'sdk'` entry. Only providers running on
 *   the Anthropic SDK runtime can host this (currently `claude-code`).
 * - `stdio`: the agent-runner spawns `dist/tools/skill-loader-mcp-server.js`
 *   as a stdio MCP child process; the provider proxies it through its own
 *   MCP layer like any other stdio server. Required for every provider
 *   whose runtime can't host the in-process SDK server — including CLI-
 *   strategy providers (gemini-cli) AND SDK-strategy providers that
 *   delegate MCP to a child wrapper (codex-cli, openai-compatible).
 *
 * Decoupled from `ExecutionStrategy['type']` because the run-loop interface
 * (`'sdk'` returns AsyncIterable, `'cli'` returns Promise) is orthogonal to
 * how the provider hosts MCP servers. Conflating the two left codex-cli
 * and openai-compatible silently without `skill_load`.
 */
export type SkillLoaderTransport = 'in-process' | 'stdio';

export interface AgentProvider {
  readonly name: ProviderName;
  readonly skillLoaderTransport: SkillLoaderTransport;
  createExecutionStrategy(): ExecutionStrategy;
  prepareBackgroundInvocation(input: ProviderSpawnInput): Result<PreparedProviderInvocation, BackgroundAgentError>;
  parseBackgroundResult(raw: {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }, resultFiles?: PreparedProviderResultFiles): ProviderResult;
  estimateContextUsage(usage: AgentUsage): ContextUsage;
}
