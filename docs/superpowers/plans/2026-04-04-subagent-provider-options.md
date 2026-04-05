# Sub-Agent `providerOptions` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add free-form per-model `providerOptions` passthrough on subagent overrides so operators can disable Qwen3 thinking (and set any vendor-specific knob) when routing sub-agents to llama.cpp / vLLM / tunnel endpoints.

**Architecture:** Extend `SubAgentModelOverrideSchema` with an arbitrary `providerOptions` record. Switch the `ollama` code path in `ModelResolver` from `@ai-sdk/openai`'s `createOpenAI` (strict typed options) to `@ai-sdk/openai-compatible`'s `createOpenAICompatible` (arbitrary body passthrough). The runner wraps user options under the active model entry's provider name and places them on `SubAgentContext.providerOptions`, which all 5 default sub-agents forward to their `generateText` / `generateObject` calls.

**Tech Stack:** TypeScript, Zod, Vercel AI SDK (`@ai-sdk/openai-compatible`), vitest, neverthrow

---

### Task 1: Add `@ai-sdk/openai-compatible` dependency and switch `ollama` resolver

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `src/subagents/model-resolver.ts:69-76` (swap factory)

- [ ] **Step 1: Add the dependency**

```bash
npm install @ai-sdk/openai-compatible
```

Expected: `package.json` now contains `"@ai-sdk/openai-compatible": "^<version>"` alongside `@ai-sdk/openai`, and `package-lock.json` is updated. Do not pin a version manually — use whatever `npm install` resolves.

- [ ] **Step 2: Update the `ollama` case in `ModelResolver.createModel`**

Open `src/subagents/model-resolver.ts`. Find the `ollama` case (around line 69-76):

```typescript
      case 'ollama': {
        // ollama-ai-provider only supports LanguageModelV1, which the AI SDK v5
        // rejects at runtime. Use @ai-sdk/openai with Ollama's OpenAI-compatible
        // endpoint instead.
        const { createOpenAI } = await import('@ai-sdk/openai');
        const baseURL = creds.baseURL ?? 'http://localhost:11434/v1';
        return createOpenAI({ baseURL, apiKey: 'ollama' })(modelName);
      }
```

Replace with:

```typescript
      case 'ollama': {
        // Use @ai-sdk/openai-compatible so arbitrary request body fields
        // (e.g. Qwen's chat_template_kwargs.enable_thinking) can flow through
        // via providerOptions. The @ai-sdk/openai typed options do not allow
        // non-standard fields.
        const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
        const baseURL = creds.baseURL ?? 'http://localhost:11434/v1';
        return createOpenAICompatible({ name: 'ollama', baseURL, apiKey: 'ollama' })(modelName);
      }
```

- [ ] **Step 3: Build to verify the dependency is wired**

Run: `npm run build`
Expected: Clean build, no TypeScript errors.

- [ ] **Step 4: Run the model resolver tests if they exist**

Run: `npx vitest run tests/unit/subagents/model-resolver.test.ts 2>&1 | tail -15`
Expected: Either all pass, or the file does not exist (skip). If it exists and fails due to an import or return-type mismatch, fix before continuing.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/subagents/model-resolver.ts
git commit -m "feat(resolver): switch ollama path to createOpenAICompatible for body passthrough"
```

---

### Task 2: Add `providerOptions` to override schema

**Files:**
- Modify: `src/core/config/config-schema.ts:341-346`
- Test: `tests/unit/core/config/config-schema-subagents.test.ts`

- [ ] **Step 1: Write failing tests**

Append these tests inside the existing `describe('TalondConfigSchema — subagents override', ...)` block in `tests/unit/core/config/config-schema-subagents.test.ts`:

```typescript
it('accepts providerOptions on a model override entry', () => {
  const result = TalondConfigSchema.safeParse({
    subagents: {
      'session-summarizer': {
        model: [
          {
            provider: 'ollama',
            name: 'Qwen3.5-35B-A3B-UD-Q4_K_XL',
            providerOptions: {
              chat_template_kwargs: { enable_thinking: false },
              temperature: 0.7,
            },
          },
        ],
      },
    },
  });
  expect(result.success).toBe(true);
  if (result.success) {
    const entry = result.data.subagents['session-summarizer'].model[0];
    expect(entry.providerOptions).toEqual({
      chat_template_kwargs: { enable_thinking: false },
      temperature: 0.7,
    });
  }
});

