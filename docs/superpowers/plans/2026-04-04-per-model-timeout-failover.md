# Per-Model Timeout + Timeout Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow per-model `timeoutMs` in subagent config overrides, and make timeout errors trigger failover to the next model instead of being terminal.

**Architecture:** Add optional `timeoutMs` to `SubAgentModelOverrideSchema`. Thread an `AbortController` signal through `SubAgentContext` so the runner can abort timed-out AI SDK calls before failing over. Each model in the chain gets its own timeout (falling back to manifest `timeoutMs` if unset). All 5 default subagents pass `ctx.abortSignal` to their `generateText`/`generateObject` calls.

**Tech Stack:** TypeScript, Zod, vitest, neverthrow, Vercel AI SDK (`abortSignal` support)

---

### Task 1: Add `timeoutMs` to config override schema

**Files:**
- Modify: `src/core/config/config-schema.ts:341-345`
- Test: `tests/unit/core/config/config-schema-subagents.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/core/config/config-schema-subagents.test.ts`:

```typescript
it('accepts timeoutMs on a model override entry', () => {
  const result = TalondConfigSchema.safeParse({
    subagents: {
      'memory-groomer': {
        model: [
          { provider: 'ollama', name: 'qwen3-30b', timeoutMs: 120000 },
          { provider: 'anthropic', name: 'claude-haiku-4-5', timeoutMs: 60000 },
        ],
      },
    },
  });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.subagents['memory-groomer'].model[0].timeoutMs).toBe(120000);
    expect(result.data.subagents['memory-groomer'].model[1].timeoutMs).toBe(60000);
  }
});

it('allows timeoutMs to be omitted (remains undefined)', () => {
  const result = TalondConfigSchema.safeParse({
    subagents: {
      'test': {
        model: [{ provider: 'anthropic', name: 'haiku' }],
      },
    },
  });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.subagents['test'].model[0].timeoutMs).toBeUndefined();
  }
});

it('rejects timeoutMs below 1000', () => {
  const result = TalondConfigSchema.safeParse({
    subagents: {
      'test': {
        model: [{ provider: 'anthropic', name: 'haiku', timeoutMs: 500 }],
      },
    },
  });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/core/config/config-schema-subagents.test.ts`
