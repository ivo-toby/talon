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
import type { BindingRepository } from '../../core/database/repositories/binding-repository.js';
import type { MessageRefRepository } from '../../core/database/repositories/message-ref-repository.js';
import type {
  AgentOutput,
  ChannelConnector,
  OutboundReplyTarget,
  SendReceipt,
} from '../../channels/channel-types.js';
import { ToolError } from '../../core/errors/error-types.js';
import type { ResolvedCapabilities } from '../../personas/persona-types.js';
import { hasCapabilityPrefix } from '../tool-filter.js';
import {
  resolveOutboundAttachments,
  type OutboundAttachmentPolicy,
} from '../../attachments/outbound-attachment-resolver.js';
import {
  toAttachmentMetadata,
  type OutboundAttachment,
  type OutboundAttachmentMetadata,
  type OutboundAttachmentRefusal,
} from '../../attachments/outbound-attachment-types.js';
import {
  attachmentFailureNotice,
  attachmentLedgerText,
  attachmentSummaryLine,
} from '../../attachments/outbound-attachment-text.js';
import {
  isVoiceObservationContext,
  type VoiceObservationContext,
} from '../../observability/langfuse/voice-observation.js';

function voiceDiagnosticFields(
  voiceObservation: VoiceObservationContext,
  extras: Record<string, string | boolean> = {},
): Record<string, string | boolean> {
  return {
    voice: true,
    ...(voiceObservation.runId ? { runId: voiceObservation.runId } : {}),
    ...(voiceObservation.threadId ? { threadId: voiceObservation.threadId } : {}),
    ...extras,
  };
}

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
  /**
   * Provider message ID of a message in the recipient chat to send this as a
   * native reply to (the "(id …)" shown in reply and reaction headers).
   * Ignored by channels without native replies.
   */
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
  /**
   * Files to attach, each an absolute host path inside
   * `attachments.outbound.allowedRoots`. Requires the `channel.attach`
   * capability. When present, `content` may be empty.
   */
  attachments?: unknown;
}

/** Capability label prefix that allows attachments on channel.send. */
export const CHANNEL_ATTACH_CAPABILITY = 'channel.attach';

/** Execution context passed to every tool handler. */
export interface ToolExecutionContext {
  runId: string;
  threadId: string;
  personaId: string;
  requestId?: string;
  traceparent?: string;
  /** Server-owned context for content-free voice observations. */
  voiceObservation?: VoiceObservationContext;
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
      channelRepository?: Pick<ChannelRepository, 'findByName' | 'findById'>;
      messageRepository?: Pick<MessageRepository, 'insert'>;
      /**
       * When provided, outbound persistence is gated on the current
       * persona being bound to the target — either via a thread-scoped
       * binding for `(channel, targetThread)` or via a channel-default
       * binding (mirrors `ChannelRouter.resolvePersona`'s fallback). This
       * prevents a persona from polluting an unbound thread's message
       * history when `externalChatId` deliberately targets a chat the
       * persona is not bound to. The capability check still permits the
       * send itself.
       */
      bindingRepository?: Pick<
        BindingRepository,
        'findByChannelAndThread' | 'findDefaultForChannel'
      >;
      /**
       * When provided, the recipient thread's session is force-rotated
       * whenever an outbound message is persisted to a thread other than
       * the current run's thread (the scheduled-task cross-thread case).
       * Without this, the next run on the recipient thread resumes its
       * codex session and ContextAssembler is skipped (agent-runner.ts),
       * so the agent never sees the scheduled outbound in context — even
       * though it's in the DB. Rotating forces a fresh session and lets
       * ContextAssembler inject the recent messages including the
       * scheduled outbound. The cost is one cache miss per cross-thread
       * delivery; acceptable for scheduled tasks (few per hour).
       */
      sessionTracker?: { rotateSession: (threadId: string) => void };
      /**
       * Message ledger. When provided, a `replyTo` target is completed from
       * it (author and text, which some providers need to build a quote) and
       * the sent message's provider ID is recorded on the recipient thread so
       * later replies and reactions on it resolve.
       */
      messageRefRepository?: Pick<MessageRefRepository, 'find' | 'record'>;
      /**
       * Resolves the calling persona's capabilities, fail-closed. Required
       * for attachments: without it every attachment request is refused.
       */
      resolveCapabilities?: (personaId: string) => ResolvedCapabilities;
      /**
       * Outbound attachment policy from `attachments.outbound`. Without it
       * (or with no allowed roots) attachments are disabled.
       */
      attachmentPolicy?: OutboundAttachmentPolicy;
      /**
       * Returns the thread artifacts directory. When set, the run's own
       * thread artifacts directory is an extra allowed root, exempt from
       * the policy's `deniedPaths` (which include the data directory).
       */
      threadArtifactsDir?: (threadId: string) => string;
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
    const voiceObservation = isVoiceObservationContext(context.voiceObservation)
      ? context.voiceObservation
      : undefined;
    let { channelId } = args;
    const { content, replyTo } = args;

