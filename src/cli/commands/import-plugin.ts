/**
 * `talonctl import-plugin` command.
 *
 * Reads already-installed Claude Code plugins from ~/.claude/plugins/ and
 * copies compatible components (skills) into Talon's global skills/ directory.
 * MCP servers are detected and reported for manual wiring.
 *
 * See: docs/superpowers/specs/2026-03-27-import-plugin-design.md
 */

import fs from 'node:fs/promises';
import { existsSync, realpathSync, lstatSync, type Dirent } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { validateName } from '../config-utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CC_PLUGINS_DIR = path.join(os.homedir(), '.claude', 'plugins');
const DEFAULT_SKILLS_DIR = 'skills';

/** CC-specific directories that have no Talon equivalent. */
const SKIPPED_DIRS = ['hooks', 'commands', 'agents'] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of ~/.claude/plugins/installed_plugins.json */
interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, PluginEntry[]>;
}

interface PluginEntry {
  scope: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  projectPath?: string;
  gitCommitSha?: string;
}

/** Resolved plugin ready for import. */
interface ResolvedPlugin {
  shortName: string;
  fullKey: string;
  installPath: string;
  entry: PluginEntry;
}

/** Result of scanning a plugin directory. */
interface PluginScanResult {
  skillDirs: string[];       // subdirectory names under skills/
  hasMcpServer: boolean;
  skippedComponents: string[]; // e.g. ['hooks', 'agents']
}

export interface ImportPluginOptions {
  name?: string;
  list?: boolean;
  skillsDir?: string;
  ccPluginsDir?: string;
}

export interface ImportPluginResult {
  skillsCopied: string[];
  hasMcpServer: boolean;
  skippedComponents: string[];
}