Expected: 2 new tests FAIL (timeoutMs not in schema), 1 passes (undefined is ok since field doesn't exist)

- [ ] **Step 3: Add `timeoutMs` to `SubAgentModelOverrideSchema`**

In `src/core/config/config-schema.ts`, change:

```typescript
export const SubAgentModelOverrideSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  maxTokens: z.number().int().positive().optional(),
});
```

to:

```typescript
export const SubAgentModelOverrideSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().min(1000).optional(),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/core/config/config-schema-subagents.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/config/config-schema.ts tests/unit/core/config/config-schema-subagents.test.ts
git commit -m "feat(config): add optional timeoutMs to subagent model override schema"
```

---

### Task 2: Add `abortSignal` to `SubAgentContext`

**Files:**
- Modify: `src/subagents/subagent-types.ts:110-133`

- [ ] **Step 1: Add `abortSignal` field to `SubAgentContext`**

In `src/subagents/subagent-types.ts`, add after the `telemetry` field in `SubAgentContext`:

```typescript
  /**
   * Abort signal from the runner's timeout controller.
   * Sub-agents should pass this to AI SDK calls (`generateText`, `generateObject`)
   * so that timed-out requests are cancelled promptly, enabling failover.
   */
  abortSignal?: AbortSignal;
```

- [ ] **Step 2: Commit**

```bash
git add src/subagents/subagent-types.ts
git commit -m "feat(subagents): add optional abortSignal to SubAgentContext"
```

---

### Task 3: Thread `abortSignal` through default subagents

All 5 default subagents call `generateText` or `generateObject` from the AI SDK. Each needs to pass `ctx.abortSignal` (the AI SDK accepts `abortSignal` on both functions).

**Files:**
- Modify: `src/subagents/default/file-searcher/index.ts:97-103`
- Modify: `src/subagents/default/memory-groomer/index.ts:82-89`
- Modify: `src/subagents/default/spark-coder/index.ts:56-63`
- Modify: `src/subagents/default/memory-retriever/index.ts:143-149`
- Modify: `src/subagents/default/session-summarizer/index.ts:32-39`

- [ ] **Step 1: Add `abortSignal` to file-searcher**

In `src/subagents/default/file-searcher/index.ts`, change the `generateText` call:

```typescript
    const { text, usage } = await generateText({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt: `Query: "${query}"\n\nMatches:\n\n${matchSummary}`,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
      abortSignal: ctx.abortSignal,
    });
```

- [ ] **Step 2: Add `abortSignal` to memory-groomer**

In `src/subagents/default/memory-groomer/index.ts`, change the `generateObject` call:

```typescript
    const { object: response, usage } = await generateObject({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt,
      schema: GroomResponseSchema,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
      abortSignal: ctx.abortSignal,
    });
```

- [ ] **Step 3: Add `abortSignal` to spark-coder**

In `src/subagents/default/spark-coder/index.ts`, change the `generateObject` call:

```typescript
    const { object, usage } = await generateObject({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt,
      schema: SparkCoderOutputSchema,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
      abortSignal: ctx.abortSignal,
    });
```

- [ ] **Step 4: Add `abortSignal` to memory-retriever**

In `src/subagents/default/memory-retriever/index.ts`, change the `generateText` call:

```typescript
    const { text, usage } = await generateText({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
      abortSignal: ctx.abortSignal,
    });
```

- [ ] **Step 5: Add `abortSignal` to session-summarizer**

In `src/subagents/default/session-summarizer/index.ts`, change the `generateObject` call:

```typescript
    const { object, usage } = await generateObject({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt: `Summarize this conversation transcript:\n\n${transcript}`,
      schema: SummarySchema,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
      abortSignal: ctx.abortSignal,
    });
```

- [ ] **Step 6: Commit**

```bash
git add src/subagents/default/file-searcher/index.ts \
        src/subagents/default/memory-groomer/index.ts \
        src/subagents/default/spark-coder/index.ts \
        src/subagents/default/memory-retriever/index.ts \
        src/subagents/default/session-summarizer/index.ts
git commit -m "feat(subagents): pass abortSignal to AI SDK calls in all default subagents"
```

---

### Task 4: Rewrite runner timeout + failover logic

This is the core change. The runner currently uses `Promise.race` with a shared timeout and treats `SubAgentTimeoutError` as terminal. The new behavior:

1. Each model entry gets its own timeout: `modelEntry.timeoutMs ?? agent.manifest.timeoutMs`
2. The runner creates an `AbortController` per model attempt
3. On timeout, the controller is aborted (cancelling the AI SDK call), then failover proceeds to the next model
4. The `abortSignal` is threaded into the `SubAgentContext`

**Files:**
- Modify: `src/subagents/subagent-runner.ts:128-345`
- Test: `tests/unit/subagents/subagent-runner.test.ts`

- [ ] **Step 1: Write failing tests for new timeout-failover behavior**

Add these tests to the `failover` describe block in `tests/unit/subagents/subagent-runner.test.ts`:

```typescript
    it('uses per-model timeoutMs from override config', async () => {
      const agent = makeAgent({
        manifest: { ...makeAgent().manifest, timeoutMs: 30_000 },
        run: vi.fn().mockResolvedValue(ok({ summary: 'Done' })),
      });
      const agents = new Map([['test-agent', agent]]);
      const resolver = {
        resolve: vi.fn().mockResolvedValue(ok({} as any)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [{ provider: 'ollama', name: 'qwen3-30b', timeoutMs: 120_000 }],
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isOk()).toBe(true);
      // The run function should have received an abortSignal in the context
      const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.abortSignal).toBeInstanceOf(AbortSignal);
    });

    it('falls back to manifest timeoutMs when override has no timeoutMs', async () => {
      // Slow run that would fail a 30s manifest timeout but we can't wait that long.
      // Instead verify the abortSignal is present (proves AbortController is wired).
      const agent = makeAgent({
        run: vi.fn().mockResolvedValue(ok({ summary: 'Done' })),
      });
      const agents = new Map([['test-agent', agent]]);
      const resolver = {
        resolve: vi.fn().mockResolvedValue(ok({} as any)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [{ provider: 'ollama', name: 'qwen3-30b' }],  // no timeoutMs
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isOk()).toBe(true);
      const ctx = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.abortSignal).toBeInstanceOf(AbortSignal);
    });

    it('fails over to next model on timeout instead of terminating', async () => {
      const agent = makeAgent({
        manifest: { ...makeAgent().manifest, timeoutMs: 50 },
        run: vi.fn()
          // First call: slow (will timeout)
          .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(ok({ summary: 'late' })), 10_000)))
          // Second call: fast (succeeds)
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
            { provider: 'ollama', name: 'qwen3-30b', timeoutMs: 50 },
            { provider: 'anthropic', name: 'claude-haiku-4-5', timeoutMs: 5000 },
          ],
        },
      });

      const result = await runner.execute('test-agent', {}, makeContext());
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().summary).toBe('Done via fallback');
      expect(agent.run).toHaveBeenCalledTimes(2);
    });

    it('aborts the signal when a model times out', async () => {
      let capturedSignal: AbortSignal | undefined;
      const agent = makeAgent({
        manifest: { ...makeAgent().manifest, timeoutMs: 50 },
        run: vi.fn()
          .mockImplementationOnce((ctx: any) => {
            capturedSignal = ctx.abortSignal;
            return new Promise((resolve) => setTimeout(() => resolve(ok({ summary: 'late' })), 10_000));
          })
          .mockResolvedValueOnce(ok({ summary: 'Done' })),
      });
      const agents = new Map([['test-agent', agent]]);
      const resolver = {
        resolve: vi.fn().mockResolvedValue(ok({} as any)),
      } as unknown as ModelResolver;

      const runner = makeRunner(agents, resolver, undefined, {
        'test-agent': {
          model: [
            { provider: 'ollama', name: 'qwen3-30b', timeoutMs: 50 },
            { provider: 'anthropic', name: 'claude-haiku-4-5' },
          ],
        },
      });

      await runner.execute('test-agent', {}, makeContext());
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal!.aborted).toBe(true);
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/subagents/subagent-runner.test.ts`
Expected: New tests FAIL (no `abortSignal` in context, timeout is still terminal)

- [ ] **Step 3: Update the `modelChain` type to include `timeoutMs`**

In `src/subagents/subagent-runner.ts`, change the `modelChain` type on line 163:

```typescript
    const modelChain: Array<{ provider: string; name: string; maxTokens: number; timeoutMs: number; source: string }> = [];
```

Update the override loop (lines 165-173):

```typescript
    if (overrideConfig) {
      for (const entry of overrideConfig.model) {
        modelChain.push({
          provider: entry.provider,
          name: entry.name,
          maxTokens: entry.maxTokens ?? agent.manifest.model.maxTokens,
          timeoutMs: entry.timeoutMs ?? agent.manifest.timeoutMs,
          source: 'override',
        });
      }
    }
```

Update the manifest fallback push (lines 176-182):

```typescript
    // Always append manifest model as final fallback
    modelChain.push({
      provider: agent.manifest.model.provider,
      name: agent.manifest.model.name,
      maxTokens: agent.manifest.model.maxTokens,
      timeoutMs: agent.manifest.timeoutMs,
      source: 'manifest',
    });
```

- [ ] **Step 4: Rewrite the per-model execution loop with AbortController**

Replace the `for (const modelEntry of modelChain)` loop (lines 194-278) with:

```typescript
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
        this.logger.warn(
          { subagent: name, model: `${modelEntry.provider}/${modelEntry.name}`, source: modelEntry.source },
          `Model resolution failed, trying next: ${modelResult.error.message}`,
        );
        continue;
      }

      const model: LanguageModel = modelResult.value;

      // Per-model AbortController for timeout cancellation
      const abortController = new AbortController();

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
      };

      try {
        const runResult = await this.runWithTimeout(
          agent.run(agentContext, input),
          modelEntry.timeoutMs,
          name,
          abortController,
        );

        if (runResult.isErr()) {
          const failMsg = `${modelEntry.provider}/${modelEntry.name} (${modelEntry.source}): ${runResult.error.message}`;
          failures.push(failMsg);
          this.logger.warn(
            { subagent: name, model: `${modelEntry.provider}/${modelEntry.name}` },
            `Sub-agent run failed, trying next: ${runResult.error.message}`,
          );
          continue;
        }

        const modelLabel = `${modelEntry.provider}/${modelEntry.name}`;
        if (failures.length > 0) {
          this.logger.info(
            { subagent: name, model: modelLabel, source: modelEntry.source, failedAttempts: failures.length },
            'Sub-agent succeeded after failover',
          );
        } else {
          this.logger.info(
            { subagent: name, model: modelLabel, source: modelEntry.source },
            'Sub-agent completed',
          );
        }

        return ok({ ...runResult.value, _model: modelLabel, _modelSource: modelEntry.source });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failMsg = `${modelEntry.provider}/${modelEntry.name} (${modelEntry.source}): ${message}`;
        failures.push(failMsg);

        if (error instanceof SubAgentTimeoutError) {
          this.logger.warn(
            { subagent: name, model: `${modelEntry.provider}/${modelEntry.name}`, timeoutMs: modelEntry.timeoutMs },
            `Sub-agent timed out, failing over to next model`,
          );
          continue;  // <-- was `break`, now `continue` for failover
        }

        this.logger.warn(
          { subagent: name, model: `${modelEntry.provider}/${modelEntry.name}` },
          `Sub-agent execution threw, trying next: ${message}`,
        );
        continue;
      }
    }
```

- [ ] **Step 5: Update `runWithTimeout` to accept and use AbortController**

Replace the `runWithTimeout` method (lines 328-345) with:

```typescript
  /**
   * Race the given promise against a timeout.
   * Aborts the controller when the timeout fires, then rejects with SubAgentTimeoutError.
   */
  private async runWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    name: string,
    abortController: AbortController,
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => {
          abortController.abort();
          reject(new SubAgentTimeoutError(name, timeoutMs));
        },
        timeoutMs,
      );
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/unit/subagents/subagent-runner.test.ts`
Expected: All PASS (including existing timeout test which now has slightly different error message handling)

- [ ] **Step 7: Update existing timeout test assertion**

The existing test `'respects timeout on slow sub-agents'` (line 192) expects `timed out after 100ms`. This still works since there's only one model (manifest) and all models exhaust → error message includes the timeout text. Verify it still passes. If the error message wrapping changed (it's now in `All models failed` wrapper), update the assertion:

