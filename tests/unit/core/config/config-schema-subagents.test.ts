import { describe, it, expect } from 'vitest';
import { TalondConfigSchema } from '../../../../src/core/config/config-schema.js';

describe('TalondConfigSchema — subagents override', () => {
  it('accepts a valid subagents override config', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        'memory-groomer': {
          model: [
            { provider: 'ollama', name: 'qwen3-30b' },
            { provider: 'anthropic', name: 'claude-haiku-4-5-20251001', maxTokens: 4096 },
          ],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const overrides = result.data.subagents;
      expect(overrides['memory-groomer'].model).toHaveLength(2);
      expect(overrides['memory-groomer'].model[0].provider).toBe('ollama');
      expect(overrides['memory-groomer'].model[0].maxTokens).toBeUndefined();
      expect(overrides['memory-groomer'].model[1].maxTokens).toBe(4096);
    }
  });

  it('defaults subagents to empty object when omitted', () => {
    const result = TalondConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subagents).toEqual({});
    }
  });

  it('rejects subagent override with empty model array', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        'memory-groomer': { model: [] },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects model entry with empty provider', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        'memory-groomer': {
          model: [{ provider: '', name: 'model-name' }],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts the Claude Code subscription provider in subagent model overrides', () => {
    const result = TalondConfigSchema.safeParse({
      subagentCli: {
        claudeCode: { enabled: true },
      },
      subagents: {
        'memory-groomer': {
          model: [{ provider: 'claude-code', name: 'claude-sonnet-4-6' }],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subagentCli.claudeCode).toEqual({ enabled: true, command: 'claude' });
    }
  });

  it('defaults subscription CLI providers to disabled', () => {
    const result = TalondConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subagentCli).toEqual({
        claudeCode: { enabled: false, command: 'claude' },
      });
    }
  });

  it('defaults Codex runner startup readiness to 30 seconds', () => {
    const result = TalondConfigSchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subagentSandbox.codex).toEqual({
        enabled: false,
        endpoint: 'http://codex-runner:9700',
        startupTimeoutMs: 30_000,
      });
    }
  });

  it('accepts an enabled externally contained Codex subscription runner', () => {
    const result = TalondConfigSchema.safeParse({
      subagentSandbox: {
        codex: {
          enabled: true,
          endpoint: 'http://codex-runner:9700',
          token: 't'.repeat(32),
        },
      },
      subagents: {
        'memory-groomer': {
          model: [{ provider: 'codex-sandbox', name: 'gpt-5.6-terra' }],
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subagentSandbox.codex).toMatchObject({
        enabled: true,
        endpoint: 'http://codex-runner:9700',
      });
    }
  });

  it('rejects a Codex runner override when the contained runner is disabled', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        'memory-groomer': {
          model: [{ provider: 'codex-sandbox', name: 'gpt-5.6-terra' }],
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['subagentSandbox', 'codex', 'enabled'],
          message: expect.stringContaining('memory-groomer selects codex-sandbox'),
        }),
      );
    }
  });

  it('rejects an enabled Codex sandbox runner without a token', () => {
    const result = TalondConfigSchema.safeParse({
      subagentSandbox: { codex: { enabled: true } },
    });

    expect(result.success).toBe(false);
  });

  it('rejects the documented Codex runner token placeholder', () => {
    const result = TalondConfigSchema.safeParse({
      subagentSandbox: {
        codex: {
          enabled: true,
          token: 'replace_with_a_random_32_character_minimum_value',
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects model entry with empty name', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        'memory-groomer': {
          model: [{ provider: 'anthropic', name: '' }],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative maxTokens', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        test: {
          model: [{ provider: 'anthropic', name: 'haiku', maxTokens: -1 }],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts timeoutMs on a model override entry', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        'memory-groomer': {
          model: [
            { provider: 'ollama', name: 'qwen3-30b', timeoutMs: 120000 },
            { provider: 'anthropic', name: 'claude-haiku-4-5-20251001', timeoutMs: 60000 },
          ],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subagents['memory-groomer'].model[0].timeoutMs).toBe(120000);
      expect(result.data.subagents['memory-groomer'].model[1].timeoutMs).toBe(60000);
    }
  });

  it('allows timeoutMs to be omitted (remains undefined)', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        test: {
          model: [{ provider: 'anthropic', name: 'haiku' }],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subagents['test'].model[0].timeoutMs).toBeUndefined();
    }
  });

  it('rejects timeoutMs below 1000', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        test: {
          model: [{ provider: 'anthropic', name: 'haiku', timeoutMs: 500 }],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts providerOptions on a model override entry', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        'session-summarizer': {
          model: [
            {
              provider: 'ollama',
              name: 'Qwen3.5-35B-A3B-UD-Q4_K_XL',
              providerOptions: {
                chat_template_kwargs: { enable_thinking: false },
                temperature: 0.7,
              },
            },
          ],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const entry = result.data.subagents['session-summarizer'].model[0];
      expect(entry.providerOptions).toEqual({
        chat_template_kwargs: { enable_thinking: false },
        temperature: 0.7,
      });
    }
  });

  it('allows providerOptions to be omitted (remains undefined)', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        test: { model: [{ provider: 'ollama', name: 'qwen' }] },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subagents['test'].model[0].providerOptions).toBeUndefined();
    }
  });

  describe('vision chain overrides', () => {
    it('accepts vision overrides built only from inference providers', () => {
      const result = TalondConfigSchema.safeParse({
        subagents: {
          vision: {
            model: [
              { provider: 'openai', name: 'gpt-4o' },
              { provider: 'ollama', name: 'llava' },
              { provider: 'anthropic', name: 'claude-sonnet-4-6' },
              { provider: 'google', name: 'gemini-2.0-flash' },
            ],
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects a claude-code vision override even when the subscription CLI is enabled', () => {
      const result = TalondConfigSchema.safeParse({
        subagentCli: { claudeCode: { enabled: true } },
        subagents: {
          vision: {
            model: [
              { provider: 'openai', name: 'gpt-4o' },
              { provider: 'claude-code', name: 'sonnet' },
            ],
          },
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['subagents', 'vision', 'model', 1, 'provider'],
            message: expect.stringContaining('claude-code" is text-only'),
          }),
        );
      }
    });

    it('rejects a codex-sandbox vision override even when the contained runner is enabled', () => {
      const result = TalondConfigSchema.safeParse({
        subagentSandbox: {
          codex: { enabled: true, token: 't'.repeat(32) },
        },
        subagents: {
          vision: {
            model: [{ provider: 'codex-sandbox', name: 'gpt-5.6-terra' }],
          },
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        // The sandbox-enablement rule still passes here; only the vision
        // classification rule fires.
        expect(result.error.issues).not.toContainEqual(
          expect.objectContaining({
            message: expect.stringContaining('subagentSandbox.codex is disabled'),
          }),
        );
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['subagents', 'vision', 'model', 0, 'provider'],
            message: expect.stringContaining('codex-sandbox" is text-only'),
          }),
        );
      }
    });

    it('keeps non-vision subagent overrides on the existing provider rules (claude-code still allowed)', () => {
      const result = TalondConfigSchema.safeParse({
        subagentCli: { claudeCode: { enabled: true } },
        subagents: {
          'memory-groomer': {
            model: [{ provider: 'claude-code', name: 'sonnet' }],
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it('keeps claude-code and codex-sandbox as valid providers for subagent overrides in general', () => {
      // The enum is derived from the model-resolver classifications; every
      // adapter the resolver can instantiate must remain configurable here.
      const result = TalondConfigSchema.safeParse({
        subagentCli: { claudeCode: { enabled: true } },
        subagentSandbox: { codex: { enabled: true, token: 't'.repeat(32) } },
        subagents: {
          'session-summarizer': {
            model: [
              { provider: 'claude-code', name: 'sonnet' },
              { provider: 'codex-sandbox', name: 'gpt-5.6-terra' },
              { provider: 'ollama', name: 'qwen3-30b' },
            ],
          },
        },
      });
      expect(result.success).toBe(true);
    });
  });

  it('accepts deeply nested providerOptions without inner validation', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        test: {
          model: [
            {
              provider: 'ollama',
              name: 'qwen',
              providerOptions: {
                level1: { level2: { level3: 'deep' } },
                arrayField: [1, 2, 3],
                nullField: null,
              },
            },
          ],
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
