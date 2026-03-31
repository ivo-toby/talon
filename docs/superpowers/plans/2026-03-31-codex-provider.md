# Codex Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `codex-cli` provider for both foreground and background execution, with resumable foreground sessions, isolated provider-owned Codex homes, Codex-native MCP config, and Codex-aware testing/docs.

**Architecture:** Keep Codex inside the existing provider abstraction. The only core plumbing changes are: foreground session handling must depend on `supportsSessionResumption` instead of `strategy.type === 'sdk'`, and background provider parsing must be allowed to read provider-created result files so Codex can use `--output-last-message`. `CodexCliProvider` itself will own HOME isolation, config generation, MCP TOML rendering, and JSONL parsing.

**Tech Stack:** TypeScript, Node.js `child_process`/`fs`/`os`/`path`, neverthrow, vitest, Commander.js, Markdown docs

**Spec:** `docs/superpowers/specs/2026-03-31-codex-provider-design.md`

---

## File Structure

- `src/providers/provider.ts`
  - Extend the foreground provider contract so CLI strategies may be resumable.
  - Add `threadId` to `AgentRunInput`.
  - Let background result parsing accept provider-created result-file metadata.
- `src/providers/provider-types.ts`
  - Extend `PreparedProviderInvocation` with provider-owned result files such as `lastMessagePath`.
- `src/providers/codex-cli-provider.ts`
  - New provider adapter.
  - Owns stable foreground HOME paths, temporary background HOME paths, auth seeding, config TOML generation, Codex CLI arg construction, JSONL parsing, and output extraction.
- `src/providers/index.ts`
  - Export the new provider.
- `src/daemon/agent-runner.ts`
  - Restore/persist sessions for any strategy with `supportsSessionResumption: true`.
  - Pass `threadId` into provider runs.
  - Skip previous-context stuffing for resumed Codex turns just like resumed Claude SDK turns.
- `src/subagents/background/background-agent-manager.ts`
  - Preserve provider-created result-file metadata and pass it back into `parseBackgroundResult()` before cleanup.
- `src/daemon/daemon-bootstrap.ts`
  - Register `codex-cli` and inject `dataDir` into its constructor.
- `src/cli/commands/test-provider.ts`
  - Add Codex-specific smoke testing with isolated HOME, `-o/--output-last-message`, and JSONL parsing.
- `tests/unit/providers/codex-cli-provider.test.ts`
  - New focused provider tests for foreground, background, MCP translation, and parse behavior.
- `tests/unit/daemon/agent-runner.test.ts`
  - Add resumable CLI provider coverage.
- `tests/unit/subagents/background/background-agent-manager.test.ts`
  - Cover result-file metadata forwarding.
- `tests/unit/daemon/daemon-bootstrap.test.ts`
  - Verify `codex-cli` registration.
- `tests/unit/cli/test-provider.test.ts`
  - New tests for the Codex smoke branch of `talonctl test-provider`.
- `README.md`
  - Update provider list, examples, and background-agent wording.
- `CLAUDE.md`
  - Update architecture guidance to mention Codex as a supported provider.
- `docs/setup-guide.md`
  - Add Codex install/auth/verify flow and config examples.
- `docs/getting-started/configuration.mdx`
  - Add Codex provider examples to foreground/background config.
- `docs/reference/talonctl.mdx`
  - Add Codex examples to `add-provider`, `set-default-provider`, and `test-provider`.
- `docs/reference/config-schema.mdx`
  - Update config examples that currently only show Claude/Gemini shapes.
- `config/talond.example.yaml`
  - Add commented or disabled `codex-cli` examples beside existing providers.

---

### Task 1: Generalize Provider Contracts For Resumable CLI Runs

This task handles the two core interface changes that Codex needs before the provider file can exist:

- foreground CLI strategies may resume sessions
- background providers may need result-file metadata when parsing completion output

**Files:**
- Modify: `src/providers/provider.ts`
- Modify: `src/providers/provider-types.ts`
- Modify: `src/daemon/agent-runner.ts`
- Modify: `src/subagents/background/background-agent-manager.ts`
- Test: `tests/unit/daemon/agent-runner.test.ts`
- Test: `tests/unit/subagents/background/background-agent-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests to `tests/unit/daemon/agent-runner.test.ts` inside the provider/session coverage section:

```typescript
it('restores sessions for resumable CLI providers and skips previous-context stuffing on resumed turns', async () => {
  const cliRun = vi.fn().mockResolvedValue({
    output: 'Codex resumed result',
    sessionId: 'codex-thread-002',
    usage: {
      inputTokens: 42_000,
      outputTokens: 120,
    },
    isError: false,
  });

  vi.mocked(ctx.sessionTracker.getSessionId).mockReturnValue(undefined);
  vi.mocked(ctx.repos.run.getLatestSessionId).mockReturnValue(ok('codex-thread-001'));
  vi.mocked(ctx.personaLoader.getByName).mockReturnValue(ok({
    config: {
      model: 'gpt-5.4',
      provider: 'codex-cli',
      skills: [],
      capabilities: { allow: [] },
    },
    systemPromptContent: 'You are a Codex test bot.',
    resolvedCapabilities: {
      allow: ['channel.send:*', 'memory.access', 'schedule.manage'],
      requireApproval: [],
    },
  } as any));

  ctx.providerRegistry = {
    get: vi.fn().mockReturnValue(undefined),
    getDefault: vi.fn().mockReturnValue({
      provider: {
        name: 'codex-cli',
        createExecutionStrategy: () => ({
          type: 'cli' as const,
          supportsSessionResumption: true as const,
          run: cliRun,
        }),
        prepareBackgroundInvocation: vi.fn(),
        parseBackgroundResult: vi.fn(),
        estimateContextUsage: vi.fn().mockReturnValue({
          inputTokens: 42_000,
          metrics: {
            input_tokens: 42_000,
          },
        }),
      },
      config: makeAgentRunnerProviderConfig({
        command: 'codex',
        contextWindowTokens: 400_000,
        contextManagement: makeContextManagement({
          triggerMetric: 'input_tokens',
          thresholdRatio: 0.8,
        }),
      }),
    }),
  } as any;

  const result = await runner.run(makeQueueItem());

  expect(result.isOk()).toBe(true);
  expect(ctx.repos.run.getLatestSessionId).toHaveBeenCalledWith('thread-001');
  expect(cliRun).toHaveBeenCalledWith(expect.objectContaining({
    threadId: 'thread-001',
    sessionId: 'codex-thread-001',
  }));
  expect(ctx.observability.observe).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: 'retriever', name: 'previous-context' }),
    expect.any(Function),
  );
});

