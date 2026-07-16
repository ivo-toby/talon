---
id: TASK-005-transactional-event-bus
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-002-durable-event-runtime
wave: WAVE-003
slug: transactional-event-bus
title: Implement transactional lifecycle event publication
status: done
depends_on: ["TASK-001-lifecycle-contracts-registry", "TASK-002-lifecycle-event-persistence"]
conflict_domains:
  - "src/lifecycle/lifecycle-event-bus.ts"
  - "src/lifecycle/transaction-context.ts"
  - "src/core/database/**"
assigned_model_class: codexHigh
actual_model: gpt-5.6-terra
reasoning_effort: high
review_model_class: reviewGate
branch: task/TASK-005-transactional-event-bus
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-003-transactional-event-bus
worktree_status: cleaned_up
worker_thread_id: 019f69eb-a64d-7612-9084-7918ade4525f
review_thread_id: 019f6a04-bb9c-7aa0-89f2-c3413c2f30c2
pr: https://github.com/ivo-toby/talon/pull/261
current_gate: merged
branch_freshness: merged_current_at_d3357fb
verification:
  - "/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin/node ../../node_modules/vitest/vitest.mjs run tests/unit/lifecycle/lifecycle-event-bus.test.ts tests/unit/core/database/repositories/lifecycle-event-repository.test.ts"
  - "npm run build"
  - "git diff --check"
---

# TASK-005-transactional-event-bus: Implement transactional lifecycle event publication

## Status

done

## Parent Ticket

TICKET-002-durable-event-runtime

## Wave

WAVE-003

## Objective

Implement validated versioned publication, atomic subscriber delivery fan-out, correlation/causation/depth propagation, and after-commit wake behavior.

## Scope

- Support standalone and bus-owned transaction-callback publication.
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

Terra/high integration owner `019f69eb-a64d-7612-9084-7918ade4525f`
completed reviewed commit `65bd0a7` on
`task/TASK-005-transactional-event-bus`. PR #261 merged at epic commit
`d3357fb`; the clean task worktree was removed and pruned.

## PR / Patch Reference

[PR #261](https://github.com/ivo-toby/talon/pull/261) merged reviewed commit
`65bd0a7bc4037ab4e634e25e8ee34886f5c9c338` into
`epic/durable-lifecycle-pipeline` at `d3357fb674ab3549769fa6e0a3a306c19925c31b`.

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

- [x] Objective and scoped behavior are complete.
- [x] Focused RED/GREEN, build/lint, and listed validation evidence are recorded.
- [x] Required review has no unresolved P1/P2 findings.
- [x] PR targets the epic branch and freshness is checked.
- [x] Shared-context findings are proposed when needed.

## Validation Steps

- npx vitest run tests/unit/lifecycle/lifecycle-event-bus.test.ts tests/unit/core/database/repositories/lifecycle-event-repository.test.ts
- npm run build
- git diff --check

## Verification Evidence

- 43/43 focused tests passed with the repository-pinned Node 24 runtime,
  including 26 real-SQLite repository tests.
- `npm run build` passed.
- Scoped ESLint and Prettier checks passed on changed source and test files.
- `git diff --check` passed.
- No dependency install or native rebuild was performed.

## Review Feedback

### P1

- High: the first transaction-coordinator finding is reviewed resolved. Fresh
  Sol/high review reproduced forgeable cross-bus/cross-connection authority via
  overridable public context methods; opaque exact-bus/exact-connection
  authority is implemented and reviewed resolved.

### P2

- Medium: caller-owned publication could throw across a neverthrow boundary.
- Medium: rejected asynchronous wakes could escape as unhandled rejections.
- Medium: derived-event causation and recursion invariants were not enforced.

The original three Medium findings are reviewed resolved. Fresh Sol/high review
found one new Medium: nested SQLite transactions could wake before the outer
commit. Nested/external active transactions are rejected and reviewed resolved.

### P3

- Low: the test fixture has standalone strict-TypeScript drift in four helper
  shapes. It is non-blocking and intentionally untouched under the WDD policy.

## Completion Notes

- Initial Sol/high review `019f69e5-5c3d-7151-9ca8-c1d04d787e2d` failed
  0C/1H/3M/0L. Terra/high integration owner
  `019f69eb-a64d-7612-9084-7918ade4525f` completed the blocking remediation
  with 37 focused tests. Fresh full-diff Sol/high review
  `019f69f7-de0f-7d91-a71a-127ab60c892f` failed 0C/1H/1M/0L after reproducing
  forgeable cross-connection transaction authority and pre-outer-commit nested
  wakes. The same Terra/high owner remediated both blockers; controller
  verification passed 43 focused tests plus build and static gates. Fresh
  full-diff Sol/high review `019f6a04-bb9c-7aa0-89f2-c3413c2f30c2` passed
  0C/0H/0M/1L with exact hash integrity. The Low remains untouched. Reviewed
  commit `65bd0a7` is pushed and PR #261 targets the current epic head; GitHub
  checks passed with no review threads. PR #261 merged into the epic branch at
  `d3357fb`.
