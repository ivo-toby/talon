/**
 * Channel setup — wires channel connectors to the registry, database, and pipeline.
 *
 * Creates connector instances from config, seeds channel rows in the DB,
 * creates default channel→persona bindings, and registers inbound message
 * handlers. Used by both bootstrap and hot-reload.
 */

import { v4 as uuidv4 } from 'uuid';
import type pino from 'pino';
import type Database from 'better-sqlite3';
import type { TalondConfig, BindingConfig } from '../core/config/config-types.js';
import type { ChannelRepository } from '../core/database/repositories/channel-repository.js';
import type { BindingRepository } from '../core/database/repositories/binding-repository.js';
import type { PersonaRepository } from '../core/database/repositories/persona-repository.js';
import type { ChannelRegistry } from './channel-registry.js';
import type { ChannelConnector, InboundEvent } from './channel-types.js';
import type { MessagePipeline } from '../pipeline/message-pipeline.js';
import { createConnector } from '../daemon/channel-factory.js';
import { SignalConnector } from './connectors/signal/signal-connector.js';
import type { SignalConnectorDependencies } from './connectors/signal/signal-connector.js';
import { parseSignalConfig, type SignalConfig } from './connectors/signal/signal-config.js';
import { SignalDeviceRegistry } from './connectors/signal/signal-device-registry.js';
import { SignalAccountStateRepository } from '../core/database/repositories/signal-account-state-repository.js';
import { SignalDestinationLeaseRepository } from '../core/database/repositories/signal-destination-lease-repository.js';
import type { QueueRepository } from '../core/database/repositories/queue-repository.js';

/**
 * Shared Signal wiring for one configuration generation. Every Signal channel in the
 * generation receives the SAME device registry; repositories share the daemon's SQLite connection.
 */
export interface SignalSetupWiring {
  readonly accounts: SignalAccountStateRepository;
  readonly leases: SignalDestinationLeaseRepository;
  readonly queue: QueueRepository;
  readonly generation: number;
}

/**
 * The Signal account-state and destination-lease repositories for one SQLite connection. Cached
 * per connection so bootstrap and every reload share the SAME objects: the connector owner guard
 * is keyed by the accounts repository instance.
 */
const signalRepositoryCache = new WeakMap<
  Database.Database,
  { accounts: SignalAccountStateRepository; leases: SignalDestinationLeaseRepository }
>();
export function signalRepositoriesFor(db: Database.Database): {
  accounts: SignalAccountStateRepository;
  leases: SignalDestinationLeaseRepository;
} {
  const cached = signalRepositoryCache.get(db);
  if (cached !== undefined) return cached;
  const created = {
    accounts: new SignalAccountStateRepository(db),
    leases: new SignalDestinationLeaseRepository(db),
  };
  signalRepositoryCache.set(db, created);
  return created;
}

/** Dependencies needed to register channels. */
export interface ChannelSetupDeps {
  readonly channelRepo: ChannelRepository;
  readonly bindingRepo: BindingRepository;
  readonly personaRepo: PersonaRepository;
  readonly messagePipeline: MessagePipeline;
  readonly logger: pino.Logger;
  /** Absent means Signal channels are not registered (no shared wiring to construct them with). */
  readonly signal?: SignalSetupWiring;
}

/** Per-generation Signal wiring: dependencies by channel name and the refresh router for the generation. */
interface SignalGenerationWiring {
  readonly dependencies: Map<string, SignalConnectorDependencies>;
  /** Records the connector that owns an account in THIS generation (called when it is constructed). */
  readonly own: (connector: SignalConnector) => void;
}

/**
 * Builds the per-channel Signal dependencies for one generation. Every instance that shares an
 * account ACI with another enabled instance is rejected (the spec rejects duplicate receive
 * ownership rather than racing for it) before any connector is constructed or started; instances
 * of other accounts are unaffected. Log lines carry channel names only, never account identifiers.
 *
 * `requestDeviceRefresh` routes a foreign author ACI to that generation's owning connector. The
 * registry has already coalesced the request; the owner enforces its own persisted budget.
 */