it('persists returned session ids from resumable CLI providers', async () => {
  const cliRun = vi.fn().mockResolvedValue({
    output: 'Codex result',
    sessionId: 'codex-thread-003',
    usage: {
      inputTokens: 10,
      outputTokens: 3,
    },
    isError: false,
  });

  vi.mocked(ctx.personaLoader.getByName).mockReturnValue(ok({
    config: {
      model: 'gpt-5.4',
      provider: 'codex-cli',
      skills: [],
      capabilities: { allow: [] },
    },
    systemPromptContent: 'You are a Codex test bot.',
    resolvedCapabilities: {
      allow: ['channel.send:*', 'memory.access', 'schedule.manage'],
      requireApproval: [],
    },
  } as any));

  ctx.providerRegistry = {
    get: vi.fn().mockReturnValue(undefined),
    getDefault: vi.fn().mockReturnValue({
      provider: {
        name: 'codex-cli',
        createExecutionStrategy: () => ({
          type: 'cli' as const,
          supportsSessionResumption: true as const,
          run: cliRun,
        }),
        prepareBackgroundInvocation: vi.fn(),
        parseBackgroundResult: vi.fn(),
        estimateContextUsage: vi.fn().mockReturnValue({
          inputTokens: 10,
          metrics: {
            input_tokens: 10,
          },
        }),
      },
      config: makeAgentRunnerProviderConfig({
        command: 'codex',
        contextWindowTokens: 400_000,
        contextManagement: makeContextManagement({
          triggerMetric: 'input_tokens',
          thresholdRatio: 0.8,
        }),
      }),
    }),
  } as any;

  const result = await runner.run(makeQueueItem());

  expect(result.isOk()).toBe(true);
  expect(ctx.sessionTracker.setSessionId).toHaveBeenCalledWith('thread-001', 'codex-thread-003');
  expect(ctx.repos.run.updateSessionId).toHaveBeenCalledWith(expect.any(String), 'codex-thread-003');
});
```

Add this test to `tests/unit/subagents/background/background-agent-manager.test.ts` near the completion/parsing coverage:

```typescript
it('passes provider resultFiles back into parseBackgroundResult before cleanup', async () => {
  prepareBackgroundInvocation.mockReturnValueOnce(ok({
    command: 'codex',
    args: ['exec', '--json'],
    stdin: '',
    cwd: '/workspace/repo',
    timeoutMs: 30 * 60 * 1000,
    cleanupPaths: ['/tmp/talon-bg-test'],
    resultFiles: {
      lastMessagePath: '/tmp/talon-bg-test/last-message.txt',
    },
  }));

  const manager = createManager();
  const taskId = (await manager.spawn(spawnInput))._unsafeUnwrap();

  completionResolve?.(ok({
    stdout: '{"type":"thread.started","thread_id":"codex-thread-1"}',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(repository.findById(taskId)._unsafeUnwrap()?.status).toBe('completed');
  expect(parseBackgroundResult).toHaveBeenCalledWith(
    {
      stdout: '{"type":"thread.started","thread_id":"codex-thread-1"}',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    },
    {
      lastMessagePath: '/tmp/talon-bg-test/last-message.txt',
    },
  );
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```bash
npx vitest run tests/unit/daemon/agent-runner.test.ts tests/unit/subagents/background/background-agent-manager.test.ts -t "resumable CLI providers|resultFiles"
```

Expected:

- `agent-runner` assertions fail because CLI providers do not currently restore sessions or receive `threadId`
- `background-agent-manager` assertions fail because `parseBackgroundResult()` currently receives only the raw stdio object

- [ ] **Step 3: Extend provider contracts**

Update `src/providers/provider-types.ts`:

```typescript
export interface PreparedProviderResultFiles {
  lastMessagePath?: string;
}

export interface PreparedProviderInvocation {
  command: string;
  args: string[];
  stdin: string;
  env?: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  cleanupPaths: string[];
  resultFiles?: PreparedProviderResultFiles;
}
```

Update `src/providers/provider.ts`:

```typescript
import type {
  AgentUsage,
  CanonicalMcpServer,
  ContextUsage,
  PreparedProviderInvocation,
  PreparedProviderResultFiles,
  ProviderName,
  ProviderResult,
  ProviderSpawnInput,
} from './provider-types.js';

export interface AgentRunInput {
  threadId: string;
  prompt: string;
  systemPrompt: string;
  mcpServers: Record<string, CanonicalMcpServer>;
  cwd: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  sessionId?: string;
}

export interface ResumableCLIExecutionStrategy {
  readonly type: 'cli';
  readonly supportsSessionResumption: true;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export interface StatelessCLIExecutionStrategy {
  readonly type: 'cli';
  readonly supportsSessionResumption: false;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export type CLIExecutionStrategy =
  | ResumableCLIExecutionStrategy
  | StatelessCLIExecutionStrategy;

export type ExecutionStrategy = SDKExecutionStrategy | CLIExecutionStrategy;

export interface AgentProvider {
  readonly name: ProviderName;
  createExecutionStrategy(): ExecutionStrategy;
  prepareBackgroundInvocation(input: ProviderSpawnInput): Result<PreparedProviderInvocation, BackgroundAgentError>;
  parseBackgroundResult(
    raw: {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
    },
    resultFiles?: PreparedProviderResultFiles,
  ): ProviderResult;
  estimateContextUsage(usage: AgentUsage): ContextUsage;
}
```

- [ ] **Step 4: Update `AgentRunner` to use `supportsSessionResumption` instead of `strategy.type === 'sdk'`**

In `src/daemon/agent-runner.ts`, replace the session-restore and query-input branching with:

```typescript
const strategy = providerEntry.provider.createExecutionStrategy();
const canResumeSession = strategy.supportsSessionResumption && !isA2ATask;

let resolvedSessionId: string | undefined;
if (canResumeSession) {
  resolvedSessionId = this.ctx.sessionTracker.getSessionId(item.threadId);
  if (!resolvedSessionId && !this.ctx.sessionTracker.wasRotated(item.threadId)) {
    const dbSessionResult = this.ctx.repos.run.getLatestSessionId(item.threadId);
    if (dbSessionResult.isOk() && dbSessionResult.value) {
      resolvedSessionId = dbSessionResult.value;
      this.ctx.logger.info(
        { threadId: item.threadId, sessionId: resolvedSessionId },
        'agent-runner: restored session from DB after restart',
      );
    }
  }
}
```

Replace the previous-context suppression and query input with:

```typescript
const existingSessionId = strategy.supportsSessionResumption ? resolvedSessionId : undefined;

if (!resumeSessionId) {
  const previous = await getPreviousContext();
  if (previous.text) {
    systemPromptParts.push(previous.text);
  }
}

const queryInput = {
  threadId: item.threadId,
  prompt: content,
  systemPrompt,
  mcpServers,
  cwd: workspaceResult.value,
  model,
  maxTurns: 25,
  timeoutMs: queryTimeoutMs,
  ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
};
```

Leave the fresh-session retry logic SDK-only:

```typescript
if (strategy.type === 'sdk' && this.shouldRetryFreshSession(cause)) {
  this.ctx.sessionTracker.rotateSession(item.threadId);
  // existing retry path
}
```

- [ ] **Step 5: Forward `resultFiles` through `BackgroundAgentManager`**

In `src/subagents/background/background-agent-manager.ts`, extend the managed-process state and parse call:

```typescript
import type { PreparedProviderResultFiles } from '../../providers/provider-types.js';

interface ManagedProcess {
  kill: () => void;
  cleanupPaths: string[];
  provider: AgentProvider;
  resultFiles?: PreparedProviderResultFiles;
  observation?: StartedObservationHandle;
}
```

When storing the process:

```typescript
this.processes.set(taskId, {
  kill: () => processInstance.kill(),
  cleanupPaths,
  provider: providerEntry.provider,
  resultFiles: invocation.resultFiles,
  observation,
});
```

And when parsing completion:

```typescript
const parsedResult = managedProcess
  ? managedProcess.provider.parseBackgroundResult(
      {
        stdout: processResult.stdout,
        stderr: processResult.stderr,
        exitCode: processResult.exitCode,
        timedOut: processResult.timedOut,
      },
      managedProcess.resultFiles,
    )
  : {
      output: processResult.stdout,
      stderr: processResult.stderr,
      exitCode: processResult.exitCode,
      timedOut: processResult.timedOut,
    };
```

- [ ] **Step 6: Run the updated tests**

Run:

```bash
npx vitest run tests/unit/daemon/agent-runner.test.ts tests/unit/subagents/background/background-agent-manager.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/providers/provider.ts src/providers/provider-types.ts src/daemon/agent-runner.ts src/subagents/background/background-agent-manager.ts tests/unit/daemon/agent-runner.test.ts tests/unit/subagents/background/background-agent-manager.test.ts
git commit -m "refactor(providers): support resumable CLI sessions"
```

---

### Task 2: Implement `CodexCliProvider`

This is the provider-native work: isolated HOME handling, auth seeding, config TOML generation, MCP translation, foreground resume, background ephemeral runs, and JSONL parsing.

**Files:**
- Create: `src/providers/codex-cli-provider.ts`
- Test: `tests/unit/providers/codex-cli-provider.test.ts`

- [ ] **Step 1: Write the failing provider tests**

Create `tests/unit/providers/codex-cli-provider.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { CodexCliProvider } from '../../../src/providers/codex-cli-provider.js';

describe('CodexCliProvider', () => {
  let runtimeDir: string;
  let operatorHome: string;

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'talon-codex-runtime-'));
    operatorHome = mkdtempSync(join(tmpdir(), 'talon-codex-operator-'));
    mkdirSync(join(operatorHome, '.codex'), { recursive: true });
    writeFileSync(join(operatorHome, '.codex', 'auth.json'), '{"access_token":"test"}');
  });

  afterEach(() => {
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(operatorHome, { recursive: true, force: true });
  });

  function makeProvider() {
    return new CodexCliProvider(
      {
        enabled: true,
        command: 'codex',
        contextWindowTokens: 400_000,
        options: {
          defaultModel: 'gpt-5.4',
        },
      },
      {
        dataDir: runtimeDir,
        operatorHome,
      },
    );
  }

  it('creates a resumable CLI strategy and resumes by thread id', async () => {
    const provider = makeProvider();
    let invocation: any;

    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'executeInvocation')
      .mockImplementation(async (prepared) => {
        invocation = prepared;
        writeFileSync(prepared.resultFiles.lastMessagePath, 'resumed');
        return {
          stdout: [
            '{"type":"thread.started","thread_id":"codex-thread-001"}',
            '{"type":"turn.completed","usage":{"input_tokens":144,"output_tokens":9}}',
          ].join('\\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      });

    try {
      const strategy = provider.createExecutionStrategy();
      const result = await strategy.run({
        threadId: 'thread-001',
        prompt: 'Continue',
        systemPrompt: 'You are helpful.',
        mcpServers: {},
        cwd: '/workspace/repo',
        model: 'gpt-5.4',
        maxTurns: 25,
        timeoutMs: 60_000,
        sessionId: 'codex-thread-001',
      });

      expect(strategy.type).toBe('cli');
      expect(strategy.supportsSessionResumption).toBe(true);
      expect(invocation.args.slice(0, 4)).toEqual(['exec', 'resume', 'codex-thread-001', 'Continue']);
      expect(invocation.env.HOME).toContain('/providers/codex-cli/threads/thread-001/home');
      expect(result).toEqual({
        output: 'resumed',
        sessionId: 'codex-thread-001',
        usage: {
          inputTokens: 144,
          outputTokens: 9,
        },
        isError: false,
      });
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('prepares background invocations with isolated HOME, generated config, and resultFiles metadata', () => {
    const provider = makeProvider();

    const result = provider.prepareBackgroundInvocation({
      prompt: 'Refactor the auth module.',
      systemPrompt: 'You are helpful.',
      mcpServers: {
        hostTools: {
          transport: 'stdio',
          command: 'node',
          args: ['dist/tools/host-tools-mcp-server.js'],
          env: { TALOND_SOCKET: '/tmp/talond.sock' },
        },
        remoteBrowser: {
          transport: 'http',
          url: 'https://mcp.example.test',
          headers: { Authorization: 'Bearer secret-token' },
        },
      },
      cwd: '/workspace/repo',
      timeoutMs: 60_000,
      model: 'gpt-5.4',
    });

    expect(result.isOk()).toBe(true);
    const invocation = result._unsafeUnwrap();
    expect(invocation.args).toContain('--ephemeral');
    expect(invocation.args).toContain('--json');
    expect(invocation.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(invocation.resultFiles?.lastMessagePath).toBeDefined();
    expect(invocation.env?.HOME).toBeDefined();

    const configPath = join(invocation.env!.HOME, '.codex', 'config.toml');
    expect(existsSync(configPath)).toBe(true);
    const configToml = readFileSync(configPath, 'utf8');
    expect(configToml).toContain('model = "gpt-5.4"');
    expect(configToml).toContain('[projects."/workspace/repo"]');
    expect(configToml).toContain('trust_level = "trusted"');
    expect(configToml).toContain('[mcp_servers.hostTools]');
    expect(configToml).toContain('command = "node"');
    expect(configToml).toContain('bearer_token_env_var = "TALON_CODEX_MCP_REMOTEBROWSER_TOKEN"');
  });

  it('rejects MCP servers with custom non-bearer headers', () => {
    const provider = makeProvider();

    const result = provider.prepareBackgroundInvocation({
      prompt: 'Refactor.',
      systemPrompt: 'You are helpful.',
      mcpServers: {
        remoteBrowser: {
          transport: 'http',
          url: 'https://mcp.example.test',
          headers: { 'X-Token': 'abc123' },
        },
      },
      cwd: '/workspace/repo',
      timeoutMs: 30_000,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('custom headers');
  });

  it('reads final output from lastMessagePath and usage from JSONL', () => {
    const provider = makeProvider();
    const lastMessagePath = join(runtimeDir, 'last-message.txt');
    writeFileSync(lastMessagePath, 'isolated');

    const result = provider.parseBackgroundResult(
      {
        stdout: [
          '{"type":"thread.started","thread_id":"codex-thread-009"}',
          '{"type":"turn.completed","usage":{"input_tokens":14813,"output_tokens":16}}',
        ].join('\\n'),
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
      { lastMessagePath },
    );

    expect(result).toEqual({
      output: 'isolated',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      usage: {
        inputTokens: 14813,
        outputTokens: 16,
      },
    });
  });
});
```

- [ ] **Step 2: Run the provider tests to verify they fail**

Run:

```bash
npx vitest run tests/unit/providers/codex-cli-provider.test.ts
```

Expected:

- FAIL because `src/providers/codex-cli-provider.ts` does not exist yet

- [ ] **Step 3: Create the provider scaffold**

Create `src/providers/codex-cli-provider.ts` with the core types and constructor:

```typescript
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from 'neverthrow';
import { BackgroundAgentError } from '../core/errors/error-types.js';
import type { ProviderConfig } from '../core/config/config-types.js';
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
      inputTokens: usage.inputTokens,
      metrics: {
        input_tokens: usage.inputTokens,
      },
    };
  }
}
```

- [ ] **Step 4: Implement HOME isolation, config generation, and invocation builders**

Add these helpers to `src/providers/codex-cli-provider.ts`:

```typescript
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
): Result<{ configPath: string }, BackgroundAgentError> {
  try {
    const codexDir = join(homeDir, '.codex');
    mkdirSync(codexDir, { recursive: true, mode: 0o700 });

    const sourceAuthPath = join(this.operatorCodexDir(), 'auth.json');
    const authJson = readFileSync(sourceAuthPath, 'utf8');
    writeFileSync(join(codexDir, 'auth.json'), authJson, { mode: 0o600 });

    const configPath = join(codexDir, 'config.toml');
    writeFileSync(
      configPath,
      this.renderConfigToml({ cwd, model, mcpServers }),
      { encoding: 'utf8', mode: 0o600 },
    );

    return ok({ configPath });
  } catch (cause) {
    return err(new BackgroundAgentError(
      `Codex CLI: failed to seed provider home: ${String(cause)}`,
      cause instanceof Error ? cause : undefined,
    ));
  }
}

private renderConfigToml(input: {
  cwd: string;
  model?: string;
  mcpServers: Record<string, CanonicalMcpServer>;
}): string {
  const lines: string[] = [];
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

    if (server.transport === 'stdio') {
      lines.push(`[mcp_servers.${name}]`);
      lines.push(`command = ${JSON.stringify(server.command)}`);
      lines.push(`args = [${server.args.map((arg) => JSON.stringify(arg)).join(', ')}]`);
      lines.push('');
      if (server.env && Object.keys(server.env).length > 0) {
        lines.push(`[mcp_servers.${name}.env]`);
        for (const [key, value] of Object.entries(server.env)) {
          lines.push(`${key} = ${JSON.stringify(value)}`);
        }
        lines.push('');
      }
      continue;
    }

    lines.push(`[mcp_servers.${name}]`);
    lines.push(`url = ${JSON.stringify(server.url)}`);

    const headers = server.headers ?? {};
    const headerEntries = Object.entries(headers);
    if (headerEntries.length === 1 && headerEntries[0][0].toLowerCase() === 'authorization') {
      const match = /^Bearer\\s+(.+)$/u.exec(String(headerEntries[0][1]));
      if (!match) {
        throw new Error(`Codex CLI only supports bearer Authorization headers for remote MCP server "${name}"`);
      }
      lines.push(`bearer_token_env_var = ${JSON.stringify(`TALON_CODEX_MCP_${name.replace(/[^a-z0-9]/giu, '').toUpperCase()}_TOKEN`)}`);
      lines.push('');
      continue;
    }

    if (headerEntries.length > 0) {
      throw new Error(`Codex CLI cannot represent custom headers for remote MCP server "${name}"`);
    }

    lines.push('');
  }

  return `${lines.join('\\n').trim()}\\n`;
}

private buildCodexArgs(
  prompt: string,
  resultFiles: PreparedProviderResultFiles,
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
    resultFiles.lastMessagePath!,
  );

  if (options.ephemeral) {
    args.push('--ephemeral');
  }

  if (options.model) {
    args.push('--model', options.model);
  }

  return args;
}
```

- [ ] **Step 5: Implement foreground run, background prep, and Codex parsing**

Complete `src/providers/codex-cli-provider.ts` with the actual run/prep/parse logic:

```typescript
private async runForeground(input: AgentRunInput) {
  const homeDir = this.buildForegroundHome(input.threadId);
  const resultFiles = {
    lastMessagePath: join(homeDir, 'last-message.txt'),
  };

  const seedResult = this.seedCodexHome(homeDir, input.cwd, input.mcpServers, input.model ?? this.readDefaultModel());
  if (seedResult.isErr()) {
    throw seedResult.error;
  }

  const invocation: PreparedProviderInvocation = {
    command: this.config.command,
    args: this.buildCodexArgs(input.prompt, resultFiles, {
      model: input.model ?? this.readDefaultModel(),
      sessionId: input.sessionId,
      ephemeral: false,
    }),
    stdin: '',
    env: {
      HOME: homeDir,
    },
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    cleanupPaths: [],
    resultFiles,
  };

  const raw = await this.executeInvocation(invocation);
  const parsed = this.parseCodexResult(raw, resultFiles);
  return {
    output: parsed.output,
    sessionId: this.parseCodexJsonl(raw.stdout).threadId,
    usage: parsed.usage ?? { inputTokens: 0, outputTokens: 0 },
    isError: parsed.exitCode !== 0 || parsed.timedOut,
  };
}

private prepareBackgroundCodexInvocation(
  input: ProviderSpawnInput,
): Result<PreparedProviderInvocation, BackgroundAgentError> {
  const homeDir = this.buildBackgroundHome();
  const resultFiles = {
    lastMessagePath: join(homeDir, 'last-message.txt'),
  };

  const seedResult = this.seedCodexHome(homeDir, input.cwd, input.mcpServers, input.model ?? this.readDefaultModel());
  if (seedResult.isErr()) {
    rmSync(homeDir, { recursive: true, force: true });
    return seedResult;
  }

  return ok({
    command: this.config.command,
    args: this.buildCodexArgs(input.prompt, resultFiles, {
      model: input.model ?? this.readDefaultModel(),
      ephemeral: true,
    }),
    stdin: '',
    env: {
      HOME: homeDir,
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
  const output = resultFiles?.lastMessagePath
    ? readFileSync(resultFiles.lastMessagePath, 'utf8')
    : raw.stdout;

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

  for (const line of stdout.split('\\n').filter(Boolean)) {
    const event = JSON.parse(line) as Record<string, any>;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      result.threadId = event.thread_id;
    }
    if (event.type === 'turn.completed' && event.usage) {
      result.usage = {
        inputTokens: event.usage.input_tokens ?? 0,
        outputTokens: event.usage.output_tokens ?? 0,
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
      reject(new BackgroundAgentError(`Codex CLI: failed to run provider process: ${cause.message}`, cause));
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
```

- [ ] **Step 6: Run the provider tests**

Run:

```bash
npx vitest run tests/unit/providers/codex-cli-provider.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/providers/codex-cli-provider.ts tests/unit/providers/codex-cli-provider.test.ts
git commit -m "feat(providers): add codex CLI provider"
```

---

### Task 3: Register `codex-cli` In Bootstrap And Provider Exports

This task wires the new provider into the daemon without changing provider resolution semantics.

**Files:**
- Modify: `src/providers/index.ts`
- Modify: `src/daemon/daemon-bootstrap.ts`
- Test: `tests/unit/daemon/daemon-bootstrap.test.ts`

- [ ] **Step 1: Write the failing bootstrap test**

Add this test to `tests/unit/daemon/daemon-bootstrap.test.ts` near the Gemini registration test:

```typescript
it('registers codex-cli when enabled in provider config', async () => {
  setupSuccessfulMocks();
  vi.mocked(loadConfig).mockReturnValue(
    ok(
      makeConfig({
        agentRunner: {
          defaultProvider: 'codex-cli',
          providers: {
            'claude-code': {
              ...makeAgentRunnerProviderConfig(),
            },
            'codex-cli': {
              ...makeAgentRunnerProviderConfig({
                command: 'codex',
                contextWindowTokens: 400000,
                contextManagement: makeContextManagementConfig({
                  triggerMetric: 'input_tokens',
                  thresholdRatio: 0.8,
                }),
              }),
              options: {
                defaultModel: 'gpt-5.4',
              },
            },
          },
        },
        backgroundAgent: {
          enabled: true,
          maxConcurrent: 3,
          defaultTimeoutMinutes: 30,
          defaultProvider: 'codex-cli',
          providers: {
            'claude-code': {
              ...makeBackgroundProviderConfig(),
            },
            'codex-cli': {
              ...makeBackgroundProviderConfig({
                command: 'codex',
                contextWindowTokens: 400000,
              }),
              options: {
                defaultModel: 'gpt-5.4',
              },
            },
          },
        },
      }) as any,
    ),
  );

  const result = await bootstrap('/config.yaml', logger);

  expect(result.isOk()).toBe(true);
  const ctx = result._unsafeUnwrap();
  expect(ctx.providerRegistry.get('codex-cli')?.provider.name).toBe('codex-cli');
  expect(ctx.providerRegistry.getDefault(['codex-cli'])?.provider.name).toBe('codex-cli');
  expect(BackgroundAgentManager).toHaveBeenCalledWith(
    expect.objectContaining({
      defaultProvider: 'codex-cli',
    }),
  );
});
```

- [ ] **Step 2: Run the bootstrap test to verify it fails**

Run:

```bash
npx vitest run tests/unit/daemon/daemon-bootstrap.test.ts -t "registers codex-cli"
```

Expected: FAIL because `codex-cli` is not imported or registered

- [ ] **Step 3: Register the provider**

Update `src/providers/index.ts`:

```typescript
export * from './provider-types.js';
export * from './provider.js';
export * from './provider-registry.js';
export * from './claude-code-provider.js';
export * from './gemini-cli-provider.js';
export * from './codex-cli-provider.js';
```

Update `src/daemon/daemon-bootstrap.ts` imports and factory map:

```typescript
import { ClaudeCodeProvider } from '../providers/claude-code-provider.js';
import { GeminiCliProvider } from '../providers/gemini-cli-provider.js';
import { CodexCliProvider } from '../providers/codex-cli-provider.js';
import { ProviderRegistry, type ProviderFactoryMap } from '../providers/provider-registry.js';
```

```typescript
const providerFactories: ProviderFactoryMap = {
  'claude-code': (providerConfig) => new ClaudeCodeProvider(providerConfig),
  'gemini-cli': (providerConfig) => new GeminiCliProvider(providerConfig),
  'codex-cli': (providerConfig) => new CodexCliProvider(providerConfig, { dataDir }),
};
```

- [ ] **Step 4: Run the bootstrap test again**

Run:

```bash
npx vitest run tests/unit/daemon/daemon-bootstrap.test.ts -t "registers codex-cli"
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/providers/index.ts src/daemon/daemon-bootstrap.ts tests/unit/daemon/daemon-bootstrap.test.ts
git commit -m "feat(bootstrap): register codex CLI provider"
```

---

### Task 4: Extend `talonctl test-provider` For Codex

`talonctl test-provider` currently has Claude/Gemini assumptions. This task adds a real Codex smoke branch that matches the provider behavior closely enough to be useful.

**Files:**
- Modify: `src/cli/commands/test-provider.ts`
- Create: `tests/unit/cli/test-provider.test.ts`

- [ ] **Step 1: Write the failing CLI tests**

Create `tests/unit/cli/test-provider.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { testProvider } from '../../../src/cli/commands/test-provider.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-test-provider-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function writeExecutable(name: string, body: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function writeConfig(command: string): string {
  const path = join(tmpDir, 'talond.yaml');
  writeFileSync(
    path,
    `
agentRunner:
  defaultProvider: codex-cli
  providers:
    codex-cli:
      enabled: true
      command: ${JSON.stringify(command)}
      contextWindowTokens: 400000
`,
  );
  return path;
}

describe('testProvider() - codex-cli', () => {
  it('validates Codex via JSONL plus output-last-message', async () => {
    const fakeCodex = writeExecutable(
      'codex',
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "--version" ]]; then
  echo "codex 0.117.0"
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  OUTPUT_FILE=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -o|--output-last-message)
        OUTPUT_FILE="$2"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  printf 'codex-ok' > "$OUTPUT_FILE"
  printf '{"type":"thread.started","thread_id":"codex-thread-123"}\\n'
  printf '{"type":"turn.completed","usage":{"input_tokens":21,"output_tokens":8}}\\n'
  exit 0
fi
echo "unexpected args: $*" >&2
exit 1
`,
    );
    const configPath = writeConfig(fakeCodex);

    const result = await testProvider({
      name: 'codex-cli',
      configPath,
    });

    expect(result).toEqual({
      binaryFound: true,
      version: '0.117.0',
      response: 'codex-ok',
      jsonValid: true,
      inputTokens: 21,
      outputTokens: 8,
      error: null,
    });
  });

  it('reports a Codex compatibility error when thread.started is missing', async () => {
    const fakeCodex = writeExecutable(
      'codex',
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "--version" ]]; then
  echo "codex 0.117.0"
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  OUTPUT_FILE=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -o|--output-last-message)
        OUTPUT_FILE="$2"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  printf 'codex-ok' > "$OUTPUT_FILE"
  printf '{"type":"turn.completed","usage":{"input_tokens":21,"output_tokens":8}}\\n'
  exit 0
fi
exit 1
`,
    );
    const configPath = writeConfig(fakeCodex);

    const result = await testProvider({
      name: 'codex-cli',
      configPath,
    });

    expect(result.binaryFound).toBe(true);
    expect(result.jsonValid).toBe(false);
    expect(result.error).toMatch(/thread.started/i);
  });
});
```

- [ ] **Step 2: Run the new CLI tests to verify they fail**

Run:

```bash
npx vitest run tests/unit/cli/test-provider.test.ts
```

Expected: FAIL because `testProvider()` does not yet have a Codex branch or `-o/--output-last-message` handling

- [ ] **Step 3: Implement the Codex smoke branch**

In `src/cli/commands/test-provider.ts`, first replace `runProcess()` with an env-aware process helper:

```typescript
interface ProcessOutput {
  stdout: string;
  stderr: string;
}

function runProcess(
  command: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Process timed out after ${SPAWN_TIMEOUT_MS}ms`));
    }, SPAWN_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Process exited with code ${code}. stderr: ${stderr.trim()}`));
      } else {
        resolve({ stdout, stderr });
      }
    });

    if (options.input !== undefined && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}
```

