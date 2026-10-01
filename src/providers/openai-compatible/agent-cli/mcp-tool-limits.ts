import { z } from 'zod';
import type { MastraMCPServerDefinition } from '@mastra/mcp';
import { createTool, type Tool } from '@mastra/core/tools';
import {
  DEFAULT_FETCH_SLICE_CAP,
  DEFAULT_TOOL_OUTPUT_CAP,
  excerptToolOutput,
  fetchToolOutputSlice,
  type ToolOutputStore,
} from './tool-output-excerpter.js';

export type SerializableMcpServer =
  | {
      transport: 'stdio';
      command: string;
      args: string[];
      env?: Record<string, string>;
      timeoutMs?: number;
      toolOutputCap?: number;
    }
  | {
      transport: 'http' | 'sse';
      url: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
      toolOutputCap?: number;
    };

export function isSerializableMcpServer(value: unknown): value is SerializableMcpServer {
  if (!isRecord(value) || typeof value.transport !== 'string') {
    return false;
  }

  if (value.transport === 'stdio') {
    return (
      typeof value.command === 'string' &&
      Array.isArray(value.args) &&
      value.args.every((entry) => typeof entry === 'string') &&
      (value.env === undefined || isStringRecord(value.env)) &&
      (value.timeoutMs === undefined || isTimeoutMs(value.timeoutMs)) &&
      (value.toolOutputCap === undefined || isToolOutputCap(value.toolOutputCap))
    );
  }

  if (value.transport === 'http' || value.transport === 'sse') {
    return (
      typeof value.url === 'string' &&
      (value.headers === undefined || isStringRecord(value.headers)) &&
      (value.timeoutMs === undefined || isTimeoutMs(value.timeoutMs)) &&
      (value.toolOutputCap === undefined || isToolOutputCap(value.toolOutputCap))
    );
  }

  return false;
}

/** Per-server operation timeout: integer milliseconds, minimum 1000. */
function isTimeoutMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1000;
}

/** Per-server tool-output cap: non-negative integer (0 disables). */
function isToolOutputCap(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function toMastraMcpServers(
  mcpServers: Record<string, SerializableMcpServer>,
): Record<string, MastraMCPServerDefinition> {
  const servers: Record<string, MastraMCPServerDefinition> = {};

  for (const [name, server] of Object.entries(mcpServers)) {
    if (server.transport === 'stdio') {
      servers[name] = {
        command: server.command,
        args: server.args,
        ...(server.env ? { env: server.env } : {}),
        ...(server.timeoutMs !== undefined ? { timeout: server.timeoutMs } : {}),
        cwd: process.cwd(),
      };
      continue;
    }

    const headers = server.headers;
    servers[name] = {
      url: new URL(server.url),
      ...(server.timeoutMs !== undefined ? { timeout: server.timeoutMs } : {}),
      ...(headers
        ? {
            requestInit: { headers },
            eventSourceInit: {
              fetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
                const requestHeaders = new Headers(init?.headers);
                for (const [key, value] of Object.entries(headers)) {
                  requestHeaders.set(key, value);
                }
                return fetch(input, {
                  ...init,
                  headers: requestHeaders,
                });
              },
            },
          }
        : {}),
    };
  }

  return servers;
}

export function resolveMcpToolOutputCap(
  toolName: string,
  servers: Record<string, SerializableMcpServer>,
  providerCap: number | undefined,
): number {
  const owner = findLongestOwningServer(toolName, Object.keys(servers));
  if (owner !== undefined) {
    const ownerCap = servers[owner].toolOutputCap;
    if (ownerCap !== undefined) return ownerCap;
  }
  if (providerCap !== undefined) return providerCap;
  return DEFAULT_TOOL_OUTPUT_CAP;
}

