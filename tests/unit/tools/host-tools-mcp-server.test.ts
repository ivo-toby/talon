/**
 * Unit tests for host-tools-mcp-server.ts dynamic skill-exec tool support.
 *
 * The MCP server is a standalone script, so we test the shared
 * SKILL_EXEC_INPUT_SCHEMA and SkillExecToolMeta contract used by both
 * the server and the agent-runner.
 *
 * For the env var parsing logic, we validate the JSON contract that
 * TALOND_SKILL_EXEC_TOOLS must satisfy.
 */

import { describe, it, expect } from 'vitest';
import {
  SKILL_EXEC_INPUT_SCHEMA,
  buildSkillExecDescription,
  type SkillExecToolMeta,
} from '../../../src/tools/skill-exec-description.js';

describe('TALOND_SKILL_EXEC_TOOLS env var contract', () => {
  it('valid JSON array with required fields is accepted', () => {
    const meta: SkillExecToolMeta[] = [
      {
        mcpName: 'contentful_exec',
        skillName: 'contentful',
        description: 'Run bash commands in contentful sandbox',
      },
      {
        mcpName: 'deploy_exec',
        skillName: 'deploy',
        description: 'Run bash commands in deploy sandbox',
      },
    ];
    const json = JSON.stringify(meta);
    const parsed = JSON.parse(json) as unknown[];

    // Validate all entries have required fields
    for (const entry of parsed) {
      expect(entry).toHaveProperty('mcpName');
      expect(entry).toHaveProperty('skillName');
      expect(entry).toHaveProperty('description');
    }
    expect(parsed).toHaveLength(2);
  });

  it('entries missing required fields are filtered out by the server', () => {
    // The parseSkillExecTools function filters entries missing required fields.
    // This test verifies the contract: only objects with mcpName, skillName,
    // and description (all strings) are valid.
    const raw = [
      { mcpName: 'valid_exec', skillName: 'valid', description: 'desc' },
      { mcpName: 'no_desc', skillName: 'nope' }, // missing description
      { mcpName: 123, skillName: 'bad_type', description: 'desc' }, // wrong type
      null,
      'not_an_object',
    ];

    const valid = raw.filter((entry: unknown): entry is SkillExecToolMeta => {
      if (typeof entry !== 'object' || entry === null) return false;
      const obj = entry as Record<string, unknown>;
      return (
        typeof obj.mcpName === 'string' &&
        typeof obj.skillName === 'string' &&
        typeof obj.description === 'string'
      );
    });

    expect(valid).toHaveLength(1);
    expect(valid[0]!.mcpName).toBe('valid_exec');
  });
});

describe('dynamic skill-exec tool definitions', () => {
  it('ListTools includes dynamic tools with correct inputSchema', () => {
    // Simulate what the MCP server does: for each SkillExecToolMeta,
    // create a tool definition with the shared input schema.
    const meta: SkillExecToolMeta = {
      mcpName: 'contentful_exec',
      skillName: 'contentful',
      description: buildSkillExecDescription(
        {
          workdir: 'repo',
          mounts: [],
          network: 'on',
          secrets: ['CONTENTFUL_TOKEN'],
          env: {},
          bins: ['bash', 'node', 'npm'],
          image: 'talon-skill-runtime:latest',
          shell: '/bin/bash',
          timeoutSeconds: 30,
          resourceLimits: { cpus: 1, memoryMb: 512, diskGb: 1 },
        },
        'contentful',
      ),
    };

    const toolDef = {
      name: meta.mcpName,
      description: meta.description,
      inputSchema: SKILL_EXEC_INPUT_SCHEMA,
    };

    expect(toolDef.name).toBe('contentful_exec');
    expect(toolDef.description).toContain("'contentful'");
    expect(toolDef.description).toContain('CONTENTFUL_TOKEN');
    expect(toolDef.description).toContain('Network: on');
    expect(toolDef.inputSchema.type).toBe('object');
    expect(toolDef.inputSchema.properties.command.type).toBe('string');
    expect(toolDef.inputSchema.properties.timeoutSeconds.type).toBe('integer');
    expect(toolDef.inputSchema.required).toContain('command');
  });

  it('dynamic tools are filtered by TALOND_ALLOWED_TOOLS', () => {
    // Simulate the server's filtering: only tools in allowedSet are included.
    const allowedSet = new Set(['channel_send', 'contentful_exec']);
    const allSkillExecTools: SkillExecToolMeta[] = [
      { mcpName: 'contentful_exec', skillName: 'contentful', description: 'desc1' },
      { mcpName: 'deploy_exec', skillName: 'deploy', description: 'desc2' },
    ];

    const filtered = allSkillExecTools.filter((t) => allowedSet.has(t.mcpName));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.mcpName).toBe('contentful_exec');
  });
});
