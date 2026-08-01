import { chown, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexSandboxGenerateRequestSchema,
  type CodexSandboxGenerateRequest,
  type CodexSandboxGenerateResponse,
} from '../subagents/codex-sandbox-protocol.js';
import { CodexSandboxPolicyViolationError, runCodexAppServerTurn } from './app-server.js';

export interface CodexRunnerServiceConfig {
  authDir: string;
  command?: string;
  appServerUid?: number;
  appServerGid?: number;
}

export interface CodexRunnerServiceDeps {
  runTurn?: typeof runCodexAppServerTurn;
}

/**
 * Prepares one sterile Codex App Server home for each request. The persistent
 * auth store is copied in only for the lifetime of the process and is never
 * mounted into Talon or supplied through the runner's HTTP protocol.
 */
export class CodexRunnerService {
  private readonly runTurn: typeof runCodexAppServerTurn;

  constructor(
    private readonly config: CodexRunnerServiceConfig,
    deps: CodexRunnerServiceDeps = {},
  ) {
    this.runTurn = deps.runTurn ?? runCodexAppServerTurn;
  }

  async generate(
    rawRequest: unknown,
    abortSignal?: AbortSignal,
  ): Promise<CodexSandboxGenerateResponse> {
    const request = CodexSandboxGenerateRequestSchema.safeParse(rawRequest);
    if (!request.success) {
      return {
        ok: false,
        code: 'INVALID_REQUEST',
        error: request.error.issues.map((issue) => issue.message).join('; '),
      };
    }

    try {
      return await this.run(request.data, abortSignal);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        ok: false,
        code: cause instanceof CodexSandboxPolicyViolationError ? 'POLICY_VIOLATION' : 'CODEX_RUN_FAILED',
        error: message,
      };
    }
  }

  private async run(
    request: CodexSandboxGenerateRequest,
    abortSignal?: AbortSignal,
  ): Promise<CodexSandboxGenerateResponse> {
    const jobRoot = await mkdtemp(join(tmpdir(), 'talon-codex-runner-'));
    const home = join(jobRoot, 'home');
    const codexHome = join(home, '.codex');
    const workspace = join(jobRoot, 'workspace');
    const authSource = join(this.config.authDir, 'auth.json');
    const authDestination = join(codexHome, 'auth.json');
    const configPath = join(codexHome, 'config.toml');

    try {
      await Promise.all([mkdir(codexHome, { recursive: true, mode: 0o700 }), mkdir(workspace)]);
      await copyFile(authSource, authDestination);
      await writeFile(
        configPath,
        'web_search = "disabled"\napproval_policy = "never"\nsandbox_mode = "read-only"\n',
        { mode: 0o600 },
      );
      // Prevent ancestor AGENTS.md discovery even if the image changes its
      // temporary directory layout in the future.
      await writeFile(join(workspace, 'AGENTS.md'), '', { mode: 0o600 });
      await this.setAppServerOwnership([
        jobRoot,
        home,
        codexHome,
        workspace,
        authDestination,
        configPath,
      ]);

      const result = await this.runTurn({
        command: this.config.command ?? 'codex',
        cwd: workspace,
        env: appServerEnvironment({ home, codexHome, tempDir: jobRoot }),
        model: request.model,
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
        ...(abortSignal === undefined ? {} : { abortSignal }),
        ...(this.shouldDropPrivileges() ? { uid: this.config.appServerUid } : {}),
        ...(this.shouldDropPrivileges() ? { gid: this.config.appServerGid } : {}),
      });

      // Codex refreshes ChatGPT account state in-place. Persist only the auth
      // file after a successful App Server turn; temporary sessions and config
      // remain in the deleted job root.
      await copyFile(authDestination, authSource);
      return { ok: true, text: result.text, ...(result.usage === undefined ? {} : { usage: result.usage }) };
    } finally {
      await rm(jobRoot, { recursive: true, force: true });
    }
  }

  private async setAppServerOwnership(paths: readonly string[]): Promise<void> {
    if (!this.shouldDropPrivileges()) return;
    await Promise.all(paths.map((path) => chown(path, this.config.appServerUid!, this.config.appServerGid!)));
  }

  private shouldDropPrivileges(): boolean {
    return (
      process.getuid?.() === 0 &&
      this.config.appServerUid !== undefined &&
      this.config.appServerGid !== undefined
    );
  }
}

function appServerEnvironment(input: {
  home: string;
  codexHome: string;
  tempDir: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: input.home,
    CODEX_HOME: input.codexHome,
    TMPDIR: input.tempDir,
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  };

  for (const key of ['LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  return env;
}
