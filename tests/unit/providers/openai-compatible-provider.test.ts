import { describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleProvider } from '../../../src/providers/openai-compatible-provider.js';

describe('OpenAiCompatibleProvider', () => {
  function makeProvider() {
    return new OpenAiCompatibleProvider({
      enabled: true,
      command: 'node',
      contextWindowTokens: 256_000,
      options: {
        defaultModel: 'qwen3-coder:30b',
        baseUrl: 'http://127.0.0.1:11434/v1',
      },
    });
  }

  it('creates a stateless CLI execution strategy for foreground runs', () => {
    const provider = makeProvider();
    const strategy = provider.createExecutionStrategy();

    expect(strategy.type).toBe('cli');
    expect(strategy.supportsSessionResumption).toBe(false);
    expect(typeof strategy.run).toBe('function');
  });

  it('returns an error when neither input.model nor defaultModel is configured', () => {
    const provider = new OpenAiCompatibleProvider({
      enabled: true,
      command: 'node',
      contextWindowTokens: 256_000,
      options: {
        baseUrl: 'http://127.0.0.1:11434/v1',
      },
    });

    const result = provider.prepareBackgroundInvocation({
      prompt: 'Read the repo and summarize the result.',
      systemPrompt: 'You are a helpful coding agent.',
      mcpServers: {},
      cwd: '/workspace/repo',
      timeoutMs: 60_000,
      model: undefined,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain(
      'OpenAI-compatible provider requires input.model or providers.<name>.options.defaultModel',
    );
  });

  it('returns an error when no baseUrl is configured', () => {
    const provider = new OpenAiCompatibleProvider({
      enabled: true,
      command: 'node',
      contextWindowTokens: 256_000,
      options: {
        defaultModel: 'qwen3-coder:30b',
      },
    });

    const result = provider.prepareBackgroundInvocation({
      prompt: 'Read the repo and summarize the result.',
      systemPrompt: 'You are a helpful coding agent.',
      mcpServers: {},
      cwd: '/workspace/repo',
      timeoutMs: 60_000,
      model: undefined,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain(
      'OpenAI-compatible provider requires providers.<name>.options.baseUrl or auth.providers.openai.baseURL',
    );
  });

  it('prepares background invocations for the bundled wrapper with MCP server config and provider options', () => {
    const provider = makeProvider();

    const result = provider.prepareBackgroundInvocation({
      prompt: 'Read the repo and summarize the result.',
      systemPrompt: 'You are a helpful coding agent.',
      mcpServers: {
        hostTools: {
          transport: 'stdio',
          command: 'node',
          args: ['dist/tools/host-tools-mcp-server.js'],
          env: { TALOND_SOCKET: '/tmp/talond.sock' },
        },
        remoteDocs: {
          transport: 'http',
          url: 'https://mcp.example.test',
          headers: { Authorization: 'Bearer test-token' },
        },
        sseFeed: {
          transport: 'sse',
          url: 'https://sse.example.test',
          headers: { 'X-Test': 'abc' },
        },
        inProcess: {
          transport: 'sdk',
          instance: { connect: vi.fn() },
        },
      },
      cwd: '/workspace/repo',
      timeoutMs: 60_000,
      model: 'qwen3-coder:30b',
    });

    expect(result.isOk()).toBe(true);
    const invocation = result._unsafeUnwrap();

    expect(invocation.command).toBe('node');
    expect(invocation.cwd).toBe('/workspace/repo');
    expect(invocation.timeoutMs).toBe(60_000);
    expect(invocation.cleanupPaths).toEqual([]);
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/providers\/openai-compatible\/agent-cli\/index\.(ts|js)$/),
      ]),
    );

    const payload = JSON.parse(invocation.stdin) as Record<string, unknown>;
    expect(payload).toMatchObject({
      prompt: 'Read the repo and summarize the result.',
      systemPrompt: 'You are a helpful coding agent.',
      cwd: '/workspace/repo',
      model: 'qwen3-coder:30b',
      baseUrl: 'http://127.0.0.1:11434/v1',
    });
    expect(payload['mcpServers']).toEqual({
      hostTools: {
        transport: 'stdio',
        command: 'node',
        args: ['dist/tools/host-tools-mcp-server.js'],
        env: { TALOND_SOCKET: '/tmp/talond.sock' },
      },
      remoteDocs: {
        transport: 'http',
        url: 'https://mcp.example.test',
        headers: { Authorization: 'Bearer test-token' },
      },
      sseFeed: {
        transport: 'sse',
        url: 'https://sse.example.test',
        headers: { 'X-Test': 'abc' },
      },
    });
  });

  it('parses wrapper JSON into normalized output and usage', () => {
    const provider = makeProvider();

    const result = provider.parseBackgroundResult({
      stdout: JSON.stringify({
        output: 'Completed successfully.',
        usage: {
          inputTokens: 120,
          outputTokens: 24,
        },
      }),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });

    expect(result).toEqual({
      output: 'Completed successfully.',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      usage: {
        inputTokens: 120,
        outputTokens: 24,
      },
    });
  });
});
