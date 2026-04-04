# Codex CLI Streaming Events for Talon Provider

Date: 2026-04-04
Issue: `ivo-toby/talon#174`

## Summary

The `codex-cli` provider currently collapses a JSONL execution stream into a single final output string. This change upgrades the foreground execution path to consume Codex JSONL incrementally and surface Talon streaming events while preserving the final synthesized output for existing consumers.

## Goals

1. Parse Codex JSONL incrementally instead of waiting for full stdout completion.
2. Surface assistant text chunks as Talon `text` stream events during execution.
3. Surface non-text execution activity as Talon `tool_event` stream events.
4. Preserve final output compatibility through the existing `last-message.txt` behavior.
5. Remain resilient to schema drift:
   - ignore unknown event types
   - ignore malformed individual lines
   - tolerate missing optional fields
   - avoid coupling correctness to a single exact `item.*` payload shape

## Non-Goals

1. Redesign Talon’s provider event model.
2. Change Codex CLI itself.
3. Add background-process live streaming beyond the foreground provider stream.
4. Emit reasoning blocks as user-visible text.

## Event Mapping

Foreground execution uses Talon `SDKExecutionStrategy` semantics even though Codex is still launched as a CLI subprocess.

### Text events

Emit Talon `{ type: 'text', content }` for assistant-visible text discovered in JSONL item events. The parser should accept text from multiple likely shapes, including nested item payloads and chunk/delta style fields, as long as the value is a string.

### Tool events

Emit Talon `{ type: 'tool_event', ... }` for non-text execution activity that represents tool-like or structured work. Mapping should preserve as much structure as available:

1. `messageType`: source event type or derived subtype
2. `tool`: best-effort tool name when present
3. `toolUseId`: best-effort stable id when present
4. `input`: structured input payload when present
5. `output`: structured output payload when present
6. `isError`: true for explicit error/result-error payloads
7. `subtype`: best-effort item subtype when present
8. `serverName`: MCP/server name when present

### Result event

At process completion, emit exactly one Talon `{ type: 'result', result }` event with:

1. `output`: final synthesized output read from `last-message.txt` when available, otherwise fallback output
2. `sessionId`: `thread.started.thread_id`
3. `usage`: usage parsed from `turn.completed`
4. `isError`: non-zero exit or timeout

## Validation Rules

Successful foreground execution still requires:

1. `thread.started`
2. `turn.completed`
3. a string `thread_id` when a thread id is required

Unknown event shapes must not fail the run by themselves. Missing terminal validation still fails the run.

## Task List

1. Convert `CodexCliProvider.createExecutionStrategy()` to a streaming strategy for foreground runs.
2. Add incremental JSONL line buffering and parsing for subprocess stdout.
3. Add best-effort event classification helpers for assistant text and tool-style events.
4. Keep existing background invocation/result parsing behavior compatible.
5. Add regression tests for:
   - streamed text emission before final result
   - structured tool event emission
   - unknown event types ignored
   - malformed JSONL lines ignored
   - validation failure only on missing required terminal events
