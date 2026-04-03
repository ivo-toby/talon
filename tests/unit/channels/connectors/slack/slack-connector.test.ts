/**
 * Unit tests for SlackConnector.
 *
 * All Slack Web API calls are intercepted via vi.stubGlobal('fetch', ...).
 * No real HTTP requests are made.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';
import { SlackConnector, encodeThreadId, decodeThreadId, extractMentionedUserIds } from '../../../../../src/channels/connectors/slack/slack-connector.js';
import type { SlackConfig } from '../../../../../src/channels/connectors/slack/slack-types.js';
import type { InboundEvent } from '../../../../../src/channels/channel-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function defaultConfig(overrides?: Partial<SlackConfig>): SlackConfig {
  return {
    botToken: 'xoxb-test-token',
    signingSecret: 'test-signing-secret',
    ...overrides,
  };
}

/** Build a minimal Slack event envelope with a text message. */
function makeSlackEvent(overrides?: {
  channelId?: string;
  userId?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  event_id?: string;
  client_msg_id?: string;
}): object {
  const {
    channelId = 'C01234567',
    userId = 'U01234567',
    text = 'Hello bot!',
    ts = '1700000000.123456',
    thread_ts,
    bot_id,
    event_id = 'Ev01234567',
    client_msg_id,
  } = overrides ?? {};

  return {
    event_id,
    event_time: 1700000000,
    type: 'event_callback',
    event: {
      type: 'message',
      channel: channelId,
      user: userId,
      text,
      ts,
      ...(thread_ts ? { thread_ts } : {}),
      ...(bot_id ? { bot_id } : {}),
      ...(client_msg_id ? { client_msg_id } : {}),
    },
  };
}

/** Build a successful chat.postMessage response. */
function postMessageOkResponse(): object {
  return {
    ok: true,
    channel: 'C01234567',
    ts: '1700000001.000000',
    message: {
      type: 'message',
      text: 'Hello',
      ts: '1700000001.000000',
    },
  };
}