```typescript
  it('respects timeout on slow sub-agents', async () => {
    const slowRun = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(ok({ summary: 'late' })), 10_000)),
    );
    const agent = makeAgent({
      manifest: { ...makeAgent().manifest, timeoutMs: 100 },
      run: slowRun,
    });
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents);

    const result = await runner.execute('test-agent', {}, makeContext());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('timed out after 100ms');
  });
```

- [ ] **Step 8: Commit**

```bash
git add src/subagents/subagent-runner.ts tests/unit/subagents/subagent-runner.test.ts
git commit -m "feat(runner): per-model timeout with AbortController + timeout failover"
```

---

### Task 5: Thread `timeoutMs` through CLI `run-subagent` command

The CLI's `runSubAgent` function has its own model resolution and timeout logic separate from the runner. It needs to respect per-model `timeoutMs` overrides.

**Files:**
- Modify: `src/cli/commands/run-subagent.ts:21-150`

- [ ] **Step 1: Update `RunSubAgentOptions` type**

In `src/cli/commands/run-subagent.ts`, change:

```typescript
export interface RunSubAgentOptions {
  name: string;
  input: string;          // JSON string
  subagentsDir: string;
  providers: Record<string, { apiKey?: string; baseURL?: string }>;
  subagentOverrides?: Record<string, { model: Array<{ provider: string; name: string; maxTokens?: number; timeoutMs?: number }> }>;
}
```

