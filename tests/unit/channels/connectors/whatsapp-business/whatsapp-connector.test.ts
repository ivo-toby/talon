/**
 * Unit tests for WhatsAppConnector.
 *
 * All WhatsApp Cloud API calls are intercepted via vi.stubGlobal('fetch', ...).
 * No real HTTP requests are made.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';
import { WhatsAppConnector } from '../../../../../src/channels/connectors/whatsapp-business/whatsapp-connector.js';
import type { WhatsAppConfig, WhatsAppWebhookPayload } from '../../../../../src/channels/connectors/whatsapp-business/whatsapp-types.js';
import type { InboundEvent } from '../../../../../src/channels/channel-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function defaultConfig(overrides?: Partial<WhatsAppConfig>): WhatsAppConfig {
  return {
    phoneNumberId: '123456789',
    accessToken: 'test-access-token',
    verifyToken: 'test-verify-token',
    apiVersion: 'v18.0',
    ...overrides,
  };
}

/** Build a successful send response from the WhatsApp Cloud API. */
function sendOkResponse(): object {
  return {
    messaging_product: 'whatsapp',
    contacts: [{ input: '+1234567890', wa_id: '1234567890' }],
    messages: [{ id: 'wamid.ABCDEF' }],
  };
}

/** Build an error response from the WhatsApp Cloud API. */
function sendErrorResponse(code: number, message: string): object {
  return {
    error: {
      message,
      type: 'OAuthException',
      code,
      fbtrace_id: 'trace123',
    },
  };
}

