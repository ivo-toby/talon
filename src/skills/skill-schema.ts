/**
 * Zod schema for skill.yaml manifest validation.
 *
 * The schema validates the structure of a skill manifest and provides
 * inferred TypeScript types. Defaults make minimal manifests valid:
 * only `name`, `version`, and `description` are strictly required.
 *
 * Capability label format is NOT validated here — the loader validates
 * labels with regex after schema validation.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Capability label pattern (permissive — loader emits warnings for mismatches)
// ---------------------------------------------------------------------------

/**
 * Capability label: `domain.action:scope` or `domain.action`.
 * We use a permissive string check here; the loader does stricter validation.
 */
export const CapabilityLabelSchema = z.string().min(1);

// ---------------------------------------------------------------------------
// SkillManifest schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for validating a raw skill.yaml document.
 *
 * All list fields default to empty arrays so a minimal manifest only needs
 * `name`, `version`, and `description`.
 */
export const SkillManifestSchema = z.object({
  /** Unique skill identifier. Must be non-empty. */
  name: z.string().min(1, 'skill name must be non-empty'),

  /** Semantic version string. Must be non-empty. */
  version: z.string().min(1, 'skill version must be non-empty'),

  /** Human-readable description. Must be non-empty. */
  description: z.string().min(1, 'skill description must be non-empty'),

  /**
   * Capability labels required for this skill to be usable by a persona.
   * Defaults to [] — a skill with no required capabilities is always usable.
   */
  requiredCapabilities: z.array(CapabilityLabelSchema).default([]),

  /**
   * Relative paths to prompt fragment files (e.g. `prompts/intro.md`).
   * The loader discovers these by scanning the prompts/ directory; the
   * manifest field is optional and overrides auto-discovery when present.
   */
  promptFragments: z.array(z.string()).default([]),

  /**
   * Relative paths to tool manifest YAML files (e.g. `tools/search.yaml`).
   * Auto-discovered from tools/*.yaml by the loader.
   */
  toolManifests: z.array(z.string()).default([]),

  /**
   * Relative paths to MCP server definition JSON files.
   * Auto-discovered from mcp/*.json by the loader.
   */
  mcpServers: z.array(z.string()).default([]),

  /**
   * Relative paths to SQL migration files.
   * Auto-discovered from migrations/*.sql by the loader.
   */
  migrations: z.array(z.string()).default([]),
});

export const SkillMdFrontmatterSchema = z.object({
  name: z.string().min(1, 'skill name must be non-empty'),
  version: z.string().min(1).default('0.1.0'),
  description: z.string().min(1, 'skill description must be non-empty'),
  requiredCapabilities: z.array(CapabilityLabelSchema).default([]),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

/** TypeScript type inferred from SkillManifestSchema. */
export type SkillManifestInput = z.input<typeof SkillManifestSchema>;

/** TypeScript type of the validated/transformed output. */
export type SkillManifestOutput = z.output<typeof SkillManifestSchema>;

export type SkillMdFrontmatterInput = z.input<typeof SkillMdFrontmatterSchema>;

export type SkillMdFrontmatterOutput = z.output<typeof SkillMdFrontmatterSchema>;