function buildSignalDependencies(
  channels: readonly { name: string; type: string; config: Record<string, unknown> }[],
  wiring: SignalSetupWiring,
  logger: pino.Logger,
): SignalGenerationWiring {
  const parsedChannels: { name: string; config: SignalConfig }[] = [];
  const claims = new Map<string, number>();
  for (const channel of channels) {
    if (channel.type !== 'signal') continue;
    const parsed = parseSignalConfig(channel.config);
    if (parsed.isErr()) {
      logger.warn({ channelName: channel.name }, 'channel-setup: invalid Signal configuration; skipping');
      continue;
    }
    claims.set(parsed.value.accountUuid, (claims.get(parsed.value.accountUuid) ?? 0) + 1);
    parsedChannels.push({ name: channel.name, config: parsed.value });
  }
  const accepted: { name: string; config: SignalConfig }[] = [];
  for (const entry of parsedChannels) {
    if ((claims.get(entry.config.accountUuid) ?? 0) > 1) {
      logger.warn(
        { channelName: entry.name },
        'channel-setup: duplicate Signal account ownership; rejecting this instance',
      );
      continue;
    }
    accepted.push(entry);
  }
  const dependencies = new Map<string, SignalConnectorDependencies>();
  const owners = new Map<string, SignalConnector>();
  const own = (connector: SignalConnector): void => {
    const accountUuid = accepted.find((entry) => entry.name === connector.name)?.config.accountUuid;
    if (accountUuid !== undefined) owners.set(accountUuid, connector);
  };
  if (accepted.length === 0) return { dependencies, own };
  const registry = SignalDeviceRegistry.create(
    wiring.generation,
    accepted.map((entry) => entry.config),
  );
  if (registry.isErr()) {
    logger.warn('channel-setup: Signal device registry rejected; skipping all Signal channels');
    return { dependencies, own };
  }
  const requestDeviceRefresh = (accountUuid: string): void => {
    const owner = owners.get(accountUuid);
    if (owner === undefined) return;
    void owner.requestVerificationRefresh().catch(() => undefined);
  };
  for (const entry of accepted) {
    dependencies.set(entry.name, {
      accounts: wiring.accounts,
      leases: wiring.leases,
      queue: wiring.queue,
      registry: registry.value,
      requestDeviceRefresh,
    });
  }
  return { dependencies, own };
}

/**
 * Registers all enabled channels from config into the registry.
 *
 * For each enabled channel:
 * 1. Creates a connector instance via the channel factory
 * 2. Ensures a channel row exists in the database and its stored config matches the current config
 * 3. Creates a default channel→persona binding if none exists
 * 4. Wires the inbound message handler to the pipeline
 * 5. Registers the connector in the registry
 *
 * @param config          - Full daemon config (channels + personas).
 * @param channelRegistry - Registry to register connectors into.
 * @param deps            - Database repos, pipeline, and logger.
 */
export function registerChannels(
  config: TalondConfig,
  channelRegistry: ChannelRegistry,
  deps: ChannelSetupDeps,
): void {
  const { channelRepo, bindingRepo, personaRepo, messagePipeline, logger } = deps;
  const enabledChannels = config.channels.filter((channel) => channel.enabled);
  const signalWiring: SignalGenerationWiring =
    deps.signal === undefined
      ? { dependencies: new Map<string, SignalConnectorDependencies>(), own: () => undefined }
      : buildSignalDependencies(enabledChannels, deps.signal, logger);
  const signalDependencies = signalWiring.dependencies;

  for (const channelConfig of enabledChannels) {
    const signal = signalDependencies.get(channelConfig.name);
    if (channelConfig.type === 'signal' && signal === undefined) {
      logger.warn(
        { channelName: channelConfig.name },
        'channel-setup: Signal channel not registered (no shared wiring or rejected)',
      );
      continue;
    }
    const connector = createConnector(
      channelConfig.type,
      channelConfig.name,
      channelConfig.config,
      logger,
      signal,
    );
    if (connector === null) {
      logger.warn(
        { channelName: channelConfig.name, channelType: channelConfig.type },
        'channel-setup: unknown connector type; skipping',
      );
      continue;
    }

    // Ensure the channel exists in the database and its stored config matches the current config.
    // Reply paths (e.g. the Signal target check) read the stored row, so a stale row would refuse
    // destinations that the live config already allows.
    const existing = channelRepo.findByName(channelConfig.name);
    const configJson = JSON.stringify(channelConfig.config);
    let channelId: string;
    if (existing.isOk() && existing.value !== null) {
      channelId = existing.value.id;
      if (existing.value.config !== configJson || existing.value.type !== channelConfig.type) {
        const refreshed = channelRepo.update(channelId, {
          type: channelConfig.type,
          config: configJson,
        });
        if (refreshed.isErr()) {
          // Content-free: the config and the DB error may both carry account identifiers.
          logger.warn(
            { channelName: channelConfig.name, channelType: channelConfig.type },
            'channel-setup: failed to refresh stored channel config; keeping stored row',
          );
        }
      }
    } else {
      channelId = uuidv4();
      channelRepo.insert({
        id: channelId,
        type: channelConfig.type,
        name: channelConfig.name,
        config: configJson,
        credentials_ref: null,
        enabled: 1,
      });
    }

    // Create a default binding to the first persona if none exists.
    if (config.personas.length > 0) {
      const defaultBinding = bindingRepo.findDefaultForChannel(channelId);
      if (defaultBinding.isOk() && defaultBinding.value === null) {
        const personaResult = personaRepo.findByName(config.personas[0].name);
        if (personaResult.isOk() && personaResult.value !== null) {
          bindingRepo.insert({
            id: uuidv4(),
            channel_id: channelId,
            thread_id: null,
            persona_id: personaResult.value.id,
            is_default: 1,
          });
          logger.info(
            { channelName: channelConfig.name, persona: config.personas[0].name },
            'channel-setup: created default channel->persona binding',
          );
        }
      }
    }

    if (connector instanceof SignalConnector) {
      signalWiring.own(connector);
      // Signal delivers only through the Result-returning receipt path; ordinary onMessage stays unchanged.
      connector.onMessageWithReceipt((event) => messagePipeline.handleInboundEventWithReceipt(event));
    } else {
      connector.onMessage((event: InboundEvent) => {
        const pipelineResult = messagePipeline.handleInboundEvent(event);
        if (pipelineResult.isErr()) {
          logger.error(
            { channelName: event.channelName, err: pipelineResult.error.message },
            'channel-setup: inbound message pipeline failed',
          );
        }
      });
    }

    channelRegistry.register(connector);
  }

  // Reconcile explicit bindings from config (YAML is source of truth).
  if (config.bindings && config.bindings.length > 0) {
    reconcileBindings(config.bindings, {
      channelRepo,
      bindingRepo,
      personaRepo,
      logger,
    });
  }
}

