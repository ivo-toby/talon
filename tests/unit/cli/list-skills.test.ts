import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listSkills } from '../../../src/cli/commands/list-skills.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-list-skills-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function writeYaml(content: string): string {
  const p = join(tmpDir, 'talond.yaml');
  writeFileSync(p, content);
  return p;
}

describe('listSkills()', () => {
  it('returns empty array when no personas configured', async () => {
    const p = writeYaml('logLevel: info\n');
    const result = await listSkills({ configPath: p });
    expect(result).toEqual([]);
  });

  it('returns all skills across personas', async () => {
    const p = writeYaml('personas:\n  - name: assistant\n    skills:\n      - web-search\n  - name: coder\n    skills:\n      - code-runner\n');
    const result = await listSkills({ configPath: p });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ personaName: 'assistant', skillName: 'web-search' });
    expect(result[1]).toMatchObject({ personaName: 'coder', skillName: 'code-runner' });
    expect(['unknown', 'yaml', 'skillmd']).toContain(result[0].format);
    expect(['unknown', 'yaml', 'skillmd']).toContain(result[1].format);
  });

  it('filters by persona name', async () => {
    const p = writeYaml('personas:\n  - name: assistant\n    skills:\n      - web-search\n  - name: coder\n    skills:\n      - code-runner\n');
    const result = await listSkills({ configPath: p, personaName: 'coder' });

    expect(result).toHaveLength(1);
    expect(result[0]!.skillName).toBe('code-runner');
  });

  it('throws when persona not found', async () => {
    const p = writeYaml('personas:\n  - name: assistant\n    skills: []\n');
    await expect(listSkills({ configPath: p, personaName: 'nope' }))
      .rejects.toThrow(/not found/);
  });
});
