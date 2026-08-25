import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { CodexSandboxGenerateResponse } from '../subagents/codex-sandbox-protocol.js';
import { CodexRunnerService } from './runner-service.js';

const MAX_REQUEST_BYTES = 1_000_000;

export interface CodexRunnerHttpServerDeps {
  generate?: (request: unknown, abortSignal?: AbortSignal) => Promise<CodexSandboxGenerateResponse>;
  isReady?: (abortSignal?: AbortSignal) => Promise<boolean>;
}

/**
 * Creates the small, authenticated runner API. Its only mutating endpoint
 * starts one bounded generation; callers cannot select commands, mounts, CWDs,
 * MCP configuration, App Server options, or environment variables.
 */
export function createCodexRunnerHttpServer(
  token: string,
  service: CodexRunnerService,
  deps: CodexRunnerHttpServerDeps = {},
): Server {
  const generate = deps.generate ?? service.generate.bind(service);
  const isReady = deps.isReady ?? service.isReady.bind(service);
  let activeRequest = false;

  return createServer((request, response) => {
    void handleRequest(
      request,
      response,
      token,
      generate,
      isReady,
      () => activeRequest,
      (value) => {
        activeRequest = value;
      },
    );
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  generate: (request: unknown, abortSignal?: AbortSignal) => Promise<CodexSandboxGenerateResponse>,
  isReady: (abortSignal?: AbortSignal) => Promise<boolean>,
  isActive: () => boolean,
  setActive: (value: boolean) => void,
): Promise<void> {
  if (request.method === 'GET' && request.url === '/healthz') {
    writeJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'GET' && request.url === '/readyz') {
    if (!isAuthorized(request.headers.authorization, token)) {
      writeJson(response, 401, { ok: false, code: 'UNAUTHORIZED', error: 'Unauthorized' });
      return;
    }

    try {
      const abortController = new AbortController();
      request.once('aborted', () => abortController.abort());
      response.once('close', () => {
        if (!response.writableEnded) abortController.abort();
      });
      const ready = await isReady(abortController.signal);
      writeJson(response, ready ? 200 : 503, { ok: ready });
    } catch {
      writeJson(response, 503, { ok: false });
    }
    return;
  }

  if (request.method !== 'POST' || request.url !== '/v1/generate') {
    writeJson(response, 404, { ok: false, code: 'NOT_FOUND', error: 'Not found' });
    return;
  }

  if (!isAuthorized(request.headers.authorization, token)) {
    writeJson(response, 401, { ok: false, code: 'UNAUTHORIZED', error: 'Unauthorized' });
    return;
  }

  if (isActive()) {
    writeJson(response, 429, {
      ok: false,
      code: 'RUNNER_BUSY',
      error: 'Codex sandbox runner already has an active generation',
    });
    return;
  }

  // Acquire before consuming the body. Otherwise two concurrent requests can
  // both await readJsonBody(), then each observe a free runner and race the
  // shared auth refresh path.
  setActive(true);
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Invalid request body';
    writeJson(response, 400, { ok: false, code: 'INVALID_REQUEST', error: message });
    setActive(false);
    return;
  }

  const abortController = new AbortController();
  request.once('aborted', () => abortController.abort());
  response.once('close', () => {
    if (!response.writableEnded) abortController.abort();
  });

  try {
    const result = await generate(body, abortController.signal);
    writeJson(response, result.ok ? 200 : 422, result);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    writeJson(response, 500, { ok: false, code: 'RUNNER_ERROR', error: message });
  } finally {
    setActive(false);
  }
}

function isAuthorized(authorization: string | undefined, token: string): boolean {
  if (authorization === undefined || !authorization.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(authorization.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    received += buffer.length;
    if (received > MAX_REQUEST_BYTES) {
      request.destroy();
      throw new Error(`Request body exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) throw new Error('Request body is required');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
