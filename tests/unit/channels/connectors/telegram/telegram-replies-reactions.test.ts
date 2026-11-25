/**
 * Unit tests for Telegram native replies, emoji reactions and topic threads.
 *
 * Covers the pure helpers (`telegram-threads.ts`, `telegram-reactions.ts`) and
 * the connector's inbound reply/reaction normalisation, outbound `send()`
 * reply/topic payloads, `react()`, `getUpdates` and `sendTyping`.
 *
 * All Telegram Bot API calls are intercepted via vi.stubGlobal('fetch', ...).
 * No real HTTP requests are made.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import pino from 'pino';
import { TelegramConnector } from '../../../../../src/channels/connectors/telegram/telegram-connector.js';
import type {
  TelegramConfig,
  TelegramMessage,
  TelegramReactionType,
} from '../../../../../src/channels/connectors/telegram/telegram-types.js';
import {
  isTelegramGroupChatId,
  parseTelegramThreadId,
  telegramThreadIdForMessage,
} from '../../../../../src/channels/connectors/telegram/telegram-threads.js';
import {
  TELEGRAM_REACTION_EMOJI,
  addedReactionEmoji,
  normalizeTelegramReactionEmoji,
} from '../../../../../src/channels/connectors/telegram/telegram-reactions.js';
import type { InboundEvent } from '../../../../../src/channels/channel-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The bot identity every getMe call resolves to. */
const BOT_ID = 12345;
const BOT_USERNAME = 'test_bot';

const GET_ME_RESPONSE = {
  ok: true,
  result: { id: BOT_ID, is_bot: true, first_name: 'TestBot', username: BOT_USERNAME },
};

const DM_CHAT_ID = 555;
const GROUP_CHAT_ID = -1001234567890;
const USER_ID = 999;
const OTHER_USER_ID = 777;

/** Emoji literals written as escapes so the exact code points are explicit. */
const THUMBS_UP = '\u{1F44D}';
const THUMBS_UP_MEDIUM_SKIN = '\u{1F44D}\u{1F3FD}';
const HEART = '❤';
const HEART_WITH_VS16 = '❤️';
const FIRE = '\u{1F525}';
const CHECK_MARK = '✅';

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

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * Build a fake fetch function that returns the given JSON bodies in order.
 * Calls to the `getMe` endpoint always return the standard bot identity
 * without consuming from the queue. Once the queue is exhausted, calls hang
 * until their AbortSignal fires (what an idle long poll looks like).
 */
function makeMockFetch(responses: Array<unknown>): ReturnType<typeof vi.fn> {
  let callIndex = 0;
  return vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    if (typeof url === 'string' && url.endsWith('/getMe')) {
      return Promise.resolve(jsonResponse(GET_ME_RESPONSE));
    }

    const idx = callIndex++;
    if (idx < responses.length) {
      return Promise.resolve(jsonResponse(responses[idx]));
    }
    return new Promise((_resolve, reject) => {
      const signal = opts?.signal;
      if (!signal) return;
      const abort = (): void =>
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort);
    });
  });
}

/** A fetch mock that answers every call with the same JSON body. */
function stubFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const mockFetch = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(body, status)));
  vi.stubGlobal('fetch', mockFetch);
  return mockFetch;
}

/** A successful sendMessage response carrying the given message_id. */
function sendOkResponse(messageId = 4242): object {
  return {
    ok: true,
    result: {
      message_id: messageId,
      chat: { id: 1234, type: 'private' },
      date: 1_700_000_000,
      text: 'hello',
    },
  };
}

/** The JSON body of the n-th fetch call. */
function requestBody(mockFetch: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const init = mockFetch.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

/** The URL of the n-th fetch call. */
function requestUrl(mockFetch: ReturnType<typeof vi.fn>, callIndex = 0): string {
  return mockFetch.mock.calls[callIndex][0] as string;
}

/** A text message in a private chat. */
function dmMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1010,
    from: { id: USER_ID, first_name: 'Test', username: 'testuser' },
    chat: { id: DM_CHAT_ID, type: 'private' },
    date: 1_700_000_000,
    text: 'hello bot',
    ...overrides,
  };
}

/** A text message in a supergroup. */
function groupMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 2020,
    from: { id: USER_ID, first_name: 'Test', username: 'testuser' },
    chat: { id: GROUP_CHAT_ID, type: 'supergroup', title: 'Team' },
    date: 1_700_000_000,
    text: 'hello group',
    ...overrides,
  };
}

/** A message the bot itself sent earlier (what a user replies to). */
function botMessage(chatId: number, overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 900,
    from: { id: BOT_ID, is_bot: true, first_name: 'TestBot', username: BOT_USERNAME },
    chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' },
    date: 1_699_999_000,
    text: 'the bot said this',
    ...overrides,
  };
}

/** A message another human sent earlier. */
function otherUserMessage(
  chatId: number,
  overrides: Partial<TelegramMessage> = {},
): TelegramMessage {
  return {
    message_id: 901,
    from: { id: OTHER_USER_ID, first_name: 'Other', username: 'otheruser' },
    chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' },
    date: 1_699_999_000,
    text: 'someone else said this',
    ...overrides,
  };
}

function messageUpdate(updateId: number, message: TelegramMessage): object {
  return { update_id: updateId, message };
}

interface ReactionUpdateOptions {
  chatId?: number;
  chatType?: string;
  messageId?: number;
  user?: { id: number; is_bot?: boolean; first_name: string };
  oldReaction?: TelegramReactionType[];
  newReaction?: TelegramReactionType[];
}

/** A `message_reaction` update; defaults to a user adding a thumbs-up in a DM. */
function reactionUpdate(updateId: number, opts: ReactionUpdateOptions = {}): object {
  return {
    update_id: updateId,
    message_reaction: {
      chat: { id: opts.chatId ?? DM_CHAT_ID, type: opts.chatType ?? 'private' },
      message_id: opts.messageId ?? 900,
      user: opts.user ?? { id: USER_ID, first_name: 'Test' },
      date: 1_700_000_000,
      old_reaction: opts.oldReaction ?? [],
      new_reaction: opts.newReaction ?? [{ type: 'emoji', emoji: THUMBS_UP }],
    },
  };
}

// ---------------------------------------------------------------------------
// Connector lifecycle shared by all connector tests
// ---------------------------------------------------------------------------

const connectors: TelegramConnector[] = [];

function makeConnector(overrides?: Partial<TelegramConfig>): TelegramConnector {
  const connector = new TelegramConnector(defaultConfig(overrides), 'test-bot', silentLogger());
  connectors.push(connector);
  return connector;
}

/** Collect every event the connector hands to its onMessage handler. */
function collectEvents(connector: TelegramConnector): InboundEvent[] {
  const received: InboundEvent[] = [];
  connector.onMessage(async (event) => {
    received.push(event);
  });
  return received;
}

/**
 * Start the connector against a fetch mock that answers getMe and then leaves
 * the long poll hanging, so the bot's own identity (id + username) resolves
 * exactly as in production. The connector is stopped in afterEach.
 */
async function startWithIdentity(connector: TelegramConnector): Promise<ReturnType<typeof vi.fn>> {
  const mockFetch = makeMockFetch([]);
  vi.stubGlobal('fetch', mockFetch);
  await connector.start();
  expect(connector.botUserId).toBe(String(BOT_ID));
  return mockFetch;
}

