/**
 * Unit tests for SkillLoader.
 *
 * Tests use real temporary directories (fs.mkdtemp) for realistic I/O.
 *
 * Coverage areas:
 *   - Loading a minimal valid skill directory (manifest only)
 *   - Loading with prompt fragments, tool manifests, MCP defs, migrations
 *   - Manifest validation failures (missing required fields, bad YAML)
 *   - Capability label validation (malformed = error, scope-less = warning)
 *   - Missing sub-directories are silently skipped
 *   - Unreadable files produce Err
 *   - Tool manifest YAML validation failures
 *   - MCP definition JSON validation failures
 *   - loadMultiple: success and fail-fast on first error
 *   - Alphabetical ordering of discovered files
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillLoader } from '../../../src/skills/skill-loader.js';
import { SkillError } from '../../../src/core/errors/index.js';

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
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a temporary directory and returns its path. Automatically cleaned
 * up in afterEach via the cleanup array.
 */
async function makeTmpDir(cleanupFns: Array<() => Promise<void>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'skill-loader-test-'));
  cleanupFns.push(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * Writes a minimal valid skill.yaml to the given directory.
 */
async function writeMinimalManifest(skillDir: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const manifest = {
    name: 'test-skill',
    version: '1.0.0',
    description: 'A test skill',
    ...overrides,
  };
  const lines = Object.entries(manifest)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        if (v.length === 0) return `${k}: []`;
        return `${k}:\n${v.map((item) => `  - ${item}`).join('\n')}`;
      }
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join('\n');
  await writeFile(join(skillDir, 'skill.yaml'), lines, 'utf-8');
}

/**
 * Writes a minimal valid SKILL.md with YAML frontmatter to the given directory.
 */
