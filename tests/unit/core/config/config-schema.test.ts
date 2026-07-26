import { describe, it, expect } from 'vitest';
import {
  TalondConfigSchema,
  LangfuseConfigSchema,
  StorageConfigSchema,
  SandboxConfigSchema,
  ExecutionEnvResourceLimitsSchema,
  CapabilitiesSchema,
  MountConfigSchema,
  PersonaConfigSchema,
  SpritesConfigSchema,
  ChannelConfigSchema,
  IpcConfigSchema,
  QueueConfigSchema,
  SchedulerConfigSchema,
  AuthConfigSchema,
  AgentRunnerConfigSchema,
  BackgroundAgentConfigSchema,
  ProviderConfigSchema,
} from '../../../../src/core/config/config-schema.js';

// ---------------------------------------------------------------------------
// LangfuseConfigSchema
// ---------------------------------------------------------------------------

describe('LangfuseConfigSchema', () => {
  it('parses an empty object with defaults', () => {
    const result = LangfuseConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        enabled: false,
        publicKey: '',
        secretKey: '',
        baseUrl: 'https://cloud.langfuse.com',
        environment: 'production',
        exportMode: 'batched',
        flushAt: 20,
        flushIntervalSeconds: 5,
      });
    }
  });

  it('accepts a valid explicit config', () => {
    const result = LangfuseConfigSchema.safeParse({
      enabled: true,
      publicKey: 'pk-lf-test',
      secretKey: 'sk-lf-test',
      baseUrl: 'https://us.cloud.langfuse.com',
      environment: 'staging',
      release: 'git-sha-123',
      exportMode: 'immediate',
      flushAt: 5,
      flushIntervalSeconds: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.release).toBe('git-sha-123');
      expect(result.data.exportMode).toBe('immediate');
    }
  });

  it('rejects enabled=true without both API keys', () => {
    expect(
      LangfuseConfigSchema.safeParse({
        enabled: true,
        publicKey: '',
        secretKey: 'sk-lf-test',
      }).success,
    ).toBe(false);
    expect(
      LangfuseConfigSchema.safeParse({
        enabled: true,
        publicKey: 'pk-lf-test',
        secretKey: '',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// StorageConfigSchema
// ---------------------------------------------------------------------------

describe('StorageConfigSchema', () => {
  it('parses an empty object with defaults', () => {
    const result = StorageConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('sqlite');
      expect(result.data.path).toBe('data/talond.sqlite');
    }
  });

  it('accepts a valid explicit config', () => {
    const result = StorageConfigSchema.safeParse({ type: 'sqlite', path: '/tmp/test.db' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.path).toBe('/tmp/test.db');
    }
  });

  it('rejects an unknown storage type', () => {
    const result = StorageConfigSchema.safeParse({ type: 'postgres' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SandboxConfigSchema
// ---------------------------------------------------------------------------

describe('SandboxConfigSchema', () => {
  it('parses an empty object with defaults', () => {
    const result = SandboxConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtime).toBe('docker');
      expect(result.data.image).toBe('talon-sandbox:latest');
      expect(result.data.maxConcurrent).toBe(3);
      expect(result.data.networkDefault).toBe('off');
      expect(result.data.idleTimeoutMs).toBe(30 * 60 * 1000);
      expect(result.data.hardTimeoutMs).toBe(60 * 60 * 1000);
      expect(result.data.resourceLimits.memoryMb).toBe(1024);
      expect(result.data.resourceLimits.cpus).toBe(1);
      expect(result.data.resourceLimits.pidsLimit).toBe(256);
    }
  });

  it('accepts apple-container runtime', () => {
    const result = SandboxConfigSchema.safeParse({ runtime: 'apple-container' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtime).toBe('apple-container');
    }
  });

  it('rejects an unknown runtime', () => {
    const result = SandboxConfigSchema.safeParse({ runtime: 'lxc' });
    expect(result.success).toBe(false);
  });

  it('rejects maxConcurrent below 1', () => {
    const result = SandboxConfigSchema.safeParse({ maxConcurrent: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects negative idleTimeoutMs', () => {
    const result = SandboxConfigSchema.safeParse({ idleTimeoutMs: -1 });
    expect(result.success).toBe(false);
  });

  it('accepts custom resourceLimits', () => {
    const result = SandboxConfigSchema.safeParse({
      resourceLimits: { memoryMb: 2048, cpus: 2, pidsLimit: 512 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceLimits.memoryMb).toBe(2048);
    }
  });
});

// ---------------------------------------------------------------------------
// CapabilitiesSchema
// ---------------------------------------------------------------------------

describe('CapabilitiesSchema', () => {
  it('parses an empty object with empty arrays', () => {
    const result = CapabilitiesSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allow).toEqual([]);
      expect(result.data.requireApproval).toEqual([]);
    }
  });

  it('accepts allow and requireApproval lists', () => {
    const result = CapabilitiesSchema.safeParse({
      allow: ['read_file', 'list_dir'],
      requireApproval: ['write_file'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allow).toContain('read_file');
      expect(result.data.requireApproval).toContain('write_file');
    }
  });

  it('rejects non-string items in allow', () => {
    const result = CapabilitiesSchema.safeParse({ allow: [42] });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MountConfigSchema
// ---------------------------------------------------------------------------

describe('MountConfigSchema', () => {
  it('requires source and target', () => {
    expect(MountConfigSchema.safeParse({}).success).toBe(false);
    expect(MountConfigSchema.safeParse({ source: '/src' }).success).toBe(false);
    expect(MountConfigSchema.safeParse({ target: '/dst' }).success).toBe(false);
  });

  it('defaults mode to ro', () => {
    const result = MountConfigSchema.safeParse({ source: '/src', target: '/dst' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('ro');
    }
  });

  it('accepts rw mode', () => {
    const result = MountConfigSchema.safeParse({ source: '/src', target: '/dst', mode: 'rw' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('rw');
    }
  });

  it('rejects an invalid mode', () => {
    const result = MountConfigSchema.safeParse({ source: '/src', target: '/dst', mode: 'exec' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PersonaConfigSchema
// ---------------------------------------------------------------------------

describe('PersonaConfigSchema', () => {
  it('requires a non-empty name', () => {
    expect(PersonaConfigSchema.safeParse({}).success).toBe(false);
    expect(PersonaConfigSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('parses a minimal persona with defaults', () => {
    const result = PersonaConfigSchema.safeParse({ name: 'assistant' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe('claude-sonnet-4-6');
      expect(result.data.skills).toEqual([]);
      expect(result.data.capabilities.allow).toEqual([]);
      expect(result.data.mounts).toEqual([]);
      expect(result.data.systemPromptFile).toBeUndefined();
      expect(result.data.queryTimeoutMinutes).toBe(10);
      expect(result.data.maxConcurrent).toBeUndefined();
      expect(result.data.executionEnv).toBeUndefined();
      expect(Object.keys(result.data)).not.toContain('reasoningEffort');
    }
  });

  it('accepts all supported persona reasoningEffort values', () => {
    const values = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

    for (const reasoningEffort of values) {
      const result = PersonaConfigSchema.safeParse({ name: 'assistant', reasoningEffort });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.reasoningEffort).toBe(reasoningEffort);
      }
    }
  });

  it('rejects unsupported persona reasoningEffort values', () => {
    expect(
      PersonaConfigSchema.safeParse({ name: 'assistant', reasoningEffort: 'extreme' }).success,
    ).toBe(false);
    expect(
      PersonaConfigSchema.safeParse({ name: 'assistant', reasoningEffort: 'gpt-5.4:xhigh' })
        .success,
    ).toBe(false);
  });

  it('accepts a fully-specified persona', () => {
    const result = PersonaConfigSchema.safeParse({
      name: 'researcher',
      model: 'claude-opus-4-6',
      provider: 'gemini-cli',
      reasoningEffort: 'high',
      systemPromptFile: '/prompts/researcher.md',
      queryTimeoutMinutes: 45,
      skills: ['web-search', 'code-runner'],
      capabilities: { allow: ['read_file'], requireApproval: [] },
      mounts: [{ source: '/data', target: '/workspace', mode: 'rw' }],
      maxConcurrent: 2,
      executionEnv: {
        sandboxDefault: true,
        baseSnapshot: 'node-22-bookworm',
        workingDirectory: '/workspace',
        resourceLimits: {
          cpus: 4,
          memoryMb: 8192,
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('researcher');
      expect(result.data.provider).toBe('gemini-cli');
      expect(result.data.reasoningEffort).toBe('high');
      expect(result.data.queryTimeoutMinutes).toBe(45);
      expect(result.data.maxConcurrent).toBe(2);
      expect(result.data.mounts).toHaveLength(1);
      expect(result.data.executionEnv).toEqual({
        sandboxDefault: true,
        baseSnapshot: 'node-22-bookworm',
        workingDirectory: '/workspace',
        resourceLimits: {
          cpus: 4,
          memoryMb: 8192,
          diskGb: 20,
        },
      });
    }
  });

  it('rejects maxConcurrent below 1', () => {
    const result = PersonaConfigSchema.safeParse({ name: 'bot', maxConcurrent: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects queryTimeoutMinutes outside the supported range', () => {
    expect(PersonaConfigSchema.safeParse({ name: 'bot', queryTimeoutMinutes: 0 }).success).toBe(
      false,
    );
    expect(PersonaConfigSchema.safeParse({ name: 'bot', queryTimeoutMinutes: 481 }).success).toBe(
      false,
    );
  });

  describe('PersonaConfigSchema — background overrides', () => {
    it('accepts optional backgroundProvider and backgroundModel', () => {
      const parsed = PersonaConfigSchema.parse({
        name: 'assistant',
        backgroundProvider: 'claude-code',
        backgroundModel: 'claude-sonnet-4-6',
      });
      expect(parsed.backgroundProvider).toBe('claude-code');
      expect(parsed.backgroundModel).toBe('claude-sonnet-4-6');
    });

    it('leaves backgroundProvider and backgroundModel absent from parsed output when omitted', () => {
      const parsed = PersonaConfigSchema.parse({ name: 'assistant' });
      expect(Object.keys(parsed)).not.toContain('backgroundProvider');
      expect(Object.keys(parsed)).not.toContain('backgroundModel');
    });

    it('rejects empty string backgroundProvider', () => {
      expect(() =>
        PersonaConfigSchema.parse({ name: 'assistant', backgroundProvider: '   ' }),
      ).toThrow();
    });

    it('rejects empty string backgroundModel', () => {
      expect(() => PersonaConfigSchema.parse({ name: 'assistant', backgroundModel: '' })).toThrow();
    });

    it('accepts backgroundModel without backgroundProvider at the schema level (cross-validation deferred to TalondConfigSchema)', () => {
      expect(() =>
        PersonaConfigSchema.parse({ name: 'assistant', backgroundModel: 'claude-sonnet-4-6' }),
      ).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// ExecutionEnvResourceLimitsSchema
// ---------------------------------------------------------------------------

describe('ExecutionEnvResourceLimitsSchema', () => {
  it('parses an empty object with defaults', () => {
    const result = ExecutionEnvResourceLimitsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        cpus: 2,
        memoryMb: 4096,
        diskGb: 20,
      });
    }
  });

  it('rejects invalid limits', () => {
    expect(ExecutionEnvResourceLimitsSchema.safeParse({ cpus: 0 }).success).toBe(false);
    expect(ExecutionEnvResourceLimitsSchema.safeParse({ memoryMb: 128 }).success).toBe(false);
    expect(ExecutionEnvResourceLimitsSchema.safeParse({ diskGb: 0 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ChannelConfigSchema
// ---------------------------------------------------------------------------

describe('ChannelConfigSchema', () => {
  it('requires type and name', () => {
    expect(ChannelConfigSchema.safeParse({}).success).toBe(false);
    expect(ChannelConfigSchema.safeParse({ type: 'telegram' }).success).toBe(false);
    expect(ChannelConfigSchema.safeParse({ name: 'main' }).success).toBe(false);
  });

  it('defaults enabled to true and config to {}', () => {
    const result = ChannelConfigSchema.safeParse({ type: 'telegram', name: 'main' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.config).toEqual({});
      expect(result.data.tokenRef).toBeUndefined();
    }
  });

  it('accepts all supported channel types', () => {
    const types = ['telegram', 'whatsapp', 'slack', 'email', 'discord'] as const;
    for (const type of types) {
      const result = ChannelConfigSchema.safeParse({ type, name: type });
      expect(result.success).toBe(true);
    }
  });

  it('rejects an unknown channel type', () => {
    const result = ChannelConfigSchema.safeParse({ type: 'signal', name: 'signal' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty name', () => {
    const result = ChannelConfigSchema.safeParse({ type: 'telegram', name: '' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IpcConfigSchema
// ---------------------------------------------------------------------------

describe('IpcConfigSchema', () => {
  it('parses an empty object with defaults', () => {
    const result = IpcConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pollIntervalMs).toBe(500);
      expect(result.data.daemonSocketDir).toBe('data/ipc/daemon');
    }
  });

  it('rejects pollIntervalMs below 100', () => {
    const result = IpcConfigSchema.safeParse({ pollIntervalMs: 99 });
    expect(result.success).toBe(false);
  });

  it('accepts pollIntervalMs of exactly 100', () => {
    const result = IpcConfigSchema.safeParse({ pollIntervalMs: 100 });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QueueConfigSchema
// ---------------------------------------------------------------------------

describe('QueueConfigSchema', () => {
  it('parses an empty object with defaults', () => {
    const result = QueueConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxAttempts).toBe(3);
      expect(result.data.backoffBaseMs).toBe(1000);
      expect(result.data.backoffMaxMs).toBe(60000);
      expect(result.data.concurrencyLimit).toBe(5);
    }
  });

  it('rejects maxAttempts below 1', () => {
    const result = QueueConfigSchema.safeParse({ maxAttempts: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects concurrencyLimit below 1', () => {
    const result = QueueConfigSchema.safeParse({ concurrencyLimit: 0 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SchedulerConfigSchema
// ---------------------------------------------------------------------------

describe('SchedulerConfigSchema', () => {
  it('parses an empty object with defaults', () => {
    const result = SchedulerConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tickIntervalMs).toBe(5000);
    }
  });

  it('rejects tickIntervalMs below 1000', () => {
    const result = SchedulerConfigSchema.safeParse({ tickIntervalMs: 999 });
    expect(result.success).toBe(false);
  });

  it('accepts tickIntervalMs of exactly 1000', () => {
    const result = SchedulerConfigSchema.safeParse({ tickIntervalMs: 1000 });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AuthConfigSchema
// ---------------------------------------------------------------------------

describe('AuthConfigSchema', () => {
  it('parses an empty object with defaults', () => {
    const result = AuthConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('subscription');
      expect(result.data.apiKey).toBeUndefined();
    }
  });

  it('accepts api_key mode with an apiKey', () => {
    const result = AuthConfigSchema.safeParse({ mode: 'api_key', apiKey: 'sk-test-abc123' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('api_key');
      expect(result.data.apiKey).toBe('sk-test-abc123');
    }
  });

  it('accepts subscription mode without apiKey', () => {
    const result = AuthConfigSchema.safeParse({ mode: 'subscription' });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown auth mode', () => {
    const result = AuthConfigSchema.safeParse({ mode: 'oauth' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BackgroundAgentConfigSchema
// ---------------------------------------------------------------------------

describe('BackgroundAgentConfigSchema', () => {
  it('parses an empty object with defaults', () => {
    const result = BackgroundAgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        enabled: true,
        maxConcurrent: 3,
        defaultTimeoutMinutes: 30,
        defaultProvider: 'claude-code',
        providers: {
          'claude-code': {
            enabled: true,
            command: 'claude',
            contextWindowTokens: 200000,
          },
        },
      });
    }
  });

  it('accepts explicit overrides', () => {
    const result = BackgroundAgentConfigSchema.safeParse({
      enabled: false,
      maxConcurrent: 5,
      defaultTimeoutMinutes: 120,
      defaultProvider: 'claude-code',
      providers: {
        'claude-code': {
          enabled: true,
          command: '/usr/local/bin/claude',
          contextWindowTokens: 250000,
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.maxConcurrent).toBe(5);
      expect(result.data.defaultTimeoutMinutes).toBe(120);
      expect(result.data.defaultProvider).toBe('claude-code');
      expect(result.data.providers['claude-code']).toEqual({
        enabled: true,
        command: '/usr/local/bin/claude',
        contextWindowTokens: 250000,
      });
    }
  });

  it('rejects maxConcurrent below 1', () => {
    const result = BackgroundAgentConfigSchema.safeParse({ maxConcurrent: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects maxConcurrent above 10', () => {
    const result = BackgroundAgentConfigSchema.safeParse({ maxConcurrent: 11 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SpritesConfigSchema
// ---------------------------------------------------------------------------

describe('SpritesConfigSchema', () => {
  it('parses an empty object with defaults', () => {
    const result = SpritesConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        enabled: false,
        token: '',
        apiBaseUrl: 'https://api.sprites.dev',
        workingDirectory: '/workspace',
        createTimeoutMs: 60_000,
        execTimeoutMs: 20 * 60 * 1000,
        autoDestroyOnCompletion: true,
        resourceLimits: {
          cpus: 2,
          memoryMb: 4096,
          diskGb: 20,
        },
      });
      expect(result.data.defaultBaseSnapshot).toBeUndefined();
    }
  });

  it('requires token when sprites are enabled', () => {
    const result = SpritesConfigSchema.safeParse({
      enabled: true,
      token: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a fully-specified sprites config', () => {
    const result = SpritesConfigSchema.safeParse({
      enabled: true,
      token: 'sprites-token',
      apiBaseUrl: 'https://sprites.internal',
      defaultBaseSnapshot: 'node-22-bookworm',
      workingDirectory: '/workspace/app',
      createTimeoutMs: 75_000,
      execTimeoutMs: 42_000,
      autoDestroyOnCompletion: false,
      resourceLimits: {
        cpus: 4,
        memoryMb: 8192,
        diskGb: 40,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultBaseSnapshot).toBe('node-22-bookworm');
      expect(result.data.resourceLimits.cpus).toBe(4);
      expect(result.data.autoDestroyOnCompletion).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// ProviderConfigSchema / AgentRunnerConfigSchema
// ---------------------------------------------------------------------------

describe('ProviderConfigSchema', () => {
  it('parses provider defaults', () => {
    const result = ProviderConfigSchema.safeParse({ command: 'claude' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        enabled: false,
        command: 'claude',
        contextWindowTokens: 200000,
      });
    }
  });

  it('accepts an implementation type for provider aliases', () => {
    const result = ProviderConfigSchema.safeParse({
      enabled: true,
      type: 'openai-compatible',
      command: 'node',
      contextWindowTokens: 128000,
      options: {
        baseUrl: 'http://mac.local:11434/v1',
        defaultModel: 'qwen3-coder:30b',
        providerId: 'ollama-mac',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('openai-compatible');
      expect(result.data.options?.providerId).toBe('ollama-mac');
    }
  });

  it('rejects an empty implementation type', () => {
    const result = ProviderConfigSchema.safeParse({
      type: '   ',
      command: 'node',
    });
    expect(result.success).toBe(false);
  });
});

describe('AgentRunnerConfigSchema', () => {
  it('parses defaults with a Claude provider', () => {
    const result = AgentRunnerConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        defaultProvider: 'claude-code',
        providers: {
          'claude-code': {
            enabled: true,
            command: 'claude',
            contextWindowTokens: 200000,
            contextManagement: {
              enabled: true,
              mode: 'summarizer',
              triggerMetric: 'cache_read_input_tokens',
              thresholdRatio: 0.5,
              recentMessageCount: 10,
              summarizer: 'session-summarizer',
              observerInputContract: 'talon.context.observer.input.v1',
              observerOutputContract: 'talon.context.observer.v1',
              reducerInputContract: 'talon.context.reducer.input.v1',
              reducerOutputContract: 'talon.context.reducer.v1',
              reflectionThresholdChars: 40_000,
              deprecatedLegacySummarizer: false,
            },
          },
        },
      });
    }
  });

  it('accepts explicit contextManagement overrides', () => {
    const result = AgentRunnerConfigSchema.safeParse({
      defaultProvider: 'claude-code',
      providers: {
        'claude-code': {
          enabled: true,
          command: '/usr/local/bin/claude',
          contextWindowTokens: 1000000,
          contextManagement: {
            enabled: true,
            triggerMetric: 'cache_read_input_tokens',
            thresholdRatio: 0.5,
            recentMessageCount: 12,
            summarizer: 'session-summarizer',
          },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.providers['claude-code']).toEqual({
        enabled: true,
        command: '/usr/local/bin/claude',
        contextWindowTokens: 1000000,
        contextManagement: {
          enabled: true,
          mode: 'summarizer',
          triggerMetric: 'cache_read_input_tokens',
          thresholdRatio: 0.5,
          recentMessageCount: 12,
          summarizer: 'session-summarizer',
          observerInputContract: 'talon.context.observer.input.v1',
          observerOutputContract: 'talon.context.observer.v1',
          reducerInputContract: 'talon.context.reducer.input.v1',
          reducerOutputContract: 'talon.context.reducer.v1',
          reflectionThresholdChars: 40_000,
          deprecatedLegacySummarizer: false,
        },
      });
    }
  });

  it('ignores incomplete contextManagement settings on disabled providers', () => {
    const result = AgentRunnerConfigSchema.safeParse({
      defaultProvider: 'claude-code',
      providers: {
        'claude-code': {
          enabled: true,
          command: 'claude',
          contextWindowTokens: 200000,
          contextManagement: {
            enabled: true,
            triggerMetric: 'cache_read_input_tokens',
            thresholdRatio: 0.5,
            summarizer: 'session-summarizer',
          },
        },
        stale_disabled_provider: {
          enabled: false,
          command: 'codex',
          contextWindowTokens: 200000,
          contextManagement: {
            enabled: true,
            mode: 'observation',
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts explicit observation-mode context handlers and contracts', () => {
    const result = AgentRunnerConfigSchema.safeParse({
      providers: {
        'claude-code': {
          enabled: true,
          command: 'claude',
          contextWindowTokens: 200000,
          contextManagement: {
            enabled: true,
            mode: 'observation',
            triggerMetric: 'cache_read_input_tokens',
            thresholdRatio: 0.5,
            recentMessageCount: 10,
            observer: 'session-observer',
            reducer: 'session-reflector',
          },
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.providers['claude-code']?.contextManagement).toMatchObject({
        mode: 'observation',
        observer: 'session-observer',
        reducer: 'session-reflector',
        observerInputContract: 'talon.context.observer.input.v1',
        observerOutputContract: 'talon.context.observer.v1',
        reducerInputContract: 'talon.context.reducer.input.v1',
        reducerOutputContract: 'talon.context.reducer.v1',
      });
    }
  });

  it('accepts cache creation and total trigger metrics', () => {
    const creationMetricResult = AgentRunnerConfigSchema.safeParse({
      providers: {
        'claude-code': {
          enabled: true,
          command: 'claude',
          contextWindowTokens: 200000,
          contextManagement: {
            enabled: true,
            triggerMetric: 'cache_creation_input_tokens',
            thresholdRatio: 0.5,
            recentMessageCount: 10,
            summarizer: 'session-summarizer',
          },
        },
      },
    });
    expect(creationMetricResult.success).toBe(true);

    const totalMetricResult = AgentRunnerConfigSchema.safeParse({
      providers: {
        'claude-code': {
          enabled: true,
          command: 'claude',
          contextWindowTokens: 200000,
          contextManagement: {
            enabled: true,
            triggerMetric: 'cache_total_input_tokens',
            thresholdRatio: 0.5,
            recentMessageCount: 10,
            summarizer: 'session-summarizer',
          },
        },
      },
    });
    expect(totalMetricResult.success).toBe(true);
  });

  it('rejects invalid contextManagement.thresholdRatio values', () => {
    expect(
      AgentRunnerConfigSchema.safeParse({
        providers: {
          'claude-code': {
            enabled: true,
            command: 'claude',
            contextWindowTokens: 200000,
            contextManagement: {
              enabled: true,
              triggerMetric: 'cache_read_input_tokens',
              thresholdRatio: -0.1,
              recentMessageCount: 10,
              summarizer: 'session-summarizer',
            },
          },
        },
      }).success,
    ).toBe(false);

    expect(
      AgentRunnerConfigSchema.safeParse({
        providers: {
          'claude-code': {
            enabled: true,
            command: 'claude',
            contextWindowTokens: 200000,
            contextManagement: {
              enabled: true,
              triggerMetric: 'cache_read_input_tokens',
              thresholdRatio: 1.1,
              recentMessageCount: 10,
              summarizer: 'session-summarizer',
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects unsupported contextManagement.triggerMetric values', () => {
    const result = AgentRunnerConfigSchema.safeParse({
      providers: {
        'claude-code': {
          enabled: true,
          command: 'claude',
          contextWindowTokens: 200000,
          contextManagement: {
            enabled: true,
            triggerMetric: 'cache_write_input_tokens',
            thresholdRatio: 0.4,
            recentMessageCount: 10,
            summarizer: 'session-summarizer',
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects enabled contextManagement without a summarizer', () => {
    const result = AgentRunnerConfigSchema.safeParse({
      providers: {
        'claude-code': {
          enabled: true,
          command: 'claude',
          contextWindowTokens: 200000,
          contextManagement: {
            enabled: true,
            triggerMetric: 'cache_read_input_tokens',
            thresholdRatio: 0.4,
            recentMessageCount: 10,
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects enabled contextManagement with a whitespace-only summarizer', () => {
    const result = AgentRunnerConfigSchema.safeParse({
      providers: {
        'claude-code': {
          enabled: true,
          command: 'claude',
          contextWindowTokens: 200000,
          contextManagement: {
            enabled: true,
            triggerMetric: 'cache_read_input_tokens',
            thresholdRatio: 0.5,
            recentMessageCount: 10,
            summarizer: '   ',
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TalondConfigSchema (root)
// ---------------------------------------------------------------------------

describe('TalondConfigSchema', () => {
  it('parses an empty object — all defaults applied', () => {
    const result = TalondConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.logLevel).toBe('info');
      expect(result.data.dataDir).toBe('data');
      expect(result.data.channels).toEqual([]);
      expect(result.data.personas).toEqual([]);
      expect(result.data.storage.type).toBe('sqlite');
      expect(result.data.ipc.pollIntervalMs).toBe(500);
      expect(result.data.queue.maxAttempts).toBe(3);
      expect(result.data.scheduler.tickIntervalMs).toBe(5000);
      expect(result.data.auth.mode).toBe('subscription');
      expect(result.data.agentRunner).toEqual({
        defaultProvider: 'claude-code',
        providers: {
          'claude-code': {
            enabled: true,
            command: 'claude',
            contextWindowTokens: 200000,
            contextManagement: {
              enabled: true,
              mode: 'summarizer',
              triggerMetric: 'cache_read_input_tokens',
              thresholdRatio: 0.5,
              recentMessageCount: 10,
              summarizer: 'session-summarizer',
              observerInputContract: 'talon.context.observer.input.v1',
              observerOutputContract: 'talon.context.observer.v1',
              reducerInputContract: 'talon.context.reducer.input.v1',
              reducerOutputContract: 'talon.context.reducer.v1',
              reflectionThresholdChars: 40_000,
              deprecatedLegacySummarizer: false,
            },
          },
        },
      });
      expect(result.data.backgroundAgent).toEqual({
        enabled: true,
        maxConcurrent: 3,
        defaultTimeoutMinutes: 30,
        defaultProvider: 'claude-code',
        providers: {
          'claude-code': {
            enabled: true,
            command: 'claude',
            contextWindowTokens: 200000,
          },
        },
      });
      expect(result.data.sprites).toEqual({
        enabled: false,
        token: '',
        apiBaseUrl: 'https://api.sprites.dev',
        workingDirectory: '/workspace',
        createTimeoutMs: 60_000,
        execTimeoutMs: 20 * 60 * 1000,
        autoDestroyOnCompletion: true,
        resourceLimits: {
          cpus: 2,
          memoryMb: 4096,
          diskGb: 20,
        },
      });
      expect(result.data.langfuse).toEqual({
        enabled: false,
        publicKey: '',
        secretKey: '',
        baseUrl: 'https://cloud.langfuse.com',
        environment: 'production',
        exportMode: 'batched',
        flushAt: 20,
        flushIntervalSeconds: 5,
      });
      expect(Object.keys(result.data)).not.toContain('lifecycle');
    }
  });

  it('accepts a fully-specified configuration', () => {
    const result = TalondConfigSchema.safeParse({
      logLevel: 'debug',
      dataDir: '/var/lib/talon',
      storage: { type: 'sqlite', path: '/var/lib/talon/db.sqlite' },
      sandbox: { runtime: 'docker', maxConcurrent: 5 },
      channels: [{ type: 'telegram', name: 'main', tokenRef: 'TELEGRAM_TOKEN' }],
      personas: [{ name: 'helper', model: 'claude-sonnet-4-6' }],
      ipc: { pollIntervalMs: 250 },
      queue: { maxAttempts: 5 },
      scheduler: { tickIntervalMs: 10000 },
      auth: { mode: 'api_key', apiKey: 'sk-ant-test' },
      agentRunner: {
        defaultProvider: 'claude-code',
        providers: {
          'claude-code': {
            enabled: true,
            command: '/opt/bin/claude-sdk',
            contextWindowTokens: 220000,
            contextManagement: {
              enabled: true,
              triggerMetric: 'cache_read_input_tokens',
              thresholdRatio: 0.6,
              recentMessageCount: 8,
              summarizer: 'session-summarizer',
            },
          },
        },
      },
      backgroundAgent: {
        enabled: false,
        maxConcurrent: 2,
        defaultTimeoutMinutes: 45,
        defaultProvider: 'claude-code',
        providers: {
          'claude-code': {
            enabled: true,
            command: '/opt/bin/claude',
            contextWindowTokens: 220000,
          },
        },
      },
      sprites: {
        enabled: true,
        token: 'sprites-token',
        defaultBaseSnapshot: 'node-22-bookworm',
        workingDirectory: '/workspace',
        resourceLimits: {
          cpus: 4,
          memoryMb: 8192,
          diskGb: 40,
        },
      },
      langfuse: {
        enabled: true,
        publicKey: 'pk-lf-prod',
        secretKey: 'sk-lf-prod',
        baseUrl: 'https://us.cloud.langfuse.com',
        environment: 'staging',
        release: 'abcdef1234',
        exportMode: 'immediate',
        flushAt: 3,
        flushIntervalSeconds: 1,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.logLevel).toBe('debug');
      expect(result.data.channels).toHaveLength(1);
      expect(result.data.personas).toHaveLength(1);
      expect(result.data.backgroundAgent.enabled).toBe(false);
      expect(result.data.sprites.enabled).toBe(true);
      expect(result.data.sprites.resourceLimits.diskGb).toBe(40);
      expect(result.data.langfuse.release).toBe('abcdef1234');
    }
  });

  it('accepts openai-compatible provider options for both main and background agents', () => {
    const result = TalondConfigSchema.safeParse({
      agentRunner: {
        defaultProvider: 'openai-compatible',
        providers: {
          'openai-compatible': {
            enabled: true,
            command: 'node',
            contextWindowTokens: 256000,
            contextManagement: {
              enabled: true,
              triggerMetric: 'input_tokens',
              thresholdRatio: 0.75,
              recentMessageCount: 10,
              summarizer: 'session-summarizer',
            },
            options: {
              defaultModel: 'qwen3-coder:30b',
              baseUrl: 'http://127.0.0.1:11434/v1',
            },
          },
        },
      },
      backgroundAgent: {
        defaultProvider: 'openai-compatible',
        providers: {
          'openai-compatible': {
            enabled: true,
            command: 'node',
            contextWindowTokens: 256000,
            options: {
              defaultModel: 'qwen3-coder:30b',
              baseUrl: 'http://127.0.0.1:11434/v1',
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentRunner.defaultProvider).toBe('openai-compatible');
      expect(result.data.backgroundAgent.defaultProvider).toBe('openai-compatible');
      expect(result.data.agentRunner.providers['openai-compatible']?.options).toEqual({
        defaultModel: 'qwen3-coder:30b',
        baseUrl: 'http://127.0.0.1:11434/v1',
      });
      expect(result.data.backgroundAgent.providers['openai-compatible']?.options).toEqual({
        defaultModel: 'qwen3-coder:30b',
        baseUrl: 'http://127.0.0.1:11434/v1',
      });
    }
  });

  it('rejects an invalid logLevel', () => {
    const result = TalondConfigSchema.safeParse({ logLevel: 'verbose' });
    expect(result.success).toBe(false);
  });

  it('accepts all valid logLevel values', () => {
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
    for (const level of levels) {
      const result = TalondConfigSchema.safeParse({ logLevel: level });
      expect(result.success).toBe(true);
    }
  });

  it('ignores extra top-level fields (strips by default)', () => {
    const result = TalondConfigSchema.safeParse({ unknownField: 'value' });
    // Zod strips unknown fields by default — parse should still succeed
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>)['unknownField']).toBeUndefined();
    }
  });

  describe('TalondConfigSchema — backgroundProvider cross-validation', () => {
    function baseConfig() {
      return {
        personas: [{ name: 'assistant' }],
        backgroundAgent: {
          enabled: true,
          providers: {
            'claude-code': { enabled: true, command: 'claude', contextWindowTokens: 200_000 },
          },
        },
      };
    }

    it('accepts a persona whose backgroundProvider is enabled', () => {
      const cfg = baseConfig();
      cfg.personas[0] = { name: 'assistant', backgroundProvider: 'claude-code' } as any;
      expect(() => TalondConfigSchema.parse(cfg)).not.toThrow();
    });

    it('rejects a persona whose backgroundProvider is not in backgroundAgent.providers', () => {
      const cfg = baseConfig();
      cfg.personas[0] = { name: 'assistant', backgroundProvider: 'openai-compatible' } as any;
      // ZodError serialises issue messages as JSON, so " becomes \" in the thrown message string
      expect(() => TalondConfigSchema.parse(cfg)).toThrow(
        /backgroundProvider \\"openai-compatible\\" is not enabled/i,
      );
    });

    it('rejects a persona whose backgroundProvider is registered but disabled', () => {
      const cfg = baseConfig();
      (cfg.backgroundAgent.providers as any)['codex-cli'] = {
        enabled: false,
        command: 'codex',
        contextWindowTokens: 200_000,
      };
      cfg.personas[0] = { name: 'assistant', backgroundProvider: 'codex-cli' } as any;
      expect(() => TalondConfigSchema.parse(cfg)).toThrow(
        /backgroundProvider \\"codex-cli\\" is not enabled/i,
      );
    });

    it('rejects backgroundModel set without backgroundProvider', () => {
      const cfg = baseConfig();
      cfg.personas[0] = { name: 'assistant', backgroundModel: 'claude-opus-4-7' } as any;
      expect(() => TalondConfigSchema.parse(cfg)).toThrow(
        /backgroundModel requires backgroundProvider/i,
      );
    });

    it('reports the failing persona name in the error', () => {
      const cfg = baseConfig();
      cfg.personas = [
        { name: 'good', backgroundProvider: 'claude-code' },
        { name: 'bad', backgroundProvider: 'openai-compatible' },
      ] as any;
      // ZodError serialises issue messages as JSON, so " becomes \" in the thrown message string
      expect(() => TalondConfigSchema.parse(cfg)).toThrow(/persona \\"bad\\"/i);
    });

    it('rejects invalid backgroundProvider even when backgroundAgent.enabled is false', () => {
      const cfg = baseConfig();
      cfg.backgroundAgent.enabled = false;
      cfg.personas[0] = { name: 'assistant', backgroundProvider: 'openai-compatible' } as any;
      // ZodError serialises issue messages as JSON, so " becomes \" in the thrown message string
      expect(() => TalondConfigSchema.parse(cfg)).toThrow(
        /backgroundProvider \\"openai-compatible\\" is not enabled/i,
      );
    });

    it('includes "(none)" in the error message when backgroundAgent.providers is empty', () => {
      const cfg = baseConfig();
      cfg.backgroundAgent.providers = {} as any;
      cfg.personas[0] = { name: 'assistant', backgroundProvider: 'claude-code' } as any;
      expect(() => TalondConfigSchema.parse(cfg)).toThrow(/Enabled providers:.*?\(none\)/i);
    });
  });

  describe('TalondConfigSchema — lifecycle contracts and attachments', () => {
    it('accepts lifecycle omission without changing legacy config behavior', () => {
      const result = TalondConfigSchema.safeParse({
        personas: [{ name: 'assistant' }],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(Object.keys(result.data)).not.toContain('lifecycle');
        expect(Object.keys(result.data.personas[0] ?? {})).not.toContain('lifecycle');
      }
    });

    it('validates lifecycle retention compaction policy when lifecycle is configured', () => {
      const defaulted = TalondConfigSchema.safeParse({
        lifecycle: { enabled: true, handlers: [] },
      });

      expect(defaulted.success).toBe(true);
      if (defaulted.success) {
        expect(defaulted.data.lifecycle?.retention.completedAuditWindowMs).toBe(
          30 * 24 * 60 * 60 * 1000,
        );
      }

      const configured = TalondConfigSchema.safeParse({
        lifecycle: {
          enabled: true,
          handlers: [],
          retention: { completedAuditWindowMs: 86_400_000 },
        },
      });
      expect(configured.success).toBe(true);
      if (configured.success) {
        expect(configured.data.lifecycle?.retention.completedAuditWindowMs).toBe(86_400_000);
      }

      expect(
        TalondConfigSchema.safeParse({
          lifecycle: {
            enabled: true,
            handlers: [],
            retention: { completedAuditWindowMs: -1 },
          },
        }).success,
      ).toBe(false);
    });

    it('preserves duplicate owner names unless lifecycle registry validation is enabled', () => {
      const duplicateOwnerNames = {
        channels: [
          { type: 'terminal' as const, name: 'legacy-terminal' },
          { type: 'terminal' as const, name: 'legacy-terminal' },
        ],
        personas: [{ name: 'legacy-assistant' }, { name: 'legacy-assistant' }],
      };

      expect(TalondConfigSchema.safeParse(duplicateOwnerNames).success).toBe(true);
      expect(
        TalondConfigSchema.safeParse({
          ...duplicateOwnerNames,
          lifecycle: { enabled: false, handlers: [] },
        }).success,
      ).toBe(true);

      const enabledResult = TalondConfigSchema.safeParse({
        ...duplicateOwnerNames,
        lifecycle: { enabled: true, handlers: [] },
      });
      expect(enabledResult.success).toBe(false);
      if (!enabledResult.success) {
        expect(enabledResult.error.issues.map((issue) => issue.message)).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/duplicate persona name "legacy-assistant"/i),
            expect.stringMatching(/duplicate channel name "legacy-terminal"/i),
          ]),
        );
      }
    });

    it('preserves oversized persona names when lifecycle is omitted or disabled', () => {
      const oversizedOwner = '😀'.repeat(257);

      expect(TalondConfigSchema.safeParse({ personas: [{ name: oversizedOwner }] }).success).toBe(
        true,
      );
      expect(
        TalondConfigSchema.safeParse({
          lifecycle: { enabled: false, handlers: [] },
          personas: [{ name: oversizedOwner }],
        }).success,
      ).toBe(true);

      const enabled = TalondConfigSchema.safeParse({
        lifecycle: { enabled: true, handlers: [] },
        personas: [{ name: oversizedOwner }],
      });
      expect(enabled.success).toBe(false);
      if (!enabled.success) {
        expect(enabled.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: ['personas', 0, 'name'],
              message: expect.stringMatching(/256 Unicode scalars and 1024 UTF-8 bytes/i),
            }),
          ]),
        );
      }
    });

    it('accepts globally defined handlers with explicit persona subscriptions', () => {
      const result = TalondConfigSchema.safeParse({
        lifecycle: {
          enabled: true,
          handlers: [
            {
              version: 'v1',
              id: 'context-projector',
              mode: 'event',
              inputContract: 'talon.lifecycle.event.envelope.v1',
              outputContract: 'talon.lifecycle.signal.envelopes.v1',
              runtime: {
                kind: 'native',
                ref: 'context-projector',
                implementationVersion: '1.0.0',
              },
              failurePolicy: {
                version: 'v1',
                mode: 'preserve_session',
              },
            },
          ],
        },
        personas: [
          {
            name: 'assistant',
            lifecycle: {
              subscriptions: [
                {
                  version: 'v1',
                  handler: 'context-projector',
                  priority: 100,
                  subscription: {
                    version: 'v1',
                    kind: 'event',
                    events: [{ version: 'v1', type: 'run.completed.v1' }],
                  },
                },
              ],
            },
          },
        ],
      });

      expect(result.success).toBe(true);
    });

    it('keeps implementation availability out of structural config validation', () => {
      const result = TalondConfigSchema.safeParse({
        lifecycle: {
          enabled: true,
          handlers: [
            {
              version: 'v1',
              id: 'manifest-loaded-agent',
              mode: 'event',
              inputContract: 'talon.lifecycle.event.envelope.v1',
              outputContract: 'talon.lifecycle.signal.envelopes.v1',
              runtime: {
                kind: 'subagent',
                ref: 'manifest-loaded-agent',
                implementationVersion: '1.0.0',
              },
            },
          ],
        },
      });

      expect(result.success).toBe(true);
    });

    it('does not let YAML declare a native implementation catalog', () => {
      const result = TalondConfigSchema.safeParse({
        lifecycle: {
          enabled: true,
          trustedNativeImplementations: ['yaml-self-authorized'],
          handlers: [],
        },
      });

      expect(result.success).toBe(false);
    });

    it('rejects duplicate lifecycle handler ids', () => {
      const result = TalondConfigSchema.safeParse({
        lifecycle: {
          enabled: true,
          handlers: [
            {
              version: 'v1',
              id: 'audit-log',
              mode: 'event',
              inputContract: 'talon.lifecycle.event.envelope.v1',
              outputContract: 'talon.lifecycle.signal.envelopes.v1',
              runtime: {
                kind: 'native',
                ref: 'audit-log',
                implementationVersion: '1.0.0',
              },
            },
            {
              version: 'v1',
              id: 'audit-log',
              mode: 'signal',
              inputContract: 'talon.lifecycle.signal.envelope.v1',
              outputContract: 'talon.lifecycle.signal.envelopes.v1',
              runtime: {
                kind: 'native',
                ref: 'audit-signal',
                implementationVersion: '1.0.0',
              },
            },
          ],
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(
          /duplicate lifecycle handler id "audit-log"/i,
        );
      }
    });

    it('rejects persona subscriptions that reference missing handlers', () => {
      const result = TalondConfigSchema.safeParse({
        lifecycle: {
          enabled: true,
          handlers: [],
        },
        personas: [
          {
            name: 'assistant',
            lifecycle: {
              subscriptions: [
                {
                  version: 'v1',
                  handler: 'missing-handler',
                  subscription: {
                    version: 'v1',
                    kind: 'event',
                    events: [{ version: 'v1', type: 'message.persisted.v1' }],
                  },
                },
              ],
            },
          },
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(
          /references unknown lifecycle handler "missing-handler"/i,
        );
      }
    });

    it('rejects incompatible handler modes and subscription kinds', () => {
      const result = TalondConfigSchema.safeParse({
        lifecycle: {
          enabled: true,
          handlers: [
            {
              version: 'v1',
              id: 'audit-log',
              mode: 'event',
              inputContract: 'talon.lifecycle.event.envelope.v1',
              outputContract: 'talon.lifecycle.signal.envelopes.v1',
              runtime: {
                kind: 'native',
                ref: 'audit-log',
                implementationVersion: '1.0.0',
              },
            },
          ],
        },
        personas: [
          {
            name: 'assistant',
            lifecycle: {
              subscriptions: [
                {
                  version: 'v1',
                  handler: 'audit-log',
                  subscription: {
                    version: 'v1',
                    kind: 'signal',
                    signals: [{ version: 'v1', type: 'context.rotate.requested.v1' }],
                  },
                },
              ],
            },
          },
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(
          /handler "audit-log" has mode "event" but subscription kind is "signal"/i,
        );
      }
    });

    it('rejects strict filter objects with arbitrary expressions', () => {
      const result = TalondConfigSchema.safeParse({
        lifecycle: {
          enabled: true,
          handlers: [
            {
              version: 'v1',
              id: 'audit-log',
              mode: 'event',
              inputContract: 'talon.lifecycle.event.envelope.v1',
              outputContract: 'talon.lifecycle.signal.envelopes.v1',
              runtime: {
                kind: 'native',
                ref: 'audit-log',
                implementationVersion: '1.0.0',
              },
            },
          ],
        },
        personas: [
          {
            name: 'assistant',
            lifecycle: {
              subscriptions: [
                {
                  version: 'v1',
                  handler: 'audit-log',
                  subscription: {
                    version: 'v1',
                    kind: 'event',
                    events: [{ version: 'v1', type: 'message.persisted.v1' }],
                    filter: {
                      version: 'v1',
                      expression: 'channel == "terminal"',
                    },
                  },
                },
              ],
            },
          },
        ],
      });

      expect(result.success).toBe(false);
    });

    it('rejects lifecycle channel filters that reference unknown channels', () => {
      const result = TalondConfigSchema.safeParse({
        channels: [{ type: 'terminal', name: 'local-terminal' }],
        lifecycle: {
          enabled: true,
          handlers: [
            {
              version: 'v1',
              id: 'audit-log',
              mode: 'event',
              inputContract: 'talon.lifecycle.event.envelope.v1',
              outputContract: 'talon.lifecycle.signal.envelopes.v1',
              runtime: {
                kind: 'native',
                ref: 'audit-log',
                implementationVersion: '1.0.0',
              },
            },
          ],
        },
        personas: [
          {
            name: 'assistant',
            lifecycle: {
              subscriptions: [
                {
                  version: 'v1',
                  handler: 'audit-log',
                  subscription: {
                    version: 'v1',
                    kind: 'event',
                    events: [{ version: 'v1', type: 'message.persisted.v1' }],
                    filter: {
                      version: 'v1',
                      channels: ['terminal'],
                    },
                  },
                },
              ],
            },
          },
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(
          /lifecycle filter references unknown channel "terminal"/i,
        );
      }
    });

    it('rejects lifecycle persona filters that do not match the attached persona', () => {
      const result = TalondConfigSchema.safeParse({
        lifecycle: {
          enabled: true,
          handlers: [
            {
              version: 'v1',
              id: 'audit-log',
              mode: 'event',
              inputContract: 'talon.lifecycle.event.envelope.v1',
              outputContract: 'talon.lifecycle.signal.envelopes.v1',
              runtime: {
                kind: 'native',
                ref: 'audit-log',
                implementationVersion: '1.0.0',
              },
            },
          ],
        },
        personas: [
          { name: 'assistant' },
          { name: 'observer' },
          {
            name: 'analyst',
            lifecycle: {
              subscriptions: [
                {
                  version: 'v1',
                  handler: 'audit-log',
                  subscription: {
                    version: 'v1',
                    kind: 'event',
                    events: [{ version: 'v1', type: 'message.persisted.v1' }],
                    filter: {
                      version: 'v1',
                      personas: ['observer'],
                    },
                  },
                },
              ],
            },
          },
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(
          /does not match the attached persona "analyst"/i,
        );
      }
    });

    it('preserves bounded opaque names from persona, channel, and runtime owners', () => {
      const result = TalondConfigSchema.safeParse({
        channels: [{ type: 'terminal', name: 'Terminal.Main:V2' }],
        lifecycle: {
          enabled: true,
          handlers: [
            {
              version: 'v1',
              id: 'audit-log',
              mode: 'event',
              inputContract: 'talon.lifecycle.event.envelope.v1',
              outputContract: 'talon.lifecycle.signal.envelopes.v1',
              runtime: {
                kind: 'native',
                ref: 'Native.Audit/Log:V2',
                implementationVersion: '1.0.0',
              },
            },
          ],
        },
        personas: [
          {
            name: 'Ops/Agent:Blue',
            lifecycle: {
              subscriptions: [
                {
                  version: 'v1',
                  handler: 'audit-log',
                  subscription: {
                    version: 'v1',
                    kind: 'event',
                    events: [{ version: 'v1', type: 'message.persisted.v1' }],
                    filter: {
                      version: 'v1',
                      channels: ['Terminal.Main:V2'],
                      personas: ['Ops/Agent:Blue'],
                    },
                  },
                },
              ],
            },
          },
        ],
      });

      expect(result.success).toBe(true);
    });

    it('rejects unsafe fail-open lifecycle policies', () => {
      expect(() =>
        TalondConfigSchema.parse({
          lifecycle: {
            enabled: true,
            handlers: [
              {
                version: 'v1',
                id: 'native-interceptor',
                mode: 'interceptor',
                interceptorSafety: 'enforcing',
                inputContract: 'talon.lifecycle.interceptor.input.v1',
                outputContract: 'talon.lifecycle.enforcing.interceptor.output.v1',
                runtime: {
                  kind: 'native',
                  ref: 'native-interceptor',
                  implementationVersion: '1.0.0',
                },
                failurePolicy: {
                  version: 'v1',
                  mode: 'fail_open',
                },
              },
            ],
          },
          personas: [
            {
              name: 'assistant',
              lifecycle: {
                subscriptions: [
                  {
                    version: 'v1',
                    handler: 'native-interceptor',
                    subscription: {
                      version: 'v1',
                      kind: 'interceptor',
                      interceptors: [{ version: 'v1', hook: 'message.before_persist' }],
                    },
                  },
                ],
              },
            },
          ],
        }),
      ).toThrow(/enforcing native interceptors must use fail_closed/i);
    });

    it('rejects interceptor safety outside native interceptor declarations', () => {
      const eventSafety = TalondConfigSchema.safeParse({
        lifecycle: {
          enabled: true,
          handlers: [
            {
              version: 'v1',
              id: 'event-with-interceptor-safety',
              mode: 'event',
              interceptorSafety: 'advisory',
              inputContract: 'talon.lifecycle.event.envelope.v1',
              outputContract: 'talon.lifecycle.signal.envelopes.v1',
              runtime: {
                kind: 'native',
                ref: 'event-handler',
                implementationVersion: '1.0.0',
              },
            },
          ],
        },
        personas: [{ name: 'assistant' }],
      });
      expect(eventSafety.success).toBe(false);

      const subagentEnforcement = TalondConfigSchema.safeParse({
        lifecycle: {
          enabled: true,
          handlers: [
            {
              version: 'v1',
              id: 'subagent-enforcer',
              mode: 'interceptor',
              interceptorSafety: 'enforcing',
              inputContract: 'talon.lifecycle.interceptor.input.v1',
              outputContract: 'talon.lifecycle.enforcing.interceptor.output.v1',
              runtime: {
                kind: 'subagent',
                ref: 'review-agent',
                implementationVersion: '1.0.0',
              },
            },
          ],
        },
        personas: [{ name: 'assistant' }],
      });
      expect(subagentEnforcement.success).toBe(false);
    });
  });

  describe('TalondConfigSchema — reasoningEffort cross-validation', () => {
    it('rejects reasoningEffort for unsupported provider implementations', () => {
      expect(() =>
        TalondConfigSchema.parse({
          personas: [{ name: 'assistant', provider: 'gemini-cli', reasoningEffort: 'high' }],
          agentRunner: {
            defaultProvider: 'gemini-cli',
            providers: {
              'gemini-cli': { enabled: true, command: 'gemini' },
            },
          },
        }),
      ).toThrow(/reasoningEffort is not supported by provider/i);
    });

    it('resolves aliased provider implementations when validating reasoningEffort', () => {
      expect(() =>
        TalondConfigSchema.parse({
          personas: [{ name: 'assistant', provider: 'codex-work', reasoningEffort: 'high' }],
          agentRunner: {
            defaultProvider: 'codex-work',
            providers: {
              'codex-work': { enabled: true, type: 'codex-cli', command: 'codex' },
            },
          },
        }),
      ).not.toThrow();
    });

    it('rejects reasoningEffort none for Codex CLI', () => {
      expect(() =>
        TalondConfigSchema.parse({
          personas: [{ name: 'assistant', provider: 'codex-cli', reasoningEffort: 'none' }],
          agentRunner: {
            defaultProvider: 'codex-cli',
            providers: {
              'codex-cli': { enabled: true, command: 'codex' },
            },
          },
        }),
      ).toThrow(/reasoningEffort \\"none\\" is not supported by codex-cli/i);
    });

    it('requires Responses mode for OpenAI-compatible reasoningEffort', () => {
      expect(() =>
        TalondConfigSchema.parse({
          personas: [
            { name: 'assistant', provider: 'openai-compatible', reasoningEffort: 'medium' },
          ],
          agentRunner: {
            defaultProvider: 'openai-compatible',
            providers: {
              'openai-compatible': { enabled: true, command: 'openai-compatible' },
            },
          },
        }),
      ).toThrow(/requires openai-compatible options.apiMode: responses/i);
    });

    it('accepts reasoningEffort none for OpenAI-compatible Responses mode', () => {
      expect(() =>
        TalondConfigSchema.parse({
          personas: [{ name: 'assistant', provider: 'openai-compatible', reasoningEffort: 'none' }],
          agentRunner: {
            defaultProvider: 'openai-compatible',
            providers: {
              'openai-compatible': {
                enabled: true,
                command: 'openai-compatible',
                options: { apiMode: 'responses' },
              },
            },
          },
        }),
      ).not.toThrow();
    });

    it('rejects reasoningEffort when a configured backgroundProvider cannot consume it', () => {
      expect(() =>
        TalondConfigSchema.parse({
          personas: [
            {
              name: 'assistant',
              provider: 'codex-cli',
              reasoningEffort: 'high',
              backgroundProvider: 'claude-code',
            },
          ],
          agentRunner: {
            defaultProvider: 'codex-cli',
            providers: {
              'codex-cli': { enabled: true, command: 'codex' },
            },
          },
          backgroundAgent: {
            providers: {
              'claude-code': { enabled: true, command: 'claude' },
            },
          },
        }),
      ).toThrow(/reasoningEffort is not supported by backgroundProvider/i);
    });
  });
});
