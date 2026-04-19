import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

import { run } from '../../../src/subagents/default/session-observer/index.js';
import { generateText } from 'ai';

const makeCtx = (): any => ({
  threadId: 'thread-1',
  personaId: 'persona-1',
  systemPrompt: 'You are a session observer.',
  model: {} as any,
  maxOutputTokens: 8192,
  rootPaths: [],
  telemetry: { isEnabled: false },
  services: {
    memory: {} as any,
    schedules: {} as any,
    personas: {} as any,
    channels: {} as any,
    threads: {} as any,
    messages: {} as any,
    runs: {} as any,
    queue: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  },
});

const baseObservation = {
  date: '2026-04-19',
  time: '10:00',
  priority: 'high' as const,
  text: 'user asked to deploy',
};

describe('session-observer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns structured output with normalized boolean taskComplete', async () => {
    (generateText as any).mockResolvedValueOnce({
      text: JSON.stringify({
        observations: [baseObservation],
        taskComplete: true,
        currentTask: '',
        suggestedContinuation: '',
        memoryUpdates: [],
      }),
      usage: { inputTokens: 500, outputTokens: 200 },
    });

    const result = await run(makeCtx(), { transcript: 'User: hi\nAssistant: hello' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap().data as any;
    expect(data.taskComplete).toBe(true);
    expect(data.observations).toHaveLength(1);
  });

  it('coerces string "false" taskComplete to boolean false', async () => {
    (generateText as any).mockResolvedValueOnce({
      text: JSON.stringify({
        observations: [baseObservation],
        taskComplete: 'false',
        currentTask: 'implementing X',
        suggestedContinuation: 'finish step 3',
        memoryUpdates: [],
      }),
      usage: { inputTokens: 500, outputTokens: 200 },
    });

    const result = await run(makeCtx(), { transcript: 'User: do X' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap().data as any;
    expect(data.taskComplete).toBe(false);
    expect(data.currentTask).toBe('implementing X');
    expect(data.suggestedContinuation).toBe('finish step 3');
  });

  it('defaults taskComplete to true when the field is missing', async () => {
    (generateText as any).mockResolvedValueOnce({
      text: JSON.stringify({
        observations: [baseObservation],
        currentTask: 'ignored',
        suggestedContinuation: 'ignored',
        memoryUpdates: [],
      }),
      usage: { inputTokens: 500, outputTokens: 200 },
    });

    const result = await run(makeCtx(), { transcript: 'User: hi' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap().data as any;
    expect(data.taskComplete).toBe(true);
    // When taskComplete is true, hints are blanked out regardless of what
    // the model returned — downstream consumers (context-assembler) must
    // not see conflicting signals.
    expect(data.currentTask).toBe('');
    expect(data.suggestedContinuation).toBe('');
  });

  it('defaults taskComplete to true for unrecognized values (safe default)', async () => {
    (generateText as any).mockResolvedValueOnce({
      text: JSON.stringify({
        observations: [baseObservation],
        taskComplete: 42,
        currentTask: 'should not leak',
        suggestedContinuation: 'should not leak',
        memoryUpdates: [],
      }),
      usage: { inputTokens: 500, outputTokens: 200 },
    });

    const result = await run(makeCtx(), { transcript: 'User: hi' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap().data as any;
    expect(data.taskComplete).toBe(true);
    expect(data.currentTask).toBe('');
    expect(data.suggestedContinuation).toBe('');
  });

  it('blanks hints when taskComplete is true even if the model returned them', async () => {
    (generateText as any).mockResolvedValueOnce({
      text: JSON.stringify({
        observations: [baseObservation],
        taskComplete: true,
        currentTask: 'leftover',
        suggestedContinuation: 'leftover',
        memoryUpdates: [],
      }),
      usage: { inputTokens: 500, outputTokens: 200 },
    });

    const result = await run(makeCtx(), { transcript: 'User: hi' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap().data as any;
    expect(data.currentTask).toBe('');
    expect(data.suggestedContinuation).toBe('');
  });

  it('returns error for empty transcript', async () => {
    const result = await run(makeCtx(), { transcript: '' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('empty');
  });

  it('returns error when observations field is missing', async () => {
    (generateText as any).mockResolvedValueOnce({
      text: JSON.stringify({ taskComplete: true }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const result = await run(makeCtx(), { transcript: 'User: hi' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('observations array');
  });

  it('extracts JSON from markdown fences', async () => {
    (generateText as any).mockResolvedValueOnce({
      text: '```json\n' + JSON.stringify({
        observations: [baseObservation],
        taskComplete: true,
        currentTask: '',
        suggestedContinuation: '',
        memoryUpdates: [],
      }) + '\n```',
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const result = await run(makeCtx(), { transcript: 'User: hi' });
    expect(result.isOk()).toBe(true);
  });

  it('returns error when response is not JSON at all', async () => {
    (generateText as any).mockResolvedValueOnce({
      text: 'Sorry, I cannot do that.',
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const result = await run(makeCtx(), { transcript: 'User: hi' });
    expect(result.isErr()).toBe(true);
  });
});
