/**
 * Host-side tool: channel.send
 *
 * Sends a message to a channel on behalf of a persona. The tool is gated by
 * the `channel.send:<channel-id>` capability and requires either explicit
 * allow or operator approval depending on the persona policy.
 */

import { randomUUID } from 'node:crypto';
import { downloadAllowedAttachment } from './attachment-download.js';
import type pino from 'pino';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import type { AgentOutput, Attachment } from '../../channels/channel-types.js';
import type { ChannelRegistry } from '../../channels/channel-registry.js';
import type { ChannelRepository } from '../../core/database/repositories/channel-repository.js';
import type { MessageRepository } from '../../core/database/repositories/message-repository.js';
import type {
  InsertThreadInput,
  ThreadRepository,
  ThreadRow,
} from '../../core/database/repositories/thread-repository.js';
import type { BindingRepository } from '../../core/database/repositories/binding-repository.js';
import { ToolError, ChannelPartialDeliveryError } from '../../core/errors/error-types.js';

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

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
// Bound the entire batch, not just each individual file.
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const ATTACHMENT_FETCH_TIMEOUT_MS = 60_000;

export interface ChannelSendAttachmentArg {
  /** HTTP(S) URL to fetch immediately before channel delivery. */
  url: string;
  /** Optional filename override. */
  filename?: string;
  /** Optional MIME type override. */
  mimeType?: string;
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
  /** Optional files to fetch and attach to the outbound message. */
  attachments?: ChannelSendAttachmentArg[];
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
      attachments?: { allowedOrigins: string[]; privateOrigins: string[] };
      threadRepository: ThreadRepository;
      channelRepository?: Pick<ChannelRepository, 'findByName'>;
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
    const { channelId, content, attachments, replyTo } = args;

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

    // Fetch requested attachments on the host. This keeps large file bytes out of
    // the model/MCP transcript while still allowing an MCP server to hand Talon a
    // short-lived download URL.
    let resolvedAttachments: Attachment[] | undefined;
    if (attachments !== undefined) {
      if (Array.isArray(attachments) && attachments.length > 0 && connector.supportsAttachments !== true) {
        const msg = `channel.send: channel "${channelId}" does not support file attachments (currently Telegram only)`;
        return { requestId, tool: 'channel.send', status: 'error', error: msg };
      }
      if (!Array.isArray(attachments) || attachments.length > 10) {
        const msg = 'channel.send: attachments must be an array with at most 10 items';
        return { requestId, tool: 'channel.send', status: 'error', error: msg };
      }
      try {
        resolvedAttachments = [];
        let remainingBytes = MAX_TOTAL_ATTACHMENT_BYTES;
        for (const attachment of attachments) {
          if (remainingBytes <= 0) {
            throw new Error('attachment batch exceeds total byte limit');
          }
          const resolved = await this.fetchAttachment(attachment, remainingBytes);
          remainingBytes -= resolved.size ?? resolved.data.length;
          resolvedAttachments.push(resolved);
        }
      } catch (attachmentErr) {
        const msg =
          attachmentErr instanceof Error
            ? `channel.send: failed to fetch attachment — ${attachmentErr.message}`
            : `channel.send: failed to fetch attachment — ${String(attachmentErr)}`;
        this.deps.logger.warn({ requestId, channelId, attachmentCount: attachments.length }, msg);
        return { requestId, tool: 'channel.send', status: 'error', error: msg };
      }
    }

