/**
 * PersonaLoader — loads and hydrates persona definitions from configuration.
 *
 * Responsibilities:
 *   1. Read optional system-prompt files from disk.
 *   2. Resolve effective capabilities by merging persona-level grants.
 *   3. Validate capability labels (warn-only — never fails loading).
 *   4. Upsert persona records to the database via PersonaRepository.
 *   5. Maintain an in-process cache for fast name-based lookups.
 */

import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, type Result } from 'neverthrow';
import matter from 'gray-matter';
import type pino from 'pino';
import { PersonaError } from '../core/errors/index.js';
import type { PersonaRepository } from '../core/database/repositories/persona-repository.js';
import type { PersonaConfig } from '../core/config/config-types.js';
import { mergeCapabilities, validateCapabilityLabels } from './capability-merger.js';
import { PersonaFrontmatterSchema } from './persona-schema.js';
import type { LoadedPersona, ResolvedCapabilities } from './persona-types.js';

// ---------------------------------------------------------------------------
// PersonaLoader
// ---------------------------------------------------------------------------

/**
 * Loads persona definitions from config, persists them to the database, and
 * provides a name-keyed cache for fast runtime lookups.
 */
export class PersonaLoader {
  /** In-process cache populated after `loadFromConfig`. */
  private readonly cache = new Map<string, LoadedPersona>();
  /** Secondary cache keyed by persisted persona ID. */
  private readonly idCache = new Map<string, LoadedPersona>();

