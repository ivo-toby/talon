# Subagent Model Configuration: Per-Subagent Overrides and Failover

**Issue:** [#156](https://github.com/ivo-toby/talon/issues/156)
**Date:** 2026-04-02
**Status:** Approved

## Problem

Subagent model selection is hardcoded in each subagent's `subagent.yaml` manifest. Operators cannot override models from `talond.yaml`, and there is no failover if a provider is unavailable (e.g., local Ollama endpoint is down).

## Goals

1. Per-subagent model overrides in `talond.yaml` without editing `subagent.yaml` manifests.
2. Ordered failover chain so if the primary model fails, the next is tried automatically.

## Design Decisions

- **Top-level `subagents` config section** (not per-persona). Subagents do the same job regardless of which persona invokes them; per-persona overrides are YAGNI.
- **Catch-on-error failover** (not health checks or circuit breakers). Subagent calls are infrequent enough that the latency of one failed attempt is acceptable. No background polling needed.
- **Failover at the runner level**. Subagent `run()` functions remain unaware of failover; they receive a single resolved model. The runner retries with the next model on failure.
- **Manifest model as final fallback**. If all override models fail, the model declared in `subagent.yaml` is tried last. If that also fails, the error includes a summary of all failures.

## Config Shape

New optional top-level section in `talond.yaml`:

```yaml
subagents:
  memory-groomer:
    model:
      - provider: ollama
        name: qwen3-30b
        maxTokens: 4096        # optional, falls back to manifest default
      - provider: anthropic
        name: claude-haiku-4-5
  session-summarizer:
    model:
      - provider: openai
        name: gpt-5.4-spark
```

- `model` is an ordered array. Each entry is tried in sequence.
- `maxTokens` is optional per entry; if omitted, the manifest's `maxTokens` is used.
- Subagents not listed here use their manifest model unchanged (no behavioral change).

## Config Schema

New Zod schemas in `config-schema.ts`:

```typescript
const SubAgentModelOverrideSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  maxTokens: z.number().int().positive().optional(),
});

const SubAgentOverrideSchema = z.object({
  model: z.array(SubAgentModelOverrideSchema).min(1),
});

const SubAgentsConfigSchema = z.record(z.string(), SubAgentOverrideSchema);
```

Added to root config schema as:

```typescript
subagents: SubAgentsConfigSchema.optional().default({})
```

## Model Resolution Flow

### Current flow (unchanged for subagents without overrides)

1. Runner calls `modelResolver.resolve(manifest.model)`
2. Resolver checks credentials in `auth.providers`, imports AI SDK package
3. Returns `LanguageModel` or error

### New flow (for subagents with overrides)

1. Runner builds model chain: config override entries + manifest model as final entry
2. For each model in chain:
   a. Call `modelResolver.resolve()` -- on config error (missing credentials, unknown provider), log warning, skip to next
   b. Build `SubAgentContext` with resolved model, invoke `agent.run()`
   c. On success: return result
   d. On runtime error (provider down, model not found, timeout): log warning with error details, try next model
3. If all models exhausted: return error listing all attempted providers and their failure reasons

### Error reporting

The final error includes each model attempted and why it failed:

```
All models failed for subagent "memory-groomer":
  1. ollama/qwen3-30b: ECONNREFUSED 127.0.0.1:11434
  2. anthropic/claude-haiku-4-5: 529 API overloaded
  3. anthropic/claude-haiku-4-5 (manifest fallback): 529 API overloaded
```

## Component Changes

### `src/core/config/config-schema.ts`
- Add `SubAgentModelOverrideSchema`, `SubAgentOverrideSchema`, `SubAgentsConfigSchema`
- Add optional `subagents` field to root config schema with default `{}`

### `src/subagents/subagent-types.ts`
- Export `SubAgentModelOverride` type (inferred from Zod schema or defined independently)

### `src/subagents/subagent-runner.ts`
- Constructor accepts `subagentOverrides: Record<string, SubAgentOverride>` parameter
- `execute()` builds model chain from overrides + manifest fallback
- Retry loop wraps model resolution and `agent.run()` invocation
- Logging: warn on each failed attempt, info on successful failover

### `src/subagents/model-resolver.ts`
- No changes. Existing `resolve()` method is sufficient.

### `src/daemon/daemon-bootstrap.ts`
- Pass `config.subagents ?? {}` to `SubAgentRunner` constructor

### `src/cli/commands/run-subagent.ts`
- Pass config overrides to runner for CLI testing consistency

### `config/talond.example.yaml`
- Add documented `subagents` section with examples

### `README.md`
- Document subagent model overrides and failover behavior

### Tests
- Config schema: valid overrides, missing fields, empty arrays rejected
- Runner failover: first model fails -> second succeeds, all fail -> error with summary
- Runner no overrides: existing behavior unchanged
- Integration with manifest fallback

## Non-Goals

- Per-persona model overrides (can be added later if needed)
- Health-check or circuit-breaker patterns
- Changes to `subagent.yaml` schema or loader
- Changes to `ModelResolver` interface
