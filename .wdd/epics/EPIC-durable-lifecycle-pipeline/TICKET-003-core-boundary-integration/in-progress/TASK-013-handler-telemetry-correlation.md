---
id: TASK-013-handler-telemetry-correlation
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-003-core-boundary-integration
wave: WAVE-006
slug: handler-telemetry-correlation
title: Add lifecycle audit, metrics, and Langfuse correlation
status: in-progress
depends_on: ["TASK-006-durable-event-dispatcher", "TASK-008-run-tool-outbound-events"]
conflict_domains:
  - "src/observability/**"
  - "src/core/logging/audit-logger.ts"
  - "src/lifecycle/telemetry/**"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-013-handler-telemetry-correlation
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-006-handler-telemetry-correlation
worktree_status: allocated_pending_creation
pr: null
current_gate: activation_checkpoint_pending
branch_freshness: pending_activation_checkpoint
verification:
  - "npx vitest run tests/unit/observability tests/unit/lifecycle/telemetry.test.ts tests/unit/core/logging/audit-logger.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-013-handler-telemetry-correlation: Add lifecycle audit, metrics, and Langfuse correlation

## Status

in-progress

## Parent Ticket

TICKET-003-core-boundary-integration

## Wave

WAVE-006

## Objective

Instrument publication/interceptor/handler/delivery behavior with bounded audit, metrics, and existing Langfuse observations plus an optional issue-70 trace-evidence seam.

## Scope

- Record success/failure/retry/dead-letter/lag/latency/token/cost/timeout/circuit metrics.
- Create correlated Langfuse observations.
- Audit decisions, replay, disablement, projections, and promotions with redaction.
- Define optional bounded TraceEvidenceProvider and no-op implementation.

## Non-Scope

No issue-70 trace querying, dashboard, CLI, or full-trace persistence.

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

- src/observability/**
- src/core/logging/audit-logger.ts
- src/lifecycle/telemetry/**
- src/lifecycle/trace-evidence-provider.ts
- tests/unit/observability/**
- tests/unit/lifecycle/telemetry.test.ts

## Dependencies

- TASK-006-durable-event-dispatcher
- TASK-008-run-tool-outbound-events

## Conflict Domains

- src/observability/**
- src/core/logging/audit-logger.ts
- src/lifecycle/telemetry/**

## Assigned Model Class

codexHigh

## Branch

task/TASK-013-handler-telemetry-correlation

## Worker Worktree

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-006-handler-telemetry-correlation

Allocated by the controller for WAVE-006. Do not create or use this worktree
until the reviewed activation checkpoint has been committed and pushed.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing tests for bounded metrics/labels, audit redaction, correlation/traceparent, costs, noop behavior, and unavailable evidence provider.

### GREEN

Extend existing observability/audit interfaces and instrument lifecycle execution.

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

- npx vitest run tests/unit/observability tests/unit/lifecycle/telemetry.test.ts tests/unit/core/logging/audit-logger.test.ts
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
