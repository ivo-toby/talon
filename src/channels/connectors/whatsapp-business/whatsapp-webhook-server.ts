/**
 * WhatsApp webhook HTTP server.
 *
 * Receives inbound webhook requests from the Meta WhatsApp Cloud API and
 * routes them to a registered payload handler.
 *
 * Responsibilities:
 *  - GET  <path>  — Meta webhook verification challenge
 *  - POST <path>  — Event delivery with HMAC-SHA256 signature validation
 *
 * No external HTTP framework is used; this relies solely on node:http and
 * node:crypto from the Node.js standard library.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type pino from 'pino';
import type { WhatsAppWebhookPayload } from './whatsapp-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WhatsAppWebhookServerConfig {
  /** Token used to validate the Meta webhook verification challenge. */
  verifyToken: string;
  /** App secret for HMAC-SHA256 signature validation of inbound POST payloads. */
  appSecret: string;
  /**
   * URL path on which to listen for webhook requests.
   * Defaults to '/webhook'.
   */
  webhookPath?: string;
}

/** Maximum accepted POST body size in bytes (5 MB). */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// WhatsAppWebhookServer
// ---------------------------------------------------------------------------

/**
 * Self-contained HTTP server that handles Meta WhatsApp Cloud API webhooks.
 *
 * Usage:
 * 1. Construct with a config and logger.
 * 2. Call `onPayload()` to register a handler for inbound payloads.
 * 3. Call `start(host, port)` — pass port 0 to let the OS pick a free port.
 *    Returns the actual bound port number.
 * 4. Call `stop()` to shut down gracefully.
 */
export class WhatsAppWebhookServer {
  private server: Server | null = null;
  private handler?: (payload: WhatsAppWebhookPayload) => void | Promise<void>;
  private readonly webhookPath: string;