/** Info returned by --list. */
export interface ListablePlugin {
  shortName: string;
  fullKey: string;
  version: string;
  hasSkills: boolean;
  hasMcpServer: boolean;
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Reads the installed_plugins.json index file.
 *
 * @throws Error if the file doesn't exist or can't be parsed.
 */
export async function readInstalledPlugins(ccPluginsDir: string): Promise<InstalledPluginsFile> {
  const indexPath = path.join(ccPluginsDir, 'installed_plugins.json');

  if (!existsSync(indexPath)) {
    throw new Error(
      'No Claude Code plugins found. Install plugins in Claude Code first.',
    );
  }

  let raw: string;
  try {
    raw = await fs.readFile(indexPath, 'utf-8');
  } catch (cause) {
    throw new Error(`Error reading Claude Code plugins index "${indexPath}": ${String(cause)}`);
  }

  try {
    return JSON.parse(raw) as InstalledPluginsFile;
  } catch (cause) {
    throw new Error(`Error parsing Claude Code plugins index "${indexPath}": ${String(cause)}`);
  }
}

/**
 * Extracts the short plugin name from a full key like "backend-development@claude-code-workflows".
 */
export function extractShortName(fullKey: string): string {
  const atIndex = fullKey.indexOf('@');
  return atIndex === -1 ? fullKey : fullKey.substring(0, atIndex);
}

/**
 * Validates that a resolved install path is under the expected CC plugins cache.
 * Uses fs.realpathSync to resolve symlinks, preventing symlink-based escapes.
 */
export function validateInstallPath(installPath: string, ccPluginsDir: string): void {
  let resolvedInstall: string;
  let resolvedCache: string;
  try {
    resolvedInstall = realpathSync(installPath);
    resolvedCache = realpathSync(ccPluginsDir);
  } catch {
    // If either path doesn't exist, fall back to path.resolve for the error message.
    resolvedInstall = path.resolve(installPath);
    resolvedCache = path.resolve(ccPluginsDir);
  }
  if (!resolvedInstall.startsWith(resolvedCache + path.sep)) {
    throw new Error(
      `Plugin install path "${installPath}" is outside the Claude Code plugins directory. The plugins index may be corrupted.`,
    );
  }
}

/**
 * Resolves a plugin by short name from the installed plugins index.
 * If multiple entries match, picks the one with the most recent lastUpdated.
 */
export function resolvePlugin(
  shortName: string,
  plugins: InstalledPluginsFile,
): ResolvedPlugin {
  // Collect all entries across all keys that match the short name.
  const candidates: Array<{ fullKey: string; entry: PluginEntry }> = [];

  for (const [fullKey, entries] of Object.entries(plugins.plugins)) {
    if (extractShortName(fullKey) === shortName) {
      for (const entry of entries) {
        candidates.push({ fullKey, entry });
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `Plugin '${shortName}' not found. Run \`talonctl import-plugin --list\` to see available plugins.`,
    );
  }

  // Pick the most recently updated.
  candidates.sort(
    (a, b) =>
      new Date(b.entry.lastUpdated).getTime() -
      new Date(a.entry.lastUpdated).getTime(),
  );

  const best = candidates[0]!;
  return {
    shortName,
    fullKey: best.fullKey,
    installPath: best.entry.installPath,
    entry: best.entry,
  };
}

/**
 * Scans a plugin directory for importable components.
 */
export async function scanPlugin(installPath: string): Promise<PluginScanResult> {
  if (!existsSync(installPath)) {
    throw new Error(
      `Plugin install path not found: "${installPath}". It may have been uninstalled from Claude Code.`,
    );
  }

  const skillDirs: string[] = [];
  const skippedComponents: string[] = [];

  // Check for skills.
  const skillsPath = path.join(installPath, 'skills');
  if (existsSync(skillsPath)) {
    let dirEntries: Dirent[];
    try {
      dirEntries = await fs.readdir(skillsPath, { withFileTypes: true }) as unknown as Dirent[];
    } catch (cause) {
      throw new Error(`Error reading plugin skills directory "${skillsPath}": ${String(cause)}`);
    }
    for (const entry of dirEntries) {
      if (entry.isDirectory()) {
        const skillMd = path.join(skillsPath, entry.name, 'SKILL.md');
        if (existsSync(skillMd) && lstatSync(skillMd).isFile()) {
          skillDirs.push(entry.name);
        }
      }
    }
  }

  // Check for skipped CC-specific directories.
  for (const dir of SKIPPED_DIRS) {
    if (existsSync(path.join(installPath, dir))) {
      skippedComponents.push(dir);
    }
  }

  // Check for MCP server.
  let hasMcpServer = false;
  const pkgJsonPath = path.join(installPath, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const pkgRaw = await fs.readFile(pkgJsonPath, 'utf-8');
      const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      if ('@modelcontextprotocol/sdk' in deps) {
        hasMcpServer = true;
      }
    } catch {
      // Ignore parse errors in package.json.
    }
  }

  return { skillDirs, hasMcpServer, skippedComponents };
}

/**
 * Lists all installed CC plugins that have importable components.
 */
export async function listImportablePlugins(
  options: Pick<ImportPluginOptions, 'ccPluginsDir'>,
): Promise<ListablePlugin[]> {
  const ccPluginsDir = options.ccPluginsDir ?? DEFAULT_CC_PLUGINS_DIR;
  const index = await readInstalledPlugins(ccPluginsDir);

  // Deduplicate by short name — pick the most recently updated entry.
  const byShortName = new Map<string, { fullKey: string; entry: PluginEntry }>();
  for (const [fullKey, entries] of Object.entries(index.plugins)) {
    const shortName = extractShortName(fullKey);
    for (const entry of entries) {
      const existing = byShortName.get(shortName);
      if (
        !existing ||
        new Date(entry.lastUpdated).getTime() >
          new Date(existing.entry.lastUpdated).getTime()
      ) {
        byShortName.set(shortName, { fullKey, entry });
      }
    }
  }

  const result: ListablePlugin[] = [];

  for (const [shortName, { fullKey, entry }] of byShortName) {
    if (!existsSync(entry.installPath)) continue;

    try {
      validateInstallPath(entry.installPath, ccPluginsDir);
      const scan = await scanPlugin(entry.installPath);
      if (scan.skillDirs.length > 0 || scan.hasMcpServer) {
        result.push({
          shortName,
          fullKey,
          version: entry.version,
          hasSkills: scan.skillDirs.length > 0,
          hasMcpServer: scan.hasMcpServer,
        });
      }
    } catch {
      // Skip plugins with broken install paths.
    }
  }

  return result.sort((a, b) => a.shortName.localeCompare(b.shortName));
}

/**
 * Imports a CC plugin's skills into Talon's skills directory.
 *
 * @throws Error with a user-facing message on any failure.
 */
export async function importPlugin(
  options: ImportPluginOptions,
): Promise<ImportPluginResult> {
  const ccPluginsDir = options.ccPluginsDir ?? DEFAULT_CC_PLUGINS_DIR;
  const skillsDir = options.skillsDir ?? DEFAULT_SKILLS_DIR;

  if (!options.name) {
    throw new Error('Plugin name is required. Use --name <name> or --list to see available plugins.');
  }

  // Validate name.
  const nameError = validateName(options.name, 'Plugin');
  if (nameError) {
    throw new Error(nameError);
  }

  // Resolve plugin.
  const index = await readInstalledPlugins(ccPluginsDir);
  const resolved = resolvePlugin(options.name, index);

  // Validate install path is under CC plugins directory.
  validateInstallPath(resolved.installPath, ccPluginsDir);

  // Scan plugin.
  const scan = await scanPlugin(resolved.installPath);

  if (scan.skillDirs.length === 0 && !scan.hasMcpServer) {
    throw new Error(
      `Plugin '${options.name}' has no importable skills or MCP servers.`,
    );
  }

  // Ensure skills directory exists.
  try {
    await fs.mkdir(skillsDir, { recursive: true });
  } catch (cause) {
    throw new Error(`Error creating skills directory "${skillsDir}": ${String(cause)}`);
  }

  // Check for collisions before copying anything.
  for (const skillName of scan.skillDirs) {
    const targetDir = path.join(skillsDir, skillName);
    if (existsSync(targetDir)) {
      throw new Error(
        `Skills from plugin '${options.name}' already exist in ${skillsDir}/. Remove them first to re-import.`,
      );
    }
  }

  // Copy skill directories. Use errorOnExist to prevent TOCTOU overwrites.
  const skillsCopied: string[] = [];
  for (const skillName of scan.skillDirs) {
    const srcDir = path.join(resolved.installPath, 'skills', skillName);
    const destDir = path.join(skillsDir, skillName);
    try {
      await fs.cp(srcDir, destDir, { recursive: true, errorOnExist: true, force: false });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(
          `Skills from plugin '${options.name}' already exist in ${skillsDir}/. Remove them first to re-import.`,
        );
      }
      throw new Error(`Error copying skill "${skillName}" to "${destDir}": ${String(cause)}`);
    }
    skillsCopied.push(skillName);
  }

