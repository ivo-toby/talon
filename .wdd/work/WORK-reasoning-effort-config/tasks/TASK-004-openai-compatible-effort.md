---
id: TASK-004-openai-compatible-effort
kind: micro_task
work: WORK-reasoning-effort-config
slug: openai-compatible-effort
title: OpenAI-Compatible Responses Effort
status: review
depends_on:
  - TASK-001-config-runtime-contract
conflict_domains:
  - src/providers/openai-compatible-provider.ts
  - src/providers/openai-compatible/agent-cli/index.ts
  - src/providers/openai-compatible/agent-cli/responses-api.ts
  - tests/unit/providers/openai-compatible-provider.test.ts
  - tests/unit/providers/openai-compatible-responses-api.test.ts
risk: medium
review_required: true
branch: work/WORK-reasoning-effort-config-bundle
worker_worktree: /home/ivo/workspace/talon/.worktrees/work-reasoning-effort-config-bundle
current_gate: ready_for_finish
verification:
  - npx vitest run tests/unit/providers/openai-compatible-provider.test.ts tests/unit/providers/openai-compatible-responses-api.test.ts
---

# TASK-004-openai-compatible-effort: OpenAI-Compatible Responses Effort

## Objective

Translate persona reasoning effort into OpenAI-compatible Responses API request bodies while preserving provider-level reasoning options.

## Scope

- Included:
  - Carry provider input effort into the OpenAI-compatible wrapper payload.
  - In Responses mode, merge effort into `providerOptions.reasoning.effort`.
  - Preserve provider-level `providerOptions.reasoning` fields other than `effort`.
  - Give persona-level effort deterministic precedence for `reasoning.effort`.
  - Preserve current behavior when effort is omitted.
  - Define deterministic chat-completions behavior in code and tests, preferring a clear runtime/configuration error if this can be done without overcoupling.
  - Add focused provider and Responses loop tests.
- Excluded:
  - Hard-coding model-specific support.
  - Changing Mastra chat-completions provider options unrelated to this field.

## Context To Read

- `src/providers/openai-compatible-provider.ts`
- `src/providers/openai-compatible/agent-cli/index.ts`
- `src/providers/openai-compatible/agent-cli/responses-api.ts`
- `tests/unit/providers/openai-compatible-provider.test.ts`
- `tests/unit/providers/openai-compatible-responses-api.test.ts`
- Issue #253 provider behavior section for `openai-compatible`.

## Likely Files

- `src/providers/openai-compatible-provider.ts`
- `src/providers/openai-compatible/agent-cli/index.ts`
- `src/providers/openai-compatible/agent-cli/responses-api.ts`
- `tests/unit/providers/openai-compatible-provider.test.ts`
- `tests/unit/providers/openai-compatible-responses-api.test.ts`

## Dependencies

- `TASK-001-config-runtime-contract`

## Conflict Domains

- `src/providers/openai-compatible-provider.ts`
- `src/providers/openai-compatible/agent-cli/**`
- `tests/unit/providers/openai-compatible*.test.ts`

## Validation

- `npx vitest run tests/unit/providers/openai-compatible-provider.test.ts tests/unit/providers/openai-compatible-responses-api.test.ts`

## Done

- [x] Responses request body includes `reasoning.effort` from persona config.
- [x] Persona effort wins over provider-level `reasoning.effort`.
- [x] Other provider-level reasoning fields are preserved.
- [x] Omitted effort preserves current behavior.
- [x] Chat-completions behavior is deterministic and tested.
- [x] Focused tests record evidence.

## Evidence

- Worker dispatched to `/home/ivo/workspace/talon/.worktrees/work-reasoning-effort-config-bundle` on branch `work/WORK-reasoning-effort-config-bundle`.
- RED: `npx vitest run tests/unit/core/config/config-schema.test.ts tests/unit/personas/persona-loader.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/sandbox/session-tracker.test.ts tests/unit/core/database/repositories/run-repository.test.ts tests/unit/tools/background-agent.test.ts tests/unit/subagents/background/background-agent-manager.test.ts tests/unit/providers/codex-cli-provider.test.ts tests/unit/providers/openai-compatible-provider.test.ts tests/unit/providers/openai-compatible-responses-api.test.ts` exited 1 before implementation; OpenAI-compatible tests failed because effort was not forwarded into the wrapper payload, Responses request body, or deterministic chat-completions handling.
- GREEN: `npx vitest run tests/unit/providers/openai-compatible-provider.test.ts tests/unit/providers/openai-compatible-responses-api.test.ts` exited 0: 2 files, 35 tests passed.
- Note: The GREEN pass also fixed a pre-existing wrapper bug in this path by awaiting async `createWorkspaceTools(workspace)`, restoring Responses workspace tool availability.
- REVIEW P2 FIX RED: `npx vitest run tests/unit/providers/openai-compatible-provider.test.ts -t "passes persona reasoningEffort to foreground Responses wrapper payload"` exited 1; foreground wrapper payload had `reasoningEffort: undefined` instead of `xhigh`.
- REVIEW P2 FIX GREEN: `npx vitest run tests/unit/providers/openai-compatible-provider.test.ts tests/unit/providers/openai-compatible-responses-api.test.ts` exited 0: 2 files, 36 tests passed.
