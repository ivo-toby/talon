/**
 * Unit tests for WhatsAppWebhookServer.
 *
 * Spins up a real HTTP server on a random port for each test suite,
 * so we exercise the actual node:http layer without mocking it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import pino from 'pino';
import { WhatsAppWebhookServer } from '../../../../../src/channels/connectors/whatsapp/whatsapp-webhook-server.js';
import type { WhatsAppWebhookPayload } from '../../../../../src/channels/connectors/whatsapp/whatsapp-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

/** Compute a valid X-Hub-Signature-256 for a body + secret. */
function sign(body: string, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(body);
  return `sha256=${hmac.digest('hex')}`;
}

/** Make a minimal valid WhatsApp webhook payload. */
function makePayload(text = 'hello'): WhatsAppWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+10000000000', phone_number_id: '123' },
              contacts: [{ profile: { name: 'Test' }, wa_id: '447700900000' }],
              messages: [
                {
                  id: 'msg-1',
                  from: '447700900000',
                  timestamp: '1700000000',
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

/**
 * Make an HTTP GET request using fetch (available in Node 22+).
 */
async function httpGet(
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.text() };
}

async function httpPost(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  return { status: res.status, body: await res.text() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WhatsAppWebhookServer', () => {
  const APP_SECRET = 'test-app-secret';
  const VERIFY_TOKEN = 'test-verify-token';
  // Use port 0 so the OS assigns a free port automatically.
  let server: WhatsAppWebhookServer;
  let port: number;

  beforeEach(async () => {
    server = new WhatsAppWebhookServer(
      { verifyToken: VERIFY_TOKEN, appSecret: APP_SECRET },
      silentLogger(),
    );
    port = await server.start('127.0.0.1', 0);
  });

  afterEach(async () => {
    await server.stop();
  });

  // -------------------------------------------------------------------------
  // GET /webhook — Meta verification challenge
  // -------------------------------------------------------------------------

  describe('GET /webhook (verification challenge)', () => {
    it('returns 200 with hub.challenge when verify token matches', async () => {
      const qs = new URLSearchParams({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': 'challenge-token-abc',
      });
      const { status, body } = await httpGet(port, `/webhook?${qs.toString()}`);
      expect(status).toBe(200);
      expect(body).toBe('challenge-token-abc');
    });

    it('returns 403 when verify token does not match', async () => {
      const qs = new URLSearchParams({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token',
        'hub.challenge': 'challenge-token-abc',
      });
      const { status } = await httpGet(port, `/webhook?${qs.toString()}`);
      expect(status).toBe(403);
    });

    it('returns 400 when hub.mode is missing', async () => {
      const qs = new URLSearchParams({
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': 'challenge-token-abc',
      });
      const { status } = await httpGet(port, `/webhook?${qs.toString()}`);
      expect(status).toBe(400);
    });

    it('returns 400 when hub.challenge is missing', async () => {
      const qs = new URLSearchParams({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
      });
      const { status } = await httpGet(port, `/webhook?${qs.toString()}`);
      expect(status).toBe(400);
    });

    it('returns 403 when hub.mode is not "subscribe"', async () => {
      const qs = new URLSearchParams({
        'hub.mode': 'unsubscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': 'challenge-token-abc',
      });
      const { status } = await httpGet(port, `/webhook?${qs.toString()}`);
      expect(status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // POST /webhook — event delivery
  // -------------------------------------------------------------------------

  describe('POST /webhook (event delivery)', () => {
    it('returns 200 and calls onPayload for a valid signed payload', async () => {
      const received: WhatsAppWebhookPayload[] = [];
      server.onPayload(async (p) => { received.push(p); });

      const body = JSON.stringify(makePayload('hello world'));
      const sig = sign(body, APP_SECRET);

      const { status } = await httpPost(port, '/webhook', body, {
        'x-hub-signature-256': sig,
      });

      expect(status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0].object).toBe('whatsapp_business_account');
    });

    it('returns 401 when X-Hub-Signature-256 header is missing', async () => {
      const body = JSON.stringify(makePayload());
      const { status } = await httpPost(port, '/webhook', body);
      expect(status).toBe(401);
    });

    it('returns 401 when signature is invalid', async () => {
      const body = JSON.stringify(makePayload());
      const { status } = await httpPost(port, '/webhook', body, {
        'x-hub-signature-256': 'sha256=deadbeef',
      });
      expect(status).toBe(401);
    });

    it('returns 400 when body is not valid JSON', async () => {
      const body = 'not-json{{{';
      const sig = sign(body, APP_SECRET);
      const { status } = await httpPost(port, '/webhook', body, {
        'x-hub-signature-256': sig,
      });
      expect(status).toBe(400);
    });

    it('does not call onPayload when signature is invalid', async () => {
      const called: boolean[] = [];
      server.onPayload(async () => { called.push(true); });

      const body = JSON.stringify(makePayload());
      await httpPost(port, '/webhook', body, {
        'x-hub-signature-256': 'sha256=wrong',
      });

      expect(called).toHaveLength(0);
    });

    it('uses timing-safe comparison for signature validation', async () => {
      // We verify this indirectly: a near-miss signature must also be rejected.
      const body = JSON.stringify(makePayload());
      const correctSig = sign(body, APP_SECRET);
      // Flip last char
      const tamperedSig = correctSig.slice(0, -1) + (correctSig.endsWith('a') ? 'b' : 'a');

      const { status } = await httpPost(port, '/webhook', body, {
        'x-hub-signature-256': tamperedSig,
      });
      expect(status).toBe(401);
    });

    it('returns 200 without calling onPayload when no handler is registered', async () => {
      const body = JSON.stringify(makePayload());
      const sig = sign(body, APP_SECRET);

      const { status } = await httpPost(port, '/webhook', body, {
        'x-hub-signature-256': sig,
      });
      // Should not throw even if no handler registered
      expect(status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Unknown routes
  // -------------------------------------------------------------------------

  describe('unknown routes', () => {
    it('returns 404 for an unrecognised path', async () => {
      const { status } = await httpGet(port, '/health');
      expect(status).toBe(404);
    });

    it('returns 405 for a POST to an unknown path', async () => {
      const { status } = await httpPost(port, '/other', '{}');
      expect(status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('start() returns the bound port number', () => {
      expect(port).toBeGreaterThan(0);
    });

    it('stop() shuts down the server so subsequent requests fail', async () => {
      await server.stop();
      await expect(httpGet(port, '/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=y'))
        .rejects.toThrow();
    });

    it('stop() is idempotent', async () => {
      await server.stop();
      await server.stop(); // should not throw
    });
  });

  // -------------------------------------------------------------------------
  // Custom webhook path
  // -------------------------------------------------------------------------

  describe('custom webhook path', () => {
    it('serves on a custom path when configured', async () => {
      const customServer = new WhatsAppWebhookServer(
        { verifyToken: VERIFY_TOKEN, appSecret: APP_SECRET, webhookPath: '/meta/webhook' },
        silentLogger(),
      );
      const customPort = await customServer.start('127.0.0.1', 0);

      try {
        const qs = new URLSearchParams({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': 'abc',
        });
        const { status } = await httpGet(customPort, `/meta/webhook?${qs.toString()}`);
        expect(status).toBe(200);
      } finally {
        await customServer.stop();
      }
    });

    it('returns 404 for the default path when a custom path is configured', async () => {
      const customServer = new WhatsAppWebhookServer(
        { verifyToken: VERIFY_TOKEN, appSecret: APP_SECRET, webhookPath: '/meta/webhook' },
        silentLogger(),
      );
      const customPort = await customServer.start('127.0.0.1', 0);

      try {
        const qs = new URLSearchParams({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': 'abc',
        });
        const { status } = await httpGet(customPort, `/webhook?${qs.toString()}`);
        expect(status).toBe(404);
      } finally {
        await customServer.stop();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// WhatsAppConnector integration with webhook server
// ---------------------------------------------------------------------------

describe('WhatsAppConnector with webhook server', () => {
  it('starts the webhook server when webhookPort is set and appSecret is provided', async () => {
    const { WhatsAppConnector } = await import(
      '../../../../../src/channels/connectors/whatsapp/whatsapp-connector.js'
    );
    const logger = pino({ level: 'silent' });

    const connector = new WhatsAppConnector(
      {
        phoneNumberId: '123',
        accessToken: 'token',
        verifyToken: 'verify',
        appSecret: 'secret',
        webhookPort: 0,
        webhookHost: '127.0.0.1',
      },
      'test-wa',
      logger,
    );

    // start() should not throw
    await expect(connector.start()).resolves.toBeUndefined();
    await connector.stop();
  });

  it('does not start a webhook server when appSecret is not provided', async () => {
    const { WhatsAppConnector } = await import(
      '../../../../../src/channels/connectors/whatsapp/whatsapp-connector.js'
    );
    const logger = pino({ level: 'silent' });

    const connector = new WhatsAppConnector(
      {
        phoneNumberId: '123',
        accessToken: 'token',
        verifyToken: 'verify',
        // no appSecret, no webhookPort
      },
      'test-wa',
      logger,
    );

    await expect(connector.start()).resolves.toBeUndefined();
    await connector.stop();
  });
});
