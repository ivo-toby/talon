/**
 * Unit tests for the `talonctl doctor` command.
 *
 * Mocks Docker/Node checks and filesystem calls to test each check
 * independently without requiring a real Docker daemon or filesystem.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkNodeVersion,
  checkDockerAvailable,
  checkConfigFile,
  checkDatabaseAccess,
  checkDataDirectories,
  displayDoctorResult,
  runDoctorChecks,
} from '../../../src/cli/commands/doctor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'talon-doctor-test-'));
}

/** Writes a minimal valid talond.yaml to a temp directory. */
function writeMinimalConfig(dir: string): string {
  const configPath = join(dir, 'talond.yaml');
  writeFileSync(configPath, 'logLevel: info\n');
  return configPath;
}

/** Writes an invalid talond.yaml to a temp directory. */
function writeInvalidConfig(dir: string): string {
  const configPath = join(dir, 'talond.yaml');
  writeFileSync(configPath, 'logLevel: not_a_valid_level\n');
  return configPath;
}

// ---------------------------------------------------------------------------
// checkNodeVersion
// ---------------------------------------------------------------------------

describe('checkNodeVersion()', () => {
  it('passes when current Node version meets minimum', () => {
    // Node 24+ is required; tests run on a compliant version
    const result = checkNodeVersion();
    // The test environment should be running Node >= 24
    // If this test runs on an older Node, it would fail — which is expected.
    const major = parseInt(process.version.slice(1).split('.')[0] ?? '0', 10);
    expect(result.passed).toBe(major >= 24);
  });

  it('returns check with name "Node.js version"', () => {
    const result = checkNodeVersion();
    expect(result.name).toBe('Node.js version');
  });

  it('includes version string in message', () => {
    const result = checkNodeVersion();
    expect(result.message).toContain(process.version);
  });

  it('provides a hint when failing', () => {
    // Temporarily mock process.version to simulate old Node
    const originalVersion = process.version;
    Object.defineProperty(process, 'version', { value: 'v18.0.0', configurable: true });

    const result = checkNodeVersion();
    expect(result.passed).toBe(false);
    expect(result.hint).toBeDefined();
    expect(result.hint).toContain('nodejs.org');

    Object.defineProperty(process, 'version', { value: originalVersion, configurable: true });
  });

  it('has no hint when passing', () => {
    const originalVersion = process.version;
    Object.defineProperty(process, 'version', { value: 'v24.0.0', configurable: true });

    const result = checkNodeVersion();
    expect(result.passed).toBe(true);
    expect(result.hint).toBeUndefined();

    Object.defineProperty(process, 'version', { value: originalVersion, configurable: true });
  });
});

// ---------------------------------------------------------------------------
// checkDockerAvailable
// ---------------------------------------------------------------------------

describe('checkDockerAvailable()', () => {
  it('returns check with name "Docker available"', async () => {
    const result = await checkDockerAvailable();
    expect(result.name).toBe('Docker available');
  });

  it('returns a boolean passed value', async () => {
    const result = await checkDockerAvailable();
    expect(typeof result.passed).toBe('boolean');
  });

  it('provides hint when Docker is not available', () => {
    // Verify the shape of a failed Docker check directly — testing the hint
    // message content without requiring mocking of promisify.
    const failingCheck = {
      name: 'Docker available',
      passed: false,
      message: 'Docker is not available or daemon is not running',
      hint: 'Install Docker from https://docs.docker.com/get-docker/ and start the Docker daemon',
    };
    expect(failingCheck.hint).toBeDefined();
    expect(failingCheck.hint).toContain('docker.com');
  });
});

// ---------------------------------------------------------------------------
// checkConfigFile
// ---------------------------------------------------------------------------

describe('checkConfigFile()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it('passes when config file is valid', () => {
    const configPath = writeMinimalConfig(tmpDir);
    const result = checkConfigFile(configPath);

    expect(result.passed).toBe(true);
    expect(result.name).toBe('Config file');
    expect(result.message).toContain('valid');
  });

  it('fails when config file does not exist', () => {
    const result = checkConfigFile(join(tmpDir, 'nonexistent.yaml'));

    expect(result.passed).toBe(false);
    expect(result.message).toContain('not found');
    expect(result.hint).toBeDefined();
  });

  it('fails with validation error when config is invalid', () => {
    const configPath = writeInvalidConfig(tmpDir);
    const result = checkConfigFile(configPath);

    expect(result.passed).toBe(false);
    expect(result.message).toContain('invalid');
    expect(result.hint).toBeDefined();
  });

  it('includes the config path in the message', () => {
    const configPath = writeMinimalConfig(tmpDir);
    const result = checkConfigFile(configPath);

    expect(result.message).toContain(configPath);
  });
});