  constructor(
    private readonly personaRepo: PersonaRepository,
    private readonly logger: pino.Logger,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Loads all persona configs, reads system prompt files, resolves capabilities,
   * upserts to the database, and populates the internal cache.
   *
   * If any single persona fails (e.g. system prompt file unreadable, DB write
   * error) the entire operation returns an `Err`. The error message identifies
   * which persona caused the failure.
   *
   * @param configs - Array of persona config objects from the daemon config file.
   * @returns `Ok(LoadedPersona[])` on success, `Err(PersonaError)` on failure.
   */
  async loadFromConfig(configs: PersonaConfig[]): Promise<Result<LoadedPersona[], PersonaError>> {
    // Clear caches so removed personas don't linger after a reload.
    this.cache.clear();
    this.idCache.clear();

    const loaded: LoadedPersona[] = [];

    for (const config of configs) {
      const result = await this.loadOne(config);
      if (result.isErr()) {
        return err(result.error);
      }
      loaded.push(result.value);
    }

    return ok(loaded);
  }

  /**
   * Looks up a previously-loaded persona by its name.
   *
   * Returns `undefined` if no persona with that name was loaded (e.g. if
   * `loadFromConfig` has not been called yet, or the name does not exist in
   * the config).
   *
   * @param name - The persona name to look up.
   * @returns `Ok(LoadedPersona | undefined)`.
   */
  getByName(name: string): Result<LoadedPersona | undefined, PersonaError> {
    return ok(this.cache.get(name));
  }

  /**
   * Returns the names of all loaded personas.
   */
  listNames(): string[] {
    return [...this.cache.keys()];
  }

  /**
   * Returns name + description for all loaded personas.
   * Used by the `background_agent profiles` action.
   */
  listProfiles(): Array<{ name: string; description?: string }> {
    return [...this.cache.entries()].map(([name, loaded]) => ({
      name,
      description: loaded.description,
    }));
  }

  /**
   * Looks up a previously-loaded persona by its persisted database ID.
   *
   * @param id - Persona primary key.
   * @returns `Ok(LoadedPersona | undefined)`.
   */
  getById(id: string): Result<LoadedPersona | undefined, PersonaError> {
    return ok(this.idCache.get(id));
  }

  /**
   * Resolves a task prompt alias to file contents for a loaded persona.
   *
   * @param personaId  - Persisted persona ID.
   * @param promptFile - Prompt basename without `.md`.
   */
  async resolveTaskPrompt(
    personaId: string,
    promptFile: string,
  ): Promise<Result<string, PersonaError>> {
    const loadedPersona = this.idCache.get(personaId);
    if (!loadedPersona) {
      return err(new PersonaError(`No loaded persona found for id "${personaId}"`));
    }

    let promptPath = loadedPersona.taskPromptPaths?.[promptFile];

    // Filesystem fallback: if the alias isn't in the startup index (e.g. the
    // file was added after the daemon started), try to resolve it directly.
    if (!promptPath && loadedPersona.config.systemPromptFile) {
      const candidate = join(
        dirname(resolve(loadedPersona.config.systemPromptFile)),
        'prompts',
        `${promptFile}.md`,
      );
      try {
        await readFile(candidate, 'utf-8'); // probe existence
        promptPath = candidate;
        // Update the index so subsequent lookups are fast.
        if (!loadedPersona.taskPromptPaths) {
          loadedPersona.taskPromptPaths = {};
        }
        loadedPersona.taskPromptPaths[promptFile] = candidate;
        this.logger.info(
          { persona: loadedPersona.config.name, promptFile },
          'task prompt discovered via filesystem fallback',
        );
      } catch {
        // File doesn't exist — fall through to the error below.
      }
    }

    if (!promptPath) {
      return err(
        new PersonaError(
          `Task prompt "${promptFile}" not found for persona "${loadedPersona.config.name}"`,
        ),
      );
    }

    try {
      return ok(await readFile(promptPath, 'utf-8'));
    } catch (cause) {
      return err(
        new PersonaError(
          `Failed to read task prompt "${promptFile}" for persona "${loadedPersona.config.name}": ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Loads a single persona: reads system prompt, resolves capabilities, upserts
   * to DB, and stores in cache.
   */
  private async loadOne(config: PersonaConfig): Promise<Result<LoadedPersona, PersonaError>> {
    // 1. Read system prompt file if specified, parsing optional frontmatter.
    let systemPromptContent: string | undefined;
    let description: string | undefined;
    if (config.systemPromptFile) {
      const readResult = await this.readSystemPrompt(config.systemPromptFile, config.name);
      if (readResult.isErr()) {
        return err(readResult.error);
      }
      systemPromptContent = readResult.value.content;
      description = readResult.value.description;
    }

    // 2. Read personality folder if present (sibling to system prompt file).
    let personalityContent: string | undefined;
    if (config.systemPromptFile) {
      personalityContent = await this.readPersonalityFolder(config.systemPromptFile, config.name);
    }

    // 2b. Index task prompt files for on-demand scheduled task resolution.
    let taskPromptPaths: Record<string, string> | undefined;
    if (config.systemPromptFile) {
      taskPromptPaths = await this.readTaskPromptPaths(config.systemPromptFile, config.name);
    }

    // 3. Resolve effective capabilities (persona-level only at load time;
    //    skill-level merging happens at runtime when skills are attached).
    const resolvedCapabilities: ResolvedCapabilities = mergeCapabilities(config.capabilities);

    // 4. Validate labels — emit warnings but never block loading.
    const { warnings } = validateCapabilityLabels(resolvedCapabilities);
    for (const warning of warnings) {
      this.logger.warn({ persona: config.name }, warning);
    }

    // 5. Upsert to the database.
    const upsertResult = this.upsertPersona(config);
    if (upsertResult.isErr()) {
      return err(upsertResult.error);
    }

    // 6. Build the loaded persona and cache it.
    const loadedPersona: LoadedPersona = {
      config,
      description,
      systemPromptContent,
      personalityContent,
      taskPromptPaths,
      resolvedCapabilities,
    };

    this.cache.set(config.name, loadedPersona);
    this.idCache.set(upsertResult.value, loadedPersona);
    this.logger.info({ persona: config.name }, 'persona loaded');

    return ok(loadedPersona);
  }

  /**
   * Reads a system prompt file from disk and parses optional YAML frontmatter.
   *
   * Returns the body content (frontmatter stripped) and any parsed frontmatter
   * fields. If the file has no frontmatter, the full content is returned as-is.
   *
   * @param filePath  - Path to the system prompt file.
   * @param personaName - Persona name (used in error messages).
   */
  private async readSystemPrompt(
    filePath: string,
    personaName: string,
  ): Promise<Result<{ content: string; description?: string }, PersonaError>> {
    try {
      const raw = await readFile(filePath, 'utf-8');
      const { data, content } = matter(raw);

      // Validate frontmatter — warn on invalid, never block loading.
      let description: string | undefined;
      const parsed = PersonaFrontmatterSchema.safeParse(data);
      if (parsed.success) {
        description = parsed.data.description;
      } else if (Object.keys(data).length > 0) {
        this.logger.warn(
          { persona: personaName, errors: parsed.error.issues },
          'invalid frontmatter in system prompt file — ignoring',
        );
      }

      this.logger.debug({ persona: personaName, file: filePath }, 'system prompt file read');
      return ok({ content: content.trim(), description });
    } catch (cause) {
      return err(
        new PersonaError(
          `Failed to read system prompt file "${filePath}" for persona "${personaName}": ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Reads all `.md` files from the `personality/` folder adjacent to the system
   * prompt file. Files are sorted alphabetically and concatenated with double
   * newlines. Returns `undefined` if the folder doesn't exist or is empty.
   */
  private async readPersonalityFolder(
    systemPromptFile: string,
    personaName: string,
  ): Promise<string | undefined> {
    const personaDir = dirname(systemPromptFile);
    const personalityDir = join(personaDir, 'personality');

    let entries: string[];
    try {
      entries = await readdir(personalityDir);
    } catch (cause: unknown) {
      // ENOENT is expected — folder simply doesn't exist.
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
        return undefined;
      }
      // Surface other errors (EACCES, ENOTDIR, etc.) so misconfigs aren't silent.
      this.logger.warn(
        { persona: personaName, err: cause },
        'failed to read personality folder',
      );
      return undefined;
    }

    const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();
    if (mdFiles.length === 0) return undefined;

    const contents: string[] = [];
    for (const file of mdFiles) {
      try {
        const trimmed = (await readFile(join(personalityDir, file), 'utf-8')).trim();
        if (trimmed.length > 0) {
          contents.push(trimmed);
        }
      } catch (cause) {
        this.logger.warn(
          { persona: personaName, file, err: cause },
          'failed to read personality file, skipping',
        );
      }
    }

    if (contents.length === 0) return undefined;

    this.logger.debug(
      { persona: personaName, files: contents.length },
      'personality files loaded',
    );

    return contents.join('\n\n');
  }

  /**
   * Indexes all `.md` files from the `prompts/` folder adjacent to the system
   * prompt file. Returns a record keyed by basename without extension.
   */
  private async readTaskPromptPaths(
    systemPromptFile: string,
    personaName: string,
  ): Promise<Record<string, string> | undefined> {
    const promptsDir = join(dirname(resolve(systemPromptFile)), 'prompts');

    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(promptsDir, { withFileTypes: true });
    } catch (cause: unknown) {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
        return undefined;
      }
      this.logger.warn(
        { persona: personaName, err: cause },
        'failed to read prompts folder',
      );
      return undefined;
    }

    const mdFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort();
    if (mdFiles.length === 0) {
      return undefined;
    }

    const taskPromptPaths: Record<string, string> = {};
    for (const file of mdFiles) {
      taskPromptPaths[basename(file, '.md')] = join(promptsDir, file);
    }

    this.logger.debug(
      { persona: personaName, files: mdFiles.length },
      'task prompt files indexed',
    );

    return taskPromptPaths;
  }

  /**
   * Upserts a persona to the database.
   *
   * Attempts to find an existing record by name and update it; if none exists,
   * inserts a new record. This ensures idempotent startup behaviour.
   *
   * @param config - The persona config to persist.
   */
  private upsertPersona(config: PersonaConfig): Result<string, PersonaError> {
    // Check if persona already exists.
    const findResult = this.personaRepo.findByName(config.name);
    if (findResult.isErr()) {
      return err(
        new PersonaError(
          `Database lookup failed for persona "${config.name}": ${findResult.error.message}`,
          findResult.error,
        ),
      );
    }

    const existingRow = findResult.value;

    if (existingRow) {
      // Update existing record.
      const updateResult = this.personaRepo.update(existingRow.id, {
        model: config.model,
        system_prompt_file: config.systemPromptFile ?? null,
        skills: JSON.stringify(config.skills),
        capabilities: JSON.stringify(config.capabilities),
        mounts: JSON.stringify(config.mounts),
        max_concurrent: config.maxConcurrent ?? null,
      });

      if (updateResult.isErr()) {
        return err(
          new PersonaError(
            `Failed to update persona "${config.name}" in database: ${updateResult.error.message}`,
            updateResult.error,
          ),
        );
      }

      this.logger.debug({ persona: config.name }, 'persona record updated in database');
      return ok(existingRow.id);
    } else {
      // Insert new record.
      const insertResult = this.personaRepo.insert({
        id: uuidv4(),
        name: config.name,
        model: config.model,
        system_prompt_file: config.systemPromptFile ?? null,
        skills: JSON.stringify(config.skills),
        capabilities: JSON.stringify(config.capabilities),
        mounts: JSON.stringify(config.mounts),
        max_concurrent: config.maxConcurrent ?? null,
      });

      if (insertResult.isErr()) {
        return err(
          new PersonaError(
            `Failed to insert persona "${config.name}" into database: ${insertResult.error.message}`,
            insertResult.error,
          ),
        );
      }

      this.logger.debug({ persona: config.name }, 'persona record inserted into database');
      return ok(insertResult.value.id);
    }
  }
}