- [ ] **Step 2: Track resolved `timeoutMs` alongside model**

In `runSubAgent`, after `let resolvedMaxTokens` (line 75), add:

```typescript
  let resolvedTimeoutMs = agent.manifest.timeoutMs;
```

Inside the override loop (line 78-92), after `resolvedMaxTokens = entryMaxTokens;` add:

```typescript
        resolvedTimeoutMs = entry.timeoutMs ?? agent.manifest.timeoutMs;
```

- [ ] **Step 3: Use resolved timeout and add AbortController**

Replace lines 103-143 (the timeout + execution block) with:

```typescript
  // Execute with resolved timeout (from override or manifest).
  const systemPrompt = agent.promptContents.join('\n\n');
  const abortController = new AbortController();
  const runPromise = agent.run(
    {
      threadId: 'cli-test',
      personaId: 'cli-test',
      systemPrompt,
      model: resolvedModel,
      maxOutputTokens: resolvedMaxTokens,
      rootPaths: agent.manifest.rootPaths,
      services: {
        memory: {} as any,
        schedules: {} as any,
        personas: {} as any,
        channels: {} as any,
        threads: {} as any,
        messages: {} as any,
        runs: {} as any,
        queue: {} as any,
        logger,
      },
      telemetry: { isEnabled: false },
      abortSignal: abortController.signal,
    },
    input,
  );

  const timeoutMs = resolvedTimeoutMs;
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => {
        abortController.abort();
        reject(new Error(`Sub-agent "${name}" timed out after ${timeoutMs}ms`));
      },
      timeoutMs,
    );
  });

  let result: Awaited<ReturnType<typeof agent.run>>;
  try {
    result = await Promise.race([runPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
```

- [ ] **Step 4: Run existing CLI test**

Run: `npx vitest run tests/unit/cli/run-subagent.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/run-subagent.ts
git commit -m "feat(cli): thread per-model timeoutMs and abortSignal through run-subagent"
```

---

### Task 6: Thread `timeoutMs` through bootstrap summarizer

The daemon bootstrap builds its own model chain and timeout for summarizers. It needs to pick up `timeoutMs` from overrides.

