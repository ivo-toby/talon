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
import type { ThreadRepository } from '../core/database/repositories/thread-repository.js';
import { err, ok, type Result } from 'neverthrow';
import { DbError } from '../core/errors/error-types.js';
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
import { BrowserVoiceConnector } from './connectors/browser-voice.js';
import type { VoiceSessionService } from '../voice/voice-types.js';

/** Dependencies needed to register channels. */
export interface ChannelSetupDeps {
  readonly channelRepo: ChannelRepository;
  readonly bindingRepo: BindingRepository;
  readonly personaRepo: PersonaRepository;
  readonly messagePipeline: MessagePipeline;
  readonly logger: pino.Logger;
  /** Absent means Signal channels are not registered (no shared wiring to construct them with). */
  readonly signal?: SignalSetupWiring;
  /**
   * Needed to reconcile thread-scoped bindings (`bindings[].thread`). When
   * absent those entries are skipped with a warning.
   */
  readonly threadRepo?: Pick<ThreadRepository, 'findByExternalId' | 'insert'>;
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

/** Durable logical channel identity used by browservoice threads. */
export const BROWSER_VOICE_CHANNEL_NAME = 'browser-voice';
export const BROWSER_VOICE_CHANNEL_TYPE = 'voice';

export interface VoiceChannelSetupDeps {
  readonly channelRepo: ChannelRepository;
  readonly logger: pino.Logger;
  readonly bindingRepo?: Pick<BindingRepository, 'findDefaultForChannel' | 'insert' | 'updatePersona'>;
  readonly personaId?: string;
}

export interface VoiceConnectorSetupDeps extends VoiceChannelSetupDeps {
  readonly channelRegistry: ChannelRegistry;
  readonly threadRepository: Pick<ThreadRepository, 'findByExternalId'>;
  readonly sessionService: Pick<VoiceSessionService, 'notifyThread'>;
}

/**
 * Registers the browservoice logical channel without creating a connector.
 * Only sanitized metadata is persisted; access tokens stay in config/auth.
 */
export function registerVoiceChannel(
  deps: VoiceChannelSetupDeps,
  name = BROWSER_VOICE_CHANNEL_NAME,
): Result<string, DbError> {
  const existing = deps.channelRepo.findByName(name);
  if (existing.isErr()) return err(existing.error);
  if (existing.value) {
    if (existing.value.type !== BROWSER_VOICE_CHANNEL_TYPE) {
      return err(
        new DbError(
          `Channel name "${name}" is already used by ${existing.value.type}; refusing to adopt it for browser voice`,
        ),
      );
    }
    const updated = deps.channelRepo.update(existing.value.id, {
      type: BROWSER_VOICE_CHANNEL_TYPE,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });
    if (updated.isErr()) return err(updated.error);
    const binding = ensureVoiceBinding(deps, updated.value?.id ?? existing.value.id);
    if (binding.isErr()) return err(binding.error);
    deps.logger.info({ channelName: name }, 'channel-setup: browser voice channel reconciled');
    return okChannelId(updated.value?.id ?? existing.value.id);
  }

  const inserted = deps.channelRepo.insert({
    id: uuidv4(),
    type: BROWSER_VOICE_CHANNEL_TYPE,
    name,
    config: '{}',
    credentials_ref: null,
    enabled: 1,
  });
  if (inserted.isErr()) return err(inserted.error);
  const binding = ensureVoiceBinding(deps, inserted.value.id);
  if (binding.isErr()) return err(binding.error);
  deps.logger.info({ channelName: name }, 'channel-setup: browser voice channel registered');
  return okChannelId(inserted.value.id);
}

function ensureVoiceBinding(
  deps: VoiceChannelSetupDeps,
  channelId: string,
): Result<void, DbError> {
  if (!deps.bindingRepo || !deps.personaId) return ok(undefined);
  const existing = deps.bindingRepo.findDefaultForChannel(channelId);
  if (existing.isErr()) return err(existing.error);
  if (existing.value) {
    if (existing.value.persona_id !== deps.personaId) {
      const updated = deps.bindingRepo.updatePersona(existing.value.id, deps.personaId);
      if (updated.isErr()) return err(updated.error);
    }
    return ok(undefined);
  }
  const inserted = deps.bindingRepo.insert({
    id: uuidv4(),
    channel_id: channelId,
    thread_id: null,
    persona_id: deps.personaId,
    is_default: 1,
  });
  if (inserted.isErr()) return err(inserted.error);
  return ok(undefined);
}

/** Register the outbound browservoice connector after the session service exists. */
export function registerVoiceConnector(
  deps: VoiceConnectorSetupDeps,
  name = BROWSER_VOICE_CHANNEL_NAME,
): Result<void, DbError> {
  const channel = deps.channelRepo.findByName(name);
  if (channel.isErr()) return err(channel.error);
  if (!channel.value) return err(new DbError(`Browser voice channel "${name}" was not found`));
  if (channel.value.type !== BROWSER_VOICE_CHANNEL_TYPE) {
    return err(
      new DbError(
        `Channel name "${name}" is already used by ${channel.value.type}; refusing to register browser voice`,
      ),
    );
  }
  const existingConnector = deps.channelRegistry.get(name);
  if (existingConnector) {
    if (
      existingConnector.type !== BROWSER_VOICE_CHANNEL_TYPE ||
      !(existingConnector instanceof BrowserVoiceConnector)
    ) {
      return err(
        new DbError(`Channel connector "${name}" is not the browser voice connector`),
      );
    }
    return ok(undefined);
  }

  deps.channelRegistry.register(
    new BrowserVoiceConnector({
      channelId: channel.value.id,
      name,
      threadRepository: deps.threadRepository,
      sessionService: deps.sessionService,
      logger: deps.logger,
    }),
  );
  deps.logger.info({ channelName: name }, 'channel-setup: browser voice connector registered');
  return ok(undefined);
}

function okChannelId(id: string): Result<string, DbError> {
  return ok(id);
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

  // Image intake limits for the image-capable connectors, from the validated
  // top-level `images` section. Connectors without image intake ignore it.
  const imageSettings = {
    maxInputBytes: config.images.maxInputBytes,
    maxPerMessage: config.images.maxPerMessage,
  };

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
      imageSettings,
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
      // The pipeline is async: image-bearing events stage attachment bytes
      // before atomic admission. Await its Result so failures are logged, and
      // contain unexpected throws here so a connector never produces an
      // unhandled rejection.
      connector.onMessage(async (event: InboundEvent) => {
        try {
          const pipelineResult = await messagePipeline.handleInboundEvent(event);
          if (pipelineResult.isErr()) {
            logger.error(
              { channelName: event.channelName, err: pipelineResult.error.message },
              'channel-setup: inbound message pipeline failed',
            );
          }
        } catch (cause) {
          logger.error(
            { channelName: event.channelName, err: cause },
            'channel-setup: inbound message pipeline threw',
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

  // Thread-scoped bindings run even with an empty list: removing the last
  // entry from the YAML must still unbind its conversation.
  reconcileThreadBindings(
    config.bindings ?? [],
    config.channels.map((channel) => channel.name),
    {
      channelRepo,
      bindingRepo,
      personaRepo,
      logger,
      ...(deps.threadRepo ? { threadRepo: deps.threadRepo } : {}),
    },
  );
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
    // Only default bindings are reconciled here. Thread-scoped entries
    // (`thread`) belong to reconcileThreadBindings, and they never act as a
    // channel default even when `isDefault` is set on them.
    if (!binding.isDefault || binding.thread !== undefined) {
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

/** Dependencies for thread-scoped binding reconciliation. */
export interface ReconcileThreadBindingsDeps extends ReconcileBindingsDeps {
  readonly threadRepo?: Pick<ThreadRepository, 'findByExternalId' | 'insert'>;
}

/**
 * Reconciles thread-scoped bindings (`bindings[].thread`) with the database.
 *
 * A thread-scoped binding routes ONE conversation of a channel — a Telegram
 * chat, or a single forum topic — to a persona, ahead of the channel's
 * default binding. For each declared entry the thread row is created when it
 * does not exist yet (the conversation may not have sent a message), and the
 * binding is created or pointed at the declared persona.
 *
 * The YAML is the source of truth for bindings it created: a `config`-owned
 * binding on a configured channel that is no longer declared is removed, so
 * deleting the entry returns the conversation to the channel default.
 * Bindings created any other way (`runtime`) are never removed here; one that
 * the YAML now declares is taken over and becomes `config`-owned.
 *
 * @param bindings       - The full YAML `bindings` list.
 * @param channelNames   - Names of the configured channels; pruning is
 *                         limited to these.
 */
export function reconcileThreadBindings(
  bindings: BindingConfig[],
  channelNames: readonly string[],
  deps: ReconcileThreadBindingsDeps,
): void {
  const { channelRepo, personaRepo, bindingRepo, threadRepo, logger } = deps;
  const declared = bindings.filter((binding) => binding.thread !== undefined);

  if (threadRepo === undefined) {
    if (declared.length > 0) {
      logger.warn(
        { count: declared.length },
        'reconcileThreadBindings: no thread repository available, thread-scoped bindings skipped',
      );
    }
    return;
  }

  /** channel row id -> thread row ids that the YAML declares. */
  const declaredThreads = new Map<string, Set<string>>();

  for (const binding of declared) {
    const externalThreadId = binding.thread as string;
    const context = {
      channel: binding.channel,
      persona: binding.persona,
      thread: externalThreadId,
    };

    const channelResult = channelRepo.findByName(binding.channel);
    if (channelResult.isErr() || channelResult.value === null) {
      logger.warn(context, 'reconcileThreadBindings: channel not found, skipping');
      continue;
    }
    const channelId = channelResult.value.id;

    const personaResult = personaRepo.findByName(binding.persona);
    if (personaResult.isErr() || personaResult.value === null) {
      logger.warn(context, 'reconcileThreadBindings: persona not found, skipping');
      continue;
    }
    const personaId = personaResult.value.id;

    const threadResult = threadRepo.findByExternalId(channelId, externalThreadId);
    if (threadResult.isErr()) {
      logger.error(
        { ...context, err: threadResult.error.message },
        'reconcileThreadBindings: failed to look up thread',
      );
      continue;
    }
    let threadId = threadResult.value?.id;
    if (threadId === undefined) {
      const inserted = threadRepo.insert({
        id: uuidv4(),
        channel_id: channelId,
        external_id: externalThreadId,
        metadata: '{}',
      });
      if (inserted.isErr()) {
        logger.error(
          { ...context, err: inserted.error.message },
          'reconcileThreadBindings: failed to create thread',
        );
        continue;
      }
      threadId = inserted.value.id;
    }

    const known = declaredThreads.get(channelId) ?? new Set<string>();
    if (known.has(threadId)) {
      logger.warn(
        context,
        'reconcileThreadBindings: thread is bound more than once; last entry wins',
      );
    }
    known.add(threadId);
    declaredThreads.set(channelId, known);

    const existing = bindingRepo.findByChannelAndThread(channelId, threadId);
    if (existing.isErr()) {
      logger.error(
        { ...context, err: existing.error.message },
        'reconcileThreadBindings: failed to query existing binding',
      );
      continue;
    }
    if (existing.value !== null) {
      if (existing.value.persona_id === personaId && existing.value.source === 'config') {
        continue;
      }
      const claimed = bindingRepo.claimForConfig(existing.value.id, personaId);
      if (claimed.isErr()) {
        logger.error(
          { ...context, err: claimed.error.message },
          'reconcileThreadBindings: failed to update binding',
        );
        continue;
      }
      logger.info(context, 'reconcileThreadBindings: updated thread binding from config');
      continue;
    }

    const inserted = bindingRepo.insert({
      id: uuidv4(),
      channel_id: channelId,
      thread_id: threadId,
      persona_id: personaId,
      is_default: 0,
      source: 'config',
    });
    if (inserted.isErr()) {
      logger.error(
        { ...context, err: inserted.error.message },
        'reconcileThreadBindings: failed to create binding',
      );
      continue;
    }
    logger.info(context, 'reconcileThreadBindings: created thread binding from config');
  }

  // Remove config-owned bindings the YAML no longer declares.
  for (const channelName of channelNames) {
    const channelResult = channelRepo.findByName(channelName);
    if (channelResult.isErr() || channelResult.value === null) {
      continue;
    }
    const channelId = channelResult.value.id;
    const scoped = bindingRepo.findThreadScopedForChannel(channelId);
    if (scoped.isErr()) {
      logger.warn(
        { channel: channelName, err: scoped.error.message },
        'reconcileThreadBindings: failed to list thread bindings',
      );
      continue;
    }
    const keep = declaredThreads.get(channelId) ?? new Set<string>();
    for (const row of scoped.value) {
      if (row.source !== 'config' || row.thread_id === null || keep.has(row.thread_id)) {
        continue;
      }
      const removed = bindingRepo.delete(row.id);
      if (removed.isErr()) {
        logger.error(
          { channel: channelName, err: removed.error.message },
          'reconcileThreadBindings: failed to remove binding',
        );
        continue;
      }
      logger.info(
        { channel: channelName, threadId: row.thread_id },
        'reconcileThreadBindings: removed thread binding no longer in config',
      );
    }
  }
}