    this.deps.logger.info(
      voiceObservation
        ? voiceDiagnosticFields(voiceObservation, { event: 'channel_send' })
        : {
            requestId,
            runId: context.runId,
            threadId: context.threadId,
            personaId: context.personaId,
            channelId,
          },
      'channel.send: executing',
    );

    // Validate required args
    if (!channelId || typeof channelId !== 'string' || channelId.trim() === '') {
      const error = new ToolError('channel.send: channelId is required and must be a non-empty string');
      this.deps.logger.warn(
        voiceObservation
          ? voiceDiagnosticFields(voiceObservation, { errorCategory: 'policy' })
          : { requestId, channelId },
        voiceObservation ? 'channel.send: invalid channel id' : error.message,
      );
      return { requestId, tool: 'channel.send', status: 'error', error: error.message };
    }

    const hasAttachments = Array.isArray(args.attachments)
      ? args.attachments.length > 0
      : args.attachments !== undefined && args.attachments !== null;
    if (
      typeof content !== 'string' ||
      (content.trim() === '' && !hasAttachments)
    ) {
      const error = new ToolError('channel.send: content is required and must be a non-empty string');
      this.deps.logger.warn(
        voiceObservation
          ? voiceDiagnosticFields(voiceObservation, { errorCategory: 'policy' })
          : { requestId },
        voiceObservation ? 'channel.send: invalid content' : error.message,
      );
      return { requestId, tool: 'channel.send', status: 'error', error: error.message };
    }

    // A configured channel name always wins over a provider-type alias.
    // Resolve an alias only for the current inbound channel, never for a
    // scheduled thread or a cross-chat send with an explicit recipient.
    if (!this.deps.channelRegistry.get(channelId) &&
        !(typeof args.externalChatId === 'string' && args.externalChatId.trim()) &&
        this.deps.channelRepository) {
      const origin = this.deps.threadRepository.findById(context.threadId);
      if (origin.isOk() && origin.value && !origin.value.external_id.startsWith('schedule:')) {
        const currentChannel = this.deps.channelRepository.findById(origin.value.channel_id);
        if (currentChannel.isOk() && currentChannel.value?.type === channelId &&
            this.deps.channelRegistry.get(currentChannel.value.name)) {
          channelId = currentChannel.value.name;
        }
      }
    }

    // Look up the connector
    const connector = this.deps.channelRegistry.get(channelId);
    if (!connector) {
      const error = new ToolError(`channel.send: channel "${channelId}" not found in registry`);
      this.deps.logger.warn(
        voiceObservation
          ? voiceDiagnosticFields(voiceObservation, { errorCategory: 'unknown' })
          : { requestId, channelId },
        voiceObservation ? 'channel.send: channel lookup failed' : error.message,
      );
      return { requestId, tool: 'channel.send', status: 'error', error: error.message };
    }

    // Attachments are validated and read before anything is sent: a refused
    // request sends nothing, not even the text.
    let attachments: OutboundAttachment[] = [];
    if (hasAttachments) {
      const prepared = await this.prepareAttachments(args.attachments, connector, context);
      if (!Array.isArray(prepared)) {
        return { requestId, tool: 'channel.send', status: 'error', error: prepared.error };
      }
      attachments = prepared;
    }

    // Allocate the delivery identity before sending so connectors and the
    // persisted outbound row refer to the same message.
    const messageId = randomUUID();

