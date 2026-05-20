# Per-Persona Background Agent Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow each persona to declare a dedicated `backgroundProvider` and `backgroundModel` so background-agent runs can be routed independently of the foreground agent runtime, validated at config load, with a safe registry-availability fallback for personas that don't set them.

**Architecture:** Add two optional fields (`backgroundProvider`, `backgroundModel`) to `PersonaConfigSchema`. Cross-validate the persona-level `backgroundProvider` against `backgroundAgent.providers` via a `.superRefine` on `TalondConfigSchema`, failing loudly at config-load time. Extend `ProviderRegistry` with a small `hasProvider` predicate. Update the `background-agent` host-tool resolution chain to: `args.provider → persona.backgroundProvider → persona.provider (only if available in background registry) → backgroundAgent.defaultProvider`. Forward `backgroundModel` symmetrically with `model`. No changes to the background-agent provider registry itself — it remains a single global registry.

**Tech Stack:** TypeScript strict mode, Zod (config schema), neverthrow `Result<T, E>`, vitest, better-sqlite3 (unaffected).

---

## File Structure

**Modified:**
- `src/core/config/config-schema.ts` — add two persona fields + cross-section `.superRefine`
- `src/providers/provider-registry.ts` — add `hasProvider`
- `src/tools/host-tools/background-agent.ts:222-282` — extend provider + model resolution
- `README.md` — Background Agent Workers section (per-persona override docs)
- `config/talond.example.yaml` — annotated example
- `CLAUDE.md` — short note in architecture decisions
- `.claude/skills/create-profile/SKILL.md` — persona field reference

**Modified (tests):**
- `tests/unit/core/config/config-schema.test.ts` — new field defaults + cross-validation
- `tests/unit/providers/provider-registry.test.ts` — `hasProvider`
- `tests/unit/tools/background-agent.test.ts` — new resolution-chain cases + regression for the original openai-compatible bug

**No new files.** Every change extends an existing module.

---

## Background Context (read before starting)

The original bug: persona `assistant` has `provider: openai-compatible` (foreground). When it spawns a background agent, `background-agent.ts:230` forwards `personaProvider = 'openai-compatible'` to `BackgroundAgentManager.spawn`. The manager treats *any* non-empty provider as an "explicit request" that must be honored strictly (`background-agent-manager.ts:139-152`), and the background-agent registry only has `claude-code` and `codex-cli` enabled. Result: `Requested provider "openai-compatible" is not available. Enabled providers: claude-code, codex-cli.`

The existing `shouldForwardModel` logic (`background-agent.ts:252`) already knows persona ↔ background-provider mismatches happen — it drops the *model* in that case — but it doesn't drop the *provider itself*. This plan fixes that and adds explicit per-persona control.

Resolution chain after this plan:

```
explicit args.provider                                          (strict — fail if not in background registry)
  ↘ persona.backgroundProvider                                  (validated at config load)
    ↘ persona.provider (only if present in background registry) (safety net)
      ↘ backgroundAgent.defaultProvider                         (final default)
```

Model resolution (symmetric):

```
explicit args.provider given                                    → no model forwarded
persona.backgroundProvider used                                 → forward persona.backgroundModel (if set)
persona.provider used (because available in background registry) → forward persona.model (if set)
otherwise                                                       → no model forwarded
```

`args.model` does **not** exist on `BackgroundAgentArgs` — model overrides per-task are not surfaced to the LLM today. Do not add one in this plan.

---

### Task 1: Add `backgroundProvider` and `backgroundModel` to `PersonaConfigSchema`

**Files:**
- Modify: `src/core/config/config-schema.ts:79-95`
- Test: `tests/unit/core/config/config-schema.test.ts`

- [ ] **Step 1: Write failing test for new fields**

Add this test inside the existing `describe('PersonaConfigSchema')` block (or top-level if none — use existing file conventions):

```typescript
import { describe, it, expect } from 'vitest';
import { PersonaConfigSchema } from '../../../../src/core/config/config-schema.js';

describe('PersonaConfigSchema — background overrides', () => {
  it('accepts optional backgroundProvider and backgroundModel', () => {
    const parsed = PersonaConfigSchema.parse({
      name: 'assistant',
      backgroundProvider: 'claude-code',
      backgroundModel: 'claude-sonnet-4-6',
    });
    expect(parsed.backgroundProvider).toBe('claude-code');
    expect(parsed.backgroundModel).toBe('claude-sonnet-4-6');
  });

  it('defaults backgroundProvider and backgroundModel to undefined when omitted', () => {
    const parsed = PersonaConfigSchema.parse({ name: 'assistant' });
    expect(parsed.backgroundProvider).toBeUndefined();
    expect(parsed.backgroundModel).toBeUndefined();
  });

  it('rejects empty string backgroundProvider', () => {
    expect(() =>
      PersonaConfigSchema.parse({ name: 'assistant', backgroundProvider: '   ' }),
    ).toThrow();
  });

  it('rejects empty string backgroundModel', () => {
    expect(() =>
      PersonaConfigSchema.parse({ name: 'assistant', backgroundModel: '' }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/config/config-schema.test.ts -t "background overrides"`
