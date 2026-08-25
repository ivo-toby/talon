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
import { isUnsafeCodexSandboxToken } from '../../subagents/codex-sandbox-protocol.js';

import {
  MAX_HOPS,
  MAX_CONCURRENT_PER_TARGET,
  DEFAULT_A2A_MAX_ATTEMPTS,
} from '../../a2a/a2a-types.js';
import {
  LifecycleConfigSchema,
  PersonaLifecycleConfigSchema,
} from '../../lifecycle/contracts/index.js';
import {
  CONTEXT_OBSERVER_INPUT_CONTRACT,
  CONTEXT_OBSERVER_OUTPUT_CONTRACT,
  CONTEXT_REDUCER_INPUT_CONTRACT,
  CONTEXT_REDUCER_OUTPUT_CONTRACT,
} from '../../lifecycle/context/index.js';
import { collectLifecycleValidationIssues } from '../../lifecycle/handler-registry.js';

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
  idleTimeoutMs: z
    .number()
    .int()
    .min(0)
    .default(30 * 60 * 1000),
  hardTimeoutMs: z
    .number()
    .int()
    .min(0)
    .default(60 * 60 * 1000),
  resourceLimits: ResourceLimitsSchema.default(() => ResourceLimitsSchema.parse({})),
});

export const ExecutionEnvResourceLimitsSchema = z.object({
  cpus: z.number().min(0.25).default(2),
  memoryMb: z.number().int().min(256).default(4096),
  diskGb: z.number().int().min(1).default(20),
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

export const ReasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

const REASONING_EFFORT_BY_PROVIDER_TYPE: Record<
  string,
  ReadonlyArray<z.infer<typeof ReasoningEffortSchema>>
> = {
  'codex-cli': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'openai-compatible': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};

const PersonaExecutionEnvSchema = z.object({
  sandboxDefault: z.boolean().default(false),
  baseSnapshot: z.string().optional(),
  workingDirectory: z.string().default('/workspace'),
  resourceLimits: ExecutionEnvResourceLimitsSchema.partial().default({}),
});

export const PersonaConfigSchema = z.object({
  name: z.string().min(1),
  model: z.string().default('claude-sonnet-4-6'),
  provider: z.string().trim().min(1).optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  /**
   * Optional override: when set, background agents spawned by this persona use
   * this provider instead of the persona's foreground `provider`. Cross-validated
   * against `backgroundAgent.providers` at root config level.
   */
  backgroundProvider: z.string().trim().min(1).optional(),
  /**
   * Optional model override paired with `backgroundProvider`. When
   * `backgroundProvider` is absent, this field is ignored by the runtime
   * resolution chain (prevents forwarding a non-matching model name like
   * `gpt-oss` to a claude-code background provider).
   */
  backgroundModel: z.string().trim().min(1).optional(),
  systemPromptFile: z.string().optional(),
  /**
   * Maximum time in minutes the agent runner will wait for a single query to complete.
   * Increase for personas that run long Codex tasks or deep research. Defaults to 10.
   */
  queryTimeoutMinutes: z.number().int().min(1).max(480).default(10),
  skills: z.array(z.string()).default([]),
  subagents: z.array(z.string()).default([]),
  capabilities: CapabilitiesSchema.default(() => CapabilitiesSchema.parse({})),
  mounts: z.array(MountConfigSchema).default([]),
  maxConcurrent: z.number().int().min(1).optional(),
  executionEnv: PersonaExecutionEnvSchema.optional(),
  lifecycle: PersonaLifecycleConfigSchema.optional(),
});

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export const ChannelConfigSchema = z.object({
  type: z.enum([
    'telegram',
    'whatsapp',
    'whatsappBusiness',
    'whatsappBaileys',
    'slack',
    'email',
    'discord',
    'terminal',
  ]),
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  tokenRef: z.string().optional(),
  enabled: z.boolean().default(true),
  showToolCalls: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

export const BindingConfigSchema = z.object({
  persona: z.string().min(1),
  channel: z.string().min(1),
  isDefault: z.boolean().default(false),
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
  type: z.string().trim().min(1).optional(),
  command: z.string(),
  contextWindowTokens: z.number().int().min(1000).default(200_000),
  options: z.record(z.string(), z.unknown()).optional(),
});

export const ContextManagementConfigSchema = z.object({
    enabled: z.boolean().default(false),
    mode: z.enum(['summarizer', 'observation']).default('summarizer'),
    triggerMetric: z
      .enum([
        'input_tokens',
        'cache_read_input_tokens',
        'cache_creation_input_tokens',
        'cache_total_input_tokens',
      ])
      .optional(),
    thresholdRatio: z.number().min(0).max(1).optional(),
    recentMessageCount: z.number().int().min(0).default(10),
    /**
     * Legacy summary handler name. Still supported for `mode: summarizer`;
     * `summarizer: session-observer` is translated by the config loader into
     * explicit observation-mode observer/reducer handlers.
     */
    summarizer: z.string().trim().min(1).optional(),
    observer: z.string().trim().min(1).optional(),
    reducer: z.string().trim().min(1).optional(),
    observerInputContract: z.literal(CONTEXT_OBSERVER_INPUT_CONTRACT).default(CONTEXT_OBSERVER_INPUT_CONTRACT),
    observerOutputContract: z.literal(CONTEXT_OBSERVER_OUTPUT_CONTRACT).default(CONTEXT_OBSERVER_OUTPUT_CONTRACT),
    reducerInputContract: z.literal(CONTEXT_REDUCER_INPUT_CONTRACT).default(CONTEXT_REDUCER_INPUT_CONTRACT),
    reducerOutputContract: z.literal(CONTEXT_REDUCER_OUTPUT_CONTRACT).default(CONTEXT_REDUCER_OUTPUT_CONTRACT),
    deprecatedLegacySummarizer: z.boolean().default(false),
    // Max combined size, in characters, of the per-thread observation log
    // before the reflector sub-agent is invoked to consolidate it. Only
    // applies when `summarizer` is `session-observer` (observational memory
    // path). Defaults to 40_000 (~10K tokens).
    reflectionThresholdChars: z.number().int().min(1000).default(40_000),
  });

function validateEnabledContextManagement(
  value: z.infer<typeof ContextManagementConfigSchema>,
  ctx: z.RefinementCtx,
): void {
  if (!value.enabled) {
    return;
  }

  if (!value.triggerMetric) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contextManagement', 'triggerMetric'],
      message: 'triggerMetric is required when contextManagement.enabled is true',
    });
  }

  if (value.thresholdRatio === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contextManagement', 'thresholdRatio'],
      message: 'thresholdRatio is required when contextManagement.enabled is true',
    });
  }

  // recentMessageCount has a schema default(10), so it's always defined.

  if (value.mode === 'observation') {
    if (!value.observer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contextManagement', 'observer'],
        message: 'observer is required when contextManagement.mode is observation',
      });
    }
    if (!value.reducer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contextManagement', 'reducer'],
        message: 'reducer is required when contextManagement.mode is observation',
      });
    }
    return;
  }

  if (!value.summarizer) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contextManagement', 'summarizer'],
      message: 'summarizer is required when contextManagement.mode is summarizer',
    });
  }
}

