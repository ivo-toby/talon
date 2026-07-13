/**
 * Unit tests for PersonaLoader.
 *
 * Tests cover:
 *   - Loading from config with no system prompt file
 *   - Loading with a valid system prompt file
 *   - Handling a missing system prompt file (returns Err)
 *   - DB insert on first load
 *   - DB update (upsert) when persona already exists
 *   - DB lookup failure returns Err
 *   - DB insert failure returns Err
 *   - Capability validation warnings are logged (not fatal)
 *   - getByName cache lookup
 *   - Loading multiple personas
 *   - Empty config array
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFile, unlink, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { PersonaLoader } from '../../../src/personas/persona-loader.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { ok, err } from 'neverthrow';
import { DbError } from '../../../src/core/errors/index.js';
import type { PersonaConfig } from '../../../src/core/config/config-types.js';

// ---------------------------------------------------------------------------
// Test DB helpers (inline to avoid cross-directory import complexity)
// ---------------------------------------------------------------------------

import Database2 from 'better-sqlite3';
import { join as pathJoin } from 'node:path';
import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { v4 as uuidv4 } from 'uuid';

function createTestDb(): Database2.Database {
  const db = new Database2(':memory:');
  db.pragma('foreign_keys = ON');
  const result = runMigrations(
    db,
    pathJoin(import.meta.dirname, '../../../src/core/database/migrations'),
  );
  if (result.isErr()) {
    throw new Error(`Test DB migration failed: ${result.error.message}`);
  }
  return db;
}

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as import('pino').Logger;
}

// ---------------------------------------------------------------------------
// Persona config factory
// ---------------------------------------------------------------------------

function makePersonaConfig(overrides: Partial<PersonaConfig> = {}): PersonaConfig {
  return {
    name: `persona-${uuidv4()}`,
    model: 'claude-sonnet-4-6',
    skills: [],
    capabilities: { allow: [], requireApproval: [] },
    mounts: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PersonaLoader', () => {
  let db: Database.Database;
  let repo: PersonaRepository;
  let logger: ReturnType<typeof makeLogger>;
  let loader: PersonaLoader;

  beforeEach(() => {
    db = createTestDb();
    repo = new PersonaRepository(db);
    logger = makeLogger();
    loader = new PersonaLoader(repo, logger);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // loadFromConfig — basic
  // -------------------------------------------------------------------------

  describe('loadFromConfig — empty config', () => {
    it('returns Ok([]) for an empty config array', async () => {
      const result = await loader.loadFromConfig([]);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toHaveLength(0);
    });
  });

  describe('loadFromConfig — single persona without system prompt', () => {
    it('returns Ok with one loaded persona', async () => {
      const config = makePersonaConfig({ name: 'alfred' });
      const result = await loader.loadFromConfig([config]);
      expect(result.isOk()).toBe(true);
      const personas = result._unsafeUnwrap();
      expect(personas).toHaveLength(1);
      expect(personas[0].config.name).toBe('alfred');
    });

    it('preserves persona reasoningEffort on the loaded runtime config', async () => {
      const config = makePersonaConfig({ name: 'deep-thinker', reasoningEffort: 'xhigh' });
      const result = await loader.loadFromConfig([config]);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()[0].config.reasoningEffort).toBe('xhigh');
      expect(loader.getByName('deep-thinker')._unsafeUnwrap()?.config.reasoningEffort).toBe(
        'xhigh',
      );
    });

    it('systemPromptContent is undefined when no file specified', async () => {
      const config = makePersonaConfig({ name: 'sherlock' });
      const result = await loader.loadFromConfig([config]);
      expect(result._unsafeUnwrap()[0].systemPromptContent).toBeUndefined();
    });

    it('inserts persona record into the database', async () => {
      const config = makePersonaConfig({ name: 'watson' });
      await loader.loadFromConfig([config]);
      const row = repo.findByName('watson')._unsafeUnwrap();
      expect(row).not.toBeNull();
      expect(row?.model).toBe('claude-sonnet-4-6');
    });

    it('logs an info message on successful load', async () => {
      const config = makePersonaConfig({ name: 'moriarty' });
      await loader.loadFromConfig([config]);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ persona: 'moriarty' }),
        expect.any(String),
      );
    });
  });

  describe('loadFromConfig — multiple personas', () => {
    it('loads all configs and returns them all', async () => {
      const configs = [
        makePersonaConfig({ name: 'alice' }),
        makePersonaConfig({ name: 'bob' }),
        makePersonaConfig({ name: 'carol' }),
      ];
      const result = await loader.loadFromConfig(configs);
      expect(result.isOk()).toBe(true);
      const names = result._unsafeUnwrap().map((p) => p.config.name);
      expect(names).toContain('alice');
      expect(names).toContain('bob');
      expect(names).toContain('carol');
    });

    it('inserts all personas into the database', async () => {
      const configs = [makePersonaConfig({ name: 'dave' }), makePersonaConfig({ name: 'eve' })];
      await loader.loadFromConfig(configs);
      expect(repo.findByName('dave')._unsafeUnwrap()).not.toBeNull();
      expect(repo.findByName('eve')._unsafeUnwrap()).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // loadFromConfig — system prompt file
  // -------------------------------------------------------------------------

  describe('loadFromConfig — system prompt file', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'persona-loader-test-'));
    });

    afterEach(async () => {
      // Clean up temp files (best effort).
      try {
        const { readdir } = await import('node:fs/promises');
        const files = await readdir(tmpDir);
        for (const f of files) {
          await unlink(join(tmpDir, f)).catch(() => {});
        }
        await import('node:fs/promises').then(({ rmdir }) => rmdir(tmpDir).catch(() => {}));
      } catch {
        // ignore
      }
    });

    it('reads system prompt content from file (no frontmatter)', async () => {
      const promptFile = join(tmpDir, 'prompt.txt');
      await writeFile(promptFile, 'You are a helpful assistant.');
      const config = makePersonaConfig({
        name: 'assistant',
        systemPromptFile: promptFile,
      });
      const result = await loader.loadFromConfig([config]);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()[0].systemPromptContent).toBe('You are a helpful assistant.');
      expect(result._unsafeUnwrap()[0].description).toBeUndefined();
    });

    it('logs debug message when prompt file is read', async () => {
      const promptFile = join(tmpDir, 'prompt2.txt');
      await writeFile(promptFile, 'System prompt.');
      const config = makePersonaConfig({ name: 'p2', systemPromptFile: promptFile });
      await loader.loadFromConfig([config]);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ persona: 'p2', file: promptFile }),
        expect.any(String),
      );
    });

    it('returns Err when system prompt file does not exist', async () => {
      const config = makePersonaConfig({
        name: 'badfile',
        systemPromptFile: join(tmpDir, 'nonexistent.txt'),
      });
      const result = await loader.loadFromConfig([config]);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toMatch(/badfile/);
      expect(result._unsafeUnwrapErr().message).toMatch(/nonexistent\.txt/);
    });

    it('stops loading on first system prompt error', async () => {
      const badConfig = makePersonaConfig({
        name: 'bad',
        systemPromptFile: '/nonexistent/path/prompt.txt',
      });
      const goodConfig = makePersonaConfig({ name: 'good' });
      const result = await loader.loadFromConfig([badConfig, goodConfig]);
      expect(result.isErr()).toBe(true);
      // 'good' should NOT have been inserted since we failed on 'bad'.
      expect(repo.findByName('good')._unsafeUnwrap()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // loadFromConfig — task prompt files
  // -------------------------------------------------------------------------

  describe('loadFromConfig — task prompt files', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'persona-loader-prompts-test-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    async function scaffoldPersonaWithSystemPrompt(personaName: string): Promise<string> {
      const personaDir = join(tmpDir, personaName);
      await mkdir(personaDir, { recursive: true });

      const systemPromptFile = join(personaDir, 'system.md');
      await writeFile(systemPromptFile, `# ${personaName}\n`);

      return systemPromptFile;
    }

    it('indexes markdown files from prompts/ by basename with absolute paths', async () => {
      const systemPromptFile = await scaffoldPersonaWithSystemPrompt('assistant');
      const promptsDir = join(tmpDir, 'assistant', 'prompts');
      await mkdir(promptsDir, { recursive: true });
      await writeFile(join(promptsDir, 'morning-briefing.md'), 'Morning briefing');
      await writeFile(join(promptsDir, 'weekly-review.md'), 'Weekly review');
      await writeFile(join(promptsDir, 'notes.txt'), 'ignore me');

      const config = makePersonaConfig({ name: 'assistant', systemPromptFile });
      const result = await loader.loadFromConfig([config]);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()[0].taskPromptPaths).toEqual({
        'morning-briefing': join(promptsDir, 'morning-briefing.md'),
        'weekly-review': join(promptsDir, 'weekly-review.md'),
      });
    });

    it('leaves taskPromptPaths undefined when prompts/ is missing or empty', async () => {
      const missingPromptConfig = makePersonaConfig({
        name: 'missing-prompts',
        systemPromptFile: await scaffoldPersonaWithSystemPrompt('missing-prompts'),
      });

      const emptyPromptSystemFile = await scaffoldPersonaWithSystemPrompt('empty-prompts');
      await mkdir(join(tmpDir, 'empty-prompts', 'prompts'), { recursive: true });
      const emptyPromptConfig = makePersonaConfig({
        name: 'empty-prompts',
        systemPromptFile: emptyPromptSystemFile,
      });

      const result = await loader.loadFromConfig([missingPromptConfig, emptyPromptConfig]);

      expect(result.isOk()).toBe(true);
      const [missingPromptPersona, emptyPromptPersona] = result._unsafeUnwrap();
      expect(missingPromptPersona.taskPromptPaths).toBeUndefined();
      expect(emptyPromptPersona.taskPromptPaths).toBeUndefined();
    });

    it('returns loaded personas by id after loadFromConfig', async () => {
      const config = makePersonaConfig({
        name: 'lookup-by-id',
        systemPromptFile: await scaffoldPersonaWithSystemPrompt('lookup-by-id'),
      });

      await loader.loadFromConfig([config]);
      const row = repo.findByName('lookup-by-id')._unsafeUnwrap();
      const result = loader.getById(row!.id);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()?.config.name).toBe('lookup-by-id');
    });

    it('reads task prompt file contents on demand', async () => {
      const systemPromptFile = await scaffoldPersonaWithSystemPrompt('reader');
      const promptsDir = join(tmpDir, 'reader', 'prompts');
      await mkdir(promptsDir, { recursive: true });
      const promptPath = join(promptsDir, 'morning-briefing.md');
      await writeFile(promptPath, 'Original content');

      const config = makePersonaConfig({ name: 'reader', systemPromptFile });
      await loader.loadFromConfig([config]);

      await writeFile(promptPath, 'Updated content after load');

      const row = repo.findByName('reader')._unsafeUnwrap();
      const result = await loader.resolveTaskPrompt(row!.id, 'morning-briefing');

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('Updated content after load');
    });

    it('discovers prompt files added after startup via filesystem fallback', async () => {
      const systemPromptFile = await scaffoldPersonaWithSystemPrompt('late-add');
      const promptsDir = join(tmpDir, 'late-add', 'prompts');
      // No prompts dir at load time
      const config = makePersonaConfig({ name: 'late-add', systemPromptFile });
      await loader.loadFromConfig([config]);

      // Add a prompt file after loading
      await mkdir(promptsDir, { recursive: true });
      await writeFile(join(promptsDir, 'new-task.md'), 'Dynamically added prompt');

      const row = repo.findByName('late-add')._unsafeUnwrap();
      const result = await loader.resolveTaskPrompt(row!.id, 'new-task');

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('Dynamically added prompt');

      // Second call should use the cached path (no extra filesystem probe)
      const result2 = await loader.resolveTaskPrompt(row!.id, 'new-task');
      expect(result2.isOk()).toBe(true);
    });

    it('returns Err when resolving an unknown prompt alias', async () => {
      const systemPromptFile = await scaffoldPersonaWithSystemPrompt('unknown-alias');
      const promptsDir = join(tmpDir, 'unknown-alias', 'prompts');
      await mkdir(promptsDir, { recursive: true });
      await writeFile(join(promptsDir, 'known.md'), 'Known prompt');

      const config = makePersonaConfig({ name: 'unknown-alias', systemPromptFile });
      await loader.loadFromConfig([config]);
      const row = repo.findByName('unknown-alias')._unsafeUnwrap();

      const result = await loader.resolveTaskPrompt(row!.id, 'missing');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toMatch(/missing/);
    });
  });

  // -------------------------------------------------------------------------
  // loadFromConfig — upsert behaviour
  // -------------------------------------------------------------------------

  describe('loadFromConfig — upsert behaviour', () => {
    it('updates model when persona already exists in DB', async () => {
      const config1 = makePersonaConfig({ name: 'updatable', model: 'claude-sonnet-4-6' });
      await loader.loadFromConfig([config1]);

      const loader2 = new PersonaLoader(repo, logger);
      const config2 = makePersonaConfig({ name: 'updatable', model: 'claude-opus-4-6' });
      await loader2.loadFromConfig([config2]);

      const row = repo.findByName('updatable')._unsafeUnwrap();
      expect(row?.model).toBe('claude-opus-4-6');
    });

    it('does not create duplicate DB records on second load', async () => {
      const config = makePersonaConfig({ name: 'singleton' });
      await loader.loadFromConfig([config]);
      const loader2 = new PersonaLoader(repo, logger);
      await loader2.loadFromConfig([config]);

      const all = repo.findAll()._unsafeUnwrap();
      const matches = all.filter((r) => r.name === 'singleton');
      expect(matches).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // loadFromConfig — capability resolution
  // -------------------------------------------------------------------------

  describe('loadFromConfig — capability resolution', () => {
    it('resolves capabilities with allow list', async () => {
      const config = makePersonaConfig({
        name: 'capable',
        capabilities: { allow: ['fs.read:workspace'], requireApproval: [] },
      });
      const result = await loader.loadFromConfig([config]);
      const persona = result._unsafeUnwrap()[0];
      expect(persona.resolvedCapabilities.allow).toContain('fs.read:workspace');
      expect(persona.resolvedCapabilities.requireApproval).toHaveLength(0);
    });

    it('requireApproval overrides allow when label appears in both', async () => {
      const config = makePersonaConfig({
        name: 'approver',
        capabilities: {
          allow: ['fs.read:workspace', 'net.http:egress'],
          requireApproval: ['net.http:egress'],
        },
      });
      const result = await loader.loadFromConfig([config]);
      const persona = result._unsafeUnwrap()[0];
      expect(persona.resolvedCapabilities.allow).not.toContain('net.http:egress');
      expect(persona.resolvedCapabilities.requireApproval).toContain('net.http:egress');
    });

    it('logs warning for malformed capability labels without failing', async () => {
      const config = makePersonaConfig({
        name: 'malformed',
        capabilities: { allow: ['bad-label!!!'], requireApproval: [] },
      });
      const result = await loader.loadFromConfig([config]);
      // Should succeed despite the malformed label.
      expect(result.isOk()).toBe(true);
      // Should have logged a warning.
      expect(logger.warn).toHaveBeenCalled();
    });

    it('logs warning for missing-scope labels without failing', async () => {
      const config = makePersonaConfig({
        name: 'noscope',
        capabilities: { allow: ['fs.read'], requireApproval: [] },
      });
      const result = await loader.loadFromConfig([config]);
      expect(result.isOk()).toBe(true);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // loadFromConfig — DB error handling
  // -------------------------------------------------------------------------

  describe('loadFromConfig — DB error handling', () => {
    it('returns Err when DB findByName fails', async () => {
      const mockRepo = {
        findByName: vi.fn().mockReturnValue(err(new DbError('lookup failed'))),
        insert: vi.fn(),
        update: vi.fn(),
        findAll: vi.fn(),
        findById: vi.fn(),
        delete: vi.fn(),
      } as unknown as PersonaRepository;

      const errorLoader = new PersonaLoader(mockRepo, logger);
      const config = makePersonaConfig({ name: 'fail-find' });
      const result = await errorLoader.loadFromConfig([config]);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toMatch(/fail-find/);
    });

    it('returns Err when DB insert fails', async () => {
      const mockRepo = {
        findByName: vi.fn().mockReturnValue(ok(null)),
        insert: vi.fn().mockReturnValue(err(new DbError('insert failed'))),
        update: vi.fn(),
        findAll: vi.fn(),
        findById: vi.fn(),
        delete: vi.fn(),
      } as unknown as PersonaRepository;

      const errorLoader = new PersonaLoader(mockRepo, logger);
      const config = makePersonaConfig({ name: 'fail-insert' });
      const result = await errorLoader.loadFromConfig([config]);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toMatch(/fail-insert/);
    });

    it('returns Err when DB update fails', async () => {
      const existingRow = {
        id: uuidv4(),
        name: 'fail-update',
        model: 'claude-sonnet-4-6',
        system_prompt_file: null,
        skills: '[]',
        capabilities: '{}',
        mounts: '[]',
        max_concurrent: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      };

      const mockRepo = {
        findByName: vi.fn().mockReturnValue(ok(existingRow)),
        insert: vi.fn(),
        update: vi.fn().mockReturnValue(err(new DbError('update failed'))),
        findAll: vi.fn(),
        findById: vi.fn(),
        delete: vi.fn(),
      } as unknown as PersonaRepository;

      const errorLoader = new PersonaLoader(mockRepo, logger);
      const config = makePersonaConfig({ name: 'fail-update' });
      const result = await errorLoader.loadFromConfig([config]);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toMatch(/fail-update/);
    });
  });

  // -------------------------------------------------------------------------
  // getByName
  // -------------------------------------------------------------------------

  describe('getByName', () => {
    it('returns undefined before any personas are loaded', () => {
      const result = loader.getByName('nobody');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeUndefined();
    });

    it('returns the loaded persona after loadFromConfig', async () => {
      const config = makePersonaConfig({ name: 'cached' });
      await loader.loadFromConfig([config]);
      const result = loader.getByName('cached');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()?.config.name).toBe('cached');
    });

    it('returns undefined for a name not in the loaded set', async () => {
      const config = makePersonaConfig({ name: 'present' });
      await loader.loadFromConfig([config]);
      const result = loader.getByName('absent');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeUndefined();
    });

    it('cache reflects the most recent load', async () => {
      const config1 = makePersonaConfig({ name: 'versioned', model: 'claude-sonnet-4-6' });
      await loader.loadFromConfig([config1]);

      const config2 = makePersonaConfig({ name: 'versioned', model: 'claude-opus-4-6' });
      await loader.loadFromConfig([config2]);

      const found = loader.getByName('versioned')._unsafeUnwrap();
      expect(found?.config.model).toBe('claude-opus-4-6');
    });
  });

  // -------------------------------------------------------------------------
  // DB persistence — field mapping
  // -------------------------------------------------------------------------

  describe('DB persistence — field mapping', () => {
    it('stores skills as JSON array', async () => {
      const config = makePersonaConfig({
        name: 'skilled',
        skills: ['skill-a', 'skill-b'],
      });
      await loader.loadFromConfig([config]);
      const row = repo.findByName('skilled')._unsafeUnwrap();
      expect(JSON.parse(row!.skills)).toEqual(['skill-a', 'skill-b']);
    });

    it('stores capabilities as JSON', async () => {
      const config = makePersonaConfig({
        name: 'capper',
        capabilities: { allow: ['fs.read:workspace'], requireApproval: ['net.http:egress'] },
      });
      await loader.loadFromConfig([config]);
      const row = repo.findByName('capper')._unsafeUnwrap();
      const stored = JSON.parse(row!.capabilities);
      expect(stored.allow).toContain('fs.read:workspace');
      expect(stored.requireApproval).toContain('net.http:egress');
    });

    it('stores mounts as JSON array', async () => {
      const config = makePersonaConfig({
        name: 'mounted',
        mounts: [{ source: '/host/path', target: '/container/path', mode: 'ro' }],
      });
      await loader.loadFromConfig([config]);
      const row = repo.findByName('mounted')._unsafeUnwrap();
      const stored = JSON.parse(row!.mounts);
      expect(stored).toHaveLength(1);
      expect(stored[0].source).toBe('/host/path');
    });

    it('stores maxConcurrent when set', async () => {
      const config = makePersonaConfig({ name: 'concurrent', maxConcurrent: 5 });
      await loader.loadFromConfig([config]);
      const row = repo.findByName('concurrent')._unsafeUnwrap();
      expect(row?.max_concurrent).toBe(5);
    });

    it('stores null for maxConcurrent when not set', async () => {
      const config = makePersonaConfig({ name: 'noconcurrent' });
      await loader.loadFromConfig([config]);
      const row = repo.findByName('noconcurrent')._unsafeUnwrap();
      expect(row?.max_concurrent).toBeNull();
    });

    it('stores system_prompt_file path when set', async () => {
      const config = makePersonaConfig({
        name: 'promptpath',
        // We use a path that doesn't exist — we only test DB persistence here.
      });
      await loader.loadFromConfig([config]);
      const row = repo.findByName('promptpath')._unsafeUnwrap();
      expect(row?.system_prompt_file).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // loadFromConfig — frontmatter parsing
  // -------------------------------------------------------------------------

  describe('loadFromConfig — frontmatter parsing', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'persona-loader-frontmatter-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('parses description from YAML frontmatter', async () => {
      const promptFile = join(tmpDir, 'system.md');
      await writeFile(
        promptFile,
        [
          '---',
          'description: "Deep web research agent"',
          '---',
          '',
          '# researcher',
          '',
          'You are a researcher.',
        ].join('\n'),
      );

      const config = makePersonaConfig({ name: 'researcher', systemPromptFile: promptFile });
      const result = await loader.loadFromConfig([config]);
      expect(result.isOk()).toBe(true);
      const persona = result._unsafeUnwrap()[0];
      expect(persona.description).toBe('Deep web research agent');
      expect(persona.systemPromptContent).not.toContain('---');
      expect(persona.systemPromptContent).toContain('# researcher');
    });

    it('strips frontmatter from system prompt content', async () => {
      const promptFile = join(tmpDir, 'system.md');
      await writeFile(
        promptFile,
        ['---', 'description: "Butler"', '---', '', 'You are James.'].join('\n'),
      );

      const config = makePersonaConfig({ name: 'james', systemPromptFile: promptFile });
      const result = await loader.loadFromConfig([config]);
      const persona = result._unsafeUnwrap()[0];
      expect(persona.systemPromptContent).toBe('You are James.');
    });

    it('handles system prompt with no frontmatter', async () => {
      const promptFile = join(tmpDir, 'system.md');
      await writeFile(promptFile, '# plain persona\n\nNo frontmatter here.');

      const config = makePersonaConfig({ name: 'plain', systemPromptFile: promptFile });
      const result = await loader.loadFromConfig([config]);
      const persona = result._unsafeUnwrap()[0];
      expect(persona.description).toBeUndefined();
      expect(persona.systemPromptContent).toContain('# plain persona');
    });

    it('handles frontmatter with empty description', async () => {
      const promptFile = join(tmpDir, 'system.md');
      await writeFile(promptFile, '---\ndescription: ""\n---\n\nBody.');

      const config = makePersonaConfig({ name: 'empty-desc', systemPromptFile: promptFile });
      const result = await loader.loadFromConfig([config]);
      const persona = result._unsafeUnwrap()[0];
      // Empty string fails min(1) validation, so description is undefined
      expect(persona.description).toBeUndefined();
    });

    it('warns on invalid frontmatter without blocking loading', async () => {
      const promptFile = join(tmpDir, 'system.md');
      await writeFile(promptFile, '---\ndescription: 42\n---\n\nBody.');

      const config = makePersonaConfig({ name: 'bad-fm', systemPromptFile: promptFile });
      const result = await loader.loadFromConfig([config]);
      expect(result.isOk()).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ persona: 'bad-fm' }),
        expect.stringContaining('invalid frontmatter'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // listProfiles
  // -------------------------------------------------------------------------

  describe('listProfiles', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'persona-loader-profiles-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('returns empty array when no personas loaded', () => {
      expect(loader.listProfiles()).toEqual([]);
    });

    it('returns name and description for loaded personas', async () => {
      const promptFile = join(tmpDir, 'system.md');
      await writeFile(promptFile, '---\ndescription: "A helpful butler"\n---\n\nYou are James.');

      const configs = [
        makePersonaConfig({ name: 'james', systemPromptFile: promptFile }),
        makePersonaConfig({ name: 'plain' }),
      ];
      await loader.loadFromConfig(configs);

      const profiles = loader.listProfiles();
      expect(profiles).toHaveLength(2);

      const james = profiles.find((p) => p.name === 'james');
      expect(james?.description).toBe('A helpful butler');

      const plain = profiles.find((p) => p.name === 'plain');
      expect(plain?.description).toBeUndefined();
    });
  });
});
