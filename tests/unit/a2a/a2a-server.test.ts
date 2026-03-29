/**
 * Unit tests for A2AServer — Hono-based A2A JSON-RPC server.
 *
 * The server is tested via app.request() without binding a port,
 * consistent with M1's internal-only transport model.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ok, err } from 'neverthrow';
import { A2AServer } from '../../../src/a2a/a2a-server.js';
import type { A2AAgentCard, A2ATaskStatus } from '../../../src/a2a/a2a-types.js';
import { A2AError } from '../../../src/core/errors/index.js';
import pino from 'pino';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCard(personaName: string): A2AAgentCard {
  return {
    id: personaName,
    name: personaName,
    description: `Talon persona: ${personaName}`,
    url: `/a2a/agents/${personaName}`,
    version: '0.1.0',
    skills: [{ id: 'code-review', name: 'code-review' }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    metadata: {
      personaName,
      model: 'claude-sonnet-4-6',
      skills: ['code-review'],
      capabilities: { allow: ['read-repo'], requireApproval: [] },
      internalOnly: true,
    },
  };
}

function makeTaskStatus(overrides: Partial<A2ATaskStatus> = {}): A2ATaskStatus {
  return {
    taskId: 'task-abc-123',
    state: 'submitted',
    sourcePersona: 'assistant',
    targetPersona: 'software-engineer',
    threadId: 'thread-123',
    queueItemId: 'queue-item-456',
    submittedAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createLogger() {
  return pino({ level: 'silent' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('A2AServer', () => {
  let registry: Map<string, A2AAgentCard>;
  let mockMapper: {
    submitTask: ReturnType<typeof vi.fn>;
    getTaskStatus: ReturnType<typeof vi.fn>;
  };
  let server: A2AServer;

  beforeEach(() => {
    registry = new Map([
      ['software-engineer', makeCard('software-engineer')],
      ['assistant', makeCard('assistant')],
    ]);

    mockMapper = {
      submitTask: vi.fn().mockReturnValue(ok(makeTaskStatus())),
      getTaskStatus: vi.fn().mockReturnValue(ok(makeTaskStatus())),
    };

    server = new A2AServer(registry, mockMapper as never, createLogger());
  });

  // -------------------------------------------------------------------------
  // Agent card routes
  // -------------------------------------------------------------------------

  describe('GET /.well-known/agent-card.json', () => {
    it('returns 200 with all persona cards', async () => {
      const res = await server.fetch(new Request('http://talon.internal/.well-known/agent-card.json'));
      expect(res.status).toBe(200);
      const body = await res.json() as { agents: A2AAgentCard[] };
      expect(body.agents).toBeDefined();
      expect(body.agents).toHaveLength(2);
    });

    it('includes card data for each persona', async () => {
      const res = await server.fetch(new Request('http://talon.internal/.well-known/agent-card.json'));
      const body = await res.json() as { agents: A2AAgentCard[] };
      const names = body.agents.map((a: A2AAgentCard) => a.name);
      expect(names).toContain('software-engineer');
      expect(names).toContain('assistant');
    });
  });

  describe('GET /a2a/agents/:personaName/.well-known/agent-card.json', () => {
    it('returns 200 with card for known persona', async () => {
      const res = await server.fetch(
        new Request('http://talon.internal/a2a/agents/software-engineer/.well-known/agent-card.json'),
      );
      expect(res.status).toBe(200);
      const card = await res.json() as A2AAgentCard;
      expect(card.id).toBe('software-engineer');
    });

    it('returns 404 for unknown persona', async () => {
      const res = await server.fetch(
        new Request('http://talon.internal/a2a/agents/unknown-persona/.well-known/agent-card.json'),
      );
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Task submission (JSON-RPC)
  // -------------------------------------------------------------------------

  describe('POST /a2a/agents/:personaName (tasks/send)', () => {
    function makeJsonRpcBody(params: Record<string, unknown> = {}) {
      return {
        jsonrpc: '2.0',
        id: '1',
        method: 'tasks/send',
        params: {
          message: {
            role: 'user',
            parts: [{ kind: 'text', text: 'Review the PR' }],
          },
          metadata: {
            sourcePersona: 'assistant',
            sourceThreadId: 'thread-123',
          },
          ...params,
        },
      };
    }

    it('returns 200 with task submitted status', async () => {
      const res = await server.fetch(
        new Request('http://talon.internal/a2a/agents/software-engineer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(makeJsonRpcBody()),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { result?: { status?: { state: string } } };
      expect(body.result?.status?.state).toBe('submitted');
    });

    it('calls submitTask with extracted text content', async () => {
      await server.fetch(
        new Request('http://talon.internal/a2a/agents/software-engineer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(makeJsonRpcBody()),
        }),
      );

      expect(mockMapper.submitTask).toHaveBeenCalledWith(
        expect.objectContaining({
          targetPersona: 'software-engineer',
          content: 'Review the PR',
          sourcePersona: 'assistant',
          sourceThreadId: 'thread-123',
        }),
      );
    });

    it('returns 404 for unknown target persona', async () => {
      const res = await server.fetch(
        new Request('http://talon.internal/a2a/agents/unknown-persona', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(makeJsonRpcBody()),
        }),
      );
      expect(res.status).toBe(404);
    });

    it('returns JSON-RPC error when mapper returns A2AError', async () => {
      mockMapper.submitTask.mockReturnValue(
        err(new A2AError('hop count exceeded')),
      );

      const res = await server.fetch(
        new Request('http://talon.internal/a2a/agents/software-engineer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(makeJsonRpcBody()),
        }),
      );

      expect(res.status).toBe(200);
      const body = await res.json() as { error?: { message: string } };
      expect(body.error?.message).toMatch(/hop count exceeded/);
    });

    it('returns JSON-RPC error when message parts are missing text', async () => {
      const res = await server.fetch(
        new Request('http://talon.internal/a2a/agents/software-engineer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            makeJsonRpcBody({
              message: { role: 'user', parts: [] },
            }),
          ),
        }),
      );

      expect(res.status).toBe(200);
      const body = await res.json() as { error?: { code: number } };
      expect(body.error).toBeDefined();
    });

    it('returns JSON-RPC error for missing sourcePersona metadata', async () => {
      const res = await server.fetch(
        new Request('http://talon.internal/a2a/agents/software-engineer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            makeJsonRpcBody({ metadata: { sourceThreadId: 'thread-123' } }),
          ),
        }),
      );

      const body = await res.json() as { error?: { code: number } };
      expect(body.error).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Task status
  // -------------------------------------------------------------------------

  describe('POST /a2a/agents/:personaName (tasks/get)', () => {
    it('returns task status for valid task ID', async () => {
      mockMapper.getTaskStatus.mockReturnValue(ok(makeTaskStatus({ state: 'completed' })));

      const res = await server.fetch(
        new Request('http://talon.internal/a2a/agents/software-engineer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: '2',
            method: 'tasks/get',
            params: { id: 'task-abc-123' },
          }),
        }),
      );

      expect(res.status).toBe(200);
      const body = await res.json() as { result?: { status?: { state: string } } };
      expect(body.result?.status?.state).toBe('completed');
    });

    it('returns error for unknown task ID', async () => {
      mockMapper.getTaskStatus.mockReturnValue(ok(null));

      const res = await server.fetch(
        new Request('http://talon.internal/a2a/agents/software-engineer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: '3',
            method: 'tasks/get',
            params: { id: 'nonexistent' },
          }),
        }),
      );

      const body = await res.json() as { error?: { code: number } };
      expect(body.error).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Internal fetch() transport
  // -------------------------------------------------------------------------

  describe('fetch() transport', () => {
    it('returns a Response object', async () => {
      const res = await server.fetch(
        new Request('http://talon.internal/.well-known/agent-card.json'),
      );
      expect(res).toBeInstanceOf(Response);
    });

    it('sets content-type to application/json', async () => {
      const res = await server.fetch(
        new Request('http://talon.internal/.well-known/agent-card.json'),
      );
      expect(res.headers.get('content-type')).toContain('application/json');
    });
  });
});
