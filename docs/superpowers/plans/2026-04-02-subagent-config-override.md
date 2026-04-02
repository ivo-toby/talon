# Subagent Config Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-subagent model overrides and ordered failover in `talond.yaml` so operators can control which models subagents use without editing `subagent.yaml` manifests.

**Architecture:** New top-level `subagents` config section with ordered model arrays. The runner builds a failover chain (config overrides + manifest fallback), tries each model in order, and returns the first successful result. Subagent `run()` functions are unaware of failover.

**Tech Stack:** TypeScript, Zod, vitest, neverthrow

---

### Task 1: Config Schema — Zod schemas for subagent overrides

**Files:**
- Modify: `src/core/config/config-schema.ts:341-357` (root schema)
- Modify: `src/core/config/config-types.ts` (add type exports)
- Test: `tests/unit/config/config-schema-subagents.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/config/config-schema-subagents.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TalondConfigSchema } from '../../../src/core/config/config-schema.js';

describe('TalondConfigSchema — subagents override', () => {
  it('accepts a valid subagents override config', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        'memory-groomer': {
          model: [
            { provider: 'ollama', name: 'qwen3-30b' },
            { provider: 'anthropic', name: 'claude-haiku-4-5', maxTokens: 4096 },
          ],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const overrides = result.data.subagents;
      expect(overrides['memory-groomer'].model).toHaveLength(2);
      expect(overrides['memory-groomer'].model[0].provider).toBe('ollama');
      expect(overrides['memory-groomer'].model[0].maxTokens).toBeUndefined();
      expect(overrides['memory-groomer'].model[1].maxTokens).toBe(4096);
    }
  });

  it('defaults subagents to empty object when omitted', () => {
    const result = TalondConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subagents).toEqual({});
    }
  });

  it('rejects subagent override with empty model array', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        'memory-groomer': { model: [] },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects model entry with empty provider', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        'memory-groomer': {
          model: [{ provider: '', name: 'model-name' }],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects model entry with empty name', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        'memory-groomer': {
          model: [{ provider: 'anthropic', name: '' }],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative maxTokens', () => {
    const result = TalondConfigSchema.safeParse({
      subagents: {
        'test': {
          model: [{ provider: 'anthropic', name: 'haiku', maxTokens: -1 }],
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/config/config-schema-subagents.test.ts`
Expected: FAIL — `subagents` field not recognized by schema

- [ ] **Step 3: Write minimal implementation**

In `src/core/config/config-schema.ts`, add before the root schema (around line 338):

```typescript
// ---------------------------------------------------------------------------
// Sub-agent overrides
// ---------------------------------------------------------------------------

export const SubAgentModelOverrideSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  maxTokens: z.number().int().positive().optional(),
});

export const SubAgentOverrideSchema = z.object({
  model: z.array(SubAgentModelOverrideSchema).min(1),
});

export const SubAgentsConfigSchema = z.record(z.string(), SubAgentOverrideSchema);
```

Add to `TalondConfigSchema`:

```typescript
subagents: SubAgentsConfigSchema.default({}),
```

In `src/core/config/config-types.ts`, add imports and types:

```typescript
// Add to imports:
import type { SubAgentsConfigSchema, SubAgentModelOverrideSchema } from './config-schema.js';

// Add type exports:
export type SubAgentsConfig = z.infer<typeof SubAgentsConfigSchema>;
export type SubAgentModelOverride = z.infer<typeof SubAgentModelOverrideSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/config/config-schema-subagents.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/config/config-schema.ts src/core/config/config-types.ts tests/unit/config/config-schema-subagents.test.ts
git commit -m "feat(config): add subagent model override schema (#156)"
```

---

### Task 2: Runner Failover — retry loop in SubAgentRunner

