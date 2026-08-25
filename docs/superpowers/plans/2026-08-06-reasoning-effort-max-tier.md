# Reasoning-Effort `max`/`ultra` Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `max` and `ultra` as allowed `reasoningEffort` values for the Codex CLI and OpenAI-compatible providers.

**Architecture:** Extend `ReasoningEffortSchema` with two new literals; replace the flat "is this provider type supported" cross-validation in `config-schema.ts` with a per-provider-type allowed-value table (only `codex-cli` and `openai-compatible` get entries — `claude-code`/`gemini-cli` stay fully rejected, unchanged). Codex CLI and OpenAI-compatible already forward `reasoningEffort` as an unvalidated raw string, so they need schema/doc updates only, plus one duplicated type/guard kept in sync in the OpenAI-compatible subprocess wrapper.

**Tech Stack:** TypeScript, Zod, Vitest.

**Design doc:** `docs/superpowers/specs/2026-08-06-reasoning-effort-max-tier-design.md`

## Revision note (2026-08-06)

This plan originally included wiring `reasoningEffort` into the `claude-code` provider (SDK `Options.effort`), which required bumping `@anthropic-ai/claude-agent-sdk` to the `0.3.x` line. That bump was attempted and reverted: `0.3.x` no longer ships a bundled `cli.js` (replaced by native per-platform binaries), which broke `claude-code-provider.ts`'s background-run command resolution — a real regression, confirmed against `deploy/Dockerfile:85-89`, which depends on the old bundled-CLI layout for production background runs. Decision: **stay on `^0.2.71`, drop all `claude-code` and SDK-bump work.** The original Task 1 (SDK bump) and Task 4 (Claude Code provider wiring) were removed; the original Task 8 (agent-runner claude-code coverage) was removed since there's no new claude-code behavior to cover. Remaining tasks are renumbered 1–7 below. The SDK-bump revert itself is already committed (`git revert` of the bump commit) — no task step needed for it.

---

### Task 1: Add `max` and `ultra` to the base `ReasoningEffortSchema` enum

**Files:**
- Modify: `src/core/config/config-schema.ts:87`
- Test: `tests/unit/core/config/config-schema.test.ts:255-265`

- [ ] **Step 1: Write the failing test**

In `tests/unit/core/config/config-schema.test.ts`, replace the `values` array in the existing `'accepts all supported persona reasoningEffort values'` test (currently at line 255):

```ts
  it('accepts all supported persona reasoningEffort values', () => {
    const values = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

    for (const reasoningEffort of values) {
      const result = PersonaConfigSchema.safeParse({ name: 'assistant', reasoningEffort });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.reasoningEffort).toBe(reasoningEffort);
      }
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/config/config-schema.test.ts -t "accepts all supported persona reasoningEffort values"`
Expected: FAIL — `max`/`ultra` rejected by the current enum.

- [ ] **Step 3: Update the schema**

In `src/core/config/config-schema.ts:87`, change:
```ts
export const ReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
```
to:
```ts
export const ReasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/core/config/config-schema.test.ts -t "accepts all supported persona reasoningEffort values"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/config/config-schema.ts tests/unit/core/config/config-schema.test.ts
git commit -m "feat(config): add max and ultra reasoningEffort values"
```

---

### Task 2: Per-provider-type allowed-value cross-validation (codex-cli / openai-compatible only)

**Files:**
- Modify: `src/core/config/config-schema.ts:537-589`
- Test: `tests/unit/core/config/config-schema.test.ts:1217-1321`

This replaces the current binary "is reasoningEffort supported by this provider type at all" check with a per-provider-type allowed-value table. `claude-code` and `gemini-cli` are **not** in the table, so they remain fully rejected — unchanged from today's behavior. Only `codex-cli` and `openai-compatible` gain `max`/`ultra`.

Allowed values by provider type:
- `codex-cli`: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`
- `openai-compatible` (Responses mode only): `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`

- [ ] **Step 1: Write the failing tests**

In `tests/unit/core/config/config-schema.test.ts`, inside `describe('TalondConfigSchema — reasoningEffort cross-validation', ...)`:

1. Update the existing `'rejects reasoningEffort none for Codex CLI'` test's assertion regex (the message format changes — see Step 4 below):

```ts
    it('rejects reasoningEffort none for Codex CLI', () => {
      expect(() =>
        TalondConfigSchema.parse({
          personas: [{ name: 'assistant', provider: 'codex-cli', reasoningEffort: 'none' }],
          agentRunner: {
            defaultProvider: 'codex-cli',
            providers: {
              'codex-cli': { enabled: true, command: 'codex' },
            },
          },
        }),
      ).toThrow(/reasoningEffort \\"none\\" is not supported by provider \\"codex-cli\\"/i);
    });
