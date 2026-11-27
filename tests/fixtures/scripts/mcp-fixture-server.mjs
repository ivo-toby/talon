// Minimal stdio MCP server for the MCP provider test.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fixture', version: '1.0.0' });
const items = ['apple'];

server.registerTool(
  'list_items',
  { description: 'List items', annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: 'text', text: JSON.stringify(items) }] }),
);
server.registerTool(
  'add_item',
  { description: 'Add an item', inputSchema: { name: z.string() } },
  async ({ name }) => {
    items.push(name);
    return { content: [{ type: 'text', text: `added ${name}` }] };
  },
);
server.registerTool('fail', { description: 'Always fails' }, async () => ({
  isError: true,
  content: [{ type: 'text', text: 'boom' }],
}));

await server.connect(new StdioServerTransport());