/** Build a failed chat.postMessage response. */
function postMessageErrorResponse(error: string): object {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SlackConnector', () => {
  let connector: SlackConnector;

  beforeEach(() => {
    connector = new SlackConnector(defaultConfig(), 'test-slack', silentLogger());
  });

  afterEach(async () => {
    await connector.stop();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Constructor / metadata
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('exposes type = "slack"', () => {
      expect(connector.type).toBe('slack');
    });

    it('exposes the channel name', () => {
      expect(connector.name).toBe('test-slack');
    });
  });

  // -------------------------------------------------------------------------
  // Start / stop lifecycle
  // -------------------------------------------------------------------------

  describe('start/stop lifecycle', () => {
    it('starts and stops without error', async () => {
      await connector.start();
      await connector.stop();
    });

    it('start() is idempotent — calling it twice is a no-op', async () => {
      await connector.start();
      await connector.start(); // second call should be a no-op
      await connector.stop();
    });

    it('stop() is idempotent when not running', async () => {
      await connector.stop(); // should not throw
    });

    it('stop() after start() transitions to stopped state', async () => {
      await connector.start();
      await connector.stop();
      // Calling stop again should be a no-op.
      await connector.stop();
    });
  });

  // -------------------------------------------------------------------------
  // feedEvent — inbound message handling
  // -------------------------------------------------------------------------

  describe('feedEvent() — inbound message handling', () => {
    it('calls handler with a correctly normalised InboundEvent', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.feedEvent(makeSlackEvent({
        channelId: 'C01234567',
        userId: 'U09876543',
        text: 'Hello bot!',
        ts: '1700000000.123456',
        event_id: 'Ev01234567',
      }) as Parameters<typeof connector.feedEvent>[0]);

      expect(received).toHaveLength(1);
      const event = received[0];
      expect(event.channelType).toBe('slack');
      expect(event.channelName).toBe('test-slack');
      expect(event.externalThreadId).toBe('C01234567');
      expect(event.senderId).toBe('U09876543');
      expect(event.idempotencyKey).toBe('Ev01234567');
      expect(event.content).toBe('Hello bot!');
      expect(event.timestamp).toBe(1700000000123);
      expect(event.raw).toBeDefined();
    });

    it('uses channel:thread_ts as externalThreadId for threaded messages', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.feedEvent(makeSlackEvent({
        channelId: 'C01234567',
        ts: '1700000001.000000',
        thread_ts: '1700000000.000000',
      }) as Parameters<typeof connector.feedEvent>[0]);

      expect(received).toHaveLength(1);
      expect(received[0].externalThreadId).toBe('C01234567:1700000000.000000');
    });

    it('uses channel alone as externalThreadId for non-threaded messages', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.feedEvent(makeSlackEvent({
        channelId: 'C01234567',
        ts: '1700000000.000000',
      }) as Parameters<typeof connector.feedEvent>[0]);

      expect(received).toHaveLength(1);
      expect(received[0].externalThreadId).toBe('C01234567');
    });

    it('prefers event_id as idempotency key', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.feedEvent(makeSlackEvent({
        event_id: 'Ev_unique_123',
        client_msg_id: 'client-id-456',
      }) as Parameters<typeof connector.feedEvent>[0]);

      expect(received[0].idempotencyKey).toBe('Ev_unique_123');
    });

    it('falls back to client_msg_id when event_id is absent', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      const event = makeSlackEvent({
        client_msg_id: 'client-id-456',
      }) as Record<string, unknown>;
      delete event['event_id'];

      await connector.feedEvent(event as Parameters<typeof connector.feedEvent>[0]);

      expect(received[0].idempotencyKey).toBe('client-id-456');
    });

    it('falls back to channel:ts when neither event_id nor client_msg_id is present', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      const slackEvent = makeSlackEvent({
        channelId: 'C01234567',
        ts: '1700000000.123456',
      }) as Record<string, unknown>;
      delete slackEvent['event_id'];

      await connector.feedEvent(slackEvent as Parameters<typeof connector.feedEvent>[0]);

      expect(received[0].idempotencyKey).toBe('C01234567:1700000000.123456');
    });

    it('drops bot messages (messages with bot_id set)', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.feedEvent(makeSlackEvent({
        bot_id: 'B01234567',
        text: 'I am a bot',
      }) as Parameters<typeof connector.feedEvent>[0]);

      expect(received).toHaveLength(0);
    });

    it('drops events with no inner event object', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.feedEvent({} as Parameters<typeof connector.feedEvent>[0]);

      expect(received).toHaveLength(0);
    });

    it('drops events with no text', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      const event = makeSlackEvent({ text: 'hello' }) as Record<string, unknown>;
      const innerEvent = event['event'] as Record<string, unknown>;
      delete innerEvent['text'];

      await connector.feedEvent(event as Parameters<typeof connector.feedEvent>[0]);

      expect(received).toHaveLength(0);
    });

    it('uses channel as senderId when user is absent', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      const slackEvent = makeSlackEvent({ channelId: 'C01234567' }) as Record<string, unknown>;
      const innerEvent = slackEvent['event'] as Record<string, unknown>;
      delete innerEvent['user'];

      await connector.feedEvent(slackEvent as Parameters<typeof connector.feedEvent>[0]);

      expect(received[0].senderId).toBe('C01234567');
    });

    it('logs a warning when no handler is registered', async () => {
      // No handler registered — should not throw.
      await connector.feedEvent(makeSlackEvent() as Parameters<typeof connector.feedEvent>[0]);
    });

    it('continues processing after handler throws', async () => {
      let callCount = 0;

      connector.onMessage(async () => {
        callCount++;
        throw new Error('handler blew up');
      });

      // Should not throw even if handler throws.
      await connector.feedEvent(makeSlackEvent() as Parameters<typeof connector.feedEvent>[0]);

      expect(callCount).toBe(1);
    });

    it('parses Slack timestamp correctly to milliseconds', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.feedEvent(makeSlackEvent({
        ts: '1700000000.500000',
      }) as Parameters<typeof connector.feedEvent>[0]);

      // 1700000000.5 seconds = 1700000000500 ms
      expect(received[0].timestamp).toBe(1700000000500);
    });
  });

  // -------------------------------------------------------------------------
  // send()
  // -------------------------------------------------------------------------

  describe('send()', () => {
    it('returns Ok on a successful chat.postMessage call', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(postMessageOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('C01234567', { body: 'Hello **world**' });

      expect(result.isOk()).toBe(true);
    });

    it('calls the Slack chat.postMessage endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(postMessageOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('C01234567', { body: 'Hello' });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('slack.com/api/chat.postMessage');
    });

    it('sends Authorization Bearer token header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(postMessageOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('C01234567', { body: 'Hello' });

      const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
      const headers = callOpts.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer xoxb-test-token');
    });

    it('sends JSON with channel and text fields', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(postMessageOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('C01234567', { body: 'plain text' });

      const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(callOpts.body as string) as Record<string, unknown>;
      expect(body.channel).toBe('C01234567');
      expect(typeof body.text).toBe('string');
    });

    it('sends thread_ts when externalThreadId encodes a thread', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(postMessageOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('C01234567:1700000000.000000', { body: 'Reply in thread' });

      const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(callOpts.body as string) as Record<string, unknown>;
      expect(body.channel).toBe('C01234567');
      expect(body.thread_ts).toBe('1700000000.000000');
    });

    it('does not send thread_ts when externalThreadId is just a channel', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(postMessageOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('C01234567', { body: 'Top-level message' });

      const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(callOpts.body as string) as Record<string, unknown>;
      expect(body.thread_ts).toBeUndefined();
    });

    it('returns Err(ChannelError) when the API returns ok=false', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(postMessageErrorResponse('channel_not_found')),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('C_INVALID', { body: 'test' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('channel_not_found');
    });

    it('returns Err(ChannelError) on a network error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('network failure'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('C01234567', { body: 'test' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('network failure');
    });

    it('returns Err(ChannelError) when response JSON cannot be parsed', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('invalid json')),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('C01234567', { body: 'test' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('could not parse response');
    });

    it('converts the Markdown body to Slack mrkdwn before sending', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(postMessageOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('C01234567', { body: '**bold**' });

      const body = JSON.parse(
        (mockFetch.mock.calls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      // **bold** should be converted to *bold* (Slack mrkdwn bold)
      expect(body.text).toBe('*bold*');
    });
  });

  // -------------------------------------------------------------------------
  // format()
  // -------------------------------------------------------------------------

  describe('format()', () => {
    it('delegates to markdownToSlackMrkdwn', () => {
      expect(connector.format('**hello**')).toBe('*hello*');
    });

    it('converts italic markdown to Slack mrkdwn', () => {
      expect(connector.format('*italic*')).toBe('_italic_');
    });

    it('converts links to Slack <url|label> format', () => {
      expect(connector.format('[click](https://example.com)')).toBe('<https://example.com|click>');
    });
  });
});

