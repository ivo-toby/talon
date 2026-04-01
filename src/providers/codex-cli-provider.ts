import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  hasThreadStarted: boolean;
  hasTurnCompleted: boolean;
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

      const sourceCodexDir = this.operatorCodexDir();
      for (const entry of readdirSync(sourceCodexDir)) {
        if (!this.shouldCopyCodexStateFile(entry)) {
          continue;
        }

        const sourcePath = join(sourceCodexDir, entry);
        if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
          continue;
        }

        copyFileSync(sourcePath, join(codexDir, entry));
      }

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

  private shouldCopyCodexStateFile(name: string): boolean {
    return (
      name === 'auth.json'
      || name === 'models_cache.json'
      || name === 'cloud-requirements-cache.json'
      || name === 'version.json'
      || /^state_\d+\.sqlite(?:-(?:wal|shm))?$/u.test(name)
      || /^logs_\d+\.sqlite(?:-(?:wal|shm))?$/u.test(name)
    );
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
    resultFiles: { lastMessagePath: string },
    options: {
      model?: string;
      sessionId?: string;
      ephemeral: boolean;
    },
  ): string[] {
    const args = ['exec'];
    if (options.sessionId) {
      args.push('resume');
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

    if (options.sessionId) {
      args.push(options.sessionId, '-');
    } else {
      args.push('-');
    }

    return args;
  }

  private composePromptStdin(systemPrompt: string, prompt: string): string {
    return ['System prompt:', systemPrompt, '', 'User prompt:', prompt, ''].join('\n');
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
      args: this.buildCodexArgs(resultFiles, {
        model,
        sessionId: input.sessionId,
        ephemeral: false,
      }),
      stdin: this.composePromptStdin(input.systemPrompt, input.prompt),
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
    const parsed = this.parseCodexResult(raw, resultFiles, {
      failOnSuccessfulInvalidJsonl: true,
      requireThreadId: true,
    });
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
      args: this.buildCodexArgs(resultFiles, {
        model,
        ephemeral: true,
      }),
      stdin: this.composePromptStdin(input.systemPrompt, input.prompt),
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
    options?: { failOnSuccessfulInvalidJsonl?: boolean; requireThreadId?: boolean },
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

    const validationError = this.buildValidationError(parsed, {
      requireThreadId: options?.requireThreadId ?? false,
    });
    if (raw.exitCode === 0 && !raw.timedOut && validationError) {
      if (options?.failOnSuccessfulInvalidJsonl) {
        throw new BackgroundAgentError(validationError);
      }

      return {
        output,
        stderr: this.appendStderr(raw.stderr, validationError),
        exitCode: 1,
        timedOut: raw.timedOut,
        usage: parsed.usage,
      };
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
    const result: CodexParsedOutput = {
      hasThreadStarted: false,
      hasTurnCompleted: false,
    };
    const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);

    for (const line of lines) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        result.hasThreadStarted = true;
        result.threadId = event.thread_id;
      } else if (event.type === 'thread.started') {
        result.hasThreadStarted = true;
      }

      if (event.type === 'turn.completed') {
        result.hasTurnCompleted = true;
        if (typeof event.usage === 'object' && event.usage !== null) {
          const usage = event.usage as { input_tokens?: unknown; output_tokens?: unknown };
          result.usage = {
            inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
            outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
          };
        }
      }
    }

    return result;
  }

  private buildValidationError(
    parsed: CodexParsedOutput,
    options: { requireThreadId: boolean },
  ): string | null {
    const missingEvents: string[] = [];
    if (!parsed.hasThreadStarted) {
      missingEvents.push('thread.started');
    }
    if (!parsed.hasTurnCompleted) {
      missingEvents.push('turn.completed');
    }
    if (options.requireThreadId && parsed.hasThreadStarted && typeof parsed.threadId !== 'string') {
      missingEvents.push('thread.started.thread_id (string)');
    }

    if (missingEvents.length === 0) {
      return null;
    }

    return `Codex CLI returned invalid JSONL output (expected ${missingEvents.join(' and ')}).`;
  }

  private appendStderr(stderr: string, message: string): string {
    const trimmed = stderr.trim();
    return trimmed.length > 0 ? `${trimmed}\n${message}` : message;
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