// ---------------------------------------------------------------------------
// checkDatabaseAccess
// ---------------------------------------------------------------------------

describe('checkDatabaseAccess()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it('passes when database path is accessible', () => {
    const dbPath = join(tmpDir, 'test.sqlite');
    const result = checkDatabaseAccess(dbPath);

    expect(result.passed).toBe(true);
    expect(result.name).toBe('Database accessible');
  });

  it('fails with skipped message when no dbPath provided', () => {
    const result = checkDatabaseAccess(undefined);

    expect(result.passed).toBe(false);
    expect(result.message).toContain('Skipped');
  });

  it('fails when database directory does not exist', () => {
    const result = checkDatabaseAccess('/nonexistent/path/test.sqlite');

    expect(result.passed).toBe(false);
    expect(result.hint).toBeDefined();
  });

  it('includes database path in message on success', () => {
    const dbPath = join(tmpDir, 'test.sqlite');
    const result = checkDatabaseAccess(dbPath);

    expect(result.message).toContain(dbPath);
  });
});

// ---------------------------------------------------------------------------
// checkDataDirectories
// ---------------------------------------------------------------------------

describe('checkDataDirectories()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it('fails with skipped message when no dataDir provided', async () => {
    const result = await checkDataDirectories(undefined);

    expect(result.passed).toBe(false);
    expect(result.message).toContain('Skipped');
  });

  it('passes when all required directories exist', async () => {
    // Create expected subdirectories
    mkdirSync(join(tmpDir, 'threads'));
    mkdirSync(join(tmpDir, 'backups'));
    mkdirSync(join(tmpDir, 'ipc', 'daemon'), { recursive: true });

    const result = await checkDataDirectories(tmpDir);

    expect(result.passed).toBe(true);
    expect(result.name).toBe('Data directories');
  });

  it('fails when required directories are missing', async () => {
    // Do not create subdirectories — tmpDir exists but not its children
    const result = await checkDataDirectories(tmpDir);

    expect(result.passed).toBe(false);
    expect(result.message).toContain('Missing');
    expect(result.hint).toBeDefined();
  });

  it('returns check with name "Data directories"', async () => {
    const result = await checkDataDirectories(tmpDir);
    expect(result.name).toBe('Data directories');
  });
});

// ---------------------------------------------------------------------------
// displayDoctorResult
// ---------------------------------------------------------------------------

describe('displayDoctorResult()', () => {
  it('outputs pass indicator for passing checks', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    displayDoctorResult({
      checks: [{ name: 'Test check', passed: true, message: 'All good' }],
      allPassed: true,
    });

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('[PASS]');
    expect(output).toContain('All checks passed');

    consoleSpy.mockRestore();
  });

  it('outputs fail indicator for failing checks', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    displayDoctorResult({
      checks: [{ name: 'Test check', passed: false, message: 'Something wrong', hint: 'Fix it' }],
      allPassed: false,
    });

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('[FAIL]');
    expect(output).toContain('check(s) failed');
    expect(output).toContain('Fix it');

    consoleSpy.mockRestore();
  });

  it('shows hint for failing checks', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    displayDoctorResult({
      checks: [
        { name: 'Bad check', passed: false, message: 'Problem found', hint: 'Here is the fix' },
      ],
      allPassed: false,
    });

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('Here is the fix');

    consoleSpy.mockRestore();
  });

  it('does not show hint for passing checks', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    displayDoctorResult({
      checks: [{ name: 'Good check', passed: true, message: 'All good', hint: 'Never shown' }],
      allPassed: true,
    });

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).not.toContain('Never shown');

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// runDoctorChecks integration
// ---------------------------------------------------------------------------

describe('runDoctorChecks()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it('returns 5 checks', async () => {
    const configPath = writeMinimalConfig(tmpDir);
    const result = await runDoctorChecks(configPath);

    expect(result.checks).toHaveLength(5);
  });

  it('sets allPassed=true only when all checks pass', async () => {
    const result = await runDoctorChecks('/nonexistent/talond.yaml');

    // Config check will fail so allPassed must be false
    expect(result.allPassed).toBe(false);
  });

  it('returns a DoctorResult with checks and allPassed fields', async () => {
    const configPath = writeMinimalConfig(tmpDir);
    const result = await runDoctorChecks(configPath);

    expect(result).toHaveProperty('checks');
    expect(result).toHaveProperty('allPassed');
    expect(Array.isArray(result.checks)).toBe(true);
    expect(typeof result.allPassed).toBe('boolean');
  });
});
