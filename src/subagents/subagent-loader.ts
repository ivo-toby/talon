/**
 * SubAgentLoader -- reads sub-agent directories from the filesystem,
 * parses YAML manifests, loads prompt fragments, and dynamically imports
 * the `run` function from entry points.
 *
 * Follows the same manifest-driven loading pattern as {@link SkillLoader}.
 *
 * Directory layout:
 *   subagents/{name}/
 *     subagent.yaml          -- required manifest
 *     index.js or index.ts   -- entry point exporting a `run` function
 *     prompts/*.md           -- prompt fragments (auto-discovered)
 *
 * If the subagents root directory does not exist the feature is treated as
 * optional and an empty array is returned. Directories without a manifest
 * are silently skipped; invalid manifests log a warning and are skipped.
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { type Dirent, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { ok, err, type Result } from 'neverthrow';
import type pino from 'pino';
import { SubAgentManifestSchema } from './subagent-schema.js';
import type { LoadedSubAgent, SubAgentRunFn } from './subagent-types.js';
import { SubAgentError } from '../core/errors/index.js';

// ---------------------------------------------------------------------------
// Capability label validation
// ---------------------------------------------------------------------------

/** Fully-qualified label: `domain.action:scope` (scope may be `*` wildcard) */
const CAPABILITY_WITH_SCOPE_RE = /^\w+\.\w+:[\w*]+$/;
/** Minimal label: `domain.action` (scope-less, accepted with warning) */
const CAPABILITY_WITHOUT_SCOPE_RE = /^\w+\.\w+$/;

/**
 * Validates a single capability label.
 *
 * Returns an object indicating whether the label is syntactically valid and
 * any warning message. A label matching neither pattern is invalid.
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
// SubAgentLoader
// ---------------------------------------------------------------------------

/**
 * Reads sub-agent directories from the filesystem and returns
 * {@link LoadedSubAgent} objects ready for orchestration.
 */
