import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleProvider } from '../../../src/providers/openai-compatible-provider.js';
import type { AgentStreamEvent } from '../../../src/providers/provider.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const { spawn: mockedSpawn } = await import('node:child_process');

interface FakeChildOptions {
  stdoutLines: string[];
  stderr?: string;
  exitCode?: number;
  delayMs?: number;
}

function makeFakeChild(options: FakeChildOptions): EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  stdin: PassThrough;
  kill: (signal?: string) => boolean;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: PassThrough;
    kill: (signal?: string) => boolean;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.kill = vi.fn().mockReturnValue(true);

  const exitCode = options.exitCode ?? 0;
  const delayMs = options.delayMs ?? 0;

  setTimeout(() => {
    for (const line of options.stdoutLines) {
      stdout.write(`${line}\n`);
    }
    if (options.stderr) {
      stderr.write(options.stderr);
    }
    stdout.end();
    stderr.end();
    // The agent-runner expects `close` with the exit code after the streams end.
    setImmediate(() => {
      child.emit('close', exitCode);
    });
  }, delayMs);

  return child;
}

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

  it('can report an alias provider name', () => {
    const provider = new OpenAiCompatibleProvider(
      {
        enabled: true,
        command: 'node',
        contextWindowTokens: 256_000,
        options: {
          defaultModel: 'qwen3-coder:30b',
          baseUrl: 'http://127.0.0.1:11434/v1',
        },
      },
      {},
      'ollama-mac',
    );

    expect(provider.name).toBe('ollama-mac');
  });

  it('forwards options.toolOutputCap to the wrapper payload when configured', () => {
    const provider = new OpenAiCompatibleProvider({
      enabled: true,
      command: 'node',
      contextWindowTokens: 8_000,
      options: {
        defaultModel: 'qwen2.5-coder:7b',
        baseUrl: 'http://127.0.0.1:11434/v1',
        toolOutputCap: 2048,
      },
    });
    const result = provider.prepareBackgroundInvocation({
      prompt: 'hi',
      systemPrompt: 's',
      mcpServers: {},
      cwd: '/tmp',
      timeoutMs: 10_000,
      model: 'qwen2.5-coder:7b',
    });
    expect(result.isOk()).toBe(true);
    const payload = JSON.parse(result._unsafeUnwrap().stdin) as Record<string, unknown>;
    expect(payload.toolOutputCap).toBe(2048);
  });

  it('wraps options.providerOptions under the configured providerId', () => {
    const provider = new OpenAiCompatibleProvider({
      enabled: true,
      type: 'openai-compatible',
      command: 'node',
      contextWindowTokens: 128_000,
      options: {
        defaultModel: 'qwen3-coder:30b',
        baseUrl: 'http://mac.local:11434/v1',
        providerId: 'ollama-mac',
        providerOptions: {
          chat_template_kwargs: {
            enable_thinking: false,
          },
        },
      },
    });

    const result = provider.prepareBackgroundInvocation({
      prompt: 'hi',
      systemPrompt: 's',
      mcpServers: {},
      cwd: '/tmp',
      timeoutMs: 10_000,
      model: 'qwen3-coder:30b',
    });

    expect(result.isOk()).toBe(true);
    const payload = JSON.parse(result._unsafeUnwrap().stdin) as Record<string, unknown>;
    expect(payload.providerId).toBe('ollama-mac');
    expect(payload.providerOptions).toEqual({
      'ollama-mac': {
        chat_template_kwargs: {
          enable_thinking: false,
        },
      },
    });
  });

  it('creates a stateless streaming SDK execution strategy for foreground runs', () => {
    const provider = makeProvider();
    const strategy = provider.createExecutionStrategy();

    expect(strategy.type).toBe('sdk');
    expect(strategy.supportsSessionResumption).toBe(false);
    expect(typeof strategy.run).toBe('function');
  });

  it('creates a resumable SDK strategy when oMLX Responses mode is enabled', () => {
    const provider = new OpenAiCompatibleProvider({
      enabled: true,
      command: 'node',
      contextWindowTokens: 256_000,
      options: {
        defaultModel: 'qwen3.5-9b-optiq-4bit',
        baseUrl: 'http://127.0.0.1:8000/v1',
        omlxResponses: true,
      },
    });

    const strategy = provider.createExecutionStrategy();

    expect(strategy.type).toBe('sdk');
    expect(strategy.supportsSessionResumption).toBe(true);
  });

  it('passes oMLX Responses mode and previous response ids to the wrapper payload', async () => {
    const capturedStdin: string[] = [];
    vi.mocked(mockedSpawn).mockImplementation((() => {
      const child = makeFakeChild({
        stdoutLines: [
          JSON.stringify({
            type: 'result',
            output: 'ok',
            sessionId: 'resp-new',
            usage: { inputTokens: 5, outputTokens: 1 },
          }),
        ],
      });
      child.stdin.on('data', (chunk: Buffer) => {
        capturedStdin.push(chunk.toString('utf8'));
      });
      return child;
    }) as unknown as typeof mockedSpawn);

    const provider = new OpenAiCompatibleProvider({
      enabled: true,
      command: 'node',
      contextWindowTokens: 256_000,
      options: {
        defaultModel: 'qwen3.5-9b-optiq-4bit',
        baseUrl: 'http://127.0.0.1:8000/v1',
        omlxResponses: true,
      },
    });
    const strategy = provider.createExecutionStrategy();
    const events: AgentStreamEvent[] = [];

    for await (const event of strategy.run({
      threadId: 'thread-test',
      prompt: 'continue',
      systemPrompt: 'system',
      mcpServers: {},
      cwd: '/tmp',
      model: 'qwen3.5-9b-optiq-4bit',
      maxTurns: 10,
      timeoutMs: 5_000,
      sessionId: 'resp-prev',
    })) {
      events.push(event);
    }

    const payload = JSON.parse(capturedStdin.join('')) as Record<string, unknown>;
    expect(payload.omlxResponses).toBe(true);
    expect(payload.previousResponseId).toBe('resp-prev');
    expect(payload.maxSteps).toBe(10);
    expect(payload.threadId).toBe('thread-test');

    const resultEvent = events.find((event) => event.type === 'result');
    expect(resultEvent).toBeDefined();
    if (resultEvent?.type === 'result') {
      expect(resultEvent.result.sessionId).toBe('resp-new');
    }
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
      'OpenAI-compatible provider requires providers.<name>.options.baseUrl, or auth.providers.<options.providerId>.baseURL, or auth.providers.openai-compatible.baseURL',
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
    // Background invocations allocate a temp result file that must be
    // cleaned up after the run and threaded to the background runner via
    // resultFiles.lastMessagePath.
    expect(invocation.cleanupPaths).toHaveLength(2);
    expect(invocation.cleanupPaths[0]).toMatch(/talon-openai-compat-.*\/last-message\.txt$/);
    expect(invocation.resultFiles?.lastMessagePath).toBe(invocation.cleanupPaths[0]);
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
      // Background invocations must disable streaming so the wrapper emits
      // only the terminal result/error event — otherwise the background
      // stdout buffer (100KB) could truncate away the summary line.
      streamEvents: false,
    });
    // The wrapper must receive the same result-file path the background
    // runner will later read from, so large outputs bypass the stdout cap.
    expect(payload.outputFilePath).toBe(invocation.resultFiles?.lastMessagePath);
    // toolOutputCap is omitted from the payload when not configured so the
    // wrapper falls back to its internal default.
    expect(payload).not.toHaveProperty('toolOutputCap');
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

  it('parses NDJSON wrapper events into normalized background output and usage', () => {
    const provider = makeProvider();

    const stdout = [
      JSON.stringify({ type: 'text', content: 'Completed ' }),
      JSON.stringify({ type: 'text', content: 'successfully.' }),
      JSON.stringify({
        type: 'tool_event',
        messageType: 'tool_use',
        tool: 'fs.read',
        toolUseId: 'call-1',
        input: { path: '/tmp' },
      }),
      JSON.stringify({
        type: 'result',
        output: 'Completed successfully.',
        usage: { inputTokens: 120, outputTokens: 24 },
      }),
      '',
    ].join('\n');

    const result = provider.parseBackgroundResult({
      stdout,
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
        cacheReadTokens: undefined,
      },
    });
  });

  it('surfaces wrapper stderr and structured error events when the child fails', () => {
    const provider = makeProvider();

    const stdout = [
      JSON.stringify({ type: 'text', content: 'partial' }),
      JSON.stringify({ type: 'error', message: 'AI_APICallError: Unauthorized' }),
      '',
    ].join('\n');

    const result = provider.parseBackgroundResult({
      stdout,
      stderr: '  AI_APICallError: Unauthorized\n    at postToApi (...)  ',
      exitCode: 1,
      timedOut: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe('');
    expect(result.stderr).toContain('AI_APICallError: Unauthorized');
    expect(result.stderr).toContain('at postToApi');
    expect(result.usage).toBeUndefined();
  });

  it('streams NDJSON wrapper events as AgentStreamEvents and yields a terminal result', async () => {
    vi.mocked(mockedSpawn).mockImplementation((() =>
      makeFakeChild({
        stdoutLines: [
          JSON.stringify({ type: 'text', content: 'Hel' }),
          JSON.stringify({ type: 'text', content: 'lo.' }),
          JSON.stringify({
            type: 'tool_event',
            messageType: 'tool_use',
            tool: 'fs.read',
            toolUseId: 'call-1',
            input: { path: '/tmp' },
          }),
          JSON.stringify({
            type: 'result',
            output: 'Hello.',
            usage: { inputTokens: 42, outputTokens: 7 },
          }),
        ],
      })) as unknown as typeof mockedSpawn);

    const provider = makeProvider();
    const strategy = provider.createExecutionStrategy();
    const events: AgentStreamEvent[] = [];

    for await (const event of strategy.run({
      threadId: 'thread-test',
      prompt: 'hello',
      systemPrompt: 'system',
      mcpServers: {},
      cwd: '/tmp',
      model: 'qwen3-coder:30b',
      maxTurns: 10,
      timeoutMs: 5_000,
    })) {
      events.push(event);
    }

    const textEvents = events.filter((e) => e.type === 'text');
    expect(textEvents).toEqual([
      { type: 'text', content: 'Hel' },
      { type: 'text', content: 'lo.' },
    ]);

    const toolEvents = events.filter((e) => e.type === 'tool_event');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]).toMatchObject({
      type: 'tool_event',
      messageType: 'tool_use',
      tool: 'fs.read',
      toolUseId: 'call-1',
    });

    const resultEvent = events.find((e) => e.type === 'result');
    expect(resultEvent).toBeDefined();
    if (resultEvent?.type === 'result') {
      expect(resultEvent.result.output).toBe('Hello.');
      expect(resultEvent.result.usage).toEqual({
        inputTokens: 42,
        outputTokens: 7,
        cacheReadTokens: undefined,
      });
      expect(resultEvent.result.isError).toBe(false);
    }

    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('propagates tool-output excerpt telemetry (truncated/originalChars/excerptChars) across the wrapper boundary', async () => {
    // The wrapper emits a single enriched tool_result event with the
    // excerpting telemetry; the provider must forward those fields onto
    // AgentStreamEvent so downstream observability (Langfuse, audit log)
    // can count truncation rate without losing the original-size signal.
    vi.mocked(mockedSpawn).mockImplementation((() =>
      makeFakeChild({
        stdoutLines: [
          JSON.stringify({
            type: 'tool_event',
            messageType: 'tool_result',
            tool: 'mcp_read_file',
            toolUseId: 'call-42',
            output: '…excerpt…',
            truncated: true,
            originalChars: 51234,
            excerptChars: 3987,
          }),
          JSON.stringify({
            type: 'result',
            output: 'done',
            usage: { inputTokens: 10, outputTokens: 2 },
          }),
        ],
      })) as unknown as typeof mockedSpawn);

    const provider = makeProvider();
    const strategy = provider.createExecutionStrategy();
    const events: AgentStreamEvent[] = [];
    for await (const event of strategy.run({
      threadId: 'thread-t',
      prompt: 'x',
      systemPrompt: 's',
      mcpServers: {},
      cwd: '/tmp',
      model: 'qwen3-coder:30b',
      maxTurns: 10,
      timeoutMs: 5_000,
    })) {
      events.push(event);
    }

    const toolEvents = events.filter((e) => e.type === 'tool_event');
    // Single event only — no duplicate from a synthetic wrapper emit.
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]).toMatchObject({
      type: 'tool_event',
      messageType: 'tool_result',
      toolUseId: 'call-42',
      truncated: true,
      originalChars: 51234,
      excerptChars: 3987,
    });
  });

  it('sends streamEvents=true to the wrapper when the foreground strategy spawns the child', async () => {
    const capturedStdin: string[] = [];
    vi.mocked(mockedSpawn).mockImplementation((() => {
      const child = makeFakeChild({
        stdoutLines: [
          JSON.stringify({
            type: 'result',
            output: 'ok',
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        ],
      });
      child.stdin.on('data', (chunk: Buffer) => {
        capturedStdin.push(chunk.toString('utf8'));
      });
      return child;
    }) as unknown as typeof mockedSpawn);

    const provider = makeProvider();
    const strategy = provider.createExecutionStrategy();

    // Drain the generator so the child receives stdin.
    for await (const _event of strategy.run({
      threadId: 'thread-test',
      prompt: 'hello',
      systemPrompt: 'system',
      mcpServers: {},
      cwd: '/tmp',
      model: 'qwen3-coder:30b',
      maxTurns: 10,
      timeoutMs: 5_000,
    })) {
      void _event;
    }

    const stdinJoined = capturedStdin.join('');
    expect(stdinJoined.length).toBeGreaterThan(0);
    const payload = JSON.parse(stdinJoined) as Record<string, unknown>;
    expect(payload.streamEvents).toBe(true);
  });

  it('emits an error stream event containing stderr when the wrapper exits non-zero', async () => {
    vi.mocked(mockedSpawn).mockImplementation((() =>
      makeFakeChild({
        stdoutLines: [],
        stderr: 'AI_APICallError: Unauthorized\n    at postToApi (...)',
        exitCode: 1,
      })) as unknown as typeof mockedSpawn);

    const provider = makeProvider();
    const strategy = provider.createExecutionStrategy();
    const events: AgentStreamEvent[] = [];

    for await (const event of strategy.run({
      threadId: 'thread-test',
      prompt: 'hello',
      systemPrompt: 'system',
      mcpServers: {},
      cwd: '/tmp',
      model: 'qwen3-coder:30b',
      maxTurns: 10,
      timeoutMs: 5_000,
    })) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.message).toContain('AI_APICallError: Unauthorized');
    }
  });

  it('does not leak an unhandled rejection when the consumer cancels the generator early', async () => {
    // Reproduces the early-termination cleanup path: the child is still
    // running (no close event yet) when the caller breaks out of the for-await
    // loop. The finally block should clean up synchronously, and the pending
    // closePromise (which will later resolve/reject when the mock child
    // eventually closes) must not surface as an unhandled rejection.
    vi.mocked(mockedSpawn).mockImplementation((() =>
      makeFakeChild({
        stdoutLines: [
          JSON.stringify({ type: 'text', content: 'start' }),
          JSON.stringify({ type: 'text', content: ' middle' }),
          JSON.stringify({
            type: 'result',
            output: 'start middle end',
            usage: { inputTokens: 1, outputTokens: 3 },
          }),
        ],
        delayMs: 0,
      })) as unknown as typeof mockedSpawn);

    const unhandled: unknown[] = [];
    const handler = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', handler);

    try {
      const provider = makeProvider();
      const strategy = provider.createExecutionStrategy();
      const iterator = strategy
        .run({
          threadId: 'thread-test',
          prompt: 'hello',
          systemPrompt: 'system',
          mcpServers: {},
          cwd: '/tmp',
          model: 'qwen3-coder:30b',
          maxTurns: 10,
          timeoutMs: 5_000,
        })
        [Symbol.asyncIterator]();

      const first = await iterator.next();
      expect(first.done).toBe(false);
      // Abandon the iterator — triggers finally-based cleanup.
      if (iterator.return) {
        await iterator.return(undefined);
      }

      // Allow any queued microtasks (close event handlers, no-op catches) to run.
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
    } finally {
      process.off('unhandledRejection', handler);
    }

    expect(unhandled).toEqual([]);
  });

  describe('file-based background result transport', () => {
    const tempPaths: string[] = [];

    afterEach(() => {
      for (const path of tempPaths) {
        rmSync(path, { recursive: true, force: true });
      }
      tempPaths.length = 0;
    });

    it('reads the aggregated output from resultFiles.lastMessagePath when present', () => {
      const dir = mkdtempSync(join(tmpdir(), 'openai-compat-test-'));
      tempPaths.push(dir);
      const lastMessagePath = join(dir, 'last-message.txt');
      // Intentionally larger than the 100KB stdout cap to prove the file
      // transport is immune to it.
      const bigOutput = 'A'.repeat(200 * 1024);
      writeFileSync(lastMessagePath, bigOutput, 'utf8');

      const provider = makeProvider();

      // Background mode: stdout contains only the tiny terminal envelope
      // (usage, empty output) because the real content went to the file.
      const stdout = `${JSON.stringify({
        type: 'result',
        output: '',
        usage: { inputTokens: 500, outputTokens: 2048 },
      })}\n`;

      const result = provider.parseBackgroundResult(
        {
          stdout,
          stderr: '',
          exitCode: 0,
          timedOut: false,
        },
        { lastMessagePath },
      );

      expect(result.exitCode).toBe(0);
      expect(result.output).toBe(bigOutput);
      expect(result.usage).toEqual({
        inputTokens: 500,
        outputTokens: 2048,
        cacheReadTokens: undefined,
      });
    });

    it('falls back to the stdout envelope when the result file is missing', () => {
      const provider = makeProvider();
      const missingPath = join(tmpdir(), `openai-compat-missing-${Date.now()}.txt`);

      const result = provider.parseBackgroundResult(
        {
          stdout: `${JSON.stringify({
            type: 'result',
            output: 'fallback from stdout',
            usage: { inputTokens: 10, outputTokens: 5 },
          })}\n`,
          stderr: '',
          exitCode: 0,
          timedOut: false,
        },
        { lastMessagePath: missingPath },
      );

      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('fallback from stdout');
    });
  });

  it('flags the background result as failed when no result event is emitted even though exit is zero', () => {
    const provider = makeProvider();

    const result = provider.parseBackgroundResult({
      stdout: `${JSON.stringify({ type: 'text', content: 'only text' })}\n`,
      stderr: 'wrapper exited without emitting a result event',
      exitCode: 0,
      timedOut: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe('');
    expect(result.stderr).toContain('wrapper exited without emitting a result event');
  });

  describe('estimateContextUsage', () => {
    it('derives cache_creation_input_tokens from input - cache reads when the upstream reports caching', () => {
      // OpenAI-compatible servers that honour prompt caching (OpenAI,
      // DeepSeek, GLM, vLLM with prefix caching, …) set
      // prompt_tokens_details.cached_tokens on the usage object. The
      // Mastra AI-SDK wrapper maps it onto cachedInputTokens, our usage
      // extractor maps it onto AgentUsage.cacheReadTokens, and this
      // method must then expose all four cache metrics so the context
      // roller and Langfuse observations see them.
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

    it('falls back to zero cache metrics for upstreams that do not report caching (Ollama, Groq, …)', () => {
      // Ollama self-hosted and Ollama Cloud do not populate
      // prompt_tokens_details in their OpenAI-compatible response, and
      // neither do Groq/Together. cacheReadTokens is therefore undefined
      // and the three cache metrics must degrade gracefully:
      // cache_read stays zero, cache_creation = input_tokens, and
      // cache_total = input_tokens.
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

    it('handles the zero-input edge case without going negative', () => {
      const provider = makeProvider();

      expect(
        provider.estimateContextUsage({
          inputTokens: 0,
          outputTokens: 0,
        }),
      ).toEqual({
        inputTokens: 0,
        metrics: {
          input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_total_input_tokens: 0,
        },
      });
    });
  });
});