    // Build the AgentOutput. The reply target is attached once the recipient
    // chat is known, below.
    const output: AgentOutput = {
      body: content,
      messageId,
      sourceRunId: context.runId,
      ...(attachments.length > 0 ? { attachments } : {}),
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
      this.deps.logger.error(
        voiceObservation
          ? voiceDiagnosticFields(voiceObservation, { errorCategory: 'unknown' })
          : { requestId, threadId: context.threadId, err: threadResult.error },
        voiceObservation ? 'channel.send: recipient thread lookup failed' : msg,
      );
      return { requestId, tool: 'channel.send', status: 'error', error: msg };
    }
    if (!threadResult.value) {
      const msg = `channel.send: thread "${context.threadId}" not found — cannot resolve recipient`;
      this.deps.logger.error(
        voiceObservation
          ? voiceDiagnosticFields(voiceObservation, { errorCategory: 'unknown' })
          : { requestId, threadId: context.threadId, channelId },
        voiceObservation ? 'channel.send: recipient thread missing' : msg,
      );
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
    // Blank optional recipient IDs should not override the real chat ID of
    // the current thread. Keep explicit recipients and schedule origins first.
    const explicitChatId =
      typeof args.externalChatId === 'string' && args.externalChatId.trim()
        ? args.externalChatId.trim()
        : null;
    const scheduleOriginId =
      typeof originExternalId === 'string' && originExternalId.trim()
        ? originExternalId.trim()
        : null;
    const externalThreadId =
      explicitChatId ?? scheduleOriginId ?? (isSyntheticFallback ? null : fallbackExternalId);

    if (!externalThreadId) {
      const msg =
        'channel.send: no recipient chat id. This run is on a schedule thread without an originExternalId (likely created from the CLI). ' +
        'Pass `externalChatId` explicitly, or use `channel.list` to discover available chats and `channel.broadcast` to fan out to all bound chats.';
      this.deps.logger.warn(
        voiceObservation
          ? voiceDiagnosticFields(voiceObservation, { errorCategory: 'unknown' })
          : { requestId, threadId: context.threadId, channelId, threadExternalId: fallbackExternalId },
        'channel.send: missing valid recipient chat id',
      );
      return { requestId, tool: 'channel.send', status: 'error', error: msg };
    }

    const replyTarget = this.resolveReplyTarget(replyTo, channelId, externalThreadId);
    if (replyTarget !== undefined) {
      output.replyTo = replyTarget;
    }

    const result = await connector.send(externalThreadId, output);

    if (result.isErr()) {
      const msg = `channel.send: failed to send message — ${result.error.message}`;
      this.deps.logger.error(
        voiceObservation
          ? voiceDiagnosticFields(voiceObservation, { errorCategory: 'unknown' })
          : { requestId, channelId, err: result.error },
        voiceObservation ? 'channel.send: connector send failed' : msg,
      );
      return { requestId, tool: 'channel.send', status: 'error', error: msg };
    }

    const receipt: SendReceipt | undefined = result.value ?? undefined;
    const outcomes = this.attachmentOutcomes(attachments, receipt);
    const failed = outcomes.filter((o) => o.status === 'failed');
    const textSent = content.trim() !== '';
    if (!textSent && attachments.length > 0 && failed.length === attachments.length) {
      const msg =
        'channel.send: no attachment could be delivered, and there was no text — nothing was sent. ' +
        failed.map((o) => `[${o.index}] ${o.filename}: ${o.error ?? 'failed'}`).join('; ');
      this.deps.logger.error(
        voiceObservation
          ? voiceDiagnosticFields(voiceObservation, { errorCategory: 'unknown' })
          : { requestId, channelId, attachmentsFailed: failed.length },
        'channel.send: all attachments failed',
      );
      return { requestId, tool: 'channel.send', status: 'error', error: msg };
    }

    this.deps.logger.info(
      voiceObservation
        ? voiceDiagnosticFields(voiceObservation, { event: 'message_sent' })
        : {
            requestId,
            channelId,
            threadId: context.threadId,
            // Where the message went and why. An agent-supplied recipient
            // overrides a schedule's origin, so a reminder that lands in the
            // wrong chat or topic is explained by this line.
            recipient: externalThreadId,
            recipientSource: explicitChatId
              ? 'externalChatId argument'
              : scheduleOriginId
                ? 'schedule origin'
                : 'current thread',
            ...(attachments.length > 0
              ? {
                  attachments: attachments.map((a, index) => ({
                    index,
                    mimeType: a.mimeType,
                    size: a.size,
                    sha256: a.sha256.slice(0, 16),
                    status: outcomes[index]?.status,
                  })),
                }
              : {}),
          },
      'channel.send: message sent successfully',
    );

    // Tell the human, in plain words, when an attachment did not make it.
    if (failed.length > 0) {
      const notice = await connector.send(externalThreadId, {
        body: attachmentFailureNotice(failed.map((o) => o.filename)),
        sourceRunId: context.runId,
      });
      if (notice.isErr()) {
        this.deps.logger.warn(
          { requestId, channelId, err: notice.error },
          'channel.send: failed to deliver attachment-failure notice',
        );
      }
    }

    const sentMetadata = attachments
      .filter((_, index) => outcomes[index]?.status === 'sent')
      .map(toAttachmentMetadata);
    this.persistOutboundMessage({
      requestId,
      runId: context.runId,
      channelName: channelId,
      externalThreadId,
      content: attachmentSummaryLine(content, sentMetadata),
      personaId: context.personaId,
      runThreadId: context.threadId,
      messageId,
      ...(receipt?.externalMessageId
        ? { externalMessageId: receipt.externalMessageId }
        : {}),
      ...(sentMetadata.length > 0 ? { attachments: sentMetadata } : {}),
      attachmentRefs: outcomes
        .filter((o) => o.status === 'sent' && o.externalMessageId !== undefined &&
          o.externalMessageId !== receipt?.externalMessageId)
        .map((o) => ({
          externalMessageId: o.externalMessageId!,
          text: attachmentLedgerText(attachments[o.index]),
        })),
      ...(voiceObservation ? { voiceObservation } : {}),
    });

    return {
      requestId,
      tool: 'channel.send',
      status: 'success',
      result: {
        channelId,
        sent: true,
        ...(attachments.length > 0
          ? {
              attachments: outcomes.map((o) => ({
                index: o.index,
                filename: o.filename,
                status: o.status,
                ...(o.error !== undefined ? { error: o.error } : {}),
              })),
              ...(failed.length > 0
                ? {
                    note:
                      `${failed.length} of ${attachments.length} attachments failed; the recipient was told which. ` +
                      'Retry them, or describe the file instead.',
                  }
                : {}),
            }
          : {}),
      },
    };
  }

