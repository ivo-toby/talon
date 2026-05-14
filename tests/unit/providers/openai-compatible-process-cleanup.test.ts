import { describe, it, expect } from 'vitest';

import {
  collectDescendantPids,
  killDescendantTree,
  MCP_CHILD_MARKER_ENV,
  type ProcessInfo,
} from '../../../src/providers/openai-compatible/agent-cli/process-cleanup.js';

describe('collectDescendantPids', () => {
  it('returns an empty list when the root has no children', () => {
    const table: ProcessInfo[] = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 1 },
    ];
    expect(collectDescendantPids(100, table)).toEqual([]);
  });

  it('walks the full chain (wrapper → npx → sh → node)', () => {
    const table: ProcessInfo[] = [
      { pid: 100, ppid: 1 }, // wrapper
      { pid: 200, ppid: 100 }, // npx
      { pid: 300, ppid: 200 }, // sh
      { pid: 400, ppid: 300 }, // node mcp-remote
      { pid: 999, ppid: 1 }, // unrelated
    ];
    const descendants = collectDescendantPids(100, table);
    expect(descendants).toEqual(expect.arrayContaining([200, 300, 400]));
    expect(descendants).not.toContain(100);
    expect(descendants).not.toContain(999);
    expect(descendants).toHaveLength(3);
  });

  it('handles multiple branches under the root', () => {
    const table: ProcessInfo[] = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 201, ppid: 100 },
      { pid: 300, ppid: 200 },
      { pid: 301, ppid: 201 },
    ];
    const descendants = collectDescendantPids(100, table).sort((a, b) => a - b);
    expect(descendants).toEqual([200, 201, 300, 301]);
  });

  it('ignores cycles defensively (does not loop forever)', () => {
    // Pathological table — ppid points back at the descendant.
    const table: ProcessInfo[] = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 100, ppid: 200 },
    ];
    const descendants = collectDescendantPids(100, table);
    expect(descendants).toEqual([200]);
  });
});

describe('killDescendantTree', () => {
  it('signals every descendant with SIGTERM and escalates to SIGKILL on survivors', async () => {
    const table: ProcessInfo[] = [
      { pid: 100, ppid: 1 }, // wrapper (self)
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 }, // this one "survives" SIGTERM
    ];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const result = await killDescendantTree(100, {
      readProcesses: () => table,
      sleep: async () => {},
      isAlive: (pid) => pid === 300, // 200 dies on SIGTERM, 300 survives
      signal: (pid, sig) => {
        signals.push({ pid, signal: sig });
        return true;
      },
      gracePeriodMs: 0,
    });

    expect(result.sort((a, b) => a - b)).toEqual([200, 300]);
    expect(signals).toEqual([
      { pid: 200, signal: 'SIGTERM' },
      { pid: 300, signal: 'SIGTERM' },
      { pid: 300, signal: 'SIGKILL' },
    ]);
  });

  it('is a no-op when no descendants exist', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = await killDescendantTree(100, {
      readProcesses: () => [{ pid: 100, ppid: 1 }],
      sleep: async () => {},
      isAlive: () => false,
      signal: (pid, sig) => {
        signals.push({ pid, signal: sig });
        return true;
      },
    });
    expect(result).toEqual([]);
    expect(signals).toEqual([]);
  });

  it('does not SIGKILL processes that exited during the grace period', async () => {
    const table: ProcessInfo[] = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
    ];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    await killDescendantTree(100, {
      readProcesses: () => table,
      sleep: async () => {},
      isAlive: () => false,
      signal: (pid, sig) => {
        signals.push({ pid, signal: sig });
        return true;
      },
    });
    expect(signals).toEqual([{ pid: 200, signal: 'SIGTERM' }]);
  });

  it('invokes onSurvivor for each pid escalated to SIGKILL', async () => {
    const table: ProcessInfo[] = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 100 },
    ];
    const survivors: number[] = [];
    await killDescendantTree(100, {
      readProcesses: () => table,
      sleep: async () => {},
      isAlive: () => true,
      signal: () => true,
      onSurvivor: (pid) => survivors.push(pid),
    });
    expect(survivors.sort((a, b) => a - b)).toEqual([200, 300]);
  });
});

describe('MCP_CHILD_MARKER_ENV', () => {
  it('is the documented env var name', () => {
    expect(MCP_CHILD_MARKER_ENV).toBe('TALON_MCP_CHILD');
  });
});