// ---------------------------------------------------------------------------
// encodeThreadId / decodeThreadId utilities
// ---------------------------------------------------------------------------

describe('encodeThreadId', () => {
  it('returns just the channelId when no threadTs is provided', () => {
    expect(encodeThreadId('C01234567')).toBe('C01234567');
  });

  it('encodes channelId and threadTs separated by colon', () => {
    expect(encodeThreadId('C01234567', '1700000000.000000')).toBe(
      'C01234567:1700000000.000000',
    );
  });
});

describe('decodeThreadId', () => {
  it('returns channelId and undefined threadTs when no colon is present', () => {
    const result = decodeThreadId('C01234567');
    expect(result.channelId).toBe('C01234567');
    expect(result.threadTs).toBeUndefined();
  });

  it('splits on the first colon to extract channelId and threadTs', () => {
    const result = decodeThreadId('C01234567:1700000000.123456');
    expect(result.channelId).toBe('C01234567');
    expect(result.threadTs).toBe('1700000000.123456');
  });

  it('round-trips with encodeThreadId', () => {
    const channelId = 'C01234567';
    const threadTs = '1700000000.000000';
    const encoded = encodeThreadId(channelId, threadTs);
    const decoded = decodeThreadId(encoded);
    expect(decoded.channelId).toBe(channelId);
    expect(decoded.threadTs).toBe(threadTs);
  });
});

