import { writeFileSync } from 'node:fs';
import type { JSONObject } from '@ai-sdk/provider';
import { Agent } from '@mastra/core/agent';
import { RequestContext, MASTRA_THREAD_ID_KEY } from '@mastra/core/di';
import { createTool, type Tool } from '@mastra/core/tools';
import {
  Workspace,
  LocalFilesystem,
  LocalSandbox,
  createWorkspaceTools,
  type WorkspaceToolsConfig,
} from '@mastra/core/workspace';
import { MCPClient, type MastraMCPServerDefinition } from '@mastra/mcp';
import { z } from 'zod';
import {
  chooseUsage,
  extractCumulativeUsage,
  extractPerStepUsage,
  mergeUsage,
  normalizeUsage,
  type UsageSnapshot,
} from './usage.js';
import {
  excerptToolOutput,
  fetchToolOutputSlice,
  ToolOutputStore,
  DEFAULT_TOOL_OUTPUT_CAP,
  DEFAULT_FETCH_SLICE_CAP,
} from './tool-output-excerpter.js';
import { runOmlxResponsesLoop } from './omlx-responses.js';

interface WrapperInput {
  prompt: string;
  systemPrompt: string;
  threadId?: string;
  cwd: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  providerId?: string;
  providerOptions?: ProviderOptionsPayload;
  headers?: Record<string, string>;
  mcpServers: Record<string, SerializableMcpServer>;
  streamEvents?: boolean;
  outputFilePath?: string;
  /**
   * Use oMLX's Responses-compatible endpoint instead of the default
   * Mastra chat-completions stream. This unlocks `previous_response_id`
   * session chaining for local oMLX KV/prefix cache reuse.
   */
  omlxResponses?: boolean;
  /** Prior oMLX response id to resume with `previous_response_id`. */
  previousResponseId?: string;
  /** Max model/tool-call steps for the run. Defaults to 25. */
  maxSteps?: number;
  /**
   * Max chars of tool output allowed into the agent's message history.
   * A head/tail excerpt is injected and the full output is kept in-memory
   * for the run so the agent can re-fetch ranges via fetch_tool_output.
   * 0 disables the feature. Defaults to DEFAULT_TOOL_OUTPUT_CAP when
   * omitted.
   */
  toolOutputCap?: number;
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

type ProviderOptionsPayload = Record<string, JSONObject>;

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
      /** Set when the result was excerpted before entering history. */
      truncated?: boolean;
      /** Original payload size in characters (stringified). */
      originalChars?: number;
      /** Excerpt size in characters placed into history. */
      excerptChars?: number;
    }
  | {
      type: 'result';
      output: string;
      sessionId?: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
      };
      lastStepUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
      };
    }
  | { type: 'error'; message: string };

function emit(event: WrapperEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

// ---------------------------------------------------------------------------
// Fetch-level stream_options injection
// ---------------------------------------------------------------------------
// Mastra's OpenAICompatibleConfig model path does NOT send
// `stream_options: { include_usage: true }` in the request body (unlike the
// @ai-sdk/openai chat model which does). Without this flag, OpenAI-compatible
// servers (Ollama, vLLM, etc.) omit the usage chunk from the SSE stream
// entirely, so token counts show up as zeros everywhere downstream. Once the
// flag is injected and the server sends the usage chunk, Mastra's own Agent
// pipeline correctly propagates the values onto finish/step-finish chunks
// and stream.usage.
//
// This patch is safe because the wrapper runs as a short-lived child
// process — it does not affect the daemon's fetch.
// ---------------------------------------------------------------------------

function installStreamOptionsInterceptor(baseUrl: string): void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function interceptedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.startsWith(baseUrl) && url.includes('/chat/completions')) {
      return originalFetch(input, injectStreamOptions(init));
    }

    return originalFetch(input, init);
  };
}

