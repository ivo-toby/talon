/**
 * Unit tests for the WhatsApp Baileys connector.
 *
 * All tests mock @whiskeysockets/baileys so no real WhatsApp connection is needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { WhatsAppBaileysConnector } from '../../../../../src/channels/connectors/whatsapp-baileys/whatsapp-baileys-connector.js';
import { markdownToWhatsApp } from '../../../../../src/channels/connectors/whatsapp-business/whatsapp-format.js';

const logger = pino({ level: 'silent' });

describe('WhatsAppBaileysConnector', () => {
  let connector: WhatsAppBaileysConnector;

  beforeEach(() => {
    connector = new WhatsAppBaileysConnector({}, 'test-baileys', logger);
  });

  it('has type "whatsappBaileys"', () => {
    expect(connector.type).toBe('whatsappBaileys');
  });

  it('has the configured channel name', () => {
    expect(connector.name).toBe('test-baileys');
  });

  it('stop() is idempotent when not running', async () => {
    // Should not throw when called multiple times on a stopped connector
    await connector.stop();
    await connector.stop();
  });

  it('format() delegates to markdownToWhatsApp', () => {
    const input = '**bold** and _italic_';
    expect(connector.format(input)).toBe(markdownToWhatsApp(input));
  });

  it('send() returns err when not running', async () => {
    const result = await connector.send('123@s.whatsapp.net', { body: 'hello' });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('not running');
    }
  });

  it('onMessage() registers a handler', () => {
    const handler = vi.fn();
    // Should not throw
    connector.onMessage(handler);
  });

  it('exposes correct type on a new instance', () => {
    const other = new WhatsAppBaileysConnector({}, 'other', logger);
    expect(other.type).toBe('whatsappBaileys');
  });
});
