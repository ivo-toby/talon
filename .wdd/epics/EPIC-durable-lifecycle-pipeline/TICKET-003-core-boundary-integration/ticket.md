---
id: TICKET-003-core-boundary-integration
kind: ticket
epic: EPIC-durable-lifecycle-pipeline
slug: TICKET-003-core-boundary-integration
title: Core Boundary Integration and Telemetry
status: in_progress
task_count: 3
depends_on: []
conflict_domains:
  - "src/daemon/**"
  - "src/pipeline/**"
  - "src/queue/**"
  - "src/scheduler/**"
  - "src/tools/**"
  - "src/observability/**"
adapter_links:
  github_issue: https://github.com/ivo-toby/talon/issues/256
---

# Core Boundary Integration and Telemetry

## Summary

Wire lifecycle services into daemon, message, queue, schedule, run, tool, outbound, audit, metrics, and Langfuse boundaries.

## Objective

Complete the child tasks, reconcile durable findings, and preserve the epic native-policy/pluggable-reasoning split.

## Scope

- Included: all child outcomes below.
- Excluded: remote handlers, arbitrary filter expressions, and implementation of issue #70.

## Non-Scope

- Work owned by other tickets or excluded by the epic.

## Shared Context References

- ../shared-context/index.md
- ../shared-context/resources/architecture.md
- ../shared-context/resources/design-decisions.md
- ../shared-context/resources/testing-strategy.md

## Task Inventory

| Task | Status | Wave | Summary |
|------|--------|------|---------|
| TASK-007-daemon-message-queue-schedule-events | in_progress | WAVE-004 | Construct/supervise lifecycle services and publish message, routing, queue, and schedule events while enforcing message.before_persist without disabled-behavior drift. |
| TASK-008-run-tool-outbound-events | todo | WAVE-005 | Publish run/tool/outbound events and enforce run, tool, and send interceptors while preserving approvals, delivery idempotency, audit, and originating-run semantics. |
| TASK-013-handler-telemetry-correlation | todo | WAVE-006 | Instrument publication/interceptor/handler/delivery behavior with bounded audit, metrics, and existing Langfuse observations plus an optional issue-70 trace-evidence seam. |

## Dependencies

- Task-level prerequisites are authoritative in wave-plan.md and orchestration.json.

## Conflict Domains

- src/daemon/**
- src/pipeline/**
- src/queue/**
- src/scheduler/**
- src/tools/**
- src/observability/**

## Validation Expectations

- Complete every child task or explicitly cancel it.
- Reconcile focused verification, required review, freshness, and shared findings.

## Review Focus

- Native policy/projection versus pluggable reasoning boundaries.
- Persistence, scope, privacy, idempotency, ordering, failure, and compatibility risks.

## Completion Criteria

- [ ] All child task review and verification gates are resolved.
- [ ] Shared-context updates are reconciled.
- [ ] Ticket status matches child task state.
