import { describe, expect, it, vi } from 'vitest';
import { generateObject } from 'ai';
import { z } from 'zod';
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import {
  CodexSandboxLanguageModel,
  type CodexSandboxFetch,
} from '../../../src/subagents/codex-sandbox-language-model.js';

function textOptions(): LanguageModelV3CallOptions {
  return {
    prompt: [
      { role: 'system', content: 'Keep the response short.' },
      { role: 'user', content: [{ type: 'text', text: 'Say hello.' }] },
    ],
  };
}

describe('CodexSandboxLanguageModel', () => {
  it('sends only a bounded generation request to the configured runner', async () => {
    const fetchImpl = vi.fn<CodexSandboxFetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, text: 'Hello from the sandbox.', usage: { inputTokens: 8, outputTokens: 4 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const model = new CodexSandboxLanguageModel(
      {
        modelName: 'gpt-5.6-terra',
        endpoint: 'http://codex-runner:9700/',
        token: 't'.repeat(32),
      },
      fetchImpl,
    );

    const result = await model.doGenerate(textOptions());

    expect(result.content).toEqual([{ type: 'text', text: 'Hello from the sandbox.' }]);
    expect(result.usage.inputTokens.total).toBe(8);
    expect(result.usage.outputTokens.total).toBe(4);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://codex-runner:9700/v1/generate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: `Bearer ${'t'.repeat(32)}` }),
      }),
    );
    const request = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(request).toEqual({
      model: 'gpt-5.6-terra',
      systemPrompt: 'Keep the response short.',
      userPrompt: 'Say hello.',
    });
  });

  it('forwards JSON Schema through the runner protocol for generateObject', async () => {
    const fetchImpl = vi.fn<CodexSandboxFetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, text: JSON.stringify({ answer: 'ready' }) }), { status: 200 }),
    );
    const model = new CodexSandboxLanguageModel(
      { modelName: 'gpt-5.6-terra', endpoint: 'http://runner.test', token: 't'.repeat(32) },
      fetchImpl,
    );

    const result = await generateObject({
      model,
      schema: z.object({ answer: z.string() }),
      system: 'Return JSON only.',
      prompt: 'Is the sandbox ready?',
    });

    expect(result.object).toEqual({ answer: 'ready' });
    const request = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(request.outputSchema).toMatchObject({ type: 'object' });
  });

  it('surfaces a fail-closed runner policy rejection', async () => {
    const fetchImpl = vi.fn<CodexSandboxFetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, code: 'POLICY_VIOLATION', error: 'A command tool was attempted' }),
        { status: 422 },
      ),
    );
    const model = new CodexSandboxLanguageModel(
      { modelName: 'gpt-5.6-terra', endpoint: 'http://runner.test', token: 't'.repeat(32) },
      fetchImpl,
    );

    await expect(model.doGenerate(textOptions())).rejects.toThrow('A command tool was attempted');
  });
});
