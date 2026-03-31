import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import type { ProviderConfig } from '../core/config/config-types.js';
import { BackgroundAgentError } from '../core/errors/error-types.js';
import type { AgentProvider, AgentRunInput } from './provider.js';
import type {
  AgentUsage,
  CanonicalMcpServer,
  ContextUsage,
  PreparedProviderInvocation,
  PreparedProviderResultFiles,
  ProviderResult,
  ProviderSpawnInput,
} from './provider-types.js';

interface CodexCliProviderRuntime {
  dataDir: string;
  operatorHome?: string;
}

interface CodexParsedOutput {
  threadId?: string;
  usage?: AgentUsage;
}

interface RenderedCodexConfig {
  toml: string;
  env: Record<string, string>;
}

export class CodexCliProvider implements AgentProvider {
  readonly name = 'codex-cli';

  constructor(
    private readonly config: ProviderConfig,
    private readonly runtime: CodexCliProviderRuntime,
  ) {}

  createExecutionStrategy() {
    return {
      type: 'cli' as const,
      supportsSessionResumption: true as const,
      run: async (input: AgentRunInput) => this.runForeground(input),
    };
  }

  prepareBackgroundInvocation(
    input: ProviderSpawnInput,
  ): Result<PreparedProviderInvocation, BackgroundAgentError> {
    return this.prepareBackgroundCodexInvocation(input);
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
    return this.parseCodexResult(raw, resultFiles);
  }

  estimateContextUsage(usage: AgentUsage): ContextUsage {
    return {
      inputTokens: usage.inputTokens ?? 0,
      metrics: {
        input_tokens: usage.inputTokens ?? 0,
      },
    };
  }

  private buildForegroundHome(threadId: string): string {
    return join(this.runtime.dataDir, 'providers', 'codex-cli', 'threads', threadId, 'home');
  }

  private buildBackgroundHome(): string {
    return join(tmpdir(), `talon-provider-codex-cli-${randomUUID()}`);
  }

  private operatorCodexDir(): string {
    return join(this.runtime.operatorHome ?? homedir(), '.codex');
  }

