import type { RequestContext } from '@mastra/core/di';
import type { Tool, ToolExecutionContext } from '@mastra/core/tools';
import type { Workspace } from '@mastra/core/workspace';
import type { ReasoningEffort } from '../../../core/config/config-types.js';
import type { AgentUsage } from '../../provider-types.js';

type ToolLike = Tool<unknown, unknown, unknown, unknown>;
type ToolWriter = NonNullable<ToolExecutionContext['writer']>;

export interface ResponsesToolExecutionContextInput {
  workspace?: Workspace;
  requestContext?: RequestContext;
  abortSignal?: AbortSignal;
  writer?: ToolWriter;
  mcp?: ToolExecutionContext['mcp'];
  threadId?: string;
  resourceId?: string;
}

export type ResponsesWrapperEvent =
  | { type: 'text'; content: string }
  | {
      type: 'tool_event';
      messageType: 'tool_use' | 'tool_result';
      tool?: string;
      toolUseId?: string;
      input?: unknown;
      output?: unknown;
      isError?: boolean;
      truncated?: boolean;
      originalChars?: number;
      excerptChars?: number;
    };

export interface ToolOutputMetadata {
  truncated: boolean;
  originalChars: number;
  excerptChars: number;
}

export interface ResponsesLoopInput {
  prompt: string;
  systemPrompt: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  previousResponseId?: string;
  providerOptions?: Record<string, unknown>;
  reasoningEffort?: ReasoningEffort;
  tools: Record<string, ToolLike>;
  executionContext?: ResponsesToolExecutionContextInput;
  maxSteps: number;
  streamEvents: boolean;
  fetchImpl?: typeof fetch;
  emit: (event: ResponsesWrapperEvent) => void;
  getToolOutputMetadata?: (toolCallId: string) => ToolOutputMetadata | undefined;
}

export interface ResponsesLoopResult {
  output: string;
  responseId?: string;
  usage: AgentUsage;
  lastStepUsage?: AgentUsage;
}

interface FunctionCall {
  callId: string;
  name: string;
  input?: unknown;
  inputError?: string;
}

interface FunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export async function runResponsesLoop(input: ResponsesLoopInput): Promise<ResponsesLoopResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = `${input.baseUrl.replace(/\/+$/u, '')}/responses`;
  const toolDefinitions = buildResponsesTools(input.tools);
  const usage: AgentUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let lastStepUsage: AgentUsage | undefined;
  let previousResponseId = input.previousResponseId;
  let nextInput: string | FunctionCallOutput[] = input.prompt;
  let aggregatedText = '';
  let responseId: string | undefined;

  for (let step = 0; step < input.maxSteps; step++) {
    const body: Record<string, unknown> = {
      ...mergeReasoningEffort(input.providerOptions, input.reasoningEffort),
      model: input.model,
      input: nextInput,
      stream: false,
      store: true,
      ...(toolDefinitions.length > 0 ? { tools: toolDefinitions } : {}),
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      ...(!previousResponseId && step === 0 ? { instructions: input.systemPrompt } : {}),
    };

    const response = await postResponsesRequest(endpoint, body, input, fetchImpl);
    responseId = readStringProp(response, 'id') ?? responseId;
    if (responseId) {
      previousResponseId = responseId;
    }

    lastStepUsage = normalizeResponsesUsage(response.usage);
    addUsage(usage, lastStepUsage);

    const text = extractResponseText(response);
    if (text.length > 0) {
      aggregatedText += text;
      if (input.streamEvents) {
        input.emit({ type: 'text', content: text });
      }
    }

    const calls = extractFunctionCalls(response);
    if (calls.length === 0) {
      return {
        output: aggregatedText,
        responseId,
        usage: omitZeroCacheRead(usage),
        ...(lastStepUsage ? { lastStepUsage: omitZeroCacheRead(lastStepUsage) } : {}),
      };
    }

    nextInput = await executeFunctionCalls(calls, input);
  }

  throw new Error(`Responses API run exceeded maxSteps (${input.maxSteps})`);
}

