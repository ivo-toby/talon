/**
 * `talonctl doctor` command.
 *
 * Standalone command that checks system requirements and configuration:
 *   1. Node.js version >= 24
 *   2. Docker available and responsive
 *   3. Config file exists and validates
 *   4. Database is accessible
 *   5. Data directories exist with correct permissions
 *
 * Each check reports pass/fail with a clear message and optional fix hint.
 */

import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { loadConfig } from '../../core/config/config-loader.js';
import { createDatabase } from '../../core/database/connection.js';
import type { DoctorCheck, DoctorResult } from '../cli-types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum required Node.js major version. */
const MIN_NODE_MAJOR = 24;

/** Default path to search for talond.yaml. */
const DEFAULT_CONFIG_PATH = 'talond.yaml';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes the `doctor` CLI command.
 *
 * Runs all system checks and prints results. Exits with code 1 if any check
 * fails.
 *
 * @param options.configPath - Override config file path (for testing).
 * @param options.dataDir - Override data directory path (for testing).
 */
export async function doctorCommand(options: {
  configPath?: string;
  dataDir?: string;
} = {}): Promise<void> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  const result = await runDoctorChecks(configPath, options.dataDir);
  displayDoctorResult(result);

  if (!result.allPassed) {
    process.exit(1);
  }
}

/**
 * Runs all doctor checks and returns the aggregated result.
 *
 * Exported for testing — allows running checks without process.exit side effects.
 *
 * @param configPath - Path to talond.yaml.
 * @param dataDirOverride - Override the data directory for checks.
 */
export async function runDoctorChecks(
  configPath: string = DEFAULT_CONFIG_PATH,
  dataDirOverride?: string,
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  // 1. Node.js version check.
  checks.push(checkNodeVersion());

  // 2. Docker availability check.
  checks.push(await checkDockerAvailable());

  // 3. Config file exists and validates.
  const configCheck = checkConfigFile(configPath);
  checks.push(configCheck);

  // Remaining checks depend on config — only run them if config loaded.
  let dbPath: string | undefined;
  let dataDir: string | undefined;

  if (configCheck.passed) {
    const configResult = loadConfig(configPath);
    if (configResult.isOk()) {
      dbPath = configResult.value.storage.path;
      dataDir = dataDirOverride ?? configResult.value.dataDir;
    }
  }

  // 4. Database accessible.
  checks.push(checkDatabaseAccess(dbPath));

  // 5. Data directories.
  checks.push(await checkDataDirectories(dataDir));

  const allPassed = checks.every((c) => c.passed);
  return { checks, allPassed };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * Checks that the running Node.js version meets the minimum requirement.
 */
export function checkNodeVersion(): DoctorCheck {
  const versionString = process.version; // e.g. "v22.3.0"
  const major = parseInt(versionString.slice(1).split('.')[0] ?? '0', 10);
  const passed = major >= MIN_NODE_MAJOR;

  return {
    name: 'Node.js version',
    passed,
    message: passed
      ? `Node.js ${versionString} (>= v${MIN_NODE_MAJOR} required)`
      : `Node.js ${versionString} is too old (>= v${MIN_NODE_MAJOR} required)`,
    hint: passed
      ? undefined
      : `Install Node.js v${MIN_NODE_MAJOR} or later from https://nodejs.org`,
  };
}

/**
 * Checks that Docker is installed and the daemon is responsive.
 */
export async function checkDockerAvailable(): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}']);
    const version = stdout.trim();
    return {
      name: 'Docker available',
      passed: true,
      message: `Docker ${version} is running`,
    };
  } catch {
    return {
      name: 'Docker available',
      passed: false,
      message: 'Docker is not available or daemon is not running',
      hint: 'Install Docker from https://docs.docker.com/get-docker/ and start the Docker daemon',
    };
  }
}

/**
 * Checks that the config file exists and passes schema validation.
 */
export function checkConfigFile(configPath: string): DoctorCheck {
  const result = loadConfig(configPath);

  if (result.isOk()) {
    return {
      name: 'Config file',
      passed: true,
      message: `Config file "${configPath}" is valid`,
    };
  }

  // Distinguish between "file not found" and "invalid config".
  const error = result.error;
  const notFound = error.message.includes('ENOENT') || error.message.includes('no such file');

  return {
    name: 'Config file',
    passed: false,
    message: notFound
      ? `Config file "${configPath}" not found`
      : `Config file "${configPath}" is invalid: ${error.message}`,
    hint: notFound
      ? `Create a talond.yaml config file. See the documentation for a minimal example.`
      : `Fix the configuration errors listed above and re-run talonctl doctor.`,
  };
}

/**
 * Checks that the SQLite database can be opened.
 *
 * If dbPath is undefined (config not loaded), returns a skipped-style check.
 */
export function checkDatabaseAccess(dbPath?: string): DoctorCheck {
  if (!dbPath) {
    return {
      name: 'Database accessible',
      passed: false,
      message: 'Skipped — config file must be valid first',
    };
  }

  const result = createDatabase(dbPath);

  if (result.isOk()) {
    result.value.close();
    return {
      name: 'Database accessible',
      passed: true,
      message: `Database "${dbPath}" is accessible`,
    };
  }

  return {
    name: 'Database accessible',
    passed: false,
    message: `Cannot open database "${dbPath}": ${result.error.message}`,
    hint: `Ensure the directory containing "${dbPath}" exists and is writable.`,
  };
}

/**
 * Checks that key data directories exist and are readable/writable.
 *
 * If dataDir is undefined (config not loaded), returns a skipped check.
 */
export async function checkDataDirectories(dataDir?: string): Promise<DoctorCheck> {
  if (!dataDir) {
    return {
      name: 'Data directories',
      passed: false,
      message: 'Skipped — config file must be valid first',
    };
  }

  const dirsToCheck = [
    dataDir,
    path.join(dataDir, 'threads'),
    path.join(dataDir, 'backups'),
    path.join(dataDir, 'ipc', 'daemon'),
  ];

  const missing: string[] = [];

  for (const dir of dirsToCheck) {
    try {
      await fs.access(dir, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
      missing.push(dir);
    }
  }

  if (missing.length === 0) {
    return {
      name: 'Data directories',
      passed: true,
      message: `All data directories exist and are accessible under "${dataDir}"`,
    };
  }

  return {
    name: 'Data directories',
    passed: false,
    message: `Missing or inaccessible directories: ${missing.join(', ')}`,
    hint: `Run talond at least once to create required directories, or create them manually.`,
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Renders doctor results to stdout with pass/fail indicators.
 */
export function displayDoctorResult(result: DoctorResult): void {
  console.log('talonctl doctor');
  console.log('---------------');

  for (const check of result.checks) {
    const indicator = check.passed ? '[PASS]' : '[FAIL]';
    console.log(`${indicator} ${check.name}: ${check.message}`);
    if (!check.passed && check.hint) {
      console.log(`       Hint: ${check.hint}`);
    }
  }

  console.log('');
  if (result.allPassed) {
    console.log('All checks passed. talond is ready to run.');
  } else {
    const failed = result.checks.filter((c) => !c.passed).length;
    console.log(`${failed} check(s) failed. Fix the issues above and re-run talonctl doctor.`);
  }
}
