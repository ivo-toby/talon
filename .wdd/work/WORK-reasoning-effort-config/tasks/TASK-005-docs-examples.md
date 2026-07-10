---
id: TASK-005-docs-examples
kind: micro_task
work: WORK-reasoning-effort-config
slug: docs-examples
title: Documentation and Examples
status: done
depends_on:
  - TASK-001-config-runtime-contract
  - TASK-002-session-effort-identity
  - TASK-003-codex-cli-effort
  - TASK-004-openai-compatible-effort
conflict_domains:
  - README.md
  - config/talond.example.yaml
  - .agents/skills/create-profile/SKILL.md
  - AGENTS.md
risk: low
review_required: true
branch: work/WORK-reasoning-effort-config-bundle
worker_worktree: /home/ivo/workspace/talon/.worktrees/work-reasoning-effort-config-bundle
current_gate: merge_ready
verification:
  - git diff --check
---

# TASK-005-docs-examples: Documentation and Examples

## Objective

Document persona-level `reasoningEffort` so README, example config, setup/profile guidance, and architecture notes match the implemented behavior.

## Scope

- Included:
  - Update README persona config/provider sections with examples and supported values.
  - Update `config/talond.example.yaml` with Codex CLI and/or OpenAI-compatible persona examples.
  - Update `.agents/skills/create-profile/SKILL.md` so guided profile creation mentions the field for OpenAI/Codex models.
  - Update `AGENTS.md` if session identity or provider/session architecture documentation changes.
  - Explain unsupported provider behavior and the no model-name suffix rule.
- Excluded:
  - Broad copyediting unrelated to issue #253.
  - Full CLI command reference updates unless CLI flag support is implemented.

## Context To Read

- `README.md`
- `config/talond.example.yaml`
- `.agents/skills/create-profile/SKILL.md`
- `AGENTS.md`
- Final implementation diffs from tasks 1-4.

## Likely Files

- `README.md`
- `config/talond.example.yaml`
- `.agents/skills/create-profile/SKILL.md`
- `AGENTS.md`

## Dependencies

- `TASK-001-config-runtime-contract`
- `TASK-002-session-effort-identity`
- `TASK-003-codex-cli-effort`
- `TASK-004-openai-compatible-effort`

## Conflict Domains

- `README.md`
- `config/talond.example.yaml`
- `.agents/skills/create-profile/SKILL.md`
- `AGENTS.md`

## Validation

- `git diff --check`

## Done

- [x] README documents field, values, provider behavior, and examples.
- [x] Example config includes a realistic `reasoningEffort` persona example.
- [x] Profile creation skill guidance mentions the field.
- [x] AGENTS provider/session notes are updated if implementation changes them.
- [x] Whitespace sanity check records evidence.

## Evidence

- Worker dispatched to `/home/ivo/workspace/talon/.worktrees/work-reasoning-effort-config-bundle` on branch `work/WORK-reasoning-effort-config-bundle`.
- Docs updated: `README.md`, `config/talond.example.yaml`, `.agents/skills/create-profile/SKILL.md`, and `AGENTS.md`.
- GREEN: `npm run build` exited 0.
- GREEN_WITH_CONCERN: `npm run lint` exited 1 with existing unrelated repo lint debt: 130 problems (98 errors, 32 warnings). Patch-local source lint command `npx eslint src/core/config/config-schema.ts src/core/config/config-types.ts src/core/database/repositories/run-repository.ts src/daemon/agent-runner.ts src/providers/codex-cli-provider.ts src/providers/openai-compatible-provider.ts src/providers/openai-compatible/agent-cli/index.ts src/providers/openai-compatible/agent-cli/responses-api.ts src/providers/provider-types.ts src/providers/provider.ts src/sandbox/session-tracker.ts src/subagents/background/background-agent-manager.ts src/tools/host-tools/background-agent.ts` exited 0 with 3 explicit-return warnings in `background-agent-manager.ts`.
- GREEN: `git diff --check` exited 0 after WDD evidence updates.
- Final handoff: merge-ready commit `6be941ce9e15d01ed0123398bc8e0ff17c9f3042`.
