import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateObject } from 'ai';
import { z } from 'zod';
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import {
  SubscriptionCliLanguageModel,
  executeSubscriptionCli,
  type SubscriptionCliExecutor,
} from '../../../src/subagents/subscription-cli-language-model.js';

function textOptions(): LanguageModelV3CallOptions {
  return {
    prompt: [
      { role: 'system', content: 'Keep the response short.' },
      { role: 'user', content: [{ type: 'text', text: 'Say hello.' }] },
    ],
  };
}

describe('SubscriptionCliLanguageModel', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs Claude Code as one tool-free, non-persistent subscription turn', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'must-not-reach-cli');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://metered.example/v1');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'must-not-reach-cli');
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'official-subscription-setup-token');
    vi.stubEnv('OPENAI_API_KEY', 'must-not-reach-cli');
    vi.stubEnv('TALON_CHANNEL_SECRET', 'must-not-reach-cli');
    const execute = vi.fn<SubscriptionCliExecutor>().mockResolvedValue({
      stdout: JSON.stringify({
        result: 'Hello from Claude.',
        usage: { input_tokens: 21, output_tokens: 5 },
      }),
      stderr: '',
      exitCode: 0,
    });
    const model = new SubscriptionCliLanguageModel(
      { provider: 'claude-code', modelName: 'sonnet', command: 'claude' },
      execute,
    );

    const result = await model.doGenerate(textOptions());

    expect(result.content).toEqual([{ type: 'text', text: 'Hello from Claude.' }]);
    expect(result.usage.inputTokens.total).toBe(21);
    expect(result.usage.outputTokens.total).toBe(5);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'claude',
        args: expect.arrayContaining([
          '--print',
          '--output-format',
          'json',
          '--no-session-persistence',
          '--safe-mode',
          '--tools',
          '',
          '--max-turns',
          '1',
        ]),
        cwd: expect.stringContaining('talon-subagent-claude-code-'),
        stdin: 'Say hello.',
      }),
    );
    const invocation = execute.mock.calls[0][0];
    expect(invocation.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(invocation.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(invocation.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(invocation.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(invocation.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('official-subscription-setup-token');
    expect(invocation.env.OPENAI_API_KEY).toBeUndefined();
    expect(invocation.env.TALON_CHANNEL_SECRET).toBeUndefined();
  });

  it('presents Claude JSON-schema output to generateObject', async () => {
    const execute = vi.fn<SubscriptionCliExecutor>().mockResolvedValue({
      stdout: JSON.stringify({
        result: 'This text must not be used for schema output.',
        structured_output: { answer: 'ready' },
      }),
      stderr: '',
      exitCode: 0,
    });
    const model = new SubscriptionCliLanguageModel(
      { provider: 'claude-code', modelName: 'sonnet', command: 'claude' },
      execute,
    );

    const result = await generateObject({
      model,
      schema: z.object({ answer: z.string() }),
      system: 'Return JSON only.',
      prompt: 'Is the adapter ready?',
    });

    expect(result.object).toEqual({ answer: 'ready' });
    const args = execute.mock.calls[0][0].args;
    const schemaIndex = args.indexOf('--json-schema');
    expect(schemaIndex).toBeGreaterThan(-1);
    expect(JSON.parse(args[schemaIndex + 1])).toMatchObject({ type: 'object' });
  });

  it('terminates a real subprocess after abort before resolving', async () => {
    const controller = new AbortController();
    const resultPromise = executeSubscriptionCli({
      command: process.execPath,
      args: ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000);"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      stdin: '',
      abortSignal: controller.signal,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    controller.abort();

    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 });
  });
});
