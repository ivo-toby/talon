import { describe, it, expect } from 'vitest';
import { TalondConfigSchema } from '../../../../src/core/config/config-schema.js';

describe('TalondConfigSchema — subagents override', () => {
  it('accepts a valid subagents override config', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        'memory-groomer': {
          model: [
            { provider: 'ollama', name: 'qwen3-30b' },
            { provider: 'anthropic', name: 'claude-haiku-4-5', maxTokens: 4096 },
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
        'test': {
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
            { provider: 'anthropic', name: 'claude-haiku-4-5', timeoutMs: 60000 },
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
        'test': {
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
        'test': {
          model: [{ provider: 'anthropic', name: 'haiku', timeoutMs: 500 }],
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
