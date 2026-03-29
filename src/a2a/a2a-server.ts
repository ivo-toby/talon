/**
 * A2AServer — internal Hono-based A2A JSON-RPC server.
 *
 * Exposes agent card discovery routes and JSON-RPC task endpoints for each
 * loaded persona. In Milestone 1, this server operates in-process only:
 * no port is bound. Internal callers use `server.fetch(request)` directly.
 *
 * Routes:
 *   GET  /.well-known/agent-card.json             — all persona cards
 *   GET  /a2a/agents/:name/.well-known/agent-card.json — single persona card
 *   POST /a2a/agents/:name                        — JSON-RPC task endpoint
 *
 * JSON-RPC methods supported:
 *   tasks/send — Submit a new A2A task
 *   tasks/get  — Retrieve task status by ID
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type pino from 'pino';
import type { A2AAgentCard, A2ATaskStatus } from './a2a-types.js';
import type { A2ATaskMapper } from './a2a-task-mapper.js';

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

const JSONRPC_VERSION = '2.0';

interface JsonRpcRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: string;
  id: string | number;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: string;
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// Standard JSON-RPC error codes
const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // A2A-specific
  NOT_FOUND: -32001,
  A2A_ERROR: -32002,
} as const;

function jsonRpcSuccess(id: string | number, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

// ---------------------------------------------------------------------------
// Task params types and Zod schemas
// ---------------------------------------------------------------------------

const SendMessageParamsSchema = z.object({
  message: z.object({
    role: z.string().optional(),
    parts: z.array(
      z.object({
        kind: z.string().optional(),
        text: z.string().optional(),
      }),
    ).optional(),
  }).optional(),
  metadata: z.object({
    sourcePersona: z.string().optional(),
    sourceThreadId: z.string().optional(),
    hopCount: z.number().int().nonnegative().optional(),
    parentTaskId: z.string().optional(),
    traceId: z.string().optional(),
  }).optional(),
});

const GetTaskParamsSchema = z.object({
  id: z.string().optional(),
});

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

type SendMessageParams = z.infer<typeof SendMessageParamsSchema>;
type GetTaskParams = z.infer<typeof GetTaskParamsSchema>;

// ---------------------------------------------------------------------------
// A2AServer
// ---------------------------------------------------------------------------

/**
 * Internal A2A Hono server.
 *
 * Provides a `fetch()` handle that can be called directly in-process without
 * binding a network socket. This enables deterministic unit testing and keeps
 * the M1 transport boundary fully private.
 */
export class A2AServer {
  private readonly app: Hono;

  constructor(
    private readonly cardRegistry: Map<string, A2AAgentCard>,
    private readonly mapper: A2ATaskMapper,
    private readonly logger: pino.Logger,
  ) {
    this.app = new Hono();
    this.registerRoutes();
  }

  /**
   * Handles an inbound HTTP request against the A2A server.
   * Can be called in-process without a bound socket.
   */
  fetch(request: Request): Promise<Response> {
    return Promise.resolve(this.app.fetch(request));
  }

  // ---------------------------------------------------------------------------
  // Route registration
  // ---------------------------------------------------------------------------

