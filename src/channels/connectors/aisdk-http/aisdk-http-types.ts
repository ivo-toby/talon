/**
 * Types and Zod schemas for the aisdk-http channel connector.
 *
 * Defines the config shape, AI SDK v5 data-stream wire types, and internal
 * structures for managing pending SSE streams.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Config schema (registered in config-schema.ts)
// ---------------------------------------------------------------------------

export const ArtifactMappingSchema = z.object({
  /** Tool name whose result should emit a custom data chunk. */
  toolName: z.string(),
  /** SSE data chunk type prefix, e.g. "data-exo-output-artifact". */
  chunkType: z.string(),
  /**
   * Optional wrapper key. When set, result is emitted as { [wrapAs]: result }.
   * When omitted, result is emitted as-is.
   */
  wrapAs: z.string().optional(),
});

export const AisdkHttpChannelConfigSchema = z.object({
  /** TCP port to listen on. */
  port: z.number().int().min(1).max(65535),
  /**
   * Express-style route pattern with named params (e.g. "/agents/:agentId/stream"
   * or "/spaces/:spaceId/environments/:envId/ai/agents/:agentId/stream").
   * The :agentId param maps to a persona name.
   */
  routePattern: z.string().default('/agents/:agentId/stream'),
  /** CORS allowed origins. Glob patterns supported. */
  cors: z.object({
    allowOrigins: z.array(z.string()).default(['*']),
  }).default(() => ({ allowOrigins: ['*'] })),
  /**
   * Map specific tool result names to custom SSE data chunks.
   * Each matched tool result also emits its normal tool-result chunk.
   */
  artifactMapping: z.array(ArtifactMappingSchema).default([]),
  /**
   * Override the SSE chunk type used for text output.
   * null = use standard "0:" text-delta chunks (default, works with any useChat frontend).
   * Set to e.g. "data-human-readable" for custom frontend handling.
   */
  textChunkType: z.string().nullable().default(null),
  /**
   * HTTP request headers to forward to MCP servers.
   * E.g. ["Authorization"] passes the Bearer token through.
   */
  forwardHeaders: z.array(z.string()).default([]),
  /**
   * Map route path params to header names forwarded to MCP servers.
   * E.g. { spaceId: "X-Space-Id" } extracts :spaceId from the URL and sends it as a header.
   */
  forwardPathParams: z.record(z.string(), z.string()).default({}),
  /**
   * Explicit agentId -> persona name mapping.
   * If absent, agentId is used directly as the persona name.
   */
  agentMapping: z.record(z.string(), z.string()).default({}),
  /** Fallback persona when agentId doesn't match any mapping. */
  defaultPersona: z.string().optional(),
  /** Keep-alive SSE tick interval while agent is running (ms). Min 1000. */
  keepAliveIntervalMs: z.number().int().min(1000).max(60000).default(5000),
  /** Host to bind to. Defaults to 127.0.0.1. */
  host: z.string().default('127.0.0.1'),
});

export type AisdkHttpChannelConfig = z.infer<typeof AisdkHttpChannelConfigSchema>;
export type ArtifactMapping = z.infer<typeof ArtifactMappingSchema>;

// ---------------------------------------------------------------------------
// AI SDK v5 data-stream wire types
// ---------------------------------------------------------------------------

/** AI SDK data-stream protocol chunk types (numeric codes). */
export const StreamPartType = {
  TEXT_DELTA: '0',
  DATA: '2',
  ERROR: '3',
  TOOL_CALL: '9',
  TOOL_RESULT: 'a',
  TOOL_CALL_STREAMING_START: 'b',
  TOOL_CALL_DELTA: 'c',
  FINISH_MESSAGE: 'd',
  FINISH_STEP: 'e',
  START_STEP: 'f',
} as const;

/** Represents one line in the AI SDK data-stream SSE body. */
export interface StreamPart {
  type: string;   // one of StreamPartType values
  value: unknown; // serialised as JSON after the type prefix
}

// ---------------------------------------------------------------------------
// AI SDK request body (what useChat POSTs)
// ---------------------------------------------------------------------------

export interface AisdkMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  id?: string;
}

export interface AisdkRequestBody {
  /** Conversation messages. Last user message is the new input. */
  messages: AisdkMessage[];
  /** Client-generated thread ID. Used as Talon externalThreadId. */
  id?: string;
  /** Opaque metadata forwarded to the persona context. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal: pending SSE stream entry
// ---------------------------------------------------------------------------

export interface PendingStream {
  /** Node.js ServerResponse (kept open for SSE). */
  res: import('node:http').ServerResponse;
  /** Interval handle for keep-alive ticks. */
  keepAliveInterval: ReturnType<typeof setInterval>;
  /** Headers extracted from the original request (for MCP forwarding). */
  forwardedHeaders: Record<string, string>;
}
