/**
 * TypeScript types inferred from the Zod config schemas.
 *
 * Import from here when you need typed configuration objects at runtime.
 * The schemas themselves live in `config-schema.ts`; this module exists
 * solely to give callers a clean import path for types.
 */

import type { z } from 'zod';
import type {
  TalondConfigSchema,
  StorageConfigSchema,
  SandboxConfigSchema,
  CapabilitiesSchema,
  MountConfigSchema,
  PersonaConfigSchema,
  ChannelConfigSchema,
  BindingConfigSchema,
  IpcConfigSchema,
  QueueConfigSchema,
  SchedulerConfigSchema,
  AuthConfigSchema,
  AgentRunnerConfigSchema,
  BackgroundAgentConfigSchema,
  LangfuseConfigSchema,
  ProviderConfigSchema,
} from './config-schema.js';

/** The full daemon configuration, validated and frozen at startup. */
export type TalondConfig = z.infer<typeof TalondConfigSchema>;

/** Storage backend configuration. */
export type StorageConfig = z.infer<typeof StorageConfigSchema>;

/** Container sandbox configuration. */
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

/** Resource limits within the sandbox. */
export type SandboxResourceLimits = SandboxConfig['resourceLimits'];

/** Per-persona capability grants and approval requirements. */
export type CapabilitiesConfig = z.infer<typeof CapabilitiesSchema>;

/** A single host-to-container mount definition. */
export type MountConfig = z.infer<typeof MountConfigSchema>;

/** Persona definition as declared in the config file. */
export type PersonaConfig = z.infer<typeof PersonaConfigSchema>;

/** Channel integration definition. */
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;

/** Binding definition linking a persona to a channel. */
export type BindingConfig = z.infer<typeof BindingConfigSchema>;

/** IPC polling settings. */
export type IpcConfig = z.infer<typeof IpcConfigSchema>;

/** Durable queue settings. */
export type QueueConfig = z.infer<typeof QueueConfigSchema>;

/** Scheduler tick settings. */
export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;

/** Authentication mode and credentials. */
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

/** Provider execution settings shared by agent runners and background agents. */
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/** Agent runner provider settings, including provider-scoped context management. */
export type AgentRunnerProviderConfig = AgentRunnerConfig['providers'][string];

/** Main agent runner provider settings. */
export type AgentRunnerConfig = z.infer<typeof AgentRunnerConfigSchema>;

/** Background Claude Code worker settings. */
export type BackgroundAgentConfig = z.infer<typeof BackgroundAgentConfigSchema>;

/** Langfuse Cloud observability settings. */
export type LangfuseConfig = z.infer<typeof LangfuseConfigSchema>;
