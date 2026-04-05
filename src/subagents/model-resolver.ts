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

export class ModelResolver {
  constructor(private readonly providers: Record<string, ProviderCredentials>) {}

  async resolve(config: ModelConfig): Promise<Result<LanguageModel, ConfigError>> {
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
        new ConfigError(
          `Failed to create model for ${config.provider}/${config.name}: ${message}`,
        ),
      );
    }
  }

  private async createModel(
    provider: string,
    creds: ProviderCredentials,
    modelName: string,
  ): Promise<LanguageModel> {
    switch (provider) {
      case 'anthropic': {
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        return createAnthropic({ apiKey: creds.apiKey! })(modelName);
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
        const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
        const baseURL = creds.baseURL ?? 'http://localhost:11434/v1';
        return createOpenAICompatible({ name: 'ollama', baseURL, apiKey: 'ollama' })(modelName);
      }
      default:
        throw new Error(
          `Unsupported provider: "${provider}". Supported: anthropic, openai, google, ollama`,
        );
    }
  }
}
