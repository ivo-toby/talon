/**
 * MessagePipeline — end-to-end message ingestion pipeline.
 *
 * Connects channel connectors to the durable work queue by orchestrating:
 *   InboundEvent → channel lookup → thread resolution → normalization →
 *   deduplication → persona routing → queue enqueue.
 *
 * All expected failure paths are returned as Result errors; exceptions are
 * never thrown across the public boundary.
 */

import { v4 as uuidv4 } from 'uuid';
import type pino from 'pino';
import { ok, err, type Result } from 'neverthrow';
import { PipelineError } from '../core/errors/index.js';
import type { ChannelRepository } from '../core/database/repositories/channel-repository.js';
import type { ThreadRepository } from '../core/database/repositories/thread-repository.js';
import type { MessageRepository } from '../core/database/repositories/message-repository.js';
import type { ChannelRouter } from '../channels/channel-router.js';
import type { QueueManager } from '../queue/queue-manager.js';
import type { AuditLogger } from '../core/logging/audit-logger.js';
import type { InboundEvent } from '../channels/channel-types.js';
import { MessageNormalizer } from './message-normalizer.js';
import type { PipelineResult, PipelineStats } from './pipeline-types.js';
import type { LifecycleRuntime } from '../lifecycle/lifecycle-runtime.js';
import type { LifecycleEventEnvelope } from '../lifecycle/contracts/index.js';

/**
 * Orchestrates the full inbound message lifecycle from raw InboundEvent
 * through to a work item on the durable queue.
 *
 * The pipeline is stateless with respect to messages — all state is in the
 * database. The only mutable state held by this class is the aggregate stats
 * counters.
 */
export class MessagePipeline {
  private readonly normalizer = new MessageNormalizer();
  private readonly statsCounters: PipelineStats = {
    processed: 0,
    duplicates: 0,
    noPersona: 0,
    errors: 0,
  };

  constructor(
    private readonly messageRepo: MessageRepository,
    private readonly threadRepo: ThreadRepository,
    private readonly channelRepo: ChannelRepository,
    private readonly queueManager: QueueManager,
    private readonly router: ChannelRouter,
    private readonly auditLogger: AuditLogger,
    private readonly logger: pino.Logger,
    private readonly lifecycleRuntime?: LifecycleRuntime,
    private readonly resolvePersonaName?: (personaId: string) => Result<string | undefined, Error>,
  ) {}

