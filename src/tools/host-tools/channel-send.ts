/**
 * Host-side tool: channel.send
 *
 * Sends a message to a channel on behalf of a persona. The tool is gated by
 * the `channel.send:<channel-id>` capability and requires either explicit
 * allow or operator approval depending on the persona policy.
 */

import { randomUUID } from 'node:crypto';
import type pino from 'pino';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import type { ChannelRegistry } from '../../channels/channel-registry.js';
import type { ChannelRepository } from '../../core/database/repositories/channel-repository.js';
import type { MessageRepository } from '../../core/database/repositories/message-repository.js';
import type {
  InsertThreadInput,
  ThreadRepository,
  ThreadRow,
} from '../../core/database/repositories/thread-repository.js';
import { ToolError } from '../../core/errors/error-types.js';

/**
 * Returns the origin chat's external_id recorded in a dedicated schedule
 * thread's metadata, or null if the thread is not a schedule thread or the
 * metadata is malformed. Dedicated schedule threads are created by
 * schedule.manage and carry `{ kind: 'schedule', originExternalId: ... }`.
 */
function readOriginExternalId(metadataJson: string | null | undefined): string | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
    if (parsed && parsed.kind === 'schedule' && typeof parsed.originExternalId === 'string') {
      return parsed.originExternalId;
    }
  } catch {
    /* ignore — treat unparseable metadata as absent */
  }
  return null;
}

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
  /**
   * Explicit recipient chat id on the target channel (e.g. Telegram chat_id,
   * Slack channel id). When provided, this takes precedence over any
   * schedule-thread `originExternalId`. Required when the run is on a
   * schedule thread that has no `originExternalId` (CLI-created schedules);
   * in that case the tool errors and points the agent at `channel.list`
   * and `channel.broadcast`.
   */
  externalChatId?: string;
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
  backgroundTaskId?: string;
  primaryExecutionEnvId?: string;
  allowedHostRoots?: string[];
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
      channelRepository?: Pick<ChannelRepository, 'findByName'>;
      messageRepository?: Pick<MessageRepository, 'insert'>;
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
    // Dedicated schedule execution threads store the originating chat's
    // external_id in metadata.originExternalId — prefer that so scheduled
    // runs notify the originating user rather than the synthetic schedule
    // thread id, which is not a valid provider-side recipient.
    //
    // Fail loud when the thread row is missing or unreadable: falling back
    // to context.threadId (a UUID) produced 400 "chat not found" errors
    // that the agent paraphrased as "Telegram unreachable — delivering
    // inline", silently swallowing scheduled notifications (observed in
    // PR #201 production rollout).
    const threadResult = this.deps.threadRepository.findById(context.threadId);
    if (threadResult.isErr()) {
      const msg = `channel.send: failed to resolve thread "${context.threadId}" — ${threadResult.error.message}`;
      this.deps.logger.error({ requestId, threadId: context.threadId, err: threadResult.error }, msg);
      return { requestId, tool: 'channel.send', status: 'error', error: msg };
    }
    if (!threadResult.value) {
      const msg = `channel.send: thread "${context.threadId}" not found — cannot resolve recipient`;
      this.deps.logger.error({ requestId, threadId: context.threadId, channelId }, msg);
      return { requestId, tool: 'channel.send', status: 'error', error: msg };
    }
    const originExternalId = readOriginExternalId(threadResult.value.metadata);
    const fallbackExternalId = threadResult.value.external_id;
    const isSyntheticFallback = fallbackExternalId.startsWith('schedule:');
    // Precedence: explicit externalChatId → schedule-thread originExternalId →
    // thread.external_id when it's a real chat id (non-synthetic). Refuse the
    // synthetic `schedule:<persona>:<channel>` fallback because it isn't a
    // valid provider-side chat id and the connector would reject it with
    // "chat not found" (the silent-failure mode this branch fixes).
    const externalThreadId =
      args.externalChatId ?? originExternalId ?? (isSyntheticFallback ? null : fallbackExternalId);
    if (!externalThreadId) {
      const msg =
        'channel.send: no recipient chat id. This run is on a schedule thread without an originExternalId (likely created from the CLI). ' +
        'Pass `externalChatId` explicitly, or use `channel.list` to discover available chats and `channel.broadcast` to fan out to all bound chats.';
      this.deps.logger.warn(
        { requestId, threadId: context.threadId, channelId, threadExternalId: fallbackExternalId },
        'channel.send: refusing to deliver to synthetic schedule-thread external_id',
      );
      return { requestId, tool: 'channel.send', status: 'error', error: msg };
    }

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
    this.persistOutboundMessage({
      requestId,
      runId: context.runId,
      channelName: channelId,
      externalThreadId,
      content,
    });

    return {
      requestId,
      tool: 'channel.send',
      status: 'success',
      result: { channelId, sent: true },
    };
  }

  private persistOutboundMessage(input: {
    requestId: string;
    runId: string;
    channelName: string;
    externalThreadId: string;
    content: string;
  }): void {
    if (!this.deps.channelRepository || !this.deps.messageRepository) {
      return;
    }

    const targetThread = this.resolveTargetThread(input);
    if (!targetThread) {
      return;
    }

    const idempotencyRequestId =
      input.requestId === 'unknown' ? randomUUID() : input.requestId;
    const insertResult = this.deps.messageRepository.insert({
      id: randomUUID(),
      thread_id: targetThread.id,
      direction: 'outbound',
      content: JSON.stringify({ body: input.content }),
      idempotency_key: `channel-send:${input.runId}:${idempotencyRequestId}`,
      provider_id: null,
      run_id: input.runId,
    });
    if (insertResult.isErr()) {
      this.deps.logger.warn(
        {
          requestId: input.requestId,
          runId: input.runId,
          threadId: targetThread.id,
          err: insertResult.error,
        },
        'channel.send: delivered message but failed to persist outbound context',
      );
    }
  }

  private resolveTargetThread(input: {
    requestId: string;
    channelName: string;
    externalThreadId: string;
  }): ThreadRow | null {
    const channelResult = this.deps.channelRepository!.findByName(input.channelName);
    if (channelResult.isErr()) {
      this.deps.logger.warn(
        {
          requestId: input.requestId,
          channelName: input.channelName,
          err: channelResult.error,
        },
        'channel.send: delivered message but failed to resolve channel for outbound persistence',
      );
      return null;
    }
    const channel = channelResult.value;
    if (!channel) {
      this.deps.logger.warn(
        { requestId: input.requestId, channelName: input.channelName },
        'channel.send: delivered message but channel row was missing for outbound persistence',
      );
      return null;
    }

    const existingResult = this.deps.threadRepository.findByExternalId(
      channel.id,
      input.externalThreadId,
    );
    if (existingResult.isErr()) {
      this.deps.logger.warn(
        {
          requestId: input.requestId,
          channelId: channel.id,
          externalThreadId: input.externalThreadId,
          err: existingResult.error,
        },
        'channel.send: delivered message but failed to resolve recipient thread for outbound persistence',
      );
      return null;
    }
    if (existingResult.value) {
      return existingResult.value;
    }

    const insertInput: InsertThreadInput = {
      id: randomUUID(),
      channel_id: channel.id,
      external_id: input.externalThreadId,
      metadata: '{}',
    };
    const insertResult = this.deps.threadRepository.insert(insertInput);
    if (insertResult.isOk()) {
      return insertResult.value;
    }

    const retryResult = this.deps.threadRepository.findByExternalId(
      channel.id,
      input.externalThreadId,
    );
    if (retryResult.isOk() && retryResult.value) {
      return retryResult.value;
    }

    this.deps.logger.warn(
      {
        requestId: input.requestId,
        channelId: channel.id,
        externalThreadId: input.externalThreadId,
        err: insertResult.error,
      },
      'channel.send: delivered message but failed to create recipient thread for outbound persistence',
    );
    return null;
  }
}
