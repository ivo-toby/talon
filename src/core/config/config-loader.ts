/**
 * YAML configuration loader for talond.
 *
 * Reads a YAML file (or parses a YAML string), validates it against the
 * TalondConfigSchema, and returns either a frozen, strongly-typed
 * TalondConfig or a ConfigError with a human-readable message that
 * identifies exactly which field failed validation.
 */

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { ok, err, type Result } from 'neverthrow';
import { TalondConfigSchema } from './config-schema.js';
import type { TalondConfig } from './config-types.js';
import { ConfigError } from '../errors/index.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Formats a Zod issue path and message into a single actionable string.
 * e.g. "sandbox.resourceLimits.memoryMb: Expected number, received string"
 */
function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>';
  return `${path}: ${issue.message}`;
}

/**
 * Deeply freezes an object so the config cannot be mutated at runtime.
 * Primitive values and null are returned as-is.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  // Freeze array elements
  if (Array.isArray(value)) {
    (value as unknown[]).forEach((item) => deepFreeze(item));
    return Object.freeze(value);
  }

  // Freeze object properties
  Object.values(value as Record<string, unknown>).forEach((v) => deepFreeze(v));
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLegacyConfig(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return raw;
  }

  const root = { ...raw };
  const backgroundAgent = root['backgroundAgent'];
  if (isRecord(backgroundAgent)) {
    const normalizedBackgroundAgent = { ...backgroundAgent };
    const claudePath = normalizedBackgroundAgent['claudePath'];
    const hasExplicitProviders = normalizedBackgroundAgent['providers'] !== undefined;

    if (typeof claudePath === 'string' && !hasExplicitProviders) {
      normalizedBackgroundAgent['defaultProvider'] ??= 'claude-code';
      normalizedBackgroundAgent['providers'] = {
        'claude-code': {
          enabled: true,
          command: claudePath,
          contextWindowTokens: 200000,
        },
      };
    }

    root['backgroundAgent'] = normalizedBackgroundAgent;
  }

  // Migrate legacy provider-level rotationThreshold to contextManagement.
  const agentRunner = root['agentRunner'];
  if (isRecord(agentRunner)) {
    const providers = agentRunner['providers'];
    if (isRecord(providers)) {
      const normalizedProviders = { ...providers };
      for (const [name, provider] of Object.entries(normalizedProviders)) {
        if (!isRecord(provider)) continue;
        const hasRotationThreshold = provider['rotationThreshold'] !== undefined;
        const hasContextManagement = provider['contextManagement'] !== undefined;

        if (hasRotationThreshold && !hasContextManagement) {
          const threshold = provider['rotationThreshold'];
          const normalizedProvider = { ...provider };
          // Claude providers use cache_read_input_tokens; others use input_tokens.
          const isClaude = name.includes('claude');
          normalizedProvider['contextManagement'] = {
            enabled: true,
            triggerMetric: isClaude ? 'cache_read_input_tokens' : 'input_tokens',
            thresholdRatio: typeof threshold === 'number' ? threshold : 0.5,
            recentMessageCount: 10,
            summarizer: 'session-summarizer',
          };
          delete normalizedProvider['rotationThreshold'];
          normalizedProviders[name] = normalizedProvider;
        }

        const contextManagement = provider['contextManagement'];
        if (isRecord(contextManagement)) {
          const summarizer = contextManagement['summarizer'];
          const mode = contextManagement['mode'];
          if (summarizer === 'session-observer' && mode === undefined) {
            normalizedProviders[name] = {
              ...provider,
              contextManagement: {
                ...contextManagement,
                mode: 'observation',
                observer: contextManagement['observer'] ?? 'session-observer',
                reducer: contextManagement['reducer'] ?? 'session-reflector',
                deprecatedLegacySummarizer: true,
              },
            };
          }
        }
      }
      const normalizedAgentRunner = { ...agentRunner, providers: normalizedProviders };
      root['agentRunner'] = normalizedAgentRunner;
    }
  }

  return root;
}

function hasLegacyContextConfig(raw: unknown): boolean {
  return isRecord(raw) && Object.hasOwn(raw, 'context');
}

function legacyContextConfigError(source: string): ConfigError {
  return new ConfigError(
    `Top-level "context" configuration has been removed. Migrate context management to agentRunner.providers.<name>.contextManagement. See README.md. (${source})`,
  );
}

/**
 * Parses and validates raw YAML content (as a string) into a TalondConfig.
 * Returns a ConfigError when the YAML is malformed or fails schema validation.
 */