function mergeReasoningEffort(
  providerOptions: Record<string, unknown> | undefined,
  reasoningEffort: ReasoningEffort | undefined,
): Record<string, unknown> {
  if (!reasoningEffort) {
    return providerOptions ?? {};
  }

  const reasoning = isRecord(providerOptions?.reasoning) ? providerOptions.reasoning : {};

  return {
    ...(providerOptions ?? {}),
    reasoning: {
      ...reasoning,
      effort: reasoningEffort,
    },
  };
}

export function buildResponsesTools(
  tools: Record<string, ToolLike>,
): Array<Record<string, unknown>> {
  return Object.entries(tools).map(([name, tool]) => ({
    type: 'function',
    name,
    description: readStringProp(tool, 'description') ?? name,
    parameters: schemaToJsonSchema(readUnknownProp(tool, 'inputSchema')),
  }));
}

async function postResponsesRequest(
  endpoint: string,
  body: Record<string, unknown>,
  input: ResponsesLoopInput,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const headers = new Headers({
    'content-type': 'application/json',
    ...(input.headers ?? {}),
  });
  if (input.apiKey && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${input.apiKey}`);
  }

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: input.executionContext?.abortSignal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Responses API request failed with HTTP ${response.status}: ${detail || response.statusText}`,
    );
  }

  const json: unknown = await response.json();
  if (!isRecord(json)) {
    throw new Error('Responses API returned a non-object response');
  }
  return json;
}

async function executeFunctionCalls(
  calls: FunctionCall[],
  input: ResponsesLoopInput,
): Promise<FunctionCallOutput[]> {
  const outputs: FunctionCallOutput[] = [];

  for (const call of calls) {
    if (input.streamEvents) {
      input.emit({
        type: 'tool_event',
        messageType: 'tool_use',
        tool: call.name,
        toolUseId: call.callId,
        input: call.input,
      });
    }

    const tool = input.tools[call.name];
    if (!tool?.execute) {
      const message = `Tool "${call.name}" is not available.`;
      if (input.streamEvents) {
        input.emit({
          type: 'tool_event',
          messageType: 'tool_result',
          tool: call.name,
          toolUseId: call.callId,
          output: message,
          isError: true,
        });
      }
      outputs.push({ type: 'function_call_output', call_id: call.callId, output: message });
      continue;
    }

    try {
      if (call.inputError) {
        throw new Error(call.inputError);
      }
      const validatedInput = await validateToolInput(tool, call.input, call.name);
      const result = await executeTool(tool, validatedInput, call.callId, input.executionContext);
      const output = stringifyToolOutput(applyToolModelOutput(tool, result));
      const metadata = input.getToolOutputMetadata?.(call.callId);
      if (input.streamEvents) {
        input.emit({
          type: 'tool_event',
          messageType: 'tool_result',
          tool: call.name,
          toolUseId: call.callId,
          output,
          isError: false,
          ...(metadata?.truncated
            ? {
                truncated: true,
                originalChars: metadata.originalChars,
                excerptChars: metadata.excerptChars,
              }
            : {}),
        });
      }
      outputs.push({ type: 'function_call_output', call_id: call.callId, output });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (input.streamEvents) {
        input.emit({
          type: 'tool_event',
          messageType: 'tool_result',
          tool: call.name,
          toolUseId: call.callId,
          output: message,
          isError: true,
        });
      }
      outputs.push({ type: 'function_call_output', call_id: call.callId, output: message });
    }
  }

  return outputs;
}