  constructor(
    private readonly config: WhatsAppWebhookServerConfig,
    private readonly logger: pino.Logger,
  ) {
    this.webhookPath = config.webhookPath ?? '/webhook';
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Register the payload handler invoked after each valid inbound POST.
   * A second call replaces the previous handler.
   */
  onPayload(handler: (payload: WhatsAppWebhookPayload) => void | Promise<void>): void {
    this.handler = handler;
  }

  /**
   * Start the HTTP server and bind to `host:port`.
   *
   * @param host - Network interface to bind to (e.g. '0.0.0.0' or '127.0.0.1').
   * @param port - TCP port to listen on. Pass 0 to let the OS pick a free port.
   * @returns The actual port the server is listening on.
   */
  start(host: string, port: number): Promise<number> {
    if (this.server) {
      const addr = this.server.address();
      const boundPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
      return Promise.resolve(boundPort);
    }
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => {
        this.handleRequest(req, res).catch((err: unknown) => {
          this.logger.error({ err }, 'whatsapp-webhook-server: unhandled error in request handler');
          if (!res.headersSent) {
            res.writeHead(500).end('Internal Server Error');
          }
        });
      });

      const onError = (err: Error) => reject(err);
      srv.once('error', onError);
      srv.listen(port, host, () => {
        // Remove the startup error listener — runtime errors after this point
        // should not reject the (already resolved) start promise.
        srv.removeListener('error', onError);
        const addr = srv.address();
        const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
        this.server = srv;
        this.logger.info(
          { host, port: boundPort, path: this.webhookPath },
          'whatsapp-webhook-server: listening',
        );
        resolve(boundPort);
      });
    });
  }

  /**
   * Gracefully close the HTTP server.
   *
   * Calls `closeAllConnections()` (Node ≥ 18.2) to immediately terminate
   * keep-alive connections, then waits for `close()` to confirm the server
   * has stopped accepting new connections.
   *
   * Idempotent — safe to call multiple times.
   */
  stop(): Promise<void> {
    if (!this.server) {
      return Promise.resolve();
    }
    const srv = this.server;
    this.server = null;
    // Forcibly close any lingering keep-alive connections so that close()
    // resolves promptly rather than waiting for idle timeouts.
    if (typeof srv.closeAllConnections === 'function') {
      srv.closeAllConnections();
    }
    return new Promise((resolve, reject) => {
      srv.close((err) => {
        if (err) {
          reject(err);
        } else {
          this.logger.info('whatsapp-webhook-server: stopped');
          resolve();
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Request dispatch
  // ---------------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname !== this.webhookPath) {
      res.writeHead(404).end('Not Found');
      return;
    }

    if (req.method === 'GET') {
      this.handleVerification(url, res);
      return;
    }

    if (req.method === 'POST') {
      await this.handleEventDelivery(req, res);
      return;
    }

    res.writeHead(405).end('Method Not Allowed');
  }

  // ---------------------------------------------------------------------------
  // GET — Meta webhook verification challenge
  // ---------------------------------------------------------------------------

  private handleVerification(url: URL, res: ServerResponse): void {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (!mode || !challenge) {
      res.writeHead(400).end('Bad Request');
      return;
    }

    if (mode !== 'subscribe' || !this.timingSafeStringEqual(token ?? '', this.config.verifyToken)) {
      this.logger.warn({ mode, tokenPresent: token !== null }, 'whatsapp-webhook-server: verification failed');
      res.writeHead(403).end('Forbidden');
      return;
    }

    this.logger.info('whatsapp-webhook-server: verification challenge accepted');
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(challenge);
  }

  // ---------------------------------------------------------------------------
  // POST — Event delivery
  // ---------------------------------------------------------------------------

  private async handleEventDelivery(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const signatureHeader = req.headers['x-hub-signature-256'];
    if (!signatureHeader || typeof signatureHeader !== 'string') {
      this.logger.warn('whatsapp-webhook-server: missing X-Hub-Signature-256 header');
      res.writeHead(401).end('Unauthorized');
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await this.readBody(req);
    } catch {
      res.writeHead(413).end('Payload Too Large');
      return;
    }

    if (!this.verifySignature(rawBody, signatureHeader)) {
      this.logger.warn('whatsapp-webhook-server: invalid signature');
      res.writeHead(401).end('Unauthorized');
      return;
    }

    let payload: WhatsAppWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf-8')) as WhatsAppWebhookPayload;
    } catch {
      this.logger.warn('whatsapp-webhook-server: failed to parse JSON body');
      res.writeHead(400).end('Bad Request');
      return;
    }

    res.writeHead(200).end('OK');

    if (this.handler) {
      try {
        await this.handler(payload);
      } catch (err) {
        this.logger.error({ err }, 'whatsapp-webhook-server: payload handler threw an error');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Read the full request body into a Buffer.
   * Rejects with an error if the body exceeds MAX_BODY_BYTES.
   */
  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          reject(new Error(`Request body exceeds maximum size of ${MAX_BODY_BYTES} bytes`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  /**
   * Timing-safe string equality check.
   * Returns false immediately on length mismatch (after a constant-time
   * self-compare to avoid early-exit timing signals). Strings of equal length
   * are compared with timingSafeEqual.
   */
  private timingSafeStringEqual(a: string, b: string): boolean {
    try {
      const bufA = Buffer.from(a, 'utf-8');
      const bufB = Buffer.from(b, 'utf-8');
      if (bufA.length !== bufB.length) {
        // Compare against itself to keep constant time, then return false.
        timingSafeEqual(bufA, bufA);
        return false;
      }
      return timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }

  /**
   * Validate `X-Hub-Signature-256: sha256=<hex>` against the raw body.
   *
   * Uses the double-HMAC pattern: both the expected and actual values are
   * re-HMAC'd with a deterministic key derived from appSecret so that
   * their lengths are always equal (fixed 32-byte digest) and no length
   * information is leaked via a plain timingSafeEqual.
   */
  private verifySignature(body: Buffer, signatureHeader: string): boolean {
    try {
      const expected = `sha256=${createHmac('sha256', this.config.appSecret).update(body).digest('hex')}`;
      // Double-HMAC: re-hash both values with the same throwaway key so that
      // their lengths are always equal and no length information is leaked.
      const hmacKey = createHmac('sha256', this.config.appSecret).update('sig-compare').digest();
      const hashExpected = createHmac('sha256', hmacKey).update(expected).digest();
      const hashActual = createHmac('sha256', hmacKey).update(signatureHeader).digest();
      return timingSafeEqual(hashExpected, hashActual);
    } catch {
      return false;
    }
  }
}