**Files:**
- Modify: `src/daemon/daemon-bootstrap.ts:348-440`

- [ ] **Step 1: Add `timeoutMs` to the boot model chain entries**

In `src/daemon/daemon-bootstrap.ts`, the `bootModelChain` (line 348) and `modelChain` (line 380) both build `{ provider, name, maxTokens, source }` objects. Add `timeoutMs` to both.

Change the `bootModelChain` (around line 348):

```typescript
      const bootModelChain = [
        ...(overrideConfig?.model ?? []).map((e) => ({
          provider: e.provider,
          name: e.name,
          maxTokens: e.maxTokens ?? summarizerAgent.manifest.model.maxTokens,
          timeoutMs: e.timeoutMs ?? summarizerAgent.manifest.timeoutMs,
          source: 'override' as const,
        })),
        { ...summarizerAgent.manifest.model, timeoutMs: summarizerAgent.manifest.timeoutMs, source: 'manifest' as const },
      ];
```

Change the inner `modelChain` (around line 380):

```typescript
        const modelChain = [
          ...(overrideConfig?.model ?? []).map((e) => ({
            provider: e.provider,
            name: e.name,
            maxTokens: e.maxTokens ?? summarizerAgent.manifest.model.maxTokens,
            timeoutMs: e.timeoutMs ?? summarizerAgent.manifest.timeoutMs,
            source: 'override' as const,
          })),
          { ...summarizerAgent.manifest.model, timeoutMs: summarizerAgent.manifest.timeoutMs, source: 'manifest' as const },
        ];
```

- [ ] **Step 2: Add AbortController to the summarizer run call**

In the `for (const entry of modelChain)` loop (around line 400), add an `AbortController` and pass `abortSignal` to the context:

```typescript
          const abortController = new AbortController();
          try {
            const result = await summarizerAgent.run(
              {
                threadId,
                personaId,
                model: modelResult.value,
                systemPrompt: summarizerPrompt,
                maxOutputTokens: entry.maxTokens,
                rootPaths: [],
                services: {
                  memory: repos.memory,
                  schedules: repos.schedule,
                  personas: repos.persona,
                  channels: repos.channel,
                  threads: repos.thread,
                  messages: repos.message,
                  runs: repos.run,
                  queue: repos.queue,
                  logger,
                },
                telemetry: { isEnabled: !(observability instanceof NoopObservabilityService) },
                abortSignal: abortController.signal,
              },
              input,
            );
```

Note: The bootstrap summarizer doesn't currently have its own per-model timeout race (it relies on the subagent's internal timeout or the caller). The `timeoutMs` is threaded into the chain for future use and consistency. The `abortSignal` is critical since the main runner now expects it.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/daemon-bootstrap.ts
git commit -m "feat(bootstrap): thread per-model timeoutMs and abortSignal through summarizer chain"
```

---

### Task 7: Update `makeRunner` test helper types

The `makeRunner` helper in the runner tests has a hardcoded type for `subagentOverrides` that doesn't include `timeoutMs`. Update it so new tests compile.

**Files:**
- Modify: `tests/unit/subagents/subagent-runner.test.ts:71-78`

- [ ] **Step 1: Update `makeRunner` overrides type**

Change:

```typescript
function makeRunner(
  agents: Map<string, LoadedSubAgent> = new Map(),
  resolver: ModelResolver = mockResolver,
  observability: ObservabilityService | undefined = undefined,
  subagentOverrides: Record<string, { model: Array<{ provider: string; name: string; maxTokens?: number }> }> = {},
): SubAgentRunner {
```

to:

```typescript
function makeRunner(
  agents: Map<string, LoadedSubAgent> = new Map(),
  resolver: ModelResolver = mockResolver,
  observability: ObservabilityService | undefined = undefined,
  subagentOverrides: Record<string, { model: Array<{ provider: string; name: string; maxTokens?: number; timeoutMs?: number }> }> = {},
): SubAgentRunner {
```

- [ ] **Step 2: Run all runner tests**

Run: `npx vitest run tests/unit/subagents/subagent-runner.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add tests/unit/subagents/subagent-runner.test.ts
git commit -m "test(runner): update makeRunner helper to accept timeoutMs in overrides"
```

---

### Task 8: Build verification

- [ ] **Step 1: Run full build**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 3: Run all affected tests together**

Run: `npx vitest run tests/unit/core/config/config-schema-subagents.test.ts tests/unit/subagents/subagent-runner.test.ts tests/unit/cli/run-subagent.test.ts`
Expected: All PASS

- [ ] **Step 4: Commit any lint fixes if needed**

```bash
git add -A && git commit -m "chore: lint fixes"
```
