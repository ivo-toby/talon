# Stage 1 — Tool-output excerpting with artifact store (openai-compatible)

**Status:** draft
**Branch:** `feat/tool-output-trim`
**Related:** issue #198 (context compaction preflight); replaces the simpler "just cap at 8K" approach.

## Problem

On the openai-compatible provider (Mastra-based, owns its tool-call loop), raw tool output is appended to the message history verbatim. A single `read_file`, `git diff`, or `execute_command` result of tens of thousands of characters can overshoot the model's context window in a single step — especially on Ollama where windows are 8K–32K tokens.

Between-turn rotation (context-roller / observer) doesn't help: overshoot happens inside one run, before any rotation point.

Built-in Mastra Workspace tools already apply `maxOutputTokens` caps (2000–3000 in `agent-cli/index.ts`), but **MCP tools** (Talon host-tools and external MCPs) have no cap. They pass through raw.

## Goal

Make "tool output never enters message history unbounded" an invariant for openai-compatible, **without destroying information**.

Concretely: the model always sees a bounded excerpt in history; the full output is retained for the duration of the agent run; the model can explicitly re-fetch ranges if the excerpt isn't enough.

This mirrors how an engineer reads logs: scroll a summary; drill into the specific region that matters.

## Non-goals

- Mid-run LLM summarization (Stage 2)
- Preflight prompt-size gate between turns (Stage 3, issue #198)
- Applying to Claude Code / Codex CLI / Gemini CLI (those own their tool loops; we can't intercept)
- Cross-turn persistent artifact store (follow-up)
- Per-tool policy overrides, JSON-structure-aware trimming, query-region preservation (all V2)

## Design

### Components

1. **Excerpt policy** — each tool result is truncated to a char budget before entering agent history.
2. **In-memory artifact store** — full output retained by `toolCallId` for the duration of the agent run.
3. **`fetch_tool_output` synthetic tool** — agent can call this to retrieve a specific range of a truncated output.
4. **Truncation marker with retrieval hint** — the excerpt explicitly tells the model *how* to get the rest.

### Excerpt policy (V1)

- Default cap: **4000 chars** (roughly 1K tokens — fits under an Ollama 8K window alongside system + history + next-call space).
- Configurable per-provider: `options.toolOutputCap: number` (0 = disabled).
- Shape-aware:
  - MCP shape (`{ content: [{ type: 'text', text: '…' }, …], isError? }`): apply cap to the concatenated text, preserve the envelope.
  - Plain string: head/tail truncation (70% head, 30% tail).
  - Object / JSON-like: `JSON.stringify` then head/tail. (Structure-aware trimming is V2.)
- **Errors are NOT truncated.** If `isError === true` or the result looks like a stderr message (heuristic: short + contains "error"/"exception"/stack-trace markers), skip truncation. Error messages are critical and usually small.

### Truncation marker

```
[head content, first ~2800 chars]

[... TRUNCATED BY TALON: N chars omitted, M total from tool 'tool_name'.
 Full output retained in this run as toolCallId="<id>".
 Call fetch_tool_output(toolCallId="<id>", startChar=…, endChar=…) to read a specific range. ...]

[tail content, last ~1200 chars]
```

The marker is deliberately verbose so the model knows **this is a Talon truncation, not the tool's own output, and there's a recovery path.**

### In-memory artifact store

- A `Map<toolCallId, { toolName: string, fullOutput: string, originalChars: number }>` inside the agent-cli wrapper process.
- Populated during tool execution (before truncation happens).
- Lifetime: one agent run. Cleared on wrapper exit.
- No DB writes, no disk writes in V1. Keeps the change small.

### `fetch_tool_output` synthetic tool

Registered alongside MCP tools in `Agent({ tools: { …mcpTools, fetch_tool_output: … } })`.

```ts
fetch_tool_output({
  toolCallId: string,       // the id of the original truncated tool call
  startChar?: number,       // 0-indexed; default 0
  endChar?: number,         // exclusive; default = startChar + 8000
})
```

Returns a chunk of the full output. Invariants:

- **Returned slice is itself capped** at 8000 chars (2× the default excerpt cap). Prevents the model from accidentally reintroducing the entire oversized payload into history by asking for `[0, 999999]`.
- If `toolCallId` not found (expired, typo, cross-run): returns an error string (not an exception).
- The fetched chunk is also subject to the excerpt policy if it exceeds the slice cap — so the model gets a truncated-of-truncated with the same marker. Agent must narrow the range.

### Telemetry

- Wrapper NDJSON emits a `tool_event` with `truncated: true, originalChars: N, excerptChars: M, toolCallId` so the daemon can log and Langfuse can surface it.
- On every truncation: structured `warn` log with tool name, original size, cap.

## Config

```yaml
agentRunner:
  providers:
    openai-compatible:
      contextWindowTokens: 8000
      options:
        defaultModel: qwen2.5-coder:7b
        toolOutputCap: 4000        # chars; 0 disables; default 4000 when enabled
```

Default is on with a conservative 4000-char cap. Operators can raise for bigger models or set `0` to disable entirely.

## Files touched

- `src/core/config/config-schema.ts` — add optional `toolOutputCap` to openai-compatible provider options.
- `src/providers/openai-compatible-provider.ts` — extend `WrapperPayload`, pass config through to child process.
- `src/providers/openai-compatible/agent-cli/index.ts` — wire the excerpter, register `fetch_tool_output`, wrap MCP tools.
- **NEW** `src/providers/openai-compatible/agent-cli/tool-output-excerpter.ts` — pure functions: `truncate`, `buildMarker`, `isLikelyError`; class `ToolOutputStore` for the in-memory map.
- **NEW** `tests/unit/providers/openai-compatible/tool-output-excerpter.test.ts` — unit tests for truncation, shape handling, error bypass, store behaviour.

## V2 backlog (out of scope here)

- Per-tool policy (`read_file` preserves file body around requested line range; `grep` preserves matching lines; `execute_command` head/tail).
- JSON structure-aware trimming (keep top-level keys visible, elide long values with a size hint).
- Persistent artifact store (DB + disk) so cross-turn retrieval survives beyond a single run.
- Stderr detection based on exit code instead of heuristic.
- Cross-provider rollout (Claude SDK has its own tool loop; Mastra variant of it may want the same treatment).
- Token-based cap (using a real tokenizer) once an empirical baseline exists.

## Acceptance criteria

- A 50K-char tool result lands in agent history as a ~4K excerpt with the truncation marker, plus a `fetch_tool_output` hint.
- The model can call `fetch_tool_output(toolCallId, startChar, endChar)` and get an 8K-capped slice back.
- Error-flagged tool results (`isError: true`) are passed through untouched.
- A run with no truncation has identical behaviour to today (no regression).
- `toolOutputCap: 0` disables the feature cleanly.
- Claude Code / Codex CLI / Gemini CLI are untouched.
