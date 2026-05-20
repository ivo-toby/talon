import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../../src/providers/provider-registry.js';

function makeProviderConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    command: 'claude',
    contextWindowTokens: 200000,
    ...overrides,
  };
}

describe('ProviderRegistry', () => {
  it('registers enabled providers and resolves preferred defaults', () => {
    const registry = new ProviderRegistry(
      {
        'claude-code': makeProviderConfig(),
        'gemini-cli': makeProviderConfig({
          enabled: false,
          command: 'gemini',
          contextWindowTokens: 1000000,
        }),
        'codex-cli': makeProviderConfig({
          command: 'codex',
        }),
        'openai-compatible': makeProviderConfig({
          enabled: false,
          command: 'node',
        }),
      },
      {
        'claude-code': () => ({ name: 'claude-code' }) as any,
        'gemini-cli': () => ({ name: 'gemini-cli' }) as any,
        'codex-cli': () => ({ name: 'codex-cli' }) as any,
        'openai-compatible': () => ({ name: 'openai-compatible' }) as any,
      },
    );

    expect(registry.listEnabled()).toEqual(['claude-code', 'codex-cli']);
    expect(registry.get('claude-code')?.provider.name).toBe('claude-code');
    expect(registry.get('gemini-cli')).toBeUndefined();
    expect(registry.getDefault(['gemini-cli', 'codex-cli'])?.provider.name).toBe('codex-cli');
  });

  it('falls back to the first enabled provider when no preferred provider matches', () => {
    const registry = new ProviderRegistry(
      {
        'claude-code': makeProviderConfig(),
      },
      {
        'claude-code': () => ({ name: 'claude-code' }) as any,
      },
    );

    expect(registry.getDefault(['missing-provider'])?.provider.name).toBe('claude-code');
  });

  it('silently skips a provider whose name has no matching factory', () => {
    const registry = new ProviderRegistry(
      {
        'claude-code': makeProviderConfig(),
        'unknown-provider': makeProviderConfig({
          command: 'unknown',
          contextWindowTokens: 100000,
        }),
      },
      {
        'claude-code': () => ({ name: 'claude-code' }) as any,
        // no factory for 'unknown-provider'
      },
    );

    expect(registry.listEnabled()).toEqual(['claude-code']);
    expect(registry.get('unknown-provider')).toBeUndefined();
  });

  it('returns empty list and undefined default when all providers are disabled', () => {
    const registry = new ProviderRegistry(
      {
        'claude-code': makeProviderConfig({ enabled: false }),
        'gemini-cli': makeProviderConfig({
          enabled: false,
          command: 'gemini',
          contextWindowTokens: 1000000,
        }),
      },
      {
        'claude-code': () => ({ name: 'claude-code' }) as any,
        'gemini-cli': () => ({ name: 'gemini-cli' }) as any,
      },
    );

    expect(registry.listEnabled()).toEqual([]);
    expect(registry.getDefault(['claude-code', 'gemini-cli'])).toBeUndefined();
  });

  it('propagates an error thrown by a factory function', () => {
    expect(() => {
      new ProviderRegistry(
        {
          'claude-code': makeProviderConfig(),
        },
        {
          'claude-code': () => {
            throw new Error('factory failure');
          },
        },
      );
    }).toThrow('factory failure');
  });

  it('registers only enabled providers when config contains a mix', () => {
    const registry = new ProviderRegistry(
      {
        'claude-code': makeProviderConfig(),
        'gemini-cli': makeProviderConfig({
          enabled: false,
          command: 'gemini',
          contextWindowTokens: 1000000,
        }),
        'codex-cli': makeProviderConfig({
          command: 'codex',
        }),
        'openai-compatible': makeProviderConfig({
          enabled: false,
          command: 'node',
        }),
        'grok-cli': makeProviderConfig({
          enabled: false,
          command: 'grok',
          contextWindowTokens: 131072,
        }),
      },
      {
        'claude-code': () => ({ name: 'claude-code' }) as any,
        'gemini-cli': () => ({ name: 'gemini-cli' }) as any,
        'codex-cli': () => ({ name: 'codex-cli' }) as any,
        'openai-compatible': () => ({ name: 'openai-compatible' }) as any,
        'grok-cli': () => ({ name: 'grok-cli' }) as any,
      },
    );

    expect(registry.listEnabled()).toEqual(['claude-code', 'codex-cli']);
    expect(registry.get('gemini-cli')).toBeUndefined();
    expect(registry.get('grok-cli')).toBeUndefined();
  });

  it('returns undefined from get() for a provider name that was never registered', () => {
    const registry = new ProviderRegistry(
      {
        'claude-code': makeProviderConfig(),
      },
      {
        'claude-code': () => ({ name: 'claude-code' }) as any,
      },
    );

    expect(registry.get('nonexistent-provider')).toBeUndefined();
  });

  it('falls back to first enabled provider when preferredOrder is empty', () => {
    const registry = new ProviderRegistry(
      {
        'claude-code': makeProviderConfig(),
        'codex-cli': makeProviderConfig({
          command: 'codex',
        }),
      },
      {
        'claude-code': () => ({ name: 'claude-code' }) as any,
        'codex-cli': () => ({ name: 'codex-cli' }) as any,
      },
    );

    // Empty preferredOrder — loop body never executes, falls through to insertion-order fallback
    expect(registry.getDefault([])?.provider.name).toBe('claude-code');
  });

  describe('hasProvider', () => {
    it('returns true for an enabled registered provider', () => {
      const registry = new ProviderRegistry(
        { 'claude-code': makeProviderConfig() },
        { 'claude-code': () => ({ name: 'claude-code' }) as any },
      );
      expect(registry.hasProvider('claude-code')).toBe(true);
    });

    it('returns false for a provider that is not registered', () => {
      const registry = new ProviderRegistry(
        { 'claude-code': makeProviderConfig() },
        { 'claude-code': () => ({ name: 'claude-code' }) as any },
      );
      expect(registry.hasProvider('openai-compatible')).toBe(false);
    });

    it('returns false for a registered but disabled provider', () => {
      const registry = new ProviderRegistry(
        {
          'claude-code': makeProviderConfig(),
          'codex-cli': makeProviderConfig({ enabled: false, command: 'codex' }),
        },
        {
          'claude-code': () => ({ name: 'claude-code' }) as any,
          'codex-cli': () => ({ name: 'codex-cli' }) as any,
        },
      );
      expect(registry.hasProvider('codex-cli')).toBe(false);
    });
  });
});
