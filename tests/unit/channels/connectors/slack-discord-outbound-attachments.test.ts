/**
 * Unit tests for Slack and Discord outbound attachments.
 *
 * Slack: the external upload flow (getUploadURLExternal → presigned upload →
 * completeUploadExternal), thread targeting, captions, upload-host check and
 * per-item receipts. Discord: one multipart message per attachment with the
 * caption as content, reply on the first message only, 429 retry.
 *
 * All HTTP is intercepted via vi.stubGlobal('fetch', ...).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import pino from 'pino';
import { SlackConnector } from '../../../../src/channels/connectors/slack/slack-connector.js';
import {
  isSlackUploadUrl,
  uploadSlackAttachment,
} from '../../../../src/channels/connectors/slack/slack-outbound-media.js';
import { DiscordConnector } from '../../../../src/channels/connectors/discord/discord-connector.js';
import type { OutboundAttachment } from '../../../../src/channels/channel-types.js';

const logger = pino({ level: 'silent' });

function attachment(overrides: Partial<OutboundAttachment> = {}): OutboundAttachment {
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  return {
    filename: 'shot.png',
    mimeType: 'image/png',
    kind: 'image',
    data,
    size: data.length,
    sha256: 'a'.repeat(64),
    ...overrides,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

interface Call {
  url: string;
  init: RequestInit;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

const UPLOAD_URL = 'https://files.slack.com/upload/v1/abc';

function slackFetch(
  overrides: {
    reserve?: unknown;
    upload?: Response;
    complete?: unknown[];
    post?: unknown;
  } = {},
): { calls: Call[]; fetch: ReturnType<typeof vi.fn> } {
  const calls: Call[] = [];
  const complete = overrides.complete ?? [];
  let fileCounter = 0;
  const fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/chat.postMessage')) {
      return Promise.resolve(json(overrides.post ?? { ok: true, ts: '1700000000.000100' }));
    }
    if (url.endsWith('/files.getUploadURLExternal')) {
      fileCounter += 1;
      return Promise.resolve(
        json(overrides.reserve ?? { ok: true, upload_url: UPLOAD_URL, file_id: `F${fileCounter}` }),
      );
    }
    if (url === UPLOAD_URL || url.startsWith('https://evil')) {
      return Promise.resolve(overrides.upload ?? json({}, 200));
    }
    if (url.endsWith('/files.completeUploadExternal')) {
      return Promise.resolve(json(complete.shift() ?? { ok: true, files: [{ id: 'F1' }] }));
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  return { calls, fetch };
}

describe('Slack outbound attachments', () => {
  it('declares support', () => {
    const c = new SlackConnector({ botToken: 'xoxb-t', signingSecret: 's' }, 'slack', logger);
    expect(c.outboundAttachments).toEqual({ maxBytes: 1024 ** 3, maxFiles: 10 });
  });

  it('reserves, uploads without the token, and shares into the thread with the caption', async () => {
    const { calls, fetch } = slackFetch({
      complete: [
        {
          ok: true,
          files: [{ id: 'F1', shares: { public: { C123: [{ ts: '1700000000.000200' }] } } }],
        },
      ],
    });
    const result = await uploadSlackAttachment(
      'xoxb-t',
      attachment({ caption: 'Screenshot' }),
      { channelId: 'C123', threadTs: '1700000000.000001' },
      fetch as never,
    );
    expect(result._unsafeUnwrap()).toBe('1700000000.000200');
    expect(calls.map((c) => c.url)).toEqual([
      'https://slack.com/api/files.getUploadURLExternal',
      UPLOAD_URL,
      'https://slack.com/api/files.completeUploadExternal',
    ]);
    const reserve = new URLSearchParams(calls[0]!.init.body as string);
    expect(reserve.get('filename')).toBe('shot.png');
    expect(reserve.get('length')).toBe('7');
    expect(reserve.get('alt_txt')).toBe('Screenshot');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-t');
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual({
      files: [{ id: 'F1', title: 'shot.png' }],
      channel_id: 'C123',
      thread_ts: '1700000000.000001',
      initial_comment: 'Screenshot',
    });
  });

  it('refuses an upload URL that is not https on slack.com', async () => {
    expect(isSlackUploadUrl('https://files.slack.com/x')).toBe(true);
    expect(isSlackUploadUrl('http://files.slack.com/x')).toBe(false);
    expect(isSlackUploadUrl('https://evil.example/slack.com')).toBe(false);
    expect(isSlackUploadUrl('https://slack.com.evil.example/')).toBe(false);
    const { calls, fetch } = slackFetch({
      reserve: { ok: true, upload_url: 'https://evil.example/u', file_id: 'F1' },
    });
    const result = await uploadSlackAttachment(
      'xoxb-t',
      attachment(),
      { channelId: 'C1' },
      fetch as never,
    );
    expect(result._unsafeUnwrapErr().message).toContain('unexpected upload host');
    expect(calls).toHaveLength(1);
  });

  it('reports a missing files:write scope as a failed reservation', async () => {
    const { fetch } = slackFetch({ reserve: { ok: false, error: 'missing_scope' } });
    const result = await uploadSlackAttachment(
      'xoxb-t',
      attachment(),
      { channelId: 'C1' },
      fetch as never,
    );
    expect(result._unsafeUnwrapErr().message).toContain('missing_scope');
  });

  it('connector sends text then each file into the thread, reporting per item', async () => {
    const { calls, fetch } = slackFetch({
      complete: [
        { ok: true, files: [{ id: 'F1' }] },
        { ok: false, error: 'file_upload_failed' },
      ],
    });
    vi.stubGlobal('fetch', fetch);
    const c = new SlackConnector({ botToken: 'xoxb-t', signingSecret: 's' }, 'slack', logger);

    const result = await c.send('C123:1700000000.000001', {
      body: 'Report',
      attachments: [
        attachment(),
        attachment({ kind: 'file', filename: 'log.txt', mimeType: 'text/plain' }),
      ],
    });

    expect(result._unsafeUnwrap()).toEqual({
      externalMessageId: '1700000000.000100',
      attachments: [
        { index: 0, status: 'sent' },
        { index: 1, status: 'failed', error: expect.stringContaining('file_upload_failed') },
      ],
    });
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      channel: 'C123',
      thread_ts: '1700000000.000001',
    });
  });

  it('connector uploads nothing when the text fails', async () => {
    const { calls, fetch } = slackFetch({ post: { ok: false, error: 'channel_not_found' } });
    vi.stubGlobal('fetch', fetch);
    const c = new SlackConnector({ botToken: 'xoxb-t', signingSecret: 's' }, 'slack', logger);
    const result = await c.send('C123', { body: 'x', attachments: [attachment()] });
    expect(result.isErr()).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('a plain text send still returns no receipt', async () => {
    const { fetch } = slackFetch();
    vi.stubGlobal('fetch', fetch);
    const c = new SlackConnector({ botToken: 'xoxb-t', signingSecret: 's' }, 'slack', logger);
    expect((await c.send('C123', { body: 'hi' }))._unsafeUnwrap()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

describe('Discord outbound attachments', () => {
  function connector(): DiscordConnector {
    return new DiscordConnector({ botToken: 'bot-t', applicationId: '1' }, 'discord', logger);
  }

  it('declares support', () => {
    expect(connector().outboundAttachments).toEqual({ maxBytes: 20 * 1024 * 1024, maxFiles: 10 });
  });

  it('sends text with the reply, then one multipart message per file with the caption', async () => {
    const calls: Call[] = [];
    let id = 500;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init: RequestInit) => {
        calls.push({ url, init });
        id += 1;
        return Promise.resolve(json({ id: String(id), channel_id: 'ch1' }));
      }),
    );

    const result = await connector().send('ch1:m99', {
      body: 'Report',
      attachments: [
        attachment({ caption: 'Screenshot' }),
        attachment({ kind: 'file', filename: 'r.pdf', mimeType: 'application/pdf' }),
      ],
    });

    expect(result._unsafeUnwrap()).toEqual({
      externalMessageId: '501',
      attachments: [
        { index: 0, status: 'sent', externalMessageId: '502' },
        { index: 1, status: 'sent', externalMessageId: '503' },
      ],
    });
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      content: 'Report',
      message_reference: { message_id: 'm99' },
    });
    const form = calls[1]!.init.body as FormData;
    expect(JSON.parse(form.get('payload_json') as string)).toEqual({
      content: 'Screenshot',
      attachments: [{ id: 0, filename: 'shot.png' }],
    });
    expect((form.get('files[0]') as File).name).toBe('shot.png');
    expect((calls[1]!.init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe('Bot bot-t');
  });

  it('puts the reply on the first file when there is no text', async () => {
    const calls: Call[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(json({ id: '700' }));
      }),
    );
    await connector().send('ch1:m99', { body: '', attachments: [attachment(), attachment()] });
    expect(calls).toHaveLength(2);
    const first = JSON.parse((calls[0]!.init.body as FormData).get('payload_json') as string);
    const second = JSON.parse((calls[1]!.init.body as FormData).get('payload_json') as string);
    expect(first.message_reference).toEqual({ message_id: 'm99' });
    expect(second.message_reference).toBeUndefined();
  });

  it('retries a rate-limited upload and reports a rejected one', async () => {
    const responses = [
      json({ id: '1' }),
      json({ message: 'rate limited', retry_after: 0.001 }, 429, { 'Retry-After': '0.001' }),
      json({ id: '2' }),
      json({ code: 40005, message: 'Request entity too large' }, 413),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(responses.shift())),
    );

    const result = await connector().send('ch1', {
      body: 'x',
      attachments: [attachment(), attachment()],
    });

    expect(result._unsafeUnwrap()).toEqual({
      externalMessageId: '1',
      attachments: [
        { index: 0, status: 'sent', externalMessageId: '2' },
        { index: 1, status: 'failed', error: expect.stringContaining('40005') },
      ],
    });
  });

  it('uploads nothing when the text fails', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(json({ code: 50013, message: 'Missing Permissions' }, 403));
    vi.stubGlobal('fetch', fetch);
    const result = await connector().send('ch1', { body: 'x', attachments: [attachment()] });
    expect(result.isErr()).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