export function applyMcpToolLimits(
  tools: Record<string, Tool<unknown, unknown, unknown, unknown>>,
  servers: Record<string, SerializableMcpServer>,
  providerCap: number | undefined,
  store: ToolOutputStore,
  idFactory: () => string,
  onRecoveryCollision: () => void,
): Record<string, Tool<unknown, unknown, unknown, unknown>> {
  const discovered = Object.keys(tools);
  if (
    discovered.length === 0 ||
    !discovered.some((name) => resolveMcpToolOutputCap(name, servers, providerCap) > 0)
  ) {
    return tools;
  }

  const wrapped: Record<string, Tool<unknown, unknown, unknown, unknown>> = {};
  for (const name of discovered) {
    wrapped[name] = wrapOneToolWithOutputCap(
      name,
      tools[name],
      resolveMcpToolOutputCap(name, servers, providerCap),
      store,
      idFactory,
    );
  }

  if (Object.prototype.hasOwnProperty.call(tools, 'fetch_tool_output')) {
    onRecoveryCollision();
    return wrapped;
  }

  wrapped.fetch_tool_output = buildFetchToolOutputTool(store);
  return wrapped;
}

function findLongestOwningServer(toolName: string, serverNames: string[]): string | undefined {
  let best: string | undefined;
  for (const name of serverNames) {
    const prefix = `${name}_`;
    if (!toolName.startsWith(prefix)) continue;
    if (best === undefined || name.length > best.length) best = name;
  }
  return best;
}

function wrapOneToolWithOutputCap(
  toolName: string,
  tool: Tool<unknown, unknown, unknown, unknown>,
  cap: number,
  store: ToolOutputStore,
  idFactory: () => string,
): Tool<unknown, unknown, unknown, unknown> {
  const originalExecute = tool.execute?.bind(tool);
  if (!originalExecute) return tool;

  // Proxy preserves the Mastra Tool prototype (instanceof checks, metadata)
  // while overriding execute. Returning a plain object works too but losing
  // the marker symbol can break introspection.
  return new Proxy(tool, {
    get(target, prop, receiver): unknown {
      if (prop === 'execute') {
        return async (input: unknown, ctx?: unknown) => {
          const rawResult = await (
            originalExecute as (i: unknown, c?: unknown) => Promise<unknown>
          )(input, ctx);
          const toolCallId = extractToolCallIdFromContext(ctx) ?? idFactory();
          const excerpted = excerptToolOutput(toolCallId, toolName, rawResult, cap);

          // Always record — even when truncation didn't fire — so a
          // follow-up fetch_tool_output call on a normal-sized output still
          // works. Keeps semantics simple for the model.
          store.record(toolCallId, {
            toolName,
            fullOutput: excerpted.fullOutputString,
            originalChars: excerpted.originalChars,
            truncated: excerpted.truncated,
            excerptChars: excerpted.excerptChars,
          });

          return excerpted.excerpt;
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

/**
 * Build the synthetic `fetch_tool_output` tool that lets the agent re-read
 * a range of a previously-stored tool output.
 */
function buildFetchToolOutputTool(
  store: ToolOutputStore,
): Tool<unknown, unknown, unknown, unknown> {
  return createTool({
    id: 'fetch_tool_output',
    description:
      'Retrieve a range of a previously-truncated tool output. Use this when the excerpt ' +
      'in the message history contains a "TRUNCATED BY TALON" marker and you need a ' +
      'specific region of the full content. Each call returns at most ' +
      `${DEFAULT_FETCH_SLICE_CAP} characters; widen ranges carefully to avoid reintroducing the full payload.`,
    inputSchema: z.object({
      toolCallId: z.string().describe('The toolCallId from the truncation marker.'),
      startChar: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('0-indexed start (inclusive). Defaults to 0.'),
      endChar: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(`Exclusive end. Defaults to startChar + ${DEFAULT_FETCH_SLICE_CAP}.`),
    }),
    execute: (input): Promise<string> => {
      const { toolCallId, startChar, endChar } = input;
      return Promise.resolve(fetchToolOutputSlice(store, toolCallId, startChar, endChar));
    },
  }) as unknown as Tool<unknown, unknown, unknown, unknown>;
}

/**
 * Try to read the tool call id from whatever shape Mastra passes as
 * execution context. Mastra's internal shape evolves; best-effort is fine —
 * we fall back to a synthetic id when nothing matches.
 */
function extractToolCallIdFromContext(ctx: unknown): string | undefined {
  if (!isRecord(ctx)) return undefined;
  const direct = readStringProp(ctx, 'toolCallId');
  if (direct) return direct;
  const options = ctx.options;
  if (isRecord(options)) {
    const fromOptions = readStringProp(options, 'toolCallId');
    if (fromOptions) return fromOptions;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function readStringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}
