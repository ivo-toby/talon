---
id: TASK-009-context-contracts-projector
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-004-context-migration
wave: WAVE-005
slug: context-contracts-projector
title: Add context observer/reducer contracts and native projector
status: done
depends_on: ["TASK-004-subagent-lifecycle-adapter", "TASK-005-transactional-event-bus"]
conflict_domains:
  - "src/lifecycle/context/**"
  - "src/daemon/context-roller.ts"
  - "src/core/database/repositories/memory-repository.ts"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-009-context-contracts-projector
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-005-context-contracts-projector
worktree_status: cleaned_up
pr: https://github.com/ivo-toby/talon/pull/266
current_gate: merged
branch_freshness: merged_current_at_3c1b5f4
verification:
  - "npx vitest run tests/unit/lifecycle/context tests/unit/daemon/context-roller.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-009-context-contracts-projector: Add context observer/reducer contracts and native projector

## Status

done

## Parent Ticket

TICKET-004-context-migration

## Wave

WAVE-005

## Objective

Define talon.context.observer.v1 and reducer.v1 plus an idempotent native projector preserving observation, memory, pre-roll, reduction, continuation, boundary, and session invariants.

## Scope

- Add strict context input/output contracts.
- Extract native observation/memory/pre-roll/rotation projection.
- Preserve reducer atomic replacement and continuation metadata.
- Make replay idempotent and emit correlated results.
- Port existing behavior tests while leaving legacy orchestration callable.

## Non-Scope

No name-check removal, config translation, or prompt changes.

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

- src/lifecycle/context/**
- src/daemon/context-roller.ts
- src/core/database/repositories/memory-repository.ts
- tests/unit/lifecycle/context/**
- tests/unit/daemon/context-roller.test.ts

## Dependencies

- TASK-004-subagent-lifecycle-adapter
- TASK-005-transactional-event-bus

## Conflict Domains

- src/lifecycle/context/**
- src/daemon/context-roller.ts
- src/core/database/repositories/memory-repository.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-009-context-contracts-projector

## Worker Worktree

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-005-context-contracts-projector

## PR / Patch Reference

PR #266: https://github.com/ivo-toby/talon/pull/266

Merged into `epic/durable-lifecycle-pipeline` at
`3c1b5f4b0bea23ff08b6b591e6c5871ab6ec3377` on 2026-07-25.

## RED-GREEN TDD Plan

### RED

Failing tests for schema validation, projection, schedule/direct provenance, continuation, boundaries, reducer atomicity, rollback, and replay.

### GREEN

Extract proven ContextRoller invariants into typed native policy/projector modules.

### REFACTOR

Refactor only the new/touched boundary after green; do not broaden scope or change unrelated abstractions.

## Implementation Notes

- Start in the assigned task worktree and confirm this task plus current orchestration state exist.
- Do not switch branches in the controller checkout or start dependent work.
- Preserve unrelated user changes and use typed neverthrow results across module boundaries.
- Audit side effects and keep durable payloads bounded and secret-free.
- Request reviewGate/`gpt-5.5` review with xhigh reasoning before commit; resolve all P1/P2 or Critical/High/Medium findings. Never use GPT-5.6.

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
- [x] Shared-context findings are proposed when needed.

## Validation Steps

- npx vitest run tests/unit/lifecycle/context tests/unit/daemon/context-roller.test.ts
- npm run build
- npm run lint
- git diff --check

## Verification Evidence

- Focused tests passed: `npx vitest run tests/unit/lifecycle/context
  tests/unit/daemon/context-roller.test.ts` (65 tests).
- `npm run build` passed during remediation.
- Scoped ESLint passed for `src/lifecycle/context/context-contracts.ts`,
  `src/lifecycle/context/context-projector.ts`, `src/lifecycle/context/index.ts`,
  and `src/daemon/context-roller.ts`.
- `git diff --check` passed.
- GitHub Verify PR and PR Agent passed on PR #266.

## Review Feedback

### P1

- None.

### P2

- None.

### P3

- Fresh GPT-5.5/xhigh review passed with 0 Critical/High/Medium and one
  non-blocking P3 tombstone-visibility follow-up intentionally left untouched.

## Completion Notes

- Added strict context observer/reducer contracts under `src/lifecycle/context`.
- Extracted native context projection for observations, named memory updates,
  pre-roll tails, reductions, and continuation metadata.
- Preserved replay/idempotency invariants for append-mode named memory and
  reduced observation replays.
- Clean task worktree was removed and pruned during WAVE-005 reconciliation.
