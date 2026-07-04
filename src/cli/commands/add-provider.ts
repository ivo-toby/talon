/**
 * `talonctl add-provider` command.
 *
 * Adds a new provider entry to `agentRunner.providers`, `backgroundAgent.providers`,
 * or both in talond.yaml.
 */

import { basename } from 'node:path';

import {
  DEFAULT_CONFIG_PATH,
  validateName,
  readConfig,
  writeConfigAtomic,
} from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderContext = 'agent-runner' | 'background' | 'both';
export type TriggerMetric =
  | 'input_tokens'
  | 'cache_read_input_tokens'
  | 'cache_creation_input_tokens'
  | 'cache_total_input_tokens';
export type OpenAiCompatibleApiMode = 'chat-completions' | 'responses';
export type OpenAiCompatibleSessionMode = 'none' | 'previous_response_id';

export interface AddProviderOptions {
  name: string;
  type?: string;
  command: string;
  context?: ProviderContext;
  contextWindowTokens?: number;
  contextEnabled?: boolean;
  triggerMetric?: TriggerMetric;
  thresholdRatio?: number;
  recentMessageCount?: number;
  summarizer?: string;
  enabled?: boolean;
  defaultModel?: string;
  baseUrl?: string;
  providerId?: string;
  toolOutputCap?: number;
  apiMode?: string;
  sessionMode?: string;
  /** @deprecated Use apiMode + sessionMode. */
  omlxResponses?: boolean;
  configPath?: string;
}

export interface ContextManagementEntry {
  enabled: boolean;
  triggerMetric: TriggerMetric;
  thresholdRatio: number;
  recentMessageCount: number;
  summarizer: string;
}

export interface ProviderEntry {
  enabled: boolean;
  type?: string;
  command: string;
  contextWindowTokens: number;
  contextManagement?: ContextManagementEntry;
  options?: Record<string, unknown>;
}

function inferDefaultTriggerMetric(name: string, command: string): TriggerMetric {
  const normalizedCommand = basename(command.trim())
    .toLowerCase()
    .replace(/\.(cmd|exe|bat)$/u, '');
  const normalizedName = name.trim().toLowerCase();

  if (normalizedCommand.includes('claude') || normalizedName.includes('claude')) {
    return 'cache_read_input_tokens';
  }

  return 'input_tokens';
}

function parseApiMode(value: string | undefined): OpenAiCompatibleApiMode | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized === 'chat-completions' || normalized === 'responses') {
    return normalized;
  }
  throw new Error('apiMode must be one of: chat-completions, responses.');
}

function parseSessionMode(value: string | undefined): OpenAiCompatibleSessionMode | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized === 'none' || normalized === 'previous_response_id') {
    return normalized;
  }
  throw new Error('sessionMode must be one of: none, previous_response_id.');
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Adds a provider to the config file.
 *
 * Pure business logic — no console output or process.exit.
 * Can be called from CLI, setup skill, or terminal agent.
 *
 * @returns The provider entry that was added.
 * @throws Error with a user-facing message on any failure.
 */
