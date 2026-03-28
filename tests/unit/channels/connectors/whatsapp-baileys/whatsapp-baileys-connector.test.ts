/**
 * Unit tests for the WhatsApp Baileys connector.
 *
 * handleInboundMessage is private, so we call it via (connector as any).
 * No real WhatsApp connection is needed — all tests exercise the message
 * filtering and normalisation logic directly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { WhatsAppBaileysConnector } from '../../../../../src/channels/connectors/whatsapp-baileys/whatsapp-baileys-connector.js';
import { markdownToWhatsApp } from '../../../../../src/channels/connectors/whatsapp-business/whatsapp-format.js';
import type { WhatsAppBaileysConfig } from '../../../../../src/channels/connectors/whatsapp-baileys/whatsapp-baileys-types.js';
import type { InboundEvent } from '../../../../../src/channels/channel-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logger = pino({ level: 'silent' });

function makeConnector(config: WhatsAppBaileysConfig = {}): WhatsAppBaileysConnector {
  return new WhatsAppBaileysConnector(config, 'test-baileys', logger);
}

/** Minimal Baileys WAMessage shape for handleInboundMessage. */
function makeMsg(overrides: {
  fromMe?: boolean;
  remoteJid?: string;
  id?: string;
  text?: string;
  extendedText?: string;
  messageType?: string;
  timestamp?: number;
} = {}): unknown {
  const message: Record<string, unknown> = {};
  if (overrides.text !== undefined) {
    message['conversation'] = overrides.text;
  } else if (overrides.extendedText !== undefined) {
    message['extendedTextMessage'] = { text: overrides.extendedText };
  } else if (overrides.messageType !== undefined) {
    message[overrides.messageType] = {};
  } else {
    message['conversation'] = 'hello';
  }
  return {
    key: {
      fromMe: overrides.fromMe ?? false,
      remoteJid: overrides.remoteJid ?? '31612345678@s.whatsapp.net',
      id: overrides.id ?? 'msg-001',
    },
    message,
    messageTimestamp: overrides.timestamp ?? 1700000000,
  };
}

