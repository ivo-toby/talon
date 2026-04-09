import { describe, it, expect, vi, beforeEach } from 'vitest';
import type pino from 'pino';

// Mock availability detection and runner constructors
vi.mock('@talon/skills/script-runner/availability.js', () => ({
  detectRunnerBackend: vi.fn(),
}));

vi.mock('@talon/skills/script-runner/bubblewrap-runner.js', () => ({
  BubblewrapRunner: vi.fn().mockImplementation(function (
    this: { backend: string },
  ) {
    this.backend = 'bubblewrap';
  }),
}));

vi.mock('@talon/skills/script-runner/apple-container-runner.js', () => ({
  AppleContainerRunner: vi.fn().mockImplementation(function (
    this: { backend: string },
  ) {
    this.backend = 'apple-container';
  }),
}));

import { detectRunnerBackend } from '@talon/skills/script-runner/availability.js';
import { BubblewrapRunner } from '@talon/skills/script-runner/bubblewrap-runner.js';
import { AppleContainerRunner } from '@talon/skills/script-runner/apple-container-runner.js';
import {
  createSkillScriptRunner,
  _resetCachedRunner,
} from '@talon/skills/script-runner/index.js';

function makeMockLogger(): pino.Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as unknown as pino.Logger;
}

describe('createSkillScriptRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCachedRunner();
  });

  it('returns a BubblewrapRunner when bubblewrap backend is detected', async () => {
    vi.mocked(detectRunnerBackend).mockResolvedValue({
      backend: 'bubblewrap',
      version: '0.10',
    });

    const runner = await createSkillScriptRunner({
      logger: makeMockLogger(),
      dataDir: '/tmp/talon-data',
    });

    expect(runner).not.toBeNull();
    expect(runner!.backend).toBe('bubblewrap');
    expect(BubblewrapRunner).toHaveBeenCalledOnce();
  });

  it('returns an AppleContainerRunner when apple-container backend is detected', async () => {
    vi.mocked(detectRunnerBackend).mockResolvedValue({
      backend: 'apple-container',
      version: '1.0',
    });

    const runner = await createSkillScriptRunner({
      logger: makeMockLogger(),
      dataDir: '/tmp/talon-data',
    });

    expect(runner).not.toBeNull();
    expect(runner!.backend).toBe('apple-container');
    expect(AppleContainerRunner).toHaveBeenCalledOnce();
  });

  it('returns null when no backend is detected', async () => {
    vi.mocked(detectRunnerBackend).mockResolvedValue(null);

    const runner = await createSkillScriptRunner({
      logger: makeMockLogger(),
      dataDir: '/tmp/talon-data',
    });

    expect(runner).toBeNull();
  });

  it('caches the runner — second call reuses the instance without re-detecting', async () => {
    vi.mocked(detectRunnerBackend).mockResolvedValue({
      backend: 'bubblewrap',
      version: '0.10',
    });

    const logger = makeMockLogger();
    const deps = { logger, dataDir: '/tmp/talon-data' };

    const first = await createSkillScriptRunner(deps);
    const second = await createSkillScriptRunner(deps);

    expect(first).toBe(second);
    expect(detectRunnerBackend).toHaveBeenCalledOnce();
  });

  it('caches null result — detection is not retried', async () => {
    vi.mocked(detectRunnerBackend).mockResolvedValue(null);

    const deps = { logger: makeMockLogger(), dataDir: '/tmp/talon-data' };

    const first = await createSkillScriptRunner(deps);
    const second = await createSkillScriptRunner(deps);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(detectRunnerBackend).toHaveBeenCalledOnce();
  });
});