Add Codex JSONL parsing plus the Codex branch:

```typescript
import fs from 'node:fs/promises';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function parseCodexJsonl(raw: string): { threadId: string | null; inputTokens: number | null; outputTokens: number | null } | null {
  let threadId: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  for (const line of raw.split('\n').filter(Boolean)) {
    const event = JSON.parse(line) as Record<string, any>;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      threadId = event.thread_id;
    }
    if (event.type === 'turn.completed' && event.usage) {
      inputTokens = typeof event.usage.input_tokens === 'number' ? event.usage.input_tokens : null;
      outputTokens = typeof event.usage.output_tokens === 'number' ? event.usage.output_tokens : null;
    }
  }

  return threadId ? { threadId, inputTokens, outputTokens } : null;
}
```

```typescript
const versionOutput = await runProcess(command, ['--version']);
result.binaryFound = true;
result.version = extractVersion(versionOutput.stdout);

const prompt = 'Say hello in one word';
const isGemini = options.name.includes('gemini') || command.includes('gemini');
const isCodex = options.name.includes('codex') || command.includes('codex');

if (isCodex) {
  const tempHome = mkdtempSync(join(tmpdir(), 'talon-test-provider-codex-'));
  const tempCodexDir = join(tempHome, '.codex');
  await fs.mkdir(tempCodexDir, { recursive: true });
  const sourceAuthPath = join(process.env.HOME ?? '', '.codex', 'auth.json');
  const targetAuthPath = join(tempCodexDir, 'auth.json');
  await fs.copyFile(sourceAuthPath, targetAuthPath);
  writeFileSync(join(tempCodexDir, 'config.toml'), 'model = "gpt-5.4"\\n');

  const outputLastMessage = join(tempHome, 'last-message.txt');
  const testOutput = await runProcess(
    command,
    [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      tempHome,
      '-o',
      outputLastMessage,
      prompt,
    ],
    {
      env: {
        HOME: tempHome,
      },
    },
  );

  const parsed = parseCodexJsonl(testOutput.stdout);
  if (!parsed) {
    result.response = readFileSync(outputLastMessage, 'utf8').trim() || null;
    result.jsonValid = false;
    result.error = 'Codex CLI did not emit a valid thread.started event in JSONL output.';
    return result;
  }

  result.response = readFileSync(outputLastMessage, 'utf8').trim() || null;
  result.jsonValid = result.response !== null;
  result.inputTokens = parsed.inputTokens;
  result.outputTokens = parsed.outputTokens;
  return result;
}
```

