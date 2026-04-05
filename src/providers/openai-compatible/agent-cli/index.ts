import { writeFileSync } from 'node:fs';
import { Agent } from '@mastra/core/agent';
import type { Tool } from '@mastra/core/tools';
import { MCPClient, type MastraMCPServerDefinition } from '@mastra/mcp';
import {
  chooseUsage,
  extractUsage,
  mergeUsage,
  normalizeUsage,
  type UsageSnapshot,
} from './usage.js';

interface WrapperInput {
  prompt: string;
  systemPrompt: string;
  cwd: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  providerId?: string;
  headers?: Record<string, string>;
  mcpServers: Record<string, SerializableMcpServer>;
  /**
   * When true (default) the wrapper streams text/tool events to stdout as
   * they arrive. When false, it consumes the underlying stream silently and
   * emits only the terminal `result` (or `error`) event. The background
   * invocation path sets this to false because its stdout buffer is capped
   * at 100 KB, and losing the trailing `result` line to truncation would
   * flip a successful run to a failure.
   */
  streamEvents?: boolean;
  /**
   * Optional absolute path to a file the wrapper should write the full
   * aggregate response into after the stream completes. When set, the
   * terminal `result` stdout line carries only usage metadata and the real
   * output lives in this file. The background provider uses this to bypass
   * the 100 KB stdout buffer cap entirely.
   */
  outputFilePath?: string;
}

type SerializableMcpServer =
  | {
      transport: 'stdio';
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  | {
      transport: 'http' | 'sse';
      url: string;
      headers?: Record<string, string>;
    };

/**
 * NDJSON event emitted on stdout. One line per event. The `result` event is
 * always emitted last and carries the aggregate text + usage, so the
 * background-agent code path (which buffers stdout) can recover the final
 * output even when streaming is not consumed.
 */
type WrapperEvent =
  | { type: 'text'; content: string }
  | {
      type: 'tool_event';
      messageType: 'tool_use' | 'tool_result';
      tool?: string;
      toolUseId?: string;
      input?: unknown;
      output?: unknown;
      isError?: boolean;
    }
  | {
      type: 'result';
      output: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
      };
    }
  | { type: 'error'; message: string };

