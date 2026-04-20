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
  usage: AgentUsage;
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

export interface AgentProvider {
  readonly name: ProviderName;
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