  /**
   * Checks capability, voice and connector support, then validates and reads
   * the requested files. Returns the attachments, or an error message that
   * lists every refusal by index and code. Nothing has been sent either way.
   */
  private async prepareAttachments(
    requested: unknown,
    connector: ChannelConnector,
    context: ToolExecutionContext,
  ): Promise<OutboundAttachment[] | { error: string }> {
    const refuse = (refusals: OutboundAttachmentRefusal[]): { error: string } => {
      this.deps.logger.warn(
        {
          requestId: context.requestId ?? 'unknown',
          personaId: context.personaId,
          channelId: connector.name,
          refusals: refusals.map((r) => ({ index: r.index, code: r.code })),
        },
        'channel.send: attachments refused before sending',
      );
      return {
        error:
          'channel.send: attachments refused — nothing was sent.\n' +
          refusals.map((r) => `- [${r.code}] ${r.message}`).join('\n'),
      };
    };

    if (context.voiceObservation !== undefined) {
      return refuse([
        { index: -1, code: 'channel_unsupported', message: 'Attachments cannot be sent from a voice session.' },
      ]);
    }
    const capabilities = this.deps.resolveCapabilities?.(context.personaId) ?? {
      allow: [],
      requireApproval: [],
    };
    if (!hasCapabilityPrefix(capabilities, CHANNEL_ATTACH_CAPABILITY)) {
      return refuse([
        {
          index: -1,
          code: 'capability_denied',
          message: `This persona is not granted ${CHANNEL_ATTACH_CAPABILITY}; send the text alone and describe the file instead.`,
        },
      ]);
    }
    const support = connector.outboundAttachments;
    if (support === undefined) {
      return refuse([
        {
          index: -1,
          code: 'channel_unsupported',
          message: `Channel "${connector.name}" (${connector.type}) does not support attachments; describe the file or give its location instead.`,
        },
      ]);
    }
    const basePolicy = this.deps.attachmentPolicy;
    if (basePolicy === undefined) {
      return refuse([
        { index: -1, code: 'attachments_disabled', message: 'Outbound attachments are not enabled on this Talon.' },
      ]);
    }
    const artifactsDir = this.deps.threadArtifactsDir?.(context.threadId);
    const policy: OutboundAttachmentPolicy =
      artifactsDir === undefined
        ? basePolicy
        : {
            ...basePolicy,
            allowedRoots: [...basePolicy.allowedRoots, artifactsDir],
            exemptRoots: [...(basePolicy.exemptRoots ?? []), artifactsDir],
          };
    const resolved = await resolveOutboundAttachments(requested, policy, support);
    return resolved.isErr() ? refuse(resolved.error) : resolved.value;
  }

