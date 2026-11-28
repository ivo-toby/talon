/**
 * Unit tests for Telegram outbound attachments: sendPhoto vs sendDocument,
 * captions, topics, native replies, photo→document fallback and receipts.
 *
 * Bot API calls are intercepted via vi.stubGlobal('fetch', ...).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import pino from 'pino';
import { TelegramConnector } from '../../../../../src/channels/connectors/telegram/telegram-connector.js';
import {
  TELEGRAM_MAX_PHOTO_BYTES,
  sendTelegramAttachment,
} from '../../../../../src/channels/connectors/telegram/telegram-outbound-media.js';
import type { OutboundAttachment } from '../../../../../src/channels/channel-types.js';

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

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

interface Call {
  method: string;
  form?: FormData;
  json?: Record<string, unknown>;
}

/** A fetch mock that answers each Bot API method with the next queued body. */
function mockFetch(answers: Record<string, unknown[]>): {
  calls: Call[];
  fetch: ReturnType<typeof vi.fn>;
} {
  const calls: Call[] = [];
  const fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = url.split('/').pop() ?? '';
    const body = init?.body;
    calls.push({
      method,
      ...(body instanceof FormData ? { form: body } : {}),
      ...(typeof body === 'string' ? { json: JSON.parse(body) as Record<string, unknown> } : {}),
    });
    const next = answers[method]?.shift() ?? { ok: true, result: { message_id: 1 } };
    return Promise.resolve(jsonResponse(next));
  });
  return { calls, fetch };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendTelegramAttachment', () => {
  const apiUrl = (m: string): string => `https://api.telegram.org/botTOKEN/${m}`;

  it('sends an image as a photo with caption, topic and reply', async () => {
    const { calls, fetch } = mockFetch({ sendPhoto: [{ ok: true, result: { message_id: 42 } }] });
    const result = await sendTelegramAttachment(
      apiUrl,
      attachment({ caption: 'Look *here*' }),
      { chatId: '-100123', topicId: 7, replyToMessageId: 5 },
      fetch as unknown as typeof globalThis.fetch,
    );
    expect(result._unsafeUnwrap()).toBe('42');
    const form = calls[0]!.form!;
    expect(calls[0]!.method).toBe('sendPhoto');
    expect(form.get('chat_id')).toBe('-100123');
    expect(form.get('message_thread_id')).toBe('7');
    expect(form.get('caption')).toBe('Look *here*');
    expect(form.get('parse_mode')).toBeNull();
    expect(JSON.parse(form.get('reply_parameters') as string)).toEqual({
      message_id: 5,
      allow_sending_without_reply: true,
    });
    const file = form.get('photo') as File;
    expect(file.name).toBe('shot.png');
    expect(file.type).toBe('image/png');
  });

  it('sends non-images and oversized images as documents', async () => {
    const { calls, fetch } = mockFetch({});
    await sendTelegramAttachment(
      apiUrl,
      attachment({ kind: 'file', mimeType: 'application/pdf', filename: 'r.pdf' }),
      { chatId: '1' },
      fetch as never,
    );
    await sendTelegramAttachment(
      apiUrl,
      attachment({ size: TELEGRAM_MAX_PHOTO_BYTES + 1 }),
      { chatId: '1' },
      fetch as never,
    );
    expect(calls.map((c) => c.method)).toEqual(['sendDocument', 'sendDocument']);
    expect((calls[0]!.form!.get('document') as File).name).toBe('r.pdf');
  });

  it('retries a photo Telegram rejects as a document', async () => {
    const { calls, fetch } = mockFetch({
      sendPhoto: [
        { ok: false, error_code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' },
      ],
      sendDocument: [{ ok: true, result: { message_id: 9 } }],
    });
    const result = await sendTelegramAttachment(
      apiUrl,
      attachment(),
      { chatId: '1' },
      fetch as never,
    );
    expect(result._unsafeUnwrap()).toBe('9');
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendDocument']);
  });

  it('returns a ChannelError when the document upload fails', async () => {
    const { fetch } = mockFetch({
      sendDocument: [{ ok: false, error_code: 413, description: 'Request Entity Too Large' }],
    });
    const result = await sendTelegramAttachment(
      apiUrl,
      attachment({ kind: 'file' }),
      { chatId: '1' },
      fetch as never,
    );
    expect(result._unsafeUnwrapErr().message).toContain('413');
  });
});

describe('TelegramConnector.send with attachments', () => {
  function connector(): TelegramConnector {
    return new TelegramConnector(
      { botToken: 'TOKEN', pollingTimeoutSec: 1 },
      'tg',
      pino({ level: 'silent' }),
    );
  }

  it('declares outbound attachment support', () => {
    expect(connector().outboundAttachments).toEqual({ maxBytes: 50 * 1024 * 1024, maxFiles: 10 });
  });

  it('sends the text with the reply first, then each attachment into the topic, and reports per item', async () => {
    const { calls, fetch } = mockFetch({
      sendMessage: [{ ok: true, result: { message_id: 100 } }],
      sendPhoto: [{ ok: true, result: { message_id: 101 } }],
      sendDocument: [{ ok: false, error_code: 400, description: 'Bad Request: file is empty' }],
    });
    vi.stubGlobal('fetch', fetch);

    const result = await connector().send('-100123:7', {
      body: 'Report',
      replyTo: { externalMessageId: '55' },
      attachments: [
        attachment(),
        attachment({ kind: 'file', mimeType: 'text/plain', filename: 'log.txt' }),
      ],
    });

    expect(result._unsafeUnwrap()).toEqual({
      externalMessageId: '100',
      attachments: [
        { index: 0, status: 'sent', externalMessageId: '101' },
        { index: 1, status: 'failed', error: expect.stringContaining('file is empty') },
      ],
    });
    expect(calls.map((c) => c.method)).toEqual(['sendMessage', 'sendPhoto', 'sendDocument']);
    expect(calls[0]!.json).toMatchObject({
      chat_id: '-100123',
      message_thread_id: 7,
      reply_parameters: { message_id: 55 },
    });
    expect(calls[1]!.form!.get('message_thread_id')).toBe('7');
    expect(calls[1]!.form!.get('reply_parameters')).toBeNull();
  });

  it('puts the reply on the first attachment when there is no text', async () => {
    const { calls, fetch } = mockFetch({ sendPhoto: [{ ok: true, result: { message_id: 200 } }] });
    vi.stubGlobal('fetch', fetch);

    const result = await connector().send('555', {
      body: '',
      replyTo: { externalMessageId: '9' },
      attachments: [attachment()],
    });

    expect(result._unsafeUnwrap()).toMatchObject({ externalMessageId: '200' });
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto']);
    expect(JSON.parse(calls[0]!.form!.get('reply_parameters') as string)).toMatchObject({
      message_id: 9,
    });
  });

  it('uploads nothing when the text fails', async () => {
    const { calls, fetch } = mockFetch({
      sendMessage: [{ ok: false, error_code: 403, description: 'Forbidden' }],
    });
    vi.stubGlobal('fetch', fetch);

    const result = await connector().send('555', { body: 'x', attachments: [attachment()] });

    expect(result.isErr()).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['sendMessage']);
  });
});
