/**
 * Unit tests for the `talonctl import-plugin` command.
 *
 * Tests the pure functions: readInstalledPlugins, extractShortName,
 * resolvePlugin, scanPlugin, listImportablePlugins, and importPlugin.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readInstalledPlugins,
  extractShortName,
  resolvePlugin,
  validateInstallPath,
  scanPlugin,
  listImportablePlugins,
  importPlugin,
} from '../../../src/cli/commands/import-plugin.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-import-plugin-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** The cc-plugins dir for this test run, created lazily. */
function ccPluginsDir(): string {
  return join(tmpDir, 'cc-plugins');
}

/** Build a plugin install path that is under the ccPluginsDir (required by path validation). */
function pluginInstallPath(name: string): string {
  return join(ccPluginsDir(), 'cache', name);
}

/** Write a minimal installed_plugins.json. */
function writePluginIndex(
  plugins: Record<string, Array<{ installPath: string; version: string; lastUpdated: string; scope?: string }>>,
): string {
  const ccDir = ccPluginsDir();
  mkdirSync(ccDir, { recursive: true });
  writeFileSync(
    join(ccDir, 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins }, null, 2),
  );
  return ccDir;
}

/** Scaffold a plugin directory with skills. */
function scaffoldPlugin(basePath: string, skills: string[], opts?: { mcpDeps?: boolean; hooks?: boolean; agents?: boolean; commands?: boolean }): void {
  mkdirSync(basePath, { recursive: true });

  if (skills.length > 0) {
    const skillsDir = join(basePath, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    for (const name of skills) {
      const skillDir = join(skillsDir, name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: "Test skill"\n---\n\n# ${name}\n`,
      );
    }
  }

  if (opts?.mcpDeps) {
    writeFileSync(
      join(basePath, 'package.json'),
      JSON.stringify({
        name: 'test-mcp-plugin',
        dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
      }),
    );
  }

  if (opts?.hooks) mkdirSync(join(basePath, 'hooks'), { recursive: true });
  if (opts?.agents) mkdirSync(join(basePath, 'agents'), { recursive: true });
  if (opts?.commands) mkdirSync(join(basePath, 'commands'), { recursive: true });
}

// ---------------------------------------------------------------------------
// extractShortName
// ---------------------------------------------------------------------------

describe('extractShortName', () => {
  it('extracts name before @', () => {
    expect(extractShortName('backend-development@claude-code-workflows')).toBe('backend-development');
  });

  it('returns full string if no @', () => {
    expect(extractShortName('my-plugin')).toBe('my-plugin');
  });
});

// ---------------------------------------------------------------------------
// readInstalledPlugins
// ---------------------------------------------------------------------------

describe('readInstalledPlugins', () => {
  it('reads a valid index file', async () => {
    const ccDir = writePluginIndex({
      'test@marketplace': [{ installPath: '/tmp/test', version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z' }],
    });
    const result = await readInstalledPlugins(ccDir);
    expect(result.version).toBe(2);
    expect(result.plugins).toHaveProperty('test@marketplace');
  });

  it('throws when index file missing', async () => {
    await expect(readInstalledPlugins(join(tmpDir, 'nonexistent'))).rejects.toThrow(
      'No Claude Code plugins found',
    );
  });

  it('throws on malformed JSON', async () => {
    const ccDir = join(tmpDir, 'cc-bad');
    mkdirSync(ccDir, { recursive: true });
    writeFileSync(join(ccDir, 'installed_plugins.json'), '{not valid json');
    await expect(readInstalledPlugins(ccDir)).rejects.toThrow('Error parsing');
  });
});

// ---------------------------------------------------------------------------
// validateInstallPath
// ---------------------------------------------------------------------------

describe('validateInstallPath', () => {
  it('accepts paths under the CC plugins dir', () => {
    expect(() => validateInstallPath('/home/user/.claude/plugins/cache/market/plugin/1.0', '/home/user/.claude/plugins')).not.toThrow();
  });

  it('rejects paths outside CC plugins dir', () => {
    expect(() => validateInstallPath('/etc/evil', '/home/user/.claude/plugins')).toThrow('outside the Claude Code plugins directory');
  });

  it('rejects path traversal attempts', () => {
    expect(() => validateInstallPath('/home/user/.claude/plugins/../../../etc/passwd', '/home/user/.claude/plugins')).toThrow('outside the Claude Code plugins directory');
  });
});

// ---------------------------------------------------------------------------
// resolvePlugin
// ---------------------------------------------------------------------------

describe('resolvePlugin', () => {
  it('resolves a plugin by short name', () => {
    const installPath = join(tmpDir, 'install');
    const index = {
      version: 2,
      plugins: {
        'my-plugin@market': [
          { installPath, version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z', scope: 'user', installedAt: '2026-01-01T00:00:00Z' },
        ],
      },
    };
    const resolved = resolvePlugin('my-plugin', index);
    expect(resolved.shortName).toBe('my-plugin');
    expect(resolved.installPath).toBe(installPath);
  });

  it('picks the most recently updated entry across marketplaces', () => {
    const oldPath = join(tmpDir, 'old');
    const newPath = join(tmpDir, 'new');
    const index = {
      version: 2,
      plugins: {
        'my-plugin@market-a': [
          { installPath: oldPath, version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z', scope: 'user', installedAt: '2026-01-01T00:00:00Z' },
        ],
        'my-plugin@market-b': [
          { installPath: newPath, version: '2.0.0', lastUpdated: '2026-06-01T00:00:00Z', scope: 'user', installedAt: '2026-06-01T00:00:00Z' },
        ],
      },
    };
    const resolved = resolvePlugin('my-plugin', index);
    expect(resolved.installPath).toBe(newPath);
  });

  it('throws when plugin not found', () => {
    const index = { version: 2, plugins: {} };
    expect(() => resolvePlugin('nonexistent', index)).toThrow("Plugin 'nonexistent' not found");
  });
});

// ---------------------------------------------------------------------------
// scanPlugin
// ---------------------------------------------------------------------------

describe('scanPlugin', () => {
  it('finds skills with SKILL.md', async () => {
    const pluginPath = join(tmpDir, 'plugin');
    scaffoldPlugin(pluginPath, ['api-design', 'caching']);
    const scan = await scanPlugin(pluginPath);
    expect(scan.skillDirs.sort()).toEqual(['api-design', 'caching']);
    expect(scan.hasMcpServer).toBe(false);
    expect(scan.skippedComponents).toEqual([]);
  });

  it('detects MCP server from package.json', async () => {
    const pluginPath = join(tmpDir, 'plugin');
    scaffoldPlugin(pluginPath, [], { mcpDeps: true });
    const scan = await scanPlugin(pluginPath);
    expect(scan.hasMcpServer).toBe(true);
  });

  it('detects skipped CC-specific directories', async () => {
    const pluginPath = join(tmpDir, 'plugin');
    scaffoldPlugin(pluginPath, ['skill-a'], { hooks: true, agents: true, commands: true });
    const scan = await scanPlugin(pluginPath);
    expect(scan.skippedComponents.sort()).toEqual(['agents', 'commands', 'hooks']);
  });

  it('ignores skill dirs without SKILL.md', async () => {
    const pluginPath = join(tmpDir, 'plugin');
    mkdirSync(join(pluginPath, 'skills', 'empty-skill'), { recursive: true });
    const scan = await scanPlugin(pluginPath);
    expect(scan.skillDirs).toEqual([]);
  });

  it('throws when install path missing', async () => {
    await expect(scanPlugin(join(tmpDir, 'nonexistent'))).rejects.toThrow(
      'Plugin install path not found',
    );
  });
});

// ---------------------------------------------------------------------------
// listImportablePlugins
// ---------------------------------------------------------------------------

describe('listImportablePlugins', () => {
  it('returns only plugins with skills or MCP servers', async () => {
    const pluginWithSkills = pluginInstallPath('with-skills');
    const pluginMcpOnly = pluginInstallPath('mcp-only');
    const pluginEmpty = pluginInstallPath('empty');

    scaffoldPlugin(pluginWithSkills, ['skill-a']);
    scaffoldPlugin(pluginMcpOnly, [], { mcpDeps: true });
    mkdirSync(pluginEmpty, { recursive: true });

    const ccDir = writePluginIndex({
      'with-skills@market': [{ installPath: pluginWithSkills, version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z' }],
      'mcp-only@market': [{ installPath: pluginMcpOnly, version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z' }],
      'empty@market': [{ installPath: pluginEmpty, version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z' }],
    });

    const result = await listImportablePlugins({ ccPluginsDir: ccDir });
    const names = result.map((p) => p.shortName);
    expect(names).toContain('with-skills');
    expect(names).toContain('mcp-only');
    expect(names).not.toContain('empty');
  });
});

// ---------------------------------------------------------------------------
// importPlugin
// ---------------------------------------------------------------------------

describe('importPlugin', () => {
  it('copies skill directories into skills/', async () => {
    const pluginPath = pluginInstallPath('test-plugin');
    const skillsDir = join(tmpDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });

    // Scaffold plugin with skills including assets.
    scaffoldPlugin(pluginPath, ['my-skill']);
    const assetsDir = join(pluginPath, 'skills', 'my-skill', 'assets');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, 'checklist.md'), '# Checklist\n');

    const ccDir = writePluginIndex({
      'test-plugin@market': [{ installPath: pluginPath, version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z' }],
    });

    const result = await importPlugin({
      name: 'test-plugin',
      skillsDir,
      ccPluginsDir: ccDir,
    });

    expect(result.skillsCopied).toEqual(['my-skill']);
    expect(existsSync(join(skillsDir, 'my-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'my-skill', 'assets', 'checklist.md'))).toBe(true);
  });

  it('errors when skill already exists', async () => {
    const pluginPath = pluginInstallPath('test-plugin');
    const skillsDir = join(tmpDir, 'skills');

    scaffoldPlugin(pluginPath, ['existing-skill']);
    // Pre-create the skill in talon's skills dir.
    mkdirSync(join(skillsDir, 'existing-skill'), { recursive: true });

    const ccDir = writePluginIndex({
      'test-plugin@market': [{ installPath: pluginPath, version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z' }],
    });

    await expect(
      importPlugin({ name: 'test-plugin', skillsDir, ccPluginsDir: ccDir }),
    ).rejects.toThrow('already exist');
  });

  it('errors when plugin has no importable components', async () => {
    const pluginPath = pluginInstallPath('empty-plugin');
    mkdirSync(pluginPath, { recursive: true });

    const ccDir = writePluginIndex({
      'empty-plugin@market': [{ installPath: pluginPath, version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z' }],
    });

    await expect(
      importPlugin({ name: 'empty-plugin', skillsDir: join(tmpDir, 'skills'), ccPluginsDir: ccDir }),
    ).rejects.toThrow('no importable skills or MCP servers');
  });

  it('reports MCP server and skipped components', async () => {
    const pluginPath = pluginInstallPath('full-plugin');
    const skillsDir = join(tmpDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });

    scaffoldPlugin(pluginPath, ['skill-a'], { mcpDeps: true, hooks: true, agents: true });

    const ccDir = writePluginIndex({
      'full-plugin@market': [{ installPath: pluginPath, version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z' }],
    });

    const result = await importPlugin({
      name: 'full-plugin',
      skillsDir,
      ccPluginsDir: ccDir,
    });

    expect(result.skillsCopied).toEqual(['skill-a']);
    expect(result.hasMcpServer).toBe(true);
    expect(result.skippedComponents.sort()).toEqual(['agents', 'hooks']);
  });

  it('succeeds for MCP-only plugin with zero skills', async () => {
    const pluginPath = pluginInstallPath('mcp-plugin');
    const skillsDir = join(tmpDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });

    scaffoldPlugin(pluginPath, [], { mcpDeps: true });

    const ccDir = writePluginIndex({
      'mcp-plugin@market': [{ installPath: pluginPath, version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z' }],
    });

    const result = await importPlugin({
      name: 'mcp-plugin',
      skillsDir,
      ccPluginsDir: ccDir,
    });

    expect(result.skillsCopied).toEqual([]);
    expect(result.hasMcpServer).toBe(true);
  });

  it('creates skillsDir if it does not exist', async () => {
    const pluginPath = pluginInstallPath('create-dir-plugin');
    const skillsDir = join(tmpDir, 'nonexistent-skills');

    scaffoldPlugin(pluginPath, ['test-skill']);

    const ccDir = writePluginIndex({
      'create-dir-plugin@market': [{ installPath: pluginPath, version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z' }],
    });

    const result = await importPlugin({
      name: 'create-dir-plugin',
      skillsDir,
      ccPluginsDir: ccDir,
    });

    expect(result.skillsCopied).toEqual(['test-skill']);
    expect(existsSync(join(skillsDir, 'test-skill', 'SKILL.md'))).toBe(true);
  });

  it('errors when plugin contains skills with invalid names', async () => {
    const pluginPath = pluginInstallPath('bad-names-plugin');
    const skillsDir = join(tmpDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });

    // Create a skill with a dot in the name (invalid for Talon).
    mkdirSync(join(pluginPath, 'skills', 'my.skill'), { recursive: true });
    writeFileSync(join(pluginPath, 'skills', 'my.skill', 'SKILL.md'), '---\nname: my.skill\n---\n');

    const ccDir = writePluginIndex({
      'bad-names-plugin@market': [{ installPath: pluginPath, version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z' }],
    });

    await expect(
      importPlugin({ name: 'bad-names-plugin', skillsDir, ccPluginsDir: ccDir }),
    ).rejects.toThrow('invalid names');
  });

  it('errors when name is missing', async () => {
    await expect(importPlugin({})).rejects.toThrow('Plugin name is required');
  });

  it('errors when name is invalid', async () => {
    await expect(importPlugin({ name: 'bad name!' })).rejects.toThrow('invalid');
  });
});