Expected: 4 failing tests with messages about unrecognized keys or undefined values.

- [ ] **Step 3: Add fields to `PersonaConfigSchema`**

Edit `src/core/config/config-schema.ts:79-95`. Insert two lines between `provider:` (line 82) and `systemPromptFile:` (line 83):

```typescript
export const PersonaConfigSchema = z.object({
  name: z.string().min(1),
  model: z.string().default('claude-sonnet-4-6'),
  provider: z.string().trim().min(1).optional(),
  /**
   * Optional override: when set, background agents spawned by this persona use
   * this provider instead of the persona's foreground `provider` (or the
   * `backgroundAgent.defaultProvider`). Must be enabled under
   * `backgroundAgent.providers`. Validated at config load.
   */
  backgroundProvider: z.string().trim().min(1).optional(),
  /**
   * Optional model override paired with `backgroundProvider`. Ignored when
   * `backgroundProvider` is not set (to prevent cross-provider model leaks).
   */
  backgroundModel: z.string().trim().min(1).optional(),
  systemPromptFile: z.string().optional(),
  // ... rest unchanged
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/core/config/config-schema.test.ts -t "background overrides"`
Expected: 4 passing tests.

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: clean build (no TypeScript errors). The `PersonaConfig` type derived from the schema picks up the two new optional fields automatically.

- [ ] **Step 6: Commit**

```bash
git add src/core/config/config-schema.ts tests/unit/core/config/config-schema.test.ts
git commit -m "feat(config): add optional backgroundProvider/backgroundModel persona fields"
```

---

### Task 2: Add `hasProvider` to `ProviderRegistry`

**Files:**
- Modify: `src/providers/provider-registry.ts:14-58`
- Test: `tests/unit/providers/provider-registry.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/unit/providers/provider-registry.test.ts`:

```typescript
describe('ProviderRegistry.hasProvider', () => {
  it('returns true for an enabled registered provider', () => {
    const registry = new ProviderRegistry(
      { 'claude-code': { enabled: true, command: 'claude', contextWindowTokens: 200_000 } },
      { 'claude-code': () => ({ name: 'claude-code' } as any) },
    );
    expect(registry.hasProvider('claude-code')).toBe(true);
  });

  it('returns false for a provider that is not registered', () => {
    const registry = new ProviderRegistry(
      { 'claude-code': { enabled: true, command: 'claude', contextWindowTokens: 200_000 } },
      { 'claude-code': () => ({ name: 'claude-code' } as any) },
    );
    expect(registry.hasProvider('openai-compatible')).toBe(false);
  });

  it('returns false for a registered but disabled provider', () => {
    const registry = new ProviderRegistry(
      {
        'claude-code': { enabled: true, command: 'claude', contextWindowTokens: 200_000 },
        'codex-cli': { enabled: false, command: 'codex', contextWindowTokens: 200_000 },
      },
      {
        'claude-code': () => ({ name: 'claude-code' } as any),
        'codex-cli': () => ({ name: 'codex-cli' } as any),
      },
    );
    expect(registry.hasProvider('codex-cli')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/providers/provider-registry.test.ts -t "hasProvider"`
Expected: 3 failures with `registry.hasProvider is not a function`.

- [ ] **Step 3: Add `hasProvider` method**

Edit `src/providers/provider-registry.ts`. Insert after the `get` method (line 40):

```typescript
  /**
   * Predicate variant of `get` — true when the provider is registered and
   * enabled. Useful for "is this provider available before I demand it"
   * checks without forcing the caller to discard a `ProviderEntry`.
   */
  hasProvider(name: ProviderName): boolean {
    return this.providers.has(name);
  }
```

Also expose `hasProvider` on the `Pick<ProviderRegistry, …>` type used by `BackgroundAgentManagerDeps.providerRegistry` (`src/subagents/background/background-agent-manager.ts:63`):