function injectStreamOptions(init?: RequestInit): RequestInit | undefined {
  if (!init?.body || typeof init.body !== 'string') return init;
  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (body.stream !== true) return init;
    if (body.stream_options) return init;
    body.stream_options = { include_usage: true };
    return { ...init, body: JSON.stringify(body) };
  } catch {
    return init;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let workspace: Workspace | undefined;
  let mcpClient: MCPClient | undefined;
  let aggregatedText = '';

  try {
    const input = parseInput(await readStdin());
    installStreamOptionsInterceptor(input.baseUrl);

    // Mastra Workspace provides fs + bash feature parity with claude-code,
    // codex-cli, and gemini-cli. Mastra auto-injects read_file, write_file,
    // list_files, execute_command, etc. onto the Agent when a workspace is
    // set. We configure it with:
    //   - contained: false — tools are NOT jailed to basePath; the model can
    //     reach anywhere the daemon process can, matching claude-code behavior.
    //   - isolation: 'none' — commands run directly on the host.
    //   - maxOutputTokens caps on verbose tools to prevent stalls from huge
    //     directory listings or command output.
    //   - Heavy/redundant tools disabled.
    const workspaceToolsConfig: WorkspaceToolsConfig = {
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

    workspace = new Workspace({
      filesystem: new LocalFilesystem({
        basePath: input.cwd,
        contained: false,
      }),
      sandbox: new LocalSandbox({
        workingDirectory: input.cwd,
        env: process.env,
      }),
      tools: workspaceToolsConfig,
    });
    await workspace.init();
    const workspaceTools = createWorkspaceTools(workspace) as Record<
      string,
      Tool<unknown, unknown, unknown, unknown>
    >;

    const mcpServers = toMastraMcpServers(input.mcpServers);
    const rawMcpTools =
      Object.keys(mcpServers).length > 0
        ? await (async (): Promise<Record<string, Tool<unknown, unknown, unknown, unknown>>> => {
            mcpClient = new MCPClient({ servers: mcpServers });
            return mcpClient.listTools();
          })()
        : {};

    // Tool-output excerpting: bound the size of what enters the agent's
    // message history, retain the full output for this run, expose the
    // fetch_tool_output synthetic tool so the agent can re-read ranges.
    // See specs/2026-04-20-tool-output-excerpting-stage1.md.
    const toolOutputCap = input.toolOutputCap ?? DEFAULT_TOOL_OUTPUT_CAP;
    const toolOutputStore = new ToolOutputStore();
    let syntheticToolCallSeq = 0;
    const mcpTools =
      toolOutputCap > 0
        ? wrapToolsWithOutputCap(
            rawMcpTools,
            toolOutputCap,
            toolOutputStore,
            () => `talond-mcp-${Date.now()}-${++syntheticToolCallSeq}`,
          )
        : rawMcpTools;

    const combinedTools: Record<string, Tool<unknown, unknown, unknown, unknown>> = { ...mcpTools };
    if (toolOutputCap > 0) {
      // Guard against an MCP server accidentally exposing a tool named
      // "fetch_tool_output" — our synthetic tool would silently overwrite
      // it otherwise. Log and skip registration in that case; the agent
      // loses the re-fetch affordance but keeps the MCP tool working.
      if (Object.prototype.hasOwnProperty.call(combinedTools, 'fetch_tool_output')) {
        process.stderr.write(
          'openai-compatible wrapper: an MCP tool named "fetch_tool_output" is already ' +
            'registered; skipping synthetic tool registration to avoid shadowing.\n',
        );
      } else {
        combinedTools.fetch_tool_output = buildFetchToolOutputTool(toolOutputStore);
      }
    }

    if (input.omlxResponses === true) {
      const shouldStream = input.streamEvents !== false;
      const providerId = input.providerId ?? 'openai-compatible';
      const requestContext = new RequestContext();
      if (input.threadId) {
        requestContext.set(MASTRA_THREAD_ID_KEY, input.threadId);
      }
      const result = await runOmlxResponsesLoop({
        prompt: input.prompt,
        systemPrompt: input.systemPrompt,
        model: input.model,
        baseUrl: input.baseUrl,
        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
        ...(input.previousResponseId ? { previousResponseId: input.previousResponseId } : {}),
        ...(input.providerOptions?.[providerId]
          ? { providerOptions: input.providerOptions[providerId] as Record<string, unknown> }
          : {}),
        tools: { ...combinedTools, ...workspaceTools },
        executionContext: {
          workspace,
          requestContext,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
        maxSteps: input.maxSteps ?? 25,
        streamEvents: shouldStream,
        emit,
        getToolOutputMetadata: (toolCallId) => toolOutputStore.get(toolCallId),
      });

      if (input.outputFilePath) {
        try {
          writeFileSync(input.outputFilePath, result.output, { encoding: 'utf8', mode: 0o600 });
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
          ...(result.responseId ? { sessionId: result.responseId } : {}),
          usage: result.usage,
          ...(result.lastStepUsage ? { lastStepUsage: result.lastStepUsage } : {}),
        });
        return;
      }

      emit({
        type: 'result',
        output: result.output,
        ...(result.responseId ? { sessionId: result.responseId } : {}),
        usage: result.usage,
        ...(result.lastStepUsage ? { lastStepUsage: result.lastStepUsage } : {}),
      });
      return;
    }

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
      tools: combinedTools,
    });

    // Mastra's default stopWhen is stepCountIs(5), which stalls the stream
    // after ~5 tool calls. Match the agent-runner's maxTurns (default 25)
    // so the agent can do meaningful multi-tool work.
    const stream = await agent.stream(input.prompt, {
      maxSteps: 25,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });
    const shouldStream = input.streamEvents !== false;
    // Track per-step and cumulative usage in SEPARATE accumulators so we
    // can surface each to the right consumer downstream:
    //   - `cumulativeUsage` → reported as the result's `usage` field for
    //     telemetry/accounting (Langfuse, `runs.input_tokens`, etc).
    //   - `perStepUsage` → reported as `lastStepUsage` for rotation gating
    //     in agent-runner. Per-step is what answers "is the next prompt
    //     going to exceed the model context window?".
    // Mixing them within one snapshot leads either to inflated rotation
    // ratios (using cumulative) or under-reported billing (using per-step).
    let cumulativeUsage: UsageSnapshot | undefined;
    let perStepUsage: UsageSnapshot | undefined;
    // Third accumulator: running SUM of per-step values across the agent
    // loop. Used as a cumulative fallback when the provider/version never
    // emits a native cumulative shape (no `totalUsage`, no `output.usage`).
    // For those providers, summed per-step equals what `totalUsage` would
    // have reported, so it correctly preserves billing accuracy without
    // leaking back into the per-step accumulator used for rotation gating.
    const summedPerStep: UsageSnapshot = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    };
    let sawAnyPerStep = false;

    for await (const rawChunk of stream.fullStream as AsyncIterable<unknown>) {
      const chunk = normalizeStreamChunk(rawChunk);
      if (!chunk) continue;

      const perStep = extractPerStepUsage(chunk.payload);
      if (perStep) {
        perStepUsage = mergeUsage(perStepUsage, perStep);
        sawAnyPerStep = true;
        summedPerStep.inputTokens = (summedPerStep.inputTokens ?? 0) + (perStep.inputTokens ?? 0);
        summedPerStep.outputTokens =
          (summedPerStep.outputTokens ?? 0) + (perStep.outputTokens ?? 0);
        summedPerStep.cachedInputTokens =
          (summedPerStep.cachedInputTokens ?? 0) + (perStep.cachedInputTokens ?? 0);
      }
      const cumulative = extractCumulativeUsage(chunk.payload);
      if (cumulative) {
        cumulativeUsage = mergeUsage(cumulativeUsage, cumulative);
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
          const toolUseId = readStringProp(chunk.payload, 'toolCallId');
          // Enrich the emitted event with excerpting telemetry when the
          // store has an entry for this toolCallId. Single source of truth
          // for tool_result events — the wrap helper records to the store
          // but does NOT emit an event, so downstream consumers don't see
          // duplicates.
          const stored = toolUseId ? toolOutputStore.get(toolUseId) : undefined;
          emit({
            type: 'tool_event',
            messageType: 'tool_result',
            tool: readStringProp(chunk.payload, 'toolName'),
            toolUseId,
            output: chunk.payload.result,
            isError: readBooleanProp(chunk.payload, 'isError'),
            ...(stored?.truncated
              ? {
                  truncated: true,
                  originalChars: stored.originalChars,
                  excerptChars: stored.excerptChars,
                }
              : {}),
          });
        }
        continue;
      }

      if (chunk.type === 'error') {
        const errorValue = chunk.payload.error;
        const message =
          errorValue instanceof Error
            ? errorValue.message
            : typeof errorValue === 'string'
              ? errorValue
              : JSON.stringify(errorValue);
        emit({ type: 'error', message });
        process.exitCode = 1;
        return;
      }
    }

    await stream.consumeStream().catch(() => {});
    const [finalText, promiseUsage] = await Promise.all([stream.text, stream.usage]);
    const resolvedText = finalText && finalText.length > 0 ? finalText : aggregatedText;
    // `usage` is the cumulative total — what the user was billed for and
    // what telemetry/accounting expects. Resolution order:
    //   1. Native cumulative chunks (`totalUsage`, `output.usage`) — most
    //      authoritative when the provider emits them.
    //   2. `stream.usage` promise — Mastra's official end-of-stream total.
    //   3. SUM of per-step chunks across the loop — for providers/versions
    //      that only emit per-step shapes, the per-step sum equals what
    //      `totalUsage` would have reported, so it preserves billing
    //      accuracy. Without this fallback the wrapper would emit
    //      `{ inputTokens: 0 }` while `lastStepUsage` was populated, and
    //      Langfuse + `runs.input_tokens` would silently under-report.
    const cumulativeFallback = sawAnyPerStep ? summedPerStep : undefined;
    // Chain chooseUsage so that a non-zero source always wins over a zero
    // one. Without the chain, `chooseUsage(cumulativeUsage, promiseUsage)`
    // could return `{0, 0}` when the promise settles with zeros after
    // `fullStream` is externally drained, and a plain `??` wouldn't fall
    // through to `summedPerStep`.
    const finalCumulativeUsage = chooseUsage(
      chooseUsage(cumulativeUsage, promiseUsage),
      cumulativeFallback,
    );
    // `lastStepUsage` is the per-step total from the FINAL model turn —
    // what context-rotation gating uses to estimate the next prompt size.
    // No fallback to the promise (which is cumulative); if we never saw a
    // per-step shape, we omit the field and let agent-runner fall back to
    // the cumulative usage (degraded signal, but better than nothing).
    const normalizedCumulative = normalizeUsage(finalCumulativeUsage);
    const normalizedPerStep = perStepUsage ? normalizeUsage(perStepUsage) : undefined;

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
        usage: normalizedCumulative,
        ...(normalizedPerStep ? { lastStepUsage: normalizedPerStep } : {}),
      });
      return;
    }

    emit({
      type: 'result',
      output: resolvedText,
      usage: normalizedCumulative,
      ...(normalizedPerStep ? { lastStepUsage: normalizedPerStep } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    emit({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    await mcpClient?.disconnect().catch(() => {});
    await workspace?.destroy().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    throw new Error(
      'OpenAI-compatible wrapper requires prompt, systemPrompt, cwd, model, and baseUrl',
    );
  }

  return {
    prompt: parsed.prompt,
    systemPrompt: parsed.systemPrompt,
    ...(parsed.threadId ? { threadId: parsed.threadId } : {}),
    cwd: parsed.cwd,
    model: parsed.model,
    baseUrl: parsed.baseUrl,
    ...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
    ...(parsed.providerId ? { providerId: parsed.providerId } : {}),
    ...(parsed.providerOptions ? { providerOptions: parsed.providerOptions } : {}),
    ...(parsed.headers ? { headers: parsed.headers } : {}),
    mcpServers: parsed.mcpServers ?? {},
    ...(typeof parsed.streamEvents === 'boolean' ? { streamEvents: parsed.streamEvents } : {}),
    ...(typeof parsed.outputFilePath === 'string' && parsed.outputFilePath.length > 0
      ? { outputFilePath: parsed.outputFilePath }
      : {}),
    ...(typeof parsed.omlxResponses === 'boolean' ? { omlxResponses: parsed.omlxResponses } : {}),
    ...(typeof parsed.previousResponseId === 'string' && parsed.previousResponseId.length > 0
      ? { previousResponseId: parsed.previousResponseId }
      : {}),
    ...(typeof parsed.maxSteps === 'number' ? { maxSteps: parsed.maxSteps } : {}),
    ...(typeof parsed.toolOutputCap === 'number' ? { toolOutputCap: parsed.toolOutputCap } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool-output excerpting glue
// ---------------------------------------------------------------------------

/**
 * Wrap each tool so its `execute` records the full output in the store and
 * returns a bounded excerpt instead. The downstream stream-chunk handler
 * (see the `tool-result` branch) is the single source of tool_event
 * emission — this helper does NOT emit its own event to avoid duplicates.
 *
 * The toolCallId comes from the Mastra execution context when available;
 * otherwise a synthetic id is generated via `idFactory`. Synthetic ids are
 * still usable with fetch_tool_output within the same run.
 */
function wrapToolsWithOutputCap(
  tools: Record<string, Tool<unknown, unknown, unknown, unknown>>,
  cap: number,
  store: ToolOutputStore,
  idFactory: () => string,
): Record<string, Tool<unknown, unknown, unknown, unknown>> {
  const wrapped: Record<string, Tool<unknown, unknown, unknown, unknown>> = {};
  for (const [name, tool] of Object.entries(tools)) {
    wrapped[name] = wrapOneToolWithOutputCap(name, tool, cap, store, idFactory);
  }
  return wrapped;
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
      typeof value.command === 'string' &&
      Array.isArray(value.args) &&
      value.args.every((entry) => typeof entry === 'string') &&
      (value.env === undefined || isStringRecord(value.env))
    );
  }

  if (value.transport === 'http' || value.transport === 'sse') {
    return (
      typeof value.url === 'string' &&
      (value.headers === undefined || isStringRecord(value.headers))
    );
  }

  return false;
}

function isWrapperInput(value: unknown): value is WrapperInput {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.prompt !== 'string' ||
    typeof value.systemPrompt !== 'string' ||
    (value.threadId !== undefined && typeof value.threadId !== 'string') ||
    typeof value.cwd !== 'string' ||
    typeof value.model !== 'string' ||
    typeof value.baseUrl !== 'string'
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

  if (value.providerOptions !== undefined && !isProviderOptions(value.providerOptions)) {
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

  if (value.omlxResponses !== undefined && typeof value.omlxResponses !== 'boolean') {
    return false;
  }

  if (value.previousResponseId !== undefined && typeof value.previousResponseId !== 'string') {
    return false;
  }

  if (
    value.maxSteps !== undefined &&
    (typeof value.maxSteps !== 'number' || !Number.isInteger(value.maxSteps) || value.maxSteps <= 0)
  ) {
    return false;
  }

  return Object.values(value.mcpServers).every(isSerializableMcpServer);
}

function isProviderOptions(value: unknown): value is ProviderOptionsPayload {
  return isRecord(value) && Object.values(value).every(isRecord);
}

void main();
