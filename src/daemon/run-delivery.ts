/**
 * Delivery of an agent run's own text to its channel.
 *
 * Wraps the connector for the text blocks a run produces (text flushed
 * before a tool call, then the final block) and adds the three behaviours
 * native replies and reactions need:
 *
 * - **No-reply directive.** A block that is only the `NO_REPLY` sentinel is
 *   not sent: the agent acknowledged with a reaction, or had nothing to say.
 * - **Implicit reply target.** The first block that is sent carries the
 *   message that triggered the run as an implicit reply target; the connector
 *   decides from its `replyToTrigger` setting whether that becomes a native
 *   reply. Later blocks of the same run are plain sends, so one answer never
 *   quotes the same message repeatedly.
 * - **Ledger recording.** The provider message ID from the send receipt is
 *   recorded, so a later reply or reaction on that message resolves back to
 *   this thread.
 *
 * Progress notices ("Thinking...", tool-call descriptions) are not run text
 * and keep going straight through the connector.
 */

import type pino from 'pino';
import { ok, type Result } from 'neverthrow';
import type {
  ChannelConnector,
  OutboundReplyTarget,
  SendReceipt,
} from '../channels/channel-types.js';
import type { ChannelError } from '../core/errors/error-types.js';
import type {
  MessageRefRepository,
  MessageRefRow,
} from '../core/database/repositories/message-ref-repository.js';
import { isNoReplyOutput } from '../channels/no-reply.js';

/** Dependencies of one run's delivery. */
export interface RunDeliveryDeps {
  connector: ChannelConnector;
  /** Provider-side recipient (chat) the run answers into. */
  externalThreadId: string;
  /** Talon thread the sent messages are recorded under. */
  threadId: string;
  /** `messages.id` the run's outbound row will be stored under. */
  outboundMessageId: string;
  /** Message ledger; absent means sends are not recorded. */
  messageRefs?: MessageRefRepository;
  /**
   * Ledger ref of the inbound message that triggered the run, when there is
   * one. Absent for reactions, schedules, and messages without a provider ID.
   */
  trigger?: MessageRefRow | null;
  /**
   * False when the recipient is not this thread's own chat (a schedule
   * thread answering into its origin chat): a ref recorded under the wrong
   * thread could never be resolved, so none is written.
   */
  recordRefs: boolean;
  logger: pino.Logger;
}

/** Builds the implicit reply target for a run from its trigger's ledger ref. */
export function implicitReplyTarget(trigger: MessageRefRow): OutboundReplyTarget {
  return {
    externalMessageId: trigger.external_id,
    implicit: true,
    fromSelf: trigger.direction === 'outbound',
    ...(trigger.sender_id !== null ? { author: trigger.sender_id } : {}),
    ...(trigger.excerpt !== '' ? { text: trigger.excerpt } : {}),
  };
}

/** Sends one run's text blocks to its channel. */
export class RunDelivery {
  private replyTargetUsed = false;

  constructor(private readonly deps: RunDeliveryDeps) {}

  /**
   * Sends one text block. Returns Ok without sending when the block is the
   * no-reply sentinel; otherwise the connector's result.
   */
  async sendText(body: string): Promise<Result<SendReceipt | void, ChannelError>> {
    if (isNoReplyOutput(body)) {
      this.deps.logger.info(
        { threadId: this.deps.threadId },
        'run-delivery: agent returned the no-reply directive; nothing sent',
      );
      return ok(undefined);
    }

    const trigger = this.deps.trigger;
    const replyTo =
      !this.replyTargetUsed && trigger !== undefined && trigger !== null
        ? implicitReplyTarget(trigger)
        : undefined;

    const result = await this.deps.connector.send(this.deps.externalThreadId, {
      body,
      ...(replyTo !== undefined ? { replyTo } : {}),
    });
    if (result.isErr()) {
      return result;
    }
    this.replyTargetUsed = true;
    this.recordSent(result.value, body);
    return result;
  }

  private recordSent(receipt: SendReceipt | void, body: string): void {
    const refs = this.deps.messageRefs;
    const externalMessageId = receipt?.externalMessageId;
    if (
      refs === undefined ||
      !this.deps.recordRefs ||
      externalMessageId === undefined ||
      externalMessageId === ''
    ) {
      return;
    }
    const recorded = refs.record({
      thread_id: this.deps.threadId,
      external_id: externalMessageId,
      direction: 'outbound',
      message_id: this.deps.outboundMessageId,
      text: body,
    });
    if (recorded.isErr()) {
      this.deps.logger.warn(
        { threadId: this.deps.threadId, err: recorded.error.message },
        'run-delivery: failed to record outbound message ref',
      );
    }
  }
}
