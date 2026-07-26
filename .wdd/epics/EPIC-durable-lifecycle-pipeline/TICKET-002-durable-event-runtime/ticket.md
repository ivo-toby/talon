---
id: TICKET-002-durable-event-runtime
kind: ticket
epic: EPIC-durable-lifecycle-pipeline
slug: TICKET-002-durable-event-runtime
title: Durable Event Runtime
status: done
task_count: 4
depends_on: []
conflict_domains:
  - "src/core/database/**"
  - "src/lifecycle/lifecycle-event-bus.ts"
  - "src/lifecycle/lifecycle-dispatcher.ts"
  - "src/daemon/reload.ts"
adapter_links:
  github_issue: https://github.com/ivo-toby/talon/issues/256
---

# Durable Event Runtime

## Summary

Persist, publish, dispatch, retain, reload, disable, and replay lifecycle deliveries independently.

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
| TASK-002-lifecycle-event-persistence | done | WAVE-002 | Add real SQLite migration/repository support for bounded lifecycle events and per-handler deliveries with claims, ordering, retry, dead-letter, and transactional primitives. |
| TASK-005-transactional-event-bus | done | WAVE-003 | Implement validated versioned publication, atomic subscriber delivery fan-out, correlation/causation/depth propagation, and after-commit wake behavior. |
| TASK-006-durable-event-dispatcher | done | WAVE-003 | Implement independent at-least-once delivery with leases, per-aggregate ordering, bounded concurrency, retry/dead-letter, idempotency, backpressure, circuit state, and restart-safe shutdown. |
| TASK-014-lifecycle-retention-reload-replay | done | WAVE-007 | Add configurable compaction, privacy-aware payload deletion/tombstoning, stable handler identity across reload, disablement, and exact one-handler replay without duplicated state/side effects. |

## Dependencies

- Task-level prerequisites are authoritative in wave-plan.md and orchestration.json.

## Conflict Domains

- src/core/database/**
- src/lifecycle/lifecycle-event-bus.ts
- src/lifecycle/lifecycle-dispatcher.ts
- src/daemon/reload.ts

## Validation Expectations

- Complete every child task or explicitly cancel it.
- Reconcile focused verification, required review, freshness, and shared findings.

## Review Focus

- Native policy/projection versus pluggable reasoning boundaries.
- Persistence, scope, privacy, idempotency, ordering, failure, and compatibility risks.

## Completion Criteria

- [x] All child task review and verification gates are resolved.
- [x] Shared-context updates are reconciled.
- [x] Ticket status matches child task state.