  private seedCodexHome(
    homeDir: string,
    cwd: string,
    mcpServers: Record<string, CanonicalMcpServer>,
    model: string | undefined,
  ): Result<{ configEnv: Record<string, string> }, BackgroundAgentError> {
    try {
      const codexDir = join(homeDir, '.codex');
      mkdirSync(codexDir, { recursive: true, mode: 0o700 });

      const sourceAuthPath = join(this.operatorCodexDir(), 'auth.json');
      const authJson = readFileSync(sourceAuthPath, 'utf8');
      writeFileSync(join(codexDir, 'auth.json'), authJson, { encoding: 'utf8', mode: 0o600 });

      const renderedConfig = this.renderConfigToml({ cwd, model, mcpServers });
      writeFileSync(join(codexDir, 'config.toml'), renderedConfig.toml, {
        encoding: 'utf8',
        mode: 0o600,
      });

      return ok({ configEnv: renderedConfig.env });
    } catch (cause) {
      return err(
        new BackgroundAgentError(
          `Codex CLI: failed to seed provider home: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  private renderConfigToml(input: {
    cwd: string;
    model?: string;
    mcpServers: Record<string, CanonicalMcpServer>;
  }): RenderedCodexConfig {
    const lines: string[] = [];
    const env: Record<string, string> = {};

    if (input.model) {
      lines.push(`model = ${JSON.stringify(input.model)}`);
      lines.push('');
    }

    lines.push(`[projects.${JSON.stringify(input.cwd)}]`);
    lines.push('trust_level = "trusted"');
    lines.push('');

    for (const [name, server] of Object.entries(input.mcpServers)) {
      if (server.transport === 'sdk') {
        continue;
      }

      const tableName = `mcp_servers.${JSON.stringify(name)}`;
      if (server.transport === 'stdio') {
        lines.push(`[${tableName}]`);
        lines.push(`command = ${JSON.stringify(server.command)}`);
        lines.push(`args = [${server.args.map((arg) => JSON.stringify(arg)).join(', ')}]`);
        lines.push('');

        if (server.env && Object.keys(server.env).length > 0) {
          lines.push(`[${tableName}.env]`);
          for (const [key, value] of Object.entries(server.env)) {
            lines.push(`${key} = ${JSON.stringify(value)}`);
          }
          lines.push('');
        }
        continue;
      }

      lines.push(`[${tableName}]`);
      lines.push(`url = ${JSON.stringify(server.url)}`);

      const headers = server.headers ?? {};
      const headerEntries = Object.entries(headers);
      if (headerEntries.length === 0) {
        lines.push('');
        continue;
      }

      const [headerName, headerValue] = headerEntries[0];
      if (headerEntries.length !== 1 || headerName.toLowerCase() !== 'authorization') {
        throw new Error(
          `Codex CLI cannot represent custom headers for remote MCP server "${name}"`,
        );
      }

      const tokenMatch = /^Bearer\s+(.+)$/u.exec(String(headerValue));
      if (!tokenMatch) {
        throw new Error(
          `Codex CLI only supports bearer Authorization headers for remote MCP server "${name}"`,
        );
      }

      const envVar = this.toBearerEnvVar(name);
      env[envVar] = tokenMatch[1];
      lines.push(`bearer_token_env_var = ${JSON.stringify(envVar)}`);
      lines.push('');
    }

    return {
      toml: `${lines.join('\n').trim()}\n`,
      env,
    };
  }

  private toBearerEnvVar(name: string): string {
    const normalized = name
      .replace(/[^a-z0-9]+/giu, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase();
    const suffix = createHash('sha256').update(name).digest('hex').slice(0, 8).toUpperCase();
    return `TALON_CODEX_MCP_${normalized || 'SERVER'}_${suffix}_TOKEN`;
  }

  private buildCodexArgs(
    prompt: string,
    resultFiles: { lastMessagePath: string },
    options: {
      model?: string;
      sessionId?: string;
      ephemeral: boolean;
    },
  ): string[] {
    const args = ['exec'];
    if (options.sessionId) {
      args.push('resume', options.sessionId, prompt);
    } else {
      args.push(prompt);
    }

    args.push(
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-o',
      resultFiles.lastMessagePath,
    );

    if (options.ephemeral) {
      args.push('--ephemeral');
    }

    if (options.model) {
      args.push('--model', options.model);
    }

    return args;
  }

  private async runForeground(input: AgentRunInput) {
    const homeDir = this.buildForegroundHome(input.threadId);
    const lastMessagePath = join(homeDir, 'last-message.txt');
    const resultFiles = { lastMessagePath };
    const model = input.model ?? this.readDefaultModel();
    rmSync(lastMessagePath, { force: true });

    const seedResult = this.seedCodexHome(homeDir, input.cwd, input.mcpServers, model);
    if (seedResult.isErr()) {
      throw seedResult.error;
    }

    const invocation: PreparedProviderInvocation = {
      command: this.config.command,
      args: this.buildCodexArgs(input.prompt, resultFiles, {
        model,
        sessionId: input.sessionId,
        ephemeral: false,
      }),
      stdin: '',
      env: {
        HOME: homeDir,
        ...seedResult.value.configEnv,
      },
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      cleanupPaths: [],
      resultFiles,
    };

    const raw = await this.executeInvocation(invocation);
    const parsed = this.parseCodexResult(raw, resultFiles);
    const parsedJsonl = this.parseCodexJsonl(raw.stdout);
    return {
      output: parsed.output,
      sessionId: parsedJsonl.threadId,
      usage: parsed.usage ?? { inputTokens: 0, outputTokens: 0 },
      isError: parsed.exitCode !== 0 || parsed.timedOut,
    };
  }

  private prepareBackgroundCodexInvocation(
    input: ProviderSpawnInput,
  ): Result<PreparedProviderInvocation, BackgroundAgentError> {
    const homeDir = this.buildBackgroundHome();
    const resultFiles = { lastMessagePath: join(homeDir, 'last-message.txt') };
    const model = input.model ?? this.readDefaultModel();
    const seedResult = this.seedCodexHome(homeDir, input.cwd, input.mcpServers, model);
    if (seedResult.isErr()) {
      rmSync(homeDir, { recursive: true, force: true });
      return err(seedResult.error);
    }

    return ok({
      command: this.config.command,
      args: this.buildCodexArgs(input.prompt, resultFiles, {
        model,
        ephemeral: true,
      }),
      stdin: '',
      env: {
        HOME: homeDir,
        ...seedResult.value.configEnv,
        ...(input.traceparent ? { TALOND_TRACEPARENT: input.traceparent } : {}),
      },
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      cleanupPaths: [homeDir],
      resultFiles,
    });
  }

  private parseCodexResult(
    raw: {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
    },
    resultFiles?: PreparedProviderResultFiles,
  ): ProviderResult {
    const parsed = this.parseCodexJsonl(raw.stdout);
    let output = raw.stdout;

    const lastMessagePath = resultFiles?.lastMessagePath;
    if (typeof lastMessagePath === 'string') {
      try {
        output = readFileSync(lastMessagePath, 'utf8');
      } catch {
        // Fall back to stdout when the provider output file is unavailable.
      }
    }

    return {
      output,
      stderr: raw.stderr,
      exitCode: raw.exitCode,
      timedOut: raw.timedOut,
      usage: parsed.usage,
    };
  }

  private parseCodexJsonl(stdout: string): CodexParsedOutput {
    const result: CodexParsedOutput = {};
    const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);

    for (const line of lines) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        result.threadId = event.thread_id;
      }

      if (event.type === 'turn.completed' && typeof event.usage === 'object' && event.usage !== null) {
        const usage = event.usage as { input_tokens?: unknown; output_tokens?: unknown };
        result.usage = {
          inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
          outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
        };
      }
    }

    return result;
  }

  private readDefaultModel(): string | undefined {
    const defaultModel = this.config.options?.defaultModel;
    return typeof defaultModel === 'string' && defaultModel.trim().length > 0
      ? defaultModel
      : undefined;
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

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.on('error', (cause) => {
        clearTimeout(timeout);
        reject(
          new BackgroundAgentError(
            `Codex CLI: failed to run provider process: ${cause.message}`,
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
}
