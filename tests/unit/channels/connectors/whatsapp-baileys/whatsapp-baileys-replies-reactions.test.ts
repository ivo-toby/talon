/**
 * Unit tests for WhatsApp Baileys quoted replies and emoji reactions.
 *
 * Two layers are covered:
 * - the pure Baileys <-> Talon mapping helpers in `whatsapp-baileys-replies.ts`;
 * - the connector, driven end to end through a mocked `@whiskeysockets/baileys`
 *   module: `start()` runs against a fake socket, the captured `ev.on` handlers
 *   deliver `connection.update` / `messages.upsert`, and outbound calls are
 *   asserted on the payloads handed to the fake `sock.sendMessage`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import { WhatsAppBaileysConnector } from '../../../../../src/channels/connectors/whatsapp-baileys/whatsapp-baileys-connector.js';
import {
  buildMessageKey,
  buildQuotedMessage,
  extractQuotedContext,
  extractReaction,
} from '../../../../../src/channels/connectors/whatsapp-baileys/whatsapp-baileys-replies.js';
import type { WhatsAppBaileysConfig } from '../../../../../src/channels/connectors/whatsapp-baileys/whatsapp-baileys-types.js';
import type { InboundEvent } from '../../../../../src/channels/channel-types.js';

// ---------------------------------------------------------------------------
// Baileys module mock
// ---------------------------------------------------------------------------

type EventHandler = (payload: unknown) => void;

interface FakeSocket {
  user: { id: string; lid?: string };
  handlers: Map<string, EventHandler>;
  ev: { on: (event: string, handler: EventHandler) => void };
  sendMessage: ReturnType<typeof vi.fn>;
  sendPresenceUpdate: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

// The socket `makeWASocket` hands out; replaced per test in `startConnector`.
const { baileysState } = vi.hoisted(() => ({
  baileysState: { socket: undefined as unknown },
}));

vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: () => baileysState.socket,
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => undefined }),
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
  DisconnectReason: { loggedOut: 401 },
  Browsers: { appropriate: (name: string) => [name, 'Chrome', '1.0.0'] },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logger = pino({ level: 'silent' });

const DM_JID = '31612345678@s.whatsapp.net';
const GROUP_JID = '120363001234567890@g.us';
const PARTICIPANT_JID = '31687654321@s.whatsapp.net';
const SELF_PN_JID = '31600000001:5@s.whatsapp.net';
const SELF_CHAT_JID = '31600000001@s.whatsapp.net';

function makeFakeSocket(): FakeSocket {
  const handlers = new Map<string, EventHandler>();
  return {
    user: { id: SELF_PN_JID, lid: '96490886312027:5@lid' },
    handlers,
    ev: {
      on: (event, handler) => {
        handlers.set(event, handler);
      },
    },
    sendMessage: vi.fn(async () => ({ key: { id: 'SENT-001' } })),
    sendPresenceUpdate: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
  };
}

const startedConnectors: WhatsAppBaileysConnector[] = [];

/**
 * Starts a connector against a fresh fake socket and drives it to the
 * connected/running state by delivering `connection.update: open`, which also
 * populates `selfIds` from `sock.user`.
 */
async function startConnector(
  config: WhatsAppBaileysConfig = {},
): Promise<{ connector: WhatsAppBaileysConnector; sock: FakeSocket; received: InboundEvent[] }> {
  const sock = makeFakeSocket();
  baileysState.socket = sock;

  const connector = new WhatsAppBaileysConnector(config, 'test-baileys', logger);
  // Deregister the rejection shield synchronously on stop().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (connector as any).shieldTeardownGraceMs = 0;
  startedConnectors.push(connector);

  const received: InboundEvent[] = [];
  connector.onMessage(async (event) => {
    received.push(event);
  });

  const started = connector.start();
  // start() registers its handlers after a few awaits (dynamic import, auth
  // state, version fetch); `messages.upsert` is the last one registered.
  await vi.waitFor(
    () => {
      expect(sock.handlers.has('messages.upsert')).toBe(true);
    },
    { interval: 1 },
  );
  sock.handlers.get('connection.update')?.({ connection: 'open' });
  await started;

  return { connector, sock, received };
}

