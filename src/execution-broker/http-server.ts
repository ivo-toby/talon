import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import { ExecutionBrokerError } from './errors.js';
import type { BrokerApi, BrokerHttpServerOptions } from './http-types.js';
import type { ExecutionBrokerErrorCode } from './types.js';

const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const MIN_TOKEN_LENGTH = 32;

/** Broker error code -> HTTP status. Fixed by the API contract. */
const ERROR_STATUS: Record<ExecutionBrokerErrorCode, number> = {
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

type BodyResult =
  | { kind: 'ok'; value: unknown }
  | { kind: 'invalid' }
  | { kind: 'too_large' };

/**
 * Creates the authenticated broker HTTP API without listening. There is
 * deliberately no global request lock; the broker enforces its own
 * concurrency limits.
 */
export function createBrokerHttpServer(
  options: BrokerHttpServerOptions,
): Result<Server, ExecutionBrokerError> {
  if (options.token.length < MIN_TOKEN_LENGTH) {
    return err(
      new ExecutionBrokerError(
        'INVALID_ARGUMENT',
        `token must be at least ${MIN_TOKEN_LENGTH} characters`,
      ),
    );
  }
  const tokenBuf = Buffer.from(options.token);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const isReady = options.isReady ?? ((): Promise<boolean> => Promise.resolve(true));

  return ok(
    createServer((request, response) => {
      void handleRequest(request, response, tokenBuf, maxBodyBytes, isReady, options.broker);
    }),
  );
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  tokenBuf: Buffer,
  maxBodyBytes: number,
  isReady: (signal: AbortSignal) => Promise<boolean>,
  broker: BrokerApi,
): Promise<void> {
  // /healthz is the only unauthenticated route; auth runs before routing.
  if (request.method === 'GET' && request.url === '/healthz') {
    writeJson(response, 200, { ok: true });
    return;
  }

  if (!isAuthorized(request.headers.authorization, tokenBuf)) {
    writeJson(response, 401, { ok: false, code: 'UNAUTHORIZED', error: 'Unauthorized' });
    return;
  }

  if (request.method === 'GET' && request.url === '/readyz') {
    await handleReadyz(request, response, isReady);
    return;
  }

  if (request.method === 'POST' && request.url === '/v1/leases') {
    await handleCreateLease(request, response, maxBodyBytes, broker);
    return;
  }

  if (request.method === 'POST' && request.url === '/v1/execute') {
    await handleExecute(request, response, maxBodyBytes, broker);
    return;
  }

  if (request.method === 'POST' && request.url === '/v1/revoke') {
    await handleRevoke(request, response, maxBodyBytes, broker);
    return;
  }

  writeJson(response, 404, { ok: false, code: 'NOT_FOUND', error: 'Not found' });
}

async function handleReadyz(
  request: IncomingMessage,
  response: ServerResponse,
  isReady: (signal: AbortSignal) => Promise<boolean>,
): Promise<void> {
  const abortController = new AbortController();
  request.once('aborted', () => abortController.abort());
  response.once('close', () => {
    if (!response.writableEnded) abortController.abort();
  });
  try {
    const ready = await isReady(abortController.signal);
    writeJson(response, ready ? 200 : 503, { ok: ready });
  } catch {
    writeJson(response, 503, { ok: false });
  }
}

async function handleCreateLease(
  request: IncomingMessage,
  response: ServerResponse,
  maxBodyBytes: number,
  broker: BrokerApi,
): Promise<void> {
  const body = await readJsonBody(request, maxBodyBytes, response);
  if (body.kind !== 'ok') return;
  try {
    const result = await broker.createLease(body.value);
    if (result.isErr()) {
      writeBrokerError(response, result.error);
      return;
    }
    writeJson(response, 201, { ok: true, leaseId: result.value.leaseId });
  } catch {
    writeInternalError(response);
  }
}

async function handleExecute(
  request: IncomingMessage,
  response: ServerResponse,
  maxBodyBytes: number,
  broker: BrokerApi,
): Promise<void> {
  const body = await readJsonBody(request, maxBodyBytes, response);
  if (body.kind !== 'ok') return;

  // Constraint: a client disconnect before the response ends counts as a
  // cancel, which is a revoke. A normal finish must never revoke.
  let ended = false;
  let disconnectRevoked = false;
  response.once('close', () => {
    if (ended || disconnectRevoked || response.writableEnded) return;
    disconnectRevoked = true;
    const leaseId = extractLeaseId(body.value);
    if (leaseId !== undefined) {
      void broker.revoke(leaseId).catch(() => undefined);
    }
  });

  try {
    const result = await broker.execute(body.value);
    if (result.isErr()) {
      writeBrokerError(response, result.error);
      return;
    }
    writeJson(response, 200, { ok: true, result: result.value });
  } catch {
    writeInternalError(response);
  } finally {
    ended = true;
  }
}

async function handleRevoke(
  request: IncomingMessage,
  response: ServerResponse,
  maxBodyBytes: number,
  broker: BrokerApi,
): Promise<void> {
  const body = await readJsonBody(request, maxBodyBytes, response);
  if (body.kind !== 'ok') return;
  const leaseId = extractLeaseId(body.value);
  if (leaseId === undefined) {
    writeJson(response, 400, {
      ok: false,
      code: 'INVALID_ARGUMENT',
      error: 'leaseId must be a non-empty string',
    });
    return;
  }
  try {
    const result = await broker.revoke(leaseId);
    if (result.isErr()) {
      writeBrokerError(response, result.error);
      return;
    }
    writeJson(response, 200, { ok: true });
  } catch {
    writeInternalError(response);
  }
}

function extractLeaseId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const leaseId = (value as { leaseId?: unknown }).leaseId;
  return typeof leaseId === 'string' && leaseId.length > 0 ? leaseId : undefined;
}

function isAuthorized(authorization: string | undefined, tokenBuf: Buffer): boolean {
  if (authorization === undefined || !authorization.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(authorization.slice('Bearer '.length));
  return supplied.length === tokenBuf.length && timingSafeEqual(supplied, tokenBuf);
}

async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number,
  response: ServerResponse,
): Promise<BodyResult> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  let tooLarge = false;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      received += buffer.length;
      if (received > maxBodyBytes) {
        tooLarge = true;
        break;
      }
      chunks.push(buffer);
    }
  } catch {
    return { kind: 'invalid' };
  }

  if (tooLarge) {
    // Stop buffering and discard the remainder; destroying the request here
    // would suppress the 413 response. The server hangs up after the response.
    request.resume();
    writeJson(response, 413, {
      ok: false,
      code: 'PAYLOAD_TOO_LARGE',
      error: 'Request body too large',
    });
    return { kind: 'too_large' };
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) {
    writeJson(response, 400, {
      ok: false,
      code: 'INVALID_ARGUMENT',
      error: 'Request body is required',
    });
    return { kind: 'invalid' };
  }
  try {
    return { kind: 'ok', value: JSON.parse(text) as unknown };
  } catch {
    writeJson(response, 400, {
      ok: false,
      code: 'INVALID_ARGUMENT',
      error: 'Request body must be valid JSON',
    });
    return { kind: 'invalid' };
  }
}

function writeBrokerError(response: ServerResponse, error: ExecutionBrokerError): void {
  writeJson(response, ERROR_STATUS[error.brokerCode] ?? 400, {
    ok: false,
    code: error.brokerCode,
    error: error.message,
  });
}

function writeInternalError(response: ServerResponse): void {
  // Never leak the thrown message.
  writeJson(response, 500, { ok: false, code: 'INTERNAL', error: 'Internal error' });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