// ---------------------------------------------------------------------------
// extractMentionedUserIds
// ---------------------------------------------------------------------------

describe('extractMentionedUserIds', () => {
  it('returns empty set for text with no mentions', () => {
    expect(extractMentionedUserIds('hello world')).toEqual(new Set());
  });

  it('extracts a single mention', () => {
    expect(extractMentionedUserIds('hey <@U111> do this')).toEqual(new Set(['U111']));
  });

  it('extracts multiple mentions', () => {
    expect(extractMentionedUserIds('<@U111> and <@U222> check this')).toEqual(
      new Set(['U111', 'U222']),
    );
  });

  it('deduplicates repeated mentions', () => {
    expect(extractMentionedUserIds('<@U111> <@U111>')).toEqual(new Set(['U111']));
  });

  it('does not match channel or group mentions', () => {
    expect(extractMentionedUserIds('<!channel> <!here>')).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// @mention filtering in feedEvent
// ---------------------------------------------------------------------------

describe('SlackConnector — @mention filtering', () => {
  /**
   * Helper: create a connector with a pre-set bot user ID by reaching into
   * the private field. This avoids needing to mock auth.test for every test.
   */
  function connectorWithBotId(botUserId: string): SlackConnector {
    const c = new SlackConnector(defaultConfig(), 'test-mentions', silentLogger());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any)._botUserId = botUserId;
    return c;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('processes DMs regardless of mentions', async () => {
    const connector = connectorWithBotId('UBOT12345');
    const received: InboundEvent[] = [];
    connector.onMessage(async (event) => { received.push(event); });

    // DM channels start with 'D'.
    await connector.feedEvent(makeSlackEvent({
      channelId: 'D01234567',
      text: 'hey, no mention here',
    }) as Parameters<typeof connector.feedEvent>[0]);

    expect(received).toHaveLength(1);
  });

  it('processes channel messages that @mention this bot', async () => {
    const connector = connectorWithBotId('UBOT12345');
    const received: InboundEvent[] = [];
    connector.onMessage(async (event) => { received.push(event); });

    await connector.feedEvent(makeSlackEvent({
      channelId: 'C01234567',
      text: '<@UBOT12345> fix the build',
    }) as Parameters<typeof connector.feedEvent>[0]);

    expect(received).toHaveLength(1);
  });

  it('drops channel messages that @mention a different bot', async () => {
    const connector = connectorWithBotId('UBOT12345');
    const received: InboundEvent[] = [];
    connector.onMessage(async (event) => { received.push(event); });

    await connector.feedEvent(makeSlackEvent({
      channelId: 'C01234567',
      text: '<@UOTHER6789> fix the build',
    }) as Parameters<typeof connector.feedEvent>[0]);

    expect(received).toHaveLength(0);
  });

  it('drops channel messages with no @mentions at all', async () => {
    const connector = connectorWithBotId('UBOT12345');
    const received: InboundEvent[] = [];
    connector.onMessage(async (event) => { received.push(event); });

    await connector.feedEvent(makeSlackEvent({
      channelId: 'C01234567',
      text: 'hey everyone',
    }) as Parameters<typeof connector.feedEvent>[0]);

    expect(received).toHaveLength(0);
  });

  it('processes messages that mention multiple bots including this one', async () => {
    const connector = connectorWithBotId('UBOT12345');
    const received: InboundEvent[] = [];
    connector.onMessage(async (event) => { received.push(event); });

    await connector.feedEvent(makeSlackEvent({
      channelId: 'C01234567',
      text: '<@UBOT12345> and <@UOTHER6789> review this',
    }) as Parameters<typeof connector.feedEvent>[0]);

    expect(received).toHaveLength(1);
  });

  it('skips mention filtering when bot identity is unknown', async () => {
    // No bot user ID set — filtering disabled, all messages pass through.
    const connector = new SlackConnector(defaultConfig(), 'test-no-id', silentLogger());
    const received: InboundEvent[] = [];
    connector.onMessage(async (event) => { received.push(event); });

    await connector.feedEvent(makeSlackEvent({
      channelId: 'C01234567',
      text: 'no mentions, no bot id',
    }) as Parameters<typeof connector.feedEvent>[0]);

    expect(received).toHaveLength(1);
  });

  it('processes group messages (G prefix) with correct @mention', async () => {
    const connector = connectorWithBotId('UBOT12345');
    const received: InboundEvent[] = [];
    connector.onMessage(async (event) => { received.push(event); });

    await connector.feedEvent(makeSlackEvent({
      channelId: 'G01234567',
      text: '<@UBOT12345> check this private channel',
    }) as Parameters<typeof connector.feedEvent>[0]);

    expect(received).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// botUserId config validation
// ---------------------------------------------------------------------------

describe('SlackConnector — botUserId config validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses to start when configured botUserId does not match auth.test', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, user_id: 'UACTUAL999' }),
    } as unknown as Response);
    vi.stubGlobal('fetch', mockFetch);

    const connector = new SlackConnector(
      defaultConfig({ botUserId: 'UWRONG1234' }),
      'test-mismatch',
      silentLogger(),
    );
    connector.onMessage(async () => {});
    await connector.start();

    // Connector should not be running after mismatch — botUserId stays undefined.
    expect(connector.botUserId).toBeUndefined();

    await connector.stop();
  });

  it('starts successfully when configured botUserId matches auth.test', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, user_id: 'UBOT12345' }),
    } as unknown as Response);
    vi.stubGlobal('fetch', mockFetch);

    const connector = new SlackConnector(
      defaultConfig({ botUserId: 'UBOT12345' }),
      'test-match',
      silentLogger(),
    );
    const received: InboundEvent[] = [];
    connector.onMessage(async (event) => { received.push(event); });
    await connector.start();

    await connector.feedEvent(makeSlackEvent({
      channelId: 'D01234567',
      text: 'hello',
    }) as Parameters<typeof connector.feedEvent>[0]);
    expect(received).toHaveLength(1);

    await connector.stop();
  });

  it('falls back to configured botUserId when auth.test fails', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', mockFetch);

    const connector = new SlackConnector(
      defaultConfig({ botUserId: 'UBOT12345' }),
      'test-fallback',
      silentLogger(),
    );
    const received: InboundEvent[] = [];
    connector.onMessage(async (event) => { received.push(event); });
    await connector.start();

    // Should use the configured ID for mention filtering.
    await connector.feedEvent(makeSlackEvent({
      channelId: 'C01234567',
      text: '<@UBOT12345> do this',
    }) as Parameters<typeof connector.feedEvent>[0]);
    expect(received).toHaveLength(1);

    // Should drop messages mentioning a different bot.
    await connector.feedEvent(makeSlackEvent({
      channelId: 'C01234567',
      text: '<@UOTHER6789> do that',
    }) as Parameters<typeof connector.feedEvent>[0]);
    expect(received).toHaveLength(1); // still 1, not 2

    await connector.stop();
  });
});

