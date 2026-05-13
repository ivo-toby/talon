import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import type { ProviderConfig } from '../core/config/config-types.js';
import { BackgroundAgentError } from '../core/errors/error-types.js';
import type {
  AgentProvider,
  AgentRunInput,
  AgentStreamEvent,
  StatelessSDKExecutionStrategy,
} from './provider.js';
import type {
  AgentUsage,
  CanonicalMcpServer,
  ContextUsage,
  PreparedProviderInvocation,
  PreparedProviderResultFiles,
  ProviderResult,
  ProviderSpawnInput,
} from './provider-types.js';

interface OpenAiCompatibleProviderRuntime {
  apiKey?: string;
  baseUrl?: string;
}

interface WrapperPayload {
  prompt: string;
  systemPrompt: string;
  cwd: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  providerId: string;
  headers?: Record<string, string>;
  mcpServers: Record<string, Exclude<CanonicalMcpServer, { transport: 'sdk' }>>;
  /**
   * Foreground runs stream every text delta and tool event on stdout so the
   * agent-runner can surface incremental updates. Background runs ask the
   * wrapper to consume the stream silently and emit only the terminal
   * `result`/`error` line, because the background-agent stdout buffer caps
   * captured output at 100 KB and we must not let truncation discard the
   * summary for long responses.
   */
  streamEvents: boolean;
  /**
   * When set, the wrapper writes the full aggregate response to this path
   * after the stream completes. Used exclusively by the background path so
   * the terminal stdout line stays tiny (usage only) and the stdout buffer
   * cap cannot truncate away the run's actual output.
   */
  outputFilePath?: string;
  /**
   * Max chars of tool output allowed into agent message history before
   * excerpting. 0 disables the feature. When omitted, the wrapper uses its
   * internal default. See
   * specs/2026-04-20-tool-output-excerpting-stage1.md for rationale.
   */
  toolOutputCap?: number;
}

/** NDJSON event shape emitted by the wrapper CLI. */
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
      /**
       * Tool-output excerpting metadata carried across the wrapper→provider
       * boundary. See specs/2026-04-20-tool-output-excerpting-stage1.md.
       */
      truncated?: boolean;
      originalChars?: number;
      excerptChars?: number;
    }
  | {
      type: 'result';
      output: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
      };
      /**
       * Per-step usage from the FINAL model turn — distinct from
       * cumulative `usage`. Forwarded to ProviderResult.lastStepUsage so
       * context-rotation can gate on per-call prompt size rather than the
       * inflated sum across the agent loop.
       */
      lastStepUsage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
      };
    }
  | { type: 'error'; message: string };

export class OpenAiCompatibleProvider implements AgentProvider {
  readonly name = 'openai-compatible';

  constructor(
    private readonly config: ProviderConfig,
    private readonly runtime: OpenAiCompatibleProviderRuntime = {},
  ) {}

  createExecutionStrategy(): StatelessSDKExecutionStrategy {
    return {
      type: 'sdk' as const,
      supportsSessionResumption: false as const,
      run: (input: AgentRunInput) => this.streamForeground(input),
    };
  }

