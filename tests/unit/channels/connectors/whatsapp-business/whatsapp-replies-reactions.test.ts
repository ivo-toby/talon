/**
 * Unit tests for contextual replies and emoji reactions in WhatsAppConnector
 * (WhatsApp Business / Cloud API).
 *
 * All WhatsApp Cloud API calls are intercepted via vi.stubGlobal('fetch', ...).
 * No real HTTP requests are made.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';
import { WhatsAppConnector } from '../../../../../src/channels/connectors/whatsapp-business/whatsapp-connector.js';
import type {
  WhatsAppConfig,
  WhatsAppMessage,
  WhatsAppWebhookPayload,
} from '../../../../../src/channels/connectors/whatsapp-business/whatsapp-types.js';
import type { InboundEvent } from '../../../../../src/channels/channel-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WA_ID = '447700900000';
const MESSAGES_URL = 'https://graph.facebook.com/v18.0/123456789/messages';

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

function makeConnector(overrides?: Partial<WhatsAppConfig>): WhatsAppConnector {
  return new WhatsAppConnector(defaultConfig(overrides), 'test-whatsapp', silentLogger());
}

/** Build a successful send response from the WhatsApp Cloud API. */
function sendOkResponse(messageId = 'wamid.X'): object {
  return {
    messaging_product: 'whatsapp',
    contacts: [{ input: '+1234567890', wa_id: '1234567890' }],
    messages: [{ id: messageId }],
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

/** Wrap one or more raw messages in a valid webhook payload. */
function makeWebhookPayload(...messages: WhatsAppMessage[]): WhatsAppWebhookPayload {
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
              contacts: [{ profile: { name: 'Test User' }, wa_id: WA_ID }],
              messages,
            },
          },
        ],
      },
    ],
  };
}

/** Build a text message, optionally carrying a `context` object. */
function makeTextMessage(
  messageId: string,
  text: string,
  context?: WhatsAppMessage['context'],
): WhatsAppMessage {
  return {
    id: messageId,
    from: WA_ID,
    timestamp: '1700000000',
    type: 'text',
    text: { body: text },
    ...(context !== undefined ? { context } : {}),
  };
}

/** Build a `type: 'reaction'` message with the given reaction object. */
function makeReactionMessage(
  messageId: string,
  reaction: Record<string, unknown>,
): WhatsAppMessage {
  return {
    id: messageId,
    from: WA_ID,
    timestamp: '1700000000',
    type: 'reaction',
    reaction: reaction as unknown as WhatsAppMessage['reaction'],
  };
}

/** Stub global fetch with a response resolving to the given JSON body. */
function stubFetchJson(
  body: unknown,
  init?: { ok?: boolean; status?: number },
): ReturnType<typeof vi.fn> {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: () => Promise.resolve(body),
  } as unknown as Response);
  vi.stubGlobal('fetch', mockFetch);
  return mockFetch;
}

