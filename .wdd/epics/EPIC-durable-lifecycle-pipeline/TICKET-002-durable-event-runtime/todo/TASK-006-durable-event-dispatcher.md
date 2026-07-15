---
id: TASK-006-durable-event-dispatcher
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-002-durable-event-runtime
wave: WAVE-003
slug: durable-event-dispatcher
title: Implement the durable lifecycle dispatcher
status: todo
depends_on: ["TASK-001-lifecycle-contracts-registry", "TASK-002-lifecycle-event-persistence", "TASK-003-interceptor-engine", "TASK-004-subagent-lifecycle-adapter"]
conflict_domains:
  - "src/lifecycle/lifecycle-dispatcher.ts"
  - "src/lifecycle/handler-executor.ts"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-006-durable-event-dispatcher
worker_worktree: null
worktree_status: unassigned
pr: null
current_gate: not_started
branch_freshness: unknown
verification:
  - "npx vitest run tests/unit/lifecycle/lifecycle-dispatcher.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-006-durable-event-dispatcher: Implement the durable lifecycle dispatcher

## Status

todo

## Parent Ticket

TICKET-002-durable-event-runtime

## Wave

WAVE-003

## Objective

Implement independent at-least-once delivery with leases, per-aggregate ordering, bounded concurrency, retry/dead-letter, idempotency, backpressure, circuit state, and restart-safe shutdown.

## Scope

- Claim and recover eligible deliveries.
- Execute captured native/sub-agent handlers.
- Enforce ordering plus global/per-handler concurrency.
- Apply retry, dead-letter, circuit, backpressure, and idempotent completion.
- Expose a bounded dispatcher state snapshot.

## Non-Scope

No daemon bootstrap, CLI, retention, or user-queue coupling.

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

- src/lifecycle/lifecycle-dispatcher.ts
- src/lifecycle/dispatcher-policy.ts
- src/lifecycle/handler-executor.ts
- tests/unit/lifecycle/lifecycle-dispatcher.test.ts

## Dependencies

- TASK-001-lifecycle-contracts-registry
- TASK-002-lifecycle-event-persistence
- TASK-003-interceptor-engine
- TASK-004-subagent-lifecycle-adapter

## Conflict Domains

- src/lifecycle/lifecycle-dispatcher.ts
- src/lifecycle/handler-executor.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-006-durable-event-dispatcher

## Worker Worktree

None assigned. The controller must create or verify an isolated worktree before dispatch and provide its path.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing tests for leases, ordering, concurrency, retry/dead-letter, one-handler isolation, backpressure/circuit, idempotency, shutdown, and restart.

### GREEN

Implement a poll/wake dispatcher with injected repositories, executors, and policy.

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

- npx vitest run tests/unit/lifecycle/lifecycle-dispatcher.test.ts
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
