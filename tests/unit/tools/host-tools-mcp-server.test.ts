/**
 * host-tools-mcp-server contract tests (TASK-017).
 *
 * These run against the exported definitions and the pure exposure/gating
 * helpers — no socket, no spawn, no daemon — and pin the `image_lookup`
 * schema contract:
 *
 *  - one flat input schema (the union of accepted fields, with
 *    `additionalProperties: false`) and NO top-level oneOf/anyOf/allOf, which
 *    provider tool APIs reject; per-operation rules live in the handler;
 *  - bounded pagination (`limit` 1–100, default 20) and an opaque `cursor`;
 *  - no thread, path, URL, provenance, persona, or run field anywhere in the
 *    accepted input (the thread comes from the trusted run context);
 *  - MCP-name exposure filtering and call gating, including rejection of the
 *    internal dot-notation name `image.lookup` (no internal-name bypass).
 */
import { describe, it, expect } from 'vitest';
import {
  HOST_TOOL_DEFINITIONS,
  gateMcpToolCall,
  listExposedTools,
} from '../../../src/tools/host-tools-mcp-server.js';

function findTool(name: string) {
  const tool = HOST_TOOL_DEFINITIONS.find((t) => t.name === name);
  expect(tool, `tool ${name} should be defined`).toBeDefined();
  return tool as {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
  };
}

describe('image_lookup tool definition', () => {
  const tool = findTool('image_lookup');

  it('is present exactly once in the MCP tool list', () => {
    const names = HOST_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names.filter((n) => n === 'image_lookup')).toHaveLength(1);
  });

  it('declares a top-level object schema that rejects unknown fields', () => {
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.required).toEqual(['operation']);
    expect(tool.inputSchema.properties.operation.enum).toEqual([
      'list_images',
      'get_image',
      'list_findings',
      'get_finding',
    ]);
  });

  it('exposes exactly the union of accepted fields — no thread/path/url/provenance', () => {
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual([
      'cursor',
      'findingId',
      'imageId',
      'limit',
      'operation',
    ]);
  });

  it('bounds pagination: limit 1-100', () => {
    expect(tool.inputSchema.properties.limit.minimum).toBe(1);
    expect(tool.inputSchema.properties.limit.maximum).toBe(100);
  });

  it("states each operation's fields in the description", () => {
    expect(tool.description).toContain('`get_image` requires `imageId`');
    expect(tool.description).toContain('`get_finding` requires `findingId`');
  });

  // Provider tool APIs (Anthropic: "input_schema does not support oneOf,
  // allOf, or anyOf at the top level") reject top-level combinators, which
  // fails every request that exposes the tool, not just calls to it.
  it.each(HOST_TOOL_DEFINITIONS.map((t) => [t.name, t] as const))(
    '%s has no top-level oneOf/anyOf/allOf',
    (_name, def) => {
      const schema = (def as { inputSchema: Record<string, unknown> }).inputSchema;
      expect(schema.type).toBe('object');
      for (const key of ['oneOf', 'anyOf', 'allOf']) {
        expect(schema).not.toHaveProperty(key);
      }
    },
  );

  // Recursively collects any denylisted key in a schema tree. Entries are
  // compared case-insensitively, so the denylist itself is stored lowercased:
  // the keys are lowercased before the check, and a mixed-case denylist entry
  // (e.g. `threadId`) would never match and let a nested field escape.
  const FORBIDDEN_CONTEXT_KEYS = [
    'threadid',
    'thread',
    'path',
    'url',
    'uri',
    'provenance',
    'personaid',
    'runid',
  ];

  const findUntrustedContextFields = (node: any): string[] => {
    if (node === null || typeof node !== 'object') return [];
    const found: string[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (FORBIDDEN_CONTEXT_KEYS.includes(key.toLowerCase())) found.push(key);
      found.push(...findUntrustedContextFields(value));
    }
    return found;
  };

  it('detects an injected camelCase context field (denylist positive control)', () => {
    // Guards against a silently-dead denylist: camelCase entries must still
    // match after keys are lowercased. If the denylist is ever reverted to
    // raw camelCase, this assertion fails.
    expect(
      findUntrustedContextFields({
        type: 'object',
        properties: {
          threadId: { type: 'string' },
          persona: { properties: { personaId: { type: 'string' } } },
        },
        oneOf: [{ properties: { runId: { type: 'string' } } }],
      }),
    ).toEqual(['threadId', 'personaId', 'runId']);
  });

  it('accepts no untrusted context field anywhere in the image_lookup schema tree', () => {
    expect(findUntrustedContextFields(tool.inputSchema)).toEqual([]);
  });
});

describe('MCP exposure and call gating', () => {
  const allowedWithImage = new Set(['image_lookup', 'memory']);
  const allowedWithoutImage = new Set(['memory']);

  it('exposes image_lookup only when it is in the allowed set', () => {
    expect(listExposedTools(allowedWithImage).map((t) => t.name)).toContain('image_lookup');
    expect(listExposedTools(allowedWithoutImage).map((t) => t.name)).not.toContain('image_lookup');
  });

  it('resolves an allowed MCP name to its internal handler name', () => {
    const gate = gateMcpToolCall(allowedWithImage, 'image_lookup');
    expect(gate).toEqual({ ok: true, handlerName: 'image.lookup' });
  });

  it('rejects the internal dot-notation name image.lookup (no bypass via internal name)', () => {
    const gate = gateMcpToolCall(allowedWithImage, 'image.lookup');
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.error).toContain('not allowed');
    }
  });

  it('rejects names that are allowed but unknown to the tool map', () => {
    const gate = gateMcpToolCall(new Set(['not_a_real_tool']), 'not_a_real_tool');
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.error).toContain('Unknown tool');
    }
  });

  it('rejects a call when the allowed set is empty (default-deny)', () => {
    const gate = gateMcpToolCall(new Set(), 'image_lookup');
    expect(gate.ok).toBe(false);
  });
});

describe('persona delegation tool definitions', () => {
  it('persona_send explains isolation, results, failure and discovery', () => {
    const tool = findTool('persona_send');
    expect(tool.description).toContain('ONLY `message`');
    expect(tool.description).toContain('persona_list');
    expect(tool.description).toContain('queued');
    expect(tool.description).toContain('cancel_on_timeout');
    expect(tool.description).toContain('`result`');
    expect(tool.description).toContain('"failed" state is final');
    expect(tool.inputSchema.properties.message.description).toContain('only thing the target sees');
    expect(tool.inputSchema.properties.target_persona.description).toContain('persona_list');
  });

  it('persona_list and persona_task_status describe what they return', () => {
    expect(findTool('persona_list').description).toContain('name, description and skills');
    expect(findTool('persona_task_status').description).toContain('wait_ms');
  });
});