  /** Per-attachment outcome, from the connector's receipt. */
  private attachmentOutcomes(
    attachments: readonly OutboundAttachment[],
    receipt: SendReceipt | undefined,
  ): Array<{
    index: number;
    filename: string;
    status: 'sent' | 'failed';
    externalMessageId?: string;
    error?: string;
  }> {
    return attachments.map((attachment, index) => {
      const delivered = receipt?.attachments?.find((r) => r.index === index);
      return {
        index,
        filename: attachment.filename,
        // A connector that declares support must report each item; a missing
        // entry is treated as sent without a ledger ID.
        status: delivered?.status ?? 'sent',
        ...(delivered?.externalMessageId !== undefined
          ? { externalMessageId: delivered.externalMessageId }
          : {}),
        ...(delivered?.error !== undefined ? { error: delivered.error } : {}),
      };
    });
  }

  /**
   * Builds the explicit reply target for a `replyTo` argument. The ledger of
   * the recipient thread supplies author and text when it knows the message;
   * an unknown ID is passed through as-is, which is enough for providers that
   * address a reply by ID alone.
   */
  private resolveReplyTarget(
    replyTo: unknown,
    channelName: string,
    externalThreadId: string,
  ): OutboundReplyTarget | undefined {
    const externalMessageId = typeof replyTo === 'string' ? replyTo.trim() : '';
    if (externalMessageId === '') {
      return undefined;
    }
    const target: OutboundReplyTarget = { externalMessageId };
    const refs = this.deps.messageRefRepository;
    const channel = this.deps.channelRepository?.findByName(channelName);
    if (refs === undefined || channel === undefined || channel.isErr() || !channel.value) {
      return target;
    }
    const thread = this.deps.threadRepository.findByExternalId(channel.value.id, externalThreadId);
    if (thread.isErr() || !thread.value) {
      return target;
    }
    const ref = refs.find(thread.value.id, externalMessageId);
    if (ref.isErr() || ref.value === null) {
      return target;
    }
    return {
      externalMessageId,
      fromSelf: ref.value.direction === 'outbound',
      ...(ref.value.sender_id !== null ? { author: ref.value.sender_id } : {}),
      ...(ref.value.excerpt !== '' ? { text: ref.value.excerpt } : {}),
    };
  }

