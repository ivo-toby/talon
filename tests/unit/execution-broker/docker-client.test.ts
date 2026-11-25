import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
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

describe('createDockerEngineClient openStream', () => {
  interface Upgraded {
    headers: IncomingMessage['headers'];
    socket: Duplex;
  }
  let upgrades: Upgraded[];
  let onUpgrade: (u: Upgraded, head: Buffer) => void;
  const sockets = new Set<Duplex>();

  beforeEach(() => {
    upgrades = [];
    sockets.clear();
    onUpgrade = (u) => {
      u.socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    };
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      sockets.add(socket);
      const u = { headers: req.headers, socket };
      upgrades.push(u);
      onUpgrade(u, head);
    });
  });

  afterEach(() => {
    for (const socket of sockets) socket.destroy();
  });

  const nextChunk = (listen: (cb: (c: Buffer) => void) => void): Promise<Buffer> =>
    new Promise((resolve) => listen(resolve));

  it('sends the upgrade headers and the JSON body', async () => {
    const client = createDockerEngineClient({ socketPath });
    const duplex = (
      await client.openStream({ method: 'POST', path: '/exec/x/start', body: { Detach: false } })
    )._unsafeUnwrap();
    expect(upgrades[0].headers.connection?.toLowerCase()).toBe('upgrade');
    expect(upgrades[0].headers.upgrade).toBe('tcp');
    duplex.destroy();
  });

  it('moves bytes both ways after a 101 reply', async () => {
    const client = createDockerEngineClient({ socketPath });
    const duplex = (await client.openStream({ method: 'POST', path: '/exec/x/start' }))._unsafeUnwrap();
    const fromServer = nextChunk((cb) => duplex.onData(cb));
    upgrades[0].socket.write('hello');
    expect((await fromServer).toString('utf8')).toBe('hello');

    const fromClient = new Promise<Buffer>((resolve) => upgrades[0].socket.once('data', resolve));
    duplex.write(Buffer.from('ping'));
    expect((await fromClient).toString('utf8')).toBe('ping');
    duplex.destroy();
  });

  it('delivers bytes that arrive with the 101 head as the first chunk', async () => {
    onUpgrade = (u) => {
      u.socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nearly');
    };
    const client = createDockerEngineClient({ socketPath });
    const duplex = (await client.openStream({ method: 'POST', path: '/exec/x/start' }))._unsafeUnwrap();
    const chunk = await nextChunk((cb) => duplex.onData(cb));
    expect(chunk.toString('utf8')).toBe('early');
    duplex.destroy();
  });

  it.each([200, 404])('maps a %i reply without upgrade to BACKEND_FAILURE', async (status) => {
    server.removeAllListeners('upgrade');
    // The server declines the upgrade with a plain HTTP reply.
    server.on('upgrade', (_req, socket: Duplex) => {
      socket.end(`HTTP/1.1 ${status} X\r\nContent-Length: 0\r\n\r\n`);
    });
    const client = createDockerEngineClient({ socketPath });
    const error = (await client.openStream({ method: 'POST', path: '/exec/x/start' }))._unsafeUnwrapErr();
    expect(error.brokerCode).toBe('BACKEND_FAILURE');
    expect(error.message).not.toContain(socketPath);
  });

  it('endInput half-closes the input while output continues', async () => {
    const client = createDockerEngineClient({ socketPath });
    const duplex = (await client.openStream({ method: 'POST', path: '/exec/x/start' }))._unsafeUnwrap();
    const serverSocket = upgrades[0].socket;
    serverSocket.on('end', () => serverSocket.write('after-end'));
    const fromServer = nextChunk((cb) => duplex.onData(cb));
    duplex.endInput();
    expect((await fromServer).toString('utf8')).toBe('after-end');
    duplex.destroy();
  });

  it('calls onClose one time with an error when aborted after the upgrade', async () => {
    const controller = new AbortController();
    const client = createDockerEngineClient({ socketPath });
    const duplex = (
      await client.openStream({ method: 'POST', path: '/exec/x/start', signal: controller.signal })
    )._unsafeUnwrap();
    const calls: Array<unknown> = [];
    const closed = new Promise<void>((resolve) =>
      duplex.onClose((error) => {
        calls.push(error);
        resolve();
      }),
    );
    controller.abort();
    await closed;
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
    expect((calls[0] as { brokerCode: string }).brokerCode).toBe('BACKEND_FAILURE');
  });

  it('calls onClose without an error when the server closes the stream', async () => {
    const client = createDockerEngineClient({ socketPath });
    const duplex = (await client.openStream({ method: 'POST', path: '/exec/x/start' }))._unsafeUnwrap();
    const closed = new Promise<unknown>((resolve) => duplex.onClose((error) => resolve(error)));
    upgrades[0].socket.end();
    expect(await closed).toBeUndefined();
  });

  it('delivers a close that happened before onClose was registered', async () => {
    const client = createDockerEngineClient({ socketPath });
    const duplex = (await client.openStream({ method: 'POST', path: '/exec/x/start' }))._unsafeUnwrap();
    duplex.destroy();
    await new Promise((r) => setTimeout(r, 20));
    const calls: unknown[] = [];
    duplex.onClose((error) => calls.push(error));
    expect(calls).toEqual([undefined]);
  });

  it('returns BACKEND_FAILURE when the signal is already aborted', async () => {
    const client = createDockerEngineClient({ socketPath });
    const error = (
      await client.openStream({ method: 'POST', path: '/x', signal: AbortSignal.abort() })
    )._unsafeUnwrapErr();
    expect(error.brokerCode).toBe('BACKEND_FAILURE');
    expect(upgrades).toHaveLength(0);
  });

  it('maps a connect failure to BACKEND_FAILURE without echoing the socket path', async () => {
    const missing = join(dir, 'missing.sock');
    const client = createDockerEngineClient({ socketPath: missing });
    const error = (await client.openStream({ method: 'POST', path: '/x' }))._unsafeUnwrapErr();
    expect(error.brokerCode).toBe('BACKEND_FAILURE');
    expect(error.message).not.toContain(missing);
  });
});