```

2. The existing `'rejects reasoningEffort when a configured backgroundProvider cannot consume it'` test uses `backgroundProvider: 'claude-code'` with `reasoningEffort: 'high'` — `claude-code` stays fully rejected in this narrowed scope, so this test's premise is unaffected and needs **no change**. Leave it as-is.

3. Add new tests after the `'accepts reasoningEffort none for OpenAI-compatible Responses mode'` test (before the closing of the `describe` block):

```ts
    it('accepts codex-cli reasoningEffort values max and ultra', () => {
      for (const reasoningEffort of ['max', 'ultra'] as const) {
        expect(() =>
          TalondConfigSchema.parse({
            personas: [{ name: 'assistant', provider: 'codex-cli', reasoningEffort }],
            agentRunner: {
              defaultProvider: 'codex-cli',
              providers: {
                'codex-cli': { enabled: true, command: 'codex' },
              },
            },
          }),
        ).not.toThrow();
      }
    });

    it('accepts openai-compatible Responses reasoningEffort values max and ultra', () => {
      for (const reasoningEffort of ['max', 'ultra'] as const) {
        expect(() =>
          TalondConfigSchema.parse({
            personas: [
              { name: 'assistant', provider: 'openai-compatible', reasoningEffort },
            ],
            agentRunner: {
              defaultProvider: 'openai-compatible',
              providers: {
                'openai-compatible': {
                  enabled: true,
                  command: 'openai-compatible',
                  options: { apiMode: 'responses' },
                },
              },
            },
          }),
        ).not.toThrow();
      }
    });

    it('still rejects reasoningEffort for claude-code (unchanged)', () => {
      expect(() =>
        TalondConfigSchema.parse({
          personas: [{ name: 'assistant', provider: 'claude-code', reasoningEffort: 'high' }],
          agentRunner: {
            defaultProvider: 'claude-code',
            providers: {
              'claude-code': { enabled: true, command: 'claude' },
            },
          },
        }),
      ).toThrow(/reasoningEffort is not supported by provider \\"claude-code\\"/i);
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/core/config/config-schema.test.ts -t "reasoningEffort cross-validation"`
Expected: FAIL — the "codex-cli none" message regex doesn't match the current wording; the new `max`/`ultra` tests fail because those values aren't in the schema's cross-validation logic yet (they will already parse at the `PersonaConfigSchema` level after Task 1, but `TalondConfigSchema`'s cross-validation doesn't yet have an allowed-value table).

- [ ] **Step 3: Add the module-scope allowed-values table**

In `src/core/config/config-schema.ts`, directly below the `ReasoningEffortSchema` definition (line 87), add:

```ts
const REASONING_EFFORT_BY_PROVIDER_TYPE: Record<
  string,
  ReadonlyArray<z.infer<typeof ReasoningEffortSchema>>
> = {
  'codex-cli': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'openai-compatible': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};
```

It's declared once at module scope (not recomputed per persona) since it's a static table, not per-persona state. `claude-code` and `gemini-cli` are deliberately absent — any provider type not in this table hits the "not supported at all" branch below, same as today.

- [ ] **Step 4: Replace the cross-validation logic**

In `src/core/config/config-schema.ts`, replace the `value.personas.forEach` block's `if (persona.reasoningEffort) { ... }` body (lines 538–590) with:

```ts
      if (persona.reasoningEffort) {
        const validateProvider = (
          providerName: string,
          provider: z.infer<typeof ProviderConfigSchema> | undefined,
          usage: string,
        ): void => {
          const providerType = provider?.type ?? providerName;
          const allowedValues = REASONING_EFFORT_BY_PROVIDER_TYPE[providerType];

          if (!allowedValues) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['personas', index, 'reasoningEffort'],
              message:
                `persona "${persona.name}": reasoningEffort is not supported by ${usage} ` +
                `"${providerName}" (type "${providerType}").`,
            });
            return;
          }

          if (!allowedValues.includes(persona.reasoningEffort!)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['personas', index, 'reasoningEffort'],
              message:
                `persona "${persona.name}": reasoningEffort "${persona.reasoningEffort}" is not ` +
                `supported by ${usage} "${providerName}" (type "${providerType}"); allowed: ` +
                `${allowedValues.join(', ')}.`,
            });
            return;
          }

          if (providerType === 'openai-compatible' && provider?.options?.apiMode !== 'responses') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['personas', index, 'reasoningEffort'],
              message:
                `persona "${persona.name}": reasoningEffort requires openai-compatible ` +
                'options.apiMode: responses.',
            });
          }
        };

        const foregroundProviderName = persona.provider ?? value.agentRunner.defaultProvider;
        validateProvider(
          foregroundProviderName,
          value.agentRunner.providers[foregroundProviderName],
          'provider',
        );

        if (persona.backgroundProvider) {
          validateProvider(
            persona.backgroundProvider,
            value.backgroundAgent.providers[persona.backgroundProvider],
            'backgroundProvider',
          );
        }
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/core/config/config-schema.test.ts`
Expected: PASS (full file — this confirms no other existing test in the file was broken by the message-format change).

- [ ] **Step 6: Commit**

```bash
git add src/core/config/config-schema.ts tests/unit/core/config/config-schema.test.ts
git commit -m "feat(config): gate reasoningEffort by per-provider-type allowed values"
```

---

### Task 3: Codex CLI — coverage for `max`/`ultra` passthrough

**Files:**
- Test: `tests/unit/providers/codex-cli-provider.test.ts`

Codex CLI already writes any `reasoningEffort` string verbatim into `config.toml` (`renderConfigToml`), so no production code changes are needed here — this is coverage-only, confirming the new schema values flow through correctly.

- [ ] **Step 1: Write the test**

In `tests/unit/providers/codex-cli-provider.test.ts`, add after the `'does not render unsupported reasoning effort none into Codex config'` test (after line 86):

```ts
  it('renders max and ultra reasoning effort into Codex config', () => {
    const provider = makeProvider();
    for (const reasoningEffort of ['max', 'ultra'] as const) {
      const rendered = (provider as any).renderConfigToml({
        cwd: '/workspace/repo',
        reasoningEffort,
        mcpServers: {},
      });
      expect(rendered.toml).toContain(`model_reasoning_effort = "${reasoningEffort}"`);
    }
  });
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/unit/providers/codex-cli-provider.test.ts -t "renders max and ultra"`
Expected: PASS immediately (no production code change needed — this confirms the passthrough already works for any string once the schema permits it).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/providers/codex-cli-provider.test.ts
git commit -m "test(codex-cli): cover max/ultra reasoningEffort passthrough"
```

