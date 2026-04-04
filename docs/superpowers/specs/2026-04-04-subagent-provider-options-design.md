# Per-Model `providerOptions` for Sub-Agents — Design

**Date:** 2026-04-04
**Branch:** `feat/subagent-config-override`
**Status:** Approved, ready for planning

## Problem

Operators run local OpenAI-compatible endpoints (llama.cpp, vLLM, Qwen via a
Cloudflare tunnel) for sub-agent inference. These endpoints accept non-standard
top-level request body fields that the AI SDK's strict `@ai-sdk/openai` provider
does not expose. The motivating case: disabling reasoning/thinking on Qwen3 via

```json
{ "chat_template_kwargs": { "enable_thinking": false } }
```

Thinking mode wastes tokens on structured-output tasks like summarization and
memory grooming. Users need per-sub-agent control, per-model, without forking
sub-agent code for every vendor quirk.

## Goals

1. Per-model-entry free-form passthrough of request body fields for the
   `ollama` provider slot (which already serves all OpenAI-compatible endpoints).
2. Works for any vendor knob (`chat_template_kwargs`, `temperature`, `top_p`,
   sampling params, future fields) without schema churn.
3. Consistent with existing per-model overrides (`timeoutMs`, `maxTokens`).
4. Failover-safe: Qwen-specific options do not leak to Claude when the chain
   falls over to an Anthropic fallback.

## Non-Goals

- Exposing strict OpenAI fields on real OpenAI (`provider: openai`). That path
  stays typed via `createOpenAI`; llama.cpp / vLLM users go through
  `provider: ollama`.
- A semantic `thinking: false` abstraction. Each model family exposes thinking
  differently (Qwen `chat_template_kwargs`, DeepSeek-R1 tag suppression, OpenAI
  `reasoning_effort`, Anthropic `thinking` block). A single boolean cannot map
  cleanly and would break on every new model family.
- Per-provider global `providerOptions`. The knob is model-specific; a global
  default would leak across sub-agents.
- Changes to the Anthropic or Google provider code paths.

## Architecture

### Switch `ollama` code path to `createOpenAICompatible`

Current `model-resolver.ts` ollama case:

```typescript
case 'ollama': {
  const { createOpenAI } = await import('@ai-sdk/openai');
  const baseURL = creds.baseURL ?? 'http://localhost:11434/v1';
  return createOpenAI({ baseURL, apiKey: 'ollama' })(modelName);
}
```

Becomes:

```typescript
case 'ollama': {
  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
  const baseURL = creds.baseURL ?? 'http://localhost:11434/v1';
  return createOpenAICompatible({ name: 'ollama', baseURL, apiKey: 'ollama' })(modelName);
}
```

This is the only resolver change. `createOpenAICompatible` is the AI SDK's
explicit passthrough provider: `providerOptions[name]` becomes arbitrary body
fields in the request. The `createOpenAI` typed options do not allow this.

New dependency: `@ai-sdk/openai-compatible`.

### Schema: free-form `providerOptions` per model entry

```typescript
export const SubAgentModelOverrideSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
});
```

No inner validation — vendor-specific, explicit contract with the operator.

### User-facing YAML shape

The user writes options flat (no provider-key nesting):

```yaml
subagents:
  session-summarizer:
    model:
      - provider: ollama
        name: Qwen3.5-35B-A3B-UD-Q4_K_XL
        timeoutMs: 180000
        providerOptions:
          chat_template_kwargs:
            enable_thinking: false
      - provider: anthropic
        name: claude-sonnet-4-6
        timeoutMs: 60000
        # no providerOptions — Claude doesn't need them, and would
        # reject the Qwen-specific field
```

### Runner wraps under provider key

The AI SDK's `providerOptions` argument is `Record<providerName, Record<string, unknown>>`.
The runner wraps the user's flat record under the active model entry's provider
name before placing it on the context:

```typescript
const wrappedProviderOptions = modelEntry.providerOptions
  ? { [modelEntry.provider]: modelEntry.providerOptions }
  : undefined;

const agentContext = {
  // ...
  abortSignal: abortController.signal,
  providerOptions: wrappedProviderOptions,
};
```

Sub-agents forward `ctx.providerOptions` verbatim to `generateText` /
`generateObject`. They do not know the provider name.

### SubAgentContext extension

```typescript
export interface SubAgentContext {
  // ... existing fields
  abortSignal?: AbortSignal;
  providerOptions?: Record<string, Record<string, unknown>>;
}
```

### Sub-agent call-site pattern

All 5 default sub-agents gain one field in their AI SDK call:

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

Same mechanical treatment as the earlier `abortSignal` task.

### CLI and bootstrap paths

Both `src/cli/commands/run-subagent.ts` and `src/daemon/daemon-bootstrap.ts`
build their own model chains and `SubAgentContext` instances. Each needs the
same wrap-under-provider-key logic when it selects a model entry.

## Failover Semantics

Each model entry in the chain carries its own `providerOptions`. When the
runner falls over from Qwen to Claude, the next `SubAgentContext` it builds
has `providerOptions: undefined` (because the Anthropic entry has no
`providerOptions` in the config). Claude never sees Qwen-specific fields.

If a user does specify `providerOptions` on multiple entries in a chain, each
entry's options apply only when that entry is the active one.

## Error Handling

- Unknown fields inside `providerOptions`: no validation — forwarded as-is.
  The vendor endpoint's response is the error surface. If llama.cpp rejects
  an unknown field, the run fails with the AI SDK error; failover proceeds
  normally per existing logic.
- `providerOptions` on a `provider: openai` entry: still passes through the
  AI SDK, but strict `@ai-sdk/openai` will drop non-typed keys silently.
  Acceptable — users targeting llama.cpp should use `provider: ollama`.
- `providerOptions` on `provider: anthropic` / `google`: same — silently
  dropped by those typed providers. Documented in the config example.

## Testing

Unit tests added alongside existing sub-agent runner tests:

1. **Schema test** — `providerOptions` is accepted as arbitrary record,
   absent/present/nested values all parse.
2. **Runner wrapping test** — when an override entry has `providerOptions`,
   the runner places `{ [provider]: providerOptions }` on the context.
3. **Runner absence test** — when the override has no `providerOptions`,
   `ctx.providerOptions` is `undefined`.
4. **Runner failover isolation test** — a chain where the first entry has
   `providerOptions` and the second does not: confirm the second attempt's
   context has `providerOptions: undefined`.

No integration test against a live llama.cpp endpoint — the wire-level
behavior is the AI SDK's responsibility.

## Documentation

Add a short section to `config/talond.example.yaml` with the Qwen
disable-thinking example verbatim. Users land on this via grep when they
search the repo for "qwen" or "thinking".

Update `CLAUDE.md` if the `providerOptions` feature affects the documented
architecture. (It extends an existing feature rather than adding a new
subsystem, so a one-line note in the SubAgents section is likely enough.)

## Rollout

Single feature branch, single PR. Six small commits following the task
decomposition (one per task in the implementation plan). No migration
concerns — the feature is additive and opt-in; existing configs without
`providerOptions` are unaffected.