/** Build a valid text message webhook payload. */
function makeTextWebhookPayload(
  waId: string,
  messageId: string,
  text: string,
  timestampSec = 1_700_000_000,
): WhatsAppWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-id-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '+10000000000',
                phone_number_id: '123456789',
              },
              contacts: [{ profile: { name: 'Test User' }, wa_id: waId }],
              messages: [
                {
                  id: messageId,
                  from: waId,
                  timestamp: String(timestampSec),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Build a media message webhook payload (no text). */
function makeMediaWebhookPayload(waId: string, messageId: string, mediaType: string): WhatsAppWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-id-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '+10000000000',
                phone_number_id: '123456789',
              },
              contacts: [],
              messages: [
                {
                  id: messageId,
                  from: waId,
                  timestamp: '1700000000',
                  type: mediaType,
                  [mediaType]: { id: 'media-id-123' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WhatsAppConnector', () => {
  let connector: WhatsAppConnector;

  beforeEach(() => {
    connector = new WhatsAppConnector(defaultConfig(), 'test-whatsapp', silentLogger());
  });

  afterEach(async () => {
    await connector.stop();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Constructor / metadata
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('exposes type = "whatsappBusiness"', () => {
      expect(connector.type).toBe('whatsappBusiness');
    });

    it('exposes the channel name', () => {
      expect(connector.name).toBe('test-whatsapp');
    });
  });

  // -------------------------------------------------------------------------
  // Start / stop lifecycle
  // -------------------------------------------------------------------------

  describe('start/stop lifecycle', () => {
    it('starts without error', async () => {
      await connector.start();
    });

    it('stops without error', async () => {
      await connector.start();
      await connector.stop();
    });

    it('start() is idempotent — calling it twice does not throw', async () => {
      await connector.start();
      await connector.start(); // second call is a no-op
      await connector.stop();
    });

    it('stop() is idempotent when not running', async () => {
      await connector.stop(); // should not throw
    });

    it('stop() is idempotent when called twice', async () => {
      await connector.start();
      await connector.stop();
      await connector.stop(); // should not throw
    });
  });

  // -------------------------------------------------------------------------
  // feedWebhook — inbound message ingestion
  // -------------------------------------------------------------------------

  describe('feedWebhook()', () => {
    it('calls handler with a correctly normalised InboundEvent for a text message', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => {
        received.push(event);
      });

      const payload = makeTextWebhookPayload('447700900000', 'wamid.ABCDEF', 'Hello WhatsApp!');
      await connector.feedWebhook(payload);

      expect(received).toHaveLength(1);
      const event = received[0];
      expect(event.channelType).toBe('whatsappBusiness');
      expect(event.channelName).toBe('test-whatsapp');
      expect(event.externalThreadId).toBe('447700900000');
      expect(event.senderId).toBe('447700900000');
      expect(event.idempotencyKey).toBe('wamid.ABCDEF');
      expect(event.content).toBe('Hello WhatsApp!');
      expect(event.timestamp).toBe(1_700_000_000_000); // converted from seconds to ms
      expect(event.raw).toBeDefined();
    });

    it('processes multiple messages in a single webhook payload', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => {
        received.push(event);
      });

      const payload: WhatsAppWebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'entry-1',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '+10000000000',
                    phone_number_id: '123456789',
                  },
                  contacts: [],
                  messages: [
                    {
                      id: 'msg-1',
                      from: '111',
                      timestamp: '1700000001',
                      type: 'text',
                      text: { body: 'first' },
                    },
                    {
                      id: 'msg-2',
                      from: '222',
                      timestamp: '1700000002',
                      type: 'text',
                      text: { body: 'second' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      await connector.feedWebhook(payload);

      expect(received).toHaveLength(2);
      expect(received[0].content).toBe('first');
      expect(received[1].content).toBe('second');
    });

    it('skips non-text message types (image, document, audio)', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.feedWebhook(makeMediaWebhookPayload('447700900000', 'wamid.IMG1', 'image'));
      await connector.feedWebhook(makeMediaWebhookPayload('447700900000', 'wamid.DOC1', 'document'));
      await connector.feedWebhook(makeMediaWebhookPayload('447700900000', 'wamid.AUD1', 'audio'));

      expect(received).toHaveLength(0);
    });

    it('ignores payloads that are not whatsapp_business_account', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => {
        received.push(event);
      });

      const nonWaPayload = {
        object: 'page',
        entry: [],
      } as unknown as WhatsAppWebhookPayload;

      await connector.feedWebhook(nonWaPayload);

      expect(received).toHaveLength(0);
    });

    it('ignores changes with field other than "messages"', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => {
        received.push(event);
      });

      const payload: WhatsAppWebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'entry-1',
            changes: [
              {
                field: 'statuses', // not 'messages'
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '+10000000000',
                    phone_number_id: '123456789',
                  },
                  messages: [
                    {
                      id: 'msg-1',
                      from: '111',
                      timestamp: '1700000001',
                      type: 'text',
                      text: { body: 'should be ignored' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      await connector.feedWebhook(payload);
      expect(received).toHaveLength(0);
    });

    it('does not call handler when no handler is registered', async () => {
      // Should not throw even without a registered handler.
      const payload = makeTextWebhookPayload('447700900000', 'wamid.ABCDEF', 'Hello!');
      await expect(connector.feedWebhook(payload)).resolves.toBeUndefined();
    });

    it('continues processing messages after a handler error', async () => {
      const received: InboundEvent[] = [];
      let callCount = 0;

      connector.onMessage(async (event) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('handler blew up');
        }
        received.push(event);
      });

      const payload: WhatsAppWebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'entry-1',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '+10000000000',
                    phone_number_id: '123456789',
                  },
                  contacts: [],
                  messages: [
                    {
                      id: 'msg-fail',
                      from: '111',
                      timestamp: '1700000001',
                      type: 'text',
                      text: { body: 'causes error' },
                    },
                    {
                      id: 'msg-ok',
                      from: '111',
                      timestamp: '1700000002',
                      type: 'text',
                      text: { body: 'succeeds' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      await connector.feedWebhook(payload);

      expect(callCount).toBe(2);
      expect(received).toHaveLength(1);
      expect(received[0].idempotencyKey).toBe('msg-ok');
    });

    it('includes raw payload in the event', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.feedWebhook(
        makeTextWebhookPayload('447700900000', 'wamid.RAW', 'raw test'),
      );

      expect(received[0].raw).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // send()
  // -------------------------------------------------------------------------

  describe('send()', () => {
    it('returns Ok on a successful API call', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sendOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('447700900000', { body: 'Hello **world**' });

      expect(result.isOk()).toBe(true);
    });

    it('calls the correct WhatsApp Cloud API endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sendOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('447700900000', { body: 'Hello' });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('graph.facebook.com');
      expect(calledUrl).toContain('v18.0');
      expect(calledUrl).toContain('123456789');
      expect(calledUrl).toContain('messages');
    });

    it('uses the configured API version in the URL', async () => {
      const customVersionConnector = new WhatsAppConnector(
        defaultConfig({ apiVersion: 'v19.0' }),
        'custom-version',
        silentLogger(),
      );

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sendOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await customVersionConnector.send('447700900000', { body: 'Hello' });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('v19.0');
    });

    it('defaults to v18.0 when apiVersion is not configured', async () => {
      const defaultVersionConnector = new WhatsAppConnector(
        { phoneNumberId: '123', accessToken: 'token', verifyToken: 'verify' },
        'default-version',
        silentLogger(),
      );

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sendOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await defaultVersionConnector.send('447700900000', { body: 'Hello' });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('v18.0');
    });

    it('sends Bearer authorization header with access token', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sendOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('447700900000', { body: 'Hello' });

      const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
      const headers = callOpts.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-access-token');
    });

    it('posts JSON with correct WhatsApp message structure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sendOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('447700900000', { body: 'plain text' });

      const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(callOpts.body as string) as Record<string, unknown>;
      expect(body.messaging_product).toBe('whatsapp');
      expect(body.to).toBe('447700900000');
      expect(body.type).toBe('text');
      expect((body.text as Record<string, unknown>).body).toBeDefined();
    });

    it('converts Markdown body to WhatsApp format before sending', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sendOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('447700900000', { body: '**bold**' });

      const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(callOpts.body as string) as Record<string, unknown>;
      const textBody = body.text as Record<string, unknown>;
      // **bold** should be converted to *bold* (WhatsApp bold)
      expect(textBody.body).toBe('*bold*');
    });

    it('returns Err(ChannelError) when the API returns an error object', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve(sendErrorResponse(190, 'Invalid OAuth access token')),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('447700900000', { body: 'test' });

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.message).toContain('190');
      expect(error.message).toContain('Invalid OAuth access token');
    });

    it('returns Err(ChannelError) on a network error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('network failure'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('447700900000', { body: 'test' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('network failure');
    });

    it('returns Err(ChannelError) when response body is not parseable JSON', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new SyntaxError('not json')),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('447700900000', { body: 'test' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('500');
    });

    it('returns Err(ChannelError) when response is non-ok with no error field', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: () => Promise.resolve({}),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('447700900000', { body: 'test' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('429');
    });
  });

  // -------------------------------------------------------------------------
  // format()
  // -------------------------------------------------------------------------

  describe('format()', () => {
    it('delegates to markdownToWhatsApp', () => {
      expect(connector.format('**hello**')).toBe('*hello*');
    });

    it('converts inline code to triple backtick monospace', () => {
      expect(connector.format('`code`')).toBe('```code```');
    });

    it('converts heading to bold', () => {
      expect(connector.format('# Title')).toBe('*Title*');
    });

    it('converts link to label (url) format', () => {
      expect(connector.format('[click](https://example.com)')).toBe(
        'click (https://example.com)',
      );
    });

    it('passes plain text through unchanged', () => {
      expect(connector.format('plain text')).toBe('plain text');
    });
  });
});
