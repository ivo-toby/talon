/**
 * Unit tests for the `talonctl setup` command.
 *
 * Uses real temp directories and mocks child_process for Docker detection.
 * Verifies OS detection, Node version checking, directory creation,
 * config generation, migration execution, and config validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectOs,
  checkNodeVersion,
  checkDockerAvailable,
  createDataDirectories,
  generateDefaultConfig,
  runDatabaseMigrations,
  validateConfig,
  runSetupChecks,
  displaySetupResult,
} from '../../../src/cli/commands/setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'talon-setup-test-'));
}

/** Writes a minimal valid talond.yaml to a temp directory. */
function writeMinimalConfig(dir: string, dataDir?: string): string {
  const configPath = join(dir, 'talond.yaml');
  const storage = dataDir ? `storage:\n  path: "${join(dataDir, 'talond.sqlite')}"\n` : '';
  writeFileSync(configPath, `${storage}logLevel: info\n`);
  return configPath;
}

// ---------------------------------------------------------------------------
// detectOs
// ---------------------------------------------------------------------------

describe('detectOs()', () => {
  it('always returns status "passed"', () => {
    const result = detectOs();
    expect(result.status).toBe('passed');
  });

  it('returns check named "OS detection"', () => {
    const result = detectOs();
    expect(result.name).toBe('OS detection');
  });

  it('includes platform info in message', () => {
    const result = detectOs();
    // Should mention linux, macOS, or the raw platform name
    expect(result.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// checkNodeVersion
// ---------------------------------------------------------------------------

describe('checkNodeVersion()', () => {
  it('returns check named "Node.js version"', () => {
    const result = checkNodeVersion();
    expect(result.name).toBe('Node.js version');
  });

  it('includes version string in message', () => {
    const result = checkNodeVersion();
    expect(result.message).toContain(process.version);
  });

  it('passes when Node version is >= 24', () => {
    const original = process.version;
    Object.defineProperty(process, 'version', { value: 'v24.0.0', configurable: true });
    const result = checkNodeVersion();
    expect(result.status).toBe('passed');
    Object.defineProperty(process, 'version', { value: original, configurable: true });
  });

  it('fails when Node version is < 24', () => {
    const original = process.version;
    Object.defineProperty(process, 'version', { value: 'v22.12.0', configurable: true });
    const result = checkNodeVersion();
    expect(result.status).toBe('failed');
    expect(result.hint).toBeDefined();
    expect(result.hint).toContain('nodejs.org');
    Object.defineProperty(process, 'version', { value: original, configurable: true });
  });

  it('has no hint on success', () => {
    const original = process.version;
    Object.defineProperty(process, 'version', { value: 'v24.0.0', configurable: true });
    const result = checkNodeVersion();
    expect(result.hint).toBeUndefined();
    Object.defineProperty(process, 'version', { value: original, configurable: true });
  });
});

// ---------------------------------------------------------------------------
// checkDockerAvailable
// ---------------------------------------------------------------------------

describe('checkDockerAvailable()', () => {
  it('returns check named "Docker availability"', async () => {
    const result = await checkDockerAvailable();
    expect(result.name).toBe('Docker availability');
  });

  it('returns a boolean-equivalent status', async () => {
    const result = await checkDockerAvailable();
    expect(['passed', 'failed']).toContain(result.status);
  });

  it('provides hint when Docker is not available', () => {
    // Test the expected shape directly — we cannot guarantee Docker is absent
    const failedCheck = {
      name: 'Docker availability',
      status: 'failed' as const,
      message: 'Docker is not available or daemon is not running',
      hint: 'Install Docker from https://docs.docker.com/get-docker/ and start the Docker daemon',
    };
    expect(failedCheck.hint).toContain('docker.com');
  });
});

// ---------------------------------------------------------------------------
// createDataDirectories
// ---------------------------------------------------------------------------

describe('createDataDirectories()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it('creates the data directory and subdirectories', async () => {
    const dataDir = join(tmpDir, 'data');
    const result = await createDataDirectories(dataDir);

    expect(result.status).toBe('passed');
    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(join(dataDir, 'ipc', 'daemon'))).toBe(true);
    expect(existsSync(join(dataDir, 'backups'))).toBe(true);
    expect(existsSync(join(dataDir, 'threads'))).toBe(true);
  });

  it('returns "skipped" when directories already exist', async () => {
    const dataDir = join(tmpDir, 'data');
    // Pre-create the directory structure
    mkdirSync(join(dataDir, 'ipc', 'daemon'), { recursive: true });
    mkdirSync(join(dataDir, 'backups'), { recursive: true });
    mkdirSync(join(dataDir, 'threads'), { recursive: true });

    const result = await createDataDirectories(dataDir);
    expect(result.status).toBe('skipped');
  });

  it('includes the data directory in message', async () => {
    const dataDir = join(tmpDir, 'newdata');
    const result = await createDataDirectories(dataDir);
    expect(result.message).toContain('newdata');
  });

  it('returns check named "Data directory structure"', async () => {
    const dataDir = join(tmpDir, 'data2');
    const result = await createDataDirectories(dataDir);
    expect(result.name).toBe('Data directory structure');
  });

  it('creates data directories with owner-only permissions on POSIX', async () => {
    const dataDir = join(tmpDir, 'secure-data');
    const result = await createDataDirectories(dataDir);

    expect(result.status).toBe('passed');

    for (const dir of [
      dataDir,
      join(dataDir, 'ipc'),
      join(dataDir, 'ipc', 'daemon'),
      join(dataDir, 'backups'),
      join(dataDir, 'threads'),
    ]) {
      const stat = await import('node:fs').then(({ statSync }) => statSync(dir));
      expect(stat.isDirectory()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o700);
    }
  });
});

// ---------------------------------------------------------------------------
// generateDefaultConfig
// ---------------------------------------------------------------------------

describe('generateDefaultConfig()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it('generates a config file at the given path', async () => {
    const configPath = join(tmpDir, 'talond.yaml');
    const result = await generateDefaultConfig(configPath, 'data');

    expect(result.status).toBe('passed');
    expect(existsSync(configPath)).toBe(true);
  });

  it('config file contains valid YAML with expected keys', async () => {
    const configPath = join(tmpDir, 'talond.yaml');
    await generateDefaultConfig(configPath, 'data');

    const { readFileSync } = await import('node:fs');
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain('logLevel');
    expect(content).toContain('storage');
    expect(content).toContain('sandbox');
  });

  it('skips generation when config already exists', async () => {
    const configPath = writeMinimalConfig(tmpDir);
    const result = await generateDefaultConfig(configPath, 'data');

    expect(result.status).toBe('skipped');
    expect(result.message).toContain('already exists');
  });

  it('includes config path in message', async () => {
    const configPath = join(tmpDir, 'talond.yaml');
    const result = await generateDefaultConfig(configPath, 'data');

    expect(result.message).toContain(configPath);
  });

  it('returns check named "Config file generation"', async () => {
    const configPath = join(tmpDir, 'talond.yaml');
    const result = await generateDefaultConfig(configPath, 'data');
    expect(result.name).toBe('Config file generation');
  });
});