  return {
    skillsCopied,
    hasMcpServer: scan.hasMcpServer,
    skippedComponents: scan.skippedComponents,
  };
}

// ---------------------------------------------------------------------------
// CLI wrappers
// ---------------------------------------------------------------------------

/**
 * CLI entrypoint for `talonctl import-plugin --list`.
 */
export async function listPluginsCommand(
  options: Pick<ImportPluginOptions, 'ccPluginsDir'>,
): Promise<void> {
  try {
    const plugins = await listImportablePlugins(options);

    if (plugins.length === 0) {
      console.log('No importable Claude Code plugins found.');
      return;
    }

    console.log('Importable Claude Code plugins:\n');
    for (const p of plugins) {
      const components: string[] = [];
      if (p.hasSkills) components.push('skills');
      if (p.hasMcpServer) components.push('MCP server');
      console.log(`  ${p.shortName} (${p.version}) — ${components.join(', ')}`);
    }
    console.log(`\nUse \`talonctl import-plugin --name <name>\` to import.`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * CLI entrypoint for `talonctl import-plugin --name <name>`.
 */
export async function importPluginCommand(
  options: ImportPluginOptions,
): Promise<void> {
  try {
    const result = await importPlugin(options);

    // Report copied skills.
    if (result.skillsCopied.length > 0) {
      console.log(`Imported ${result.skillsCopied.length} skill(s):`);
      for (const name of result.skillsCopied) {
        console.log(`  ${options.skillsDir ?? DEFAULT_SKILLS_DIR}/${name}/`);
      }
    } else {
      console.log('No skills imported.');
    }

    // Report skipped components.
    if (result.skippedComponents.length > 0) {
      console.log(
        `\nSkipped CC-specific components: ${result.skippedComponents.join(', ')} (no Talon equivalent)`,
      );
    }

    // Report MCP server.
    if (result.hasMcpServer) {
      if (result.skillsCopied.length === 0) {
        console.log('MCP server detected — configure it via talonctl MCP commands.');
      } else {
        console.log('\nMCP server also detected — configure it via talonctl MCP commands.');
      }
    }

    // Next steps.
    if (result.skillsCopied.length > 0) {
      console.log('\nTo attach these skills to a persona, use:');
      console.log('  talonctl add-skill --name <skill-name> --persona <persona-name> --format skillmd');
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
