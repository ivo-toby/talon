/**
 * Host-side tool: channel.list
 *
 * Returns the channels bound to the persona and, per channel, the threads
 * (chat external_ids) the persona is associated with. Used by scheduled
 * tasks running without an `originExternalId` (CLI-created schedules) to
 * discover explicit delivery targets for `channel.send`.
 */

import type pino from 'pino';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import type { ToolExecutionContext } from './channel-send.js';
import type { BindingRepository } from '../../core/database/repositories/binding-repository.js';
import type { ChannelRepository } from '../../core/database/repositories/channel-repository.js';
import type { ThreadRepository } from '../../core/database/repositories/thread-repository.js';
import { ToolError } from '../../core/errors/error-types.js';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ChannelListArgs {}

export interface ChannelListEntry {
  channelName: string;
  channelType: string;
  threadId: string | null;
  externalChatId: string | null;
}

export class ChannelListHandler {
  static readonly manifest: ToolManifest = {
    name: 'channel.list',
    description:
      'Lists the channels bound to the persona and, per channel, the chat external_ids the persona can deliver to. Use this to pick a specific target for channel.send, or to inspect available channels before channel.broadcast.',
    capabilities: ['channel.send:*'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      bindingRepository: Pick<BindingRepository, 'findByPersona'>;
      channelRepository: Pick<ChannelRepository, 'findById'>;
      threadRepository: Pick<ThreadRepository, 'findById'>;
      logger: pino.Logger;
    },
  ) {}

  execute(_args: ChannelListArgs, context: ToolExecutionContext): ToolCallResult {
    const requestId = context.requestId ?? 'unknown';
    const bindingsResult = this.deps.bindingRepository.findByPersona(context.personaId);
    if (bindingsResult.isErr()) {
      const error = new ToolError(`channel.list: failed to load bindings — ${bindingsResult.error.message}`);
      this.deps.logger.warn({ requestId, personaId: context.personaId, err: bindingsResult.error }, error.message);
      return { requestId, tool: 'channel.list', status: 'error', error: error.message };
    }

    const entries: ChannelListEntry[] = [];
    for (const binding of bindingsResult.value) {
      const channelResult = this.deps.channelRepository.findById(binding.channel_id);
      if (channelResult.isErr() || !channelResult.value) {
        this.deps.logger.warn(
          { requestId, bindingId: binding.id, channelId: binding.channel_id, err: channelResult.isErr() ? channelResult.error : undefined },
          'channel.list: skipping binding — channel row missing',
        );
        continue;
      }
      const channel = channelResult.value;
      let threadId: string | null = null;
      let externalChatId: string | null = null;
      if (binding.thread_id !== null) {
        const threadResult = this.deps.threadRepository.findById(binding.thread_id);
        if (threadResult.isOk() && threadResult.value) {
          threadId = threadResult.value.id;
          externalChatId = threadResult.value.external_id;
        } else {
          this.deps.logger.warn(
            { requestId, bindingId: binding.id, threadId: binding.thread_id, err: threadResult.isErr() ? threadResult.error : undefined },
            'channel.list: skipping binding — thread row missing',
          );
          continue;
        }
      }
      entries.push({
        channelName: channel.name,
        channelType: channel.type,
        threadId,
        externalChatId,
      });
    }

    return {
      requestId,
      tool: 'channel.list',
      status: 'success',
      result: entries,
    };
  }
}