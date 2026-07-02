/**
 * `talonctl list-providers` command.
 *
 * Prints all providers from both `agentRunner.providers` and
 * `backgroundAgent.providers` in talond.yaml in table format.
 */

import {
  DEFAULT_CONFIG_PATH,
  readConfig,
} from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ListProvidersOptions {
  configPath?: string;
}

export interface ProviderInfo {
  context: 'agent-runner' | 'background';
  name: string;
  type: string;
  enabled: boolean;
  command: string;
  contextWindowTokens: number;
  isDefault: boolean;
  contextManagementEnabled: boolean;
  triggerMetric?: string;
  thresholdRatio?: number;
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Returns all providers from both agentRunner and backgroundAgent config sections.
 *
 * @throws Error if the config file can't be read.
 */
export async function listProviders(options: ListProvidersOptions = {}): Promise<ProviderInfo[]> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const doc = await readConfig(configPath);

  const results: ProviderInfo[] = [];

  // agentRunner.providers
  const agentRunnerSection = doc.agentRunner as Record<string, unknown> | undefined;
  const agentRunnerDefault = typeof agentRunnerSection?.defaultProvider === 'string'
    ? agentRunnerSection.defaultProvider
    : undefined;
  const agentRunnerProviders = agentRunnerSection?.providers as Record<string, unknown> | undefined;
  if (agentRunnerProviders && typeof agentRunnerProviders === 'object') {
    for (const [name, entry] of Object.entries(agentRunnerProviders)) {
      const p = entry as Record<string, unknown>;
      const contextManagement = p.contextManagement as Record<string, unknown> | undefined;
      results.push({
        context: 'agent-runner',
        name,
        type: typeof p.type === 'string' && p.type.trim().length > 0 ? p.type.trim() : name,
        enabled: p.enabled !== false,
        command: typeof p.command === 'string' ? p.command : '',
        contextWindowTokens: typeof p.contextWindowTokens === 'number' ? p.contextWindowTokens : 200000,
        isDefault: agentRunnerDefault === name,
        contextManagementEnabled: contextManagement?.enabled === true,
        triggerMetric: typeof contextManagement?.triggerMetric === 'string' ? contextManagement.triggerMetric : undefined,
        thresholdRatio: typeof contextManagement?.thresholdRatio === 'number' ? contextManagement.thresholdRatio : undefined,
      });
    }
  }

  // backgroundAgent.providers
  const backgroundSection = doc.backgroundAgent as Record<string, unknown> | undefined;
  const backgroundDefault = typeof backgroundSection?.defaultProvider === 'string'
    ? backgroundSection.defaultProvider
    : undefined;
  const backgroundProviders = backgroundSection?.providers as Record<string, unknown> | undefined;
  if (backgroundProviders && typeof backgroundProviders === 'object') {
    for (const [name, entry] of Object.entries(backgroundProviders)) {
      const p = entry as Record<string, unknown>;
      results.push({
        context: 'background',
        name,
        type: typeof p.type === 'string' && p.type.trim().length > 0 ? p.type.trim() : name,
        enabled: p.enabled !== false,
        command: typeof p.command === 'string' ? p.command : '',
        contextWindowTokens: typeof p.contextWindowTokens === 'number' ? p.contextWindowTokens : 200000,
        isDefault: backgroundDefault === name,
        contextManagementEnabled: false,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function listProvidersCommand(options: ListProvidersOptions = {}): Promise<void> {
  try {
    const providers = await listProviders(options);

    if (providers.length === 0) {
      console.log('No providers configured.');
      return;
    }

    // Column widths
    const COL_CONTEXT = 14;
    const COL_NAME = Math.max(14, 'NAME'.length, ...providers.map((p) => p.name.length));
    const COL_TYPE = Math.max(18, 'TYPE'.length, ...providers.map((p) => p.type.length));
    const COL_ENABLED = 7;
    const COL_COMMAND = Math.max(12, 'COMMAND'.length, ...providers.map((p) => p.command.length));
    const COL_CW = 14;
    const COL_CONTEXT_MGMT = 8;
    const COL_TRIGGER = 23;
    const COL_THRESHOLD = 9;
    const COL_DEFAULT = 7;

    // Header
    console.log(
      `${'CONTEXT'.padEnd(COL_CONTEXT)} ${'NAME'.padEnd(COL_NAME)} ${'TYPE'.padEnd(COL_TYPE)} ${'ENABLED'.padEnd(COL_ENABLED)} ${'COMMAND'.padEnd(COL_COMMAND)} ${'CONTEXT WINDOW'.padEnd(COL_CW)} ${'CTX MGMT'.padEnd(COL_CONTEXT_MGMT)} ${'TRIGGER'.padEnd(COL_TRIGGER)} ${'THRESHOLD'.padEnd(COL_THRESHOLD)} DEFAULT`,
    );
    console.log(
      `${'─'.repeat(COL_CONTEXT)} ${'─'.repeat(COL_NAME)} ${'─'.repeat(COL_TYPE)} ${'─'.repeat(COL_ENABLED)} ${'─'.repeat(COL_COMMAND)} ${'─'.repeat(COL_CW)} ${'─'.repeat(COL_CONTEXT_MGMT)} ${'─'.repeat(COL_TRIGGER)} ${'─'.repeat(COL_THRESHOLD)} ${'─'.repeat(COL_DEFAULT)}`,
    );

    for (const p of providers) {
      console.log(
        `${p.context.padEnd(COL_CONTEXT)} ${p.name.padEnd(COL_NAME)} ${p.type.padEnd(COL_TYPE)} ${(p.enabled ? 'yes' : 'no').padEnd(COL_ENABLED)} ${p.command.padEnd(COL_COMMAND)} ${String(p.contextWindowTokens).padEnd(COL_CW)} ${(p.contextManagementEnabled ? 'yes' : 'no').padEnd(COL_CONTEXT_MGMT)} ${(p.triggerMetric ?? '-').padEnd(COL_TRIGGER)} ${String(p.thresholdRatio ?? '-').padEnd(COL_THRESHOLD)} ${p.isDefault ? 'yes' : 'no'}`,
      );
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
