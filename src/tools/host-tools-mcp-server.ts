#!/usr/bin/env node

/**
 * Host Tools MCP Server
 *
 * A standalone Node.js script that implements the MCP protocol over stdio.
 * The Agent SDK spawns this as a child process. It connects to the talond
 * Unix domain socket and proxies tool calls from the agent to the daemon.
 *
 * Environment variables:
 *   TALOND_SOCKET       - Path to the Unix socket (required)
 *   TALOND_RUN_ID       - Current run ID (required)
 *   TALOND_THREAD_ID    - Current thread ID (required)
 *   TALOND_PERSONA_ID   - Current persona ID (required)
 *   TALOND_ALLOWED_TOOLS - Comma-separated list of MCP tool names the persona
 *                          may use (e.g. "channel_send,memory_access"). When set,
 *                          only these tools are listed and callable. When unset or
 *                          empty, NO host tools are exposed (secure default).
 */

import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { MCP_TO_INTERNAL } from './tool-filter.js';
import { getHostToolRequestTimeoutMs } from './tool-timeouts.js';
import { TALOND_BRIDGE_SECRET_ENV } from './host-tools-bridge-auth.js';
import {
  IMAGE_LOOKUP_OPERATIONS,
  IMAGE_LOOKUP_DEFAULT_LIMIT,
  IMAGE_LOOKUP_MIN_LIMIT,
  IMAGE_LOOKUP_MAX_LIMIT,
} from './host-tools/image-lookup.js';

/** Tool name mapping from MCP (underscores) to handler (dots). Derived from HOST_TOOL_REGISTRY. */
const TOOL_NAME_MAP = Object.fromEntries(MCP_TO_INTERNAL);

