import { describe, it, expect, vi } from 'vitest';
import {
  buildSubAgentModelChain,
  validateVisionModelChain,
  VISION_SUBAGENT_NAME,
} from '../../../src/subagents/subagent-model-chain.js';
import type { LoadedSubAgent } from '../../../src/subagents/subagent-types.js';
import type { SubAgentsConfig } from '../../../src/core/config/config-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(
  manifestModel: { provider: string; name: string; maxTokens: number } = {
    provider: 'anthropic',
    name: 'claude-haiku-4-5-20251001',
    maxTokens: 2048,
  },
  timeoutMs = 30_000,
): LoadedSubAgent {
  return {
    manifest: {
      name: VISION_SUBAGENT_NAME,
      version: '0.1.0',
      description: 'A test sub-agent',
      model: manifestModel,
      requiredCapabilities: [],
      rootPaths: [],
      timeoutMs,
      requiresEnv: [],
    },
    promptContents: [],
    run: vi.fn(),
    rootDir: '/tmp/subagents/test-agent',
  };
}

// ---------------------------------------------------------------------------
// buildSubAgentModelChain
// ---------------------------------------------------------------------------

describe('buildSubAgentModelChain', () => {
  it('appends the implicit manifest entry after override entries', () => {
    const agent = makeAgent({ provider: 'google', name: 'gemini-2.0-flash', maxTokens: 1024 }, 9_000);
    const override: SubAgentsConfig[string] = {
      model: [
        { provider: 'openai', name: 'gpt-4o' },
        { provider: 'ollama', name: 'qwen3-30b', maxTokens: 4096, timeoutMs: 60_000 },
      ],
    };

    const chain = buildSubAgentModelChain(agent, override);

    expect(chain).toHaveLength(3);
    expect(chain[0]).toMatchObject({
      provider: 'openai',
      name: 'gpt-4o',
      source: 'override',
      // Inherited from the manifest when the override omits them.
      maxTokens: 1024,
      timeoutMs: 9_000,
    });
    expect(chain[1]).toMatchObject({
      provider: 'ollama',
      name: 'qwen3-30b',
      source: 'override',
      maxTokens: 4096,
      timeoutMs: 60_000,
    });
    expect(chain[2]).toMatchObject({
      provider: 'google',
      name: 'gemini-2.0-flash',
      maxTokens: 1024,
      timeoutMs: 9_000,
      source: 'manifest',
    });
  });

  it('returns the manifest entry alone when no override is configured', () => {
    const agent = makeAgent({ provider: 'anthropic', name: 'claude-haiku-4-5', maxTokens: 2048 });

    const chain = buildSubAgentModelChain(agent, undefined);

    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ provider: 'anthropic', source: 'manifest' });
  });

  it('carries providerOptions through per entry without leaking between entries', () => {
    const agent = makeAgent();
    const override: SubAgentsConfig[string] = {
      model: [
        { provider: 'ollama', name: 'qwen', providerOptions: { temperature: 0.2 } },
        { provider: 'anthropic', name: 'claude-haiku-4-5' },
      ],
    };

    const chain = buildSubAgentModelChain(agent, override);

    expect(chain[0].providerOptions).toEqual({ temperature: 0.2 });
    expect(chain[1].providerOptions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateVisionModelChain
// ---------------------------------------------------------------------------

describe('validateVisionModelChain', () => {
  it('accepts a manifest-only vision chain built from inference providers', () => {
    const agent = makeAgent({ provider: 'ollama', name: 'llava', maxTokens: 2048 });

    const result = validateVisionModelChain(agent, undefined);

    expect(result.isOk()).toBe(true);
  });

  it('accepts a full chain of inference overrides with an inference manifest fallback', () => {
    const agent = makeAgent({ provider: 'google', name: 'gemini-2.0-flash', maxTokens: 2048 });
    const override: SubAgentsConfig[string] = {
      model: [
        { provider: 'openai', name: 'gpt-4o' },
        { provider: 'anthropic', name: 'claude-sonnet-4-6' },
      ],
    };

    const result = validateVisionModelChain(agent, override);

    expect(result.isOk()).toBe(true);
  });

  it('rejects a text-only custom manifest fallback even when every explicit override is inference-capable', () => {
    // A custom vision subagent whose manifest model is a text-only
    // subscription CLI. The implicit manifest fallback is part of the
    // complete chain, so validation must fail against the actual
    // buildSubAgentModelChain result, not just the configured overrides.
    const agent = makeAgent({ provider: 'claude-code', name: 'sonnet', maxTokens: 2048 });
    const override: SubAgentsConfig[string] = {
      model: [{ provider: 'openai', name: 'gpt-4o' }],
    };

    const result = validateVisionModelChain(agent, override);

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('vision sub-agent');
    expect(message).toContain('claude-code/sonnet (manifest)');
  });

  it('rejects an explicit codex-sandbox override even when the manifest model is inference-capable', () => {
    const agent = makeAgent({ provider: 'anthropic', name: 'claude-sonnet-4-6', maxTokens: 2048 });
    const override: SubAgentsConfig[string] = {
      model: [{ provider: 'codex-sandbox', name: 'gpt-5.6-terra' }],
    };

    const result = validateVisionModelChain(agent, override);

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('codex-sandbox/gpt-5.6-terra (override)');
  });

  it('rejects a chain whose only text-only entry sits mid-chain and names every offender', () => {
    const agent = makeAgent({ provider: 'claude-code', name: 'sonnet', maxTokens: 2048 });
    const override: SubAgentsConfig[string] = {
      model: [
        { provider: 'openai', name: 'gpt-4o' },
        { provider: 'codex-sandbox', name: 'gpt-5.6-terra' },
      ],
    };

    const result = validateVisionModelChain(agent, override);

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('codex-sandbox/gpt-5.6-terra (override)');
    expect(message).toContain('claude-code/sonnet (manifest)');
    // Inference entries are not reported as offenders.
    expect(message).not.toContain('openai/gpt-4o');
  });

  it('keeps non-vision subagent chains out of scope of the validator contract', () => {
    // The validator checks the chain it is given; it is the startup caller's
    // job to invoke it only for the loaded vision manifest. A text-only
    // chain passed here still fails — proving the check is chain-based,
    // not name-based on overrides.
    const agent = makeAgent({ provider: 'claude-code', name: 'haiku', maxTokens: 512 });

    const result = validateVisionModelChain(agent, undefined);

    expect(result.isErr()).toBe(true);
  });
});
