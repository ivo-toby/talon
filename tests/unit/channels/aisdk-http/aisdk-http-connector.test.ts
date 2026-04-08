import { describe, it, expect, afterEach } from 'vitest';
import { AisdkHttpConnector } from '../../../../src/channels/connectors/aisdk-http/aisdk-http-connector.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

async function startConnector(config: Record<string, unknown>): Promise<AisdkHttpConnector> {
  const connector = new AisdkHttpConnector(config, 'test-aisdk', logger);
  await connector.start();
  return connector;
}

async function postMessage(
  port: number,
  body: object,
  path = '/agents/test-agent/stream',
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
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

  it('fires onMessage handler with last user message content (v4 format)', async () => {
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

  it('extracts text from v5 UIMessage parts format', async () => {
    connector = await startConnector({ port: 4218 });
    const received: string[] = [];
    connector.onMessage((event) => { received.push(event.content); });

    void postMessage(4218, {
      messages: [{
        role: 'user',
        parts: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'from parts' },
        ],
      }],
      id: 'thread-v5',
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(received).toContain('Hello from parts');
  });

  it('send() writes v5 SSE chunks and closes stream', async () => {
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
    expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    const body = await res.text();

    // V5 protocol: start, start-step, text-start, text-delta(s), text-end, finish-step, finish, [DONE]
    expect(body).toContain('"type":"start"');
    expect(body).toContain('"type":"start-step"');
    expect(body).toContain('"type":"text-start"');
    expect(body).toContain('"type":"text-delta"');
    expect(body).toContain('"type":"text-end"');
    expect(body).toContain('"type":"finish-step"');
    expect(body).toContain('"type":"finish"');
    expect(body).toContain('data: [DONE]');
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

  it('rejects oversized request bodies with 413', async () => {
    connector = await startConnector({ port: 4219 });

    // Create a body larger than 1MB
    const largeContent = 'x'.repeat(1024 * 1024 + 1);
    const res = await fetch(`http://127.0.0.1:4219/agents/test-agent/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: largeContent }] }),
    }).catch(() => null);

    // Connection may be reset or return 413
    if (res) {
      expect(res.status).toBe(413);
    }
    // If res is null, the connection was reset which is also acceptable
  });
});
