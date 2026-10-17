/**
 * host-tools-mcp-server contract tests (TASK-017).
 *
 * These run against the exported definitions and the pure exposure/gating
 * helpers — no socket, no spawn, no daemon — and pin the `image_lookup`
 * schema contract:
 *
 *  - four operation-specific input schemas (list_images, get_image,
 *    list_findings, get_finding), each pinning its own `operation` value, its
 *    own required fields, and `additionalProperties: false`;
 *  - bounded pagination (`limit` 1–100, default 20) and an opaque `cursor`;
 *  - no thread, path, URL, provenance, persona, or run field anywhere in the
 *    accepted input (the thread comes from the trusted run context);
 *  - MCP-name exposure filtering and call gating, including rejection of the
 *    internal dot-notation name `image.lookup` (no internal-name bypass).
 */
import { describe, it, expect } from 'vitest';
import {
  HOST_TOOL_DEFINITIONS,
  IMAGE_LOOKUP_LIST_IMAGES_SCHEMA,
  IMAGE_LOOKUP_GET_IMAGE_SCHEMA,
  IMAGE_LOOKUP_LIST_FINDINGS_SCHEMA,
  IMAGE_LOOKUP_GET_FINDING_SCHEMA,
  IMAGE_LOOKUP_OPERATION_SCHEMAS,
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

  it('carries four oneOf branches matching the four operation schemas', () => {
    expect(tool.inputSchema.oneOf).toHaveLength(4);
    expect(tool.inputSchema.oneOf).toEqual(IMAGE_LOOKUP_OPERATION_SCHEMAS);
  });

  describe('operation schemas', () => {
    it('list_images: optional bounded limit and cursor only', () => {
      expect(IMAGE_LOOKUP_LIST_IMAGES_SCHEMA.type).toBe('object');
      expect(IMAGE_LOOKUP_LIST_IMAGES_SCHEMA.additionalProperties).toBe(false);
      expect(IMAGE_LOOKUP_LIST_IMAGES_SCHEMA.required).toEqual(['operation']);
      expect(Object.keys(IMAGE_LOOKUP_LIST_IMAGES_SCHEMA.properties).sort()).toEqual([
        'cursor',
        'limit',
        'operation',
      ]);
      expect(IMAGE_LOOKUP_LIST_IMAGES_SCHEMA.properties.operation.enum).toEqual(['list_images']);
      expect(IMAGE_LOOKUP_LIST_IMAGES_SCHEMA.properties.limit.minimum).toBe(1);
      expect(IMAGE_LOOKUP_LIST_IMAGES_SCHEMA.properties.limit.maximum).toBe(100);
    });

    it('get_image: exactly imageId, no pagination fields', () => {
      expect(IMAGE_LOOKUP_GET_IMAGE_SCHEMA.additionalProperties).toBe(false);
      expect(IMAGE_LOOKUP_GET_IMAGE_SCHEMA.required).toEqual(['operation', 'imageId']);
      expect(Object.keys(IMAGE_LOOKUP_GET_IMAGE_SCHEMA.properties).sort()).toEqual([
        'imageId',
        'operation',
      ]);
      expect(IMAGE_LOOKUP_GET_IMAGE_SCHEMA.properties.operation.enum).toEqual(['get_image']);
    });

    it('list_findings: optional imageId filter plus bounded pagination', () => {
      expect(IMAGE_LOOKUP_LIST_FINDINGS_SCHEMA.additionalProperties).toBe(false);
      expect(IMAGE_LOOKUP_LIST_FINDINGS_SCHEMA.required).toEqual(['operation']);
      expect(Object.keys(IMAGE_LOOKUP_LIST_FINDINGS_SCHEMA.properties).sort()).toEqual([
        'cursor',
        'imageId',
        'limit',
        'operation',
      ]);
      expect(IMAGE_LOOKUP_LIST_FINDINGS_SCHEMA.properties.limit.minimum).toBe(1);
      expect(IMAGE_LOOKUP_LIST_FINDINGS_SCHEMA.properties.limit.maximum).toBe(100);
      expect(IMAGE_LOOKUP_LIST_FINDINGS_SCHEMA.properties.operation.enum).toEqual([
        'list_findings',
      ]);
    });

    it('get_finding: exactly findingId, no pagination fields', () => {
      expect(IMAGE_LOOKUP_GET_FINDING_SCHEMA.additionalProperties).toBe(false);
      expect(IMAGE_LOOKUP_GET_FINDING_SCHEMA.required).toEqual(['operation', 'findingId']);
      expect(Object.keys(IMAGE_LOOKUP_GET_FINDING_SCHEMA.properties).sort()).toEqual([
        'findingId',
        'operation',
      ]);
      expect(IMAGE_LOOKUP_GET_FINDING_SCHEMA.properties.operation.enum).toEqual(['get_finding']);
    });

    it('pins each operation to a single branch (no cross-operation field leakage)', () => {
      const expected = ['list_images', 'get_image', 'list_findings', 'get_finding'];
      IMAGE_LOOKUP_OPERATION_SCHEMAS.forEach((branch, index) => {
        expect(branch.properties.operation.enum).toEqual([expected[index]]);
      });
    });
  });

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
