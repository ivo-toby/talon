/**
 * Unit tests for tool-filter.ts — capability-to-tool mapping and filtering.
 */

import { describe, it, expect } from 'vitest';
import {
  extractCapabilityPrefix,
  filterAllowedMcpTools,
  filterAllowedTools,
  getToolPolicyDecision,
  isToolAllowed,
  ALL_HOST_TOOLS,
} from '../../../src/tools/tool-filter.js';
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
// getToolPolicyDecision
// ---------------------------------------------------------------------------

describe('getToolPolicyDecision', () => {
  const caps: ResolvedCapabilities = {
    allow: ['channel.send:TalonMain', 'memory.access'],
    requireApproval: ['db.query'],
  };

  it('returns allow for directly allowed tools', () => {
    expect(getToolPolicyDecision('channel.send', caps)).toBe('allow');
    expect(getToolPolicyDecision('memory.access', caps)).toBe('allow');
  });

  it('returns require_approval for approval-gated tools', () => {
    expect(getToolPolicyDecision('db.query', caps)).toBe('require_approval');
  });

  it('returns allow when a tool appears in both lists', () => {
    expect(getToolPolicyDecision('db.query', {
      allow: ['db.query'],
      requireApproval: ['db.query'],
    })).toBe('allow');
  });

  it('returns deny for disallowed tools', () => {
    expect(getToolPolicyDecision('net.http', caps)).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// ALL_HOST_TOOLS
// ---------------------------------------------------------------------------

describe('ALL_HOST_TOOLS', () => {
  it('contains all eleven host tools', () => {
    expect(ALL_HOST_TOOLS).toHaveLength(11);
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
  });
});
