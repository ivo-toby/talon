// Minimal stdio MCP server for integration tests. Exposes one no-op tool per
// name in STUB_MCP_TOOLS (comma-separated), so a test can start several
// servers with different tool sets from this one file.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'stub-mcp-server', version: '0.0.0' });

for (const name of (process.env.STUB_MCP_TOOLS ?? '').split(',').filter(Boolean)) {
  server.registerTool(name, { description: `stub tool ${name}` }, async () => ({
    content: [{ type: 'text', text: `${name} ok` }],
  }));
}

await server.connect(new StdioServerTransport());
