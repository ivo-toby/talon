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
 * Native replies and reactions ride on the same path. A reply's target is
 * resolved through the message ledger and rendered as a header line in the
 * message content; an emoji reaction on one of Talon's messages becomes a
 * message of its own (see `message-context.ts`). Every accepted message with
 * a provider message ID is recorded in the ledger so later replies and
 * reactions can find it.
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
import type { MessageRefRepository } from '../core/database/repositories/message-ref-repository.js';
import type { ChannelRouter } from '../channels/channel-router.js';
import type { QueueManager } from '../queue/queue-manager.js';
import type { AuditLogger } from '../core/logging/audit-logger.js';
import type { InboundEvent } from '../channels/channel-types.js';
import { MessageNormalizer } from './message-normalizer.js';
import type {
  ImageIngestionRequest,
  ImageIngestionService,
} from '../images/image-ingestion.js';
import type { NormalizedMessage, PipelineResult, PipelineStats } from './pipeline-types.js';
import {
  prependReplyHeader,
  renderReactionContent,
  renderReplyHeader,
  type ResolvedMessageReference,
} from './message-context.js';

/** Ledger excerpt recorded for a message that carried media but no text. */
const MEDIA_ONLY_EXCERPT = '[image]';

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
    /**
     * Message ledger for native replies and reactions. Optional: without it
     * reply targets are rendered from what the connector delivered only, no
     * provider message IDs are recorded, and reaction events are ignored.
     */
    private readonly messageRefs: MessageRefRepository | null = null,
  ) {}

  /**
   * Processes a single InboundEvent through the full pipeline.
   *
   * Steps:
   *  1. Resolve channel by name.
   *  1a. Reaction events: resolve the reacted-to message through the ledger
   *      and continue at step 4 on that message's thread, or ignore the event.
   *  2. Resolve (or create) thread by external ID.
   *  2a. Native replies: prefix the content with the resolved reply header.
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
      // Step 1a: Reactions never create a thread and carry no text of their
      // own; they are resolved against the ledger instead.
      // ------------------------------------------------------------------
      if (event.reaction !== undefined) {
        return this.handleReactionEvent(event, channelId);
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
      const normalized = this.normalizer.normalize(
        this.withReplyContext(event, threadId),
        channelId,
        threadId,
      );

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
        const imageResult = await this.handleImageEvent(
          event,
          ingestion,
          channelId,
          threadId,
          normalized,
        );
        if (imageResult.isOk() && imageResult.value !== 'duplicate') {
          this.recordInboundRef(event, threadId, normalized.id);
        }
        return imageResult;
      }

      return this.persistAndEnqueue(event, channelId, threadId, normalized);
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
   * Steps 4–6 for a text message: persist with deduplication, route to a
   * persona, and enqueue. Shared by ordinary messages and reaction events,
   * which differ only in how `normalized.content` was produced.
   */
  private persistAndEnqueue(
    event: InboundEvent,
    channelId: string,
    threadId: string,
    normalized: NormalizedMessage,
  ): Result<PipelineResult, PipelineError> {

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
    this.recordInboundRef(event, threadId, normalized.id);

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
  }

  /**
   * Returns the event with its content prefixed by a reply header when it is
   * a native reply; the event itself otherwise.
   *
   * The target is completed from the ledger: direction tells whether Talon
   * sent it, and the stored excerpt covers providers that deliver only an ID
   * (WhatsApp Cloud API). What the connector delivered wins over the ledger,
   * since a provider quote can be a hand-picked part of the message. A target
   * the ledger does not know is still rendered, as "an earlier message", and
   * is then added to the ledger so the id shown in the header stays usable.
   */
  private withReplyContext(event: InboundEvent, threadId: string): InboundEvent {
    const reply = event.replyTo;
    if (reply === undefined || reply.externalMessageId === '') {
      return event;
    }
    const target: ResolvedMessageReference = {
      externalMessageId: reply.externalMessageId,
      ...(reply.fromSelf !== undefined ? { fromSelf: reply.fromSelf } : {}),
      ...(reply.senderId !== undefined ? { senderId: reply.senderId } : {}),
      ...(reply.text !== undefined && reply.text !== '' ? { text: reply.text } : {}),
    };
    const ledger = this.messageRefs?.find(threadId, reply.externalMessageId);
    if (ledger !== undefined && ledger.isOk() && ledger.value !== null) {
      const ref = ledger.value;
      // The ledger is authoritative for authorship: a WhatsApp Web account is
      // shared with its human owner, so only a recorded outbound message is
      // known to be Talon's.
      target.fromSelf = ref.direction === 'outbound';
      if (target.senderId === undefined && ref.sender_id !== null) {
        target.senderId = ref.sender_id;
      }
      if (target.text === undefined && ref.excerpt !== '') {
        target.text = ref.excerpt;
      }
    } else if (ledger !== undefined && ledger.isErr()) {
      this.logger.warn(
        { threadId, err: ledger.error.message },
        'pipeline: reply target lookup failed; rendering from connector data only',
      );
    } else if (ledger !== undefined) {
      // A target from before the ledger existed. Its id is about to be shown
      // to the agent in the header, so it must be addressable afterwards:
      // record it from what the connector delivered. Only a provider that
      // positively identifies the message as Talon's makes it outbound.
      const recorded = this.messageRefs?.record({
        thread_id: threadId,
        external_id: reply.externalMessageId,
        direction: reply.fromSelf === true ? 'outbound' : 'inbound',
        ...(reply.fromSelf !== true && reply.senderId !== undefined
          ? { sender_id: reply.senderId }
          : {}),
        ...(reply.text !== undefined ? { text: reply.text } : {}),
      });
      if (recorded !== undefined && recorded.isErr()) {
        this.logger.warn(
          { threadId, err: recorded.error.message },
          'pipeline: failed to record reply target ref',
        );
      }
    }
    return {
      ...event,
      content: prependReplyHeader(renderReplyHeader(target, event.senderId), event.content),
    };
  }

  /**
   * Records the inbound message in the ledger. Best effort: the ledger is
   * metadata for later replies and reactions, so a failed write is logged and
   * never fails the message.
   */
  private recordInboundRef(event: InboundEvent, threadId: string, messageId: string): void {
    const refs = this.messageRefs;
    const externalMessageId = event.externalMessageId;
    if (refs === null || externalMessageId === undefined || externalMessageId === '') {
      return;
    }
    const hasMedia = event.attachments !== undefined && event.attachments.length > 0;
    const recorded = refs.record({
      thread_id: threadId,
      external_id: externalMessageId,
      direction: 'inbound',
      message_id: messageId,
      sender_id: event.senderId,
      // The ORIGINAL text, without any reply header added above.
      text: event.content === '' && hasMedia ? MEDIA_ONLY_EXCERPT : event.content,
    });
    if (recorded.isErr()) {
      this.logger.warn(
        { threadId, messageId, err: recorded.error.message },
        'pipeline: failed to record inbound message ref',
      );
    }
  }

  /**
   * Handles an emoji reaction event.
   *
   * Only a reaction on a message Talon itself sent is forwarded: the ledger
   * must hold the target as an outbound message of this chat. Everything else
   * is ignored — reactions on other people's messages in a group, reactions
   * on messages sent before the ledger existed, and removed reactions. A
   * forwarded reaction is persisted and enqueued like a text message, on the
   * thread the target belongs to, so the agent runs with full conversation
   * context and can answer, react back, or stay silent.
   */
  private handleReactionEvent(
    event: InboundEvent,
    channelId: string,
  ): Result<PipelineResult, PipelineError> {
    const reaction = event.reaction;
    const refs = this.messageRefs;
    if (reaction === undefined || refs === null || reaction.emoji === '') {
      this.logger.debug(
        { channelName: event.channelName },
        'pipeline: reaction ignored (removed, or no message ledger)',
      );
      return ok('ignored');
    }

    const targetResult = refs.findInChat(
      channelId,
      event.externalThreadId,
      reaction.targetMessageId,
    );
    if (targetResult.isErr()) {
      this.statsCounters.errors++;
      return err(
        new PipelineError(
          `Failed to resolve reaction target on channel ${channelId}: ${targetResult.error.message}`,
          targetResult.error,
        ),
      );
    }
    const target = targetResult.value;
    if (target === null || target.direction !== 'outbound') {
      this.logger.debug(
        { channelName: event.channelName, known: target !== null },
        'pipeline: reaction ignored (target is not a message Talon sent)',
      );
      return ok('ignored');
    }

    const content = renderReactionContent(reaction.emoji, {
      externalMessageId: target.external_id,
      fromSelf: true,
      ...(target.excerpt !== '' ? { text: target.excerpt } : {}),
    });
    const normalized = this.normalizer.normalize(
      { ...event, content },
      channelId,
      target.thread_id,
    );
    return this.persistAndEnqueue(event, channelId, target.thread_id, normalized);
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