/** Delivers messages through the captured `messages.upsert` handler and drains the chat queue. */
async function fireUpsert(sock: FakeSocket, messages: unknown[], type = 'notify'): Promise<void> {
  const handler = sock.handlers.get('messages.upsert');
  if (handler === undefined) throw new Error('messages.upsert handler was not registered');
  handler({ messages, type });
  // The per-chat queue and the handler run on microtasks only; a macrotask
  // turn guarantees they have all settled.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface KeyOverrides {
  fromMe?: boolean;
  remoteJid?: string;
  id?: string;
  participant?: string;
}

/** Minimal Baileys WAMessage with arbitrary content. */
function makeMsg(content: Record<string, unknown>, key: KeyOverrides = {}): unknown {
  return {
    key: {
      fromMe: key.fromMe ?? false,
      remoteJid: key.remoteJid ?? DM_JID,
      id: key.id ?? 'msg-001',
      ...(key.participant !== undefined ? { participant: key.participant } : {}),
    },
    message: content,
    messageTimestamp: 1700000000,
  };
}

/** A reaction WAMessage: `text` omitted means the field is absent. */
function reactionMsg(
  reaction: { targetId?: string; text?: string } = {},
  key: KeyOverrides = {},
): unknown {
  const text = 'text' in reaction ? reaction.text : '👍';
  return makeMsg(
    {
      reactionMessage: {
        key: { remoteJid: key.remoteJid ?? DM_JID, id: reaction.targetId ?? 'TARGET-001' },
        ...(text !== undefined ? { text } : {}),
      },
    },
    { id: 'reaction-001', ...key },
  );
}

afterEach(async () => {
  for (const connector of startedConnectors.splice(0)) {
    await connector.stop();
  }
  baileysState.socket = undefined;
});

// ---------------------------------------------------------------------------
// Pure helpers: extractQuotedContext
// ---------------------------------------------------------------------------