  private registerRoutes(): void {
    // Directory card: all personas
    this.app.get('/.well-known/agent-card.json', (c) => {
      const agents = [...this.cardRegistry.values()];
      return c.json({ agents });
    });

    // Per-persona card
    this.app.get('/a2a/agents/:personaName/.well-known/agent-card.json', (c) => {
      const { personaName } = c.req.param();
      const card = this.cardRegistry.get(personaName);
      if (!card) {
        return c.json({ error: `Persona not found: ${personaName}` }, 404);
      }
      return c.json(card);
    });

    // Per-persona JSON-RPC task endpoint
    this.app.post('/a2a/agents/:personaName', async (c) => {
      const { personaName } = c.req.param();

      if (!this.cardRegistry.has(personaName)) {
        return c.json(jsonRpcError(null, JSONRPC_ERRORS.NOT_FOUND, `Persona not found: ${personaName}`), 404);
      }

      let rawBody: unknown;
      try {
        rawBody = await c.req.json();
      } catch {
        return c.json(jsonRpcError(null, JSONRPC_ERRORS.PARSE_ERROR, 'Invalid JSON'));
      }

      const bodyParse = JsonRpcRequestSchema.safeParse(rawBody);
      if (!bodyParse.success) {
        return c.json(
          jsonRpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Only JSON-RPC 2.0 is supported'),
        );
      }

      // JSON-RPC 2.0 spec §4: a notification has no 'id'. The server MUST NOT reply.
      if (bodyParse.data.id === undefined) {
        return new Response(null, { status: 204 });
      }

      const body: JsonRpcRequest = bodyParse.data as JsonRpcRequest;

      const id = body.id ?? null;

      switch (body.method) {
        case 'tasks/send': {
          const paramsParse = SendMessageParamsSchema.safeParse(body.params ?? {});
          if (!paramsParse.success) {
            return c.json(
              jsonRpcError(id, JSONRPC_ERRORS.INVALID_PARAMS, 'Invalid params for tasks/send'),
            );
          }
          return this.handleTaskSend(c, id, personaName, paramsParse.data);
        }
        case 'tasks/get': {
          const paramsParse = GetTaskParamsSchema.safeParse(body.params ?? {});
          if (!paramsParse.success) {
            return c.json(
              jsonRpcError(id, JSONRPC_ERRORS.INVALID_PARAMS, 'Invalid params for tasks/get'),
            );
          }
          return this.handleTaskGet(c, id, paramsParse.data);
        }
        default:
          return c.json(
            jsonRpcError(id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${body.method}`),
          );
      }
    });
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC method handlers
  // ---------------------------------------------------------------------------

  private handleTaskSend(
    c: Context,
    id: string | number | null,
    targetPersona: string,
    params: SendMessageParams,
  ): Response {
    // Extract text from message parts
    const textPart = params?.message?.parts?.find((p) => p.kind === 'text' || p.text !== undefined);
    const content = textPart?.text?.trim() ?? '';

    if (!content) {
      return c.json(
        jsonRpcError(id, JSONRPC_ERRORS.INVALID_PARAMS, 'No text content found in message parts'),
      );
    }

    const metadata = params?.metadata;
    const sourcePersona = metadata?.sourcePersona;
    const sourceThreadId = metadata?.sourceThreadId;

    if (!sourcePersona) {
      return c.json(
        jsonRpcError(id, JSONRPC_ERRORS.INVALID_PARAMS, 'metadata.sourcePersona is required'),
      );
    }

    if (!sourceThreadId) {
      return c.json(
        jsonRpcError(id, JSONRPC_ERRORS.INVALID_PARAMS, 'metadata.sourceThreadId is required'),
      );
    }

    const result = this.mapper.submitTask({
      sourcePersona,
      targetPersona,
      sourceThreadId,
      content,
      hopCount: metadata?.hopCount ?? 0,
      parentTaskId: metadata?.parentTaskId,
      traceId: metadata?.traceId,
    });

    if (result.isErr()) {
      this.logger.warn(
        { targetPersona, sourcePersona, err: result.error.message },
        'A2A task submission failed',
      );
      return c.json(jsonRpcError(id, JSONRPC_ERRORS.A2A_ERROR, result.error.message));
    }

    const status = result.value;
    return c.json(jsonRpcSuccess(id ?? '0', { id: status.taskId, status: this.statusToProto(status) }));
  }

  private handleTaskGet(
    c: Context,
    id: string | number | null,
    params: GetTaskParams,
  ): Response {
    const taskId = params?.id;
    if (!taskId) {
      return c.json(jsonRpcError(id, JSONRPC_ERRORS.INVALID_PARAMS, 'params.id is required'));
    }

    const result = this.mapper.getTaskStatus(taskId);
    if (result.isErr()) {
      return c.json(jsonRpcError(id, JSONRPC_ERRORS.INTERNAL_ERROR, result.error.message));
    }

    const status = result.value;
    if (!status) {
      return c.json(jsonRpcError(id, JSONRPC_ERRORS.NOT_FOUND, `Task not found: ${taskId}`));
    }

    return c.json(jsonRpcSuccess(id ?? '0', { id: status.taskId, status: this.statusToProto(status) }));
  }

  // ---------------------------------------------------------------------------
  // Protocol mapping
  // ---------------------------------------------------------------------------

  private statusToProto(status: A2ATaskStatus): Record<string, unknown> {
    return {
      state: status.state,
      sourcePersona: status.sourcePersona,
      targetPersona: status.targetPersona,
      threadId: status.threadId,
      queueItemId: status.queueItemId,
      submittedAt: status.submittedAt,
      updatedAt: status.updatedAt,
      completedAt: status.completedAt,
      result: status.result,
      error: status.error,
    };
  }
}