function parseAndValidate(yamlContent: string, source: string): Result<TalondConfig, ConfigError> {
  // Substitute ${ENV_VAR} placeholders with process.env values before parsing.
  const substituted = yamlContent.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
    return process.env[name] ?? '';
  });

  let raw: unknown;

  try {
    raw = yaml.load(substituted);
  } catch (e) {
    const cause = e instanceof Error ? e : new Error(String(e));
    return err(
      new ConfigError(`Failed to parse YAML from ${source}: ${cause.message}`, cause),
    );
  }

  // yaml.load returns undefined for an empty document; treat that as {}
  if (raw === undefined || raw === null) {
    raw = {};
  }

  if (hasLegacyContextConfig(raw)) {
    return err(legacyContextConfigError(source));
  }

  raw = normalizeLegacyConfig(raw);

  const result = TalondConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(formatIssue);
    const summary = issues.slice(0, 5).join('; ');
    const extra = issues.length > 5 ? ` (and ${issues.length - 5} more)` : '';
    return err(
      new ConfigError(
        `Configuration validation failed for ${source}: ${summary}${extra}`,
      ),
    );
  }

  return ok(deepFreeze(result.data));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Loads and validates a talond configuration from a YAML file.
 *
 * The returned TalondConfig is deeply frozen — any attempt to mutate it at
 * runtime will throw in strict mode.
 *
 * @param filePath  Absolute or relative path to the YAML config file.
 * @returns         Ok(TalondConfig) on success, Err(ConfigError) on failure.
 */
export function loadConfig(filePath: string): Result<TalondConfig, ConfigError> {
  let content: string;

  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (e) {
    const cause = e instanceof Error ? e : new Error(String(e));
    return err(
      new ConfigError(`Failed to read config file "${filePath}": ${cause.message}`, cause),
    );
  }

  return parseAndValidate(content, `"${filePath}"`);
}

/**
 * Validates a talond configuration from a YAML string.
 *
 * Useful for testing and for the `talonctl doctor` command which may
 * want to validate a config without writing it to disk first.
 *
 * @param yamlContent  Raw YAML string to parse and validate.
 * @returns            Ok(TalondConfig) on success, Err(ConfigError) on failure.
 */
export function loadConfigFromString(yamlContent: string): Result<TalondConfig, ConfigError> {
  return parseAndValidate(yamlContent, '<string>');
}

/**
 * Validates a plain object (already parsed from YAML or JSON) against the
 * TalondConfigSchema.
 *
 * Intended for use by `talonctl doctor` when it needs to validate a config
 * object that was obtained through other means.
 *
 * @param raw  The raw (unvalidated) configuration object.
 * @returns    Ok(TalondConfig) on success, Err(ConfigError) on failure.
 */
export function validateConfig(raw: unknown): Result<TalondConfig, ConfigError> {
  if (hasLegacyContextConfig(raw)) {
    return err(legacyContextConfigError('validateConfig'));
  }

  const result = TalondConfigSchema.safeParse(normalizeLegacyConfig(raw));
  if (!result.success) {
    const issues = result.error.issues.map(formatIssue);
    const summary = issues.slice(0, 5).join('; ');
    const extra = issues.length > 5 ? ` (and ${issues.length - 5} more)` : '';
    return err(
      new ConfigError(`Configuration validation failed: ${summary}${extra}`),
    );
  }

  return ok(deepFreeze(result.data));
}
