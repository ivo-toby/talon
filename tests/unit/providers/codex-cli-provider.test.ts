import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexCliProvider } from '../../../src/providers/codex-cli-provider.js';

describe('CodexCliProvider', () => {
  let runtimeDir: string;
  let operatorHome: string;
  const cleanupPaths: string[] = [];

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'talon-codex-runtime-'));
    operatorHome = mkdtempSync(join(tmpdir(), 'talon-codex-operator-'));
    mkdirSync(join(operatorHome, '.codex'), { recursive: true });
    writeFileSync(join(operatorHome, '.codex', 'auth.json'), '{"access_token":"test"}');
  });

  afterEach(() => {
    for (const path of cleanupPaths) {
      rmSync(path, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
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

  it('creates a resumable CLI execution strategy', () => {
    const provider = makeProvider();
    const strategy = provider.createExecutionStrategy();

    expect(strategy.type).toBe('cli');
    expect(strategy.supportsSessionResumption).toBe(true);
    expect(typeof strategy.run).toBe('function');
  });

  it('runs foreground sessions with stable HOME, seeded auth/config, and codex exec args', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'executeInvocation')
      .mockImplementation(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'foreground-output', 'utf8');
        return {
          stdout: [
            '{"type":"thread.started","thread_id":"codex-thread-123"}',
            '{"type":"turn.completed","usage":{"input_tokens":111,"output_tokens":7}}',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      });

    try {
      const strategy = provider.createExecutionStrategy();
      const result = await strategy.run({
        threadId: 'thread-001',
        prompt: 'Continue this conversation.',
        systemPrompt: 'You are helpful.',
        mcpServers: {
          hostTools: {
            transport: 'stdio',
            command: 'node',
            args: ['mcp.js'],
            env: { TOKEN: 'abc' },
          },
          remoteBrowser: {
            transport: 'http',
            url: 'https://mcp.example.test',
            headers: { Authorization: 'Bearer secret-token' },
          },
        },
        cwd: '/workspace/repo',
        model: 'gpt-5.4',
        maxTurns: 25,
        timeoutMs: 60_000,
      });

      const invocation = executeInvocation.mock.calls[0]?.[0];
      expect(invocation).toBeDefined();

      const expectedHome = join(
        runtimeDir,
        'providers',
        'codex-cli',
        'threads',
        'thread-001',
        'home',
      );
      expect(invocation.env.HOME).toBe(expectedHome);
      expect(invocation.args[0]).toBe('exec');
      expect(invocation.args[1]).toBe('-');
      expect(invocation.args).toContain('--json');
      expect(invocation.args).toContain('--skip-git-repo-check');
      expect(invocation.args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(invocation.args).not.toContain('--ephemeral');
      expect(invocation.args).toContain('-o');
      expect(invocation.stdin).toContain('You are helpful.');
      expect(invocation.stdin).toContain('Continue this conversation.');
      const outputFlagIndex = invocation.args.indexOf('-o');
      const expectedLastMessagePath = join(expectedHome, 'last-message.txt');
      expect(outputFlagIndex).toBeGreaterThan(-1);
      expect(invocation.args[outputFlagIndex + 1]).toBe(expectedLastMessagePath);
      expect(invocation.resultFiles.lastMessagePath).toBe(expectedLastMessagePath);

      const authPath = join(expectedHome, '.codex', 'auth.json');
      expect(existsSync(authPath)).toBe(true);
      expect(readFileSync(authPath, 'utf8')).toBe('{"access_token":"test"}');

      const configPath = join(expectedHome, '.codex', 'config.toml');
      expect(existsSync(configPath)).toBe(true);
      const configToml = readFileSync(configPath, 'utf8');
      expect(configToml).toContain('model = "gpt-5.4"');
      expect(configToml).toContain('[projects."/workspace/repo"]');
      expect(configToml).toContain('trust_level = "trusted"');
      expect(configToml).toContain('[mcp_servers."hostTools"]');
      expect(configToml).toContain('command = "node"');
      expect(configToml).toContain('[mcp_servers."hostTools".env]');
      expect(configToml).toContain('TOKEN = "abc"');
      expect(configToml).toContain('[mcp_servers."remoteBrowser"]');
      expect(configToml).toContain('url = "https://mcp.example.test"');
      expect(configToml).toContain('bearer_token_env_var = ');

      expect(result).toEqual({
        output: 'foreground-output',
        sessionId: 'codex-thread-123',
        usage: {
          inputTokens: 111,
          outputTokens: 7,
        },
        isError: false,
      });
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('does not reuse stale foreground last-message output when a subsequent run does not write one', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'executeInvocation')
      .mockImplementationOnce(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'first-output', 'utf8');
        return {
          stdout: [
            '{"type":"thread.started","thread_id":"codex-thread-123"}',
            '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":2}}',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      })
      .mockResolvedValueOnce({
        stdout: 'second-raw-stdout',
        stderr: 'failed',
        exitCode: 1,
        timedOut: false,
      });

    try {
      const strategy = provider.createExecutionStrategy();

      const first = await strategy.run({
        threadId: 'thread-001',
        prompt: 'First',
        systemPrompt: 'You are helpful.',
        mcpServers: {},
        cwd: '/workspace/repo',
        model: 'gpt-5.4',
        maxTurns: 25,
        timeoutMs: 60_000,
      });
      expect(first.output).toBe('first-output');

      const second = await strategy.run({
        threadId: 'thread-001',
        prompt: 'Second',
        systemPrompt: 'You are helpful.',
        mcpServers: {},
        cwd: '/workspace/repo',
        model: 'gpt-5.4',
        maxTurns: 25,
        timeoutMs: 60_000,
      });

      expect(second.output).toBe('second-raw-stdout');
      expect(second.isError).toBe(true);
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('uses codex exec resume when a session id is provided', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'executeInvocation')
      .mockImplementation(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'resumed-output', 'utf8');
        return {
          stdout: [
            '{"type":"thread.started","thread_id":"codex-thread-001"}',
            '{"type":"turn.completed","usage":{"input_tokens":144,"output_tokens":9}}',
          ].join('\n'),
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

      const invocation = executeInvocation.mock.calls[0]?.[0];
      expect(invocation.args.slice(0, 4)).toEqual([
        'exec',
        'resume',
        'codex-thread-001',
        '-',
      ]);
      expect(invocation.stdin).toContain('You are helpful.');
      expect(invocation.stdin).toContain('Continue');
      expect(result.sessionId).toBe('codex-thread-001');
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('prepares background invocations with temp HOME, resultFiles metadata, and --ephemeral', () => {
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
        remoteStream: {
          transport: 'sse',
          url: 'https://sse.example.test/mcp',
          headers: { Authorization: 'Bearer sse-secret-token' },
        },
        inProcess: {
          transport: 'sdk',
          instance: { connect: vi.fn() },
        },
      },
      cwd: '/workspace/repo',
      timeoutMs: 60_000,
      model: 'gpt-5.4',
    });

    expect(result.isOk()).toBe(true);
    const invocation = result._unsafeUnwrap();
    cleanupPaths.push(...invocation.cleanupPaths);

    expect(invocation.env?.HOME.startsWith(tmpdir())).toBe(true);
    expect(invocation.cleanupPaths).toContain(invocation.env!.HOME);
    expect(invocation.resultFiles?.lastMessagePath).toBeDefined();
    expect(invocation.args[1]).toBe('-');
    expect(invocation.args).toContain('--ephemeral');
    expect(invocation.args).toContain('--json');
    expect(invocation.args).toContain('--skip-git-repo-check');
    expect(invocation.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(invocation.args).toContain('-o');
    expect(invocation.stdin).toContain('You are helpful.');
    expect(invocation.stdin).toContain('Refactor the auth module.');
    const outputFlagIndex = invocation.args.indexOf('-o');
    expect(outputFlagIndex).toBeGreaterThan(-1);
    expect(invocation.args[outputFlagIndex + 1]).toBe(invocation.resultFiles?.lastMessagePath);

    const configPath = join(invocation.env!.HOME, '.codex', 'config.toml');
    expect(existsSync(configPath)).toBe(true);
    const configToml = readFileSync(configPath, 'utf8');
    expect(configToml).toContain('[mcp_servers."hostTools"]');
    expect(configToml).toContain('command = "node"');
    expect(configToml).toContain('[mcp_servers."remoteBrowser"]');
    expect(configToml).toContain('bearer_token_env_var = ');
    expect(configToml).toContain('[mcp_servers."remoteStream"]');
    expect(configToml).toContain('url = "https://sse.example.test/mcp"');
    expect(configToml).not.toContain('[mcp_servers.inProcess]');
    expect(Object.values(invocation.env ?? {})).toContain('secret-token');
    expect(Object.values(invocation.env ?? {})).toContain('sse-secret-token');
  });

  it('quotes TOML table names for MCP servers with dotted or spaced names', () => {
    const provider = makeProvider();
    const result = provider.prepareBackgroundInvocation({
      prompt: 'Refactor',
      systemPrompt: 'You are helpful.',
      mcpServers: {
        'tools.demo server': {
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: { TOKEN: 'abc' },
        },
      },
      cwd: '/workspace/repo',
      timeoutMs: 30_000,
    });

    expect(result.isOk()).toBe(true);
    const invocation = result._unsafeUnwrap();
    cleanupPaths.push(...invocation.cleanupPaths);
    const configToml = readFileSync(join(invocation.env!.HOME, '.codex', 'config.toml'), 'utf8');

    expect(configToml).toContain('[mcp_servers."tools.demo server"]');
    expect(configToml).toContain('[mcp_servers."tools.demo server".env]');
  });

  it('uses collision-resistant bearer env var names for distinct MCP ids', () => {
    const provider = makeProvider();
    const result = provider.prepareBackgroundInvocation({
      prompt: 'Refactor',
      systemPrompt: 'You are helpful.',
      mcpServers: {
        'foo-bar': {
          transport: 'http',
          url: 'https://foo-bar.example.test/mcp',
          headers: { Authorization: 'Bearer token-a' },
        },
        foobar: {
          transport: 'http',
          url: 'https://foobar.example.test/mcp',
          headers: { Authorization: 'Bearer token-b' },
        },
      },
      cwd: '/workspace/repo',
      timeoutMs: 30_000,
    });

    expect(result.isOk()).toBe(true);
    const invocation = result._unsafeUnwrap();
    cleanupPaths.push(...invocation.cleanupPaths);
    const configToml = readFileSync(join(invocation.env!.HOME, '.codex', 'config.toml'), 'utf8');

    const matches = [...configToml.matchAll(/bearer_token_env_var = "([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(matches).toHaveLength(2);
    expect(new Set(matches).size).toBe(2);
    expect(invocation.env?.[matches[0]]).toBeDefined();
    expect(invocation.env?.[matches[1]]).toBeDefined();
    expect(Object.values(invocation.env ?? {})).toContain('token-a');
    expect(Object.values(invocation.env ?? {})).toContain('token-b');
  });

  it('fails fast for remote MCP servers with custom non-bearer headers', () => {
    const provider = makeProvider();
    const result = provider.prepareBackgroundInvocation({
      prompt: 'Refactor',
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

  it('reads background final output from resultFiles.lastMessagePath and usage from JSONL', () => {
    const provider = makeProvider();
    const lastMessagePath = join(runtimeDir, 'last-message.txt');
    writeFileSync(lastMessagePath, 'isolated-final-output', 'utf8');

    const result = provider.parseBackgroundResult(
      {
        stdout: [
          '{"type":"thread.started","thread_id":"codex-thread-009"}',
          '{"type":"turn.completed","usage":{"input_tokens":14813,"output_tokens":16}}',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
      { lastMessagePath },
    );

    expect(result).toEqual({
      output: 'isolated-final-output',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      usage: {
        inputTokens: 14813,
        outputTokens: 16,
      },
    });
  });

  it('throws when successful foreground output is missing thread.started', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'executeInvocation')
      .mockImplementation(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'foreground-output', 'utf8');
        return {
          stdout: '{"type":"turn.completed","usage":{"input_tokens":111,"output_tokens":7}}',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      });

    try {
      const strategy = provider.createExecutionStrategy();
      await expect(
        strategy.run({
          threadId: 'thread-001',
          prompt: 'Continue this conversation.',
          systemPrompt: 'You are helpful.',
          mcpServers: {},
          cwd: '/workspace/repo',
          model: 'gpt-5.4',
          maxTurns: 25,
          timeoutMs: 60_000,
        }),
      ).rejects.toThrow('thread.started');
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('throws when successful foreground output is missing turn.completed', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'executeInvocation')
      .mockImplementation(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'foreground-output', 'utf8');
        return {
          stdout: '{"type":"thread.started","thread_id":"codex-thread-123"}',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      });

    try {
      const strategy = provider.createExecutionStrategy();
      await expect(
        strategy.run({
          threadId: 'thread-001',
          prompt: 'Continue this conversation.',
          systemPrompt: 'You are helpful.',
          mcpServers: {},
          cwd: '/workspace/repo',
          model: 'gpt-5.4',
          maxTurns: 25,
          timeoutMs: 60_000,
        }),
      ).rejects.toThrow('turn.completed');
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('throws when successful foreground output has thread.started without a string thread_id', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'executeInvocation')
      .mockImplementation(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'foreground-output', 'utf8');
        return {
          stdout: [
            '{"type":"thread.started","thread_id":123}',
            '{"type":"turn.completed","usage":{"input_tokens":111,"output_tokens":7}}',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      });

    try {
      const strategy = provider.createExecutionStrategy();
      await expect(
        strategy.run({
          threadId: 'thread-001',
          prompt: 'Continue this conversation.',
          systemPrompt: 'You are helpful.',
          mcpServers: {},
          cwd: '/workspace/repo',
          model: 'gpt-5.4',
          maxTurns: 25,
          timeoutMs: 60_000,
        }),
      ).rejects.toThrow('thread_id');
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('marks successful background output without thread.started as failed', () => {
    const provider = makeProvider();
    const lastMessagePath = join(runtimeDir, 'last-message.txt');
    writeFileSync(lastMessagePath, 'isolated-final-output', 'utf8');

    const result = provider.parseBackgroundResult(
      {
        stdout: '{"type":"turn.completed","usage":{"input_tokens":14813,"output_tokens":16}}',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
      { lastMessagePath },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('thread.started');
  });

  it('marks successful background output without turn.completed as failed', () => {
    const provider = makeProvider();
    const lastMessagePath = join(runtimeDir, 'last-message.txt');
    writeFileSync(lastMessagePath, 'isolated-final-output', 'utf8');

    const result = provider.parseBackgroundResult(
      {
        stdout: '{"type":"thread.started","thread_id":"codex-thread-009"}',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
      { lastMessagePath },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('turn.completed');
  });

  it('estimates context usage from input_tokens only', () => {
    const provider = makeProvider();

    expect(
      provider.estimateContextUsage({
        inputTokens: 12_345,
        outputTokens: 100,
      }),
    ).toEqual({
      inputTokens: 12_345,
      metrics: {
        input_tokens: 12_345,
      },
    });
  });
});
