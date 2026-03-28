/**
 * Unit tests for channel-factory createConnector().
 *
 * All connector constructors are mocked so tests never instantiate real
 * connectors or require credentials.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';

// ---------------------------------------------------------------------------
// Module-level mocks — declared before imports that reference them.
// ---------------------------------------------------------------------------

vi.mock('../../../src/channels/connectors/telegram/telegram-connector.js', () => ({
  TelegramConnector: vi.fn().mockImplementation(() => ({ type: 'telegram' })),
}));

vi.mock('../../../src/channels/connectors/slack/slack-connector.js', () => ({
  SlackConnector: vi.fn().mockImplementation(() => ({ type: 'slack' })),
}));

vi.mock('../../../src/channels/connectors/discord/discord-connector.js', () => ({
  DiscordConnector: vi.fn().mockImplementation(() => ({ type: 'discord' })),
}));

vi.mock('../../../src/channels/connectors/whatsapp-business/whatsapp-connector.js', () => ({
  WhatsAppConnector: vi.fn().mockImplementation(() => ({ type: 'whatsappBusiness' })),
}));

vi.mock('../../../src/channels/connectors/whatsapp-baileys/whatsapp-baileys-connector.js', () => ({
  WhatsAppBaileysConnector: vi.fn().mockImplementation(() => ({ type: 'whatsappBaileys' })),
}));

vi.mock('../../../src/channels/connectors/email/email-connector.js', () => ({
  EmailConnector: vi.fn().mockImplementation(() => ({ type: 'email' })),
}));

vi.mock('../../../src/channels/connectors/terminal/terminal-connector.js', () => ({
  TerminalConnector: vi.fn().mockImplementation(() => ({ type: 'terminal' })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createConnector } from '../../../src/daemon/channel-factory.js';
import { TelegramConnector } from '../../../src/channels/connectors/telegram/telegram-connector.js';
import { SlackConnector } from '../../../src/channels/connectors/slack/slack-connector.js';
import { DiscordConnector } from '../../../src/channels/connectors/discord/discord-connector.js';
import { WhatsAppConnector } from '../../../src/channels/connectors/whatsapp-business/whatsapp-connector.js';
import { WhatsAppBaileysConnector } from '../../../src/channels/connectors/whatsapp-baileys/whatsapp-baileys-connector.js';
import { EmailConnector } from '../../../src/channels/connectors/email/email-connector.js';
import { TerminalConnector } from '../../../src/channels/connectors/terminal/terminal-connector.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createConnector', () => {
  let logger: pino.Logger;
  const config: Record<string, unknown> = { token: 'fake-token' };
  const name = 'test-channel';

  beforeEach(() => {
    logger = createSilentLogger();
    vi.clearAllMocks();
  });

  it('creates TelegramConnector for type "telegram"', () => {
    const connector = createConnector('telegram', name, config, logger);

    expect(connector).not.toBeNull();
    expect(TelegramConnector).toHaveBeenCalledWith(config, name, logger);
  });

  it('creates SlackConnector for type "slack"', () => {
    const connector = createConnector('slack', name, config, logger);

    expect(connector).not.toBeNull();
    expect(SlackConnector).toHaveBeenCalledWith(config, name, logger);
  });

  it('creates DiscordConnector for type "discord"', () => {
    const connector = createConnector('discord', name, config, logger);

    expect(connector).not.toBeNull();
    expect(DiscordConnector).toHaveBeenCalledWith(config, name, logger);
  });

  it('creates WhatsAppConnector for type "whatsapp"', () => {
    const connector = createConnector('whatsapp', name, config, logger);

    expect(connector).not.toBeNull();
    expect(WhatsAppConnector).toHaveBeenCalledWith(config, name, logger);
  });

  it('creates WhatsAppConnector for type "whatsappBusiness"', () => {
    const connector = createConnector('whatsappBusiness', name, config, logger);

    expect(connector).not.toBeNull();
    expect(WhatsAppConnector).toHaveBeenCalledWith(config, name, logger);
  });

  it('creates WhatsAppBaileysConnector for type "whatsappBaileys"', () => {
    const connector = createConnector('whatsappBaileys', name, config, logger);

    expect(connector).not.toBeNull();
    expect(WhatsAppBaileysConnector).toHaveBeenCalledWith(config, name, logger);
  });

  it('creates EmailConnector for type "email"', () => {
    const connector = createConnector('email', name, config, logger);

    expect(connector).not.toBeNull();
    expect(EmailConnector).toHaveBeenCalledWith(config, name, logger);
  });

  it('creates TerminalConnector for type "terminal"', () => {
    const connector = createConnector('terminal', name, config, logger);

    expect(connector).not.toBeNull();
    expect(TerminalConnector).toHaveBeenCalledWith(config, name, logger);
  });

  it('returns null for unknown type', () => {
    const connector = createConnector('carrier-pigeon', name, config, logger);

    expect(connector).toBeNull();
  });

  it('returns null for empty string type', () => {
    const connector = createConnector('', name, config, logger);

    expect(connector).toBeNull();
  });
});
