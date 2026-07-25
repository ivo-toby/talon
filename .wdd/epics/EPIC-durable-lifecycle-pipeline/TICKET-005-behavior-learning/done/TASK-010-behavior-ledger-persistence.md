---
id: TASK-010-behavior-ledger-persistence
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-005-behavior-learning
wave: WAVE-005
slug: behavior-ledger-persistence
title: Add persona-scoped behavior evidence and promotion persistence
status: done
depends_on: ["TASK-002-lifecycle-event-persistence"]
conflict_domains:
  - "src/core/database/migrations/**"
  - "src/core/database/repositories/index.ts"
  - "src/lifecycle/behavior/types.ts"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-010-behavior-ledger-persistence
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-005-behavior-ledger-persistence
worktree_status: cleaned_up
pr: https://github.com/ivo-toby/talon/pull/267
current_gate: merged
branch_freshness: merged_current_at_08c564a
verification:
  - "npx vitest run tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/core/database/migrations/runner.test.ts"
  - "npm run build"
  - "git diff --check"
---

# TASK-010-behavior-ledger-persistence: Add persona-scoped behavior evidence and promotion persistence

## Status

done

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

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-005-behavior-ledger-persistence

## PR / Patch Reference

PR #267: https://github.com/ivo-toby/talon/pull/267

Merged into `epic/durable-lifecycle-pipeline` at
`08c564a75faa86025c8995822a13e78ad1178861` on 2026-07-25.

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

- [x] Objective and scoped behavior are complete.
- [x] Focused RED/GREEN, build/lint, and listed validation evidence are recorded.
- [x] Required review has no unresolved P1/P2 findings.
- [x] PR targets the epic branch and freshness is checked.
- [x] Shared-context findings are proposed when needed.

## Validation Steps

- npx vitest run tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/core/database/migrations/runner.test.ts
- npm run build
- git diff --check

## Verification Evidence

- Focused repository/migration tests passed:
  `npx vitest run tests/unit/core/database/repositories/behavior-signal-repository.test.ts
  tests/unit/core/database/migrations/runner.test.ts`.
- GitHub CI-selected verification after the migration-expectation fix passed
  37 files and 837 tests, including lifecycle repository migration coverage.
- Scoped ESLint exited 0 with repo-standard ignored-test warnings only.
- `npm run build` passed.
- `git diff --check` passed.
- GitHub Verify PR passed on PR #267 after the CI expectation fix.

## Review Feedback

### P1

- None.

### P2

- None. GPT-5.5/xhigh review passed with no Critical/High/Medium blockers.

### P3

- None.

## Completion Notes

- Added migration 018 for persona-scoped behavior evidence, candidates,
  promotions, activations, and rollback lineage.
- Added `BehaviorSignalRepository` and behavior lifecycle types with guarded
  transition, fingerprint, provenance, and persona isolation tests.
- Fixed stale v14-to-current migration test expectations after adding migration
  018; CI rerun passed before merge.
- Clean task worktree was removed and pruned during WAVE-005 reconciliation.