describe('extractQuotedContext', () => {
  it('reads the quote from extendedTextMessage.contextInfo', () => {
    const result = extractQuotedContext({
      extendedTextMessage: {
        text: 'my reply',
        contextInfo: {
          stanzaId: 'QUOTED-1',
          participant: PARTICIPANT_JID,
          quotedMessage: { conversation: 'original text' },
        },
      },
    });

    expect(result).toStrictEqual({
      externalMessageId: 'QUOTED-1',
      senderId: PARTICIPANT_JID,
      text: 'original text',
    });
  });

  it('reads the quote from imageMessage.contextInfo', () => {
    const result = extractQuotedContext({
      imageMessage: {
        mimetype: 'image/jpeg',
        caption: 'look at this',
        contextInfo: {
          stanzaId: 'QUOTED-2',
          participant: PARTICIPANT_JID,
          quotedMessage: { conversation: 'send me a photo' },
        },
      },
    });

    expect(result).toStrictEqual({
      externalMessageId: 'QUOTED-2',
      senderId: PARTICIPANT_JID,
      text: 'send me a photo',
    });
  });

  it('takes the quoted text from quotedMessage.extendedTextMessage.text', () => {
    const result = extractQuotedContext({
      extendedTextMessage: {
        text: 'my reply',
        contextInfo: {
          stanzaId: 'QUOTED-3',
          participant: PARTICIPANT_JID,
          quotedMessage: { extendedTextMessage: { text: 'extended original' } },
        },
      },
    });

    expect(result).toStrictEqual({
      externalMessageId: 'QUOTED-3',
      senderId: PARTICIPANT_JID,
      text: 'extended original',
    });
  });

  it('takes the quoted text from a quoted imageMessage.caption', () => {
    const result = extractQuotedContext({
      extendedTextMessage: {
        text: 'nice picture',
        contextInfo: {
          stanzaId: 'QUOTED-4',
          participant: PARTICIPANT_JID,
          quotedMessage: { imageMessage: { mimetype: 'image/jpeg', caption: 'holiday photo' } },
        },
      },
    });

    expect(result).toStrictEqual({
      externalMessageId: 'QUOTED-4',
      senderId: PARTICIPANT_JID,
      text: 'holiday photo',
    });
  });

  it('omits senderId and text when the provider delivered neither', () => {
    const result = extractQuotedContext({
      extendedTextMessage: { text: 'my reply', contextInfo: { stanzaId: 'QUOTED-5' } },
    });

    expect(result).toStrictEqual({ externalMessageId: 'QUOTED-5' });
  });

  it('returns undefined when there is no contextInfo', () => {
    expect(extractQuotedContext({ conversation: 'plain text' })).toBeUndefined();
    expect(extractQuotedContext({ extendedTextMessage: { text: 'no quote' } })).toBeUndefined();
  });

  it('returns undefined when stanzaId is missing', () => {
    const result = extractQuotedContext({
      extendedTextMessage: {
        text: 'my reply',
        contextInfo: {
          participant: PARTICIPANT_JID,
          quotedMessage: { conversation: 'original text' },
        },
      },
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when stanzaId is empty', () => {
    const result = extractQuotedContext({
      extendedTextMessage: {
        text: 'my reply',
        contextInfo: {
          stanzaId: '',
          participant: PARTICIPANT_JID,
          quotedMessage: { conversation: 'original text' },
        },
      },
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined for undefined content', () => {
    expect(extractQuotedContext(undefined)).toBeUndefined();
  });

  it('never sets fromSelf, even when the quoted author is known', () => {
    const fromExtendedText = extractQuotedContext({
      extendedTextMessage: {
        text: 'my reply',
        contextInfo: {
          stanzaId: 'QUOTED-6',
          participant: SELF_PN_JID,
          quotedMessage: { conversation: 'something Talon said' },
        },
      },
    });
    const fromImage = extractQuotedContext({
      imageMessage: { contextInfo: { stanzaId: 'QUOTED-7' } },
    });

    expect(fromExtendedText).toBeDefined();
    expect(fromExtendedText).not.toHaveProperty('fromSelf');
    expect(fromImage).toBeDefined();
    expect(fromImage).not.toHaveProperty('fromSelf');
  });
});

// ---------------------------------------------------------------------------
// Pure helpers: extractReaction
// ---------------------------------------------------------------------------

describe('extractReaction', () => {
  it('maps a reactionMessage to its target message ID and emoji', () => {
    const result = extractReaction({ reactionMessage: { key: { id: 'TARGET-1' }, text: '👍' } });

    expect(result).toStrictEqual({ targetMessageId: 'TARGET-1', emoji: '👍' });
  });

  it('reports an empty emoji when the reaction text is empty', () => {
    const result = extractReaction({ reactionMessage: { key: { id: 'TARGET-1' }, text: '' } });

    expect(result).toStrictEqual({ targetMessageId: 'TARGET-1', emoji: '' });
  });

  it('reports an empty emoji when the reaction text is missing', () => {
    const result = extractReaction({ reactionMessage: { key: { id: 'TARGET-1' } } });

    expect(result).toStrictEqual({ targetMessageId: 'TARGET-1', emoji: '' });
  });

  it('returns undefined when there is no reactionMessage', () => {
    expect(extractReaction({ conversation: 'hello' })).toBeUndefined();
    expect(extractReaction(undefined)).toBeUndefined();
  });

  it('returns undefined when the reaction key has no id', () => {
    expect(extractReaction({ reactionMessage: { text: '👍' } })).toBeUndefined();
    expect(extractReaction({ reactionMessage: { key: {}, text: '👍' } })).toBeUndefined();
    expect(extractReaction({ reactionMessage: { key: { id: '' }, text: '👍' } })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pure helpers: buildMessageKey / buildQuotedMessage
// ---------------------------------------------------------------------------

describe('buildMessageKey', () => {
  it('direct chat, own message: fromMe true and no participant', () => {
    const key = buildMessageKey(DM_JID, {
      externalMessageId: 'ABC',
      fromSelf: true,
      author: SELF_PN_JID,
    });

    expect(key).toStrictEqual({ remoteJid: DM_JID, id: 'ABC', fromMe: true });
  });

  it("direct chat, someone else's message: fromMe false and no participant", () => {
    const key = buildMessageKey(DM_JID, {
      externalMessageId: 'ABC',
      fromSelf: false,
      author: DM_JID,
    });

    expect(key).toStrictEqual({ remoteJid: DM_JID, id: 'ABC', fromMe: false });
  });

  it('treats an absent fromSelf as not from self', () => {
    const key = buildMessageKey(DM_JID, { externalMessageId: 'ABC' });

    expect(key).toStrictEqual({ remoteJid: DM_JID, id: 'ABC', fromMe: false });
  });

  it("group, someone else's message with a known author: participant is set", () => {
    const key = buildMessageKey(GROUP_JID, {
      externalMessageId: 'ABC',
      fromSelf: false,
      author: PARTICIPANT_JID,
    });

    expect(key).toStrictEqual({
      remoteJid: GROUP_JID,
      id: 'ABC',
      fromMe: false,
      participant: PARTICIPANT_JID,
    });
  });

  it('group, own message: no participant even when an author is recorded', () => {
    const key = buildMessageKey(GROUP_JID, {
      externalMessageId: 'ABC',
      fromSelf: true,
      author: SELF_PN_JID,
    });

    expect(key).toStrictEqual({ remoteJid: GROUP_JID, id: 'ABC', fromMe: true });
  });

  it('group without a known author: no participant', () => {
    expect(buildMessageKey(GROUP_JID, { externalMessageId: 'ABC', fromSelf: false })).toStrictEqual(
      { remoteJid: GROUP_JID, id: 'ABC', fromMe: false },
    );
    expect(
      buildMessageKey(GROUP_JID, { externalMessageId: 'ABC', fromSelf: false, author: '' }),
    ).toStrictEqual({ remoteJid: GROUP_JID, id: 'ABC', fromMe: false });
  });
});

describe('buildQuotedMessage', () => {
  it('pairs the rebuilt key with the target text as conversation', () => {
    const quoted = buildQuotedMessage(GROUP_JID, {
      externalMessageId: 'ABC',
      fromSelf: false,
      author: PARTICIPANT_JID,
      text: 'the original message',
    });

    expect(quoted).toStrictEqual({
      key: { remoteJid: GROUP_JID, id: 'ABC', fromMe: false, participant: PARTICIPANT_JID },
      message: { conversation: 'the original message' },
    });
  });

  it('uses the same key as buildMessageKey', () => {
    const target = { externalMessageId: 'ABC', fromSelf: true, text: 'mine' };

    expect(buildQuotedMessage(DM_JID, target).key).toStrictEqual(buildMessageKey(DM_JID, target));
  });

  it('uses an empty conversation when the target text is absent', () => {
    const quoted = buildQuotedMessage(DM_JID, { externalMessageId: 'ABC', fromSelf: true });

    expect(quoted).toStrictEqual({
      key: { remoteJid: DM_JID, id: 'ABC', fromMe: true },
      message: { conversation: '' },
    });
  });
});

// ---------------------------------------------------------------------------
// Connector: reaching the running state through the mocked socket
// ---------------------------------------------------------------------------

describe('WhatsAppBaileysConnector replies and reactions', () => {
  describe('start() against the mocked Baileys socket', () => {
    it('registers the socket handlers and captures selfIds on connection open', async () => {
      const { connector, sock } = await startConnector();

      expect([...sock.handlers.keys()].sort()).toEqual([
        'connection.update',
        'creds.update',
        'messages.upsert',
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect([...((connector as any).selfIds as Set<string>)].sort()).toEqual([
        '31600000001',
        '96490886312027',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Inbound: message identity and quoted replies
  // -------------------------------------------------------------------------

  describe('inbound messages', () => {
    it('carries the message key id as externalMessageId on a text message', async () => {
      const { sock, received } = await startConnector();

      await fireUpsert(sock, [makeMsg({ conversation: 'Hello bot!' }, { id: 'WA-MSG-42' })]);

      expect(received).toHaveLength(1);
      expect(received[0].externalMessageId).toBe('WA-MSG-42');
      expect(received[0].idempotencyKey).toBe('WA-MSG-42');
      expect(received[0].content).toBe('Hello bot!');
      expect(received[0]).not.toHaveProperty('replyTo');
      expect(received[0]).not.toHaveProperty('reaction');
    });

    it('ignores upserts that are not of type notify', async () => {
      const { sock, received } = await startConnector();

      await fireUpsert(sock, [makeMsg({ conversation: 'history sync' })], 'append');

      expect(received).toHaveLength(0);
    });

    it('yields replyTo for a quoted reply (extendedTextMessage.contextInfo)', async () => {
      const { sock, received } = await startConnector();

      await fireUpsert(sock, [
        makeMsg(
          {
            extendedTextMessage: {
              text: 'yes, that one',
              contextInfo: {
                stanzaId: 'QUOTED-ID',
                participant: SELF_PN_JID,
                quotedMessage: { conversation: 'Which file do you mean?' },
              },
            },
          },
          { id: 'reply-001' },
        ),
      ]);

      expect(received).toHaveLength(1);
      const event = received[0];
      expect(event.content).toBe('yes, that one');
      expect(event.externalMessageId).toBe('reply-001');
      expect(event.replyTo).toStrictEqual({
        externalMessageId: 'QUOTED-ID',
        senderId: SELF_PN_JID,
        text: 'Which file do you mean?',
      });
    });

    it('yields replyTo for a quoted reply wrapped in an ephemeralMessage container', async () => {
      const { sock, received } = await startConnector();

      await fireUpsert(sock, [
        makeMsg({
          ephemeralMessage: {
            message: {
              extendedTextMessage: {
                text: 'disappearing reply',
                contextInfo: {
                  stanzaId: 'QUOTED-EPH',
                  participant: PARTICIPANT_JID,
                  quotedMessage: { extendedTextMessage: { text: 'original' } },
                },
              },
            },
          },
        }),
      ]);

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('disappearing reply');
      expect(received[0].replyTo).toStrictEqual({
        externalMessageId: 'QUOTED-EPH',
        senderId: PARTICIPANT_JID,
        text: 'original',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Inbound: reactions
  // -------------------------------------------------------------------------

  describe('inbound reactions', () => {
    it('forwards a reaction from an allowed sender as a reaction event', async () => {
      const { sock, received } = await startConnector({ allowedSenders: ['31612345678'] });

      await fireUpsert(sock, [reactionMsg({ targetId: 'TARGET-001', text: '👍' })]);

      expect(received).toHaveLength(1);
      const event = received[0];
      expect(event.reaction).toStrictEqual({ targetMessageId: 'TARGET-001', emoji: '👍' });
      expect(event.content).toBe('');
      expect(event.externalThreadId).toBe(DM_JID);
      expect(event.senderId).toBe(DM_JID);
      expect(event.idempotencyKey).toBe('reaction-001');
      expect(event.channelType).toBe('whatsappBaileys');
      expect(event.channelName).toBe('test-baileys');
      expect(event.timestamp).toBe(1700000000000);
      expect(event).not.toHaveProperty('externalMessageId');
      expect(event).not.toHaveProperty('replyTo');
    });

    it('drops reactions when inboundReactions is false', async () => {
      const { sock, received } = await startConnector({ inboundReactions: false });

      await fireUpsert(sock, [reactionMsg()]);

      expect(received).toHaveLength(0);
    });

    it('drops a reaction removal (empty emoji text)', async () => {
      const { sock, received } = await startConnector();

      await fireUpsert(sock, [reactionMsg({ text: '' })]);

      expect(received).toHaveLength(0);
    });

    it('drops a reaction from a sender that is not in allowedSenders', async () => {
      const { sock, received } = await startConnector({ allowedSenders: ['31612345678'] });

      await fireUpsert(sock, [reactionMsg({}, { remoteJid: '447700900000@s.whatsapp.net' })]);

      expect(received).toHaveLength(0);
    });

    it('drops a fromMe reaction in normal (non-selfChat) mode', async () => {
      const { sock, received } = await startConnector();

      await fireUpsert(sock, [reactionMsg({}, { fromMe: true })]);

      expect(received).toHaveLength(0);
    });

    it('forwards a reaction even when triggerWords are configured', async () => {
      const { sock, received } = await startConnector({ triggerWords: ['@Talon'] });

      await fireUpsert(sock, [reactionMsg({ targetId: 'TARGET-TW', text: '❤️' })]);

      expect(received).toHaveLength(1);
      expect(received[0].reaction).toStrictEqual({ targetMessageId: 'TARGET-TW', emoji: '❤️' });
      expect(received[0].content).toBe('');
    });

    it('forwards a group reaction with the participant as senderId', async () => {
      const { sock, received } = await startConnector({
        allowGroupChats: true,
        triggerWords: ['@Talon'],
      });

      await fireUpsert(sock, [
        reactionMsg(
          { targetId: 'TARGET-GRP', text: '🎉' },
          { remoteJid: GROUP_JID, participant: PARTICIPANT_JID, id: 'group-reaction-001' },
        ),
      ]);

      expect(received).toHaveLength(1);
      const event = received[0];
      expect(event.reaction).toStrictEqual({ targetMessageId: 'TARGET-GRP', emoji: '🎉' });
      expect(event.externalThreadId).toBe(GROUP_JID);
      expect(event.senderId).toBe(PARTICIPANT_JID);
      expect(event.idempotencyKey).toBe('group-reaction-001');
      expect(event.content).toBe('');
      expect(event).not.toHaveProperty('externalMessageId');
    });

    it('forwards a fromMe reaction in the self JID thread in selfChat mode', async () => {
      const { sock, received } = await startConnector({ selfChat: true });

      await fireUpsert(sock, [
        reactionMsg(
          { targetId: 'TARGET-SELF', text: '👀' },
          { fromMe: true, remoteJid: SELF_CHAT_JID, id: 'self-reaction-001' },
        ),
      ]);

      expect(received).toHaveLength(1);
      const event = received[0];
      expect(event.reaction).toStrictEqual({ targetMessageId: 'TARGET-SELF', emoji: '👀' });
      expect(event.externalThreadId).toBe(SELF_CHAT_JID);
      expect(event.idempotencyKey).toBe('self-reaction-001');
      expect(event.content).toBe('');
    });

    it('drops a non-fromMe reaction in selfChat mode', async () => {
      const { sock, received } = await startConnector({ selfChat: true });

      await fireUpsert(sock, [reactionMsg({}, { fromMe: false, remoteJid: SELF_CHAT_JID })]);

      expect(received).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Outbound: send()
  // -------------------------------------------------------------------------

  describe('send()', () => {
    it('returns a receipt with the key id of the sent message', async () => {
      const { connector, sock } = await startConnector();
      sock.sendMessage.mockResolvedValueOnce({ key: { id: 'WA-SENT-77' } });

      const result = await connector.send(DM_JID, { body: 'hello' });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toStrictEqual({ externalMessageId: 'WA-SENT-77' });
    });

    it('resolves to ok(undefined) when sendMessage resolves undefined', async () => {
      const { connector, sock } = await startConnector();
      sock.sendMessage.mockResolvedValueOnce(undefined);

      const result = await connector.send(DM_JID, { body: 'hello' });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeUndefined();
    });

    it('sends without a quote exactly as before when there is no replyTo', async () => {
      const { connector, sock } = await startConnector();

      await connector.send(DM_JID, { body: 'hello' });

      expect(sock.sendMessage).toHaveBeenCalledTimes(1);
      expect(sock.sendMessage.mock.calls[0]).toStrictEqual([DM_JID, { text: 'hello' }]);
    });

    it('quotes an explicit replyTo target', async () => {
      const { connector, sock } = await startConnector();

      await connector.send(DM_JID, {
        body: 'hello',
        replyTo: { externalMessageId: 'ABC', fromSelf: false, text: 'hi' },
      });

      expect(sock.sendMessage).toHaveBeenCalledTimes(1);
      expect(sock.sendMessage.mock.calls[0]).toStrictEqual([
        DM_JID,
        { text: 'hello' },
        {
          quoted: {
            key: { remoteJid: DM_JID, id: 'ABC', fromMe: false },
            message: { conversation: 'hi' },
          },
        },
      ]);
    });

    it('quotes an explicit replyTo target even when replyToTrigger is never', async () => {
      const { connector, sock } = await startConnector({ replyToTrigger: 'never' });

      await connector.send(DM_JID, {
        body: 'hello',
        replyTo: { externalMessageId: 'ABC', fromSelf: true, text: 'earlier answer' },
      });

      expect(sock.sendMessage.mock.calls[0]).toStrictEqual([
        DM_JID,
        { text: 'hello' },
        {
          quoted: {
            key: { remoteJid: DM_JID, id: 'ABC', fromMe: true },
            message: { conversation: 'earlier answer' },
          },
        },
      ]);
    });

    it('default mode: does not quote an implicit replyTo in a direct chat', async () => {
      const { connector, sock } = await startConnector();

      await connector.send(DM_JID, {
        body: 'hello',
        replyTo: { externalMessageId: 'ABC', fromSelf: false, text: 'hi', implicit: true },
      });

      expect(sock.sendMessage).toHaveBeenCalledTimes(1);
      expect(sock.sendMessage.mock.calls[0]).toStrictEqual([DM_JID, { text: 'hello' }]);
    });

    it('default mode: quotes an implicit replyTo in a group chat', async () => {
      const { connector, sock } = await startConnector();

      await connector.send(GROUP_JID, {
        body: 'hello',
        replyTo: {
          externalMessageId: 'ABC',
          fromSelf: false,
          author: PARTICIPANT_JID,
          text: '@Talon hi',
          implicit: true,
        },
      });

      expect(sock.sendMessage).toHaveBeenCalledTimes(1);
      expect(sock.sendMessage.mock.calls[0]).toStrictEqual([
        GROUP_JID,
        { text: 'hello' },
        {
          quoted: {
            key: {
              remoteJid: GROUP_JID,
              id: 'ABC',
              fromMe: false,
              participant: PARTICIPANT_JID,
            },
            message: { conversation: '@Talon hi' },
          },
        },
      ]);
    });

    it('replyToTrigger always: quotes an implicit replyTo in a direct chat', async () => {
      const { connector, sock } = await startConnector({ replyToTrigger: 'always' });

      await connector.send(DM_JID, {
        body: 'hello',
        replyTo: { externalMessageId: 'ABC', fromSelf: false, text: 'hi', implicit: true },
      });

      expect(sock.sendMessage).toHaveBeenCalledTimes(1);
      expect(sock.sendMessage.mock.calls[0]).toStrictEqual([
        DM_JID,
        { text: 'hello' },
        {
          quoted: {
            key: { remoteJid: DM_JID, id: 'ABC', fromMe: false },
            message: { conversation: 'hi' },
          },
        },
      ]);
    });

    it('replyToTrigger never: does not quote an implicit replyTo in a group chat', async () => {
      const { connector, sock } = await startConnector({ replyToTrigger: 'never' });

      await connector.send(GROUP_JID, {
        body: 'hello',
        replyTo: {
          externalMessageId: 'ABC',
          fromSelf: false,
          author: PARTICIPANT_JID,
          text: '@Talon hi',
          implicit: true,
        },
      });

      expect(sock.sendMessage).toHaveBeenCalledTimes(1);
      expect(sock.sendMessage.mock.calls[0]).toStrictEqual([GROUP_JID, { text: 'hello' }]);
    });

    it('still returns the receipt for a quoted send', async () => {
      const { connector, sock } = await startConnector();
      sock.sendMessage.mockResolvedValueOnce({ key: { id: 'WA-QUOTED-SENT' } });

      const result = await connector.send(DM_JID, {
        body: 'hello',
        replyTo: { externalMessageId: 'ABC', fromSelf: false, text: 'hi' },
      });

      expect(result._unsafeUnwrap()).toStrictEqual({ externalMessageId: 'WA-QUOTED-SENT' });
    });

    it('returns Err containing the thrown message when a quoted send rejects', async () => {
      const { connector, sock } = await startConnector();
      sock.sendMessage.mockRejectedValueOnce(new Error('quote exploded'));

      const result = await connector.send(DM_JID, {
        body: 'hello',
        replyTo: { externalMessageId: 'ABC', fromSelf: false, text: 'hi' },
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('quote exploded');
    });
  });

  // -------------------------------------------------------------------------
  // Outbound: react()
  // -------------------------------------------------------------------------

  describe('react()', () => {
    it('sends a react payload keyed on the target message', async () => {
      const { connector, sock } = await startConnector();

      const result = await connector.react(
        DM_JID,
        { externalMessageId: 'TARGET-9', fromSelf: false, author: DM_JID },
        '👍',
      );

      expect(result.isOk()).toBe(true);
      expect(sock.sendMessage).toHaveBeenCalledTimes(1);
      expect(sock.sendMessage.mock.calls[0]).toStrictEqual([
        DM_JID,
        { react: { text: '👍', key: { remoteJid: DM_JID, id: 'TARGET-9', fromMe: false } } },
      ]);
    });

    it("sets fromMe on the key when reacting to one of Talon's own messages", async () => {
      const { connector, sock } = await startConnector();

      await connector.react(DM_JID, { externalMessageId: 'TARGET-9', fromSelf: true }, '👍');

      expect(sock.sendMessage.mock.calls[0]).toStrictEqual([
        DM_JID,
        { react: { text: '👍', key: { remoteJid: DM_JID, id: 'TARGET-9', fromMe: true } } },
      ]);
    });

    it('includes the participant in a group for a non-self target', async () => {
      const { connector, sock } = await startConnector();

      const result = await connector.react(
        GROUP_JID,
        { externalMessageId: 'TARGET-9', fromSelf: false, author: PARTICIPANT_JID },
        '👍',
      );

      expect(result.isOk()).toBe(true);
      expect(sock.sendMessage.mock.calls[0]).toStrictEqual([
        GROUP_JID,
        {
          react: {
            text: '👍',
            key: {
              remoteJid: GROUP_JID,
              id: 'TARGET-9',
              fromMe: false,
              participant: PARTICIPANT_JID,
            },
          },
        },
      ]);
    });

    it('passes an empty text to clear the reaction', async () => {
      const { connector, sock } = await startConnector();

      const result = await connector.react(
        DM_JID,
        { externalMessageId: 'TARGET-9', fromSelf: false },
        '',
      );

      expect(result.isOk()).toBe(true);
      expect(sock.sendMessage.mock.calls[0]).toStrictEqual([
        DM_JID,
        { react: { text: '', key: { remoteJid: DM_JID, id: 'TARGET-9', fromMe: false } } },
      ]);
    });

    it('returns Err when the connector is not running', async () => {
      const connector = new WhatsAppBaileysConnector({}, 'test-baileys', logger);

      const result = await connector.react(DM_JID, { externalMessageId: 'TARGET-9' }, '👍');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('not running');
    });

    it('returns Err after the connector has been stopped', async () => {
      const { connector, sock } = await startConnector();
      await connector.stop();

      const result = await connector.react(DM_JID, { externalMessageId: 'TARGET-9' }, '👍');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('not running');
      expect(sock.sendMessage).not.toHaveBeenCalled();
    });

    it('returns Err containing the thrown message when sendMessage rejects', async () => {
      const { connector, sock } = await startConnector();
      sock.sendMessage.mockRejectedValueOnce(new Error('reaction boom'));

      const result = await connector.react(
        DM_JID,
        { externalMessageId: 'TARGET-9', fromSelf: false },
        '👍',
      );

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('reaction boom');
    });
  });
});
