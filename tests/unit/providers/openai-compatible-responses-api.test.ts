import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestContext } from '@mastra/core/di';
import { describe, expect, it, vi } from 'vitest';
import { createTool } from '@mastra/core/tools';
import { createWorkspaceTools, LocalFilesystem, Workspace } from '@mastra/core/workspace';
import { z } from 'zod';
import {
  buildResponsesTools,
  runResponsesLoop,
  type ResponsesWrapperEvent,
} from '../../../src/providers/openai-compatible/agent-cli/responses-api.js';

describe('openai-compatible Responses API runner', () => {
  it('uses the executable tool map key as the Responses tool name', () => {
    const tool = createTool({
      id: 'internal_id',
      description: 'Read a file',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => 'ok',
    });

    expect(buildResponsesTools({ read_file: tool })).toEqual([
      expect.objectContaining({
        name: 'read_file',
        description: 'Read a file',
      }),
    ]);
  });

  it('chains tool-call turns through previous_response_id and returns the final response id', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), body });

      if (requests.length === 1) {
        return new Response(
          JSON.stringify({
            id: 'resp-tool',
            output: [
              {
                type: 'function_call',
                call_id: 'call-read',
                name: 'read_file',
                arguments: JSON.stringify({ path: 'README.md' }),
              },
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 5,
              input_tokens_details: { cached_tokens: 40 },
            },
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          id: 'resp-final',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'File says hello.' }],
            },
          ],
          usage: {
            input_tokens: 30,
            output_tokens: 7,
            input_tokens_details: { cached_tokens: 30 },
          },
        }),
        { status: 200 },
      );
    });

    const events: ResponsesWrapperEvent[] = [];
    const readFile = createTool({
      id: 'read_file',
      description: 'Read a file',
      inputSchema: z.object({
        path: z.string(),
      }),
      execute: async (input) => `contents of ${input.path}`,
    });

    const result = await runResponsesLoop({
      prompt: 'Read README.md',
      systemPrompt: 'You are a coding agent.',
      model: 'qwen3.5-9b-optiq-4bit',
      baseUrl: 'http://127.0.0.1:8000/v1',
      tools: { read_file: readFile },
      maxSteps: 5,
      streamEvents: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      emit: (event) => events.push(event),
    });

    expect(result).toEqual({
      output: 'File says hello.',
      responseId: 'resp-final',
      usage: { inputTokens: 130, outputTokens: 12, cacheReadTokens: 70 },
      lastStepUsage: { inputTokens: 30, outputTokens: 7, cacheReadTokens: 30 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(requests[0]?.url).toBe('http://127.0.0.1:8000/v1/responses');
    expect(requests[0]?.body).toMatchObject({
      model: 'qwen3.5-9b-optiq-4bit',
      input: 'Read README.md',
      instructions: 'You are a coding agent.',
      store: true,
    });
    expect(requests[0]?.body.previous_response_id).toBeUndefined();
    expect(requests[0]?.body.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            path: expect.objectContaining({ type: 'string' }),
          }),
        }),
      }),
    ]);
    expect(requests[1]?.body).toMatchObject({
      model: 'qwen3.5-9b-optiq-4bit',
      previous_response_id: 'resp-tool',
      input: [
        {
          type: 'function_call_output',
          call_id: 'call-read',
          output: 'contents of README.md',
        },
      ],
      store: true,
    });
    expect(requests[1]?.body.instructions).toBeUndefined();
    expect(events).toEqual([
      {
        type: 'tool_event',
        messageType: 'tool_use',
        tool: 'read_file',
        toolUseId: 'call-read',
        input: { path: 'README.md' },
      },
      {
        type: 'tool_event',
        messageType: 'tool_result',
        tool: 'read_file',
        toolUseId: 'call-read',
        output: 'contents of README.md',
        isError: false,
      },
      { type: 'text', content: 'File says hello.' },
    ]);
  });

  it('passes the abort signal into Responses API fetch calls', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(
        JSON.stringify({
          id: 'resp-final',
          output_text: 'done',
          usage: {
            input_tokens: 12,
            output_tokens: 2,
          },
        }),
        { status: 200 },
      );
    });

    const result = await runResponsesLoop({
      prompt: 'Say done',
      systemPrompt: 'You are a coding agent.',
      model: 'qwen3.5-9b-optiq-4bit',
      baseUrl: 'http://127.0.0.1:8000/v1',
      tools: {},
      executionContext: {
        abortSignal: controller.signal,
      },
      maxSteps: 5,
      streamEvents: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      emit: vi.fn(),
    });

    expect(result.output).toBe('done');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns invalid JSON tool arguments as a tool error without executing the tool', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (!body.previous_response_id) {
        return new Response(
          JSON.stringify({
            id: 'resp-tool',
            output: [
              {
                type: 'function_call',
                call_id: 'call-bad',
                name: 'read_file',
                arguments: '{not-json',
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          id: 'resp-final',
          output_text: 'recovered',
        }),
        { status: 200 },
      );
    });
    const execute = vi.fn(async () => 'should not run');
    const events: ResponsesWrapperEvent[] = [];

    await runResponsesLoop({
      prompt: 'Read README.md',
      systemPrompt: 'You are a coding agent.',
      model: 'qwen3.5-9b-optiq-4bit',
      baseUrl: 'http://127.0.0.1:8000/v1',
      tools: {
        read_file: createTool({
          id: 'read_file',
          description: 'Read a file',
          inputSchema: z.object({ path: z.string() }),
          execute,
        }),
      },
      maxSteps: 5,
      streamEvents: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      emit: (event) => events.push(event),
    });

    expect(execute).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:8000/v1/responses',
      expect.objectContaining({
        body: expect.stringContaining('Invalid JSON arguments for tool call.'),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_event',
        messageType: 'tool_result',
        toolUseId: 'call-bad',
        isError: true,
        output: 'Invalid JSON arguments for tool call.',
      }),
    );
  });

  it('validates tool inputs before execution', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (!body.previous_response_id) {
        return new Response(
          JSON.stringify({
            id: 'resp-tool',
            output: [
              {
                type: 'function_call',
                call_id: 'call-invalid',
                name: 'read_file',
                arguments: JSON.stringify({}),
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          id: 'resp-final',
          output_text: 'recovered',
        }),
        { status: 200 },
      );
    });
    const execute = vi.fn(async () => 'should not run');

    await runResponsesLoop({
      prompt: 'Read README.md',
      systemPrompt: 'You are a coding agent.',
      model: 'qwen3.5-9b-optiq-4bit',
      baseUrl: 'http://127.0.0.1:8000/v1',
      tools: {
        read_file: createTool({
          id: 'read_file',
          description: 'Read a file',
          inputSchema: z.object({ path: z.string() }),
          execute,
        }),
      },
      maxSteps: 5,
      streamEvents: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      emit: vi.fn(),
    });

    expect(execute).not.toHaveBeenCalled();
    const secondBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as {
      input: Array<{ output: string }>;
    };
    expect(secondBody.input[0]?.output).toContain('Invalid arguments for tool "read_file"');
  });

  it('passes a Mastra-like execution context to tools', async () => {
    let receivedContext: unknown;
    const requestContext = new RequestContext();
    const workspace = { id: 'workspace-test' } as unknown as Workspace;
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (!body.previous_response_id) {
        return new Response(
          JSON.stringify({
            id: 'resp-tool',
            output: [
              {
                type: 'function_call',
                call_id: 'call-context',
                name: 'inspect_context',
                arguments: JSON.stringify({ value: 'x' }),
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          id: 'resp-final',
          output_text: 'done',
        }),
        { status: 200 },
      );
    });

    await runResponsesLoop({
      prompt: 'Inspect context',
      systemPrompt: 'You are a coding agent.',
      model: 'qwen3.5-9b-optiq-4bit',
      baseUrl: 'http://127.0.0.1:8000/v1',
      tools: {
        inspect_context: createTool({
          id: 'inspect_context',
          description: 'Inspect context',
          inputSchema: z.object({ value: z.string() }),
          execute: async (_input, context) => {
            receivedContext = context;
            return 'ok';
          },
        }),
      },
      maxSteps: 5,
      streamEvents: false,
      executionContext: {
        workspace,
        requestContext,
        threadId: 'thread-test',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      emit: vi.fn(),
    });

    expect(receivedContext).toMatchObject({
      workspace,
      requestContext,
      toolCallId: 'call-context',
      options: { toolCallId: 'call-context' },
      writer: { custom: expect.any(Function) },
      agent: {
        agentId: 'openai-compatible-cli',
        toolCallId: 'call-context',
        threadId: 'thread-test',
        messages: [],
      },
    });
  });

  it('executes Mastra workspace tools with workspace context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'talon-responses-workspace-'));
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: dir, contained: false }),
    });
    await workspace.init();
    writeFileSync(join(dir, 'README.md'), 'hello from workspace\n');
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (!body.previous_response_id) {
        return new Response(
          JSON.stringify({
            id: 'resp-tool',
            output: [
              {
                type: 'function_call',
                call_id: 'call-read',
                name: 'mastra_workspace_read_file',
                arguments: JSON.stringify({ path: 'README.md', showLineNumbers: false }),
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          id: 'resp-final',
          output_text: 'done',
        }),
        { status: 200 },
      );
    });

    try {
      await runResponsesLoop({
        prompt: 'Read README.md',
        systemPrompt: 'You are a coding agent.',
        model: 'qwen3.5-9b-optiq-4bit',
        baseUrl: 'http://127.0.0.1:8000/v1',
        tools: createWorkspaceTools(workspace),
        maxSteps: 5,
        streamEvents: false,
        executionContext: {
          workspace,
          requestContext: new RequestContext(),
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        emit: vi.fn(),
      });
    } finally {
      await workspace.destroy();
      rmSync(dir, { recursive: true, force: true });
    }

    const secondBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as {
      input: Array<{ output: string }>;
    };
    expect(secondBody.input[0]?.output).toContain('hello from workspace');
  });

  it('resumes from an existing response id without resending system instructions', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: 'resp-new',
          output_text: 'continued',
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { status: 200 },
      );
    });

    const result = await runResponsesLoop({
      prompt: 'Continue',
      systemPrompt: 'System prompt that is already in the chain.',
      model: 'qwen3.5-9b-optiq-4bit',
      baseUrl: 'http://127.0.0.1:8000/v1',
      previousResponseId: 'resp-old',
      tools: {},
      maxSteps: 5,
      streamEvents: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      emit: vi.fn(),
    });

    expect(result.responseId).toBe('resp-new');
    expect(result.output).toBe('continued');
    expect(bodies[0]).toMatchObject({
      previous_response_id: 'resp-old',
      input: 'Continue',
    });
    expect(bodies[0]?.instructions).toBeUndefined();
  });
});
