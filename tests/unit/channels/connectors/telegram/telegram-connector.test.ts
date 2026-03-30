/**
 * Unit tests for TelegramConnector.
 *
 * All Telegram Bot API calls are intercepted via vi.stubGlobal('fetch', ...).
 * No real HTTP requests are made.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';
import { TelegramConnector } from '../../../../../src/channels/connectors/telegram/telegram-connector.js';
import type { TelegramConfig } from '../../../../../src/channels/connectors/telegram/telegram-types.js';
import type { InboundEvent } from '../../../../../src/channels/channel-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function defaultConfig(overrides?: Partial<TelegramConfig>): TelegramConfig {
  return {
    botToken: 'test-token',
    pollingTimeoutSec: 1,
    ...overrides,
  };
}

/** Default getMe response used by makeMockFetch. */
const GET_ME_RESPONSE = {
  ok: true,
  result: { id: 12345, is_bot: true, first_name: 'TestBot', username: 'test_bot' },
};

/**
 * Build a fake fetch function that returns the given JSON bodies in order.
 * Calls to the `getMe` endpoint are intercepted and always return a
 * standard bot identity response, without consuming from the responses queue.
 * If there are more calls than responses, subsequent calls hang until the
 * AbortSignal fires.
 */
function makeMockFetch(responses: Array<unknown>): ReturnType<typeof vi.fn> {
  let callIndex = 0;
  return vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    // Auto-respond to getMe calls without consuming queued responses.
    if (typeof url === 'string' && url.endsWith('/getMe')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(GET_ME_RESPONSE),
      } as Response);
    }

    const idx = callIndex++;
    if (idx < responses.length) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(responses[idx]),
      } as Response);
    }
    // No more prepared responses — hang until aborted.
    return new Promise((_resolve, reject) => {
      if (opts?.signal) {
        opts.signal.addEventListener('abort', () => {
          const err = new DOMException('The operation was aborted.', 'AbortError');
          reject(err);
        });
        // If already aborted.
        if (opts.signal.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        }
      }
    });
  });
}

/** Build a minimal TelegramUpdate with a text message. */
function makeUpdate(
  updateId: number,
  chatId: number,
  text: string,
  userId = 999,
): object {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      from: { id: userId, first_name: 'Test', username: 'testuser' },
      chat: { id: chatId, type: 'private' },
      date: 1_700_000_000,
      text,
    },
  };
}

/** Build a getUpdates response with the given updates. */
function updatesResponse(updates: object[]): object {
  return { ok: true, result: updates };
}

/** Build an empty getUpdates response. */
function emptyUpdatesResponse(): object {
  return { ok: true, result: [] };
}

/** Build a successful sendMessage response. */
function sendOkResponse(): object {
  return {
    ok: true,
    result: {
      message_id: 42,
      chat: { id: 1234, type: 'private' },
      date: 1_700_000_000,
      text: 'hello',
    },
  };
}