    // Build the AgentOutput and call send.
    const output: AgentOutput = {
      body: content,
      ...(replyTo ? { metadata: { replyTo } } : {}),
      ...(resolvedAttachments && resolvedAttachments.length > 0
        ? { attachments: resolvedAttachments }
        : {}),
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
      if (result.error instanceof ChannelPartialDeliveryError) {
        const { deliveredText, deliveredAttachments, deliveryUncertain } = result.error;
        if (deliveredText) {
          this.persistOutboundMessage({
            requestId, runId: context.runId, channelName: channelId,
            externalThreadId, content, personaId: context.personaId,
            runThreadId: context.threadId,
          });
        }
        const msg = `channel.send: partial delivery; ${deliveredText ? 'text delivered' : 'text not delivered'}, ${deliveredAttachments} of ${attachments?.length ?? 0} attachments confirmed. ${deliveryUncertain ? 'Latest upload outcome is unknown.' : 'Next attachment was rejected.'} Do not retry the entire batch. ${result.error.message}`;
        this.deps.logger.warn({ requestId, channelId, deliveredText, deliveredAttachments, deliveryUncertain }, msg);
        return {
          requestId, tool: 'channel.send', status: 'error', error: msg,
          result: { channelId, sent: false, partial: true, deliveredText, deliveredAttachments, deliveryUncertain, retryWholeBatch: false },
        };
      }
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
      personaId: context.personaId,
      runThreadId: context.threadId,
    });

    return {
      requestId,
      tool: 'channel.send',
      status: 'success',
      result: { channelId, sent: true },
    };
  }


  /**
   * Restrict host-side downloads to explicitly configured origins. An empty
   * allowlist fails closed, preserving the default-deny channel capability.
   * This is an initial barrier, not a substitute for DNS/IP pinning.
   */
  private isAttachmentOriginAllowed(url: URL): boolean {
    return (this.deps.attachments?.allowedOrigins ?? []).some(
      (origin) => new URL(origin).origin === url.origin,
    );
  }

  private async fetchAttachment(input: ChannelSendAttachmentArg, remainingBytes: number): Promise<Attachment> {
    if (!input || typeof input.url !== 'string' || input.url.trim() === '') {
      throw new Error('attachment url is required');
    }
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new Error('attachment url is invalid');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('attachment url must use http or https');
    }

    if (url.username || url.password || !this.isAttachmentOriginAllowed(url)) {
      throw new Error('attachment origin is not explicitly allowed');
    }

    const privateOrigins = this.deps.attachments?.privateOrigins ?? [];
    const { data, contentType } = await downloadAllowedAttachment(
      url, Math.min(MAX_ATTACHMENT_BYTES, remainingBytes), ATTACHMENT_FETCH_TIMEOUT_MS,
      privateOrigins.includes(url.origin),
    );

    const pathName = decodeURIComponent(url.pathname.split('/').pop() || '');
    const filename =
      typeof input.filename === 'string' && input.filename.trim()
        ? input.filename.trim()
        : pathName || 'attachment';
    const responseMime = contentType?.split(';')[0]?.trim();
    const inferredMime = this.inferMimeType(filename);
    const mimeType =
      typeof input.mimeType === 'string' && input.mimeType.trim()
        ? input.mimeType.trim()
        : responseMime && responseMime !== 'application/octet-stream'
          ? responseMime
          : inferredMime ?? responseMime ?? 'application/octet-stream';

    return { filename, mimeType, data, size: data.byteLength };
  }

  private inferMimeType(filename: string): string | undefined {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.mp4')) return 'video/mp4';
    if (lower.endsWith('.mov')) return 'video/quicktime';
    if (lower.endsWith('.webm')) return 'video/webm';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.pdf')) return 'application/pdf';
    if (lower.endsWith('.txt')) return 'text/plain';
    return undefined;
  }

  private persistOutboundMessage(input: {
    requestId: string;
    runId: string;
    channelName: string;
    externalThreadId: string;
    content: string;
    personaId: string;
    /**
     * The thread the current run is executing on. When the resolved
     * recipient thread differs from this (cross-thread delivery — the
     * scheduled-task case), the recipient's session is force-rotated so
     * the next run there starts fresh and ContextAssembler injects this
     * outbound into context.
     */
    runThreadId: string;
  }): void {
    if (!this.deps.channelRepository || !this.deps.messageRepository) {
      return;
    }

    const channelResult = this.deps.channelRepository.findByName(input.channelName);
    if (channelResult.isErr() || !channelResult.value) {
      this.deps.logger.warn(
        {
          requestId: input.requestId,
          channelName: input.channelName,
          err: channelResult.isErr() ? channelResult.error : undefined,
        },
        'channel.send: delivered message but failed to resolve channel for outbound persistence',
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
      return;
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
        {
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
    input: { requestId: string; personaId: string },
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
        {
          requestId: input.requestId,
          channelId,
          threadId: targetThread.id,
          err: scopedResult.error,
        },
        'channel.send: skipping outbound persistence — binding lookup failed',
      );
      return false;
    }
    const scoped = scopedResult.value;
    if (scoped) {
      if (scoped.persona_id === input.personaId) {
        return true;
      }
      this.deps.logger.warn(
        {
          requestId: input.requestId,
          channelId,
          threadId: targetThread.id,
          personaId: input.personaId,
          scopedPersonaId: scoped.persona_id,
        },
        'channel.send: delivered message but skipping outbound persistence — thread is bound to a different persona',
      );
      return false;
    }
    const defaultResult = this.deps.bindingRepository.findDefaultForChannel(channelId);
    if (defaultResult.isErr()) {
      this.deps.logger.warn(
        {
          requestId: input.requestId,
          channelId,
          err: defaultResult.error,
        },
        'channel.send: skipping outbound persistence — default binding lookup failed',
      );
      return false;
    }
    const defaultBinding = defaultResult.value;
    if (defaultBinding && defaultBinding.persona_id === input.personaId) {
      return true;
    }
    this.deps.logger.warn(
      {
        requestId: input.requestId,
        channelId,
        threadId: targetThread.id,
        personaId: input.personaId,
        defaultPersonaId: defaultBinding?.persona_id ?? null,
      },
      'channel.send: delivered message but skipping outbound persistence — no binding for this persona on target channel/thread',
    );
    return false;
  }

  private resolveTargetThread(
    input: { requestId: string; externalThreadId: string },
    channelId: string,
  ): ThreadRow | null {
    const existingResult = this.deps.threadRepository.findByExternalId(
      channelId,
      input.externalThreadId,
    );
    if (existingResult.isErr()) {
      this.deps.logger.warn(
        {
          requestId: input.requestId,
          channelId,
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
      {
        requestId: input.requestId,
        channelId,
        externalThreadId: input.externalThreadId,
        err: insertResult.error,
      },
      'channel.send: delivered message but failed to create recipient thread for outbound persistence',
    );
    return null;
  }
}
