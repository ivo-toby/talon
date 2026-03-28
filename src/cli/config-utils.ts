/**
 * Shared configuration utilities for talonctl CLI commands.
 *
 * All config mutation commands should use these functions instead of
 * inline fs calls. This ensures atomic writes, consistent validation,
 * and importable logic for the setup skill and terminal agent.
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import writeFileAtomic from 'write-file-atomic';
import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default config file path. */
export const DEFAULT_CONFIG_PATH = 'talond.yaml';

/** Pattern for valid resource names (channels, personas, skills). */
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Valid channel connector types — kept in sync with ChannelConfigSchema. */
export const VALID_CHANNEL_TYPES = ['telegram', 'whatsapp', 'whatsappBusiness', 'whatsappBaileys', 'slack', 'email', 'discord', 'terminal'] as const;
export type ChannelType = (typeof VALID_CHANNEL_TYPES)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Root YAML document structure (partial — only what we need). */
export interface YamlDocument {
  channels?: Array<{ name: string; type: string; config?: Record<string, unknown>; enabled?: boolean }>;
  personas?: Array<{ name: string; model?: string; systemPromptFile?: string; skills?: string[]; capabilities?: Record<string, unknown>; mounts?: unknown[] }>;
  bindings?: Array<{ persona: string; channel: string; isDefault?: boolean }>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

/**
 * Validates a resource name (channel, persona, skill).
 *
 * Names must match `^[a-zA-Z0-9_-]+$` — no spaces, dots, or special chars.
 * This prevents YAML serialization issues and filesystem path problems.
 *
 * @returns null if valid, error message string if invalid.
 */
export function validateName(name: string, resource: string): string | null {
  if (!name || name.trim() === '') {
    return `${resource} name must not be empty.`;
  }
  if (!NAME_PATTERN.test(name)) {
    return `${resource} name "${name}" is invalid. Use only letters, numbers, hyphens, and underscores.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Config file I/O
// ---------------------------------------------------------------------------

/**
 * Reads and parses the talond.yaml config file.
 *
 * @param configPath - Path to the config file.
 * @returns The parsed YAML document.
 * @throws Error if the file doesn't exist, can't be read, or is invalid YAML.
 */
export async function readConfig(configPath: string = DEFAULT_CONFIG_PATH): Promise<YamlDocument> {
  if (!existsSync(configPath)) {
    throw new Error(`Config file "${configPath}" not found. Run \`talonctl setup\` first, or pass --config to specify a different path.`);
  }

  let rawContent: string;
  try {
    rawContent = await fs.readFile(configPath, 'utf-8');
  } catch (cause) {
    throw new Error(`Error reading config file "${configPath}": ${String(cause)}`);
  }

  try {
    const parsed = yaml.load(rawContent);
    return (parsed ?? {}) as YamlDocument;
  } catch (cause) {
    throw new Error(`Error parsing YAML in "${configPath}": ${String(cause)}`);
  }
}

/**
 * Writes a YAML document to the config file atomically.
 *
 * Uses write-file-atomic to prevent corruption if the process crashes
 * mid-write. The file is written to a temp location first, then renamed.
 *
 * @param configPath - Path to the config file.
 * @param doc        - The YAML document to write.
 */
export async function writeConfigAtomic(configPath: string, doc: YamlDocument): Promise<void> {
  const updatedYaml = yaml.dump(doc, {
    lineWidth: 120,
    quotingType: '"',
    forceQuotes: false,
  });

  try {
    await writeFileAtomic(configPath, updatedYaml, { encoding: 'utf-8' });
  } catch (cause) {
    throw new Error(`Error writing config file "${configPath}": ${String(cause)}`);
  }
}