/** Build a failed sendMessage response. */
function sendErrorResponse(code: number, description: string): object {
  return { ok: false, error_code: code, description };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelegramConnector', () => {
  let connector: TelegramConnector;

  beforeEach(() => {
    connector = new TelegramConnector(defaultConfig(), 'test-bot', silentLogger());
  });

  afterEach(async () => {
    // Ensure connector is stopped after each test to clean up any running poll loops.
    await connector.stop();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Constructor / metadata
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('exposes type = "telegram"', () => {
      expect(connector.type).toBe('telegram');
    });

    it('exposes the channel name', () => {
      expect(connector.name).toBe('test-bot');
    });
  });

  // -------------------------------------------------------------------------
  // Start / stop lifecycle
  // -------------------------------------------------------------------------

  describe('start/stop lifecycle', () => {
    it('starts and stops without error', async () => {
      const mockFetch = makeMockFetch([]);
      vi.stubGlobal('fetch', mockFetch);

      await connector.start();
      await connector.stop();
    });

    it('start() is idempotent — calling it twice does not create two loops', async () => {
      const mockFetch = makeMockFetch([]);
      vi.stubGlobal('fetch', mockFetch);

      await connector.start();
      await connector.start(); // second call is a no-op
      await connector.stop();
    });

    it('stop() is idempotent when not running', async () => {
      await connector.stop(); // should not throw
    });
  });

  // -------------------------------------------------------------------------
  // Inbound message handling
  // -------------------------------------------------------------------------

  describe('onMessage / incoming updates', () => {
    it('calls handler with a correctly normalised InboundEvent', async () => {
      const received: InboundEvent[] = [];

      const mockFetch = makeMockFetch([
        updatesResponse([makeUpdate(101, 555, 'Hello bot!')]),
        // After processing the first batch, the loop will call getUpdates again
        // and hang until stop().
      ]);
      vi.stubGlobal('fetch', mockFetch);

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.start();

      // Give the poll loop time to process the first batch.
      await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 2000 });

      await connector.stop();

      const event = received[0];
      expect(event.channelType).toBe('telegram');
      expect(event.channelName).toBe('test-bot');
      expect(event.externalThreadId).toBe('555');
      expect(event.senderId).toBe('999');
      expect(event.idempotencyKey).toBe('101');
      expect(event.content).toBe('Hello bot!');
      expect(event.timestamp).toBe(1_700_000_000_000); // ms
      expect(event.raw).toBeDefined();
    });

    it('processes multiple updates in a single batch', async () => {
      const received: InboundEvent[] = [];

      const mockFetch = makeMockFetch([
        updatesResponse([
          makeUpdate(200, 10, 'first'),
          makeUpdate(201, 10, 'second'),
          makeUpdate(202, 10, 'third'),
        ]),
      ]);
      vi.stubGlobal('fetch', mockFetch);

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.start();
      await vi.waitFor(() => expect(received.length).toBe(3), { timeout: 2000 });
      await connector.stop();

      expect(received.map((e) => e.content)).toEqual(['first', 'second', 'third']);
    });

    it('skips updates without text', async () => {
      const received: InboundEvent[] = [];

      const mockFetch = makeMockFetch([
        updatesResponse([
          // Update without a message.text
          {
            update_id: 300,
            message: {
              message_id: 3000,
              chat: { id: 50, type: 'private' },
              date: 1_700_000_000,
              // no text field
            },
          },
          makeUpdate(301, 50, 'this one has text'),
        ]),
      ]);
      vi.stubGlobal('fetch', mockFetch);

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.start();
      await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 2000 });
      await connector.stop();

      expect(received[0].content).toBe('this one has text');
    });

    it('skips updates with no message object', async () => {
      const received: InboundEvent[] = [];

      const mockFetch = makeMockFetch([
        updatesResponse([
          { update_id: 400 }, // no message
          makeUpdate(401, 60, 'valid'),
        ]),
      ]);
      vi.stubGlobal('fetch', mockFetch);

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.start();
      await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 2000 });
      await connector.stop();
    });

    it('uses chat.id as senderId when from is absent', async () => {
      const received: InboundEvent[] = [];

      const mockFetch = makeMockFetch([
        updatesResponse([
          {
            update_id: 500,
            message: {
              message_id: 5000,
              chat: { id: 777, type: 'channel' },
              date: 1_700_000_000,
              text: 'channel post',
              // no from field
            },
          },
        ]),
      ]);
      vi.stubGlobal('fetch', mockFetch);

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.start();
      await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 2000 });
      await connector.stop();

      expect(received[0].senderId).toBe('777'); // same as chatId
    });
  });

  // -------------------------------------------------------------------------
  // Offset tracking
  // -------------------------------------------------------------------------

  describe('offset tracking', () => {
    it('advances the offset to update_id + 1 after each update', async () => {
      const receivedKeys: string[] = [];

      // First batch: two updates.
      // Second batch: one more update.
      const mockFetch = makeMockFetch([
        updatesResponse([makeUpdate(10, 1, 'a'), makeUpdate(11, 1, 'b')]),
        updatesResponse([makeUpdate(12, 1, 'c')]),
      ]);
      vi.stubGlobal('fetch', mockFetch);

      connector.onMessage(async (event) => {
        receivedKeys.push(event.idempotencyKey);
      });

      await connector.start();
      await vi.waitFor(() => expect(receivedKeys.length).toBe(3), { timeout: 2000 });
      await connector.stop();

      expect(receivedKeys).toEqual(['10', '11', '12']);
    });
  });

  // -------------------------------------------------------------------------
  // allowedChatIds filtering
  // -------------------------------------------------------------------------

  describe('allowedChatIds filtering', () => {
    it('drops messages from chats not in the allowlist', async () => {
      const received: InboundEvent[] = [];

      const restrictedConnector = new TelegramConnector(
        defaultConfig({ allowedChatIds: ['100'] }),
        'restricted-bot',
        silentLogger(),
      );

      const mockFetch = makeMockFetch([
        updatesResponse([
          makeUpdate(600, 100, 'allowed'),
          makeUpdate(601, 200, 'blocked'),
          makeUpdate(602, 100, 'also allowed'),
        ]),
      ]);
      vi.stubGlobal('fetch', mockFetch);

      restrictedConnector.onMessage(async (event) => {
        received.push(event);
      });

      await restrictedConnector.start();
      await vi.waitFor(() => expect(received.length).toBe(2), { timeout: 2000 });
      await restrictedConnector.stop();

      expect(received.every((e) => e.externalThreadId === '100')).toBe(true);
    });

    it('allows all chats when allowedChatIds is not set', async () => {
      const received: InboundEvent[] = [];

      const mockFetch = makeMockFetch([
        updatesResponse([
          makeUpdate(700, 111, 'any chat 1'),
          makeUpdate(701, 222, 'any chat 2'),
        ]),
      ]);
      vi.stubGlobal('fetch', mockFetch);

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.start();
      await vi.waitFor(() => expect(received.length).toBe(2), { timeout: 2000 });
      await connector.stop();

      expect(received).toHaveLength(2);
    });

    it('allows all chats when allowedChatIds is an empty array', async () => {
      const received: InboundEvent[] = [];

      const openConnector = new TelegramConnector(
        defaultConfig({ allowedChatIds: [] }),
        'open-bot',
        silentLogger(),
      );

      const mockFetch = makeMockFetch([
        updatesResponse([makeUpdate(800, 333, 'msg')]),
      ]);
      vi.stubGlobal('fetch', mockFetch);

      openConnector.onMessage(async (event) => {
        received.push(event);
      });

      await openConnector.start();
      await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 2000 });
      await openConnector.stop();
    });
  });

  // -------------------------------------------------------------------------
  // send()
  // -------------------------------------------------------------------------

  describe('send()', () => {
    it('returns Ok on a successful sendMessage call', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sendOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('1234', { body: 'Hello **world**' });

      expect(result.isOk()).toBe(true);
    });

    it('calls the Telegram sendMessage endpoint with the correct URL', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sendOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('1234', { body: 'Hello' });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('api.telegram.org');
      expect(calledUrl).toContain('sendMessage');
      expect(calledUrl).toContain('test-token');
    });

    it('posts JSON with chat_id, text, and parse_mode=MarkdownV2', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sendOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('9999', { body: 'plain text' });

      const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(callOpts.body as string) as Record<string, unknown>;
      expect(body.chat_id).toBe('9999');
      expect(body.parse_mode).toBe('MarkdownV2');
      expect(typeof body.text).toBe('string');
    });

    it('returns Err(ChannelError) when the API returns ok=false', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sendErrorResponse(403, 'Forbidden')),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('1234', { body: 'test' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('403');
      expect(result._unsafeUnwrapErr().message).toContain('Forbidden');
    });

    it('returns Err(ChannelError) on a network error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('network failure'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('1234', { body: 'test' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('network failure');
    });

    it('converts the Markdown body to Telegram MarkdownV2 before sending', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sendOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('1234', { body: '**bold**' });

      const body = JSON.parse(
        (mockFetch.mock.calls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      // **bold** should be converted to *bold* (Telegram bold)
      expect(body.text).toBe('*bold*');
    });
  });

  // -------------------------------------------------------------------------
  // format()
  // -------------------------------------------------------------------------

  describe('format()', () => {
    it('delegates to markdownToTelegram', () => {
      expect(connector.format('**hello**')).toBe('*hello*');
    });

    it('escapes plain text', () => {
      expect(connector.format('1+1=2')).toBe('1\\+1\\=2');
    });
  });

  // -------------------------------------------------------------------------
  // Error handling in poll loop
  // -------------------------------------------------------------------------

  describe('poll loop error handling', () => {
    it('continues polling after a getUpdates error', async () => {
      const received: InboundEvent[] = [];

      // getMe succeeds, then first getUpdates errors, then second succeeds,
      // then subsequent calls hang until aborted.
      let getUpdatesCallCount = 0;
      const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (typeof url === 'string' && url.endsWith('/getMe')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(GET_ME_RESPONSE),
          } as Response);
        }
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          return Promise.reject(new Error('network blip'));
        }
        if (getUpdatesCallCount === 2) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(updatesResponse([makeUpdate(900, 1, 'after error')])),
          } as unknown as Response);
        }
        // Hang until aborted.
        return new Promise((_resolve, reject) => {
          if (opts?.signal) {
            opts.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
            if (opts.signal.aborted) {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            }
          }
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      // Use a very short polling timeout + short backoff for the test.
      const fastConnector = new TelegramConnector(
        defaultConfig({ pollingTimeoutSec: 0 }),
        'fast-bot',
        silentLogger(),
      );

      fastConnector.onMessage(async (event) => {
        received.push(event);
      });

      await fastConnector.start();
      // The second call should succeed after backoff.
      await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 5000 });
      await fastConnector.stop();
    });

    it('continues polling after a handler error', async () => {
      const received: InboundEvent[] = [];
      let handlerCallCount = 0;

      const mockFetch = makeMockFetch([
        updatesResponse([makeUpdate(1000, 1, 'causes handler error')]),
        updatesResponse([makeUpdate(1001, 1, 'succeeds')]),
      ]);
      vi.stubGlobal('fetch', mockFetch);

      connector.onMessage(async (event) => {
        handlerCallCount++;
        if (event.idempotencyKey === '1000') {
          throw new Error('handler blew up');
        }
        received.push(event);
      });

      await connector.start();
      await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 2000 });
      await connector.stop();

      expect(handlerCallCount).toBeGreaterThanOrEqual(2);
      expect(received[0].idempotencyKey).toBe('1001');
    });

    it('stops cleanly when getUpdates returns an API error response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: false, error_code: 401, description: 'Unauthorized' }),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.start();
      // Wait a tick to let the loop hit the error.
      await new Promise((r) => setTimeout(r, 50));
      await connector.stop();
      // Should not throw.
    });
  });
});
