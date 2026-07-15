---
id: TASK-009-context-contracts-projector
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-004-context-migration
wave: WAVE-005
slug: context-contracts-projector
title: Add context observer/reducer contracts and native projector
status: todo
depends_on: ["TASK-004-subagent-lifecycle-adapter", "TASK-005-transactional-event-bus"]
conflict_domains:
  - "src/lifecycle/context/**"
  - "src/daemon/context-roller.ts"
  - "src/core/database/repositories/memory-repository.ts"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-009-context-contracts-projector
worker_worktree: null
worktree_status: unassigned
pr: null
current_gate: not_started
branch_freshness: unknown
verification:
  - "npx vitest run tests/unit/lifecycle/context tests/unit/daemon/context-roller.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-009-context-contracts-projector: Add context observer/reducer contracts and native projector

## Status

todo

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

None assigned. The controller must create or verify an isolated worktree before dispatch and provide its path.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

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
- Request reviewGate/GPT-5.4 review before commit; resolve all P1/P2 or Critical/High/Medium findings.

## Review Focus

- Correctness and regressions at the listed conflict domains.
- Security/scope/privacy/idempotency/ordering/failure semantics relevant to the task.
- RED/GREEN evidence and contract/config/documentation drift.

## Durable Memory Notes To Consider

- Propose only stable decisions, root causes, constraints, or verified outcomes for task-findings.md.

## Task-Level Definition of Done

- [ ] Objective and scoped behavior are complete.
- [ ] Focused RED/GREEN, build/lint, and listed validation evidence are recorded.
- [ ] Required review has no unresolved P1/P2 findings.
- [ ] PR targets the epic branch and freshness is checked.
- [ ] Shared-context findings are proposed when needed.

## Validation Steps

- npx vitest run tests/unit/lifecycle/context tests/unit/daemon/context-roller.test.ts
- npm run build
- npm run lint
- git diff --check

## Verification Evidence

- Not run yet.

## Review Feedback

### P1

- None.

### P2

- None.

### P3

- None.

## Completion Notes

- None yet.