Keep the existing Claude/Gemini logic after the Codex branch.

- [ ] **Step 4: Run the CLI tests**

Run:

```bash
npx vitest run tests/unit/cli/test-provider.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/test-provider.ts tests/unit/cli/test-provider.test.ts
git commit -m "feat(cli): add codex provider smoke test"
```

---

### Task 5: Update Docs And Example Config

This task brings the public docs in sync with the new provider reality and removes wording that claims Claude is the only provider.

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/setup-guide.md`
- Modify: `docs/getting-started/configuration.mdx`
- Modify: `docs/reference/talonctl.mdx`
- Modify: `docs/reference/config-schema.mdx`
- Modify: `config/talond.example.yaml`

- [ ] **Step 1: Locate the stale provider-only wording**

Run:

```bash
rg -n "currently only|Claude or Gemini|Claude Code ships as the default|Claude Code and/or Gemini CLI|Launch long-running Claude Code workers" README.md CLAUDE.md docs/setup-guide.md docs/getting-started/configuration.mdx docs/reference/talonctl.mdx docs/reference/config-schema.mdx config/talond.example.yaml
```

Expected: several matches that still describe Talon as Claude-only or Claude/Gemini-only

- [ ] **Step 2: Update README and CLAUDE architecture wording**

In `README.md`, update the provider section and feature bullets to say Codex is supported:

```md
Each provider implements a small interface: prepare a background CLI invocation, parse its output, estimate context usage, and create an execution strategy. The daemon resolves which provider to use from config, both for the main agent runner and for background agents independently. Claude Code ships as the default provider; Gemini CLI and Codex CLI are also supported.
```

```md
- **Background agents** — Launch long-running provider workers for deep tasks without blocking the foreground conversation
```

In `CLAUDE.md`, update the overview and source-layout notes:

```md
Talon (`talond`) is a self-hosted autonomous AI agent daemon (~22K lines TypeScript). It receives messages from humans across multiple channels, processes them through an AI provider (Claude Code, Gemini CLI, or Codex CLI), executes tools through capability-gated host-tools, and sends responses back.
```

```md
- **Agent SDK runs on host** (not in container) — Claude uses the Agent SDK directly; CLI providers such as Gemini and Codex run as provider-managed child processes.
```

- [ ] **Step 3: Update setup/config/talonctl docs and example YAML**

In `docs/setup-guide.md`, add a Codex install/auth section plus updated provider examples:

```md
### Codex CLI

