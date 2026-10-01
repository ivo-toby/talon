import { writeFileSync } from 'node:fs';
import type { JSONObject } from '@ai-sdk/provider';
import { Agent } from '@mastra/core/agent';
import { RequestContext, MASTRA_THREAD_ID_KEY } from '@mastra/core/di';
import { type Tool } from '@mastra/core/tools';
import {
  Workspace,
  LocalFilesystem,
  LocalSandbox,
  createWorkspaceTools,
  type WorkspaceToolsConfig,
} from '@mastra/core/workspace';
import { MCPClient } from '@mastra/mcp';
import {
  chooseUsage,
  extractCumulativeUsage,
  extractPerStepUsage,
  mergeUsage,
  normalizeUsage,
  type UsageSnapshot,
} from './usage.js';
import { ToolOutputStore } from './tool-output-excerpter.js';
import {
  applyMcpToolLimits,
  isSerializableMcpServer,
  toMastraMcpServers,
  type SerializableMcpServer,
} from './mcp-tool-limits.js';
import { runResponsesLoop } from './responses-api.js';

const DEFAULT_MAX_STEPS = 1000;
type OpenAiCompatibleApiMode = 'chat-completions' | 'responses';
type OpenAiCompatibleSessionMode = 'none' | 'previous_response_id';
// Keep in sync with ReasoningEffortSchema in src/core/config/config-schema.ts — this
// file is a standalone subprocess entrypoint and cannot import from src/core.
type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

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
  reasoningEffort?: ReasoningEffort;
  headers?: Record<string, string>;
  mcpServers: Record<string, SerializableMcpServer>;
  disableNativeShellAndFilesystemTools?: boolean;
  streamEvents?: boolean;
  outputFilePath?: string;
  /**
   * Use the OpenAI-compatible Responses endpoint instead of the default
   * Mastra chat-completions stream.
   */
  apiMode?: OpenAiCompatibleApiMode;
  /**
   * Cross-run session resumption mode. `previous_response_id` stores and
   * resumes the prior response id when the endpoint supports stateful
   * Responses chains.
   */
  sessionMode?: OpenAiCompatibleSessionMode;
  /** @deprecated Use apiMode: responses + sessionMode: previous_response_id. */
  omlxResponses?: boolean;
  /** Prior response id to resume with `previous_response_id`. */
  previousResponseId?: string;
  /** High safety net for model/tool-call steps. Defaults to DEFAULT_MAX_STEPS. */
  maxSteps?: number;
  /**
   * Provider fallback cap: max chars of tool output allowed into the agent's
   * message history. A head/tail excerpt is injected and the full output is
   * kept in-memory for the run so the agent can re-fetch ranges via
   * fetch_tool_output. Per-server mcpServers[*].toolOutputCap values override
   * this fallback; 0 disables only this fallback (positive per-server caps
   * still apply). Defaults to DEFAULT_TOOL_OUTPUT_CAP when omitted.
   */
  toolOutputCap?: number;
}

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

    // OAuth-backed MCP runs must not expose these unrestricted local tools.
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

    let workspaceTools: Record<string, Tool<unknown, unknown, unknown, unknown>> = {};
    if (!input.disableNativeShellAndFilesystemTools) {
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
      workspaceTools = createWorkspaceTools(workspace) as Record<
        string,
        Tool<unknown, unknown, unknown, unknown>
      >;
    }

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
    const toolOutputStore = new ToolOutputStore();
    let syntheticToolCallSeq = 0;
    const mcpTools = applyMcpToolLimits(
      rawMcpTools,
      input.mcpServers,
      input.toolOutputCap,
      toolOutputStore,
      () => `talond-mcp-${Date.now()}-${++syntheticToolCallSeq}`,
      () => {
        // Guard against an MCP server accidentally exposing a tool named
        // "fetch_tool_output" — our synthetic tool would silently overwrite
        // it otherwise. Log and skip registration in that case; the agent
        // loses the re-fetch affordance but keeps the MCP tool working.
        process.stderr.write(
          'openai-compatible wrapper: an MCP tool named "fetch_tool_output" is already ' +
            'registered; skipping synthetic tool registration to avoid shadowing.\n',
        );
      },
    );

    const combinedTools: Record<string, Tool<unknown, unknown, unknown, unknown>> = { ...mcpTools };

    const apiMode = resolveApiMode(input);
    const sessionMode = resolveSessionMode(input);
    if (apiMode === 'responses') {
      const shouldStream = input.streamEvents !== false;
      const providerId = input.providerId ?? 'openai-compatible';
      const requestContext = new RequestContext();
      if (input.threadId) {
        requestContext.set(MASTRA_THREAD_ID_KEY, input.threadId);
      }
      const result = await runResponsesLoop({
        prompt: input.prompt,
        systemPrompt: input.systemPrompt,
        model: input.model,
        baseUrl: input.baseUrl,
        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
        ...(sessionMode === 'previous_response_id' && input.previousResponseId
          ? { previousResponseId: input.previousResponseId }
          : {}),
        ...(input.providerOptions?.[providerId]
          ? { providerOptions: input.providerOptions[providerId] as Record<string, unknown> }
          : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        tools: { ...combinedTools, ...workspaceTools },
        executionContext: {
          ...(workspace ? { workspace } : {}),
          requestContext,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
        maxSteps: input.maxSteps ?? DEFAULT_MAX_STEPS,
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
      ...(workspace ? { workspace } : {}),
      tools: combinedTools,
    });

    // Mastra's default stopWhen is stepCountIs(5), which stalls the stream
    // after ~5 tool calls. Use a high safety net and let the model stop
    // naturally once it emits a no-tool-calls turn.
    const stream = await agent.stream(input.prompt, {
      maxSteps: input.maxSteps ?? DEFAULT_MAX_STEPS,
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

function isApiMode(value: unknown): value is OpenAiCompatibleApiMode {
  return value === 'chat-completions' || value === 'responses';
}

function isSessionMode(value: unknown): value is OpenAiCompatibleSessionMode {
  return value === 'none' || value === 'previous_response_id';
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'ultra'
  );
}

function resolveApiMode(input: WrapperInput): OpenAiCompatibleApiMode {
  return input.apiMode ?? (input.omlxResponses === true ? 'responses' : 'chat-completions');
}

function resolveSessionMode(input: WrapperInput): OpenAiCompatibleSessionMode {
  return input.sessionMode ?? (input.omlxResponses === true ? 'previous_response_id' : 'none');
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
    ...(isReasoningEffort(parsed.reasoningEffort)
      ? { reasoningEffort: parsed.reasoningEffort }
      : {}),
    ...(parsed.headers ? { headers: parsed.headers } : {}),
    mcpServers: parsed.mcpServers ?? {},
    ...(parsed.disableNativeShellAndFilesystemTools === true
      ? { disableNativeShellAndFilesystemTools: true }
      : {}),
    ...(typeof parsed.streamEvents === 'boolean' ? { streamEvents: parsed.streamEvents } : {}),
    ...(typeof parsed.outputFilePath === 'string' && parsed.outputFilePath.length > 0
      ? { outputFilePath: parsed.outputFilePath }
      : {}),
    ...(isApiMode(parsed.apiMode) ? { apiMode: parsed.apiMode } : {}),
    ...(isSessionMode(parsed.sessionMode) ? { sessionMode: parsed.sessionMode } : {}),
    ...(typeof parsed.omlxResponses === 'boolean' ? { omlxResponses: parsed.omlxResponses } : {}),
    ...(typeof parsed.previousResponseId === 'string' && parsed.previousResponseId.length > 0
      ? { previousResponseId: parsed.previousResponseId }
      : {}),
    ...(typeof parsed.maxSteps === 'number' ? { maxSteps: parsed.maxSteps } : {}),
    ...(typeof parsed.toolOutputCap === 'number' ? { toolOutputCap: parsed.toolOutputCap } : {}),
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
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

  if (
    value.disableNativeShellAndFilesystemTools !== undefined
    && typeof value.disableNativeShellAndFilesystemTools !== 'boolean'
  ) {
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

  if (value.reasoningEffort !== undefined && !isReasoningEffort(value.reasoningEffort)) {
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

  if (value.apiMode !== undefined && !isApiMode(value.apiMode)) {
    return false;
  }

  if (value.sessionMode !== undefined && !isSessionMode(value.sessionMode)) {
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