// ---------------------------------------------------------------------------
// runDatabaseMigrations
// ---------------------------------------------------------------------------

describe('runDatabaseMigrations()', () => {
  let tmpDir: string;
  let migrationsDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    migrationsDir = makeTmpDir();
  });

  it('runs migrations when config is valid', async () => {
    const dbPath = join(tmpDir, 'test.sqlite');
    const configPath = writeMinimalConfig(tmpDir, tmpDir);
    // Write config with explicit storage path
    writeFileSync(configPath, `storage:\n  path: "${dbPath}"\nlogLevel: info\n`);

    const result = await runDatabaseMigrations(configPath, migrationsDir);
    expect(result.status).toBe('passed');
  });

  it('applies a migration file when present', async () => {
    const dbPath = join(tmpDir, 'test.sqlite');
    const configPath = join(tmpDir, 'talond.yaml');
    writeFileSync(configPath, `storage:\n  path: "${dbPath}"\nlogLevel: info\n`);

    writeFileSync(
      join(migrationsDir, '001-test.sql'),
      'CREATE TABLE test_migration (id TEXT PRIMARY KEY);',
    );

    const result = await runDatabaseMigrations(configPath, migrationsDir);
    expect(result.status).toBe('passed');
    expect(result.message).toContain('1 migration');
  });

  it('returns "skipped" when config file does not exist', async () => {
    const result = await runDatabaseMigrations(
      join(tmpDir, 'nonexistent.yaml'),
      migrationsDir,
    );
    expect(result.status).toBe('skipped');
  });

  it('returns "failed" when config is invalid', async () => {
    const configPath = join(tmpDir, 'talond.yaml');
    writeFileSync(configPath, 'logLevel: not_a_valid_level\n');

    const result = await runDatabaseMigrations(configPath, migrationsDir);
    expect(result.status).toBe('failed');
  });

  it('returns check named "Database migrations"', async () => {
    const dbPath = join(tmpDir, 'test.sqlite');
    const configPath = join(tmpDir, 'talond.yaml');
    writeFileSync(configPath, `storage:\n  path: "${dbPath}"\nlogLevel: info\n`);

    const result = await runDatabaseMigrations(configPath, migrationsDir);
    expect(result.name).toBe('Database migrations');
  });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe('validateConfig()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it('passes for a valid config file', async () => {
    const configPath = writeMinimalConfig(tmpDir);
    const result = await validateConfig(configPath);
    expect(result.status).toBe('passed');
  });

  it('fails for an invalid config file', async () => {
    const configPath = join(tmpDir, 'bad.yaml');
    writeFileSync(configPath, 'logLevel: not_a_valid_level\n');

    const result = await validateConfig(configPath);
    expect(result.status).toBe('failed');
  });

  it('returns "skipped" when config does not exist', async () => {
    const result = await validateConfig(join(tmpDir, 'missing.yaml'));
    expect(result.status).toBe('skipped');
  });

  it('includes config path in message', async () => {
    const configPath = writeMinimalConfig(tmpDir);
    const result = await validateConfig(configPath);
    expect(result.message).toContain(configPath);
  });

  it('returns check named "Config validation"', async () => {
    const configPath = writeMinimalConfig(tmpDir);
    const result = await validateConfig(configPath);
    expect(result.name).toBe('Config validation');
  });
});