it('allows providerOptions to be omitted (remains undefined)', () => {
  const result = TalondConfigSchema.safeParse({
    subagents: {
      'test': { model: [{ provider: 'ollama', name: 'qwen' }] },
    },
  });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.subagents['test'].model[0].providerOptions).toBeUndefined();
  }
});

it('accepts deeply nested providerOptions without inner validation', () => {
  const result = TalondConfigSchema.safeParse({
    subagents: {
      'test': {
        model: [{
          provider: 'ollama',
          name: 'qwen',
          providerOptions: {
            level1: { level2: { level3: 'deep' } },
            arrayField: [1, 2, 3],
            nullField: null,
          },
        }],
      },
    },
  });
  expect(result.success).toBe(true);
});
```

- [ ] **Step 2: Verify tests fail**

Run: `npx vitest run tests/unit/core/config/config-schema-subagents.test.ts`
Expected: the three new tests FAIL (schema does not know `providerOptions` field yet; Zod strict-object behavior strips unknown keys so the field is undefined).

- [ ] **Step 3: Add `providerOptions` to the schema**

In `src/core/config/config-schema.ts`, find `SubAgentModelOverrideSchema` (around line 341-346):

```typescript
export const SubAgentModelOverrideSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().min(1000).optional(),
});
```

Change it to:

```typescript
export const SubAgentModelOverrideSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
});
```

- [ ] **Step 4: Verify tests pass**

Run: `npx vitest run tests/unit/core/config/config-schema-subagents.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/config/config-schema.ts tests/unit/core/config/config-schema-subagents.test.ts
git commit -m "feat(config): add optional providerOptions to subagent model override schema"
```

---

### Task 3: Add `providerOptions` field to `SubAgentContext`

**Files:**
- Modify: `src/subagents/subagent-types.ts` (around the `SubAgentContext` interface)

- [ ] **Step 1: Add the field**

Open `src/subagents/subagent-types.ts`. Find the `SubAgentContext` interface (around line 110-133). After the existing `abortSignal?: AbortSignal;` field, add:

```typescript
  /**
   * Provider-specific options to forward to the AI SDK call, keyed by provider
   * name. Comes from the active model entry's `providerOptions` in the subagent
   * override config, wrapped under that entry's provider name. Example shape:
   *   { ollama: { chat_template_kwargs: { enable_thinking: false } } }
   * Subagents should forward this verbatim to generateText / generateObject.
   */
  providerOptions?: Record<string, Record<string, unknown>>;
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit; echo "exit: $?"`
Expected: `exit: 0`

- [ ] **Step 3: Commit**

```bash
git add src/subagents/subagent-types.ts
git commit -m "feat(subagents): add optional providerOptions to SubAgentContext"
```

---

### Task 4: Runner wraps `providerOptions` under provider name and places on context

**Files:**
- Modify: `src/subagents/subagent-runner.ts` (modelChain construction + context build)
- Test: `tests/unit/subagents/subagent-runner.test.ts`

- [ ] **Step 1: Write failing tests**

Append these tests inside the `describe('failover', ...)` block in `tests/unit/subagents/subagent-runner.test.ts`:

```typescript
    it('wraps providerOptions under the active model entry provider name', async () => {
      const agent = makeAgent({
        run: vi.fn().mockResolvedValue(ok({ summary: 'Done' })),
      });
      const agents = new Map([['test-agent', agent]]);
      const resolver = {
        resolve: vi.fn().mockResolvedValue(ok({} as any)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [{
            provider: 'ollama',
            name: 'qwen',
            providerOptions: {
              chat_template_kwargs: { enable_thinking: false },
            },
          }],
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isOk()).toBe(true);

      const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.providerOptions).toEqual({
        ollama: { chat_template_kwargs: { enable_thinking: false } },
      });
    });

    it('leaves providerOptions undefined when override has none', async () => {
      const agent = makeAgent({
        run: vi.fn().mockResolvedValue(ok({ summary: 'Done' })),
      });
      const agents = new Map([['test-agent', agent]]);
      const resolver = {
        resolve: vi.fn().mockResolvedValue(ok({} as any)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [{ provider: 'ollama', name: 'qwen' }],
        },
      });

      await runner.execute('test-agent', {}, makeContext());
      const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.providerOptions).toBeUndefined();
    });

    it('does not leak providerOptions across chain entries on failover', async () => {
      const agent = makeAgent({
        run: vi.fn()
          .mockRejectedValueOnce(new Error('first model blew up'))
          .mockResolvedValueOnce(ok({ summary: 'Done via fallback' })),
      });
      const agents = new Map([['test-agent', agent]]);
      const resolver = {
        resolve: vi.fn()
          .mockResolvedValueOnce(ok({} as any))
          .mockResolvedValueOnce(ok({} as any)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [
            {
              provider: 'ollama',
              name: 'qwen',
              providerOptions: { chat_template_kwargs: { enable_thinking: false } },
            },
            { provider: 'anthropic', name: 'claude-haiku-4-5' },
          ],
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isOk()).toBe(true);

      const calls = (agent.run as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      // First attempt (ollama): providerOptions wrapped under 'ollama'
      expect(calls[0][0].providerOptions).toEqual({
        ollama: { chat_template_kwargs: { enable_thinking: false } },
      });
      // Second attempt (anthropic fallback): no providerOptions
      expect(calls[1][0].providerOptions).toBeUndefined();
    });
```

Also update the `makeRunner` helper's overrides type signature (around line 71-78) to include `providerOptions`:

```typescript
function makeRunner(
  agents: Map<string, LoadedSubAgent> = new Map(),
  resolver: ModelResolver = mockResolver,
  observability: ObservabilityService | undefined = undefined,
  subagentOverrides: Record<string, { model: Array<{ provider: string; name: string; maxTokens?: number; timeoutMs?: number; providerOptions?: Record<string, unknown> }> }> = {},
): SubAgentRunner {
```

- [ ] **Step 2: Verify tests fail**

Run: `npx vitest run tests/unit/subagents/subagent-runner.test.ts`
Expected: the three new tests FAIL (runner does not thread `providerOptions` yet; `ctx.providerOptions` is always undefined).

- [ ] **Step 3: Add `providerOptions` to `modelChain` entries**

In `src/subagents/subagent-runner.ts`, find the `modelChain` type declaration (around line 163). Change:

```typescript
    const modelChain: Array<{ provider: string; name: string; maxTokens: number; timeoutMs: number; source: string }> = [];
```

to:

```typescript
    const modelChain: Array<{ provider: string; name: string; maxTokens: number; timeoutMs: number; providerOptions?: Record<string, unknown>; source: string }> = [];
```

Update the override loop (around line 165-174) to carry `providerOptions`:

```typescript
    if (overrideConfig) {
      for (const entry of overrideConfig.model) {
        modelChain.push({
          provider: entry.provider,
          name: entry.name,
          maxTokens: entry.maxTokens ?? agent.manifest.model.maxTokens,
          timeoutMs: entry.timeoutMs ?? agent.manifest.timeoutMs,
          providerOptions: entry.providerOptions,
          source: 'override',
        });
      }
    }
```

The manifest fallback push does not need updating — the manifest has no
`providerOptions` concept, so the field stays `undefined` on that entry.

- [ ] **Step 4: Build the wrapped options and place on `agentContext`**

Find the per-model loop body (around line 194-230) where `agentContext` is constructed. Right before the `agentContext` object literal, compute the wrapped options:

```typescript
      const wrappedProviderOptions = modelEntry.providerOptions
        ? { [modelEntry.provider]: modelEntry.providerOptions }
        : undefined;
```

Then add `providerOptions: wrappedProviderOptions,` to the `agentContext` object literal (alongside the existing `abortSignal: abortController.signal,`):

```typescript
      const agentContext = {
        threadId: ctx.threadId,
        personaId: ctx.personaId,
        systemPrompt,
        model,
        maxOutputTokens: modelEntry.maxTokens,
        rootPaths: agent.manifest.rootPaths,
        services: { ...this.services, logger: childLogger },
        telemetry: { isEnabled: !(this.observability instanceof NoopObservabilityService) },
        abortSignal: abortController.signal,
        providerOptions: wrappedProviderOptions,
      };
```

- [ ] **Step 5: Verify tests pass**

Run: `npx vitest run tests/unit/subagents/subagent-runner.test.ts`
Expected: ALL PASS, including the 3 new tests and all pre-existing tests.

- [ ] **Step 6: Commit**

```bash
git add src/subagents/subagent-runner.ts tests/unit/subagents/subagent-runner.test.ts
git commit -m "feat(runner): thread providerOptions from override into SubAgentContext"
```

---

### Task 5: Forward `ctx.providerOptions` in all 5 default sub-agents

All 5 default sub-agents call `generateText` or `generateObject`. Each needs
`providerOptions: ctx.providerOptions` added to the options object. This is
the same mechanical pattern as the earlier `abortSignal` task.

**Files:**
- Modify: `src/subagents/default/file-searcher/index.ts` (`generateText` call ~line 97)
- Modify: `src/subagents/default/memory-groomer/index.ts` (`generateObject` call ~line 82)
- Modify: `src/subagents/default/spark-coder/index.ts` (`generateObject` call ~line 56)
- Modify: `src/subagents/default/memory-retriever/index.ts` (`generateText` call ~line 143)
- Modify: `src/subagents/default/session-summarizer/index.ts` (`generateObject` call ~line 32)

- [ ] **Step 1: Update file-searcher**

In `src/subagents/default/file-searcher/index.ts`, find the `generateText({` call and add `providerOptions: ctx.providerOptions,` after the `abortSignal: ctx.abortSignal,` line. The full call becomes:

```typescript
    const { text, usage } = await generateText({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt: `Query: "${query}"\n\nMatches:\n\n${matchSummary}`,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
      abortSignal: ctx.abortSignal,
      providerOptions: ctx.providerOptions,
    });
```

- [ ] **Step 2: Update memory-groomer**

In `src/subagents/default/memory-groomer/index.ts`, find the `generateObject({` call and add `providerOptions: ctx.providerOptions,` after the `abortSignal: ctx.abortSignal,` line:

```typescript
    const { object: response, usage } = await generateObject({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt,
      schema: GroomResponseSchema,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
      abortSignal: ctx.abortSignal,
      providerOptions: ctx.providerOptions,
    });
```

- [ ] **Step 3: Update spark-coder**

In `src/subagents/default/spark-coder/index.ts`, find the `generateObject({` call and add `providerOptions: ctx.providerOptions,` after `abortSignal: ctx.abortSignal,`:

```typescript
    const { object, usage } = await generateObject({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt,
      schema: SparkCoderOutputSchema,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
      abortSignal: ctx.abortSignal,
      providerOptions: ctx.providerOptions,
    });
```

- [ ] **Step 4: Update memory-retriever**

In `src/subagents/default/memory-retriever/index.ts`, find the `generateText({` call and add `providerOptions: ctx.providerOptions,` after `abortSignal: ctx.abortSignal,`:

```typescript
    const { text, usage } = await generateText({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
      abortSignal: ctx.abortSignal,
      providerOptions: ctx.providerOptions,
    });
```

- [ ] **Step 5: Update session-summarizer**

In `src/subagents/default/session-summarizer/index.ts`, find the `generateObject({` call and add `providerOptions: ctx.providerOptions,` after `abortSignal: ctx.abortSignal,`:

```typescript
    const { object, usage } = await generateObject({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt: `Summarize this conversation transcript:\n\n${transcript}`,
      schema: SummarySchema,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
      abortSignal: ctx.abortSignal,
      providerOptions: ctx.providerOptions,
    });
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit; echo "exit: $?"`
Expected: `exit: 0`

- [ ] **Step 7: Commit**

```bash
git add src/subagents/default/file-searcher/index.ts \
        src/subagents/default/memory-groomer/index.ts \
        src/subagents/default/spark-coder/index.ts \
        src/subagents/default/memory-retriever/index.ts \
        src/subagents/default/session-summarizer/index.ts
git commit -m "feat(subagents): forward ctx.providerOptions to AI SDK calls in default subagents"
```

---

### Task 6: Thread `providerOptions` through CLI `run-subagent`

**Files:**
- Modify: `src/cli/commands/run-subagent.ts`

- [ ] **Step 1: Update `RunSubAgentOptions` type**

In `src/cli/commands/run-subagent.ts`, find the `RunSubAgentOptions` interface (around line 21-27). Change the `subagentOverrides` field to include `providerOptions`:

```typescript
export interface RunSubAgentOptions {
  name: string;
  input: string;          // JSON string
  subagentsDir: string;
  providers: Record<string, { apiKey?: string; baseURL?: string }>;
  subagentOverrides?: Record<string, { model: Array<{ provider: string; name: string; maxTokens?: number; timeoutMs?: number; providerOptions?: Record<string, unknown> }> }>;
}
```

- [ ] **Step 2: Track resolved `providerOptions` alongside resolved model**

In `runSubAgent`, after the existing `let resolvedTimeoutMs = agent.manifest.timeoutMs;` line (around line 76), add:

```typescript
  let resolvedProviderOptions: Record<string, unknown> | undefined;
  let resolvedProviderName = agent.manifest.model.provider;
```

Inside the override loop (around line 78-95), after the existing `resolvedTimeoutMs = entry.timeoutMs ?? agent.manifest.timeoutMs;` line, add:

```typescript
        resolvedProviderOptions = entry.providerOptions;
        resolvedProviderName = entry.provider;
```

- [ ] **Step 3: Place wrapped options on the context**

Find the `agent.run(` call (around line 108). Right before it, compute the wrapped options:

```typescript
  const wrappedProviderOptions = resolvedProviderOptions
    ? { [resolvedProviderName]: resolvedProviderOptions }
    : undefined;
```

Then add `providerOptions: wrappedProviderOptions,` to the context object passed to `agent.run(...)`, right after `abortSignal: abortController.signal,`:

```typescript
      telemetry: { isEnabled: false },
      abortSignal: abortController.signal,
      providerOptions: wrappedProviderOptions,
    },
    input,
  );
```

- [ ] **Step 4: Run the CLI tests**

Run: `npx vitest run tests/unit/cli/run-subagent.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/run-subagent.ts
git commit -m "feat(cli): thread providerOptions through run-subagent"
```

---

### Task 7: Thread `providerOptions` through bootstrap summarizer chain

**Files:**
- Modify: `src/daemon/daemon-bootstrap.ts`

- [ ] **Step 1: Add `providerOptions` to the inner `modelChain`**

In `src/daemon/daemon-bootstrap.ts`, find the inner `modelChain = [` inside the `boundSummarizer` function (around line 380-389). Change it to carry `providerOptions`:

```typescript
        const modelChain = [
          ...(overrideConfig?.model ?? []).map((e) => ({
            provider: e.provider,
            name: e.name,
            maxTokens: e.maxTokens ?? summarizerAgent.manifest.model.maxTokens,
            timeoutMs: e.timeoutMs ?? summarizerAgent.manifest.timeoutMs,
            providerOptions: e.providerOptions as Record<string, unknown> | undefined,
            source: 'override' as const,
          })),
          { ...summarizerAgent.manifest.model, timeoutMs: summarizerAgent.manifest.timeoutMs, providerOptions: undefined as Record<string, unknown> | undefined, source: 'manifest' as const },
        ];
```

Leave the outer `bootModelChain` (around line 348-356) unchanged — the boot
probe only needs to verify resolvability, not execute.

- [ ] **Step 2: Wrap and place on the summarizer context**

Find the `summarizerAgent.run(` call inside the `try {` block (around line 404). Right before the `const runPromise = summarizerAgent.run(` line, compute the wrapped options:

```typescript
            const wrappedProviderOptions = entry.providerOptions
              ? { [entry.provider]: entry.providerOptions }
              : undefined;
```

Then add `providerOptions: wrappedProviderOptions,` to the context object, right after `abortSignal: abortController.signal,`:

```typescript
                telemetry: { isEnabled: !(observability instanceof NoopObservabilityService) },
                abortSignal: abortController.signal,
                providerOptions: wrappedProviderOptions,
              },
              input,
            );
```

- [ ] **Step 3: Typecheck and run bootstrap tests**

Run: `npx tsc --noEmit; echo "exit: $?"`
Expected: `exit: 0`

Run: `npx vitest run tests/unit/daemon/daemon-bootstrap.test.ts`
Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/daemon-bootstrap.ts
git commit -m "feat(bootstrap): thread providerOptions through summarizer chain"
```

---

### Task 8: Config example for Qwen disable-thinking

**Files:**
- Modify: `config/talond.example.yaml` (append example to the `subagents` section)

- [ ] **Step 1: Locate the `subagents` example in the config file**

Open `config/talond.example.yaml`. Search for a top-level `subagents:` key. If one exists, add the example underneath. If none exists, add a new section at the bottom of the file.

- [ ] **Step 2: Append the Qwen example**

Add this block to the `subagents` section (or create the section if missing):

```yaml
# Per-subagent model overrides.
# Each subagent can specify an ordered model chain with per-model timeouts
# and free-form providerOptions passthrough for the active entry.
#
# Example: route session-summarizer to Qwen3 via a local llama.cpp endpoint
# with reasoning/thinking disabled, fall back to Claude on failure.
subagents:
  session-summarizer:
    model:
      - provider: ollama   # "ollama" is Talon's OpenAI-compatible slot —
                           # point it at any OpenAI-compatible endpoint by
                           # setting auth.providers.ollama.baseURL
        name: Qwen3.5-35B-A3B-UD-Q4_K_XL
        timeoutMs: 180000
        maxTokens: 32768
        # providerOptions are forwarded verbatim to the AI SDK, keyed under
        # the provider name. For llama.cpp + Qwen3, disable thinking mode:
        providerOptions:
          chat_template_kwargs:
            enable_thinking: false
      - provider: anthropic
        name: claude-sonnet-4-6
        timeoutMs: 60000
        # No providerOptions on the fallback — Claude does not accept
        # chat_template_kwargs and would reject the call.
```

- [ ] **Step 3: Verify YAML still parses**

Run: `node -e "const yaml=require('js-yaml'); const fs=require('fs'); yaml.load(fs.readFileSync('config/talond.example.yaml','utf8')); console.log('OK');"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add config/talond.example.yaml
git commit -m "docs(config): add Qwen disable-thinking example for subagent providerOptions"
```

---

### Task 9: Build, lint, and full affected-test verification

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: Clean exit, no TypeScript errors.

- [ ] **Step 2: Lint (pre-existing error count baseline is 81)**

Run: `npm run lint 2>&1 | rg -c '^\s+[0-9]+:[0-9]+\s+error'`
Expected: `81` (unchanged from baseline on this branch). If higher, inspect new errors and fix any introduced by this feature's changes.

- [ ] **Step 3: Full affected test suite**

Run: `npx vitest run tests/unit/core/config/config-schema-subagents.test.ts tests/unit/subagents/subagent-runner.test.ts tests/unit/cli/run-subagent.test.ts tests/unit/daemon/daemon-bootstrap.test.ts`
Expected: All PASS.

- [ ] **Step 4: If any lint fixes were needed, commit them**

```bash
git add -A
git commit -m "chore: lint fixes for providerOptions feature" || echo "no lint fixes needed"
```