/** NDJSON request to bridge. */
interface BridgeRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  bridgeSecret: string;
  context: {
    runId: string;
    threadId: string;
    personaId: string;
    requestId: string;
    traceparent?: string;
    a2aTaskId?: string;
    a2aHopCount?: number;
    backgroundTaskId?: string;
    primaryExecutionEnvId?: string;
    allowedHostRoots?: string[];
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
      console.error('[host-tools-mcp] Connected to bridge');
    });

    this.socket.on('data', (chunk) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.socket.on('close', () => {
      this.connected = false;
      console.error('[host-tools-mcp] Connection closed');
    });

    this.socket.on('error', (err) => {
      console.error('[host-tools-mcp] Socket error:', err.message);
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
          pending.resolve(response); // Resolve with full response
        }
      } catch {
        console.error('[host-tools-mcp] Failed to parse response:', line);
      }
    }
  }

  async sendRequest(
    tool: string,
    args: Record<string, unknown>,
    bridgeSecret: string,
    context: {
      runId: string;
      threadId: string;
      personaId: string;
      traceparent?: string;
      a2aTaskId?: string;
      a2aHopCount?: number;
      backgroundTaskId?: string;
      primaryExecutionEnvId?: string;
      allowedHostRoots?: string[];
    },
    timeoutMs: number,
  ): Promise<BridgeResponse['result']> {
    if (!this.connected) {
      await this.connectedPromise;
    }

    const id = randomUUID();
    const request: BridgeRequest = {
      id,
      tool,
      args,
      bridgeSecret,
      context: {
        runId: context.runId,
        threadId: context.threadId,
        personaId: context.personaId,
        requestId: randomUUID(),
        ...(context.traceparent ? { traceparent: context.traceparent } : {}),
        ...(context.a2aTaskId ? { a2aTaskId: context.a2aTaskId } : {}),
        ...(context.a2aHopCount !== undefined ? { a2aHopCount: context.a2aHopCount } : {}),
        ...(context.backgroundTaskId ? { backgroundTaskId: context.backgroundTaskId } : {}),
        ...(context.primaryExecutionEnvId ? { primaryExecutionEnvId: context.primaryExecutionEnvId } : {}),
        ...(context.allowedHostRoots ? { allowedHostRoots: context.allowedHostRoots } : {}),
      },
    };

    return new Promise<BridgeResponse['result']>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (response: BridgeResponse) => {
          // Surface bridge-level errors instead of silently dropping them.
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

// ---------------------------------------------------------------------------
// image_lookup — four operation-specific input schemas
//
// `image.lookup` has four operations with different field sets, so the tool
// declares one JSON Schema branch per operation under `oneOf`. Each branch
// pins its own `operation` value, its own required fields, and
// `additionalProperties: false`, which is what keeps the accepted input set
// exactly equal to the handler's own tables.
//
// There is deliberately NO thread, persona, run, path, URL, or provenance
// field anywhere in these schemas. The thread comes from the trusted
// ToolExecutionContext the daemon injects, and an extra field is rejected
// rather than ignored (here at the schema, and again in the handler).
// ---------------------------------------------------------------------------

/** Pagination bounds, shared by the two listing operations. */
const IMAGE_LOOKUP_LIMIT_SCHEMA = {
  type: 'integer' as const,
  minimum: IMAGE_LOOKUP_MIN_LIMIT,
  maximum: IMAGE_LOOKUP_MAX_LIMIT,
  description: `Maximum entries to return. Default: ${IMAGE_LOOKUP_DEFAULT_LIMIT}, allowed ${IMAGE_LOOKUP_MIN_LIMIT}\u2013${IMAGE_LOOKUP_MAX_LIMIT}.`,
};

const IMAGE_LOOKUP_CURSOR_SCHEMA = {
  type: 'string' as const,
  description:
    'Opaque cursor taken from a previous result\'s `nextCursor`. Bound to the operation, filter, and thread that issued it \u2014 do not edit it or reuse it for another operation, filter, or thread. Omit for the first page.',
};

/** Opaque Image/Finding identifiers: plain tokens, never paths or URLs. */
const IMAGE_LOOKUP_IMAGE_ID_SCHEMA = {
  type: 'string' as const,
  description:
    'Image ID from an Image descriptor in the current thread. An opaque token \u2014 never a file path or URL.',
};

const IMAGE_LOOKUP_FINDING_ID_SCHEMA = {
  type: 'string' as const,
  description:
    'Finding ID from a `list_findings` result. An opaque token \u2014 never a file path or URL.',
};

/** `list_images` \u2014 `{ images, nextCursor }` */
export const IMAGE_LOOKUP_LIST_IMAGES_SCHEMA = {
  type: 'object' as const,
  properties: {
    operation: { type: 'string' as const, enum: ['list_images'] as const },
    limit: IMAGE_LOOKUP_LIMIT_SCHEMA,
    cursor: IMAGE_LOOKUP_CURSOR_SCHEMA,
  },
  required: ['operation'] as const,
  additionalProperties: false as const,
};

/** `get_image` \u2014 `{ image }` */
export const IMAGE_LOOKUP_GET_IMAGE_SCHEMA = {
  type: 'object' as const,
  properties: {
    operation: { type: 'string' as const, enum: ['get_image'] as const },
    imageId: IMAGE_LOOKUP_IMAGE_ID_SCHEMA,
  },
  required: ['operation', 'imageId'] as const,
  additionalProperties: false as const,
};

/** `list_findings` \u2014 `{ findings, nextCursor }` */
export const IMAGE_LOOKUP_LIST_FINDINGS_SCHEMA = {
  type: 'object' as const,
  properties: {
    operation: { type: 'string' as const, enum: ['list_findings'] as const },
    imageId: {
      ...IMAGE_LOOKUP_IMAGE_ID_SCHEMA,
      description:
        'Optional filter: only Findings whose Inspection referenced this current-thread Image ID.',
    },
    limit: IMAGE_LOOKUP_LIMIT_SCHEMA,
    cursor: IMAGE_LOOKUP_CURSOR_SCHEMA,
  },
  required: ['operation'] as const,
  additionalProperties: false as const,
};

/** `get_finding` \u2014 `{ finding }` */
export const IMAGE_LOOKUP_GET_FINDING_SCHEMA = {
  type: 'object' as const,
  properties: {
    operation: { type: 'string' as const, enum: ['get_finding'] as const },
    findingId: IMAGE_LOOKUP_FINDING_ID_SCHEMA,
  },
  required: ['operation', 'findingId'] as const,
  additionalProperties: false as const,
};

/** The four operation-specific input schemas, in `IMAGE_LOOKUP_OPERATIONS` order. */
export const IMAGE_LOOKUP_OPERATION_SCHEMAS = [
  IMAGE_LOOKUP_LIST_IMAGES_SCHEMA,
  IMAGE_LOOKUP_GET_IMAGE_SCHEMA,
  IMAGE_LOOKUP_LIST_FINDINGS_SCHEMA,
  IMAGE_LOOKUP_GET_FINDING_SCHEMA,
] as const;

const IMAGE_LOOKUP_TOOL = {
  name: 'image_lookup',
  description:
    'Discovers the Images in the CURRENT thread and reads Findings their Inspections already saved. Text only \u2014 it never returns pixels, file paths, or URLs, never calls a model, and never downloads anything. Four operations: `list_images` (current descriptors, newest first, including Rejected/Unavailable; still-processing Images are omitted), `get_image` (the CURRENT descriptor of one Image \u2014 use this instead of trusting a descriptor quoted in an earlier turn), `list_findings` (saved Findings, optionally filtered by imageId), `get_finding` (one exact saved Finding with its answer and extracted text). Reading a saved Finding through this tool does NOT run a new Inspection. The thread is taken from the trusted run context and cannot be supplied here.',
  inputSchema: {
    type: 'object' as const,
    // Union of every accepted field, so converters that only read top-level
    // `properties` still see the complete allowlist and reject everything else.
    properties: {
      operation: {
        type: 'string' as const,
        enum: [...IMAGE_LOOKUP_OPERATIONS],
        description: 'Operation to perform.',
      },
      imageId: IMAGE_LOOKUP_IMAGE_ID_SCHEMA,
      findingId: IMAGE_LOOKUP_FINDING_ID_SCHEMA,
      limit: IMAGE_LOOKUP_LIMIT_SCHEMA,
      cursor: IMAGE_LOOKUP_CURSOR_SCHEMA,
    },
    required: ['operation'] as const,
    additionalProperties: false as const,
    // Per-operation requirements: exactly one branch matches, because each one
    // pins its own `operation` value and allows only its own fields.
    oneOf: IMAGE_LOOKUP_OPERATION_SCHEMAS,
  },
};

/** MCP tool definitions with JSON schemas. */
const TOOLS = [
  {
    name: 'schedule_manage',
    description: 'Creates, updates, cancels, or lists scheduled tasks on behalf of a persona. Schedules are durable — persisted in SQLite and survive session resets and daemon restarts. Use this instead of CronCreate/CronDelete, which are session-bound and disappear when the conversation ends.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string' as const,
          enum: ['create', 'update', 'cancel', 'delete', 'list'],
          description: 'Action to perform. "cancel" disables a schedule, "delete" removes it permanently. Use "list" to see your schedules.',
        },
        scheduleId: {
          type: 'string' as const,
          description: 'Unique schedule identifier (required for update/cancel/delete)',
        },
        cronExpr: {
          type: 'string' as const,
          description: 'Cron expression defining when the task fires (required for create/update)',
        },
        label: {
          type: 'string' as const,
          description: 'Human-readable label for the scheduled task',
        },
        prompt: {
          type: 'string' as const,
          description: 'Inline prompt to execute when the schedule fires. Mutually exclusive with promptFile.',
        },
        promptFile: {
          type: 'string' as const,
          description: 'Prompt file alias from the persona prompts/ directory. Mutually exclusive with prompt.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'channel_send',
    description:
      'Sends a message to a channel on behalf of a persona. Pass `externalChatId` to target a specific chat on the channel (e.g. a Telegram chat_id). When omitted, the tool routes to the schedule thread\'s origin chat if the run is on a persona-created schedule. If neither is available (CLI-created schedules), the tool errors — use `channel_list` to discover available chats or `channel_broadcast` to fan out.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channelId: {
          type: 'string' as const,
          description: 'Target channel identifier (channel name)',
        },
        content: {
          type: 'string' as const,
          description: 'Message content in Markdown format',
        },
        replyTo: {
          type: 'string' as const,
          description: 'Optional thread or message ID to reply to',
        },
        externalChatId: {
          type: 'string' as const,
          description:
            'Optional explicit recipient chat id on the target channel (e.g. Telegram chat_id, Slack channel id). Required for CLI-created scheduled tasks that have no originExternalId.',
        },
      },
      required: ['channelId', 'content'],
    },
  },
  {
    name: 'channel_list',
    description:
      'Lists the channels bound to the persona and, per channel, the chat external_ids the persona can deliver to. Use this to discover explicit targets for channel_send when the schedule was created from the CLI and has no origin chat.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'channel_broadcast',
    description:
      'Sends a single message to every chat the persona is bound to, across all bound channels. Deliberate fan-out — use only when the schedule has no specific origin chat. Skips channel-default bindings (no thread_id) with a warning included in the result. Returns { delivered, skipped, failed } summary.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: {
          type: 'string' as const,
          description: 'Message content in Markdown format',
        },
        replyTo: {
          type: 'string' as const,
          description: 'Optional thread or message ID to reply to (applied to every delivery)',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'persona_send',
    description: 'Send a task to another persona via the A2A layer',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target_persona: {
          type: 'string' as const,
          description: 'Target persona name from talond.yaml',
        },
        message: {
          type: 'string' as const,
          description: 'Text task to send to the target persona',
        },
        await_reply: {
          type: 'boolean' as const,
          description: 'Wait for the target persona to finish and return its result',
        },
        timeout_ms: {
          type: 'integer' as const,
          description: 'Optional synchronous wait timeout in milliseconds. Default: 300000 (5 minutes).',
        },
      },
      required: ['target_persona', 'message'],
    },
  },
  {
    name: 'persona_task_status',
    description: 'Fetch the status or final result of a delegated task created via persona_send',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: {
          type: 'string' as const,
          description: 'Task ID returned by persona_send',
        },
        wait_ms: {
          type: 'integer' as const,
          description: 'Optional wait time in milliseconds for the task to reach a terminal state. Default: 0.',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'memory_access',
    description:
      'Reads from or writes to the per-thread layered memory store. Use operation "read" to retrieve a key, "write" to store a value, "delete" to remove a key, or "list" to enumerate all items.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        operation: {
          type: 'string' as const,
          enum: ['read', 'write', 'delete', 'list'],
          description: 'Operation to perform: "read", "write", "delete", or "list"',
        },
        key: {
          type: 'string' as const,
          description: 'Memory key to read, write, or delete',
        },
        value: {
          description: 'Value to store (required for write)',
        },
        namespace: {
          type: 'string' as const,
          description: 'Optional namespace/layer to scope the operation',
        },
      },
      required: ['operation'],
    },
  },
  {
    name: 'net_http',
    description: 'Proxies outbound HTTP/HTTPS requests from the sandbox through the host.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        method: {
          type: 'string' as const,
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
          description: 'HTTP method',
        },
        url: {
          type: 'string' as const,
          description: 'Target URL',
        },
        headers: {
          type: 'object' as const,
          description: 'Optional request headers',
        },
        body: {
          type: 'string' as const,
          description: 'Optional request body (for POST/PUT/PATCH)',
        },
        timeoutMs: {
          type: 'number' as const,
          description: 'Request timeout in milliseconds',
        },
      },
      required: ['method', 'url'],
    },
  },
  {
    name: 'db_query',
    description: 'Executes read-only SQL SELECT queries against the talond SQLite database.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sql: {
          type: 'string' as const,
          description: 'SQL SELECT statement',
        },
        params: {
          type: 'array' as const,
          description: 'Positional or named parameters for the prepared statement',
        },
        limit: {
          type: 'number' as const,
          description: 'Maximum number of rows to return (default: 100, max: 1000)',
        },
      },
      required: ['sql'],
    },
  },
  {
    name: 'execution_env',
    description: 'Manage isolated Sprite execution environments. Before risky commands or repeated test runs, create a checkpoint so you can restore the same env to a clean baseline.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string' as const,
          enum: ['create', 'exec', 'upload', 'download', 'checkpoint', 'restore', 'destroy'],
          description: 'Operation to perform on an execution environment. Use checkpoint before risky changes, then restore to roll the same env back to that checkpoint.',
        },
        envId: {
          type: 'string' as const,
          description: 'Execution environment identifier.',
        },
        checkpointId: {
          type: 'string' as const,
          description: 'Checkpoint identifier for restore operations on the same env.',
        },
        label: {
          type: 'string' as const,
          description: 'Optional label for checkpoint creation, such as "baseline-before-tests".',
        },
        command: {
          type: 'string' as const,
          description: 'Command to execute inside the environment.',
        },
        cwd: {
          type: 'string' as const,
          description: 'Optional working directory for command execution.',
        },
        timeoutMs: {
          type: 'number' as const,
          description: 'Optional command timeout in milliseconds.',
        },
        detach: {
          type: 'boolean' as const,
          description: 'Whether to start the process in detached mode.',
        },
        env: {
          type: 'object' as const,
          description: 'Optional environment variables for command execution.',
        },
        sourcePath: {
          type: 'string' as const,
          description: 'Host or remote source path for transfer operations.',
        },
        destinationPath: {
          type: 'string' as const,
          description: 'Host or remote destination path for transfer operations.',
        },
        recursive: {
          type: 'boolean' as const,
          description: 'Whether upload should recurse into directories.',
        },
        overwrite: {
          type: 'boolean' as const,
          description: 'Whether download may overwrite an existing file.',
        },
        baseSnapshot: {
          type: 'string' as const,
          description: 'Optional base snapshot for create.',
        },
        workingDirectory: {
          type: 'string' as const,
          description: 'Optional working directory for create.',
        },
        autoDestroy: {
          type: 'boolean' as const,
          description: 'Whether the created environment should be auto-destroyed.',
        },
        sandboxProfile: {
          type: 'string' as const,
          description: 'Optional sandbox profile for future environment selection.',
        },
        resourceLimits: {
          type: 'object' as const,
          properties: {
            cpus: {
              type: 'number' as const,
            },
            memoryMb: {
              type: 'number' as const,
            },
            diskGb: {
              type: 'number' as const,
            },
          },
          description: 'Optional CPU, memory, and disk overrides for create.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'subagent_invoke',
    description: 'Delegate a task to a specialized sub-agent that runs a cheap, fast model',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string' as const,
          description: 'Sub-agent name (e.g. "memory-groomer", "file-searcher")',
        },
        input: {
          type: 'object' as const,
          description: 'Task-specific input for the sub-agent',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'persona_list',
    description: 'List all personas available for delegation via persona_send',
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  },
  IMAGE_LOOKUP_TOOL,
  {
    name: 'background_agent',
    description: 'Starts and manages background agent workers. You have access to specialized agent profiles — always call action "profiles" first to discover what is available before spawning. When asked about your capabilities, available agents, or what you can delegate, call "profiles" to list them.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string' as const,
          enum: ['spawn', 'status', 'cancel', 'result', 'profiles'],
          description: 'Operation to perform. Call "profiles" to discover available specialist agents before spawning. Always do this when asked about your capabilities or available agents.',
        },
        prompt: {
          type: 'string' as const,
          description: 'Task prompt to execute when action is "spawn".',
        },
        taskId: {
          type: 'string' as const,
          description: 'Background task identifier for status/cancel/result actions.',
        },
        provider: {
          type: 'string' as const,
          description: 'Optional provider override for spawn (e.g. "claude-code", "gemini-cli").',
        },
        profile: {
          type: 'string' as const,
          description: 'Persona name to use as the background agent profile. Call with action "profiles" first to see available options with descriptions. When provided, the named persona\'s system prompt, skills, model, and provider are used instead of the spawning thread\'s persona.',
        },
        workingDirectory: {
          type: 'string' as const,
          description: 'Optional working directory for the spawned worker.',
        },
        timeoutMinutes: {
          type: 'number' as const,
          description: 'Optional timeout override for spawn, in minutes. Default is 30 minutes. Use at least 15 for simple tasks and 30+ for complex tasks (spec writing, multi-file refactors, research). The agent process is killed when the timeout expires.',
        },
      },
      required: ['action'],
    },
  },
];

