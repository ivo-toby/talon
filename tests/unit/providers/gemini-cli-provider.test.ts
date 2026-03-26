import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { GeminiCliProvider } from '../../../src/providers/gemini-cli-provider.js';

describe('GeminiCliProvider', () => {
  const cleanupPaths: string[] = [];
  const provider = new GeminiCliProvider({
    enabled: true,
    command: 'gemini',
    contextWindowTokens: 1_000_000,
    options: {
      defaultModel: 'gemini-2.5-pro',
    },
  });

  afterEach(() => {
    for (const path of cleanupPaths) {
      rmSync(path, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  it('creates a CLI execution strategy', () => {
    const strategy = provider.createExecutionStrategy();

    expect(strategy.type).toBe('cli');
    expect(strategy.supportsSessionResumption).toBe(false);
    expect(typeof strategy.run).toBe('function');
  });

  it('prepares Gemini background invocations with temp settings and env overrides', () => {
    const result = provider.prepareBackgroundInvocation({
      prompt: 'Refactor the auth module.',
      systemPrompt: 'You are a helpful assistant.',
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
          headers: { Authorization: 'Bearer token' },
        },
        liveFeed: {
          transport: 'sse',
          url: 'https://sse.example.test',
          headers: { 'X-Token': 'abc123' },
        },
        inProcess: {
          transport: 'sdk',
          instance: { connect: vi.fn() },
        },
      },
      cwd: '/tmp',
      timeoutMs: 60_000,
    });

    expect(result.isOk()).toBe(true);
    const invocation = result._unsafeUnwrap();
    cleanupPaths.push(...invocation.cleanupPaths);

    expect(invocation.command).toBe('gemini');
    expect(invocation.stdin).toBe('');
    expect(invocation.cwd).toBe('/tmp');
    expect(invocation.args).toEqual([
      '--approval-mode',
      'yolo',
      '--output-format',
      'json',
      '--model',
      'gemini-2.5-pro',
      'Refactor the auth module.',
    ]);
    expect(invocation.env).toEqual(
      expect.objectContaining({
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: expect.any(String),
        GEMINI_SYSTEM_MD: expect.any(String),
      }),
    );
    expect(invocation.env).not.toHaveProperty('GEMINI_CLI_HOME');

    const settingsPath = invocation.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    const systemPath = invocation.env?.GEMINI_SYSTEM_MD;

    expect(settingsPath).toBeDefined();
    expect(systemPath).toBeDefined();
    expect(existsSync(settingsPath!)).toBe(true);
    expect(existsSync(systemPath!)).toBe(true);
    expect(readFileSync(systemPath!, 'utf8')).toBe('You are a helpful assistant.');
    expect(JSON.parse(readFileSync(settingsPath!, 'utf8'))).toEqual({
      security: {
        folderTrust: {
          enabled: false,
        },
      },
      mcpServers: {
        hostTools: {
          command: 'node',
          args: ['dist/tools/host-tools-mcp-server.js'],
          env: { TALOND_SOCKET: '/tmp/talond.sock' },
        },
        remoteBrowser: {
          httpUrl: 'https://mcp.example.test',
          headers: { Authorization: 'Bearer token' },
        },
        liveFeed: {
          url: 'https://sse.example.test',
          headers: { 'X-Token': 'abc123' },
        },
      },
    });
  });

  it('parses Gemini JSON output into normalized usage and text', () => {
    const result = provider.parseBackgroundResult({
      stdout: JSON.stringify({
        response: 'Finished successfully.',
        stats: {
          models: {
            'gemini-2.5-pro': {
              tokens: {
                input: 120,
                candidates: 30,
                total: 150,
                cached: 0,
                thoughts: 0,
                tool: 0,
              },
            },
          },
        },
      }),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });

    expect(result).toEqual({
      output: 'Finished successfully.',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      usage: {
        inputTokens: 120,
        outputTokens: 30,
      },
    });
  });

  it('marks successful non-JSON Gemini output as an incompatible CLI failure', () => {
    const result = provider.parseBackgroundResult({
      stdout: 'plain text output',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });

    expect(result.output).toBe('plain text output');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Upgrade gemini-cli');
    expect(result.usage).toBeUndefined();
  });

  it('throws an upgrade-required error from the CLI strategy when Gemini returns non-JSON success output', async () => {
    const executeInvocation = vi
      .spyOn(GeminiCliProvider.prototype as any, 'executeInvocation')
      .mockResolvedValue({
        stdout: 'plain text output',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      });

    try {
      const strategy = provider.createExecutionStrategy();
      await expect(
        strategy.run({
          prompt: 'Refactor the auth module.',
          systemPrompt: 'You are a helpful assistant.',
          mcpServers: {},
          cwd: '/tmp',
          model: 'gemini-2.5-pro',
          maxTurns: 25,
          timeoutMs: 60_000,
        }),
      ).rejects.toThrow(/Upgrade gemini-cli/);
    } finally {
      executeInvocation.mockRestore();
    }
  });

  it('estimates context usage from total input tokens', () => {
    expect(
      provider.estimateContextUsage({
        inputTokens: 500_000,
        outputTokens: 2_000,
      }),
    ).toEqual({
      inputTokens: 500_000,
      metrics: {
        input_tokens: 500_000,
      },
    });
  });

  it('returns err and cleans up the temp dir when settings cannot be written', async () => {
    const capturedRmCalls: Array<[string, unknown]> = [];

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      let writeCount = 0;
      return {
        ...actual,
        writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
          if (writeCount++ === 0) {
            throw new Error('disk full');
          }
          return actual.writeFileSync(...args);
        },
        rmSync: (path: string, opts: unknown) => {
          capturedRmCalls.push([path, opts]);
          return actual.rmSync(path, opts as Parameters<typeof actual.rmSync>[1]);
        },
      };
    });

    vi.resetModules();

    try {
      const { GeminiCliProvider: IsolatedProvider } = await import(
        '../../../src/providers/gemini-cli-provider.js'
      );
      const isolatedProvider = new IsolatedProvider({
        enabled: true,
        command: 'gemini',
        contextWindowTokens: 1_000_000,
      });

      const result = isolatedProvider.prepareBackgroundInvocation({
        prompt: 'Test prompt.',
        systemPrompt: 'System.',
        mcpServers: {},
        cwd: '/tmp',
        timeoutMs: 30_000,
      });

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.message).toContain('failed to prepare background invocation');
      expect(error.message).toContain('disk full');

      const cleanupCalls = capturedRmCalls.filter(([p]) =>
        p.includes('talon-provider-gemini-cli-'),
      );
      expect(cleanupCalls.length).toBeGreaterThanOrEqual(1);
      expect(cleanupCalls[0][1]).toEqual({ recursive: true, force: true });
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});
