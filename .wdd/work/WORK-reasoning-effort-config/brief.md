---
id: WORK-reasoning-effort-config
kind: work_packet
profile: micro
slug: reasoning-effort-config
title: Per-Persona Reasoning Effort Configuration
status: done
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

- [x] Scope is complete.
- [x] Focused verification evidence is recorded.
- [x] Required review, if any, is complete.
- [x] Documentation and examples match behavior.
- [x] Final handoff is ready.

## Open Questions

- Resolved: supported providers consume `reasoningEffort`; OpenAI-compatible chat-completions mode now fails deterministically when persona effort is configured; docs describe provider behavior.
- Closed out of scope: `talonctl add-persona --reasoning-effort` was not added in this micro-wave.

## Finish Notes

- Result: merge-ready on branch `work/WORK-reasoning-effort-config-bundle`.
- Commit: `6be941ce9e15d01ed0123398bc8e0ff17c9f3042`.
- Scope completed: persona `reasoningEffort` config parsing, foreground and background provider propagation, Codex CLI config rendering, OpenAI-compatible Responses payload merge, deterministic chat-completions handling, and session identity/run persistence by effort.
- Documentation completed: `README.md`, `config/talond.example.yaml`, `.agents/skills/create-profile/SKILL.md`, and `AGENTS.md`.
- Review: initial GPT-5.4 review found two P2 blockers; both were fixed with focused RED/GREEN tests. Follow-up GPT-5.4 review found no P1/P2/P3 issues.
- Verification evidence: focused Vitest slices passed for config/persona/agent-runner (214 tests), session/run-repository/agent-runner after review fix (155 tests), background-agent paths (79 tests), Codex CLI provider (25 tests), and OpenAI-compatible provider/Responses after review fix (36 tests). Final committed-branch rerun: `npm run build` exited 0 and the combined focused Vitest command passed 10 files / 420 tests. `git diff --check` exited 0. Full `npm run lint` remains blocked by existing unrelated repo lint debt; patch-local source lint passed with 3 existing explicit-return warnings in `background-agent-manager.ts`.
- Cleanup: worker worktree cleanup is deferred because `/home/ivo/workspace/talon/.worktrees/work-reasoning-effort-config-bundle` contains unpushed local commit `6be941c` and an untracked copied WDD work packet. Keep it until the branch is pushed/merged or otherwise accepted, then remove the worktree and prune stale entries.
