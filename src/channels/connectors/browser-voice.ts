/**
 * Channel connector for browser voice conversations.
 *
 * Voice input and provider audio stay inside VoiceSessionService. This
 * connector only resolves the durable voice thread and delivers normal
 * outbound text through the existing notification boundary.
 */

import type pino from 'pino';
import { err, ok, type Result } from '../../core/types/result.js';
import { ChannelError } from '../../core/errors/error-types.js';
import type { ThreadRepository } from '../../core/database/repositories/thread-repository.js';
import type { VoiceSessionService } from '../../voice/voice-types.js';
import type { AgentOutput, ChannelConnector, InboundEvent } from '../channel-types.js';

const VOICE_CHANNEL_TYPE = 'voice';
const VOICE_CHANNEL_NAME = 'browser-voice';
const VOICE_EXTERNAL_PREFIX = 'voice:';

export interface BrowserVoiceConnectorOptions {
  readonly channelId: string;
  readonly name?: string;
  readonly threadRepository: Pick<ThreadRepository, 'findByExternalId'>;
  readonly sessionService: Pick<VoiceSessionService, 'notifyThread'>;
  readonly logger?: pino.Logger;
}

/** Delivers ordinary channel output to the currently known voice session. */
export class BrowserVoiceConnector implements ChannelConnector {
  readonly type = VOICE_CHANNEL_TYPE;
  readonly name: string;

  constructor(private readonly options: BrowserVoiceConnectorOptions) {
    this.name = options.name ?? VOICE_CHANNEL_NAME;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  onMessage(_handler: (event: InboundEvent) => void | Promise<void>): void {
    // Browser voice input is admitted by VoiceSessionService, not the text
    // message pipeline. Keep this connector outbound-only by design.
  }

  async send(externalThreadId: string, output: AgentOutput): Promise<Result<void, ChannelError>> {
    if (output.attachments && output.attachments.length > 0) {
      return err(new ChannelError('Browser voice does not support file attachments'));
    }
    if (output.actions && output.actions.length > 0) {
      return err(new ChannelError('Browser voice does not support interactive actions'));
    }
    const text = output.body.trim();
    if (text.length === 0) return err(new ChannelError('Browser voice message text is empty'));

    const thread = this.options.threadRepository.findByExternalId(
      this.options.channelId,
      externalThreadId,
    );
    if (thread.isErr()) {
      return err(new ChannelError(`Failed to resolve browser voice thread: ${thread.error.message}`));
    }
    if (!thread.value || !isVoiceThread(thread.value.metadata, externalThreadId)) {
      return err(new ChannelError('Browser voice recipient is not an authorized voice thread'));
    }

    const requestedMessageId = output.messageId?.trim() || undefined;
    const delivered = await this.options.sessionService.notifyThread({
      threadId: thread.value.id,
      text,
      ...(requestedMessageId ? { messageId: requestedMessageId } : {}),
    });
    if (delivered.isErr()) {
      this.options.logger?.warn(
        { threadId: thread.value.id, cause: delivered.error },
        'browser voice notification was not delivered',
      );
      return err(new ChannelError(`Browser voice notification failed: ${delivered.error.message}`));
    }
    if (!output.messageId) output.messageId = delivered.value.notificationId;
    return ok(undefined);
  }

  format(markdown: string): string {
    return markdown;
  }
}

function isVoiceThread(metadata: string, externalThreadId: string): boolean {
  if (!externalThreadId.startsWith(VOICE_EXTERNAL_PREFIX)) return false;
  const sessionId = externalThreadId.slice(VOICE_EXTERNAL_PREFIX.length);
  if (!sessionId) return false;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { kind?: unknown }).kind === 'voice' &&
      (parsed as { sessionId?: unknown }).sessionId === sessionId
    );
  } catch {
    return false;
  }
}
