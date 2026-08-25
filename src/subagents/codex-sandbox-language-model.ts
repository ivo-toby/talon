/**
 * AI SDK model adapter for a separately deployed, externally contained Codex
 * runner. Talon supplies only a bounded generation request over HTTP; Codex
 * itself never runs in the daemon process or receives Talon host tools.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import {
  CodexSandboxGenerateResponseSchema,
  type CodexSandboxGenerateRequest,
} from './codex-sandbox-protocol.js';

export interface CodexSandboxModelConfig {
  modelName: string;
  endpoint: string;
  token: string;
}

export type CodexSandboxFetch = typeof fetch;

interface PromptParts {
  system: string;
  user: string;
}

const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

export class CodexSandboxLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const;
  readonly provider = 'codex-sandbox';
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  constructor(
    private readonly config: CodexSandboxModelConfig,
    private readonly fetchImpl: CodexSandboxFetch = fetch,
  ) {
    this.modelId = config.modelName;
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const prompt = extractPromptParts(options.prompt);
    const request: CodexSandboxGenerateRequest = {
      model: this.modelId,
      systemPrompt: prompt.system,
      userPrompt: prompt.user,
      ...(responseSchema(options) === undefined ? {} : { outputSchema: responseSchema(options) }),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.endpoint.replace(/\/$/u, '')}/v1/generate`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: options.abortSignal,
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Codex sandbox runner request failed: ${detail}`);
    }

    const payload: unknown = await response.json().catch(() => null);
    const parsed = CodexSandboxGenerateResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(
        `Codex sandbox runner returned an invalid response (${response.status} ${response.statusText})`,
      );
    }

    if (!response.ok || !parsed.data.ok) {
      const detail = parsed.data.ok ? response.statusText : parsed.data.error;
      throw new Error(`Codex sandbox runner rejected the generation: ${detail}`);
    }

    return {
      content: [{ type: 'text', text: parsed.data.text }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: {
          ...EMPTY_USAGE.inputTokens,
          total: parsed.data.usage?.inputTokens,
        },
        outputTokens: {
          ...EMPTY_USAGE.outputTokens,
          total: parsed.data.usage?.outputTokens,
          text: parsed.data.usage?.outputTokens,
        },
      },
      warnings:
        options.maxOutputTokens === undefined
          ? []
          : [
              {
                type: 'unsupported',
                feature: 'maxOutputTokens',
                details:
                  'Codex App Server does not expose a Talon-enforced hard output-token limit; the sub-agent timeout remains enforced.',
              },
            ],
    };
  }

  doStream(_options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    return Promise.reject(new Error('Codex sandbox sub-agent models do not support streaming'));
  }
}

function extractPromptParts(prompt: LanguageModelV3Prompt): PromptParts {
  const system: string[] = [];
  const user: string[] = [];

  for (const message of prompt) {
    if (message.role === 'system') {
      system.push(message.content);
      continue;
    }

    if (message.role === 'user') {
      for (const part of message.content) {
        if (part.type !== 'text') {
          throw new Error('Codex sandbox sub-agent models support text prompts only');
        }
        user.push(part.text);
      }
      continue;
    }

    throw new Error('Codex sandbox sub-agent models support a single system/user prompt only');
  }

  return { system: system.join('\n\n'), user: user.join('\n\n') };
}

function responseSchema(options: LanguageModelV3CallOptions): unknown {
  return options.responseFormat?.type === 'json' ? options.responseFormat.schema : undefined;
}
