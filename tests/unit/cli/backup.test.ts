/**
 * Unit tests for the `talonctl backup` command.
 *
 * Tests that the backup command creates a valid backup directory containing
 * database, config, personas, and skills.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { backupCommand } from '../../../src/cli/commands/backup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'talon-backup-test-'));
}

/** Creates a minimal SQLite database with one table for testing. */
function createTestDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec('CREATE TABLE test (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO test VALUES ('row1')");
  db.close();
}

/** Writes a talond.yaml config pointing at a specific db and data directory. */
function writeConfig(dir: string, dbPath: string, dataDir: string): string {
  const configPath = join(dir, 'talond.yaml');
  writeFileSync(
    configPath,
    `storage:\n  path: "${dbPath}"\ndataDir: "${dataDir}"\nlogLevel: info\n`,
  );
  return configPath;
}

/** Creates a personas directory with a test persona. */
function createPersonasDir(baseDir: string): void {
  const personasDir = join(baseDir, 'personas');
  const personaDir = join(personasDir, 'test-persona');
  mkdirSync(personaDir, { recursive: true });
  writeFileSync(join(personaDir, 'persona.yaml'), 'name: test-persona\n');
}

/** Creates a skills directory with a test skill. */
function createSkillsDir(baseDir: string): void {
  const skillsDir = join(baseDir, 'skills');
  const skillDir = join(skillsDir, 'test-skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# Test Skill\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backupCommand()', () => {
  let tmpDir: string;
  let dbDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    dbDir = makeTmpDir();
  });

  it('creates a backup directory with database at the specified path', async () => {
    const dbPath = join(dbDir, 'test.sqlite');
    createTestDatabase(dbPath);
    const configPath = writeConfig(tmpDir, dbPath, dbDir);
    const backupDir = join(dbDir, 'test-backup');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath, backupPath: backupDir });

    expect(existsSync(backupDir)).toBe(true);
    expect(existsSync(join(backupDir, 'talond.sqlite'))).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('backup database is a valid SQLite file', async () => {
    const dbPath = join(dbDir, 'test.sqlite');
    createTestDatabase(dbPath);
    const configPath = writeConfig(tmpDir, dbPath, dbDir);
    const backupDir = join(dbDir, 'backup-valid');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath, backupPath: backupDir });

    // Open backup as SQLite and verify data is preserved.
    const backupDb = new Database(join(backupDir, 'talond.sqlite'));
    const rows = backupDb.prepare('SELECT id FROM test').all() as Array<{ id: string }>;
    backupDb.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('row1');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('creates backup directory if it does not exist', async () => {
    const dbPath = join(dbDir, 'test.sqlite');
    createTestDatabase(dbPath);
    const configPath = writeConfig(tmpDir, dbPath, dbDir);
    const backupDir = join(dbDir, 'nested', 'backups', 'test');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath, backupPath: backupDir });

    expect(existsSync(backupDir)).toBe(true);
    expect(existsSync(join(backupDir, 'talond.sqlite'))).toBe(true);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('uses default backup path under data/backups/', async () => {
    const dbPath = join(dbDir, 'test.sqlite');
    createTestDatabase(dbPath);
    const configPath = writeConfig(tmpDir, dbPath, dbDir);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath });

    // Check that a backup directory was created under data/backups/
    const backupsDir = join(dbDir, 'backups');
    const backupDirs = readdirSync(backupsDir).filter((f) => f.startsWith('talond-'));
    expect(backupDirs.length).toBeGreaterThan(0);
    expect(existsSync(join(backupsDir, backupDirs[0]!, 'talond.sqlite'))).toBe(true);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('backs up the config file', async () => {
    const dbPath = join(dbDir, 'test.sqlite');
    createTestDatabase(dbPath);
    const configPath = writeConfig(tmpDir, dbPath, dbDir);
    const backupDir = join(dbDir, 'backup-config');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath, backupPath: backupDir });

    expect(existsSync(join(backupDir, 'talond.yaml'))).toBe(true);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('backs up the personas directory', async () => {
    const dbPath = join(dbDir, 'test.sqlite');
    createTestDatabase(dbPath);
    const configPath = writeConfig(tmpDir, dbPath, dbDir);
    const backupDir = join(dbDir, 'backup-personas');

    // Personas dir is resolved relative to config file's directory (tmpDir).
    createPersonasDir(tmpDir);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath, backupPath: backupDir });

    expect(existsSync(join(backupDir, 'personas', 'test-persona', 'persona.yaml'))).toBe(true);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('backs up the skills directory', async () => {
    const dbPath = join(dbDir, 'test.sqlite');
    createTestDatabase(dbPath);
    const configPath = writeConfig(tmpDir, dbPath, dbDir);
    const backupDir = join(dbDir, 'backup-skills');

    // Skills dir is resolved relative to config file's directory (tmpDir).
    createSkillsDir(tmpDir);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath, backupPath: backupDir });

    expect(existsSync(join(backupDir, 'skills', 'test-skill', 'SKILL.md'))).toBe(true);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with code 1 when backup output is inside personas directory', async () => {
    const dbPath = join(dbDir, 'test.sqlite');
    createTestDatabase(dbPath);
    const configPath = writeConfig(tmpDir, dbPath, dbDir);

    // Create personas directory, then set backup output inside it.
    createPersonasDir(tmpDir);
    const backupDir = join(tmpDir, 'personas', 'inside-backup');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath, backupPath: backupDir });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorOutput = errorSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(errorOutput).toContain('inside personas directory');

    consoleSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('backs up skills from dataDir when configDir/skills is absent', async () => {
    const dbPath = join(dbDir, 'test.sqlite');
    createTestDatabase(dbPath);
    // Use a separate dir for config so configDir/skills doesn't exist.
    const configDir = makeTmpDir();
    const configPath = writeConfig(configDir, dbPath, dbDir);
    const backupDir = join(dbDir, 'backup-datadir-skills');

    // Create skills under dataDir (dbDir) instead of configDir.
    createSkillsDir(dbDir);

    // chdir to tmpDir to avoid cwd/skills picking up the real repo's skills/.
    const origCwd = process.cwd();
    process.chdir(tmpDir);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    try {
      await backupCommand({ configPath, backupPath: backupDir });
      expect(existsSync(join(backupDir, 'skills', 'test-skill', 'SKILL.md'))).toBe(true);
    } finally {
      process.chdir(origCwd);
      consoleSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('skips skills gracefully when no skills directory exists', async () => {
    const dbPath = join(dbDir, 'test.sqlite');
    createTestDatabase(dbPath);
    const configPath = writeConfig(tmpDir, dbPath, dbDir);
    const backupDir = join(dbDir, 'backup-no-skills');

    // chdir to tmpDir so cwd/skills doesn't resolve to the real repo's skills/.
    const origCwd = process.cwd();
    process.chdir(tmpDir);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    try {
      await backupCommand({ configPath, backupPath: backupDir });

      const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
      expect(output).toContain('Skills backup:     skipped');
      expect(existsSync(join(backupDir, 'skills'))).toBe(false);
    } finally {
      process.chdir(origCwd);
      consoleSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('exits with code 1 when config file is missing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath: '/nonexistent/talond.yaml' });

    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with code 1 when database does not exist', async () => {
    writeFileSync(
      join(tmpDir, 'talond.yaml'),
      `storage:\n  path: "/nonexistent/path/test.sqlite"\ndataDir: "${dbDir}"\nlogLevel: info\n`,
    );
    const configPath = join(tmpDir, 'talond.yaml');
    const backupDir = join(dbDir, 'backup-fail');

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath, backupPath: backupDir });

    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('logs source database and backup directory on success', async () => {
    const dbPath = join(dbDir, 'test.sqlite');
    createTestDatabase(dbPath);
    const configPath = writeConfig(tmpDir, dbPath, dbDir);
    const backupDir = join(dbDir, 'backup-log-test');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath, backupPath: backupDir });

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain(dbPath);
    expect(output).toContain(backupDir);
    expect(output).toContain('completed');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
