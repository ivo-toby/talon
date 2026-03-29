/**
 * `talonctl setup` command.
 *
 * Interactive first-time setup that:
 *   1. Detects the OS (Linux / macOS)
 *   2. Checks Node.js version (>= 24 required)
 *   3. Checks Docker availability via `docker info`
 *   4. Creates the data/ directory structure
 *   5. Generates a default talond.yaml config if none exists
 *   6. Runs database migrations against the generated config
 *   7. Validates the generated config
 *   8. Prints a summary of all completed steps
 *
 * Each check returns a structured SetupCheck result (passed/failed/skipped)
 * so the summary can clearly report what was configured.
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import yaml from 'js-yaml';
import writeFileAtomic from 'write-file-atomic';

import { loadConfigFromString } from '../../core/config/config-loader.js';
import { createDatabase } from '../../core/database/connection.js';
import { runMigrations } from '../../core/database/migrations/runner.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status of a single setup step. */
export type SetupStatus = 'passed' | 'failed' | 'skipped';

/** Result of a single setup check/step. */
export interface SetupCheck {
  /** Human-readable name of the step. */
  name: string;
  /** Outcome of this step. */
  status: SetupStatus;
  /** Human-readable message describing the outcome. */
  message: string;
  /** Optional hint for resolving a failure. */
  hint?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum required Node.js major version. */
const MIN_NODE_MAJOR = 24;

/** Default path to write the generated talond.yaml. */
const DEFAULT_CONFIG_PATH = 'talond.yaml';

/** Default data directory. */
const DEFAULT_DATA_DIR = 'data';

/** Subdirectories to create under dataDir. */
const DATA_SUBDIRS = ['ipc', path.join('ipc', 'daemon'), 'backups', 'threads'];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes the `setup` CLI command.
 *
 * Runs all setup steps and prints a summary. Exits with code 1 if any
 * critical step fails.
 *
 * @param options.configPath - Override config output path (default: talond.yaml).
 * @param options.dataDir    - Override data directory path (default: data/).
 */
export async function setupCommand(options: {
  configPath?: string;
  dataDir?: string;
} = {}): Promise<void> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;

  console.log('talonctl setup');
  console.log('--------------');
  console.log('Running setup checks...\n');

  const checks = await runSetupChecks({ configPath, dataDir });
  displaySetupResult(checks);

  const failed = checks.filter((c) => c.status === 'failed');
  if (failed.length > 0) {
    process.exit(1);
  }
}

/**
 * Runs all setup steps in order and returns structured results.
 *
 * Exported for testing — allows checking results without process.exit.
 */
export async function runSetupChecks(options: {
  configPath: string;
  dataDir: string;
  /** Override migrations directory for testing. */
  migrationsDir?: string;
}): Promise<SetupCheck[]> {
  const { configPath, dataDir } = options;
  const checks: SetupCheck[] = [];

  // Step 1: OS detection (informational — always passes).
  checks.push(detectOs());

  // Step 2: Node.js version.
  checks.push(checkNodeVersion());

  // Step 3: Docker availability.
  checks.push(await checkDockerAvailable());

  // Step 4: Create data directory structure.
  checks.push(await createDataDirectories(dataDir));

  // Step 5: Generate default config (skip if config already exists).
  checks.push(await generateDefaultConfig(configPath, dataDir));

  // Step 6: Run database migrations.
  const migrationsDir = options.migrationsDir ?? getDefaultMigrationsDir();
  checks.push(await runDatabaseMigrations(configPath, migrationsDir));

  // Step 7: Validate the generated config.
  checks.push(await validateConfig(configPath));

  return checks;
}

// ---------------------------------------------------------------------------
// Individual setup steps
// ---------------------------------------------------------------------------

/**
 * Detects the host operating system and reports it.
 *
 * This step always passes — it is informational only.
 */
export function detectOs(): SetupCheck {
  const platform = os.platform();
  const release = os.release();
  const platformLabel = platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform;

  return {
    name: 'OS detection',
    status: 'passed',
    message: `Detected ${platformLabel} (${release})`,
  };
}

/**
 * Verifies that the current Node.js version meets the minimum requirement.
 */