export const AgentRunnerProviderConfigSchema = ProviderConfigSchema.extend({
  contextManagement: ContextManagementConfigSchema.default(() =>
    ContextManagementConfigSchema.parse({}),
  ),
}).superRefine((value, ctx) => {
  if (!value.enabled) {
    return;
  }
  validateEnabledContextManagement(value.contextManagement, ctx);
});

function defaultClaudeProviderConfig(): z.infer<typeof ProviderConfigSchema> {
  return ProviderConfigSchema.parse({
    enabled: true,
    command: 'claude',
    contextWindowTokens: 200_000,
  });
}

function defaultClaudeAgentRunnerProviderConfig(): z.infer<typeof AgentRunnerProviderConfigSchema> {
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

export const SpritesConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    token: z.string().default(''),
    apiBaseUrl: z.string().url().default('https://api.sprites.dev'),
    defaultBaseSnapshot: z.string().optional(),
    workingDirectory: z.string().default('/workspace'),
    createTimeoutMs: z.number().int().min(1000).default(60_000),
    execTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .default(20 * 60 * 1000),
    autoDestroyOnCompletion: z.boolean().default(true),
    resourceLimits: ExecutionEnvResourceLimitsSchema.default(() =>
      ExecutionEnvResourceLimitsSchema.parse({}),
    ),
  })
  .superRefine((value, ctx) => {
    if (!value.enabled) {
      return;
    }

    if (value.token.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['token'],
        message: 'token is required when sprites.enabled is true',
      });
    }
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
// A2A (agent-to-agent) limits
// ---------------------------------------------------------------------------

