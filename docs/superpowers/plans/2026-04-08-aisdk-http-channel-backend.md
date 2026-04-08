# AI SDK HTTP Channel — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `aisdk-http` channel type to Talon that speaks the Vercel AI SDK v5 data-stream SSE protocol, so any `@ai-sdk/react` frontend can connect to a Talon persona via HTTP POST + SSE.

**Architecture:** The connector runs its own lightweight HTTP server (Node `http`). Inbound POST requests are parsed as AI SDK message bodies and converted to `InboundEvent`s for the existing pipeline. The HTTP response is held open as an SSE stream; keep-alive ticks fire every 5 s while the agent runs. When `send()` is called by the daemon with the completed `AgentOutput`, the connector serialises it as AI SDK data-stream chunks and closes the stream. Tool results for configured tool names are additionally emitted as custom `data-` chunks.

**Tech Stack:** Node 22 `http`, TypeScript strict, `neverthrow` Result, `zod`, `pino`, AI SDK v5 data-stream protocol (text/event-stream), `vitest` for tests.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/channels/connectors/aisdk-http/aisdk-http-types.ts` | Zod config schema + all TS types for this connector |
| Create | `src/channels/connectors/aisdk-http/route-parser.ts` | Parse configurable route patterns, extract named path params |
| Create | `src/channels/connectors/aisdk-http/stream-adapter.ts` | Convert `AgentOutput` → AI SDK data-stream SSE chunks |
| Create | `src/channels/connectors/aisdk-http/artifact-mapper.ts` | Emit custom `2:[...]` data chunks for configured tool names |
| Create | `src/channels/connectors/aisdk-http/aisdk-http-connector.ts` | Main `ChannelConnector` implementation — HTTP server, SSE, keep-alive |
| Modify | `src/core/config/config-schema.ts` | Add `AisdkHttpChannelConfigSchema`, widen `ChannelConfigSchema.type` enum |
| Modify | `src/daemon/channel-factory.ts` | Add `aisdk-http` case |
| Create | `tests/unit/channels/aisdk-http/route-parser.test.ts` | Unit tests for route parsing |
| Create | `tests/unit/channels/aisdk-http/stream-adapter.test.ts` | Unit tests for SSE serialisation |
| Create | `tests/unit/channels/aisdk-http/artifact-mapper.test.ts` | Unit tests for artifact mapping |
| Create | `tests/unit/channels/aisdk-http/aisdk-http-connector.test.ts` | Integration tests for connector lifecycle + HTTP |

---

## Task 1: Types and Config Schema

**Files:**
- Create: `src/channels/connectors/aisdk-http/aisdk-http-types.ts`
- Modify: `src/core/config/config-schema.ts`

- [ ] **Step 1: Write the types file**

```typescript
// src/channels/connectors/aisdk-http/aisdk-http-types.ts
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
  }).default({}),
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
  forwardPathParams: z.record(z.string()).default({}),
  /**
   * Explicit agentId → persona name mapping.
   * If absent, agentId is used directly as the persona name.
   */
  agentMapping: z.record(z.string()).default({}),
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
```

- [ ] **Step 2: Widen the ChannelConfigSchema type enum in config-schema.ts**

Open `src/core/config/config-schema.ts`. Find the line:
```typescript
  type: z.enum(['telegram', 'whatsapp', 'whatsappBusiness', 'whatsappBaileys', 'slack', 'email', 'discord', 'terminal']),
```
Replace it with:
```typescript
  type: z.enum(['telegram', 'whatsapp', 'whatsappBusiness', 'whatsappBaileys', 'slack', 'email', 'discord', 'terminal', 'aisdk-http']),
```

- [ ] **Step 3: Build and typecheck**

```bash
cd /home/talon/talon && npm run build 2>&1 | tail -20
```
Expected: no errors related to config-schema.ts or aisdk-http-types.ts.

- [ ] **Step 4: Commit**

```bash
git add src/channels/connectors/aisdk-http/aisdk-http-types.ts src/core/config/config-schema.ts
git commit -m "feat(aisdk-http): add types, config schema, and enum registration"
```

---

## Task 2: Route Parser

**Files:**
- Create: `src/channels/connectors/aisdk-http/route-parser.ts`
- Create: `tests/unit/channels/aisdk-http/route-parser.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/channels/aisdk-http/route-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseRoute, matchRoute } from '../../../src/channels/connectors/aisdk-http/route-parser.js';

