/**
 * AI SDK HTTP channel connector.
 *
 * Runs a lightweight HTTP server that speaks the Vercel AI SDK v5
 * data-stream SSE protocol. Any @ai-sdk/react frontend (useChat,
 * DefaultChatTransport) can connect to a Talon persona via this channel.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type pino from 'pino';
import type { ChannelConnector, InboundEvent, AgentOutput } from '../../channel-types.js';
import type { Result } from '../../../core/types/result.js';
import { ok, err } from '../../../core/types/result.js';
import { ChannelError } from '../../../core/errors/error-types.js';
import { matchRoute } from './route-parser.js';
import { buildTextChunks, buildFinishChunks, buildKeepAlive, buildStartStep } from './stream-adapter.js';
import type { AisdkHttpChannelConfig, AisdkRequestBody, PendingStream } from './aisdk-http-types.js';
import { AisdkHttpChannelConfigSchema } from './aisdk-http-types.js';

// ---------------------------------------------------------------------------
// AisdkHttpConnector
// ---------------------------------------------------------------------------

export class AisdkHttpConnector implements ChannelConnector {
  readonly type = 'aisdk-http';
  readonly name: string;

  private config: AisdkHttpChannelConfig;
  private handler?: (event: InboundEvent) => void | Promise<void>;
  private running = false;
  private httpServer?: ReturnType<typeof createServer>;
  private idCounter = 0;

  /**
   * Map from externalThreadId to the open SSE response for that thread.
   * Only one pending stream per thread is supported (last one wins).
   */
  private pendingStreams = new Map<string, PendingStream>();

  constructor(
    rawConfig: Record<string, unknown>,
    channelName: string,
    private readonly logger: pino.Logger,
  ) {
    this.name = channelName;
    this.config = AisdkHttpChannelConfigSchema.parse(rawConfig);
  }

  // -------------------------------------------------------------------------
  // ChannelConnector lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    return new Promise((resolve, reject) => {
      this.httpServer = createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      this.httpServer.on('error', (e) => {
        this.running = false;
        reject(e);
      });

      this.httpServer.listen(this.config.port, this.config.host, () => {
        this.logger.info(
          { channelName: this.name, port: this.config.port, host: this.config.host },
          'aisdk-http: listening',
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    for (const [threadId, pending] of this.pendingStreams) {
      clearInterval(pending.keepAliveInterval);
      try { pending.res.end(); } catch { /* client already disconnected */ }
      this.pendingStreams.delete(threadId);
    }

    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  onMessage(handler: (event: InboundEvent) => void | Promise<void>): void {
    this.handler = handler;
  }

  /**
   * Called by the daemon with the completed agent output.
   * Flushes the response as AI SDK SSE chunks and closes the stream.
   */
  async send(externalThreadId: string, output: AgentOutput): Promise<Result<void, ChannelError>> {
    const pending = this.pendingStreams.get(externalThreadId);
    if (!pending) {
      this.logger.warn({ channelName: this.name, externalThreadId }, 'aisdk-http: no pending stream for thread');
      return ok(undefined);
    }

    const { res } = pending;
    clearInterval(pending.keepAliveInterval);
    this.pendingStreams.delete(externalThreadId);

    try {
      // Start step
      res.write(buildStartStep(randomUUID()));

      // Text chunks (word-by-word streaming feel)
      for (const chunk of buildTextChunks(output.body, this.config.textChunkType)) {
        res.write(chunk);
      }

      // Finish
      for (const chunk of buildFinishChunks()) {
        res.write(chunk);
      }

      res.end();
      return ok(undefined);
    } catch (e) {
      this.logger.error({ channelName: this.name, externalThreadId, err: e }, 'aisdk-http: send error');
      return err(new ChannelError(`aisdk-http send failed: ${String(e)}`));
    }
  }

  format(markdown: string): string {
    return markdown;
  }

  setSiblingBotIds(_ids: Set<string>): void {
    // No bot-self-filtering concept for HTTP
  }

  // -------------------------------------------------------------------------
  // HTTP request handling
  // -------------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS preflight
    this.setCorsHeaders(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Match route
    const url = req.url ?? '/';
    const params = matchRoute(this.config.routePattern, url);
    if (!params) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Resolve persona from agentId
    const agentId = params['agentId'];
    // TODO: forward to pipeline once persona routing from channel is supported
    const _personaName = agentId
      ? (this.config.agentMapping[agentId] ?? agentId)
      : this.config.defaultPersona ?? 'default';

    // Parse request body
    let body: AisdkRequestBody;
    try {
      body = await this.readBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
      return;
    }

    // Determine thread ID (client-supplied or generate)
    const externalThreadId = body.id ?? randomUUID();

    // Extract headers to forward
    const forwardedHeaders: Record<string, string> = {};
    for (const header of this.config.forwardHeaders) {
      const val = req.headers[header.toLowerCase()];
      if (val) forwardedHeaders[header] = Array.isArray(val) ? val[0] ?? '' : val;
    }
    for (const [param, headerName] of Object.entries(this.config.forwardPathParams)) {
      if (params[param]) forwardedHeaders[headerName] = params[param] ?? '';
    }

    // Build inbound event content from last user message
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
    const content = lastUser?.content ?? '';

    // Open SSE stream immediately
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Thread-Id': externalThreadId,
      'Access-Control-Expose-Headers': 'X-Thread-Id',
    });

    // Set up keep-alive
    const keepAliveInterval = setInterval(() => {
      try { res.write(buildKeepAlive()); } catch { /* client disconnected */ }
    }, this.config.keepAliveIntervalMs);

    // Store pending stream (last one wins if duplicate threadId)
    const existing = this.pendingStreams.get(externalThreadId);
    if (existing) {
      clearInterval(existing.keepAliveInterval);
      try { existing.res.end(); } catch { /* ignore */ }
    }
    this.pendingStreams.set(externalThreadId, { res, keepAliveInterval, forwardedHeaders });

    // Handle client disconnect
    req.on('close', () => {
      const pending = this.pendingStreams.get(externalThreadId);
      if (pending && pending.res === res) {
        clearInterval(pending.keepAliveInterval);
        this.pendingStreams.delete(externalThreadId);
      }
    });

    // Fire inbound event
    const idempotencyKey = `${externalThreadId}-${++this.idCounter}`;
    const event: InboundEvent = {
      channelType: this.type,
      channelName: this.name,
      externalThreadId,
      senderId: externalThreadId,
      idempotencyKey,
      content,
      timestamp: Date.now(),
      raw: body,
    };

    if (this.handler) {
      try {
        await this.handler(event);
      } catch (e) {
        this.logger.error({ channelName: this.name, err: e }, 'aisdk-http: handler error');
        clearInterval(keepAliveInterval);
        this.pendingStreams.delete(externalThreadId);
        try {
          res.write(`3:"Internal error"\n`);
          res.end();
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Set CORS headers, checking the request origin against allowed origins.
   * Supports wildcard ('*') and exact-match origins.
   */
  private setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
    const origins = this.config.cors.allowOrigins;

    if (origins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      const requestOrigin = req.headers.origin;
      if (requestOrigin && origins.includes(requestOrigin)) {
        res.setHeader('Access-Control-Allow-Origin', requestOrigin);
        res.setHeader('Vary', 'Origin');
      }
    }

    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  private readBody(req: IncomingMessage): Promise<AisdkRequestBody> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(raw) as AisdkRequestBody);
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  }
}
