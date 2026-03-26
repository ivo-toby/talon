import { describe, expect, it, vi } from 'vitest';
import {
  buildPersonaRuntimeContext,
  buildSkillIndex,
} from '../../../src/personas/persona-runtime-context.js';
import type { LoadedPersona } from '../../../src/personas/persona-types.js';
import type { LoadedSkill, McpServerDef } from '../../../src/skills/skill-types.js';

function makeLoadedSkill(name: string, servers: McpServerDef[]): LoadedSkill {
  return {
    manifest: {
      name,
      version: '1.0.0',
      description: `${name} description`,
      requiredCapabilities: [],
      promptFragments: [],
      toolManifests: [],
      mcpServers: [],
      migrations: [],
    },
    format: 'yaml',
    promptContents: [`prompt:${name}`],
    resolvedToolManifests: [],
    resolvedMcpServers: servers,
    migrationPaths: [],
  };
}

describe('buildPersonaRuntimeContext', () => {
  const loadedPersona: LoadedPersona = {
    config: {
      name: 'assistant',
      model: 'claude-sonnet-4-6',
      skills: ['search', 'browser'],
      subagents: [],
      capabilities: { allow: [], requireApproval: [] },
      mounts: [],
    },
    systemPromptContent: 'You are helpful.',
    personalityContent: 'Stay concise.',
    resolvedCapabilities: { allow: [], requireApproval: [] },
  };

  describe('buildSkillIndex', () => {
    it('generates metadata-only skill index', () => {
      const resolvedSkills = [
        makeLoadedSkill('search', []),
        makeLoadedSkill('browser', []),
      ];

      const index = buildSkillIndex(resolvedSkills);

      expect(index).toContain('## Available Skills');
      expect(index).toContain('- **search**: search description');
      expect(index).toContain('- **browser**: browser description');
      expect(index).toContain('call the `skill_load` tool with the skill name');
      expect(index).not.toContain('prompt:search');
      expect(index).not.toContain('prompt:browser');
    });

    it('returns empty string when no skills', () => {
      expect(buildSkillIndex([])).toBe('');
    });
  });

  describe('skillLoadingMode', () => {
    it('uses lazy mode by default (metadata index only)', () => {
      const resolvedSkills = [makeLoadedSkill('search', [])];
      const skillResolver = {
        mergePromptFragments: vi.fn().mockReturnValue('FULL PROMPT CONTENT'),
        collectMcpServers: vi.fn().mockReturnValue([]),
      };

      const result = buildPersonaRuntimeContext({
        loadedPersona,
        resolvedSkills,
        skillResolver: skillResolver as any,
      });

      expect(result.personaPrompt).toContain('## Available Skills');
      expect(result.personaPrompt).toContain('- **search**: search description');
      expect(result.personaPrompt).not.toContain('FULL PROMPT CONTENT');
    });

    it('uses eager mode when specified (full prompts)', () => {
      const resolvedSkills = [makeLoadedSkill('search', [])];
      const skillResolver = {
        mergePromptFragments: vi.fn().mockReturnValue('FULL PROMPT CONTENT'),
        collectMcpServers: vi.fn().mockReturnValue([]),
      };

      const result = buildPersonaRuntimeContext({
        loadedPersona,
        resolvedSkills,
        skillResolver: skillResolver as any,
        skillLoadingMode: 'eager',
      });

      expect(result.personaPrompt).toContain('FULL PROMPT CONTENT');
    });
  });

  it('merges prompt fragments and resolves env placeholders in MCP config', () => {
    process.env.TEST_API_KEY = 'secret-token';
    process.env.TEST_BEARER = 'bearer-token';

    const loadedSkills = [
      makeLoadedSkill('search', [
        {
          name: 'perplexity',
          config: {
            name: 'perplexity',
            transport: 'stdio',
            command: 'npx',
            args: ['perplexity-mcp'],
            env: { API_KEY: '${TEST_API_KEY}' },
          },
        },
      ]),
      makeLoadedSkill('browser', [
        {
          name: 'browser',
          config: {
            name: 'browser',
            transport: 'http',
            url: 'https://mcp.example.test',
            headers: { Authorization: 'Bearer ${TEST_BEARER}' },
          },
        },
      ]),
    ];

    const skillResolver = {
      mergePromptFragments: vi.fn().mockReturnValue('search prompt\nbrowser prompt'),
      collectMcpServers: vi
        .fn()
        .mockReturnValue(loadedSkills.flatMap((skill) => skill.resolvedMcpServers)),
    };

    const result = buildPersonaRuntimeContext({
      loadedPersona,
      resolvedSkills: loadedSkills,
      skillResolver: skillResolver as any,
      skillLoadingMode: 'eager',
    });

    expect(result.personaPrompt).toBe('You are helpful.\n\nStay concise.\n\nsearch prompt\nbrowser prompt');
    expect(result.mcpServers).toEqual({
      perplexity: {
        transport: 'stdio',
        command: 'npx',
        args: ['perplexity-mcp'],
        env: { API_KEY: 'secret-token' },
      },
      browser: {
        transport: 'http',
        url: 'https://mcp.example.test',
        headers: { Authorization: 'Bearer bearer-token' },
      },
    });
  });

  it('filters excluded MCP servers and lets later definitions win', () => {
    const resolvedSkills = [
      makeLoadedSkill('first', [
        {
          name: 'duplicate',
          config: { name: 'duplicate', transport: 'stdio', command: 'first' },
        },
      ]),
      makeLoadedSkill('second', [
        {
          name: 'duplicate',
          config: { name: 'duplicate', transport: 'stdio', command: 'second' },
        },
        {
          name: 'host-tools',
          config: { name: 'host-tools', transport: 'stdio', command: 'node' },
        },
      ]),
    ];

    const skillResolver = {
      mergePromptFragments: vi.fn().mockReturnValue(''),
      collectMcpServers: vi
        .fn()
        .mockReturnValue(resolvedSkills.flatMap((skill) => skill.resolvedMcpServers)),
    };

    const result = buildPersonaRuntimeContext({
      loadedPersona,
      resolvedSkills,
      skillResolver: skillResolver as any,
      excludeServerNames: ['host-tools'],
    });

    expect(result.mcpServers).toEqual({
      duplicate: {
        transport: 'stdio',
        command: 'second',
        args: [],
      },
    });
  });

  it('skips remote MCP servers that do not define a URL', () => {
    const resolvedSkills = [
      makeLoadedSkill('broken-remote', [
        {
          name: 'remote-without-url',
          config: {
            name: 'remote-without-url',
            transport: 'http',
            headers: { Authorization: 'Bearer token' },
          },
        },
      ]),
    ];
    const logger = { warn: vi.fn() };
    const skillResolver = {
      mergePromptFragments: vi.fn().mockReturnValue(''),
      collectMcpServers: vi
        .fn()
        .mockReturnValue(resolvedSkills.flatMap((skill) => skill.resolvedMcpServers)),
    };

    const result = buildPersonaRuntimeContext({
      loadedPersona,
      resolvedSkills,
      skillResolver: skillResolver as any,
      logger,
    });

    expect(result.mcpServers).toEqual({});
    expect(logger.warn).toHaveBeenCalledWith(
      { mcpServer: 'remote-without-url', transport: 'http' },
      'agent-sdk: skipping remote MCP server without URL',
    );
  });

  it('skips stdio MCP servers that do not define a command', () => {
    const resolvedSkills = [
      makeLoadedSkill('broken-stdio', [
        {
          name: 'stdio-without-command',
          config: {
            name: 'stdio-without-command',
            transport: 'stdio',
            args: ['server.js'],
          },
        },
      ]),
    ];
    const logger = { warn: vi.fn() };
    const skillResolver = {
      mergePromptFragments: vi.fn().mockReturnValue(''),
      collectMcpServers: vi
        .fn()
        .mockReturnValue(resolvedSkills.flatMap((skill) => skill.resolvedMcpServers)),
    };

    const result = buildPersonaRuntimeContext({
      loadedPersona,
      resolvedSkills,
      skillResolver: skillResolver as any,
      logger,
    });

    expect(result.mcpServers).toEqual({});
    expect(logger.warn).toHaveBeenCalledWith(
      { mcpServer: 'stdio-without-command', transport: 'stdio' },
      'agent-sdk: skipping stdio MCP server without command',
    );
  });

  it('rejects user-defined MCP servers with __talond_ prefix', () => {
    const resolvedSkills = [
      makeLoadedSkill('evil-skill', [
        {
          name: '__talond_evil',
          config: {
            name: '__talond_evil',
            transport: 'stdio',
            command: 'node',
          },
        },
      ]),
    ];
    const skillResolver = {
      mergePromptFragments: vi.fn().mockReturnValue(''),
      collectMcpServers: vi
        .fn()
        .mockReturnValue(resolvedSkills.flatMap((skill) => skill.resolvedMcpServers)),
    };

    expect(() =>
      buildPersonaRuntimeContext({
        loadedPersona,
        resolvedSkills,
        skillResolver: skillResolver as any,
      }),
    ).toThrow(/__talond_/);
  });
});
