/**
 * Core type definitions for the Talon skills system.
 *
 * Skills are reusable, named capability bundles that can be attached to
 * personas. Each skill is a directory containing a manifest (skill.yaml),
 * prompt fragments, tool manifests, MCP server definitions, and optional
 * SQL migrations.
 *
 * Skills do NOT directly modify the database. Migration paths are collected
 * by the loader and run separately by talonctl migrate.
 */

import type { ToolManifest } from '../tools/tool-types.js';
import type { McpServerConfig } from '../mcp/mcp-types.js';

// ---------------------------------------------------------------------------
// MCP server definition (as declared in a skill)
// ---------------------------------------------------------------------------

/**
 * A lightweight declaration that a skill needs a named MCP server.
 * The host MCP proxy resolves the actual server connection at runtime.
 */
export interface McpServerDef {
  /** Logical name for this MCP server (e.g. `filesystem`, `github`). */
  name: string;
  /** Full MCP server configuration as understood by the host proxy. */
  config: McpServerConfig;
}

// ---------------------------------------------------------------------------
// Skill manifest
// ---------------------------------------------------------------------------

/**
 * The parsed contents of a skill's `skill.yaml` manifest file.
 *
 * Declares metadata, capability requirements, and pointers to the files
 * inside the skill directory that the loader will read.
 */
export interface SkillManifest {
  /** Unique skill identifier (e.g. `web-search`, `memory-tools`). */
  name: string;
  /** Semantic version string (e.g. `1.0.0`). */
  version: string;
  /** Human-readable description of what the skill provides. */
  description: string;
  /**
   * Capability labels that the persona must have before this skill is
   * usable. Labels follow the pattern `<domain>.<action>:<scope>` or
   * `<domain>.<action>`. If ALL required labels are present in the
   * persona's allow or requireApproval set, the skill is resolved.
   */
  requiredCapabilities: string[];
  /**
   * Relative paths to prompt fragment files inside the skill directory
   * (e.g. `prompts/intro.md`). Order determines concatenation order.
   * These are typically globs resolved by the loader from `prompts/*.md`.
   */
  promptFragments: string[];
  /**
   * Relative paths to tool manifest YAML files inside the skill directory
   * (e.g. `tools/search.yaml`). Resolved by loader from `tools/*.yaml`.
   */
  toolManifests: string[];
  /**
   * Relative paths to MCP server definition JSON files inside the skill
   * directory (e.g. `mcp/filesystem.json`). Resolved from `mcp/*.json`.
   */
  mcpServers: string[];
  /**
   * Relative paths to SQL migration files inside the skill directory
   * (e.g. `migrations/001_init.sql`). Collected but NOT executed by the
   * loader — execution is delegated to talonctl migrate.
   */
  migrations: string[];
}

// ---------------------------------------------------------------------------
// Loaded skill
// ---------------------------------------------------------------------------

/**
 * A skill after all files have been read from disk.
 *
 * The loader resolves the file paths declared in the manifest and replaces
 * them with actual content / resolved absolute paths.
 */
export interface LoadedSkill {
  /** The validated manifest from skill.yaml. */
  manifest: SkillManifest;
  /** Source manifest format used to load this skill. */
  format: 'yaml' | 'skillmd';
  /**
   * Contents of each prompt fragment file, in the order they were
   * declared in (or discovered from) the skill directory.
   */
  promptContents: string[];
  /** Fully parsed and validated tool manifests for this skill. */
  resolvedToolManifests: ToolManifest[];
  /** Fully parsed MCP server definitions for this skill. */
  resolvedMcpServers: McpServerDef[];
  /**
   * Absolute paths to SQL migration files, in alphabetical order.
   * Not executed here — collected for the migration runner.
   */
  migrationPaths: string[];
}

// ---------------------------------------------------------------------------
// Resolved skill set
// ---------------------------------------------------------------------------

/**
 * The output of the skill resolver for a single persona.
 *
 * Contains only the skills whose `requiredCapabilities` are fully satisfied
 * by the persona's effective capability set.
 */
export interface ResolvedSkillSet {
  /** Skills that are fully usable for this persona. */
  usable: LoadedSkill[];
  /**
   * Skills that were requested but could not be resolved because they
   * require capabilities the persona does not have.
   */
  skipped: Array<{
    skillName: string;
    missingCapabilities: string[];
  }>;
  /**
   * Skill names that were declared by the persona but not found in the
   * provided set of loaded skills.
   */
  unknown: string[];
}

// ---------------------------------------------------------------------------
// Skill directory layout
// ---------------------------------------------------------------------------

/**
 * Describes the expected directory layout for a skill.
 *
 * Used as documentation and by the loader when scanning sub-directories.
 */
export interface SkillDirectory {
  /** Absolute path to the skill's root directory. */
  rootDir: string;
  /** Absolute path to the manifest file. */
  manifestPath: string;
  /** Absolute path to the prompts directory (`<rootDir>/prompts/`). */
  promptsDir: string;
  /** Absolute path to the tools directory (`<rootDir>/tools/`). */
  toolsDir: string;
  /** Absolute path to the MCP definitions directory (`<rootDir>/mcp/`). */
  mcpDir: string;
  /** Absolute path to the migrations directory (`<rootDir>/migrations/`). */
  migrationsDir: string;
}
