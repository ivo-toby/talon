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
import type { GovernanceService } from '../governance/governance-service.js';
import { MessageNormalizer } from './message-normalizer.js';
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
    rateLimited: 0,
    errors: 0,
  };

  private governanceService?: GovernanceService;

  constructor(
    private readonly messageRepo: MessageRepository,
    private readonly threadRepo: ThreadRepository,
    private readonly channelRepo: ChannelRepository,
    private readonly queueManager: QueueManager,
    private readonly router: ChannelRouter,
    private readonly auditLogger: AuditLogger,
    private readonly logger: pino.Logger,
  ) {}

  /**
   * Sets the governance service for inbound rate limiting.
   * Called after bootstrap when governance config is present.
   */
  setGovernanceService(service: GovernanceService): void {
    this.governanceService = service;
  }

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
      // Step 1b: Governance — inbound rate limiting.
      // ------------------------------------------------------------------
      if (this.governanceService) {
        const rateResult = this.governanceService.checkInboundRate(channelId, event.senderId);
        if (rateResult.isErr()) {
          this.statsCounters.rateLimited++;
          this.logger.warn(
            { channelId, senderId: event.senderId, reason: rateResult.error.message },
            'pipeline: inbound rate limit exceeded — message dropped',
          );
          this.auditLogger.logChannelSend({
            threadId: undefined,
            action: 'pipeline.message.rate_limited',
            details: {
              channelId,
              channelName: event.channelName,
              senderId: event.senderId,
              reason: rateResult.error.code,
            },
          });
          return ok('rate_limited');
        }
      }

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
   * Returns a snapshot of running pipeline counters.
   *
   * Counters are updated on every call to `handleInboundEvent` regardless of
   * outcome, making them suitable for health checks and monitoring dashboards.
   */
  stats(): PipelineStats {
    return { ...this.statsCounters };
  }
}
