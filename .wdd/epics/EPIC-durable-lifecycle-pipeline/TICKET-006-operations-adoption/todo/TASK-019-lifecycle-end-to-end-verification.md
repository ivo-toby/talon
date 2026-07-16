---
id: TASK-019-lifecycle-end-to-end-verification
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-006-operations-adoption
wave: WAVE-010
slug: lifecycle-end-to-end-verification
title: Add end-to-end lifecycle, restart, and security verification
status: todo
depends_on: ["TASK-018-governed-prompt-promotion"]
conflict_domains:
  - "tests/integration/**"
  - "tests/fixtures/**"
  - "src/lifecycle/** (defect fixes only)"
  - "src/daemon/** (defect fixes only)"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-019-lifecycle-end-to-end-verification
worker_worktree: null
worktree_status: unassigned
pr: null
current_gate: not_started
branch_freshness: unknown
verification:
  - "npx vitest run tests/integration/lifecycle-*.test.ts tests/integration/rolling-context-window.test.ts"
  - "npm run build"
  - "npm run lint"
  - "npm test (controller obtains explicit user approval before running the slow full suite)"
  - "$run-talon-smoke -- no-cost daemon and terminal round trip, then verify no listeners remain"
  - "git diff --check"
---

# TASK-019-lifecycle-end-to-end-verification: Add end-to-end lifecycle, restart, and security verification

## Status

todo

## Parent Ticket

TICKET-006-operations-adoption

## Wave

WAVE-010

## Objective

Prove inbound-to-outbound async analysis, context rotation, restart/replay, retention, isolation, interceptors, and governed behavior promotion across real SQLite and daemon boundaries.

## Scope

- Add black-box lifecycle and context integration scenarios.
- Explicitly prove threshold -> observer -> projector -> reducer -> rotation,
  including reducer atomic replacement and next-item/session ordering.
- Test restart/lease recovery, dead-letter, replay, reload, retention, privacy, and disablement.
- Test scope/capability isolation, prompt injection, schema rejection, secret redaction, timeouts, recursion, and side-effect dedup.
- Test migration from current schema and targeted runtime-smoke assertions.

## Non-Scope

No unrelated refactor, issue-70 implementation, or full suite without approval.

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

- tests/integration/lifecycle-*.test.ts
- tests/integration/rolling-context-window.test.ts
- tests/fixtures/**
- src/lifecycle/** (defect fixes only)
- src/daemon/** (defect fixes only)

## Dependencies

- TASK-018-governed-prompt-promotion

## Conflict Domains

- tests/integration/**
- tests/fixtures/**
- src/lifecycle/** (defect fixes only)
- src/daemon/** (defect fixes only)

## Assigned Model Class

codexHigh

## Branch

task/TASK-019-lifecycle-end-to-end-verification

## Worker Worktree

None assigned. The controller must create or verify an isolated worktree before dispatch and provide its path.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Add end-to-end scenarios first and demonstrate missing behavior against the reconciled branch.

### GREEN

Make only focused fixes exposed by the scenarios.

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

- [ ] Objective and scoped behavior are complete.
- [ ] Focused RED/GREEN, build/lint, and listed validation evidence are recorded.
- [ ] Required review has no unresolved P1/P2 findings.
- [ ] PR targets the epic branch and freshness is checked.
- [ ] Shared-context findings are proposed when needed.

## Validation Steps

- npx vitest run tests/integration/lifecycle-*.test.ts tests/integration/rolling-context-window.test.ts
- npm run build
- npm run lint
- npm test (controller obtains explicit user approval before running the slow full suite)
- $run-talon-smoke -- no-cost daemon and terminal round trip, then verify no listeners remain
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
