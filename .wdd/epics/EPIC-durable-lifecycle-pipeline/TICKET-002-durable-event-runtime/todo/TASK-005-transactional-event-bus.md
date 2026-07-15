---
id: TASK-005-transactional-event-bus
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-002-durable-event-runtime
wave: WAVE-003
slug: transactional-event-bus
title: Implement transactional lifecycle event publication
status: todo
depends_on: ["TASK-001-lifecycle-contracts-registry", "TASK-002-lifecycle-event-persistence"]
conflict_domains:
  - "src/lifecycle/lifecycle-event-bus.ts"
  - "src/lifecycle/transaction-context.ts"
  - "src/core/database/**"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-005-transactional-event-bus
worker_worktree: null
worktree_status: unassigned
pr: null
current_gate: not_started
branch_freshness: unknown
verification:
  - "npx vitest run tests/unit/lifecycle/lifecycle-event-bus.test.ts tests/unit/core/database/repositories/lifecycle-event-repository.test.ts"
  - "npm run build"
  - "git diff --check"
---

# TASK-005-transactional-event-bus: Implement transactional lifecycle event publication

## Status

todo

## Parent Ticket

TICKET-002-durable-event-runtime

## Wave

WAVE-003

## Objective

Implement validated versioned publication, atomic subscriber delivery fan-out, correlation/causation/depth propagation, and after-commit wake behavior.

## Scope

- Support standalone and caller-owned transaction publication.
- Validate bounded payload/reference metadata and recursion depth.
- Snapshot stable subscribers and create delivery rows.
- Wake dispatch only after successful commit.

## Non-Scope

No dispatcher polling or concrete daemon boundary wiring.

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

- src/lifecycle/lifecycle-event-bus.ts
- src/lifecycle/transaction-context.ts
- src/core/database/**
- tests/unit/lifecycle/lifecycle-event-bus.test.ts

## Dependencies

- TASK-001-lifecycle-contracts-registry
- TASK-002-lifecycle-event-persistence

## Conflict Domains

- src/lifecycle/lifecycle-event-bus.ts
- src/lifecycle/transaction-context.ts
- src/core/database/**

## Assigned Model Class

codexHigh

## Branch

task/TASK-005-transactional-event-bus

## Worker Worktree

None assigned. The controller must create or verify an isolated worktree before dispatch and provide its path.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing tests for domain-write atomicity, rollback, fan-out, wake timing, payload bounds, causation/depth, and no-subscriber behavior.

### GREEN

Implement the bus and smallest safe transaction context over lifecycle repositories.

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

- [ ] Objective and scoped behavior are complete.
- [ ] Focused RED/GREEN, build/lint, and listed validation evidence are recorded.
- [ ] Required review has no unresolved P1/P2 findings.
- [ ] PR targets the epic branch and freshness is checked.
- [ ] Shared-context findings are proposed when needed.

## Validation Steps

- npx vitest run tests/unit/lifecycle/lifecycle-event-bus.test.ts tests/unit/core/database/repositories/lifecycle-event-repository.test.ts
- npm run build
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