Install and authenticate with `npm install -g @openai/codex` and `codex login`.

Verify it with `codex --version`, then run `codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C /tmp -o /tmp/codex-last.txt "say hello"` and confirm `cat /tmp/codex-last.txt` prints a non-empty response.
```

Update the provider example blocks in `docs/setup-guide.md`, `docs/getting-started/configuration.mdx`, `docs/reference/config-schema.mdx`, and `config/talond.example.yaml` with a disabled Codex entry:

```yaml
codex-cli:
  enabled: false
  command: codex
  contextWindowTokens: 400000
  contextManagement:
    enabled: true
    triggerMetric: input_tokens
    thresholdRatio: 0.8
    recentMessageCount: 10
    summarizer: session-summarizer
  options:
    defaultModel: gpt-5.4
```

For `backgroundAgent.providers`:

```yaml
codex-cli:
  enabled: false
  command: codex
  contextWindowTokens: 400000
  options:
    defaultModel: gpt-5.4
```

Update `docs/reference/talonctl.mdx` examples:

```bash
npx talonctl add-provider --name codex-cli \
  --command /usr/local/bin/codex \
  --context both \
  --context-window 400000 \
  --trigger-metric input_tokens \
  --threshold-ratio 0.8 \
  --recent-message-count 10 \
  --summarizer session-summarizer \
  --enabled \
  --default-model gpt-5.4