function getEnvRequired(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** All MCP tool definitions in declaration order (exported for contract tests). */
export const HOST_TOOL_DEFINITIONS = TOOLS;

/**
 * Gates one MCP tool call before it reaches the bridge.
 *
 * Only an exact MCP tool name present in the persona's allowed set may
 * dispatch. Internal dot-notation names (`image.lookup`) are never in the
 * allowed set and never resolve through {@link TOOL_NAME_MAP}, so offering an
 * internal name cannot reach the same handler through a second, unfiltered
 * path. The bridge re-checks the persona capability independently for either
 * spelling.
 */
export function gateMcpToolCall(
  allowedSet: ReadonlySet<string>,
  name: string,
): { ok: true; handlerName: string } | { ok: false; error: string } {
  if (!allowedSet.has(name)) {
    return { ok: false, error: `Tool "${name}" is not allowed for this persona` };
  }

  const handlerName = TOOL_NAME_MAP[name];
  if (!handlerName) {
    return { ok: false, error: `Unknown tool: ${name}` };
  }

  return { ok: true, handlerName };
}

/** Tools the persona may see, in declaration order (exported for contract tests). */
export function listExposedTools(allowedSet: ReadonlySet<string>): typeof TOOLS {
  return TOOLS.filter((t) => allowedSet.has(t.name));
}

/**
 * Parse TALOND_ALLOWED_TOOLS into a Set of MCP tool names.
 *
 * Returns an empty set when the env var is missing or empty (secure default:
 * no tools exposed). The agent-runner is responsible for computing the correct
 * comma-separated list from persona capabilities.
 */
function parseAllowedTools(): Set<string> {
  const raw = process.env.TALOND_ALLOWED_TOOLS;
  if (raw === undefined || raw === '') {
    return new Set(); // Secure default: no tools
  }
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(names);
}

function parseOptionalJsonStringArray(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const socketPath = getEnvRequired('TALOND_SOCKET');
  const runId = getEnvRequired('TALOND_RUN_ID');
  const threadId = getEnvRequired('TALOND_THREAD_ID');
  const personaId = getEnvRequired('TALOND_PERSONA_ID');
  const bridgeSecret = getEnvRequired(TALOND_BRIDGE_SECRET_ENV);
  const traceparent = process.env.TALOND_TRACEPARENT;
  const a2aTaskId = process.env.TALOND_A2A_TASK_ID;
  const rawA2aHopCount = process.env.TALOND_A2A_HOP_COUNT;
  const parsedA2aHopCount =
    rawA2aHopCount !== undefined ? Number.parseInt(rawA2aHopCount, 10) : undefined;
  const a2aHopCount =
    typeof parsedA2aHopCount === 'number' && Number.isFinite(parsedA2aHopCount)
      ? parsedA2aHopCount
      : undefined;
  const backgroundTaskId = process.env.TALOND_BACKGROUND_TASK_ID;
  const primaryExecutionEnvId = process.env.TALOND_PRIMARY_EXECUTION_ENV_ID;
  const allowedHostRoots = parseOptionalJsonStringArray(process.env.TALOND_ALLOWED_HOST_ROOTS);

  // Determine which tools this persona may use. Only tools whose MCP names
  // appear in TALOND_ALLOWED_TOOLS are listed and callable.
  const allowedSet = parseAllowedTools();
  const filteredTools = listExposedTools(allowedSet);

  console.error('[host-tools-mcp] Starting with socket:', socketPath);
  console.error(
    '[host-tools-mcp] Context: runId=%s threadId=%s personaId=%s',
    runId,
    threadId,
    personaId,
  );
  console.error(
    '[host-tools-mcp] Allowed tools: %s',
    filteredTools.length > 0 ? filteredTools.map((t) => t.name).join(', ') : '(none)',
  );

  const client = new SocketClient(socketPath);

  const server = new Server(
    {
      name: '__talond_host_tools',
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
      tools: filteredTools,
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Enforce tool restrictions. Only an exact MCP name in the allowed set may
    // dispatch; unknown names and internal dot-notation names are refused here
    // and re-checked independently by the bridge.
    const gate = gateMcpToolCall(allowedSet, name);
    if (!gate.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: gate.error }),
          },
        ],
        isError: true,
      };
    }

    const handlerName = gate.handlerName;
    const normalizedTool = gate.handlerName;

    try {
      const result = await client.sendRequest(
        handlerName,
        args as Record<string, unknown>,
        bridgeSecret,
        {
          runId,
          threadId,
          personaId,
          traceparent,
          ...(a2aTaskId ? { a2aTaskId } : {}),
          ...(a2aHopCount !== undefined ? { a2aHopCount } : {}),
          ...(backgroundTaskId ? { backgroundTaskId } : {}),
          ...(primaryExecutionEnvId ? { primaryExecutionEnvId } : {}),
          ...(allowedHostRoots ? { allowedHostRoots } : {}),
        },
        getHostToolRequestTimeoutMs(normalizedTool, args as Record<string, unknown>),
      );

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
              text: JSON.stringify({ error: result.error }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result.result),
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

  console.error('[host-tools-mcp] MCP server ready');
}

// Only start the server when executed directly, not when imported for testing.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isEntrypoint) {
  main().catch((err) => {
    console.error('[host-tools-mcp] Fatal error:', err);
    process.exit(1);
  });
}
