/**
 * SkillLoader — reads skill directories from the filesystem and produces
 * fully-hydrated {@link LoadedSkill} objects.
 *
 * Each skill directory must contain a `skill.yaml` manifest. Prompt
 * fragments, tool manifests, MCP definitions, and migration files are
 * auto-discovered from sub-directories even when not listed in the
 * manifest (the manifest lists take precedence when present; otherwise
 * the loader falls back to directory scanning).
 *
 * Directory layout:
 *   skills/{name}/
 *     skill.yaml              — required manifest
 *     prompts/*.md            — prompt fragments (auto-discovered)
 *     tools/*.yaml            — tool manifest YAML files (auto-discovered)
 *     mcp/*.json              — MCP server definition JSON (auto-discovered)
 *     migrations/*.sql        — SQL migrations (auto-discovered, not executed)
 *
 * All file I/O is async (fs/promises). The loader never modifies the
 * database; migration paths are collected and returned for external use.
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { ok, err, type Result } from 'neverthrow';
import type pino from 'pino';
import { z } from 'zod';
import { SkillError } from '../core/errors/index.js';
import { SkillManifestSchema, SkillMdFrontmatterSchema } from './skill-schema.js';
import type { LoadedSkill, McpServerDef } from './skill-types.js';
import type { ToolManifest } from '../tools/tool-types.js';

// ---------------------------------------------------------------------------
// Capability label validation
// ---------------------------------------------------------------------------

/** Fully-qualified label: `domain.action:scope` */
const CAPABILITY_WITH_SCOPE_RE = /^\w+\.\w+:\w+$/;
/** Minimal label: `domain.action` (scope-less, accepted with warning) */
const CAPABILITY_WITHOUT_SCOPE_RE = /^\w+\.\w+$/;

/**
 * Validates a single capability label.
 *
 * Returns an object indicating whether the label is fully valid and any
 * warning message. A label that is syntactically invalid (neither pattern
 * matches) causes loading to fail; a scope-less label emits a warning only.
 */
function validateCapabilityLabel(
  label: string,
): { valid: boolean; warning?: string; error?: string } {
  if (CAPABILITY_WITH_SCOPE_RE.test(label)) {
    return { valid: true };
  }
  if (CAPABILITY_WITHOUT_SCOPE_RE.test(label)) {
    return {
      valid: true,
      warning: `Capability label "${label}" is missing scope segment (expected <domain>.<action>:<scope>)`,
    };
  }
  return {
    valid: false,
    error: `Capability label "${label}" is malformed (expected <domain>.<action>:<scope> or <domain>.<action>)`,
  };
}

// ---------------------------------------------------------------------------
// Tool manifest YAML schema
// ---------------------------------------------------------------------------

const ExecutionLocationSchema = z.enum(['host', 'sandbox', 'mcp']);

const ToolManifestFileSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  parameterSchema: z.unknown().optional(),
  executionLocation: ExecutionLocationSchema,
});

// ---------------------------------------------------------------------------
// MCP server definition JSON schema
// ---------------------------------------------------------------------------

const McpRateLimitSchema = z.object({
  callsPerMinute: z.number().int().positive(),
});

