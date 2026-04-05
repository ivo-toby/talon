import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import type { ProviderConfig } from '../core/config/config-types.js';
import { BackgroundAgentError } from '../core/errors/error-types.js';
import type {
  AgentProvider,
  AgentRunInput,
  AgentRunResult,
  StatelessCLIExecutionStrategy,
} from './provider.js';
import type {
  AgentUsage,
  CanonicalMcpServer,
  ContextUsage,
  PreparedProviderInvocation,
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
}

const OPENAI_COMPATIBLE_JSON_UPGRADE_MESSAGE =
  'OpenAI-compatible wrapper returned non-JSON output despite a successful exit. Inspect stderr for wrapper failures.';

export class OpenAiCompatibleProvider implements AgentProvider {
  readonly name = 'openai-compatible';

  constructor(
    private readonly config: ProviderConfig,
    private readonly runtime: OpenAiCompatibleProviderRuntime = {},
  ) {}

  createExecutionStrategy(): StatelessCLIExecutionStrategy {
    return {
      type: 'cli' as const,
      supportsSessionResumption: false as const,
      run: async (input: AgentRunInput): Promise<AgentRunResult> => {
        const invocationResult = this.prepareInvocation({
          prompt: input.prompt,
          systemPrompt: input.systemPrompt,
          mcpServers: input.mcpServers,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          model: input.model,
        });
        if (invocationResult.isErr()) {
          throw invocationResult.error;
        }

        const parsed = this.parseResult(
          await this.executeInvocation(invocationResult.value),
          { failOnSuccessfulNonJson: true },
        );
        return {
          output: parsed.output,
          sessionId: undefined,
          usage: parsed.usage ?? { inputTokens: 0, outputTokens: 0 },
          isError: parsed.exitCode !== 0 || parsed.timedOut,
        };
      },
    };
  }

  prepareBackgroundInvocation(
    input: ProviderSpawnInput,
  ): Result<PreparedProviderInvocation, BackgroundAgentError> {
    return this.prepareInvocation(input);
  }

  parseBackgroundResult(raw: {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }): ProviderResult {
    return this.parseResult(raw, { failOnSuccessfulNonJson: false });
  }

  estimateContextUsage(usage: AgentUsage): ContextUsage {
    return {
      inputTokens: usage.inputTokens ?? 0,
      metrics: {
        input_tokens: usage.inputTokens ?? 0,
      },
    };
  }

  private parseResult(
    raw: {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
    },
    options: { failOnSuccessfulNonJson: boolean },
  ): ProviderResult {
    let output = raw.stdout;
    let usage: AgentUsage | undefined;

    try {
      const parsed = JSON.parse(raw.stdout) as {
        output?: string;
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          totalCostUsd?: number;
        };
      };

      if (typeof parsed.output === 'string' && parsed.output.length > 0) {
        output = parsed.output;
      }

      if (parsed.usage) {
        usage = {
          inputTokens: parsed.usage.inputTokens ?? 0,
          outputTokens: parsed.usage.outputTokens ?? 0,
          cacheReadTokens: parsed.usage.cacheReadTokens,
          cacheWriteTokens: parsed.usage.cacheWriteTokens,
          totalCostUsd: parsed.usage.totalCostUsd,
        };
      }
    } catch (cause) {
      if (raw.exitCode === 0 && !raw.timedOut) {
        const parseError = cause instanceof Error ? cause : undefined;
        if (options.failOnSuccessfulNonJson) {
          throw new BackgroundAgentError(OPENAI_COMPATIBLE_JSON_UPGRADE_MESSAGE, parseError);
        }

        return {
          output,
          stderr: this.appendStderr(raw.stderr, OPENAI_COMPATIBLE_JSON_UPGRADE_MESSAGE),
          exitCode: 1,
          timedOut: raw.timedOut,
        };
      }
    }

    return {
      output,
      stderr: raw.stderr,
      exitCode: raw.exitCode,
      timedOut: raw.timedOut,
      usage,
    };
  }

  private appendStderr(stderr: string, message: string): string {
    const trimmed = stderr.trim();
    return trimmed.length > 0 ? `${trimmed}\n${message}` : message;
  }

  private prepareInvocation(
    input: ProviderSpawnInput,
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
          'OpenAI-compatible provider requires providers.<name>.options.baseUrl or auth.providers.openai-compatible.baseURL',
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
    };

    return ok({
      command: this.config.command,
      args: scriptArgs,
      stdin: JSON.stringify(payload),
      env: input.traceparent ? { TALOND_TRACEPARENT: input.traceparent } : undefined,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      cleanupPaths: [],
    });
  }

  private readStringOption(name: string): string | undefined {
    const value = this.config.options?.[name];
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
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

  private executeInvocation(invocation: PreparedProviderInvocation): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: {
          ...process.env,
          ...(invocation.env ?? {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, invocation.timeoutMs);

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.stdout.on('data', (chunk) => {
        stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      });

      child.stderr.on('data', (chunk) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      });

      child.on('close', (exitCode) => {
        clearTimeout(timeout);
        resolvePromise({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode,
          timedOut,
        });
      });

      child.stdin.end(invocation.stdin);
    });
  }
}
