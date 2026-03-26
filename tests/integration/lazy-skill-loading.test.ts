/**
 * Integration tests for lazy skill loading.
 *
 * Exercises the full skill loading pipeline: disk loading → skill resolution →
 * persona runtime context → agent runner wiring. Uses real temp directories
 * for skills, real SkillLoader/SkillResolver, and real persona runtime context.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';

import { SkillLoader } from '../../src/skills/skill-loader.js';
import { SkillResolver } from '../../src/skills/skill-resolver.js';
import {
  buildPersonaRuntimeContext,
  buildSkillIndex,
} from '../../src/personas/persona-runtime-context.js';
import type { LoadedPersona } from '../../src/personas/persona-types.js';
import type { LoadedSkill } from '../../src/skills/skill-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

const cleanupFns: Array<() => Promise<void>> = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lazy-skill-integ-'));
  cleanupFns.push(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeMinimalPersona(overrides?: Partial<LoadedPersona>): LoadedPersona {
  return {
    config: {
      name: 'test-persona',
      model: 'claude-3-5-sonnet-20241022',
      skills: [],
      ...overrides?.config,
    },
    systemPromptContent: 'You are a helpful assistant.',
    personalityContent: 'Be concise.',
    resolvedCapabilities: { allow: [], requireApproval: [] },
    ...overrides,
  } as LoadedPersona;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

afterEach(async () => {
  for (const fn of cleanupFns) {
    await fn();
  }
  cleanupFns.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Lazy skill loading integration', () => {
  describe('SKILL.md format end-to-end', () => {
    it('loads SKILL.md, resolves for persona, and builds lazy metadata index', async () => {
      const dir = await makeTmpDir();
      const skillDir = join(dir, 'web-research');
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: web-research',
          'description: "Search the web and fetch pages for research tasks"',
          'requiredCapabilities:',
          '  - net.http:external',
          '---',
          '',
          '# Web Research',
          '',
          'When the user asks you to research something, use the search tool.',
          'Always cite your sources.',
        ].join('\n'),
      );

      const loader = new SkillLoader(createLogger());
      const loadResult = await loader.loadFromDirectory(skillDir);
      expect(loadResult.isOk()).toBe(true);

      const skill = loadResult._unsafeUnwrap();
      expect(skill.format).toBe('skillmd');
      expect(skill.manifest.name).toBe('web-research');
      expect(skill.manifest.description).toBe('Search the web and fetch pages for research tasks');
      expect(skill.manifest.version).toBe('0.1.0');
      expect(skill.promptContents).toHaveLength(1);
      expect(skill.promptContents[0]).toContain('Always cite your sources.');

      // Resolve for persona with matching capabilities
      const resolver = new SkillResolver(createLogger());
      const resolved = resolver.resolveForPersona(
        ['web-research'],
        [skill],
        ['net.http:external'],
      );
      expect(resolved.isOk()).toBe(true);
      expect(resolved._unsafeUnwrap().usable).toHaveLength(1);

      // Build lazy metadata index (default mode)
      const context = buildPersonaRuntimeContext({
        loadedPersona: makeMinimalPersona({
          config: { name: 'test', model: 'claude', skills: ['web-research'] },
        } as Partial<LoadedPersona>),
        resolvedSkills: [skill],
        skillResolver: resolver,
      });

      // Metadata index present
      expect(context.personaPrompt).toContain('## Available Skills');
      expect(context.personaPrompt).toContain('**web-research**: Search the web');
      expect(context.personaPrompt).toContain('skill_load');

      // Full prompt content NOT present
      expect(context.personaPrompt).not.toContain('Always cite your sources.');
    });

    it('loads SKILL.md with MCP server and includes it in runtime context', async () => {
      const dir = await makeTmpDir();
      const skillDir = join(dir, 'with-mcp');
      await mkdir(join(skillDir, 'mcp'), { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        '---\nname: with-mcp\ndescription: "Skill with MCP server"\n---\n\nInstructions here.',
      );

      await writeFile(
        join(skillDir, 'mcp', 'test-server.json'),
        JSON.stringify({
          name: 'test-server',
          config: {
            transport: 'stdio',
            command: 'echo',
            args: ['hello'],
            name: 'test-server',
          },
        }),
      );

      const loader = new SkillLoader(createLogger());
      const loadResult = await loader.loadFromDirectory(skillDir);
      expect(loadResult.isOk()).toBe(true);

      const skill = loadResult._unsafeUnwrap();
      expect(skill.resolvedMcpServers).toHaveLength(1);
      expect(skill.resolvedMcpServers[0].name).toBe('test-server');

      // MCP servers should be in runtime context even with lazy loading
      const resolver = new SkillResolver(createLogger());
      const context = buildPersonaRuntimeContext({
        loadedPersona: makeMinimalPersona({
          config: { name: 'test', model: 'claude', skills: ['with-mcp'] },
        } as Partial<LoadedPersona>),
        resolvedSkills: [skill],
        skillResolver: resolver,
      });

      expect(context.mcpServers['test-server']).toBeDefined();
      expect(context.mcpServers['test-server'].transport).toBe('stdio');
    });
  });

  describe('skill.yaml format backwards compatibility', () => {
    it('loads skill.yaml and builds lazy metadata index identically', async () => {
      const dir = await makeTmpDir();
      const skillDir = join(dir, 'codex');
      await mkdir(join(skillDir, 'prompts'), { recursive: true });

      await writeFile(
        join(skillDir, 'skill.yaml'),
        'name: codex\nversion: "1.0.0"\ndescription: "Run Codex CLI for code analysis"\n',
      );

      await writeFile(
        join(skillDir, 'prompts', 'main.md'),
        '# Codex\n\nUse the Codex CLI to analyze and refactor code.\n',
      );

      const loader = new SkillLoader(createLogger());
      const loadResult = await loader.loadFromDirectory(skillDir);
      expect(loadResult.isOk()).toBe(true);

      const skill = loadResult._unsafeUnwrap();
      expect(skill.format).toBe('yaml');
      expect(skill.manifest.name).toBe('codex');

      // Lazy index works the same
      const index = buildSkillIndex([skill]);
      expect(index).toContain('**codex**: Run Codex CLI for code analysis');
      expect(index).not.toContain('Use the Codex CLI to analyze');
    });
  });

  describe('mixed format loading', () => {
    it('loads multiple skills in different formats and builds combined index', async () => {
      const dir = await makeTmpDir();

      // SKILL.md format
      const skillMdDir = join(dir, 'research');
      await mkdir(skillMdDir, { recursive: true });
      await writeFile(
        join(skillMdDir, 'SKILL.md'),
        '---\nname: research\ndescription: "Web research"\n---\n\nResearch instructions.',
      );

      // skill.yaml format
      const yamlDir = join(dir, 'codex');
      await mkdir(join(yamlDir, 'prompts'), { recursive: true });
      await writeFile(
        join(yamlDir, 'skill.yaml'),
        'name: codex\nversion: "1.0.0"\ndescription: "Code analysis"\n',
      );
      await writeFile(join(yamlDir, 'prompts', 'main.md'), 'Codex instructions.');

      const loader = new SkillLoader(createLogger());
      const skills: LoadedSkill[] = [];

      for (const name of ['research', 'codex']) {
        const result = await loader.loadFromDirectory(join(dir, name));
        expect(result.isOk()).toBe(true);
        skills.push(result._unsafeUnwrap());
      }

      expect(skills[0].format).toBe('skillmd');
      expect(skills[1].format).toBe('yaml');

      const index = buildSkillIndex(skills);
      expect(index).toContain('**research**: Web research');
      expect(index).toContain('**codex**: Code analysis');
      expect(index).not.toContain('Research instructions.');
      expect(index).not.toContain('Codex instructions.');
    });

    it('errors when skill directory has both formats', async () => {
      const dir = await makeTmpDir();
      const skillDir = join(dir, 'ambiguous');
      await mkdir(join(skillDir, 'prompts'), { recursive: true });

      await writeFile(
        join(skillDir, 'skill.yaml'),
        'name: ambiguous\nversion: "1.0.0"\ndescription: "test"\n',
      );
      await writeFile(
        join(skillDir, 'SKILL.md'),
        '---\nname: ambiguous\ndescription: "test"\n---\nBody',
      );

      const loader = new SkillLoader(createLogger());
      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('ambiguous');
    });
  });

  describe('eager vs lazy loading mode', () => {
    let skills: LoadedSkill[];
    let resolver: SkillResolver;

    beforeEach(async () => {
      const dir = await makeTmpDir();

      // Create two skills with substantial prompt content
      const skill1Dir = join(dir, 'skill-a');
      await mkdir(skill1Dir, { recursive: true });
      await writeFile(
        join(skill1Dir, 'SKILL.md'),
        '---\nname: skill-a\ndescription: "Skill A"\n---\n\n' +
        'These are the detailed instructions for skill A.\n'.repeat(50),
      );

      const skill2Dir = join(dir, 'skill-b');
      await mkdir(skill2Dir, { recursive: true });
      await writeFile(
        join(skill2Dir, 'SKILL.md'),
        '---\nname: skill-b\ndescription: "Skill B"\n---\n\n' +
        'These are the detailed instructions for skill B.\n'.repeat(50),
      );

      const loader = new SkillLoader(createLogger());
      skills = [];
      for (const name of ['skill-a', 'skill-b']) {
        const result = await loader.loadFromDirectory(join(dir, name));
        skills.push(result._unsafeUnwrap());
      }

      resolver = new SkillResolver(createLogger());
    });

    it('lazy mode produces significantly smaller system prompt', () => {
      const persona = makeMinimalPersona({
        config: { name: 'test', model: 'claude', skills: ['skill-a', 'skill-b'] },
      } as Partial<LoadedPersona>);

      const lazyContext = buildPersonaRuntimeContext({
        loadedPersona: persona,
        resolvedSkills: skills,
        skillResolver: resolver,
        skillLoadingMode: 'lazy',
      });

      const eagerContext = buildPersonaRuntimeContext({
        loadedPersona: persona,
        resolvedSkills: skills,
        skillResolver: resolver,
        skillLoadingMode: 'eager',
      });

      // Lazy should be much smaller
      expect(lazyContext.personaPrompt.length).toBeLessThan(eagerContext.personaPrompt.length / 2);

      // Lazy has metadata, eager has full content
      expect(lazyContext.personaPrompt).toContain('## Available Skills');
      expect(lazyContext.personaPrompt).not.toContain('detailed instructions for skill A');

      expect(eagerContext.personaPrompt).toContain('detailed instructions for skill A');
      expect(eagerContext.personaPrompt).toContain('detailed instructions for skill B');
      expect(eagerContext.personaPrompt).not.toContain('## Available Skills');
    });

    it('default mode is lazy', () => {
      const context = buildPersonaRuntimeContext({
        loadedPersona: makeMinimalPersona({
          config: { name: 'test', model: 'claude', skills: ['skill-a'] },
        } as Partial<LoadedPersona>),
        resolvedSkills: skills,
        skillResolver: resolver,
      });

      expect(context.personaPrompt).toContain('## Available Skills');
      expect(context.personaPrompt).not.toContain('detailed instructions');
    });
  });

  describe('__talond_ prefix validation', () => {
    it('rejects skills with MCP servers using reserved prefix', async () => {
      const dir = await makeTmpDir();
      const skillDir = join(dir, 'evil-skill');
      await mkdir(join(skillDir, 'mcp'), { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        '---\nname: evil-skill\ndescription: "Evil"\n---\nBody',
      );
      await writeFile(
        join(skillDir, 'mcp', 'server.json'),
        JSON.stringify({
          name: '__talond_hijack',
          config: { transport: 'stdio', command: 'evil', name: '__talond_hijack' },
        }),
      );

      const loader = new SkillLoader(createLogger());
      const loadResult = await loader.loadFromDirectory(skillDir);
      expect(loadResult.isOk()).toBe(true);

      const skill = loadResult._unsafeUnwrap();
      const resolver = new SkillResolver(createLogger());

      expect(() =>
        buildPersonaRuntimeContext({
          loadedPersona: makeMinimalPersona({
            config: { name: 'test', model: 'claude', skills: ['evil-skill'] },
          } as Partial<LoadedPersona>),
          resolvedSkills: [skill],
          skillResolver: resolver,
        }),
      ).toThrow('__talond_');
    });
  });

  describe('empty skill content', () => {
    it('skill with no prompt content is included in index and returns empty on load', async () => {
      const dir = await makeTmpDir();
      const skillDir = join(dir, 'mcp-only');
      await mkdir(skillDir, { recursive: true });

      // SKILL.md with frontmatter only, no body
      await writeFile(
        join(skillDir, 'SKILL.md'),
        '---\nname: mcp-only\ndescription: "MCP server only, no instructions"\n---\n',
      );

      const loader = new SkillLoader(createLogger());
      const result = await loader.loadFromDirectory(skillDir);
      expect(result.isOk()).toBe(true);

      const skill = result._unsafeUnwrap();
      expect(skill.promptContents).toHaveLength(0);

      // Still appears in metadata index
      const index = buildSkillIndex([skill]);
      expect(index).toContain('**mcp-only**: MCP server only');
    });
  });
});
