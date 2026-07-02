import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexCliProvider } from '../../../src/providers/codex-cli-provider.js';
import type { AgentStreamEvent } from '../../../src/providers/provider.js';

describe('CodexCliProvider', () => {
  let runtimeDir: string;
  let operatorHome: string;
  const cleanupPaths: string[] = [];

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'talon-codex-runtime-'));
    operatorHome = mkdtempSync(join(tmpdir(), 'talon-codex-operator-'));
    mkdirSync(join(operatorHome, '.codex'), { recursive: true });
    writeFileSync(join(operatorHome, '.codex', 'auth.json'), '{"access_token":"test"}');
    writeFileSync(join(operatorHome, '.codex', 'state_5.sqlite'), 'state-db', 'utf8');
    writeFileSync(join(operatorHome, '.codex', 'state_5.sqlite-wal'), 'state-wal', 'utf8');
    writeFileSync(join(operatorHome, '.codex', 'logs_1.sqlite'), 'logs-db', 'utf8');
    writeFileSync(join(operatorHome, '.codex', 'models_cache.json'), '{"models":[]}', 'utf8');
    writeFileSync(join(operatorHome, '.codex', 'version.json'), '{"version":"0.118.0"}', 'utf8');
  });

  afterEach(() => {
    for (const path of cleanupPaths) {
      rmSync(path, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(operatorHome, { recursive: true, force: true });
  });

  function makeProvider(name = 'codex-cli') {
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
      name,
    );
  }

  async function collectEvents(
    stream: AsyncIterable<AgentStreamEvent>,
  ): Promise<AgentStreamEvent[]> {
    const events: AgentStreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    return events;
  }

  it('creates a resumable streaming execution strategy', () => {
    const provider = makeProvider();
    const strategy = provider.createExecutionStrategy();

    expect(strategy.type).toBe('sdk');
    expect(strategy.supportsSessionResumption).toBe(true);
    expect(typeof strategy.run).toBe('function');
  });

  it('can report an alias provider name', () => {
    const provider = makeProvider('codex-work');

    expect(provider.name).toBe('codex-work');
  });

  it('streams foreground text chunks, tool events, and final result with stable HOME and codex exec args', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'streamInvocation')
      .mockImplementation(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'foreground-output', 'utf8');
        async function* events() {
          yield '{"type":"thread.started","thread_id":"codex-thread-123"}\n';
          yield '{"type":"item.completed","item":{"type":"assistant_message","content":[{"type":"output_text","text":"Hello "} ]}}\n';
          yield '{"type":"item.completed","item":{"type":"mcp_tool_call","server_name":"brave","name":"search","call_id":"tool-1","arguments":{"q":"latest"}}}\n';
          yield '{"type":"item.completed","item":{"type":"assistant_message","content":[{"type":"output_text","text":"world"}]}}\n';
          yield '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":111,"cached_input_tokens":42,"output_tokens":7},"last_token_usage":{"input_tokens":55,"cached_input_tokens":30,"output_tokens":3},"model_context_window":258400}}}\n';
          yield '{"type":"turn.completed","usage":{"input_tokens":111,"cached_input_tokens":42,"output_tokens":7}}\n';
        }
        return {
          stdout: events(),
          completed: Promise.resolve({
            stderr: '',
            exitCode: 0,
            timedOut: false,
          }),
        };
      });

    try {
      const strategy = provider.createExecutionStrategy();
      const events = await collectEvents(
        strategy.run({
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
        }),
      );

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
      expect(invocation.env.HOME.startsWith('/')).toBe(true);
      expect(invocation.args[0]).toBe('exec');
      expect(invocation.args[invocation.args.length - 1]).toBe('-');
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
      expect(readFileSync(join(expectedHome, '.codex', 'state_5.sqlite'), 'utf8')).toBe('state-db');
      expect(readFileSync(join(expectedHome, '.codex', 'state_5.sqlite-wal'), 'utf8')).toBe(
        'state-wal',
      );
      expect(readFileSync(join(expectedHome, '.codex', 'logs_1.sqlite'), 'utf8')).toBe('logs-db');
      expect(readFileSync(join(expectedHome, '.codex', 'models_cache.json'), 'utf8')).toContain(
        '"models"',
      );
      expect(readFileSync(join(expectedHome, '.codex', 'version.json'), 'utf8')).toContain(
        '0.118.0',
      );

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

      expect(events).toEqual([
        { type: 'text', content: 'Hello ' },
        {
          type: 'tool_event',
          messageType: 'mcp_tool_use',
          tool: 'search',
          toolUseId: 'tool-1',
          input: { q: 'latest' },
          output: undefined,
          isError: undefined,
          subtype: 'mcp_tool_call',
          serverName: 'brave',
        },
        { type: 'text', content: 'world' },
        {
          type: 'result',
          result: {
            output: 'foreground-output',
            sessionId: 'codex-thread-123',
            usage: {
              inputTokens: 111,
              cacheReadTokens: 42,
              outputTokens: 7,
            },
            lastStepUsage: {
              inputTokens: 55,
              cacheReadTokens: 30,
              outputTokens: 3,
            },
            isError: false,
          },
        },
      ]);
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('does not reuse stale foreground last-message output when a subsequent run does not write one', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'streamInvocation')
      .mockImplementationOnce(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'first-output', 'utf8');
        return {
          stdout: (async function* () {
            yield '{"type":"thread.started","thread_id":"codex-thread-123"}\n';
            yield '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":2}}\n';
          })(),
          completed: Promise.resolve({
            stderr: '',
            exitCode: 0,
            timedOut: false,
          }),
        };
      })
      .mockResolvedValueOnce({
        stdout: (async function* () {
          yield 'second-raw-stdout';
        })(),
        completed: Promise.resolve({
          stderr: 'failed',
          exitCode: 1,
          timedOut: false,
        }),
      });

    try {
      const strategy = provider.createExecutionStrategy();

      const first = await collectEvents(
        strategy.run({
          threadId: 'thread-001',
          prompt: 'First',
          systemPrompt: 'You are helpful.',
          mcpServers: {},
          cwd: '/workspace/repo',
          model: 'gpt-5.4',
          maxTurns: 25,
          timeoutMs: 60_000,
        }),
      );
      expect(first[first.length - 1]).toEqual({
        type: 'result',
        result: expect.objectContaining({ output: 'first-output', isError: false }),
      });

      const second = await collectEvents(
        strategy.run({
          threadId: 'thread-001',
          prompt: 'Second',
          systemPrompt: 'You are helpful.',
          mcpServers: {},
          cwd: '/workspace/repo',
          model: 'gpt-5.4',
          maxTurns: 25,
          timeoutMs: 60_000,
        }),
      );

      expect(second[second.length - 1]).toEqual({
        type: 'result',
        result: expect.objectContaining({ output: 'second-raw-stdout', isError: true }),
      });
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('uses codex exec resume when a session id is provided', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'streamInvocation')
      .mockImplementation(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'resumed-output', 'utf8');
        return {
          stdout: (async function* () {
            yield '{"type":"thread.started","thread_id":"codex-thread-001"}\n';
            yield '{"type":"turn.completed","usage":{"input_tokens":144,"output_tokens":9}}\n';
          })(),
          completed: Promise.resolve({
            stderr: '',
            exitCode: 0,
            timedOut: false,
          }),
        };
      });

    try {
      const strategy = provider.createExecutionStrategy();
      const events = await collectEvents(
        strategy.run({
          threadId: 'thread-001',
          prompt: 'Continue',
          systemPrompt: 'You are helpful.',
          mcpServers: {},
          cwd: '/workspace/repo',
          model: 'gpt-5.4',
          maxTurns: 25,
          timeoutMs: 60_000,
          sessionId: 'codex-thread-001',
        }),
      );

      const invocation = executeInvocation.mock.calls[0]?.[0];
      expect(invocation.args.slice(0, 2)).toEqual(['exec', 'resume']);
      expect(invocation.args).toContain('--json');
      expect(invocation.args).toContain('--skip-git-repo-check');
      expect(invocation.args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(invocation.args).toContain('-o');
      expect(invocation.args.slice(-2)).toEqual(['codex-thread-001', '-']);
      expect(invocation.stdin).toContain('You are helpful.');
      expect(invocation.stdin).toContain('Continue');
      expect(events[events.length - 1]).toEqual({
        type: 'result',
        result: expect.objectContaining({ sessionId: 'codex-thread-001' }),
      });
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('prepares background invocations with a stable runtime HOME, resultFiles metadata, and --ephemeral', () => {
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

    expect(
      invocation.env?.HOME.startsWith(join(runtimeDir, 'providers', 'codex-cli', 'background')),
    ).toBe(true);
    expect(invocation.env?.HOME.endsWith('/home')).toBe(true);
    expect(invocation.cleanupPaths).toContain(invocation.env!.HOME);
    expect(invocation.resultFiles?.lastMessagePath).toBeDefined();
    expect(invocation.args[invocation.args.length - 1]).toBe('-');
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
          '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":14813,"cached_input_tokens":9000,"output_tokens":16},"last_token_usage":{"input_tokens":7312,"cached_input_tokens":4096,"output_tokens":5},"model_context_window":258400}}}',
          '{"type":"turn.completed","usage":{"input_tokens":14813,"cached_input_tokens":9000,"output_tokens":16}}',
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
        cacheReadTokens: 9000,
        outputTokens: 16,
      },
      lastStepUsage: {
        inputTokens: 7312,
        cacheReadTokens: 4096,
        outputTokens: 5,
      },
    });
  });

  it('throws when successful foreground output is missing thread.started', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'streamInvocation')
      .mockImplementation(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'foreground-output', 'utf8');
        return {
          stdout: (async function* () {
            yield '{"type":"turn.completed","usage":{"input_tokens":111,"output_tokens":7}}\n';
          })(),
          completed: Promise.resolve({
            stderr: '',
            exitCode: 0,
            timedOut: false,
          }),
        };
      });

    try {
      const strategy = provider.createExecutionStrategy();
      await expect(
        collectEvents(
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
        ),
      ).rejects.toThrow('thread.started');
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('throws when successful foreground output is missing turn.completed', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'streamInvocation')
      .mockImplementation(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'foreground-output', 'utf8');
        return {
          stdout: (async function* () {
            yield '{"type":"thread.started","thread_id":"codex-thread-123"}\n';
          })(),
          completed: Promise.resolve({
            stderr: '',
            exitCode: 0,
            timedOut: false,
          }),
        };
      });

    try {
      const strategy = provider.createExecutionStrategy();
      await expect(
        collectEvents(
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
        ),
      ).rejects.toThrow('turn.completed');
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('throws when successful foreground output has thread.started without a string thread_id', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'streamInvocation')
      .mockImplementation(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'foreground-output', 'utf8');
        return {
          stdout: (async function* () {
            yield '{"type":"thread.started","thread_id":123}\n';
            yield '{"type":"turn.completed","usage":{"input_tokens":111,"output_tokens":7}}\n';
          })(),
          completed: Promise.resolve({
            stderr: '',
            exitCode: 0,
            timedOut: false,
          }),
        };
      });

    try {
      const strategy = provider.createExecutionStrategy();
      await expect(
        collectEvents(
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
        ),
      ).rejects.toThrow('thread_id');
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('ignores malformed and unknown JSONL events while still streaming known assistant text', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'streamInvocation')
      .mockImplementation(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'final-output', 'utf8');
        return {
          stdout: (async function* () {
            yield 'not-json\n';
            yield '{"type":"thread.started","thread_id":"codex-thread-123"}\n';
            yield '{"type":"item.weird","payload":{"foo":"bar"}}\n';
            yield '{"type":"item.completed","item":{"type":"assistant_message","delta":{"text":"Known text"}}}\n';
            yield '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}\n';
          })(),
          completed: Promise.resolve({
            stderr: '',
            exitCode: 0,
            timedOut: false,
          }),
        };
      });

    try {
      const strategy = provider.createExecutionStrategy();
      const events = await collectEvents(
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
      );

      expect(events).toContainEqual({ type: 'text', content: 'Known text' });
      expect(events[events.length - 1]).toEqual({
        type: 'result',
        result: expect.objectContaining({ output: 'final-output', isError: false }),
      });
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('does not surface reasoning items as assistant text', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'streamInvocation')
      .mockImplementation(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'final-output', 'utf8');
        return {
          stdout: (async function* () {
            yield '{"type":"thread.started","thread_id":"codex-thread-123"}\n';
            yield '{"type":"item.completed","item":{"type":"assistant_reasoning","content":[{"type":"reasoning_text","text":"private chain of thought"}]}}\n';
            yield '{"type":"item.completed","item":{"type":"assistant_message","content":[{"type":"output_text","text":"visible answer"}]}}\n';
            yield '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}\n';
          })(),
          completed: Promise.resolve({
            stderr: '',
            exitCode: 0,
            timedOut: false,
          }),
        };
      });

    try {
      const strategy = provider.createExecutionStrategy();
      const events = await collectEvents(
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
      );

      expect(events).toContainEqual({ type: 'text', content: 'visible answer' });
      expect(events).not.toContainEqual({ type: 'text', content: 'private chain of thought' });
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('does not duplicate streamed text when assistant content is a bare string', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'streamInvocation')
      .mockImplementation(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'final-output', 'utf8');
        return {
          stdout: (async function* () {
            yield '{"type":"thread.started","thread_id":"codex-thread-123"}\n';
            yield '{"type":"item.completed","item":{"type":"assistant_message","content":"Known text"}}\n';
            yield '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}\n';
          })(),
          completed: Promise.resolve({
            stderr: '',
            exitCode: 0,
            timedOut: false,
          }),
        };
      });

    try {
      const strategy = provider.createExecutionStrategy();
      const events = await collectEvents(
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
      );

      expect(events.filter((event) => event.type === 'text')).toEqual([
        { type: 'text', content: 'Known text' },
      ]);
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('keeps tool events whose subtype contains message when they still map to tool activity', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'streamInvocation')
      .mockImplementation(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'final-output', 'utf8');
        return {
          stdout: (async function* () {
            yield '{"type":"thread.started","thread_id":"codex-thread-123"}\n';
            yield '{"type":"item.completed","item":{"type":"tool_message_start","name":"shell","call_id":"tool-1","input":{"cmd":"pwd"}}}\n';
            yield '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}\n';
          })(),
          completed: Promise.resolve({
            stderr: '',
            exitCode: 0,
            timedOut: false,
          }),
        };
      });

    try {
      const strategy = provider.createExecutionStrategy();
      const events = await collectEvents(
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
      );

      expect(events).toContainEqual({
        type: 'tool_event',
        messageType: 'tool_use',
        tool: 'shell',
        toolUseId: 'tool-1',
        input: { cmd: 'pwd' },
        output: undefined,
        isError: undefined,
        subtype: 'tool_message_start',
        serverName: undefined,
      });
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('maps tool message end events to tool results', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'streamInvocation')
      .mockImplementation(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'final-output', 'utf8');
        return {
          stdout: (async function* () {
            yield '{"type":"thread.started","thread_id":"codex-thread-123"}\n';
            yield '{"type":"item.completed","item":{"type":"tool_message_end","name":"shell","call_id":"tool-1","output":{"cwd":"/workspace/repo"}}}\n';
            yield '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}\n';
          })(),
          completed: Promise.resolve({
            stderr: '',
            exitCode: 0,
            timedOut: false,
          }),
        };
      });

    try {
      const strategy = provider.createExecutionStrategy();
      const events = await collectEvents(
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
      );

      expect(events).toContainEqual({
        type: 'tool_event',
        messageType: 'tool_result',
        tool: 'shell',
        toolUseId: 'tool-1',
        input: undefined,
        output: { cwd: '/workspace/repo' },
        isError: undefined,
        subtype: 'tool_message_end',
        serverName: undefined,
      });
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('streams agent_message items with top-level text (real Codex CLI format)', async () => {
    const provider = makeProvider();
    const executeInvocation = vi
      .spyOn(CodexCliProvider.prototype as any, 'streamInvocation')
      .mockImplementation(async (prepared) => {
        writeFileSync(prepared.resultFiles.lastMessagePath, 'final-output', 'utf8');
        return {
          stdout: (async function* () {
            yield '{"type":"thread.started","thread_id":"codex-thread-123"}\n';
            yield '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Thinking about it."}}\n';
            yield '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"pwd","aggregated_output":"","exit_code":null,"status":"in_progress"}}\n';
            yield '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"pwd","aggregated_output":"/workspace","exit_code":0,"status":"completed"}}\n';
            yield '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"The answer is 4."}}\n';
            yield '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":10}}\n';
          })(),
          completed: Promise.resolve({
            stderr: '',
            exitCode: 0,
            timedOut: false,
          }),
        };
      });

    try {
      const strategy = provider.createExecutionStrategy();
      const events = await collectEvents(
        strategy.run({
          threadId: 'thread-001',
          prompt: 'What is 2+2?',
          systemPrompt: 'You are helpful.',
          mcpServers: {},
          cwd: '/workspace/repo',
          model: 'gpt-5.4',
          maxTurns: 25,
          timeoutMs: 60_000,
        }),
      );

      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents).toEqual([
        { type: 'text', content: 'Thinking about it.' },
        { type: 'text', content: 'The answer is 4.' },
      ]);

      const toolEvents = events.filter((e) => e.type === 'tool_event');
      expect(toolEvents).toHaveLength(2);
      expect(toolEvents[0]).toMatchObject({
        type: 'tool_event',
        subtype: 'command_execution',
      });
      expect(toolEvents[1]).toMatchObject({
        type: 'tool_event',
        subtype: 'command_execution',
      });

      expect(events[events.length - 1]).toEqual({
        type: 'result',
        result: expect.objectContaining({ output: 'final-output', isError: false }),
      });
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

  it('keeps successful background output with a non-empty final message when turn.completed is missing', () => {
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

    expect(result).toEqual({
      output: 'isolated-final-output',
      stderr: expect.stringContaining('turn.completed'),
      exitCode: 0,
      timedOut: false,
      usage: undefined,
    });
  });

  it('marks successful background output as failed when the final message file is empty', () => {
    const provider = makeProvider();
    const lastMessagePath = join(runtimeDir, 'last-message.txt');
    writeFileSync(lastMessagePath, '   \n', 'utf8');

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

  it('marks successful background output as failed when the final message file is unavailable', () => {
    const provider = makeProvider();
    const lastMessagePath = join(runtimeDir, 'missing-last-message.txt');

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

  it('estimates context usage with derived cache_creation_input_tokens', () => {
    const provider = makeProvider();

    expect(
      provider.estimateContextUsage({
        inputTokens: 12_345,
        cacheReadTokens: 6_789,
        outputTokens: 100,
      }),
    ).toEqual({
      inputTokens: 12_345,
      metrics: {
        input_tokens: 12_345,
        cache_read_input_tokens: 6_789,
        cache_creation_input_tokens: 5_556,
        cache_total_input_tokens: 12_345,
      },
    });
  });

  it('estimates context usage when no cache tokens are reported', () => {
    const provider = makeProvider();

    expect(
      provider.estimateContextUsage({
        inputTokens: 10_000,
        outputTokens: 500,
      }),
    ).toEqual({
      inputTokens: 10_000,
      metrics: {
        input_tokens: 10_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 10_000,
        cache_total_input_tokens: 10_000,
      },
    });
  });
});