describe('parseRoute', () => {
  it('converts pattern to regex and extracts param names', () => {
    const result = parseRoute('/agents/:agentId/stream');
    expect(result.paramNames).toEqual(['agentId']);
    expect(result.regex.test('/agents/exo-agent/stream')).toBe(true);
    expect(result.regex.test('/agents/exo-agent/other')).toBe(false);
  });

  it('handles multi-segment patterns with multiple params', () => {
    const result = parseRoute('/spaces/:spaceId/environments/:envId/ai/agents/:agentId/stream');
    expect(result.paramNames).toEqual(['spaceId', 'envId', 'agentId']);
    expect(result.regex.test('/spaces/abc123/environments/master/ai/agents/exo-agent/stream')).toBe(true);
  });

  it('handles patterns with no params', () => {
    const result = parseRoute('/chat/stream');
    expect(result.paramNames).toEqual([]);
    expect(result.regex.test('/chat/stream')).toBe(true);
    expect(result.regex.test('/chat/stream/extra')).toBe(false);
  });
});

describe('matchRoute', () => {
  it('returns null when URL does not match pattern', () => {
    const result = matchRoute('/agents/:agentId/stream', '/other/path');
    expect(result).toBeNull();
  });

  it('extracts named params from matching URL', () => {
    const result = matchRoute('/agents/:agentId/stream', '/agents/my-persona/stream');
    expect(result).toEqual({ agentId: 'my-persona' });
  });

  it('extracts multiple named params', () => {
    const result = matchRoute(
      '/spaces/:spaceId/environments/:envId/ai/agents/:agentId/stream',
      '/spaces/abc/environments/master/ai/agents/exo-agent/stream',
    );
    expect(result).toEqual({ spaceId: 'abc', envId: 'master', agentId: 'exo-agent' });
  });

  it('ignores query string when matching', () => {
    const result = matchRoute('/agents/:agentId/stream', '/agents/foo/stream?bar=baz');
    expect(result).toEqual({ agentId: 'foo' });
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd /home/talon/talon && npx vitest run tests/unit/channels/aisdk-http/route-parser.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement route-parser.ts**

```typescript
// src/channels/connectors/aisdk-http/route-parser.ts

interface ParsedRoute {
  regex: RegExp;
  paramNames: string[];
}

/**
 * Pre-compile an Express-style route pattern to a regex + param name list.
 * Segments like :paramName are captured as named groups.
 */
export function parseRoute(pattern: string): ParsedRoute {
  const paramNames: string[] = [];
  // Escape special regex chars except for our :param syntax
  const regexStr = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')   // escape regex specials
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
      paramNames.push(name);
      return '([^/]+)';
    });
  const regex = new RegExp(`^${regexStr}$`);
  return { regex, paramNames };
}

/**
 * Match a URL pathname against a route pattern.
 * Returns extracted param values, or null if no match.
 */
export function matchRoute(
  pattern: string,
  url: string,
): Record<string, string> | null {
  // Strip query string
  const pathname = url.split('?')[0] ?? url;
  const { regex, paramNames } = parseRoute(pattern);
  const match = regex.exec(pathname);
  if (!match) return null;
  const params: Record<string, string> = {};
  paramNames.forEach((name, i) => {
    params[name] = match[i + 1] ?? '';
  });
  return params;
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /home/talon/talon && npx vitest run tests/unit/channels/aisdk-http/route-parser.test.ts 2>&1 | tail -10
```
Expected: PASS — all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/channels/connectors/aisdk-http/route-parser.ts tests/unit/channels/aisdk-http/route-parser.test.ts
git commit -m "feat(aisdk-http): route parser with named param extraction"
```

---

## Task 3: Stream Adapter

**Files:**
- Create: `src/channels/connectors/aisdk-http/stream-adapter.ts`
- Create: `tests/unit/channels/aisdk-http/stream-adapter.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/channels/aisdk-http/stream-adapter.test.ts
import { describe, it, expect } from 'vitest';
import { encodeStreamPart, buildTextChunks, buildFinishChunks, buildKeepAlive } from '../../../src/channels/connectors/aisdk-http/stream-adapter.js';

describe('encodeStreamPart', () => {
  it('encodes a text-delta chunk', () => {
    const line = encodeStreamPart('0', 'Hello world');
    expect(line).toBe('0:"Hello world"\n');
  });

  it('encodes a data chunk (array)', () => {
    const line = encodeStreamPart('2', [{ type: 'test' }]);
    expect(line).toBe('2:[{"type":"test"}]\n');
  });

  it('encodes a finish-message chunk', () => {
    const line = encodeStreamPart('d', { finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 } });
    expect(line).toBe('d:{"finishReason":"stop","usage":{"promptTokens":10,"completionTokens":5}}\n');
  });
});

describe('buildTextChunks', () => {
  it('returns array of encoded text-delta lines for word tokens', () => {
    const chunks = buildTextChunks('Hello world', null);
    // Each word (split by space) becomes a text-delta
    expect(chunks.length).toBeGreaterThan(0);
    chunks.forEach(c => expect(c).toMatch(/^0:".+"\n$/));
  });

  it('uses custom chunk type when textChunkType is set', () => {
    const chunks = buildTextChunks('Hi', 'data-human-readable');
    expect(chunks[0]).toMatch(/^data-human-readable:/);
  });
});

describe('buildFinishChunks', () => {
  it('returns finish-step and finish-message lines', () => {
    const chunks = buildFinishChunks();
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('"finishReason":"stop"');
    expect(chunks[0]).toContain('"isContinued":false');
    expect(chunks[1]).toContain('"finishReason":"stop"');
  });
});

describe('buildKeepAlive', () => {
  it('returns a comment line (SSE keep-alive)', () => {
    const line = buildKeepAlive();
    expect(line).toBe(': keep-alive\n\n');
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd /home/talon/talon && npx vitest run tests/unit/channels/aisdk-http/stream-adapter.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement stream-adapter.ts**

```typescript
// src/channels/connectors/aisdk-http/stream-adapter.ts

/**
 * Serialise one AI SDK v5 data-stream protocol part.
 * Format: `TYPE_CODE:JSON_VALUE\n`
 */
export function encodeStreamPart(type: string, value: unknown): string {
  return `${type}:${JSON.stringify(value)}\n`;
}

/**
 * Split `AgentOutput.body` (Markdown string) into word-level text-delta chunks.
 * Each chunk is one encoded SSE line.
 *
 * When textChunkType is null, uses standard "0:" prefix.
 * When textChunkType is set, uses that string as the prefix instead.
 */
export function buildTextChunks(body: string, textChunkType: string | null): string[] {
  // Split on whitespace boundaries, preserving the delimiter attached to each token
  const tokens = body.match(/\S+\s*/g) ?? [body];
  return tokens.map((token) =>
    textChunkType
      ? `${textChunkType}:${JSON.stringify(token)}\n`
      : encodeStreamPart('0', token),
  );
}

/**
 * Build the two finish chunks that close an AI SDK stream:
 * 1. finish-step (`e`) — marks the end of a reasoning step
 * 2. finish-message (`d`) — marks the end of the assistant message
 */
export function buildFinishChunks(): string[] {
  const finishStep = encodeStreamPart('e', {
    finishReason: 'stop',
    usage: { promptTokens: 0, completionTokens: 0 },
    isContinued: false,
  });
  const finishMessage = encodeStreamPart('d', {
    finishReason: 'stop',
    usage: { promptTokens: 0, completionTokens: 0 },
  });
  return [finishStep, finishMessage];
}

/**
 * SSE comment line used as a keep-alive tick.
 * Browsers and proxies treat SSE comment lines as no-ops but they reset the
 * connection timeout timer.
 */
export function buildKeepAlive(): string {
  return ': keep-alive\n\n';
}

/**
 * Build the start-step chunk (`f`) that opens the stream.
 */
export function buildStartStep(messageId: string): string {
  return encodeStreamPart('f', { messageId });
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /home/talon/talon && npx vitest run tests/unit/channels/aisdk-http/stream-adapter.test.ts 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/connectors/aisdk-http/stream-adapter.ts tests/unit/channels/aisdk-http/stream-adapter.test.ts
git commit -m "feat(aisdk-http): stream adapter — AI SDK v5 data-stream SSE encoding"
```

---

## Task 4: Artifact Mapper

**Files:**
- Create: `src/channels/connectors/aisdk-http/artifact-mapper.ts`
- Create: `tests/unit/channels/aisdk-http/artifact-mapper.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/channels/aisdk-http/artifact-mapper.test.ts
import { describe, it, expect } from 'vitest';
import { buildArtifactChunks } from '../../../src/channels/connectors/aisdk-http/artifact-mapper.js';
import type { ArtifactMapping } from '../../../src/channels/connectors/aisdk-http/aisdk-http-types.js';

const mapping: ArtifactMapping[] = [
  { toolName: 'assemble_experience_tree', chunkType: 'data-exo-output-artifact', wrapAs: 'jsonContent' },
  { toolName: 'search_results', chunkType: 'data-search-results' },
];

describe('buildArtifactChunks', () => {
  it('returns empty array when tool name is not in mapping', () => {
    const chunks = buildArtifactChunks('unknown_tool', { foo: 'bar' }, mapping);
    expect(chunks).toHaveLength(0);
  });

  it('wraps result when wrapAs is set', () => {
    const chunks = buildArtifactChunks('assemble_experience_tree', { tree: [] }, mapping);
    expect(chunks).toHaveLength(1);
    // Should be a data chunk (type "2") with the custom wrapper
    expect(chunks[0]).toContain('"data-exo-output-artifact"');
    expect(chunks[0]).toContain('"jsonContent"');
    expect(chunks[0]).toContain('"tree"');
  });

  it('emits result as-is when wrapAs is absent', () => {
    const chunks = buildArtifactChunks('search_results', [{ id: '1' }], mapping);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('"data-search-results"');
    expect(chunks[0]).toContain('"id"');
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd /home/talon/talon && npx vitest run tests/unit/channels/aisdk-http/artifact-mapper.test.ts 2>&1 | tail -10
```
Expected: FAIL.

- [ ] **Step 3: Implement artifact-mapper.ts**

```typescript
// src/channels/connectors/aisdk-http/artifact-mapper.ts
import { encodeStreamPart } from './stream-adapter.js';
import type { ArtifactMapping } from './aisdk-http-types.js';

/**
 * Given a tool name and its result, emit zero or more custom SSE data chunks
 * based on the configured artifact mapping.
 *
 * Custom chunks are emitted as `2:[{type, ...data}]` lines — the AI SDK
 * data-stream "data" part type. Frontends can listen for these via
 * `useChat`'s `onData` callback or by inspecting `data` from the hook.
 */
export function buildArtifactChunks(
  toolName: string,
  result: unknown,
  mapping: ArtifactMapping[],
): string[] {
  const entry = mapping.find((m) => m.toolName === toolName);
  if (!entry) return [];

  const payload = entry.wrapAs
    ? { type: entry.chunkType, [entry.wrapAs]: result }
    : { type: entry.chunkType, ...( typeof result === 'object' && result !== null ? result : { result }) };

  return [encodeStreamPart('2', [payload])];
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /home/talon/talon && npx vitest run tests/unit/channels/aisdk-http/artifact-mapper.test.ts 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/connectors/aisdk-http/artifact-mapper.ts tests/unit/channels/aisdk-http/artifact-mapper.test.ts
git commit -m "feat(aisdk-http): artifact mapper — tool results to custom SSE data chunks"
```

---

## Task 5: Main Connector

**Files:**
- Create: `src/channels/connectors/aisdk-http/aisdk-http-connector.ts`

- [ ] **Step 1: Write the connector**

```typescript
// src/channels/connectors/aisdk-http/aisdk-http-connector.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type pino from 'pino';
import type { ChannelConnector, InboundEvent, AgentOutput } from '../../channel-types.js';
import type { Result } from '../../../core/types/result.js';
import { ok, err } from '../../../core/types/result.js';
import { ChannelError } from '../../../core/errors/error-types.js';
import { matchRoute } from './route-parser.js';
import { buildTextChunks, buildFinishChunks, buildKeepAlive, buildStartStep } from './stream-adapter.js';
import { buildArtifactChunks } from './artifact-mapper.js';
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

    // Close all open SSE streams
    for (const [threadId, pending] of this.pendingStreams) {
      clearInterval(pending.keepAliveInterval);
      try { pending.res.end(); } catch { /* ignore */ }
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
      // Thread may have disconnected — not an error, just log and move on
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
      return err(new ChannelError('send-failed', String(e)));
    }
  }

  format(markdown: string): string {
    return markdown; // No transformation needed — we emit raw Markdown
  }

  setSiblingBotIds(_ids: Set<string>): void {
    // No bot-self-filtering concept for HTTP
  }

  // -------------------------------------------------------------------------
  // HTTP request handling
  // -------------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS preflight
    this.setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Only accept POST
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
    const personaName = agentId
      ? (this.config.agentMapping[agentId] ?? agentId)
      : this.config.defaultPersona ?? 'default';

    // Parse request body
    let body: AisdkRequestBody;
    try {
      body = await this.readBody(req);
    } catch (e) {
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
      Connection: 'keep-alive',
      'X-Thread-Id': externalThreadId,
      'Access-Control-Expose-Headers': 'X-Thread-Id',
    });

    // Set up keep-alive
    const keepAliveInterval = setInterval(() => {
      try { res.write(buildKeepAlive()); } catch { /* client disconnected */ }
    }, this.config.keepAliveIntervalMs);

    // Store pending stream
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
      senderId: externalThreadId, // No per-user identity in HTTP mode
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
          res.write(`:3:"Internal error"\n`);
          res.end();
        } catch { /* ignore */ }
      }
    }
  }

  private setCorsHeaders(res: ServerResponse): void {
    // Allow configured origins (* by default)
    const origins = this.config.cors.allowOrigins;
    res.setHeader('Access-Control-Allow-Origin', origins.includes('*') ? '*' : origins[0] ?? '*');
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
```

- [ ] **Step 2: Build and typecheck**

```bash
cd /home/talon/talon && npm run build 2>&1 | grep -E "error|Error" | head -20
```
Expected: 0 errors in the new files.

- [ ] **Step 3: Commit**

```bash
git add src/channels/connectors/aisdk-http/aisdk-http-connector.ts
git commit -m "feat(aisdk-http): main connector — HTTP server, SSE lifecycle, InboundEvent dispatch"
```

---

## Task 6: Register in Channel Factory

**Files:**
- Modify: `src/daemon/channel-factory.ts`

- [ ] **Step 1: Add the import and case**

In `src/daemon/channel-factory.ts`, add the import after the existing terminal import:
```typescript
import { AisdkHttpConnector } from '../channels/connectors/aisdk-http/aisdk-http-connector.js';
```

In the `switch` block, add before `default`:
```typescript
    case 'aisdk-http':
      return new AisdkHttpConnector(config, name, logger);
```

- [ ] **Step 2: Build — expect clean**

```bash
cd /home/talon/talon && npm run build 2>&1 | grep -E "^.*error" | head -10
```
Expected: 0 TypeScript errors.

- [ ] **Step 3: Smoke test — start daemon with minimal aisdk-http config**

Create a temporary test config at `/tmp/aisdk-test.yaml`:
```yaml
providers:
  - type: claude
    apiKey: "${ANTHROPIC_API_KEY}"

personas:
  - name: test-agent
    provider: claude
    model: claude-haiku-4-5
    systemPrompt: "You are a test agent."

channels:
  - name: aisdk-test
    type: aisdk-http
    config:
      port: 4199
      routePattern: "/agents/:agentId/stream"

bindings:
  - channel: aisdk-test
    persona: test-agent
    isDefault: true
```

Start the daemon (ctrl-c after 5s to verify it starts without crashing):
```bash
cd /home/talon/talon && timeout 5 node dist/index.js --config /tmp/aisdk-test.yaml 2>&1 || true
```
Expected: logs show `aisdk-http: listening` on port 4199.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/channel-factory.ts
git commit -m "feat(aisdk-http): register connector in channel factory"
```

---

## Task 7: Update README and CLAUDE.md

**Files:**
- Modify: `README.md` (channel type list)
- Modify: `CLAUDE.md` (source layout / architecture section)

- [ ] **Step 1: Add aisdk-http to the channel list in README.md**

Find the section in README.md that lists channel types (telegram, slack, discord, etc.) and add:
```
| `aisdk-http` | HTTP + SSE | Any Vercel AI SDK v5 frontend (`useChat`, `DefaultChatTransport`) |
```

- [ ] **Step 2: Add aisdk-http to CLAUDE.md architecture table**

In CLAUDE.md, find the connectors line:
```
| Channels  | `src/channels/connectors/` | 7 adapters: telegram, slack, discord, whatsapp-business, whatsapp-baileys, email, terminal |
```
Update to:
```
| Channels  | `src/channels/connectors/` | 8 adapters: telegram, slack, discord, whatsapp-business, whatsapp-baileys, email, terminal, aisdk-http |
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: add aisdk-http channel to README and CLAUDE.md"
```

---

## Task 8: Integration Test

**Files:**
- Create: `tests/unit/channels/aisdk-http/aisdk-http-connector.test.ts`

- [ ] **Step 1: Write integration tests**

```typescript
// tests/unit/channels/aisdk-http/aisdk-http-connector.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AisdkHttpConnector } from '../../../../src/channels/connectors/aisdk-http/aisdk-http-connector.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

async function startConnector(config: Record<string, unknown>) {
  const connector = new AisdkHttpConnector(config, 'test-aisdk', logger);
  await connector.start();
  return connector;
}

async function postMessage(port: number, body: object): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/agents/test-agent/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('AisdkHttpConnector', () => {
  let connector: AisdkHttpConnector;

  afterEach(async () => {
    if (connector) await connector.stop();
  });

  it('starts and stops cleanly', async () => {
    connector = await startConnector({ port: 4210 });
    expect(connector.type).toBe('aisdk-http');
    expect(connector.name).toBe('test-aisdk');
  });

  it('returns 404 for unknown routes', async () => {
    connector = await startConnector({ port: 4211 });
    const res = await fetch('http://127.0.0.1:4211/unknown/path', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(404);
    await connector.stop();
  });

  it('returns 405 for non-POST requests', async () => {
    connector = await startConnector({ port: 4212 });
    const res = await fetch('http://127.0.0.1:4212/agents/test-agent/stream', { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('fires onMessage handler with last user message content', async () => {
    connector = await startConnector({ port: 4213 });
    const received: string[] = [];
    connector.onMessage((event) => { received.push(event.content); });

    // Post but don't await the SSE stream — just trigger it
    void postMessage(4213, {
      messages: [{ role: 'user', content: 'Hello Talon' }],
      id: 'thread-abc',
    });

    // Wait for handler to fire
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toContain('Hello Talon');
  });

  it('send() writes text-delta chunks and closes stream', async () => {
    connector = await startConnector({ port: 4214 });
    connector.onMessage(() => {
      // Simulate async agent response
      setTimeout(() => {
        void connector.send('thread-xyz', { body: 'Test response' });
      }, 50);
    });

    const res = await postMessage(4214, {
      messages: [{ role: 'user', content: 'ping' }],
      id: 'thread-xyz',
    });

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('0:');          // text-delta chunks
    expect(body).toContain('"stop"');      // finish
    expect(res.headers.get('x-thread-id')).toBe('thread-xyz');
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd /home/talon/talon && npx vitest run tests/unit/channels/aisdk-http/ 2>&1 | tail -20
```
Expected: all tests pass (route-parser, stream-adapter, artifact-mapper, connector integration).

- [ ] **Step 3: Final commit**

```bash
git add tests/unit/channels/aisdk-http/aisdk-http-connector.test.ts
git commit -m "test(aisdk-http): integration tests for connector lifecycle and HTTP/SSE"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ HTTP server with configurable port and host
- ✅ Configurable route pattern with named params
- ✅ AI SDK v5 data-stream SSE protocol (text-delta, finish-step, finish-message)
- ✅ Keep-alive ticks
- ✅ CORS (configurable origins)
- ✅ Header forwarding (forwardHeaders, forwardPathParams)
- ✅ Artifact mapping (custom data-* chunks for configured tool names)
- ✅ textChunkType override
- ✅ agentId → persona mapping with fallback
- ✅ Config schema (Zod, registered in ChannelConfigSchema enum)
- ✅ Channel factory registration
- ✅ README + CLAUDE.md docs
- ⚠️ **Not implemented:** Tool-result artifact chunks (requires agent runner to call a streaming hook per tool result — deferred to V2). V1 only streams the final `AgentOutput.body`.
- ⚠️ **Not implemented:** Per-request MCP header injection. The connector stores `forwardedHeaders` in `PendingStream` but the daemon pipeline doesn't yet have a mechanism to pass per-request headers to MCP servers. This is a known gap from design doc open question, deferred to a follow-up.

**Type consistency:** All types defined in `aisdk-http-types.ts` are imported consistently. `PendingStream.res` correctly typed as `ServerResponse`.
