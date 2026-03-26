#!/usr/bin/env node

/**
 * Skill Loader MCP Server
 *
 * A standalone Node.js script that implements the MCP protocol over stdio.
 * Spawned as a child process by CLI-based agent providers (Gemini, Codex).
 * SDK providers use the in-process createSdkMcpServer() path instead.
 * Connects to the talond Unix domain socket and proxies skill.load calls
 * from the agent to the daemon.
 *
 * Environment variables:
 *   TALOND_SOCKET       - Path to the Unix socket (required)
 *   TALOND_RUN_ID       - Current run ID (required)
 *   TALOND_THREAD_ID    - Current thread ID (required)
 *   TALOND_PERSONA_ID   - Current persona ID (required)
 *   TALOND_TRACEPARENT  - Traceparent to attach to bridge requests (optional)
 */

import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** NDJSON request to bridge. */
interface BridgeRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  context: {
    runId: string;
    threadId: string;
    personaId: string;
    requestId: string;
    traceparent?: string;
  };
}

/** NDJSON response from bridge. */
interface BridgeResponse {
  id: string;
  result?: {
    requestId: string;
    tool: string;
    status: 'success' | 'error' | 'timeout';
    result?: unknown;
    error?: string;
  };
  error?: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** Socket client that maintains a persistent connection to the bridge. */
class SocketClient {
  private socket: ReturnType<typeof createConnection> | null = null;
  private readonly socketPath: string;
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: BridgeResponse) => void;
      reject: (reason: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private buffer = '';
  private connected = false;
  private connectResolve: ((value: void) => void) | null = null;
  private connectedPromise: Promise<void>;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
    this.connectedPromise = new Promise((resolve) => {
      this.connectResolve = resolve;
    });
    this.connect();
  }

  private connect(): void {
    this.socket = createConnection(this.socketPath, () => {
      this.connected = true;
      if (this.connectResolve) {
        this.connectResolve();
        this.connectResolve = null;
      }
      console.error('[skill-loader-mcp] Connected to bridge');
    });

    this.socket.on('data', (chunk) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.socket.on('close', () => {
      this.connected = false;
      console.error('[skill-loader-mcp] Connection closed');
    });

    this.socket.on('error', (err) => {
      console.error('[skill-loader-mcp] Socket error:', err.message);
      this.connected = false;
    });
  }

  private processBuffer(): void {
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.trim() === '') {
        continue;
      }

      try {
        const response = JSON.parse(line) as BridgeResponse;
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(response.id);
          pending.resolve(response);
        }
      } catch {
        console.error('[skill-loader-mcp] Failed to parse response:', line);
      }
    }
  }

  async sendRequest(
    tool: string,
    args: Record<string, unknown>,
    context: { runId: string; threadId: string; personaId: string; traceparent?: string },
  ): Promise<BridgeResponse['result']> {
    if (!this.connected) {
      await this.connectedPromise;
    }

    const id = randomUUID();
    const request: BridgeRequest = {
      id,
      tool,
      args,
      context: {
        runId: context.runId,
        threadId: context.threadId,
        personaId: context.personaId,
        requestId: randomUUID(),
        ...(context.traceparent ? { traceparent: context.traceparent } : {}),
      },
    };

    return new Promise<BridgeResponse['result']>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: (response: BridgeResponse) => {
          if (response.error && !response.result) {
            reject(new Error(`Bridge error: ${response.error}`));
          } else {
            resolve(response.result);
          }
        },
        reject,
        timeout,
      });

      this.socket?.write(JSON.stringify(request) + '\n');
    });
  }

  close(): void {
    this.socket?.end();
  }
}

const TOOLS = [
  {
    name: 'skill_load',
    description: 'Load the full instructions for a skill by name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string' as const,
          description: 'Skill name',
        },
      },
      required: ['name'],
    },
  },
];

export function lookupSkillContent(
  skillContentMap: Map<string, string>,
  name: string,
): string | null {
  const content = skillContentMap.get(name);
  return content === undefined ? null : content;
}

function getEnvRequired(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const socketPath = getEnvRequired('TALOND_SOCKET');
  const runId = getEnvRequired('TALOND_RUN_ID');
  const threadId = getEnvRequired('TALOND_THREAD_ID');
  const personaId = getEnvRequired('TALOND_PERSONA_ID');
  const traceparent = process.env.TALOND_TRACEPARENT;

  console.error('[skill-loader-mcp] Starting with socket:', socketPath);
  console.error(
    '[skill-loader-mcp] Context: runId=%s threadId=%s personaId=%s',
    runId,
    threadId,
    personaId,
  );

  const client = new SocketClient(socketPath);

  const server = new Server(
    {
      name: '__talond_skill_loader',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => {
    return {
      tools: TOOLS,
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name !== 'skill_load') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: `Unknown tool: ${name}`,
            }),
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await client.sendRequest('skill.load', args as Record<string, unknown>, {
        runId,
        threadId,
        personaId,
        traceparent,
      });

      if (!result) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'No response from bridge' }),
            },
          ],
          isError: true,
        };
      }

      if (result.status === 'error') {
        return {
          content: [
            {
              type: 'text' as const,
              text: result.error ?? 'Unknown error',
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result.result === 'string' ? result.result : JSON.stringify(result.result),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[skill-loader-mcp] MCP server ready');
}

// Only start the server when executed directly, not when imported for testing.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isEntrypoint) {
  main().catch((err) => {
    console.error('[skill-loader-mcp] Fatal error:', err);
    process.exit(1);
  });
}
