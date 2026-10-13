/**
 * Disabled-by-default HTTP receiver for OpenAI Standard Webhooks deliveries.
 *
 * Raw bytes are bounded and authenticated before parsing JSON. The verified
 * provider event is handed to SipIngressService, which separately verifies
 * the caller assertion and owns durable at-most-once admission.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { err, ok, type Result } from '../../../core/types/result.js';
import { PolicyError } from '../../../core/errors/index.js';
import type {
  IncomingSipEvent,
  SipHeader,
  SipIngressService,
} from './sip-ingress-service.js';

export const SIP_WEBHOOK_DEFAULT_HOST = '127.0.0.1';
export const SIP_WEBHOOK_DEFAULT_PORT = 0;
export const SIP_WEBHOOK_DEFAULT_PATH = '/voice/sip/webhook';
export const SIP_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
export const SIP_WEBHOOK_DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300;
export const SIP_WEBHOOK_MAX_PENDING_REQUESTS = 32;

export interface SipWebhookServerConfig {
  readonly enabled?: boolean;
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly standardWebhookSecret?: string;
  readonly maxRequestBytes?: number;
  readonly timestampToleranceSeconds?: number;
}

export interface SipWebhookServerDependencies {
  readonly ingress: SipIngressService;
  readonly logger?: Pick<Console, 'error' | 'warn' | 'info'>;
}

interface VerifiedDelivery {
  readonly deliveryId: string;
  readonly deliveredAt: number;
  readonly body: Buffer;
}

/** HTTP listener that stays inert until explicitly started by daemon config. */
export class SipWebhookServer {
  private readonly config: Required<
    Pick<
      SipWebhookServerConfig,
      | 'enabled'
      | 'host'
      | 'port'
      | 'path'
      | 'maxRequestBytes'
      | 'timestampToleranceSeconds'
    >
  > & Pick<SipWebhookServerConfig, 'standardWebhookSecret'>;
  private readonly ingress: SipIngressService;
  private readonly logger: Pick<Console, 'error' | 'warn' | 'info'>;
  private server: Server | null = null;
  private startPromise: Promise<number> | null = null;
  private pendingRequests = 0;

  constructor(config: SipWebhookServerConfig, dependencies: SipWebhookServerDependencies) {
    this.config = {
      enabled: config.enabled ?? false,
      host: config.host ?? SIP_WEBHOOK_DEFAULT_HOST,
      port: config.port ?? SIP_WEBHOOK_DEFAULT_PORT,
      path: normalizePath(config.path ?? SIP_WEBHOOK_DEFAULT_PATH),
      standardWebhookSecret: config.standardWebhookSecret,
      maxRequestBytes: config.maxRequestBytes ?? SIP_WEBHOOK_MAX_BODY_BYTES,
      timestampToleranceSeconds:
        config.timestampToleranceSeconds ?? SIP_WEBHOOK_DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
    };
    validateConfig(this.config);
    this.ingress = dependencies.ingress;
    this.logger = dependencies.logger ?? console;
  }

  get port(): number {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : 0;
  }

  start(host = this.config.host, port = this.config.port): Promise<number> {
    if (!this.config.enabled) return Promise.resolve(0);
    if (this.server) return Promise.resolve(this.port);
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<number>((resolveStart, rejectStart) => {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response).catch(() => {
          writeJson(response, 500, { error: 'SIP webhook request failed' });
        });
      });
      this.server = server;
      const onError = (cause: Error): void => {
        this.server = null;
        this.startPromise = null;
        rejectStart(cause);
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        server.on('error', (cause: Error) => {
          this.logger.error('SIP webhook server error', cause);
        });
        this.logger.info('SIP webhook server started', { host, port: this.port });
        resolveStart(this.port);
      });
    });
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (!this.server) return Promise.resolve();
    const server = this.server;
    this.server = null;
    this.startPromise = null;
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    return new Promise<void>((resolveStop, rejectStop) => {
      server.close((cause) => {
        if (cause) rejectStop(cause);
        else resolveStop();
      });
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    applySecurityHeaders(response);
    if (request.method !== 'POST' || (request.url ?? '').split('?')[0] !== this.config.path) {
      writeJson(response, 404, { error: 'Not found' });
      return;
    }
    if (this.pendingRequests >= SIP_WEBHOOK_MAX_PENDING_REQUESTS) {
      request.resume();
      writeJson(response, 429, { error: 'SIP webhook capacity exhausted' });
      return;
    }
    this.pendingRequests += 1;
    try {
      const verified = await this.verifyDelivery(request);
      if (verified.isErr()) {
        writeJson(response, verified.error.code === 'signature' ? 401 : 400, {
          error: 'Invalid webhook delivery',
        });
        return;
      }
      let parsed: IncomingSipEvent;
      try {
        parsed = parseIncomingSipEvent(verified.value.body, verified.value.deliveryId);
      } catch {
        writeJson(response, 400, { error: 'Invalid webhook delivery' });
        return;
      }
      const result = await this.ingress.ingest(parsed, {
        deliveryId: verified.value.deliveryId,
        deliveredAt: verified.value.deliveredAt,
      });
      if (result.isErr()) {
        writeJson(response, 500, { error: 'SIP ingress unavailable' });
        return;
      }
      const status =
        result.value.outcome === 'duplicate'
          ? 200
          : result.value.outcome === 'rejected'
            ? 403
            : 202;
      writeJson(response, status, {
        accepted: result.value.outcome !== 'rejected',
        duplicate: result.value.duplicate,
        outcome: result.value.outcome,
      });
    } finally {
      this.pendingRequests -= 1;
    }
  }

  private async verifyDelivery(request: IncomingMessage): Promise<Result<VerifiedDelivery, WebhookFailure>> {
    const deliveryId = singleHeader(request.headers, 'webhook-id');
    const timestamp = singleHeader(request.headers, 'webhook-timestamp');
    const signature = singleHeader(request.headers, 'webhook-signature');
    if (!deliveryId || !timestamp || !signature) return err(new WebhookFailure('signature'));
    if (!isBoundedHeader(deliveryId, 256) || !/^\d+$/.test(timestamp)) {
      return err(new WebhookFailure('signature'));
    }
    const deliveredAt = Number(timestamp);
    const nowSeconds = Math.floor(Date.now() / 1_000);
    if (!Number.isSafeInteger(deliveredAt)) return err(new WebhookFailure('signature'));
    if (Math.abs(nowSeconds - deliveredAt) > this.config.timestampToleranceSeconds) {
      return err(new WebhookFailure('signature'));
    }
    const body = await readBoundedBody(request, this.config.maxRequestBytes);
    if (body.isErr()) return err(body.error);
    const secret = this.config.standardWebhookSecret;
    if (!secret || !verifyStandardWebhook(secret, deliveryId, timestamp, body.value, signature)) {
      return err(new WebhookFailure('signature'));
    }
    return ok({ deliveryId, deliveredAt, body: body.value });
  }
}