export const A2AConfigSchema = z.object({
  /**
   * Maximum hop count before a chained A2A task is rejected. Guards against
   * runaway delegation loops. Submissions with `hopCount >= maxHops` fail.
   */
  maxHops: z.number().int().min(1).max(32).default(MAX_HOPS),
  /**
   * Maximum number of in-flight (submitted/working/input-required) A2A tasks
   * targeting a single persona. Additional submissions are rejected until one
   * completes. Set higher to allow parallel delegation to the same persona.
   */
  maxConcurrentPerTarget: z.number().int().min(1).max(100).default(MAX_CONCURRENT_PER_TARGET),
  /**
   * Max queue retry attempts for collaboration queue items before they move
   * to the dead-letter queue.
   */
  maxAttempts: z.number().int().min(1).max(20).default(DEFAULT_A2A_MAX_ATTEMPTS),
});

// ---------------------------------------------------------------------------
// Sub-agent overrides
// ---------------------------------------------------------------------------

const SubAgentModelProviderSchema = z.enum([
  'anthropic',
  'openai',
  'google',
  'ollama',
  'claude-code',
  'codex-sandbox',
]);

const ClaudeCodeSubAgentCliSchema = z.object({
  enabled: z.boolean().default(false),
  command: z.string().trim().min(1).default('claude'),
});

/**
 * Subscription-authenticated CLI configuration for bounded subagent runs.
 * This is intentionally separate from agentRunner/backgroundAgent providers:
 * it supplies a single generation only and never receives MCP or host tools.
 */
export const SubAgentCliConfigSchema = z.object({
  claudeCode: ClaudeCodeSubAgentCliSchema.default(() => ClaudeCodeSubAgentCliSchema.parse({})),
});

const CodexSandboxSubAgentConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    endpoint: z.string().url().default('http://codex-runner:9700'),
    /** Time the daemon waits for the supervised runner at boot. */
    startupTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    /** Shared bearer token for Talon → runner traffic. Keep it out of the runner child. */
    token: z
      .string()
      .min(32)
      .refine((token) => !isUnsafeCodexSandboxToken(token), {
        message: 'token must be a unique random value, not the documented placeholder',
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.enabled && value.token === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['token'],
        message: 'token is required when subagentSandbox.codex is enabled',
      });
    }
  });

/**
 * Externally contained subscription adapters for bounded subagent runs.
 * The Codex process lives in a separately deployed runner container, not in
 * the daemon or the AgentProvider registry.
 */
export const SubAgentSandboxConfigSchema = z.object({
  codex: CodexSandboxSubAgentConfigSchema.default(() => CodexSandboxSubAgentConfigSchema.parse({})),
});

export const SubAgentModelOverrideSchema = z.object({
  provider: SubAgentModelProviderSchema,
  name: z.string().min(1),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
});

export const SubAgentOverrideSchema = z.object({
  model: z.array(SubAgentModelOverrideSchema).min(1),
});

export const SubAgentsConfigSchema = z.record(z.string(), SubAgentOverrideSchema);

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

