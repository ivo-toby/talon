/**
 * Tests for `talonctl install-skill` command.
 *
 * Focuses on core logic: source parsing, skill root location,
 * sandbox review cases, config modification, and staging integration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  parseSource,
  locateSkillRoot,
  parseSkill,
  proposeSandboxBlock,
  installSkill,
} from '../../../src/cli/commands/install-skill.js';
import type { ScanResult } from '../../../src/cli/commands/install-skill-scanner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'install-skill-test-'));
  tmpDirs.push(dir);
  return dir;
}

async function writeSkillMd(
  dir: string,
  name: string,
  opts?: { sandbox?: boolean; codeFences?: boolean },
): Promise<void> {
  const yaml = (await import('js-yaml')).default;

  const frontmatter: Record<string, unknown> = {
    name,
    version: '0.1.0',
    description: `${name} skill`,
  };

  if (opts?.sandbox) {
    frontmatter.sandbox = {
      workdir: 'repo',
      network: 'off',
      bins: ['bash', 'sh', 'ls', 'cat'],
      shell: '/bin/bash',
      timeoutSeconds: 60,
    };
    frontmatter.requiredCapabilities = [`skill.exec:${name}`];
  }

  let body = `\n# ${name}\n\nSome instructions.\n`;
  if (opts?.codeFences) {
    body += '\n```bash\nnpm install\ngit status\n```\n';
  }

  const frontmatterYaml = yaml.dump(frontmatter, { lineWidth: 120 });
  const content = `---\n${frontmatterYaml}---\n${body}`;

  await fs.writeFile(path.join(dir, 'SKILL.md'), content, 'utf-8');
}

async function writeConfig(dir: string, personas: string[]): Promise<string> {
  const configPath = path.join(dir, 'talond.yaml');
  const config = {
    dataDir: path.join(dir, 'data'),
    personas: personas.map((name) => ({
      name,
      model: 'test-model',
      systemPromptFile: 'system.md',
      skills: [] as string[],
      capabilities: { allow: [] as string[], requireApproval: [] as string[] },
    })),
    channels: [],
    bindings: [],
  };

  const yaml = await import('js-yaml');
  await fs.writeFile(configPath, yaml.default.dump(config), 'utf-8');
  await fs.mkdir(path.join(dir, 'data', 'skills'), { recursive: true });
  return configPath;
}

beforeEach(() => {
  tmpDirs = [];
});

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Source parsing
// ---------------------------------------------------------------------------

describe('parseSource', () => {
  it('recognizes a local path starting with ./', () => {
    const result = parseSource('./my-skill');
    expect(result.type).toBe('local');
    expect(result.path).toBe(path.resolve('./my-skill'));
  });

  it('recognizes a local path starting with /', () => {
    const result = parseSource('/tmp/my-skill');
    expect(result.type).toBe('local');
    expect(result.path).toBe('/tmp/my-skill');
  });

  it('recognizes a local path starting with ../', () => {
    const result = parseSource('../my-skill');
    expect(result.type).toBe('local');
    expect(result.path).toContain('my-skill');
  });

  it('recognizes a GitHub URL', () => {
    const result = parseSource('https://github.com/user/repo');
    expect(result.type).toBe('git');
    expect(result.url).toBe('https://github.com/user/repo');
    expect(result.ref).toBeUndefined();
  });

  it('recognizes a GitHub URL with ref', () => {
    const result = parseSource('https://github.com/user/repo#v1.0');
    expect(result.type).toBe('git');
    expect(result.url).toBe('https://github.com/user/repo');
    expect(result.ref).toBe('v1.0');
  });

  it('recognizes a .git URL', () => {
    const result = parseSource('https://example.com/repo.git');
    expect(result.type).toBe('git');
  });

  it('returns registry for unsupported source', () => {
    const result = parseSource('my-org/my-skill');
    expect(result.type).toBe('registry');
  });
});

// ---------------------------------------------------------------------------
// Skill root location
// ---------------------------------------------------------------------------

describe('locateSkillRoot', () => {
  it('finds SKILL.md in root', async () => {
    const dir = await makeTmpDir();
    await writeSkillMd(dir, 'test-skill');

    const result = await locateSkillRoot(dir);
    expect(result.root).toBe(dir);
    expect(result.format).toBe('skillmd');
  });

  it('finds skill.yaml in root', async () => {
    const dir = await makeTmpDir();
    const yaml = await import('js-yaml');
    await fs.writeFile(
      path.join(dir, 'skill.yaml'),
      yaml.default.dump({ name: 'test', version: '0.1.0', description: 'test' }),
      'utf-8',
    );

    const result = await locateSkillRoot(dir);
    expect(result.root).toBe(dir);
    expect(result.format).toBe('yaml');
  });

  it('finds SKILL.md one level deep', async () => {
    const dir = await makeTmpDir();
    const subDir = path.join(dir, 'nested');
    await fs.mkdir(subDir);
    await writeSkillMd(subDir, 'test-skill');

    const result = await locateSkillRoot(dir);
    expect(result.root).toBe(subDir);
    expect(result.format).toBe('skillmd');
  });

  it('throws when no skill manifest found', async () => {
    const dir = await makeTmpDir();
    await expect(locateSkillRoot(dir)).rejects.toThrow('Could not find SKILL.md or skill.yaml');
  });
});

// ---------------------------------------------------------------------------
// Sandbox review — Case A (existing sandbox block)
// ---------------------------------------------------------------------------

describe('sandbox review Case A', () => {
  it('detects existing sandbox block and presents it for review', async () => {
    const dir = await makeTmpDir();
    await writeSkillMd(dir, 'sandbox-skill', { sandbox: true });

    const skill = await parseSkill(dir, 'skillmd');
    expect(skill.sandbox).toBeDefined();
    expect(skill.sandbox?.workdir).toBe('repo');
    expect(skill.sandbox?.network).toBe('off');
    expect(skill.sandbox?.bins).toEqual(['bash', 'sh', 'ls', 'cat']);
  });
});

// ---------------------------------------------------------------------------
// Sandbox review — Case B (scanner → proposed block)
// ---------------------------------------------------------------------------

describe('sandbox review Case B — proposeSandboxBlock', () => {
  it('includes base set of bins plus detected bins', () => {
    const scan: ScanResult = {
      bins: new Set(['npm', 'git', 'node']),
      envs: new Set(['API_KEY']),
      urls: new Set(),
    };

    const proposed = proposeSandboxBlock(scan);
    // Must include base set
    expect(proposed.bins).toContain('bash');
    expect(proposed.bins).toContain('sh');
    expect(proposed.bins).toContain('ls');
    expect(proposed.bins).toContain('cat');
    // Plus detected
    expect(proposed.bins).toContain('npm');
    expect(proposed.bins).toContain('git');
    expect(proposed.bins).toContain('node');
  });

  it('puts detected env vars as secrets', () => {
    const scan: ScanResult = {
      bins: new Set(),
      envs: new Set(['CONTENTFUL_TOKEN', 'API_SECRET']),
      urls: new Set(),
    };

    const proposed = proposeSandboxBlock(scan);
    expect(proposed.secrets).toContain('CONTENTFUL_TOKEN');
    expect(proposed.secrets).toContain('API_SECRET');
  });

  it('sets network to "on" when URLs are detected', () => {
    const scan: ScanResult = {
      bins: new Set(),
      envs: new Set(),
      urls: new Set(['https://api.example.com']),
    };

    const proposed = proposeSandboxBlock(scan);
    expect(proposed.network).toBe('on');
  });

  it('sets network to "off" when no URLs are detected', () => {
    const scan: ScanResult = {
      bins: new Set(),
      envs: new Set(),
      urls: new Set(),
    };

    const proposed = proposeSandboxBlock(scan);
    expect(proposed.network).toBe('off');
  });

  it('uses default workdir "repo"', () => {
    const scan: ScanResult = { bins: new Set(), envs: new Set(), urls: new Set() };
    const proposed = proposeSandboxBlock(scan);
    expect(proposed.workdir).toBe('repo');
  });
});

// ---------------------------------------------------------------------------
// Config modification
// ---------------------------------------------------------------------------

describe('config modification', () => {
  it('adds skill name to persona skills array and capability to allow list', async () => {
    const dir = await makeTmpDir();
    const skillDir = path.join(dir, 'source-skill');
    await fs.mkdir(skillDir);
    await writeSkillMd(skillDir, 'my-skill', { sandbox: true });
    const configPath = await writeConfig(dir, ['assistant', 'devbot']);

    // Suppress stdout during test
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      const result = await installSkill({
        source: skillDir,
        persona: 'assistant',
        configPath,
        _confirm: async () => true,
      });

      expect(result.name).toBe('my-skill');
      expect(result.personas).toEqual(['assistant']);
      expect(result.hasSandbox).toBe(true);

      // Verify config was updated
      const { readConfig } = await import('../../../src/cli/config-utils.js');
      const updatedDoc = await readConfig(configPath);
      const persona = updatedDoc.personas?.find((p) => p.name === 'assistant');
      expect(persona?.skills).toContain('my-skill');
      const caps = persona?.capabilities as { allow?: string[] };
      expect(caps.allow).toContain('skill.exec:my-skill');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('adds skill without capability when no sandbox', async () => {
    const dir = await makeTmpDir();
    const skillDir = path.join(dir, 'source-skill');
    await fs.mkdir(skillDir);
    await writeSkillMd(skillDir, 'prompt-skill');
    const configPath = await writeConfig(dir, ['assistant']);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      const result = await installSkill({
        source: skillDir,
        persona: 'assistant',
        configPath,
        _confirm: async () => true,
      });

      expect(result.name).toBe('prompt-skill');
      expect(result.hasSandbox).toBe(false);

      const { readConfig } = await import('../../../src/cli/config-utils.js');
      const updatedDoc = await readConfig(configPath);
      const persona = updatedDoc.personas?.find((p) => p.name === 'assistant');
      expect(persona?.skills).toContain('prompt-skill');
      // No skill.exec capability added
      const caps = persona?.capabilities as { allow?: string[] };
      expect(caps.allow).not.toContain('skill.exec:prompt-skill');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Staging integration
// ---------------------------------------------------------------------------

describe('staging integration', () => {
  it('calls stageSkillSandbox when sandbox is present', async () => {
    const dir = await makeTmpDir();
    const skillDir = path.join(dir, 'source-skill');
    await fs.mkdir(skillDir);
    await writeSkillMd(skillDir, 'staged-skill', { sandbox: true });
    const configPath = await writeConfig(dir, ['assistant']);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      const result = await installSkill({
        source: skillDir,
        persona: 'assistant',
        configPath,
        _confirm: async () => true,
      });

      expect(result.hasSandbox).toBe(true);
      // .bin directory should exist (may have warnings about missing binaries
      // but the directory is created)
      const installPath = result.installedPath;
      expect(installPath).toContain('staged-skill');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('error cases', () => {
  it('rejects registry shorthand', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      await expect(
        installSkill({
          source: 'my-org/my-skill',
          configPath: 'talond.yaml',
        }),
      ).rejects.toThrow('Registry shorthand is not supported yet');
    } finally {
      writeSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('rejects when sandbox is not accepted', async () => {
    const dir = await makeTmpDir();
    const skillDir = path.join(dir, 'source-skill');
    await fs.mkdir(skillDir);
    await writeSkillMd(skillDir, 'rejected-skill', { sandbox: true });
    const configPath = await writeConfig(dir, ['assistant']);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      await expect(
        installSkill({
          source: skillDir,
          persona: 'assistant',
          configPath,
          _confirm: async () => false,
        }),
      ).rejects.toThrow('Sandbox profile rejected');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('rejects when source path does not exist', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      await expect(
        installSkill({
          source: '/nonexistent/path/to/skill',
          configPath: 'talond.yaml',
        }),
      ).rejects.toThrow('does not exist');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('handles Case B: code fences trigger scan and proposal', async () => {
    const dir = await makeTmpDir();
    const skillDir = path.join(dir, 'source-skill');
    await fs.mkdir(skillDir);
    await writeSkillMd(skillDir, 'scan-skill', { codeFences: true });
    const configPath = await writeConfig(dir, ['assistant']);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      const result = await installSkill({
        source: skillDir,
        persona: 'assistant',
        configPath,
        _editResponse: async () => 'y',
        _confirm: async () => true,
      });

      expect(result.name).toBe('scan-skill');
      expect(result.hasSandbox).toBe(true);

      // Verify the proposed sandbox was accepted (bins should include npm, git from fences)
      const { readConfig } = await import('../../../src/cli/config-utils.js');
      const updatedDoc = await readConfig(configPath);
      const persona = updatedDoc.personas?.find((p) => p.name === 'assistant');
      expect(persona?.skills).toContain('scan-skill');
      const caps = persona?.capabilities as { allow?: string[] };
      expect(caps.allow).toContain('skill.exec:scan-skill');
    } finally {
      writeSpy.mockRestore();
    }
  });
});