export function checkNodeVersion(): SetupCheck {
  const versionString = process.version;
  const major = parseInt(versionString.slice(1).split('.')[0] ?? '0', 10);
  const passed = major >= MIN_NODE_MAJOR;

  return {
    name: 'Node.js version',
    status: passed ? 'passed' : 'failed',
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
export async function checkDockerAvailable(): Promise<SetupCheck> {
  try {
    await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}']);
    return {
      name: 'Docker availability',
      status: 'passed',
      message: 'Docker daemon is running and accessible',
    };
  } catch {
    return {
      name: 'Docker availability',
      status: 'failed',
      message: 'Docker is not available or daemon is not running',
      hint: 'Install Docker from https://docs.docker.com/get-docker/ and start the Docker daemon',
    };
  }
}

/**
 * Creates the data/ directory structure required by talond.
 *
 * Creates `dataDir` and all required subdirectories. If they already exist,
 * the step is reported as skipped (rather than failed).
 */
export async function createDataDirectories(dataDir: string): Promise<SetupCheck> {
  const dirsToCreate = [dataDir, ...DATA_SUBDIRS.map((sub) => path.join(dataDir, sub))];
  const created: string[] = [];
  const alreadyExisted: string[] = [];

  for (const dir of dirsToCreate) {
    if (existsSync(dir)) {
      alreadyExisted.push(dir);
      continue;
    }
    try {
      await fs.mkdir(dir, { recursive: true });
      created.push(dir);
    } catch (cause) {
      return {
        name: 'Data directory structure',
        status: 'failed',
        message: `Failed to create directory "${dir}": ${String(cause)}`,
        hint: `Ensure you have write permissions in the current directory.`,
      };
    }
  }

  if (created.length === 0) {
    return {
      name: 'Data directory structure',
      status: 'skipped',
      message: `Data directories already exist under "${dataDir}"`,
    };
  }

  return {
    name: 'Data directory structure',
    status: 'passed',
    message: `Created ${created.length} director${created.length === 1 ? 'y' : 'ies'} under "${dataDir}"`,
  };
}

/**
 * Generates a default talond.yaml config file if one does not already exist.
 *
 * Uses sensible defaults derived from the config schema.
 */
export async function generateDefaultConfig(
  configPath: string,
  dataDir: string,
): Promise<SetupCheck> {
  if (existsSync(configPath)) {
    return {
      name: 'Config file generation',
      status: 'skipped',
      message: `Config file "${configPath}" already exists — not overwriting`,
    };
  }

  const defaultConfig = buildDefaultConfigObject(dataDir);
  const yamlContent = yaml.dump(defaultConfig, {
    lineWidth: 120,
    quotingType: '"',
    forceQuotes: false,
  });

  const header = [
    '# talond.yaml — generated by talonctl setup',
    '# Edit this file to configure your Talon daemon.',
    '# See talond.yaml.example for full documentation.',
    '',
    '',
  ].join('\n');

  try {
    await writeFileAtomic(configPath, header + yamlContent, { encoding: 'utf-8' });
  } catch (cause) {
    return {
      name: 'Config file generation',
      status: 'failed',
      message: `Failed to write config file "${configPath}": ${String(cause)}`,
      hint: `Ensure you have write permissions in the current directory.`,
    };
  }

  return {
    name: 'Config file generation',
    status: 'passed',
    message: `Generated default config at "${configPath}"`,
  };
}

/**
 * Runs database migrations against the config found at configPath.
 */
export async function runDatabaseMigrations(
  configPath: string,
  migrationsDir: string,
): Promise<SetupCheck> {
  // Load config to find db path.
  let configContent: string;
  try {
    configContent = await fs.readFile(configPath, 'utf-8');
  } catch {
    return {
      name: 'Database migrations',
      status: 'skipped',
      message: `Skipped — config file "${configPath}" not found`,
    };
  }

  const configResult = loadConfigFromString(configContent);
  if (configResult.isErr()) {
    return {
      name: 'Database migrations',
      status: 'failed',
      message: `Cannot run migrations — config is invalid: ${configResult.error.message}`,
    };
  }

  const dbPath = configResult.value.storage.path;

  // Ensure the directory containing the database exists.
  const dbDir = path.dirname(dbPath);
  try {
    await fs.mkdir(dbDir, { recursive: true });
  } catch {
    // Ignore — directory may already exist.
  }

  const dbResult = createDatabase(dbPath);
  if (dbResult.isErr()) {
    return {
      name: 'Database migrations',
      status: 'failed',
      message: `Failed to open database "${dbPath}": ${dbResult.error.message}`,
      hint: `Ensure the directory "${dbDir}" exists and is writable.`,
    };
  }

  const db = dbResult.value;
  let applied = 0;

  try {
    const migrateResult = runMigrations(db, migrationsDir);
    if (migrateResult.isErr()) {
      return {
        name: 'Database migrations',
        status: 'failed',
        message: `Migration failed: ${migrateResult.error.message}`,
      };
    }
    applied = migrateResult.value;
  } finally {
    db.close();
  }

  const msg =
    applied === 0
      ? `Database is up to date at "${dbPath}"`
      : `Applied ${applied} migration(s) to "${dbPath}"`;

  return {
    name: 'Database migrations',
    status: 'passed',
    message: msg,
  };
}

/**
 * Validates the config file at configPath against the schema.
 */
export async function validateConfig(configPath: string): Promise<SetupCheck> {
  let configContent: string;
  try {
    configContent = await fs.readFile(configPath, 'utf-8');
  } catch {
    return {
      name: 'Config validation',
      status: 'skipped',
      message: `Skipped — config file "${configPath}" not found`,
    };
  }

  const result = loadConfigFromString(configContent);
  if (result.isErr()) {
    return {
      name: 'Config validation',
      status: 'failed',
      message: `Config validation failed: ${result.error.message}`,
      hint: `Edit "${configPath}" to fix the validation errors.`,
    };
  }

  return {
    name: 'Config validation',
    status: 'passed',
    message: `Config file "${configPath}" is valid`,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds a plain object representing the default talond.yaml configuration.
 */
function buildDefaultConfigObject(dataDir: string): Record<string, unknown> {
  return {
    logLevel: 'info',
    dataDir,
    storage: {
      type: 'sqlite',
      path: `${dataDir}/talond.sqlite`,
    },
    sandbox: {
      runtime: 'docker',
      image: 'talon-sandbox:latest',
      maxConcurrent: 3,
      networkDefault: 'off',
      idleTimeoutMs: 1800000,
      hardTimeoutMs: 3600000,
      resourceLimits: {
        memoryMb: 1024,
        cpus: 1,
        pidsLimit: 256,
      },
    },
    ipc: {
      pollIntervalMs: 500,
      daemonSocketDir: `${dataDir}/ipc/daemon`,
    },
    queue: {
      maxAttempts: 3,
      backoffBaseMs: 1000,
      backoffMaxMs: 60000,
      concurrencyLimit: 5,
    },
    scheduler: {
      tickIntervalMs: 5000,
    },
    auth: {
      mode: 'subscription',
    },
    channels: [],
    personas: [],
  };
}

/**
 * Returns the path to the bundled migrations directory relative to this file.
 */
function getDefaultMigrationsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  return path.resolve(thisDir, '../../core/database/migrations');
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Renders setup check results to stdout.
 */
export function displaySetupResult(checks: SetupCheck[]): void {
  for (const check of checks) {
    const indicator =
      check.status === 'passed' ? '[OK]  ' : check.status === 'skipped' ? '[SKIP]' : '[FAIL]';
    console.log(`${indicator} ${check.name}: ${check.message}`);
    if (check.status === 'failed' && check.hint) {
      console.log(`       Hint: ${check.hint}`);
    }
  }

  console.log('');

  const failed = checks.filter((c) => c.status === 'failed');
  const skipped = checks.filter((c) => c.status === 'skipped');
  const passed = checks.filter((c) => c.status === 'passed');

  if (failed.length === 0) {
    console.log(`Setup complete. ${passed.length} step(s) completed, ${skipped.length} skipped.`);
    console.log('Run `talond` to start the daemon.');
  } else {
    console.log(
      `Setup encountered ${failed.length} failure(s). Fix the issues above and re-run talonctl setup.`,
    );
  }
}
