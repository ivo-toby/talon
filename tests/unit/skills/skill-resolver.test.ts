/**
 * Unit tests for SkillResolver.
 *
 * The resolver is pure (no I/O), so tests construct LoadedSkill fixtures
 * directly and exercise the matching / merging logic.
 *
 * Coverage areas:
 *   - resolveForPersona: all capabilities met → usable
 *   - resolveForPersona: some capabilities missing → skipped with details
 *   - resolveForPersona: no capabilities required → always usable
 *   - resolveForPersona: unknown skill name → captured in unknown list
 *   - resolveForPersona: mixed usable + skipped + unknown
 *   - resolveForPersona: empty skill names list
 *   - resolveForPersona: capabilities from both allow and requireApproval
 *   - resolveForPersona: duplicate skill names resolved correctly
 *   - mergePromptFragments: single skill, multiple skills, empty
 *   - collectToolManifests: single skill, multiple skills, empty
 *   - collectMcpServers: single skill, multiple skills, empty
 */

import { describe, it, expect, vi } from 'vitest';
import { SkillResolver } from '../../../src/skills/skill-resolver.js';
import type { LoadedSkill, McpServerDef } from '../../../src/skills/skill-types.js';
import type { ToolManifest } from '../../../src/tools/tool-types.js';

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
// Fixtures
// ---------------------------------------------------------------------------

function makeToolManifest(name: string): ToolManifest {
  return {
    name,
    description: `Tool ${name}`,
    capabilities: [],
    executionLocation: 'host',
  };
}

function makeMcpServerDef(name: string): McpServerDef {
  return {
    name,
    config: {
      name,
      transport: 'stdio',
      command: 'npx',
    },
  };
}

