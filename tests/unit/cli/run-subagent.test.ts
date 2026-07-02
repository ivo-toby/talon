import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Shared mock resolve implementation. Individual tests can override it via
// `resolveMock.mockImplementation(...)` to exercise failover and gate paths.
interface MockResolveInput {
  provider: string;
  name: string;
  maxTokens: number;
}
const resolveMock = vi.fn<(config: MockResolveInput) => Promise<{
  isErr: () => boolean;
  isOk: () => boolean;
  value?: unknown;
  error?: { message: string };
}>>();

// Mock the model resolver to avoid needing real API keys.
vi.mock('../../../src/subagents/model-resolver.js', () => ({
  ModelResolver: class {
    async resolve(config: MockResolveInput) {
      return resolveMock(config);
    }
  },
}));

import { runSubAgent } from '../../../src/cli/commands/run-subagent.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `run-subagent-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSubAgent(root: string, name: string, runBody: string): void {
  const agentDir = join(root, name);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'subagent.yaml'),
    [
      `name: ${name}`,
      'version: "0.1.0"',
      `description: "Test agent ${name}"`,
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
    runBody,
  );
}

describe('runSubAgent()', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
    // Default: resolver always succeeds. Individual tests override as needed.
    resolveMock.mockReset();
    resolveMock.mockImplementation(async () => ({
      isErr: () => false,
      isOk: () => true,
      value: {},
    }));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads and executes a sub-agent by name', async () => {
    writeSubAgent(root, 'echo-agent', `
      export async function run(ctx, input) {
        const { ok } = await import('neverthrow');
        return ok({ summary: 'Echo: ' + (input.prompt || ''), data: { prompt: input.prompt } });
      }
    `);

    const result = await runSubAgent({
      name: 'echo-agent',
      input: '{"prompt": "hello"}',
      subagentsDir: root,
      providers: { anthropic: { apiKey: 'test' } },
    });

    expect(result.summary).toContain('hello');
  });

  it('throws for unknown sub-agent', async () => {
    writeSubAgent(root, 'other-agent', `
      export async function run() {
        const { ok } = await import('neverthrow');
        return ok({ summary: 'ok' });
      }
    `);

    await expect(
      runSubAgent({
        name: 'nonexistent',
        input: '{}',
        subagentsDir: root,
        providers: {},
      }),
    ).rejects.toThrow('not found');
  });

  it('throws for invalid JSON input', async () => {
    writeSubAgent(root, 'test-agent', `
      export async function run() {
        const { ok } = await import('neverthrow');
        return ok({ summary: 'ok' });
      }
    `);

    await expect(
      runSubAgent({
        name: 'test-agent',
        input: 'not-json',
        subagentsDir: root,
        providers: { anthropic: { apiKey: 'test' } },
      }),
    ).rejects.toThrow('Invalid JSON');
  });

  it('throws when sub-agent run returns an error', async () => {
    writeSubAgent(root, 'fail-agent', `
      export async function run() {
        const { err } = await import('neverthrow');
        return err(new Error('Something went wrong'));
      }
    `);

    await expect(
      runSubAgent({
        name: 'fail-agent',
        input: '{}',
        subagentsDir: root,
        providers: { anthropic: { apiKey: 'test' } },
      }),
    ).rejects.toThrow('Sub-agent execution failed');
  });

  it('throws for non-object JSON input (array)', async () => {
    writeSubAgent(root, 'test-agent', `
      export async function run() {
        const { ok } = await import('neverthrow');
        return ok({ summary: 'ok' });
      }
    `);

    await expect(
      runSubAgent({
        name: 'test-agent',
        input: '[1, 2, 3]',
        subagentsDir: root,
        providers: { anthropic: { apiKey: 'test' } },
      }),
    ).rejects.toThrow('must be a JSON object');
  });

  it('throws for non-object JSON input (string)', async () => {
    writeSubAgent(root, 'test-agent', `
      export async function run() {
        const { ok } = await import('neverthrow');
        return ok({ summary: 'ok' });
      }
    `);

    await expect(
      runSubAgent({
        name: 'test-agent',
        input: '"just a string"',
        subagentsDir: root,
        providers: { anthropic: { apiKey: 'test' } },
      }),
    ).rejects.toThrow('must be a JSON object');
  });

  it('throws for empty subagents directory', async () => {
    await expect(
      runSubAgent({
        name: 'anything',
        input: '{}',
        subagentsDir: root,
        providers: {},
      }),
    ).rejects.toThrow('not found');
  });

  // ---------------------------------------------------------------------------
  // Failover + provider override tests
  //
  // The CLI `runSubAgent` has its own model-resolution loop (separate from
  // SubAgentRunner). These tests lock in the contract: the loop tries each
  // override in order, selects the first that resolves, and otherwise falls
  // back to the manifest model. They also verify that per-model timeout and
  // providerOptions propagate correctly into the SubAgentContext handed to the
  // sub-agent's run function.
  // ---------------------------------------------------------------------------

  describe('failover + per-model overrides', () => {
    function writeCapturingAgent(root: string, name: string): void {
      // Captures the ctx it receives so tests can assert on
      // maxOutputTokens, abortSignal, providerOptions, etc.
      writeSubAgent(root, name, `
        export async function run(ctx, input) {
          const { ok } = await import('neverthrow');
          globalThis.__lastCtx = {
            maxOutputTokens: ctx.maxOutputTokens,
            hasAbortSignal: ctx.abortSignal instanceof AbortSignal,
            providerOptions: ctx.providerOptions,
          };
          return ok({ summary: 'captured' });
        }
      `);
    }

    it('picks the first override that resolves', async () => {
      writeCapturingAgent(root, 'capture-agent');

      // First override (ollama) fails; second (anthropic) succeeds.
      resolveMock.mockImplementationOnce(async () => ({
        isErr: () => true,
        isOk: () => false,
        error: { message: 'ollama unreachable' },
      }));
      resolveMock.mockImplementationOnce(async () => ({
        isErr: () => false,
        isOk: () => true,
        value: {},
      }));

      const result = await runSubAgent({
        name: 'capture-agent',
        input: '{}',
        subagentsDir: root,
        providers: {
          ollama: { baseURL: 'http://localhost:8080/v1' },
          anthropic: { apiKey: 'test' },
        },
        subagentOverrides: {
          'capture-agent': {
            model: [
              { provider: 'ollama', name: 'qwen3-30b', maxTokens: 4096 },
              { provider: 'anthropic', name: 'claude-haiku-4-5-20251001', maxTokens: 2048 },
            ],
          },
        },
      });

      expect(result.summary).toBe('captured');
      // Resolver was called twice (ollama fail → anthropic success).
      expect(resolveMock).toHaveBeenCalledTimes(2);
      expect(resolveMock.mock.calls[0]![0].provider).toBe('ollama');
      expect(resolveMock.mock.calls[1]![0].provider).toBe('anthropic');
      // Context carries the second entry's maxTokens.
      expect((globalThis as any).__lastCtx.maxOutputTokens).toBe(2048);
    });

    it('falls back to the manifest model when all overrides fail', async () => {
      writeCapturingAgent(root, 'capture-agent');

      // All overrides fail; manifest model (anthropic/claude-haiku-4-5-20251001) must
      // still be tried by the CLI and succeed.
      resolveMock.mockImplementationOnce(async () => ({
        isErr: () => true,
        isOk: () => false,
        error: { message: 'ollama unreachable' },
      }));
      resolveMock.mockImplementationOnce(async () => ({
        isErr: () => false,
        isOk: () => true,
        value: {},
      }));

      const result = await runSubAgent({
        name: 'capture-agent',
        input: '{}',
        subagentsDir: root,
        providers: { anthropic: { apiKey: 'test' } },
        subagentOverrides: {
          'capture-agent': {
            model: [{ provider: 'ollama', name: 'qwen3-30b' }],
          },
        },
      });

      expect(result.summary).toBe('captured');
      expect(resolveMock).toHaveBeenCalledTimes(2);
      expect(resolveMock.mock.calls[1]![0].provider).toBe('anthropic');
      expect(resolveMock.mock.calls[1]![0].name).toBe('claude-haiku-4-5-20251001');
      // Context uses manifest maxTokens (1024 from writeSubAgent default).
      expect((globalThis as any).__lastCtx.maxOutputTokens).toBe(1024);
    });

    it('throws when every override AND the manifest model fail to resolve', async () => {
      writeCapturingAgent(root, 'capture-agent');

      resolveMock.mockImplementation(async () => ({
        isErr: () => true,
        isOk: () => false,
        error: { message: 'no credentials' },
      }));

      await expect(
        runSubAgent({
          name: 'capture-agent',
          input: '{}',
          subagentsDir: root,
          providers: {},
          subagentOverrides: {
            'capture-agent': {
              model: [{ provider: 'ollama', name: 'qwen3-30b' }],
            },
          },
        }),
      ).rejects.toThrow(/Model resolution failed/);
    });

    it('provides an AbortSignal on the context so sub-agents can cancel on timeout', async () => {
      writeCapturingAgent(root, 'capture-agent');

      await runSubAgent({
        name: 'capture-agent',
        input: '{}',
        subagentsDir: root,
        providers: { anthropic: { apiKey: 'test' } },
      });

      expect((globalThis as any).__lastCtx.hasAbortSignal).toBe(true);
    });

    it('wraps providerOptions under the active provider name on ollama entries', async () => {
      writeCapturingAgent(root, 'capture-agent');

      await runSubAgent({
        name: 'capture-agent',
        input: '{}',
        subagentsDir: root,
        providers: { ollama: { baseURL: 'http://localhost:8080/v1' } },
        subagentOverrides: {
          'capture-agent': {
            model: [{
              provider: 'ollama',
              name: 'qwen3',
              providerOptions: {
                chat_template_kwargs: { enable_thinking: false },
              },
            }],
          },
        },
      });

      expect((globalThis as any).__lastCtx.providerOptions).toEqual({
        ollama: { chat_template_kwargs: { enable_thinking: false } },
      });
    });

    it('drops providerOptions set on a non-ollama (typed) provider', async () => {
      // Gate prevents config injection via temperature/max_tokens on a
      // typed provider. See wrapProviderOptions.
      writeCapturingAgent(root, 'capture-agent');

      await runSubAgent({
        name: 'capture-agent',
        input: '{}',
        subagentsDir: root,
        providers: { anthropic: { apiKey: 'test' } },
        subagentOverrides: {
          'capture-agent': {
            model: [{
              provider: 'anthropic',
              name: 'claude-haiku-4-5-20251001',
              providerOptions: { temperature: 0.99, max_tokens: 999999 },
            }],
          },
        },
      });

      expect((globalThis as any).__lastCtx.providerOptions).toBeUndefined();
    });
  });
});
