import { describe, it, expect, beforeEach } from 'vitest';

import {
  excerptToolOutput,
  fetchToolOutputSlice,
  isLikelyError,
  ToolOutputStore,
  DEFAULT_TOOL_OUTPUT_CAP,
  DEFAULT_FETCH_SLICE_CAP,
} from '../../../src/providers/openai-compatible/agent-cli/tool-output-excerpter.js';

describe('excerptToolOutput', () => {
  it('passes through when total size is within the cap', () => {
    const result = excerptToolOutput('call-1', 'read_file', 'hello world', 4000);
    expect(result.truncated).toBe(false);
    expect(result.excerpt).toBe('hello world');
    expect(result.originalChars).toBe(11);
    expect(result.excerptChars).toBe(11);
  });

  it('passes through when cap is 0 (feature disabled)', () => {
    const big = 'x'.repeat(50_000);
    const result = excerptToolOutput('call-1', 'read_file', big, 0);
    expect(result.truncated).toBe(false);
    expect(result.excerpt).toBe(big);
    expect(result.excerptChars).toBe(50_000);
  });

  it('head/tail-truncates a plain string larger than the cap', () => {
    const big = 'HEAD_'.repeat(500) + 'MIDDLE_'.repeat(500) + 'TAIL_'.repeat(500);
    const result = excerptToolOutput('call-1', 'execute_command', big, 400);

    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBe(big.length);
    expect(result.excerptChars).toBeLessThan(big.length);
    // Head and tail survive, middle omitted.
    expect(result.excerpt).toMatch(/^HEAD_/);
    expect(result.excerpt).toMatch(/TAIL_$/);
    expect(result.excerpt).not.toContain('MIDDLE_');
    // Marker is present with recovery hint.
    expect(result.excerpt as string).toContain('TRUNCATED BY TALON');
    expect(result.excerpt as string).toContain('toolCallId="call-1"');
    expect(result.excerpt as string).toContain("tool 'execute_command'");
    expect(result.excerpt as string).toContain('fetch_tool_output');
  });

  it('preserves MCP envelope and excerpts the concatenated text', () => {
    const big = 'line\n'.repeat(2000); // ~10K chars
    const mcp = {
      content: [
        { type: 'text', text: big },
        { type: 'image', data: '...' },
      ],
      isError: false,
    };

    const result = excerptToolOutput('call-2', 'mcp_tool', mcp, 400);

    expect(result.truncated).toBe(true);
    const excerpt = result.excerpt as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    expect(excerpt.isError).toBe(false);
    // Envelope is preserved.
    expect(Array.isArray(excerpt.content)).toBe(true);
    const textPart = excerpt.content.find((c) => c.type === 'text');
    expect(textPart).toBeDefined();
    expect(textPart!.text).toContain('TRUNCATED BY TALON');
  });

  it('truncates MCP results whose bulk is non-text (e.g. large image/resource parts)', () => {
    // Small text part, huge base64 image part — the text-only concat would
    // come in under the cap, but the stringified total is enormous. The
    // excerpter must still apply truncation so unbounded content never
    // enters history.
    const bigBase64 = 'A'.repeat(30_000);
    const mcp = {
      content: [
        { type: 'text', text: 'brief label' },
        { type: 'image', data: bigBase64, mimeType: 'image/png' },
      ],
      isError: false,
    };

    const result = excerptToolOutput('call-img', 'mcp_screenshot', mcp, 400);
    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBeGreaterThan(30_000);
    expect(result.excerptChars).toBeLessThan(600);
    // Excerpt is either a string (generic path) or an MCP envelope with
    // truncated text — either way it must NOT contain the full base64 blob.
    const rendered = typeof result.excerpt === 'string'
      ? result.excerpt
      : JSON.stringify(result.excerpt);
    expect(rendered.includes(bigBase64)).toBe(false);
    expect(rendered).toContain('TRUNCATED BY TALON');
  });

  it('never truncates a result flagged isError=true, even if huge', () => {
    const big = 'x'.repeat(50_000);
    const mcp = { content: [{ type: 'text', text: big }], isError: true };
    const result = excerptToolOutput('call-err', 'mcp_tool', mcp, 400);

    expect(result.truncated).toBe(false);
    expect(result.excerpt).toBe(mcp);
  });

  it('never truncates a short stderr-like error string', () => {
    const msg = 'Error: command not found: foobar';
    const result = excerptToolOutput('call-err2', 'execute_command', msg, 10);

    expect(result.truncated).toBe(false);
    expect(result.excerpt).toBe(msg);
  });

  it('stringifies non-MCP object results before truncation', () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `row-${i}` })) };
    const result = excerptToolOutput('call-3', 'db_query', big, 400);

    expect(result.truncated).toBe(true);
    expect(typeof result.excerpt).toBe('string');
    expect(result.excerpt as string).toContain('TRUNCATED BY TALON');
  });

  it('captures the full output in fullOutputString even when truncated', () => {
    const big = 'x'.repeat(20_000);
    const result = excerptToolOutput('call-4', 'read_file', big, 400);
    expect(result.fullOutputString).toHaveLength(20_000);
  });
});