afterEach(async () => {
  // Stop first so any hanging long poll is aborted before fetch is restored.
  for (const connector of connectors.splice(0)) {
    await connector.stop();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure helpers: thread addressing
// ---------------------------------------------------------------------------

describe('telegram-threads', () => {
  describe('parseTelegramThreadId', () => {
    it('returns a plain positive chat id as chatId only', () => {
      expect(parseTelegramThreadId('12345')).toStrictEqual({ chatId: '12345' });
    });

    it('returns a plain negative (supergroup) chat id as chatId only', () => {
      expect(parseTelegramThreadId('-1001234567890')).toStrictEqual({ chatId: '-1001234567890' });
    });

    it('splits "<chat_id>:<topic_id>" into chatId and a numeric topicId', () => {
      expect(parseTelegramThreadId('-1001234567890:42')).toStrictEqual({
        chatId: '-1001234567890',
        topicId: 42,
      });
    });

    it('splits a positive chat id with a topic', () => {
      expect(parseTelegramThreadId('12345:3')).toStrictEqual({ chatId: '12345', topicId: 3 });
    });

    it('splits "@channelname:<topic_id>"', () => {
      expect(parseTelegramThreadId('@channelname:7')).toStrictEqual({
        chatId: '@channelname',
        topicId: 7,
      });
    });

    it('returns an @username without a topic whole', () => {
      expect(parseTelegramThreadId('@channelname')).toStrictEqual({ chatId: '@channelname' });
    });

    it.each([
      ['a WhatsApp JID', '491701234567@s.whatsapp.net'],
      ['a WhatsApp device JID containing a colon', '491701234567:12@s.whatsapp.net'],
      ['a non-numeric pair', 'abc:def'],
      ['a non-numeric topic', '-100123:abc'],
      ['a negative topic', '-100123:-4'],
      ['a trailing colon', '-100123:'],
      ['three segments', '-100123:4:5'],
    ])('returns %s whole as chatId', (_label, value) => {
      expect(parseTelegramThreadId(value)).toStrictEqual({ chatId: value });
    });
  });

  describe('telegramThreadIdForMessage', () => {
    it('keys a topic message as "<chat>:<topic>"', () => {
      const message = groupMessage({ is_topic_message: true, message_thread_id: 42 });
      expect(telegramThreadIdForMessage(message)).toBe(`${GROUP_CHAT_ID}:42`);
    });

    it('keys a message with message_thread_id but no is_topic_message by chat only', () => {
      // A plain reply thread in a non-forum group also carries message_thread_id.
      const message = groupMessage({ message_thread_id: 42 });
      expect(telegramThreadIdForMessage(message)).toBe(String(GROUP_CHAT_ID));
    });

    it('keys a message with is_topic_message false by chat only', () => {
      const message = groupMessage({ is_topic_message: false, message_thread_id: 42 });
      expect(telegramThreadIdForMessage(message)).toBe(String(GROUP_CHAT_ID));
    });

    it('keys an ordinary message by chat only', () => {
      expect(telegramThreadIdForMessage(dmMessage())).toBe(String(DM_CHAT_ID));
    });

    it('round-trips through parseTelegramThreadId', () => {
      const message = groupMessage({ is_topic_message: true, message_thread_id: 42 });
      expect(parseTelegramThreadId(telegramThreadIdForMessage(message))).toStrictEqual({
        chatId: String(GROUP_CHAT_ID),
        topicId: 42,
      });
    });
  });

  describe('isTelegramGroupChatId', () => {
    it('is true for negative (group and supergroup) chat ids', () => {
      expect(isTelegramGroupChatId('-1001234567890')).toBe(true);
      expect(isTelegramGroupChatId('-4567')).toBe(true);
    });

    it('is false for positive (private) chat ids and usernames', () => {
      expect(isTelegramGroupChatId('12345')).toBe(false);
      expect(isTelegramGroupChatId('@channelname')).toBe(false);
      expect(isTelegramGroupChatId('')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Pure helpers: reactions
// ---------------------------------------------------------------------------

describe('telegram-reactions', () => {
  describe('normalizeTelegramReactionEmoji', () => {
    it('passes an allowed emoji through unchanged', () => {
      expect(normalizeTelegramReactionEmoji(THUMBS_UP)).toBe(THUMBS_UP);
    });

    it('strips the emoji presentation selector (U+FE0F) from a heart', () => {
      expect(HEART_WITH_VS16).not.toBe(HEART);
      expect(normalizeTelegramReactionEmoji(HEART_WITH_VS16)).toBe(HEART);
    });

    it('strips a skin-tone modifier', () => {
      expect(normalizeTelegramReactionEmoji(THUMBS_UP_MEDIUM_SKIN)).toBe(THUMBS_UP);
    });

    it('trims surrounding whitespace', () => {
      expect(normalizeTelegramReactionEmoji(` ${THUMBS_UP} `)).toBe(THUMBS_UP);
    });

    it('returns null for an emoji outside the allowed set', () => {
      expect(normalizeTelegramReactionEmoji(CHECK_MARK)).toBeNull();
    });

    it('returns null for plain text and the empty string', () => {
      expect(normalizeTelegramReactionEmoji('ok')).toBeNull();
      expect(normalizeTelegramReactionEmoji('')).toBeNull();
    });

    it('exposes the allowed set with the bare heart and thumbs-up but not the check mark', () => {
      expect(TELEGRAM_REACTION_EMOJI).toContain(HEART);
      expect(TELEGRAM_REACTION_EMOJI).toContain(THUMBS_UP);
      expect(TELEGRAM_REACTION_EMOJI).not.toContain(CHECK_MARK);
    });
  });

  describe('addedReactionEmoji', () => {
    it('returns an emoji present in the new list but not in the old one', () => {
      expect(addedReactionEmoji([], [{ type: 'emoji', emoji: THUMBS_UP }])).toEqual([THUMBS_UP]);
    });

    it('returns only the newly added emoji when the user already had one', () => {
      expect(
        addedReactionEmoji(
          [{ type: 'emoji', emoji: THUMBS_UP }],
          [
            { type: 'emoji', emoji: THUMBS_UP },
            { type: 'emoji', emoji: FIRE },
          ],
        ),
      ).toEqual([FIRE]);
    });

    it('returns the new emoji when one reaction replaces another', () => {
      expect(
        addedReactionEmoji([{ type: 'emoji', emoji: THUMBS_UP }], [{ type: 'emoji', emoji: FIRE }]),
      ).toEqual([FIRE]);
    });

    it('returns [] for a pure removal', () => {
      expect(addedReactionEmoji([{ type: 'emoji', emoji: THUMBS_UP }], [])).toEqual([]);
    });

    it('returns [] when nothing changed', () => {
      expect(
        addedReactionEmoji(
          [{ type: 'emoji', emoji: THUMBS_UP }],
          [{ type: 'emoji', emoji: THUMBS_UP }],
        ),
      ).toEqual([]);
    });

    it('treats undefined lists as empty', () => {
      expect(addedReactionEmoji(undefined, undefined)).toEqual([]);
      expect(addedReactionEmoji(undefined, [{ type: 'emoji', emoji: THUMBS_UP }])).toEqual([
        THUMBS_UP,
      ]);
    });

    it('skips custom_emoji and paid reactions', () => {
      const custom = { type: 'custom_emoji', custom_emoji_id: '5368324170671202286' };
      expect(
        addedReactionEmoji(
          [],
          [custom as TelegramReactionType, { type: 'paid' }, { type: 'emoji', emoji: FIRE }],
        ),
      ).toEqual([FIRE]);
      expect(addedReactionEmoji([], [custom as TelegramReactionType, { type: 'paid' }])).toEqual(
        [],
      );
    });

    it('skips an emoji-typed reaction with a missing or empty emoji', () => {
      expect(addedReactionEmoji([], [{ type: 'emoji' }, { type: 'emoji', emoji: '' }])).toEqual([]);
    });

    it('collapses duplicates in the new list', () => {
      expect(
        addedReactionEmoji(
          [],
          [
            { type: 'emoji', emoji: THUMBS_UP },
            { type: 'emoji', emoji: THUMBS_UP },
            { type: 'emoji', emoji: FIRE },
          ],
        ),
      ).toEqual([THUMBS_UP, FIRE]);
    });
  });
});

// ---------------------------------------------------------------------------
// Inbound messages
// ---------------------------------------------------------------------------

describe('TelegramConnector inbound replies and topics', () => {
  it('carries the Telegram message_id as externalMessageId', async () => {
    const connector = makeConnector();
    const received = collectEvents(connector);

    await connector.handleUpdatePublic(messageUpdate(101, dmMessage({ message_id: 3131 })));

    expect(received).toHaveLength(1);
    expect(received[0].externalMessageId).toBe('3131');
    // Distinct from the idempotency key, which stays the update_id.
    expect(received[0].idempotencyKey).toBe('101');
    expect(received[0].externalThreadId).toBe(String(DM_CHAT_ID));
    expect(received[0].content).toBe('hello bot');
  });

  it('has no replyTo when the message replies to nothing', async () => {
    const connector = makeConnector();
    const received = collectEvents(connector);

    await connector.handleUpdatePublic(messageUpdate(102, dmMessage()));

    expect(received).toHaveLength(1);
    expect('replyTo' in received[0]).toBe(false);
  });

  it('marks a reply to the bot own message as fromSelf', async () => {
    const connector = makeConnector();
    const received = collectEvents(connector);
    await startWithIdentity(connector);

    await connector.handleUpdatePublic(
      messageUpdate(
        103,
        dmMessage({ text: 'what do you mean?', reply_to_message: botMessage(DM_CHAT_ID) }),
      ),
    );

    expect(received).toHaveLength(1);
    expect(received[0].replyTo).toEqual({
      externalMessageId: '900',
      senderId: String(BOT_ID),
      fromSelf: true,
      text: 'the bot said this',
    });
    expect(received[0].content).toBe('what do you mean?');
  });

  it('marks a reply to another user message as not fromSelf', async () => {
    const connector = makeConnector();
    const received = collectEvents(connector);
    await startWithIdentity(connector);

    await connector.handleUpdatePublic(
      messageUpdate(104, dmMessage({ reply_to_message: otherUserMessage(DM_CHAT_ID) })),
    );

    expect(received).toHaveLength(1);
    expect(received[0].replyTo).toEqual({
      externalMessageId: '901',
      senderId: String(OTHER_USER_ID),
      fromSelf: false,
      text: 'someone else said this',
    });
  });

  it('does not claim fromSelf before the bot identity is resolved by getMe', async () => {
    // start() was never called, so the connector does not know its own id.
    const connector = makeConnector();
    const received = collectEvents(connector);
    expect(connector.botUserId).toBeUndefined();

    await connector.handleUpdatePublic(
      messageUpdate(105, dmMessage({ reply_to_message: botMessage(DM_CHAT_ID) })),
    );

    expect(received).toHaveLength(1);
    expect(received[0].replyTo?.senderId).toBe(String(BOT_ID));
    expect(received[0].replyTo?.fromSelf).toBe(false);
  });

  it('reports fromSelf false and no senderId when the replied message has no sender', async () => {
    const connector = makeConnector();
    const received = collectEvents(connector);
    await startWithIdentity(connector);

    const replied = otherUserMessage(DM_CHAT_ID);
    delete replied.from;
    await connector.handleUpdatePublic(
      messageUpdate(106, dmMessage({ reply_to_message: replied })),
    );

    expect(received).toHaveLength(1);
    expect(received[0].replyTo).toEqual({
      externalMessageId: '901',
      fromSelf: false,
      text: 'someone else said this',
    });
  });

  it('prefers the quoted selection over the replied message text', async () => {
    const connector = makeConnector();
    const received = collectEvents(connector);
    await startWithIdentity(connector);

    await connector.handleUpdatePublic(
      messageUpdate(
        107,
        dmMessage({
          reply_to_message: botMessage(DM_CHAT_ID, { text: 'a long answer with several points' }),
          quote: { text: 'several points' },
        }),
      ),
    );

    expect(received).toHaveLength(1);
    expect(received[0].replyTo?.text).toBe('several points');
    expect(received[0].replyTo?.externalMessageId).toBe('900');
  });

  it('falls back to the replied message caption when it has no text', async () => {
    const connector = makeConnector();
    const received = collectEvents(connector);
    await startWithIdentity(connector);

    const replied = otherUserMessage(DM_CHAT_ID, { caption: 'photo caption' });
    delete replied.text;
    await connector.handleUpdatePublic(
      messageUpdate(108, dmMessage({ reply_to_message: replied })),
    );

    expect(received).toHaveLength(1);
    expect(received[0].replyTo?.text).toBe('photo caption');
  });

  it('omits replyTo.text when the replied message has neither text nor caption', async () => {
    const connector = makeConnector();
    const received = collectEvents(connector);
    await startWithIdentity(connector);

    const replied = otherUserMessage(DM_CHAT_ID);
    delete replied.text;
    await connector.handleUpdatePublic(
      messageUpdate(109, dmMessage({ reply_to_message: replied })),
    );

    expect(received).toHaveLength(1);
    expect(received[0].replyTo).toEqual({
      externalMessageId: '901',
      senderId: String(OTHER_USER_ID),
      fromSelf: false,
    });
  });

  describe('topics', () => {
    /** A topic message in a supergroup that @mentions the bot so it passes the group gate. */
    function topicMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
      return groupMessage({
        text: `@${BOT_USERNAME} hello topic`,
        entities: [{ type: 'mention', offset: 0, length: BOT_USERNAME.length + 1 }],
        is_topic_message: true,
        message_thread_id: 42,
        ...overrides,
      });
    }

    it('has no replyTo when reply_to_message is the topic root by id', async () => {
      const connector = makeConnector({ allowGroupChats: true });
      const received = collectEvents(connector);
      await startWithIdentity(connector);

      await connector.handleUpdatePublic(
        messageUpdate(
          120,
          topicMessage({
            // No forum_topic_created here: the id match alone must be enough.
            reply_to_message: otherUserMessage(GROUP_CHAT_ID, { message_id: 42 }),
          }),
        ),
      );

      expect(received).toHaveLength(1);
      expect('replyTo' in received[0]).toBe(false);
      expect(received[0].externalThreadId).toBe(`${GROUP_CHAT_ID}:42`);
      expect(received[0].content).toBe('hello topic');
    });

    it('has no replyTo when reply_to_message is the forum_topic_created service message', async () => {
      const connector = makeConnector({ allowGroupChats: true });
      const received = collectEvents(connector);
      await startWithIdentity(connector);

      const topicRoot = otherUserMessage(GROUP_CHAT_ID, {
        // A different id than message_thread_id: forum_topic_created alone must be enough.
        message_id: 41,
        forum_topic_created: { name: 'Releases', icon_color: 7322096 },
      });
      delete topicRoot.text;
      await connector.handleUpdatePublic(
        messageUpdate(121, topicMessage({ reply_to_message: topicRoot })),
      );

      expect(received).toHaveLength(1);
      expect('replyTo' in received[0]).toBe(false);
      expect(received[0].externalThreadId).toBe(`${GROUP_CHAT_ID}:42`);
    });

    it('keeps replyTo for a real reply to another message inside the topic', async () => {
      const connector = makeConnector({ allowGroupChats: true });
      const received = collectEvents(connector);
      await startWithIdentity(connector);

      await connector.handleUpdatePublic(
        messageUpdate(
          122,
          topicMessage({
            reply_to_message: otherUserMessage(GROUP_CHAT_ID, {
              message_id: 57,
              is_topic_message: true,
              message_thread_id: 42,
            }),
          }),
        ),
      );

      expect(received).toHaveLength(1);
      expect(received[0].replyTo).toEqual({
        externalMessageId: '57',
        senderId: String(OTHER_USER_ID),
        fromSelf: false,
        text: 'someone else said this',
      });
      expect(received[0].externalThreadId).toBe(`${GROUP_CHAT_ID}:42`);
    });

    it('keeps a non-topic message with a message_thread_id in the chat thread', async () => {
      const connector = makeConnector({ allowGroupChats: true });
      const received = collectEvents(connector);
      await startWithIdentity(connector);

      // A reply chain in a non-forum group: message_thread_id is the replied
      // message id, but is_topic_message is absent.
      await connector.handleUpdatePublic(
        messageUpdate(
          123,
          topicMessage({
            is_topic_message: undefined,
            message_thread_id: 57,
            reply_to_message: otherUserMessage(GROUP_CHAT_ID, { message_id: 57 }),
          }),
        ),
      );

      expect(received).toHaveLength(1);
      expect(received[0].externalThreadId).toBe(String(GROUP_CHAT_ID));
      expect(received[0].replyTo?.externalMessageId).toBe('57');
    });
  });

  describe('group reply gate', () => {
    it('delivers a reply to the bot own message with the full text, without a mention', async () => {
      const connector = makeConnector({ allowGroupChats: true });
      const received = collectEvents(connector);
      await startWithIdentity(connector);

      await connector.handleUpdatePublic(
        messageUpdate(
          130,
          groupMessage({
            text: 'and what about tomorrow?',
            reply_to_message: botMessage(GROUP_CHAT_ID),
          }),
        ),
      );

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('and what about tomorrow?');
      expect(received[0].externalThreadId).toBe(String(GROUP_CHAT_ID));
      expect(received[0].externalMessageId).toBe('2020');
      expect(received[0].replyTo).toEqual({
        externalMessageId: '900',
        senderId: String(BOT_ID),
        fromSelf: true,
        text: 'the bot said this',
      });
    });

    it('drops a reply to someone else message that has no mention or trigger word', async () => {
      const connector = makeConnector({ allowGroupChats: true });
      const received = collectEvents(connector);
      await startWithIdentity(connector);

      await connector.handleUpdatePublic(
        messageUpdate(
          131,
          groupMessage({
            text: 'and what about tomorrow?',
            reply_to_message: otherUserMessage(GROUP_CHAT_ID),
          }),
        ),
      );

      expect(received).toHaveLength(0);
    });

    it('drops a plain group message with no reply, mention or trigger word', async () => {
      const connector = makeConnector({ allowGroupChats: true });
      const received = collectEvents(connector);
      await startWithIdentity(connector);

      await connector.handleUpdatePublic(messageUpdate(132, groupMessage()));

      expect(received).toHaveLength(0);
    });

    it('drops a reply to the bot when group chats are not enabled', async () => {
      const connector = makeConnector();
      const received = collectEvents(connector);
      await startWithIdentity(connector);

      await connector.handleUpdatePublic(
        messageUpdate(133, groupMessage({ reply_to_message: botMessage(GROUP_CHAT_ID) })),
      );

      expect(received).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Inbound reactions
// ---------------------------------------------------------------------------

describe('TelegramConnector inbound reactions', () => {
  it('turns an added emoji into a reaction event', async () => {
    const connector = makeConnector();
    const received = collectEvents(connector);
    const update = reactionUpdate(201, { messageId: 900 });

    await connector.handleUpdatePublic(update);

    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event.reaction).toEqual({ targetMessageId: '900', emoji: THUMBS_UP });
    expect(event.content).toBe('');
    expect(event.externalThreadId).toBe(String(DM_CHAT_ID));
    expect(event.idempotencyKey).toBe('201');
    expect(event.senderId).toBe(String(USER_ID));
    expect('externalMessageId' in event).toBe(false);
    expect('replyTo' in event).toBe(false);
    expect(event.channelType).toBe('telegram');
    expect(event.channelName).toBe('test-bot');
    expect(event.timestamp).toBe(1_700_000_000_000);
    expect(event.raw).toBe(update);
  });

  it('reports only the emoji that was added on top of an existing reaction', async () => {
    const connector = makeConnector();
    const received = collectEvents(connector);

    await connector.handleUpdatePublic(
      reactionUpdate(202, {
        oldReaction: [{ type: 'emoji', emoji: THUMBS_UP }],
        newReaction: [
          { type: 'emoji', emoji: THUMBS_UP },
          { type: 'emoji', emoji: FIRE },
        ],
      }),
    );

    expect(received).toHaveLength(1);
    expect(received[0].reaction).toEqual({ targetMessageId: '900', emoji: FIRE });
  });

  it('forwards a reaction from a group chat when allowGroupChats is enabled', async () => {
    const connector = makeConnector({ allowGroupChats: true });
    const received = collectEvents(connector);

    await connector.handleUpdatePublic(
      reactionUpdate(203, { chatId: GROUP_CHAT_ID, chatType: 'supergroup', messageId: 77 }),
    );

    expect(received).toHaveLength(1);
    // The update does not name the topic, so the event carries the bare chat id.
    expect(received[0].externalThreadId).toBe(String(GROUP_CHAT_ID));
    expect(received[0].reaction).toEqual({ targetMessageId: '77', emoji: THUMBS_UP });
  });

  it('forwards a reaction from a chat listed in allowedChatIds', async () => {
    const connector = makeConnector({ allowedChatIds: [String(DM_CHAT_ID)] });
    const received = collectEvents(connector);

    await connector.handleUpdatePublic(reactionUpdate(204));

    expect(received).toHaveLength(1);
  });

  describe('dropped', () => {
    it('when inboundReactions is false', async () => {
      const connector = makeConnector({ inboundReactions: false });
      const received = collectEvents(connector);

      await connector.handleUpdatePublic(reactionUpdate(210));

      expect(received).toHaveLength(0);
    });

    it('when the reaction was removed (new_reaction empty)', async () => {
      const connector = makeConnector();
      const received = collectEvents(connector);

      await connector.handleUpdatePublic(
        reactionUpdate(211, {
          oldReaction: [{ type: 'emoji', emoji: THUMBS_UP }],
          newReaction: [],
        }),
      );

      expect(received).toHaveLength(0);
    });

    it('when only a custom_emoji reaction was added', async () => {
      const connector = makeConnector();
      const received = collectEvents(connector);

      await connector.handleUpdatePublic(
        reactionUpdate(212, {
          newReaction: [
            {
              type: 'custom_emoji',
              custom_emoji_id: '5368324170671202286',
            } as TelegramReactionType,
          ],
        }),
      );

      expect(received).toHaveLength(0);
    });

    it('when the reacting user is a bot', async () => {
      const connector = makeConnector();
      const received = collectEvents(connector);

      await connector.handleUpdatePublic(
        reactionUpdate(213, { user: { id: 4321, is_bot: true, first_name: 'OtherBot' } }),
      );

      expect(received).toHaveLength(0);
    });

    it('when it comes from a group chat and allowGroupChats is not enabled', async () => {
      const connector = makeConnector();
      const received = collectEvents(connector);

      await connector.handleUpdatePublic(
        reactionUpdate(214, { chatId: GROUP_CHAT_ID, chatType: 'supergroup' }),
      );
      await connector.handleUpdatePublic(reactionUpdate(215, { chatId: -4567, chatType: 'group' }));

      expect(received).toHaveLength(0);
    });

    it('when the chat is not in allowedChatIds', async () => {
      const connector = makeConnector({ allowedChatIds: ['111'] });
      const received = collectEvents(connector);

      await connector.handleUpdatePublic(reactionUpdate(216));

      expect(received).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Outbound send()
// ---------------------------------------------------------------------------

describe('TelegramConnector send() replies and topics', () => {
  const DM_THREAD = '1234';
  const GROUP_THREAD = '-100123';

  it('returns the sent message_id as the receipt', async () => {
    const connector = makeConnector();
    stubFetchJson(sendOkResponse(4242));

    const result = await connector.send(DM_THREAD, { body: 'Hello' });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ externalMessageId: '4242' });
  });

  it('sends exactly chat_id, text and parse_mode when there is no reply target and no topic', async () => {
    const connector = makeConnector();
    const mockFetch = stubFetchJson(sendOkResponse());

    await connector.send(DM_THREAD, { body: 'Hello' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(requestUrl(mockFetch)).toBe('https://api.telegram.org/bottest-token/sendMessage');
    expect(requestBody(mockFetch)).toStrictEqual({
      chat_id: DM_THREAD,
      text: connector.format('Hello'),
      parse_mode: 'MarkdownV2',
    });
  });

  it('delivers a topic thread into its topic', async () => {
    const connector = makeConnector();
    const mockFetch = stubFetchJson(sendOkResponse());

    const result = await connector.send('-100123:42', { body: 'Hello' });

    expect(result.isOk()).toBe(true);
    expect(requestBody(mockFetch)).toStrictEqual({
      chat_id: '-100123',
      text: connector.format('Hello'),
      parse_mode: 'MarkdownV2',
      message_thread_id: 42,
    });
  });

  it('sends an explicit reply target as a native reply in a DM', async () => {
    const connector = makeConnector();
    const mockFetch = stubFetchJson(sendOkResponse());

    const result = await connector.send(DM_THREAD, {
      body: 'Hello',
      replyTo: { externalMessageId: '77' },
    });

    expect(result.isOk()).toBe(true);
    expect(requestBody(mockFetch)).toStrictEqual({
      chat_id: DM_THREAD,
      text: connector.format('Hello'),
      parse_mode: 'MarkdownV2',
      reply_parameters: { message_id: 77, allow_sending_without_reply: true },
    });
  });

  it('sends an explicit reply target as a native reply even with replyToTrigger "never"', async () => {
    const connector = makeConnector({ replyToTrigger: 'never' });
    const mockFetch = stubFetchJson(sendOkResponse());

    await connector.send(DM_THREAD, { body: 'Hello', replyTo: { externalMessageId: '77' } });

    expect(requestBody(mockFetch).reply_parameters).toEqual({
      message_id: 77,
      allow_sending_without_reply: true,
    });
  });

  it('combines a topic and a reply target', async () => {
    const connector = makeConnector();
    const mockFetch = stubFetchJson(sendOkResponse());

    await connector.send('-100123:42', {
      body: 'Hello',
      replyTo: { externalMessageId: '77', implicit: true },
    });

    expect(requestBody(mockFetch)).toStrictEqual({
      chat_id: '-100123',
      text: connector.format('Hello'),
      parse_mode: 'MarkdownV2',
      message_thread_id: 42,
      reply_parameters: { message_id: 77, allow_sending_without_reply: true },
    });
  });

  describe('implicit reply target', () => {
    const implicitOutput = {
      body: 'Hello',
      replyTo: { externalMessageId: '77', implicit: true },
    };
    const nativeReply = { message_id: 77, allow_sending_without_reply: true };

    it('is not sent as a reply in a DM by default', async () => {
      const connector = makeConnector();
      const mockFetch = stubFetchJson(sendOkResponse());

      const result = await connector.send(DM_THREAD, implicitOutput);

      expect(result.isOk()).toBe(true);
      expect(requestBody(mockFetch)).toStrictEqual({
        chat_id: DM_THREAD,
        text: connector.format('Hello'),
        parse_mode: 'MarkdownV2',
      });
    });

    it('is sent as a reply in a group by default', async () => {
      const connector = makeConnector();
      const mockFetch = stubFetchJson(sendOkResponse());

      await connector.send(GROUP_THREAD, implicitOutput);

      const body = requestBody(mockFetch);
      expect(body.chat_id).toBe(GROUP_THREAD);
      expect(body.reply_parameters).toEqual(nativeReply);
    });

    it('behaves the same with replyToTrigger "groups" set explicitly', async () => {
      const connector = makeConnector({ replyToTrigger: 'groups' });
      const mockFetch = stubFetchJson(sendOkResponse());

      await connector.send(DM_THREAD, implicitOutput);
      await connector.send(GROUP_THREAD, implicitOutput);

      expect('reply_parameters' in requestBody(mockFetch, 0)).toBe(false);
      expect(requestBody(mockFetch, 1).reply_parameters).toEqual(nativeReply);
    });

    it('is sent as a reply in a DM with replyToTrigger "always"', async () => {
      const connector = makeConnector({ replyToTrigger: 'always' });
      const mockFetch = stubFetchJson(sendOkResponse());

      await connector.send(DM_THREAD, implicitOutput);

      const body = requestBody(mockFetch);
      expect(body.chat_id).toBe(DM_THREAD);
      expect(body.reply_parameters).toEqual(nativeReply);
    });

    it('is not sent as a reply in a group with replyToTrigger "never"', async () => {
      const connector = makeConnector({ replyToTrigger: 'never' });
      const mockFetch = stubFetchJson(sendOkResponse());

      const result = await connector.send(GROUP_THREAD, implicitOutput);

      expect(result.isOk()).toBe(true);
      expect(requestBody(mockFetch)).toStrictEqual({
        chat_id: GROUP_THREAD,
        text: connector.format('Hello'),
        parse_mode: 'MarkdownV2',
      });
    });
  });

  it.each([
    ['a WhatsApp message id', 'wamid.HBgLNDkxNzAxMjM0NTY3'],
    ['a negative number', '-5'],
    ['zero', '0'],
    ['a decimal', '7.5'],
    ['the empty string', ''],
  ])('degrades to a plain send when the reply id is %s', async (_label, externalMessageId) => {
    const connector = makeConnector();
    const mockFetch = stubFetchJson(sendOkResponse(4242));

    const result = await connector.send(DM_THREAD, {
      body: 'Hello',
      replyTo: { externalMessageId },
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ externalMessageId: '4242' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(requestBody(mockFetch)).toStrictEqual({
      chat_id: DM_THREAD,
      text: connector.format('Hello'),
      parse_mode: 'MarkdownV2',
    });
  });
});

// ---------------------------------------------------------------------------
// Outbound react()
// ---------------------------------------------------------------------------

describe('TelegramConnector react()', () => {
  it('calls setMessageReaction with the chat, numeric message id and emoji', async () => {
    const connector = makeConnector();
    const mockFetch = stubFetchJson({ ok: true, result: true });

    const result = await connector.react('1234', { externalMessageId: '77' }, THUMBS_UP);

    expect(result.isOk()).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(requestUrl(mockFetch)).toBe('https://api.telegram.org/bottest-token/setMessageReaction');
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(requestBody(mockFetch)).toStrictEqual({
      chat_id: '1234',
      message_id: 77,
      reaction: [{ type: 'emoji', emoji: THUMBS_UP }],
    });
  });

  it('sends a heart with a presentation selector as the bare heart', async () => {
    const connector = makeConnector();
    const mockFetch = stubFetchJson({ ok: true, result: true });

    const result = await connector.react('1234', { externalMessageId: '77' }, HEART_WITH_VS16);

    expect(result.isOk()).toBe(true);
    expect(requestBody(mockFetch).reaction).toEqual([{ type: 'emoji', emoji: HEART }]);
  });

  it('sends a skin-toned thumbs-up as the plain thumbs-up', async () => {
    const connector = makeConnector();
    const mockFetch = stubFetchJson({ ok: true, result: true });

    await connector.react('1234', { externalMessageId: '77' }, THUMBS_UP_MEDIUM_SKIN);

    expect(requestBody(mockFetch).reaction).toEqual([{ type: 'emoji', emoji: THUMBS_UP }]);
  });

  it('clears the reaction when the emoji is empty', async () => {
    const connector = makeConnector();
    const mockFetch = stubFetchJson({ ok: true, result: true });

    const result = await connector.react('1234', { externalMessageId: '77' }, '');

    expect(result.isOk()).toBe(true);
    expect(requestBody(mockFetch)).toStrictEqual({ chat_id: '1234', message_id: 77, reaction: [] });
  });

  it('refuses an unsupported emoji with the allowed alternatives and makes no request', async () => {
    const connector = makeConnector();
    const mockFetch = stubFetchJson({ ok: true, result: true });

    const result = await connector.react('1234', { externalMessageId: '77' }, CHECK_MARK);

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain(CHECK_MARK);
    expect(message).toContain(THUMBS_UP);
    expect(message).toContain(HEART);
    expect(message).toContain(TELEGRAM_REACTION_EMOJI.join(' '));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a WhatsApp message id', 'wamid.HBgLNDkxNzAxMjM0NTY3'],
    ['a negative number', '-5'],
    ['zero', '0'],
    ['the empty string', ''],
  ])('refuses %s as the message id and makes no request', async (_label, externalMessageId) => {
    const connector = makeConnector();
    const mockFetch = stubFetchJson({ ok: true, result: true });

    const result = await connector.react('1234', { externalMessageId }, THUMBS_UP);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('is not a Telegram message id');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns Err with the API description when Telegram answers ok: false', async () => {
    const connector = makeConnector();
    stubFetchJson(
      { ok: false, error_code: 400, description: 'Bad Request: REACTION_INVALID' },
      400,
    );

    const result = await connector.react('1234', { externalMessageId: '77' }, THUMBS_UP);

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('Bad Request: REACTION_INVALID');
    expect(message).toContain('400');
  });

  it('returns Err when the request throws', async () => {
    const connector = makeConnector();
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await connector.react('1234', { externalMessageId: '77' }, THUMBS_UP);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('ECONNRESET');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns Err when the response body is not JSON', async () => {
    const connector = makeConnector();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    } as unknown as Response);
    vi.stubGlobal('fetch', mockFetch);

    const result = await connector.react('1234', { externalMessageId: '77' }, THUMBS_UP);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('502');
  });

  it('addresses the bare chat for a topic thread', async () => {
    const connector = makeConnector();
    const mockFetch = stubFetchJson({ ok: true, result: true });

    const result = await connector.react('-100123:42', { externalMessageId: '77' }, THUMBS_UP);

    expect(result.isOk()).toBe(true);
    expect(requestBody(mockFetch)).toStrictEqual({
      chat_id: '-100123',
      message_id: 77,
      reaction: [{ type: 'emoji', emoji: THUMBS_UP }],
    });
  });
});

// ---------------------------------------------------------------------------
// getUpdates / sendTyping
// ---------------------------------------------------------------------------

describe('TelegramConnector getUpdates allowed_updates', () => {
  /** Start the poll loop, wait for the first long poll, and return its URL. */
  async function firstGetUpdatesUrl(connector: TelegramConnector): Promise<URL> {
    const mockFetch = makeMockFetch([]);
    vi.stubGlobal('fetch', mockFetch);

    const getUpdatesCalls = (): string[] =>
      mockFetch.mock.calls
        .map((call) => call[0] as string)
        .filter((url) => url.includes('/getUpdates'));

    await connector.start();
    await vi.waitFor(() => expect(getUpdatesCalls().length).toBeGreaterThan(0), { timeout: 2000 });
    await connector.stop();

    return new URL(getUpdatesCalls()[0]);
  }

  it('asks for message and message_reaction updates by default', async () => {
    const url = await firstGetUpdatesUrl(makeConnector());

    expect(url.pathname).toBe('/bottest-token/getUpdates');
    const allowed = url.searchParams.get('allowed_updates');
    expect(allowed).not.toBeNull();
    expect(JSON.parse(allowed as string)).toEqual(['message', 'message_reaction']);
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.get('timeout')).toBe('1');
  });

  it('asks for message and message_reaction updates when inboundReactions is true', async () => {
    const url = await firstGetUpdatesUrl(makeConnector({ inboundReactions: true }));

    expect(JSON.parse(url.searchParams.get('allowed_updates') as string)).toEqual([
      'message',
      'message_reaction',
    ]);
  });

  it('asks for message updates only when inboundReactions is false', async () => {
    const url = await firstGetUpdatesUrl(makeConnector({ inboundReactions: false }));

    const allowed = url.searchParams.get('allowed_updates');
    expect(allowed).not.toBeNull();
    expect(JSON.parse(allowed as string)).toEqual(['message']);
  });

  it('delivers a polled message_reaction update to the handler', async () => {
    const connector = makeConnector();
    const received = collectEvents(connector);
    const mockFetch = makeMockFetch([
      { ok: true, result: [reactionUpdate(301, { messageId: 88 })] },
    ]);
    vi.stubGlobal('fetch', mockFetch);

    await connector.start();
    await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 2000 });
    await connector.stop();

    expect(received[0].reaction).toEqual({ targetMessageId: '88', emoji: THUMBS_UP });
    expect(received[0].idempotencyKey).toBe('301');
  });
});

describe('TelegramConnector sendTyping()', () => {
  it('sends message_thread_id for a topic thread', async () => {
    const connector = makeConnector();
    const mockFetch = stubFetchJson({ ok: true, result: true });

    await connector.sendTyping('-100123:42');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(requestUrl(mockFetch)).toBe('https://api.telegram.org/bottest-token/sendChatAction');
    expect(requestBody(mockFetch)).toStrictEqual({
      chat_id: '-100123',
      action: 'typing',
      message_thread_id: 42,
    });
  });

  it('sends no message_thread_id for a plain chat thread', async () => {
    const connector = makeConnector();
    const mockFetch = stubFetchJson({ ok: true, result: true });

    await connector.sendTyping('1234');

    expect(requestBody(mockFetch)).toStrictEqual({ chat_id: '1234', action: 'typing' });
  });
});

// ---------------------------------------------------------------------------
// Diagnostics: an ignored group must be visible in the log
// ---------------------------------------------------------------------------

describe('TelegramConnector diagnostics', () => {
  function recordingLogger(): {
    logger: pino.Logger;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  } {
    const warn = vi.fn();
    const debug = vi.fn();
    const logger = { info: vi.fn(), warn, debug, error: vi.fn() } as unknown as pino.Logger;
    return { logger, warn, debug };
  }

  function connectorWith(
    logger: pino.Logger,
    overrides?: Partial<TelegramConfig>,
  ): TelegramConnector {
    const connector = new TelegramConnector(defaultConfig(overrides), 'test-bot', logger);
    connectors.push(connector);
    return connector;
  }

  const IGNORED_GROUP = 'telegram group chat is ignored because allowGroupChats is not enabled';

  it('warns once per group chat when allowGroupChats is off, naming the chat id', async () => {
    const { logger, warn } = recordingLogger();
    const connector = connectorWith(logger);
    const received = collectEvents(connector);

    await connector.handleUpdatePublic(messageUpdate(1, groupMessage()));
    await connector.handleUpdatePublic(messageUpdate(2, groupMessage({ message_id: 2021 })));

    expect(received).toHaveLength(0);
    const warnings = warn.mock.calls.filter((call) => String(call[1]).startsWith(IGNORED_GROUP));
    expect(warnings).toHaveLength(1);
    expect(warnings[0][0]).toMatchObject({
      chatId: String(GROUP_CHAT_ID),
      chatType: 'supergroup',
    });
  });

  it('warns separately for each ignored group chat', async () => {
    const { logger, warn } = recordingLogger();
    const connector = connectorWith(logger);

    await connector.handleUpdatePublic(messageUpdate(1, groupMessage()));
    await connector.handleUpdatePublic(
      messageUpdate(
        2,
        groupMessage({ chat: { id: -1009999, type: 'supergroup', title: 'Other' } }),
      ),
    );

    const chatIds = warn.mock.calls
      .filter((call) => String(call[1]).startsWith(IGNORED_GROUP))
      .map((call) => (call[0] as { chatId: string }).chatId);
    expect(chatIds).toEqual([String(GROUP_CHAT_ID), '-1009999']);
  });

  it('does not warn when allowGroupChats is on, or for a private chat', async () => {
    const { logger, warn } = recordingLogger();
    const groupEnabled = connectorWith(logger, { allowGroupChats: true });
    await groupEnabled.handleUpdatePublic(messageUpdate(1, groupMessage()));
    const privateOnly = connectorWith(logger);
    collectEvents(privateOnly);
    await privateOnly.handleUpdatePublic(messageUpdate(2, dmMessage()));

    expect(warn.mock.calls.some((call) => String(call[1]).startsWith(IGNORED_GROUP))).toBe(false);
  });

  it('logs every delivered update at debug with identifiers only, before any filter', async () => {
    const { logger, debug } = recordingLogger();
    const connector = connectorWith(logger);

    await connector.handleUpdatePublic(
      messageUpdate(
        7,
        groupMessage({ text: 'secret text', is_topic_message: true, message_thread_id: 42 }),
      ),
    );

    const received = debug.mock.calls.find((call) => call[1] === 'telegram update received');
    expect(received?.[0]).toEqual({
      channelName: 'test-bot',
      updateId: 7,
      kind: 'message',
      chatId: String(GROUP_CHAT_ID),
      chatType: 'supergroup',
      topicId: 42,
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain('secret text');
  });

  it('labels reaction updates and updates of other kinds', async () => {
    const { logger, debug } = recordingLogger();
    const connector = connectorWith(logger);

    await connector.handleUpdatePublic(reactionUpdate(8));
    await connector.handleUpdatePublic({ update_id: 9, edited_message: {} });

    const kinds = debug.mock.calls
      .filter((call) => call[1] === 'telegram update received')
      .map((call) => (call[0] as { kind: string }).kind);
    expect(kinds).toEqual(['message_reaction', 'other']);
  });
});

// ---------------------------------------------------------------------------
// requireMention: false — answer every message in allowed groups
// ---------------------------------------------------------------------------

describe('TelegramConnector requireMention', () => {
  const OPEN_GROUP = { allowGroupChats: true, requireMention: false } as const;

  it('by default drops a group message that does not address the bot', async () => {
    const connector = makeConnector({ allowGroupChats: true });
    const received = collectEvents(connector);
    await connector.handleUpdatePublic(messageUpdate(1, groupMessage({ text: 'just chatting' })));
    expect(received).toHaveLength(0);
  });

  it('treats requireMention: true like the default', async () => {
    const connector = makeConnector({ allowGroupChats: true, requireMention: true });
    const received = collectEvents(connector);
    await connector.handleUpdatePublic(messageUpdate(1, groupMessage({ text: 'just chatting' })));
    expect(received).toHaveLength(0);
  });

  it('delivers a plain group message with its full text when requireMention is false', async () => {
    const connector = makeConnector(OPEN_GROUP);
    const received = collectEvents(connector);

    await connector.handleUpdatePublic(
      messageUpdate(1, groupMessage({ text: 'wat is de status?' })),
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      content: 'wat is de status?',
      externalThreadId: String(GROUP_CHAT_ID),
      externalMessageId: '2020',
      senderId: String(USER_ID),
    });
  });

  it('delivers a plain message inside a topic to that topic thread', async () => {
    const connector = makeConnector(OPEN_GROUP);
    const received = collectEvents(connector);

    await connector.handleUpdatePublic(
      messageUpdate(
        1,
        groupMessage({ text: 'homelab vraag', is_topic_message: true, message_thread_id: 42 }),
      ),
    );

    expect(received).toHaveLength(1);
    expect(received[0].externalThreadId).toBe(`${GROUP_CHAT_ID}:42`);
    expect(received[0].content).toBe('homelab vraag');
  });

  it('still strips an @mention that is present', async () => {
    const connector = makeConnector(OPEN_GROUP);
    await startWithIdentity(connector);
    const received = collectEvents(connector);
    const text = `@${BOT_USERNAME} wat is de status?`;

    await connector.handleUpdatePublic(
      messageUpdate(
        1,
        groupMessage({
          text,
          entities: [{ type: 'mention', offset: 0, length: BOT_USERNAME.length + 1 }],
        }),
      ),
    );

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('wat is de status?');
  });

  it('still strips a trigger word that is present', async () => {
    const connector = makeConnector({ ...OPEN_GROUP, triggerWords: ['!talon'] });
    const received = collectEvents(connector);

    await connector.handleUpdatePublic(messageUpdate(1, groupMessage({ text: '!talon ping' })));
    await connector.handleUpdatePublic(
      messageUpdate(2, groupMessage({ message_id: 2021, text: 'zonder trigger' })),
    );

    expect(received.map((event) => event.content)).toEqual(['ping', 'zonder trigger']);
  });

  it('does not open groups on its own: allowGroupChats must still be on', async () => {
    const connector = makeConnector({ requireMention: false });
    const received = collectEvents(connector);
    await connector.handleUpdatePublic(messageUpdate(1, groupMessage()));
    expect(received).toHaveLength(0);
  });

  it('still enforces allowedChatIds', async () => {
    const connector = makeConnector({ ...OPEN_GROUP, allowedChatIds: ['-100999'] });
    const received = collectEvents(connector);
    await connector.handleUpdatePublic(messageUpdate(1, groupMessage()));
    expect(received).toHaveLength(0);

    const allowed = makeConnector({ ...OPEN_GROUP, allowedChatIds: [String(GROUP_CHAT_ID)] });
    const allowedReceived = collectEvents(allowed);
    await allowed.handleUpdatePublic(messageUpdate(2, groupMessage()));
    expect(allowedReceived).toHaveLength(1);
  });

  it('still drops messages from bots', async () => {
    const connector = makeConnector(OPEN_GROUP);
    const received = collectEvents(connector);
    await connector.handleUpdatePublic(
      messageUpdate(
        1,
        groupMessage({
          from: { id: 4321, is_bot: true, first_name: 'Other', username: 'other_bot' },
        }),
      ),
    );
    expect(received).toHaveLength(0);
  });

  it('still drops a group message with no text and no image', async () => {
    const connector = makeConnector(OPEN_GROUP);
    const received = collectEvents(connector);
    await connector.handleUpdatePublic(
      messageUpdate(
        1,
        groupMessage({
          text: undefined,
          sticker: { file_id: 'f', file_unique_id: 'u', width: 1, height: 1 },
        }),
      ),
    );
    expect(received).toHaveLength(0);
  });

  it('does not bypass trigger words in a direct chat', async () => {
    const connector = makeConnector({ ...OPEN_GROUP, triggerWords: ['!talon'] });
    const received = collectEvents(connector);
    await connector.handleUpdatePublic(messageUpdate(1, dmMessage({ text: 'no trigger here' })));
    expect(received).toHaveLength(0);
  });

  describe('startup warning', () => {
    const OPEN_TO_ALL = 'telegram requireMention is false without allowedChatIds';

    async function warningsOnStart(overrides: Partial<TelegramConfig>): Promise<string[]> {
      const warn = vi.fn();
      const logger = {
        info: vi.fn(),
        warn,
        debug: vi.fn(),
        error: vi.fn(),
      } as unknown as pino.Logger;
      const connector = new TelegramConnector(defaultConfig(overrides), 'test-bot', logger);
      connectors.push(connector);
      vi.stubGlobal('fetch', makeMockFetch([]));
      await connector.start();
      return warn.mock.calls.map((call) => String(call[1]));
    }

    it('warns when every group is answered without an allow-list', async () => {
      const warnings = await warningsOnStart(OPEN_GROUP);
      expect(warnings.some((message) => message.startsWith(OPEN_TO_ALL))).toBe(true);
    });

    it('stays quiet with an allow-list, with requireMention on, or with groups off', async () => {
      for (const overrides of [
        { ...OPEN_GROUP, allowedChatIds: [String(GROUP_CHAT_ID)] },
        { allowGroupChats: true },
        { requireMention: false },
      ]) {
        const warnings = await warningsOnStart(overrides);
        expect(warnings.some((message) => message.startsWith(OPEN_TO_ALL))).toBe(false);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Per-chat settings (config.chats)
// ---------------------------------------------------------------------------

describe('TelegramConnector per-chat settings', () => {
  const WORKSPACE = String(GROUP_CHAT_ID);
  const OTHER_GROUP_ID = -1009999;

  it('answers every message in a chat whose own requireMention is false', async () => {
    const connector = makeConnector({
      allowGroupChats: true,
      chats: { [WORKSPACE]: { requireMention: false } },
    });
    const received = collectEvents(connector);

    await connector.handleUpdatePublic(
      messageUpdate(1, groupMessage({ text: 'in the workspace' })),
    );
    await connector.handleUpdatePublic(
      messageUpdate(
        2,
        groupMessage({
          message_id: 2021,
          text: 'in another group',
          chat: { id: OTHER_GROUP_ID, type: 'supergroup', title: 'Other' },
        }),
      ),
    );

    expect(received.map((event) => event.content)).toEqual(['in the workspace']);
  });

  it('lets one chat require a mention while the connector default does not', async () => {
    const connector = makeConnector({
      allowGroupChats: true,
      requireMention: false,
      chats: { [WORKSPACE]: { requireMention: true } },
    });
    const received = collectEvents(connector);

    await connector.handleUpdatePublic(messageUpdate(1, groupMessage({ text: 'needs a mention' })));
    await connector.handleUpdatePublic(
      messageUpdate(
        2,
        groupMessage({
          message_id: 2021,
          text: 'open group',
          chat: { id: OTHER_GROUP_ID, type: 'supergroup', title: 'Other' },
        }),
      ),
    );

    expect(received.map((event) => event.content)).toEqual(['open group']);
  });

  it('does not admit a chat just because it is listed', async () => {
    const connector = makeConnector({ chats: { [WORKSPACE]: { requireMention: false } } });
    const received = collectEvents(connector);
    await connector.handleUpdatePublic(messageUpdate(1, groupMessage()));
    expect(received).toHaveLength(0);
  });

  describe('replyToTrigger', () => {
    const implicit = { externalMessageId: '77', implicit: true };

    async function sendTo(
      config: Partial<TelegramConfig>,
      threadId: string,
    ): Promise<Record<string, unknown>> {
      const connector = makeConnector(config);
      const mockFetch = stubFetchJson(sendOkResponse());
      await connector.send(threadId, { body: 'hi', replyTo: implicit });
      return requestBody(mockFetch);
    }

    it('turns quoting off for one group and leaves other groups on the default', async () => {
      const config = { chats: { [WORKSPACE]: { replyToTrigger: 'never' as const } } };
      expect(await sendTo(config, `${WORKSPACE}:42`)).not.toHaveProperty('reply_parameters');
      expect(await sendTo(config, String(OTHER_GROUP_ID))).toHaveProperty('reply_parameters');
    });

    it('lets one chat quote while the connector default is never', async () => {
      const config = {
        replyToTrigger: 'never' as const,
        chats: { [WORKSPACE]: { replyToTrigger: 'always' as const } },
      };
      expect(await sendTo(config, WORKSPACE)).toHaveProperty('reply_parameters');
      expect(await sendTo(config, String(OTHER_GROUP_ID))).not.toHaveProperty('reply_parameters');
    });

    it('still sends an explicit reply in a chat set to never', async () => {
      const connector = makeConnector({ chats: { [WORKSPACE]: { replyToTrigger: 'never' } } });
      const mockFetch = stubFetchJson(sendOkResponse());
      await connector.send(WORKSPACE, { body: 'hi', replyTo: { externalMessageId: '77' } });
      expect(requestBody(mockFetch)).toHaveProperty('reply_parameters.message_id', 77);
    });
  });
});

// ---------------------------------------------------------------------------
// /chatid setup command
// ---------------------------------------------------------------------------

describe('TelegramConnector /chatid', () => {
  function command(text: string, overrides: Partial<TelegramMessage> = {}): object {
    return messageUpdate(1, groupMessage({ text, ...overrides }));
  }

  it('answers with the chat id and thread key, even before the group is allowed', async () => {
    // allowGroupChats is off: this is the setup step that reveals the id.
    const connector = makeConnector({ allowedChatIds: [String(USER_ID)] });
    const received = collectEvents(connector);
    const mockFetch = stubFetchJson(sendOkResponse());

    await connector.handleUpdatePublic(command('/chatid'));

    expect(received).toHaveLength(0);
    expect(requestUrl(mockFetch)).toContain('/sendMessage');
    expect(requestBody(mockFetch)).toEqual({
      chat_id: String(GROUP_CHAT_ID),
      text: `Chat ID: ${GROUP_CHAT_ID}\nTalon thread: ${GROUP_CHAT_ID}`,
    });
  });

  it('adds the topic id and answers inside the topic', async () => {
    const connector = makeConnector({ allowedChatIds: [String(USER_ID)] });
    const mockFetch = stubFetchJson(sendOkResponse());

    await connector.handleUpdatePublic(
      command('/chatid', { is_topic_message: true, message_thread_id: 42 }),
    );

    expect(requestBody(mockFetch)).toEqual({
      chat_id: String(GROUP_CHAT_ID),
      text: `Chat ID: ${GROUP_CHAT_ID}\nTopic ID: 42\nTalon thread: ${GROUP_CHAT_ID}:42`,
      message_thread_id: 42,
    });
  });

  it('works in a private chat', async () => {
    const connector = makeConnector({ allowedChatIds: [String(DM_CHAT_ID)] });
    const mockFetch = stubFetchJson(sendOkResponse());
    await connector.handleUpdatePublic(messageUpdate(1, dmMessage({ text: '/chatid' })));
    expect(requestBody(mockFetch).text).toBe(`Chat ID: ${DM_CHAT_ID}\nTalon thread: ${DM_CHAT_ID}`);
  });

  it('accepts the command addressed to this bot and ignores one addressed to another', async () => {
    const connector = makeConnector({ allowGroupChats: true, allowedChatIds: [String(USER_ID)] });
    await startWithIdentity(connector);
    const received = collectEvents(connector);
    const mockFetch = stubFetchJson(sendOkResponse());

    await connector.handleUpdatePublic(command(`/chatid@${BOT_USERNAME}`));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await connector.handleUpdatePublic(command('/chatid@some_other_bot'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Not ours: it takes the normal path (and is dropped there: the group is
    // not in allowedChatIds).
    expect(received).toHaveLength(0);
  });

  it('answers anyone when the bot has no allowedChatIds', async () => {
    const connector = makeConnector();
    const mockFetch = stubFetchJson(sendOkResponse());
    await connector.handleUpdatePublic(command('/chatid'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('answers a member of an already allowed chat', async () => {
    const connector = makeConnector({ allowedChatIds: [String(GROUP_CHAT_ID)] });
    const mockFetch = stubFetchJson(sendOkResponse());
    await connector.handleUpdatePublic(
      command('/chatid', { from: { id: OTHER_USER_ID, first_name: 'Other' } }),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('stays silent for a sender who is not allowed, and never forwards the command', async () => {
    const connector = makeConnector({ allowGroupChats: true, allowedChatIds: ['424242'] });
    const received = collectEvents(connector);
    const mockFetch = stubFetchJson(sendOkResponse());

    await connector.handleUpdatePublic(command('/chatid'));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });

  it('ignores the command from a bot', async () => {
    const connector = makeConnector();
    const mockFetch = stubFetchJson(sendOkResponse());
    await connector.handleUpdatePublic(
      command('/chatid', { from: { id: 4321, is_bot: true, first_name: 'Bot' } }),
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('leaves messages that merely contain the word alone', async () => {
    const connector = makeConnector();
    const received = collectEvents(connector);
    const mockFetch = stubFetchJson(sendOkResponse());

    await connector.handleUpdatePublic(messageUpdate(1, dmMessage({ text: '/chatid please' })));
    await connector.handleUpdatePublic(
      messageUpdate(2, dmMessage({ message_id: 1011, text: 'what is /chatid' })),
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(received.map((event) => event.content)).toEqual(['/chatid please', 'what is /chatid']);
  });

  it('survives a failed reply', async () => {
    const connector = makeConnector();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(connector.handleUpdatePublic(command('/chatid'))).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Typing indicator diagnostics
// ---------------------------------------------------------------------------

describe('TelegramConnector sendTyping() diagnostics', () => {
  const REFUSED = 'telegram refused the typing indicator';

  function connectorWithLogger(): {
    connector: TelegramConnector;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  } {
    const warn = vi.fn();
    const debug = vi.fn();
    const logger = { info: vi.fn(), warn, debug, error: vi.fn() } as unknown as pino.Logger;
    const connector = new TelegramConnector(defaultConfig(), 'test-bot', logger);
    connectors.push(connector);
    return { connector, warn, debug };
  }

  it('reports a refused typing indicator once per thread, with the reason', async () => {
    const { connector, warn, debug } = connectorWithLogger();
    stubFetchJson(
      { ok: false, error_code: 400, description: 'Bad Request: message thread not found' },
      400,
    );

    await connector.sendTyping(`${GROUP_CHAT_ID}:42`);
    await connector.sendTyping(`${GROUP_CHAT_ID}:42`);
    await connector.sendTyping(`${GROUP_CHAT_ID}:43`);

    const warnings = warn.mock.calls.filter((call) => String(call[1]).startsWith(REFUSED));
    expect(warnings).toHaveLength(2);
    expect(warnings[0][0]).toEqual({
      channelName: 'test-bot',
      chatId: String(GROUP_CHAT_ID),
      topicId: 42,
      errorCode: 400,
      description: 'Bad Request: message thread not found',
    });
    expect(debug.mock.calls.filter((call) => String(call[1]).startsWith(REFUSED))).toHaveLength(1);
  });

  it('stays quiet when Telegram accepts the indicator', async () => {
    const { connector, warn } = connectorWithLogger();
    stubFetchJson({ ok: true, result: true });
    await connector.sendTyping(String(GROUP_CHAT_ID));
    expect(warn).not.toHaveBeenCalled();
  });

  it('swallows a network failure', async () => {
    const { connector, warn } = connectorWithLogger();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(connector.sendTyping(String(GROUP_CHAT_ID))).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Per-topic settings: several bots sharing one forum group
// ---------------------------------------------------------------------------

describe('TelegramConnector per-topic settings', () => {
  const GROUP = String(GROUP_CHAT_ID);
  const inTopic = (topicId: number, text: string, messageId = 3000 + topicId): object =>
    messageUpdate(
      topicId,
      groupMessage({
        message_id: messageId,
        text,
        is_topic_message: true,
        message_thread_id: topicId,
      }),
    );

  it('answers unprompted only in the topic that is configured for it', async () => {
    const connector = makeConnector({
      allowGroupChats: true,
      chats: { [`${GROUP}:42`]: { requireMention: false } },
    });
    const received = collectEvents(connector);

    await connector.handleUpdatePublic(inTopic(42, 'in my topic'));
    await connector.handleUpdatePublic(inTopic(43, 'in the other topic'));
    await connector.handleUpdatePublic(messageUpdate(9, groupMessage({ text: 'in General' })));

    expect(received.map((event) => [event.externalThreadId, event.content])).toEqual([
      [`${GROUP}:42`, 'in my topic'],
    ]);
  });

  it('lets two bots share a group, each answering unprompted in its own topic', async () => {
    const groceriesBot = makeConnector({
      allowGroupChats: true,
      chats: { [`${GROUP}:42`]: { requireMention: false } },
    });
    const calendarBot = makeConnector({
      allowGroupChats: true,
      chats: { [`${GROUP}:43`]: { requireMention: false } },
    });
    const groceries = collectEvents(groceriesBot);
    const calendar = collectEvents(calendarBot);

    // Telegram delivers every group message to both administrator bots.
    for (const update of [inTopic(42, 'buy milk'), inTopic(43, 'dentist on Friday')]) {
      await groceriesBot.handleUpdatePublic(update);
      await calendarBot.handleUpdatePublic(update);
    }

    expect(groceries.map((event) => event.content)).toEqual(['buy milk']);
    expect(calendar.map((event) => event.content)).toEqual(['dentist on Friday']);
  });

  it('still answers a mention in a topic that is not its own', async () => {
    const connector = makeConnector({
      allowGroupChats: true,
      chats: { [`${GROUP}:42`]: { requireMention: false } },
    });
    await startWithIdentity(connector);
    const received = collectEvents(connector);
    const text = `@${BOT_USERNAME} quick question`;

    await connector.handleUpdatePublic(
      messageUpdate(
        1,
        groupMessage({
          text,
          entities: [{ type: 'mention', offset: 0, length: BOT_USERNAME.length + 1 }],
          is_topic_message: true,
          message_thread_id: 43,
        }),
      ),
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      externalThreadId: `${GROUP}:43`,
      content: 'quick question',
    });
  });

  it('lets a topic require a mention inside a group that otherwise does not', async () => {
    const connector = makeConnector({
      allowGroupChats: true,
      chats: {
        [GROUP]: { requireMention: false },
        [`${GROUP}:43`]: { requireMention: true },
      },
    });
    const received = collectEvents(connector);

    await connector.handleUpdatePublic(inTopic(42, 'open topic'));
    await connector.handleUpdatePublic(inTopic(43, 'quiet topic'));

    expect(received.map((event) => event.content)).toEqual(['open topic']);
  });

  it("applies a topic's own replyToTrigger over the chat's", async () => {
    const config = {
      chats: {
        [GROUP]: { replyToTrigger: 'always' as const },
        [`${GROUP}:42`]: { replyToTrigger: 'never' as const },
      },
    };
    const implicit = { externalMessageId: '77', implicit: true };

    const quiet = makeConnector(config);
    let mockFetch = stubFetchJson(sendOkResponse());
    await quiet.send(`${GROUP}:42`, { body: 'hi', replyTo: implicit });
    expect(requestBody(mockFetch)).not.toHaveProperty('reply_parameters');

    const quoting = makeConnector(config);
    mockFetch = stubFetchJson(sendOkResponse());
    await quoting.send(`${GROUP}:43`, { body: 'hi', replyTo: implicit });
    expect(requestBody(mockFetch)).toHaveProperty('reply_parameters.message_id', 77);
  });
});

// ---------------------------------------------------------------------------
// requireMention: false must not answer a message aimed at another bot
// ---------------------------------------------------------------------------

describe('TelegramConnector messages addressed to another bot', () => {
  const OPEN = { allowGroupChats: true, requireMention: false } as const;
  const OTHER_BOT = 'calendar_bot';
  const OTHER_BOT_ID = 6001;

  /** A group message whose text starts with an @mention of `username`. */
  function mentioning(username: string, rest: string, overrides: Partial<TelegramMessage> = {}) {
    return groupMessage({
      text: `@${username} ${rest}`,
      entities: [{ type: 'mention', offset: 0, length: username.length + 1 }],
      ...overrides,
    });
  }

  async function openBot(): Promise<{ connector: TelegramConnector; received: InboundEvent[] }> {
    const connector = makeConnector(OPEN);
    await startWithIdentity(connector);
    return { connector, received: collectEvents(connector) };
  }

  it('stays silent when the message @mentions a different bot', async () => {
    const { connector, received } = await openBot();
    await connector.handleUpdatePublic(
      messageUpdate(1, mentioning(OTHER_BOT, 'what is on today?')),
    );
    expect(received).toHaveLength(0);
  });

  it('answers when it is the one mentioned, with the mention stripped', async () => {
    const { connector, received } = await openBot();
    await connector.handleUpdatePublic(messageUpdate(1, mentioning(BOT_USERNAME, 'buy milk')));
    expect(received.map((event) => event.content)).toEqual(['buy milk']);
  });

  it('answers when both bots are mentioned', async () => {
    const { connector, received } = await openBot();
    const text = `@${OTHER_BOT} @${BOT_USERNAME} both of you`;
    await connector.handleUpdatePublic(
      messageUpdate(
        1,
        groupMessage({
          text,
          entities: [
            { type: 'mention', offset: 0, length: OTHER_BOT.length + 1 },
            { type: 'mention', offset: OTHER_BOT.length + 2, length: BOT_USERNAME.length + 1 },
          ],
        }),
      ),
    );
    expect(received).toHaveLength(1);
  });

  it('still answers a message that mentions a person', async () => {
    const { connector, received } = await openBot();
    await connector.handleUpdatePublic(
      messageUpdate(1, mentioning('josje', 'can you check this?')),
    );
    expect(received.map((event) => event.content)).toEqual(['@josje can you check this?']);
  });

  it("stays silent on a reply to a different bot's message", async () => {
    const { connector, received } = await openBot();
    await connector.handleUpdatePublic(
      messageUpdate(
        1,
        groupMessage({
          text: 'move it to Friday',
          reply_to_message: {
            message_id: 1900,
            from: { id: OTHER_BOT_ID, is_bot: true, first_name: 'Calendar', username: OTHER_BOT },
            chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
            date: 1_700_000_000,
            text: 'Dentist is on Thursday',
          },
        }),
      ),
    );
    expect(received).toHaveLength(0);
  });

  it('still answers a reply to its own message', async () => {
    const { connector, received } = await openBot();
    await connector.handleUpdatePublic(
      messageUpdate(
        1,
        groupMessage({
          text: 'and oats',
          reply_to_message: botMessage(GROUP_CHAT_ID, { message_id: 1900, text: 'Milk added' }),
        }),
      ),
    );
    expect(received.map((event) => event.content)).toEqual(['and oats']);
  });

  it("still answers a reply to a person's message", async () => {
    const { connector, received } = await openBot();
    await connector.handleUpdatePublic(
      messageUpdate(
        1,
        groupMessage({
          text: 'agreed',
          reply_to_message: otherUserMessage(GROUP_CHAT_ID, { message_id: 1900 }),
        }),
      ),
    );
    expect(received).toHaveLength(1);
  });

  it('stays silent on a command sent to a different bot', async () => {
    const { connector, received } = await openBot();
    const text = `/agenda@${OTHER_BOT}`;
    await connector.handleUpdatePublic(
      messageUpdate(
        1,
        groupMessage({ text, entities: [{ type: 'bot_command', offset: 0, length: text.length }] }),
      ),
    );
    expect(received).toHaveLength(0);
  });

  it('stays silent on a text mention of a different bot', async () => {
    const { connector, received } = await openBot();
    await connector.handleUpdatePublic(
      messageUpdate(
        1,
        groupMessage({
          text: 'Calendar what is on today?',
          entities: [
            {
              type: 'text_mention',
              offset: 0,
              length: 8,
              user: { id: OTHER_BOT_ID, is_bot: true, first_name: 'Calendar' },
            },
          ],
        }),
      ),
    );
    expect(received).toHaveLength(0);
  });

  it('does not treat a topic created by another bot as a reply to that bot', async () => {
    const { connector, received } = await openBot();
    await connector.handleUpdatePublic(
      messageUpdate(
        1,
        groupMessage({
          text: 'buy milk',
          is_topic_message: true,
          message_thread_id: 42,
          reply_to_message: {
            message_id: 42,
            from: { id: OTHER_BOT_ID, is_bot: true, first_name: 'Calendar', username: OTHER_BOT },
            chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
            date: 1_700_000_000,
            forum_topic_created: { name: 'Groceries' },
          },
        }),
      ),
    );
    expect(received).toHaveLength(1);
  });

  it('answers everything when it does not know its own username', async () => {
    // No start(): getMe never ran, so its own mention cannot be told apart.
    const connector = makeConnector(OPEN);
    const received = collectEvents(connector);
    await connector.handleUpdatePublic(messageUpdate(1, mentioning(OTHER_BOT, 'hello')));
    expect(received).toHaveLength(1);
  });

  it('leaves the two bots of one topic with one answer each way', async () => {
    const config = {
      allowGroupChats: true,
      chats: { [`${GROUP_CHAT_ID}:42`]: { requireMention: false } },
    };
    const first = makeConnector(config);
    await startWithIdentity(first);
    const firstReceived = collectEvents(first);

    const inTopic = (message: TelegramMessage, id: number) =>
      messageUpdate(id, { ...message, is_topic_message: true, message_thread_id: 42 });

    await first.handleUpdatePublic(inTopic(mentioning(OTHER_BOT, 'for the other one'), 1));
    await first.handleUpdatePublic(
      inTopic(groupMessage({ text: 'for whoever', message_id: 2021 }), 2),
    );

    expect(firstReceived.map((event) => event.content)).toEqual(['for whoever']);
  });
});
