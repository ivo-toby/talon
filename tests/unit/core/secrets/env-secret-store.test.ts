import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { EnvSecretStore, parseDotenv } from '@talon/core/secrets/env-secret-store.js';
import type { SecretResolveContext } from '@talon/core/secrets/index.js';
import { SecretError } from '@talon/core/secrets/index.js';

vi.mock('node:fs');

function createMockLogger(): ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>> {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
  return logger as unknown as ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>;
}

const DATA_DIR = '/tmp/talon-test-data';
const CTX: SecretResolveContext = {};
const FAKE_FD = 42;

describe('parseDotenv', () => {
  it('parses KEY=VALUE pairs', () => {
    const result = parseDotenv('FOO=bar\nBAZ=qux');
    expect(result.get('FOO')).toBe('bar');
    expect(result.get('BAZ')).toBe('qux');
  });

  it('skips comments and empty lines', () => {
    const result = parseDotenv('# comment\n\nFOO=bar\n  \n# another comment');
    expect(result.size).toBe(1);
    expect(result.get('FOO')).toBe('bar');
  });

  it('strips double quotes', () => {
    const result = parseDotenv('FOO="hello world"');
    expect(result.get('FOO')).toBe('hello world');
  });

  it('strips single quotes', () => {
    const result = parseDotenv("FOO='hello world'");
    expect(result.get('FOO')).toBe('hello world');
  });

  it('handles values with equals signs', () => {
    const result = parseDotenv('URL=https://example.com?a=1&b=2');
    expect(result.get('URL')).toBe('https://example.com?a=1&b=2');
  });

  it('skips lines without equals sign', () => {
    const result = parseDotenv('INVALID_LINE\nFOO=bar');
    expect(result.size).toBe(1);
  });

  it('handles export prefix', () => {
    const result = parseDotenv('export MY_KEY=my_value');
    expect(result.get('MY_KEY')).toBe('my_value');
  });

  it('strips inline comments for unquoted values', () => {
    const result = parseDotenv('KEY=value # this is a comment');
    expect(result.get('KEY')).toBe('value');
  });

  it('preserves hash in quoted values', () => {
    const result = parseDotenv('KEY="value # not a comment"');
    expect(result.get('KEY')).toBe('value # not a comment');
  });
});

