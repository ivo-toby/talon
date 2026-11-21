/**
 * End-to-end check that `allowedTools` reaches the model request: starts the
 * real openai-compatible agent CLI as a child process against stub stdio MCP
 * servers and a stub model endpoint, then asserts on the tool names the
 * wrapper sent to the model. Covers the `main()` wiring that the unit tests
 * of `selectAllowedMcpTools` cannot see.
 */
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');
const wrapperPath = resolve(repoRoot, 'src/providers/openai-compatible/agent-cli/index.ts');
const stubMcpServerPath = resolve(repoRoot, 'tests/fixtures/mcp/stub-mcp-server.mjs');

type ApiMode = 'chat-completions' | 'responses';

interface ModelRequest {
  path: string;
  body: { tools?: Array<{ name?: string; function?: { name?: string } }> };
}

function stubMcpServer(tools: string[], allowedTools?: string[]): Record<string, unknown> {
  return {
    transport: 'stdio',
    command: process.execPath,
    args: [stubMcpServerPath],
    env: { STUB_MCP_TOOLS: tools.join(',') },
    ...(allowedTools ? { allowedTools } : {}),
  };
}

/** Answers every model call with plain text, so the run ends after one step. */
function answerModelCall(path: string, stream: boolean, res: ServerResponse): void {
  if (path.endsWith('/responses')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'resp_stub',
        output_text: 'ok',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    return;
  }

  const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: unknown): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-stub',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'stub-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    })}\n\n`;

  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: 0,
        model: 'stub-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(chunk({ role: 'assistant', content: 'ok' }, null));
  res.write(chunk({}, 'stop', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
  res.end('data: [DONE]\n\n');
}

function runWrapper(
  input: Record<string, unknown>,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', wrapperPath], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', rejectPromise);
    child.on('close', (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe('openai-compatible agent CLI — allowedTools in the model request', () => {
  let modelServer: Server;
  let baseUrl: string;
  let requests: ModelRequest[];

  beforeEach(async () => {
    requests = [];
    modelServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      req.on('end', () => {
        const body = (raw ? JSON.parse(raw) : {}) as ModelRequest['body'] & { stream?: boolean };
        requests.push({ path: req.url ?? '', body });
        answerModelCall(req.url ?? '', body.stream === true, res);
      });
    });
    await new Promise<void>((resolvePromise) =>
      modelServer.listen(0, '127.0.0.1', () => resolvePromise()),
    );
    baseUrl = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`;
  });

  afterEach(async () => {
    await new Promise<void>((resolvePromise) => modelServer.close(() => resolvePromise()));
  });

  it.each<ApiMode>(['chat-completions', 'responses'])(
    'offers only allowed tools, judged per owning server (%s)',
    async (apiMode) => {
      const result = await runWrapper({
        prompt: 'hello',
        systemPrompt: 'You are a test agent.',
        cwd: repoRoot,
        model: 'stub-model',
        baseUrl,
        apiKey: 'stub-key',
        apiMode,
        streamEvents: false,
        disableNativeShellAndFilesystemTools: true,
        // Default fallback cap would add fetch_tool_output; keep the
        // request to MCP tools only.
        toolOutputCap: 0,
        mcpServers: {
          // `hub_delete` on `git` is keyed `git_hub_delete`, which looks like
          // a tool of server `git_hub`; it must still be judged by `git`.
          git: stubMcpServer(['status', 'hub_delete'], ['status']),
          git_hub: stubMcpServer(['issues']),
          postgram: stubMcpServer(['search', 'recall', 'delete'], ['search', 'recall']),
        },
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(requests.length).toBeGreaterThan(0);
      const toolNames = (requests[0]!.body.tools ?? [])
        .map((tool) => tool.function?.name ?? tool.name)
        .sort();
      expect(toolNames).toEqual([
        'git_hub_issues',
        'git_status',
        'postgram_recall',
        'postgram_search',
      ]);
      expect(result.stderr).toContain(
        'openai-compatible wrapper: MCP server "git" allowedTools hides 1 of 2 tools.',
      );
      expect(result.stderr).toContain(
        'openai-compatible wrapper: MCP server "postgram" allowedTools hides 1 of 3 tools.',
      );
    },
    60_000,
  );

  it('reports a pattern written with the server prefix', async () => {
    const result = await runWrapper({
      prompt: 'hello',
      systemPrompt: 'You are a test agent.',
      cwd: repoRoot,
      model: 'stub-model',
      baseUrl,
      apiKey: 'stub-key',
      apiMode: 'responses',
      streamEvents: false,
      disableNativeShellAndFilesystemTools: true,
      toolOutputCap: 0,
      mcpServers: {
        postgram: stubMcpServer(['search', 'recall'], ['postgram_search']),
      },
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(requests[0]!.body.tools ?? []).toEqual([]);
    expect(result.stderr).toContain(
      'MCP server "postgram" allowedTools hides 2 of 2 tools. Patterns matching no tool: "postgram_search"',
    );
  }, 60_000);
});
