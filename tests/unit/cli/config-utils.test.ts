import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateName, readConfig, writeConfigAtomic, type YamlDocument } from '../../../src/cli/config-utils.js';
import { SignalConfigSchema } from '../../../src/channels/connectors/signal/signal-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'talonctl-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function configPath(): string {
  return path.join(tmpDir, 'talond.yaml');
}

async function writeYaml(content: string): Promise<string> {
  const p = configPath();
  await fs.writeFile(p, content, 'utf-8');
  return p;
}

// ---------------------------------------------------------------------------
// validateName
// ---------------------------------------------------------------------------

describe('validateName', () => {
  it('accepts valid names', () => {
    expect(validateName('my-channel', 'Channel')).toBeNull();
    expect(validateName('assistant_v2', 'Persona')).toBeNull();
    expect(validateName('WebResearch', 'Skill')).toBeNull();
    expect(validateName('a', 'Channel')).toBeNull();
    expect(validateName('test-123', 'Channel')).toBeNull();
  });

  it('rejects empty names', () => {
    expect(validateName('', 'Channel')).toMatch(/must not be empty/);
    expect(validateName('  ', 'Channel')).toMatch(/must not be empty/);
  });

  it('rejects names with spaces', () => {
    expect(validateName('my channel', 'Channel')).toMatch(/invalid/);
  });

  it('rejects names with dots', () => {
    expect(validateName('my.channel', 'Channel')).toMatch(/invalid/);
  });

  it('rejects names with special chars', () => {
    expect(validateName('my@channel', 'Channel')).toMatch(/invalid/);
    expect(validateName('my/channel', 'Channel')).toMatch(/invalid/);
    expect(validateName('my:channel', 'Channel')).toMatch(/invalid/);
  });

  it('includes the resource type in error messages', () => {
    expect(validateName('', 'Persona')).toContain('Persona');
    expect(validateName('bad name', 'Skill')).toContain('Skill');
  });
});

// ---------------------------------------------------------------------------
// readConfig
// ---------------------------------------------------------------------------

describe('readConfig', () => {
  it('reads and parses a valid YAML file', async () => {
    const p = await writeYaml('channels:\n  - name: test\n    type: telegram\n');
    const doc = await readConfig(p);
    expect(doc.channels).toHaveLength(1);
    expect(doc.channels![0].name).toBe('test');
  });

  it('returns empty object for empty file', async () => {
    const p = await writeYaml('');
    const doc = await readConfig(p);
    expect(doc).toEqual({});
  });

  it('throws for non-existent file', async () => {
    await expect(readConfig(path.join(tmpDir, 'nonexistent-talond.yaml'))).rejects.toThrow(/not found/);
  });

  it('throws for invalid YAML', async () => {
    const p = await writeYaml(':\n  :\n    - [\ninvalid');
    await expect(readConfig(p)).rejects.toThrow(/Error parsing YAML/);
  });
});

// ---------------------------------------------------------------------------
// writeConfigAtomic
// ---------------------------------------------------------------------------

describe('writeConfigAtomic', () => {
  it('writes valid YAML atomically', async () => {
    const p = configPath();
    const doc: YamlDocument = { channels: [{ name: 'test', type: 'telegram' }] };
    await writeConfigAtomic(p, doc);

    expect(existsSync(p)).toBe(true);
    const content = await fs.readFile(p, 'utf-8');
    expect(content).toContain('name: test');
    expect(content).toContain('type: telegram');
  });

  it('overwrites existing file', async () => {
    const p = await writeYaml('old: content\n');
    const doc: YamlDocument = { channels: [{ name: 'new', type: 'slack' }] };
    await writeConfigAtomic(p, doc);

    const content = await fs.readFile(p, 'utf-8');
    expect(content).not.toContain('old');
    expect(content).toContain('name: new');
  });

  it('throws for unwritable path', async () => {
    await expect(
      writeConfigAtomic(path.join(tmpDir, 'nonexistent-dir', 'talond.yaml'), {}),
    ).rejects.toThrow(/Error writing/);
  });
});

// Config I/O remains schema-neutral: actual admission belongs to addChannel/config load.
describe('Signal YAML config I/O', () => {
  it('preserves canonical default-deny Signal config and unrelated document fields', async () => {
    const p = await writeYaml('custom:\n  keep: [one, two]\nchannels: []\n');
    const original = await readConfig(p);
    const config = SignalConfigSchema.parse({
      accountMode: 'dedicated', socketPath: '/run/signal/bridge.sock',
      account: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
      accountUuid: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb', deviceId: 1,
      allowedDmPeers: [], allowedGroups: [], allowedSenders: [],
    });
    const doc: YamlDocument = {
      ...original, channels: [{ name: 'signal-dedicated', type: 'signal', enabled: true, config }],
    };
    await writeConfigAtomic(p, doc);
    expect(await readConfig(p)).toEqual(doc);
    expect((await readConfig(p)).channels?.[0]?.config).toMatchObject({
      allowedDmPeers: [], allowedGroups: [], allowedSenders: [],
    });
    expect(await fs.readdir(tmpDir)).toEqual(['talond.yaml']);
  });
});