  /**
   * Processes a single InboundEvent through the full pipeline.
   *
   * Steps:
   *  1. Resolve channel by name.
   *  2. Resolve (or create) thread by external ID.
   *  3. Normalize event to canonical NormalizedMessage.
   *  4. Persist message with INSERT OR IGNORE deduplication.
   *  5. Route to persona via ChannelRouter.
   *  6. Enqueue work item.
   *
   * @param event - The inbound event emitted by a channel connector.
   * @returns Ok(PipelineResult) on all expected outcomes, Err(PipelineError) on unexpected failures.
   */
  handleInboundEvent(event: InboundEvent): Result<PipelineResult, PipelineError> {
    this.statsCounters.processed++;

    try {
      // ------------------------------------------------------------------
      // Step 1: Resolve channel by name.
      // ------------------------------------------------------------------
      const channelResult = this.channelRepo.findByName(event.channelName);
      if (channelResult.isErr()) {
        this.statsCounters.errors++;
        return err(
          new PipelineError(
            `Failed to look up channel '${event.channelName}': ${channelResult.error.message}`,
            channelResult.error,
          ),
        );
      }
      const channel = channelResult.value;
      if (channel === null) {
        this.statsCounters.errors++;
        this.logger.warn({ channelName: event.channelName }, 'pipeline: channel not found');
        return err(new PipelineError(`Channel not found: ${event.channelName}`));
      }
      const channelId = channel.id;

      // ------------------------------------------------------------------
      // Step 2: Resolve or create thread.
      // ------------------------------------------------------------------
      const threadResult = this.threadRepo.findByExternalId(channelId, event.externalThreadId);
      if (threadResult.isErr()) {
        this.statsCounters.errors++;
        return err(
          new PipelineError(
            `Failed to look up thread for channel ${channelId}, external ID '${event.externalThreadId}': ${threadResult.error.message}`,
            threadResult.error,
          ),
        );
      }

      let threadId: string;
      if (threadResult.value !== null) {
        threadId = threadResult.value.id;
      } else {
        // Thread does not exist yet — create it.
        const newThreadId = uuidv4();
        const insertResult = this.threadRepo.insert({
          id: newThreadId,
          channel_id: channelId,
          external_id: event.externalThreadId,
          metadata: '{}',
        });
        if (insertResult.isErr()) {
          this.statsCounters.errors++;
          return err(
            new PipelineError(
              `Failed to create thread for channel ${channelId}, external ID '${event.externalThreadId}': ${insertResult.error.message}`,
              insertResult.error,
            ),
          );
        }
        threadId = newThreadId;
        this.logger.debug(
          { threadId, channelId, externalThreadId: event.externalThreadId },
          'pipeline: created new thread',
        );
      }

      // ------------------------------------------------------------------
      // Step 3: Normalize the event.
      // ------------------------------------------------------------------
      const normalized = this.normalizer.normalize(event, channelId, threadId);

      // ------------------------------------------------------------------
      // Step 4: Persist with INSERT OR IGNORE deduplication.
      // Check before inserting to distinguish duplicate from first insert.
      // ------------------------------------------------------------------
      const scopedIdempotencyKey = `${channelId}:${normalized.idempotencyKey}`;
      const alreadyExists = this.messageRepo.existsByIdempotencyKey(scopedIdempotencyKey);
      if (alreadyExists) {
        this.statsCounters.duplicates++;
        this.logger.debug(
          { idempotencyKey: scopedIdempotencyKey, channelName: event.channelName },
          'pipeline: duplicate message detected, skipping',
        );
        return ok('duplicate');
      }

      // Lifecycle interception needs the configured persona name, while the
      // queue continues to use the persisted persona ID. Resolve it before
      // persistence only when the optional runtime is enabled; the legacy path
      // retains its original lookup order and behaviour.
      let routedPersonaId: string | null | undefined;
      let personaName: string | undefined;
      let content = normalized.content;
      if (this.lifecycleRuntime) {
        const personaResult = this.router.resolvePersona(channelId, threadId);
        if (personaResult.isErr()) {
          this.statsCounters.errors++;
          return err(
            new PipelineError(
              `Failed to resolve persona for channel ${channelId}, thread ${threadId}: ${personaResult.error.message}`,
              personaResult.error,
            ),
          );
        }
        routedPersonaId = personaResult.value;
        if (routedPersonaId !== null) {
          const personaNameResult = this.resolvePersonaName?.(routedPersonaId);
          if (!personaNameResult || personaNameResult.isErr() || !personaNameResult.value) {
            this.statsCounters.errors++;
            return err(
              new PipelineError(`Failed to resolve lifecycle persona for ${routedPersonaId}`),
            );
          }
          personaName = personaNameResult.value;
          const interception = this.lifecycleRuntime.intercept(
            {
              persona: personaName,
              hook: 'message.before_persist',
              itemOrigin: 'channel',
              itemType: 'message',
              channel: event.channelName,
              messageSource: 'inbound',
            },
            {
              version: 'v1',
              interceptionId: uuidv4(),
              hook: 'message.before_persist',
              context: this.lifecycleContext('message', normalized.id, normalized.id, 'channel'),
              input: {
                messageId: normalized.id,
                content,
                source: 'inbound',
                channel: event.channelName,
                persona: personaName,
              },
            },
          );
          if (interception.isErr()) {
            this.statsCounters.errors++;
            return err(
              new PipelineError(`Lifecycle interception failed: ${interception.error.message}`),
            );
          }
          if (interception.value.outcome !== 'allow') {
            this.logger.info(
              { messageId: normalized.id, threadId, reason: interception.value.reason },
              'pipeline: inbound message denied by lifecycle policy',
            );
            return ok('denied');
          }
          content = (interception.value.input.input as { content: string }).content;
        }
      }

      const messageInput = {
        id: normalized.id,
        thread_id: normalized.threadId,
        direction: 'inbound',
        content,
        idempotency_key: scopedIdempotencyKey,
        provider_id: normalized.senderId,
        run_id: null,
      } as const;
      if (this.lifecycleRuntime && personaName && routedPersonaId) {
        const atomicResult = this.lifecycleRuntime.transaction<PipelineResult, PipelineError>(
          (transaction) => {
            const inserted = this.messageRepo.insertIfAbsent(messageInput);
            if (inserted.isErr()) {
              return err(
                new PipelineError(
                  `Failed to persist message with idempotency key '${scopedIdempotencyKey}': ${inserted.error.message}`,
                  inserted.error,
                ),
              );
            }
            if (!inserted.value.inserted) return ok('duplicate' as const);

            const persisted = this.publishMessageEvent(
              'message.persisted.v1',
              normalized.id,
              threadId,
              personaName,
              event.channelName,
              transaction,
            );
            if (persisted.isErr()) return err(persisted.error);

            const routed = this.publishMessageEvent(
              'message.routed.v1',
              normalized.id,
              threadId,
              personaName,
              event.channelName,
              transaction,
              routedPersonaId,
            );
            if (routed.isErr()) return err(routed.error);

            const enqueued = this.queueManager.enqueueInLifecycleTransaction(
              threadId,
              'message',
              {
                messageId: normalized.id,
                channelId,
                channelName: event.channelName,
                senderId: normalized.senderId,
                content,
                timestamp: normalized.timestamp,
                personaId: routedPersonaId,
              },
              { persona: personaName, itemType: 'message' },
              transaction,
              normalized.id,
            );
            if (enqueued.isErr()) {
              return err(
                new PipelineError(
                  `Failed to enqueue message ${normalized.id} for thread ${threadId}: ${enqueued.error.message}`,
                  enqueued.error,
                ),
              );
            }
            return ok('enqueued' as const);
          },
        );
        if (atomicResult.isErr()) {
          this.statsCounters.errors++;
          return err(
            new PipelineError(
              `Failed to atomically process message ${normalized.id}: ${atomicResult.error.message}`,
              atomicResult.error,
            ),
          );
        }
        if (atomicResult.value === 'duplicate') {
          this.statsCounters.duplicates++;
          return ok('duplicate');
        }
        this.logger.info(
          { messageId: normalized.id, threadId, channelId, personaId: routedPersonaId },
          'pipeline: message enqueued',
        );
        return ok('enqueued');
      }

      const insertResult = this.messageRepo.insert(messageInput);
      if (insertResult.isErr()) {
        this.statsCounters.errors++;
        return err(
          new PipelineError(
            `Failed to persist message with idempotency key '${scopedIdempotencyKey}': ${insertResult.error.message}`,
            insertResult.error,
          ),
        );
      }

      // ------------------------------------------------------------------
      // Step 5: Resolve persona via ChannelRouter.
      // ------------------------------------------------------------------
      const personaResult =
        routedPersonaId === undefined
          ? this.router.resolvePersona(channelId, threadId)
          : ok(routedPersonaId);
      if (personaResult.isErr()) {
        this.statsCounters.errors++;
        return err(
          new PipelineError(
            `Failed to resolve persona for channel ${channelId}, thread ${threadId}: ${personaResult.error.message}`,
            personaResult.error,
          ),
        );
      }

      const personaId = personaResult.value;
      if (personaId === null) {
        this.statsCounters.noPersona++;
        this.logger.warn(
          { channelId, threadId, channelName: event.channelName },
          'pipeline: no persona binding found; message dropped',
        );
        this.auditLogger.logChannelSend({
          threadId,
          action: 'pipeline.message.dropped',
          details: {
            reason: 'no_persona',
            channelId,
            channelName: event.channelName,
            externalThreadId: event.externalThreadId,
            messageId: normalized.id,
            idempotencyKey: scopedIdempotencyKey,
          },
        });
        return ok('no_persona');
      }

      // ------------------------------------------------------------------
      // Step 6: Enqueue work item.
      // ------------------------------------------------------------------
      const enqueueResult = this.queueManager.enqueue(
        threadId,
        'message',
        {
          messageId: normalized.id,
          channelId,
          channelName: event.channelName,
          senderId: normalized.senderId,
          content,
          timestamp: normalized.timestamp,
          personaId,
        },
        normalized.id,
      );

      if (enqueueResult.isErr()) {
        this.statsCounters.errors++;
        return err(
          new PipelineError(
            `Failed to enqueue message ${normalized.id} for thread ${threadId}: ${enqueueResult.error.message}`,
            enqueueResult.error,
          ),
        );
      }

      this.logger.info(
        {
          messageId: normalized.id,
          threadId,
          channelId,
          queueItemId: enqueueResult.value.id,
          personaId,
        },
        'pipeline: message enqueued',
      );

      return ok('enqueued');
    } catch (cause) {
      // Catch-all for truly unexpected errors (programming bugs, not domain failures).
      this.statsCounters.errors++;
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error({ err: cause }, `pipeline: unexpected error: ${message}`);
      return err(
        new PipelineError(
          `Unexpected pipeline error: ${message}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Returns a snapshot of running pipeline counters.
   *
   * Counters are updated on every call to `handleInboundEvent` regardless of
   * outcome, making them suitable for health checks and monitoring dashboards.
   */
  stats(): PipelineStats {
    return { ...this.statsCounters };
  }

  private lifecycleContext(
    aggregateType: string,
    aggregateId: string,
    correlationId: string,
    source: string,
  ): LifecycleEventEnvelope['context'] {
    return {
      aggregate: { type: aggregateType, id: aggregateId },
      correlationId,
      recursion: { depth: 0, maxDepth: 8 },
      provenance: { source, sourceEventIds: [], sourceReferences: [] },
    };
  }

  private lifecycleEvent(
    type: LifecycleEventEnvelope['type'],
    aggregateId: string,
    correlationId: string,
    source: string,
    references: LifecycleEventEnvelope['payload']['references'],
    metadata: LifecycleEventEnvelope['payload']['metadata'],
  ): LifecycleEventEnvelope {
    return {
      version: 'v1',
      type,
      eventId: uuidv4(),
      occurredAt: new Date().toISOString(),
      context: this.lifecycleContext('message', aggregateId, correlationId, source),
      payload: { references, metadata },
    };
  }

  private publishMessageEvent(
    type: 'message.persisted.v1' | 'message.routed.v1',
    messageId: string,
    threadId: string,
    personaName: string,
    channelName: string,
    transaction: import('../lifecycle/transaction-context.js').TransactionContext,
    personaId?: string,
  ): Result<void, PipelineError> {
    const references: LifecycleEventEnvelope['payload']['references'] = [
      { type: 'message', id: messageId },
      { type: 'thread', id: threadId },
      ...(personaId ? [{ type: 'persona', id: personaId }] : []),
    ];
    const publication = this.lifecycleRuntime!.publish(
      {
        event: this.lifecycleEvent(type, messageId, messageId, 'channel', references, {
          direction: 'inbound',
          source: 'channel',
        }),
        persona: personaName,
        itemOrigin: 'channel',
        itemType: 'message',
        channel: channelName,
        messageSource: 'inbound',
      },
      transaction,
    );
    return publication.isErr()
      ? err(new PipelineError(`Failed to publish ${type}: ${publication.error.message}`))
      : ok(undefined);
  }
}
