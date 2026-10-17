/**
 * Unit tests for the `talonctl add-channel` command.
 *
 * Tests both the pure `addChannel()` function (importable by setup skill /
 * terminal agent) and the `addChannelCommand()` CLI wrapper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import yaml from 'js-yaml';

import { addChannel, addChannelCommand, buildPlaceholderConfig, type AddChannelOptions } from '../../../src/cli/commands/add-channel.js';
import { readConfig } from '../../../src/cli/config-utils.js';
import { SignalConfigSchema } from '../../../src/channels/connectors/signal/signal-config.js';
import { ChannelConfigSchema } from '../../../src/core/config/config-schema.js';
import { ConfigError } from '../../../src/core/errors/error-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-add-channel-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function configPath(): string {
  return join(tmpDir, 'talond.yaml');
}

function writeMinimalConfig(): string {
  const p = configPath();
  writeFileSync(p, 'logLevel: info\nchannels: []\n');
  return p;
}

function writeYaml(content: string): string {
  const p = configPath();
  writeFileSync(p, content);
  return p;
}

function readYaml(p: string): Record<string, unknown> {
  return (yaml.load(readFileSync(p, 'utf-8')) ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// addChannel() — pure function
// ---------------------------------------------------------------------------

describe('addChannel()', () => {
  it('adds a channel entry to an empty channels list', async () => {
    const p = writeMinimalConfig();
    const result = await addChannel({ name: 'my-telegram', type: 'telegram', configPath: p });

    expect(result.name).toBe('my-telegram');
    expect(result.type).toBe('telegram');
    expect(result.enabled).toBe(true);
    const doc = readYaml(p);
    const channels = doc.channels as Array<Record<string, unknown>>;
    expect(channels).toHaveLength(1);
    expect(channels[0]!.name).toBe('my-telegram');
    expect(channels[0]!.type).toBe('telegram');
  });

  it('appends a channel to an existing list', async () => {
    const p = writeYaml('channels:\n  - name: existing\n    type: slack\n');
    await addChannel({ name: 'new-discord', type: 'discord', configPath: p });

    const doc = readYaml(p);
    const channels = doc.channels as Array<Record<string, unknown>>;
    expect(channels).toHaveLength(2);
    expect(channels[1]!.name).toBe('new-discord');
  });

  it('sets enabled: true on the new channel', async () => {
    const p = writeMinimalConfig();
    await addChannel({ name: 'tg', type: 'telegram', configPath: p });

    const doc = readYaml(p);
    const channels = doc.channels as Array<Record<string, unknown>>;
    expect(channels[0]!.enabled).toBe(true);
  });

  it('adds telegram placeholder config', async () => {
    const p = writeMinimalConfig();
    await addChannel({ name: 'tg-bot', type: 'telegram', configPath: p });

    const doc = readYaml(p);
    const channels = doc.channels as Array<Record<string, unknown>>;
    const config = channels[0]!.config as Record<string, unknown>;
    expect(config.botToken).toBeDefined();
  });

  it('adds slack placeholder config with botToken, appToken, and signingSecret', async () => {
    const p = writeMinimalConfig();
    await addChannel({ name: 'slack-main', type: 'slack', configPath: p });

    const doc = readYaml(p);
    const channels = doc.channels as Array<Record<string, unknown>>;
    const config = channels[0]!.config as Record<string, unknown>;
    expect(config.botToken).toBeDefined();
    expect(config.appToken).toBeDefined();
    expect(config.signingSecret).toBeDefined();
  });

  it('adds terminal placeholder config', async () => {
    const p = writeMinimalConfig();
    await addChannel({ name: 'term', type: 'terminal', configPath: p });

    const doc = readYaml(p);
    const channels = doc.channels as Array<Record<string, unknown>>;
    const config = channels[0]!.config as Record<string, unknown>;
    expect(config.port).toBe(8089);
  });

  it('adds whatsappBaileys placeholder config with authDir, selfChat, and triggerWords', async () => {
    const p = writeMinimalConfig();
    await addChannel({ name: 'wa', type: 'whatsappBaileys', configPath: p });

    const doc = readYaml(p);
    const channels = doc.channels as Array<Record<string, unknown>>;
    const config = channels[0]!.config as Record<string, unknown>;
    expect(config.authDir).toBe('./baileys-auth');
    expect(config.selfChat).toBe(false);
    expect(config.triggerWords).toEqual([]);
  });

  // --- Validation ---

  it('rejects a duplicate channel name', async () => {
    const p = writeYaml('channels:\n  - name: my-telegram\n    type: telegram\n');
    await expect(addChannel({ name: 'my-telegram', type: 'telegram', configPath: p }))
      .rejects.toThrow(/already exists/);
  });

  it('rejects an invalid channel name', async () => {
    const p = writeMinimalConfig();
    await expect(addChannel({ name: 'bad name', type: 'telegram', configPath: p }))
      .rejects.toThrow(/invalid/);
  });

  it('rejects an empty channel name', async () => {
    const p = writeMinimalConfig();
    await expect(addChannel({ name: '', type: 'telegram', configPath: p }))
      .rejects.toThrow(/must not be empty/);
  });

  it('rejects an unknown channel type', async () => {
    const p = writeMinimalConfig();
    await expect(addChannel({ name: 'custom', type: 'custom', configPath: p }))
      .rejects.toThrow(/Unknown channel type/);
  });

  it('includes valid types in the type error message', async () => {
    const p = writeMinimalConfig();
    await expect(addChannel({ name: 'custom', type: 'foobar', configPath: p }))
      .rejects.toThrow(/telegram/);
  });

  it('throws for non-existent config file', async () => {
    await expect(addChannel({ name: 'bot', type: 'telegram', configPath: join(tmpDir, 'nope.yaml') }))
      .rejects.toThrow(/not found/);
  });

  it('handles channels as non-array (overwrites with array)', async () => {
    const p = writeYaml('channels: "not-an-array"\n');
    await addChannel({ name: 'tg', type: 'telegram', configPath: p });

    const doc = readYaml(p);
    const channels = doc.channels as Array<Record<string, unknown>>;
    expect(channels).toHaveLength(1);
    expect(channels[0]!.name).toBe('tg');
  });

  it('creates channels array if missing from config', async () => {
    const p = writeYaml('logLevel: info\n');
    await addChannel({ name: 'tg', type: 'telegram', configPath: p });

    const doc = readYaml(p);
    const channels = doc.channels as Array<Record<string, unknown>>;
    expect(channels).toHaveLength(1);
    expect(channels[0]!.name).toBe('tg');
  });
});

// ---------------------------------------------------------------------------
// addChannelCommand() — CLI wrapper
// ---------------------------------------------------------------------------

describe('addChannelCommand()', () => {
  it('prints confirmation on success', async () => {
    const p = writeMinimalConfig();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await addChannelCommand({ name: 'tg', type: 'telegram', configPath: p });

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('tg');
    expect(output).toContain('telegram');
    consoleSpy.mockRestore();
  });

  it('exits with code 1 on error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await addChannelCommand({ name: 'bot', type: 'telegram', configPath: join(tmpDir, 'nonexistent.yaml') });

    expect(exitSpy).toHaveBeenCalledWith(1);
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints error message for invalid name', async () => {
    const p = writeMinimalConfig();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await addChannelCommand({ name: 'bad name', type: 'telegram', configPath: p });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(errOutput).toContain('invalid');
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints error message for invalid type', async () => {
    const p = writeMinimalConfig();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await addChannelCommand({ name: 'my-chan', type: 'invalid', configPath: p });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(errOutput).toContain('Unknown channel type');
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// Synthetic setup metadata, matching signal-contracts.test.ts; not live device proof.
// signal-cli v0.14.9 / 3997429779095ff3a2d64c877126e84fce9852aa:
// src/main/java/org/asamk/signal/commands/ListDevicesCommand.java:47-67 and
// lib/src/main/java/org/asamk/signal/manager/internal/ManagerImpl.java:483-504.
// Only standalone plain output marks the current device; JSON supplies creation time.
const accountUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const peerUuid = 'cccccccc-1111-2222-3333-dddddddddddd';
const signalConfig = {
  accountMode: 'personal',
  socketPath: '/run/signal/bridge.sock',
  account: accountUuid,
  accountUuid,
  deviceId: 3,
  deviceCreatedTimestamp: 200,
};

function signalOptions(p: string, config: unknown = signalConfig, showToolCalls?: boolean): AddChannelOptions {
  return { name: 'signal-personal', type: 'signal', configPath: p, signalConfig: config, showToolCalls };
}

describe('addChannel() Signal canonical admission', () => {
  it.each(['personal', 'dedicated'])('admits a named %s instance using canonical defaults', async (accountMode) => {
    const p = writeMinimalConfig();
    const input = { ...signalConfig, accountMode };
    const entry = await addChannel(signalOptions(p, input));
    expect(entry).toEqual({
      name: 'signal-personal', type: 'signal', enabled: true,
      config: SignalConfigSchema.parse(input),
    });
    expect(entry.config).toMatchObject({
      allowedDmPeers: [], allowedSenders: [], allowedGroups: [], triggerPrefix: '!talon',
      requestTimeoutMs: 30_000, reconnectBaseMs: 1_000, reconnectMaxMs: 60_000,
    });
    expect((await readConfig(p)).channels).toEqual([entry]);
    // CLI admission does not create/probe the configured bridge socket or provision anything.
    expect(await fs.readdir(tmpDir)).toEqual(['talond.yaml']);
  });

  it('normalizes and deduplicates identities and strips unsupported extras exactly like the daemon', async () => {
    const p = writeMinimalConfig();
    const input = {
      ...signalConfig, account: accountUuid.toUpperCase(), accountUuid: accountUuid.toUpperCase(),
      allowedDmPeers: [peerUuid, peerUuid.toUpperCase()],
      allowedSenders: [peerUuid.toUpperCase(), peerUuid], allowedGroups: ['+/8=', '+/8='],
      botToken: 'PRIVATE_TOKEN', pollingTimeoutSec: 10, showToolCalls: true,
      PRIVATE_DYNAMIC_KEY: { body: 'PRIVATE_BODY' },
    };
    const entry = await addChannel(signalOptions(p, input));
    expect(entry.config).toEqual(SignalConfigSchema.parse(input));
    expect(entry.config).toMatchObject({
      account: accountUuid, accountUuid, allowedDmPeers: [peerUuid],
      allowedSenders: [peerUuid], allowedGroups: ['+/8='],
    });
    expect(readFileSync(p, 'utf-8')).not.toMatch(/PRIVATE_|botToken|pollingTimeoutSec|showToolCalls/);
  });

  it.each([
    { requestTimeoutMs: 1_000, reconnectBaseMs: 100, reconnectMaxMs: 100 },
    { requestTimeoutMs: 120_000, reconnectBaseMs: 60_000, reconnectMaxMs: 300_000 },
  ])('admits inclusive timing bounds: %j', async (bounds) => {
    const p = writeMinimalConfig();
    const input = { ...signalConfig, ...bounds, triggerPrefix: '!ask' };
    expect((await addChannel(signalOptions(p, input))).config).toEqual(SignalConfigSchema.parse(input));
  });

  it('admits dedicated primary device and E.164 selector without inventing creation metadata', async () => {
    // Pinned ListAccountsCommand.java:33-47: number/aci, not device/registration flags.
    const p = writeMinimalConfig();
    const input = {
      ...signalConfig, accountMode: 'dedicated', account: '+12025550123',
      deviceId: 1, deviceCreatedTimestamp: undefined,
    };
    const entry = await addChannel(signalOptions(p, input, true));
    expect(entry.config).toEqual(SignalConfigSchema.parse(input));
    expect(readYaml(p).channels).toEqual([{ ...entry, config: { ...entry.config } }]);
    expect(entry.config.deviceCreatedTimestamp).toBeUndefined();
    expect(entry).toHaveProperty('showToolCalls', true);
  });

  it.each([
    { accountMode: undefined }, { accountMode: 'bot' }, { socketPath: undefined },
    { socketPath: 'relative.sock' }, { socketPath: '/run/a\0.sock' },
    { account: undefined }, { account: 'PRIVATE_ACCOUNT' }, { account: '+0123' },
    { account: ` ${accountUuid}` }, { account: `PNI:${accountUuid}` }, { account: peerUuid },
    { accountUuid: undefined }, { accountUuid: `{${accountUuid}}` },
    { deviceId: undefined }, { deviceId: 0 }, { deviceId: 1 }, { deviceId: 1.2 },
    { deviceId: Number.MAX_SAFE_INTEGER + 1 },
    { deviceCreatedTimestamp: undefined }, { deviceCreatedTimestamp: 0 },
    { deviceCreatedTimestamp: -1 }, { deviceCreatedTimestamp: 1.5 },
    { deviceCreatedTimestamp: Number.MAX_SAFE_INTEGER + 1 },
    { allowedDmPeers: ['+12025550123'] }, { allowedSenders: ['PRIVATE_SENDER'] },
    { allowedSenders: [`PNI:${peerUuid}`] }, { allowedGroups: ['-_8'] },
    { allowedGroups: ['+/8'] }, { allowedGroups: [' +/8='] }, { allowedGroups: ['AB=='] },
    { triggerPrefix: '' }, { triggerPrefix: '  ' },
    { requestTimeoutMs: 999 }, { requestTimeoutMs: 120_001 }, { requestTimeoutMs: 1_000.1 },
    { reconnectBaseMs: 99 }, { reconnectBaseMs: 60_001 },
    { reconnectMaxMs: 99 }, { reconnectMaxMs: 300_001 },
    { reconnectBaseMs: 2_000, reconnectMaxMs: 1_000 },
  ])('rejects unsafe fields without mutation or diagnostic leakage: %j', async (change) => {
    const p = writeMinimalConfig();
    const before = readFileSync(p);
    const input = { ...signalConfig, ...change, PRIVATE_DYNAMIC_KEY: 'PRIVATE_BODY_TOKEN' };
    expect(SignalConfigSchema.safeParse(input).success).toBe(false);
    await expect(addChannel(signalOptions(p, input))).rejects.toMatchObject({
      name: 'ConfigError', code: 'CONFIG_ERROR', message: 'Invalid Signal configuration', cause: undefined,
    });
    expect(readFileSync(p)).toEqual(before);
    expect(await fs.readdir(tmpDir)).toEqual(['talond.yaml']);
  });

  it.each([undefined, null, {}, 'PRIVATE_BODY_TOKEN', []])('refuses absent or malformed operator config: %j', async (input) => {
    const p = writeMinimalConfig();
    const before = readFileSync(p);
    const options = { ...signalOptions(p), signalConfig: input };
    await expect(addChannel(options)).rejects.toBeInstanceOf(ConfigError);
    expect(readFileSync(p)).toEqual(before);
    expect(await fs.readdir(tmpDir)).toEqual(['talond.yaml']);
  });

  it('enforces the canonical personal channel-level showToolCalls restriction', async () => {
    const p = writeMinimalConfig();
    const before = readFileSync(p);
    expect(ChannelConfigSchema.safeParse({ name: 'signal-personal', type: 'signal', config: signalConfig, showToolCalls: true }).success).toBe(false);
    await expect(addChannel(signalOptions(p, signalConfig, true))).rejects.toBeInstanceOf(ConfigError);
    expect(readFileSync(p)).toEqual(before);
    const entry = await addChannel(signalOptions(p, signalConfig, false));
    expect(entry).toHaveProperty('showToolCalls', false);
  });

  it('keeps duplicate-name precedence and leaves unrelated YAML data intact', async () => {
    const p = writeYaml('logLevel: debug\ncustom:\n  untouched: [one, two]\nchannels:\n  - name: existing\n    type: slack\n    config:\n      secret: PRIVATE_EXISTING_TOKEN\nbindings:\n  - channel: existing\n    persona: helper\n');
    const original = await readConfig(p);
    const entry = await addChannel(signalOptions(p));
    expect(await readConfig(p)).toEqual({ ...original, channels: [...(original.channels ?? []), entry] });
    const beforeDuplicate = readFileSync(p);
    await expect(addChannel({ ...signalOptions(p), signalConfig: undefined })).rejects.toThrow(/already exists/);
    expect(readFileSync(p)).toEqual(beforeDuplicate);
    await expect(addChannel({ ...signalOptions(p), name: 'existing' })).rejects.toThrow(/already exists/);
    expect(readFileSync(p)).toEqual(beforeDuplicate);
  });

  it('requires an existing YAML config and never creates a missing file', async () => {
    const p = configPath();
    await expect(addChannel(signalOptions(p))).rejects.toThrow(/not found/);
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it('refuses a Signal placeholder rather than fabricating operator/device values', () => {
    expect(() => buildPlaceholderConfig('signal')).toThrow(ConfigError);
  });

  it('confirms Signal admission without printing setup identities or claiming runtime readiness', async () => {
    const p = writeMinimalConfig();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await addChannelCommand(signalOptions(p));
      expect(logSpy.mock.calls).toEqual([
        [`Added channel "signal-personal" (type: signal) to "${p}".`],
        ['Signal configuration validated; runtime socket/account/device verification is still required.'],
      ]);
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).not.toContain(accountUuid);
      expect(output).not.toContain(signalConfig.socketPath);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('prints only safe validation failure through the actual CLI wrapper', async () => {
    const p = writeMinimalConfig();
    const before = readFileSync(p);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      await addChannelCommand(signalOptions(p, { ...signalConfig, account: 'PRIVATE_ACCOUNT', PRIVATE_DYNAMIC_KEY: 'PRIVATE_BODY_TOKEN' }));
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy.mock.calls).toEqual([['Error: Invalid Signal configuration']]);
      expect(logSpy).not.toHaveBeenCalled();
      expect(readFileSync(p)).toEqual(before);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('addChannel() Signal I/O privacy', () => {
  it('sanitizes actual YAML parser failures without leaking source text or paths', async () => {
    const p = writeYaml('PRIVATE_EXISTING_TOKEN: [PRIVATE_BODY\n');
    const before = readFileSync(p);
    await expect(addChannel(signalOptions(p))).rejects.toMatchObject({
      name: 'ConfigError', code: 'CONFIG_ERROR',
      message: 'Signal config file not found, unreadable, or invalid YAML', cause: undefined,
    });
    expect(readFileSync(p)).toEqual(before);
    expect(await fs.readdir(tmpDir)).toEqual(['talond.yaml']);
  });

  it('sanitizes actual unreadable-file failures and missing private file paths', async () => {
    const directory = join(tmpDir, 'PRIVATE_ACCOUNT');
    await fs.mkdir(directory);
    for (const p of [directory, join(tmpDir, 'PRIVATE_BODY_TOKEN.yaml')]) {
      await expect(addChannel(signalOptions(p))).rejects.toMatchObject({
        name: 'ConfigError', code: 'CONFIG_ERROR',
        message: 'Signal config file not found, unreadable, or invalid YAML', cause: undefined,
      });
    }
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('omits paths from duplicate Signal errors while preserving duplicate precedence', async () => {
    const p = writeYaml('channels:\n  - name: signal-personal\n    type: telegram\n');
    const before = readFileSync(p);
    await expect(addChannel({ ...signalOptions(p), signalConfig: undefined })).rejects.toMatchObject({
      name: 'ConfigError', code: 'CONFIG_ERROR',
      message: 'A channel with that name already exists. Choose a different name or edit the existing entry directly.',
      cause: undefined,
    });
    expect(readFileSync(p)).toEqual(before);
  });

  // Root bypasses fixture directory permissions; this test uses only its own disposable directory.
  it.skipIf(process.getuid?.() === 0)('sanitizes actual atomic write failure and leaves the original file byte-identical', async () => {
    const p = writeYaml('PRIVATE_EXISTING_TOKEN: PRIVATE_BODY\nchannels: []\n');
    const before = readFileSync(p);
    await fs.chmod(tmpDir, 0o500);
    try {
      await expect(addChannel(signalOptions(p))).rejects.toMatchObject({
        name: 'ConfigError', code: 'CONFIG_ERROR', message: 'Unable to write Signal config file', cause: undefined,
      });
      expect(readFileSync(p)).toEqual(before);
      expect(await fs.readdir(tmpDir)).toEqual(['talond.yaml']);
    } finally {
      await fs.chmod(tmpDir, 0o700);
    }
  });

  it('retains ordinary-channel parser and missing-file error semantics', async () => {
    const p = writeYaml('bad: [\n');
    await expect(addChannel({ name: 'ordinary', type: 'telegram', configPath: p })).rejects.toThrow(/Error parsing YAML/);
    await expect(addChannel({ name: 'ordinary', type: 'telegram', configPath: join(tmpDir, 'missing.yaml') })).rejects.toThrow(/not found.*talonctl setup/);
  });

  it('never prints raw YAML parser causes through the Signal CLI wrapper', async () => {
    const p = writeYaml('PRIVATE_EXISTING_TOKEN: [PRIVATE_BODY\n');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      await addChannelCommand(signalOptions(p));
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy.mock.calls).toEqual([['Error: Signal config file not found, unreadable, or invalid YAML']]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('Signal admission mode and compatibility controls', () => {
  it.each([
    { account: peerUuid }, { deviceId: 0 }, { deviceCreatedTimestamp: 0 },
    { allowedDmPeers: ['PRIVATE_PEER'] }, { triggerPrefix: '' },
    { requestTimeoutMs: 999 }, { reconnectBaseMs: 2_000, reconnectMaxMs: 1_000 },
  ])('rejects invalid dedicated configuration too: %j', async (change) => {
    const p = writeMinimalConfig();
    const before = readFileSync(p);
    const input = { ...signalConfig, accountMode: 'dedicated', deviceId: 1, ...change };
    expect(SignalConfigSchema.safeParse(input).success).toBe(false);
    await expect(addChannel(signalOptions(p, input))).rejects.toBeInstanceOf(ConfigError);
    expect(readFileSync(p)).toEqual(before);
    expect(await fs.readdir(tmpDir)).toEqual(['talond.yaml']);
  });

  it('retains explicitly empty policies and permits independently named instances', async () => {
    const p = writeMinimalConfig();
    const first = await addChannel(signalOptions(p, {
      ...signalConfig, account: '+12025550123',
      allowedDmPeers: [], allowedSenders: [], allowedGroups: [],
    }));
    const second = await addChannel({ ...signalOptions(p, {
      ...signalConfig, account: peerUuid, accountUuid: peerUuid,
      accountMode: 'dedicated', deviceId: Number.MAX_SAFE_INTEGER,
      deviceCreatedTimestamp: Number.MAX_SAFE_INTEGER,
    }), name: 'signal-dedicated' });
    expect(first.config).toMatchObject({ allowedDmPeers: [], allowedSenders: [], allowedGroups: [] });
    expect((await readConfig(p)).channels).toEqual([first, second]);
  });

  it.each(['PRIVATE_BODY_TOKEN', '- PRIVATE_BODY_TOKEN\n'])('refuses a non-document YAML root without leaking its contents: %s', async (content) => {
    const p = writeYaml(content);
    const before = readFileSync(p);
    await expect(addChannel(signalOptions(p))).rejects.toMatchObject({
      name: 'ConfigError', code: 'CONFIG_ERROR',
      message: 'Signal config file not found, unreadable, or invalid YAML', cause: undefined,
    });
    expect(readFileSync(p)).toEqual(before);
    expect(await fs.readdir(tmpDir)).toEqual(['talond.yaml']);
  });

  it.each([
    ['telegram', { botToken: '${TELEGRAM_BOT_TOKEN}', pollingTimeoutSec: 30 }],
    ['slack', { botToken: '${SLACK_BOT_TOKEN}', appToken: '${SLACK_APP_TOKEN}', signingSecret: '${SLACK_SIGNING_SECRET}' }],
    ['discord', { botToken: '${DISCORD_BOT_TOKEN}', applicationId: 'YOUR_APPLICATION_ID' }],
    ...['whatsapp', 'whatsappBusiness'].map((type) => [type, {
      phoneNumberId: 'YOUR_PHONE_NUMBER_ID', accessToken: '${WHATSAPP_ACCESS_TOKEN}',
      verifyToken: '${WHATSAPP_VERIFY_TOKEN}', appSecret: '${WHATSAPP_APP_SECRET}',
    }] as const),
    ['whatsappBaileys', { authDir: './baileys-auth', selfChat: false, triggerWords: [] }],
    ['email', {
      imapHost: 'imap.gmail.com', imapPort: 993, imapUser: 'bot@gmail.com', imapPass: '${EMAIL_PASSWORD}', imapSecure: true,
      smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpUser: 'bot@gmail.com', smtpPass: '${EMAIL_PASSWORD}', smtpSecure: false,
      fromAddress: 'Talon <bot@gmail.com>',
    }],
    ['terminal', { port: 8089, host: '127.0.0.1', token: '${TERMINAL_TOKEN}' }],
  ] as const)('preserves the full ordinary %s placeholder and unrelated YAML fields', async (type, config) => {
    const p = writeYaml('custom: untouched\nchannels: []\n');
    const entry = await addChannel({ name: 'ordinary', type, configPath: p });
    expect(entry).toEqual({ name: 'ordinary', type, enabled: true, config });
    expect(await readConfig(p)).toEqual({ custom: 'untouched', channels: [entry] });
  });
});

const objectScalarYamlRoots = [
  { kind: 'timestamp', content: '2026-01-01\n', constructor: Date },
  { kind: 'binary', content: '!!binary UFJJVkFURV9CT0RZX1RPS0VO\n', constructor: Uint8Array },
];

describe('Signal admission requires a plain YAML mapping (F4)', () => {
  it.each(objectScalarYamlRoots)('rejects an actual $kind root before writing', async (root) => {
    const p = writeYaml(root.content);
    const before = readFileSync(p);
    expect(await readConfig(p)).toBeInstanceOf(root.constructor);

    const admission = addChannel(signalOptions(p));
    await expect(admission).rejects.toBeInstanceOf(ConfigError);
    await expect(admission).rejects.toMatchObject({
      name: 'ConfigError', code: 'CONFIG_ERROR',
      message: 'Signal config file not found, unreadable, or invalid YAML', cause: undefined,
    });
    expect(readFileSync(p)).toEqual(before);
    expect(await fs.readdir(tmpDir)).toEqual(['talond.yaml']);
  });

  it.each(objectScalarYamlRoots)('never prints success for an actual $kind root', async (root) => {
    const p = writeYaml(root.content);
    const before = readFileSync(p);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      await addChannelCommand(signalOptions(p));
      expect(logSpy).not.toHaveBeenCalled();
      expect(exitSpy.mock.calls).toEqual([[1]]);
      expect(errorSpy.mock.calls).toEqual([['Error: Signal config file not found, unreadable, or invalid YAML']]);
      expect(readFileSync(p)).toEqual(before);
      expect(await fs.readdir(tmpDir)).toEqual(['talond.yaml']);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each(['', 'null\n', '~\n', '{}\n', 'channels: []\n'])('preserves empty/null/mapping root handling for Signal and ordinary channels: %j', async (content) => {
    for (const type of ['signal', 'telegram']) {
      const p = writeYaml(content);
      const entry = await addChannel({ ...signalOptions(p), type });
      expect(entry.config).toEqual(type === 'signal'
        ? SignalConfigSchema.parse(signalConfig)
        : { botToken: '${TELEGRAM_BOT_TOKEN}', pollingTimeoutSec: 30 });
      expect((await readConfig(p)).channels).toEqual([entry]);
      expect(await fs.readdir(tmpDir)).toEqual(['talond.yaml']);
    }
  });

  it.each(['signal', 'telegram'])('preserves nested timestamp and binary data in a plain mapping for %s', async (type) => {
    const p = writeYaml('custom:\n  created: 2026-01-01\n  bytes: !!binary UFJJVkFURV9CT0RZX1RPS0VO\nchannels: []\n');
    const original = await readConfig(p);
    const entry = await addChannel({ ...signalOptions(p), type });
    expect(await readConfig(p)).toEqual({ ...original, channels: [entry] });
    if (type === 'signal') {
      expect(entry.config).toEqual(SignalConfigSchema.parse(signalConfig));
    } else {
      expect(entry.config).toEqual({ botToken: '${TELEGRAM_BOT_TOKEN}', pollingTimeoutSec: 30 });
    }
    expect(await fs.readdir(tmpDir)).toEqual(['talond.yaml']);
  });
});