npx talonctl set-default-provider --name codex-cli --context agent-runner
npx talonctl test-provider --name codex-cli
```

- [ ] **Step 4: Verify the docs are consistent**

Run:

```bash
rg -n "currently only|Claude or Gemini|Launch long-running Claude Code workers" README.md CLAUDE.md docs/setup-guide.md docs/getting-started/configuration.mdx docs/reference/talonctl.mdx docs/reference/config-schema.mdx config/talond.example.yaml
```

Expected: no matches

Run:

```bash
rg -n "codex-cli|Codex CLI" README.md CLAUDE.md docs/setup-guide.md docs/getting-started/configuration.mdx docs/reference/talonctl.mdx docs/reference/config-schema.mdx config/talond.example.yaml
```

Expected: each file above now contains a Codex example or explanation

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md docs/setup-guide.md docs/getting-started/configuration.mdx docs/reference/talonctl.mdx docs/reference/config-schema.mdx config/talond.example.yaml
git commit -m "docs: add codex provider guidance"
```

---

## Final verification pass

After all tasks are complete, run the combined verification pass before opening a PR or merging:

```bash
npx vitest run tests/unit/providers/codex-cli-provider.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/subagents/background/background-agent-manager.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/cli/test-provider.test.ts
```

Expected: PASS

If `codex` is installed locally, run one manual smoke check before calling the work complete:

```bash
npx talonctl test-provider --name codex-cli
```

Expected: binary found, valid JSONL smoke run, non-empty final response
