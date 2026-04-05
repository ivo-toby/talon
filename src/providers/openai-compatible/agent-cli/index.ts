import { Agent } from '@mastra/core/agent';
import type { Tool } from '@mastra/core/tools';
import { Workspace, LocalFilesystem, LocalSandbox } from '@mastra/core/workspace';
import { MCPClient, type MastraMCPServerDefinition } from '@mastra/mcp';

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

async function main(): Promise<void> {
  let workspace: Workspace | undefined;
  let mcpClient: MCPClient | undefined;

  try {
    const input = parseInput(await readStdin());
    workspace = new Workspace({
      filesystem: new LocalFilesystem({
        basePath: input.cwd,
      }),
      sandbox: new LocalSandbox({
        workingDirectory: input.cwd,
        env: process.env,
      }),
    });
    await workspace.init();

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
      workspace,
      tools: mcpTools,
    });

    const result = await agent.generate(input.prompt);
    process.stdout.write(
      `${JSON.stringify({
        output: result.text,
        usage: normalizeUsage(result.totalUsage ?? result.usage),
      })}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    await mcpClient?.disconnect().catch(() => {});
    await workspace?.destroy().catch(() => {});
  }
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

function normalizeUsage(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
      }
    | undefined,
): Record<string, number> {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    ...(typeof usage?.cachedInputTokens === 'number'
      ? { cacheReadTokens: usage.cachedInputTokens }
      : {}),
  };
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

  return Object.values(value.mcpServers).every(isSerializableMcpServer);
}

void main();