function makeLoadedSkill(
  name: string,
  requiredCapabilities: string[] = [],
  overrides: Partial<LoadedSkill> = {},
): LoadedSkill {
  return {
    manifest: {
      name,
      version: '1.0.0',
      description: `Skill ${name}`,
      requiredCapabilities,
      promptFragments: [],
      toolManifests: [],
      mcpServers: [],
      migrations: [],
    },
    skillDir: `/fake/skills/${name}`,
    format: 'yaml',
    promptContents: [],
    resolvedToolManifests: [],
    resolvedMcpServers: [],
    migrationPaths: [],
    stagedSandbox: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillResolver', () => {
  // -------------------------------------------------------------------------
  // resolveForPersona — capability matching
  // -------------------------------------------------------------------------

  describe('resolveForPersona — capability matching', () => {
    it('marks a skill as usable when all required capabilities are present', () => {
      const resolver = new SkillResolver(makeLogger());
      const skill = makeLoadedSkill('search', ['net.http:egress']);
      const personaCaps = ['net.http:egress', 'fs.read:workspace'];

      const result = resolver.resolveForPersona(['search'], [skill], personaCaps);
      expect(result.isOk()).toBe(true);
      const set = result._unsafeUnwrap();
      expect(set.usable).toHaveLength(1);
      expect(set.usable[0].manifest.name).toBe('search');
      expect(set.skipped).toHaveLength(0);
      expect(set.unknown).toHaveLength(0);
    });

    it('marks a skill as skipped when any required capability is missing', () => {
      const resolver = new SkillResolver(makeLogger());
      const skill = makeLoadedSkill('search', ['net.http:egress', 'mem.write:global']);
      const personaCaps = ['net.http:egress']; // missing mem.write:global

      const result = resolver.resolveForPersona(['search'], [skill], personaCaps);
      const set = result._unsafeUnwrap();
      expect(set.usable).toHaveLength(0);
      expect(set.skipped).toHaveLength(1);
      expect(set.skipped[0].skillName).toBe('search');
      expect(set.skipped[0].missingCapabilities).toContain('mem.write:global');
    });

    it('includes all missing capabilities in the skipped entry', () => {
      const resolver = new SkillResolver(makeLogger());
      const skill = makeLoadedSkill('full', ['net.http:egress', 'fs.write:workspace', 'mem.write:global']);
      const personaCaps: string[] = [];

      const result = resolver.resolveForPersona(['full'], [skill], personaCaps);
      const set = result._unsafeUnwrap();
      expect(set.skipped[0].missingCapabilities).toHaveLength(3);
      expect(set.skipped[0].missingCapabilities).toContain('net.http:egress');
      expect(set.skipped[0].missingCapabilities).toContain('fs.write:workspace');
      expect(set.skipped[0].missingCapabilities).toContain('mem.write:global');
    });

    it('marks a skill with no required capabilities as always usable', () => {
      const resolver = new SkillResolver(makeLogger());
      const skill = makeLoadedSkill('free-skill', []); // no requirements
      const personaCaps: string[] = [];

      const result = resolver.resolveForPersona(['free-skill'], [skill], personaCaps);
      const set = result._unsafeUnwrap();
      expect(set.usable).toHaveLength(1);
      expect(set.skipped).toHaveLength(0);
    });

    it('tracks unknown skill names in the unknown list', () => {
      const resolver = new SkillResolver(makeLogger());
      const skill = makeLoadedSkill('known-skill');

      const result = resolver.resolveForPersona(
        ['known-skill', 'ghost-skill', 'phantom-skill'],
        [skill],
        [],
      );
      const set = result._unsafeUnwrap();
      expect(set.usable).toHaveLength(1);
      expect(set.unknown).toHaveLength(2);
      expect(set.unknown).toContain('ghost-skill');
      expect(set.unknown).toContain('phantom-skill');
    });

    it('logs a warning for each unknown skill name', () => {
      const logger = makeLogger();
      const resolver = new SkillResolver(logger);
      const skill = makeLoadedSkill('real-skill');

      resolver.resolveForPersona(['real-skill', 'missing-skill'], [skill], []);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ skillName: 'missing-skill' }),
        expect.any(String),
      );
    });

    it('handles an empty personaSkillNames list', () => {
      const resolver = new SkillResolver(makeLogger());
      const skill = makeLoadedSkill('unused-skill', ['net.http:egress']);

      const result = resolver.resolveForPersona([], [skill], ['net.http:egress']);
      const set = result._unsafeUnwrap();
      expect(set.usable).toHaveLength(0);
      expect(set.skipped).toHaveLength(0);
      expect(set.unknown).toHaveLength(0);
    });

    it('handles an empty allSkills list', () => {
      const resolver = new SkillResolver(makeLogger());

      const result = resolver.resolveForPersona(['some-skill'], [], []);
      const set = result._unsafeUnwrap();
      expect(set.usable).toHaveLength(0);
      expect(set.unknown).toContain('some-skill');
    });

    it('resolves skills from both allow and requireApproval capability sets', () => {
      const resolver = new SkillResolver(makeLogger());
      // Skill requires cap that is in requireApproval (not allow).
      const skill = makeLoadedSkill('approval-skill', ['net.http:egress']);
      // persona has it only in requireApproval.
      const personaCaps = ['net.http:egress']; // combined list

      const result = resolver.resolveForPersona(['approval-skill'], [skill], personaCaps);
      const set = result._unsafeUnwrap();
      expect(set.usable).toHaveLength(1);
    });

    it('handles mixed usable, skipped, and unknown in one call', () => {
      const resolver = new SkillResolver(makeLogger());
      const skillA = makeLoadedSkill('skill-a', ['fs.read:workspace']);
      const skillB = makeLoadedSkill('skill-b', ['mem.write:global']); // missing
      const personaCaps = ['fs.read:workspace'];

      const result = resolver.resolveForPersona(
        ['skill-a', 'skill-b', 'skill-ghost'],
        [skillA, skillB],
        personaCaps,
      );
      const set = result._unsafeUnwrap();
      expect(set.usable).toHaveLength(1);
      expect(set.usable[0].manifest.name).toBe('skill-a');
      expect(set.skipped).toHaveLength(1);
      expect(set.skipped[0].skillName).toBe('skill-b');
      expect(set.unknown).toHaveLength(1);
      expect(set.unknown[0]).toBe('skill-ghost');
    });

    it('uses the first occurrence when duplicate skill names are in personaSkillNames', () => {
      const resolver = new SkillResolver(makeLogger());
      const skill = makeLoadedSkill('repeated', ['fs.read:workspace']);
      const personaCaps = ['fs.read:workspace'];

      const result = resolver.resolveForPersona(
        ['repeated', 'repeated'],
        [skill],
        personaCaps,
      );
      const set = result._unsafeUnwrap();
      // Both references resolve to usable (the skill appears twice).
      expect(set.usable).toHaveLength(2);
    });

    it('returns Ok even when no skills are usable', () => {
      const resolver = new SkillResolver(makeLogger());
      const skill = makeLoadedSkill('blocked', ['super.power:level-9000']);
      const personaCaps: string[] = [];

      const result = resolver.resolveForPersona(['blocked'], [skill], personaCaps);
      expect(result.isOk()).toBe(true);
      const set = result._unsafeUnwrap();
      expect(set.usable).toHaveLength(0);
      expect(set.skipped).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // mergePromptFragments
  // -------------------------------------------------------------------------

  describe('mergePromptFragments', () => {
    it('returns empty string when no skills are provided', () => {
      const resolver = new SkillResolver(makeLogger());
      expect(resolver.mergePromptFragments([])).toBe('');
    });

    it('returns empty string when all skills have no prompt contents', () => {
      const resolver = new SkillResolver(makeLogger());
      const skill = makeLoadedSkill('empty', [], { promptContents: [] });
      expect(resolver.mergePromptFragments([skill])).toBe('');
    });

    it('returns the single fragment when one skill has one fragment', () => {
      const resolver = new SkillResolver(makeLogger());
      const skill = makeLoadedSkill('s', [], { promptContents: ['Hello world'] });
      expect(resolver.mergePromptFragments([skill])).toBe('Hello world');
    });

    it('joins multiple fragments from one skill with newlines', () => {
      const resolver = new SkillResolver(makeLogger());
      const skill = makeLoadedSkill('s', [], { promptContents: ['First', 'Second', 'Third'] });
      const merged = resolver.mergePromptFragments([skill]);
      expect(merged).toBe('First\nSecond\nThird');
    });

    it('merges fragments from multiple skills in skill order', () => {
      const resolver = new SkillResolver(makeLogger());
      const skill1 = makeLoadedSkill('s1', [], { promptContents: ['Skill1-FragA', 'Skill1-FragB'] });
      const skill2 = makeLoadedSkill('s2', [], { promptContents: ['Skill2-FragA'] });

      const merged = resolver.mergePromptFragments([skill1, skill2]);
      expect(merged).toBe('Skill1-FragA\nSkill1-FragB\nSkill2-FragA');
    });

    it('skips skills that have no fragments without introducing extra newlines', () => {
      const resolver = new SkillResolver(makeLogger());
      const skill1 = makeLoadedSkill('s1', [], { promptContents: ['Content1'] });
      const skill2 = makeLoadedSkill('s2', [], { promptContents: [] }); // empty
      const skill3 = makeLoadedSkill('s3', [], { promptContents: ['Content3'] });

      const merged = resolver.mergePromptFragments([skill1, skill2, skill3]);
      expect(merged).toBe('Content1\nContent3');
    });
  });

  // -------------------------------------------------------------------------
  // collectToolManifests
  // -------------------------------------------------------------------------

  describe('collectToolManifests', () => {
    it('returns empty array when no skills are provided', () => {
      const resolver = new SkillResolver(makeLogger());
      expect(resolver.collectToolManifests([])).toHaveLength(0);
    });

    it('returns empty array when all skills have no tool manifests', () => {
      const resolver = new SkillResolver(makeLogger());
      const skill = makeLoadedSkill('no-tools', [], { resolvedToolManifests: [] });
      expect(resolver.collectToolManifests([skill])).toHaveLength(0);
    });

    it('returns all tool manifests from a single skill', () => {
      const resolver = new SkillResolver(makeLogger());
      const tools = [makeToolManifest('tool-a'), makeToolManifest('tool-b')];
      const skill = makeLoadedSkill('s', [], { resolvedToolManifests: tools });

      const collected = resolver.collectToolManifests([skill]);
      expect(collected).toHaveLength(2);
      expect(collected.map((t) => t.name)).toContain('tool-a');
      expect(collected.map((t) => t.name)).toContain('tool-b');
    });

    it('concatenates tool manifests from multiple skills', () => {
      const resolver = new SkillResolver(makeLogger());
      const skill1 = makeLoadedSkill('s1', [], {
        resolvedToolManifests: [makeToolManifest('tool-from-s1')],
      });
      const skill2 = makeLoadedSkill('s2', [], {
        resolvedToolManifests: [makeToolManifest('tool-from-s2')],
      });

      const collected = resolver.collectToolManifests([skill1, skill2]);
      expect(collected).toHaveLength(2);
      expect(collected[0].name).toBe('tool-from-s1');
      expect(collected[1].name).toBe('tool-from-s2');
    });

    it('preserves skill order in the collected result', () => {
      const resolver = new SkillResolver(makeLogger());
      const skillA = makeLoadedSkill('alpha', [], {
        resolvedToolManifests: [makeToolManifest('alpha-tool')],
      });
      const skillB = makeLoadedSkill('beta', [], {
        resolvedToolManifests: [makeToolManifest('beta-tool')],
      });

      const collected = resolver.collectToolManifests([skillA, skillB]);
      expect(collected[0].name).toBe('alpha-tool');
      expect(collected[1].name).toBe('beta-tool');
    });
  });

  // -------------------------------------------------------------------------
  // collectMcpServers
  // -------------------------------------------------------------------------

  describe('collectMcpServers', () => {
    it('returns empty array when no skills are provided', () => {
      const resolver = new SkillResolver(makeLogger());
      expect(resolver.collectMcpServers([])).toHaveLength(0);
    });

    it('returns empty array when all skills have no MCP server defs', () => {
      const resolver = new SkillResolver(makeLogger());
      const skill = makeLoadedSkill('no-mcp', [], { resolvedMcpServers: [] });
      expect(resolver.collectMcpServers([skill])).toHaveLength(0);
    });

    it('returns all MCP server defs from a single skill', () => {
      const resolver = new SkillResolver(makeLogger());
      const servers = [makeMcpServerDef('github'), makeMcpServerDef('filesystem')];
      const skill = makeLoadedSkill('s', [], { resolvedMcpServers: servers });

      const collected = resolver.collectMcpServers([skill]);
      expect(collected).toHaveLength(2);
      expect(collected.map((s) => s.name)).toContain('github');
      expect(collected.map((s) => s.name)).toContain('filesystem');
    });

    it('concatenates MCP server defs from multiple skills', () => {
      const resolver = new SkillResolver(makeLogger());
      const skill1 = makeLoadedSkill('s1', [], {
        resolvedMcpServers: [makeMcpServerDef('server-from-s1')],
      });
      const skill2 = makeLoadedSkill('s2', [], {
        resolvedMcpServers: [makeMcpServerDef('server-from-s2')],
      });

      const collected = resolver.collectMcpServers([skill1, skill2]);
      expect(collected).toHaveLength(2);
      expect(collected[0].name).toBe('server-from-s1');
      expect(collected[1].name).toBe('server-from-s2');
    });

    it('preserves MCP server config fidelity', () => {
      const resolver = new SkillResolver(makeLogger());
      const def: McpServerDef = {
        name: 'custom-server',
        config: {
          name: 'custom-server',
          transport: 'http',
          url: 'https://example.com/mcp',
          allowedTools: ['read_file'],
          rateLimit: { callsPerMinute: 30 },
        },
      };
      const skill = makeLoadedSkill('s', [], { resolvedMcpServers: [def] });

      const collected = resolver.collectMcpServers([skill]);
      expect(collected[0].config.transport).toBe('http');
      expect(collected[0].config.url).toBe('https://example.com/mcp');
      expect(collected[0].config.allowedTools).toContain('read_file');
      expect(collected[0].config.rateLimit?.callsPerMinute).toBe(30);
    });
  });

  // -------------------------------------------------------------------------
  // Integration: resolveForPersona + merge/collect helpers
  // -------------------------------------------------------------------------

  describe('integration: resolve then merge/collect', () => {
    it('merges only fragments from usable skills', () => {
      const resolver = new SkillResolver(makeLogger());
      const usableSkill = makeLoadedSkill('usable', [], { promptContents: ['Usable content'] });
      const skippedSkill = makeLoadedSkill('skipped', ['missing.cap:scope'], {
        promptContents: ['Skipped content'],
      });

      const resolveResult = resolver.resolveForPersona(
        ['usable', 'skipped'],
        [usableSkill, skippedSkill],
        [], // no capabilities — skippedSkill is blocked
      );

      const { usable } = resolveResult._unsafeUnwrap();
      const merged = resolver.mergePromptFragments(usable);
      expect(merged).toBe('Usable content');
      expect(merged).not.toContain('Skipped content');
    });

    it('collects tools only from usable skills', () => {
      const resolver = new SkillResolver(makeLogger());
      const usableSkill = makeLoadedSkill('usable', [], {
        resolvedToolManifests: [makeToolManifest('good-tool')],
      });
      const skippedSkill = makeLoadedSkill('skipped', ['blocked.cap:scope'], {
        resolvedToolManifests: [makeToolManifest('blocked-tool')],
      });

      const { usable } = resolver
        .resolveForPersona(['usable', 'skipped'], [usableSkill, skippedSkill], [])
        ._unsafeUnwrap();

      const tools = resolver.collectToolManifests(usable);
      expect(tools.map((t) => t.name)).toContain('good-tool');
      expect(tools.map((t) => t.name)).not.toContain('blocked-tool');
    });
  });
});
