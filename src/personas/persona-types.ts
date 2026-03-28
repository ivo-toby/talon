/**
 * Types for the persona management system.
 *
 * A LoadedPersona combines the raw config with the resolved system prompt
 * content and fully-merged capability policy. This is the runtime representation
 * used throughout the daemon after startup persona loading.
 */

import type { PersonaConfig, CapabilitiesConfig } from '../core/config/config-types.js';

// Re-export PersonaConfig for consumers that import from this module.
export type { PersonaConfig, CapabilitiesConfig };

// ---------------------------------------------------------------------------
// Resolved capabilities
// ---------------------------------------------------------------------------

/**
 * Effective capability policy for a running persona.
 *
 * After merging persona-level grants with skill-level requirements, we have
 * two disjoint sets: capabilities that are directly allowed, and those that
 * require human approval before the action may proceed.
 *
 * Note: `requireApproval` takes precedence — if a label appears in both
 * lists, it is treated as requiring approval.
 */
export interface ResolvedCapabilities {
  /** Capability labels that are permitted without extra confirmation. */
  allow: string[];
  /** Capability labels that need an approval gate before use. */
  requireApproval: string[];
}

// ---------------------------------------------------------------------------
// Loaded persona
// ---------------------------------------------------------------------------

/**
 * A persona as it exists in memory after being loaded from config, with the
 * system-prompt file content read and capabilities fully resolved.
 */
export interface LoadedPersona {
  /** The original config-file declaration for this persona. */
  config: PersonaConfig;
  /**
   * Short description from the `system.md` YAML frontmatter.
   * Used by the `background_agent profiles` action to help the agent
   * choose the right profile for a task.
   */
  description?: string;
  /**
   * Content of the system prompt file, if `systemPromptFile` was specified
   * and the file was read successfully. Frontmatter is stripped.
   * `undefined` otherwise.
   */
  systemPromptContent?: string;
  /**
   * Concatenated content of all `personality/*.md` files (sorted alphabetically).
   * Injected into the system prompt after `systemPromptContent` and before skill fragments.
   * `undefined` if the personality folder doesn't exist or is empty.
   */
  personalityContent?: string;
  /**
   * Map of task prompt names to absolute markdown file paths from `prompts/*.md`.
   * Prompt contents are not loaded at startup; files are read on demand.
   */
  taskPromptPaths?: Record<string, string>;
  /** Effective capability policy after merging persona + skill grants. */
  resolvedCapabilities: ResolvedCapabilities;
}
