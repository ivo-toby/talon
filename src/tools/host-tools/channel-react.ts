/**
 * Host-side tool: channel.react
 *
 * Places an emoji reaction on a message in the current conversation, or
 * removes Talon's reaction from it. Gated by the `channel.react` capability.
 *
 * The target defaults to the message that triggered the current run, so the
 * common case — acknowledging what the user just said — needs only an emoji.
 * Any other message is addressed by its provider message ID.
 *
 * An explicit ID must be one the message ledger knows for this conversation.
 * The agent only ever sees those IDs in reply and reaction headers, so an ID
 * the ledger does not know is a guess — typically a number read from the
 * database, where a Telegram `update_id` looks like a message ID but is not
 * one. A guess is never forwarded to the provider: the tool answers with the
 * conversation's recent messages and their real IDs instead, and `list: true`
 * returns the same listing on request.
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
import type {
  ThreadRepository,
  ThreadRow,
} from '../../core/database/repositories/thread-repository.js';
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

/** How many recent messages a listing shows. */
const RECENT_MESSAGE_LIMIT = 12;

/** Excerpt length per listed message, in string units. */
const RECENT_EXCERPT_MAX_CHARS = 80;

/** Arguments accepted by the channel.react tool. */
export interface ChannelReactArgs {
  /** The reaction emoji. Not needed when `remove` or `list` is true. */
  emoji?: string;
  /**
   * Provider message ID of the message to react to. Defaults to the message
   * that triggered the current run.
   */
  messageId?: string;
  /** Remove Talon's reaction from the message instead of adding one. */
  remove?: boolean;
  /**
   * Return the conversation's recent messages with their IDs instead of
   * reacting.
   */
  list?: boolean;
}

