import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDockerEngineClient } from '../../../src/execution-broker/docker-client.js';

interface Seen {
  method: string;
  url: string;
  contentType: string | undefined;
  body: string;
}

let dir: string;
let socketPath: string;
let server: Server;
let seen: Seen[];
let handler: (req: IncomingMessage, res: import('node:http').ServerResponse) => void;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'docker-client-'));
  socketPath = join(dir, 'docker.sock');
  seen = [];
  handler = (_req, res) => {
    res.statusCode = 200;
    res.end('{"ok":true}');
  };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('createDockerEngineClient', () => {
  it('sends a GET without a body and returns status and body', async () => {
    const client = createDockerEngineClient({ socketPath });
    const response = (await client.request({ method: 'GET', path: '/_ping' }))._unsafeUnwrap();
    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('{"ok":true}');
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/_ping', body: '' });
  });

  it('sends a JSON body with a content-type header on POST', async () => {
    const client = createDockerEngineClient({ socketPath });
    await client.request({ method: 'POST', path: '/containers/create', body: { Image: 'x' } });
    expect(seen[0].method).toBe('POST');
    expect(seen[0].contentType).toBe('application/json');
    expect(JSON.parse(seen[0].body)).toEqual({ Image: 'x' });
  });

  it('returns non-2xx statuses as ok for the caller to judge', async () => {
    handler = (_req, res) => {
      res.statusCode = 404;
      res.end('{"message":"no such container"}');
    };
    const client = createDockerEngineClient({ socketPath });
    const response = (await client.request({ method: 'DELETE', path: '/containers/x' }))._unsafeUnwrap();
    expect(response.status).toBe(404);
  });

  it('maps a missing socket to BACKEND_FAILURE without echoing the socket path', async () => {
    const client = createDockerEngineClient({ socketPath: join(dir, 'missing.sock') });
    const error = (await client.request({ method: 'GET', path: '/_ping' }))._unsafeUnwrapErr();
    expect(error.brokerCode).toBe('BACKEND_FAILURE');
    expect(error.message).not.toContain(dir);
  });

  it('rejects a response larger than maxResponseBytes', async () => {
    handler = (_req, res) => {
      res.statusCode = 200;
      res.end(Buffer.alloc(2_000, 0x61));
    };
    const client = createDockerEngineClient({ socketPath, maxResponseBytes: 1_000 });
    const error = (await client.request({ method: 'GET', path: '/big' }))._unsafeUnwrapErr();
    expect(error.brokerCode).toBe('BACKEND_FAILURE');
  });

  it('aborts an in-flight request when the signal fires', async () => {
    handler = () => {
      // never respond
    };
    const client = createDockerEngineClient({ socketPath });
    const controller = new AbortController();
    const pending = client.request({ method: 'GET', path: '/slow', signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const error = (await pending)._unsafeUnwrapErr();
    expect(error.brokerCode).toBe('BACKEND_FAILURE');
  });

  it('returns BACKEND_FAILURE immediately for an already-aborted signal', async () => {
    const client = createDockerEngineClient({ socketPath });
    const controller = new AbortController();
    controller.abort();
    const error = (
      await client.request({ method: 'GET', path: '/x', signal: controller.signal })
    )._unsafeUnwrapErr();
    expect(error.brokerCode).toBe('BACKEND_FAILURE');
    expect(seen).toHaveLength(0);
  });
});
