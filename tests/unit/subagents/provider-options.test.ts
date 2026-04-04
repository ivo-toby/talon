import { describe, it, expect, vi } from 'vitest';
import { wrapProviderOptions } from '../../../src/subagents/provider-options.js';

function makeLogger() {
  return { warn: vi.fn() } as const;
}

describe('wrapProviderOptions', () => {
  it('returns undefined when raw options are undefined', () => {
    const logger = makeLogger();
    const result = wrapProviderOptions('ollama', undefined, logger, { subagent: 'test' });
    expect(result).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('wraps under provider name when provider is ollama', () => {
    const logger = makeLogger();
    const raw = { chat_template_kwargs: { enable_thinking: false } };
    const result = wrapProviderOptions('ollama', raw, logger, { subagent: 'summarizer' });
    expect(result).toEqual({ ollama: raw });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('drops and warns when provider is anthropic (typed provider, not compatible)', () => {
    const logger = makeLogger();
    const raw = { thinking: { type: 'enabled', budgetTokens: 12000 } };
    const result = wrapProviderOptions('anthropic', raw, logger, {
      subagent: 'session-summarizer',
      source: 'override',
    });
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
    const warnCall = logger.warn.mock.calls[0];
    expect(warnCall[0]).toMatchObject({
      provider: 'anthropic',
      subagent: 'session-summarizer',
      source: 'override',
    });
    expect(warnCall[1]).toContain('providerOptions ignored');
    expect(warnCall[1]).toContain('anthropic');
    expect(warnCall[1]).toContain('ollama');
  });

  it('drops and warns when provider is openai (typed provider)', () => {
    const logger = makeLogger();
    const raw = { temperature: 0.7 };
    const result = wrapProviderOptions('openai', raw, logger, { subagent: 'test' });
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('drops and warns when provider is google', () => {
    const logger = makeLogger();
    const raw = { safetySettings: [] };
    const result = wrapProviderOptions('google', raw, logger, { subagent: 'test' });
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('drops and warns on unknown provider', () => {
    const logger = makeLogger();
    const raw = { foo: 'bar' };
    const result = wrapProviderOptions('mystery-provider', raw, logger, { subagent: 'test' });
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('does not warn when raw is undefined even on a typed provider', () => {
    const logger = makeLogger();
    const result = wrapProviderOptions('anthropic', undefined, logger, { subagent: 'test' });
    expect(result).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