---

### Task 4: OpenAI-compatible — coverage for `max`/`ultra` passthrough

**Files:**
- Test: `tests/unit/providers/openai-compatible-provider.test.ts`

Same rationale as Task 3 — `prepareBackgroundInvocation` already forwards `reasoningEffort` unvalidated into the wrapper payload.

- [ ] **Step 1: Write the test**

In `tests/unit/providers/openai-compatible-provider.test.ts`, add after the `'passes persona reasoningEffort to Responses wrapper payload while preserving provider reasoning options'` test (after line 208):

```ts
  it('forwards max and ultra reasoningEffort to Responses wrapper payload', () => {
    const provider = new OpenAiCompatibleProvider({
      enabled: true,
      type: 'openai-compatible',
      command: 'node',
      contextWindowTokens: 128_000,
      options: {
        defaultModel: 'gpt-5.4',
        baseUrl: 'http://127.0.0.1:8000/v1',
        providerId: 'openai',
        apiMode: 'responses',
      },
    });

    for (const reasoningEffort of ['max', 'ultra'] as const) {
      const result = provider.prepareBackgroundInvocation({
        prompt: 'hi',
        systemPrompt: 's',
        mcpServers: {},
        cwd: '/tmp',
        timeoutMs: 10_000,
        model: 'gpt-5.4',
        reasoningEffort,
      });

      expect(result.isOk()).toBe(true);
      const payload = JSON.parse(result._unsafeUnwrap().stdin) as Record<string, unknown>;
      expect(payload.reasoningEffort).toBe(reasoningEffort);
    }
  });
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/unit/providers/openai-compatible-provider.test.ts -t "forwards max and ultra"`
Expected: PASS immediately.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/providers/openai-compatible-provider.test.ts
git commit -m "test(openai-compatible): cover max/ultra reasoningEffort passthrough"
```

---

### Task 5: Keep the OpenAI-compatible subprocess wrapper's duplicated type in sync

**Files:**
- Modify: `src/providers/openai-compatible/agent-cli/index.ts:35,581-589`

This file is a standalone subprocess entrypoint that can't import from `src/core/config`, so it hand-duplicates the `ReasoningEffort` union and a runtime guard. It has no existing unit test file (confirmed — none of the other unit-tested modules in this directory, e.g. `tool-output-excerpter.ts`/`responses-api.ts`/`usage.ts`, cover `index.ts` itself, and it isn't imported directly by any test today), so this task is a direct, minimal edit with no new test — matching the file's current untested status. Correctness is exercised indirectly by the Task 4 passthrough test at the `openai-compatible-provider.ts` boundary and manually via the real subprocess path.

- [ ] **Step 1: Update the type union**

In `src/providers/openai-compatible/agent-cli/index.ts:35`, change:
```ts
type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
```
to:
```ts
type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
```

- [ ] **Step 2: Update the runtime guard**

At `src/providers/openai-compatible/agent-cli/index.ts:581-589`, change:
```ts
function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  );
}
```
to:
```ts
function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'ultra'
  );
}
```

- [ ] **Step 3: Verify the project still builds**

Run: `npm run build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/providers/openai-compatible/agent-cli/index.ts
git commit -m "fix(openai-compatible): sync subprocess wrapper reasoningEffort union with max/ultra"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md:961-964,987`
- Modify: `config/talond.example.yaml:124-130`

- [ ] **Step 1: Update the README persona example comment block**

In `README.md`, change (lines 961–964):
```yaml
    # Optional for Codex CLI and OpenAI-compatible Responses personas.
    # OpenAI Responses: none, minimal, low, medium, high, xhigh.
    # Codex CLI: minimal, low, medium, high, xhigh.
    # reasoningEffort: medium
