import type { AgentProvider } from './provider.js';
import type { ProviderConfig } from '../core/config/config-types.js';
import type { ProviderName } from './provider-types.js';

export interface ProviderFactoryMap<Config extends ProviderConfig = ProviderConfig> {
  [name: string]: (config: Config) => AgentProvider;
}

export interface ProviderEntry<Config extends ProviderConfig = ProviderConfig> {
  provider: AgentProvider;
  config: Config;
}

export class ProviderRegistry<Config extends ProviderConfig = ProviderConfig> {
  private readonly providers = new Map<ProviderName, ProviderEntry<Config>>();

  constructor(
    configs: Record<string, Config>,
    factories: ProviderFactoryMap<Config>,
  ) {
    for (const [name, config] of Object.entries(configs)) {
      if (!config.enabled) {
        continue;
      }

      const factory = factories[name];
      if (!factory) {
        continue;
      }

      this.providers.set(name, {
        provider: factory(config),
        config,
      });
    }
  }

  get(name: ProviderName): ProviderEntry<Config> | undefined {
    return this.providers.get(name);
  }

  /**
   * True when the provider is registered, enabled, and has a matching factory.
   * Predicate variant of `get` for callers that only need an availability check
   * without retrieving the entry.
   */
  hasProvider(name: ProviderName): boolean {
    return this.providers.has(name);
  }

  getDefault(preferredOrder: ProviderName[]): ProviderEntry<Config> | undefined {
    for (const name of preferredOrder) {
      const entry = this.providers.get(name);
      if (entry) {
        return entry;
      }
    }

    // Map preserves insertion order, so this falls back to the first enabled
    // provider defined in config when no preferred provider matches.
    return this.providers.values().next().value;
  }

  listEnabled(): ProviderName[] {
    return [...this.providers.keys()];
  }
}
