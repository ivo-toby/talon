/**
 * Host-side tool: channel.react
 *
 * Places an emoji reaction on a message in the current conversation, or
 * removes Talon's reaction from it. Gated by the `channel.react` capability.
 *
 * The target defaults to the message that triggered the current run, so the
 * common case — acknowledging what the user just said — needs only an emoji.
 * Any other message is addressed by the provider message ID shown in reply
 * and reaction context headers (`(id …)`).
 *
 * The tool acts on the run's own conversation only: it takes no channel or
 * chat argument, and delegated (A2A) runs are refused, because the human in
 * the source conversation must not see activity from a delegated persona.
 */

import type pino from 'pino';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import type { ChannelRegistry } from '../../channels/channel-registry.js';
import type { MessageTarget } from '../../channels/channel-types.js';
import type { ChannelRepository } from '../../core/database/repositories/channel-repository.js';
import type { ThreadRepository } from '../../core/database/repositories/thread-repository.js';
import type {
  MessageRefRepository,
  MessageRefRow,
} from '../../core/database/repositories/message-ref-repository.js';
import type { ToolExecutionContext } from './channel-send.js';

const TOOL_NAME = 'channel.react';

/**
 * Upper bound on the emoji argument, in string units. One emoji can be a long
 * ZWJ sequence, but anything beyond this is text, not a reaction.
 */
const MAX_EMOJI_LENGTH = 32;

/** Arguments accepted by the channel.react tool. */
export interface ChannelReactArgs {
  /** The reaction emoji. Not needed when `remove` is true. */
  emoji?: string;
  /**
   * Provider message ID of the message to react to. Defaults to the message
   * that triggered the current run.
   */
  messageId?: string;
  /** Remove Talon's reaction from the message instead of adding one. */
  remove?: boolean;
}

/** Converts a ledger ref into the target a connector reacts to. */
function targetFromRef(ref: MessageRefRow): MessageTarget {
  return {
    externalMessageId: ref.external_id,
    fromSelf: ref.direction === 'outbound',
    ...(ref.sender_id !== null ? { author: ref.sender_id } : {}),
    ...(ref.excerpt !== '' ? { text: ref.excerpt } : {}),
  };
}

/** Recipient chat for a thread; null for a synthetic schedule thread without an origin. */
function resolveExternalThreadId(externalId: string, metadataJson: string | null): string | null {
  if (!externalId.startsWith('schedule:')) return externalId;
  try {
    const parsed = JSON.parse(metadataJson ?? '{}') as Record<string, unknown>;
    if (typeof parsed.originExternalId === 'string' && parsed.originExternalId.trim() !== '') {
      return parsed.originExternalId.trim();
    }
  } catch {
    /* unparseable metadata: no origin */
  }
  return null;
}

/** Handler class for the channel.react host tool. */
export class ChannelReactHandler {
  /** Static manifest describing the tool. */
  static readonly manifest: ToolManifest = {
    name: TOOL_NAME,
    description: 'Places an emoji reaction on a message in the current conversation.',
    capabilities: ['channel.react:*'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      channelRegistry: ChannelRegistry;
      threadRepository: Pick<ThreadRepository, 'findById'>;
      channelRepository: Pick<ChannelRepository, 'findById'>;
      messageRefRepository?: Pick<MessageRefRepository, 'find' | 'findTriggerForRun'>;
      logger: pino.Logger;
    },
  ) {}

  /**
   * Execute the channel.react tool.
   *
   * @param args    - Tool arguments (emoji, optional messageId, optional remove).
   * @param context - Execution context (runId, threadId, personaId).
   * @returns ToolCallResult with status 'success' or 'error'.
   */
  async execute(args: ChannelReactArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';
    const fail = (message: string): ToolCallResult => {
      this.deps.logger.warn(
        { requestId, runId: context.runId, threadId: context.threadId },
        message,
      );
      return { requestId, tool: TOOL_NAME, status: 'error', error: message };
    };

    if (context.a2aTaskId) {
      return fail(
        'channel.react: not available in a delegated task — only the persona talking to the user can react',
      );
    }

    const remove = args.remove === true;
    const emoji = remove ? '' : typeof args.emoji === 'string' ? args.emoji.trim() : '';
    if (!remove && emoji === '') {
      return fail('channel.react: emoji is required (or pass remove: true to clear your reaction)');
    }
    if (emoji.length > MAX_EMOJI_LENGTH) {
      return fail('channel.react: emoji must be a single emoji');
    }

    const threadResult = this.deps.threadRepository.findById(context.threadId);
    if (threadResult.isErr() || !threadResult.value) {
      return fail(`channel.react: thread "${context.threadId}" not found`);
    }
    const thread = threadResult.value;

    const channelResult = this.deps.channelRepository.findById(thread.channel_id);
    if (channelResult.isErr() || !channelResult.value) {
      return fail('channel.react: channel of the current thread not found');
    }
    const channel = channelResult.value;

    const connector = this.deps.channelRegistry.get(channel.name);
    if (!connector) {
      return fail(`channel.react: channel "${channel.name}" is not running`);
    }
    if (typeof connector.react !== 'function') {
      return fail(
        `channel.react: channel "${channel.name}" (${connector.type}) does not support reactions`,
      );
    }

    const externalThreadId = resolveExternalThreadId(thread.external_id, thread.metadata);
    if (externalThreadId === null) {
      return fail(
        'channel.react: this run has no chat to react in (schedule thread without an origin chat)',
      );
    }

    const target = this.resolveTarget(args, context);
    if (typeof target === 'string') {
      return fail(target);
    }

    const result = await connector.react(externalThreadId, target, emoji);
    if (result.isErr()) {
      return fail(`channel.react: ${result.error.message}`);
    }

    this.deps.logger.info(
      {
        requestId,
        runId: context.runId,
        threadId: context.threadId,
        channel: channel.name,
        removed: remove,
      },
      'channel.react: reaction updated',
    );
    return {
      requestId,
      tool: TOOL_NAME,
      status: 'success',
      result: {
        messageId: target.externalMessageId,
        ...(remove ? { removed: true } : { emoji }),
      },
    };
  }

  /**
   * Resolves the message to react to: the explicit `messageId`, completed
   * from the ledger when it is known there, or else the message that
   * triggered the run. Returns an error message when neither is available.
   */
  private resolveTarget(
    args: ChannelReactArgs,
    context: ToolExecutionContext,
  ): MessageTarget | string {
    const refs = this.deps.messageRefRepository;
    const explicitId = typeof args.messageId === 'string' ? args.messageId.trim() : '';

    if (explicitId !== '') {
      const known = refs?.find(context.threadId, explicitId);
      if (known !== undefined && known.isOk() && known.value !== null) {
        return targetFromRef(known.value);
      }
      // Unknown to the ledger (sent before it existed, or a message Talon
      // never processed): the ID alone is enough for most providers.
      return { externalMessageId: explicitId };
    }

    const trigger = refs?.findTriggerForRun(context.runId);
    if (trigger !== undefined && trigger.isOk() && trigger.value !== null) {
      return targetFromRef(trigger.value);
    }
    return (
      'channel.react: this run was not started by a message that can be reacted to. ' +
      'Pass messageId — the "(id …)" shown in a reply or reaction header.'
    );
  }
}