class WebhookFailure extends Error {
  constructor(readonly code: 'signature' | 'body') {
    super(code);
  }
}

function verifyStandardWebhook(
  configuredSecret: string,
  deliveryId: string,
  timestamp: string,
  body: Buffer,
  header: string,
): boolean {
  const encodedSecret = configuredSecret.startsWith('whsec_')
    ? configuredSecret.slice('whsec_'.length)
    : configuredSecret;
  let secret: Buffer;
  try {
    secret = Buffer.from(encodedSecret, 'base64');
    if (secret.length === 0) return false;
  } catch {
    return false;
  }
  const expected = createHmac('sha256', secret)
    .update(`${deliveryId}.${timestamp}.`, 'utf8')
    .update(body)
    .digest('base64');
  const tokens = header.trim().split(/\s+/u);
  const candidates: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    const separator = token.indexOf(',');
    if (separator >= 0) {
      if (token.slice(0, separator) === 'v1') candidates.push(token.slice(separator + 1));
      continue;
    }
    const nextToken = tokens[index + 1];
    if (token === 'v1' && nextToken) {
      candidates.push(nextToken);
      index += 1;
    }
  }
  const expectedBytes = Buffer.from(expected, 'utf8');
  return candidates.some((candidate) => {
    const candidateBytes = Buffer.from(candidate, 'utf8');
    return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
  });
}

function parseIncomingSipEvent(body: Buffer, deliveryId: string): IncomingSipEvent {
  const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  if (
    parsed.id !== deliveryId ||
    parsed.type !== 'live.transport.incoming' ||
    !parsed.data ||
    typeof parsed.data !== 'object' ||
    Array.isArray(parsed.data)
  ) {
    throw new PolicyError('SIP event envelope is invalid');
  }
  const data = parsed.data as Record<string, unknown>;
  const createdAt = parsed.created_at;
  const object = parsed.object;
  if (
    data.type !== 'sip' ||
    !isBoundedHeader(data.session_id, 256) ||
    !Array.isArray(data.sip_headers) ||
    !isSafeInteger(createdAt) ||
    typeof parsed.id !== 'string' ||
    (object !== undefined && !isBoundedHeader(object, 256))
  ) {
    throw new PolicyError('SIP event payload is invalid');
  }
  const sipHeaders: SipHeader[] = data.sip_headers.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid header');
    const header = value as Record<string, unknown>;
    if (!isBoundedHeader(header.name, 256) || !isBoundedHeader(header.value, 4096)) {
      throw new Error('invalid header');
    }
    return { name: header.name, value: header.value };
  });
  const mediaSecurity = data.sip_media_security;
  if (mediaSecurity !== undefined && !isBoundedHeader(mediaSecurity, 256)) {
    throw new Error('invalid media security');
  }
  return {
    id: parsed.id,
    createdAt,
    type: 'live.transport.incoming',
    object: typeof object === 'string' ? object : undefined,
    data: {
      type: 'sip',
      sessionId: data.session_id,
      sipHeaders,
      ...(mediaSecurity === undefined ? {} : { sipMediaSecurity: mediaSecurity }),
    },
  };
}

async function readBoundedBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Result<Buffer, WebhookFailure>> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (failure: WebhookFailure): void => {
      if (settled) return;
      settled = true;
      resolveBody(err(failure));
    };
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        request.destroy();
        fail(new WebhookFailure('body'));
        return;
      }
      chunks.push(buffer);
    });
    request.once('error', () => fail(new WebhookFailure('body')));
    request.once('aborted', () => fail(new WebhookFailure('body')));
    request.once('end', () => {
      if (!settled) {
        settled = true;
        resolveBody(ok(Buffer.concat(chunks)));
      }
    });
  });
}

function singleHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  return typeof value === 'string' ? value : null;
}

function isBoundedHeader(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function validateConfig(config: SipWebhookServer['config']): void {
  if (config.maxRequestBytes <= 0 || config.maxRequestBytes > SIP_WEBHOOK_MAX_BODY_BYTES) {
    throw new Error('SIP webhook maxRequestBytes must be between 1 and 256 KiB');
  }
  if (
    !Number.isSafeInteger(config.timestampToleranceSeconds) ||
    config.timestampToleranceSeconds <= 0
  ) {
    throw new Error('SIP webhook timestamp tolerance must be positive');
  }
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
}

function writeJson(response: ServerResponse, status: number, body: Readonly<Record<string, unknown>>): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(encoded);
}

export const __private = {
  parseIncomingSipEvent,
  verifyStandardWebhook,
  readBoundedBody,
};
