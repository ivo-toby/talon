/**
 * MessagePipeline: atomic local handoff from normalized channel events to the durable queue.
 *
 * Two admission paths, each atomic in its own way:
 *
 *  - Text path (every event without attachments, and ALL Signal events): one local SQLite
 *    transaction wraps channel/thread resolution, dedup, message persist, routing and enqueue
 *    (rolled back as a unit on any failure). `handleInboundEventWithReceipt` exposes the
 *    outcome as a local-commit receipt for connectors that acknowledge remotely only after
 *    that commit. Signal events are text only (`attachments?: never`), so the receipt path
 *    can never bypass image admission.
 *
 *  - Image path (events with attachments, when an {@link ImageIngestionService} is injected):
 *    after thread resolution and normalization the event is handed to the ingestion
 *    coordinator, which stages bytes, then admits the message, its Images and its Ingestion
 *    atomically in its own transaction (so a message is never durable without its recovery
 *    record), resolves Processing outcomes and enqueues exactly once at the commit-together
 *    completion. The pipeline stays the identity authority. This path awaits attachment
 *    staging and therefore cannot run inside a synchronous SQLite transaction; its atomicity
 *    lives in the coordinator.
 *
 * All expected failure paths are returned as Result errors; exceptions are never thrown across
 * the public boundary. The public boundary is async because ingestion stages bytes first.
 */
import { v4 as uuidv4 } from 'uuid';
import type pino from 'pino';
import { ok, err, type Result } from 'neverthrow';
import { PipelineError } from '../core/errors/index.js';
import { runResultTransaction } from '../core/database/transaction.js';
import type { ChannelRepository } from '../core/database/repositories/channel-repository.js';
import type { ThreadRepository } from '../core/database/repositories/thread-repository.js';
import type { MessageRepository } from '../core/database/repositories/message-repository.js';
import type { ChannelRouter } from '../channels/channel-router.js';
import type { QueueManager } from '../queue/queue-manager.js';
import type { AuditLogger } from '../core/logging/audit-logger.js';
import type { InboundEvent, InboundReceipt } from '../channels/channel-types.js';
import { MessageNormalizer } from './message-normalizer.js';
import type { ImageIngestionRequest, ImageIngestionService } from '../images/image-ingestion.js';
import type { NormalizedMessage, PipelineResult, PipelineStats } from './pipeline-types.js';

type AcceptanceResult = Exclude<PipelineResult, 'error'>;
type FailureReason =
  | 'CHANNEL_LOOKUP_FAILED'
  | 'CHANNEL_NOT_FOUND'
  | 'THREAD_LOOKUP_FAILED'
  | 'THREAD_INSERT_FAILED'
  | 'MESSAGE_INSERT_FAILED'
  | 'ROUTING_FAILED'
  | 'ENQUEUE_FAILED'
  | 'UNEXPECTED_FAILURE';

export class MessagePipeline {
  private readonly normalizer = new MessageNormalizer();
  private readonly statsCounters: PipelineStats = {
    processed: 0,
    duplicates: 0,
    noPersona: 0,
    errors: 0,
  };

  /** All repositories (including router/queue/audit) must share one SQLite connection. */
  constructor(
    private readonly messageRepo: MessageRepository,
    private readonly threadRepo: ThreadRepository,
    private readonly channelRepo: ChannelRepository,
    private readonly queueManager: QueueManager,
    private readonly router: ChannelRouter,
    private readonly auditLogger: AuditLogger,
    private readonly logger: pino.Logger,
    /**
     * Durable Ingestion coordinator for image-bearing events. Optional so deployments without
     * image storage keep the text path working; when absent, image-bearing events follow the
     * plain text path (attachments are not admitted).
     */
    private readonly imageIngestion: ImageIngestionService | null = null,
  ) {}

  /**
   * Compatible legacy outcomes for ordinary connector callers. Image-bearing events (with an
   * ingestion coordinator) take the durable Ingestion path; everything else is the atomic
   * text path.
   */
  async handleInboundEvent(event: InboundEvent): Promise<Result<PipelineResult, PipelineError>> {
    const ingestion = this.imageIngestion;
    if (ingestion !== null && event.attachments !== undefined && event.attachments.length > 0) {
      return this.handleImageInboundEvent(event, ingestion);
    }
    return this.acceptInboundEvent(event);
  }

  /** Local transaction completion only, not an acknowledgement to the remote service. */
  handleInboundEventWithReceipt(event: InboundEvent): Result<InboundReceipt, PipelineError> {
    return this.acceptInboundEvent(event).map((outcome) => {
      switch (outcome) {
        case 'enqueued':
          return 'accepted';
        case 'duplicate':
          return 'duplicate';
        case 'no_persona':
          return 'dropped';
      }
    });
  }