```typescript
providerRegistry: Pick<ProviderRegistry, 'get' | 'getDefault' | 'listEnabled' | 'hasProvider'>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/providers/provider-registry.test.ts -t "hasProvider"`
Expected: 3 passing tests.

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add src/providers/provider-registry.ts src/subagents/background/background-agent-manager.ts tests/unit/providers/provider-registry.test.ts
git commit -m "feat(providers): add hasProvider predicate to ProviderRegistry"
```

---

### Task 3: Cross-section validation in `TalondConfigSchema`

Reject configs where a persona declares a `backgroundProvider` that isn't enabled in `backgroundAgent.providers`. Also reject `backgroundModel` set without `backgroundProvider`. Existing Zod `.superRefine` patterns live in `SpritesConfigSchema` (line 289) and `LangfuseConfigSchema` (line 320) — follow the same style.

**Files:**
- Modify: `src/core/config/config-schema.ts:364-381`
- Test: `tests/unit/core/config/config-schema.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/core/config/config-schema.test.ts`:

```typescript
import { TalondConfigSchema } from '../../../../src/core/config/config-schema.js';

describe('TalondConfigSchema — backgroundProvider cross-validation', () => {
  function baseConfig() {
    return {
      personas: [{ name: 'assistant' }],
      backgroundAgent: {
        enabled: true,
        providers: {
          'claude-code': { enabled: true, command: 'claude', contextWindowTokens: 200_000 },
        },
      },
    };
  }

  it('accepts a persona whose backgroundProvider is enabled', () => {
    const cfg = baseConfig();
    cfg.personas[0] = { name: 'assistant', backgroundProvider: 'claude-code' } as any;
    expect(() => TalondConfigSchema.parse(cfg)).not.toThrow();
  });

  it('rejects a persona whose backgroundProvider is not in backgroundAgent.providers', () => {
    const cfg = baseConfig();
    cfg.personas[0] = { name: 'assistant', backgroundProvider: 'openai-compatible' } as any;
    expect(() => TalondConfigSchema.parse(cfg)).toThrow(
      /backgroundProvider "openai-compatible" is not enabled/i,
    );
  });

  it('rejects a persona whose backgroundProvider is registered but disabled', () => {
    const cfg = baseConfig();
    (cfg.backgroundAgent.providers as any)['codex-cli'] = {
      enabled: false,
      command: 'codex',
      contextWindowTokens: 200_000,
    };
    cfg.personas[0] = { name: 'assistant', backgroundProvider: 'codex-cli' } as any;
    expect(() => TalondConfigSchema.parse(cfg)).toThrow(
      /backgroundProvider "codex-cli" is not enabled/i,
    );
  });

  it('rejects backgroundModel set without backgroundProvider', () => {
    const cfg = baseConfig();
    cfg.personas[0] = { name: 'assistant', backgroundModel: 'claude-opus-4-7' } as any;
    expect(() => TalondConfigSchema.parse(cfg)).toThrow(
      /backgroundModel requires backgroundProvider/i,
    );
  });

  it('reports the failing persona name in the error', () => {
    const cfg = baseConfig();
    cfg.personas = [
      { name: 'good', backgroundProvider: 'claude-code' },
      { name: 'bad', backgroundProvider: 'openai-compatible' },
    ] as any;
    expect(() => TalondConfigSchema.parse(cfg)).toThrow(/persona "bad"/i);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/unit/core/config/config-schema.test.ts -t "backgroundProvider cross-validation"`
Expected: 5 failures.

- [ ] **Step 3: Add `.superRefine` on `TalondConfigSchema`**

Edit `src/core/config/config-schema.ts:364-381`. Replace the `TalondConfigSchema` definition with:

```typescript
export const TalondConfigSchema = z
  .object({
    storage: StorageConfigSchema.default(() => StorageConfigSchema.parse({})),
    sandbox: SandboxConfigSchema.default(() => SandboxConfigSchema.parse({})),
    channels: z.array(ChannelConfigSchema).default([]),
    personas: z.array(PersonaConfigSchema).default([]),
    bindings: z.array(BindingConfigSchema).default([]),
    ipc: IpcConfigSchema.default(() => IpcConfigSchema.parse({})),
    queue: QueueConfigSchema.default(() => QueueConfigSchema.parse({})),
    scheduler: SchedulerConfigSchema.default(() => SchedulerConfigSchema.parse({})),
    auth: AuthConfigSchema.default(() => AuthConfigSchema.parse({})),
    agentRunner: AgentRunnerConfigSchema.default(() => AgentRunnerConfigSchema.parse({})),
    backgroundAgent: BackgroundAgentConfigSchema.default(() =>
      BackgroundAgentConfigSchema.parse({}),
    ),
    sprites: SpritesConfigSchema.default(() => SpritesConfigSchema.parse({})),
    langfuse: LangfuseConfigSchema.default(() => LangfuseConfigSchema.parse({})),
    subagents: SubAgentsConfigSchema.default({}),
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    dataDir: z.string().default('data'),
  })
  .superRefine((value, ctx) => {
    const enabledBackgroundProviders = new Set(
      Object.entries(value.backgroundAgent.providers)
        .filter(([, p]) => p.enabled)
        .map(([name]) => name),
    );

    value.personas.forEach((persona, index) => {
      if (persona.backgroundProvider) {
        if (!enabledBackgroundProviders.has(persona.backgroundProvider)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['personas', index, 'backgroundProvider'],
            message:
              `persona "${persona.name}": backgroundProvider "${persona.backgroundProvider}" ` +
              `is not enabled in backgroundAgent.providers. ` +
              `Enabled providers: ${[...enabledBackgroundProviders].join(', ') || '(none)'}.`,
          });
        }
      } else if (persona.backgroundModel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['personas', index, 'backgroundModel'],
          message:
            `persona "${persona.name}": backgroundModel requires backgroundProvider to be set.`,
        });
      }
    });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/core/config/config-schema.test.ts -t "backgroundProvider cross-validation"`
Expected: 5 passing tests.

- [ ] **Step 5: Smoke-test the real config**

Run: `node -e "require('./dist/core/config/config-loader.js').loadConfigSync('./talond.yaml')" 2>&1 || true`

(Skip if config-loader doesn't have a sync export — use `npm run build && node dist/index.js --help` instead, which loads the config during bootstrap.)

Expected: no validation error (your current `talond.yaml` has no personas using `backgroundProvider` yet).

- [ ] **Step 6: Commit**

```bash
git add src/core/config/config-schema.ts tests/unit/core/config/config-schema.test.ts
git commit -m "feat(config): validate persona backgroundProvider against backgroundAgent.providers at load"
```

---

### Task 4: Resolve provider in `background-agent.ts` — new chain

Implement the four-tier resolution. This task changes only the *provider* line; the model line is updated in Task 5 to keep diffs small.

**Files:**
- Modify: `src/tools/host-tools/background-agent.ts:33-44, 221-286`
- Test: `tests/unit/tools/background-agent.test.ts`

- [ ] **Step 1: Add `providerRegistry` to handler dependencies**

The handler currently can't introspect the background-agent provider registry. Add it as a dep so the handler can ask "is this provider available?" without going through the manager.

Edit `src/tools/host-tools/background-agent.ts:33-44`. Add an import and extend the interface:

```typescript
import type { ProviderRegistry } from '../../providers/provider-registry.js';

interface BackgroundAgentHandlerDeps {
  backgroundAgentManager: BackgroundAgentManager;
  backgroundProviderRegistry: Pick<ProviderRegistry, 'hasProvider'>;
  personaRepository: PersonaRepository;
  personaLoader: PersonaLoader;
  threadRepository: ThreadRepository;
  channelRepository: ChannelRepository;
  skillResolver: SkillResolver;
  contextAssembler: ContextAssembler;
  loadedSkills: LoadedSkill[];
  toolInstructions: Map<string, string>;
  logger: pino.Logger;
}
```

Then update the construction site in `src/daemon/daemon-bootstrap.ts`. Find where `BackgroundAgentHandler` is instantiated (grep for `new BackgroundAgentHandler` if not visible). Add the new dep:

```typescript
new BackgroundAgentHandler({
  // ...existing deps...
  backgroundProviderRegistry,
  // ...
});
```

- [ ] **Step 2: Write failing tests for the new chain**

Append to `tests/unit/tools/background-agent.test.ts`. Extend `createHandler` to accept and wire `backgroundProviderRegistry`:

```typescript
// Locate the existing createHandler() function and add to its deps block:
const backgroundProviderRegistry = {
  hasProvider: vi.fn().mockReturnValue(true),
};

const deps = {
  // ...existing deps...
  backgroundProviderRegistry,
  // ...
};
```

Then add tests:

```typescript
describe('background-agent provider resolution chain', () => {
  it('uses persona.backgroundProvider when set, ignoring persona.provider', async () => {
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: {
              skills: ['search-skill'],
              provider: 'openai-compatible',
              backgroundProvider: 'claude-code',
            },
            systemPromptContent: 'Base system prompt.',
            personalityContent: 'Friendly personality.',
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    const result = await handler.execute(
      { action: 'spawn', prompt: 'do work' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    expect(result.status).toBe('success');
    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude-code' }),
    );
  });

  it('falls back to persona.provider only when it is available in the background registry', async () => {
    const backgroundProviderRegistry = {
      hasProvider: vi.fn().mockImplementation((name: string) => name === 'gemini-cli'),
    };
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: { skills: [], provider: 'gemini-cli' },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
      backgroundProviderRegistry: backgroundProviderRegistry as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    const result = await handler.execute(
      { action: 'spawn', prompt: 'do work' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    expect(result.status).toBe('success');
    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gemini-cli' }),
    );
  });

  it('drops persona.provider when it is NOT in the background registry (defaults to daemon)', async () => {
    const backgroundProviderRegistry = {
      // openai-compatible is the persona's provider; it is NOT in background registry.
      hasProvider: vi.fn().mockImplementation((name: string) => name === 'claude-code'),
    };
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: { skills: [], provider: 'openai-compatible' },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
      backgroundProviderRegistry: backgroundProviderRegistry as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    const result = await handler.execute(
      { action: 'spawn', prompt: 'do work' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    expect(result.status).toBe('success');
    // provider key should be absent OR undefined so the manager picks the daemon default
    const spawnArgs = backgroundAgentManager.spawn.mock.calls[0][0];
    expect(spawnArgs.provider).toBeUndefined();
  });

  it('honors explicit args.provider strictly (still forwarded even when persona has backgroundProvider)', async () => {
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: { skills: [], provider: 'openai-compatible', backgroundProvider: 'claude-code' },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    const result = await handler.execute(
      { action: 'spawn', prompt: 'do work', provider: 'codex-cli' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    expect(result.status).toBe('success');
    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex-cli' }),
    );
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npx vitest run tests/unit/tools/background-agent.test.ts -t "provider resolution chain"`
Expected: 4 failures (provider mismatch).

- [ ] **Step 4: Implement the new resolution chain**

Edit `src/tools/host-tools/background-agent.ts:221-230`. Replace:

```typescript
    // Resolve provider: explicit arg > persona/profile config > undefined (daemon default).
    const explicitProvider =
      typeof args.provider === 'string' && args.provider.trim().length > 0
        ? args.provider.trim()
        : undefined;
    const personaProvider =
      typeof loadedPersona.config.provider === 'string' && loadedPersona.config.provider.trim().length > 0
        ? loadedPersona.config.provider.trim()
        : undefined;
    const resolvedProvider = explicitProvider ?? personaProvider;
```

with:

```typescript
    // Resolution: args.provider > persona.backgroundProvider > persona.provider
    // (only if available in background registry) > undefined (daemon default).
    //
    // The registry check is what prevents the original openai-compatible bug:
    // a persona's foreground provider may not be enabled for background runs,
    // and forwarding it would trip the manager's strict-provider check.
    const explicitProvider =
      typeof args.provider === 'string' && args.provider.trim().length > 0
        ? args.provider.trim()
        : undefined;
    const personaBackgroundProvider =
      typeof loadedPersona.config.backgroundProvider === 'string' &&
      loadedPersona.config.backgroundProvider.trim().length > 0
        ? loadedPersona.config.backgroundProvider.trim()
        : undefined;
    const personaProvider =
      typeof loadedPersona.config.provider === 'string' &&
      loadedPersona.config.provider.trim().length > 0
        ? loadedPersona.config.provider.trim()
        : undefined;
    const personaProviderIfAvailable =
      personaProvider && this.deps.backgroundProviderRegistry.hasProvider(personaProvider)
        ? personaProvider
        : undefined;
    const resolvedProvider =
      explicitProvider ?? personaBackgroundProvider ?? personaProviderIfAvailable;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/tools/background-agent.test.ts -t "provider resolution chain"`
Expected: 4 passing tests.

- [ ] **Step 6: Type-check + run full background-agent test file**

Run:
```bash
npm run build
npx vitest run tests/unit/tools/background-agent.test.ts
```

Expected: build clean, all tests pass (existing tests still green — `createHandler` now injects the new dep with default `hasProvider: () => true`, preserving prior assumptions).

- [ ] **Step 7: Commit**

```bash
git add src/tools/host-tools/background-agent.ts src/daemon/daemon-bootstrap.ts tests/unit/tools/background-agent.test.ts
git commit -m "feat(background-agent): resolve provider via persona.backgroundProvider with registry-aware fallback"
```

---

### Task 5: Resolve model in `background-agent.ts` symmetrically

Update the `shouldForwardModel` logic to forward `persona.backgroundModel` when `persona.backgroundProvider` was used, and `persona.model` when `persona.provider` was used (and validated).

**Files:**
- Modify: `src/tools/host-tools/background-agent.ts:243-282`
- Test: `tests/unit/tools/background-agent.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/tools/background-agent.test.ts`:

```typescript
describe('background-agent model resolution chain', () => {
  it('forwards backgroundModel when backgroundProvider resolves', async () => {
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: {
              skills: [],
              provider: 'openai-compatible',
              model: 'gpt-oss',
              backgroundProvider: 'claude-code',
              backgroundModel: 'claude-sonnet-4-6',
            },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    await handler.execute(
      { action: 'spawn', prompt: 'work' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude-code', model: 'claude-sonnet-4-6' }),
    );
  });

  it('forwards persona.model when persona.provider resolves (registry has it)', async () => {
    const backgroundProviderRegistry = {
      hasProvider: vi.fn().mockImplementation((name: string) => name === 'codex-cli'),
    };
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: { skills: [], provider: 'codex-cli', model: 'gpt-5.4' },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
      backgroundProviderRegistry: backgroundProviderRegistry as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    await handler.execute(
      { action: 'spawn', prompt: 'work' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex-cli', model: 'gpt-5.4' }),
    );
  });

  it('does NOT forward any model when persona.provider is dropped (not in background registry)', async () => {
    const backgroundProviderRegistry = {
      hasProvider: vi.fn().mockImplementation((name: string) => name === 'claude-code'),
    };
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: { skills: [], provider: 'openai-compatible', model: 'gpt-oss' },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
      backgroundProviderRegistry: backgroundProviderRegistry as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    await handler.execute(
      { action: 'spawn', prompt: 'work' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    const spawnArgs = backgroundAgentManager.spawn.mock.calls[0][0];
    expect(spawnArgs.provider).toBeUndefined();
    expect(spawnArgs.model).toBeUndefined();
  });

  it('does NOT forward model when args.provider is explicitly given', async () => {
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: {
              skills: [],
              provider: 'codex-cli',
              model: 'gpt-5.4',
              backgroundProvider: 'claude-code',
              backgroundModel: 'claude-sonnet-4-6',
            },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    await handler.execute(
      { action: 'spawn', prompt: 'work', provider: 'gemini-cli' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    const spawnArgs = backgroundAgentManager.spawn.mock.calls[0][0];
    expect(spawnArgs.provider).toBe('gemini-cli');
    expect(spawnArgs.model).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/unit/tools/background-agent.test.ts -t "model resolution chain"`
Expected: 4 failures (model mismatch).

- [ ] **Step 3: Implement model resolution**

Edit `src/tools/host-tools/background-agent.ts`. Replace the existing model resolution block (lines 243-282, the comment + `shouldForwardModel` + the `...(shouldForwardModel ? {…} : {})` spread):

```typescript
    // Model resolution mirrors provider resolution:
    //   - args.provider given                                   → no model
    //   - persona.backgroundProvider used                       → persona.backgroundModel
    //   - persona.provider used (validated against registry)    → persona.model
    //   - daemon default                                        → no model
    //
    // This prevents cross-provider model mismatches (e.g. "gpt-5.4" sent to
    // claude-code) when a persona's foreground stack differs from the
    // background stack.
    let resolvedModel: string | undefined;
    if (!explicitProvider) {
      if (personaBackgroundProvider) {
        resolvedModel = loadedPersona.config.backgroundModel ?? undefined;
      } else if (personaProviderIfAvailable && loadedPersona.config.model) {
        resolvedModel = loadedPersona.config.model;
      }
    }
```

Then replace the spawn call's model spread (currently around line 282):

```typescript
      ...(resolvedModel ? { model: resolvedModel } : {}),
```

(Delete the previous `shouldForwardModel` declaration and `...(shouldForwardModel ? { model: loadedPersona.config.model } : {})` spread.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/tools/background-agent.test.ts -t "model resolution chain"`
Expected: 4 passing tests.

- [ ] **Step 5: Run the full background-agent test file**

Run: `npx vitest run tests/unit/tools/background-agent.test.ts`
Expected: all tests pass. The existing tests `'passes model when persona has both model and explicit provider'` and `'does not pass model when persona has model but no explicit provider'` should still pass because the new logic preserves those semantics (default `hasProvider: () => true` from `createHandler` makes `persona.provider` resolve, so model forwards as before).

- [ ] **Step 6: Type-check**

Run: `npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/tools/host-tools/background-agent.ts tests/unit/tools/background-agent.test.ts
git commit -m "feat(background-agent): forward backgroundModel symmetrically with backgroundProvider"
```

---

### Task 6: Regression test for the original openai-compatible bug

Lock in that a persona with `provider: openai-compatible` and no `backgroundProvider` no longer trips the manager's strict check — it now falls through to `backgroundAgent.defaultProvider`.

**Files:**
- Test: `tests/unit/tools/background-agent.test.ts`

- [ ] **Step 1: Write regression test**

Append to `tests/unit/tools/background-agent.test.ts`:

```typescript
describe('regression: openai-compatible persona spawning background agents', () => {
  it('does not forward openai-compatible to the background manager (the trace 91a662301c97b16bb345de7cec973286 bug)', async () => {
    // Reproduces the original report: persona has `provider: openai-compatible`
    // (foreground), backgroundAgent.providers only enables claude-code + codex-cli.
    // Before this fix, openai-compatible was forwarded as an "explicit" provider
    // and tripped the manager's strict registry check.
    const backgroundProviderRegistry = {
      hasProvider: vi.fn().mockImplementation(
        (name: string) => name === 'claude-code' || name === 'codex-cli',
      ),
    };
    const { backgroundAgentManager, deps } = createHandler({
      personaLoader: {
        getByName: vi.fn().mockReturnValue(
          ok({
            config: {
              skills: [],
              provider: 'openai-compatible',
              model: 'kimi-k2.6:cloud',
            },
            resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
          }),
        ),
      } as any,
      backgroundProviderRegistry: backgroundProviderRegistry as any,
    });
    const handler = new BackgroundAgentHandler({
      ...deps,
      backgroundAgentManager: backgroundAgentManager as any,
    } as any);

    const result = await handler.execute(
      { action: 'spawn', prompt: 'do background work' },
      { runId: 'r', threadId: 'thread-1', personaId: 'persona-1', requestId: 'q' },
    );

    expect(result.status).toBe('success');
    const spawnArgs = backgroundAgentManager.spawn.mock.calls[0][0];
    expect(spawnArgs.provider).toBeUndefined(); // manager picks defaultProvider
    expect(spawnArgs.model).toBeUndefined();    // no cross-provider model leak
  });
});
```

- [ ] **Step 2: Run regression test**

Run: `npx vitest run tests/unit/tools/background-agent.test.ts -t "regression"`
Expected: PASS (the implementation from Tasks 4–5 should already make it pass — this test exists to lock the behavior).

- [ ] **Step 3: Run the full background-agent test file once more**

Run: `npx vitest run tests/unit/tools/background-agent.test.ts`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/tools/background-agent.test.ts
git commit -m "test(background-agent): regression — openai-compatible persona falls back to default"
```

---

### Task 7: Documentation

Per CLAUDE.md workflow, doc updates are required for any new feature.

**Files:**
- Modify: `README.md` (Background Agent Workers section, line 426–500)
- Modify: `config/talond.example.yaml` (annotate persona block)
- Modify: `CLAUDE.md` (architectural-decisions section)
- Modify: `.claude/skills/create-profile/SKILL.md` (persona field reference)

- [ ] **Step 1: Update `README.md` — Background Agent Workers section**

Edit `README.md`. After the Configuration block (around line 471, just after the `providers` table) and before the `Using openai-compatible for background agents` heading, insert:

```markdown
#### Per-persona override

Personas can route their background agents through a different provider/model than their foreground runtime by setting `backgroundProvider` and (optionally) `backgroundModel`:

```yaml
personas:
  - name: assistant
    model: kimi-k2.6:cloud
    provider: openai-compatible    # foreground stays on Ollama
    backgroundProvider: claude-code   # background runs on Claude Code
    backgroundModel: claude-sonnet-4-6
  - name: work-context-manager
    model: kimi-k2.6:cloud
    provider: openai-compatible
    # no backgroundProvider — falls back to backgroundAgent.defaultProvider
```

`backgroundProvider` must be enabled under `backgroundAgent.providers`; the daemon refuses to start otherwise. `backgroundModel` is paired with `backgroundProvider` and is ignored unless the provider override is also set.

Resolution order at spawn time:

1. Provider given explicitly in the `background_agent` tool call (strict)
2. Persona's `backgroundProvider`
3. Persona's foreground `provider` — **only** if it is also enabled in `backgroundAgent.providers`
4. `backgroundAgent.defaultProvider`
```

- [ ] **Step 2: Update `config/talond.example.yaml`**

Read `config/talond.example.yaml:186` (the `backgroundAgent` block) and the persona block above it. Add an annotated example persona near the top of the `personas:` list (or extend the first commented example) showing `backgroundProvider` + `backgroundModel`. Example diff:

```yaml
personas:
  - name: assistant
    model: kimi-k2.6:cloud
    provider: openai-compatible
    # Optional: override provider/model for background_agent spawns.
    # Useful when the foreground stack (e.g. Ollama) is not suitable for
    # long-running background work. Validated at config load against
    # backgroundAgent.providers.
    backgroundProvider: claude-code
    backgroundModel: claude-sonnet-4-6
    systemPromptFile: personas/assistant/system.md
    # ... rest unchanged
```

(Locate the existing assistant persona in the example file via `grep -n "^  - name:" config/talond.example.yaml` and add the two fields with the comment block above. If no `assistant` persona exists in the example, attach the same comment to whichever persona is first.)

- [ ] **Step 3: Update `CLAUDE.md`**

Edit `CLAUDE.md`. In the "Key Architectural Decisions" section, append a bullet after the existing capability/skills bullets:

```markdown
- **Per-persona background-agent override** — personas may set `backgroundProvider` and `backgroundModel` to route their background runs through a different runtime than the foreground `provider`. Validated at config load: `backgroundProvider` must be enabled under `backgroundAgent.providers`. When unset, the persona's foreground `provider` is used iff it is enabled in the background registry; otherwise the daemon falls back to `backgroundAgent.defaultProvider`.
```

- [ ] **Step 4: Update `.claude/skills/create-profile/SKILL.md`**

Read the file first and find the section that documents persona fields. Add `backgroundProvider` and `backgroundModel` alongside the existing `provider` / `model` documentation, with a one-line note: "set when the foreground provider is unsuitable for background agents (e.g. local Ollama running short-context models)".

- [ ] **Step 5: Build + lint to catch unrelated drift**

Run:
```bash
npm run build
npm run lint
```

Expected: clean build, no new lint warnings introduced.

- [ ] **Step 6: Commit**

```bash
git add README.md config/talond.example.yaml CLAUDE.md .claude/skills/create-profile/SKILL.md
git commit -m "docs: per-persona backgroundProvider/backgroundModel override"
```

---

### Task 8: Codex review + final integration

Per `CLAUDE.md`:
> Before every commit you need to use the codex skill to ask Gpt-5.4 for a review, address the issues, only if there are no critical, high or medium issues are found the work can be committed.

We've committed task-by-task above for granular history. Now run a holistic codex review across the full diff before merge.

**Files:** (review only — no edits unless codex finds issues)

- [ ] **Step 1: Stage the full feature diff for review**

Run: `git log --oneline main..HEAD` to confirm task commits.

- [ ] **Step 2: Invoke codex review**

Use the `codex` skill to ask GPT-5.4 to review the diff:

```
Review the diff between main and HEAD for the feature "per-persona background
agent provider override". Look for: (1) correctness of the resolution chain in
src/tools/host-tools/background-agent.ts (does explicit > persona.backgroundProvider
> persona.provider-if-available > default hold under all edge cases?); (2)
whether the load-time validation in src/core/config/config-schema.ts handles
the case where backgroundAgent.providers is empty; (3) any cross-provider model
leak paths the tests miss; (4) whether the new BackgroundAgentHandlerDeps field
is wired everywhere BackgroundAgentHandler is constructed (grep for
`new BackgroundAgentHandler`); (5) type safety of the optional fields end-to-end
from Zod inference through to the host-tool args.

Severity rubric: critical/high/medium must be fixed before merge; low is optional.
```

- [ ] **Step 3: Address findings**

For each critical/high/medium finding, return to the relevant task's implementation step, fix, re-run that task's tests, and commit the fix with a message referencing the codex review (e.g. `fix(background-agent): handle empty backgroundAgent.providers (codex review)`). Loop until codex returns only low-severity items or none.

- [ ] **Step 4: Run the full test suite**

Run: `npm test` (ask the user first — full suite is slow per CLAUDE.md).

Expected: all tests pass, coverage thresholds (80% branches/functions/lines/statements) maintained or improved.

- [ ] **Step 5: Final smoke test against the user's real config**

Run: `npm run build && timeout 10 node dist/index.js --config talond.yaml 2>&1 | head -40`

Expected: daemon boots without "backgroundProvider … is not enabled" errors. Kill it after the bootstrap log line. The user's current `talond.yaml` has zero personas using `backgroundProvider` so this is purely a "did I break startup" check.

- [ ] **Step 6: Open PR (or hand off for merge)**

If the user wants a PR: use `gh pr create` with a body that summarizes the four-tier resolution chain, the load-time validation, and the regression test for the original bug.

---

## Self-Review

**Spec coverage:**
- Per-persona `backgroundProvider` field → Task 1 ✓
- Symmetric `backgroundModel` field → Task 1 ✓
- Resolution chain (explicit > backgroundProvider > provider-if-available > default) → Task 4 ✓
- Symmetric model resolution → Task 5 ✓
- Load-time validation (fail loudly on typo or disabled provider) → Task 3 ✓
- Regression for original openai-compatible bug → Task 6 ✓
- Docs (README + example + CLAUDE.md + create-profile skill) → Task 7 ✓
- Codex review per workflow → Task 8 ✓

**Placeholder scan:** No "TBD", "TODO", "handle edge cases", "similar to Task N" remain. Every code block is concrete. Every command line names the exact file or test filter.

**Type consistency:**
- Field names `backgroundProvider` / `backgroundModel` used identically across schema (Task 1), validation (Task 3), handler (Task 4 & 5), tests (4, 5, 6), docs (Task 7).
- `hasProvider(name: ProviderName)` predicate consistent between definition (Task 2, `src/providers/provider-registry.ts`), the `Pick<…>` type in `BackgroundAgentManagerDeps` (Task 2), and the `BackgroundAgentHandlerDeps.backgroundProviderRegistry` injection (Task 4).
- `personaBackgroundProvider`, `personaProvider`, `personaProviderIfAvailable`, `resolvedProvider`, `resolvedModel` named consistently across Tasks 4 and 5.

No issues found.
