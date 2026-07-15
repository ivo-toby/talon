---
id: TASK-007-daemon-message-queue-schedule-events
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-003-core-boundary-integration
wave: WAVE-004
slug: daemon-message-queue-schedule-events
title: Wire lifecycle runtime plus inbound, queue, and schedule boundaries
status: todo
depends_on: ["TASK-005-transactional-event-bus", "TASK-006-durable-event-dispatcher"]
conflict_domains:
  - "src/daemon/daemon-bootstrap.ts"
  - "src/daemon/daemon.ts"
  - "src/pipeline/message-pipeline.ts"
  - "src/queue/**"
  - "src/scheduler/scheduler.ts"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-007-daemon-message-queue-schedule-events
worker_worktree: null
worktree_status: unassigned
pr: null
current_gate: not_started
branch_freshness: unknown
verification:
  - "npx vitest run tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/pipeline/message-pipeline.test.ts tests/unit/queue/queue-processor.test.ts tests/unit/scheduler/scheduler.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-007-daemon-message-queue-schedule-events: Wire lifecycle runtime plus inbound, queue, and schedule boundaries

## Status

todo

## Parent Ticket

TICKET-003-core-boundary-integration

## Wave

WAVE-004

## Objective

Construct/supervise lifecycle services and publish message, routing, queue, and schedule events while enforcing message.before_persist without disabled-behavior drift.

## Scope

- Wire daemon bootstrap/start/stop/restart.
- Publish message.persisted/routed, queue transition, and schedule.fired events.
- Run inbound interceptor before persistence.
- Use atomic state/event writes where practical.
- Preserve dedup, FIFO, retries, and synchronous Result behavior.

## Non-Scope

No run/tool/outbound, context, behavior, or operator CLI work.

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

- src/daemon/daemon-bootstrap.ts
- src/daemon/daemon.ts
- src/pipeline/message-pipeline.ts
- src/queue/**
- src/scheduler/scheduler.ts
- tests/unit/daemon/daemon-bootstrap.test.ts
- tests/unit/pipeline/message-pipeline.test.ts
- tests/unit/queue/**
- tests/unit/scheduler/scheduler.test.ts

## Dependencies

- TASK-005-transactional-event-bus
- TASK-006-durable-event-dispatcher

## Conflict Domains

- src/daemon/daemon-bootstrap.ts
- src/daemon/daemon.ts
- src/pipeline/message-pipeline.ts
- src/queue/**
- src/scheduler/scheduler.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-007-daemon-message-queue-schedule-events

## Worker Worktree

None assigned. The controller must create or verify an isolated worktree before dispatch and provide its path.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing tests for daemon lifecycle, exactly-once transition events, atomic inbound state/event, deny/transform, queue failure/dead-letter, schedule provenance, and disabled equivalence.

### GREEN

Inject lifecycle services and add calls at authoritative transitions.

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

- npx vitest run tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/pipeline/message-pipeline.test.ts tests/unit/queue/queue-processor.test.ts tests/unit/scheduler/scheduler.test.ts
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
