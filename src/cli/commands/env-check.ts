/**
 * `talonctl env-check` command.
 *
 * Scans Talon YAML and MCP server definitions for environment references and
 * reports which ones are set or missing without printing their values.
 */

import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_CONFIG_PATH } from '../config-utils.js';
import {
  findEnvironmentVariableReferences,
  isEnvironmentVariableName,
} from '../../core/config/environment.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnvCheckOptions {
  configPath?: string;
  skillsDir?: string;
}

export interface EnvVar {
  name: string;
  isSet: boolean;
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Scans Talon YAML and MCP server definitions and checks whether the
 * referenced variables are set in the current environment.
 *
 * @returns List of env vars found with their set/unset status.
 * @throws Error if the config file can't be read.
 */
export async function envCheck(options: EnvCheckOptions = {}): Promise<EnvVar[]> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const skillsDir = options.skillsDir ?? 'skills';

  let rawContent: string;
  try {
    rawContent = await fs.readFile(configPath, 'utf-8');
  } catch {
    throw new Error(`Config file "${configPath}" not found.`);
  }

  // Find all unique ${VAR} references.
  const varNames = new Set<string>();
  for (const name of findEnvironmentVariableReferences(rawContent)) {
    varNames.add(name);
  }
  for (const name of await collectMcpEnvironmentVariableNames(skillsDir)) {
    varNames.add(name);
  }

  return Array.from(varNames)
    .sort()
    .map((name) => ({
      name,
      isSet: process.env[name] !== undefined && process.env[name].length > 0,
    }));
}

async function collectMcpEnvironmentVariableNames(skillsDir: string): Promise<Set<string>> {
  const names = new Set<string>();
  let skillEntries: Dirent[];
  try {
    skillEntries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return names;
  }

  for (const skillEntry of skillEntries) {
    if (!skillEntry.isDirectory()) continue;
    const mcpDir = join(skillsDir, skillEntry.name, 'mcp');
    let mcpFiles: string[];
    try {
      mcpFiles = await fs.readdir(mcpDir);
    } catch {
      continue;
    }

    for (const file of mcpFiles.filter((entry) => entry.endsWith('.json'))) {
      const filePath = join(mcpDir, file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      } catch (cause) {
        throw new Error(`Failed to read MCP server definition "${filePath}": ${(cause as Error).message}`);
      }

      const root = asRecord(parsed);
      const config = asRecord(root?.config);
      if (!config) continue;
      for (const key of ['headers', 'env']) {
        const values = asRecord(config[key]);
        for (const value of Object.values(values ?? {})) {
          if (typeof value !== 'string') continue;
          for (const name of findEnvironmentVariableReferences(value)) names.add(name);
        }
      }

      const auth = asRecord(config.auth);
      for (const key of ['clientIdEnv', 'clientSecretEnv']) {
        const name = auth?.[key];
        if (typeof name === 'string' && isEnvironmentVariableName(name)) names.add(name);
      }
    }
  }

  return names;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function envCheckCommand(options: EnvCheckOptions = {}): Promise<void> {
  try {
    const vars = await envCheck(options);

    if (vars.length === 0) {
      console.log('No environment variable references found in config or MCP server definitions.');
      return;
    }

    console.log(`${'VARIABLE'.padEnd(35)} STATUS`);
    console.log(`${'─'.repeat(35)} ${'─'.repeat(10)}`);

    let missingCount = 0;
    for (const v of vars) {
      const status = v.isSet ? 'SET' : 'MISSING';
      if (!v.isSet) missingCount++;
      console.log(`${v.name.padEnd(35)} ${status}`);
    }

    console.log('');
    if (missingCount > 0) {
      console.log(`${missingCount} variable(s) missing. Set them in .env or environment before starting talond.`);
    } else {
      console.log('All environment variables are set.');
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
