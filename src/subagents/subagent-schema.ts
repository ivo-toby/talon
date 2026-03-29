/**
 * Zod schema for subagent.yaml manifest validation.
 *
 * The schema validates the structure of a sub-agent manifest and provides
 * inferred TypeScript types. Defaults make minimal manifests valid:
 * only `name`, `version`, `description`, and `model` (provider + name)
 * are strictly required.
 *
 * Capability label format is NOT fully validated here — the sub-agent
 * loader (see Task 5) performs stricter regex validation after parsing.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------

/**
 * Zod schema for the `model` block inside a sub-agent manifest.
 *
 * Only `provider` and `name` are required; `maxTokens` defaults to 2048.
 */
export const SubAgentModelSchema = z.object({
  /** AI provider identifier (e.g. `anthropic`, `openai`, `google`). */
  provider: z.string().min(1, 'model provider must be non-empty'),

  /** Model name as understood by the provider (e.g. `claude-haiku-4-5`). */
  name: z.string().min(1, 'model name must be non-empty'),

  /** Maximum output tokens per generation. Defaults to 2048. */
  maxTokens: z.number().int().min(1).default(2048),
});

// ---------------------------------------------------------------------------
// Sub-agent manifest
// ---------------------------------------------------------------------------

/**
 * Zod schema for validating a raw subagent.yaml document.
 *
 * All list fields default to empty arrays and numeric fields have sensible
 * defaults, so a minimal manifest only needs `name`, `version`,
 * `description`, and `model.provider` + `model.name`.
 */
export const SubAgentManifestSchema = z.object({
  /** Unique sub-agent identifier. Must be non-empty. */
  name: z.string().min(1, 'sub-agent name must be non-empty'),

  /** Semantic version string. Must be non-empty. */
  version: z.string().min(1, 'sub-agent version must be non-empty'),

  /** Human-readable description. Must be non-empty. */
  description: z.string().min(1, 'sub-agent description must be non-empty'),

  /** Model configuration for this sub-agent. */
  model: SubAgentModelSchema,

  /**
   * Capability labels required for this sub-agent to run.
   * Defaults to [] — a sub-agent with no required capabilities is always usable.
   */
  requiredCapabilities: z.array(z.string().min(1)).default([]),

  /** Filesystem paths that the sub-agent is allowed to access. Defaults to []. */
  rootPaths: z.array(z.string().min(1)).default([]),

  /**
   * Maximum wall-clock time (ms) before the sub-agent run is aborted.
   * Must be at least 1000 ms. Defaults to 30000 (30 seconds).
   */
  timeoutMs: z.number().int().min(1000).default(30000),

  /**
   * Environment variables that must be set for this sub-agent to load.
   * If any are missing from `process.env`, the loader skips this sub-agent
   * with an info-level log. Defaults to [] — no env requirements.
   */
  requiresEnv: z.array(z.string().min(1)).default([]),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

/** TypeScript type inferred from SubAgentManifestSchema (input shape). */
export type SubAgentManifestInput = z.input<typeof SubAgentManifestSchema>;

/** TypeScript type of the validated/transformed output. */
export type SubAgentManifestOutput = z.output<typeof SubAgentManifestSchema>;