export class SubAgentLoader {
  constructor(private readonly logger: pino.Logger) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Loads all sub-agents from the given root directory.
   *
   * Each immediate child directory is inspected for a `subagent.yaml`
   * manifest. Directories without a manifest are silently skipped.
   * Invalid manifests or missing entry points log a warning and are
   * skipped -- they do not fail the entire load.
   *
   * @param rootDir - Absolute path to the sub-agents root directory.
   * @returns `Ok(LoadedSubAgent[])` -- may be empty if none found.
   */
  async loadAll(rootDir: string): Promise<Result<LoadedSubAgent[], SubAgentError>> {
    // If the directory does not exist, the feature is optional.
    try {
      await access(rootDir, fsConstants.R_OK);
    } catch {
      this.logger.debug({ rootDir }, 'subagent-loader: directory not found, skipping');
      return ok([]);
    }

    let entries: Dirent[];
    try {
      entries = await readdir(rootDir, { withFileTypes: true }) as Dirent[];
    } catch (cause) {
      return err(
        new SubAgentError(
          `Failed to read subagents directory "${rootDir}": ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }

    const agents: LoadedSubAgent[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const agentDir = join(rootDir, entry.name);
      const manifestPath = join(agentDir, 'subagent.yaml');

      // Skip directories without a manifest.
      try {
        await access(manifestPath, fsConstants.R_OK);
      } catch {
        continue;
      }

      const result = await this.loadOne(agentDir, manifestPath);
      if (result.isOk()) {
        agents.push(result.value);
        this.logger.info(
          { agent: result.value.manifest.name, agentDir },
          'subagent-loader: sub-agent loaded',
        );
      } else if (!result.error.message.includes('requires env vars')) {
        // Env-gating is expected (already logged at info in loadOne) — don't warn.
        this.logger.warn(
          { agentDir, error: result.error.message },
          'subagent-loader: skipping invalid sub-agent',
        );
      }
    }

    return ok(agents);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Loads a single sub-agent from its directory.
   *
   * Steps:
   *   1. Read and validate `subagent.yaml`.
   *   2. Validate capability labels.
   *   3. Dynamically import the entry point and extract the `run` function.
   *   4. Load prompt fragments from `prompts/*.md`.
   */
  private async loadOne(
    agentDir: string,
    manifestPath: string,
  ): Promise<Result<LoadedSubAgent, SubAgentError>> {
    // 1. Read and validate the manifest.
    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf-8');
    } catch (cause) {
      return err(
        new SubAgentError(
          `Failed to read manifest at "${manifestPath}": ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }

    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (cause) {
      return err(
        new SubAgentError(
          `Failed to parse YAML in "${manifestPath}": ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }

    const validated = SubAgentManifestSchema.safeParse(parsed);

    if (!validated.success) {
      const issues = validated.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      return err(
        new SubAgentError(
          `Invalid subagent.yaml in ${agentDir}: ${issues}`,
        ),
      );
    }

    // 2. Validate capability labels (consistent with SkillLoader).
    for (const label of validated.data.requiredCapabilities) {
      const { valid, warning, error } = validateCapabilityLabel(label);
      if (warning) {
        this.logger.warn(
          { agent: validated.data.name, label },
          warning,
        );
      }
      if (!valid) {
        return err(
          new SubAgentError(
            `Sub-agent "${validated.data.name}" has malformed requiredCapability: ${error ?? label}`,
          ),
        );
      }
    }

    // 3. Check required environment variables.
    const missingEnv = validated.data.requiresEnv.filter(
      (v) => !process.env[v],
    );
    if (missingEnv.length > 0) {
      this.logger.info(
        { agent: validated.data.name, missingEnv },
        'subagent-loader: skipping sub-agent (missing required env vars)',
      );
      return err(
        new SubAgentError(
          `Sub-agent "${validated.data.name}" requires env vars: ${missingEnv.join(', ')}`,
        ),
      );
    }

    // 4. Import the entry point.
    const runFn = await this.loadEntryPoint(agentDir);
    if (runFn === null) {
      return err(
        new SubAgentError(
          `No index.js or index.ts with run export found in ${agentDir}`,
        ),
      );
    }

    // 5. Load prompt fragments.
    const promptResult = await this.loadPrompts(agentDir);
    if (promptResult.isErr()) return err(promptResult.error);

    return ok({
      manifest: validated.data,
      promptContents: promptResult.value,
      run: runFn,
      rootDir: agentDir,
    });
  }

  /**
   * Dynamically imports the sub-agent entry point and extracts the run
   * function.
   *
   * Tries `index.js` first (compiled output), then `index.ts` (dev / tsx).
   * Accepts either a named `run` export or a `default` export. If a file
   * exists but has no usable export, continues to the next extension.
   *
   * @returns The run function, or `null` if no valid entry point found.
   */
  private async loadEntryPoint(agentDir: string): Promise<SubAgentRunFn | null> {
    for (const ext of ['js', 'ts']) {
      const entryPath = join(agentDir, `index.${ext}`);
      try {
        await access(entryPath, fsConstants.R_OK);
      } catch {
        continue;
      }

      try {
        const mod = await import(pathToFileURL(entryPath).href);
        if (typeof mod.run === 'function') return mod.run as SubAgentRunFn;
        if (typeof mod.default === 'function') return mod.default as SubAgentRunFn;
        // File exists but has no usable export -- try next extension.
        this.logger.debug(
          { entryPath },
          'subagent-loader: entry point has no run or default export, trying next',
        );
        continue;
      } catch (cause) {
        this.logger.debug(
          { entryPath, error: String(cause) },
          'subagent-loader: failed to import entry point',
        );
        continue;
      }
    }
    return null;
  }

  /**
   * Reads prompt fragment files from the `prompts/` sub-directory.
   *
   * Files are sorted alphabetically so concatenation order is deterministic.
   * A missing `prompts/` directory is treated as zero fragments.
   */
  private async loadPrompts(agentDir: string): Promise<Result<string[], SubAgentError>> {
    const promptsDir = join(agentDir, 'prompts');
    try {
      await access(promptsDir, fsConstants.R_OK);
    } catch {
      return ok([]);
    }

    let files: string[];
    try {
      files = await readdir(promptsDir);
    } catch (cause) {
      return err(
        new SubAgentError(
          `Failed to read prompts directory "${promptsDir}": ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }

    const mdFiles = files.filter((f) => f.endsWith('.md')).sort();
    const contents: string[] = [];

    for (const file of mdFiles) {
      const filePath = join(promptsDir, file);
      try {
        contents.push(await readFile(filePath, 'utf-8'));
      } catch (cause) {
        return err(
          new SubAgentError(
            `Failed to read prompt fragment "${filePath}": ${String(cause)}`,
            cause instanceof Error ? cause : undefined,
          ),
        );
      }
    }

    return ok(contents);
  }
}
