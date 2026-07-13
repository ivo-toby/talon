---
id: TASK-002-session-effort-identity
kind: micro_task
work: WORK-reasoning-effort-config
slug: session-effort-identity
title: Session Identity Includes Effort
status: review
depends_on:
  - TASK-001-config-runtime-contract
conflict_domains:
  - src/sandbox/session-tracker.ts
  - src/core/database/migrations/**
  - src/core/database/repositories/run-repository.ts
  - src/daemon/agent-runner.ts
  - tests/unit/sandbox/session-tracker.test.ts
  - tests/unit/core/database/repositories/run-repository.test.ts
  - tests/unit/daemon/agent-runner.test.ts
risk: medium
review_required: true
branch: work/WORK-reasoning-effort-config-bundle
worker_worktree: /home/ivo/workspace/talon/.worktrees/work-reasoning-effort-config-bundle
current_gate: ready_for_finish
verification:
  - npx vitest run tests/unit/sandbox/session-tracker.test.ts tests/unit/core/database/repositories/run-repository.test.ts tests/unit/daemon/agent-runner.test.ts
---

# TASK-002-session-effort-identity: Session Identity Includes Effort

## Objective

Prevent resumable providers from reusing a session created with a different persona reasoning effort.

## Scope

- Included:
  - Extend in-memory session tracking keys to include reasoning effort when set.
  - Persist enough run metadata to restore sessions by thread, provider, model, and reasoning effort after restart.
  - Add or update a SQL migration for the run metadata/index.
  - Update `RunRepository` insert and latest-session lookup options.
  - Update `AgentRunner` session restore, run insert, and session save paths.
  - Add focused tests proving different efforts do not share sessions and omitted effort preserves existing behavior.
- Excluded:
  - Changing session identity for non-resumable providers.
  - A broad migration rewrite beyond adding the new nullable run metadata.

## Context To Read

- `src/sandbox/session-tracker.ts`
- `src/core/database/repositories/run-repository.ts`
- `src/core/database/migrations/012-run-model-name.sql`
- `src/daemon/agent-runner.ts`
- `tests/unit/sandbox/session-tracker.test.ts`
- `tests/unit/core/database/repositories/run-repository.test.ts`
- `tests/unit/daemon/agent-runner.test.ts`

## Likely Files

- `src/sandbox/session-tracker.ts`
- `src/core/database/repositories/run-repository.ts`
- `src/core/database/migrations/013-run-reasoning-effort.sql`
- `src/daemon/agent-runner.ts`
- `tests/unit/sandbox/session-tracker.test.ts`
- `tests/unit/core/database/repositories/run-repository.test.ts`
- `tests/unit/daemon/agent-runner.test.ts`

## Dependencies

- `TASK-001-config-runtime-contract`

## Conflict Domains

- `src/daemon/agent-runner.ts`
- `src/core/database/repositories/run-repository.ts`
- `src/core/database/migrations/**`
- `src/sandbox/session-tracker.ts`

## Validation

- `npx vitest run tests/unit/sandbox/session-tracker.test.ts tests/unit/core/database/repositories/run-repository.test.ts tests/unit/daemon/agent-runner.test.ts`

## Done

- [x] Session tracker separates sessions by effort when effort is present.
- [x] Run repository can store and query latest session by effort.
- [x] Agent runner uses effort in DB restore and in-memory session save/lookup.
- [x] Existing no-effort session behavior remains covered.
- [x] Focused tests record evidence.

## Evidence

- Worker dispatched to `/home/ivo/workspace/talon/.worktrees/work-reasoning-effort-config-bundle` on branch `work/WORK-reasoning-effort-config-bundle`.
- RED: `npx vitest run tests/unit/core/config/config-schema.test.ts tests/unit/personas/persona-loader.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/sandbox/session-tracker.test.ts tests/unit/core/database/repositories/run-repository.test.ts tests/unit/tools/background-agent.test.ts tests/unit/subagents/background/background-agent-manager.test.ts tests/unit/providers/codex-cli-provider.test.ts tests/unit/providers/openai-compatible-provider.test.ts tests/unit/providers/openai-compatible-responses-api.test.ts` exited 1 before implementation; session tracker, run repository, and AgentRunner checks failed because effort was not part of the session identity or persisted run metadata.
- Environment: `npm run rebuild:sqlite` in the worktree failed because this worktree has no full `node_modules`; `npm --prefix /home/ivo/workspace/talon run rebuild:sqlite` exited 0 and rebuilt `better-sqlite3` for Node ABI 137.
- GREEN: `npx vitest run tests/unit/sandbox/session-tracker.test.ts tests/unit/core/database/repositories/run-repository.test.ts tests/unit/daemon/agent-runner.test.ts` exited 0: 3 files, 154 tests passed.
- REVIEW P2 FIX RED: `npx vitest run tests/unit/daemon/agent-runner.test.ts -t "does not restore an explicit-effort DB session when persona omits reasoningEffort"` exited 1; no-effort persona resumed `explicit-effort-session` because DB lookup omitted `reasoningEffort: null`.
- REVIEW P2 FIX GREEN: `npx vitest run tests/unit/sandbox/session-tracker.test.ts tests/unit/core/database/repositories/run-repository.test.ts tests/unit/daemon/agent-runner.test.ts` exited 0: 3 files, 155 tests passed.