**Files:**
- Modify: `src/subagents/subagent-runner.ts` (constructor + executeInternal)
- Test: `tests/unit/subagents/subagent-runner.test.ts` (add failover tests)

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/subagents/subagent-runner.test.ts`:

```typescript
// Update makeRunner helper to accept overrides parameter:
function makeRunner(
  agents: Map<string, LoadedSubAgent> = new Map(),
  resolver: ModelResolver = mockResolver,
  observability: ObservabilityService | undefined = undefined,
  subagentOverrides: Record<string, { model: Array<{ provider: string; name: string; maxTokens?: number }> }> = {},
): SubAgentRunner {
  return new SubAgentRunner(agents, resolver, mockServices, mockLogger, observability, subagentOverrides);
}

describe('SubAgentRunner — failover', () => {
  it('uses override model when config override exists', async () => {
    const agent = makeAgent();
    const agents = new Map([['test-agent', agent]]);

    const overrideModel = {} as any;
    const manifestModel = {} as any;
    const resolver = {
      resolve: vi.fn().mockImplementation(async (config: any) => {
        if (config.provider === 'openai') return ok(overrideModel);
        return ok(manifestModel);
      }),
    } as unknown as ModelResolver;

    const runner = makeRunner(agents, resolver, undefined, {
      'test-agent': {
        model: [{ provider: 'openai', name: 'gpt-5.4-spark' }],
      },
    });

    const result = await runner.execute('test-agent', {}, makeContext());
    expect(result.isOk()).toBe(true);

    const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ctx.model).toBe(overrideModel);
  });

  it('falls back to next model in chain when first fails resolution', async () => {
    const { ConfigError } = await import('../../../src/core/errors/index.js');
    const agent = makeAgent();
    const agents = new Map([['test-agent', agent]]);

    const fallbackModel = {} as any;
    const resolver = {
      resolve: vi.fn()
        .mockResolvedValueOnce(err(new ConfigError('No credentials for ollama')))
        .mockResolvedValueOnce(ok(fallbackModel)),
    } as unknown as ModelResolver;

    const runner = makeRunner(agents, resolver, undefined, {
      'test-agent': {
        model: [
          { provider: 'ollama', name: 'qwen3-30b' },
          { provider: 'anthropic', name: 'claude-haiku-4-5' },
        ],
      },
    });

    const result = await runner.execute('test-agent', {}, makeContext());
    expect(result.isOk()).toBe(true);

    const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ctx.model).toBe(fallbackModel);
  });

  it('falls back to manifest model when all overrides fail', async () => {
    const { ConfigError } = await import('../../../src/core/errors/index.js');
    const agent = makeAgent();
    const agents = new Map([['test-agent', agent]]);

    const manifestModel = {} as any;
    const resolver = {
      resolve: vi.fn()
        .mockResolvedValueOnce(err(new ConfigError('No credentials for ollama')))
        .mockResolvedValueOnce(ok(manifestModel)),
    } as unknown as ModelResolver;

    const runner = makeRunner(agents, resolver, undefined, {
      'test-agent': {
        model: [{ provider: 'ollama', name: 'qwen3-30b' }],
      },
    });

    const result = await runner.execute('test-agent', {}, makeContext());
    expect(result.isOk()).toBe(true);

    // Second resolve call should be the manifest model
    expect(resolver.resolve).toHaveBeenCalledTimes(2);
    const secondCall = (resolver.resolve as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(secondCall.provider).toBe('anthropic');
    expect(secondCall.name).toBe('claude-haiku-4-5');
  });

  it('retries with next model when run() throws a runtime error', async () => {
    const agent = makeAgent({
      run: vi.fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(ok({ summary: 'Done via fallback' })),
    });
    const agents = new Map([['test-agent', agent]]);

    const model1 = {} as any;
    const model2 = {} as any;
    const resolver = {
      resolve: vi.fn()
        .mockResolvedValueOnce(ok(model1))
        .mockResolvedValueOnce(ok(model2)),
    } as unknown as ModelResolver;

    const runner = makeRunner(agents, resolver, undefined, {
      'test-agent': {
        model: [
          { provider: 'ollama', name: 'qwen3-30b' },
          { provider: 'anthropic', name: 'claude-haiku-4-5' },
        ],
      },
    });

    const result = await runner.execute('test-agent', {}, makeContext());
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().summary).toBe('Done via fallback');
  });

  it('returns error listing all failures when entire chain exhausted', async () => {
    const { ConfigError } = await import('../../../src/core/errors/index.js');
    const agent = makeAgent();
    const agents = new Map([['test-agent', agent]]);

    const resolver = {
      resolve: vi.fn()
        .mockResolvedValueOnce(err(new ConfigError('No creds for ollama')))
        .mockResolvedValueOnce(err(new ConfigError('No creds for anthropic'))),
    } as unknown as ModelResolver;

    const runner = makeRunner(agents, resolver, undefined, {
      'test-agent': {
        model: [{ provider: 'ollama', name: 'qwen3-30b' }],
      },
    });

    const result = await runner.execute('test-agent', {}, makeContext());
    expect(result.isErr()).toBe(true);
    const msg = result._unsafeUnwrapErr().message;
    expect(msg).toContain('All models failed');
    expect(msg).toContain('ollama');
    expect(msg).toContain('anthropic');
  });

  it('uses maxTokens from override when specified', async () => {
    const agent = makeAgent();
    const agents = new Map([['test-agent', agent]]);
    const overrideModel = {} as any;
    const resolver = {
      resolve: vi.fn().mockResolvedValue(ok(overrideModel)),
    } as unknown as ModelResolver;

    const runner = makeRunner(agents, resolver, undefined, {
      'test-agent': {
        model: [{ provider: 'openai', name: 'gpt-5.4-spark', maxTokens: 8192 }],
      },
    });

    const result = await runner.execute('test-agent', {}, makeContext());
    expect(result.isOk()).toBe(true);
    const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ctx.maxOutputTokens).toBe(8192);
  });

  it('uses manifest maxTokens when override does not specify it', async () => {
    const agent = makeAgent();
    const agents = new Map([['test-agent', agent]]);
    const overrideModel = {} as any;
    const resolver = {
      resolve: vi.fn().mockResolvedValue(ok(overrideModel)),
    } as unknown as ModelResolver;

    const runner = makeRunner(agents, resolver, undefined, {
      'test-agent': {
        model: [{ provider: 'openai', name: 'gpt-5.4-spark' }],
      },
    });

    const result = await runner.execute('test-agent', {}, makeContext());
    expect(result.isOk()).toBe(true);
    const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ctx.maxOutputTokens).toBe(2048); // from manifest default
  });

  it('behaves unchanged when no overrides configured', async () => {
    const agent = makeAgent();
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents);

    const result = await runner.execute('test-agent', { key: 'value' }, makeContext());
    expect(result.isOk()).toBe(true);
    expect(agent.run).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/subagents/subagent-runner.test.ts`
Expected: FAIL — SubAgentRunner constructor does not accept 6th parameter

- [ ] **Step 3: Write minimal implementation**

Modify `src/subagents/subagent-runner.ts`:

Add type for model override at top:

```typescript
interface ModelOverrideEntry {
  provider: string;
  name: string;
  maxTokens?: number;
}

interface SubAgentOverrides {
  model: ModelOverrideEntry[];
}
```

Update constructor to accept overrides:

```typescript
constructor(
  agents: Map<string, LoadedSubAgent>,
  modelResolver: ModelResolver,
  services: SubAgentServices,
  logger: pino.Logger,
  observability: ObservabilityService = new NoopObservabilityService(),
  private readonly subagentOverrides: Record<string, SubAgentOverrides> = {},
)
```

Replace the model resolution + execution block in `executeInternal` (lines 145-207) with the failover loop:

```typescript
try {
  // Build model chain: config overrides (if any) + manifest fallback
  const overrideConfig = this.subagentOverrides[name];
  const modelChain: Array<{ provider: string; name: string; maxTokens: number; source: string }> = [];

  if (overrideConfig) {
    for (const entry of overrideConfig.model) {
      modelChain.push({
        provider: entry.provider,
        name: entry.name,
        maxTokens: entry.maxTokens ?? agent.manifest.model.maxTokens,
        source: 'override',
      });
    }
  }

  // Always append manifest model as final fallback
  modelChain.push({
    provider: agent.manifest.model.provider,
    name: agent.manifest.model.name,
    maxTokens: agent.manifest.model.maxTokens,
    source: 'manifest',
  });

  // If no overrides, chain is just the manifest model (existing behavior)
  const failures: string[] = [];

  for (const modelEntry of modelChain) {
    // Resolve model
    const modelResult = await this.modelResolver.resolve({
      provider: modelEntry.provider,
      name: modelEntry.name,
      maxTokens: modelEntry.maxTokens,
    });

    if (modelResult.isErr()) {
      const failMsg = `${modelEntry.provider}/${modelEntry.name} (${modelEntry.source}): ${modelResult.error.message}`;
      failures.push(failMsg);
      this.logger.warn({ subagent: name, model: `${modelEntry.provider}/${modelEntry.name}`, source: modelEntry.source }, `Model resolution failed, trying next: ${modelResult.error.message}`);
      continue;
    }

    const model: LanguageModel = modelResult.value;

    // Build system prompt from prompt fragments
    const systemPrompt = agent.promptContents.join('\n\n');

    // Create a scoped logger for this sub-agent run
    const childLogger = createChildLogger(this.logger, {
      tool: `subagent:${name}`,
      threadId: ctx.threadId,
      persona: ctx.personaId,
    });

    const agentContext = {
      threadId: ctx.threadId,
      personaId: ctx.personaId,
      systemPrompt,
      model,
      maxOutputTokens: modelEntry.maxTokens,
      rootPaths: agent.manifest.rootPaths,
      services: { ...this.services, logger: childLogger },
      telemetry: { isEnabled: !(this.observability instanceof NoopObservabilityService) },
    };

    try {
      const runResult = await this.runWithTimeout(
        agent.run(agentContext, input),
        agent.manifest.timeoutMs,
        name,
      );

      if (runResult.isErr()) {
        const failMsg = `${modelEntry.provider}/${modelEntry.name} (${modelEntry.source}): ${runResult.error.message}`;
        failures.push(failMsg);
        this.logger.warn({ subagent: name, model: `${modelEntry.provider}/${modelEntry.name}` }, `Sub-agent run failed, trying next: ${runResult.error.message}`);
        continue;
      }

      if (failures.length > 0) {
        this.logger.info({ subagent: name, model: `${modelEntry.provider}/${modelEntry.name}`, failedAttempts: failures.length }, 'Sub-agent succeeded after failover');
      }

      return ok(runResult.value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failMsg = `${modelEntry.provider}/${modelEntry.name} (${modelEntry.source}): ${message}`;
      failures.push(failMsg);
      this.logger.warn({ subagent: name, model: `${modelEntry.provider}/${modelEntry.name}` }, `Sub-agent execution threw, trying next: ${message}`);
      continue;
    }
  }

  // All models exhausted
  return err(
    new ToolError(
      `All models failed for sub-agent "${name}":\n  ${failures.map((f, i) => `${i + 1}. ${f}`).join('\n  ')}`,
    ),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  return err(
    error instanceof ToolError
      ? error
      : new ToolError(message, error instanceof Error ? error : undefined),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/subagents/subagent-runner.test.ts`
Expected: PASS (all existing + all new tests)

- [ ] **Step 5: Commit**

```bash
git add src/subagents/subagent-runner.ts tests/unit/subagents/subagent-runner.test.ts
git commit -m "feat(runner): add model failover chain to SubAgentRunner (#156)"
```

---

### Task 3: Bootstrap + CLI Wiring

**Files:**
- Modify: `src/daemon/daemon-bootstrap.ts:274` (pass overrides to runner)
- Modify: `src/cli/commands/run-subagent.ts` (pass overrides to runner)

- [ ] **Step 1: Write the failing test**

No new test file needed — this is wiring. The existing bootstrap behavior is tested end-to-end. We verify by running the config schema tests and runner tests together.

- [ ] **Step 2: Implement bootstrap wiring**

In `src/daemon/daemon-bootstrap.ts`, change the SubAgentRunner instantiation (line 274):

```typescript
subAgentRunner = new SubAgentRunner(
  agentMap,
  modelResolver,
  { /* services */ },
  logger,
  observability,
  config.subagents ?? {},
);
```

- [ ] **Step 3: Implement CLI wiring**

In `src/cli/commands/run-subagent.ts`, update `runSubAgentCommand` to pass config overrides. The `runSubAgent` function runs agents directly (not via SubAgentRunner), so we add override-aware model resolution:

Update `RunSubAgentOptions`:
```typescript
export interface RunSubAgentOptions {
  name: string;
  input: string;
  subagentsDir: string;
  providers: Record<string, { apiKey?: string; baseURL?: string }>;
  subagentOverrides?: Record<string, { model: Array<{ provider: string; name: string; maxTokens?: number }> }>;
}
```

Add override-aware resolution in `runSubAgent`:
```typescript
// Resolve model — try overrides first, then manifest fallback
const overrideConfig = options.subagentOverrides?.[name];
let resolvedModel;

if (overrideConfig) {
  for (const entry of overrideConfig.model) {
    const result = await resolver.resolve({
      provider: entry.provider,
      name: entry.name,
      maxTokens: entry.maxTokens ?? agent.manifest.model.maxTokens,
    });
    if (result.isOk()) {
      resolvedModel = result.value;
      break;
    }
    logger.warn(`Model ${entry.provider}/${entry.name} failed, trying next`);
  }
}

if (!resolvedModel) {
  const modelResult = await resolver.resolve(agent.manifest.model);
  if (modelResult.isErr()) {
    throw new Error(`Model resolution failed: ${modelResult.error.message}`);
  }
  resolvedModel = modelResult.value;
}
```

Pass `config.subagents` in `runSubAgentCommand`:
```typescript
const result = await runSubAgent({
  name: options.name,
  input: options.input,
  subagentsDir: dir,
  providers: config.auth.providers ?? {},
  subagentOverrides: config.subagents ?? {},
});
```

- [ ] **Step 4: Run existing tests to verify no regressions**

Run: `npx vitest run tests/unit/subagents/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/daemon-bootstrap.ts src/cli/commands/run-subagent.ts
git commit -m "feat(wiring): pass subagent overrides to runner and CLI (#156)"
```

---

### Task 4: Example Config + Documentation

**Files:**
- Modify: `config/talond.example.yaml` (add subagents section)
- Modify: `README.md` (document the feature)

- [ ] **Step 1: Add example config**

Add to `config/talond.example.yaml` before `logLevel:`:

```yaml
# Sub-agent model overrides — override which model a sub-agent uses without
# editing its subagent.yaml manifest. Each entry is an ordered failover chain:
# if the first model is unavailable, the next is tried, then the manifest
# default as final fallback.
#
# subagents:
#   memory-groomer:
#     model:
#       - provider: ollama
#         name: qwen3-30b
#         # maxTokens: 4096     # optional — falls back to subagent.yaml default
#       - provider: anthropic
#         name: claude-haiku-4-5
#   session-summarizer:
#     model:
#       - provider: openai
#         name: gpt-5.4-spark
```

- [ ] **Step 2: Update README.md**

Add a new subsection under the appropriate section documenting:
- What subagent model overrides are
- Config shape with example
- Failover behavior
- That manifest model is always the final fallback

- [ ] **Step 3: Commit**

```bash
git add config/talond.example.yaml README.md
git commit -m "docs: subagent model overrides and failover (#156)"
```
