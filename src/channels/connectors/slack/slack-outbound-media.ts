/**
 * Outbound attachments for the Slack connector.
 *
 * Uses Slack's external upload flow (the legacy `files.upload` is retired):
 *   1. `files.getUploadURLExternal` with filename and byte length → a
 *      presigned `upload_url` and a `file_id`;
 *   2. POST the bytes to `upload_url` (no bot token: the URL is presigned);
 *   3. `files.completeUploadExternal` to share the file into the channel or
 *      thread, with the caption as `initial_comment`.
 * Requires the `files:write` bot scope.
 *
 * The upload URL comes from Slack's response; it is only followed when it is
 * an `https://` URL on a `slack.com` host, so a malformed response cannot
 * send file bytes elsewhere.
 */

import type { OutboundAttachment, OutboundAttachmentSupport } from '../../channel-types.js';
import { ok, err, type Result } from '../../../core/types/result.js';
import { ChannelError } from '../../../core/errors/error-types.js';

const SLACK_API_BASE = 'https://slack.com/api';

/**
 * Slack's own per-file limit is 1 GB; Talon's global `maxBytes` is far lower
 * and governs in practice.
 */
export const SLACK_OUTBOUND_ATTACHMENTS: OutboundAttachmentSupport = {
  maxBytes: 1024 * 1024 * 1024,
  maxFiles: 10,
};

/** Where the file is shared. */
export interface SlackAttachmentTarget {
  channelId: string;
  threadTs?: string;
}

interface SlackUploadUrlResponse {
  ok: boolean;
  error?: string;
  upload_url?: string;
  file_id?: string;
}

interface SlackShare {
  ts?: string;
}

interface SlackCompleteResponse {
  ok: boolean;
  error?: string;
  files?: Array<{
    id?: string;
    shares?: Record<string, Record<string, SlackShare[] | undefined> | undefined>;
  }>;
}

/** True for an `https://` URL whose host is `slack.com` or a subdomain of it. */
export function isSlackUploadUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'))
    );
  } catch {
    return false;
  }
}

async function readJson<T>(response: Response, step: string): Promise<Result<T, ChannelError>> {
  try {
    return ok((await response.json()) as T);
  } catch {
    return err(
      new ChannelError(`Slack ${step}: could not parse response (HTTP ${response.status})`),
    );
  }
}

/**
 * Uploads one attachment and shares it into the channel or thread.
 *
 * @returns The `ts` of the message that carries the file when Slack reports
 *          it (it often does not, since sharing completes asynchronously).
 */
export async function uploadSlackAttachment(
  botToken: string,
  attachment: OutboundAttachment,
  target: SlackAttachmentTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<string | undefined, ChannelError>> {
  const auth = { Authorization: `Bearer ${botToken}` };

  // 1. Reserve an upload URL.
  const params = new URLSearchParams({
    filename: attachment.filename,
    length: String(attachment.size),
  });
  if (attachment.kind === 'image' && attachment.caption) {
    params.set('alt_txt', attachment.caption.slice(0, 1000));
  }
  let reserved: Response;
  try {
    reserved = await fetchImpl(`${SLACK_API_BASE}/files.getUploadURLExternal`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch (fetchErr) {
    return err(
      new ChannelError(`Slack files.getUploadURLExternal network error: ${String(fetchErr)}`),
    );
  }
  const reservation = await readJson<SlackUploadUrlResponse>(
    reserved,
    'files.getUploadURLExternal',
  );
  if (reservation.isErr()) return err(reservation.error);
  const { upload_url: uploadUrl, file_id: fileId } = reservation.value;
  if (!reservation.value.ok || !uploadUrl || !fileId) {
    return err(
      new ChannelError(
        `Slack files.getUploadURLExternal failed: ${reservation.value.error ?? 'missing upload_url'}`,
      ),
    );
  }
  if (!isSlackUploadUrl(uploadUrl)) {
    return err(
      new ChannelError('Slack files.getUploadURLExternal returned an unexpected upload host'),
    );
  }

  // 2. Upload the bytes (presigned URL: no Authorization header).
  let uploaded: Response;
  try {
    uploaded = await fetchImpl(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(attachment.data),
    });
  } catch (fetchErr) {
    return err(new ChannelError(`Slack file upload network error: ${String(fetchErr)}`));
  }
  if (!uploaded.ok) {
    return err(new ChannelError(`Slack file upload failed (HTTP ${uploaded.status})`));
  }

  // 3. Share it into the conversation.
  const complete: Record<string, unknown> = {
    files: [{ id: fileId, title: attachment.filename }],
    channel_id: target.channelId,
  };
  if (target.threadTs) complete.thread_ts = target.threadTs;
  if (attachment.caption) complete.initial_comment = attachment.caption;
  let completed: Response;
  try {
    completed = await fetchImpl(`${SLACK_API_BASE}/files.completeUploadExternal`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(complete),
    });
  } catch (fetchErr) {
    return err(
      new ChannelError(`Slack files.completeUploadExternal network error: ${String(fetchErr)}`),
    );
  }
  const result = await readJson<SlackCompleteResponse>(completed, 'files.completeUploadExternal');
  if (result.isErr()) return err(result.error);
  if (!result.value.ok) {
    return err(
      new ChannelError(
        `Slack files.completeUploadExternal failed: ${result.value.error ?? 'unknown_error'}`,
      ),
    );
  }
  return ok(shareTs(result.value, target.channelId));
}

/** The share `ts` in the target channel, when Slack already reports it. */
function shareTs(response: SlackCompleteResponse, channelId: string): string | undefined {
  const shares = response.files?.[0]?.shares;
  for (const visibility of ['public', 'private'] as const) {
    const ts = shares?.[visibility]?.[channelId]?.[0]?.ts;
    if (typeof ts === 'string' && ts !== '') return ts;
  }
  return undefined;
}