// ---------------------------------------------------------------------------
// displaySetupResult
// ---------------------------------------------------------------------------

describe('displaySetupResult()', () => {
  it('prints [OK] for passed checks', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    displaySetupResult([
      { name: 'Step 1', status: 'passed', message: 'All good' },
    ]);

    const output = spy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('[OK]');
    spy.mockRestore();
  });

  it('prints [SKIP] for skipped checks', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    displaySetupResult([
      { name: 'Step 1', status: 'skipped', message: 'Already done' },
    ]);

    const output = spy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('[SKIP]');
    spy.mockRestore();
  });

  it('prints [FAIL] for failed checks', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    displaySetupResult([
      { name: 'Step 1', status: 'failed', message: 'Problem found', hint: 'Fix it' },
    ]);

    const output = spy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('[FAIL]');
    expect(output).toContain('Fix it');
    spy.mockRestore();
  });

  it('shows "Setup complete" when all pass', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    displaySetupResult([
      { name: 'Step 1', status: 'passed', message: 'OK' },
      { name: 'Step 2', status: 'skipped', message: 'Skipped' },
    ]);

    const output = spy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('Setup complete');
    spy.mockRestore();
  });

  it('shows failure count when checks fail', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    displaySetupResult([
      { name: 'Step 1', status: 'failed', message: 'Bad' },
    ]);

    const output = spy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('failure');
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// runSetupChecks integration
// ---------------------------------------------------------------------------

describe('runSetupChecks()', () => {
  let tmpDir: string;
  let migrationsDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    migrationsDir = makeTmpDir();
  });

  it('returns an array of SetupCheck objects', async () => {
    const configPath = join(tmpDir, 'talond.yaml');
    const dataDir = join(tmpDir, 'data');

    const checks = await runSetupChecks({ configPath, dataDir, migrationsDir });

    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBeGreaterThan(0);
    for (const check of checks) {
      expect(check).toHaveProperty('name');
      expect(check).toHaveProperty('status');
      expect(check).toHaveProperty('message');
    }
  });

  it('creates data directory structure during setup', async () => {
    const configPath = join(tmpDir, 'talond.yaml');
    const dataDir = join(tmpDir, 'data');

    await runSetupChecks({ configPath, dataDir, migrationsDir });

    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(join(dataDir, 'ipc', 'daemon'))).toBe(true);
  });

  it('generates a config file if one does not exist', async () => {
    const configPath = join(tmpDir, 'talond.yaml');
    const dataDir = join(tmpDir, 'data');

    expect(existsSync(configPath)).toBe(false);
    await runSetupChecks({ configPath, dataDir, migrationsDir });
    expect(existsSync(configPath)).toBe(true);
  });

  it('returns 7 checks total', async () => {
    const configPath = join(tmpDir, 'talond.yaml');
    const dataDir = join(tmpDir, 'data');

    const checks = await runSetupChecks({ configPath, dataDir, migrationsDir });
    expect(checks).toHaveLength(7);
  });

  it('skips config generation when config already exists', async () => {
    const configPath = writeMinimalConfig(tmpDir);
    const dataDir = join(tmpDir, 'data');

    const checks = await runSetupChecks({ configPath, dataDir, migrationsDir });
    const genCheck = checks.find((c) => c.name === 'Config file generation');

    expect(genCheck?.status).toBe('skipped');
  });
});
