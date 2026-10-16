import { createHmac } from 'node:crypto';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { ok } from '../../../../../src/core/types/result.js';
import {
  SipWebhookServer,
  SIP_WEBHOOK_DEFAULT_PATH,
  __private,
} from '../../../../../src/voice/transports/sip/sip-webhook-server.js';

const secret = `whsec_${Buffer.from('test-webhook-secret').toString('base64')}`;
const activeServers: SipWebhookServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.stop()));
});

function event(eventId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: eventId,
    created_at: Math.floor(Date.now() / 1_000),
    type: 'live.transport.incoming',
    object: 'event',
    data: {
      type: 'sip',
      session_id: 'provider-session-1',
      sip_headers: [
        { name: 'From', value: 'sip:forged@example.test' },
        { name: 'X-Talon-Voice-Assertion', value: 'talon-sip-v1.proof.signature' },
        { name: 'X-Custom', value: 'preserve-me' },
      ],
      ...overrides,
    },
  });
}

function signature(deliveryId: string, timestamp: string, body: string): string {
  const encodedSecret = secret.slice('whsec_'.length);
  const digest = createHmac('sha256', Buffer.from(encodedSecret, 'base64'))
    .update(`${deliveryId}.${timestamp}.`, 'utf8')
    .update(Buffer.from(body, 'utf8'))
    .digest('base64');
  return `v1,${digest}`;
}

function fakeIngress() {
  return {
    ingest: vi.fn().mockResolvedValue(
      ok({
        outcome: 'reserved',
        duplicate: false,
        externalAttempted: false,
      }),
    ),
  };
}

