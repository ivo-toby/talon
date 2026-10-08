import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildResponsesTools } from '../src/providers/openai-compatible/agent-cli/responses-api.js';

const inputSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    limit: { type: 'integer', minimum: 1 },
  },
  required: ['query'],
};

describe('Standard JSON Schema compatibility', () => {
  it('preserves MCP tool parameters from a Standard JSON Schema wrapper', () => {
    const wrapped = {
      '~standard': {
        version: 1,
        vendor: 'json-schema',
        jsonSchema: {
          input: ({ target }: { target: string }) => {
            expect(target).toBe('draft-07');
            return inputSchema;
          },
        },
      },
    };
    const tools = buildResponsesTools({
      search_records: {
        description: 'Search records',
        inputSchema: wrapped,
      } as never,
    });
    expect(tools[0]?.parameters).toMatchObject(inputSchema);
  });

  it('continues accepting plain JSON schemas', () => {
    const tools = buildResponsesTools({
      search_records: {
        description: 'Search records',
        inputSchema,
      } as never,
    });
    expect(tools[0]?.parameters).toMatchObject(inputSchema);
  });
  it('preserves the existing toJSONSchema route for Zod tools', () => {
    const schema = z.object({
      a: z.string(),
      n: z.number().default(5),
      t: z.tuple([z.string(), z.number()]),
    });
    const { $schema: _schemaUri, ...expected } = schema.toJSONSchema();
    const tools = buildResponsesTools({
      zod_tool: { inputSchema: schema } as never,
    });
    expect(tools[0]?.parameters).toEqual(expected);
    expect(tools[0]?.parameters).toMatchObject({
      required: ['a', 'n', 't'],
      additionalProperties: false,
    });
  });

  it('tries a supported schema dialect if draft-07 is rejected', () => {
    const input = vi.fn(({ target }: { target: string }) => {
      if (target === 'draft-07') throw new Error('Unsupported dialect');
      return inputSchema;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tools = buildResponsesTools({
        fallback_tool: { inputSchema: { '~standard': { jsonSchema: { input } } } } as never,
      });
      expect(tools[0]?.parameters).toMatchObject(inputSchema);
      expect(input).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('fallback_tool'),
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the run alive if every schema dialect fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tools = buildResponsesTools({
        broken_tool: {
          inputSchema: {
            '~standard': { jsonSchema: { input: () => { throw new Error('Unsupported'); } } },
          },
        } as never,
      });
      expect(tools[0]?.parameters).toEqual({
        type: 'object',
        properties: {},
        required: [],
      });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

});
