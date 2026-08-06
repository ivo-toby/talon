/**
 * AI SDK language-model adapter for subscription-authenticated Claude Code.
 *
 * This is deliberately local to the sub-agent system. It does not register an
 * AgentProvider, expose MCP servers, create resumable sessions, or inherit a
 * persona's tool access. Sub-agents need one bounded text or JSON generation
 * only, so running the full agent-provider lifecycle here would widen their
 * authority unnecessarily.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';

export type SubscriptionCliProvider = 'claude-code';

export interface SubscriptionCliModelConfig {
  provider: SubscriptionCliProvider;
  modelName: string;
  command: string;
}

export interface SubscriptionCliInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  abortSignal?: AbortSignal;
}

export interface SubscriptionCliInvocationResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type SubscriptionCliExecutor = (
  invocation: SubscriptionCliInvocation,
) => Promise<SubscriptionCliInvocationResult>;

interface PromptParts {
  system: string;
  user: string;
}

const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

/**
 * Presents a single constrained subscription CLI invocation as an AI SDK model.
 * `generateText` and `generateObject` therefore keep their existing behavior in
 * built-in and operator-supplied sub-agents without joining the agent provider
 * registry.
 */
export class SubscriptionCliLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  constructor(
    private readonly config: SubscriptionCliModelConfig,
    private readonly execute: SubscriptionCliExecutor = executeSubscriptionCli,
  ) {
    this.provider = config.provider;
    this.modelId = config.modelName;
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const prompt = extractPromptParts(options.prompt);
    const tempDir = await mkdtemp(join(tmpdir(), `talon-subagent-${this.config.provider}-`));

    try {
      const schema: unknown = responseSchema(options);
      const invocation = this.buildInvocation({
        tempDir,
        prompt,
        schema,
        options,
      });
      const raw = await this.execute(invocation);

      if (raw.exitCode !== 0) {
        const detail = raw.stderr.trim() || raw.stdout.trim() || 'no output';
        throw new Error(
          `${this.config.provider} sub-agent CLI exited with ${raw.exitCode ?? 'unknown'}: ${detail}`,
        );
      }

      const text = this.parseOutput(raw);
      if (!text.trim()) {
        throw new Error(`${this.config.provider} sub-agent CLI returned an empty response`);
      }

      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: parseUsage(this.config.provider, raw.stdout),
        warnings:
          options.maxOutputTokens === undefined
            ? []
            : [
                {
                  type: 'unsupported',
                  feature: 'maxOutputTokens',
                  details:
                    `${this.config.provider} subscription CLI does not expose a hard output-token limit; ` +
                    'the sub-agent timeout remains enforced.',
                },
              ],
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  doStream(_options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    return Promise.reject(new Error('Subscription CLI sub-agent models do not support streaming'));
  }

  private buildInvocation(input: {
    tempDir: string;
    prompt: PromptParts;
    schema?: unknown;
    options: LanguageModelV3CallOptions;
  }): SubscriptionCliInvocation {
    const args = [
      '--print',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--safe-mode',
      '--tools',
      '',
      '--max-turns',
      '1',
      '--model',
      this.config.modelName,
      '--system-prompt',
      input.prompt.system,
    ];

    if (input.schema) {
      args.push('--json-schema', JSON.stringify(input.schema));
    }

    return {
      command: this.config.command,
      args,
      cwd: input.tempDir,
      env: subscriptionCliEnvironment(),
      stdin: input.prompt.user,
      abortSignal: input.options.abortSignal,
    };
  }

  private parseOutput(raw: SubscriptionCliInvocationResult): string {
    try {
      const parsed = JSON.parse(raw.stdout) as { result?: unknown; structured_output?: unknown };
      if (parsed.structured_output !== undefined) {
        return JSON.stringify(parsed.structured_output);
      }
      if (typeof parsed.result === 'string') {
        return parsed.result;
      }
    } catch {
      // The CLI promised JSON output; surface a clear empty-response failure
      // below if a version mismatch prevents parsing it.
    }

    return '';
  }
}

function extractPromptParts(prompt: LanguageModelV3Prompt): PromptParts {
  const system: string[] = [];
  const user: string[] = [];

  for (const message of prompt) {
    if (message.role === 'system') {
      system.push(message.content);
      continue;
    }

    if (message.role === 'user') {
      for (const part of message.content) {
        if (part.type !== 'text') {
          throw new Error('Subscription CLI sub-agent models support text prompts only');
        }
        user.push(part.text);
      }
      continue;
    }

    throw new Error('Subscription CLI sub-agent models support a single system/user prompt only');
  }

  return { system: system.join('\n\n'), user: user.join('\n\n') };
}

function responseSchema(options: LanguageModelV3CallOptions): unknown {
  if (options.responseFormat?.type !== 'json') {
    return undefined;
  }
  return options.responseFormat.schema as unknown;
}

function subscriptionCliEnvironment(): NodeJS.ProcessEnv {
  // Do not pass the daemon environment to an authenticated CLI. Claude Code
  // needs only its normal login/config location, the official Claude Code
  // subscription setup token, and process-discovery/locale settings. Channel
  // tokens, database credentials, API keys, and API-routing overrides must
  // stay outside this child process.
  const allowedKeys = [
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'LANG',
    'LC_ALL',
    'TZ',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ] as const;
  const env: NodeJS.ProcessEnv = {};

  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  return env;
}

function parseUsage(_provider: SubscriptionCliProvider, stdout: string): LanguageModelV3Usage {
  try {
    const parsed = JSON.parse(stdout) as {
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    return usageFromNumbers(parsed.usage?.input_tokens, parsed.usage?.output_tokens);
  } catch {
    return EMPTY_USAGE;
  }
}

function usageFromNumbers(input: unknown, output: unknown): LanguageModelV3Usage {
  const inputTokens = numberValue(input);
  const outputTokens = numberValue(output);
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export async function executeSubscriptionCli(
  invocation: SubscriptionCliInvocation,
): Promise<SubscriptionCliInvocationResult> {
  return await new Promise<SubscriptionCliInvocationResult>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      invocation.abortSignal?.removeEventListener('abort', onAbort);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      callback();
    };
    const onAbort = (): void => {
      terminateProcessGroup(child.pid, 'SIGTERM');
      forceKillTimer = setTimeout(() => terminateProcessGroup(child.pid, 'SIGKILL'), 2_000);
      forceKillTimer.unref();
    };

    if (invocation.abortSignal?.aborted) {
      onAbort();
    } else {
      invocation.abortSignal?.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (exitCode) => {
      finish(() =>
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode,
        }),
      );
    });
    child.stdin.on('error', () => {});
    child.stdin.end(invocation.stdin);
  });
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;

  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, signal);
      return;
    }
    process.kill(pid, signal);
  } catch {
    // A process that has already exited needs no further cleanup.
  }
}
