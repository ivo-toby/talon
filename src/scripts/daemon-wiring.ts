/**
 * Builds the script runtime of the daemon from the `scripts` configuration.
 *
 * Called one time at bootstrap, only when `scripts.enabled` is true.
 * `buildScriptRuntime` does not connect to Docker. `reapScriptContainers` does:
 * the bootstrap calls it one time, with a bound of 5 seconds.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import type { Logger } from 'pino';
import type { ChannelRegistry } from '../channels/channel-registry.js';
import type { ScriptsConfig } from '../core/config/config-schema.js';
import type {
  ChannelRepository,
  PersonaRepository,
  ThreadRepository,
} from '../core/database/repositories/index.js';
import { ScriptRepository } from '../core/database/repositories/script-repository.js';
import type { AuditLogger } from '../core/logging/audit-logger.js';
import { resolveThreadRecipient } from '../daemon/schedule-thread-utils.js';
import { createDockerEngineClient, reapBrokerContainers } from '../execution-broker/index.js';
import type { DockerEngineClient } from '../execution-broker/docker-types.js';
import { createApprovalService } from './approval.js';
import { buildScriptBroker } from './config.js';
import { createDaemonProviderFactory, type DaemonProviderDeps } from './daemon-provider.js';
import { installScriptSdk } from './sdk-install.js';
import { createScriptService, type ScriptService } from './service.js';
import { createScriptStore } from './store.js';
import { ScriptError } from './types.js';

export interface ScriptRuntimeDeps {
  config: ScriptsConfig;
  db: Database.Database;
  personaRepo: Pick<PersonaRepository, 'findAll'>;
  threadRepo: Pick<ThreadRepository, 'findById'>;
  channelRepo: Pick<ChannelRepository, 'findById'>;
  channelRegistry: Pick<ChannelRegistry, 'get'>;
  auditLogger: Pick<AuditLogger, 'logToolExecution' | 'logApprovalDecision'>;
  provider: Omit<DaemonProviderDeps, 'logger'>;
  logger: Logger;
}

type Send = (
  channelName: string,
  externalThreadId: string,
  body: string,
) => Promise<Result<void, ScriptError>>;

/** Sends plain text through the connector of a channel. Never throws. */
export function createChannelSender(channelRegistry: Pick<ChannelRegistry, 'get'>): Send {
  return async (channelName, externalThreadId, body) => {
    try {
      const connector = channelRegistry.get(channelName);
      if (!connector) return err(new ScriptError('TOOL_FAILED', 'the channel is not available'));
      const sent = await connector.send(externalThreadId, { body });
      if (sent.isErr()) {
        return err(new ScriptError('TOOL_FAILED', 'the message could not be sent', sent.error));
      }
      return ok(undefined);
    } catch (cause) {
      return err(
        new ScriptError(
          'TOOL_FAILED',
          'the message could not be sent',
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  };
}

/** The bound of the start cleanup. Docker that does not answer must not hold the boot. */
const REAP_TIMEOUT_MS = 5_000;

/**
 * Force-removes the script containers that an earlier process left behind: only
 * containers with the broker label that mount the scripts root. A failure is a
 * warning, never a boot failure. Never throws.
 */
export async function reapScriptContainers(
  config: Pick<ScriptsConfig, 'root' | 'dockerSocket'>,
  logger: Logger,
  client: DockerEngineClient = createDockerEngineClient({ socketPath: config.dockerSocket }),
  timeoutMs = REAP_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((done) => {
    timer = setTimeout(() => done('timeout'), timeoutMs);
    timer.unref();
  });
  try {
    const reaped = await Promise.race([
      reapBrokerContainers(client, resolve(config.root)),
      timeout,
    ]);
    if (reaped === 'timeout') {
      logger.warn('scripts: the removal of old script containers took too long; the start goes on');
    } else if (reaped.isErr()) {
      logger.warn(
        { brokerCode: reaped.error.brokerCode },
        'scripts: old script containers could not be removed',
      );
    } else if (reaped.value > 0) {
      logger.warn({ count: reaped.value }, 'scripts: removed containers of an earlier process');
    }
  } catch {
    logger.warn('scripts: old script containers could not be removed');
  } finally {
    clearTimeout(timer);
  }
}

/** The chat of a thread: its channel name and recipient. Never throws. */
export function createChatResolver(
  threadRepo: Pick<ThreadRepository, 'findById'>,
  channelRepo: Pick<ChannelRepository, 'findById'>,
): (threadId: string) => { channelName: string; externalThreadId: string } | undefined {
  return (threadId) => {
    try {
      const thread = threadRepo.findById(threadId);
      if (thread.isErr() || !thread.value) return undefined;
      const channel = channelRepo.findById(thread.value.channel_id);
      const recipient = resolveThreadRecipient(thread.value);
      if (channel.isErr() || !channel.value || recipient === null) return undefined;
      return { channelName: channel.value.name, externalThreadId: recipient };
    } catch {
      return undefined;
    }
  };
}

export function buildScriptRuntime(deps: ScriptRuntimeDeps): Result<ScriptService, ScriptError> {
  const { config, logger } = deps;
  const root = resolve(config.root);
  try {
    mkdirSync(root, { recursive: true, mode: 0o755 });
  } catch (cause) {
    return err(
      new ScriptError(
        'INVALID_ARGUMENT',
        'the scripts root could not be created',
        cause instanceof Error ? cause : undefined,
      ),
    );
  }
  const installed = installScriptSdk(root);
  if (installed.isErr()) return err(installed.error);

  const personas = deps.personaRepo.findAll();
  if (personas.isErr()) {
    return err(new ScriptError('SANDBOX', 'the personas could not be read', personas.error));
  }
  const broker = buildScriptBroker(
    config,
    personas.value.map((persona) => persona.id),
  );
  if (broker.isErr()) return err(broker.error);

  const repo = new ScriptRepository(deps.db);
  const store = createScriptStore({ root, repo, logger });
  const approval = createApprovalService({ repo, ttlMinutes: config.approvalTtlMinutes, logger });
  if (approval.isErr()) {
    return err(new ScriptError('SANDBOX', 'the open approvals could not be read', approval.error));
  }
  const send = createChannelSender(deps.channelRegistry);

  const service = createScriptService({
    store,
    repo,
    approval: approval.value,
    broker: broker.value,
    config,
    createProvider: createDaemonProviderFactory({ ...deps.provider, logger }),
    send,
    resolveChat: createChatResolver(deps.threadRepo, deps.channelRepo),
    audit(entry) {
      if (entry.action === 'script.approval') deps.auditLogger.logApprovalDecision(entry);
      else deps.auditLogger.logToolExecution(entry);
    },
    logger,
  });

  const recovered = service.recoverStaleRuns();
  if (recovered.isErr()) {
    logger.warn('scripts: open runs of an earlier process could not be closed');
  } else if (recovered.value > 0) {
    logger.warn(
      { count: recovered.value },
      'scripts: closed runs that an earlier process left open',
    );
  }
  return ok(service);
}
