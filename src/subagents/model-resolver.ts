import type { LanguageModel } from 'ai';
import { ok, err, type Result } from 'neverthrow';
import { ConfigError } from '../core/errors/index.js';

interface ProviderCredentials {
  apiKey?: string;
  baseURL?: string;
}

interface ModelConfig {
  provider: string;
  name: string;
  maxTokens: number;
}

const SUPPORTED_PROVIDERS = ['anthropic', 'openai', 'google', 'ollama'] as const;

function isSupportedProvider(provider: string): provider is (typeof SUPPORTED_PROVIDERS)[number] {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(provider);
}

export class ModelResolver {
  constructor(private readonly providers: Record<string, ProviderCredentials>) {}

  async resolve(config: ModelConfig): Promise<Result<LanguageModel, ConfigError>> {
    if (!isSupportedProvider(config.provider)) {
      return err(
        new ConfigError(
          `Unsupported sub-agent model provider "${config.provider}". ` +
            `Sub-agents use AI SDK model providers: ${SUPPORTED_PROVIDERS.join(', ')}. ` +
            `Agent runtime providers such as codex-cli, claude-code, gemini-cli, and openai-compatible cannot be used here; ` +
            `use "ollama" for OpenAI-compatible sub-agent endpoints.`,
        ),
      );
    }

    const creds = this.providers[config.provider];
    if (!creds) {
      return err(
        new ConfigError(
          `No credentials for provider "${config.provider}". Add auth.providers.${config.provider} to talond.yaml`,
        ),
      );
    }

    // Validate that apiKey is present for providers that require it.
    if (config.provider !== 'ollama' && !creds.apiKey) {
      return err(
        new ConfigError(
          `Missing apiKey for provider "${config.provider}". Set auth.providers.${config.provider}.apiKey in talond.yaml`,
        ),
      );
    }

    try {
      const model = await this.createModel(config.provider, creds, config.name);
      return ok(model);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(
        new ConfigError(`Failed to create model for ${config.provider}/${config.name}: ${message}`),
      );
    }
  }

  private async createModel(
    provider: (typeof SUPPORTED_PROVIDERS)[number],
    creds: ProviderCredentials,
    modelName: string,
  ): Promise<LanguageModel> {
    switch (provider) {
      case 'anthropic': {
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        return createAnthropic({
          apiKey: creds.apiKey!,
          baseURL: creds.baseURL ?? 'https://api.anthropic.com/v1',
        })(modelName);
      }
      case 'openai': {
        const { createOpenAI } = await import('@ai-sdk/openai');
        return createOpenAI({ apiKey: creds.apiKey!, baseURL: creds.baseURL })(modelName);
      }
      case 'google': {
        const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
        return createGoogleGenerativeAI({ apiKey: creds.apiKey! })(modelName);
      }
      case 'ollama': {
        // Use @ai-sdk/openai-compatible so arbitrary request body fields
        // (e.g. Qwen's chat_template_kwargs.enable_thinking) can flow through
        // via providerOptions. The @ai-sdk/openai typed options do not allow
        // non-standard fields.
        //
        // `creds.apiKey` is forwarded when set (required for Ollama Cloud and
        // any authenticated OpenAI-compatible endpoint) and falls back to a
        // dummy 'ollama' value for local ollama / llama.cpp / vLLM which
        // either ignore auth or accept any token.
        const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
        const baseURL = creds.baseURL ?? 'http://localhost:11434/v1';
        return createOpenAICompatible({
          name: 'ollama',
          baseURL,
          apiKey: creds.apiKey ?? 'ollama',
        })(modelName);
      }
    }
  }
}
