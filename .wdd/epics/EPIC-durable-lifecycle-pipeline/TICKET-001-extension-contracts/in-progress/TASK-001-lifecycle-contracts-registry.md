---
id: TASK-001-lifecycle-contracts-registry
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-001-extension-contracts
wave: WAVE-001
slug: lifecycle-contracts-registry
title: Define lifecycle contracts, configuration, and handler registry
status: in_progress
depends_on: []
conflict_domains:
  - "src/lifecycle/contracts/**"
  - "src/lifecycle/handler-registry.ts"
  - "src/core/config/config-schema.ts"
assigned_model_class: codexHigh
actual_model: gpt-5.4
feedback_fix_model: gpt-5.6-terra
feedback_fix_reasoning_effort: high
review_model_class: reviewGate
review_thread: 019f672f-5bfb-7872-a964-bcb2d0fabb78
feedback_fix_thread: 019f6736-a9cf-7b32-9da4-54cf0f18d08f
branch: task/TASK-001-lifecycle-contracts-registry
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-001-lifecycle-contracts-registry
worktree_status: active
pr: https://github.com/ivo-toby/talon/pull/257
current_gate: feedback_fix_in_progress
branch_freshness: behind_b77a620_by_one_controller_artifact_commit
verification:
  - "npx vitest run tests/unit/lifecycle/handler-registry.test.ts tests/unit/core/config/config-schema.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-001-lifecycle-contracts-registry: Define lifecycle contracts, configuration, and handler registry

## Status

in_progress

## Parent Ticket

TICKET-001-extension-contracts

## Wave

WAVE-001

## Objective

Create versioned event, signal, interceptor, handler, subscription, identity, filter, budget, and failure-policy contracts plus deterministic registry/config validation.

## Scope

- Add lifecycle contract and registry modules.
- Add global handler definitions and explicit persona attachment to config validation.
- Reject duplicate IDs, incompatible contracts, unsafe policies, invalid filters, and missing handlers.
- Preserve configs with lifecycle omitted.

## Non-Scope

No persistence, dispatch, boundary wiring, remote handlers, or arbitrary filter expressions.

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

- src/lifecycle/contracts/**
- src/lifecycle/handler-registry.ts
- src/core/config/config-schema.ts
- src/personas/persona-loader.ts
- tests/unit/lifecycle/handler-registry.test.ts

## Dependencies

- None.

## Conflict Domains

- src/lifecycle/contracts/**
- src/lifecycle/handler-registry.ts
- src/core/config/config-schema.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-001-lifecycle-contracts-registry

## Worker Worktree

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-001-lifecycle-contracts-registry (active on task/TASK-001-lifecycle-contracts-registry at implementation head d68929f; created from activation head e28d331 and currently one controller-artifact commit behind b77a620).

## PR / Patch Reference

Draft PR #257 targets epic/durable-lifecycle-pipeline: https://github.com/ivo-toby/talon/pull/257

## RED-GREEN TDD Plan

### RED

Failing registry/config tests for priority, identity, explicit attachment, compatibility, validation, and legacy config acceptance.

### GREEN

Implement the smallest typed schemas and deterministic registry resolution API.

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

- npx vitest run tests/unit/lifecycle/handler-registry.test.ts tests/unit/core/config/config-schema.test.ts
- npm run build
- npm run lint
- git diff --check

## Verification Evidence

- Before controller feedback: 104 focused tests passed, `npm run build` passed, `git diff --check` passed, and the GitHub Verify PR job passed.
- Repo-wide lint retained unrelated baseline failures; no lifecycle-file lint failures were reported.
- Feedback-fix verification and independent Sol/high re-review remain pending.

## Review Feedback

### P1

- High: complete the frozen runtime envelopes and typed result contracts required by downstream lifecycle tasks.

### P2

- Medium: support safe explicit fail-open and fail-closed semantics.
- Medium: reject unknown event contracts and unresolved implementation references by default.
- Medium: keep expected registry construction failures behind the public `Result` factory.

### P3

- Use portable equal-priority ordering and add focused signal/interceptor/override coverage.
- Documentation is intentionally deferred to TASK-020, the epic-owned documentation and adoption task.

## Completion Notes

Controller Sol/high review comment: https://github.com/ivo-toby/talon/pull/257#issuecomment-4984410897. Fresh Terra/high feedback-fix worker is active; the controller owns artifact reconciliation and merge.
