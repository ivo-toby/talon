/**
 * Outbound attachments for the Telegram connector.
 *
 * Images go out with `sendPhoto` so they show inline; everything else, and
 * any image Telegram refuses as a photo (over 10 MB, or dimensions outside
 * its photo limits), goes out with `sendDocument`. Bot API limits
 * (https://core.telegram.org/bots/api#sendphoto, #senddocument): photos at
 * most 10 MB, other files at most 50 MB, captions at most 1024 characters.
 *
 * Captions are sent as plain text (no `parse_mode`) so an agent's caption
 * never fails on MarkdownV2 escaping.
 */

import type { OutboundAttachment, OutboundAttachmentSupport } from '../../channel-types.js';
import { ok, err, type Result } from '../../../core/types/result.js';
import { ChannelError } from '../../../core/errors/error-types.js';

/** Largest photo `sendPhoto` accepts. */
export const TELEGRAM_MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Telegram's outbound attachment limits (Bot API cloud server). */
export const TELEGRAM_OUTBOUND_ATTACHMENTS: OutboundAttachmentSupport = {
  maxBytes: 50 * 1024 * 1024,
  maxFiles: 10,
};

/** Longest caption Telegram accepts. */
export const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

/** Where and how one attachment is delivered. */
export interface TelegramAttachmentTarget {
  chatId: string;
  topicId?: number;
  /** Native reply target (only the first message of a send carries it). */
  replyToMessageId?: number;
}

interface TelegramMediaResponse {
  ok: boolean;
  result?: { message_id?: number };
  description?: string;
  error_code?: number;
}

type Method = 'sendPhoto' | 'sendDocument';

/**
 * Sends one attachment and returns the sent message's `message_id`.
 *
 * @param apiUrl     - Builds the Bot API URL for a method (holds the token).
 * @param attachment - Validated attachment.
 * @param target     - Chat, topic and reply target.
 * @param fetchImpl  - Injected for tests; defaults to global fetch.
 */
export async function sendTelegramAttachment(
  apiUrl: (method: string) => string,
  attachment: OutboundAttachment,
  target: TelegramAttachmentTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<string | undefined, ChannelError>> {
  const asPhoto = attachment.kind === 'image' && attachment.size <= TELEGRAM_MAX_PHOTO_BYTES;
  if (asPhoto) {
    const photo = await postMedia(apiUrl, 'sendPhoto', attachment, target, fetchImpl);
    // A photo Telegram rejects (dimensions, ratio, processing) still arrives
    // as a document; a transport failure does not get a second attempt.
    if (photo.isOk() || photo.error.message.includes('network error')) {
      return photo;
    }
  }
  return postMedia(apiUrl, 'sendDocument', attachment, target, fetchImpl);
}

async function postMedia(
  apiUrl: (method: string) => string,
  method: Method,
  attachment: OutboundAttachment,
  target: TelegramAttachmentTarget,
  fetchImpl: typeof fetch,
): Promise<Result<string | undefined, ChannelError>> {
  const form = new FormData();
  form.append('chat_id', target.chatId);
  if (target.topicId !== undefined) {
    form.append('message_thread_id', String(target.topicId));
  }
  if (target.replyToMessageId !== undefined) {
    form.append(
      'reply_parameters',
      JSON.stringify({ message_id: target.replyToMessageId, allow_sending_without_reply: true }),
    );
  }
  if (attachment.caption !== undefined && attachment.caption !== '') {
    form.append('caption', attachment.caption.slice(0, TELEGRAM_MAX_CAPTION_LENGTH));
  }
  const field = method === 'sendPhoto' ? 'photo' : 'document';
  form.append(
    field,
    new Blob([new Uint8Array(attachment.data)], { type: attachment.mimeType }),
    attachment.filename,
  );

  let response: Response;
  try {
    response = await fetchImpl(apiUrl(method), { method: 'POST', body: form });
  } catch (fetchErr) {
    return err(
      new ChannelError(
        `Telegram ${method} network error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
      ),
    );
  }

  let data: TelegramMediaResponse;
  try {
    data = (await response.json()) as TelegramMediaResponse;
  } catch {
    return err(
      new ChannelError(`Telegram ${method}: could not parse response (HTTP ${response.status})`),
    );
  }
  if (!data.ok) {
    return err(
      new ChannelError(
        `Telegram ${method} failed (${data.error_code ?? response.status}): ${data.description ?? 'unknown error'}`,
      ),
    );
  }
  const messageId = data.result?.message_id;
  return ok(typeof messageId === 'number' ? String(messageId) : undefined);
}
