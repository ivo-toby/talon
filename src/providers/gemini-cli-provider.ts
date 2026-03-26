import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { err, ok, type Result } from 'neverthrow';
import { BackgroundAgentError } from '../core/errors/error-types.js';
import type { ProviderConfig } from '../core/config/config-types.js';
import type { AgentProvider, AgentRunInput } from './provider.js';
import type {
  AgentUsage,
  CanonicalMcpServer,
  ContextUsage,
  PreparedProviderInvocation,
  ProviderResult,
  ProviderSpawnInput,
} from './provider-types.js';

interface GeminiTokens {
  input?: number;
  prompt?: number;
  candidates?: number;
  total?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
}

interface GeminiModelStats {
  tokens?: GeminiTokens;
}

interface GeminiStats {
  models?: Record<string, GeminiModelStats>;
}

const GEMINI_JSON_UPGRADE_MESSAGE =
  'Gemini CLI returned non-JSON output despite --output-format json. Upgrade gemini-cli to a compatible version.';

export class GeminiCliProvider implements AgentProvider {
  readonly name = 'gemini-cli';

  constructor(private readonly config: ProviderConfig) {}

  createExecutionStrategy() {
    return {
      type: 'cli' as const,
      supportsSessionResumption: false as const,
      run: async (input: AgentRunInput) => {
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

        const invocation = invocationResult.value;
        try {
          const raw = await this.executeInvocation(invocation);
          const parsed = this.parseResult(raw, { failOnSuccessfulNonJson: true });
          return {
            output: parsed.output,
            sessionId: undefined,
            usage: parsed.usage ?? { inputTokens: 0, outputTokens: 0 },
            isError: parsed.exitCode !== 0 || parsed.timedOut,
          };
        } finally {
          this.cleanupPaths(invocation.cleanupPaths);
        }
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
        response?: string;
        stats?: GeminiStats;
      };

      if (typeof parsed.response === 'string' && parsed.response.length > 0) {
        output = parsed.response;
      }

      const statsUsage = this.extractUsage(parsed.stats);
      if (statsUsage) {
        usage = statsUsage;
      }
    } catch (cause) {
      if (raw.exitCode === 0 && !raw.timedOut) {
        const parseError = cause instanceof Error ? cause : undefined;
        if (options.failOnSuccessfulNonJson) {
          throw new BackgroundAgentError(GEMINI_JSON_UPGRADE_MESSAGE, parseError);
        }

        return {
          output,
          stderr: this.appendStderr(raw.stderr, GEMINI_JSON_UPGRADE_MESSAGE),
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
    input: ProviderSpawnInput & { model?: string },
  ): Result<PreparedProviderInvocation, BackgroundAgentError> {
    let tempDir: string | undefined;

    try {
      tempDir = join(tmpdir(), `talon-provider-gemini-cli-${randomUUID()}`);
      mkdirSync(tempDir, { recursive: true, mode: 0o700 });

      const settingsPath = join(tempDir, 'settings.json');
      const systemPromptPath = join(tempDir, 'system.md');

      writeFileSync(
        settingsPath,
        JSON.stringify(
          {
            security: {
              folderTrust: {
                enabled: false,
              },
            },
            mcpServers: this.toGeminiMcpServers(input.mcpServers),
          },
          null,
          2,
        ),
        { encoding: 'utf8', mode: 0o600 },
      );
      writeFileSync(systemPromptPath, input.systemPrompt, {
        encoding: 'utf8',
        mode: 0o600,
      });

      // Ignore input.model (persona model, e.g. "claude-opus-4-6") — it is
      // provider-specific and meaningless to Gemini CLI. Use the provider's
      // own configured default model, or let Gemini pick its own default.
      const model = this.readDefaultModel();
      const args = ['--approval-mode', 'yolo', '--output-format', 'json'];

      if (model) {
        args.push('--model', model);
      }

      args.push(input.prompt);

      return ok({
        command: this.config.command,
        args,
        stdin: '',
        env: {
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath,
          GEMINI_SYSTEM_MD: systemPromptPath,
        },
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        cleanupPaths: [tempDir],
      });
    } catch (cause) {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }

      return err(
        new BackgroundAgentError(
          `Gemini CLI: failed to prepare background invocation: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  private toGeminiMcpServers(
    mcpServers: Record<string, CanonicalMcpServer>,
  ): Record<string, unknown> {
    const nativeServers: Record<string, unknown> = {};

    for (const [name, server] of Object.entries(mcpServers)) {
      if (server.transport === 'sdk') {
        // SDK in-process servers are not supported by CLI providers - skip
        continue;
      }

      if (server.transport === 'stdio') {
        nativeServers[name] = {
          command: server.command,
          args: server.args,
          ...(server.env ? { env: server.env } : {}),
        };
        continue;
      }

      if (server.transport === 'http') {
        nativeServers[name] = {
          httpUrl: server.url,
          ...(server.headers ? { headers: server.headers } : {}),
        };
        continue;
      }

      nativeServers[name] = {
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    }

    return nativeServers;
  }

  private readDefaultModel(): string | undefined {
    const defaultModel = this.config.options?.defaultModel;
    return typeof defaultModel === 'string' && defaultModel.trim().length > 0
      ? defaultModel
      : undefined;
  }

  private extractUsage(stats: GeminiStats | undefined): AgentUsage | undefined {
    if (!stats?.models) {
      return undefined;
    }

    // Aggregate tokens across all models in the response.
    // Gemini shape: stats.models.<modelName>.tokens.{input, candidates, ...}
    const totals = Object.values(stats.models).reduce(
      (acc, modelStats) => {
        const tokens = modelStats?.tokens;
        if (!tokens) return acc;
        acc.input += typeof tokens.input === 'number' ? tokens.input : 0;
        acc.output += typeof tokens.candidates === 'number' ? tokens.candidates : 0;
        return acc;
      },
      { input: 0, output: 0 },
    );

    if (totals.input > 0 || totals.output > 0) {
      return {
        inputTokens: totals.input,
        outputTokens: totals.output,
      };
    }

    return undefined;
  }

  private executeInvocation(invocation: PreparedProviderInvocation): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }> {
    return new Promise((resolve, reject) => {
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
        child.kill();
      }, invocation.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      child.on('error', (cause) => {
        clearTimeout(timeout);
        reject(
          new BackgroundAgentError(
            `Gemini CLI: failed to run provider process: ${cause.message}`,
            cause,
          ),
        );
      });

      child.on('close', (exitCode) => {
        clearTimeout(timeout);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode,
          timedOut,
        });
      });

      child.stdin.on('error', () => {});
      child.stdin.end(invocation.stdin);
    });
  }

  private cleanupPaths(paths: string[]): void {
    for (const path of paths) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}
