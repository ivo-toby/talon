/**
 * `talonctl config-show` command.
 *
 * Dumps the effective config (after env var substitution and defaults).
 * Masks secret values to prevent accidental exposure.
 */

import fs from 'node:fs/promises';

import yaml from 'js-yaml';

import { DEFAULT_CONFIG_PATH } from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigShowOptions {
  configPath?: string;
  showSecrets?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Keys whose values should be masked unless --show-secrets is used. */
const SECRET_KEYS = new Set([
  'token', 'botToken', 'appToken', 'authToken', 'accessToken', 'refreshToken',
  'password', 'accountSid', 'apiKey', 'secret', 'secretKey',
  'signingSecret', 'clientSecret', 'privateKey', 'webhookSecret',
  'encryptionKey', 'encryptionSecret',
]);

const MASK = '***MASKED***';

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/** Pattern to match ${VAR_NAME} placeholders — aligned with config-loader's \w+ pattern. */
const ENV_VAR_PATTERN = /\$\{(\w+)\}/g;

/**
 * Reads the config file, substitutes env vars, and optionally masks secrets.
 *
 * @returns The effective config as a string (YAML).
 * @throws Error if the config file can't be read.
 */
export async function configShow(options: ConfigShowOptions = {}): Promise<string> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  let rawContent: string;
  try {
    rawContent = await fs.readFile(configPath, 'utf-8');
  } catch {
    throw new Error(`Config file "${configPath}" not found.`);
  }

  // Substitute env vars.
  const substituted = rawContent.replace(ENV_VAR_PATTERN, (_match, varName: string) => {
    return process.env[varName] ?? `\${${varName}}`;
  });

  // Parse and re-serialize to normalize formatting.
  const parsed = yaml.load(substituted) as Record<string, unknown> | null;
  if (!parsed) {
    return '# Empty config\n';
  }

  // Mask secrets unless --show-secrets.
  if (!options.showSecrets) {
    maskSecrets(parsed);
  }

  return yaml.dump(parsed, {
    lineWidth: 120,
    quotingType: '"',
    forceQuotes: false,
  });
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function configShowCommand(options: ConfigShowOptions = {}): Promise<void> {
  try {
    const output = await configShow(options);
    process.stdout.write(output);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively masks values for keys in SECRET_KEYS.
 */
function maskSecrets(obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_KEYS.has(key) && typeof value === 'string') {
      obj[key] = MASK;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      maskSecrets(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          maskSecrets(item as Record<string, unknown>);
        }
      }
    }
  }
}