/** Parse the JSON request body of the Nth fetch call. */
function requestBody(mockFetch: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const callOpts = mockFetch.mock.calls[call][1] as RequestInit;
  return JSON.parse(callOpts.body as string) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WhatsAppConnector replies and reactions', () => {
  let connector: WhatsAppConnector;
  let received: InboundEvent[];

  /** Register a collecting handler on `target` (defaults to the shared connector). */
  function collect(target: WhatsAppConnector = connector): InboundEvent[] {
    const events: InboundEvent[] = [];
    target.onMessage(async (event) => {
      events.push(event);
    });
    return events;
  }

  beforeEach(() => {
    connector = makeConnector();
    received = collect();
  });

  afterEach(async () => {
    await connector.stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Inbound: message identity and reply context
  // -------------------------------------------------------------------------

  describe('feedWebhook() — message identity and reply context', () => {
    it('carries the wamid as externalMessageId on a text message event', async () => {
      await connector.feedWebhook(makeWebhookPayload(makeTextMessage('wamid.TEXT1', 'Hello')));

      expect(received).toHaveLength(1);
      expect(received[0].externalMessageId).toBe('wamid.TEXT1');
      expect(received[0].idempotencyKey).toBe('wamid.TEXT1');
      expect(received[0].content).toBe('Hello');
      expect(received[0].reaction).toBeUndefined();
    });

    it('carries no replyTo on a plain text message without context', async () => {
      await connector.feedWebhook(makeWebhookPayload(makeTextMessage('wamid.TEXT2', 'Hello')));

      expect(received).toHaveLength(1);
      expect(received[0]).not.toHaveProperty('replyTo');
    });

    it('maps context { from, id } to replyTo { externalMessageId, senderId }', async () => {
      await connector.feedWebhook(
        makeWebhookPayload(
          makeTextMessage('wamid.REPLY1', 'a reply', { from: '15550001111', id: 'wamid.ORIG' }),
        ),
      );

      expect(received).toHaveLength(1);
      expect(received[0].replyTo).toEqual({
        externalMessageId: 'wamid.ORIG',
        senderId: '15550001111',
      });
      // The reply itself keeps its own identity.
      expect(received[0].externalMessageId).toBe('wamid.REPLY1');
      expect(received[0].content).toBe('a reply');
    });

    it('maps context { id } only to replyTo without senderId', async () => {
      await connector.feedWebhook(
        makeWebhookPayload(makeTextMessage('wamid.REPLY2', 'a reply', { id: 'wamid.ORIG' })),
      );

      expect(received).toHaveLength(1);
      expect(received[0].replyTo).toEqual({ externalMessageId: 'wamid.ORIG' });
      expect(received[0].replyTo).not.toHaveProperty('senderId');
    });

    it('yields NO replyTo when context has no id (forwarded-shaped context)', async () => {
      await connector.feedWebhook(
        makeWebhookPayload(
          makeTextMessage('wamid.FWD1', 'forwarded text', {
            forwarded: true,
          } as unknown as WhatsAppMessage['context']),
        ),
      );

      expect(received).toHaveLength(1);
      expect(received[0]).not.toHaveProperty('replyTo');
      expect(received[0].content).toBe('forwarded text');
      expect(received[0].externalMessageId).toBe('wamid.FWD1');
    });

    it('yields NO replyTo when context carries only from (no id)', async () => {
      await connector.feedWebhook(
        makeWebhookPayload(makeTextMessage('wamid.FWD2', 'text', { from: '15550001111' })),
      );

      expect(received).toHaveLength(1);
      expect(received[0]).not.toHaveProperty('replyTo');
    });
  });

  // -------------------------------------------------------------------------
  // Inbound: reactions
  // -------------------------------------------------------------------------

  describe('feedWebhook() — reactions', () => {
    it('normalises a reaction message into a reaction event', async () => {
      await connector.feedWebhook(
        makeWebhookPayload(
          makeReactionMessage('wamid.REACT1', { message_id: 'wamid.TARGET', emoji: '👍' }),
        ),
      );

      expect(received).toHaveLength(1);
      const event = received[0];
      expect(event.reaction).toEqual({ targetMessageId: 'wamid.TARGET', emoji: '👍' });
      expect(event.content).toBe('');
      expect(event.channelType).toBe('whatsappBusiness');
      expect(event.channelName).toBe('test-whatsapp');
      expect(event.externalThreadId).toBe(WA_ID);
      expect(event.senderId).toBe(WA_ID);
      expect(event.idempotencyKey).toBe('wamid.REACT1');
      expect(event.timestamp).toBe(1_700_000_000_000); // seconds → ms
      expect(event).not.toHaveProperty('externalMessageId');
      expect(event).not.toHaveProperty('replyTo');
      expect(event).not.toHaveProperty('attachments');
    });

    it('forwards reactions when inboundReactions is explicitly true', async () => {
      const enabled = makeConnector({ inboundReactions: true });
      const events = collect(enabled);

      await enabled.feedWebhook(
        makeWebhookPayload(
          makeReactionMessage('wamid.REACT2', { message_id: 'wamid.TARGET', emoji: '❤️' }),
        ),
      );

      expect(events).toHaveLength(1);
      expect(events[0].reaction).toEqual({ targetMessageId: 'wamid.TARGET', emoji: '❤️' });
    });

    it('drops a reaction when inboundReactions is false', async () => {
      const disabled = makeConnector({ inboundReactions: false });
      const events = collect(disabled);

      await disabled.feedWebhook(
        makeWebhookPayload(
          makeReactionMessage('wamid.REACT3', { message_id: 'wamid.TARGET', emoji: '👍' }),
        ),
      );

      expect(events).toHaveLength(0);
    });

    it('still delivers text messages when inboundReactions is false', async () => {
      const disabled = makeConnector({ inboundReactions: false });
      const events = collect(disabled);

      await disabled.feedWebhook(
        makeWebhookPayload(
          makeReactionMessage('wamid.REACT4', { message_id: 'wamid.TARGET', emoji: '👍' }),
          makeTextMessage('wamid.TEXT3', 'still here'),
        ),
      );

      expect(events).toHaveLength(1);
      expect(events[0].content).toBe('still here');
      expect(events[0].reaction).toBeUndefined();
    });

    it('drops a reaction removal (emoji absent)', async () => {
      await connector.feedWebhook(
        makeWebhookPayload(makeReactionMessage('wamid.REACT5', { message_id: 'wamid.TARGET' })),
      );

      expect(received).toHaveLength(0);
    });

    it('drops a reaction whose emoji is an empty string', async () => {
      await connector.feedWebhook(
        makeWebhookPayload(
          makeReactionMessage('wamid.REACT6', { message_id: 'wamid.TARGET', emoji: '' }),
        ),
      );

      expect(received).toHaveLength(0);
    });

    it('drops a reaction without a message_id', async () => {
      await connector.feedWebhook(
        makeWebhookPayload(makeReactionMessage('wamid.REACT7', { emoji: '👍' })),
      );

      expect(received).toHaveLength(0);
    });

    it('does not trigger any media / Graph API fetch for a reaction', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await connector.feedWebhook(
        makeWebhookPayload(
          makeReactionMessage('wamid.REACT8', { message_id: 'wamid.TARGET', emoji: '👍' }),
        ),
      );

      expect(received).toHaveLength(1);
      expect(received[0].reaction).toEqual({ targetMessageId: 'wamid.TARGET', emoji: '👍' });
      expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    it('does not fetch media for a dropped reaction either', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await connector.feedWebhook(
        makeWebhookPayload(makeReactionMessage('wamid.REACT9', { message_id: 'wamid.TARGET' })),
      );

      expect(received).toHaveLength(0);
      expect(fetchMock).toHaveBeenCalledTimes(0);
    });
  });

  // -------------------------------------------------------------------------
  // Outbound: send() receipt
  // -------------------------------------------------------------------------

  describe('send() — receipt', () => {
    it('returns the sent wamid as the receipt', async () => {
      stubFetchJson(sendOkResponse('wamid.X'));

      const result = await connector.send(WA_ID, { body: 'Hello' });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({ externalMessageId: 'wamid.X' });
    });

    it('returns ok(undefined) when the response has no messages array', async () => {
      stubFetchJson({ messaging_product: 'whatsapp' });

      const result = await connector.send(WA_ID, { body: 'Hello' });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeUndefined();
    });

    it('returns ok(undefined) when the messages array is empty', async () => {
      stubFetchJson({ messaging_product: 'whatsapp', messages: [] });

      const result = await connector.send(WA_ID, { body: 'Hello' });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Outbound: send() contextual replies
  // -------------------------------------------------------------------------

  describe('send() — contextual replies', () => {
    it('sends exactly the plain text payload when there is no replyTo', async () => {
      const mockFetch = stubFetchJson(sendOkResponse());

      await connector.send(WA_ID, { body: 'plain text' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toBe(MESSAGES_URL);
      expect(requestBody(mockFetch)).toEqual({
        messaging_product: 'whatsapp',
        to: WA_ID,
        type: 'text',
        text: { body: 'plain text' },
      });
    });

    it('adds context.message_id for an explicit replyTo', async () => {
      const mockFetch = stubFetchJson(sendOkResponse());

      const result = await connector.send(WA_ID, {
        body: 'an answer',
        replyTo: { externalMessageId: 'wamid.ORIG' },
      });

      expect(result._unsafeUnwrap()).toEqual({ externalMessageId: 'wamid.X' });
      expect(requestBody(mockFetch)).toEqual({
        messaging_product: 'whatsapp',
        to: WA_ID,
        type: 'text',
        text: { body: 'an answer' },
        context: { message_id: 'wamid.ORIG' },
      });
    });

    it('sends only message_id in context even when the target carries ledger fields', async () => {
      const mockFetch = stubFetchJson(sendOkResponse());

      await connector.send(WA_ID, {
        body: 'an answer',
        replyTo: {
          externalMessageId: 'wamid.ORIG',
          fromSelf: false,
          author: '15550001111',
          text: 'quoted text',
        },
      });

      expect(requestBody(mockFetch).context).toEqual({ message_id: 'wamid.ORIG' });
    });

    it('sends an explicit replyTo as a reply even when replyToTrigger is never', async () => {
      const never = makeConnector({ replyToTrigger: 'never' });
      const mockFetch = stubFetchJson(sendOkResponse());

      await never.send(WA_ID, {
        body: 'an answer',
        replyTo: { externalMessageId: 'wamid.ORIG' },
      });

      expect(requestBody(mockFetch).context).toEqual({ message_id: 'wamid.ORIG' });
    });

    it('omits context for an implicit replyTo in the default (groups) mode', async () => {
      const mockFetch = stubFetchJson(sendOkResponse());

      await connector.send(WA_ID, {
        body: 'an answer',
        replyTo: { externalMessageId: 'wamid.ORIG', implicit: true },
      });

      const body = requestBody(mockFetch);
      expect(body).not.toHaveProperty('context');
      expect(body).toEqual({
        messaging_product: 'whatsapp',
        to: WA_ID,
        type: 'text',
        text: { body: 'an answer' },
      });
    });

    it('omits context for an implicit replyTo when replyToTrigger is explicitly groups', async () => {
      const groups = makeConnector({ replyToTrigger: 'groups' });
      const mockFetch = stubFetchJson(sendOkResponse());

      await groups.send(WA_ID, {
        body: 'an answer',
        replyTo: { externalMessageId: 'wamid.ORIG', implicit: true },
      });

      expect(requestBody(mockFetch)).not.toHaveProperty('context');
    });

    it('adds context for an implicit replyTo when replyToTrigger is always', async () => {
      const always = makeConnector({ replyToTrigger: 'always' });
      const mockFetch = stubFetchJson(sendOkResponse());

      await always.send(WA_ID, {
        body: 'an answer',
        replyTo: { externalMessageId: 'wamid.ORIG', implicit: true },
      });

      expect(requestBody(mockFetch)).toEqual({
        messaging_product: 'whatsapp',
        to: WA_ID,
        type: 'text',
        text: { body: 'an answer' },
        context: { message_id: 'wamid.ORIG' },
      });
    });

    it('omits context for an implicit replyTo when replyToTrigger is never', async () => {
      const never = makeConnector({ replyToTrigger: 'never' });
      const mockFetch = stubFetchJson(sendOkResponse());

      await never.send(WA_ID, {
        body: 'an answer',
        replyTo: { externalMessageId: 'wamid.ORIG', implicit: true },
      });

      expect(requestBody(mockFetch)).not.toHaveProperty('context');
    });

    it('omits context when the replyTo target has an empty message ID', async () => {
      const mockFetch = stubFetchJson(sendOkResponse());

      await connector.send(WA_ID, { body: 'an answer', replyTo: { externalMessageId: '' } });

      expect(requestBody(mockFetch)).not.toHaveProperty('context');
    });
  });

  // -------------------------------------------------------------------------
  // Outbound: send() error mapping (pre-existing behaviour)
  // -------------------------------------------------------------------------

  describe('send() — error mapping', () => {
    it('maps an API error object to "WhatsApp send failed (<code>): <message>"', async () => {
      stubFetchJson(sendErrorResponse(190, 'Invalid OAuth access token'), {
        ok: false,
        status: 401,
      });

      const result = await connector.send(WA_ID, {
        body: 'test',
        replyTo: { externalMessageId: 'wamid.ORIG' },
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe(
        'WhatsApp send failed (190): Invalid OAuth access token',
      );
    });

    it('maps a non-OK HTTP response without an error body to an Err naming the status', async () => {
      stubFetchJson({}, { ok: false, status: 429 });

      const result = await connector.send(WA_ID, { body: 'test' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe('WhatsApp send failed with HTTP 429');
    });

    it('maps a network throw to "WhatsApp send network error: …"', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));

      const result = await connector.send(WA_ID, { body: 'test' });

      expect(result.isErr()).toBe(true);
      const message = result._unsafeUnwrapErr().message;
      expect(message.startsWith('WhatsApp send network error: ')).toBe(true);
      expect(message).toContain('network failure');
    });

    it('maps an unparseable JSON response to an Err', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: () => Promise.reject(new SyntaxError('not json')),
        } as unknown as Response),
      );

      const result = await connector.send(WA_ID, { body: 'test' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe(
        'WhatsApp send: could not parse response (HTTP 500)',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Outbound: react()
  // -------------------------------------------------------------------------

  describe('react()', () => {
    it('POSTs a reaction payload to the messages endpoint with a bearer token', async () => {
      const mockFetch = stubFetchJson(sendOkResponse('wamid.REACTION'));

      const result = await connector.react(WA_ID, { externalMessageId: 'wamid.TARGET' }, '👍');

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeUndefined();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toBe(MESSAGES_URL);

      const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
      expect(callOpts.method).toBe('POST');
      const headers = callOpts.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-access-token');
      expect(headers['Content-Type']).toBe('application/json');

      expect(requestBody(mockFetch)).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: WA_ID,
        type: 'reaction',
        reaction: { message_id: 'wamid.TARGET', emoji: '👍' },
      });
    });

    it('builds the URL from the configured apiVersion and phoneNumberId', async () => {
      const custom = makeConnector({ apiVersion: 'v19.0', phoneNumberId: '987654321' });
      const mockFetch = stubFetchJson(sendOkResponse());

      await custom.react(WA_ID, { externalMessageId: 'wamid.TARGET' }, '👍');

      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://graph.facebook.com/v19.0/987654321/messages',
      );
    });

    it('sends an empty emoji as an empty emoji (clear)', async () => {
      const mockFetch = stubFetchJson(sendOkResponse());

      const result = await connector.react(WA_ID, { externalMessageId: 'wamid.TARGET' }, '');

      expect(result.isOk()).toBe(true);
      expect(requestBody(mockFetch)).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: WA_ID,
        type: 'reaction',
        reaction: { message_id: 'wamid.TARGET', emoji: '' },
      });
    });

    it('maps an API error to "WhatsApp reaction failed (<code>): <message>"', async () => {
      stubFetchJson(sendErrorResponse(131009, 'Parameter value is not valid'), {
        ok: false,
        status: 400,
      });

      const result = await connector.react(WA_ID, { externalMessageId: 'wamid.TARGET' }, '👍');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe(
        'WhatsApp reaction failed (131009): Parameter value is not valid',
      );
    });

    it('maps a network throw to "WhatsApp reaction network error: …"', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));

      const result = await connector.react(WA_ID, { externalMessageId: 'wamid.TARGET' }, '👍');

      expect(result.isErr()).toBe(true);
      const message = result._unsafeUnwrapErr().message;
      expect(message.startsWith('WhatsApp reaction network error: ')).toBe(true);
      expect(message).toContain('network failure');
    });

    it('maps a non-OK HTTP response without an error body to an Err naming the status', async () => {
      stubFetchJson({}, { ok: false, status: 503 });

      const result = await connector.react(WA_ID, { externalMessageId: 'wamid.TARGET' }, '👍');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe('WhatsApp reaction failed with HTTP 503');
    });
  });
});