export const TalondConfigSchema = z
  .object({
    storage: StorageConfigSchema.default(() => StorageConfigSchema.parse({})),
    sandbox: SandboxConfigSchema.default(() => SandboxConfigSchema.parse({})),
    lifecycle: LifecycleConfigSchema.optional(),
    channels: z.array(ChannelConfigSchema).default([]),
    personas: z.array(PersonaConfigSchema).default([]),
    bindings: z.array(BindingConfigSchema).default([]),
    ipc: IpcConfigSchema.default(() => IpcConfigSchema.parse({})),
    queue: QueueConfigSchema.default(() => QueueConfigSchema.parse({})),
    scheduler: SchedulerConfigSchema.default(() => SchedulerConfigSchema.parse({})),
    auth: AuthConfigSchema.default(() => AuthConfigSchema.parse({})),
    agentRunner: AgentRunnerConfigSchema.default(() => AgentRunnerConfigSchema.parse({})),
    backgroundAgent: BackgroundAgentConfigSchema.default(() =>
      BackgroundAgentConfigSchema.parse({}),
    ),
    sprites: SpritesConfigSchema.default(() => SpritesConfigSchema.parse({})),
    langfuse: LangfuseConfigSchema.default(() => LangfuseConfigSchema.parse({})),
    subagentCli: SubAgentCliConfigSchema.default(() => SubAgentCliConfigSchema.parse({})),
    subagentSandbox: SubAgentSandboxConfigSchema.default(() => SubAgentSandboxConfigSchema.parse({})),
    subagents: SubAgentsConfigSchema.default({}),
    a2a: A2AConfigSchema.default(() => A2AConfigSchema.parse({})),
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    dataDir: z.string().default('data'),
  })
  .superRefine((value, ctx) => {
    for (const [subAgentName, override] of Object.entries(value.subagents)) {
      if (
        !value.subagentSandbox.codex.enabled &&
        override.model.some((model) => model.provider === 'codex-sandbox')
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subagentSandbox', 'codex', 'enabled'],
          message:
            `subagents.${subAgentName} selects codex-sandbox, but ` +
            'subagentSandbox.codex is disabled. Enable the contained runner first.',
        });
      }
    }

    const enabledBackgroundProviders = new Set(
      Object.entries(value.backgroundAgent.providers)
        .filter(([, p]) => p.enabled)
        .map(([name]) => name),
    );

    value.personas.forEach((persona, index) => {
      if (persona.reasoningEffort) {
        const validateProvider = (
          providerName: string,
          provider: z.infer<typeof ProviderConfigSchema> | undefined,
          usage: string,
        ): void => {
          const providerType = provider?.type ?? providerName;
          const allowedValues = REASONING_EFFORT_BY_PROVIDER_TYPE[providerType];

          if (!allowedValues) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['personas', index, 'reasoningEffort'],
              message:
                `persona "${persona.name}": reasoningEffort is not supported by ${usage} ` +
                `"${providerName}" (type "${providerType}").`,
            });
            return;
          }

          if (!allowedValues.includes(persona.reasoningEffort!)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['personas', index, 'reasoningEffort'],
              message:
                `persona "${persona.name}": reasoningEffort "${persona.reasoningEffort}" is not ` +
                `supported by ${usage} "${providerName}" (type "${providerType}"); allowed: ` +
                `${allowedValues.join(', ')}.`,
            });
            return;
          }

          if (providerType === 'openai-compatible' && provider?.options?.apiMode !== 'responses') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['personas', index, 'reasoningEffort'],
              message:
                `persona "${persona.name}": reasoningEffort requires openai-compatible ` +
                'options.apiMode: responses.',
            });
          }
        };

        const foregroundProviderName = persona.provider ?? value.agentRunner.defaultProvider;
        validateProvider(
          foregroundProviderName,
          value.agentRunner.providers[foregroundProviderName],
          'provider',
        );

        if (persona.backgroundProvider) {
          validateProvider(
            persona.backgroundProvider,
            value.backgroundAgent.providers[persona.backgroundProvider],
            'backgroundProvider',
          );
        }
      }

      if (persona.backgroundProvider) {
        if (!enabledBackgroundProviders.has(persona.backgroundProvider)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['personas', index, 'backgroundProvider'],
            message:
              `persona "${persona.name}": backgroundProvider "${persona.backgroundProvider}" ` +
              `is not enabled in backgroundAgent.providers. ` +
              `Enabled providers: ${[...enabledBackgroundProviders].join(', ') || '(none)'}.`,
          });
        }
      } else if (persona.backgroundModel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['personas', index, 'backgroundModel'],
          message: `persona "${persona.name}": backgroundModel requires backgroundProvider to be set.`,
        });
      }
    });

    const lifecycleIssues = collectLifecycleValidationIssues({
      lifecycle: value.lifecycle,
      channels: value.channels,
      personas: value.personas,
    });

    for (const issue of lifecycleIssues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: issue.path,
        message: issue.message,
      });
    }
  });
