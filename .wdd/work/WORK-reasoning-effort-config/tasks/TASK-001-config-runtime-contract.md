---
id: TASK-001-config-runtime-contract
kind: micro_task
work: WORK-reasoning-effort-config
slug: config-runtime-contract
title: Config and Runtime Contract
status: review
depends_on: []
conflict_domains:
  - src/core/config/**
  - src/personas/**
  - src/providers/provider.ts
  - src/providers/provider-types.ts
  - src/daemon/agent-runner.ts
  - src/tools/host-tools/background-agent.ts
  - src/subagents/background/background-agent-manager.ts
risk: medium
review_required: true
branch: work/WORK-reasoning-effort-config-bundle
worker_worktree: /home/ivo/workspace/talon/.worktrees/work-reasoning-effort-config-bundle
current_gate: ready_for_finish
verification:
  - npx vitest run tests/unit/core/config/config-schema.test.ts tests/unit/personas/persona-loader.test.ts tests/unit/daemon/agent-runner.test.ts
---

# TASK-001-config-runtime-contract: Config and Runtime Contract

## Objective

Introduce persona-level `reasoningEffort` as a typed, validated config field and carry it through foreground and background provider invocation inputs without changing behavior when omitted.

## Scope

- Included:
  - Add conservative valid values: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
  - Preserve absence when omitted.
  - Ensure persona loading keeps the parsed field available in `loadedPersona.config`.
  - Extend provider-facing input types with optional `reasoningEffort`.
  - Pass persona effort from `AgentRunner` into foreground provider query input.
  - Pass persona effort from `background-agent` through `BackgroundAgentManager` into background provider invocation when the resolved model comes from the persona.
  - Add focused schema, persona loader, and agent-runner/background plumbing tests.
- Excluded:
  - Provider-specific Codex TOML rendering.
  - OpenAI-compatible Responses payload merge behavior.
  - Session identity persistence changes.
  - CLI `add-persona` ergonomics unless discovered to be required by existing code paths.

## Context To Read

- `src/core/config/config-schema.ts`
- `src/core/config/config-types.ts`
- `src/personas/persona-loader.ts`
- `src/providers/provider.ts`
- `src/providers/provider-types.ts`
- `src/daemon/agent-runner.ts`
- `src/tools/host-tools/background-agent.ts`
- `src/subagents/background/background-agent-manager.ts`
- `tests/unit/core/config/config-schema.test.ts`
- `tests/unit/personas/persona-loader.test.ts`
- `tests/unit/daemon/agent-runner.test.ts`

## Likely Files

- `src/core/config/config-schema.ts`
- `src/providers/provider.ts`
- `src/providers/provider-types.ts`
- `src/daemon/agent-runner.ts`
- `src/tools/host-tools/background-agent.ts`
- `src/subagents/background/background-agent-manager.ts`
- `tests/unit/core/config/config-schema.test.ts`
- `tests/unit/personas/persona-loader.test.ts`
- `tests/unit/daemon/agent-runner.test.ts`

## Dependencies

- None.

## Conflict Domains

- `src/core/config/**`
- `src/providers/provider.ts`
- `src/providers/provider-types.ts`
- `src/daemon/agent-runner.ts`
- `src/tools/host-tools/background-agent.ts`
- `src/subagents/background/background-agent-manager.ts`

## Validation

- `npx vitest run tests/unit/core/config/config-schema.test.ts tests/unit/personas/persona-loader.test.ts tests/unit/daemon/agent-runner.test.ts`

## Done

- [x] Valid effort values parse and invalid values fail.
- [x] Omitted `reasoningEffort` remains absent or undefined.
- [x] Foreground provider input includes the value only when configured.
- [x] Background provider input includes the value when using the persona's compatible model/provider selection.
- [x] Focused tests record evidence.

## Evidence

- Worker dispatched to `/home/ivo/workspace/talon/.worktrees/work-reasoning-effort-config-bundle` on branch `work/WORK-reasoning-effort-config-bundle`.
- RED: `npx vitest run tests/unit/core/config/config-schema.test.ts tests/unit/personas/persona-loader.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/sandbox/session-tracker.test.ts tests/unit/core/database/repositories/run-repository.test.ts tests/unit/tools/background-agent.test.ts tests/unit/subagents/background/background-agent-manager.test.ts tests/unit/providers/codex-cli-provider.test.ts tests/unit/providers/openai-compatible-provider.test.ts tests/unit/providers/openai-compatible-responses-api.test.ts` exited 1 before implementation; failures showed missing schema preservation, provider input propagation, session effort filters, provider rendering, and Responses merge behavior. SQLite-backed cases also exposed a local `better-sqlite3` ABI mismatch.
- GREEN: `npx vitest run tests/unit/core/config/config-schema.test.ts tests/unit/personas/persona-loader.test.ts tests/unit/daemon/agent-runner.test.ts` exited 0: 3 files, 214 tests passed.
- GREEN: `npx vitest run tests/unit/tools/background-agent.test.ts tests/unit/subagents/background/background-agent-manager.test.ts` exited 0: 2 files, 79 tests passed.