/** Invoke the private handleInboundMessage method. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handle(connector: WhatsAppBaileysConnector, msg: unknown): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (connector as any).handleInboundMessage(msg);
}

/** Set the private selfIds set (normally populated on connect). */
function setSelfIds(connector: WhatsAppBaileysConnector, ...ids: string[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selfIds = (connector as any).selfIds as Set<string>;
  selfIds.clear();
  for (const id of ids) {
    selfIds.add(id.replace(/@.*$/, '').replace(/:\d+$/, ''));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WhatsAppBaileysConnector', () => {
  let connector: WhatsAppBaileysConnector;

  beforeEach(() => {
    connector = makeConnector();
  });

  // -------------------------------------------------------------------------
  // Constructor / metadata
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('has type "whatsappBaileys"', () => {
      expect(connector.type).toBe('whatsappBaileys');
    });

    it('has the configured channel name', () => {
      expect(connector.name).toBe('test-baileys');
    });
  });

  // -------------------------------------------------------------------------
  // stop() idempotency
  // -------------------------------------------------------------------------

  it('stop() is idempotent when not running', async () => {
    await connector.stop();
    await connector.stop();
  });

  // -------------------------------------------------------------------------
  // format()
  // -------------------------------------------------------------------------

  it('format() delegates to markdownToWhatsApp', () => {
    const input = '**bold** and _italic_';
    expect(connector.format(input)).toBe(markdownToWhatsApp(input));
  });

  // -------------------------------------------------------------------------
  // send() when not running
  // -------------------------------------------------------------------------

  it('send() returns err when not running', async () => {
    const result = await connector.send('123@s.whatsapp.net', { body: 'hello' });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('not running');
    }
  });

  // -------------------------------------------------------------------------
  // Normal mode — basic message handling
  // -------------------------------------------------------------------------

  describe('normal mode — message handling', () => {
    it('forwards a text message as a normalised InboundEvent', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });

      await handle(connector, makeMsg({ text: 'Hello bot!' }));

      expect(received).toHaveLength(1);
      const event = received[0];
      expect(event.channelType).toBe('whatsappBaileys');
      expect(event.channelName).toBe('test-baileys');
      expect(event.externalThreadId).toBe('31612345678@s.whatsapp.net');
      expect(event.senderId).toBe('31612345678@s.whatsapp.net');
      expect(event.idempotencyKey).toBe('msg-001');
      expect(event.content).toBe('Hello bot!');
      expect(event.timestamp).toBe(1700000000000); // seconds → ms
    });

    it('extracts text from extendedTextMessage', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });

      await handle(connector, makeMsg({ extendedText: 'extended content' }));

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('extended content');
    });

    it('drops fromMe messages in normal mode', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });

      await handle(connector, makeMsg({ fromMe: true }));

      expect(received).toHaveLength(0);
    });

    it('drops messages with no message object', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });

      await handle(connector, { key: { remoteJid: '123@s.whatsapp.net', id: 'x' }, message: null });

      expect(received).toHaveLength(0);
    });

    it('drops messages with no remoteJid', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });

      await handle(connector, { key: { fromMe: false, remoteJid: null, id: 'x' }, message: { conversation: 'hi' } });

      expect(received).toHaveLength(0);
    });

    it('drops group messages (@g.us)', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });

      await handle(connector, makeMsg({ remoteJid: '120363001234567890@g.us' }));

      expect(received).toHaveLength(0);
    });

    it('drops non-text messages (e.g. imageMessage)', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });

      await handle(connector, makeMsg({ messageType: 'imageMessage' }));

      expect(received).toHaveLength(0);
    });

    it('logs a warning when no handler is registered', async () => {
      // No onMessage called — handler is undefined.
      // Should not throw.
      await handle(connector, makeMsg());
    });
  });

  // -------------------------------------------------------------------------
  // allowedSenders filtering
  // -------------------------------------------------------------------------

  describe('allowedSenders filtering', () => {
    it('drops messages from senders not in the allowlist', async () => {
      const c = makeConnector({ allowedSenders: ['31612345678'] });
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ remoteJid: '447700900000@s.whatsapp.net' }));

      expect(received).toHaveLength(0);
    });

    it('accepts messages from senders in the allowlist', async () => {
      const c = makeConnector({ allowedSenders: ['31612345678'] });
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ remoteJid: '31612345678@s.whatsapp.net' }));

      expect(received).toHaveLength(1);
    });

    it('strips :device suffix when matching against allowlist', async () => {
      const c = makeConnector({ allowedSenders: ['31612345678'] });
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ remoteJid: '31612345678:42@s.whatsapp.net' }));

      expect(received).toHaveLength(1);
    });

    it('handles LID-format JIDs (@lid)', async () => {
      const c = makeConnector({ allowedSenders: ['96490886312027'] });
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ remoteJid: '96490886312027@lid' }));

      expect(received).toHaveLength(1);
    });

    it('drops LID JIDs not in allowlist', async () => {
      const c = makeConnector({ allowedSenders: ['96490886312027'] });
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ remoteJid: '11111111111111@lid' }));

      expect(received).toHaveLength(0);
    });

    it('allows all senders when allowedSenders is empty', async () => {
      const c = makeConnector({ allowedSenders: [] });
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ remoteJid: '999@s.whatsapp.net' }));

      expect(received).toHaveLength(1);
    });

    it('allows all senders when allowedSenders is omitted', async () => {
      const c = makeConnector({});
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ remoteJid: '999@s.whatsapp.net' }));

      expect(received).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Self-chat mode
  // -------------------------------------------------------------------------

  describe('selfChat mode', () => {
    it('accepts fromMe messages in the self-JID thread', async () => {
      const c = makeConnector({ selfChat: true });
      setSelfIds(c, '31612345678:5@s.whatsapp.net');
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ fromMe: true, remoteJid: '31612345678@s.whatsapp.net' }));

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('hello');
    });

    it('matches self-JID ignoring :device suffix on both sides', async () => {
      const c = makeConnector({ selfChat: true });
      setSelfIds(c, '31612345678:5@s.whatsapp.net');
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ fromMe: true, remoteJid: '31612345678:99@s.whatsapp.net' }));

      expect(received).toHaveLength(1);
    });

    it('rejects messages from other JIDs in self-chat mode', async () => {
      const c = makeConnector({ selfChat: true });
      setSelfIds(c, '31612345678:5@s.whatsapp.net');
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ fromMe: false, remoteJid: '447700900000@s.whatsapp.net' }));

      expect(received).toHaveLength(0);
    });

    it('rejects non-fromMe messages in self-chat thread', async () => {
      const c = makeConnector({ selfChat: true });
      setSelfIds(c, '31612345678:5@s.whatsapp.net');
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      // Someone else's message somehow appears in the self-JID thread
      await handle(c, makeMsg({ fromMe: false, remoteJid: '31612345678@s.whatsapp.net' }));

      expect(received).toHaveLength(0);
    });

    it('drops messages when selfIds is empty (not connected)', async () => {
      const c = makeConnector({ selfChat: true });
      // selfIds is empty by default
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ fromMe: true }));

      expect(received).toHaveLength(0);
    });

    it('ignores allowedSenders in self-chat mode', async () => {
      const c = makeConnector({ selfChat: true, allowedSenders: ['999'] });
      setSelfIds(c, '31612345678:5@s.whatsapp.net');
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      // The message JID doesn't match allowedSenders, but selfChat bypasses that check.
      await handle(c, makeMsg({ fromMe: true, remoteJid: '31612345678@s.whatsapp.net' }));

      expect(received).toHaveLength(1);
    });

    it('works with LID-format selfIds', async () => {
      const c = makeConnector({ selfChat: true });
      setSelfIds(c, '96490886312027@lid');
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ fromMe: true, remoteJid: '96490886312027@lid' }));

      expect(received).toHaveLength(1);
    });

    it('matches when PN selfId is set but message arrives as LID (dual identity)', async () => {
      const c = makeConnector({ selfChat: true });
      // Simulate sock.user.id = PN, sock.user.lid = LID (both captured on connect)
      setSelfIds(c, '31624544584:49@s.whatsapp.net', '96490886312027:49@lid');
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      // Message arrives under LID
      await handle(c, makeMsg({ fromMe: true, remoteJid: '96490886312027@lid' }));

      expect(received).toHaveLength(1);
    });

    it('matches when message arrives under PN but LID is also in selfIds', async () => {
      const c = makeConnector({ selfChat: true });
      setSelfIds(c, '31624544584:49@s.whatsapp.net', '96490886312027:49@lid');
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      // Message arrives under PN
      await handle(c, makeMsg({ fromMe: true, remoteJid: '31624544584@s.whatsapp.net' }));

      expect(received).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Trigger words
  // -------------------------------------------------------------------------

  describe('triggerWords filtering', () => {
    it('accepts messages starting with a trigger word and strips it', async () => {
      const c = makeConnector({ triggerWords: ['@Talon'] });
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ text: '@Talon what is the weather?' }));

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('what is the weather?');
    });

    it('is case-insensitive', async () => {
      const c = makeConnector({ triggerWords: ['@Talon'] });
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ text: '@talon do something' }));

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('do something');
    });

    it('drops messages that do not start with a trigger word', async () => {
      const c = makeConnector({ triggerWords: ['@Talon'] });
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ text: 'just a normal message' }));

      expect(received).toHaveLength(0);
    });

    it('drops messages that contain the trigger but not at the start', async () => {
      const c = makeConnector({ triggerWords: ['@Talon'] });
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ text: 'hey @Talon do something' }));

      expect(received).toHaveLength(0);
    });

    it('drops trigger-word-only messages (no content after stripping)', async () => {
      const c = makeConnector({ triggerWords: ['@Talon'] });
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ text: '@Talon' }));

      expect(received).toHaveLength(0);
    });

    it('drops trigger word followed by only whitespace', async () => {
      const c = makeConnector({ triggerWords: ['@Talon'] });
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ text: '@Talon   ' }));

      expect(received).toHaveLength(0);
    });

    it('matches the first applicable trigger from multiple options', async () => {
      const c = makeConnector({ triggerWords: ['@Bot', '@Talon'] });
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ text: '@Bot help me' }));

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('help me');
    });

    it('passes all messages when triggerWords is empty', async () => {
      const c = makeConnector({ triggerWords: [] });
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ text: 'no trigger needed' }));

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('no trigger needed');
    });

    it('passes all messages when triggerWords is omitted', async () => {
      const c = makeConnector({});
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({ text: 'no trigger needed' }));

      expect(received).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Combined: selfChat + triggerWords
  // -------------------------------------------------------------------------

  describe('selfChat + triggerWords combined', () => {
    it('accepts self-chat messages with trigger word and strips it', async () => {
      const c = makeConnector({ selfChat: true, triggerWords: ['@Talon'] });
      setSelfIds(c, '31612345678:5@s.whatsapp.net');
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({
        fromMe: true,
        remoteJid: '31612345678@s.whatsapp.net',
        text: '@Talon remind me to buy milk',
      }));

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('remind me to buy milk');
    });

    it('drops self-chat messages without trigger word', async () => {
      const c = makeConnector({ selfChat: true, triggerWords: ['@Talon'] });
      setSelfIds(c, '31612345678:5@s.whatsapp.net');
      const received: InboundEvent[] = [];
      c.onMessage(async (event) => { received.push(event); });

      await handle(c, makeMsg({
        fromMe: true,
        remoteJid: '31612345678@s.whatsapp.net',
        text: 'just a note to self',
      }));

      expect(received).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Handler error resilience
  // -------------------------------------------------------------------------

  describe('handler error resilience', () => {
    it('does not throw when handler throws', async () => {
      connector.onMessage(async () => {
        throw new Error('handler blew up');
      });

      // Should not reject.
      await handle(connector, makeMsg());
    });
  });
});
