/**
 * Unit tests for tool-filter.ts — capability-to-tool mapping and filtering.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractCapabilityPrefix,
  filterAllowedMcpTools,
  filterAllowedTools,
  isToolAllowed,
  ALL_HOST_TOOLS,
  sanitizeSkillNameForMcp,
  getSkillNameForMcpTool,
  resetSkillExecLookup,
} from '../../../src/tools/tool-filter.js';
import type { ToolExpansionContext } from '../../../src/tools/tool-filter.js';
import type { ResolvedCapabilities } from '../../../src/personas/persona-types.js';

// ---------------------------------------------------------------------------
// extractCapabilityPrefix
// ---------------------------------------------------------------------------

describe('extractCapabilityPrefix', () => {
  it('extracts prefix from scoped capability', () => {
    expect(extractCapabilityPrefix('channel.send:TalonMain')).toBe('channel.send');
  });

  it('returns full label for unscoped capability', () => {
    expect(extractCapabilityPrefix('memory.access')).toBe('memory.access');
  });

  it('extracts prefix from complex scope', () => {
    expect(extractCapabilityPrefix('fs.read:workspace')).toBe('fs.read');
  });

  it('returns null for empty string', () => {
    expect(extractCapabilityPrefix('')).toBeNull();
  });

  it('returns null for single word (no dot)', () => {
    expect(extractCapabilityPrefix('channel')).toBeNull();
  });

  it('returns null for malformed labels', () => {
    expect(extractCapabilityPrefix('a.b.c')).toBeNull();
    expect(extractCapabilityPrefix('.send')).toBeNull();
    expect(extractCapabilityPrefix('channel.')).toBeNull();
  });

  it('handles scope with multiple colons', () => {
    // Only the first colon splits prefix from scope
    expect(extractCapabilityPrefix('net.http:egress:all')).toBe('net.http');
  });
});

// ---------------------------------------------------------------------------
// filterAllowedMcpTools
// ---------------------------------------------------------------------------

describe('filterAllowedMcpTools', () => {
  it('returns empty array for empty capabilities', () => {
    const caps: ResolvedCapabilities = { allow: [], requireApproval: [] };
    expect(filterAllowedMcpTools(caps)).toEqual([]);
  });

  it('maps channel.send capability to channel_send MCP tool', () => {
    const caps: ResolvedCapabilities = {
      allow: ['channel.send:TalonMain'],
      requireApproval: [],
    };
    expect(filterAllowedMcpTools(caps)).toEqual(['channel_send']);
  });

  it('maps multiple capabilities to MCP tools', () => {
    const caps: ResolvedCapabilities = {
      allow: ['channel.send:TalonMain', 'memory.access', 'net.http'],
      requireApproval: [],
    };
    const result = filterAllowedMcpTools(caps);
    expect(result).toContain('channel_send');
    expect(result).toContain('memory_access');
    expect(result).toContain('net_http');
    expect(result).toHaveLength(3);
  });

  it('includes tools from requireApproval list', () => {
    const caps: ResolvedCapabilities = {
      allow: [],
      requireApproval: ['db.query'],
    };
    expect(filterAllowedMcpTools(caps)).toEqual(['db_query']);
  });

  it('deduplicates when same tool appears in both allow and requireApproval', () => {
    const caps: ResolvedCapabilities = {
      allow: ['channel.send:TalonMain'],
      requireApproval: ['channel.send:OtherChannel'],
    };
    const result = filterAllowedMcpTools(caps);
    expect(result).toEqual(['channel_send']);
  });

  it('ignores capabilities that do not map to host tools', () => {
    const caps: ResolvedCapabilities = {
      allow: ['fs.read:workspace', 'fs.write:workspace'],
      requireApproval: [],
    };
    expect(filterAllowedMcpTools(caps)).toEqual([]);
  });

  it('handles mix of known and unknown capabilities', () => {
    const caps: ResolvedCapabilities = {
      allow: ['channel.send:TalonMain', 'fs.read:workspace', 'schedule.manage'],
      requireApproval: ['unknown.capability'],
    };
    const result = filterAllowedMcpTools(caps);
    expect(result).toContain('channel_send');
    expect(result).toContain('schedule_manage');
    expect(result).toHaveLength(2);
  });

  it('returns all host tools when all capabilities are granted', () => {
    const caps: ResolvedCapabilities = {
      allow: [
        'schedule.manage',
        'channel.send:any',
        'persona.send:*',
        'memory.access',
        'net.http',
        'db.query',
        'execution.env',
        'subagent.invoke',
        'subagent.background',
      ],
      requireApproval: [],
    };
    const result = filterAllowedMcpTools(caps);
    expect(result).toHaveLength(11);
    expect(result).toContain('background_agent');
    expect(result).toContain('persona_send');
    expect(result).toContain('persona_task_status');
    expect(result).toContain('persona_list');
    expect(result).toContain('execution_env');
  });

  it('maps persona.send capability to persona_send, persona_task_status, and persona_list MCP tools', () => {
    const caps: ResolvedCapabilities = {
      allow: ['persona.send:*'],
      requireApproval: [],
    };
    const result = filterAllowedMcpTools(caps);
    expect(result).toContain('persona_send');
    expect(result).toContain('persona_task_status');
    expect(result).toContain('persona_list');
    expect(result).toHaveLength(3);
  });

  it('maps subagent.background capability to background_agent MCP tool', () => {
    const caps: ResolvedCapabilities = {
      allow: ['subagent.background'],
      requireApproval: [],
    };

    expect(filterAllowedMcpTools(caps)).toEqual(['background_agent']);
  });

  it('maps execution.env capability to execution_env MCP tool', () => {
    const caps: ResolvedCapabilities = {
      allow: ['execution.env'],
      requireApproval: [],
    };

    expect(filterAllowedMcpTools(caps)).toEqual(['execution_env']);
  });
});

// ---------------------------------------------------------------------------
// filterAllowedTools (internal dot-notation)
// ---------------------------------------------------------------------------

describe('filterAllowedTools', () => {
  it('returns empty array for empty capabilities', () => {
    const caps: ResolvedCapabilities = { allow: [], requireApproval: [] };
    expect(filterAllowedTools(caps)).toEqual([]);
  });

  it('returns dot-notation tool names', () => {
    const caps: ResolvedCapabilities = {
      allow: ['channel.send:TalonMain', 'net.http', 'execution.env'],
      requireApproval: [],
    };
    const result = filterAllowedTools(caps);
    expect(result).toContain('channel.send');
    expect(result).toContain('net.http');
    expect(result).toContain('execution.env');
    expect(result).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// isToolAllowed
// ---------------------------------------------------------------------------

describe('isToolAllowed', () => {
  const caps: ResolvedCapabilities = {
    allow: ['channel.send:TalonMain', 'memory.access'],
    requireApproval: ['db.query'],
  };

  it('returns true for allowed tool', () => {
    expect(isToolAllowed('channel.send', caps)).toBe(true);
    expect(isToolAllowed('memory.access', caps)).toBe(true);
  });

  it('returns true for requireApproval tool', () => {
    expect(isToolAllowed('db.query', caps)).toBe(true);
  });

  it('returns true for execution env tool when granted', () => {
    const executionCaps: ResolvedCapabilities = {
      allow: ['execution.env'],
      requireApproval: [],
    };

    expect(isToolAllowed('execution.env', executionCaps)).toBe(true);
  });

  it('returns false for disallowed tool', () => {
    expect(isToolAllowed('net.http', caps)).toBe(false);
    expect(isToolAllowed('schedule.manage', caps)).toBe(false);
  });

  it('returns false for unknown tool name', () => {
    expect(isToolAllowed('unknown.tool', caps)).toBe(false);
  });

  it('returns false for all tools when capabilities are empty', () => {
    const empty: ResolvedCapabilities = { allow: [], requireApproval: [] };
    for (const tool of ALL_HOST_TOOLS) {
      expect(isToolAllowed(tool, empty)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// ALL_HOST_TOOLS
// ---------------------------------------------------------------------------

describe('ALL_HOST_TOOLS', () => {
  it('contains all twelve host tools', () => {
    expect(ALL_HOST_TOOLS).toHaveLength(12);
    expect(ALL_HOST_TOOLS).toContain('schedule.manage');
    expect(ALL_HOST_TOOLS).toContain('channel.send');
    expect(ALL_HOST_TOOLS).toContain('persona.send');
    expect(ALL_HOST_TOOLS).toContain('persona.task_status');
    expect(ALL_HOST_TOOLS).toContain('persona.list');
    expect(ALL_HOST_TOOLS).toContain('memory.access');
    expect(ALL_HOST_TOOLS).toContain('net.http');
    expect(ALL_HOST_TOOLS).toContain('db.query');
    expect(ALL_HOST_TOOLS).toContain('execution.env');
    expect(ALL_HOST_TOOLS).toContain('subagent.invoke');
    expect(ALL_HOST_TOOLS).toContain('subagent.background');
    expect(ALL_HOST_TOOLS).toContain('skill.exec');
  });
});

// ---------------------------------------------------------------------------
// sanitizeSkillNameForMcp
// ---------------------------------------------------------------------------

describe('sanitizeSkillNameForMcp', () => {
  it('appends _exec to simple name', () => {
    expect(sanitizeSkillNameForMcp('contentful')).toBe('contentful_exec');
  });

  it('replaces hyphens with underscores and appends _exec', () => {
    expect(sanitizeSkillNameForMcp('git-flow')).toBe('git_flow_exec');
  });

  it('lowercases the name', () => {
    expect(sanitizeSkillNameForMcp('MySkill')).toBe('myskill_exec');
  });

  it('handles multiple hyphens', () => {
    expect(sanitizeSkillNameForMcp('my-cool-skill')).toBe('my_cool_skill_exec');
  });

  it('handles name already containing underscores', () => {
    expect(sanitizeSkillNameForMcp('my_skill')).toBe('my_skill_exec');
  });
});

// ---------------------------------------------------------------------------
// skill.exec dynamic expansion
// ---------------------------------------------------------------------------

describe('filterAllowedMcpTools with skill.exec expansion', () => {
  beforeEach(() => {
    resetSkillExecLookup();
  });

  function makeSkill(name: string, hasSandbox: boolean, staged: boolean) {
    return {
      manifest: {
        name,
        ...(hasSandbox ? { sandbox: { workdir: 'repo' } } : {}),
      },
      stagedSandbox: staged ? { binDir: `/tmp/${name}/.bin` } : null,
    };
  }

  function makeContext(
    caps: ResolvedCapabilities,
    skills: ReturnType<typeof makeSkill>[],
  ): ToolExpansionContext {
    return {
      personaId: 'test-persona',
      capabilities: caps,
      loadedSkills: skills,
    };
  }

  it('returns both exec tools with skill.exec:* wildcard', () => {
    const caps: ResolvedCapabilities = {
      allow: ['skill.exec:*'],
      requireApproval: [],
    };
    const ctx = makeContext(caps, [
      makeSkill('contentful', true, true),
      makeSkill('git-flow', true, true),
    ]);

    const result = filterAllowedMcpTools(caps, ctx);
    expect(result).toContain('contentful_exec');
    expect(result).toContain('git_flow_exec');
  });

  it('returns only granted skill with specific scope', () => {
    const caps: ResolvedCapabilities = {
      allow: ['skill.exec:contentful'],
      requireApproval: [],
    };
    const ctx = makeContext(caps, [
      makeSkill('contentful', true, true),
      makeSkill('git-flow', true, true),
    ]);

    const result = filterAllowedMcpTools(caps, ctx);
    expect(result).toContain('contentful_exec');
    expect(result).not.toContain('git_flow_exec');
  });

  it('excludes skills without sandbox block', () => {
    const caps: ResolvedCapabilities = {
      allow: ['skill.exec:*'],
      requireApproval: [],
    };
    const ctx = makeContext(caps, [
      makeSkill('contentful', true, true),
      makeSkill('prompt-only', false, false),
    ]);

    const result = filterAllowedMcpTools(caps, ctx);
    expect(result).toContain('contentful_exec');
    expect(result).not.toContain('prompt_only_exec');
  });

  it('excludes skills with stagedSandbox: null', () => {
    const caps: ResolvedCapabilities = {
      allow: ['skill.exec:*'],
      requireApproval: [],
    };
    const ctx = makeContext(caps, [
      makeSkill('contentful', true, true),
      makeSkill('broken', true, false), // sandbox block present but staging failed
    ]);

    const result = filterAllowedMcpTools(caps, ctx);
    expect(result).toContain('contentful_exec');
    expect(result).not.toContain('broken_exec');
  });

  it('returns nothing when no expansion context is provided (backward compat)', () => {
    const caps: ResolvedCapabilities = {
      allow: ['skill.exec:*', 'channel.send:TalonMain'],
      requireApproval: [],
    };

    const result = filterAllowedMcpTools(caps);
    expect(result).toContain('channel_send');
    expect(result).not.toContain('contentful_exec');
    expect(result).not.toContain('skill_exec');
  });

  it('handles collision: two skills producing same MCP name', () => {
    const caps: ResolvedCapabilities = {
      allow: ['skill.exec:*'],
      requireApproval: [],
    };
    // Both produce "git_flow_exec"
    const ctx = makeContext(caps, [
      makeSkill('git-flow', true, true),
      makeSkill('git_flow', true, true),
    ]);

    const result = filterAllowedMcpTools(caps, ctx);
    // Only first one should be included
    expect(result.filter((n) => n === 'git_flow_exec')).toHaveLength(1);
  });

  it('populates reverse lookup map', () => {
    const caps: ResolvedCapabilities = {
      allow: ['skill.exec:*'],
      requireApproval: [],
    };
    const ctx = makeContext(caps, [
      makeSkill('contentful', true, true),
      makeSkill('git-flow', true, true),
    ]);

    filterAllowedMcpTools(caps, ctx);

    expect(getSkillNameForMcpTool('contentful_exec')).toBe('contentful');
    expect(getSkillNameForMcpTool('git_flow_exec')).toBe('git-flow');
    expect(getSkillNameForMcpTool('unknown_exec')).toBeNull();
  });

  it('includes requireApproval skill.exec grants', () => {
    const caps: ResolvedCapabilities = {
      allow: [],
      requireApproval: ['skill.exec:contentful'],
    };
    const ctx = makeContext(caps, [
      makeSkill('contentful', true, true),
    ]);

    const result = filterAllowedMcpTools(caps, ctx);
    expect(result).toContain('contentful_exec');
  });

  it('bare skill.exec without scope grants nothing', () => {
    const caps: ResolvedCapabilities = {
      allow: ['skill.exec'],
      requireApproval: [],
    };
    const ctx = makeContext(caps, [
      makeSkill('contentful', true, true),
    ]);

    const result = filterAllowedMcpTools(caps, ctx);
    expect(result).not.toContain('contentful_exec');
  });

  it('does not affect static tool resolution when expansion context is provided', () => {
    const caps: ResolvedCapabilities = {
      allow: ['channel.send:TalonMain', 'skill.exec:contentful'],
      requireApproval: [],
    };
    const ctx = makeContext(caps, [
      makeSkill('contentful', true, true),
    ]);

    const result = filterAllowedMcpTools(caps, ctx);
    expect(result).toContain('channel_send');
    expect(result).toContain('contentful_exec');
  });
});

// ---------------------------------------------------------------------------
// resetSkillExecLookup
// ---------------------------------------------------------------------------

describe('resetSkillExecLookup', () => {
  it('clears the reverse lookup map', () => {
    resetSkillExecLookup();

    const caps: ResolvedCapabilities = {
      allow: ['skill.exec:*'],
      requireApproval: [],
    };
    const ctx: ToolExpansionContext = {
      personaId: 'test',
      capabilities: caps,
      loadedSkills: [{
        manifest: { name: 'test-skill', sandbox: { workdir: 'repo' } },
        stagedSandbox: {},
      }],
    };

    filterAllowedMcpTools(caps, ctx);
    expect(getSkillNameForMcpTool('test_skill_exec')).toBe('test-skill');

    resetSkillExecLookup();
    expect(getSkillNameForMcpTool('test_skill_exec')).toBeNull();
  });
});
