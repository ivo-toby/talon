---
id: WORK-reasoning-effort-config
kind: work_packet
profile: micro
slug: reasoning-effort-config
title: Per-Persona Reasoning Effort Configuration
status: planned
created_at: 2026-07-10
updated_at: 2026-07-10
target_branch: main
base_branch: work/reasoning-effort-config
schema_version: 1
task_count: 5
adapter_links:
  github_issue: https://github.com/ivo-toby/talon/issues/253
  jira_issue: null
---

# Per-Persona Reasoning Effort Configuration

## Summary

Add first-class persona-level `reasoningEffort` configuration so OpenAI/Codex models can run at different thinking depths without provider aliases or model-name suffixes. The implementation must preserve existing behavior when the field is omitted and make unsupported provider behavior deterministic.

## Goal

Operators can configure the same model with different effort levels per persona, for example `model: gpt-5.5` plus `reasoningEffort: xhigh`, and Talon passes that setting through supported Codex CLI and OpenAI-compatible Responses paths.

## Scope

- Included:
  - Add a conservative persona `reasoningEffort` enum: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
  - Preserve the parsed field through persona loading and runtime provider input contracts.
  - Pass effort through foreground agent runs and background-agent provider invocations.
  - Render Codex CLI effort as `model_reasoning_effort` in generated Codex config.
  - Merge OpenAI-compatible Responses provider options so persona effort wins for `reasoning.effort` while provider-level reasoning fields remain intact.
  - Scope resumable sessions by reasoning effort when set.
  - Update focused unit tests, README, example config, affected setup/profile skill docs, and AGENTS if session architecture docs change.
- Excluded:
  - Inventing model-name suffix aliases such as `gpt-5.5:xhigh` or `gpt-5.5-xhigh`.
  - Hard-coding per-model effort support matrices.
  - Adding a separate GPT-5.6 `reasoningMode` unless it falls out naturally and stays narrow.
  - Full CLI ergonomics such as `talonctl add-persona --reasoning-effort` unless implementation cost is minimal and does not broaden the micro-wave.

## Non-Scope

- No WDD epic artifacts, shared-context resources, final PR artifact, or multi-wave planning for this work packet.
- No runtime smoke test unless implementation touches daemon boot, CLI/IPC boot, provider process startup beyond unit-verifiable invocation construction, or config migration behavior that needs an end-to-end check.

## Relevant Context

- GitHub issue: `https://github.com/ivo-toby/talon/issues/253`.
- Config schema and types: `src/core/config/config-schema.ts`, `src/core/config/config-types.ts`.
- Persona loading and persistence: `src/personas/persona-loader.ts`, `src/core/database/repositories/persona-repository.ts`.
- Foreground runtime plumbing: `src/daemon/agent-runner.ts`, `src/providers/provider.ts`, `src/providers/provider-types.ts`.
- Background runtime plumbing: `src/tools/host-tools/background-agent.ts`, `src/subagents/background/background-agent-manager.ts`.
- Session identity and run persistence: `src/sandbox/session-tracker.ts`, `src/core/database/repositories/run-repository.ts`, `src/core/database/migrations/`.
- Codex CLI provider: `src/providers/codex-cli-provider.ts`.
- OpenAI-compatible provider: `src/providers/openai-compatible-provider.ts`, `src/providers/openai-compatible/agent-cli/index.ts`, `src/providers/openai-compatible/agent-cli/responses-api.ts`.
- Tests: `tests/unit/core/config/config-schema.test.ts`, `tests/unit/personas/persona-loader.test.ts`, `tests/unit/core/database/repositories/run-repository.test.ts`, `tests/unit/sandbox/session-tracker.test.ts`, `tests/unit/daemon/agent-runner.test.ts`, `tests/unit/providers/codex-cli-provider.test.ts`, `tests/unit/providers/openai-compatible-provider.test.ts`, `tests/unit/providers/openai-compatible-responses-api.test.ts`.
- Docs and examples: `README.md`, `config/talond.example.yaml`, `.agents/skills/create-profile/SKILL.md`, `AGENTS.md`.

## Parallelization Notes

Use bundled execution. The work splits into five logical tasks, but shared contracts (`PersonaConfig`, provider inputs, `AgentRunner`, session lookup) are upstream dependencies for provider-specific and docs work. Parallel task branches would likely conflict in the same files and slow reconciliation.

## Validation Strategy

- Run focused unit tests for config schema, persona loading, session tracking/run repository, agent-runner session and provider input behavior, Codex CLI provider, and OpenAI-compatible Responses behavior.
- Run `npm run build` after code changes.
- Run `npm run lint` when practical; CI treats lint as advisory.
- Run `git diff --check` before final handoff.
- Do not run full `npm test` unless the implementation broadens beyond the planned files or the user requests it.

## Definition of Done

- [ ] Scope is complete.
- [ ] Focused verification evidence is recorded.
- [ ] Required review, if any, is complete.
- [ ] Documentation and examples match behavior.
- [ ] Final handoff is ready.

## Open Questions

- Should unsupported providers fail config validation, fail at runtime, or ignore with a warning? Planned default: supported providers consume the field; unsupported providers do not receive it, with deterministic documentation and any clean warning/error that does not overcouple schema validation to provider definitions.
- Should `talonctl add-persona` gain a flag in this micro-wave? Planned default: leave CLI flag support out unless it is very small after config/runtime support lands.

## Finish Notes

- Planned task inventory:
  - `TASK-001-config-runtime-contract`
  - `TASK-002-session-effort-identity`
  - `TASK-003-codex-cli-effort`
  - `TASK-004-openai-compatible-effort`
  - `TASK-005-docs-examples`
