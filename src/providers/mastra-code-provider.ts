/**
 * MastraCodeProvider — uses Mastra's Harness as the agent runtime.
 *
 * Instead of spawning a child process wrapper around Mastra's Agent class
 * (like openai-compatible does), this provider instantiates the Harness
 * directly in-process. The Harness handles:
 *
 *   - Multi-turn agentic loops with tool use
 *   - Observational Memory for automatic context compression
 *   - Tool call/result tracking
 *   - Thread-based session persistence
 *
 * This eliminates the need for Talon's context-roller, context-assembler,
 * and session-summarizer sub-agent when using this provider — the Harness
 * does all of that natively.
 *
 * POC: validates whether Mastra Code's Harness can replace the
 * openai-compatible provider's child-process architecture.
 */

import { join } from 'node:path';
import { err, type Result } from 'neverthrow';
import { Agent } from '@mastra/core/agent';
import { Harness } from '@mastra/core/harness';
import { Workspace, LocalFilesystem, LocalSandbox, type WorkspaceToolsConfig } from '@mastra/core/workspace';
import { MCPClient, type MastraMCPServerDefinition } from '@mastra/mcp';
import { LibSQLStore } from '@mastra/libsql';
import type { ProviderConfig } from '../core/config/config-types.js';
import { BackgroundAgentError } from '../core/errors/error-types.js';
import type {
  AgentProvider,
  AgentRunInput,
  AgentStreamEvent,
  StatelessSDKExecutionStrategy,
} from './provider.js';
import type {
  AgentUsage,
  CanonicalMcpServer,
  ContextUsage,
  PreparedProviderInvocation,
  ProviderResult,
  ProviderSpawnInput,
} from './provider-types.js';
import type { HarnessEvent } from '@mastra/core/harness';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MastraCodeProviderRuntime {
  apiKey?: string;
  baseUrl?: string;
  dataDir?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SerializableMcpServer = Exclude<CanonicalMcpServer, { transport: 'sdk' }>;

function toMastraMcpServers(
  mcpServers: Record<string, SerializableMcpServer>,
): Record<string, MastraMCPServerDefinition> {
  const servers: Record<string, MastraMCPServerDefinition> = {};

  for (const [name, server] of Object.entries(mcpServers)) {
    if (server.transport === 'stdio') {
      servers[name] = {
        command: server.command,
        args: server.args,
        ...(server.env ? { env: server.env } : {}),
        cwd: process.cwd(),
      };
      continue;
    }

    const headers = server.headers;
    servers[name] = {
      url: new URL(server.url),
      ...(headers
        ? {
            requestInit: { headers },
            eventSourceInit: {
              fetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
                const requestHeaders = new Headers(init?.headers);
                for (const [key, value] of Object.entries(headers)) {
                  requestHeaders.set(key, value);
                }
                return fetch(input, { ...init, headers: requestHeaders });
              },
            },
          }
        : {}),
    };
  }

  return servers;
}