describe('EnvSecretStore', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function setupSecretsFile(content: string, mode = 0o600): void {
    vi.mocked(fs.openSync).mockReturnValue(FAKE_FD);
    vi.mocked(fs.fstatSync).mockReturnValue({
      mode: 0o100000 | mode,
      isFile: () => true,
    } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(content);
    vi.mocked(fs.closeSync).mockReturnValue(undefined);
  }

  function setupNoFile(): void {
    const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
    enoent.code = 'ENOENT';
    vi.mocked(fs.openSync).mockImplementation(() => {
      throw enoent;
    });
  }

  it('resolves a secret from process.env', () => {
    setupNoFile();
    process.env.MY_SECRET = 'env-value';
    const logger = createMockLogger();
    const store = new EnvSecretStore({ dataDir: DATA_DIR, logger: logger as never });

    const result = store.resolve(['MY_SECRET'], CTX);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ MY_SECRET: 'env-value' });
  });

  it('resolves a secret from secrets.env file', () => {
    setupSecretsFile('FILE_SECRET=file-value');
    delete process.env.FILE_SECRET;
    const logger = createMockLogger();
    const store = new EnvSecretStore({ dataDir: DATA_DIR, logger: logger as never });

    const result = store.resolve(['FILE_SECRET'], CTX);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ FILE_SECRET: 'file-value' });
  });

  it('process.env takes precedence over file', () => {
    setupSecretsFile('SHARED=from-file');
    process.env.SHARED = 'from-env';
    const logger = createMockLogger();
    const store = new EnvSecretStore({ dataDir: DATA_DIR, logger: logger as never });

    const result = store.resolve(['SHARED'], CTX);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ SHARED: 'from-env' });
  });

  it('returns Err with correct missing names when secret not found', () => {
    setupNoFile();
    delete process.env.NONEXISTENT;
    const logger = createMockLogger();
    const store = new EnvSecretStore({ dataDir: DATA_DIR, logger: logger as never });

    const result = store.resolve(['NONEXISTENT'], CTX);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(SecretError);
    expect(error.missing).toEqual(['NONEXISTENT']);
  });

  it('returns Err with ALL missing names when multiple are missing', () => {
    setupNoFile();
    delete process.env.MISSING_A;
    delete process.env.MISSING_B;
    process.env.PRESENT = 'yes';
    const logger = createMockLogger();
    const store = new EnvSecretStore({ dataDir: DATA_DIR, logger: logger as never });

    const result = store.resolve(['MISSING_A', 'PRESENT', 'MISSING_B'], CTX);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.missing).toEqual(['MISSING_A', 'MISSING_B']);
  });

  it('returns Ok with empty record for empty names list', () => {
    setupNoFile();
    const logger = createMockLogger();
    const store = new EnvSecretStore({ dataDir: DATA_DIR, logger: logger as never });

    const result = store.resolve([], CTX);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({});
  });

  it('warns and ignores secrets.env with permissions 0644', () => {
    setupSecretsFile('SECRET=value', 0o644);
    delete process.env.SECRET;
    const logger = createMockLogger();
    const store = new EnvSecretStore({ dataDir: DATA_DIR, logger: logger as never });

    // File should be ignored, so SECRET is missing
    const result = store.resolve(['SECRET'], CTX);
    expect(result.isErr()).toBe(true);

    // Warning should have been logged with path
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining('secrets.env') }),
      expect.stringContaining('permissions looser than 0600'),
    );

    // readFileSync should NOT have been called (fstat check failed first)
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('handles secrets.env not present without error', () => {
    setupNoFile();
    process.env.FALLBACK = 'env-val';
    const logger = createMockLogger();
    const store = new EnvSecretStore({ dataDir: DATA_DIR, logger: logger as never });

    const result = store.resolve(['FALLBACK'], CTX);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ FALLBACK: 'env-val' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('parses file only once at construction', () => {
    setupSecretsFile('ONCE_SECRET=value');
    delete process.env.ONCE_SECRET;
    const logger = createMockLogger();
    const store = new EnvSecretStore({ dataDir: DATA_DIR, logger: logger as never });

    // Resolve multiple times
    store.resolve(['ONCE_SECRET'], CTX);
    store.resolve(['ONCE_SECRET'], CTX);
    store.resolve(['ONCE_SECRET'], CTX);

    // readFileSync called exactly once (at construction)
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('skips comments and empty lines in secrets.env', () => {
    setupSecretsFile('# comment\n\nVALID=yes\n  \n# another');
    delete process.env.VALID;
    const logger = createMockLogger();
    const store = new EnvSecretStore({ dataDir: DATA_DIR, logger: logger as never });

    const result = store.resolve(['VALID'], CTX);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ VALID: 'yes' });
  });

  it('strips quotes from values in secrets.env', () => {
    setupSecretsFile('DOUBLE="double-quoted"\nSINGLE=\'single-quoted\'');
    delete process.env.DOUBLE;
    delete process.env.SINGLE;
    const logger = createMockLogger();
    const store = new EnvSecretStore({ dataDir: DATA_DIR, logger: logger as never });

    const result = store.resolve(['DOUBLE', 'SINGLE'], CTX);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      DOUBLE: 'double-quoted',
      SINGLE: 'single-quoted',
    });
  });

  it('closes the file descriptor after reading', () => {
    setupSecretsFile('KEY=value');
    const logger = createMockLogger();
    new EnvSecretStore({ dataDir: DATA_DIR, logger: logger as never });

    expect(fs.closeSync).toHaveBeenCalledWith(FAKE_FD);
  });

  it('closes the file descriptor even when permissions fail', () => {
    setupSecretsFile('KEY=value', 0o644);
    const logger = createMockLogger();
    new EnvSecretStore({ dataDir: DATA_DIR, logger: logger as never });

    expect(fs.closeSync).toHaveBeenCalledWith(FAKE_FD);
  });
});
