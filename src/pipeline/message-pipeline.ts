/** Atomic local handoff from normalized channel events to the durable queue. */
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
  ) {}

  /** Compatible legacy outcomes for ordinary connector callers. */
  handleInboundEvent(event: InboundEvent): Result<PipelineResult, PipelineError> {
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
