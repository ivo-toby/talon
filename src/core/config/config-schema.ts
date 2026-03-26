/**
 * Zod schemas for the talond configuration file.
 *
 * Every top-level schema has sensible defaults so a minimal config file
 * (or even an empty one) results in a valid, usable configuration.
 *
 * Schemas are kept internal to this file; callers should import the
 * inferred TypeScript types from `config-types.ts` and load configs
 * via `config-loader.ts`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export const StorageConfigSchema = z.object({
  type: z.enum(['sqlite']).default('sqlite'),
  path: z.string().default('data/talond.sqlite'),
});

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const ResourceLimitsSchema = z.object({
  memoryMb: z.number().int().default(1024),
  cpus: z.number().default(1),
  pidsLimit: z.number().int().default(256),
});

export const SandboxConfigSchema = z.object({
  runtime: z.enum(['docker', 'apple-container']).default('docker'),
  image: z.string().default('talon-sandbox:latest'),
  maxConcurrent: z.number().int().min(1).default(3),
  networkDefault: z.enum(['off', 'on']).default('off'),
  idleTimeoutMs: z.number().int().min(0).default(30 * 60 * 1000),
  hardTimeoutMs: z.number().int().min(0).default(60 * 60 * 1000),
  resourceLimits: ResourceLimitsSchema.default(() => ResourceLimitsSchema.parse({})),
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export const CapabilitiesSchema = z.object({
  allow: z.array(z.string()).default([]),
  requireApproval: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Mounts
// ---------------------------------------------------------------------------

export const MountConfigSchema = z.object({
  source: z.string(),
  target: z.string(),
  mode: z.enum(['ro', 'rw']).default('ro'),
});

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

export const PersonaConfigSchema = z.object({
  name: z.string().min(1),
  model: z.string().default('claude-sonnet-4-6'),
  provider: z.string().trim().min(1).optional(),
  systemPromptFile: z.string().optional(),
  skills: z.array(z.string()).default([]),
  subagents: z.array(z.string()).default([]),
  capabilities: CapabilitiesSchema.default(() => CapabilitiesSchema.parse({})),
  mounts: z.array(MountConfigSchema).default([]),
  maxConcurrent: z.number().int().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export const ChannelConfigSchema = z.object({
  type: z.enum(['telegram', 'whatsapp', 'slack', 'email', 'discord', 'terminal']),
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  tokenRef: z.string().optional(),
  enabled: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

export const IpcConfigSchema = z.object({
  pollIntervalMs: z.number().int().min(100).default(500),
  daemonSocketDir: z.string().default('data/ipc/daemon'),
});

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export const QueueConfigSchema = z.object({
  maxAttempts: z.number().int().min(1).default(3),
  backoffBaseMs: z.number().int().default(1000),
  backoffMaxMs: z.number().int().default(60000),
  concurrencyLimit: z.number().int().min(1).default(5),
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export const SchedulerConfigSchema = z.object({
  tickIntervalMs: z.number().int().min(1000).default(5000),
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const ProviderAuthSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
});

export const AuthConfigSchema = z.object({
  mode: z.enum(['subscription', 'api_key']).default('subscription'),
  apiKey: z.string().optional(),
  providers: z.record(z.string(), ProviderAuthSchema).default({}),
});

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export const ProviderConfigSchema = z.object({
  enabled: z.boolean().default(false),
  command: z.string(),
  contextWindowTokens: z.number().int().min(1000).default(200_000),
  options: z.record(z.string(), z.unknown()).optional(),
});

export const ContextManagementConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    triggerMetric: z.enum([
      'input_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
      'cache_total_input_tokens',
    ]).optional(),
    thresholdRatio: z.number().min(0).max(1).optional(),
    recentMessageCount: z.number().int().min(0).default(10),
    summarizer: z.string().trim().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.enabled) {
      return;
    }

    if (!value.triggerMetric) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['triggerMetric'],
        message: 'triggerMetric is required when contextManagement.enabled is true',
      });
    }

    if (value.thresholdRatio === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thresholdRatio'],
        message: 'thresholdRatio is required when contextManagement.enabled is true',
      });
    }

    // recentMessageCount has a schema default(10), so it's always defined.

    if (!value.summarizer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summarizer'],
        message: 'summarizer is required when contextManagement.enabled is true',
      });
    }
  });

export const AgentRunnerProviderConfigSchema = ProviderConfigSchema.extend({
  contextManagement: ContextManagementConfigSchema.default(() =>
    ContextManagementConfigSchema.parse({}),
  ),
});

function defaultClaudeProviderConfig() {
  return ProviderConfigSchema.parse({
    enabled: true,
    command: 'claude',
    contextWindowTokens: 200_000,
  });
}

function defaultClaudeAgentRunnerProviderConfig() {
  return AgentRunnerProviderConfigSchema.parse({
    enabled: true,
    command: 'claude',
    contextWindowTokens: 200_000,
    contextManagement: {
      enabled: true,
      triggerMetric: 'cache_read_input_tokens',
      thresholdRatio: 0.5,
      recentMessageCount: 10,
      summarizer: 'session-summarizer',
    },
  });
}

export const AgentRunnerConfigSchema = z.object({
  defaultProvider: z.string().default('claude-code'),
  providers: z
    .record(z.string(), AgentRunnerProviderConfigSchema)
    .default(() => ({ 'claude-code': defaultClaudeAgentRunnerProviderConfig() })),
});

// ---------------------------------------------------------------------------
// Background agent
// ---------------------------------------------------------------------------

export const BackgroundAgentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxConcurrent: z.number().int().min(1).max(10).default(3),
  defaultTimeoutMinutes: z.number().int().min(15).max(480).default(30),
  defaultProvider: z.string().default('claude-code'),
  providers: z
    .record(z.string(), ProviderConfigSchema)
    .default(() => ({ 'claude-code': defaultClaudeProviderConfig() })),
  claudePath: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Langfuse observability
// ---------------------------------------------------------------------------

export const LangfuseConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    publicKey: z.string().default(''),
    secretKey: z.string().default(''),
    baseUrl: z.string().url().default('https://cloud.langfuse.com'),
    environment: z.string().default('production'),
    release: z.string().optional(),
    owner: z.string().optional(),
    exportMode: z.enum(['batched', 'immediate']).default('batched'),
    flushAt: z.number().int().min(1).default(20),
    flushIntervalSeconds: z.number().int().min(1).default(5),
  })
  .superRefine((value, ctx) => {
    if (!value.enabled) {
      return;
    }

    if (value.publicKey.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publicKey'],
        message: 'publicKey is required when langfuse.enabled is true',
      });
    }

    if (value.secretKey.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['secretKey'],
        message: 'secretKey is required when langfuse.enabled is true',
      });
    }
  });

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

export const TalondConfigSchema = z.object({
  storage: StorageConfigSchema.default(() => StorageConfigSchema.parse({})),
  sandbox: SandboxConfigSchema.default(() => SandboxConfigSchema.parse({})),
  channels: z.array(ChannelConfigSchema).default([]),
  personas: z.array(PersonaConfigSchema).default([]),
  ipc: IpcConfigSchema.default(() => IpcConfigSchema.parse({})),
  queue: QueueConfigSchema.default(() => QueueConfigSchema.parse({})),
  scheduler: SchedulerConfigSchema.default(() => SchedulerConfigSchema.parse({})),
  auth: AuthConfigSchema.default(() => AuthConfigSchema.parse({})),
  agentRunner: AgentRunnerConfigSchema.default(() => AgentRunnerConfigSchema.parse({})),
  backgroundAgent: BackgroundAgentConfigSchema.default(() => BackgroundAgentConfigSchema.parse({})),
  langfuse: LangfuseConfigSchema.default(() => LangfuseConfigSchema.parse({})),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  dataDir: z.string().default('data'),
});
