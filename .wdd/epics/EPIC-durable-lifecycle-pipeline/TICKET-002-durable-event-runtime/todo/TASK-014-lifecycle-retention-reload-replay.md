---
id: TASK-014-lifecycle-retention-reload-replay
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-002-durable-event-runtime
wave: WAVE-007
slug: lifecycle-retention-reload-replay
title: Implement retention, privacy deletion, reload identity, and safe replay
status: todo
depends_on: ["TASK-006-durable-event-dispatcher", "TASK-013-handler-telemetry-correlation"]
conflict_domains:
  - "src/lifecycle/retention-service.ts"
  - "src/lifecycle/lifecycle-admin-service.ts"
  - "src/core/database/repositories/lifecycle-*.ts"
  - "src/daemon/reload.ts"
  - "src/daemon/daemon.ts"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-014-lifecycle-retention-reload-replay
worker_worktree: null
worktree_status: unassigned
pr: null
current_gate: not_started
branch_freshness: unknown
verification:
  - "npx vitest run tests/unit/lifecycle/retention-service.test.ts tests/unit/lifecycle/lifecycle-admin-service.test.ts tests/unit/daemon/reload.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-014-lifecycle-retention-reload-replay: Implement retention, privacy deletion, reload identity, and safe replay

## Status

todo

## Parent Ticket

TICKET-002-durable-event-runtime

## Wave

WAVE-007

## Objective

Add configurable compaction, privacy-aware payload deletion/tombstoning, stable handler identity across reload, disablement, and exact one-handler replay without duplicated state/side effects.

## Scope

- Compact completed detail after an audit window.
- Integrate thread/persona privacy deletion.
- Snapshot handler/implementation/contract version for pending deliveries.
- Implement disable and exact replay services.
- Test restart/reload, compaction, deletion, replay, and dedup.

## Non-Scope

No CLI, arbitrary bulk replay, remote upgrades, or permanent full history.

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

- src/lifecycle/retention-service.ts
- src/lifecycle/lifecycle-admin-service.ts
- src/core/database/repositories/lifecycle-*.ts
- src/daemon/reload.ts
- src/daemon/daemon.ts
- tests/unit/lifecycle/retention-service.test.ts
- tests/unit/lifecycle/lifecycle-admin-service.test.ts
- tests/unit/daemon/reload.test.ts

## Dependencies

- TASK-006-durable-event-dispatcher
- TASK-013-handler-telemetry-correlation

## Conflict Domains

- src/lifecycle/retention-service.ts
- src/lifecycle/lifecycle-admin-service.ts
- src/core/database/repositories/lifecycle-*.ts
- src/daemon/reload.ts
- src/daemon/daemon.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-014-lifecycle-retention-reload-replay

## Worker Worktree

None assigned. The controller must create or verify an isolated worktree before dispatch and provide its path.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing tests for compaction windows, pending/dead-letter preservation, privacy deletion, version-stable reload, missing/disabled handlers, exact replay, audit, and no duplicates.

### GREEN

Implement retention/admin services and persisted handler snapshots.

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

- npx vitest run tests/unit/lifecycle/retention-service.test.ts tests/unit/lifecycle/lifecycle-admin-service.test.ts tests/unit/daemon/reload.test.ts
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