function emit(event: WrapperEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function main(): Promise<void> {
  let mcpClient: MCPClient | undefined;
  let aggregatedText = '';

  try {
    const input = parseInput(await readStdin());

    // Note: we intentionally do NOT attach a Mastra Workspace here.
    // Mastra's Agent auto-injects filesystem/sandbox/exec tools when a
    // workspace is set, and those tools are hard-sandboxed to
    // `basePath`/`workingDirectory`. In Talon's architecture, the
    // host-tools MCP bridge (wired up via `mcpServers` below) IS the
    // filesystem/exec/capability layer, and it applies the persona's
    // capability rules consistently across providers (claude-code,
    // codex-cli, gemini-cli). Adding Mastra's workspace tools on top
    // would give the agent a second, redundant, and differently-scoped
    // toolset — which in practice confused models like GLM-5 into
    // reporting "I'm sandboxed to ipc/" (the only populated subdir of
    // the thread workspace) instead of using the full Talon host-tools.
    const mcpServers = toMastraMcpServers(input.mcpServers);
    const mcpTools = Object.keys(mcpServers).length > 0
      ? await (async (): Promise<Record<string, Tool<unknown, unknown, unknown, unknown>>> => {
          mcpClient = new MCPClient({ servers: mcpServers });
          return mcpClient.listTools();
        })()
      : {};

    const agent = new Agent({
      id: 'openai-compatible-cli',
      name: 'OpenAI Compatible CLI',
      instructions: input.systemPrompt,
      model: {
        providerId: input.providerId ?? 'openai-compatible',
        modelId: input.model,
        url: input.baseUrl,
        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
      },
      tools: mcpTools,
    });

    const stream = await agent.stream(input.prompt);
    const shouldStream = input.streamEvents !== false;

    // Capture usage from every chunk that carries it. Mastra wraps the
    // AI SDK `stream_options: { include_usage: true }` call for us, so the
    // underlying server emits token counts in the final OpenAI stream
    // event; Mastra surfaces them on `finish`/`step-finish` chunks (and
    // some providers also sprinkle usage onto other chunks). Reading them
    // inline is more reliable than awaiting `stream.usage` after draining
    // the stream ourselves, because some wrappers settle that promise with
    // zeros once fullStream has been externally consumed.
    let streamedUsage: UsageSnapshot | undefined;

    for await (const rawChunk of stream.fullStream as AsyncIterable<unknown>) {
      const chunk = normalizeStreamChunk(rawChunk);
      if (!chunk) continue;

      const chunkUsage = extractUsage(chunk.payload);
      if (chunkUsage) {
        streamedUsage = mergeUsage(streamedUsage, chunkUsage);
      }

      if (chunk.type === 'text-delta') {
        const text = readStringProp(chunk.payload, 'text');
        if (text && text.length > 0) {
          aggregatedText += text;
          if (shouldStream) {
            emit({ type: 'text', content: text });
          }
        }
        continue;
      }

      if (chunk.type === 'tool-call') {
        if (shouldStream) {
          emit({
            type: 'tool_event',
            messageType: 'tool_use',
            tool: readStringProp(chunk.payload, 'toolName'),
            toolUseId: readStringProp(chunk.payload, 'toolCallId'),
            input: chunk.payload.args,
          });
        }
        continue;
      }

      if (chunk.type === 'tool-result') {
        if (shouldStream) {
          emit({
            type: 'tool_event',
            messageType: 'tool_result',
            tool: readStringProp(chunk.payload, 'toolName'),
            toolUseId: readStringProp(chunk.payload, 'toolCallId'),
            output: chunk.payload.result,
            isError: readBooleanProp(chunk.payload, 'isError'),
          });
        }
        continue;
      }

      if (chunk.type === 'error') {
        const errorValue = chunk.payload.error;
        const message = errorValue instanceof Error
          ? errorValue.message
          : typeof errorValue === 'string'
            ? errorValue
            : JSON.stringify(errorValue);
        emit({ type: 'error', message });
        process.exitCode = 1;
        return;
      }
    }

    const [finalText, promiseUsage] = await Promise.all([stream.text, stream.usage]);
    const resolvedText = finalText && finalText.length > 0 ? finalText : aggregatedText;
    // Prefer chunk-derived usage (authoritative), fall back to the promise.
    const finalUsage = chooseUsage(streamedUsage, promiseUsage);

    // Background path: write the full output to the operator-provided file
    // and emit a tiny terminal summary on stdout so the buffer cap cannot
    // truncate the real response away.
    if (input.outputFilePath) {
      try {
        writeFileSync(input.outputFilePath, resolvedText, { encoding: 'utf8', mode: 0o600 });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        emit({
          type: 'error',
          message: `OpenAI-compatible wrapper failed to write output file: ${message}`,
        });
        process.exitCode = 1;
        return;
      }
      emit({
        type: 'result',
        output: '',
        usage: normalizeUsage(finalUsage),
      });
      return;
    }

    emit({
      type: 'result',
      output: resolvedText,
      usage: normalizeUsage(finalUsage),
    });
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    // Write the full stack to stderr for operator debugging, and emit a
    // structured error event for downstream consumers.
    process.stderr.write(`${message}\n`);
    emit({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    await mcpClient?.disconnect().catch(() => {});
  }
}

interface StreamChunk {
  type: string;
  payload: Record<string, unknown>;
}

function normalizeStreamChunk(value: unknown): StreamChunk | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return undefined;
  }
  const payload = isRecord(value.payload) ? value.payload : {};
  return { type: value.type, payload };
}

function readStringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readBooleanProp(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function parseInput(raw: string): WrapperInput {
  const parsed: unknown = JSON.parse(raw);
  if (!isWrapperInput(parsed)) {
    throw new Error('OpenAI-compatible wrapper requires prompt, systemPrompt, cwd, model, and baseUrl');
  }

  return {
    prompt: parsed.prompt,
    systemPrompt: parsed.systemPrompt,
    cwd: parsed.cwd,
    model: parsed.model,
    baseUrl: parsed.baseUrl,
    ...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
    ...(parsed.providerId ? { providerId: parsed.providerId } : {}),
    ...(parsed.headers ? { headers: parsed.headers } : {}),
    mcpServers: parsed.mcpServers ?? {},
    ...(typeof parsed.streamEvents === 'boolean' ? { streamEvents: parsed.streamEvents } : {}),
    ...(typeof parsed.outputFilePath === 'string' && parsed.outputFilePath.length > 0
      ? { outputFilePath: parsed.outputFilePath }
      : {}),
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

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


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isSerializableMcpServer(value: unknown): value is SerializableMcpServer {
  if (!isRecord(value) || typeof value.transport !== 'string') {
    return false;
  }

  if (value.transport === 'stdio') {
    return (
      typeof value.command === 'string'
      && Array.isArray(value.args)
      && value.args.every((entry) => typeof entry === 'string')
      && (value.env === undefined || isStringRecord(value.env))
    );
  }

  if (value.transport === 'http' || value.transport === 'sse') {
    return typeof value.url === 'string' && (value.headers === undefined || isStringRecord(value.headers));
  }

  return false;
}

function isWrapperInput(value: unknown): value is WrapperInput {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.prompt !== 'string'
    || typeof value.systemPrompt !== 'string'
    || typeof value.cwd !== 'string'
    || typeof value.model !== 'string'
    || typeof value.baseUrl !== 'string'
  ) {
    return false;
  }

  if (value.apiKey !== undefined && typeof value.apiKey !== 'string') {
    return false;
  }

  if (value.providerId !== undefined && typeof value.providerId !== 'string') {
    return false;
  }

  if (value.headers !== undefined && !isStringRecord(value.headers)) {
    return false;
  }

  if (!isRecord(value.mcpServers)) {
    return false;
  }

  if (value.streamEvents !== undefined && typeof value.streamEvents !== 'boolean') {
    return false;
  }

  if (value.outputFilePath !== undefined && typeof value.outputFilePath !== 'string') {
    return false;
  }

  return Object.values(value.mcpServers).every(isSerializableMcpServer);
}

void main();
