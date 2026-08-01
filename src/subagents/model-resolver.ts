import type { LanguageModel } from 'ai';
import { ok, err, type Result } from 'neverthrow';
import { ConfigError } from '../core/errors/index.js';
import type { SubAgentCliConfig, SubAgentSandboxConfig } from '../core/config/config-types.js';
import { CodexSandboxLanguageModel } from './codex-sandbox-language-model.js';
import {
  SubscriptionCliLanguageModel,
  type SubscriptionCliProvider,
} from './subscription-cli-language-model.js';

interface ProviderCredentials {
  apiKey?: string;
  baseURL?: string;
}

interface ModelConfig {
  provider: string;
  name: string;
  maxTokens: number;
}

const INFERENCE_PROVIDERS = ['anthropic', 'openai', 'google', 'ollama'] as const;
const SUBSCRIPTION_CLI_PROVIDERS = ['claude-code'] as const;
const SANDBOXED_SUBSCRIPTION_PROVIDERS = ['codex-sandbox'] as const;

function isInferenceProvider(provider: string): provider is (typeof INFERENCE_PROVIDERS)[number] {
  return (INFERENCE_PROVIDERS as readonly string[]).includes(provider);
}

function isSubscriptionCliProvider(
  provider: string,
): provider is (typeof SUBSCRIPTION_CLI_PROVIDERS)[number] {
  return (SUBSCRIPTION_CLI_PROVIDERS as readonly string[]).includes(provider);
}

function isSandboxedSubscriptionProvider(
  provider: string,
): provider is (typeof SANDBOXED_SUBSCRIPTION_PROVIDERS)[number] {
  return (SANDBOXED_SUBSCRIPTION_PROVIDERS as readonly string[]).includes(provider);
}

export class ModelResolver {
  constructor(
    private readonly providers: Record<string, ProviderCredentials>,
    private readonly subscriptionCli: SubAgentCliConfig = {
      claudeCode: { enabled: false, command: 'claude' },
    },
    private readonly sandbox: SubAgentSandboxConfig = {
      codex: { enabled: false, endpoint: 'http://codex-runner:9700' },
    },
  ) {}

  async resolve(config: ModelConfig): Promise<Result<LanguageModel, ConfigError>> {
    if (isSubscriptionCliProvider(config.provider)) {
      return this.resolveSubscriptionCli(config.provider, config.name);
    }

    if (isSandboxedSubscriptionProvider(config.provider)) {
      return this.resolveCodexSandbox(config.name);
    }

    if (!isInferenceProvider(config.provider)) {
      return err(
        new ConfigError(
          `Unsupported sub-agent model provider "${config.provider}". ` +
            `Supported providers: ${[
              ...INFERENCE_PROVIDERS,
              ...SUBSCRIPTION_CLI_PROVIDERS,
              ...SANDBOXED_SUBSCRIPTION_PROVIDERS,
            ].join(', ')}. ` +
            'Use "ollama" for OpenAI-compatible sub-agent endpoints.',
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

  private resolveSubscriptionCli(
    provider: SubscriptionCliProvider,
    modelName: string,
  ): Result<LanguageModel, ConfigError> {
    const cli = this.subscriptionCli.claudeCode;

    if (!cli.enabled) {
      return err(
        new ConfigError(
          `Subscription CLI provider "${provider}" is disabled. Enable subagentCli.claudeCode in talond.yaml.`,
        ),
      );
    }

    return ok(
      new SubscriptionCliLanguageModel({
        provider,
        modelName,
        command: cli.command,
      }),
    );
  }

  private resolveCodexSandbox(modelName: string): Result<LanguageModel, ConfigError> {
    const codex = this.sandbox.codex;
    if (!codex.enabled || codex.token === undefined) {
      return err(
        new ConfigError(
          'Sandboxed subscription provider "codex-sandbox" is disabled. Enable subagentSandbox.codex with a runner token in talond.yaml.',
        ),
      );
    }

    return ok(
      new CodexSandboxLanguageModel({
        modelName,
        endpoint: codex.endpoint,
        token: codex.token,
      }),
    );
  }

  private async createModel(
    provider: (typeof INFERENCE_PROVIDERS)[number],
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
