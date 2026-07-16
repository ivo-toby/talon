---
id: TASK-010-behavior-ledger-persistence
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-005-behavior-learning
wave: WAVE-005
slug: behavior-ledger-persistence
title: Add persona-scoped behavior evidence and promotion persistence
status: todo
depends_on: ["TASK-002-lifecycle-event-persistence"]
conflict_domains:
  - "src/core/database/migrations/**"
  - "src/core/database/repositories/index.ts"
  - "src/lifecycle/behavior/types.ts"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-010-behavior-ledger-persistence
worker_worktree: null
worktree_status: unassigned
pr: null
current_gate: not_started
branch_freshness: unknown
verification:
  - "npx vitest run tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/core/database/migrations/runner.test.ts"
  - "npm run build"
  - "git diff --check"
---

# TASK-010-behavior-ledger-persistence: Add persona-scoped behavior evidence and promotion persistence

## Status

todo

## Parent Ticket

TICKET-005-behavior-learning

## Wave

WAVE-005

## Objective

Add dedicated behavior signal/evidence/evaluation/promotion/activation/rollback storage with provenance, evidence fingerprints, persona scope, and guarded transitions.

## Scope

- Add behavior ledger migration after lifecycle events.
- Store kinds, statuses, confidence, source IDs, fingerprints, dates, and lineage.
- Add persona-scoped transactional repositories.
- Test copy suppression, distinct-source counting, transitions, isolation, and rollback lineage.

## Non-Scope

No detector/reducer prompts, projection, prompt writes, or UI.

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

- src/core/database/migrations/015-behavior-signals.sql
- src/core/database/repositories/behavior-signal-repository.ts
- src/core/database/repositories/prompt-improvement-repository.ts
- src/core/database/repositories/index.ts
- src/lifecycle/behavior/types.ts
- tests/unit/core/database/repositories/behavior-signal-repository.test.ts

## Dependencies

- TASK-002-lifecycle-event-persistence

## Conflict Domains

- src/core/database/migrations/**
- src/core/database/repositories/index.ts
- src/lifecycle/behavior/types.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-010-behavior-ledger-persistence

## Worker Worktree

None assigned. The controller must create or verify an isolated worktree before dispatch and provide its path.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing SQLite tests for persona isolation, fingerprint uniqueness, copy suppression, distinct evidence, legal transitions, evaluation/activation/rollback, expiry, and reopen.

### GREEN

Implement migration and typed transactional repositories.

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

- npx vitest run tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/core/database/migrations/runner.test.ts
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