```
to:
```yaml
    # Optional for Codex CLI and OpenAI-compatible Responses personas.
    # OpenAI Responses: none, minimal, low, medium, high, xhigh, max, ultra.
    # Codex CLI: minimal, low, medium, high, xhigh, max, ultra.
    # reasoningEffort: medium
```

- [ ] **Step 2: Update the README prose paragraph**

In `README.md:987`, change:
```
`reasoningEffort` is a persona-level knob for Codex CLI and OpenAI-compatible Responses providers. Talon rejects it at config load for unsupported providers and OpenAI-compatible chat-completions mode. Codex CLI accepts `minimal`, `low`, `medium`, `high`, and `xhigh`; omit the field to use the provider default because Codex CLI does not support `none`. OpenAI-compatible Responses also accepts `none`. Use the base model name in `model`; Talon does not support model-name suffix aliases for effort levels.
```
to:
```
`reasoningEffort` is a persona-level knob for Codex CLI and OpenAI-compatible Responses providers. Talon rejects it at config load for unsupported providers, values unsupported by the persona's provider, and OpenAI-compatible chat-completions mode. Codex CLI accepts `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; omit the field to use the provider default because Codex CLI does not support `none`. OpenAI-compatible Responses additionally accepts `none`. Use the base model name in `model`; Talon does not support model-name suffix aliases for effort levels.
```

- [ ] **Step 3: Update the example config**

In `config/talond.example.yaml:124-130`, change:
```yaml
  # Example OpenAI/Codex reasoning persona. Use the base model name; do not
  # encode effort as a model-name suffix. Valid values are:
  # none, minimal, low, medium, high, xhigh.
  # - name: deep-researcher
  #   model: gpt-5.4
  #   provider: codex-cli
  #   reasoningEffort: high
```
to:
```yaml
  # Example OpenAI/Codex reasoning persona. Use the base model name; do not
  # encode effort as a model-name suffix. Valid values by provider:
  #   codex-cli: minimal, low, medium, high, xhigh, max, ultra
  #   openai-compatible (Responses mode): none, minimal, low, medium, high, xhigh, max, ultra
  # - name: deep-researcher
  #   model: gpt-5.4
  #   provider: codex-cli
  #   reasoningEffort: high
```

- [ ] **Step 4: Commit**

```bash
git add README.md config/talond.example.yaml
git commit -m "docs: document max/ultra reasoningEffort tiers"
```

---

### Task 7: Codex review, lint, and final verification

Per this repo's workflow (`CLAUDE.md`), a codex review is required before the work is considered done.

- [ ] **Step 1: Run lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 3: Request a Codex review**

Use the `skill-codex:codex` skill to ask GPT-5.4 to review the full branch diff against `main` (`git diff main...HEAD`). Address any critical/high/medium findings by making further commits (repeat Steps 1–2 after each fix) before proceeding. Low-severity/nit findings may be triaged at your discretion, but note the decision.

- [ ] **Step 4: Final commit (if review produced fixes)**

```bash
git add -A
git commit -m "fix: address codex review findings for reasoningEffort max/ultra tiers"
```
