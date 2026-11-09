/**
 * MessagePipeline — end-to-end message ingestion pipeline.
 *
 * Connects channel connectors to the durable work queue by orchestrating:
 *   InboundEvent → channel lookup → thread resolution → normalization →
 *   deduplication → persona routing → queue enqueue.
 *
 * Image-bearing events take the durable Ingestion path instead: after thread
 * resolution and normalization they are handed to the injected
 * {@link ImageIngestionService}, which admits the message, its Images, and its
 * Ingestion atomically (so a message is never durable without its recovery
 * record), resolves Processing outcomes, and enqueues exactly once at the
 * commit-together completion. The pipeline stays the identity authority: the
 * coordinator receives trusted channel/thread/persona context, never guesses.
 *
 * All expected failure paths are returned as Result errors; exceptions are
 * never thrown across the public boundary. The public boundary is async
 * because ingestion stages attachment bytes before admitting them.
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
import type {
  ImageIngestionRequest,
  ImageIngestionService,
} from '../images/image-ingestion.js';
import type { PipelineResult, PipelineStats } from './pipeline-types.js';

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
    /**
     * Durable Ingestion coordinator for image-bearing events. Optional so
     * deployments without image storage keep the text path working; when
     * absent, image-bearing events follow the plain text path (attachments
     * are not admitted).
     */
    private readonly imageIngestion: ImageIngestionService | null = null,
  ) {}

  /**
   * Processes a single InboundEvent through the full pipeline.
   *
   * Steps:
   *  1. Resolve channel by name.
   *  2. Resolve (or create) thread by external ID.
   *  3. Normalize event to canonical NormalizedMessage.
   *  3a. Image-bearing events (with an ingestion coordinator): hand off to
   *      durable Ingestion — atomic admission, Processing, and
   *      commit-together enqueue happen there.
   *  4. Persist message with INSERT OR IGNORE deduplication.
   *  5. Route to persona via ChannelRouter.
   *  6. Enqueue work item.
   *
   * @param event - The inbound event emitted by a channel connector.
   * @returns Ok(PipelineResult) on all expected outcomes, Err(PipelineError) on unexpected failures.
   */
  async handleInboundEvent(event: InboundEvent): Promise<Result<PipelineResult, PipelineError>> {
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
      // Step 3a: Image-bearing events go through durable Ingestion. The
      // coordinator owns message persistence, deduplication, Image
      // admission, Processing, and the commit-together enqueue for these
      // events; the text steps below must not double-write them.
      // ------------------------------------------------------------------
      const ingestion = this.imageIngestion;
      if (
        ingestion !== null &&
        event.attachments !== undefined &&
        event.attachments.length > 0
      ) {
        return await this.handleImageEvent(
          event,
          ingestion,
          channelId,
          threadId,
          normalized,
        );
      }

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

      const insertResult = this.messageRepo.insert({
        id: normalized.id,
        thread_id: normalized.threadId,
        direction: 'inbound',
        content: normalized.content,
        idempotency_key: scopedIdempotencyKey,
        provider_id: normalized.senderId,
        run_id: null,
      });
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
          content: normalized.content,
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
   * Durable Ingestion path for image-bearing events.
   *
   * Resolves the persona first (the coordinator needs the routing decision
   * to choose between pending Ingestion and a terminal admission record),
   * then delegates the whole durable lifecycle. Counter and audit behavior
   * mirrors the text path so monitoring stays comparable across both.
   */
  private async handleImageEvent(
    event: InboundEvent,
    ingestion: ImageIngestionService,
    channelId: string,
    threadId: string,
    normalized: ReturnType<MessageNormalizer['normalize']>,
  ): Promise<Result<PipelineResult, PipelineError>> {
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
    const personaId = personaResult.value;

    const request: ImageIngestionRequest = {
      channelId,
      channelName: event.channelName,
      externalMessageId: normalized.idempotencyKey,
      externalChatId: event.externalThreadId,
      threadId,
      message: {
        id: normalized.id,
        content: normalized.content,
        senderId: normalized.senderId,
        idempotencyKey: normalized.idempotencyKey,
      },
      attachments: event.attachments ?? [],
      personaId,
      // No queue payload is carried: the coordinator rebuilds completion
      // payloads from the committed Message row and the route persisted
      // with the Ingestion, so a redelivery can never enqueue a view that
      // disagrees with what the ledger stored. Payloads stay text and
      // metadata only — never pixels or local paths
      // (docs/adr/0001-vision-subagent.md).
    };

    const outcome = await ingestion.ingestMessage(request);
    if (outcome.isErr()) {
      this.statsCounters.errors++;
      return err(outcome.error);
    }

    if (outcome.value === 'no_persona') {
      this.statsCounters.noPersona++;
      this.logger.warn(
        { channelId, threadId, channelName: event.channelName },
        'pipeline: no persona binding found; image message admitted unrouted',
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
          idempotencyKey: `${channelId}:${normalized.idempotencyKey}`,
        },
      });
      return ok('no_persona');
    }

    if (outcome.value === 'duplicate') {
      this.statsCounters.duplicates++;
      this.logger.debug(
        { messageId: normalized.id, channelId },
        'pipeline: duplicate image message joined its active owner',
      );
      return ok('duplicate');
    }

    this.logger.info(
      { messageId: normalized.id, threadId, channelId, personaId },
      'pipeline: image message ingested and enqueued',
    );
    return ok('enqueued');
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
}
