import { describe, it, expect, vi } from 'vitest';
import { SubAgentInvokeHandler } from '../../../src/tools/host-tools/subagent-invoke.js';
import { ok, err } from 'neverthrow';
import { ToolError } from '../../../src/core/errors/index.js';
import { createVoiceObservationContext } from '../../../src/observability/langfuse/voice-observation.js';

const makeLogger = () =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }) as any;

describe('SubAgentInvokeHandler', () => {
  it('has correct manifest', () => {
    expect(SubAgentInvokeHandler.manifest.name).toBe('subagent.invoke');
    expect(SubAgentInvokeHandler.manifest.capabilities).toContain('subagent.invoke');
    expect(SubAgentInvokeHandler.manifest.executionLocation).toBe('host');
  });

  it('delegates to runner and returns success result', async () => {
    const execute = vi.fn().mockResolvedValue(ok({ summary: 'Done', data: { key: 'value' } }));
    const voiceObservation = createVoiceObservationContext({
      callId: 'voice-call-1',
      runId: 'r1',
      threadId: 't1',
    });
    const handler = new SubAgentInvokeHandler({
      runner: {
        execute,
      } as any,
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: { subagents: ['test-agent'] },
            resolvedCapabilities: { allow: ['subagent.invoke'], requireApproval: [] },
          }),
        ),
      } as any,
      personaRepository: { findById: vi.fn().mockReturnValue(ok({ name: 'bot' })) } as any,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      { name: 'test-agent', input: { query: 'hello' } },
      {
        runId: 'r1',
        threadId: 't1',
        personaId: 'p1',
        traceparent: '00-trace-parent-01',
        voiceObservation,
      },
    );

    expect(result.status).toBe('success');
    expect(result.result).toEqual({ summary: 'Done', data: { key: 'value' } });
    expect(execute).toHaveBeenCalledWith(
      'test-agent',
      { query: 'hello' },
      expect.objectContaining({
        threadId: 't1',
        personaId: 'p1',
        traceparent: '00-trace-parent-01',
        voiceObservation,
      }),
    );
  });

  it('returns error when runner rejects', async () => {
    const handler = new SubAgentInvokeHandler({
      runner: {
        execute: vi.fn().mockResolvedValue(err(new ToolError('Sub-agent "x" not found'))),
      } as any,
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: { subagents: ['x'] },
            resolvedCapabilities: { allow: ['subagent.invoke'], requireApproval: [] },
          }),
        ),
      } as any,
      personaRepository: { findById: vi.fn().mockReturnValue(ok({ name: 'bot' })) } as any,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      { name: 'x', input: {} },
      { runId: 'r1', threadId: 't1', personaId: 'p1' },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('not found');
  });

  it('redacts runner errors for trusted voice descendants', async () => {
    const rejectedName = 'regex-safe-rejected-subagent-name';
    const handler = new SubAgentInvokeHandler({
      runner: {
        execute: vi
          .fn()
          .mockResolvedValue(err(new ToolError(`Unknown sub-agent "${rejectedName}"`))),
      } as any,
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: { subagents: [] },
            resolvedCapabilities: { allow: ['subagent.invoke'], requireApproval: [] },
          }),
        ),
      } as any,
      personaRepository: { findById: vi.fn().mockReturnValue(ok({ name: 'bot' })) } as any,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      { name: rejectedName, input: {} },
      {
        runId: 'voice-run',
        threadId: 'voice-thread',
        personaId: 'p1',
        voiceObservation: createVoiceObservationContext({
          callId: 'voice-call',
          runId: 'voice-run',
          threadId: 'voice-thread',
        }),
      },
    );

    expect(result).toEqual({
      requestId: 'unknown',
      tool: 'subagent.invoke',
      status: 'error',
      error: 'subagent.invoke failed',
    });
    expect(JSON.stringify(result)).not.toContain(rejectedName);
  });

  it('returns error when name is whitespace-only', async () => {
    const handler = new SubAgentInvokeHandler({
      runner: { execute: vi.fn() } as any,
      personaLoader: { getByName: vi.fn() } as any,
      personaRepository: { findById: vi.fn() } as any,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      { name: '   ' },
      { runId: 'r1', threadId: 't1', personaId: 'p1' },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('name');
  });

  it('returns error when name is missing', async () => {
    const handler = new SubAgentInvokeHandler({
      runner: { execute: vi.fn() } as any,
      personaLoader: { getByName: vi.fn() } as any,
      personaRepository: { findById: vi.fn() } as any,
      logger: makeLogger(),
    });

    const result = await handler.execute({ input: {} } as any, {
      runId: 'r1',
      threadId: 't1',
      personaId: 'p1',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('name');
  });

  it('returns error when persona not found in DB', async () => {
    const handler = new SubAgentInvokeHandler({
      runner: { execute: vi.fn() } as any,
      personaLoader: { getByName: vi.fn() } as any,
      personaRepository: { findById: vi.fn().mockReturnValue(ok(null)) } as any,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      { name: 'test' },
      { runId: 'r1', threadId: 't1', personaId: 'p1' },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('Persona not found');
  });

  it('returns error when loaded persona not found in cache', async () => {
    const handler = new SubAgentInvokeHandler({
      runner: { execute: vi.fn() } as any,
      personaLoader: { getByName: vi.fn().mockReturnValue(ok(undefined)) } as any,
      personaRepository: { findById: vi.fn().mockReturnValue(ok({ name: 'ghost' })) } as any,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      { name: 'test' },
      { runId: 'r1', threadId: 't1', personaId: 'p1' },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('Loaded persona not found');
  });
});