async function writeSkillMd(
  skillDir: string,
  frontmatter: Record<string, unknown> = {},
  body = 'Default skill body.',
): Promise<void> {
  const manifest = {
    name: 'test-skill',
    description: 'A test skill',
    version: '1.0.0',
    ...frontmatter,
  };
  const lines = Object.entries(manifest)
    .filter(([, value]) => value !== undefined)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        if (v.length === 0) return `${k}: []`;
        return `${k}:\n${v.map((item) => `  - ${item}`).join('\n')}`;
      }
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join('\n');

  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\n${lines}\n---\n\n${body}\n`,
    'utf-8',
  );
}

/**
 * Returns a minimal ToolManifest YAML string.
 */
function toolManifestYaml(name = 'test-tool'): string {
  return [
    `name: ${name}`,
    `description: A test tool`,
    `capabilities: []`,
    `executionLocation: host`,
  ].join('\n');
}

/**
 * Returns a minimal McpServerDef JSON string.
 */
function mcpServerDefJson(name = 'test-mcp'): string {
  return JSON.stringify({
    name,
    config: {
      name,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', `@some/${name}`],
    },
  }, null, 2);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillLoader', () => {
  let logger: ReturnType<typeof makeLogger>;
  let loader: SkillLoader;
  const cleanup: Array<() => Promise<void>> = [];

  beforeEach(() => {
    logger = makeLogger();
    loader = new SkillLoader(logger);
  });

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) {
      await fn();
    }
  });

  // -------------------------------------------------------------------------
  // loadFromDirectory — happy path
  // -------------------------------------------------------------------------

  describe('loadFromDirectory — minimal valid skill', () => {
    it('returns Ok(LoadedSkill) for a skill with only skill.yaml', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isOk()).toBe(true);
      const skill = result._unsafeUnwrap();
      expect(skill.manifest.name).toBe('test-skill');
      expect(skill.manifest.version).toBe('1.0.0');
      expect(skill.manifest.description).toBe('A test skill');
    });

    it('returns empty arrays for all content when sub-dirs are absent', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);

      const result = await loader.loadFromDirectory(skillDir);
      const skill = result._unsafeUnwrap();
      expect(skill.promptContents).toHaveLength(0);
      expect(skill.resolvedToolManifests).toHaveLength(0);
      expect(skill.resolvedMcpServers).toHaveLength(0);
      expect(skill.migrationPaths).toHaveLength(0);
    });

    it('logs info message when skill is loaded', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);

      await loader.loadFromDirectory(skillDir);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ skill: 'test-skill' }),
        expect.any(String),
      );
    });
  });

  // -------------------------------------------------------------------------
  // loadFromDirectory — SKILL.md format
  // -------------------------------------------------------------------------

  describe('SKILL.md format', () => {
    it('loads skill from SKILL.md with frontmatter', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeSkillMd(
        skillDir,
        {
          name: 'markdown-skill',
          description: 'Skill loaded from markdown',
        },
        '# Markdown Skill\n\nUse this skill carefully.',
      );

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isOk()).toBe(true);

      const skill = result._unsafeUnwrap();
      expect(skill.manifest.name).toBe('markdown-skill');
      expect(skill.manifest.description).toBe('Skill loaded from markdown');
      expect(skill.format).toBe('skillmd');
      expect(skill.promptContents).toEqual(['# Markdown Skill\n\nUse this skill carefully.']);
    });

    it('errors when both skill.yaml and SKILL.md exist', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);
      await writeSkillMd(skillDir);

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toMatch(/ambiguous/i);
    });

    it('loads MCP servers from mcp/ alongside SKILL.md', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeSkillMd(skillDir);
      const mcpDir = join(skillDir, 'mcp');
      await mkdir(mcpDir);
      await writeFile(join(mcpDir, 'server.json'), mcpServerDefJson('server'), 'utf-8');

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isOk()).toBe(true);

      const skill = result._unsafeUnwrap();
      expect(skill.format).toBe('skillmd');
      expect(skill.resolvedMcpServers).toHaveLength(1);
      expect(skill.resolvedMcpServers[0].name).toBe('server');
    });

    it('defaults version to 0.1.0 when omitted in frontmatter', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeSkillMd(
        skillDir,
        {
          name: 'versionless-skill',
          description: 'No explicit version',
          version: undefined,
        },
        'Body',
      );

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().manifest.version).toBe('0.1.0');
    });
  });

  // -------------------------------------------------------------------------
  // loadFromDirectory — prompt fragments
  // -------------------------------------------------------------------------

  describe('loadFromDirectory — prompt fragments', () => {
    it('loads .md files from the prompts/ directory', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);
      const promptsDir = join(skillDir, 'prompts');
      await mkdir(promptsDir);
      await writeFile(join(promptsDir, 'intro.md'), '# Introduction', 'utf-8');

      const result = await loader.loadFromDirectory(skillDir);
      const skill = result._unsafeUnwrap();
      expect(skill.promptContents).toHaveLength(1);
      expect(skill.promptContents[0]).toBe('# Introduction');
    });

    it('loads multiple prompt fragments in alphabetical order', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);
      const promptsDir = join(skillDir, 'prompts');
      await mkdir(promptsDir);
      await writeFile(join(promptsDir, 'b-second.md'), 'Second', 'utf-8');
      await writeFile(join(promptsDir, 'a-first.md'), 'First', 'utf-8');
      await writeFile(join(promptsDir, 'c-third.md'), 'Third', 'utf-8');

      const result = await loader.loadFromDirectory(skillDir);
      const skill = result._unsafeUnwrap();
      expect(skill.promptContents).toHaveLength(3);
      expect(skill.promptContents[0]).toBe('First');
      expect(skill.promptContents[1]).toBe('Second');
      expect(skill.promptContents[2]).toBe('Third');
    });

    it('ignores non-.md files in prompts/ directory', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);
      const promptsDir = join(skillDir, 'prompts');
      await mkdir(promptsDir);
      await writeFile(join(promptsDir, 'fragment.md'), 'Content', 'utf-8');
      await writeFile(join(promptsDir, 'readme.txt'), 'Not a fragment', 'utf-8');

      const result = await loader.loadFromDirectory(skillDir);
      const skill = result._unsafeUnwrap();
      expect(skill.promptContents).toHaveLength(1);
    });

    it('silently returns empty array when prompts/ is absent', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().promptContents).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // loadFromDirectory — tool manifests
  // -------------------------------------------------------------------------

  describe('loadFromDirectory — tool manifests', () => {
    it('loads valid tool manifest YAML files from tools/', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);
      const toolsDir = join(skillDir, 'tools');
      await mkdir(toolsDir);
      await writeFile(join(toolsDir, 'search.yaml'), toolManifestYaml('search'), 'utf-8');

      const result = await loader.loadFromDirectory(skillDir);
      const skill = result._unsafeUnwrap();
      expect(skill.resolvedToolManifests).toHaveLength(1);
      expect(skill.resolvedToolManifests[0].name).toBe('search');
      expect(skill.resolvedToolManifests[0].executionLocation).toBe('host');
    });

    it('loads multiple tool manifests in alphabetical order', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);
      const toolsDir = join(skillDir, 'tools');
      await mkdir(toolsDir);
      await writeFile(join(toolsDir, 'b-tool.yaml'), toolManifestYaml('b-tool'), 'utf-8');
      await writeFile(join(toolsDir, 'a-tool.yaml'), toolManifestYaml('a-tool'), 'utf-8');

      const result = await loader.loadFromDirectory(skillDir);
      const skill = result._unsafeUnwrap();
      expect(skill.resolvedToolManifests).toHaveLength(2);
      expect(skill.resolvedToolManifests[0].name).toBe('a-tool');
      expect(skill.resolvedToolManifests[1].name).toBe('b-tool');
    });

    it('returns Err when a tool manifest file has invalid YAML structure', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);
      const toolsDir = join(skillDir, 'tools');
      await mkdir(toolsDir);
      // Missing required 'executionLocation' field.
      await writeFile(
        join(toolsDir, 'bad.yaml'),
        'name: bad-tool\ndescription: A tool',
        'utf-8',
      );

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SkillError);
      expect(result._unsafeUnwrapErr().message).toMatch(/tool manifest validation failed/i);
    });

    it('silently returns empty array when tools/ is absent', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().resolvedToolManifests).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // loadFromDirectory — MCP server definitions
  // -------------------------------------------------------------------------

  describe('loadFromDirectory — MCP server definitions', () => {
    it('loads valid MCP server definition JSON from mcp/', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);
      const mcpDir = join(skillDir, 'mcp');
      await mkdir(mcpDir);
      await writeFile(join(mcpDir, 'github.json'), mcpServerDefJson('github'), 'utf-8');

      const result = await loader.loadFromDirectory(skillDir);
      const skill = result._unsafeUnwrap();
      expect(skill.resolvedMcpServers).toHaveLength(1);
      expect(skill.resolvedMcpServers[0].name).toBe('github');
      expect(skill.resolvedMcpServers[0].config.transport).toBe('stdio');
    });

    it('backfills config.name from outer name when omitted', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);
      const mcpDir = join(skillDir, 'mcp');
      await mkdir(mcpDir);
      await writeFile(
        join(mcpDir, 'github.json'),
        JSON.stringify({
          name: 'github',
          config: {
            transport: 'http',
            url: 'https://api.githubcopilot.com/mcp',
          },
        }),
        'utf-8',
      );

      const result = await loader.loadFromDirectory(skillDir);
      const skill = result._unsafeUnwrap();
      expect(skill.resolvedMcpServers).toHaveLength(1);
      expect(skill.resolvedMcpServers[0].name).toBe('github');
      expect(skill.resolvedMcpServers[0].config.name).toBe('github');
    });

    it('loads multiple MCP server defs in alphabetical order', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);
      const mcpDir = join(skillDir, 'mcp');
      await mkdir(mcpDir);
      await writeFile(join(mcpDir, 'z-server.json'), mcpServerDefJson('z-server'), 'utf-8');
      await writeFile(join(mcpDir, 'a-server.json'), mcpServerDefJson('a-server'), 'utf-8');

      const result = await loader.loadFromDirectory(skillDir);
      const skill = result._unsafeUnwrap();
      expect(skill.resolvedMcpServers).toHaveLength(2);
      expect(skill.resolvedMcpServers[0].name).toBe('a-server');
      expect(skill.resolvedMcpServers[1].name).toBe('z-server');
    });

    it('loads MCP server definition with headers', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);
      const mcpDir = join(skillDir, 'mcp');
      await mkdir(mcpDir);
      await writeFile(
        join(mcpDir, 'github.json'),
        JSON.stringify({
          name: 'github',
          config: {
            name: 'github',
            transport: 'http',
            url: 'https://api.githubcopilot.com/mcp',
            headers: {
              Authorization: 'Bearer ${GITHUB_TOKEN}',
              'X-Custom': 'static-value',
            },
          },
        }),
        'utf-8',
      );

      const result = await loader.loadFromDirectory(skillDir);
      const skill = result._unsafeUnwrap();
      expect(skill.resolvedMcpServers).toHaveLength(1);
      expect(skill.resolvedMcpServers[0].config.headers).toEqual({
        Authorization: 'Bearer ${GITHUB_TOKEN}',
        'X-Custom': 'static-value',
      });
    });

    it('returns Err for invalid MCP definition JSON structure', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);
      const mcpDir = join(skillDir, 'mcp');
      await mkdir(mcpDir);
      // Missing required 'config' field.
      await writeFile(
        join(mcpDir, 'bad.json'),
        JSON.stringify({ name: 'bad-server' }),
        'utf-8',
      );

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SkillError);
      expect(result._unsafeUnwrapErr().message).toMatch(/mcp server definition validation failed/i);
    });

    it('returns Err for malformed JSON in mcp/', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);
      const mcpDir = join(skillDir, 'mcp');
      await mkdir(mcpDir);
      await writeFile(join(mcpDir, 'broken.json'), '{ not valid json', 'utf-8');

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SkillError);
    });

    it('silently returns empty array when mcp/ is absent', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().resolvedMcpServers).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // loadFromDirectory — migrations
  // -------------------------------------------------------------------------

  describe('loadFromDirectory — migrations', () => {
    it('collects .sql file paths from migrations/ in alphabetical order', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);
      const migrationsDir = join(skillDir, 'migrations');
      await mkdir(migrationsDir);
      await writeFile(join(migrationsDir, '002_add_index.sql'), '-- index', 'utf-8');
      await writeFile(join(migrationsDir, '001_init.sql'), '-- init', 'utf-8');

      const result = await loader.loadFromDirectory(skillDir);
      const skill = result._unsafeUnwrap();
      expect(skill.migrationPaths).toHaveLength(2);
      expect(skill.migrationPaths[0]).toMatch(/001_init\.sql$/);
      expect(skill.migrationPaths[1]).toMatch(/002_add_index\.sql$/);
    });

    it('returns absolute paths for migration files', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);
      const migrationsDir = join(skillDir, 'migrations');
      await mkdir(migrationsDir);
      await writeFile(join(migrationsDir, '001_init.sql'), '-- init', 'utf-8');

      const result = await loader.loadFromDirectory(skillDir);
      const skill = result._unsafeUnwrap();
      expect(skill.migrationPaths[0]).toMatch(/^\//);
    });

    it('ignores non-.sql files in migrations/', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);
      const migrationsDir = join(skillDir, 'migrations');
      await mkdir(migrationsDir);
      await writeFile(join(migrationsDir, '001_init.sql'), '-- init', 'utf-8');
      await writeFile(join(migrationsDir, 'readme.md'), '# Migrations', 'utf-8');

      const result = await loader.loadFromDirectory(skillDir);
      const skill = result._unsafeUnwrap();
      expect(skill.migrationPaths).toHaveLength(1);
    });

    it('silently returns empty array when migrations/ is absent', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir);

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().migrationPaths).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // loadFromDirectory — manifest validation failures
  // -------------------------------------------------------------------------

  describe('loadFromDirectory — manifest validation', () => {
    it('returns Err when skill.yaml does not exist', async () => {
      const skillDir = await makeTmpDir(cleanup);
      // No skill.yaml written.

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SkillError);
      expect(result._unsafeUnwrapErr().message).toMatch(/skill manifest/i);
    });

    it('returns Err when skill.yaml has invalid YAML syntax', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeFile(
        join(skillDir, 'skill.yaml'),
        'name: [unclosed bracket',
        'utf-8',
      );

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SkillError);
    });

    it('returns Err when skill.yaml is missing required "name" field', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeFile(
        join(skillDir, 'skill.yaml'),
        'version: "1.0.0"\ndescription: "No name"',
        'utf-8',
      );

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SkillError);
      expect(result._unsafeUnwrapErr().message).toMatch(/validation failed/i);
    });

    it('returns Err when skill.yaml is missing required "version" field', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeFile(
        join(skillDir, 'skill.yaml'),
        'name: "some-skill"\ndescription: "No version"',
        'utf-8',
      );

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SkillError);
    });

    it('returns Err when skill.yaml is missing required "description" field', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeFile(
        join(skillDir, 'skill.yaml'),
        'name: "some-skill"\nversion: "1.0.0"',
        'utf-8',
      );

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isErr()).toBe(true);
    });

    it('accepts an empty skill.yaml (all defaults applied, fails only required fields)', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeFile(join(skillDir, 'skill.yaml'), '', 'utf-8');

      const result = await loader.loadFromDirectory(skillDir);
      // Empty manifest fails because name/version/description are required.
      expect(result.isErr()).toBe(true);
    });

    it('loads manifest with explicit empty lists for all optional fields', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeFile(
        join(skillDir, 'skill.yaml'),
        [
          'name: full-skill',
          'version: 2.0.0',
          'description: "Full manifest"',
          'requiredCapabilities: []',
          'promptFragments: []',
          'toolManifests: []',
          'mcpServers: []',
          'migrations: []',
        ].join('\n'),
        'utf-8',
      );

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isOk()).toBe(true);
      const skill = result._unsafeUnwrap();
      expect(skill.manifest.requiredCapabilities).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // loadFromDirectory — capability label validation
  // -------------------------------------------------------------------------

  describe('loadFromDirectory — capability label validation', () => {
    it('accepts fully-qualified labels (domain.action:scope)', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeFile(
        join(skillDir, 'skill.yaml'),
        [
          'name: cap-skill',
          'version: 1.0.0',
          'description: Capabilities test',
          'requiredCapabilities:',
          '  - fs.read:workspace',
          '  - net.http:egress',
        ].join('\n'),
        'utf-8',
      );

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isOk()).toBe(true);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('accepts scope-less labels but emits a warning', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeFile(
        join(skillDir, 'skill.yaml'),
        [
          'name: cap-skill',
          'version: 1.0.0',
          'description: Capabilities test',
          'requiredCapabilities:',
          '  - fs.read',
        ].join('\n'),
        'utf-8',
      );

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isOk()).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ skill: 'cap-skill', label: 'fs.read' }),
        expect.any(String),
      );
    });

    it('returns Err for completely malformed capability labels', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeFile(
        join(skillDir, 'skill.yaml'),
        [
          'name: bad-caps',
          'version: 1.0.0',
          'description: Bad capabilities',
          'requiredCapabilities:',
          '  - "not-a-valid-label"',
        ].join('\n'),
        'utf-8',
      );

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SkillError);
      expect(result._unsafeUnwrapErr().message).toMatch(/malformed/i);
    });
  });

  // -------------------------------------------------------------------------
  // loadFromDirectory — full skill with all content
  // -------------------------------------------------------------------------

  describe('loadFromDirectory — full skill', () => {
    it('loads a skill with all content types correctly', async () => {
      const skillDir = await makeTmpDir(cleanup);
      await writeMinimalManifest(skillDir, {
        name: 'web-search',
        requiredCapabilities: ['net.http:egress'],
      });

      // Prompt fragments
      const promptsDir = join(skillDir, 'prompts');
      await mkdir(promptsDir);
      await writeFile(join(promptsDir, 'context.md'), 'Search context.', 'utf-8');

      // Tool manifests
      const toolsDir = join(skillDir, 'tools');
      await mkdir(toolsDir);
      await writeFile(
        join(toolsDir, 'search.yaml'),
        [
          'name: web.search',
          'description: Perform a web search',
          'capabilities:',
          '  - net.http:egress',
          'executionLocation: host',
        ].join('\n'),
        'utf-8',
      );

      // MCP defs
      const mcpDir = join(skillDir, 'mcp');
      await mkdir(mcpDir);
      await writeFile(join(mcpDir, 'brave.json'), mcpServerDefJson('brave'), 'utf-8');

      // Migrations
      const migrationsDir = join(skillDir, 'migrations');
      await mkdir(migrationsDir);
      await writeFile(join(migrationsDir, '001_search_index.sql'), 'CREATE TABLE search_cache (id INTEGER);', 'utf-8');

      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isOk()).toBe(true);

      const skill = result._unsafeUnwrap();
      expect(skill.manifest.name).toBe('web-search');
      expect(skill.manifest.requiredCapabilities).toContain('net.http:egress');
      expect(skill.promptContents).toHaveLength(1);
      expect(skill.promptContents[0]).toBe('Search context.');
      expect(skill.resolvedToolManifests).toHaveLength(1);
      expect(skill.resolvedToolManifests[0].name).toBe('web.search');
      expect(skill.resolvedMcpServers).toHaveLength(1);
      expect(skill.resolvedMcpServers[0].name).toBe('brave');
      expect(skill.migrationPaths).toHaveLength(1);
      expect(skill.migrationPaths[0]).toMatch(/001_search_index\.sql$/);
    });
  });

  // -------------------------------------------------------------------------
  // loadMultiple
  // -------------------------------------------------------------------------

  describe('loadMultiple', () => {
    it('returns Ok([]) for an empty array', async () => {
      const result = await loader.loadMultiple([]);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toHaveLength(0);
    });

    it('loads all skills when all are valid', async () => {
      const dir1 = await makeTmpDir(cleanup);
      await writeMinimalManifest(dir1, { name: 'skill-alpha' });

      const dir2 = await makeTmpDir(cleanup);
      await writeMinimalManifest(dir2, { name: 'skill-beta' });

      const result = await loader.loadMultiple([dir1, dir2]);
      expect(result.isOk()).toBe(true);
      const skills = result._unsafeUnwrap();
      expect(skills).toHaveLength(2);
      expect(skills.map((s) => s.manifest.name)).toContain('skill-alpha');
      expect(skills.map((s) => s.manifest.name)).toContain('skill-beta');
    });

    it('fails immediately on the first invalid skill', async () => {
      const dir1 = await makeTmpDir(cleanup);
      await writeMinimalManifest(dir1, { name: 'skill-good' });

      const dir2 = await makeTmpDir(cleanup);
      // No skill.yaml — will fail.

      const dir3 = await makeTmpDir(cleanup);
      await writeMinimalManifest(dir3, { name: 'skill-also-good' });

      const result = await loader.loadMultiple([dir1, dir2, dir3]);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SkillError);
    });

    it('returns Err wrapping the specific failure from loadFromDirectory', async () => {
      const dir = await makeTmpDir(cleanup);
      // Write invalid manifest.
      await writeFile(
        join(dir, 'skill.yaml'),
        'version: 1.0.0\ndescription: "Missing name"',
        'utf-8',
      );

      const result = await loader.loadMultiple([dir]);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toMatch(/validation failed/i);
    });
  });
});
