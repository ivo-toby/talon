import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SubAgentLoader } from '../../src/subagents/subagent-loader.js';
import { SubAgentRunner } from '../../src/subagents/subagent-runner.js';
import { ok } from 'neverthrow';

describe('Sub-agent pipeline integration', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `subagent-integration-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads, validates, and executes a sub-agent end-to-end', async () => {
    const agentDir = join(root, 'echo-agent');
    mkdirSync(join(agentDir, 'prompts'), { recursive: true });

    writeFileSync(
      join(agentDir, 'subagent.yaml'),
      [
        'name: echo-agent',
        'version: "0.1.0"',
        'description: "Echoes input back"',
        'model:',
        '  provider: anthropic',
        '  name: claude-haiku-4-5-20251001',
        '  maxTokens: 1024',
        'requiredCapabilities: []',
        'rootPaths: []',
        'timeoutMs: 10000',
      ].join('\n'),
    );

    // Entry point must return Result via neverthrow
    writeFileSync(
      join(agentDir, 'index.js'),
      `
      export async function run(ctx, input) {
        const { ok } = await import('neverthrow');
        return ok({ summary: 'Echoed: ' + input.message, data: { echo: input.message } });
      }
      `,
    );

    writeFileSync(join(agentDir, 'prompts', '01-system.md'), 'You echo things.');

    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child() { return this; },
    } as any;

    // 1. Load
    const loader = new SubAgentLoader(logger);
    const loaded = await loader.loadAll(root);
    expect(loaded.isOk()).toBe(true);
    const agents = loaded._unsafeUnwrap();
    expect(agents).toHaveLength(1);
    expect(agents[0].promptContents).toEqual(['You echo things.']);

    // 2. Build runner with mock model resolver
    const agentMap = new Map(agents.map((a) => [a.manifest.name, a]));
    const mockResolver = {
      resolve: vi.fn().mockResolvedValue(ok({} as any)),
    };
    const mockServices = {
      memory: {} as any,
      schedules: {} as any,
      personas: {} as any,
      channels: {} as any,
      threads: {} as any,
      messages: {} as any,
      runs: {} as any,
      queue: {} as any,
      logger,
    };
    const runner = new SubAgentRunner(agentMap, mockResolver as any, mockServices, logger);

    // 3. Execute
    const result = await runner.execute('echo-agent', { message: 'hello' }, {
      threadId: 'thread-1',
      personaId: 'persona-1',
      personaSubagents: ['echo-agent'],
      personaCapabilities: { allow: [], requireApproval: [] },
    });

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.summary).toBe('Echoed: hello');
    expect(value.data).toEqual({ echo: 'hello' });
  });

  it('rejects execution when persona lacks assignment', async () => {
    const agentDir = join(root, 'test-agent');
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(
      join(agentDir, 'subagent.yaml'),
      [
        'name: test-agent',
        'version: "0.1.0"',
        'description: "Test"',
        'model:',
        '  provider: anthropic',
        '  name: claude-haiku-4-5-20251001',
        '  maxTokens: 1024',
        'requiredCapabilities: []',
        'rootPaths: []',
        'timeoutMs: 10000',
      ].join('\n'),
    );

    writeFileSync(
      join(agentDir, 'index.js'),
      `export async function run() { const { ok } = await import('neverthrow'); return ok({ summary: 'ok' }); }`,
    );

    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child() { return this; },
    } as any;

    const loader = new SubAgentLoader(logger);
    const loaded = await loader.loadAll(root);
    const agents = loaded._unsafeUnwrap();
    const agentMap = new Map(agents.map((a) => [a.manifest.name, a]));
    const mockResolver = { resolve: vi.fn() };
    const mockServices = {
      memory: {} as any, schedules: {} as any, personas: {} as any,
      channels: {} as any, threads: {} as any, messages: {} as any,
      runs: {} as any, queue: {} as any, logger,
    };
    const runner = new SubAgentRunner(agentMap, mockResolver as any, mockServices, logger);

    // personaSubagents does NOT include test-agent
    const result = await runner.execute('test-agent', {}, {
      threadId: 'thread-1',
      personaId: 'persona-1',
      personaSubagents: [],
      personaCapabilities: { allow: [], requireApproval: [] },
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('not assigned');
  });
});
