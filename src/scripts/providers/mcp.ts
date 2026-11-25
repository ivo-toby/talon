import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from 'neverthrow';
import type { Logger } from 'pino';
import { MCPClient } from '@mastra/mcp';
import { createLogger } from '../../core/logging/index.js';
import {
  isMcpToolAllowed,
  toMastraMcpServers,
  type SerializableMcpServer,
} from '../../providers/openai-compatible/agent-cli/mcp-tool-limits.js';
import { ScriptError } from '../types.js';
import type { RunProvider, ToolClass } from '../types.js';

export interface McpToolLike {
  execute(input: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  mcp?: { annotations?: { readOnlyHint?: boolean } };
}

export interface McpClientLike {
  listToolsets(): Promise<Record<string, Record<string, McpToolLike>>>;
  disconnect(): Promise<void>;
}

export interface McpProviderOptions {
  servers: Record<string, SerializableMcpServer>;
  /** Keys are full script names: `<server>.<tool>`. */
  toolClasses: Record<string, 'read' | 'write'>;
  connectTimeoutMs: number;
  createClient?: (servers: unknown) => McpClientLike;
  logger?: Logger;
}

const RESERVED_SERVERS = new Set(['talon', 'model']);
const CLOSE_TIMEOUT_MS = 5_000;

/**
 * The one place that knows how a Mastra MCP tool is executed in the installed
 * @mastra/mcp version: `execute(input, { abortSignal })`.
 */
function executeTool(tool: McpToolLike, input: unknown, signal: AbortSignal): Promise<unknown> {
  return tool.execute(input, { abortSignal: signal });
}

function defaultCreateClient(servers: unknown): McpClientLike {
  type Servers = ConstructorParameters<typeof MCPClient>[0]['servers'];
  // Mastra's default log handler writes tool arguments to stderr; a script's
  // tool input must not be logged, so every server gets a silent handler.
  const silenced: Servers = {};
  for (const [name, definition] of Object.entries(servers as Servers)) {
    silenced[name] = { ...definition, logger: (): void => undefined };
  }
  // A unique id per client: without it Mastra keys a global instance map on the
  // server configuration and refuses a second client with the same one.
  return new MCPClient({ id: randomUUID(), servers: silenced }) as unknown as McpClientLike;
}

/** Resolves with the promise result, or `'timeout'` after `ms`. Never rejects on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Disconnects best effort within 5 seconds. Never rejects. */
async function disconnectBounded(
  client: McpClientLike,
  serverNames: string[],
  logger: Logger,
): Promise<void> {
  try {
    const outcome = await withTimeout(client.disconnect(), CLOSE_TIMEOUT_MS);
    if (outcome === 'timeout') {
      logger.warn(
        { servers: serverNames },
        'mcp provider: disconnect timed out; a stdio server process can still be running',
      );
    }
  } catch (cause) {
    logger.warn(
      { servers: serverNames, err: cause instanceof Error ? cause.name : 'unknown' },
      'mcp provider: disconnect failed',
    );
  }
}

function splitName(name: string): { server: string; tool: string } | undefined {
  const dot = name.indexOf('.');
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return { server: name.slice(0, dot), tool: name.slice(dot + 1) };
}

function classify(
  fullName: string,
  tool: McpToolLike,
  toolClasses: Record<string, 'read' | 'write'>,
): ToolClass {
  const configured = Object.hasOwn(toolClasses, fullName) ? toolClasses[fullName] : undefined;
  if (configured === 'read' || configured === 'write') return configured;
  return tool.mcp?.annotations?.readOnlyHint === true ? 'read' : 'write';
}

function isErrorResult(value: unknown): boolean {
  return (
    value !== null && typeof value === 'object' && (value as { isError?: unknown }).isError === true
  );
}

function emptyProvider(): RunProvider {
  return {
    describe: () => undefined,
    call: () =>
      Promise.resolve(
        err(new ScriptError('UNKNOWN_TOOL', 'the tool does not exist for this persona')),
      ),
    close: () => Promise.resolve(),
  };
}

export async function createMcpProvider(
  options: McpProviderOptions,
): Promise<Result<RunProvider, ScriptError>> {
  const logger = options.logger ?? createLogger({ level: 'info', pretty: false });
  const servers: Record<string, SerializableMcpServer> = {};
  for (const [name, server] of Object.entries(options.servers)) {
    if (RESERVED_SERVERS.has(name)) continue;
    // A script name splits at the first dot, so a dotted server name could shadow another server.
    if (name.includes('.')) {
      logger.warn({ server: name }, 'mcp provider: server with a dot in its name is not offered');
      continue;
    }
    servers[name] = server;
  }
  if (Object.keys(servers).length === 0) return ok(emptyProvider());

  const connectFailed = (cause?: unknown): Result<RunProvider, ScriptError> =>
    err(
      new ScriptError(
        'TOOL_FAILED',
        'the MCP servers could not be reached',
        cause instanceof Error ? cause : undefined,
      ),
    );

  let client: McpClientLike | undefined;
  try {
    client = (options.createClient ?? defaultCreateClient)(toMastraMcpServers(servers));
    const listed = await withTimeout(client.listToolsets(), options.connectTimeoutMs);
    if (listed === 'timeout') {
      await disconnectBounded(client, Object.keys(servers), logger);
      return connectFailed();
    }
    return ok(buildProvider(client, listed, servers, options.toolClasses, logger));
  } catch (cause) {
    if (client) await disconnectBounded(client, Object.keys(servers), logger);
    return connectFailed(cause);
  }
}

function buildProvider(
  client: McpClientLike,
  toolsets: Record<string, Record<string, McpToolLike>>,
  servers: Record<string, SerializableMcpServer>,
  toolClasses: Record<string, 'read' | 'write'>,
  logger: Logger,
): RunProvider {
  const tools = new Map<string, { tool: McpToolLike; toolClass: ToolClass }>();
  for (const [serverName, serverTools] of Object.entries(toolsets)) {
    if (!Object.hasOwn(servers, serverName)) continue;
    const patterns = servers[serverName].allowedTools;
    for (const toolName of Object.keys(serverTools)) {
      if (patterns !== undefined && !isMcpToolAllowed(toolName, patterns)) continue;
      const fullName = `${serverName}.${toolName}`;
      if (tools.has(fullName)) continue;
      const tool = serverTools[toolName];
      tools.set(fullName, { tool, toolClass: classify(fullName, tool, toolClasses) });
    }
  }

  let closed = false;
  let closing: Promise<void> | undefined;

  const lookup = (name: string): { tool: McpToolLike; toolClass: ToolClass } | undefined =>
    splitName(name) ? tools.get(name) : undefined;

  return {
    describe(name): { toolClass: ToolClass } | undefined {
      const entry = lookup(name);
      return entry ? { toolClass: entry.toolClass } : undefined;
    },

    async call(name, input, signal): Promise<Result<unknown, ScriptError>> {
      const entry = lookup(name);
      if (!entry)
        return err(new ScriptError('UNKNOWN_TOOL', 'the tool does not exist for this persona'));
      if (closed) return err(new ScriptError('TOOL_FAILED', 'the MCP provider is closed'));
      if (signal.aborted)
        return err(new ScriptError('TOOL_FAILED', 'the MCP tool call was aborted'));

      let onAbort: (() => void) | undefined;
      const aborted = new Promise<'aborted'>((resolve) => {
        onAbort = (): void => resolve('aborted');
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const running = executeTool(entry.tool, input, signal);
        // A tool that ignores the signal must not keep the call open.
        running.catch(() => undefined);
        const outcome = await Promise.race([running, aborted]);
        if (outcome === 'aborted') {
          return err(new ScriptError('TOOL_FAILED', 'the MCP tool call was aborted'));
        }
        if (isErrorResult(outcome)) {
          return err(new ScriptError('TOOL_FAILED', 'the MCP tool reported an error'));
        }
        return ok(outcome);
      } catch (cause) {
        return err(
          new ScriptError(
            'TOOL_FAILED',
            'the MCP tool call failed',
            cause instanceof Error ? cause : undefined,
          ),
        );
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
    },

    close(): Promise<void> {
      closed = true;
      closing ??= disconnectBounded(client, Object.keys(servers), logger);
      return closing;
    },
  };
}
