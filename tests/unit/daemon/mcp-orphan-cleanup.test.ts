import { describe, it, expect, vi } from 'vitest';
import { cleanupOrphanedMcpChildren } from '../../../src/daemon/mcp-orphan-cleanup.js';

const stubLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
} as unknown as Parameters<typeof cleanupOrphanedMcpChildren>[0];

describe('cleanupOrphanedMcpChildren', () => {
  it('is a no-op on non-Linux platforms', () => {
    if (process.platform === 'linux') {
      // Skip on Linux — the early-return guard is not exercised.
      return;
    }
    const findCandidates = vi.fn(() => [123]);
    const kill = vi.fn(() => true);
    const result = cleanupOrphanedMcpChildren(stubLogger, { findCandidates, kill });
    expect(result).toEqual({ scanned: 0, candidates: [], killed: [] });
    expect(findCandidates).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('SIGKILLs every candidate returned by the scanner', () => {
    if (process.platform !== 'linux') return;
    const kill = vi.fn(() => true);
    const result = cleanupOrphanedMcpChildren(stubLogger, {
      findCandidates: () => [101, 202, 303],
      kill,
    });
    expect(result.scanned).toBe(3);
    expect(result.candidates).toEqual([101, 202, 303]);
    expect(result.killed).toEqual([101, 202, 303]);
    expect(kill.mock.calls).toEqual([
      [101, 'SIGKILL'],
      [202, 'SIGKILL'],
      [303, 'SIGKILL'],
    ]);
  });

  it('reports zero kills when no orphans match', () => {
    if (process.platform !== 'linux') return;
    const kill = vi.fn(() => true);
    const result = cleanupOrphanedMcpChildren(stubLogger, {
      findCandidates: () => [],
      kill,
    });
    expect(result).toEqual({ scanned: 0, candidates: [], killed: [] });
    expect(kill).not.toHaveBeenCalled();
  });

  it('skips PIDs whose kill call fails (process already gone)', () => {
    if (process.platform !== 'linux') return;
    const result = cleanupOrphanedMcpChildren(stubLogger, {
      findCandidates: () => [10, 20],
      kill: (pid) => pid === 10, // only 10 succeeds
    });
    expect(result.killed).toEqual([10]);
    expect(result.candidates).toEqual([10, 20]);
  });

  it('survives a scanner that throws and returns an empty result', () => {
    if (process.platform !== 'linux') return;
    const result = cleanupOrphanedMcpChildren(stubLogger, {
      findCandidates: () => {
        throw new Error('boom');
      },
    });
    expect(result).toEqual({ scanned: 0, candidates: [], killed: [] });
  });
});
