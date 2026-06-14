/**
 * Unit tests for Telegram bot-self filtering.
 *
 * Verifies that messages from bots and sibling bot IDs are dropped,
 * while messages from regular users pass through.
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

function defaultConfig(): TelegramConfig {
  return {
    botToken: 'test-token',
    pollingTimeoutSec: 1,
  };
}

/** Build a TelegramUpdate with optional is_bot and userId fields. */
function makeUpdate(
  updateId: number,
  chatId: number,
  text: string,
  opts: { userId?: number; isBot?: boolean } = {},
): object {
  const userId = opts.userId ?? 999;
  const from: Record<string, unknown> = {
    id: userId,
    first_name: 'Test',
    username: 'testuser',
  };
  if (opts.isBot !== undefined) {
    from.is_bot = opts.isBot;
  }
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      from,
      chat: { id: chatId, type: 'private' },
      date: 1_700_000_000,
      text,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Telegram bot-self filtering', () => {
  let connector: TelegramConnector;

  beforeEach(() => {
    connector = new TelegramConnector(defaultConfig(), 'filter-bot', silentLogger());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // is_bot filtering
  // -------------------------------------------------------------------------

  describe('is_bot filtering', () => {
    it('drops messages where from.is_bot is true', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => received.push(event));

      const update = makeUpdate(1, 100, 'bot message', { isBot: true });
      await connector.handleUpdatePublic(update);

      expect(received).toHaveLength(0);
    });

    it('allows messages where from.is_bot is false', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => received.push(event));

      const update = makeUpdate(2, 100, 'human message', { isBot: false });
      await connector.handleUpdatePublic(update);

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('human message');
    });

    it('allows messages where from.is_bot is undefined (backward compat)', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => received.push(event));

      // No isBot option means is_bot is not set on the from object
      const update = makeUpdate(3, 100, 'legacy message');
      await connector.handleUpdatePublic(update);

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('legacy message');
    });
  });

  // -------------------------------------------------------------------------
  // Sibling bot ID filtering
  // -------------------------------------------------------------------------

  describe('sibling bot ID filtering', () => {
    it('drops messages from sibling bot IDs', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => received.push(event));

      // Register a sibling bot ID
      connector.setSiblingBotIds(new Set(['777']));

      const update = makeUpdate(4, 100, 'sibling bot message', {
        userId: 777,
        isBot: false,
      });
      await connector.handleUpdatePublic(update);

      expect(received).toHaveLength(0);
    });

    it('allows messages from non-sibling users', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => received.push(event));

      connector.setSiblingBotIds(new Set(['777']));

      const update = makeUpdate(5, 100, 'regular user', {
        userId: 888,
        isBot: false,
      });
      await connector.handleUpdatePublic(update);

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('regular user');
    });
  });

  // -------------------------------------------------------------------------
  // botUserId getter
  // -------------------------------------------------------------------------

  describe('botUserId', () => {
    it('is undefined before start()', () => {
      expect(connector.botUserId).toBeUndefined();
    });

    it('is populated after successful getMe during start()', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (typeof url === 'string' && url.endsWith('/getMe')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                ok: true,
                result: { id: 42, is_bot: true, first_name: 'Bot', username: 'mybot' },
              }),
          } as Response);
        }
        // Hang for getUpdates until aborted.
        return new Promise((_resolve, reject) => {
          if (opts?.signal) {
            opts.signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      await connector.start();
      expect(connector.botUserId).toBe('42');
      await connector.stop();
    });

    it('remains undefined when getMe fails', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (typeof url === 'string' && url.endsWith('/getMe')) {
          return Promise.reject(new Error('network failure'));
        }
        return new Promise((_resolve, reject) => {
          if (opts?.signal) {
            opts.signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      await connector.start();
      expect(connector.botUserId).toBeUndefined();
      await connector.stop();
    });

    it('remains undefined when getMe returns ok=false', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (typeof url === 'string' && url.endsWith('/getMe')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ ok: false, error_code: 401, description: 'Unauthorized' }),
          } as Response);
        }
        return new Promise((_resolve, reject) => {
          if (opts?.signal) {
            opts.signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      await connector.start();
      expect(connector.botUserId).toBeUndefined();
      await connector.stop();
    });
  });
});