// ---------------------------------------------------------------------------
// Socket Mode
// ---------------------------------------------------------------------------

describe('SlackConnector — Socket Mode', () => {
  function configWithAppToken(overrides?: Partial<SlackConfig>): SlackConfig {
    return {
      botToken: 'xoxb-test-token',
      signingSecret: 'test-signing-secret',
      appToken: 'xapp-test-app-token',
      ...overrides,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not call apps.connections.open when appToken is absent', async () => {
    const connector = new SlackConnector(defaultConfig(), 'test-no-socket', silentLogger());
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, user_id: 'UTEST00001' }),
    } as unknown as Response);
    vi.stubGlobal('fetch', mockFetch);

    await connector.start();
    // Give any async work a chance to run.
    await new Promise((r) => setTimeout(r, 50));
    await connector.stop();

    // Only auth.test should have been called, not apps.connections.open.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('auth.test');
  });

  it('calls apps.connections.open with the appToken on start', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('auth.test')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, user_id: 'UTEST00001' }),
        } as unknown as Response);
      }
      // Return a valid URL but fail the WebSocket connection so the loop exits.
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, url: 'wss://fake.slack.com/link' }),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', mockFetch);

    const connector = new SlackConnector(configWithAppToken(), 'test-socket', silentLogger());
    connector.onMessage(async () => {});
    await connector.start();

    // Let the async socketModeLoop call fetch.
    await new Promise((r) => setTimeout(r, 100));

    expect(mockFetch).toHaveBeenCalled();
    // First call is auth.test, second is apps.connections.open.
    const [url, opts] = mockFetch.mock.calls[1];
    expect(url).toContain('apps.connections.open');
    expect((opts?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer xapp-test-app-token',
    );

    await connector.stop();
  });

  it('retries with backoff when apps.connections.open fails', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: false, error: 'invalid_auth' }),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', mockFetch);

    const connector = new SlackConnector(configWithAppToken(), 'test-retry', silentLogger());
    connector.onMessage(async () => {});
    await connector.start();

    // Wait enough for at least 2 retry attempts (1s initial backoff).
    await new Promise((r) => setTimeout(r, 1500));
    await connector.stop();

    // Should have retried at least twice.
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('handleSocketModeMessage routes events_api to feedEvent', async () => {
    // Access the private method via prototype for unit testing.
    const connector = new SlackConnector(configWithAppToken(), 'test-route', silentLogger());
    const received: InboundEvent[] = [];
    connector.onMessage(async (event) => { received.push(event); });

    const fakeWs = {
      readyState: 1, // WebSocket.OPEN
      send: vi.fn(),
    };

    // Call the private method directly.
    const handleMsg = (connector as unknown as {
      handleSocketModeMessage: (ws: unknown, raw: Buffer) => Promise<void>;
    }).handleSocketModeMessage.bind(connector);

    const envelope = {
      envelope_id: 'eid-789',
      type: 'events_api',
      payload: makeSlackEvent({ text: 'socket mode message', channelId: 'C55555555' }),
    };

    await handleMsg(fakeWs, Buffer.from(JSON.stringify(envelope)));

    // Verify ack was sent.
    expect(fakeWs.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: 'eid-789' }));

    // Verify the message was routed to the handler.
    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('socket mode message');
    expect(received[0].channelType).toBe('slack');
  });

  it('handleSocketModeMessage ignores hello envelopes', async () => {
    const connector = new SlackConnector(configWithAppToken(), 'test-hello', silentLogger());
    const received: InboundEvent[] = [];
    connector.onMessage(async (event) => { received.push(event); });

    const handleMsg = (connector as unknown as {
      handleSocketModeMessage: (ws: unknown, raw: Buffer) => Promise<void>;
    }).handleSocketModeMessage.bind(connector);

    await handleMsg({ readyState: 1, send: vi.fn() }, Buffer.from(JSON.stringify({ type: 'hello' })));

    expect(received).toHaveLength(0);
  });

  it('handleSocketModeMessage closes ws on disconnect envelope', async () => {
    const connector = new SlackConnector(configWithAppToken(), 'test-disc', silentLogger());

    const fakeWs = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
    };

    const handleMsg = (connector as unknown as {
      handleSocketModeMessage: (ws: unknown, raw: Buffer) => Promise<void>;
    }).handleSocketModeMessage.bind(connector);

    await handleMsg(fakeWs, Buffer.from(JSON.stringify({ type: 'disconnect' })));

    expect(fakeWs.close).toHaveBeenCalledWith(1000, 'server requested disconnect');
  });

  it('handleSocketModeMessage skips unparseable messages', async () => {
    const connector = new SlackConnector(configWithAppToken(), 'test-bad', silentLogger());
    const received: InboundEvent[] = [];
    connector.onMessage(async (event) => { received.push(event); });

    const handleMsg = (connector as unknown as {
      handleSocketModeMessage: (ws: unknown, raw: Buffer) => Promise<void>;
    }).handleSocketModeMessage.bind(connector);

    // Send garbage that won't parse as JSON.
    await handleMsg({ readyState: 1, send: vi.fn() }, Buffer.from('not json'));

    expect(received).toHaveLength(0);
  });
});
