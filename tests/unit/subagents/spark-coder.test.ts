import { describe, it, expect, vi } from 'vitest';

vi.mock('ai', () => ({
  generateObject: vi.fn().mockResolvedValue({
    object: {
      files: [
        {
          path: 'src/utils/parser.ts',
          content: 'export function parse(input: string): string[] { return input.split(","); }',
          action: 'create',
        },
      ],
      explanation: 'Created a simple CSV parser utility.',
    },
    usage: { inputTokens: 300, outputTokens: 150 },
  }),
}));

import { run } from '../../../src/subagents/default/spark-coder/index.js';

const makeCtx = () => ({
  threadId: 'thread-1',
  personaId: 'persona-1',
  systemPrompt: 'You are a fast code generator.',
  model: {} as any,
  maxOutputTokens: 16384,
  rootPaths: [],
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
  telemetry: { isEnabled: false },
});

describe('spark-coder', () => {
  it('returns structured file operations from task', async () => {
    const result = await run(makeCtx(), {
      task: 'Create a CSV parser utility',
    });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.data).toBeDefined();
    expect((value.data as any).files).toHaveLength(1);
    expect((value.data as any).files[0].path).toBe('src/utils/parser.ts');
    expect((value.data as any).files[0].action).toBe('create');
    expect(value.usage).toBeDefined();
    expect(value.usage!.inputTokens).toBe(300);
    expect(value.summary).toBe('Created a simple CSV parser utility.');
  });

  it('includes context files in prompt when provided', async () => {
    const { generateObject } = await import('ai');

    await run(makeCtx(), {
      task: 'Add a parseJSON method',
      contextFiles: [
        { path: 'src/utils/parser.ts', content: 'export function parse() {}' },
      ],
    });

    expect(generateObject).toHaveBeenCalled();
    const call = (generateObject as any).mock.calls.at(-1)[0];
    expect(call.prompt).toContain('src/utils/parser.ts');
    expect(call.prompt).toContain('export function parse() {}');
  });

  it('includes constraints in prompt when provided', async () => {
    const { generateObject } = await import('ai');

    await run(makeCtx(), {
      task: 'Create a helper',
      constraints: 'TypeScript strict, no external deps',
    });

    const call = (generateObject as any).mock.calls.at(-1)[0];
    expect(call.prompt).toContain('Constraints: TypeScript strict, no external deps');
  });

  it('returns error for empty task', async () => {
    const result = await run(makeCtx(), { task: '' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('task description');
  });

  it('returns error when task is not provided', async () => {
    const result = await run(makeCtx(), {});
    expect(result.isErr()).toBe(true);
  });

  it('returns error when generateObject throws', async () => {
    const { generateObject } = await import('ai');
    (generateObject as any).mockRejectedValueOnce(new Error('Model unavailable'));

    const result = await run(makeCtx(), { task: 'Create something' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Code generation failed');
  });

  it('handles missing contextFiles gracefully', async () => {
    const { generateObject } = await import('ai');

    await run(makeCtx(), { task: 'Create a utility' });

    const call = (generateObject as any).mock.calls.at(-1)[0];
    expect(call.prompt).toContain('(no context files provided)');
  });

  it('filters out malformed contextFiles entries', async () => {
    const { generateObject } = await import('ai');

    await run(makeCtx(), {
      task: 'Create a utility',
      contextFiles: [
        null,
        42,
        { path: 'valid.ts', content: 'code' },
        { path: 'no-content' },
        'string',
      ],
    });

    const call = (generateObject as any).mock.calls.at(-1)[0];
    expect(call.prompt).toContain('valid.ts');
    expect(call.prompt).not.toContain('no-content');
  });

  it('passes SparkCoderOutputSchema to generateObject', async () => {
    const { generateObject } = await import('ai');

    await run(makeCtx(), { task: 'Create a utility' });

    const call = (generateObject as any).mock.calls.at(-1)[0];
    expect(call.schema).toBeDefined();
    // Verify the schema shape by parsing a valid object
    const parsed = call.schema.safeParse({
      files: [{ path: 'src/foo.ts', content: 'code', action: 'create' }],
      explanation: 'Created foo',
    });
    expect(parsed.success).toBe(true);
  });

  it('schema rejects absolute paths in output', async () => {
    const { generateObject } = await import('ai');

    await run(makeCtx(), { task: 'Create a utility' });

    const call = (generateObject as any).mock.calls.at(-1)[0];
    const parsed = call.schema.safeParse({
      files: [{ path: '/etc/passwd', content: 'bad', action: 'create' }],
      explanation: 'Nope',
    });
    expect(parsed.success).toBe(false);
  });

  it('schema rejects path traversal in output', async () => {
    const { generateObject } = await import('ai');

    await run(makeCtx(), { task: 'Create a utility' });

    const call = (generateObject as any).mock.calls.at(-1)[0];
    const parsed = call.schema.safeParse({
      files: [{ path: '../../../etc/shadow', content: 'bad', action: 'create' }],
      explanation: 'Nope',
    });
    expect(parsed.success).toBe(false);
  });
});
