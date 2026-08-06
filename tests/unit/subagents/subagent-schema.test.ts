import { describe, it, expect } from 'vitest';
import { SubAgentManifestSchema } from '../../../src/subagents/subagent-schema.js';

describe('SubAgentManifestSchema', () => {
  const minimal = {
    name: 'test-agent',
    version: '0.1.0',
    description: 'A test sub-agent',
    model: { provider: 'anthropic', name: 'claude-haiku-4-5-20251001' },
  };

  it('parses a minimal manifest', () => {
    const result = SubAgentManifestSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requiredCapabilities).toEqual([]);
      expect(result.data.rootPaths).toEqual([]);
      expect(result.data.timeoutMs).toBe(30000);
      expect(result.data.model.maxTokens).toBe(2048);
    }
  });

  it('parses a full manifest with all optional fields', () => {
    const result = SubAgentManifestSchema.safeParse({
      name: 'memory-groomer',
      version: '0.1.0',
      description: 'Grooms memory entries',
      model: { provider: 'anthropic', name: 'claude-haiku-4-5-20251001', maxTokens: 4096 },
      requiredCapabilities: ['memory.read:thread', 'memory.write:thread'],
      rootPaths: ['/home/talon/notes'],
      timeoutMs: 60000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requiredCapabilities).toEqual([
        'memory.read:thread',
        'memory.write:thread',
      ]);
      expect(result.data.rootPaths).toEqual(['/home/talon/notes']);
      expect(result.data.timeoutMs).toBe(60000);
      expect(result.data.model.maxTokens).toBe(4096);
    }
  });

  it('rejects manifest missing required fields', () => {
    const result = SubAgentManifestSchema.safeParse({ name: 'bad' });
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = SubAgentManifestSchema.safeParse({
      ...minimal,
      name: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects timeoutMs below 1000', () => {
    const result = SubAgentManifestSchema.safeParse({
      ...minimal,
      timeoutMs: 500,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty model provider', () => {
    const result = SubAgentManifestSchema.safeParse({
      ...minimal,
      model: { provider: '', name: 'claude-haiku-4-5-20251001' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts the Claude Code subscription provider as a model provider', () => {
    const result = SubAgentManifestSchema.safeParse({
      ...minimal,
      model: { provider: 'claude-code', name: 'claude-sonnet-4-6' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts the externally contained Codex subscription provider as a model provider', () => {
    const result = SubAgentManifestSchema.safeParse({
      ...minimal,
      model: { provider: 'codex-sandbox', name: 'gpt-5.6-terra' },
    });

    expect(result.success).toBe(true);
  });

  it('rejects empty model name', () => {
    const result = SubAgentManifestSchema.safeParse({
      ...minimal,
      model: { provider: 'anthropic', name: '' },
    });
    expect(result.success).toBe(false);
  });

  // --- Edge cases for model.maxTokens ---

  it('rejects model.maxTokens of 0', () => {
    const result = SubAgentManifestSchema.safeParse({
      ...minimal,
      model: { provider: 'anthropic', name: 'claude-haiku-4-5-20251001', maxTokens: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative model.maxTokens', () => {
    const result = SubAgentManifestSchema.safeParse({
      ...minimal,
      model: { provider: 'anthropic', name: 'claude-haiku-4-5-20251001', maxTokens: -100 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer model.maxTokens', () => {
    const result = SubAgentManifestSchema.safeParse({
      ...minimal,
      model: { provider: 'anthropic', name: 'claude-haiku-4-5-20251001', maxTokens: 1024.5 },
    });
    expect(result.success).toBe(false);
  });

  // --- Edge cases for requiredCapabilities ---

  it('rejects empty string in requiredCapabilities', () => {
    const result = SubAgentManifestSchema.safeParse({
      ...minimal,
      requiredCapabilities: ['memory.read:thread', ''],
    });
    expect(result.success).toBe(false);
  });

  // --- Edge cases for rootPaths ---

  it('rejects empty string in rootPaths', () => {
    const result = SubAgentManifestSchema.safeParse({
      ...minimal,
      rootPaths: ['/valid/path', ''],
    });
    expect(result.success).toBe(false);
  });

  // --- Edge cases for version and description ---

  it('rejects empty version', () => {
    const result = SubAgentManifestSchema.safeParse({
      ...minimal,
      version: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty description', () => {
    const result = SubAgentManifestSchema.safeParse({
      ...minimal,
      description: '',
    });
    expect(result.success).toBe(false);
  });

  // --- requiresEnv ---

  it('defaults requiresEnv to empty array', () => {
    const result = SubAgentManifestSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requiresEnv).toEqual([]);
    }
  });

  it('accepts requiresEnv with valid env var names', () => {
    const result = SubAgentManifestSchema.safeParse({
      ...minimal,
      requiresEnv: ['OPENAI_API_KEY', 'SOME_SECRET'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requiresEnv).toEqual(['OPENAI_API_KEY', 'SOME_SECRET']);
    }
  });

  it('rejects empty string in requiresEnv', () => {
    const result = SubAgentManifestSchema.safeParse({
      ...minimal,
      requiresEnv: ['OPENAI_API_KEY', ''],
    });
    expect(result.success).toBe(false);
  });
});
