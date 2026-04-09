import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type pino from 'pino';

// Mock child_process before importing the module under test
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { detectRunnerBackend } from '@talon/skills/script-runner/availability.js';

function makeMockLogger(): pino.Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as unknown as pino.Logger;
}

/**
 * Helper: make the mocked execFile call the callback with the given result.
 */
function mockExecFileSuccess(stdout: string, stderr = ''): void {
  (execFile as unknown as Mock).mockImplementation(
    (
      _bin: string,
      _args: string[],
      _opts: unknown,
      cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      // promisify expects the last argument to be a callback
      if (typeof cb === 'function') {
        cb(null, { stdout, stderr });
      }
    },
  );
}

function mockExecFileError(code: string, message = 'spawn error'): void {
  (execFile as unknown as Mock).mockImplementation(
    (
      _bin: string,
      _args: string[],
      _opts: unknown,
      cb?: (err: NodeJS.ErrnoException) => void,
    ) => {
      if (typeof cb === 'function') {
        const err = new Error(message) as NodeJS.ErrnoException;
        err.code = code;
        cb(err);
      }
    },
  );
}

function mockExecFileNonZero(exitCode: number, stderr = 'error output'): void {
  (execFile as unknown as Mock).mockImplementation(
    (
      _bin: string,
      _args: string[],
      _opts: unknown,
      cb?: (err: NodeJS.ErrnoException) => void,
    ) => {
      if (typeof cb === 'function') {
        const err = new Error(
          `Command failed with exit code ${exitCode}`,
        ) as NodeJS.ErrnoException & { stderr: string };
        err.code = String(exitCode);
        err.stderr = stderr;
        cb(err);
      }
    },
  );
}

describe('detectRunnerBackend', () => {
  let logger: pino.Logger;

  beforeEach(() => {
    vi.restoreAllMocks();
    logger = makeMockLogger();
  });

  it('returns bubblewrap backend on Linux when bwrap is available', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    mockExecFileSuccess('bubblewrap 0.8.0\n');

    const result = await detectRunnerBackend(logger);

    expect(result).toEqual({
      backend: 'bubblewrap',
      version: 'bubblewrap 0.8.0',
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'bubblewrap' }),
      expect.stringContaining('detected bubblewrap'),
    );
  });

  it('returns null on Linux when bwrap is not found (ENOENT)', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    mockExecFileError('ENOENT');

    const result = await detectRunnerBackend(logger);

    expect(result).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ binary: 'bwrap', errorCode: 'ENOENT' }),
      expect.stringContaining('bwrap not found'),
    );
  });

  it('returns apple-container backend on Darwin when container is available', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    mockExecFileSuccess('', 'Usage: container [options]\nApple Container Runtime v1.0');

    const result = await detectRunnerBackend(logger);

    expect(result).toEqual({
      backend: 'apple-container',
      version: 'Usage: container [options]',
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'apple-container' }),
      expect.stringContaining('detected apple-container'),
    );
  });

  it('returns null on Darwin when container is not found', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    mockExecFileError('ENOENT');

    const result = await detectRunnerBackend(logger);

    expect(result).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ binary: 'container', errorCode: 'ENOENT' }),
      expect.stringContaining('container not found'),
    );
  });

  it('returns null immediately on unsupported platform (win32)', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const result = await detectRunnerBackend(logger);

    expect(result).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'win32' }),
      expect.stringContaining('no supported platform'),
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns null and logs warning when bwrap exits non-zero', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    mockExecFileNonZero(1, 'bwrap: unknown option');

    const result = await detectRunnerBackend(logger);

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ binary: 'bwrap' }),
      expect.stringContaining('probe failed'),
    );
  });

  it('returns null when permission denied (EACCES)', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    mockExecFileError('EACCES', 'permission denied');

    const result = await detectRunnerBackend(logger);

    expect(result).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ binary: 'bwrap', errorCode: 'EACCES' }),
      expect.stringContaining('bwrap not found'),
    );
  });
});