  private acceptInboundEvent(event: InboundEvent): Result<AcceptanceResult, PipelineError> {
    this.statsCounters.processed++;
    let result: Result<AcceptanceResult, PipelineError>;
    try {
      // BaseRepository.transaction uses the existing message connection; bootstrap
      // supplies that same connection to thread, binding, queue and audit producers.
      result = runResultTransaction(
        (callback) => this.messageRepo.transaction(callback),
        () => this.processInboundEvent(event),
      );
    } catch (cause) {
      if (event.channelType !== 'signal') {
        this.logger.error({ err: cause }, 'pipeline: unexpected error');
      }
      result = err(this.failure(event, 'UNEXPECTED_FAILURE', cause));
    }

    if (result.isErr()) {
      this.statsCounters.errors++;
      if (event.channelType === 'signal') {
        this.logger.warn(
          { channelName: event.channelName, reason: 'LOCAL_ACCEPTANCE_FAILED' },
          'pipeline: Signal inbound acceptance failed',
        );
      }
    } else if (result.value === 'duplicate') {
      this.statsCounters.duplicates++;
    } else if (result.value === 'no_persona') {
      this.statsCounters.noPersona++;
    }
    return result;
  }

  private processInboundEvent(event: InboundEvent): Result<AcceptanceResult, PipelineError> {
    const channelResult = this.channelRepo.findByName(event.channelName);
    if (channelResult.isErr()) {
      return err(this.failure(event, 'CHANNEL_LOOKUP_FAILED', channelResult.error));
    }
    const channel = channelResult.value;
    if (channel === null) {
      this.logger.warn({ channelName: event.channelName }, 'pipeline: channel not found');
      return err(this.failure(event, 'CHANNEL_NOT_FOUND'));
    }
    const channelId = channel.id;

    const threadResult = this.threadRepo.findByExternalId(channelId, event.externalThreadId);
    if (threadResult.isErr()) {
      return err(this.failure(event, 'THREAD_LOOKUP_FAILED', threadResult.error));
    }
    const threadId = threadResult.value?.id ?? uuidv4();
    if (threadResult.value === null) {
      const insertResult = this.threadRepo.insert({
        id: threadId,
        channel_id: channelId,
        external_id: event.externalThreadId,
        metadata: '{}',
      });
      if (insertResult.isErr()) {
        return err(this.failure(event, 'THREAD_INSERT_FAILED', insertResult.error));
      }
      this.logger.debug(
        event.channelType === 'signal'
          ? { threadId, channelId }
          : { threadId, channelId, externalThreadId: event.externalThreadId },
        'pipeline: created new thread',
      );
    }

    const normalized: Readonly<NormalizedMessage> = this.normalizer.normalize(
      event,
      channelId,
      threadId,
    );
    const scopedIdempotencyKey = `${channelId}:${normalized.idempotencyKey}`;
    if (this.messageRepo.existsByIdempotencyKey(scopedIdempotencyKey)) {
      this.logger.debug(
        event.channelType === 'signal'
          ? { channelName: event.channelName }
          : { idempotencyKey: scopedIdempotencyKey, channelName: event.channelName },
        'pipeline: duplicate message detected, skipping',
      );
      // Historical transcript-only rows deliberately remain duplicates, not repairs.
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
      return err(this.failure(event, 'MESSAGE_INSERT_FAILED', insertResult.error));
    }

    const personaResult = this.router.resolvePersona(channelId, threadId);
    if (personaResult.isErr()) {
      return err(this.failure(event, 'ROUTING_FAILED', personaResult.error));
    }
    const personaId = personaResult.value;
    if (personaId === null) {
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
          messageId: normalized.id,
          ...(event.channelType === 'signal'
            ? {}
            : { externalThreadId: event.externalThreadId, idempotencyKey: scopedIdempotencyKey }),
        },
      });
      return ok('no_persona');
    }

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
      return err(this.failure(event, 'ENQUEUE_FAILED', enqueueResult.error));
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
  }

  /**
   * Image-bearing events: resolve channel and thread, normalize, then delegate the whole
   * durable lifecycle to the ingestion coordinator (admission is atomic there).
   */
  private async handleImageInboundEvent(
    event: InboundEvent,
    ingestion: ImageIngestionService,
  ): Promise<Result<PipelineResult, PipelineError>> {
    this.statsCounters.processed++;

    try {
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

      const normalized = this.normalizer.normalize(event, channelId, threadId);
      return await this.handleImageEvent(event, ingestion, channelId, threadId, normalized);
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

  private failure(event: InboundEvent, reason: FailureReason, cause?: unknown): PipelineError {
    // Returned errors reach shared callback loggers too: never retain a Signal
    // repository error/cause, which may contain untrusted identifiers or content.
    if (event.channelType === 'signal') {
      return new PipelineError(`Signal inbound acceptance failed: ${reason}`);
    }
    const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
    return new PipelineError(
      `Pipeline ${reason}${message ? `: ${message}` : ''}`,
      cause instanceof Error ? cause : undefined,
    );
  }

  /** Snapshot counters count only committed outcomes or rolled-back failures. */
  stats(): PipelineStats {
    return { ...this.statsCounters };
  }
}