const McpServerConfigSchema = z.object({
  name: z.string().min(1).optional(),
  transport: z.enum(['stdio', 'sse', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  credentialScope: z.string().optional(),
  rateLimit: McpRateLimitSchema.optional(),
});

const McpServerDefFileSchema = z.object({
  name: z.string().min(1),
  config: McpServerConfigSchema,
}).transform((def) => ({
  ...def,
  config: { ...def.config, name: def.config.name ?? def.name },
}));

// ---------------------------------------------------------------------------
// SkillLoader
// ---------------------------------------------------------------------------

/**
 * Reads skill directories from the filesystem and returns {@link LoadedSkill}
 * objects for use by the {@link SkillResolver}.
 */
export class SkillLoader {
  constructor(private readonly logger: pino.Logger) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Loads a single skill from a directory on disk.
   *
   * Steps:
   *   1. Read and validate `skill.yaml` with the Zod schema.
   *   2. Validate `requiredCapabilities` labels (fail on malformed).
   *   3. Discover and read prompt fragments from `prompts/*.md`.
   *   4. Discover and parse tool manifests from `tools/*.yaml`.
   *   5. Discover and parse MCP server defs from `mcp/*.json`.
   *   6. Collect migration paths from `migrations/*.sql`.
   *
   * @param skillDir - Absolute path to the skill directory.
   * @returns `Ok(LoadedSkill)` on success, `Err(SkillError)` on any failure.
   */
  async loadFromDirectory(skillDir: string): Promise<Result<LoadedSkill, SkillError>> {
    this.logger.debug({ skillDir }, 'loading skill from directory');

    const hasSkillYaml = await this.fileExists(join(skillDir, 'skill.yaml'));
    const hasSkillMd = await this.fileExists(join(skillDir, 'SKILL.md'));

    if (hasSkillYaml && hasSkillMd) {
      return err(
        new SkillError(
          `Skill directory "${skillDir}" is ambiguous: both "skill.yaml" and "SKILL.md" exist`,
        ),
      );
    }

    if (hasSkillMd) {
      return this.loadFromSkillMd(skillDir);
    }

    // 1. Read and validate the manifest.
    const manifestResult = await this.readManifest(skillDir);
    if (manifestResult.isErr()) return err(manifestResult.error);
    const manifest = manifestResult.value;

    // 2. Validate capability labels.
    for (const label of manifest.requiredCapabilities) {
      const { valid, warning, error } = validateCapabilityLabel(label);
      if (warning) {
        this.logger.warn({ skill: manifest.name, label }, warning);
      }
      if (!valid) {
        return err(
          new SkillError(
            `Skill "${manifest.name}" has malformed requiredCapability: ${error ?? label}`,
          ),
        );
      }
    }

    // 3. Load prompt fragments.
    const promptResult = await this.loadPromptFragments(skillDir, manifest.name);
    if (promptResult.isErr()) return err(promptResult.error);
    const promptContents = promptResult.value;

    // 4. Load tool manifests.
    const toolResult = await this.loadToolManifests(skillDir, manifest.name);
    if (toolResult.isErr()) return err(toolResult.error);
    const resolvedToolManifests = toolResult.value;

    // 5. Load MCP server definitions.
    const mcpResult = await this.loadMcpServerDefs(skillDir, manifest.name);
    if (mcpResult.isErr()) return err(mcpResult.error);
    const resolvedMcpServers = mcpResult.value;

    // 6. Collect migration paths.
    const migrationsResult = await this.collectMigrationPaths(skillDir, manifest.name);
    if (migrationsResult.isErr()) return err(migrationsResult.error);
    const migrationPaths = migrationsResult.value;

    const loaded: LoadedSkill = {
      manifest,
      format: 'yaml',
      promptContents,
      resolvedToolManifests,
      resolvedMcpServers,
      migrationPaths,
    };

    this.logger.info({ skill: manifest.name, skillDir }, 'skill loaded');
    return ok(loaded);
  }

  /**
   * Loads multiple skills from a list of directories.
   *
   * Fails immediately if any single skill fails to load.
   *
   * @param skillDirs - Array of absolute skill directory paths.
   * @returns `Ok(LoadedSkill[])` on success, `Err(SkillError)` on first failure.
   */
  async loadMultiple(skillDirs: string[]): Promise<Result<LoadedSkill[], SkillError>> {
    const loaded: LoadedSkill[] = [];

    for (const skillDir of skillDirs) {
      const result = await this.loadFromDirectory(skillDir);
      if (result.isErr()) return err(result.error);
      loaded.push(result.value);
    }

    return ok(loaded);
  }

  /**
   * Resolves skill directories from persona configs and loads them.
   *
   * Deduplicates skill names across personas, scans candidate directories
   * (`skills/` in cwd and dataDir), and loads all found skills.
   * Unknown skill names are logged as warnings and skipped.
   *
   * @param personas - Persona configs containing skill name references.
   * @param dataDir  - Runtime data directory (e.g. 'data').
   * @returns `Ok(LoadedSkill[])` on success, `Err(SkillError)` on first failure.
   */
  async loadFromPersonaConfig(
    personas: { skills: string[] }[],
    dataDir: string,
  ): Promise<Result<LoadedSkill[], SkillError>> {
    const uniqueSkillNames = new Set<string>();
    for (const persona of personas) {
      for (const skill of persona.skills) {
        uniqueSkillNames.add(skill);
      }
    }

    const skillDirs: string[] = [];
    for (const skillName of uniqueSkillNames) {
      const candidates = [
        join(process.cwd(), 'skills', skillName),
        join(dataDir, 'skills', skillName),
      ];
      let foundPath: string | null = null;
      for (const candidate of candidates) {
        try {
          await access(candidate, fsConstants.R_OK);
          foundPath = candidate;
          break;
        } catch {
          continue;
        }
      }
      if (foundPath !== null) {
        skillDirs.push(foundPath);
      } else {
        this.logger.warn({ skillName }, 'skill directory not found; skipping');
      }
    }

    if (skillDirs.length === 0) {
      return ok([]);
    }

    return this.loadMultiple(skillDirs);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reads and validates `skill.yaml` inside the given directory.
   */
  private async readManifest(
    skillDir: string,
  ): Promise<Result<LoadedSkill['manifest'], SkillError>> {
    const manifestPath = join(skillDir, 'skill.yaml');
    let raw: unknown;

    try {
      const content = await readFile(manifestPath, 'utf-8');
      raw = yaml.load(content);
    } catch (cause) {
      return err(
        new SkillError(
          `Failed to read skill manifest at "${manifestPath}": ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }

    if (raw === undefined || raw === null) {
      raw = {};
    }

    const parseResult = SkillManifestSchema.safeParse(raw);
    if (!parseResult.success) {
      const issues = parseResult.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      return err(
        new SkillError(
          `Skill manifest validation failed for "${manifestPath}": ${issues}`,
        ),
      );
    }

    return ok(parseResult.data);
  }

  /**
   * Reads and validates `SKILL.md` inside the given directory.
   */
  private async loadFromSkillMd(skillDir: string): Promise<Result<LoadedSkill, SkillError>> {
    const skillMdPath = join(skillDir, 'SKILL.md');
    let frontmatter: unknown;
    let body = '';

    try {
      const content = await readFile(skillMdPath, 'utf-8');
      const parsed = matter(content);
      frontmatter = parsed.data;
      body = parsed.content.trim();
    } catch (cause) {
      return err(
        new SkillError(
          `Failed to read skill markdown at "${skillMdPath}": ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }

    const parseResult = SkillMdFrontmatterSchema.safeParse(frontmatter);
    if (!parseResult.success) {
      const issues = parseResult.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      return err(
        new SkillError(
          `Skill markdown frontmatter validation failed for "${skillMdPath}": ${issues}`,
        ),
      );
    }

    const manifest: LoadedSkill['manifest'] = {
      ...parseResult.data,
      promptFragments: [],
      toolManifests: [],
      mcpServers: [],
      migrations: [],
    };

    for (const label of manifest.requiredCapabilities) {
      const { valid, warning, error } = validateCapabilityLabel(label);
      if (warning) {
        this.logger.warn({ skill: manifest.name, label }, warning);
      }
      if (!valid) {
        return err(
          new SkillError(
            `Skill "${manifest.name}" has malformed requiredCapability: ${error ?? label}`,
          ),
        );
      }
    }

    const toolResult = await this.loadToolManifests(skillDir, manifest.name);
    if (toolResult.isErr()) return err(toolResult.error);
    const resolvedToolManifests = toolResult.value;

    const mcpResult = await this.loadMcpServerDefs(skillDir, manifest.name);
    if (mcpResult.isErr()) return err(mcpResult.error);
    const resolvedMcpServers = mcpResult.value;

    const migrationsResult = await this.collectMigrationPaths(skillDir, manifest.name);
    if (migrationsResult.isErr()) return err(migrationsResult.error);
    const migrationPaths = migrationsResult.value;

    const loaded: LoadedSkill = {
      manifest,
      format: 'skillmd',
      promptContents: body.length > 0 ? [body] : [],
      resolvedToolManifests,
      resolvedMcpServers,
      migrationPaths,
    };

    this.logger.info({ skill: manifest.name, skillDir }, 'skill loaded');
    return ok(loaded);
  }

  /**
   * Reads prompt fragment files from the `prompts/` sub-directory.
   *
   * Files are sorted alphabetically so fragment order is deterministic.
   * Missing `prompts/` directory is silently treated as zero fragments.
   */
  private async loadPromptFragments(
    skillDir: string,
    skillName: string,
  ): Promise<Result<string[], SkillError>> {
    const promptsDir = join(skillDir, 'prompts');
    let files: string[];

    try {
      files = await readdir(promptsDir);
    } catch {
      // prompts/ directory does not exist — that is fine.
      this.logger.debug({ skill: skillName }, 'no prompts/ directory, skipping');
      return ok([]);
    }

    const mdFiles = files.filter((f) => f.endsWith('.md')).sort();
    const contents: string[] = [];

    for (const file of mdFiles) {
      const filePath = join(promptsDir, file);
      try {
        const content = await readFile(filePath, 'utf-8');
        contents.push(content);
        this.logger.debug({ skill: skillName, file }, 'prompt fragment loaded');
      } catch (cause) {
        return err(
          new SkillError(
            `Failed to read prompt fragment "${filePath}" for skill "${skillName}": ${String(cause)}`,
            cause instanceof Error ? cause : undefined,
          ),
        );
      }
    }

    return ok(contents);
  }

  /**
   * Reads and validates tool manifest YAML files from the `tools/`
   * sub-directory.
   *
   * Files are sorted alphabetically. Missing `tools/` directory is silently
   * treated as zero tool manifests.
   */
  private async loadToolManifests(
    skillDir: string,
    skillName: string,
  ): Promise<Result<ToolManifest[], SkillError>> {
    const toolsDir = join(skillDir, 'tools');
    let files: string[];

    try {
      files = await readdir(toolsDir);
    } catch {
      this.logger.debug({ skill: skillName }, 'no tools/ directory, skipping');
      return ok([]);
    }

    const yamlFiles = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
    const manifests: ToolManifest[] = [];

    for (const file of yamlFiles) {
      const filePath = join(toolsDir, file);
      let raw: unknown;

      try {
        const content = await readFile(filePath, 'utf-8');
        raw = yaml.load(content);
      } catch (cause) {
        return err(
          new SkillError(
            `Failed to read tool manifest "${filePath}" for skill "${skillName}": ${String(cause)}`,
            cause instanceof Error ? cause : undefined,
          ),
        );
      }

      const parseResult = ToolManifestFileSchema.safeParse(raw);
      if (!parseResult.success) {
        const issues = parseResult.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ');
        return err(
          new SkillError(
            `Tool manifest validation failed for "${filePath}" (skill "${skillName}"): ${issues}`,
          ),
        );
      }

      manifests.push(parseResult.data as ToolManifest);
      this.logger.debug({ skill: skillName, file }, 'tool manifest loaded');
    }

    return ok(manifests);
  }

  /**
   * Reads and validates MCP server definition JSON files from the `mcp/`
   * sub-directory.
   *
   * Files are sorted alphabetically. Missing `mcp/` directory is silently
   * treated as zero MCP server defs.
   */
  private async loadMcpServerDefs(
    skillDir: string,
    skillName: string,
  ): Promise<Result<McpServerDef[], SkillError>> {
    const mcpDir = join(skillDir, 'mcp');
    let files: string[];

    try {
      files = await readdir(mcpDir);
    } catch {
      this.logger.debug({ skill: skillName }, 'no mcp/ directory, skipping');
      return ok([]);
    }

    const jsonFiles = files.filter((f) => f.endsWith('.json')).sort();
    const defs: McpServerDef[] = [];

    for (const file of jsonFiles) {
      const filePath = join(mcpDir, file);
      let raw: unknown;

      try {
        const content = await readFile(filePath, 'utf-8');
        raw = JSON.parse(content);
      } catch (cause) {
        return err(
          new SkillError(
            `Failed to read MCP server definition "${filePath}" for skill "${skillName}": ${String(cause)}`,
            cause instanceof Error ? cause : undefined,
          ),
        );
      }

      const parseResult = McpServerDefFileSchema.safeParse(raw);
      if (!parseResult.success) {
        const issues = parseResult.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ');
        return err(
          new SkillError(
            `MCP server definition validation failed for "${filePath}" (skill "${skillName}"): ${issues}`,
          ),
        );
      }

      defs.push(parseResult.data as McpServerDef);
      this.logger.debug({ skill: skillName, file }, 'MCP server definition loaded');
    }

    return ok(defs);
  }

  /**
   * Collects absolute paths to SQL migration files from the `migrations/`
   * sub-directory.
   *
   * Files are sorted alphabetically. The loader does NOT execute migrations;
   * paths are returned for use by talonctl migrate.
   * Missing `migrations/` directory is silently treated as zero migrations.
   */
  private async collectMigrationPaths(
    skillDir: string,
    skillName: string,
  ): Promise<Result<string[], SkillError>> {
    const migrationsDir = join(skillDir, 'migrations');
    let files: string[];

    try {
      files = await readdir(migrationsDir);
    } catch {
      this.logger.debug({ skill: skillName }, 'no migrations/ directory, skipping');
      return ok([]);
    }

    const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();
    const paths = sqlFiles.map((f) => join(migrationsDir, f));

    this.logger.debug({ skill: skillName, count: paths.length }, 'migration paths collected');
    return ok(paths);
  }
}