export async function addProvider(
  options: AddProviderOptions,
): Promise<{ entry: ProviderEntry; contexts: ProviderContext[] }> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const ctx = options.context ?? 'both';

  // Validate context.
  const validContexts: ProviderContext[] = ['agent-runner', 'background', 'both'];
  if (!validContexts.includes(ctx)) {
    throw new Error(`Invalid context "${ctx}". Must be one of: ${validContexts.join(', ')}.`);
  }

  const explicitApiMode = options.apiMode !== undefined;
  let apiMode = parseApiMode(options.apiMode);
  let sessionMode = parseSessionMode(options.sessionMode);
  if (options.omlxResponses === true) {
    if (apiMode && apiMode !== 'responses') {
      throw new Error('--omlx-responses cannot be combined with --api-mode chat-completions.');
    }
    if (sessionMode && sessionMode !== 'previous_response_id') {
      throw new Error('--omlx-responses cannot be combined with --session-mode none.');
    }
    apiMode = 'responses';
    sessionMode = 'previous_response_id';
  }
  if (apiMode !== 'responses' && sessionMode === 'previous_response_id') {
    throw new Error('sessionMode previous_response_id requires apiMode responses.');
  }
  if (sessionMode === 'previous_response_id' && ctx === 'background') {
    if (options.omlxResponses === true) {
      throw new Error('--omlx-responses is only supported for agent-runner providers.');
    }
    throw new Error('--session-mode previous_response_id is only supported for agent-runner providers.');
  }

  // Validate name.
  const nameError = validateName(options.name, 'Provider');
  if (nameError) {
    throw new Error(nameError);
  }

  const providerType = options.type?.trim();
  if (providerType) {
    const typeError = validateName(providerType, 'Provider type');
    if (typeError) {
      throw new Error(typeError);
    }
  }

  // Validate command.
  if (!options.command || options.command.trim() === '') {
    throw new Error('Provider command must not be empty.');
  }

  // Validate contextWindowTokens.
  const contextWindowTokens = options.contextWindowTokens ?? 200000;
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens < 1000) {
    throw new Error('contextWindowTokens must be a finite number >= 1000.');
  }

  if (ctx === 'background' && options.contextEnabled === true) {
    throw new Error(
      'Background providers do not support context management. See the README for agentRunner-only context management.',
    );
  }

  const contextEnabled = options.contextEnabled ?? ctx !== 'background';
  const triggerMetric =
    options.triggerMetric ?? inferDefaultTriggerMetric(options.name, options.command);
  if (
    ![
      'input_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
      'cache_total_input_tokens',
    ].includes(triggerMetric)
  ) {
    throw new Error(
      'triggerMetric must be one of: input_tokens, cache_read_input_tokens, cache_creation_input_tokens, cache_total_input_tokens.',
    );
  }

  const thresholdRatio = options.thresholdRatio ?? 0.5;
  if (!Number.isFinite(thresholdRatio) || thresholdRatio < 0 || thresholdRatio > 1) {
    throw new Error('thresholdRatio must be a finite number between 0 and 1.');
  }

  const recentMessageCount = options.recentMessageCount ?? 10;
  if (!Number.isInteger(recentMessageCount) || recentMessageCount < 0) {
    throw new Error('recentMessageCount must be an integer >= 0.');
  }

  const summarizer = options.summarizer?.trim() ?? 'session-summarizer';
  if (contextEnabled && summarizer.length === 0) {
    throw new Error('summarizer must not be empty when context management is enabled.');
  }

  const baseUrl = options.baseUrl?.trim();
  if (options.baseUrl !== undefined && !baseUrl) {
    throw new Error('baseUrl must not be empty when provided.');
  }

  const providerId = options.providerId?.trim();
  if (providerId) {
    const providerIdError = validateName(providerId, 'Provider ID');
    if (providerIdError) {
      throw new Error(providerIdError);
    }
  }

  if (options.toolOutputCap !== undefined) {
    if (!Number.isInteger(options.toolOutputCap) || options.toolOutputCap < 0) {
      throw new Error('toolOutputCap must be an integer >= 0.');
    }
  }

  // Read existing config.
  const doc = await readConfig(configPath);

  // Build the provider entry.
  const entry: ProviderEntry = {
    enabled: options.enabled ?? false,
    command: options.command.trim(),
    contextWindowTokens,
  };

  if (providerType) {
    entry.type = providerType;
  }

  const entryOptions: Record<string, unknown> = {};
  if (options.defaultModel) {
    entryOptions.defaultModel = options.defaultModel;
  }
  if (baseUrl) {
    entryOptions.baseUrl = baseUrl;
  }
  if (providerId) {
    entryOptions.providerId = providerId;
  }
  if (options.toolOutputCap !== undefined) {
    entryOptions.toolOutputCap = options.toolOutputCap;
  }
  if (apiMode) {
    entryOptions.apiMode = apiMode;
  }
  if (sessionMode) {
    entryOptions.sessionMode = sessionMode;
  }
  if (Object.keys(entryOptions).length > 0) {
    entry.options = entryOptions;
  }

  if (contextEnabled && ctx !== 'background') {
    entry.contextManagement = {
      enabled: true,
      triggerMetric,
      thresholdRatio,
      recentMessageCount,
      summarizer,
    };
  }

  const appliedContexts: ProviderContext[] = [];

  // Helper to add to a specific section.
  function applyToSection(
    sectionKey: 'agentRunner' | 'backgroundAgent',
    contextLabel: ProviderContext,
    includeContextManagement: boolean,
  ): void {
    // Ensure section exists.
    if (!doc[sectionKey] || typeof doc[sectionKey] !== 'object') {
      doc[sectionKey] = {} as Record<string, unknown>;
    }

    const section = doc[sectionKey] as Record<string, unknown>;

    // Ensure providers object exists.
    if (!section.providers || typeof section.providers !== 'object') {
      section.providers = {} as Record<string, unknown>;
    }

    const providers = section.providers as Record<string, unknown>;

    // Check for duplicate.
    if (options.name in providers) {
      throw new Error(
        `A provider named "${options.name}" already exists in ${sectionKey} context of "${configPath}". Choose a different name or edit the existing entry directly.`,
      );
    }

    const sectionEntry = includeContextManagement
      ? { ...entry }
      : { ...entry, contextManagement: undefined };
    if (entry.options) {
      sectionEntry.options = { ...entry.options };
    }
    if (!includeContextManagement) {
      delete sectionEntry.contextManagement;
    }
    if (sectionKey === 'backgroundAgent' && sectionEntry.options) {
      delete sectionEntry.options.omlxResponses;
      if (sectionEntry.options.sessionMode === 'previous_response_id') {
        delete sectionEntry.options.sessionMode;
      }
      if (options.omlxResponses === true && !explicitApiMode) {
        delete sectionEntry.options.apiMode;
      }
      if (Object.keys(sectionEntry.options).length === 0) {
        delete sectionEntry.options;
      }
    }

    providers[options.name] = sectionEntry;
    appliedContexts.push(contextLabel);
  }

  if (ctx === 'agent-runner' || ctx === 'both') {
    applyToSection('agentRunner', 'agent-runner', contextEnabled);
  }

  if (ctx === 'background' || ctx === 'both') {
    applyToSection('backgroundAgent', 'background', false);
  }

  // Write atomically.
  await writeConfigAtomic(configPath, doc);

  return { entry, contexts: appliedContexts };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/**
 * CLI entrypoint for `talonctl add-provider`.
 *
 * Thin wrapper around {@link addProvider} that prints output and exits.
 */
export async function addProviderCommand(options: AddProviderOptions): Promise<void> {
  try {
    const { entry, contexts } = await addProvider(options);
    const contextList = contexts.join(', ');
    const typeSuffix = entry.type ? `, type: ${entry.type}` : '';
    console.log(
      `Added provider "${options.name}" (command: ${entry.command}${typeSuffix}) to context(s): ${contextList} in "${options.configPath ?? DEFAULT_CONFIG_PATH}".`,
    );
    if (!entry.enabled) {
      console.log(
        `Note: provider is disabled by default. Set enabled: true in "${options.configPath ?? DEFAULT_CONFIG_PATH}" or use --enabled to enable immediately.`,
      );
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
