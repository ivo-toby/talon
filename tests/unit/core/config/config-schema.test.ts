import { describe, it, expect } from 'vitest';
import {
  TalondConfigSchema,
  LangfuseConfigSchema,
  StorageConfigSchema,
  SandboxConfigSchema,
  WorkflowConfigSchema,
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
// WorkflowConfigSchema
// ---------------------------------------------------------------------------

describe('WorkflowConfigSchema', () => {
  it('defaults to disabled observational mode', () => {
    const result = WorkflowConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.defaultRolloutMode).toBe('observe');
      expect(result.data.defaultPolicyPack).toBe('observe-only');
      expect(result.data.bindings).toEqual([]);
      expect(result.data.watchdog).toEqual({
        enabled: true,
        evaluationIntervalMs: 30_000,
        freshnessThresholdMs: 15 * 60 * 1000,
        claimRejectionThreshold: 2,
      });
    }
  });

  it('accepts explicit authoritative bindings when enabled', () => {
    const result = WorkflowConfigSchema.safeParse({
      enabled: true,
      defaultRolloutMode: 'guided',
      bindings: [
        {
          workflowType: 'orchestrator_task',
          policyPack: 'orchestrator-task',
          rolloutMode: 'authoritative',
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.defaultRolloutMode).toBe('guided');
      expect(result.data.bindings).toEqual([
        {
          workflowType: 'orchestrator_task',
          policyPack: 'orchestrator-task',
          rolloutMode: 'authoritative',
        },
      ]);
    }
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
    }
  });

  it('accepts a fully-specified persona', () => {
    const result = PersonaConfigSchema.safeParse({
      name: 'researcher',
      model: 'claude-opus-4-6',
      provider: 'gemini-cli',
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
    expect(
      PersonaConfigSchema.safeParse({ name: 'bot', queryTimeoutMinutes: 0 }).success,
    ).toBe(false);
    expect(
      PersonaConfigSchema.safeParse({ name: 'bot', queryTimeoutMinutes: 481 }).success,
    ).toBe(false);
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
              triggerMetric: 'cache_read_input_tokens',
              thresholdRatio: 0.5,
              recentMessageCount: 10,
              summarizer: 'session-summarizer',
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
          triggerMetric: 'cache_read_input_tokens',
          thresholdRatio: 0.5,
          recentMessageCount: 12,
          summarizer: 'session-summarizer',
        },
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
              triggerMetric: 'cache_read_input_tokens',
              thresholdRatio: 0.5,
              recentMessageCount: 10,
              summarizer: 'session-summarizer',
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
      expect(result.data.workflow).toEqual({
        enabled: false,
        defaultRolloutMode: 'observe',
        defaultPolicyPack: 'observe-only',
        bindings: [],
        watchdog: {
          enabled: true,
          evaluationIntervalMs: 30_000,
          freshnessThresholdMs: 15 * 60 * 1000,
          claimRejectionThreshold: 2,
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
      workflow: {
        enabled: true,
        defaultRolloutMode: 'guided',
        defaultPolicyPack: 'observe-only',
        bindings: [
          {
            workflowType: 'orchestrator_task',
            policyPack: 'orchestrator-task',
            rolloutMode: 'authoritative',
          },
        ],
        watchdog: {
          enabled: true,
          evaluationIntervalMs: 15_000,
          freshnessThresholdMs: 120_000,
          claimRejectionThreshold: 3,
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
      expect(result.data.workflow.bindings).toHaveLength(1);
      expect(result.data.workflow.bindings[0]?.rolloutMode).toBe('authoritative');
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
});
