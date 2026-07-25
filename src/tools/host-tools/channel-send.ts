/**
 * Host-side tool: channel.send
 *
 * Sends a message to a channel on behalf of a persona. The tool is gated by
 * the `channel.send:<channel-id>` capability and requires either explicit
 * allow or operator approval depending on the persona policy.
 */

import type pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import type { ChannelRegistry } from '../../channels/channel-registry.js';
import type { ThreadRepository } from '../../core/database/repositories/thread-repository.js';
import type { PersonaRepository } from '../../core/database/repositories/persona-repository.js';
import { ToolError } from '../../core/errors/error-types.js';
import type { LifecycleRuntime } from '../../lifecycle/lifecycle-runtime.js';
import type { LifecycleEventEnvelope } from '../../lifecycle/contracts/index.js';
import {
  buildLifecycleContentPreview,
  resolveLifecycleOutboundContent,
} from '../../lifecycle/outbound-content-preview.js';

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
      personaRepository?: PersonaRepository;
      lifecycleRuntime?: LifecycleRuntime;
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
    const externalThreadId =
      readOriginExternalId(threadResult.value.metadata) ?? threadResult.value.external_id;

    const lifecycle = this.prepareLifecycleSend({
      context,
      channelId,
      content,
      externalThreadId,
    });
    if (lifecycle.status === 'error') {
      return { requestId, tool: 'channel.send', status: 'error', error: lifecycle.error };
    }

    const sendContent = lifecycle.content;
    const sendOutput = {
      ...output,
      body: sendContent,
    };

    const result = await connector.send(externalThreadId, sendOutput);

    if (result.isErr()) {
      const msg = `channel.send: failed to send message — ${result.error.message}`;
      this.deps.logger.error({ requestId, channelId, err: result.error }, msg);
      this.publishLifecycleSendEvent('message.send_failed.v1', lifecycle, sendContent, {
        status: 'failed',
        errorLength: result.error.message.length,
      });
      return { requestId, tool: 'channel.send', status: 'error', error: msg };
    }

    this.publishLifecycleSendEvent('message.sent.v1', lifecycle, sendContent, {
      status: 'sent',
    });

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

  private prepareLifecycleSend(input: {
    context: ToolExecutionContext;
    channelId: string;
    content: string;
    externalThreadId: string;
  }):
    | {
        status: 'ready';
        content: string;
        messageId: string;
        personaName: string;
        channelId: string;
        context: ToolExecutionContext;
      }
    | { status: 'error'; error: string } {
    if (!this.deps.lifecycleRuntime) {
      return {
        status: 'ready',
        content: input.content,
        messageId: uuidv4(),
        personaName: input.context.personaId,
        channelId: input.channelId,
        context: input.context,
      };
    }
    const persona = this.deps.personaRepository?.findById(input.context.personaId);
    if (!persona || persona.isErr() || persona.value === null) {
      return {
        status: 'error',
        error: `channel.send: failed to resolve lifecycle persona for ${input.context.personaId}`,
      };
    }
    const messageId = uuidv4();
    const lifecycleContent = buildLifecycleContentPreview(input.content);
    const interception = this.deps.lifecycleRuntime.intercept(
      {
        persona: persona.value.name,
        hook: 'message.before_send',
        itemOrigin: 'tool',
        itemType: 'message',
        channel: input.channelId,
        messageSource: 'outbound',
      },
      {
        version: 'v1',
        interceptionId: uuidv4(),
        hook: 'message.before_send',
        context: this.lifecycleContext('message', messageId, input.context.runId, 'tool'),
        input: {
          messageId,
          content: lifecycleContent.content,
          source: 'outbound',
          recipientId: input.externalThreadId,
          channel: input.channelId,
          persona: persona.value.name,
        },
      },
    );
    if (interception.isErr()) {
      return {
        status: 'error',
        error: `channel.send: lifecycle before_send failed — ${interception.error.message}`,
      };
    }
    if (interception.value.outcome !== 'allow') {
      return {
        status: 'error',
        error: `channel.send: lifecycle before_send blocked delivery — ${interception.value.reason}`,
      };
    }
    const content = resolveLifecycleOutboundContent({
      originalContent: input.content,
      preview: lifecycleContent,
      interceptedContent: (interception.value.input.input as { content: string }).content,
    });
    if (content.isErr()) {
      return {
        status: 'error',
        error: `channel.send: ${content.error.message}`,
      };
    }
    return {
      status: 'ready',
      content: content.value,
      messageId,
      personaName: persona.value.name,
      channelId: input.channelId,
      context: input.context,
    };
  }

  private publishLifecycleSendEvent(
    type: 'message.sent.v1' | 'message.send_failed.v1',
    lifecycle: {
      status: 'ready';
      content: string;
      messageId: string;
      personaName: string;
      channelId: string;
      context: ToolExecutionContext;
    },
    content: string,
    metadata: Record<string, string | number | boolean | null>,
  ): void {
    if (!this.deps.lifecycleRuntime) return;
    const publication = this.deps.lifecycleRuntime.publish({
      event: this.lifecycleEvent(
        type,
        'message',
        lifecycle.messageId,
        lifecycle.context.runId,
        'tool',
        [
          { type: 'message', id: lifecycle.messageId },
          { type: 'thread', id: lifecycle.context.threadId },
          { type: 'run', id: lifecycle.context.runId },
        ],
        {
          direction: 'outbound',
          source: 'tool',
          contentLength: content.length,
          ...metadata,
        },
      ),
      persona: lifecycle.personaName,
      itemOrigin: 'tool',
      itemType: 'message',
      channel: lifecycle.channelId,
      messageSource: 'outbound',
    });
    if (publication.isErr()) {
      this.deps.logger.error(
        {
          requestId: lifecycle.context.requestId ?? 'unknown',
          err: publication.error.message,
          type,
        },
        'channel.send: failed to publish lifecycle send event',
      );
    }
  }

  private lifecycleContext(
    aggregateType: string,
    aggregateId: string,
    correlationId: string,
    source: string,
  ): LifecycleEventEnvelope['context'] {
    return {
      aggregate: { type: aggregateType, id: aggregateId },
      correlationId,
      recursion: { depth: 0, maxDepth: 8 },
      provenance: { source, sourceEventIds: [], sourceReferences: [] },
    };
  }

  private lifecycleEvent(
    type: LifecycleEventEnvelope['type'],
    aggregateType: string,
    aggregateId: string,
    correlationId: string,
    source: string,
    references: LifecycleEventEnvelope['payload']['references'],
    metadata: LifecycleEventEnvelope['payload']['metadata'],
  ): LifecycleEventEnvelope {
    return {
      version: 'v1',
      type,
      eventId: uuidv4(),
      occurredAt: new Date().toISOString(),
      context: this.lifecycleContext(aggregateType, aggregateId, correlationId, source),
      payload: { references, metadata },
    };
  }
}
