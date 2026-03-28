/**
 * `talonctl backup` command.
 *
 * Standalone command (no daemon required). Creates a timestamped backup
 * directory containing:
 *   - SQLite database (atomic copy via VACUUM INTO)
 *   - talond.yaml configuration file
 *   - personas/ directory
 *   - skills/ directory
 *
 * Default backup directory: `data/backups/talond-{timestamp}/`
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../core/config/config-loader.js';
import { createDatabase } from '../../core/database/connection.js';
import type { BackupResult } from '../cli-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default path to search for talond.yaml if none is specified. */
const DEFAULT_CONFIG_PATH = 'talond.yaml';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes the `backup` CLI command.
 *
 * Loads config, determines paths, and creates a backup directory containing
 * the database, config file, personas, and skills.
 *
 * @param options.configPath - Path to talond.yaml (defaults to `talond.yaml`).
 * @param options.backupPath - Override backup destination directory.
 */
export async function backupCommand(options: {
  configPath?: string;
  backupPath?: string;
} = {}): Promise<void> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  // Load configuration to get the database and data paths.
  const configResult = loadConfig(configPath);
  if (configResult.isErr()) {
    console.error(`Error loading config: ${configResult.error.message}`);
    process.exit(1);
    return;
  }

  const config = configResult.value;
  const dbPath = config.storage.path;
  const dataDir = config.dataDir;

  // Resolve personas/ and skills/ relative to the config file's directory,
  // matching how the daemon resolves these paths at runtime.
  const configDir = path.dirname(path.resolve(configPath));

  // Build the backup directory: data/backups/talond-{ISO timestamp}/
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const backupDir =
    options.backupPath ?? path.join(dataDir, 'backups', `talond-${timestamp}`);

  const resolvedBackupDir = path.resolve(backupDir);
  const dbBackupPath = path.join(resolvedBackupDir, 'talond.sqlite');

  console.log(`Source database: ${dbPath}`);
  console.log(`Backup directory: ${resolvedBackupDir}`);

  // Ensure backup directory exists.
  try {
    await fs.mkdir(resolvedBackupDir, { recursive: true });
  } catch (cause) {
    console.error(`Error creating backup directory: ${String(cause)}`);
    process.exit(1);
    return;
  }

  // --- 1. Database backup ---------------------------------------------------

  const dbResult = createDatabase(dbPath);
  if (dbResult.isErr()) {
    console.error(`Error opening database: ${dbResult.error.message}`);
    process.exit(1);
    return;
  }

  const db = dbResult.value;
  let backupSucceeded = false;

  try {
    // VACUUM INTO performs an atomic, consistent copy of the database.
    // It works even if the source database has WAL mode enabled.
    db.exec(`VACUUM INTO '${dbBackupPath.replace(/'/g, "''")}'`);
    backupSucceeded = true;
  } catch (cause) {
    console.error(`Error creating database backup: ${String(cause)}`);
    process.exit(1);
  } finally {
    db.close();
  }

  if (!backupSucceeded) return;

  // Verify the backup file was actually created.
  if (!existsSync(dbBackupPath)) {
    console.error(`Error: Database backup "${dbBackupPath}" was not created. VACUUM INTO may have failed silently.`);
    process.exit(1);
    return;
  }

  const dbStat = await fs.stat(dbBackupPath);
  if (dbStat.size === 0) {
    console.error(`Error: Database backup "${dbBackupPath}" is empty.`);
    process.exit(1);
    return;
  }

  const dbSizeMb = (dbStat.size / (1024 * 1024)).toFixed(2);
  console.log(`Database backup:   ${dbSizeMb} MB`);

  // --- 2. Config file -------------------------------------------------------

  const resolvedConfigPath = path.resolve(configPath);
  try {
    await fs.copyFile(resolvedConfigPath, path.join(resolvedBackupDir, 'talond.yaml'));
    console.log(`Config backup:     talond.yaml`);
  } catch (cause) {
    console.error(`Error: Could not backup config file: ${String(cause)}`);
    process.exit(1);
    return;
  }

  // --- 3. Personas directory ------------------------------------------------

  const personasDir = path.resolve(configDir, 'personas');
  if (existsSync(personasDir)) {
    const personasDest = path.join(resolvedBackupDir, 'personas');
    if (isSubPath(personasDir, personasDest)) {
      console.error(`Error: Backup directory is inside personas directory. Choose a different output path.`);
      process.exit(1);
      return;
    }
    try {
      await copyDirectoryRecursive(personasDir, personasDest);
      console.log(`Personas backup:   personas/`);
    } catch (cause) {
      console.error(`Error: Could not backup personas directory: ${String(cause)}`);
      process.exit(1);
      return;
    }
  } else {
    console.log(`Personas backup:   skipped (directory not found)`);
  }

  // --- 4. Skills directory --------------------------------------------------
  // The skill loader checks both cwd/skills and dataDir/skills at runtime.
  // Back up whichever exists (preferring configDir/skills, falling back to
  // dataDir/skills if the first is not found).

  const skillsCandidates = [
    path.resolve(configDir, 'skills'),
    path.resolve(dataDir, 'skills'),
  ];
  const skillsDir = skillsCandidates.find((d) => existsSync(d));
  if (skillsDir) {
    const skillsDest = path.join(resolvedBackupDir, 'skills');
    if (isSubPath(skillsDir, skillsDest)) {
      console.error(`Error: Backup directory is inside skills directory. Choose a different output path.`);
      process.exit(1);
      return;
    }
    try {
      await copyDirectoryRecursive(skillsDir, skillsDest);
      console.log(`Skills backup:     ${path.relative(process.cwd(), skillsDir) || skillsDir}/`);
    } catch (cause) {
      console.error(`Error: Could not backup skills directory: ${String(cause)}`);
      process.exit(1);
      return;
    }
  } else {
    console.log(`Skills backup:     skipped (directory not found)`);
  }

  // --- Done -----------------------------------------------------------------

  const completedAt = new Date().toISOString();
  displayBackupResult({ backupPath: resolvedBackupDir, completedAt });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `child` is inside `parent` (i.e. parent is a prefix of child).
 */
function isSubPath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Recursively copies a directory and all its contents.
 */
async function copyDirectoryRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Renders backup result to stdout.
 */
function displayBackupResult(result: BackupResult): void {
  console.log(`Backup completed at ${result.completedAt}`);
  console.log(`Backup saved to:   ${result.backupPath}`);
}
