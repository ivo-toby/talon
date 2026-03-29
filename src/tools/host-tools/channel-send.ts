/**
 * Host-side tool: channel.send
 *
 * Sends a message to a channel on behalf of a persona. The tool is gated by
 * the `channel.send:<channel-id>` capability and requires either explicit
 * allow or operator approval depending on the persona policy.
 */

import type pino from 'pino';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import type { ChannelRegistry } from '../../channels/channel-registry.js';
import type { ThreadRepository } from '../../core/database/repositories/thread-repository.js';
import { ToolError } from '../../core/errors/error-types.js';

/** Manifest for the channel.send host tool. */
export interface ChannelSendTool {
  readonly manifest: ToolManifest;
}

/** Arguments accepted by the channel.send tool. */
export interface ChannelSendArgs {
  /** Target channel identifier. */
  channelId: string;
  /** Message content in Markdown format. */
  content: string;
  /** Optional thread or message ID to reply to. */
  replyTo?: string;
}

/** Execution context passed to every tool handler. */
export interface ToolExecutionContext {
  runId: string;
  threadId: string;
  personaId: string;
  requestId?: string;
  traceparent?: string;
  /** Set when this run is executing an A2A task. Used for hop-count enforcement. */
  a2aTaskId?: string;
  /** Hop depth of the current A2A task (0 for top-level). */
  a2aHopCount?: number;
}

/**
 * Handler class for the channel.send host tool.
 *
 * Looks up the channel connector by channelId, then calls connector.send()
 * with the provided content. The tool is gated by the
 * `channel.send:<channelId>` capability at the policy layer.
 */
export class ChannelSendHandler {
  /** Static manifest describing the tool. */
  static readonly manifest: ToolManifest = {
    name: 'channel.send',
    description: 'Sends a message to a channel on behalf of a persona.',
    capabilities: ['channel.send:*'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      channelRegistry: ChannelRegistry;
      threadRepository: ThreadRepository;
      logger: pino.Logger;
    },
  ) {}

  /**
   * Execute the channel.send tool.
   *
   * @param args    - Validated tool arguments.
   * @param context - Execution context (runId, threadId, personaId).
   * @returns ToolCallResult with status 'success' or 'error'.
   */
  async execute(args: ChannelSendArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';
    const { channelId, content, replyTo } = args;

    this.deps.logger.info(
      { requestId, runId: context.runId, threadId: context.threadId, personaId: context.personaId, channelId },
      'channel.send: executing',
    );

    // Validate required args
    if (!channelId || typeof channelId !== 'string' || channelId.trim() === '') {
      const error = new ToolError('channel.send: channelId is required and must be a non-empty string');
      this.deps.logger.warn({ requestId, channelId }, error.message);
      return { requestId, tool: 'channel.send', status: 'error', error: error.message };
    }

    if (!content || typeof content !== 'string' || content.trim() === '') {
      const error = new ToolError('channel.send: content is required and must be a non-empty string');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'channel.send', status: 'error', error: error.message };
    }

    // Look up the connector
    const connector = this.deps.channelRegistry.get(channelId);
    if (!connector) {
      const error = new ToolError(`channel.send: channel "${channelId}" not found in registry`);
      this.deps.logger.warn({ requestId, channelId }, error.message);
      return { requestId, tool: 'channel.send', status: 'error', error: error.message };
    }

    // Build the AgentOutput and call send
    const output = {
      body: content,
      ...(replyTo ? { metadata: { replyTo } } : {}),
    };

    // Resolve the thread's external_id (e.g. Telegram chat_id) from the DB.
    const threadResult = this.deps.threadRepository.findById(context.threadId);
    const externalThreadId =
      threadResult.isOk() && threadResult.value
        ? threadResult.value.external_id
        : context.threadId;

    const result = await connector.send(externalThreadId, output);

    if (result.isErr()) {
      const msg = `channel.send: failed to send message — ${result.error.message}`;
      this.deps.logger.error({ requestId, channelId, err: result.error }, msg);
      return { requestId, tool: 'channel.send', status: 'error', error: msg };
    }

    this.deps.logger.info(
      { requestId, channelId, threadId: context.threadId },
      'channel.send: message sent successfully',
    );

    return {
      requestId,
      tool: 'channel.send',
      status: 'success',
      result: { channelId, sent: true },
    };
  }
}
