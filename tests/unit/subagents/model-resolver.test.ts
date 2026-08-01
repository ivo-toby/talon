import { afterEach, describe, expect, it } from 'vitest';
import { ModelResolver } from '../../../src/subagents/model-resolver.js';

describe('ModelResolver', () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_BASE_URL;
  });

  it('resolves an anthropic model', async () => {
    const resolver = new ModelResolver({ anthropic: { apiKey: 'sk-ant-test' } });
    const result = await resolver.resolve({
      provider: 'anthropic',
      name: 'claude-haiku-4-5-20251001',
      maxTokens: 2048,
    });
    expect(result.isOk()).toBe(true);
    const model = result._unsafeUnwrap();
    expect(model).toBeTruthy();
    expect(model.modelId).toBe('claude-haiku-4-5-20251001');
  });

  it('does not let ambient ANTHROPIC_BASE_URL reroute configured anthropic models', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:11434';
    const resolver = new ModelResolver({ anthropic: { apiKey: 'sk-ant-test' } });

    const result = await resolver.resolve({
      provider: 'anthropic',
      name: 'claude-sonnet-4-6',
      maxTokens: 2048,
    });

    expect(result.isOk()).toBe(true);
    const model = result._unsafeUnwrap() as unknown as { config?: { baseURL?: string } };
    expect(model.config?.baseURL).toBe('https://api.anthropic.com/v1');
  });

  it('uses explicit auth.providers.anthropic.baseURL when configured', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:11434';
    const resolver = new ModelResolver({
      anthropic: { apiKey: 'sk-ant-test', baseURL: 'https://proxy.example.com/v1' },
    });

    const result = await resolver.resolve({
      provider: 'anthropic',
      name: 'claude-sonnet-4-6',
      maxTokens: 2048,
    });

    expect(result.isOk()).toBe(true);
    const model = result._unsafeUnwrap() as unknown as { config?: { baseURL?: string } };
    expect(model.config?.baseURL).toBe('https://proxy.example.com/v1');
  });

  it('resolves an openai model', async () => {
    const resolver = new ModelResolver({ openai: { apiKey: 'sk-oai-test' } });
    const result = await resolver.resolve({
      provider: 'openai',
      name: 'gpt-4o-mini',
      maxTokens: 2048,
    });
    expect(result.isOk()).toBe(true);
    const model = result._unsafeUnwrap();
    expect(model.modelId).toBe('gpt-4o-mini');
  });

  it('resolves a google model', async () => {
    const resolver = new ModelResolver({ google: { apiKey: 'google-test' } });
    const result = await resolver.resolve({
      provider: 'google',
      name: 'gemini-2.0-flash',
      maxTokens: 2048,
    });
    expect(result.isOk()).toBe(true);
    const model = result._unsafeUnwrap();
    expect(model.modelId).toBe('gemini-2.0-flash');
  });

  it('resolves an ollama model via OpenAI-compatible endpoint (no apiKey needed)', async () => {
    const resolver = new ModelResolver({ ollama: { baseURL: 'http://localhost:11434/v1' } });
    const result = await resolver.resolve({ provider: 'ollama', name: 'llama3', maxTokens: 2048 });
    expect(result.isOk()).toBe(true);
    const model = result._unsafeUnwrap();
    expect(model.modelId).toBe('llama3');
  });

  it('resolves an ollama model with default baseURL when none provided', async () => {
    const resolver = new ModelResolver({ ollama: {} });
    const result = await resolver.resolve({ provider: 'ollama', name: 'llama3', maxTokens: 2048 });
    expect(result.isOk()).toBe(true);
  });

  it('resolves an ollama model with a real apiKey (Ollama Cloud / authenticated endpoints)', async () => {
    // The ollama slot is Talon's OpenAI-compatible passthrough. When creds.apiKey
    // is set, the resolver must forward it instead of the dummy 'ollama' fallback,
    // otherwise authenticated endpoints like Ollama Cloud reject every request.
    const resolver = new ModelResolver({
      ollama: {
        baseURL: 'https://ollama.com',
        apiKey: 'real-cloud-token',
      },
    });
    const result = await resolver.resolve({
      provider: 'ollama',
      name: 'qwen3-30b',
      maxTokens: 2048,
    });
    expect(result.isOk()).toBe(true);
    const model = result._unsafeUnwrap();
    expect(model.modelId).toBe('qwen3-30b');
  });

  it('returns error for unknown provider', async () => {
    const resolver = new ModelResolver({});
    const result = await resolver.resolve({ provider: 'unknown', name: 'model', maxTokens: 2048 });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Unsupported sub-agent model provider');
  });

  it('returns error when provider has no credentials configured', async () => {
    const resolver = new ModelResolver({});
    const result = await resolver.resolve({
      provider: 'anthropic',
      name: 'claude-haiku-4-5-20251001',
      maxTokens: 2048,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('credentials');
  });

  it('returns error for unsupported but configured provider', async () => {
    const resolver = new ModelResolver({ mycustom: { apiKey: 'key' } });
    const result = await resolver.resolve({ provider: 'mycustom', name: 'model', maxTokens: 2048 });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Unsupported');
  });

  it('returns a clear error when a subscription CLI provider is disabled', async () => {
    const resolver = new ModelResolver({});
    const result = await resolver.resolve({
      provider: 'claude-code',
      name: 'sonnet',
      maxTokens: 2048,
    });
    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('Subscription CLI provider "claude-code" is disabled');
    expect(message).toContain('subagentCli.claudeCode');
  });

  it('resolves an enabled Claude Code subscription model without API credentials', async () => {
    const resolver = new ModelResolver(
      {},
      {
        claudeCode: { enabled: true, command: '/usr/local/bin/claude' },
      },
    );

    const claude = await resolver.resolve({
      provider: 'claude-code',
      name: 'sonnet',
      maxTokens: 2048,
    });
    expect(claude.isOk()).toBe(true);
    expect(claude._unsafeUnwrap().provider).toBe('claude-code');
    expect(claude._unsafeUnwrap().modelId).toBe('sonnet');
  });

  it('resolves an enabled contained Codex subscription model without API credentials', async () => {
    const resolver = new ModelResolver(
      {},
      { claudeCode: { enabled: false, command: 'claude' } },
      {
        codex: {
          enabled: true,
          endpoint: 'http://codex-runner:9700',
          token: 't'.repeat(32),
        },
      },
    );

    const codex = await resolver.resolve({
      provider: 'codex-sandbox',
      name: 'gpt-5.6-terra',
      maxTokens: 2048,
    });

    expect(codex.isOk()).toBe(true);
    expect(codex._unsafeUnwrap().provider).toBe('codex-sandbox');
    expect(codex._unsafeUnwrap().modelId).toBe('gpt-5.6-terra');
  });

  it('returns a clear error when a Codex sandbox runner is disabled', async () => {
    const resolver = new ModelResolver({});
    const result = await resolver.resolve({
      provider: 'codex-sandbox',
      name: 'gpt-5.6-terra',
      maxTokens: 2048,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('subagentSandbox.codex');
  });

  it('returns error when apiKey is missing for a provider that requires it', async () => {
    const resolver = new ModelResolver({ anthropic: { baseURL: 'https://example.com' } });
    const result = await resolver.resolve({
      provider: 'anthropic',
      name: 'claude-haiku-4-5-20251001',
      maxTokens: 2048,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Missing apiKey');
  });

  it('returns error when openai apiKey is missing', async () => {
    const resolver = new ModelResolver({ openai: {} });
    const result = await resolver.resolve({
      provider: 'openai',
      name: 'gpt-4o-mini',
      maxTokens: 2048,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Missing apiKey');
  });

  it('returns error when google apiKey is missing', async () => {
    const resolver = new ModelResolver({ google: {} });
    const result = await resolver.resolve({
      provider: 'google',
      name: 'gemini-2.0-flash',
      maxTokens: 2048,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Missing apiKey');
  });
});
