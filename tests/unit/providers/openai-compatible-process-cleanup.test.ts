import { describe, it, expect } from 'vitest';

import {
  collectDescendantPids,
  killDescendantTree,
  MCP_CHILD_MARKER_ENV,
  snapshotDescendantPids,
  terminateProcesses,
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
    const table: ProcessInfo[] = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 100, ppid: 200 },
    ];
    const descendants = collectDescendantPids(100, table);
    expect(descendants).toEqual([200]);
  });
});

describe('snapshotDescendantPids', () => {
  it('captures the descendant tree from the live process table', () => {
    const table: ProcessInfo[] = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 },
    ];
    expect(snapshotDescendantPids(100, () => table).sort((a, b) => a - b)).toEqual([
      200, 300,
    ]);
  });
});

describe('terminateProcesses', () => {
  it('SIGTERMs every alive pid then SIGKILLs survivors after the grace period', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = await terminateProcesses([200, 300], {
      sleep: async () => {},
      isAlive: () => true,
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
      { pid: 200, signal: 'SIGKILL' },
      { pid: 300, signal: 'SIGKILL' },
    ]);
  });

  it('does not SIGKILL processes that died during the grace period', async () => {
    const aliveCalls: number[] = [];
    let phase: 'before' | 'after' = 'before';
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    await terminateProcesses([200], {
      sleep: async () => {
        phase = 'after';
      },
      isAlive: (pid) => {
        aliveCalls.push(pid);
        return phase === 'before';
      },
      signal: (pid, sig) => {
        signals.push({ pid, signal: sig });
        return true;
      },
      gracePeriodMs: 0,
    });

    expect(signals).toEqual([{ pid: 200, signal: 'SIGTERM' }]);
  });

  it('skips pids that are already dead at the start (no useless SIGTERM)', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = await terminateProcesses([200, 300], {
      sleep: async () => {},
      isAlive: (pid) => pid === 300, // 200 was already cleaned up by upstream disconnect
      signal: (pid, sig) => {
        signals.push({ pid, signal: sig });
        return true;
      },
      gracePeriodMs: 0,
    });

    expect(result).toEqual([300]);
    expect(signals).toEqual([
      { pid: 300, signal: 'SIGTERM' },
      { pid: 300, signal: 'SIGKILL' },
    ]);
  });

  it('is a no-op when called with an empty pid list', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = await terminateProcesses([], {
      sleep: async () => {},
      isAlive: () => true,
      signal: (pid, sig) => {
        signals.push({ pid, signal: sig });
        return true;
      },
    });
    expect(result).toEqual([]);
    expect(signals).toEqual([]);
  });

  it('invokes onSurvivor for each pid escalated to SIGKILL', async () => {
    const survivors: number[] = [];
    await terminateProcesses([200, 300], {
      sleep: async () => {},
      isAlive: () => true,
      signal: () => true,
      onSurvivor: (pid) => survivors.push(pid),
      gracePeriodMs: 0,
    });
    expect(survivors.sort((a, b) => a - b)).toEqual([200, 300]);
  });
});

describe('snapshot-then-terminate race', () => {
  it('still kills grandchildren that get reparented to PID 1 during the upstream disconnect', async () => {
    // BEFORE disconnect: full wrapper → npx → sh → node chain.
    const beforeDisconnect: ProcessInfo[] = [
      { pid: 100, ppid: 1 }, // wrapper (self)
      { pid: 200, ppid: 100 }, // npx
      { pid: 300, ppid: 200 }, // sh
      { pid: 400, ppid: 300 }, // node mcp-remote (the leaker)
    ];
    // AFTER disconnect: Mastra killed 200, then 300/400 reparent to PID 1.
    // A "find descendants of 100" walk done at this point would return [].
    // The whole point of snapshot-first is to have already captured them.
    const afterDisconnect: ProcessInfo[] = [
      { pid: 100, ppid: 1 },
      { pid: 300, ppid: 1 },
      { pid: 400, ppid: 1 },
    ];

    // Step 1: snapshot BEFORE disconnect.
    const snapshot = snapshotDescendantPids(100, () => beforeDisconnect).sort(
      (a, b) => a - b,
    );
    expect(snapshot).toEqual([200, 300, 400]);

    // Sanity check: a snapshot taken AFTER disconnect would miss the orphans
    // entirely. This is precisely what the P1 review flagged in the
    // pre-refactor wrapper code path.
    const stalePostDisconnectSnapshot = snapshotDescendantPids(
      100,
      () => afterDisconnect,
    );
    expect(stalePostDisconnectSnapshot).toEqual([]);

    // Step 2: terminate the snapshotted PIDs. 200 is gone (Mastra got it),
    // 300 dies on SIGTERM, 400 hangs onto its port and needs SIGKILL.
    const sigkilledSurvivors: number[] = [];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let phase: 'before' | 'after' = 'before';

    await terminateProcesses(snapshot, {
      sleep: async () => {
        phase = 'after';
      },
      isAlive: (pid) => {
        if (pid === 200) return false; // killed by upstream
        if (pid === 300) return phase === 'before'; // SIGTERM works
        if (pid === 400) return true; // survives SIGTERM, needs SIGKILL
        return false;
      },
      signal: (pid, sig) => {
        signals.push({ pid, signal: sig });
        return true;
      },
      onSurvivor: (pid) => sigkilledSurvivors.push(pid),
      gracePeriodMs: 0,
    });

    expect(signals).toEqual([
      { pid: 300, signal: 'SIGTERM' },
      { pid: 400, signal: 'SIGTERM' },
      { pid: 400, signal: 'SIGKILL' },
    ]);
    expect(sigkilledSurvivors).toEqual([400]);
  });
});

describe('killDescendantTree (convenience wrapper)', () => {
  it('snapshots then terminates in one call', async () => {
    const table: ProcessInfo[] = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 },
    ];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = await killDescendantTree(100, {
      readProcesses: () => table,
      sleep: async () => {},
      isAlive: () => true,
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
      { pid: 200, signal: 'SIGKILL' },
      { pid: 300, signal: 'SIGKILL' },
    ]);
  });

  it('is a no-op when no descendants exist', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = await killDescendantTree(100, {
      readProcesses: () => [{ pid: 100, ppid: 1 }],
      sleep: async () => {},
      isAlive: () => true,
      signal: (pid, sig) => {
        signals.push({ pid, signal: sig });
        return true;
      },
    });
    expect(result).toEqual([]);
    expect(signals).toEqual([]);
  });
});

describe('MCP_CHILD_MARKER_ENV', () => {
  it('is the documented env var name', () => {
    expect(MCP_CHILD_MARKER_ENV).toBe('TALON_MCP_CHILD');
  });
});
