import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

import { setCapabilities } from '../../../src/cli/commands/set-capabilities.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-set-caps-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function configPath(): string {
  return join(tmpDir, 'talond.yaml');
}

function writeConfig(personas: Array<{ name: string; capabilities?: { allow?: string[]; requireApproval?: string[] } }>): string {
  const p = configPath();
  const doc = { personas: personas.map((per) => ({ ...per, model: 'claude-sonnet-4-6' })) };
  writeFileSync(p, yaml.dump(doc));
  return p;
}

function readCaps(p: string, personaName: string): { allow: string[]; requireApproval: string[] } {
  const doc = yaml.load(readFileSync(p, 'utf-8')) as Record<string, unknown>;
  const personas = doc.personas as Array<{ name: string; capabilities: { allow: string[]; requireApproval: string[] } }>;
  return personas.find((per) => per.name === personaName)!.capabilities;
}

describe('setCapabilities()', () => {
  it('replaces allow list with --allow', async () => {
    const p = writeConfig([{ name: 'james', capabilities: { allow: ['old.cap:x'], requireApproval: [] } }]);

    await setCapabilities({ persona: 'james', allow: 'memory.access:thread,net.http:egress', configPath: p });

    const caps = readCaps(p, 'james');
    expect(caps.allow).toEqual(['memory.access:thread', 'net.http:egress']);
  });

  it('adds capabilities with --add', async () => {
    const p = writeConfig([{ name: 'james', capabilities: { allow: ['memory.access:thread'], requireApproval: [] } }]);

    await setCapabilities({ persona: 'james', add: 'net.http:egress', configPath: p });

    const caps = readCaps(p, 'james');
    expect(caps.allow).toContain('memory.access:thread');
    expect(caps.allow).toContain('net.http:egress');
  });

  it('does not add duplicates with --add', async () => {
    const p = writeConfig([{ name: 'james', capabilities: { allow: ['memory.access:thread'], requireApproval: [] } }]);

    await setCapabilities({ persona: 'james', add: 'memory.access:thread', configPath: p });

    const caps = readCaps(p, 'james');
    expect(caps.allow).toEqual(['memory.access:thread']);
  });

  it('removes capabilities with --remove', async () => {
    const p = writeConfig([{ name: 'james', capabilities: { allow: ['memory.access:thread', 'net.http:egress'], requireApproval: [] } }]);

    await setCapabilities({ persona: 'james', remove: 'net.http:egress', configPath: p });

    const caps = readCaps(p, 'james');
    expect(caps.allow).toEqual(['memory.access:thread']);
  });

  it('replaces requireApproval with --requireApproval', async () => {
    const p = writeConfig([{ name: 'james', capabilities: { allow: [], requireApproval: [] } }]);

    await setCapabilities({ persona: 'james', requireApproval: 'channel.send:*', configPath: p });

    const caps = readCaps(p, 'james');
    expect(caps.requireApproval).toEqual(['channel.send:*']);
  });

  it('throws when --allow and --add are both provided', async () => {
    const p = writeConfig([{ name: 'james' }]);

    await expect(setCapabilities({ persona: 'james', allow: 'a', add: 'b', configPath: p }))
      .rejects.toThrow(/mutually exclusive/);
  });

  it('throws when persona not found', async () => {
    const p = writeConfig([{ name: 'james' }]);

    await expect(setCapabilities({ persona: 'nobody', allow: 'a', configPath: p }))
      .rejects.toThrow(/not found/);
  });

  it('returns current capabilities with --show', async () => {
    const p = writeConfig([{ name: 'james', capabilities: { allow: ['memory.access:thread'], requireApproval: ['channel.send:*'] } }]);

    const result = await setCapabilities({ persona: 'james', show: true, configPath: p });

    expect(result.allow).toEqual(['memory.access:thread']);
    expect(result.requireApproval).toEqual(['channel.send:*']);
  });
});
