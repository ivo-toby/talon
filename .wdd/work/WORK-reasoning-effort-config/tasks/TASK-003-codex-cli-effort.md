---
id: TASK-003-codex-cli-effort
kind: micro_task
work: WORK-reasoning-effort-config
slug: codex-cli-effort
title: Codex CLI Effort Rendering
status: done
depends_on:
  - TASK-001-config-runtime-contract
conflict_domains:
  - src/providers/codex-cli-provider.ts
  - tests/unit/providers/codex-cli-provider.test.ts
risk: medium
review_required: true
branch: work/WORK-reasoning-effort-config-bundle
worker_worktree: /home/ivo/workspace/talon/.worktrees/work-reasoning-effort-config-bundle
current_gate: merge_ready
verification:
  - npx vitest run tests/unit/providers/codex-cli-provider.test.ts
---

# TASK-003-codex-cli-effort: Codex CLI Effort Rendering

## Objective

Render persona reasoning effort into Codex CLI's supported generated config path for both foreground and background Codex invocations.

## Scope

- Included:
  - Add optional effort to Codex home seeding and TOML rendering.
  - Write `model_reasoning_effort = "<effort>"` when configured.
  - Ensure foreground runs receive the setting from provider input.
  - Ensure background invocations receive the setting from provider input.
  - Preserve current generated config when effort is omitted.
  - Add focused provider tests.
- Excluded:
  - Passing unsupported model-name suffixes.
  - Changing Codex auth/state copy behavior.
  - OpenAI-compatible provider behavior.

## Context To Read

- `src/providers/codex-cli-provider.ts`
- `tests/unit/providers/codex-cli-provider.test.ts`
- Issue #253 provider behavior section for `codex-cli`.

## Likely Files

- `src/providers/codex-cli-provider.ts`
- `tests/unit/providers/codex-cli-provider.test.ts`

## Dependencies

- `TASK-001-config-runtime-contract`

## Conflict Domains

- `src/providers/codex-cli-provider.ts`
- `tests/unit/providers/codex-cli-provider.test.ts`

## Validation

- `npx vitest run tests/unit/providers/codex-cli-provider.test.ts`

## Done

- [x] Foreground Codex generated config includes `model_reasoning_effort` when configured.
- [x] Background Codex generated config includes `model_reasoning_effort` when configured.
- [x] No-effort config remains unchanged except for intended formatting.
- [x] Focused tests record evidence.

## Evidence

- Worker dispatched to `/home/ivo/workspace/talon/.worktrees/work-reasoning-effort-config-bundle` on branch `work/WORK-reasoning-effort-config-bundle`.
- RED: `npx vitest run tests/unit/core/config/config-schema.test.ts tests/unit/personas/persona-loader.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/sandbox/session-tracker.test.ts tests/unit/core/database/repositories/run-repository.test.ts tests/unit/tools/background-agent.test.ts tests/unit/subagents/background/background-agent-manager.test.ts tests/unit/providers/codex-cli-provider.test.ts tests/unit/providers/openai-compatible-provider.test.ts tests/unit/providers/openai-compatible-responses-api.test.ts` exited 1 before implementation; Codex CLI tests failed because generated config omitted `model_reasoning_effort`.
- GREEN: `npx vitest run tests/unit/providers/codex-cli-provider.test.ts` exited 0: 1 file, 25 tests passed.
- Final handoff: merge-ready commit `6be941ce9e15d01ed0123398bc8e0ff17c9f3042`.
