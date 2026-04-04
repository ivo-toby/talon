# Issue 172: Codex Background First Invocation Reliability

## Problem

Codex background-agent runs can be marked failed on first invocation even when Codex exits successfully and writes a coherent final output. Two conditions contribute:

1. Background Codex `HOME` is created under `/tmp`, which triggers Codex helper-binary PATH warnings.
2. Background result parsing currently converts `exitCode: 0` into a synthetic failure when expected JSONL shutdown events are missing, even if the final output file is present and non-empty.

## In Scope

- Move background Codex `HOME` to a stable Talon-managed path under `dataDir`.
- Preserve strict JSONL validation for foreground runs.
- Relax background success classification only when:
  - the process exits with `0`
  - the run did not time out
  - the final output file exists and contains non-empty output
- Surface missing JSONL as diagnostic stderr instead of task failure in that background-only case.
- Add regression tests for background `HOME` location and background result parsing.

## Out of Scope

- Broader refactors of provider process management.
- Changing non-background Codex validation semantics.
- Fixing arbitrary malformed provider output beyond the narrow `exitCode: 0` plus final output fallback.

## Tasks

- Add provider tests that fail under the current `/tmp` background `HOME` behavior.
- Add provider tests that fail when successful background output without `turn.completed` is forced to `exitCode: 1`.
- Implement the minimum provider changes to satisfy those tests.
- Run targeted provider tests, then broader relevant checks.
- Request review and address findings before commit and PR.
