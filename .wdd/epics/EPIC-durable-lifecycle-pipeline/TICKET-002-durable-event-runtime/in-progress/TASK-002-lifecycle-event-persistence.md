---
id: TASK-002-lifecycle-event-persistence
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-002-durable-event-runtime
wave: WAVE-002
slug: lifecycle-event-persistence
title: Add durable lifecycle event and delivery persistence
status: in_progress
depends_on: ["TASK-001-lifecycle-contracts-registry"]
conflict_domains:
  - "src/core/database/migrations/**"
  - "src/core/database/repositories/index.ts"
assigned_model_class: codexHigh
actual_model: gpt-5.6-terra
reasoning_effort: high
review_model_class: reviewGate
branch: task/TASK-002-lifecycle-event-persistence
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-002-lifecycle-event-persistence
worktree_status: active
worker_thread_id: 019f694a-8c17-7a20-a7b7-113e5349f5b8
review_thread_id: 019f6944-fc19-7d82-ac69-bb2c3690bf65
pr: null
current_gate: needs_review
branch_freshness: current_at_d153e17_at_dispatch
verification:
  - "npx vitest run tests/unit/core/database/repositories/lifecycle-event-repository.test.ts tests/unit/core/database/migrations/runner.test.ts"
  - "npm run build"
  - "git diff --check"
---

# TASK-002-lifecycle-event-persistence: Add durable lifecycle event and delivery persistence

## Status

in_progress

## Parent Ticket

TICKET-002-durable-event-runtime

## Wave

WAVE-002

## Objective

Add real SQLite migration/repository support for bounded lifecycle events and per-handler deliveries with claims, ordering, retry, dead-letter, and transactional primitives.

## Scope

- Create lifecycle_events and lifecycle_event_deliveries with constraints/indexes.
- Add Result-returning repositories and mappings.
- Support insert/fan-out, ordered claims/leases, completion, failure, dead-letter, and replay primitives.
- Test migration upgrade, atomicity, uniqueness, ordering, retry, and reopen.

## Non-Scope

No dispatcher loop, behavior ledger, CLI, or transcript/tool-payload persistence.

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

- src/core/database/migrations/014-lifecycle-events.sql
- src/core/database/repositories/lifecycle-event-repository.ts
- src/core/database/repositories/lifecycle-delivery-repository.ts
- src/core/database/repositories/index.ts
- tests/unit/core/database/repositories/lifecycle-event-repository.test.ts

## Dependencies

- TASK-001-lifecycle-contracts-registry

## Conflict Domains

- src/core/database/migrations/**
- src/core/database/repositories/index.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-002-lifecycle-event-persistence

## Worker Worktree

`/Users/ivo.toby/workspace/talon/.worktrees/WAVE-002-lifecycle-event-persistence`
is active on `task/TASK-002-lifecycle-event-persistence` from reviewed and
pushed readiness commit `d153e17` under Terra/high worker
`019f6850-6765-7f63-8874-1857dfc53796`.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing real-SQLite tests for bounded payloads, atomic fan-out, uniqueness, leases, ordering, retry/dead-letter, replay, and restart.

### GREEN

Implement migration, mappings, repositories, and transaction-aware methods with neverthrow.

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

- npx vitest run tests/unit/core/database/repositories/lifecycle-event-repository.test.ts tests/unit/core/database/migrations/runner.test.ts
- npm run build
- git diff --check

## Verification Evidence

- Terra/high remediation: 35 focused tests passed under Node 24.15.0.
- Build, changed-source ESLint, touched-file Prettier, and `git diff --check` passed.
- Sol/high review failed 0C/1H/0M/0L; insert/replace bypass remediation completed
  with 35 focused tests and all static gates green.
- Focused Sol/high delta review failed 0C/0H/1M because SQLite exposes an
  omitted `INTEGER PRIMARY KEY` as provisional `-1` inside `BEFORE INSERT`.
  Terra/high remediation now excludes that sentinel from the replacement check
  and passed 35 focused tests plus all static gates. Fresh delta review is next.

## Review Feedback

### P1

- High: insert-time terminal delivery rows and `INSERT OR REPLACE` could bypass
  update-only guards. Resolved by remediation and delta review except for the
  separately classified provisional-rowid Medium below.

### P2

- Medium: replacement guard compared SQLite's provisional `NEW.event_sequence`
  value of `-1`, allowing a stored negative sequence to wedge later generated
  inserts. Terra/high remediation is complete; fresh delta review pending.

### P3

- None.

## Completion Notes

- None yet.