async function executeTool(
  tool: ToolLike,
  toolInput: unknown,
  toolCallId: string,
  contextInput?: ResponsesToolExecutionContextInput,
): Promise<unknown> {
  const execute = tool.execute as unknown as (
    value: unknown,
    ctx?: ToolExecutionContext<unknown, unknown> & {
      toolCallId: string;
      options: { toolCallId: string };
    },
  ) => Promise<unknown>;
  return execute(toolInput, {
    ...(contextInput?.workspace ? { workspace: contextInput.workspace } : {}),
    ...(contextInput?.requestContext ? { requestContext: contextInput.requestContext } : {}),
    ...(contextInput?.abortSignal ? { abortSignal: contextInput.abortSignal } : {}),
    ...(contextInput?.mcp ? { mcp: contextInput.mcp } : {}),
    writer: contextInput?.writer ?? buildNoopToolWriter(),
    toolCallId,
    options: { toolCallId },
    agent: {
      agentId: 'openai-compatible-cli',
      toolCallId,
      messages: [],
      ...(contextInput?.threadId ? { threadId: contextInput.threadId } : {}),
      ...(contextInput?.resourceId ? { resourceId: contextInput.resourceId } : {}),
      suspend: () =>
        Promise.reject(new Error('Tool suspension is not supported in Responses API mode.')),
    },
  });
}

function buildNoopToolWriter(): ToolWriter {
  return {
    custom: () => Promise.resolve(undefined),
  } as unknown as ToolWriter;
}

function applyToolModelOutput(tool: ToolLike, result: unknown): unknown {
  const transformer = readUnknownProp(tool, 'toModelOutput');
  return typeof transformer === 'function'
    ? (transformer as (output: unknown) => unknown)(result)
    : result;
}

function extractFunctionCalls(response: Record<string, unknown>): FunctionCall[] {
  const output = response.output;
  if (!Array.isArray(output)) {
    return [];
  }

  const calls: FunctionCall[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'function_call') {
      continue;
    }
    const callId =
      readStringProp(item, 'call_id') ??
      readStringProp(item, 'callId') ??
      readStringProp(item, 'id');
    const name = readStringProp(item, 'name');
    if (!callId || !name) {
      continue;
    }
    const parsed = parseFunctionArguments(item.arguments);
    calls.push(
      parsed.ok
        ? {
            callId,
            name,
            input: parsed.value,
          }
        : {
            callId,
            name,
            inputError: parsed.error,
          },
    );
  }
  return calls;
}

type ParsedFunctionArguments = { ok: true; value: unknown } | { ok: false; error: string };

function parseFunctionArguments(value: unknown): ParsedFunctionArguments {
  if (typeof value !== 'string') {
    return { ok: true, value: value ?? {} };
  }

  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false, error: 'Invalid JSON arguments for tool call.' };
  }
}

async function validateToolInput(
  tool: ToolLike,
  input: unknown,
  toolName: string,
): Promise<unknown> {
  const schema = readUnknownProp(tool, 'inputSchema');
  if (!schema) {
    return input;
  }

  if (isRecord(schema) && typeof schema.safeParse === 'function') {
    const result = (schema.safeParse as (value: unknown) => unknown)(input);
    if (isRecord(result) && result.success === true) {
      return result.data;
    }
    const message =
      isRecord(result) && result.error
        ? stringifyValidationError(result.error)
        : 'input validation failed';
    throw new Error(`Invalid arguments for tool "${toolName}": ${message}`);
  }

  if (isRecord(schema) && isRecord(schema['~standard'])) {
    const validator = schema['~standard'];
    const validate = readUnknownProp(validator, 'validate');
    if (typeof validate === 'function') {
      const validateFn = validate as (value: unknown) => unknown;
      const result: unknown = await validateFn(input);
      if (isRecord(result) && Array.isArray(result.issues) && result.issues.length > 0) {
        throw new Error(
          `Invalid arguments for tool "${toolName}": ${formatStandardIssues(result.issues)}`,
        );
      }
      if (isRecord(result) && Object.prototype.hasOwnProperty.call(result, 'value')) {
        return result.value;
      }
    }
  }

  return input;
}