  prepareBackgroundInvocation(
    input: ProviderSpawnInput,
  ): Result<PreparedProviderInvocation, BackgroundAgentError> {
    // Allocate a temp file the wrapper will write the full response into.
    // Using a dedicated file avoids the 100 KB stdout buffer cap in
    // BackgroundAgentProcess, which would otherwise truncate the terminal
    // `result` line for long responses.
    let outputFilePath: string;
    let dir: string;
    try {
      dir = mkdtempSync(join(tmpdir(), 'talon-openai-compat-'));
      outputFilePath = join(dir, 'last-message.txt');
    } catch (cause) {
      return err(
        new BackgroundAgentError(
          `OpenAI-compatible provider: failed to allocate background result file: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }

    return this.prepareInvocation(input, {
      streamEvents: false,
      outputFilePath,
      cleanupPaths: [outputFilePath, dir],
      resultFiles: { lastMessagePath: outputFilePath },
    });
  }

  parseBackgroundResult(
    raw: {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
    },
    resultFiles?: PreparedProviderResultFiles,
  ): ProviderResult {
    // The wrapper emits NDJSON events on stdout. In background mode it only
    // writes a single terminal `result` (or `error`) line, so iteration is
    // short; walk from the end to pick up the most recent summary.
    const lines = raw.stdout.split('\n');
    let resultEvent: Extract<WrapperEvent, { type: 'result' }> | undefined;
    let errorEvent: Extract<WrapperEvent, { type: 'error' }> | undefined;

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as WrapperEvent;
        if (parsed.type === 'result' && !resultEvent) {
          resultEvent = parsed;
        } else if (parsed.type === 'error' && !errorEvent) {
          errorEvent = parsed;
        }
      } catch {
        // Ignore malformed lines — the wrapper only guarantees JSON for
        // event lines, so partial writes or noise are safely skipped.
      }
    }

    // Prefer the file-based transport when available. The wrapper writes the
    // full aggregate response to this file in background mode, which is
    // immune to the stdout buffer cap.
    let output = resultEvent?.output ?? '';
    const lastMessagePath = resultFiles?.lastMessagePath;
    if (typeof lastMessagePath === 'string') {
      try {
        const fileContent = readFileSync(lastMessagePath, 'utf8');
        if (fileContent.length > 0) {
          output = fileContent;
        }
      } catch {
        // Fall back to whatever the stdout envelope carried.
      }
    }

    let usage: AgentUsage | undefined;
    if (resultEvent?.usage) {
      usage = {
        inputTokens: resultEvent.usage.inputTokens ?? 0,
        outputTokens: resultEvent.usage.outputTokens ?? 0,
        cacheReadTokens: resultEvent.usage.cacheReadTokens,
      };
    }
    let lastStepUsage: AgentUsage | undefined;
    if (resultEvent?.lastStepUsage) {
      lastStepUsage = {
        inputTokens: resultEvent.lastStepUsage.inputTokens ?? 0,
        outputTokens: resultEvent.lastStepUsage.outputTokens ?? 0,
        cacheReadTokens: resultEvent.lastStepUsage.cacheReadTokens,
      };
    }

    const failed = raw.exitCode !== 0 || raw.timedOut || errorEvent !== undefined || !resultEvent;
    const combinedStderr = failed
      ? this.combineDiagnostics(raw.stderr, errorEvent?.message)
      : raw.stderr;

    return {
      output,
      stderr: combinedStderr,
      exitCode: failed && raw.exitCode === 0 ? 1 : raw.exitCode,
      timedOut: raw.timedOut,
      usage,
      ...(lastStepUsage ? { lastStepUsage } : {}),
    };
  }

  estimateContextUsage(usage: AgentUsage): ContextUsage {
    const inputTokens = usage.inputTokens ?? 0;
    const cacheReadTokens = usage.cacheReadTokens ?? 0;
    // OpenAI-compatible servers report `prompt_tokens_details.cached_tokens`
    // (cache reads) but no separate cache-creation metric. The uncached
    // portion (input - cached) is the equivalent of Claude's
    // cache_creation_input_tokens, mirroring the codex-cli provider.
    // Note: many upstream servers (Ollama, Groq, Together, …) never emit
    // cached_tokens, so cacheReadTokens stays zero and these metrics
    // degrade gracefully to `input_tokens` for users on those endpoints.
    const cacheCreationTokens = Math.max(0, inputTokens - cacheReadTokens);
    return {
      inputTokens,
      metrics: {
        input_tokens: inputTokens,
        cache_read_input_tokens: cacheReadTokens,
        cache_creation_input_tokens: cacheCreationTokens,
        cache_total_input_tokens: cacheReadTokens + cacheCreationTokens,
      },
    };
  }

  private async *streamForeground(input: AgentRunInput): AsyncIterable<AgentStreamEvent> {
    const invocationResult = this.prepareInvocation(
      {
        prompt: input.prompt,
        systemPrompt: input.systemPrompt,
        mcpServers: input.mcpServers,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        model: input.model,
      },
      { streamEvents: true, cleanupPaths: [] },
    );
    if (invocationResult.isErr()) {
      throw invocationResult.error;
    }

    const invocation = invocationResult.value;
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: {
        ...process.env,
        ...(invocation.env ?? {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: unknown) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, invocation.timeoutMs);

    const closePromise = new Promise<{ exitCode: number | null }>((resolvePromise, rejectPromise) => {
      child.on('error', (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      });
      child.on('close', (exitCode) => {
        clearTimeout(timeout);
        resolvePromise({ exitCode });
      });
    });
    // Attach a no-op handler so an unobserved rejection (consumer cancels
    // the generator before the normal post-stream await) does not surface
    // as an unhandled promise rejection. The real rejection is still
    // propagated to any later `await closePromise` below.
    closePromise.catch(() => {});

    child.stdin.end(invocation.stdin);

    let aggregatedOutput = '';
    let usage: AgentUsage = { inputTokens: 0, outputTokens: 0 };
    let sawResultEvent = false;
    let sawErrorEvent = false;

    try {
      for await (const line of readLines(child.stdout)) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event: WrapperEvent;
        try {
          event = JSON.parse(trimmed) as WrapperEvent;
        } catch {
          // Non-JSON output from the child is unexpected but non-fatal.
          // Skip silently; stderr will carry any operator diagnostics.
          continue;
        }

        if (event.type === 'text') {
          aggregatedOutput += event.content;
          yield { type: 'text', content: event.content };
        } else if (event.type === 'tool_event') {
          yield {
            type: 'tool_event',
            messageType: event.messageType,
            tool: event.tool,
            toolUseId: event.toolUseId,
            input: event.input,
            output: event.output,
            isError: event.isError,
            ...(event.truncated !== undefined ? { truncated: event.truncated } : {}),
            ...(event.originalChars !== undefined ? { originalChars: event.originalChars } : {}),
            ...(event.excerptChars !== undefined ? { excerptChars: event.excerptChars } : {}),
          };
        } else if (event.type === 'result') {
          sawResultEvent = true;
          const resultOutput = event.output && event.output.length > 0 ? event.output : aggregatedOutput;
          if (event.usage) {
            usage = {
              inputTokens: event.usage.inputTokens ?? 0,
              outputTokens: event.usage.outputTokens ?? 0,
              cacheReadTokens: event.usage.cacheReadTokens,
            };
          }
          const lastStepUsage = event.lastStepUsage
            ? {
                inputTokens: event.lastStepUsage.inputTokens ?? 0,
                outputTokens: event.lastStepUsage.outputTokens ?? 0,
                cacheReadTokens: event.lastStepUsage.cacheReadTokens,
              }
            : undefined;
          yield {
            type: 'result',
            result: {
              output: resultOutput,
              sessionId: undefined,
              usage,
              ...(lastStepUsage ? { lastStepUsage } : {}),
              isError: false,
            },
          };
        } else if (event.type === 'error') {
          sawErrorEvent = true;
          yield { type: 'error', message: event.message };
        }
      }

      // Stream exhausted normally — resolve the child exit state and emit a
      // synthetic terminal event if the wrapper did not already emit one.
      const { exitCode } = await closePromise.catch((error: unknown) => ({
        exitCode: null as number | null,
        error,
      }));

      if (timedOut) {
        yield {
          type: 'error',
          message: `OpenAI-compatible wrapper timed out after ${invocation.timeoutMs}ms`,
        };
      } else if (exitCode !== 0 && !sawErrorEvent) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        const detail = stderr.length > 0 ? stderr : `exit code ${exitCode ?? 'null'}`;
        yield {
          type: 'error',
          message: `OpenAI-compatible wrapper failed: ${detail}`,
        };
      } else if (!sawResultEvent && !sawErrorEvent) {
        // The wrapper finished cleanly but never emitted a result event.
        // Surface whatever text we captured so the caller is not left with
        // an empty response, but flag the situation for operators.
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        if (stderr.length > 0) {
          yield { type: 'error', message: stderr };
        } else {
          yield {
            type: 'result',
            result: {
              output: aggregatedOutput,
              sessionId: undefined,
              usage,
              isError: aggregatedOutput.length === 0,
            },
          };
        }
      }
    } finally {
      // Best-effort cleanup: kill the child if the consumer abandoned the
      // generator before the stream finished. Never yield or return here —
      // doing so would mask upstream exceptions.
      clearTimeout(timeout);
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore kill failures during teardown.
        }
      }
    }
  }

  private combineDiagnostics(stderr: string, errorMessage: string | undefined): string {
    const parts: string[] = [];
    const trimmedStderr = stderr.trim();
    if (trimmedStderr.length > 0) {
      parts.push(trimmedStderr);
    }
    if (errorMessage && errorMessage.length > 0 && !parts.includes(errorMessage)) {
      parts.push(errorMessage);
    }
    return parts.join('\n');
  }

  private prepareInvocation(
    input: ProviderSpawnInput,
    options: {
      streamEvents: boolean;
      outputFilePath?: string;
      cleanupPaths: string[];
      resultFiles?: PreparedProviderResultFiles;
    },
  ): Result<PreparedProviderInvocation, BackgroundAgentError> {
    const model = input.model ?? this.readStringOption('defaultModel');
    if (!model) {
      return err(
        new BackgroundAgentError(
          'OpenAI-compatible provider requires input.model or providers.<name>.options.defaultModel',
        ),
      );
    }

    const baseUrl = this.readStringOption('baseUrl') ?? this.runtime.baseUrl;
    if (!baseUrl) {
      return err(
        new BackgroundAgentError(
          'OpenAI-compatible provider requires providers.<name>.options.baseUrl, or auth.providers.<options.providerId>.baseURL, or auth.providers.openai-compatible.baseURL',
        ),
      );
    }

    const scriptArgs = this.resolveWrapperArgs();
    const payload: WrapperPayload = {
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      cwd: input.cwd,
      model,
      baseUrl,
      providerId: this.readStringOption('providerId') ?? 'openai-compatible',
      ...(this.runtime.apiKey ? { apiKey: this.runtime.apiKey } : {}),
      ...(this.readRecordOption('headers') ? { headers: this.readRecordOption('headers') } : {}),
      mcpServers: this.toSerializableMcpServers(input.mcpServers),
      streamEvents: options.streamEvents,
      ...(options.outputFilePath ? { outputFilePath: options.outputFilePath } : {}),
      ...(this.readNumericOption('toolOutputCap') !== undefined
        ? { toolOutputCap: this.readNumericOption('toolOutputCap') }
        : {}),
    };

    return ok({
      command: this.config.command,
      args: scriptArgs,
      stdin: JSON.stringify(payload),
      env: input.traceparent ? { TALOND_TRACEPARENT: input.traceparent } : undefined,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      cleanupPaths: options.cleanupPaths,
      ...(options.resultFiles ? { resultFiles: options.resultFiles } : {}),
    });
  }

  private readStringOption(name: string): string | undefined {
    const value = this.config.options?.[name];
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  }

  private readNumericOption(name: string): number | undefined {
    const value = this.config.options?.[name];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    return undefined;
  }

  private readRecordOption(name: string): Record<string, string> | undefined {
    const value = this.config.options?.[name];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const entries = Object.entries(value).filter(([, entry]) => typeof entry === 'string');
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  private resolveWrapperArgs(): string[] {
    const projectRoot = resolve(import.meta.dirname, '..', '..');
    const distPath = resolve(projectRoot, 'dist/providers/openai-compatible/agent-cli/index.js');
    if (existsSync(distPath)) {
      return [distPath];
    }

    const sourcePath = resolve(projectRoot, 'src/providers/openai-compatible/agent-cli/index.ts');
    return ['--import', 'tsx/esm', sourcePath];
  }

  private toSerializableMcpServers(
    mcpServers: Record<string, CanonicalMcpServer>,
  ): Record<string, Exclude<CanonicalMcpServer, { transport: 'sdk' }>> {
    const serializable: Record<string, Exclude<CanonicalMcpServer, { transport: 'sdk' }>> = {};

    for (const [name, server] of Object.entries(mcpServers)) {
      if (server.transport === 'sdk') {
        continue;
      }

      serializable[name] = server;
    }

    return serializable;
  }
}

/** Yields newline-delimited lines from a Node readable byte stream. */
async function* readLines(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      yield buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
  }
  if (buffer.length > 0) {
    yield buffer;
  }
}
