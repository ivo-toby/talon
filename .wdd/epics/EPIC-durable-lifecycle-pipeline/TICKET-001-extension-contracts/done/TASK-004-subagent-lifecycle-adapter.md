---
id: TASK-004-subagent-lifecycle-adapter
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-001-extension-contracts
wave: WAVE-002
slug: subagent-lifecycle-adapter
title: Implement the capability-scoped sub-agent lifecycle adapter
status: done
depends_on: ["TASK-001-lifecycle-contracts-registry"]
conflict_domains:
  - "src/lifecycle/adapters/**"
  - "src/subagents/subagent-runner.ts"
  - "src/personas/**"
assigned_model_class: codexHigh
actual_model: gpt-5.6-terra
reasoning_effort: high
review_model_class: reviewGate
branch: task/TASK-004-subagent-lifecycle-adapter
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-002-subagent-lifecycle-adapter
worktree_status: cleaned_up
worker_thread_id: 019f6980-1903-7a92-a6e2-f05da2b97570
review_thread_id: 019f6985-1b98-7912-bab6-5f96c60fca3c
pr: https://github.com/ivo-toby/talon/pull/259
current_gate: merged
branch_freshness: merged_current_at_54dc872
verification:
  - "npx vitest run tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts tests/unit/subagents/subagent-runner.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-004-subagent-lifecycle-adapter: Implement the capability-scoped sub-agent lifecycle adapter

## Status

done

## Parent Ticket

TICKET-001-extension-contracts

## Wave

WAVE-002

## Objective

Invoke only configured sub-agents with fenced untrusted input, persona/capability scope, timeout/token/model bounds, named output contracts, and typed signals/errors.

## Scope

- Reuse loader, runner, model resolver, and failover paths.
- Fence event/message/tool/trace material as untrusted data.
- Enforce explicit attachment, scope, budgets, schema validation, and correlation.
- Return proposals only; expose no repositories.

## Non-Scope

No default behavior/context prompts, projection, dispatch, or trace fetching.

## Relevant Context

### Local Context

- Inspect the likely files and their focused tests before broad discovery.
- Follow the epic architecture and design decisions; preserve existing disabled and legacy behavior.
- Treat untrusted content, capability scope, idempotency, ordering, audit, and privacy as explicit review concerns.

### Shared Context References

- ../../shared-context/index.md
- ../../shared-context/resources/architecture.md
- ../../shared-context/resources/design-decisions.md
- ../../shared-context/resources/testing-strategy.md
- ../../shared-context/resources/task-findings.md

## Likely Files / Areas

- src/lifecycle/adapters/subagent-lifecycle-adapter.ts
- src/lifecycle/adapters/prompt-fencing.ts
- src/subagents/subagent-runner.ts
- src/personas/**
- tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts

## Dependencies

- TASK-001-lifecycle-contracts-registry

## Conflict Domains

- src/lifecycle/adapters/**
- src/subagents/subagent-runner.ts
- src/personas/**

## Assigned Model Class

codexHigh

## Branch

task/TASK-004-subagent-lifecycle-adapter

## Worker Worktree

The clean worktree at
`/Users/ivo.toby/workspace/talon/.worktrees/WAVE-002-subagent-lifecycle-adapter`
was removed and pruned after PR #259 merged.

## PR / Patch Reference

PR #259 targeted `epic/durable-lifecycle-pipeline`, used final task head
`02a0968`, and merged at final WAVE-002 epic head `54dc872`.

## RED-GREEN TDD Plan

### RED

Failing tests for explicit attachment, cross-persona/capability denial, prompt fencing, timeout/token limits, schema rejection, failover, and correlation.

### GREEN

Implement a thin adapter over existing sub-agent execution.

### REFACTOR

Refactor only the new/touched boundary after green; do not broaden scope or change unrelated abstractions.

## Implementation Notes

- Start in the assigned task worktree and confirm this task plus current orchestration state exist.
- Do not switch branches in the controller checkout or start dependent work.
- Preserve unrelated user changes and use typed neverthrow results across module boundaries.
- Audit side effects and keep durable payloads bounded and secret-free.
- Request reviewGate/`gpt-5.6-sol` review with high reasoning before commit; resolve all P1/P2 or Critical/High/Medium findings.

## Review Focus

- Correctness and regressions at the listed conflict domains.
- Security/scope/privacy/idempotency/ordering/failure semantics relevant to the task.
- RED/GREEN evidence and contract/config/documentation drift.

## Durable Memory Notes To Consider

- Propose only stable decisions, root causes, constraints, or verified outcomes for task-findings.md.

## Task-Level Definition of Done

- [x] Objective and scoped behavior are complete.
- [x] Focused RED/GREEN, build/lint, and listed validation evidence are recorded.
- [x] Required review has no unresolved P1/P2 findings.
- [x] PR targets the epic branch and freshness is checked.
- [x] Shared-context findings are reconciled.

## Validation Steps

- npx vitest run tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts tests/unit/subagents/subagent-runner.test.ts
- npm run build
- npm run lint
- git diff --check

## Verification Evidence

- Pre-review Terra/high remediation passed 104 focused tests, build,
  changed-source ESLint, touched-file Prettier, and `git diff --check`.
- Focused Sol/high delta review passed 0C/0H/0M/1L with 89 focused tests and
  exact pre/post worktree status. Its writable-review prompt explicitly forbade
  source, test, and WDD edits plus dependency installation. The Low remained
  untouched and non-blocking.
- Full task review `019f696b-318e-7950-ac94-f9962029f856` passed 0C/0H/0M/1L
  with 163 focused tests and all static gates. First refresh review
  `019f6973-8253-7e10-8a30-31c78f1e662f` also passed 0C/0H/0M/1L.
- After TASK-002 merged, integration review
  `019f697a-ab6b-70f0-b10d-222a9dea4324` found one Medium contract/persistence
  domain mismatch. Terra/high session `019f6980-1903-7a92-a6e2-f05da2b97570`
  aligned NUL/malformed-Unicode event strings and enabled persona-owner bounds
  before persistence while preserving omitted/disabled legacy compatibility.
- Final combined review `019f6985-1b98-7912-bab6-5f96c60fca3c` passed
  0C/0H/0M with no new Low after 339 focused tests, TypeScript, scoped ESLint,
  Prettier, diff, and status/hash integrity checks. GitHub Verify PR run
  `29475897009` passed; PR #259 had no review threads and merged at `54dc872`.

## Review Feedback

### P1

- None.

### P2

- Resolved Medium: boundary cloning permitted `__proto__` prototype mutation
  and inherited lifecycle fields.
- Resolved Medium: invocation did not enforce exact configured
  event/signal/hook subscription membership.
- Resolved Medium: persona aggregates bypassed explicit non-thread aggregate
  scope.
- Resolved Medium: lifecycle contract-valid NUL/malformed-Unicode event data
  and oversized lifecycle-enabled persona owners could fail only after reaching
  persistence; contract and durable domains now agree.

### P3

- Low: failover logging can claim a next attempt after the global deadline is
  exhausted. Non-blocking follow-up; not automatically fixed.

## Completion Notes

- Lifecycle sub-agents are explicitly attached, advisory-only, capability-
  scoped, repository-free, fenced from untrusted input, bounded by timeout/
  token/model attempts, and validated against named output contracts.
- Adapter and runner boundaries require exact loader-owned identity and safety
  tuples, preserve causal event context, and never infer approval.
- The known final-attempt failover-log wording Low is recorded for follow-up and
  was intentionally not remediated under the acceleration policy.