  private persistOutboundMessage(input: {
    requestId: string;
    runId: string;
    channelName: string;
    externalThreadId: string;
    content: string;
    personaId: string;
    messageId: string;
    /** Provider ID of the sent message, when the connector reported one. */
    externalMessageId?: string;
    /** Metadata of the attachments that were delivered (never bytes or paths). */
    attachments?: OutboundAttachmentMetadata[];
    /** Ledger entries for attachment messages beyond `externalMessageId`. */
    attachmentRefs?: Array<{ externalMessageId: string; text: string }>;
    /**
     * The thread the current run is executing on. When the resolved
     * recipient thread differs from this (cross-thread delivery — the
     * scheduled-task case), the recipient's session is force-rotated so
     * the next run there starts fresh and ContextAssembler injects this
     * outbound into context.
     */
    runThreadId: string;
    voiceObservation?: VoiceObservationContext;
  }): void {
    if (!this.deps.channelRepository || !this.deps.messageRepository) {
      return;
    }

    const channelResult = this.deps.channelRepository.findByName(input.channelName);
    if (channelResult.isErr() || !channelResult.value) {
      this.deps.logger.warn(
        input.voiceObservation
          ? voiceDiagnosticFields(input.voiceObservation, { errorCategory: 'unknown' })
          : {
              requestId: input.requestId,
              channelName: input.channelName,
              err: channelResult.isErr() ? channelResult.error : undefined,
            },
        input.voiceObservation
          ? 'channel.send: outbound persistence channel lookup failed'
          : 'channel.send: delivered message but failed to resolve channel for outbound persistence',
      );
      return;
    }
    const channel = channelResult.value;

    const targetThread = this.resolveTargetThread(input, channel.id);
    if (!targetThread) {
      return;
    }

    if (!this.shouldPersistForTarget(input, channel.id, targetThread)) {
      return;
    }

    const idempotencyRequestId =
      input.requestId === 'unknown' ? randomUUID() : input.requestId;
    const insertResult = this.deps.messageRepository.insert({
      id: input.messageId,
      thread_id: targetThread.id,
      direction: 'outbound',
      content: JSON.stringify({
        body: input.content,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      }),
      idempotency_key: `channel-send:${input.runId}:${idempotencyRequestId}`,
      provider_id: null,
      run_id: input.runId,
    });
    if (insertResult.isErr()) {
      this.deps.logger.warn(
        input.voiceObservation
          ? voiceDiagnosticFields(input.voiceObservation, { errorCategory: 'unknown' })
          : {
              requestId: input.requestId,
              runId: input.runId,
              threadId: targetThread.id,
              err: insertResult.error,
            },
        input.voiceObservation
          ? 'channel.send: outbound persistence insert failed'
          : 'channel.send: delivered message but failed to persist outbound context',
      );
      return;
    }

    // Record the sent message in the ledger of the thread it was persisted
    // to, so a reply or reaction on it reaches that thread's conversation.
    const refs = [
      ...(input.externalMessageId
        ? [{ externalMessageId: input.externalMessageId, text: input.content }]
        : []),
      ...(input.attachmentRefs ?? []),
    ];
    for (const ref of this.deps.messageRefRepository ? refs : []) {
      const recorded = this.deps.messageRefRepository!.record({
        thread_id: targetThread.id,
        external_id: ref.externalMessageId,
        direction: 'outbound',
        message_id: input.messageId,
        text: ref.text,
      });
      if (recorded.isErr()) {
        this.deps.logger.warn(
          input.voiceObservation
            ? voiceDiagnosticFields(input.voiceObservation, { errorCategory: 'unknown' })
            : { requestId: input.requestId, threadId: targetThread.id, err: recorded.error },
          'channel.send: delivered message but failed to record its message ref',
        );
      }
    }

    // Cross-thread delivery: the outbound was persisted to a thread other
    // than the current run's thread (scheduled-task case). Force-rotate
    // the recipient's session so the next run there starts fresh —
    // ContextAssembler will inject this outbound into context. Without
    // this, a resumed codex session on the recipient thread would skip
    // ContextAssembler (agent-runner.ts) and never see the scheduled
    // message, even though it's in the DB. Observed in production: agent
    // asked "what's on your plate today?" via scheduled task, user
    // replied, agent had no context for the reply.
    if (
      this.deps.sessionTracker &&
      targetThread.id !== input.runThreadId
    ) {
      this.deps.sessionTracker.rotateSession(targetThread.id);
      this.deps.logger.info(
        input.voiceObservation
          ? voiceDiagnosticFields(input.voiceObservation, { event: 'recipient_session_rotated' })
          : {
              requestId: input.requestId,
              runId: input.runId,
              recipientThreadId: targetThread.id,
              runThreadId: input.runThreadId,
            },
        'channel.send: rotated recipient session after cross-thread outbound persistence',
      );
    }
  }

