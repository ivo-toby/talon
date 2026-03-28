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

import { addChannel, addChannelCommand } from '../../../src/cli/commands/add-channel.js';

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