const WORKSPACE_TOOLS_CONFIG: WorkspaceToolsConfig = {
  mastra_workspace_list_files: { maxOutputTokens: 2000 },
  mastra_workspace_read_file: { maxOutputTokens: 3000 },
  mastra_workspace_grep: { maxOutputTokens: 2000 },
  mastra_workspace_execute_command: { maxOutputTokens: 3000 },
  mastra_workspace_search: { enabled: false },
  mastra_workspace_index: { enabled: false },
  mastra_workspace_lsp_inspect: { enabled: false },
  mastra_workspace_ast_edit: { enabled: false },
  mastra_workspace_delete: { enabled: false },
  mastra_workspace_kill_process: { enabled: false },
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class MastraCodeProvider implements AgentProvider {
  readonly name = 'mastra-code';

  constructor(
    private readonly config: ProviderConfig,
    private readonly runtime: MastraCodeProviderRuntime = {},
  ) {}

  createExecutionStrategy(): StatelessSDKExecutionStrategy {
    return {
      type: 'sdk' as const,
      // The Harness manages sessions internally via Observational Memory.
      // From Talon's perspective, each invocation is stateless — we don't
      // need Talon's SessionTracker or context-roller for this provider.
      supportsSessionResumption: false as const,
      run: (input: AgentRunInput) => this.runWithHarness(input),
    };
  }

  /**
   * Run a prompt through a Mastra Harness instance.
   *
   * Creates a fresh Harness per invocation with the Agent configured for the
   * requested model and MCP servers. The Harness manages its own thread and
   * context compression internally.
   *
   * Yields AgentStreamEvent objects that the agent-runner consumes.
   */
  private async *runWithHarness(input: AgentRunInput): AsyncIterable<AgentStreamEvent> {
    const baseUrl = this.runtime.baseUrl
      ?? (typeof this.config.options?.baseUrl === 'string' ? this.config.options.baseUrl : undefined)
      ?? 'http://127.0.0.1:11434/v1';
    const apiKey = this.runtime.apiKey
      ?? (typeof this.config.options?.apiKey === 'string' ? this.config.options.apiKey : undefined);
    const providerId = typeof this.config.options?.providerId === 'string'
      ? this.config.options.providerId
      : 'openai-compatible';
    const headers = typeof this.config.options?.headers === 'object' && this.config.options.headers !== null
      ? this.config.options.headers as Record<string, string>
      : undefined;

    // Filter out SDK-transport MCP servers (not serializable).
    const serializableServers: Record<string, SerializableMcpServer> = {};
    for (const [name, server] of Object.entries(input.mcpServers)) {
      if ('transport' in server && server.transport !== 'sdk') {
        serializableServers[name] = server as SerializableMcpServer;
      }
    }

    // Set up workspace for file/command access.
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({
        basePath: input.cwd,
        contained: false,
      }),
      sandbox: new LocalSandbox({
        workingDirectory: input.cwd,
        env: process.env,
      }),
      tools: WORKSPACE_TOOLS_CONFIG,
    });

    // Connect MCP tools.
    let mcpClient: MCPClient | undefined;
    let mcpTools: Record<string, unknown> = {};
    const mastraMcpServers = toMastraMcpServers(serializableServers);
    if (Object.keys(mastraMcpServers).length > 0) {
      mcpClient = new MCPClient({ servers: mastraMcpServers });
      mcpTools = await mcpClient.listTools();
    }

    // Create the Mastra Agent.
    const agent = new Agent({
      id: `mastra-code-${input.threadId}`,
      name: 'Mastra Code Agent',
      instructions: input.systemPrompt,
      model: {
        providerId,
        modelId: input.model,
        url: baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(headers ? { headers } : {}),
      },
      workspace,
      tools: mcpTools as Record<string, any>,
    });

    // Create a dedicated LibSQL storage for the Harness's internal state
    // (threads, messages, observational memory). Uses a separate `mastra.db`
    // file to avoid WAL locking contention with Talon's main `talon.db`.
    const dataDir = this.runtime.dataDir ?? '.';
    const storage = new LibSQLStore({
      id: `talon-mastra-storage`,
      url: `file:${join(dataDir, 'mastra.db')}`,
    });

    // Create the Harness with Observational Memory enabled.
    const harness = new Harness({
      id: `talon-mastra-${input.threadId}`,
      storage,
      modes: [{
        id: 'default',
        name: 'Default',
        default: true,
        agent,
      }],
      workspace,
    });

    // Collect events for yielding as AgentStreamEvents.
    const eventQueue: AgentStreamEvent[] = [];
    let agentDone = false;
    let agentError: string | undefined;
    let resolveWait: (() => void) | undefined;

    const pushEvent = (event: AgentStreamEvent): void => {
      eventQueue.push(event);
      resolveWait?.();
    };

    // Usage tracking.
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Track emitted text length to compute deltas from message_update events,
    // which contain the full accumulated message, not incremental deltas.
    let emittedTextLength = 0;

    // Subscribe to Harness events and convert to AgentStreamEvents.
    const unsubscribe = harness.subscribe((event: HarnessEvent) => {
      switch (event.type) {
        case 'message_update': {
          // Extract text content delta from the message update.
          if (event.message.role === 'assistant') {
            // Concatenate all text content to get the full current text.
            let fullText = '';
            for (const content of event.message.content) {
              if (content.type === 'text') {
                fullText += content.text;
              }
            }
            // Only emit the new portion.
            if (fullText.length > emittedTextLength) {
              const delta = fullText.slice(emittedTextLength);
              emittedTextLength = fullText.length;
              pushEvent({ type: 'text', content: delta });
            }
          }
          break;
        }

        case 'tool_start': {
          pushEvent({
            type: 'tool_event',
            messageType: 'tool_use',
            tool: event.toolName,
            toolUseId: event.toolCallId,
            input: event.args,
          });
          break;
        }

        case 'tool_end': {
          pushEvent({
            type: 'tool_event',
            messageType: 'tool_result',
            tool: undefined,
            toolUseId: event.toolCallId,
            output: event.result,
            isError: event.isError,
          });
          break;
        }

        case 'agent_end': {
          agentDone = true;
          if (event.reason === 'error') {
            agentError = 'Agent ended with error';
          }
          resolveWait?.();
          break;
        }

        default:
          // Ignore other event types for now.
          break;
      }
    });

    try {
      await harness.init();
      await harness.selectOrCreateThread();

      // Fire and forget — events come through the subscriber.
      const sendPromise = harness.sendMessage({ content: input.prompt })
        .catch((error: unknown) => {
          agentError = error instanceof Error ? error.message : String(error);
          agentDone = true;
          resolveWait?.();
        });

      // Yield events as they arrive.
      while (!agentDone || eventQueue.length > 0) {
        if (eventQueue.length > 0) {
          yield eventQueue.shift()!;
          continue;
        }

        // Wait for more events.
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
          // Safety timeout to prevent infinite hang.
          setTimeout(resolve, 1000);
        });
      }

      // Wait for sendMessage to fully complete.
      await sendPromise;

      if (agentError) {
        yield { type: 'error', message: agentError };
      } else {
        // Emit result event. The agent-runner expects this to finalize.
        yield {
          type: 'result',
          result: {
            output: '',  // Text was already streamed via message_update events.
            sessionId: undefined,
            usage: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
            },
            isError: false,
          },
        };
      }
    } finally {
      unsubscribe();
      await mcpClient?.disconnect().catch(() => {});
      await harness.destroy().catch(() => {});
    }
  }

  prepareBackgroundInvocation(
    _input: ProviderSpawnInput,
  ): Result<PreparedProviderInvocation, BackgroundAgentError> {
    // Background invocation is not yet supported for the Mastra Code provider.
    // The Harness is an in-process runtime, not a CLI subprocess.
    return err(new BackgroundAgentError(
      'mastra-code provider does not support background invocations yet',
    ));
  }

  parseBackgroundResult(raw: {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }): ProviderResult {
    return {
      output: raw.stdout || '',
      exitCode: raw.exitCode,
      timedOut: raw.timedOut,
      stderr: 'mastra-code provider does not support background invocations',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  estimateContextUsage(usage: AgentUsage): ContextUsage {
    // The Harness handles context management internally via Observational
    // Memory, so Talon's context-roller should be disabled for this provider.
    // Return input_tokens so the roller can still monitor if configured.
    return {
      inputTokens: usage.inputTokens,
      metrics: {
        input_tokens: usage.inputTokens,
      },
    };
  }
}
