---
id: TASK-011-context-lifecycle-migration
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-004-context-migration
wave: WAVE-006
slug: context-lifecycle-migration
title: Migrate observational memory to configured lifecycle handlers
status: todo
depends_on: ["TASK-008-run-tool-outbound-events", "TASK-009-context-contracts-projector"]
conflict_domains:
  - "src/daemon/agent-runner.ts"
  - "src/daemon/context-roller.ts"
  - "src/daemon/daemon-bootstrap.ts"
  - "src/core/config/config-schema.ts"
  - "src/queue/**"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-011-context-lifecycle-migration
worker_worktree: null
worktree_status: unassigned
pr: null
current_gate: not_started
branch_freshness: unknown
verification:
  - "npx vitest run tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/integration/rolling-context-window.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-011-context-lifecycle-migration: Migrate observational memory to configured lifecycle handlers

## Status

todo

## Parent Ticket

TICKET-004-context-migration

## Wave

WAVE-006

## Objective

Route context thresholds through configured contracts/projector, remove observer/reflector name checks and auto-binding, and translate legacy summarizer config with clear deprecation.

## Scope

- Publish threshold/reduction/rotation lifecycle events.
- Validate configured context handlers/contracts.
- Translate existing contextManagement summarizer/reflection config.
- Remove session-observer and session-reflector core name checks.
- Preserve context, rotation, continuation, and provider-session behavior.
- Block only the next ordinary thread item while required projection is pending.

## Non-Scope

No behavior learning or removal of legacy summarizer support before deprecation.

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

- src/daemon/agent-runner.ts
- src/daemon/context-roller.ts
- src/daemon/daemon-bootstrap.ts
- src/core/config/config-schema.ts
- src/queue/**
- src/lifecycle/context/**
- tests/unit/daemon/**
- tests/integration/rolling-context-window.test.ts

## Dependencies

- TASK-008-run-tool-outbound-events
- TASK-009-context-contracts-projector

## Conflict Domains

- src/daemon/agent-runner.ts
- src/daemon/context-roller.ts
- src/daemon/daemon-bootstrap.ts
- src/core/config/config-schema.ts
- src/queue/**

## Assigned Model Class

codexHigh

## Branch

task/TASK-011-context-lifecycle-migration

## Worker Worktree

None assigned. The controller must create or verify an isolated worktree before dispatch and provide its path.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing tests for contract config, missing handler failure, legacy translation, durable projection, next-item ordering, preserve-session failure, continuation, reduction, and no name checks.

### GREEN

Switch orchestration to native policy plus configured lifecycle contracts/projector.

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

- npx vitest run tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/integration/rolling-context-window.test.ts
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