/**
 * After all connectors have started and resolved their bot identities,
 * inject sibling bot ID sets so each connector can filter messages from
 * other Talon bots of the same type in the same workspace.
 */
export function injectSiblingBotIds(registry: ChannelRegistry, logger: pino.Logger): void {
  const byType = new Map<string, ChannelConnector[]>();
  for (const connector of registry.listAll()) {
    const group = byType.get(connector.type) ?? [];
    group.push(connector);
    byType.set(connector.type, group);
  }

  for (const [type, connectors] of byType) {
    if (connectors.length < 2) continue;

    const botIds = new Set<string>();
    for (const c of connectors) {
      if (c.botUserId) botIds.add(c.botUserId);
    }

    if (botIds.size === 0) continue;

    for (const c of connectors) {
      c.setSiblingBotIds?.(botIds);
    }

    logger.info(
      { type, connectorCount: connectors.length, botIdCount: botIds.size },
      'channel-setup: injected sibling bot IDs',
    );
  }
}

/** Dependencies for binding reconciliation. */
export interface ReconcileBindingsDeps {
  readonly channelRepo: ChannelRepository;
  readonly personaRepo: PersonaRepository;
  readonly bindingRepo: BindingRepository;
  readonly logger: pino.Logger;
}

/**
 * Reconciles DB bindings with the YAML config bindings array.
 *
 * For each binding in config:
 * - If the channel+persona pair already exists as default, leave it.
 * - If a default binding exists but points to a different persona, update it.
 * - If no default binding exists, create one.
 *
 * Bindings for channels NOT mentioned in config are left alone (the
 * auto-default-to-first-persona fallback in registerChannels still applies).
 */
export function reconcileBindings(
  bindings: BindingConfig[],
  deps: ReconcileBindingsDeps,
): void {
  const { channelRepo, personaRepo, bindingRepo, logger } = deps;

  for (const binding of bindings) {
    // Only reconcile default bindings; non-default (thread-scoped) bindings
    // are managed at runtime, not via config reconciliation.
    if (!binding.isDefault) {
      continue;
    }

    const channelResult = channelRepo.findByName(binding.channel);
    if (channelResult.isErr() || channelResult.value === null) {
      logger.warn({ channel: binding.channel }, 'reconcileBindings: channel not found, skipping');
      continue;
    }
    const channelRow = channelResult.value;

    const personaResult = personaRepo.findByName(binding.persona);
    if (personaResult.isErr() || personaResult.value === null) {
      logger.warn({ persona: binding.persona }, 'reconcileBindings: persona not found, skipping');
      continue;
    }
    const personaRow = personaResult.value;

    const existingDefault = bindingRepo.findDefaultForChannel(channelRow.id);
    if (existingDefault.isErr()) {
      logger.warn({ channel: binding.channel }, 'reconcileBindings: failed to query existing binding');
      continue;
    }

    if (existingDefault.value !== null) {
      // A default binding exists — check if it matches.
      if (existingDefault.value.persona_id === personaRow.id) {
        // Already correct — nothing to do.
        continue;
      }
      // Different persona — update it.
      const updateResult = bindingRepo.updatePersona(existingDefault.value.id, personaRow.id);
      if (updateResult.isErr()) {
        logger.error(
          { channel: binding.channel, err: updateResult.error.message },
          'reconcileBindings: failed to update binding',
        );
        continue;
      }
      logger.info(
        { channel: binding.channel, persona: binding.persona },
        'reconcileBindings: updated default binding persona',
      );
    } else {
      // No default binding — create one.
      const insertResult = bindingRepo.insert({
        id: uuidv4(),
        channel_id: channelRow.id,
        thread_id: null,
        persona_id: personaRow.id,
        is_default: 1,
      });
      if (insertResult.isErr()) {
        logger.error(
          { channel: binding.channel, err: insertResult.error.message },
          'reconcileBindings: failed to create binding',
        );
        continue;
      }
      logger.info(
        { channel: binding.channel, persona: binding.persona },
        'reconcileBindings: created default binding from config',
      );
    }
  }
}
