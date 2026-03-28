import { describe, it, expect, vi } from 'vitest';
import { listCapabilities, formatCapabilities } from '../../../src/cli/commands/list-capabilities.js';

describe('formatCapabilities()', () => {
  it('includes all tool groups', () => {
    const output = formatCapabilities();

    expect(output).toContain('memory.access');
    expect(output).toContain('net.http');
    expect(output).toContain('channel.send');
    expect(output).toContain('schedule.manage');
    expect(output).toContain('db.query');
    expect(output).toContain('subagent.invoke');
    expect(output).toContain('subagent.background');
  });

  it('includes capability labels with descriptions', () => {
    const output = formatCapabilities();

    expect(output).toContain('memory.access:thread');
    expect(output).toContain('Read and write per-thread memory items');
    expect(output).toContain('net.http:egress');
  });

  it('includes usage instructions', () => {
    const output = formatCapabilities();

    expect(output).toContain('capabilities.allow');
  });
});

describe('listCapabilities()', () => {
  it('prints to console', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    listCapabilities();

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('memory.access:thread');

    consoleSpy.mockRestore();
  });
});
