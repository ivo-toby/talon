import { describe, expect, it } from 'vitest';
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
});