  /**
   * Returns true when outbound context should be persisted on the target
   * thread. Mirrors `ChannelRouter.resolvePersona`'s resolution:
   *  1. If a thread-scoped binding exists for `(channel, targetThread)`,
   *     persist iff its persona matches the current run. A scoped binding
   *     for a different persona blocks persistence — the default binding
   *     is NOT consulted (matches router behavior).
   *  2. If no thread-scoped binding exists, fall back to the channel-
   *     default binding; persist iff its persona matches.
   * Otherwise the send still goes through (capability permits) but no
   * outbound row is written, preventing a persona from polluting an
   * unbound (or other-persona-owned) thread's message history when
   * `externalChatId` deliberately targets a chat the persona is not
   * bound to.
   */
  private shouldPersistForTarget(
    input: {
      requestId: string;
      personaId: string;
      voiceObservation?: VoiceObservationContext;
    },
    channelId: string,
    targetThread: ThreadRow,
  ): boolean {
    if (!this.deps.bindingRepository) {
      return true;
    }
    const scopedResult = this.deps.bindingRepository.findByChannelAndThread(
      channelId,
      targetThread.id,
    );
    if (scopedResult.isErr()) {
      this.deps.logger.warn(
        input.voiceObservation
          ? voiceDiagnosticFields(input.voiceObservation, { errorCategory: 'unknown' })
          : {
              requestId: input.requestId,
              channelId,
              threadId: targetThread.id,
              err: scopedResult.error,
            },
        input.voiceObservation
          ? 'channel.send: outbound persistence binding lookup failed'
          : 'channel.send: skipping outbound persistence — binding lookup failed',
      );
      return false;
    }
    const scoped = scopedResult.value;
    if (scoped) {
      if (scoped.persona_id === input.personaId) {
        return true;
      }
      this.deps.logger.warn(
        input.voiceObservation
          ? voiceDiagnosticFields(input.voiceObservation, { errorCategory: 'policy' })
          : {
              requestId: input.requestId,
              channelId,
              threadId: targetThread.id,
              personaId: input.personaId,
              scopedPersonaId: scoped.persona_id,
            },
        input.voiceObservation
          ? 'channel.send: outbound persistence binding rejected'
          : 'channel.send: delivered message but skipping outbound persistence — thread is bound to a different persona',
      );
      return false;
    }
    const defaultResult = this.deps.bindingRepository.findDefaultForChannel(channelId);
    if (defaultResult.isErr()) {
      this.deps.logger.warn(
        input.voiceObservation
          ? voiceDiagnosticFields(input.voiceObservation, { errorCategory: 'unknown' })
          : {
              requestId: input.requestId,
              channelId,
              err: defaultResult.error,
            },
        input.voiceObservation
          ? 'channel.send: outbound persistence default binding lookup failed'
          : 'channel.send: skipping outbound persistence — default binding lookup failed',
      );
      return false;
    }
    const defaultBinding = defaultResult.value;
    if (defaultBinding && defaultBinding.persona_id === input.personaId) {
      return true;
    }
    this.deps.logger.warn(
      input.voiceObservation
        ? voiceDiagnosticFields(input.voiceObservation, { errorCategory: 'policy' })
        : {
            requestId: input.requestId,
            channelId,
            threadId: targetThread.id,
            personaId: input.personaId,
            defaultPersonaId: defaultBinding?.persona_id ?? null,
          },
      input.voiceObservation
        ? 'channel.send: outbound persistence binding missing'
        : 'channel.send: delivered message but skipping outbound persistence — no binding for this persona on target channel/thread',
    );
    return false;
  }

  private resolveTargetThread(
    input: {
      requestId: string;
      externalThreadId: string;
      voiceObservation?: VoiceObservationContext;
    },
    channelId: string,
  ): ThreadRow | null {
    const existingResult = this.deps.threadRepository.findByExternalId(
      channelId,
      input.externalThreadId,
    );
    if (existingResult.isErr()) {
      this.deps.logger.warn(
        input.voiceObservation
          ? voiceDiagnosticFields(input.voiceObservation, { errorCategory: 'unknown' })
          : {
              requestId: input.requestId,
              channelId,
              externalThreadId: input.externalThreadId,
              err: existingResult.error,
            },
        input.voiceObservation
          ? 'channel.send: outbound persistence recipient lookup failed'
          : 'channel.send: delivered message but failed to resolve recipient thread for outbound persistence',
      );
      return null;
    }
    if (existingResult.value) {
      return existingResult.value;
    }

    const insertInput: InsertThreadInput = {
      id: randomUUID(),
      channel_id: channelId,
      external_id: input.externalThreadId,
      metadata: '{}',
    };
    const insertResult = this.deps.threadRepository.insert(insertInput);
    if (insertResult.isOk()) {
      return insertResult.value;
    }

    const retryResult = this.deps.threadRepository.findByExternalId(
      channelId,
      input.externalThreadId,
    );
    if (retryResult.isOk() && retryResult.value) {
      return retryResult.value;
    }

    this.deps.logger.warn(
      input.voiceObservation
        ? voiceDiagnosticFields(input.voiceObservation, { errorCategory: 'unknown' })
        : {
            requestId: input.requestId,
            channelId,
            externalThreadId: input.externalThreadId,
            err: insertResult.error,
          },
      input.voiceObservation
        ? 'channel.send: outbound persistence recipient creation failed'
        : 'channel.send: delivered message but failed to create recipient thread for outbound persistence',
    );
    return null;
  }
}