/** One message in a recent-messages listing. */
export interface RecentMessage {
  /** Provider message ID — the value to pass as `messageId`. */
  messageId: string;
  /** `you` for a message Talon sent, otherwise the sender's channel identity. */
  from: string;
  /** Bounded plain-text excerpt. */
  text: string;
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

/** Converts a ledger ref into a listing entry. */
function recentMessageFromRef(ref: MessageRefRow): RecentMessage {
  const collapsed = ref.excerpt.replace(/\s+/g, ' ').trim();
  return {
    messageId: ref.external_id,
    from: ref.direction === 'outbound' ? 'you' : (ref.sender_id ?? 'user'),
    text:
      collapsed.length > RECENT_EXCERPT_MAX_CHARS
        ? `${collapsed.slice(0, RECENT_EXCERPT_MAX_CHARS - 1).trimEnd()}…`
        : collapsed,
  };
}

/** Renders a listing as lines for an error message. */
function describeRecent(messages: readonly RecentMessage[]): string {
  if (messages.length === 0) {
    return 'No messages of this conversation have a known id yet.';
  }
  const lines = messages.map(
    (message) => `  id ${message.messageId} — ${message.from}: ${JSON.stringify(message.text)}`,
  );
  return `Recent messages, newest first:\n${lines.join('\n')}`;
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
      threadRepository: Pick<ThreadRepository, 'findById' | 'findByExternalId'>;
      channelRepository: Pick<ChannelRepository, 'findById'>;
      messageRefRepository?: Pick<
        MessageRefRepository,
        'find' | 'findByMessageId' | 'findTriggerForRun' | 'listRecent'
      >;
      logger: pino.Logger;
    },
  ) {}

  /**
   * Execute the channel.react tool.
   *
   * @param args    - Tool arguments (emoji, optional messageId, remove, list).
   * @param context - Execution context (runId, threadId, personaId).
   * @returns ToolCallResult with status 'success' or 'error'.
   */
  async execute(args: ChannelReactArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';
    const fail = (message: string): ToolCallResult => {
      this.deps.logger.warn(
        { requestId, runId: context.runId, threadId: context.threadId },
        // The listing after the first line carries message text; keep it out of logs.
        message.split('\n')[0],
      );
      return { requestId, tool: TOOL_NAME, status: 'error', error: message };
    };

    if (context.a2aTaskId) {
      return fail(
        'channel.react: not available in a delegated task — only the persona talking to the user can react',
      );
    }

    const threadResult = this.deps.threadRepository.findById(context.threadId);
    if (threadResult.isErr() || !threadResult.value) {
      return fail(`channel.react: thread "${context.threadId}" not found`);
    }
    const thread = threadResult.value;

    const externalThreadId = resolveExternalThreadId(thread.external_id, thread.metadata);
    if (externalThreadId === null) {
      return fail(
        'channel.react: this run has no chat to react in (schedule thread without an origin chat)',
      );
    }
    const ledgerThreadId = this.ledgerThreadId(thread, externalThreadId);

    if (args.list === true) {
      return {
        requestId,
        tool: TOOL_NAME,
        status: 'success',
        result: { messages: this.recentMessages(ledgerThreadId) },
      };
    }

    const remove = args.remove === true;
    const emoji = remove ? '' : typeof args.emoji === 'string' ? args.emoji.trim() : '';
    if (!remove && emoji === '') {
      return fail('channel.react: emoji is required (or pass remove: true to clear your reaction)');
    }
    if (emoji.length > MAX_EMOJI_LENGTH) {
      return fail('channel.react: emoji must be a single emoji');
    }

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

    const target = this.resolveTarget(args, context, ledgerThreadId);
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
   * The thread whose ledger holds this chat's messages. A schedule thread
   * answers into its origin chat, whose messages are recorded under that
   * chat's own thread, not under the synthetic schedule thread.
   */
  private ledgerThreadId(thread: ThreadRow, externalThreadId: string): string {
    if (thread.external_id === externalThreadId) {
      return thread.id;
    }
    const origin = this.deps.threadRepository.findByExternalId(thread.channel_id, externalThreadId);
    return origin.isOk() && origin.value ? origin.value.id : thread.id;
  }

  /** The conversation's recent messages, newest first. */
  private recentMessages(ledgerThreadId: string): RecentMessage[] {
    const recent = this.deps.messageRefRepository?.listRecent(ledgerThreadId, RECENT_MESSAGE_LIMIT);
    return recent !== undefined && recent.isOk() ? recent.value.map(recentMessageFromRef) : [];
  }

  /**
   * Resolves the message to react to, or returns an error message.
   *
   * With an explicit `messageId`: the ledger entry with that provider ID, or
   * failing that the entry of the stored message with that internal ID (an
   * agent reading the database sees `messages.id`). An ID the ledger cannot
   * place is refused with the recent-messages listing. Without a ledger the
   * ID cannot be checked and is passed through.
   *
   * Without a `messageId`: the message that triggered the run.
   */
  private resolveTarget(
    args: ChannelReactArgs,
    context: ToolExecutionContext,
    ledgerThreadId: string,
  ): MessageTarget | string {
    const refs = this.deps.messageRefRepository;
    const explicitId = typeof args.messageId === 'string' ? args.messageId.trim() : '';

    if (explicitId !== '') {
      if (refs === undefined) {
        return { externalMessageId: explicitId };
      }
      const byProviderId = refs.find(ledgerThreadId, explicitId);
      if (byProviderId.isOk() && byProviderId.value !== null) {
        return targetFromRef(byProviderId.value);
      }
      const byStoredMessage = refs.findByMessageId(ledgerThreadId, explicitId);
      if (byStoredMessage.isOk() && byStoredMessage.value !== null) {
        return targetFromRef(byStoredMessage.value);
      }
      return (
        `channel.react: "${explicitId}" is not the id of a message in this conversation. ` +
        'Message ids are not stored in the messages table (its numbers are delivery keys, not message ids). ' +
        'Omit messageId to react to the message you are answering, or use an id from this list.\n' +
        describeRecent(this.recentMessages(ledgerThreadId))
      );
    }

    const trigger = refs?.findTriggerForRun(context.runId);
    if (trigger !== undefined && trigger.isOk() && trigger.value !== null) {
      return targetFromRef(trigger.value);
    }
    return (
      'channel.react: this run was not started by a message that can be reacted to. ' +
      'Pass messageId with an id from this list.\n' +
      describeRecent(this.recentMessages(ledgerThreadId))
    );
  }
}
