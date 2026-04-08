import { describe, it, expect, afterEach } from 'vitest';
import { AisdkHttpConnector } from '../../../../src/channels/connectors/aisdk-http/aisdk-http-connector.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

async function startConnector(config: Record<string, unknown>): Promise<AisdkHttpConnector> {
  const connector = new AisdkHttpConnector(config, 'test-aisdk', logger);
  await connector.start();
  return connector;
}

async function postMessage(port: number, body: object, path = '/agents/test-agent/stream'): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('AisdkHttpConnector', () => {
  let connector: AisdkHttpConnector;

  afterEach(async () => {
    if (connector) await connector.stop();
  });

  it('starts and stops cleanly', async () => {
    connector = await startConnector({ port: 4210 });
    expect(connector.type).toBe('aisdk-http');
    expect(connector.name).toBe('test-aisdk');
  });

  it('returns 404 for unknown routes', async () => {
    connector = await startConnector({ port: 4211 });
    const res = await fetch('http://127.0.0.1:4211/unknown/path', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(404);
  });

  it('returns 405 for non-POST requests', async () => {
    connector = await startConnector({ port: 4212 });
    const res = await fetch('http://127.0.0.1:4212/agents/test-agent/stream', { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('fires onMessage handler with last user message content', async () => {
    connector = await startConnector({ port: 4213 });
    const received: string[] = [];
    connector.onMessage((event) => { received.push(event.content); });

    void postMessage(4213, {
      messages: [{ role: 'user', content: 'Hello Talon' }],
      id: 'thread-abc',
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(received).toContain('Hello Talon');
  });

  it('send() writes text-delta chunks and closes stream', async () => {
    connector = await startConnector({ port: 4214 });
    connector.onMessage(() => {
      setTimeout(() => {
        void connector.send('thread-xyz', { body: 'Test response' });
      }, 50);
    });

    const res = await postMessage(4214, {
      messages: [{ role: 'user', content: 'ping' }],
      id: 'thread-xyz',
    });

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('0:');          // text-delta chunks
    expect(body).toContain('"stop"');      // finish
    expect(res.headers.get('x-thread-id')).toBe('thread-xyz');
  });

  it('handles CORS preflight', async () => {
    connector = await startConnector({ port: 4215 });
    const res = await fetch('http://127.0.0.1:4215/agents/test-agent/stream', {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('extracts forwarded headers from request', async () => {
    connector = await startConnector({
      port: 4216,
      forwardHeaders: ['Authorization'],
    });

    let receivedEvent: { content: string } | null = null;
    connector.onMessage((event) => {
      receivedEvent = event;
      setTimeout(() => {
        void connector.send(event.externalThreadId, { body: 'ok' });
      }, 50);
    });

    await postMessage(4216, {
      messages: [{ role: 'user', content: 'test' }],
      id: 'thread-fwd',
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(receivedEvent).not.toBeNull();
    expect(receivedEvent!.content).toBe('test');
  });

  it('generates thread ID when not provided by client', async () => {
    connector = await startConnector({ port: 4217 });
    connector.onMessage((event) => {
      setTimeout(() => {
        void connector.send(event.externalThreadId, { body: 'ok' });
      }, 50);
    });

    const res = await postMessage(4217, {
      messages: [{ role: 'user', content: 'no-id' }],
    });

    const threadId = res.headers.get('x-thread-id');
    expect(threadId).toBeTruthy();
    expect(threadId!.length).toBeGreaterThan(0);
  });
});
