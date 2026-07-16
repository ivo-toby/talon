/**
 * Host-side tool: channel.broadcast
 *
 * Sends a single message to every chat the persona is bound to, across all
 * bound channels. Used by scheduled tasks created from the CLI (which carry
 * no `originExternalId`) to deliberately notify the user everywhere the
 * persona is reachable.
 *
 * Bindings with `thread_id IS NULL` (channel-default bindings used for
 * inbound routing) are skipped with a warning — they have no associated
 * chat id to deliver to, and guessing one would violate the "deliberate
 * broadcast" contract. The skip is surfaced in the tool result so the agent
 * can tell the user which channels were unreachable.
 *
 * Outbound messages are persisted on each resolved recipient thread so
 * follow-up replies on those threads include the broadcast in their
 * context (mirrors channel.send's persistence behavior).
 */

import { randomUUID } from 'node:crypto';
import type pino from 'pino';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import type { ChannelRegistry } from '../../channels/channel-registry.js';
import type { BindingRepository } from '../../core/database/repositories/binding-repository.js';
import type { ChannelRepository } from '../../core/database/repositories/channel-repository.js';
import type { MessageRepository } from '../../core/database/repositories/message-repository.js';
import type { ThreadRepository, ThreadRow } from '../../core/database/repositories/thread-repository.js';
import type { ToolExecutionContext } from './channel-send.js';
import { ToolError } from '../../core/errors/error-types.js';

export interface ChannelBroadcastArgs {
  /** Message content in Markdown format. */
  content: string;
  /** Optional thread or message ID to reply to (applied to every delivery). */
  replyTo?: string;
}

export interface ChannelBroadcastSuccess {
  /** Number of chats the message was delivered to. */
  delivered: number;
  /** Channels skipped because the binding has no thread_id. */
  skipped: Array<{ channelName: string; reason: 'no_thread_binding' }>;
  /** Channels where connector.send returned an error. */
  failed: Array<{ channelName: string; reason: 'send_failed'; message: string }>;
}

export class ChannelBroadcastHandler {
  static readonly manifest: ToolManifest = {
    name: 'channel.broadcast',
    description:
      'Sends a message to every chat the persona is bound to, across all bound channels. Deliberate fan-out — use this only when the schedule has no specific origin chat. Skips channel-default bindings (no associated chat) with a warning.',
    capabilities: ['channel.send:*'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      channelRegistry: ChannelRegistry;
      bindingRepository: Pick<BindingRepository, 'findByPersona'>;
      channelRepository: Pick<ChannelRepository, 'findById'>;
      threadRepository: Pick<ThreadRepository, 'findById' | 'findByExternalId' | 'insert'>;
      messageRepository: Pick<MessageRepository, 'insert'>;
      logger: pino.Logger;
    },
  ) {}

  async execute(args: ChannelBroadcastArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';

    if (!args.content || typeof args.content !== 'string' || args.content.trim() === '') {
      const error = new ToolError('channel.broadcast: content is required and must be a non-empty string');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'channel.broadcast', status: 'error', error: error.message };
    }

    const bindingsResult = this.deps.bindingRepository.findByPersona(context.personaId);
    if (bindingsResult.isErr()) {
      const error = new ToolError(`channel.broadcast: failed to load bindings — ${bindingsResult.error.message}`);
      this.deps.logger.warn({ requestId, personaId: context.personaId, err: bindingsResult.error }, error.message);
      return { requestId, tool: 'channel.broadcast', status: 'error', error: error.message };
    }

    const output = {
      body: args.content,
      ...(args.replyTo ? { metadata: { replyTo: args.replyTo } } : {}),
    };

    let delivered = 0;
    const skipped: ChannelBroadcastSuccess['skipped'] = [];
    const failed: ChannelBroadcastSuccess['failed'] = [];

    for (const binding of bindingsResult.value) {
      const channelResult = this.deps.channelRepository.findById(binding.channel_id);
      if (channelResult.isErr() || !channelResult.value) {
        this.deps.logger.warn(
          { requestId, bindingId: binding.id, channelId: binding.channel_id, err: channelResult.isErr() ? channelResult.error : undefined },
          'channel.broadcast: skipping binding — channel row missing',
        );
        continue;
      }
      const channel = channelResult.value;

      if (binding.thread_id === null) {
        this.deps.logger.warn(
          { requestId, channelId: channel.id, channelName: channel.name, bindingId: binding.id },
          'channel.broadcast: skipping binding — no thread binding; create a thread-scoped binding to receive broadcasts',
        );
        skipped.push({ channelName: channel.name, reason: 'no_thread_binding' });
        continue;
      }

      const threadResult = this.deps.threadRepository.findById(binding.thread_id);
      if (threadResult.isErr() || !threadResult.value) {
        this.deps.logger.warn(
          { requestId, bindingId: binding.id, threadId: binding.thread_id, err: threadResult.isErr() ? threadResult.error : undefined, channelName: channel.name },
          'channel.broadcast: skipping binding — thread row missing',
        );
        continue;
      }
      const thread = threadResult.value;

      const connector = this.deps.channelRegistry.get(channel.name);
      if (!connector) {
        this.deps.logger.warn(
          { requestId, channelName: channel.name },
          'channel.broadcast: connector not registered for channel',
        );
        failed.push({ channelName: channel.name, reason: 'send_failed', message: `connector not registered for channel "${channel.name}"` });
        continue;
      }

      const sendResult = await connector.send(thread.external_id, output);
      if (sendResult.isErr()) {
        this.deps.logger.warn(
          { requestId, channelName: channel.name, threadId: thread.id, externalChatId: thread.external_id, err: sendResult.error },
          'channel.broadcast: connector.send failed — continuing with remaining bindings',
        );
        failed.push({ channelName: channel.name, reason: 'send_failed', message: sendResult.error.message });
        continue;
      }

      this.persistOutboundMessage({
        requestId,
        runId: context.runId,
        channel,
        thread,
        content: args.content,
      });
      delivered += 1;
    }

    const summary: ChannelBroadcastSuccess = { delivered, skipped, failed };
    this.deps.logger.info(
      { requestId, personaId: context.personaId, delivered, skippedCount: skipped.length, failedCount: failed.length },
      'channel.broadcast: complete',
    );

    return {
      requestId,
      tool: 'channel.broadcast',
      status: 'success',
      result: summary,
    };
  }

  private persistOutboundMessage(input: {
    requestId: string;
    runId: string;
    channel: { id: string; name: string };
    thread: ThreadRow;
    content: string;
  }): void {
    const idempotencyRequestId = input.requestId === 'unknown' ? randomUUID() : input.requestId;
    const insertResult = this.deps.messageRepository.insert({
      id: randomUUID(),
      thread_id: input.thread.id,
      direction: 'outbound',
      content: JSON.stringify({ body: input.content }),
      idempotency_key: `channel-broadcast:${input.runId}:${input.thread.id}:${idempotencyRequestId}`,
      provider_id: null,
      run_id: input.runId,
    });
    if (insertResult.isErr()) {
      this.deps.logger.warn(
        { requestId: input.requestId, runId: input.runId, threadId: input.thread.id, err: insertResult.error },
        'channel.broadcast: delivered message but failed to persist outbound context',
      );
    }
  }
}