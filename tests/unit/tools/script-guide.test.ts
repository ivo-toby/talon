import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScriptGuide } from '../../../src/tools/tool-instructions.js';
import { HOST_TOOL_DEFINITIONS } from '../../../src/tools/host-tools-mcp-server.js';

describe('loadScriptGuide', () => {
  it('takes the first path that holds text and skips missing and empty files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guide-'));
    try {
      writeFileSync(join(dir, 'empty.md'), '  \n');
      writeFileSync(join(dir, 'guide.md'), '# Guide\n');
      expect(
        loadScriptGuide([join(dir, 'nope.md'), join(dir, 'empty.md'), join(dir, 'guide.md')]),
      ).toBe('# Guide');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when no path holds a guide', () => {
    expect(loadScriptGuide(['/nonexistent/a.md'])).toBeUndefined();
  });

  it('finds the real guide in templates/', () => {
    expect(loadScriptGuide([join(process.cwd(), 'templates/script-authoring.md')])).toContain(
      'script',
    );
  });
});

describe('script_manage MCP definition', () => {
  const tool = HOST_TOOL_DEFINITIONS.find((t) => t.name === 'script_manage') as
    | { description: string; inputSchema: { properties: Record<string, any>; required: string[] } }
    | undefined;

  it('is defined and tells the agent to read the guide first', () => {
    expect(tool).toBeDefined();
    expect(tool!.description).toContain('action "guide"');
    expect(tool!.inputSchema.required).toEqual(['action']);
    expect(tool!.inputSchema.properties.action.enum).toEqual([
      'guide',
      'tools',
      'save',
      'test',
      'request_approval',
      'list',
      'show',
    ]);
    expect(tool!.inputSchema.properties.files.maxItems).toBe(20);
  });
});