describe('SipWebhookServer', () => {
  it('is inert unless explicitly enabled', async () => {
    const server = new SipWebhookServer({}, { ingress: fakeIngress() as never });
    expect(await server.start()).toBe(0);
    expect(server.port).toBe(0);
  });

  it('authenticates raw Standard Webhooks bytes before handing over the documented SIP event', async () => {
    const ingress = fakeIngress();
    const server = new SipWebhookServer(
      { enabled: true, standardWebhookSecret: secret, port: 0 },
      { ingress: ingress as never },
    );
    activeServers.push(server);
    await server.start();
    const deliveryId = 'wh_delivery-1';
    const eventId = 'evt_event-1';
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const body = event(eventId);
    const response = await fetch(`http://127.0.0.1:${server.port}${SIP_WEBHOOK_DEFAULT_PATH}`, {
      method: 'POST',
      headers: {
        'webhook-id': deliveryId,
        'webhook-timestamp': timestamp,
        'webhook-signature': signature(deliveryId, timestamp, body),
        'content-type': 'application/json',
      },
      body,
    });
    expect(response.status).toBe(202);
    expect(ingress.ingest).toHaveBeenCalledOnce();
    const received = ingress.ingest.mock.calls[0]?.[0];
    expect(received).toMatchObject({
      id: eventId,
      type: 'live.transport.incoming',
      data: { type: 'sip', sessionId: 'provider-session-1' },
    });
    expect(ingress.ingest.mock.calls[0]?.[1]).toEqual({
      deliveryId,
      deliveredAt: Number(timestamp),
    });
    expect(received.data.sipHeaders).toEqual([
      { name: 'From', value: 'sip:forged@example.test' },
      { name: 'X-Talon-Voice-Assertion', value: 'talon-sip-v1.proof.signature' },
      { name: 'X-Custom', value: 'preserve-me' },
    ]);
  });


  it.each([undefined, null, '', 42, 'x'.repeat(257)])(
    'rejects an invalid event ID independently of the delivery ID: %s',
    (id) => {
      const body = { ...JSON.parse(event('evt_valid')), id };
      expect(() => __private.parseIncomingSipEvent(Buffer.from(JSON.stringify(body)))).toThrow();
    },
  );

  it('rejects a changed delivery ID even when the body and signature are unchanged', async () => {
    const ingress = fakeIngress();
    const server = new SipWebhookServer(
      { enabled: true, standardWebhookSecret: secret, port: 0 },
      { ingress: ingress as never },
    );
    activeServers.push(server);
    await server.start();
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const body = event('evt_separate');
    const response = await fetch(`http://127.0.0.1:${server.port}${SIP_WEBHOOK_DEFAULT_PATH}`, {
      method: 'POST',
      headers: {
        'webhook-id': 'wh_tampered',
        'webhook-timestamp': timestamp,
        'webhook-signature': signature('wh_original', timestamp, body),
      },
      body,
    });
    expect(response.status).toBe(401);
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('authenticates the exact raw bytes when the body is not valid UTF-8', () => {
    const deliveryId = 'delivery-raw-bytes';
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const body = Buffer.from([0x7b, 0x22, 0x6b, 0x22, 0x3a, 0xff, 0x7d]);
    const rawDigest = createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64'))
      .update(`${deliveryId}.${timestamp}.`, 'utf8')
      .update(body)
      .digest('base64');
    const decodedDigest = createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64'))
      .update(`${deliveryId}.${timestamp}.${body.toString('utf8')}`, 'utf8')
      .digest('base64');

    expect(__private.verifyStandardWebhook(secret, deliveryId, timestamp, body, `v1,${rawDigest}`)).toBe(true);
    expect(__private.verifyStandardWebhook(secret, deliveryId, timestamp, body, `v1,${decodedDigest}`)).toBe(false);
  });

  it('matches the independent Standard Webhooks raw-byte signature fixture', () => {
    const fixtureBody = Buffer.from(
      '{"id":"fixture","created_at":1700000000,"type":"live.transport.incoming","data":{"type":"sip","session_id":"fixture-session","sip_headers":[]}}',
      'utf8',
    );
    expect(
      __private.verifyStandardWebhook(
        'whsec_Zml4dHVyZS1zZWNyZXQ=',
        'fixture-delivery',
        '1700000000',
        fixtureBody,
        'v1,DOFH6zMTsL9ks9RaadkaG9HuP1f9LBFwlcaPCadl4Pg=',
      ),
    ).toBe(true);
    expect(
      __private.verifyStandardWebhook(
        'whsec_Zml4dHVyZS1zZWNyZXQ=',
        'fixture-delivery',
        '1700000000',
        Buffer.concat([fixtureBody, Buffer.from('\n', 'utf8')]),
        'v1,DOFH6zMTsL9ks9RaadkaG9HuP1f9LBFwlcaPCadl4Pg=',
      ),
    ).toBe(false);
  });

  it('rejects bad signatures, stale delivery timestamps, and unsupported event shapes', async () => {
    const ingress = fakeIngress();
    const server = new SipWebhookServer(
      { enabled: true, standardWebhookSecret: secret, port: 0 },
      { ingress: ingress as never },
    );
    activeServers.push(server);
    await server.start();
    const deliveryId = 'delivery-2';
    const body = event(deliveryId);
    const current = String(Math.floor(Date.now() / 1_000));
    const badSignature = await fetch(`http://127.0.0.1:${server.port}${SIP_WEBHOOK_DEFAULT_PATH}`, {
      method: 'POST',
      headers: {
        'webhook-id': deliveryId,
        'webhook-timestamp': current,
        'webhook-signature': 'v1,not-valid',
      },
      body,
    });
    expect(badSignature.status).toBe(401);

    const staleTimestamp = String(Math.floor(Date.now() / 1_000) - 301);
    const stale = await fetch(`http://127.0.0.1:${server.port}${SIP_WEBHOOK_DEFAULT_PATH}`, {
      method: 'POST',
      headers: {
        'webhook-id': deliveryId,
        'webhook-timestamp': staleTimestamp,
        'webhook-signature': signature(deliveryId, staleTimestamp, body),
      },
      body,
    });
    expect(stale.status).toBe(401);
    expect(ingress.ingest).not.toHaveBeenCalled();

    expect(() =>
      __private.parseIncomingSipEvent(
        Buffer.from(JSON.stringify({ id: deliveryId, type: 'response', data: {} })),
      ),
    ).toThrow();
  });

  it('preserves header repeats so duplicate assertions remain fail-closed', () => {
    const duplicate = JSON.parse(event('delivery-3')) as {
      data: { sip_headers: Array<{ name: string; value: string }> };
    };
    duplicate.data.sip_headers[2] = {
      name: 'X-Talon-Voice-Assertion',
      value: 'second',
    };
    const parsed = __private.parseIncomingSipEvent(
      Buffer.from(JSON.stringify(duplicate)),
    );
    expect(parsed.data.sipHeaders.map((header) => header.name)).toEqual([
      'From',
      'X-Talon-Voice-Assertion',
      'X-Talon-Voice-Assertion',
    ]);
  });

  it('reserves the 32-request cap before buffering unverified bodies and releases it', async () => {
    const ingress = fakeIngress();
    let releaseIngress!: () => void;
    const heldResult = ok({
      outcome: 'reserved' as const,
      duplicate: false,
      externalAttempted: false,
    });
    const heldIngress = new Promise<typeof heldResult>((resolve) => {
      releaseIngress = () => resolve(heldResult);
    });
    ingress.ingest.mockImplementation(() => heldIngress);
    const server = new SipWebhookServer(
      { enabled: true, standardWebhookSecret: secret, port: 0 },
      { ingress: ingress as never },
    );
    activeServers.push(server);
    await server.start();

    const send = (deliveryId: string) => {
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const body = event(deliveryId);
      return fetch(`http://127.0.0.1:${server.port}${SIP_WEBHOOK_DEFAULT_PATH}`, {
        method: 'POST',
        headers: {
          'webhook-id': deliveryId,
          'webhook-timestamp': timestamp,
          'webhook-signature': signature(deliveryId, timestamp, body),
          'content-type': 'application/json',
        },
        body,
      });
    };
    const pending = Array.from({ length: 32 }, (_, index) => send(`pending-${index}`));
    for (let attempt = 0; attempt < 100 && ingress.ingest.mock.calls.length < 32; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(ingress.ingest).toHaveBeenCalledTimes(32);
    const saturatedId = 'pending-32';
    const saturated = await fetch(`http://127.0.0.1:${server.port}${SIP_WEBHOOK_DEFAULT_PATH}`, {
      method: 'POST',
      headers: {
        'webhook-id': saturatedId,
        'webhook-timestamp': String(Math.floor(Date.now() / 1_000)),
        'webhook-signature': 'v1,invalid-before-body-verification',
        'content-type': 'application/json',
      },
      body: '{malformed',
    });
    expect(saturated.status).toBe(429);
    expect(ingress.ingest).toHaveBeenCalledTimes(32);

    releaseIngress();
    const responses = await Promise.all(pending);
    expect(responses.every((response) => response.status === 202)).toBe(true);
    await send('after-release');
    expect(ingress.ingest).toHaveBeenCalledTimes(33);
  });
});
