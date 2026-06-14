/**
 * Types and Zod schemas for the aisdk-http channel connector.
 *
 * Defines the config shape, AI SDK v5 UI Message Stream types, and internal
 * structures for managing pending SSE streams.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Config schema (registered in config-schema.ts)
// ---------------------------------------------------------------------------

export const ArtifactMappingSchema = z.object({
  /** Tool name whose result should emit a custom data chunk. */
  toolName: z.string(),
  /** SSE data chunk type, e.g. "data-exo-output-artifact". */
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
   * null = use standard text-start/text-delta/text-end (default).
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
  /** Keep-alive SSE tick interval while agent is running (ms). Min 1000. */
  keepAliveIntervalMs: z.number().int().min(1000).max(60000).default(5000),
  /** Host to bind to. Defaults to 127.0.0.1. */
  host: z.string().default('127.0.0.1'),
});

export type AisdkHttpChannelConfig = z.infer<typeof AisdkHttpChannelConfigSchema>;
export type ArtifactMapping = z.infer<typeof ArtifactMappingSchema>;

// ---------------------------------------------------------------------------
// AI SDK request body (what useChat POSTs)
// ---------------------------------------------------------------------------

/** V4 message format: content is a plain string. */
interface AisdkMessageV4 {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  id?: string;
}

/** A single part within a v5 UIMessage. */
export interface AisdkMessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** V5 UIMessage format: content may be parts array. */
interface AisdkMessageV5 {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string;
  parts?: AisdkMessagePart[];
  id?: string;
}

/** Union of v4 and v5 message formats. */
export type AisdkMessage = AisdkMessageV4 | AisdkMessageV5;

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
  /** Generated message ID for this stream (used in v5 text chunks). */
  messageId: string;
}