function extractResponseText(response: Record<string, unknown>): string {
  const topLevel =
    readStringProp(response, 'output_text') ?? readStringProp(response, 'outputText');
  if (topLevel) {
    return topLevel;
  }

  const parts: string[] = [];
  const output = response.output;
  if (!Array.isArray(output)) {
    return '';
  }

  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.type === 'output_text') {
      const text = readStringProp(item, 'text');
      if (text) parts.push(text);
      continue;
    }
    const content = item.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const contentItem of content) {
      if (!isRecord(contentItem)) {
        continue;
      }
      if (contentItem.type === 'output_text' || contentItem.type === 'text') {
        const text = readStringProp(contentItem, 'text');
        if (text) parts.push(text);
      }
    }
  }

  return parts.join('');
}

function normalizeResponsesUsage(value: unknown): AgentUsage {
  if (!isRecord(value)) {
    return { inputTokens: 0, outputTokens: 0 };
  }

  const inputTokens =
    readNumberProp(value, 'input_tokens') ??
    readNumberProp(value, 'inputTokens') ??
    readNumberProp(value, 'prompt_tokens') ??
    0;
  const outputTokens =
    readNumberProp(value, 'output_tokens') ??
    readNumberProp(value, 'outputTokens') ??
    readNumberProp(value, 'completion_tokens') ??
    0;
  const details = isRecord(value.input_tokens_details)
    ? value.input_tokens_details
    : isRecord(value.prompt_tokens_details)
      ? value.prompt_tokens_details
      : undefined;
  const cacheReadTokens =
    (details
      ? (readNumberProp(details, 'cached_tokens') ?? readNumberProp(details, 'cachedTokens'))
      : undefined) ??
    readNumberProp(value, 'cached_tokens') ??
    readNumberProp(value, 'cachedTokens') ??
    0;

  return { inputTokens, outputTokens, cacheReadTokens };
}

function addUsage(total: AgentUsage, step: AgentUsage): void {
  total.inputTokens += step.inputTokens;
  total.outputTokens += step.outputTokens;
  total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (step.cacheReadTokens ?? 0);
}

function omitZeroCacheRead(usage: AgentUsage): AgentUsage {
  return usage.cacheReadTokens && usage.cacheReadTokens > 0
    ? usage
    : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringifyValidationError(value: unknown): string {
  if (isRecord(value)) {
    const issues = value.issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return formatStandardIssues(issues);
    }
    const message = readStringProp(value, 'message');
    if (message) {
      return message;
    }
  }
  return stringifyToolOutput(value);
}

function formatStandardIssues(issues: unknown[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => {
      if (!isRecord(issue)) {
        return stringifyToolOutput(issue);
      }
      const message = readStringProp(issue, 'message') ?? stringifyToolOutput(issue);
      const path =
        Array.isArray(issue.path) && issue.path.length > 0
          ? ` at ${issue.path.map((part) => String(part)).join('.')}`
          : '';
      return `${message}${path}`;
    })
    .join('; ');
}

function schemaToJsonSchema(value: unknown): Record<string, unknown> {
  if (isRecord(value) && typeof value.toJSONSchema === 'function') {
    const jsonSchema = (value.toJSONSchema as () => unknown)();
    return normalizeJsonSchema(jsonSchema);
  }

  return normalizeJsonSchema(value);
}

function normalizeJsonSchema(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return { type: 'object', properties: {}, required: [] };
  }

  if (typeof value.type === 'string') {
    const rest: Record<string, unknown> = { ...value };
    delete rest.$schema;
    return rest;
  }

  return { type: 'object', properties: {}, required: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readStringProp(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entry = value[key];
  return typeof entry === 'string' ? entry : undefined;
}

function readNumberProp(value: Record<string, unknown>, key: string): number | undefined {
  const entry = value[key];
  return typeof entry === 'number' && Number.isFinite(entry) ? entry : undefined;
}

function readUnknownProp(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
