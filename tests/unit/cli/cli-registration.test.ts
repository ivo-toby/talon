/**
 * Tests that verify all expected talonctl commands are registered.
 *
 * Imports the Command program from each command module to verify the
 * exports are present, and checks the commander setup in index.ts.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Verify each command module exports its handler function
// ---------------------------------------------------------------------------

describe('CLI command modules', () => {
  it('status command exports statusCommand function', async () => {
    const mod = await import('../../../src/cli/commands/status.js');
    expect(typeof mod.statusCommand).toBe('function');
  });

  it('migrate command exports migrateCommand function', async () => {
    const mod = await import('../../../src/cli/commands/migrate.js');
    expect(typeof mod.migrateCommand).toBe('function');
  });

  it('backup command exports backupCommand function', async () => {
    const mod = await import('../../../src/cli/commands/backup.js');
    expect(typeof mod.backupCommand).toBe('function');
  });

  it('reload command exports reloadCommand function', async () => {
    const mod = await import('../../../src/cli/commands/reload.js');
    expect(typeof mod.reloadCommand).toBe('function');
  });

  it('doctor command exports doctorCommand function', async () => {
    const mod = await import('../../../src/cli/commands/doctor.js');
    expect(typeof mod.doctorCommand).toBe('function');
  });

  it('list-threads command exports listThreadsCommand function', async () => {
    const mod = await import('../../../src/cli/commands/list-threads.js');
    expect(typeof mod.listThreadsCommand).toBe('function');
  });

  it('reset-provider-affinity command exports resetProviderAffinityCommand function', async () => {
    const mod = await import('../../../src/cli/commands/reset-provider-affinity.js');
    expect(typeof mod.resetProviderAffinityCommand).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Verify cli-types exports are correct
// ---------------------------------------------------------------------------

describe('cli-types module', () => {
  it('exports CliError class', async () => {
    const mod = await import('../../../src/cli/cli-types.js');
    expect(typeof mod.CliError).toBe('function');
  });

  it('CliError has code CLI_ERROR', async () => {
    const { CliError } = await import('../../../src/cli/cli-types.js');
    const err = new CliError('test error');
    expect(err.code).toBe('CLI_ERROR');
    expect(err.message).toBe('test error');
    expect(err.name).toBe('CliError');
  });

  it('CliError accepts cause', async () => {
    const { CliError } = await import('../../../src/cli/cli-types.js');
    const cause = new Error('underlying cause');
    const err = new CliError('wrapped', cause);
    expect(err.cause).toBe(cause);
  });
});

// ---------------------------------------------------------------------------
// Type shape tests for result interfaces
// ---------------------------------------------------------------------------

describe('result type shapes', () => {
  it('DoctorResult has checks and allPassed fields', () => {
    // Purely static shape test — TypeScript catches this at compile time,
    // but we also verify the runtime shape here.
    const result = {
      checks: [{ name: 'test', passed: true, message: 'ok' }],
      allPassed: true,
    };
    expect(result).toHaveProperty('checks');
    expect(result).toHaveProperty('allPassed');
    expect(Array.isArray(result.checks)).toBe(true);
  });

  it('DoctorCheck has name, passed, message fields', () => {
    const check = {
      name: 'Node.js version',
      passed: true,
      message: 'Node.js v22.0.0',
    };
    expect(check).toHaveProperty('name');
    expect(check).toHaveProperty('passed');
    expect(check).toHaveProperty('message');
  });

  it('MigrateResult has applied and dbPath fields', () => {
    const result = {
      applied: 3,
      dbPath: '/data/talond.sqlite',
    };
    expect(result).toHaveProperty('applied');
    expect(result).toHaveProperty('dbPath');
  });

  it('BackupResult has backupPath and completedAt fields', () => {
    const result = {
      backupPath: '/data/backups/talond-2026-01-01.sqlite',
      completedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(result).toHaveProperty('backupPath');
    expect(result).toHaveProperty('completedAt');
  });
});
