import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionBrokerError } from '../../../src/execution-broker/errors.js';
import { createBrokerHttpServer } from '../../../src/execution-broker/http-server.js';
import type { BrokerApi } from '../../../src/execution-broker/http-types.js';
import type {
  ExecutionBrokerErrorCode,
  ExecutionResult,
} from '../../../src/execution-broker/types.js';

const TOKEN = 't'.repeat(40);

const RESULT: ExecutionResult = {
  exitCode: 0,
  stdout: 'hi',
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
  timedOut: false,
  cancelled: false,
};

interface FakeBroker extends BrokerApi {
  createLease: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
}

function fakeBroker(): FakeBroker {
  return {
    createLease: vi.fn(() => Promise.resolve(ok({ leaseId: 'lease-1' }))),
    execute: vi.fn(() => Promise.resolve(ok(RESULT))),
    revoke: vi.fn(() => Promise.resolve(ok(undefined))),
  } as FakeBroker;
}

interface Reply {
  status: number;
  contentType: string | undefined;
  text: string;
  json: any;
}

let server: Server;
let port: number;

async function start(
  broker: BrokerApi,
  extra: { isReady?: (s: AbortSignal) => Promise<boolean>; maxBodyBytes?: number } = {},
): Promise<void> {
  server = createBrokerHttpServer({ token: TOKEN, broker, ...extra })._unsafeUnwrap();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
}

