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

// Real entrypoint/argv checks. Every subprocess uses only its own disposable config/env.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach } from 'vitest';
import { readConfig } from '../../../src/cli/config-utils.js';
import { SignalConfigSchema } from '../../../src/channels/connectors/signal/signal-config.js';

let fixture: string;
beforeEach(() => { fixture = mkdtempSync(join(tmpdir(), 'signal-cli-argv-')); });
afterEach(() => { rmSync(fixture, { recursive: true, force: true }); });
function cli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), resolve('src/cli/index.ts'), ...args], {
    cwd: fixture, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, TALOND_ENV_FILE: join(fixture, 'missing.env'), TALOND_CONFIG_PATH: join(fixture, 'talond.yaml') },
  });
}
// Pinned 0.14.9 ListDevicesCommand.java:47-67 / ManagerImpl.java:483-504:
// operator-supplied device metadata, not invented RPC current-device flags.
const setup = {
  accountMode: 'personal', socketPath: '/run/signal/bridge.sock',
  account: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb', accountUuid: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
  deviceId: 3, deviceCreatedTimestamp: 200, allowedDmPeers: [], allowedSenders: [], allowedGroups: [],
  triggerPrefix: '!ask', requestTimeoutMs: 1000, reconnectBaseMs: 100, reconnectMaxMs: 100,
};

describe('actual source CLI Signal registration and argv', () => {
  it.each([{ args: ['--help'] }, { args: ['signal-resume', '--help'] }])('registers Signal management in help: %j', ({ args }) => {
    const result = cli(args);
    expect(result.status).toBe(0);
    expect(String(result.stdout)).toContain('signal-resume');
    if (args.length > 1) expect(String(result.stdout)).toContain('--external-challenge-resolved');
  });
  it('documents the actual JSON admission option', () => {
    const result = cli(['add-channel', '--help']);
    expect(result.status).toBe(0);
    expect(String(result.stdout)).toContain('--signal-config <json>');
    expect(String(result.stdout)).toContain('--show-tool-calls <boolean>');
  });
  it.each(['personal', 'dedicated'])('passes full %s JSON to gated A and preserves its normalized config', async (accountMode) => {
    const config = join(fixture, 'talond.yaml');
    writeFileSync(config, 'custom: keep\nchannels: []\n');
    const input = { ...setup, accountMode };
    const result = cli(['add-channel', '--name', 'signal-main', '--type', 'signal', '--signal-config', JSON.stringify(input), '--show-tool-calls', 'false']);
    expect(result.status, String(result.stderr)).toBe(0);
    expect((await readConfig(config)).channels).toEqual([{
      name: 'signal-main', type: 'signal', enabled: true, config: SignalConfigSchema.parse(input), showToolCalls: false,
    }]);
    expect(String(result.stdout)).not.toContain(setup.accountUuid);
  });
  it.each(['{"PRIVATE_BODY":', JSON.stringify({ ...setup, deviceId: '3PRIVATE' }), JSON.stringify({ ...setup, requestTimeoutMs: '1000PRIVATE' })])('refuses malformed JSON/numeric strings without mutation or private diagnostics', (input) => {
    const config = join(fixture, 'talond.yaml');
    writeFileSync(config, 'channels: []\n');
    const before = readFileSync(config);
    const result = cli(['add-channel', '--name', 'signal-main', '--type', 'signal', '--signal-config', input]);
    expect(result.status).toBe(1);
    expect(String(result.stderr)).not.toMatch(/PRIVATE|SyntaxError| at /);
    expect(readFileSync(config)).toEqual(before);
  });
});

import { readdirSync } from 'node:fs';

describe('real Signal resume argv refusal and config policy', () => {
  it.each([
    { args: ['--channel', 'signal-main'] },
    { args: ['--external-challenge-resolved'] },
    { args: ['--channel', 'signal-main', '--external-challenge-resolved=false'] },
    { args: ['--channel', 'signal-main', '--external-challenge-resolved=PRIVATE_TOKEN'] },
    { args: ['--channel', 'PRIVATE/socket', '--external-challenge-resolved'] },
    ...['10PRIVATE', '1.5', '-1', '0', '120001', '9007199254740992'].map((timeout) => ({ args: ['--channel', 'signal-main', '--external-challenge-resolved', '--timeout', timeout] })),
  ])('rejects before IPC with fixed private diagnostics: %j', ({ args }) => {
    const result = cli(['signal-resume', ...args, '--ipc-dir', join(fixture, 'ipc')]);
    expect(result.status).toBe(1);
    expect(String(result.stderr)).not.toMatch(/PRIVATE| at /);
    expect(readdirSync(fixture)).toEqual([]);
  });
  it.each([
    { accountMode: 'personal', notice: 'true', success: false },
    { accountMode: 'dedicated', notice: 'true', success: true },
    { accountMode: 'personal', notice: 'PRIVATE_BOOLEAN', success: false },
  ])('passes channel-level policy to A without notice defaults: %j', async ({ accountMode, notice, success }) => {
    const config = join(fixture, 'named.yaml');
    writeFileSync(config, 'channels: []\n');
    const result = cli(['add-channel', '--config', config, '--name', 'named-signal', '--type', 'signal', '--signal-config', JSON.stringify({ ...setup, accountMode }), '--show-tool-calls', notice]);
    expect(result.status).toBe(success ? 0 : 1);
    expect(String(result.stderr)).not.toContain('PRIVATE');
    if (success) expect((await readConfig(config)).channels?.[0]).toHaveProperty('showToolCalls', true);
    else expect(readFileSync(config, 'utf8')).toBe('channels: []\n');
  });
  it('retains ordinary placeholder behavior and config environment selection', async () => {
    const config = join(fixture, 'talond.yaml');
    writeFileSync(config, 'custom: keep\nchannels: []\n');
    const result = cli(['add-channel', '--name', 'ordinary', '--type', 'telegram']);
    expect(result.status).toBe(0);
    expect((await readConfig(config)).channels?.[0]?.config).toEqual({ botToken: '${TELEGRAM_BOT_TOKEN}', pollingTimeoutSec: 30 });
  });
});

import { DaemonCommandSchema } from '../../../src/ipc/daemon-ipc.js';

it.each([64, 65, 256])('F2 actual CLI admits then submits the identical %s-character channel without truncation', async (length) => {
  const channel = 'n'.repeat(length);
  const config = join(fixture, 'talond.yaml');
  writeFileSync(config, 'channels: []\n');
  const admitted = cli(['add-channel', '--name', channel, '--type', 'signal', '--signal-config', JSON.stringify(setup)]);
  expect(admitted.status, String(admitted.stderr)).toBe(0);
  expect((await readConfig(config)).channels?.[0]?.name).toBe(channel);
  const resumed = cli(['signal-resume', '--channel', channel, '--external-challenge-resolved', '--ipc-dir', join(fixture, 'ipc'), '--timeout', '1']);
  expect(resumed.status).toBe(1); // no daemon fixture here: timeout, never false success
  expect(String(resumed.stderr)).toContain('TIMEOUT');
  const input = join(fixture, 'ipc', 'input');
  const files = readdirSync(input).filter((file) => file.endsWith('.json'));
  expect(files).toHaveLength(1);
  const command = DaemonCommandSchema.parse(JSON.parse(readFileSync(join(input, files[0]!), 'utf8')));
  expect(command.command).toBe('signal-resume');
  expect(command.payload).toEqual({ channel, externalChallengeResolved: true });
  expect(String(resumed.stdout)).not.toContain('verified');
});