describe('isLikelyError', () => {
  it('flags MCP results with isError=true', () => {
    expect(isLikelyError({ content: [{ type: 'text', text: 'x' }], isError: true })).toBe(true);
  });
  it('flags short strings containing "Error:"', () => {
    expect(isLikelyError('Error: bad thing')).toBe(true);
  });
  it('flags short strings containing "traceback"', () => {
    expect(isLikelyError('Traceback (most recent call last):\n  File "foo.py", line 1')).toBe(true);
  });
  it('does NOT flag long non-error output that happens to mention "error"', () => {
    const big = 'unrelated content '.repeat(200) + 'error: in a line somewhere';
    expect(isLikelyError(big)).toBe(false);
  });
  it('does NOT flag non-error short strings', () => {
    expect(isLikelyError('hello world')).toBe(false);
  });
});

describe('ToolOutputStore', () => {
  let store: ToolOutputStore;
  beforeEach(() => {
    store = new ToolOutputStore();
  });

  it('records and retrieves an entry by toolCallId', () => {
    store.record('call-1', {
      toolName: 'read_file',
      fullOutput: 'xyz',
      originalChars: 3,
      truncated: false,
      excerptChars: 3,
    });
    expect(store.get('call-1')?.fullOutput).toBe('xyz');
    expect(store.size()).toBe(1);
  });

  it('returns undefined for missing ids', () => {
    expect(store.get('nope')).toBeUndefined();
  });

  it('clear() empties the store', () => {
    store.record('call-1', {
      toolName: 't',
      fullOutput: 'x',
      originalChars: 1,
      truncated: false,
      excerptChars: 1,
    });
    store.clear();
    expect(store.size()).toBe(0);
  });
});

describe('fetchToolOutputSlice', () => {
  let store: ToolOutputStore;
  const fullOutput = Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n');
  beforeEach(() => {
    store = new ToolOutputStore();
    store.record('call-1', {
      toolName: 'read_file',
      fullOutput,
      originalChars: fullOutput.length,
      truncated: true,
      excerptChars: 50,
    });
  });

  it('returns a ranged slice with a range-prefix line', () => {
    const result = fetchToolOutputSlice(store, 'call-1', 0, 20);
    expect(result).toContain("[range 0-20 of");
    expect(result).toContain("'read_file'");
    expect(result).toContain('line-0');
  });

  it('caps each slice at the configured size (default 8000)', () => {
    const big = 'x'.repeat(50_000);
    store.record('call-big', {
      toolName: 'read_file',
      fullOutput: big,
      originalChars: big.length,
      truncated: true,
      excerptChars: 4000,
    });
    const result = fetchToolOutputSlice(store, 'call-big', 0, 99_999);
    // Slice is capped to DEFAULT_FETCH_SLICE_CAP + header/hint overhead.
    expect(result.length).toBeLessThan(DEFAULT_FETCH_SLICE_CAP + 500);
    expect(result).toContain('slice capped');
    expect(result).toContain(`startChar=${DEFAULT_FETCH_SLICE_CAP}`);
  });

  it('returns an error string when the toolCallId is unknown', () => {
    const result = fetchToolOutputSlice(store, 'no-such-id', 0, 100);
    expect(result).toContain('Error');
    expect(result).toContain('no-such-id');
  });

  it('returns an error string when the range is empty or inverted', () => {
    const result = fetchToolOutputSlice(store, 'call-1', 10, 5);
    expect(result).toContain('Error');
  });

  it('default startChar/endChar returns the first sliceCap chars', () => {
    const result = fetchToolOutputSlice(store, 'call-1', undefined, undefined);
    expect(result).toContain('line-0');
  });
});

describe('cap defaults', () => {
  it('exports the documented defaults', () => {
    expect(DEFAULT_TOOL_OUTPUT_CAP).toBe(4000);
    expect(DEFAULT_FETCH_SLICE_CAP).toBe(8000);
  });
});