function call(
  method: string,
  path: string,
  options: { auth?: string | null; body?: unknown; raw?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    const auth = options.auth === undefined ? `Bearer ${TOKEN}` : options.auth;
    if (auth !== null) headers.authorization = auth;
    const payload =
      options.raw !== undefined
        ? options.raw
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined;
    if (payload !== undefined) headers['content-type'] = 'application/json';
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, contentType: res.headers['content-type'], text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

beforeEach(() => {
  server = undefined as unknown as Server;
});

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('createBrokerHttpServer', () => {
  it('rejects a token shorter than 32 characters', () => {
    const result = createBrokerHttpServer({ token: 'short', broker: fakeBroker() });
    expect(result._unsafeUnwrapErr().brokerCode).toBe('INVALID_ARGUMENT');
  });

  it('serves /healthz without authentication', async () => {
    await start(fakeBroker());
    const reply = await call('GET', '/healthz', { auth: null });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ ok: true });
  });

  it('protects /readyz and maps readiness to 200 or 503', async () => {
    await start(fakeBroker());
    expect((await call('GET', '/readyz', { auth: null })).status).toBe(401);
    expect((await call('GET', '/readyz')).status).toBe(200);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await start(fakeBroker(), { isReady: () => Promise.resolve(false) });
    expect((await call('GET', '/readyz')).status).toBe(503);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await start(fakeBroker(), { isReady: () => Promise.reject(new Error('boom')) });
    expect((await call('GET', '/readyz')).status).toBe(503);
  });

  it('rejects missing, malformed and wrong bearer tokens with 401 and never calls the broker', async () => {
    const broker = fakeBroker();
    await start(broker);
    const body = { taskId: 't' };
    for (const auth of [null, TOKEN, `Basic ${TOKEN}`, 'Bearer wrong', `Bearer ${'x'.repeat(40)}`, 'Bearer ']) {
      for (const path of ['/v1/leases', '/v1/execute', '/v1/revoke']) {
        const reply = await call('POST', path, { auth, body });
        expect(reply.status).toBe(401);
        expect(reply.json).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
      }
    }
    expect(broker.createLease).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    expect(broker.revoke).not.toHaveBeenCalled();
  });

  it('creates a lease: 201 with the lease ID, body passed to the broker unchanged', async () => {
    const broker = fakeBroker();
    await start(broker);
    const input = { taskId: 't1', parentPersonaId: 'p', personaId: 'w', profile: 'a', workspace: 'b', extra: 1 };
    const reply = await call('POST', '/v1/leases', { body: input });
    expect(reply.status).toBe(201);
    expect(reply.contentType).toContain('application/json');
    expect(reply.json).toEqual({ ok: true, leaseId: 'lease-1' });
    expect(broker.createLease).toHaveBeenCalledWith(input);
  });

  it('executes: 200 with the structured result, body passed to the broker unchanged', async () => {
    const broker = fakeBroker();
    await start(broker);
    const input = { leaseId: 'lease-1', taskId: 't1', personaId: 'w', argv: ['ls'], cwd: '', timeoutMs: 1000 };
    const reply = await call('POST', '/v1/execute', { body: input });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ ok: true, result: RESULT });
    expect(broker.execute).toHaveBeenCalledWith(input);
  });

  it('revokes: 200, and rejects a body without a string leaseId before calling the broker', async () => {
    const broker = fakeBroker();
    await start(broker);
    const good = await call('POST', '/v1/revoke', { body: { leaseId: 'lease-1' } });
    expect(good.status).toBe(200);
    expect(good.json).toEqual({ ok: true });
    expect(broker.revoke).toHaveBeenCalledWith('lease-1');

    broker.revoke.mockClear();
    for (const body of [{}, { leaseId: 5 }, { leaseId: '' }, [], 'x']) {
      const reply = await call('POST', '/v1/revoke', { body });
      expect(reply.status).toBe(400);
      expect(reply.json).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    }
    expect(broker.revoke).not.toHaveBeenCalled();
  });

  it('maps every broker error code to its HTTP status and passes the error text through', async () => {
    const expected: Record<ExecutionBrokerErrorCode, number> = {
      INVALID_ARGUMENT: 400,
      GRANT_DENIED: 403,
      UNKNOWN_PROFILE: 404,
      UNKNOWN_WORKSPACE: 404,
      CWD_OUTSIDE_WORKSPACE: 422,
      SYMLINK_ESCAPE: 422,
      LEASE_NOT_FOUND: 404,
      LEASE_MISMATCH: 403,
      LEASE_REVOKED: 409,
      TIMEOUT_EXCEEDS_PROFILE: 422,
      CONCURRENCY_LIMIT: 429,
      QUOTA_UNENFORCEABLE: 422,
      BACKEND_FAILURE: 502,
    };
    const broker = fakeBroker();
    await start(broker);
    for (const [code, status] of Object.entries(expected)) {
      const failure = new ExecutionBrokerError(code as ExecutionBrokerErrorCode, 'detail text');
      broker.execute.mockResolvedValueOnce(err(failure) as Result<never, ExecutionBrokerError>);
      const reply = await call('POST', '/v1/execute', { body: { leaseId: 'x' } });
      expect(reply.status).toBe(status);
      expect(reply.json).toEqual({ ok: false, code, error: failure.message });
    }
  });

  it('returns a generic 500 when the broker throws, without leaking the message', async () => {
    const broker = fakeBroker();
    broker.execute.mockRejectedValueOnce(new Error('internal stack secret'));
    await start(broker);
    const reply = await call('POST', '/v1/execute', { body: { leaseId: 'x' } });
    expect(reply.status).toBe(500);
    expect(reply.json).toMatchObject({ ok: false, code: 'INTERNAL' });
    expect(reply.text).not.toContain('secret');
  });

  it('rejects invalid, empty and oversize bodies without calling the broker', async () => {
    const broker = fakeBroker();
    await start(broker, { maxBodyBytes: 200 });
    const invalid = await call('POST', '/v1/leases', { raw: '{not json' });
    expect(invalid.status).toBe(400);
    expect(invalid.json).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    const empty = await call('POST', '/v1/leases', { raw: '' });
    expect(empty.status).toBe(400);
    const big = await call('POST', '/v1/leases', { body: { pad: 'x'.repeat(500) } });
    expect(big.status).toBe(413);
    expect(broker.createLease).not.toHaveBeenCalled();
  });

  it('answers 404 for unknown routes and wrong methods once authenticated, 401 first when not', async () => {
    await start(fakeBroker());
    expect((await call('GET', '/v1/leases')).status).toBe(404);
    expect((await call('POST', '/v1/nope', { body: {} })).status).toBe(404);
    expect((await call('GET', '/nope')).status).toBe(404);
    expect((await call('POST', '/v1/nope', { auth: null, body: {} })).status).toBe(401);
  });

  it('serves concurrent executes without a global lock', async () => {
    const broker = fakeBroker();
    const release: Array<() => void> = [];
    broker.execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          release.push(() => resolve(ok(RESULT)));
        }),
    );
    await start(broker);
    const first = call('POST', '/v1/execute', { body: { leaseId: 'a' } });
    const second = call('POST', '/v1/execute', { body: { leaseId: 'b' } });
    await vi.waitFor(() => expect(broker.execute).toHaveBeenCalledTimes(2));
    release.forEach((r) => r());
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  it('revokes the lease when the client disconnects during an execute', async () => {
    const broker = fakeBroker();
    broker.execute.mockImplementation(() => new Promise(() => undefined));
    await start(broker);
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/execute',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    });
    req.on('error', () => undefined);
    req.end(JSON.stringify({ leaseId: 'lease-9', taskId: 't', personaId: 'w', argv: ['sleep'], cwd: '', timeoutMs: 1 }));
    await vi.waitFor(() => expect(broker.execute).toHaveBeenCalledTimes(1));
    req.destroy();
    await vi.waitFor(() => expect(broker.revoke).toHaveBeenCalledWith('lease-9'));
  });

  it('does not revoke when the execute finished normally', async () => {
    const broker = fakeBroker();
    await start(broker);
    await call('POST', '/v1/execute', { body: { leaseId: 'lease-1' } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(broker.revoke).not.toHaveBeenCalled();
  });
});
